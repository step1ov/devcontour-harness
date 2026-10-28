import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync, lstatSync, readlinkSync, realpathSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import {
  DANGEROUS_FILES,
  getDangerousDirectories,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';

/**
 * Одна политика изоляции для исполнителя, ревьюера и проверок.
 *
 * Раньше граница зависела от того, кто исполняет: codex-исполнитель читал
 * любые файлы пользователя, claude-ревьюер без песочницы мог писать куда
 * угодно, а проверки шли обычным процессом хоста. Здесь граница описана один
 * раз, а применяет её механизм, родной для каждого: песочница codex (профиль
 * прав), песочница Claude Code (sandbox settings) и sandbox-runtime для
 * проверок. Все три — один класс механизма ОС (Seatbelt на macOS,
 * bubblewrap на Linux).
 *
 * - `write` — куда можно писать; всё остальное закрыто на запись.
 * - `hidden` — что закрыто на чтение: база и рабочие каталоги контура,
 *   каталоги учётных данных.
 * - `readable` — что внутри скрытого снова открыто: собственный worktree,
 *   закреплённые зависимости. Более конкретный путь побеждает.
 * - `domains` — внешние адреса; без них сеть закрыта. Проверкам остаётся
 *   localhost: тесты сервисов поднимают его сами.
 */
export interface Isolation {
  write: string[];
  hidden: string[];
  readable: string[];
  domains: string[];
  /**
   * Имена элементов каталога контура, которые хост создаёт по ходу работы
   * (конфигурация, журналы). Закрываются заранее вместе с известными harness.
   */
  entries?: string[];
}

/**
 * Каталоги учётных данных. Закрыть весь $HOME нельзя — там проверяемый
 * checkout и инструменты, — поэтому закрываются известные места ключей и
 * токенов. Пути абсолютные: не каждый механизм раскрывает `~`.
 */
export function credentialPaths(home = homedir()) {
  return [
    '.ssh',
    '.aws',
    '.gnupg',
    '.netrc',
    '.npmrc',
    '.docker',
    '.kube',
    '.config/gh',
    '.config/gcloud',
    '.git-credentials',
    '.codex',
    '.claude',
    '.claude.json',
  ].map((p) => join(home, p));
}

export function isolation(options: {
  write: string[];
  controller: string[];
  readable?: string[];
  domains?: string[];
  /** Элементы каталога контура хоста, которые закрываются и до своего появления. */
  entries?: string[];
}): Isolation {
  // Песочница сравнивает настоящие пути: временный каталог macOS лежит за
  // symlink (/var → /private/var), и правило для записанного пути иначе не
  // совпало бы с тем, куда процесс обращается на деле.
  const real = (paths: string[]) => [
    ...new Set(
      paths.map((path) => {
        try {
          return realpathSync(path);
        } catch {
          return path;
        }
      }),
    ),
  ];
  return {
    write: real(options.write),
    hidden: real([...options.controller, ...credentialPaths()]),
    // Установленные пакеты рантайма лежат внутри закрытого каталога его
    // учётных данных: без них codex не запускает даже помощника своей
    // песочницы. Более конкретный путь открыт; токены и сессии — нет.
    readable: real([
      ...options.write,
      ...(options.readable ?? []),
      join(homedir(), '.codex', 'packages'),
    ]),
    domains: options.domains ?? [],
    ...(options.entries?.length ? { entries: [...new Set(options.entries)] } : {}),
  };
}

/** Sandbox Claude Code: применяется к Bash; без запасного выхода из песочницы. */
export function claudeSandbox(policy: Isolation, review: boolean, cwd: string) {
  return {
    permissions: { deny: claudeFileDenies(policy, cwd) },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: policy.domains, allowLocalBinding: true },
      filesystem: {
        allowWrite: policy.write,
        // Ревьюер не пишет в проверяемый каталог, даже если он совпал с
        // рабочим каталогом сессии, который песочница открывает по умолчанию.
        ...(review ? { denyWrite: isolation({ write: [cwd], controller: [] }).write } : {}),
        denyRead: policy.hidden,
        allowRead: policy.readable,
      },
    },
  };
}

/**
 * Запреты для встроенных файловых инструментов claude (Read, Edit, Write…).
 *
 * Песочница Claude Code применяется только к Bash; файловые инструменты
 * подчиняются правилам прав. Скрытый путь закрывается правилом, если он не
 * предок рабочего каталога: иначе запрет закрыл бы и сам worktree. Такие
 * предки лежат вне рабочего каталога, а чтение вне него в неинтерактивном
 * режиме и так отклоняется. Главное здесь — скрытое внутри рабочего каталога:
 * база контура в embedded-режиме лежит прямо в проверяемом checkout.
 */
export function claudeFileDenies(policy: Isolation, cwd: string | undefined) {
  if (!cwd)
    return closedEntries(policy).flatMap((path) =>
      ['Read', 'Edit'].flatMap((tool) => [`${tool}(/${path})`, `${tool}(/${path}/**)`]),
    );
  // Предок рабочего каталога целиком закрыть нельзя — закрылся бы сам
  // worktree; закрываются его элементы, кроме ветки к рабочему каталогу.
  // Правило запрета сильнее любого разрешения профиля.
  const root = isolation({ write: [cwd], controller: [] }).write[0]!;
  return closedEntries({ ...policy, readable: [...policy.readable, root] }).flatMap((path) =>
    ['Read', 'Edit'].flatMap((tool) => [`${tool}(/${path})`, `${tool}(/${path}/**)`]),
  );
}
/** Файловые инструменты claude: их заранее выданные разрешения при изоляции снимаются. */
export const claudeFileTools = [
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
];
const tomlString = (value: string) => JSON.stringify(value);
/**
 * Скрытые пути в форме, пригодной для codex и правил файловых инструментов claude.
 *
 * `none` у codex запрещает и метаданные: скрытый каталог, внутри которого
 * лежит открытый путь (каталог контура над worktree, исходный checkout над
 * своим .git), ломал realpath — `git status` и `node` в worktree падали с
 * EPERM на lstat предка. Такой каталог не закрывается целиком: закрываются
 * его элементы, кроме ветки, ведущей к открытому пути, и так вглубь. Элемент,
 * появившийся в нём после построения политики, не закрыт — это граница
 * подхода; seatbelt sandbox-runtime и claude закрывают каталог целиком.
 */
/** Элементы каталога контура, известные заранее. */
const controllerEntries = [
  'state.sqlite',
  'state.sqlite-wal',
  'state.sqlite-shm',
  'state.sqlite-journal',
  'resources.sqlite',
  'artifacts',
  'dependencies',
  'deliveries',
];
function closedEntries(policy: Isolation) {
  const open = [...policy.readable, ...policy.write];
  const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
  const expand = (hidden: string): string[] => {
    // Скрытое внутри открытого остаётся скрытым: база контура в embedded
    // checkout закрыта и тогда, когда сам checkout открыт на чтение.
    if (open.includes(hidden)) return [];
    const inner = open.filter((p) => p !== hidden && within(p, hidden));
    if (!inner.length) return [hidden];
    let entries: string[];
    try {
      // Известные элементы каталога контура закрываются и тогда, когда их
      // ещё нет: база, её журналы и рабочие каталоги появляются по ходу
      // работы, а правило, построенное по снимку, их бы пропустило.
      entries = [
        ...new Set([...readdirSync(hidden), ...controllerEntries, ...(policy.entries ?? [])]),
      ].map((name) => join(hidden, name));
    } catch {
      return [];
    }
    return entries.flatMap((entry) =>
      open.some((p) => p === entry)
        ? []
        : inner.some((p) => within(p, entry))
          ? expand(entry)
          : [entry],
    );
  };
  return [...new Set(policy.hidden.flatMap(expand))];
}
/**
 * Профиль прав codex: карта путей с уровнем доступа. Более конкретный путь
 * побеждает, поэтому worktree внутри скрытого каталога контура остаётся
 * доступным. Временный каталог открыт на запись: проверкам ревьюера и
 * исполнителя нужна запись вне проверяемого кода.
 */
export function codexPermissions(policy: Isolation, network: boolean) {
  const entries: [string, string][] = [
    [':root', 'read'],
    [':tmpdir', 'write'],
    ...closedEntries(policy).map((p) => [p, 'none'] as [string, string]),
    ...policy.readable.map((p) => [p, 'read'] as [string, string]),
    ...policy.write.map((p) => [p, 'write'] as [string, string]),
  ];
  const filesystem = [...new Map(entries)]
    .map(([path, level]) => `${tomlString(path)}=${tomlString(level)}`)
    .join(', ');
  return [
    '-c',
    'default_permissions="harness"',
    '-c',
    `permissions.harness={filesystem={${filesystem}}, network={enabled=${network}}}`,
  ];
}

const srtCli = createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/dist/cli.js');

/** Готов ли механизм изоляции проверок на этой машине. */
export function isolationSupport() {
  if (!SandboxManager.isSupportedPlatform())
    return { ok: false, detail: `Платформа ${process.platform} не поддерживается sandbox-runtime` };
  const { errors, warnings } = SandboxManager.checkDependencies();
  return errors.length
    ? { ok: false, detail: 'Не хватает зависимостей песочницы: ' + errors.join('; ') }
    : { ok: true, detail: warnings.join('; ') };
}

/**
 * Обязательные запреты записи sandbox-runtime для корней проверки — без
 * каталогов IDE внутри дерева зависимостей.
 *
 * srt всегда запрещает запись в конфигурацию shell, git, IDE и Claude
 * (README «Mandatory Deny Paths»), и отключить это можно только вместе со
 * всей файловой политикой. На macOS запрет `.idea`/`.vscode` действует на
 * любой глубине под текущим каталогом процесса srt, в том числе внутри
 * `node_modules`; на Linux тот же запрет `node_modules` пропускает. Пакеты
 * публикуют `.idea/` (так поставляются и распространённые транзитивные
 * зависимости), и установка зависимостей в чистом worktree падала с EPERM
 * при любом коде.
 *
 * Запрет защищает от конфигурации, которую песочница подложит, а человек
 * потом откроет в IDE или git исполнит на хосте. Дерево зависимостей IDE как
 * конфигурацию проекта не открывает, поэтому на macOS srt запускается из
 * собственного каталога проверки, а запреты для корней задаются здесь явно:
 *
 * - конфигурация shell и git, `.mcp.json`, `.claude/commands|agents`,
 *   `.git/hooks`, `.git/config` — в корне и на любой глубине, как у srt;
 * - `.idea` и `.vscode` — в корне и в каждом подкаталоге существующих
 *   каталогов до глубины `ideDepth`, кроме `node_modules`. Глоб srt не умеет
 *   «кроме node_modules», поэтому дерево перечисляется: новый каталог глубже
 *   существующего уровня не закрыт (у srt на Linux закрыты только уже
 *   существующие файлы до глубины 3).
 *
 * Путь с символами глоба нельзя записать шаблоном без риска не совпасть ни
 * с чем; тогда возвращается `undefined`, и srt остаётся в прежнем каталоге с
 * полным собственным запретом.
 */
export const ideDirectories = ['.idea', '.vscode'];
const ideDepth = 3;
const ideDirsLimit = 2000;
const glob = /[*?[\]]/;
/**
 * Отказ собрать политику песочницы: проверка не запускается, а не идёт с
 * молча урезанными запретами.
 */
export class SandboxPolicyError extends Error {
  override name = 'SandboxPolicyError';
}
/** Файлы обычного `.git`, которые уводят git в другой репозиторий или конфигурацию. */
const gitRedirects = ['commondir', 'gitdir', 'config.worktree'];
export function protectedWriteDenies(roots: string[]) {
  if (roots.some((r) => glob.test(r))) return undefined;
  const strict = [
    ...DANGEROUS_FILES,
    ...getDangerousDirectories().filter((d) => !ideDirectories.includes(d)),
    '.git/hooks',
    '.git/config',
  ];
  const denies: string[] = [];
  for (const root of roots) {
    for (const name of strict) denies.push(join(root, name), join(root, '**', name));
    for (const name of ideDirectories) denies.push(join(root, name));
    // Git хоста потом читает этот checkout: подменённый файл `.git`,
    // перенаправление обычного `.git` или вложенный репозиторий увели бы его
    // в конфигурацию, написанную проверкой (`git-trust.ts`).
    denies.push(...rootGitDenies(root), join(root, '*', '**', '.git'));
    // Обход в ширину: сначала мелкие уровни. Предел держит профиль песочницы
    // в разумном размере; дерево больше предела — отказ, а не урезанные запреты.
    let level = [root],
      seen = 0;
    for (let depth = 0; depth < ideDepth && level.length; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        if (++seen > ideDirsLimit)
          throw new SandboxPolicyError(
            `песочница проверки не собрана: в ${root} больше ${ideDirsLimit} каталогов до глубины ${ideDepth} вне node_modules — запреты каталогов IDE не перечислить`,
          );
        const safe = !glob.test(dir);
        for (const name of ideDirectories) {
          // Любой подкаталог, и появившийся во время проверки: `node_modules/.idea`
          // этим правилом тоже закрыт, но пакеты лежат уровнем ниже.
          if (safe) denies.push(join(dir, '*', name));
        }
        let entries: import('node:fs').Dirent[] = [];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git')
            continue;
          const child = join(dir, entry.name);
          if (!safe || glob.test(entry.name))
            // Шаблоном такой каталог не записать: закрываются его собственные имена.
            for (const name of ideDirectories) denies.push(join(child, name));
          next.push(child);
        }
      }
      level = next;
    }
  }
  return [...new Set(denies)];
}
/** Запреты для `.git` корня: файл рабочего дерева целиком, у каталога — перенаправления. */
function rootGitDenies(root: string) {
  const dotgit = join(root, '.git');
  try {
    if (lstatSync(dotgit).isDirectory()) return gitRedirects.map((n) => join(dotgit, n));
  } catch {
    return [];
  }
  return [dotgit];
}
/**
 * Явные запреты для Linux. srt там закрывает только уже существующие пути и
 * сам пропускает `node_modules`; файл `.git` рабочего дерева добавляется.
 */
export function linuxWriteDenies(roots: string[]) {
  return roots.flatMap((root) => {
    const dotgit = join(root, '.git');
    try {
      return lstatSync(dotgit).isFile() ? [dotgit] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Обязательный запрет записи, под который попадает `path` внутри открытых
 * проверке каталогов. `undefined` — путь вне таких запретов: отказ в нём —
 * не следствие обязательной политики песочницы.
 */
export function mandatoryDenyRule(policy: Isolation, path: string) {
  const root = policy.write.find((w) => path === w || path.startsWith(w + sep));
  if (!root) return undefined;
  const parts = relative(root, path).split(sep);
  const at = (i: number, ...names: string[]) => names.every((n, k) => parts[i + k] === n);
  const rule = (what: string) => `обязательный запрет записи sandbox-runtime: ${what}`;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    if ((DANGEROUS_FILES as readonly string[]).includes(name) && i === parts.length - 1)
      return rule(name);
    // Каталоги IDE внутри дерева зависимостей открыты (`protectedWriteDenies`).
    if (ideDirectories.includes(name) && !parts.slice(0, i).includes('node_modules'))
      return rule(`каталог IDE ${name}`);
    if (at(i, '.git', 'hooks') || at(i, '.git', 'config'))
      return rule(parts.slice(i, i + 2).join('/'));
    if (name === '.git' && i === 0 && parts.length === 1) return rule('файл .git рабочего дерева');
    if (name === '.git' && i === 0 && gitRedirects.includes(parts[1] ?? ''))
      return rule(`.git/${parts[1]}`);
    if (name === '.git' && i > 0) return rule('вложенный репозиторий .git');
    if (at(i, '.claude', 'commands') || at(i, '.claude', 'agents'))
      return rule(parts.slice(i, i + 2).join('/'));
  }
  return undefined;
}

export interface SandboxViolation {
  operation: string;
  path: string;
}
/**
 * Отказы песочницы из журнала ядра macOS для одной проверки.
 *
 * srt помечает каждое правило запрета тегом с началом команды (base64) и
 * суффиксом сессии `_SBX`; команда проверки начинается с уникального
 * токена, и записи чужих песочниц на той же машине сюда не попадают. Текст
 * вывода проверки свидетельством не служит: его печатает сама проверка.
 */
export function parseSandboxLog(text: string, tag: string) {
  const found: SandboxViolation[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /Sandbox: .*? deny\(\d+\) (file-[\w-]+) (\/.*)$/.exec(lines[i]!);
    if (!m) continue;
    const cmd = /^CMD64_(.+?)_END/.exec(lines[i + 1] ?? '');
    if (!cmd || !Buffer.from(cmd[1]!, 'base64').toString('utf8').includes(tag)) continue;
    found.push({ operation: m[1]!, path: m[2]!.trim() });
  }
  return found;
}
/** Наблюдение за журналом песочницы на время проверки; без `log` — `undefined`. */
export async function watchSandboxLog(tag: string) {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/log')) return undefined;
  const child = spawn(
    '/usr/bin/log',
    ['stream', '--style', 'compact', '--predicate', 'eventMessage ENDSWITH "_SBX"'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let text = '';
  child.stdout.setEncoding('utf8');
  const ready = await new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), 3000);
    child.stdout.on('data', (chunk: string) => {
      text += chunk;
      // Заголовок `log stream` печатается, когда подписка уже действует.
      if (text.includes('Filtering the log data')) {
        clearTimeout(timer);
        done(true);
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      done(false);
    });
  });
  const stop = () => {
    child.stdout.removeAllListeners('data');
    child.kill();
  };
  if (!ready) {
    stop();
    return undefined;
  }
  return {
    /** Ждёт `drainMs`, пока ядро допишет записи, и возвращает отказы проверки. */
    async stop(drainMs: number) {
      if (drainMs) await new Promise((r) => setTimeout(r, drainMs));
      stop();
      return parseSandboxLog(text, tag);
    },
  };
}
/**
 * Отказы обязательной политики в открытых проверке каталогах, которые
 * подтвердило ядро. Запись вне открытых каталогов — ошибка кода проверки,
 * а не среды: её здесь нет.
 */
export function sandboxDenials(violations: SandboxViolation[], policy: Isolation) {
  const found = new Map<string, string>();
  for (const v of violations) {
    if (!v.operation.startsWith('file-write')) continue;
    const rule = mandatoryDenyRule(policy, v.path);
    if (rule && !found.has(v.path)) found.set(v.path, rule);
  }
  return [...found].map(([path, rule]) => ({ path, rule }));
}

/** Имена, которые проверка и исполнитель не создают и не меняют. */
const protectedNames = new Set<string>([...DANGEROUS_FILES, ...ideDirectories, '.claude', '.git']);
const snapshotLimit = 200_000;
/** Подпись каталога, в дереве которого нет ни файлов, ни символьных ссылок. */
const emptyTree = 'd:empty';
/**
 * Защищённые элементы checkout вне `node_modules`: путь → подпись.
 *
 * Запреты песочницы проверяют только путь операции. Каталог, собранный
 * внутри `node_modules` (там каталоги IDE открыты) и затем перенесённый в
 * дерево проекта, или новый каталог глубже перечисленных уровней ими не
 * закрыты; сверка снимков до и после проверки находит такой результат.
 */
export function protectedSnapshot(root: string) {
  const found = new Map<string, string>();
  let seen = 0;
  const count = () => {
    if (++seen > snapshotLimit)
      throw new SandboxPolicyError(
        `сверка защищённых путей не выполнена: в ${root} больше ${snapshotLimit} элементов вне node_modules`,
      );
  };
  const signature = (path: string): string => {
    count();
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return 'missing';
    }
    if (stat.isSymbolicLink()) return 'l:' + readlinkSync(path);
    if (!stat.isDirectory()) return `f:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    const names = readdirSync(path).sort();
    const inner = names.map((name) => signature(join(path, name)));
    // Дерево из одних каталогов не несёт ни конфигурации, ни ссылки наружу:
    // его подпись одна для любого такого дерева (см. `protectedChanges`).
    if (inner.every((sig) => sig === emptyTree)) return emptyTree;
    return `d:${stat.ino}[${names.map((name, i) => `${name}=${inner[i]}`).join(',')}]`;
  };
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      count();
      const path = join(dir, entry.name);
      if (entry.name === '.git' && dir === root && entry.isDirectory()) {
        // Обычный `.git`: объекты и индекс меняет и git хоста; сверяются
        // только конфигурация, hooks и перенаправления. Сам вид элемента
        // тоже: файл `.git` worktree, заменённый каталогом, — изменение,
        // даже если внутри одни пустые каталоги.
        found.set(path, 'd:git');
        for (const name of ['config', 'hooks', ...gitRedirects])
          found.set(join(path, name), signature(join(path, name)));
        continue;
      }
      if (protectedNames.has(entry.name)) {
        found.set(path, signature(path));
        continue;
      }
      if (entry.isDirectory() && entry.name !== 'node_modules') walk(path);
    }
  };
  walk(root);
  return found;
}
/**
 * Защищённые пути, которые появились или изменились после снимка `before`.
 *
 * Пустые каталоги (только каталоги, рекурсивно) нарушением не считаются,
 * если до снимка пути не было или он тоже был без файлов: исполняемой
 * конфигурации в них нет, а CLI исполнителя создаёт такие служебные каталоги
 * (`.claude/.cc-writes`) рядом с каждым записанным файлом. Путь, где раньше
 * были файлы, по-прежнему нарушение при любом изменении.
 */
export function protectedChanges(before: Map<string, string>, root: string) {
  const after = protectedSnapshot(root);
  return [...after]
    .filter(([path, sig]) => {
      if (sig === 'missing') return false;
      const was = before.get(path) ?? 'missing';
      if (sig === emptyTree && (was === 'missing' || was === emptyTree)) return false;
      return was !== sig;
    })
    .map(([path]) => path);
}

/**
 * Команда проверки внутри sandbox-runtime.
 *
 * Настройки пишутся в файл: srt отказывает, если файл пуст или невалиден, и
 * не откатывается к умолчаниям. Собственный служебный сокет srt кладёт во
 * временный каталог процесса, поэтому srt получает короткий системный
 * TMPDIR, а команде внутри передаётся свой scratch.
 *
 * `cwd` — каталог, из которого запускается srt (см. `protectedWriteDenies`):
 * на macOS это каталог метки старта, а в рабочий каталог проверки обёртка
 * переходит сама перед exec.
 */
export async function isolatedCommand(
  policy: Isolation,
  argv: string[],
  settingsDir: string,
  scratch: string,
  /**
   * Файл, который обёртка создаёт внутри песочницы перед exec команды. Его
   * отсутствие — единственный достоверный признак, что команда не начиналась.
   */
  started: string,
  /** Рабочий каталог команды. */
  workdir: string,
  /** Корни, которым нужны обязательные запреты записи (checkout проверки). */
  protect: string[] = [workdir],
  platform: NodeJS.Platform = process.platform,
  /**
   * Токен в начале команды: srt кладёт начало команды в тег записей журнала
   * ядра, и по нему отказы этой проверки отличаются от чужих (`parseSandboxLog`).
   */
  tag = '',
) {
  if (!/^[a-z0-9]*$/.test(tag)) throw new Error('Токен журнала песочницы — только [a-z0-9]');
  await mkdir(settingsDir, { recursive: true });
  const settings = join(settingsDir, 'isolation.json');
  const denies = platform === 'darwin' ? protectedWriteDenies(protect) : undefined;
  await writeFile(
    settings,
    JSON.stringify(
      {
        network: { allowedDomains: policy.domains, deniedDomains: [], allowLocalBinding: true },
        filesystem: {
          allowWrite: policy.write,
          denyWrite: denies ?? (platform === 'linux' ? linuxWriteDenies(protect) : []),
          denyRead: policy.hidden,
          allowRead: policy.readable,
        },
      },
      null,
      2,
    ),
  );
  return {
    argv: [
      process.execPath,
      srtCli,
      '--settings',
      settings,
      '--',
      '/bin/sh',
      '-c',
      `${tag ? `: ${tag}; ` : ''}: > "$0" && cd -- "$1" && shift && exec "$@"`,
      started,
      workdir,
      '/usr/bin/env',
      `TMPDIR=${scratch}`,
      ...argv,
    ],
    env: { TMPDIR: tmpdir() },
    // Без явных запретов srt остаётся в рабочем каталоге: его собственный
    // обязательный запрет действует от него.
    cwd: denies ? dirname(started) : workdir,
  };
}
