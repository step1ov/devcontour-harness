import { createHash } from 'node:crypto';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

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
 * - корень, заданный хостом (`checkoutRoot`), — как есть;
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
 * видна в `note` (doctor хоста её показывает).
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

const within = (path: string, root: string) => path === root || path.startsWith(root + sep);

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

export function chooseCheckoutRoot(input: CheckoutRootInput): CheckoutRoot {
  if (input.configured) return { root: realish(input.configured), placement: 'configured' };
  const states = input.stateDirs.map(realish);
  const repos = input.repositories.map(realish);
  const hidden = (input.hidden ?? []).map(realish);
  // Каталог состояния внутри репозитория (или им и являющийся) либо строго
  // внутри другого закрытого пути: предки его рабочих деревьев были бы закрыты.
  const nested = states.find(
    (s) => repos.some((r) => within(s, r)) || hidden.some((h) => s !== h && within(s, h)),
  );
  if (!nested) return { placement: 'in-place' };
  const base = checkoutCacheBase(input.platform, input.env, input.home);
  const root = join(base, stateHash(input.stateDirs[0] ?? nested));
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

/**
 * Закрыть рабочие деревья под корнями `roots` поэлементно: открытые пути
 * (`open`: свой checkout, снимки зависимостей) и их предки остаются открыты,
 * всё остальное под корнем (чужие попытки) закрыто. Закрыть корень целиком
 * нельзя: инструмент, ищущий конфигурацию вверх от checkout, получил бы EPERM
 * на `stat` несуществующего файла в предке. Элемент, появившийся после
 * построения политики (параллельная попытка), не закрыт — граница подхода,
 * как у codex; каталоги состояния и репозитории закрыты целиком.
 */
export function closedCheckouts(roots: string[], open: string[]) {
  const opened = open.map(realish);
  const expand = (dir: string): string[] => {
    if (opened.some((p) => within(dir, p))) return [];
    if (!opened.some((p) => within(p, dir))) return [dir];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.flatMap((name) => expand(join(dir, name)));
  };
  return [...new Set(roots.map(realish).flatMap(expand))];
}
