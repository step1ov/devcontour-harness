// Отказ установки зависимостей по вине сети или реестра пакетов.
//
// Установка (`pnpm install`, `npm ci`) тянет пакеты из реестра: 403 прокси,
// обрыв TLS или DNS роняют её так же, как ошибка в lockfile, и класс `gate`
// засчитывал такой обрыв найденным дефектом и тратил попытку поручения.
// Отказ — `environment` с причиной `dependency-network`, только когда
// выполнены все условия; иначе он остаётся прежним:
//
// 1. Команда закреплена политикой (gate, шаг `prepare`) и сама — установка
//    известным менеджером: `npm install|i|ci|clean-install`, `pnpm
//    install|i|fetch`, `yarn [install]`. Скрипты, `npx`, `exec`, shell и
//    неизвестные опции до подкоманды не распознаются.
// 2. Входы менеджера в проверяемом дереве совпадают с базой попытки
//    (закреплённым SHA целевой ветки): `.npmrc`, `.yarnrc*`, pnpmfile,
//    `pnpm-workspace.yaml`, lockfiles, `.pnp.*` — побайтно; в каждом
//    `package.json` — поля зависимостей, overrides/resolutions, `pnpm`,
//    `packageManager`, `workspaces` и скрипты установки. Изменил кандидат
//    реестр, URL tarball или добавил пакет, который закрыт прокси, — это его
//    отказ (`gate`), и его чинит следующая попытка.
// 3. База сама не исполняет кода при установке: ни в одном `package.json`
//    нет скриптов установки (`preinstall`, `install`, `postinstall`,
//    `prepare` …), нет pnpmfile, `.pnp.*`, а конфигурация не ссылается на код
//    (`pnpmfile`, `node-options`, `script-shell`, `yarnPath`, `plugins` …).
//    Иначе вывод установки мог напечатать исходник кандидата, которому
//    скрипт базы передал управление, — такому выводу верить нельзя.
// 4. Менеджер завершился сам с кодом 1–127: выход по сигналу (код ≥ 128, без
//    кода) — не его отчёт об ошибке.
// 5. Отчёт об ошибке — в формате самого менеджера: заголовок pnpm
//    (` ERR_PNPM_FETCH_403  …`, ` ECONNRESET  …`), строка `npm error code …`,
//    строка yarn `error An unexpected error occurred: …`. Каждый названный код
//    — сетевой (HTTP 403/407/408/429/5xx реестра, errno соединения, TLS), у
//    каждой строки ошибки yarn — сетевая подпись, а признаков ошибки проекта
//    (lockfile, нет версии, 404, peer-зависимости, упавший скрипт, целостность)
//    в выводе нет. Сетевые слова в выводе скриптов и предупреждениях повтора
//    сами по себе не засчитываются.
//
// Остаток риска — настоящий отказ реестра на входах базы. Он ограничен общими
// пределами класса `environment`: повтор одного отпечатка, пауза очереди и
// `MAX_NEUTRAL_FAILURES` на поручение — дальше решает человек.

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { gitOutput } from './process.ts';

/** Причина отказа среды, которую несёт сообщение: стабильный токен в начале. */
export const DEPENDENCY_NETWORK = 'dependency-network';

const managers = new Set(['npm', 'pnpm', 'yarn']);
/** Подкоманды установки; `yarn` без подкоманды — тоже установка. */
const installs: Record<string, Set<string>> = {
  npm: new Set(['install', 'i', 'ci', 'clean-install']),
  pnpm: new Set(['install', 'i', 'fetch']),
  yarn: new Set(['install']),
};
/** Опции до подкоманды, берущие значение следующим словом. */
const valued: Record<string, Set<string>> = {
  npm: new Set([
    '-C',
    '--prefix',
    '--loglevel',
    '--registry',
    '--cache',
    '--userconfig',
    '-w',
    '--workspace',
  ]),
  pnpm: new Set(['-C', '--dir', '--filter', '-F', '--loglevel', '--reporter', '--registry']),
  yarn: new Set(['--cwd', '--cache-folder', '--modules-folder', '--network-timeout']),
};
/** Опции без значения до подкоманды; любая другая делает argv неоднозначным. */
const flags = new Set([
  '--frozen-lockfile',
  '--no-frozen-lockfile',
  '--pure-lockfile',
  '--immutable',
  '--prefer-offline',
  '--offline',
  '--ignore-scripts',
  '--silent',
  '-s',
  '--quiet',
  '-q',
  '--verbose',
  '--strict-peer-dependencies',
  '-r',
  '--recursive',
  '--production',
  '--prod',
  '-P',
  '--dev',
  '-D',
  '--no-optional',
  '--no-audit',
  '--no-fund',
  '--non-interactive',
  '--no-progress',
  '--color',
  '--no-color',
  '--legacy-peer-deps',
  '--workspace-root',
  '-w',
]);

/** Имя программы: без каталога, расширения Windows и версии corepack (`pnpm@9`). */
const programOf = (path: string) =>
  path
    .slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
    .toLowerCase()
    .replace(/\.(?:cmd|exe|bat|ps1)$/, '')
    .replace(/@[^@]*$/, '');

/**
 * Argv — установка зависимостей известным менеджером пакетов: `npm
 * install|i|ci|clean-install`, `pnpm install|i|fetch`, `yarn [install]`, в том
 * числе через `corepack` (и `corepack pnpm@9`), по абсолютному пути и с `.cmd`.
 * До подкоманды допускаются только известные опции; `--`, неизвестная опция
 * без `=` (её значение не отличить от подкоманды), скрипты (`npm run …`),
 * `npx`, `exec`, shell — не установка.
 */
export function isDependencyInstall(argv: readonly string[]) {
  let rest = [...argv];
  if (rest[0] && programOf(rest[0]) === 'corepack') rest = rest.slice(1);
  const manager = rest[0] ? programOf(rest[0]) : '';
  if (!managers.has(manager)) return false;
  let i = 1;
  for (; i < rest.length && rest[i]!.startsWith('-'); i++) {
    const option = rest[i]!;
    if (option === '--') return false;
    if (option.startsWith('--') && option.includes('=')) continue;
    if (valued[manager]!.has(option)) i++;
    else if (!flags.has(option)) return false;
  }
  const sub = rest[i];
  if (sub === undefined) return manager === 'yarn' && i === rest.length;
  return installs[manager]!.has(sub);
}

/** Коды HTTP реестра, которые говорят о среде: доступ, прокси, предел частоты, сбой сервера. */
const httpStatus = '(?:403|407|408|429|5\\d\\d)';
/** errno соединения и отказы TLS Node. */
const errno =
  'ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPROTO|ERR_SOCKET_TIMEOUT|ERR_SOCKET_CONNECTION_TIMEOUT|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_[A-Z_]+|ERR_SSL_[A-Z0-9_]+|ERR_TLS_[A-Z0-9_]+';

/** Код ошибки, названный менеджером, — сетевой. */
const networkCode = new RegExp(
  `^(?:ERR_PNPM_FETCH_${httpStatus}|ERR_PNPM_(?:META_)?FETCH_FAIL|ERR_PNPM_BAD_TARBALL_SIZE|ERR_PNPM_(?:${errno})|E${httpStatus}|FETCH_ERROR|${errno})$`,
);

/**
 * Признаки ошибки проекта где угодно в выводе: при любом из них отказ остаётся
 * `gate`, даже рядом с сетевым кодом.
 */
const projectSignatures: RegExp[] = [
  /\bERR_PNPM_(?:OUTDATED_LOCKFILE|NO_MATCHING_VERSION|FETCH_404|PEER_DEP_ISSUES|LOCKFILE_[A-Z_]+|TARBALL_INTEGRITY|[A-Z_]*LIFECYCLE[A-Z_]*)\b/,
  /^\s*npm (?:error|ERR!) code (?:E404|ETARGET|ERESOLVE|EUSAGE|EINTEGRITY|ELIFECYCLE|\d+)\b/m,
  // Упавший скрипт жизненного цикла: pnpm — `ELIFECYCLE` и «Failed in … at»,
  // npm и yarn — `command failed`.
  /\bELIFECYCLE\b/,
  /\bcommand failed\b/i,
  /\bFailed in \d+(?:\.\d+)?m?s at\b/,
  /\b404 Not Found\b/i,
  /\bResponse Code: 404\b/,
  /\bis not in (?:this|the npm) registry\b/i,
  /\bNo matching version found\b/i,
  /\bcan only install packages when your package\.json and\b/,
  /\bIntegrity check failed\b/i,
  /\bCouldn't find (?:package|any versions)\b/,
  /\bYour lockfile needs to be updated\b/,
  /\bYN0(?:009|028|035)\b/,
];

const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** Заголовок ошибки pnpm: код в узких (U+2009) или обычных пробелах, затем текст. */
const pnpmHeader = /^[ \u2009]?([A-Z][A-Z0-9_]{2,})[ \u2009]{2,}\S/;
const notErrors = new Set(['WARN', 'INFO', 'DEBUG']);
const npmCode = /^npm (?:error|ERR!) code (\S+)/;
const yarnError = /^error (.*)$/;
const yarnNetwork = new RegExp(
  `^An unexpected error occurred: ".*(?:\\b(?:${errno})\\b|socket hang up|Client network socket disconnected before secure TLS connection was established|\\b${httpStatus}\\b)`,
);

/**
 * Строка отчёта менеджера о сетевом отказе — или `undefined`, когда вывод не
 * доказывает его (условия 1, 4, 5 правила; входы дерева — `untrustedInputs`).
 */
export function registryFailureLine(
  argv: readonly string[],
  code: number | null | undefined,
  output: string,
) {
  if (!isDependencyInstall(argv)) return undefined;
  if (typeof code !== 'number' || code < 1 || code > 127) return undefined;
  const text = output.replace(ansi, '');
  if (projectSignatures.some((re) => re.test(text))) return undefined;
  let found: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const header = pnpmHeader.exec(line)?.[1];
    const npm = npmCode.exec(line)?.[1];
    const yarn = yarnError.exec(line)?.[1];
    const reported = header && !notErrors.has(header) ? header : npm;
    if (reported !== undefined) {
      if (!networkCode.test(reported)) return undefined;
      found ??= line.trim();
    } else if (yarn !== undefined) {
      if (!yarnNetwork.test(yarn)) return undefined;
      found ??= line.trim();
    }
  }
  return found && (found.length > 200 ? found.slice(0, 200) + '…' : found);
}

/** Файлы конфигурации и lockfiles менеджеров: сверяются побайтно. */
const configNames = new Set([
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
  '.pnpmfile.mjs',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  '.pnp.cjs',
  '.pnp.loader.mjs',
]);
/** Код, который менеджер исполняет при установке, если он есть в базе. */
const codeFiles = new Set(['.pnpmfile.cjs', '.pnpmfile.mjs', '.pnp.cjs', '.pnp.loader.mjs']);
/** Ключи конфигурации, ссылающиеся на код или shell. */
const codeKeys =
  /^\s*["']?(?:pnpmfile|global-pnpmfile|globalPnpmfile|node-options|nodeOptions|script-shell|scriptShell|shell-emulator|onload-script|init-module|yarnPath|yarn-path|plugins)["']?\s*[:=]/im;
/** Поля `package.json`, от которых зависит установка. */
const manifestFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundleDependencies',
  'bundledDependencies',
  'dependenciesMeta',
  'overrides',
  'resolutions',
  'pnpm',
  'packageManager',
  'workspaces',
];
/** Скрипты, которые менеджеры исполняют при установке. */
const installScripts = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'dependencies',
  'pnpm:devPreinstall',
];

const watched = (path: string) => {
  const name = posix.basename(path);
  return (
    !path.split('/').includes('node_modules') && (name === 'package.json' || configNames.has(name))
  );
};

const blobOf = (bytes: Buffer) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** Значимая для установки часть манифеста; битый JSON — undefined. */
function manifestKey(text: string) {
  try {
    const json = JSON.parse(text) as Record<string, unknown> | null;
    if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
    const scripts = (json.scripts ?? {}) as Record<string, unknown>;
    return JSON.stringify([
      ...manifestFields.map((f) => json[f] ?? null),
      ...installScripts.map((s) => (typeof scripts === 'object' ? (scripts[s] ?? null) : scripts)),
    ]);
  } catch {
    return undefined;
  }
}

const hasInstallScripts = (text: string) => {
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
    if (scripts === undefined) return false;
    if (!scripts || typeof scripts !== 'object') return true;
    return installScripts.some((s) => (scripts as Record<string, unknown>)[s] !== undefined);
  } catch {
    return true;
  }
};

/**
 * Почему входам установки в дереве `root` верить нельзя (условия 2 и 3
 * правила), или `undefined`, если они совпадают с базой `base` и база не
 * исполняет кода при установке. `cwd` — каталог команды: конфигурация в нём и
 * его предках внутри дерева проверяется и тогда, когда git её игнорирует.
 * Любая ошибка чтения — недоверие.
 */
export async function untrustedInputs(root: string, base: string, cwd = root) {
  try {
    const baseFiles = new Map<string, { mode: string; blob: string }>();
    for (const entry of (await gitOutput(root, 'ls-tree', '-r', '-z', '--full-tree', base)).split(
      '\0',
    )) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const path = entry.slice(tab + 1);
      if (!watched(path)) continue;
      const [mode, , blob] = entry.slice(0, tab).split(' ');
      baseFiles.set(path, { mode: mode!, blob: blob! });
    }
    const paths = new Set(baseFiles.keys());
    for (const path of (
      await gitOutput(root, 'ls-files', '-z', '-c', '-o', '--exclude-standard')
    ).split('\0'))
      if (path && watched(path)) paths.add(path);
    // Конфигурация, которую git игнорирует, менеджер всё равно читает: в корне,
    // в каталогах манифестов и на пути к каталогу команды.
    const dirs = new Set<string>(['']);
    for (const path of paths) dirs.add(posix.dirname(path) === '.' ? '' : posix.dirname(path));
    const own = relative(root, cwd).split(sep).join('/');
    if (!own.startsWith('..'))
      for (let d = own; d && d !== '.'; d = posix.dirname(d) === '.' ? '' : posix.dirname(d))
        dirs.add(d);
    for (const dir of dirs)
      for (const name of configNames) {
        const path = dir ? `${dir}/${name}` : name;
        if (paths.has(path)) continue;
        if (
          await lstat(join(root, path)).then(
            () => true,
            () => false,
          )
        )
          paths.add(path);
      }
    for (const path of [...paths].sort()) {
      const name = posix.basename(path);
      const before = baseFiles.get(path);
      if (before && before.mode === '120000') return `ссылка в базе: ${path}`;
      if (before && codeFiles.has(name)) return `код установки в базе: ${path}`;
      const stat = await lstat(join(root, path)).catch(() => undefined);
      if (stat && !stat.isFile()) return `не обычный файл: ${path}`;
      const bytes = stat ? await readFile(join(root, path)) : undefined;
      if (!before && !bytes) continue;
      if (!before || !bytes) return `${before ? 'удалён' : 'добавлен'} ${path}`;
      const baseText =
        name === 'package.json' || !/lock|\.lockb$/.test(name)
          ? await gitOutput(root, 'cat-file', 'blob', before.blob)
          : undefined;
      if (name === 'package.json') {
        if (hasInstallScripts(baseText!)) return `скрипт установки в базе: ${path}`;
        if (before.blob === blobOf(bytes)) continue;
        const was = manifestKey(baseText!);
        if (was === undefined || was !== manifestKey(bytes.toString('utf8')))
          return `изменены зависимости или скрипты установки: ${path}`;
        continue;
      }
      if (baseText !== undefined && codeKeys.test(baseText))
        return `конфигурация ссылается на код: ${path}`;
      if (before.blob !== blobOf(bytes)) return `изменён ${path}`;
    }
    return undefined;
  } catch (error) {
    return (
      'входы установки не прочитаны: ' + (error instanceof Error ? error.message : String(error))
    );
  }
}

/** Где и чем исполнялась упавшая установка. */
export interface InstallFailure {
  argv: readonly string[];
  code: number | null | undefined;
  output: string;
  /** Корень проверяемого дерева. */
  root: string;
  /** Каталог команды. */
  cwd?: string;
  /** SHA базы, с которой сверяются входы; нет базы — нет и классификации. */
  base?: string;
}

/**
 * Строка-подпись сетевого отказа установки, если выполнены все условия
 * правила, иначе `undefined`: отказ остаётся прежнего класса.
 */
export async function dependencyNetworkFailure(failure: InstallFailure) {
  if (!failure.base) return undefined;
  const line = registryFailureLine(failure.argv, failure.code, failure.output);
  if (!line) return undefined;
  if (await untrustedInputs(failure.root, failure.base, failure.cwd ?? failure.root))
    return undefined;
  return line;
}

/** Сообщение отказа: токен причины первым, чтобы `explain` показал его и после обрезки. */
export const dependencyNetworkMessage = (signature: string, detail: string) =>
  `${DEPENDENCY_NETWORK}: установка зависимостей не получила пакеты из реестра — отказ сети или реестра, а не проекта (${signature}). ${detail}`;
