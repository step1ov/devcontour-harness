import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { realpathSync, readdirSync } from 'node:fs';
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
    // Обход в ширину: сначала мелкие уровни, предел числа каталогов держит
    // профиль песочницы в разумном размере на больших деревьях.
    let level = [root],
      seen = 0;
    for (let depth = 0; depth < ideDepth && level.length && seen < ideDirsLimit; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        if (++seen > ideDirsLimit) break;
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

/**
 * Какое правило песочницы, по всей видимости, отказало в доступе к `path`.
 * `undefined` — путь открыт политикой: отказ дала не песочница.
 */
export function sandboxRule(policy: Isolation, path: string) {
  const within = (p: string, root: string) => p === root || p.startsWith(root + sep);
  if (policy.hidden.some((h) => within(path, h)) && !policy.readable.some((r) => within(path, r)))
    return 'путь закрыт на чтение (каталог контура или учётных данных)';
  const root = policy.write.find((w) => within(path, w));
  if (!root) return 'путь вне каталогов, открытых проверке на запись (allowWrite)';
  const parts = relative(root, path).split(sep);
  const at = (i: number, ...names: string[]) => names.every((n, k) => parts[i + k] === n);
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    if ((DANGEROUS_FILES as readonly string[]).includes(name) && i === parts.length - 1)
      return `обязательный запрет записи sandbox-runtime: ${name}`;
    // Каталоги IDE внутри дерева зависимостей открыты (`protectedWriteDenies`).
    if (ideDirectories.includes(name) && !parts.slice(0, i).includes('node_modules'))
      return `обязательный запрет записи sandbox-runtime: каталог IDE ${name}`;
    if (at(i, '.git', 'hooks') || at(i, '.git', 'config'))
      return `обязательный запрет записи sandbox-runtime: ${parts.slice(i, i + 2).join('/')}`;
    if (at(i, '.claude', 'commands') || at(i, '.claude', 'agents'))
      return `обязательный запрет записи sandbox-runtime: ${parts.slice(i, i + 2).join('/')}`;
  }
  return undefined;
}

/** Настоящий путь: политика записана настоящими путями (/var → /private/var). */
function realAncestor(path: string) {
  for (let head = path, tail = ''; ;) {
    try {
      return join(realpathSync(head), tail);
    } catch {
      const up = dirname(head);
      if (up === head) return path;
      tail = join(head.slice(up.length + (up === '/' ? 0 : 1)), tail);
      head = up;
    }
  }
}

/**
 * Отказы песочницы в выводе проверки: строки с EPERM / «Operation not
 * permitted» / «permission denied» и абсолютным путём, который политика
 * действительно закрывает. Отказ внутри открытого пути (тест сам снял права
 * с файла) песочнице не приписывается.
 */
export function sandboxDenials(output: string, policy: Isolation) {
  const found = new Map<string, string>();
  for (const line of output.split('\n')) {
    if (!/\bEPERM\b|operation not permitted|permission denied/i.test(line)) continue;
    // Сеть разбирается отдельно (`sandboxBlockedHosts`).
    if (/\bconnect\b/i.test(line)) continue;
    const quoted = [...line.matchAll(/'(\/[^']+)'|"(\/[^"]+)"/g)].map((m) => (m[1] ?? m[2])!);
    // Без кавычек — форма shell «программа: путь: Operation not permitted»:
    // путь программы в начале строки отказом не считается.
    const bare = [...line.matchAll(/(?:^|[\s(=])(\/[^\s'",:)]+)/g)]
      .filter((m, _, all) => !(all.length > 1 && m.index === 0 && line[m[0].length] === ':'))
      .map((m) => m[1]!);
    for (const raw of quoted.length ? quoted : bare) {
      const path = realAncestor(raw);
      const rule = sandboxRule(policy, path);
      if (rule && !found.has(path)) found.set(path, rule);
    }
  }
  return [...found].map(([path, rule]) => ({ path, rule }));
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
) {
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
          denyWrite: denies ?? [],
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
      ': > "$0" && cd -- "$1" && shift && exec "$@"',
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
