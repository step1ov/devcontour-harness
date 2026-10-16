import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { realpathSync, readdirSync } from 'node:fs';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

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
      entries = [...new Set([...readdirSync(hidden), ...controllerEntries])].map((name) =>
        join(hidden, name),
      );
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
 * Команда проверки внутри sandbox-runtime.
 *
 * Настройки пишутся в файл: srt отказывает, если файл пуст или невалиден, и
 * не откатывается к умолчаниям. Собственный служебный сокет srt кладёт во
 * временный каталог процесса, поэтому srt получает короткий системный
 * TMPDIR, а команде внутри передаётся свой scratch.
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
) {
  await mkdir(settingsDir, { recursive: true });
  const settings = join(settingsDir, 'isolation.json');
  await writeFile(
    settings,
    JSON.stringify(
      {
        network: { allowedDomains: policy.domains, deniedDomains: [], allowLocalBinding: true },
        filesystem: {
          allowWrite: policy.write,
          denyWrite: [],
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
      ': > "$0" && exec "$@"',
      started,
      '/usr/bin/env',
      `TMPDIR=${scratch}`,
      ...argv,
    ],
    env: { TMPDIR: tmpdir() },
  };
}
