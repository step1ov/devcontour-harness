import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * Git на хосте над деревом, в котором исполнялся чужой код.
 *
 * Исполнитель и проверки пишут в checkout. Git, запущенный потом на хосте,
 * читает конфигурацию того репозитория, который найдёт от рабочего каталога,
 * а она способна запускать программы (`core.fsmonitor`, hooks, драйверы
 * фильтров и diff). Подменённый файл `.git` (`gitdir: <checkout>/evil`),
 * `.git/commondir` в обычном checkout или вложенный `.git` уводили git в
 * конфигурацию, которую написал чужой код, — и она исполнялась вне песочницы.
 *
 * Поэтому каждый вызов git хоста сначала сверяет, куда git придёт: файл
 * `.git` рабочего дерева, созданного через `worktree add`, должен остаться
 * тем же; gitdir и общий каталог репозитория лежат вне дерева и согласованы
 * между собой; общий каталог — уже известный хосту репозиторий, если он
 * известен; вложенный репозиторий внутри известного дерева и перенаправление
 * обычного `.git` — отказ. Флаги `gitHardening` поверх этого снимают
 * исполняемые настройки, которые git читает сам.
 */
export const gitHardening = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.ext.allow=never',
];

export class UntrustedCheckoutError extends Error {
  override name = 'UntrustedCheckoutError';
}

/** Общие каталоги репозиториев, которые хост открывал сам. */
const trustedCommon = new Set<string>();
/** Рабочие деревья, созданные через `worktree add`: путь → содержимое `.git`. */
const knownWorktrees = new Map<string, string>();

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
/** Признак каталога-репозитория без рабочего дерева: git находит такой и сам. */
const bareLike = (dir: string) =>
  isFile(join(dir, 'HEAD')) && isDir(join(dir, 'objects')) && isDir(join(dir, 'refs'));
const insideKnown = (dir: string) =>
  [...knownWorktrees.keys()].find((w) => dir !== w && within(dir, w));
const refuse = (reason: string): never => {
  throw new UntrustedCheckoutError('Git на хосте не запущен: ' + reason);
};

function readGitFile(path: string) {
  const m = /^gitdir: (.+)$/m.exec(readFileSync(path, 'utf8'));
  if (!m) refuse(`${path} не указывает gitdir`);
  return m![1]!.trim();
}

/**
 * Сверяет репозиторий, который git найдёт от `cwd`. Возвращает его общий
 * каталог или `undefined`, если репозитория нет (git откажет сам).
 */
export function assertTrustedCheckout(cwd: string): string | undefined {
  for (let dir = real(cwd); ; dir = dirname(dir)) {
    const dotgit = join(dir, '.git');
    let stat;
    try {
      stat = lstatSync(dotgit);
    } catch {
      /* нет `.git` на этом уровне */
    }
    const nested = insideKnown(dir);
    if (stat) {
      if (nested) refuse(`вложенный репозиторий ${dotgit} внутри рабочего дерева ${nested}`);
      if (stat.isSymbolicLink()) refuse(`${dotgit} — символическая ссылка`);
      const known = knownWorktrees.get(dir);
      if (stat.isDirectory()) {
        if (known !== undefined) refuse(`${dotgit} рабочего дерева заменён каталогом`);
        // Обычный `.git` с перенаправлением ведёт git в чужой общий каталог.
        for (const name of ['commondir', 'gitdir'])
          if (existsSync(join(dotgit, name))) refuse(`${join(dotgit, name)} перенаправляет git`);
        const common = real(dotgit);
        trustedCommon.add(common);
        return common;
      }
      const content = readFileSync(dotgit, 'utf8');
      if (known !== undefined && content !== known)
        refuse(`${dotgit} рабочего дерева изменён после создания`);
      const gitdir = real(resolve(dir, readGitFile(dotgit)));
      if (within(gitdir, dir)) refuse(`${dotgit} указывает внутрь самого дерева: ${gitdir}`);
      const commondirFile = join(gitdir, 'commondir');
      if (!isFile(commondirFile)) refuse(`${gitdir} не рабочее дерево репозитория`);
      const common = real(resolve(gitdir, readFileSync(commondirFile, 'utf8').trim()));
      if (within(common, dir)) refuse(`общий каталог ${common} внутри самого дерева`);
      if (join(common, 'worktrees', basename(gitdir)) !== gitdir || !bareLike(common))
        refuse(`${gitdir} не принадлежит репозиторию ${common}`);
      const back = join(gitdir, 'gitdir');
      if (!isFile(back) || real(readFileSync(back, 'utf8').trim()) !== real(dotgit))
        refuse(`${gitdir} не ссылается обратно на ${dotgit}`);
      // Дерево, созданное этим процессом, ведёт только в известный репозиторий.
      if (known !== undefined && !trustedCommon.has(common))
        refuse(`общий каталог ${common} не тот, от которого создано дерево`);
      return common;
    }
    if (bareLike(dir)) {
      if (nested) refuse(`вложенный репозиторий ${dir} внутри рабочего дерева ${nested}`);
      const common = real(dir);
      trustedCommon.add(common);
      return common;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Рабочее дерево создано хостом: дальше его `.git` обязан остаться прежним. */
export function rememberWorktree(path: string) {
  const dir = real(path);
  try {
    knownWorktrees.set(dir, readFileSync(join(dir, '.git'), 'utf8'));
  } catch {
    /* `worktree add` не создал дерево: git уже сообщил об отказе */
  }
}

/** Ключ дерева — настоящий путь (/var → /private/var). */
export const worktreeKey = real;
export function forgetWorktree(key: string) {
  knownWorktrees.delete(key);
}

/** Путь, который `git worktree add` получит как каталог дерева. */
export function worktreeAddPath(args: string[]) {
  const at = args.findIndex((a, i) => a === 'worktree' && args[i + 1] === 'add');
  if (at < 0) return undefined;
  const withValue = new Set(['-b', '-B', '--reason']);
  for (let i = at + 2; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') return args[i + 1];
    if (withValue.has(arg)) i++;
    else if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

/** Только для тестов: забыть, что известно процессу. */
export function resetGitTrust() {
  trustedCommon.clear();
  knownWorktrees.clear();
}
