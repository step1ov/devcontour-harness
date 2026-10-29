import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { HarnessError } from '../contracts/index.ts';

/**
 * Где harness создаёт рабочие деревья попыток, снимки зависимостей, деревья
 * переноса базы, проверки на SHA и проверки потребителей.
 *
 * Прежде они лежали в каталоге состояния. При встроенном размещении каталог
 * состояния находится внутри репозитория человека (`<W>/.devcontour-local`),
 * и тогда checkout кандидата оказывался вложен в его рабочее дерево. Песочница
 * закрывает `<W>` целиком и открывает только сам checkout, а инструменты,
 * которые ищут конфигурацию вверх по дереву (browserslist, Metro, postcss,
 * tsconfig, prettier), доходили до `<W>/package.json` и получали EPERM вместо
 * ENOENT. Без песочницы они бы прочитали конфигурацию рабочего дерева
 * человека — кандидат проверялся бы не сам по себе.
 *
 * Поэтому корень рабочих деревьев выбирается так:
 * - корень, заданный хостом (`checkoutRoot`), — как есть, если он не внутри
 *   репозитория, закрытого пути или каталога состояния и не содержит их
 *   (иначе отказ); недостающий корень и его родители создаются с mode 0700;
 * - каталог состояния внутри репозитория политики или внутри закрытого
 *   песочницей пути — каталог кэша пользователя вне дерева: macOS
 *   `~/Library/Caches/devcontour-harness/<hash>`, Linux
 *   `$XDG_CACHE_HOME/devcontour-harness/<hash>` или
 *   `~/.cache/devcontour-harness/<hash>`; `<hash>` — устойчивый хэш
 *   настоящего пути каталога состояния;
 * - иначе — прежнее место (отдельное размещение не меняется).
 *
 * Кэш на другом томе, чем репозиторий, ломает жёсткие ссылки и reflink
 * менеджеров пакетов (pnpm store): тогда корень остаётся прежним, а причина
 * видна в `note` (doctor хоста её показывает). Так же — кэш внутри
 * репозитория, закрытого пути или каталога состояния (`XDG_CACHE_HOME=<W>/.cache`)
 * и каталог кэша, который оказался ссылкой или принадлежит другому
 * пользователю: каталоги кэша создаются с правами 0700.
 *
 * Корни кэша не убираются, когда workspace переносят или удаляют: каталоги
 * `<кэш>/devcontour-harness/<hash>` без живого каталога состояния можно удалить
 * вручную, когда harness не запущен.
 */
export type CheckoutPlacement = 'configured' | 'in-place' | 'cache' | 'cross-volume';

export interface CheckoutRoot {
  /** Корень вне каталога состояния; без него — прежнее место. */
  root?: string;
  placement: CheckoutPlacement;
  /** Пояснение для диагностики: почему корень такой. */
  note?: string;
}

export interface CheckoutRootInput {
  /** Каталоги состояния (общий и каталоги попыток репозиториев); первый задаёт хэш. */
  stateDirs: string[];
  /** Пути репозиториев политики. */
  repositories: string[];
  /** Что ещё закрыто песочницей (учётные данные, каталоги хоста). */
  hidden?: string[];
  /** Корень, заданный хостом. */
  configured?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Номер тома пути (`stat.dev`); тест подменяет его. */
  device?: (path: string) => number | undefined;
  /**
   * Создать корень и недостающих родителей (0700). Без записи (`false`, диагностика) —
   * только проверка существующих.
   */
  create?: boolean;
  /** Владелец каталогов кэша; по умолчанию — текущий пользователь. */
  uid?: number;
}

/** Настоящий путь и для ещё не созданного каталога: от ближайшего существующего предка. */
export function realish(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realish(parent), basename(absolute));
  }
}

const within = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Номер тома ближайшего существующего предка пути. */
function deviceOf(path: string): number | undefined {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    try {
      return statSync(dir).dev;
    } catch {
      if (dirname(dir) === dir) return undefined;
    }
  }
}

/** Каталог кэша пользователя для рабочих деревьев (без хэша). */
export function checkoutCacheBase(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
) {
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'devcontour-harness');
  const xdg = env.XDG_CACHE_HOME;
  // Относительный XDG_CACHE_HOME спецификация велит игнорировать.
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.cache'), 'devcontour-harness');
}

/** Устойчивый хэш каталога состояния: тот же путь — тот же корень. */
export const stateHash = (stateDir: string) =>
  createHash('sha256').update(realish(stateDir)).digest('hex').slice(0, 16);

/**
 * Каталог кэша безопасен для рабочих деревьев: настоящий каталог (не ссылка)
 * этого пользователя. `create` — создать недостающий с правами 0700.
 * Возвращает причину отказа или `undefined`.
 */
function unsafeDir(path: string, create: boolean, uid: number | undefined): string | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      return `${path} не прочитан: ${(error as NodeJS.ErrnoException).code ?? String(error)}`;
    if (!create) return undefined;
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      stat = lstatSync(path);
    } catch (error) {
      return `${path} не создан: ${(error as NodeJS.ErrnoException).code ?? String(error)}`;
    }
  }
  if (stat.isSymbolicLink()) return `${path} — символическая ссылка`;
  if (!stat.isDirectory()) return `${path} не каталог`;
  if (uid !== undefined && stat.uid !== uid) return `${path} принадлежит другому пользователю`;
  return undefined;
}

export function chooseCheckoutRoot(input: CheckoutRootInput): CheckoutRoot {
  const states = input.stateDirs.map(realish);
  const repos = input.repositories.map(realish);
  const hidden = (input.hidden ?? []).map(realish);
  // Корень внутри репозитория, закрытого пути или каталога состояния вернул
  // бы ту же вложенность (или открыл бы закрытое).
  const enclosing = (root: string) => [...repos, ...hidden, ...states].find((p) => within(root, p));
  const enclosed = (root: string) => [...repos, ...hidden, ...states].find((p) => within(p, root));
  const uid = input.uid !== undefined ? input.uid : process.getuid?.();
  const create = input.create ?? true;
  if (input.configured) {
    const root = realish(input.configured);
    const inside = enclosing(root);
    if (inside)
      throw new HarnessError(
        'INVALID_INPUT',
        `checkoutRoot ${root} внутри ${inside}: корень рабочих деревьев должен лежать вне репозиториев, закрытых путей и каталога состояния`,
      );
    const contains = enclosed(root);
    if (contains)
      throw new HarnessError(
        'INVALID_INPUT',
        `checkoutRoot ${root} содержит ${contains}: корень рабочих деревьев не должен быть предком репозиториев, закрытых путей или каталога состояния`,
      );
    const unsafe = unsafeDir(resolve(input.configured), create, uid);
    if (unsafe) throw new HarnessError('INVALID_INPUT', 'checkoutRoot: ' + unsafe);
    return { root, placement: 'configured' };
  }
  // Каталог состояния внутри репозитория (или им и являющийся) либо строго
  // внутри другого закрытого пути: предки его рабочих деревьев были бы закрыты.
  const nested = states.find(
    (s) => repos.some((r) => within(s, r)) || hidden.some((h) => s !== h && within(s, h)),
  );
  if (!nested) return { placement: 'in-place' };
  const base = checkoutCacheBase(input.platform, input.env, input.home);
  const root = join(base, stateHash(input.stateDirs[0] ?? nested));
  const stay = (why: string): CheckoutRoot => ({
    placement: 'in-place',
    note: `${why}: рабочие деревья остаются в каталоге состояния ${nested} (внутри закрытого дерева инструменты, ищущие конфигурацию вверх по дереву, получат EPERM); задайте checkoutRoot`,
  });
  const inside = enclosing(realish(root));
  if (inside) return stay(`каталог кэша ${root} внутри ${inside}`);
  const contains = enclosed(realish(root));
  if (contains) return stay(`каталог кэша ${root} содержит ${contains}`);
  const device = input.device ?? deviceOf;
  const at = device(root);
  const other = repos.find((r) => {
    const d = device(r);
    return at !== undefined && d !== undefined && d !== at;
  });
  if (other)
    return {
      placement: 'cross-volume',
      note: `каталог кэша ${root} на другом томе, чем репозиторий ${other}: жёсткие ссылки и reflink менеджера пакетов там не работают, рабочие деревья остаются в каталоге состояния ${nested} (внутри закрытого дерева инструменты, ищущие конфигурацию вверх по дереву, получат EPERM); задайте checkoutRoot на томе репозитория`,
    };
  // Недостающие родители кэша создаются с теми же закрытыми правами;
  // существующие каталоги пользователя не меняются.
  for (const dir of [base, root]) {
    const unsafe = unsafeDir(dir, create, uid);
    if (unsafe) return stay('каталог кэша небезопасен: ' + unsafe);
  }
  return {
    root,
    placement: 'cache',
    note: `каталог состояния ${nested} внутри репозитория или закрытого пути: рабочие деревья — вне дерева, в ${root}`,
  };
}

/**
 * Каталог рабочего дерева вида `kind` (`worktrees`, `dependencies`,
 * `gates-at`…). Корень вне дерева: `<root>/<repositoryId>/<kind>/…`; иначе —
 * прежний путь `legacy`.
 */
export function checkoutPath(
  choice: CheckoutRoot,
  legacy: string,
  repositoryId: string,
  kind: string,
  ...rest: string[]
) {
  return choice.root ? join(choice.root, repositoryId, kind, ...rest) : legacy;
}
