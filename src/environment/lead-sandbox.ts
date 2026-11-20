import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Проверка «ведущий внутри чужой песочницы» (например, `codex exec -s
 * workspace-write`): там `.git` только для чтения (git не создаёт ветку и
 * рабочие деревья), собственная OS-изоляция harness не запускается вложенно
 * (`sandbox_apply: Operation not permitted`), а `ps` отказывает EPERM.
 * Пробы дешёвые и без побочных эффектов: единственная запись — временный
 * файл пробы с уникальным именем, который удаляется по точному пути.
 */

/** Результат запуска команды пробы. */
export interface ProbeRun {
  status: number | null;
  stderr: string;
  /** Код ошибки запуска (`ENOENT`, `EPERM`, …), если процесс не стартовал. */
  errorCode?: string;
}

/** Пробы среды; каждую можно подменить в тестах. */
export interface LeadSandboxProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  pid: number;
  run(command: string, args: readonly string[]): ProbeRun;
  /** Каталог git (общий для worktree) репозитория; нет — undefined. */
  gitDir(repository: string): string | undefined;
  /** Можно ли создать файл в каталоге; каталога нет или ошибка не про права — undefined. */
  writable(dir: string): boolean | undefined;
}

export interface LeadSandboxResult {
  /** Есть твёрдый признак песочницы (не только переменные окружения). */
  inside: boolean;
  /**
   * Коды признаков: `nested-sandbox`, `ps-denied`, `git-readonly:<путь>`,
   * `state-readonly`, `codex-env` (подсказка, не доказательство).
   */
  signals: string[];
  advice: string;
  adviceEn: string;
  /** Запуск ведущего без песочницы (только на доверенной машине). */
  flags: string;
  /** Узкий вариант: запись в `.git`, каталог состояния и сеть внутри песочницы Codex. */
  narrowFlags: string;
}

export interface LeadSandboxOptions {
  /** Репозитории политики (абсолютные пути). */
  repositories?: readonly string[];
  stateDir?: string;
  probe?: Partial<LeadSandboxProbe>;
}

const PROBE_TIMEOUT_MS = 5000;
const denied = /operation not permitted|sandbox_apply|EPERM/i;
const deniedCodes = new Set(['EPERM', 'EACCES', 'EROFS']);

const defaultRun = (command: string, args: readonly string[]): ProbeRun => {
  const r = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: PROBE_TIMEOUT_MS,
  });
  return {
    status: r.status,
    stderr: r.stderr ?? '',
    ...(r.error ? { errorCode: (r.error as NodeJS.ErrnoException).code ?? 'ERROR' } : {}),
  };
};

const defaultGitDir = (repository: string): string | undefined => {
  const r = spawnSync('git', ['-C', repository, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: PROBE_TIMEOUT_MS,
  });
  const out = r.status === 0 ? r.stdout.trim() : '';
  if (out) return isAbsolute(out) ? out : resolve(repository, out);
  const fallback = join(repository, '.git');
  try {
    return statSync(fallback).isDirectory() ? fallback : undefined;
  } catch {
    return undefined;
  }
};

const defaultWritable = (dir: string): boolean | undefined => {
  try {
    if (!statSync(dir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  // Уникальное имя и флаг `wx`: чужой файл не перезаписывается и не удаляется.
  const file = join(dir, `.harness-lead-probe-${process.pid}-${randomBytes(6).toString('hex')}`);
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code && deniedCodes.has(code) ? false : undefined;
  }
  closeSync(fd);
  try {
    unlinkSync(file);
  } catch {
    /* файл пробы остался — запись всё равно возможна */
  }
  return true;
};

const failedWithDenial = (r: ProbeRun) =>
  (r.errorCode !== undefined && deniedCodes.has(r.errorCode)) ||
  (r.status !== 0 && denied.test(r.stderr));

/** Путь для shell: в одинарных кавычках, если в нём есть особые символы. */
const shellPath = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

export const LEAD_UNSANDBOXED_FLAGS = 'codex exec --dangerously-bypass-approvals-and-sandbox';

/** Узкий вариант запуска ведущего Codex для заданных `.git` и каталога состояния. */
export function leadNarrowFlags(gitDirs: readonly string[], stateDir?: string): string {
  const dirs = [...new Set([...gitDirs, ...(stateDir ? [resolve(stateDir)] : [])])];
  return [
    'codex exec -s workspace-write',
    ...(dirs.length ? dirs : ['<repo>/.git', '<state>']).map(
      (d) => `--add-dir ${dirs.length ? shellPath(d) : d}`,
    ),
    '-c sandbox_workspace_write.network_access=true',
  ].join(' ');
}

/** Обнаружение песочницы ведущего; без признаков — `inside: false`. */
export function leadSandboxCheck(options: LeadSandboxOptions = {}): LeadSandboxResult {
  const probe: LeadSandboxProbe = {
    platform: process.platform,
    env: process.env,
    pid: process.pid,
    run: defaultRun,
    gitDir: defaultGitDir,
    writable: defaultWritable,
    ...options.probe,
  };
  const signals: string[] = [];
  // 1. Вложенная песочница: внутри seatbelt `sandbox-exec` отказывает sandbox_apply.
  if (probe.platform === 'darwin') {
    const r = probe.run('/usr/bin/sandbox-exec', [
      '-p',
      '(version 1)(allow default)',
      '/usr/bin/true',
    ]);
    if (r.errorCode !== 'ENOENT' && failedWithDenial(r)) signals.push('nested-sandbox');
  } else if (
    probe.platform === 'linux' &&
    Object.keys(probe.env).some((k) => k === 'CODEX_SANDBOX' || k.startsWith('CODEX_SANDBOX_'))
  ) {
    // bwrap отказывает и на хосте без непривилегированных user namespaces
    // (AppArmor, контейнеры): там это свойство хоста, а не песочница ведущего.
    // Поэтому на Linux проба — только при переменных песочницы Codex; bwrap
    // есть не везде, нет его — проба пропускается.
    const r = probe.run('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true']);
    if (r.errorCode !== 'ENOENT' && failedWithDenial(r)) signals.push('nested-sandbox');
  }
  // 2. `ps` по собственному pid.
  const ps = probe.run('ps', ['-o', 'pid=', '-p', String(probe.pid)]);
  if (ps.errorCode !== 'ENOENT' && failedWithDenial(ps)) signals.push('ps-denied');
  // 3. Запись в `.git` репозиториев и в каталог состояния.
  const gitDirs: string[] = [];
  for (const repository of options.repositories ?? []) {
    const dir = probe.gitDir(repository);
    if (!dir || gitDirs.includes(dir)) continue;
    gitDirs.push(dir);
    if (probe.writable(dir) === false) signals.push(`git-readonly:${dir}`);
  }
  if (options.stateDir && probe.writable(resolve(options.stateDir)) === false)
    signals.push('state-readonly');
  // 4. Переменные Codex — подсказка, не доказательство.
  if (Object.keys(probe.env).some((k) => k === 'CODEX_SANDBOX' || k.startsWith('CODEX_SANDBOX_')))
    signals.push('codex-env');
  const inside = signals.some((s) => s !== 'codex-env');
  const narrowFlags = leadNarrowFlags(gitDirs, options.stateDir);
  const flags = LEAD_UNSANDBOXED_FLAGS;
  const mac = probe.platform === 'darwin';
  const advice = inside
    ? `Ведущий работает внутри песочницы (например, Codex seatbelt): ${signals.join(', ')}. ` +
      'В ней git не может создать ветку и рабочие деревья, если `.git` только для чтения, ' +
      `а собственная OS-изоляция harness для исполнителей, gates и ревью ${mac ? 'не запускается' : 'может не запуститься'} вложенно (sandbox_apply: Operation not permitted). ` +
      `Запустите ведущего без песочницы на доверенной машине: \`${flags}\`. ` +
      `Узкий вариант даёт запись в .git, каталог состояния и сеть для CLI исполнителей: \`${narrowFlags}\`; ` +
      'но команды, запускающие модели или gates (run, smoke, gates, review-plan), и в нём требуют ведущего без песочницы или оператора вне её.'
    : signals.length
      ? 'Заданы переменные песочницы Codex, но пробы прошли: песочница не мешает harness.'
      : '';
  const adviceEn = inside
    ? `The lead runs inside a sandbox (e.g. Codex seatbelt): ${signals.join(', ')}. ` +
      'git cannot create branches or worktrees while `.git` is read-only, ' +
      `and harness's own OS isolation of writers, gates and reviewers ${mac ? 'cannot' : 'may not'} nest inside it (sandbox_apply: Operation not permitted). ` +
      `Run the lead unsandboxed on a trusted machine: \`${flags}\`. ` +
      `The narrow variant grants .git, the state directory and network for writer CLIs: \`${narrowFlags}\`; ` +
      'commands that start models or gates (run, smoke, gates, review-plan) still need an unsandboxed lead or an operator outside the sandbox.'
    : signals.length
      ? 'Codex sandbox variables are set, but the probes passed: the sandbox does not block harness.'
      : '';
  return { inside, signals, advice, adviceEn, flags, narrowFlags };
}
