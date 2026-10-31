import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { HarnessError, type AttemptState, type WorkState } from '../contracts/index.ts';
import { command, hostGitArgs } from '../environment/process.ts';
import { assertTrustedCheckout, forgetWorktree, worktreeKey } from '../environment/git-trust.ts';

/**
 * Рабочие деревья закончившихся попыток. Обычно попытка убирает их сама; после
 * падения процесса, отказа удаления или под прежними версиями они остаются и
 * занимают диск. Удаление необратимо, поэтому правило одно: в сомнении дерево
 * остаётся, а отказ назван. Убирается только то, что восстановимо: вершина
 * достижима из ref, неподтверждённые правки доказанно лежат в патче. Игнорируемые
 * файлы патч не сохраняет — они перечисляются в отчёте.
 */
export type WorktreeRefusal =
  | 'active'
  | 'recoverable'
  | 'cleanup-pending'
  | 'cleanup-unreadable'
  | 'unknown-attempt'
  | 'untrusted'
  | 'embedded-repository'
  | 'scan-limit'
  | 'scan-failed'
  | 'read-only-path'
  | 'ignore-rules-changed'
  | 'hidden-changes'
  | 'unreachable-head'
  | 'patch-unusable'
  | 'removal-incomplete'
  | 'not-registered';

export interface WorktreeCleanupEntry {
  path: string;
  repositoryId: string;
  attemptId?: string;
  /**
   * remove — будет удалено (dry run); removed — удалено; refused — дерево не
   * тронуто. failed — отказ шага: при `removalStarted` git мог удалить часть
   * файлов и регистрацию, истинное состояние — в `registered` и `treePresent`,
   * а `patch` указывает на сохранённые правки.
   */
  action: 'remove' | 'removed' | 'refused' | 'failed';
  reason?: WorktreeRefusal;
  error?: string;
  head?: string;
  sizeKb?: number;
  /** Файлов с неподтверждёнными правками. */
  uncommitted?: number;
  /** Игнорируемое в дереве: в патч не входит и исчезает вместе с деревом. */
  ignored?: { count: number; paths: string[] };
  /** Патч этих правок (не для dry run): `git apply --index` поверх `head`. */
  patch?: string;
  removalStarted?: boolean;
  registered?: boolean;
  treePresent?: boolean;
}

const terminalWork: readonly string[] = ['done', 'failed', 'cancelled'];
/** Сколько верхних путей игнорируемого называет отчёт. */
const IGNORED_PATHS = 20;

/** Почему попытку нельзя лишить дерева: идёт, или её работа ещё может продолжиться. */
export function attemptRefusal(
  attempt: AttemptState,
  work: WorkState | undefined,
  latest: boolean,
  running: boolean,
): WorktreeRefusal | undefined {
  if (attempt.status === 'active' || running) return 'active';
  if (latest && !(work && terminalWork.includes(work.status))) return 'recoverable';
  return undefined;
}

/** Незавершённая очистка: дерево — вход `cleanup --run`, его нельзя убирать мимо teardown. */
export async function cleanupUnfinished(artifacts: string, receipts: string[]) {
  const file = join(artifacts, 'cleanup-pending.json');
  if (existsSync(file)) {
    const { reason } = JSON.parse(await readFile(file, 'utf8')) as { reason?: string };
    if (reason !== 'remove-failed') return true;
  }
  for (const receipt of receipts) {
    const { status } = JSON.parse(await readFile(receipt, 'utf8')) as { status: string };
    if (status === 'active' || status === 'cleanup-failed') return true;
  }
  return false;
}

/**
 * Вывод git целиком. Решения очистки не могут опираться на обрезанный вывод:
 * `command` держит только хвост в 2 МБ, здесь буфер ограничен отказом, а не
 * усечением. `allowed` — коды выхода, которые не ошибка (check-ignore: 1).
 */
function gitOutput(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; allowed?: number } = {},
) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'git',
      hostGitArgs(cwd, args),
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
        encoding: 'buffer',
        maxBuffer: 2 ** 29,
        timeout: options.timeoutMs ?? 600_000,
      },
      (error, stdout, stderr) => {
        if (error && error.code !== options.allowed)
          reject(new Error(`git ${args[0]}: ${stderr.toString().trim() || error.message}`));
        else resolve(stdout.toString());
      },
    );
    child.stdin?.end(options.input ?? '');
  });
}

/** Зарегистрированные рабочие деревья репозитория: настоящий путь → HEAD. */
export async function registered(repoPath: string) {
  const out = await gitOutput(repoPath, ['worktree', 'list', '--porcelain']);
  const found = new Map<string, string | undefined>();
  for (const block of out.split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (path) found.set(worktreeKey(path), /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1]);
  }
  return found;
}

export interface TreeScan {
  embedded?: string;
  readOnly?: string;
  limited: boolean;
  /** Пути `.gitignore` относительно дерева. */
  ignoreFiles: string[];
}

/**
 * Настоящее дерево вместе с игнорируемым: вложенный репозиторий (`.git` файлом
 * или каталогом, либо голый) git-командам внешнего не виден, если каталог
 * игнорируется. В `node_modules` тоже смотрим: зависимость из git-источника или
 * правка на месте бывает единственной копией работы. Обход ограничен: дошедший
 * до предела обход не доказал ничего. Символические ссылки не проходятся.
 */
export async function scanTree(root: string, limit: number): Promise<TreeScan> {
  const scan: TreeScan = { limited: false, ignoreFiles: [] };
  const stack = [root];
  let entries = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    const rel = relative(root, dir);
    if (!((await lstat(dir)).mode & 0o200)) scan.readOnly ??= rel || '.';
    const items = await readdir(dir, { withFileTypes: true });
    entries += items.length;
    if (entries > limit) return { ...scan, limited: true };
    const names = new Set(items.map((i) => i.name));
    if (
      dir !== root &&
      (names.has('.git') || ['HEAD', 'objects', 'refs'].every((n) => names.has(n)))
    )
      return { ...scan, embedded: rel };
    for (const item of items) {
      if (item.name === '.git') continue;
      if (item.name === '.gitignore') scan.ignoreFiles.push(join(rel, item.name));
      if (item.isDirectory()) stack.push(join(dir, item.name));
    }
  }
  return scan;
}

/** Записи индекса: gitlink — чужой репозиторий; assume-unchanged и skip-worktree прячут правки. */
async function indexFlags(dir: string) {
  const out = await gitOutput(dir, ['--no-optional-locks', 'ls-files', '-v', '-s', '-z']);
  let gitlink = false;
  let hidden = false;
  for (const line of out.split('\0')) {
    if (!line) continue;
    const [tag, mode] = line.split(' ');
    if (mode === '160000') gitlink = true;
    if (tag === 'S' || (tag && tag !== tag.toUpperCase())) hidden = true;
  }
  return { gitlink, hidden };
}

const blobId = (content: Buffer, head: string) =>
  createHash(head.length > 40 ? 'sha256' : 'sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');

/**
 * Правила игнорирования скрывают работу: изменённый `.gitignore` убрал бы её из
 * статуса и из патча. Считается только то, что git читает: `.gitignore` внутри
 * каталога, игнорируемого неизменёнными правилами (пакет в `node_modules`), ни
 * на что не влияет. У `info/exclude` нет версии в HEAD, а шаблон git и настройки
 * человека держат там правила и без попытки, поэтому отказ — когда его правило
 * скрывает путь, существующий в дереве.
 */
async function ignoreRulesChanged(dir: string, head: string, files: string[], present: string[]) {
  if (present.length) {
    const fields = (
      await gitOutput(dir, ['check-ignore', '--stdin', '-z', '-v'], {
        input: present.map((p) => p.replace(/\/$/, '')).join('\0') + '\0',
        allowed: 1,
      })
    ).split('\0');
    for (let i = 0; i + 3 < fields.length; i += 4)
      if (fields[i]!.endsWith('info/exclude')) return true;
  }
  const tree = await gitOutput(dir, ['ls-tree', '-r', '-z', head]);
  const inHead = new Map<string, { mode: string; id: string }>();
  for (const line of tree.split('\0')) {
    const m = /^(\d+) \w+ (\w+)\t(.+)$/s.exec(line);
    if (m && basename(m[3]!) === '.gitignore') inHead.set(m[3]!, { mode: m[1]!, id: m[2]! });
  }
  const changed = new Set<string>();
  for (const file of files) {
    const known = inHead.get(file);
    const path = join(dir, file);
    if (
      !known ||
      known.mode === '120000' ||
      (await lstat(path)).isSymbolicLink() ||
      blobId(await readFile(path), head) !== known.id
    )
      changed.add(file);
  }
  for (const file of inHead.keys()) if (!files.includes(file)) changed.add(file);
  const dirs = [...changed].map(dirname);
  if (dirs.includes('.')) return true;
  if (!dirs.length) return false;
  const ignored = await gitOutput(dir, ['check-ignore', '--stdin', '-z'], {
    input: dirs.join('\0') + '\0',
    allowed: 1,
  });
  const inert = new Set(ignored.split('\0'));
  return dirs.some((d) => !inert.has(d));
}

/** Неподтверждённые правки и игнорируемое без записи в индекс дерева. */
async function treeStatus(dir: string) {
  const out = await gitOutput(dir, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '-z',
    '--no-renames',
    '--ignored=matching',
    '-uall',
  ]);
  let uncommitted = 0;
  const entries: string[] = [];
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    if (!entry.startsWith('!! ')) uncommitted++;
    else entries.push(entry.slice(3));
  }
  const top = new Set(entries.map((path) => path.split('/')[0]!));
  return {
    entries,
    uncommitted,
    ignored: { count: entries.length, paths: [...top].sort().slice(0, IGNORED_PATHS) },
  };
}

/** Что мешает удалить дерево, и что в нём лежит. Ничего не пишет. */
export async function inspectTree(
  dir: string,
  head: string | undefined,
  limit: number,
): Promise<{
  refusal?: WorktreeRefusal;
  uncommitted?: number;
  ignored?: WorktreeCleanupEntry['ignored'];
}> {
  let scan: TreeScan;
  try {
    scan = await scanTree(dir, limit);
  } catch {
    return { refusal: 'scan-failed' };
  }
  if (scan.limited) return { refusal: 'scan-limit' };
  if (scan.embedded) return { refusal: 'embedded-repository' };
  const { entries, ...status } = await treeStatus(dir);
  const refused = (refusal: WorktreeRefusal) => ({ refusal, ...status });
  const flags = await indexFlags(dir);
  if (flags.gitlink) return refused('embedded-repository');
  if (!head || !(await gitOutput(dir, ['for-each-ref', '--contains', head, '--count=1'])).trim())
    return refused('unreachable-head');
  if (await ignoreRulesChanged(dir, head, scan.ignoreFiles, entries))
    return refused('ignore-rules-changed');
  if (flags.hidden) return refused('hidden-changes');
  if (scan.readOnly) return refused('read-only-path');
  return status;
}

/** Первое свободное имя: уже сохранённый патч не перезаписывается. */
async function publish(temporary: string, directory: string, name: string) {
  for (let n = 1; ; n++) {
    const path = join(directory, `${name}${n > 1 ? `-${n}` : ''}.patch`);
    try {
      await link(temporary, path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/**
 * Неподтверждённые правки дерева — патчем к его HEAD. Индекс попытки не
 * меняется: всё идёт через временные индексы. Формат закреплён против настроек
 * пользователя, а патч проверен до удаления: наложенный на HEAD, он обязан дать
 * то же дерево, что и правки. Иначе отказ, и дерево остаётся.
 */
export async function savePatch(dir: string, artifacts: string, name: string) {
  const scratch = await mkdtemp(join(tmpdir(), 'harness-worktree-index-'));
  const temporary = join(artifacts, `.${name}.${process.pid}.tmp`);
  try {
    await mkdir(artifacts, { recursive: true });
    const inIndex = (file: string, ...args: string[]) =>
      gitOutput(dir, args, { env: { GIT_INDEX_FILE: join(scratch, file) } });
    await inIndex('edits', 'read-tree', 'HEAD');
    await inIndex('edits', 'add', '-A', '--', '.');
    if (/^:\d+ 160000 /m.test(await inIndex('edits', 'diff', '--cached', '--raw', 'HEAD')))
      return { refusal: 'embedded-repository' as const };
    const edits = (await inIndex('edits', 'write-tree')).trim();
    await inIndex(
      'edits',
      '-c',
      'diff.noprefix=false',
      '-c',
      'diff.mnemonicPrefix=false',
      '-c',
      'diff.relative=false',
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--unified=3',
      '-O/dev/null',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      `--output=${temporary}`,
      'HEAD',
    );
    try {
      await inIndex('proof', 'read-tree', 'HEAD');
      await inIndex('proof', 'apply', '--cached', '--whitespace=nowarn', temporary);
      if ((await inIndex('proof', 'write-tree')).trim() !== edits)
        return { refusal: 'patch-unusable' as const };
    } catch {
      return { refusal: 'patch-unusable' as const };
    }
    return { patch: await publish(temporary, artifacts, name) };
  } finally {
    await rm(temporary, { force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Дерево на диске — именно зарегистрированное дерево этого репозитория. */
export function trusted(dir: string, repoPath: string) {
  try {
    return assertTrustedCheckout(dir) === assertTrustedCheckout(repoPath);
  } catch {
    return false;
  }
}

export async function sizeKb(dir: string) {
  const result = await command(['du', '-sk', dir], tmpdir());
  return Number(/^\d+/.exec(result.stdout)?.[0] ?? 0);
}

/** Убрать дерево с пределом для больших деревьев: `command` ждёт по умолчанию 120 с. */
export async function removeTree(repoPath: string, path: string, timeoutMs: number) {
  await gitOutput(repoPath, ['worktree', 'remove', '--force', path], { timeoutMs });
  forgetWorktree(path);
}

const recordFile = (artifacts: string, path: string) =>
  join(artifacts, `worktree-cleanup-${basename(path)}.json`);

export interface RemovalRecord extends WorktreeCleanupEntry {
  status: 'removing' | 'removed' | 'incomplete';
  at: string;
  previous?: RemovalRecord;
}

/** Запись об удалении этого дерева; нечитаемая запись — как незавершённое удаление. */
export async function readRemoval(artifacts: string, path: string) {
  const file = recordFile(artifacts, path);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(await readFile(file, 'utf8')) as RemovalRecord;
  } catch {
    return { status: 'incomplete' } as RemovalRecord;
  }
}

/**
 * Запись рядом с артефактами попытки: с какой вершины убрано и где патч. Пишется
 * и до удаления: прерванное удаление не теряет указатель на патч и видно
 * следующему запуску. Замена атомарна.
 */
export async function recordRemoval(
  artifacts: string,
  entry: WorktreeCleanupEntry,
  status: RemovalRecord['status'],
  previous?: RemovalRecord,
) {
  await mkdir(artifacts, { recursive: true });
  const file = recordFile(artifacts, entry.path);
  const temporary = `${file}.${process.pid}.tmp`;
  const record: RemovalRecord = {
    ...entry,
    status,
    at: new Date().toISOString(),
    ...(previous ? { previous } : {}),
  };
  await writeFile(temporary, JSON.stringify(record, null, 2));
  await rename(temporary, file);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Один запуск очистки на каталог состояния: два запуска делили бы патчи и записи.
 * Замок умершего процесса снимается; замок без читаемого PID — занят.
 */
export async function lockCleanup(file: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => rm(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number((await readFile(file, 'utf8').catch(() => '')).trim());
      if (!pid || alive(pid)) break;
      await rm(file, { force: true });
    }
  }
  throw new HarnessError('NOT_READY', `Очистка деревьев уже идёт: ${file}`);
}

export const treeState = async (repoPath: string, path: string) => ({
  registered: (await registered(repoPath)).has(worktreeKey(path)),
  treePresent: existsSync(path),
});

export const isWithin = (path: string, root: string) => {
  const rest = relative(root, path);
  return !!rest && !rest.startsWith('..') && !rest.startsWith('/');
};
