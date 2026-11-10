import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir, mkdtemp, realpath, rm, readdir, lstat, rename } from 'node:fs/promises';
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
  /**
   * Корни рабочих деревьев вне каталога состояния (`checkout-root.ts`):
   * закрыты целиком, как каталог состояния; свои деревья проверки открыты
   * более конкретным разрешением (`write`, `readable`). Деревья других
   * попыток закрыты, и появившиеся после построения политики тоже. Поиск
   * конфигурации вверх по дереву не ломается: в корне нет файлов
   * конфигурации, а `stat` отсутствующего файла под запретом Seatbelt
   * отвечает ENOENT, метаданные каталогов-предков открыты.
   */
  checkouts?: string[];
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
    hidden: real([...options.controller, ...(options.checkouts ?? []), ...credentialPaths()]),
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
  'dependency-store',
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

/**
 * Предзагрузка процесса srt: поиск shell без порождения `which`.
 *
 * srt на каждый запуск ищет shell через `spawnSync('which', [shell],
 * { timeout: 1000 })`. Под нагрузкой машины порождение `which` не
 * укладывается в секунду, srt печатает «Shell 'bash' not found in PATH» и
 * выходит до запуска команды: проверка падала как будто по вине проекта.
 * Передать srt путь shell нельзя: у CLI такой опции нет, а абсолютный путь
 * он тоже проверяет через `which`. Поэтому такой вызов отвечается в процессе
 * srt: исполняемый файл ищется по тому же PATH, что у `which`, но только в
 * абсолютных каталогах — относительный или пустой элемент PATH указывает на
 * текущий каталог, то есть, возможно, в проверяемое дерево. Не найденное и
 * любые другие вызовы уходят в настоящий `spawnSync` — ответ «нет такого
 * shell» по-прежнему даёт `which`, а не эта подмена.
 */
export const srtShellLookup =
  'data:text/javascript,' +
  encodeURIComponent(`
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
const original = cp.spawnSync;
const find = (bin, path) => {
  if (bin.includes('/') && !isAbsolute(bin)) return;
  const dirs = bin.includes('/') ? [''] : (path ?? '').split(delimiter).filter((d) => isAbsolute(d));
  for (const dir of dirs) {
    const file = dir ? join(dir, bin) : bin;
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {}
  }
};
cp.spawnSync = function spawnSync(command, args, options) {
  if (command === 'which' && Array.isArray(args) && args.length === 1 &&
      typeof args[0] === 'string' && args[0] && !args[0].startsWith('-') &&
      options?.encoding === 'utf8') {
    const file = find(args[0], (options.env ?? process.env).PATH);
    if (file) {
      const stdout = file + '\\n';
      return { pid: 0, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
    }
  }
  return original.apply(this, arguments);
};
syncBuiltinESMExports();
`);

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
 * - Регистр. Правила srt (`subpath`, `regex`) записаны в нижнем регистре, но
 *   Seatbelt на нечувствительном к регистру томе (APFS по умолчанию)
 *   сравнивает путь без регистра: проба под песочницей отказывает в записи в
 *   `.IDEA/x`, `.VSCode/x`, `.Bashrc`, `.Claude/commands/x` и `x/.GIT/hooks/x`
 *   так же, как в именах нижнего регистра. На Linux ФС обычно различает
 *   регистр, и `.Claude` хост не читает как `.claude`. Имена, которых в
 *   запретах нет (`.claude/settings.json` в любом регистре), и пути глубже
 *   перечисленных уровней ловит сверка снимков (`protectedSnapshot`) — она
 *   сравнивает имена без регистра везде.
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
          if (safe) denies.push(anchoredAtRoot(root, join(dir, '*', name)));
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
 * Шаблон запрета под каталогом `dir` внутри `root`, база которого — `root`.
 *
 * srt закрепляет базу шаблона (статический префикс до первого символа глоба)
 * и всех её предков запретом `file-write-unlink`/`file-write-create`: иначе
 * каталог можно было бы перенести из-под запрета. Шаблон `<dir>/*\/.idea`
 * закреплял так каждый существующий каталог дерева до глубины перечисления:
 * проверка не могла удалить или переименовать даже свой прежний вывод
 * (`.reports/expo-export`, оставленный самопроверкой исполнителя), и
 * `expo export` падал с `EPERM rmdir`.
 *
 * Один символ первого сегмента под `root` записывается классом (`.reports` →
 * `[.]reports`): шаблон совпадает с теми же путями (класс из одного символа —
 * этот символ), а статический префикс обрывается в `root`, и закреплены
 * только `root` и его предки, как у шаблонов `root/**\/<имя>`. Перенос
 * каталога с подложенным внутри `.idea` по-прежнему ловит сверка снимков
 * (`protectedSnapshot`) — как и новый каталог, которого при сборке политики
 * не было. Символ — печатный ASCII: класс Seatbelt сравнивает байты, и
 * многобайтовый символ в классе совпал бы не с тем. Сегмент без такого
 * символа остаётся прежним шаблоном.
 */
export function anchoredAtRoot(root: string, pattern: string) {
  const rest = relative(root, pattern);
  if (!rest || rest.startsWith('..') || pattern !== join(root, rest)) return pattern;
  const first = rest.split(sep)[0]!;
  // `*` и прочие символы глоба отсюда не приходят (`glob` проверен выше);
  // `^` в начале класса — отрицание, `\` и `-` — служебные.
  const at = [...first].findIndex((c) => /^[\x20-\x7e]$/.test(c) && !/[\^\\\-*?[\]]/.test(c));
  if (first === '*' || at < 0) return pattern;
  const chars = [...first];
  const anchored = chars.slice(0, at).join('') + `[${chars[at]}]` + chars.slice(at + 1).join('');
  return join(root, anchored, rest.slice(first.length));
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
  const raw = relative(root, path).split(sep);
  // Seatbelt на нечувствительном к регистру томе (APFS по умолчанию) отказывает
  // и в `.IDEA/x`, и в `.Claude/commands`: имена сравниваются без регистра.
  // `node_modules` — как в перечислении `protectedWriteDenies`, точно.
  const parts = raw.map((p) => p.toLowerCase());
  const at = (i: number, ...names: string[]) => names.every((n, k) => parts[i + k] === n);
  const rule = (what: string) => `обязательный запрет записи sandbox-runtime: ${what}`;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    if ((DANGEROUS_FILES as readonly string[]).includes(name) && i === parts.length - 1)
      return rule(name);
    // Каталоги IDE внутри дерева зависимостей открыты (`protectedWriteDenies`).
    if (ideDirectories.includes(name) && !raw.slice(0, i).includes('node_modules'))
      return rule(`каталог IDE ${name}`);
    if (at(i, '.git', 'hooks') || at(i, '.git', 'config'))
      return rule(raw.slice(i, i + 2).join('/'));
    if (name === '.git' && i === 0 && parts.length === 1) return rule('файл .git рабочего дерева');
    if (name === '.git' && i === 0 && gitRedirects.includes(parts[1] ?? ''))
      return rule(`.git/${raw[1]}`);
    if (name === '.git' && i > 0) return rule('вложенный репозиторий .git');
    if (at(i, '.claude', 'commands') || at(i, '.claude', 'agents'))
      return rule(raw.slice(i, i + 2).join('/'));
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
 * Запрет чтения, которым песочница закрыла путь: путь внутри закрытого и не
 * внутри более конкретного открытого (srt: открытое внутри закрытого
 * побеждает, закрытое внутри открытого — снова закрыто).
 */
export function hiddenReadRule(policy: Isolation, path: string) {
  const within = (p: string, root: string) => p === root || p.startsWith(root + sep);
  const longest = (paths: string[]) =>
    paths.filter((p) => within(path, p)).reduce((a, b) => (b.length > a.length ? b : a), '');
  const hidden = longest(policy.hidden);
  if (!hidden) return undefined;
  if (longest([...policy.readable, ...policy.write]).length >= hidden.length) return undefined;
  return `запрет чтения песочницы: ${hidden} закрыт проверке`;
}

/**
 * Каталоги, которые srt закрепляет от удаления и переноса запретами записи
 * для корней `roots` (`protectedWriteDenies`): база каждого шаблона
 * (статический префикс до первого символа глоба) и предки буквального пути.
 * Возвращаются базы; закреплены и все их предки.
 */
export function pinnedBases(roots: string[]) {
  const denies = protectedWriteDenies(roots) ?? [];
  return [
    ...new Set(
      denies.map((d) => {
        if (!glob.test(d)) return dirname(d);
        const prefix = d.split(/[*?[\]]/)[0]!;
        return prefix.endsWith(sep) ? prefix.slice(0, -1) : dirname(prefix);
      }),
    ),
  ];
}

/**
 * Удаление или перенос существующего каталога внутри открытых проверке
 * каталогов, в котором ей отказало ядро, — отказ среды, только когда:
 *
 * - каталог — база или предок запрета записи, пересчитанного по политике
 *   для корней, в которых работает проверка (`pinnedBases`): srt закрепляет
 *   его от переноса, и правка кода этого не снимет;
 * - проверка упала с EPERM, назвав этот путь (абсолютно или относительно
 *   своего рабочего каталога) отдельным словом в той же строке, что и
 *   EPERM (`token`): отказ, который
 *   проверка пережила, — не причина её провала. Настоящий провал теста с
 *   проглоченной неудачной уборкой остаётся провалом gate, даже если в
 *   выводе есть другой EPERM и короткое имя каталога (`.claude`) где-то ещё.
 *
 * Отказ в создании сюда не входит: его дают и запреты имён, и они разобраны
 * `mandatoryDenyRule`.
 */
function pinnedDirectoryRule(
  policy: Isolation,
  v: SandboxViolation,
  output: string | undefined,
  cwd: string | undefined,
  bases: (roots: string[]) => string[] = pinnedBases,
) {
  if (v.operation !== 'file-write-unlink' || output === undefined || cwd === undefined)
    return undefined;
  const lines = output.split(/\r?\n/).filter((line) => epermPattern.test(line));
  if (!lines.length) return undefined;
  const roots = policy.write.filter((w) => cwd === w || cwd.startsWith(w + sep));
  if (!roots.some((w) => v.path.startsWith(w + sep))) return undefined;
  const local = relative(cwd, v.path);
  const spellings = [
    v.path,
    ...(v.path.startsWith('/private/') ? [v.path.slice('/private'.length)] : []),
  ];
  const named = (line: string) =>
    spellings.some((p) => token(line, p, false)) ||
    (!local.startsWith('..') && local !== '' && token(line, local, true));
  if (!lines.some(named)) return undefined;
  try {
    if (!lstatSync(v.path).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  let pinned: string[];
  try {
    pinned = bases(roots);
  } catch {
    return undefined;
  }
  if (!pinned.some((b) => b === v.path || b.startsWith(v.path + sep))) return undefined;
  return 'запрет sandbox-runtime на удаление или перенос каталога: каталог закреплён запретами записи внутри него';
}

const epermPattern = /\bEPERM\b|operation not permitted/i;
/**
 * Путь отдельным словом строки: перед ним начало строки, пробел, кавычка,
 * `(`, `[`, `=` или `<` (у относительного ещё `./`), после — конец строки,
 * пробел, кавычка, `:`, `/`, `,`, `;`, `)`, `]`, `>` или точка в конце
 * предложения (перед пробелом или концом строки). Так `.claude-old`,
 * `.claude.bak` и `~/.claude/…` не называют `.claude`.
 */
function token(line: string, path: string, relativePath: boolean) {
  const before = /[\s'"`([=<]/;
  const after = /[\s'"`:/,;)\]>]/;
  const ends = (end: number) =>
    end >= line.length ||
    after.test(line[end]!) ||
    (line[end] === '.' && (end + 1 >= line.length || /\s/.test(line[end + 1]!)));
  for (let i = line.indexOf(path); i !== -1; i = line.indexOf(path, i + 1)) {
    if (!ends(i + path.length)) continue;
    if (i === 0 || before.test(line[i - 1]!)) return true;
    if (relativePath && line.slice(i - 2, i) === './' && (i === 2 || before.test(line[i - 3]!)))
      return true;
  }
  return false;
}
/** Путь в выводе проверки в любом написании (macOS: /private/var и /var). */
const mentions = (output: string, path: string) =>
  output.includes(path) ||
  (path.startsWith('/private/') && output.includes(path.slice('/private'.length)));

/**
 * Отказы песочницы, которые подтвердило ядро и которые правкой кода не снять.
 *
 * - Запись: обязательная политика в открытых проверке каталогах. Запись вне
 *   открытых каталогов — ошибка кода проверки, а не среды: её здесь нет.
 * - Чтение (и `stat`): закрытый файл в предке рабочего каталога проверки
 *   (`cwd`), на котором она упала с EPERM. Инструменты ищут конфигурацию
 *   вверх по дереву и на EPERM (в отличие от ENOENT) падают. Нужны все
 *   признаки — запись ядра для тега этой проверки, форма поиска вверх
 *   (каталог файла — строгий предок `cwd`) и EPERM с этим путём в выводе
 *   (`output`). Учётные данные исключены даже при такой форме пути
 *   (`~/.npmrc` тоже лежит в предке checkout). Чтение другого закрытого пути (`~/.ssh/id_rsa`), отказ,
 *   который проверка пережила, и обычный провал тестов отказом среды не
 *   становятся: отказ среды не тратит попытку и останавливает очередь.
 */
export function sandboxDenials(
  violations: SandboxViolation[],
  policy: Isolation,
  output?: string,
  cwd?: string,
) {
  const found = new Map<string, string>();
  const eperm = output !== undefined && epermPattern.test(output);
  // Базы закреплённых каталогов перечисляют дерево: один раз на разбор.
  const bases = new Map<string, string[]>();
  const pinnedOnce = (roots: string[]) => {
    const key = roots.join('\0');
    let cached = bases.get(key);
    if (!cached) bases.set(key, (cached = pinnedBases(roots)));
    return cached;
  };
  const credentials = credentialPaths().flatMap((path) => {
    try {
      return [path, realpathSync(path)];
    } catch {
      return [path];
    }
  });
  const credential = (path: string) =>
    credentials.some((root) => path === root || path.startsWith(root + sep));
  // Поиск вверх: файл лежит прямо в строгом предке рабочего каталога.
  const walkUp = (path: string) => cwd !== undefined && cwd.startsWith(dirname(path) + sep);
  for (const v of violations) {
    if (found.has(v.path)) continue;
    const rule = v.operation.startsWith('file-write')
      ? (mandatoryDenyRule(policy, v.path) ??
        pinnedDirectoryRule(policy, v, output, cwd, pinnedOnce))
      : v.operation.startsWith('file-read') &&
          !credential(v.path) &&
          eperm &&
          walkUp(v.path) &&
          mentions(output, v.path)
        ? hiddenReadRule(policy, v.path)
        : undefined;
    if (rule) found.set(v.path, rule);
  }
  return [...found].map(([path, rule]) => ({ path, rule }));
}

/**
 * Имена, которые проверка и исполнитель не создают и не меняют.
 *
 * Сравниваются без регистра на любой платформе: на APFS и NTFS `.Claude`,
 * `.VSCode` или `.Bashrc` хост читает как `.claude`, `.vscode`, `.bashrc`.
 * На чувствительной к регистру ФС такое имя никто не читает, но и создавать
 * его незачем — лишняя строгость дешевле развилки по ФС.
 */
const protectedNames = new Set<string>([...DANGEROUS_FILES, ...ideDirectories, '.claude', '.git']);
const isProtected = (name: string) => protectedNames.has(name.toLowerCase());
export const snapshotLimit = 200_000;
/**
 * Подпись каталога, в дереве которого нет ни файлов, ни символьных ссылок, и
 * ни один каталог не открыт на запись всем (`mode & 0o002`): такой каталог —
 * место, куда любой пользователь положит конфигурацию после сверки. Запись
 * группе разрешена: при umask 002 (общие и dev-машины) CLI исполнителя
 * создаёт `.claude` с правами 775.
 */
const emptyTree = 'd:empty';
/** Ошибка доступа к пути, которую сверка не может обойти: отказ, а не пропуск. */
const unreadable = (root: string, path: string, error: unknown): never => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? String(error);
  throw new SandboxPolicyError(
    `сверка защищённых путей не выполнена: нет доступа к ${relative(root, path) || '.'} (${code}) — путь, который нельзя прочитать, мог скрыть конфигурацию IDE, shell, git или Claude`,
  );
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
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
    // Только ENOENT значит «пути нет». Любой другой отказ (EACCES под
    // каталогом без права поиска, каталог mode 000) — отказ сверки: иначе
    // `chmod 0444 sub` спрятал бы `sub/.claude/settings.json`.
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (missing(error)) return 'missing';
      return unreadable(root, path, error);
    }
    try {
      if (stat.isSymbolicLink()) return 'l:' + readlinkSync(path);
      // Не каталог и не ссылка — файл, FIFO, сокет, устройство: всё это
      // содержимое, пустым деревом не бывает. mtime возвращает `utimes`,
      // ctime — нет: правка на месте в перенесённом наружу родителе с
      // восстановленными размером и mtime всё равно меняет подпись. Ту же
      // ctime меняют chmod/chown и новая жёсткая ссылка на файл — для
      // защищённой конфигурации это тоже изменение.
      if (!stat.isDirectory()) return `f:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
      const mode = stat.mode & 0o7777;
      const names = readdirSync(path).sort();
      const inner = names.map((name) => signature(join(path, name)));
      // Дерево из одних закрытых для чужой записи каталогов не несёт ни
      // конфигурации, ни ссылки наружу: его подпись одна для любого такого
      // дерева (см. `protectedChanges`). Открытый всем каталог
      // подписывается с правами и потому виден как изменение.
      if ((mode & 0o002) === 0 && inner.every((sig) => sig === emptyTree)) return emptyTree;
      return `d:${stat.ino}:${mode.toString(8)}[${names.map((name, i) => `${name}=${inner[i]}`).join(',')}]`;
    } catch (error) {
      if (error instanceof SandboxPolicyError) throw error;
      if (missing(error)) return 'missing';
      return unreadable(root, path, error);
    }
  };
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // Исчезнувший каталог сверять нечего; непрочитанный мог спрятать
      // защищённое имя — отказ.
      if (missing(error)) return;
      return unreadable(root, dir, error);
    }
    for (const entry of entries) {
      count();
      const path = join(dir, entry.name);
      if (entry.name.toLowerCase() === '.git' && dir === root && entry.isDirectory()) {
        // Обычный `.git`: объекты и индекс меняет и git хоста; сверяются
        // только конфигурация, hooks и перенаправления. Сам вид элемента
        // тоже: файл `.git` worktree, заменённый каталогом, — изменение,
        // даже если внутри одни пустые каталоги.
        found.set(path, 'd:git');
        for (const name of ['config', 'hooks', ...gitRedirects])
          found.set(join(path, name), signature(join(path, name)));
        continue;
      }
      if (isProtected(entry.name)) {
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
 * Исчез ли `path` из дерева сам, а не скрылся за подменённым родителем.
 *
 * Снимок не спускается в символьные ссылки на каталоги: родитель `sub`,
 * перенесённый наружу и заменённый ссылкой на каталог вне дерева с другим
 * `.git`, выглядел бы как исчезновение `sub/.git`, а git хоста прочитал бы
 * подменённый `gitdir` через ссылку. Исчезновением считается только путь,
 * у которого цепочка родителей от `root` — настоящие каталоги до первого
 * отсутствующего звена (родитель удалён или перенесён наружу) или до
 * самого пути. Ссылка или не каталог на месте родителя — подмена.
 */
function removedInPlace(root: string, path: string) {
  const parts = relative(root, path).split(sep).slice(0, -1);
  let dir = root;
  for (const part of parts) {
    dir = join(dir, part);
    let stat;
    try {
      stat = lstatSync(dir);
    } catch (error) {
      if (missing(error)) return true;
      return unreadable(root, dir, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return true;
}
/**
 * Защищённые пути, которые появились или изменились после снимка `before`.
 *
 * Путь, который сверка не может прочитать (кроме ENOENT), — `SandboxPolicyError`
 * из снимка, а не пропуск: вызывающий решает, отказ ли это среды (снимок до
 * работы) или нарушение области (после).
 *
 * Путь с содержимым, который был до снимка и исчез после, — нарушение
 * (удаление `.idea` через перенос родителя).
 *
 * Пустые каталоги (только каталоги, рекурсивно, без записи всем)
 * нарушением не считаются, если до снимка пути не было или он тоже был без
 * файлов: исполняемой конфигурации в них нет, а CLI исполнителя создаёт
 * такие служебные каталоги (`.claude/.cc-writes`) рядом с каждым записанным
 * файлом. Путь, где раньше были файлы, по-прежнему нарушение при любом
 * изменении.
 */
export function protectedChanges(
  before: Map<string, string>,
  root: string,
  /**
   * Пути относительно `root`, которыми владеет подготовка фазы (вложенные
   * `.git`, см. `preparationGuard`): не в счёт только их исчезновение
   * (уборка фикстуры переносом родителя, см. `removedInPlace`). Изменение — в том числе подмена
   * переносом другого `.git` на то же место — нарушение: подменённый
   * `gitdir` подмодуля git хоста прочитал бы при следующей команде.
   */
  owned?: ReadonlySet<string>,
) {
  const after = protectedSnapshot(root);
  const mine = (path: string) => !owned?.has(relative(root, path)) || !removedInPlace(root, path);
  const changed = [...after]
    .filter(([path, sig]) => {
      if (sig === 'missing') return false;
      const was = before.get(path) ?? 'missing';
      if (sig === emptyTree && (was === 'missing' || was === emptyTree)) return false;
      return was !== sig;
    })
    .map(([path]) => path);
  // Исчезнувший защищённый путь с содержимым — тоже нарушение: ядро не
  // закрепляет каталоги дерева, и `.idea` уходит вместе с перенесённым и
  // удалённым родителем. Пустые служебные каталоги (только каталоги)
  // исчезать могут.
  const removed = [...before]
    .filter(
      ([path, sig]) =>
        mine(path) &&
        sig !== 'missing' &&
        sig !== emptyTree &&
        (after.get(path) ?? 'missing') === 'missing',
    )
    .map(([path]) => path);
  return [...changed, ...removed];
}

/**
 * Предел пути unix-сокета (`sun_path`, вместе с завершающим NUL): 104 байта
 * на macOS, 108 на Linux. srt слушает свои сокеты во временном каталоге
 * процесса (`srt-mux-<pid>-<n>.sock`, `claude-socks-<16 hex>.sock`,
 * `srt-obs-XXXXXX/s<8 hex>.sock`); глубокий TMPDIR делает путь длиннее
 * предела, и srt падает до запуска команды (`listen EINVAL`).
 */
export const SOCKET_PATH_LIMIT: Partial<Record<NodeJS.Platform, number>> = {
  darwin: 104,
  linux: 108,
};
/** Запас под самое длинное имя сокета srt внутри его временного каталога (с разделителем). */
export const SRT_SOCKET_RESERVE = 48;
/** Короткая база временного каталога srt, когда TMPDIR процесса слишком глубокий. */
export const SRT_SHORT_BASE = '/tmp';
/**
 * База, которую берёт `runGate`; тест подменяет её, чтобы проверить отказ
 * (как `isolationBackend`).
 */
export const srtTempBase = { short: SRT_SHORT_BASE };
/** Возраст, после которого брошенный каталог srt убирается при создании нового. */
export const SRT_STALE_MS = 24 * 60 * 60 * 1000;
/** Имя своего каталога srt: `dc-srt-<pid создателя>-<суффикс mkdtemp>`. */
const srtDirName = /^dc-srt-([1-9]\d*)-[A-Za-z0-9]{6}$/;

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM — процесс есть, но чужой: считаем живым.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Наибольший pid, который принимает уборка (pid_t — 32-битное со знаком). */
const MAX_PID = 2 ** 31 - 1;
/** Префикс каталога srt, переименованного уборкой перед удалением. */
export const SRT_REMOVING_PREFIX = '.dc-srt-rm-';

/**
 * Уборка брошенных каталогов srt (controller упал до своей уборки) — по
 * возможности, ошибки не мешают проверке. Удаляется только запись, которая
 * одновременно:
 * - имя `dc-srt-<pid>-XXXXXX`, pid — безопасное целое не больше 2^31−1 и не
 *   этот процесс (иначе запись остаётся);
 * - каталог (не symlink, `lstat`) этого пользователя;
 * - ни сам каталог, ни одна запись прямо в нём не менялись дольше
 *   `SRT_STALE_MS`. Свежая запись внутри — признак живого srt: процесс srt
 *   переживает controller, убитый SIGKILL (pid создателя уже свободен), а
 *   контейнеры с общим `/tmp` и своим пространством pid не видят создателя
 *   из другого пространства — для них «процесса нет» ничего не доказывает;
 * - процесс-создатель не существует (ESRCH; EPERM — процесс есть, он жив).
 *   Повтор pid только оставляет каталог.
 *
 * Удаление без гонки с подменой: каталог сначала переименовывается в
 * `.dc-srt-rm-<uuid>` того же каталога, переименованный путь проверяется
 * снова (каталог, владелец, тот же inode), и только тогда удаляется. Не
 * прошедший повторную проверку остаётся под новым именем; уборка его не
 * трогает, как и остаток после падения между rename и rm.
 */
export async function sweepStaleSrtDirs(
  short: string,
  now: number = Date.now(),
): Promise<string[]> {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  let names: string[];
  try {
    names = await readdir(short);
  } catch {
    return [];
  }
  const fresh = (mtimeMs: number) => now - mtimeMs < SRT_STALE_MS;
  const removed: string[] = [];
  for (const name of names) {
    const pid = Number(srtDirName.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID || pid === process.pid) continue;
    const path = join(short, name);
    try {
      const st = await lstat(path);
      if (!st.isDirectory() || st.uid !== uid || fresh(st.mtimeMs)) continue;
      let recent = false;
      for (const entry of await readdir(path))
        if (fresh((await lstat(join(path, entry))).mtimeMs)) {
          recent = true;
          break;
        }
      if (recent || processAlive(pid)) continue;
      const moved = join(short, SRT_REMOVING_PREFIX + randomUUID());
      await rename(path, moved);
      const again = await lstat(moved);
      if (!again.isDirectory() || again.uid !== uid || again.ino !== st.ino || again.dev !== st.dev)
        continue;
      await rm(moved, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // Уборка по возможности: запись исчезла, нет прав — пропускаем.
    }
  }
  return removed;
}

/** Путь каталога оставляет место сокетам srt на этой платформе. */
export const srtSocketsFit = (dir: string, platform: NodeJS.Platform = process.platform) => {
  const limit = SOCKET_PATH_LIMIT[platform];
  return limit === undefined || Buffer.byteLength(dir) + SRT_SOCKET_RESERVE < limit;
};

/**
 * Временный каталог процесса srt. TMPDIR процесса — как есть, если сокеты
 * srt в нём укладываются в предел пути; иначе — свой каталог под
 * `SRT_SHORT_BASE` (`mkdtemp`: новый, `0700`, только владельцу), который
 * вызывающий удаляет после проверки (`created`); перед созданием убираются
 * брошенные каталоги (`sweepStaleSrtDirs`). Если и он не укладывается
 * или не создаётся — `SandboxPolicyError` (отказ среды, `environment`) до
 * запуска, с именем TMPDIR в тексте.
 * Команде внутри передаётся свой scratch, не этот каталог.
 */
export async function srtTempDir(
  base: string = tmpdir(),
  platform: NodeJS.Platform = process.platform,
  short: string = srtTempBase.short,
): Promise<{ dir: string; created: boolean }> {
  if (srtSocketsFit(base, platform)) return { dir: base, created: false };
  const limit = SOCKET_PATH_LIMIT[platform]!;
  const refuse = (detail: string) =>
    new SandboxPolicyError(
      `Песочница проверки не запустится: путь сокетов sandbox-runtime в TMPDIR ` +
        `(${base}, ${Buffer.byteLength(base)} байт) длиннее предела unix-сокета ` +
        `${limit} байт, а короткий каталог ${short} ${detail}. Задайте более короткий TMPDIR`,
    );
  await sweepStaleSrtDirs(short);
  let dir: string;
  try {
    dir = await realpath(await mkdtemp(join(short, `dc-srt-${process.pid}-`)));
  } catch (error) {
    throw refuse(`недоступен: ${(error as Error).message}`);
  }
  if (!srtSocketsFit(dir, platform)) {
    await rm(dir, { recursive: true, force: true });
    throw refuse(`тоже слишком длинный (${dir})`);
  }
  return { dir, created: true };
}

/**
 * Команда проверки внутри sandbox-runtime.
 *
 * Настройки пишутся в файл: srt отказывает, если файл пуст или невалиден, и
 * не откатывается к умолчаниям. Собственный служебный сокет srt кладёт во
 * временный каталог процесса, поэтому srt получает TMPDIR, в котором путь
 * сокета укладывается в предел (`srtTempDir`), а команде внутри передаётся
 * свой scratch.
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
  /**
   * Токен старта: обёртка печатает его строкой в stderr перед exec команды.
   * Метку-файл команда может стереть (каталог метки ей открыт на запись), а
   * напечатанное до неё — нет: токен в выводе доказывает старт.
   */
  token = '',
  /** Временный каталог процесса srt (`srtTempDir`); по умолчанию TMPDIR процесса. */
  srtTemp: string = tmpdir(),
) {
  if (!/^[a-z0-9]*$/.test(tag)) throw new Error('Токен журнала песочницы — только [a-z0-9]');
  if (!/^[a-z0-9]*$/.test(token)) throw new Error('Токен старта — только [a-z0-9]');
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
      '--import',
      srtShellLookup,
      srtCli,
      '--settings',
      settings,
      '--',
      '/bin/sh',
      '-c',
      `${tag ? `: ${tag}; ` : ''}: > "$0" && { [ -z "$1" ] || printf '%s\\n' "$1" >&2; } && cd -- "$2" && shift 2 && exec "$@"`,
      started,
      token,
      workdir,
      '/usr/bin/env',
      `TMPDIR=${scratch}`,
      ...argv,
    ],
    env: { TMPDIR: srtTemp },
    // Без явных запретов srt остаётся в рабочем каталоге: его собственный
    // обязательный запрет действует от него.
    cwd: denies ? dirname(started) : workdir,
  };
}
