// Шаги на хосте после исполнителя — по доверенной базе (alpha.67,
// docs/infra-works.md). Teardown попытки работы инфраструктуры исполняется вне
// песочницы, когда в дереве кандидата уже лежит код, не прошедший ревью (или
// отклонённый). Поэтому он исполняется не в дереве кандидата, а в отдельном
// чистом checkout доверенной базы (`git worktree add --detach`), который
// убирается после шага. Дерево кандидата harness не меняет: черновик и
// `keepDraft` видят его целиком. Зависимостей дерева (`node_modules`) и файлов,
// которые setup создал в дереве кандидата, в checkout базы нет: teardown,
// которому они нужны, откажет — запись окружения останется `cleanup-failed`,
// а очистку доведут `harness cleanup` и сверка по меткам (закрыто по
// умолчанию).

import { randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { git } from './process.ts';

/** Доверенная база попытки: коммит (target ref при выдаче) и область инфраструктуры. */
export interface TrustedTree {
  base: string;
  paths?: string[];
}

/** Префикс каталога checkout базы рядом с записью окружения. */
export const TRUSTED_CHECKOUT_PREFIX = 'trusted-base-';

export interface BaseCheckoutHooks {
  /**
   * Checkout, записанные в запись окружения (прежний `trustedCheckout` и
   * неубранные `trustedLeftovers`): только их harness считает своими.
   */
  prior?: readonly string[];
  /** Записать путь checkout до `git worktree add` (переживает падение процесса). */
  record?: (path: string) => Promise<void>;
  /** Checkout не убран: путь и заметка в запись окружения; итог teardown она не меняет. */
  leftover?: (path: string, note: string) => Promise<void>;
  /** Записанный прежде неубранный checkout убран. */
  collected?: (path: string) => Promise<void>;
}

const prefixed = (dir: string, path: string) => {
  const full = resolve(path);
  return full.startsWith(resolve(dir) + sep) && basename(full).startsWith(TRUSTED_CHECKOUT_PREFIX);
};
/** Сбой записи в запись окружения не останавливает teardown. */
const quietly = async (hook: (() => Promise<void>) | undefined) => {
  try {
    await hook?.();
  } catch {
    // Запись окружения не обновлена; checkout всё равно найдёт уборка по регистрации.
  }
};

/** Общий каталог git и записи worktree, чей `gitdir` ведёт в `path`. */
async function worktreeEntries(repo: string, path: string, dir: string) {
  const common = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const admin = join(common, 'worktrees');
  const wanted = new Set([join(resolve(path), '.git')]);
  await realpath(path)
    .then((p) => wanted.add(join(p, '.git')))
    .catch(() => undefined);
  await realpath(dir)
    .then((d) => wanted.add(join(d, basename(path), '.git')))
    .catch(() => undefined);
  const entries: string[] = [];
  for (const name of await readdir(admin).catch(() => [] as string[])) {
    const entry = join(admin, name);
    const gitdir = (await readFile(join(entry, 'gitdir'), 'utf8').catch(() => '')).trim();
    if (wanted.has(gitdir) && resolve(entry).startsWith(resolve(admin) + sep)) entries.push(entry);
  }
  return { admin, entries };
}

/**
 * Исполнить `run` в отдельном чистом checkout базы рядом с записью окружения
 * (`dir`): сначала убрать свои оставшиеся от прежних попыток — только
 * записанные в запись окружения (`prior`); каталог, путь которого не
 * записан, не трогается никогда (префикс имени и регистрация в git
 * принадлежности не доказывают). Путь нового checkout выбирается и
 * записывается до его создания (`git worktree add` создаёт каталог сам),
 * после шага — и при отказе — он убирается. Ошибка уборки и сбой записи в
 * запись окружения итог `run` не подменяют. `repo` — любое дерево
 * репозитория (дерево кандидата).
 */
export async function withBaseCheckout<T>(
  repo: string,
  base: string,
  dir: string,
  run: (cwd: string) => Promise<T>,
  hooks: BaseCheckoutHooks = {},
): Promise<T> {
  const stale = new Set((hooks.prior ?? []).filter((p) => prefixed(dir, p)).map((p) => resolve(p)));
  for (const path of stale) {
    const note = await removeBaseCheckout(repo, dir, path, { recorded: true });
    if (note) await quietly(() => hooks.leftover?.(path, note) ?? Promise.resolve());
    else await quietly(() => hooks.collected?.(path) ?? Promise.resolve());
  }
  const path = join(resolve(dir), TRUSTED_CHECKOUT_PREFIX + randomUUID());
  await quietly(() => hooks.record?.(path) ?? Promise.resolve());
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    await git(repo, 'worktree', 'add', '--detach', path, base);
    result = { ok: true, value: await run(path) };
  } catch (error) {
    result = { ok: false, error };
  }
  const note = await removeBaseCheckout(repo, dir, path, { recorded: true });
  if (note) await quietly(() => hooks.leftover?.(path, note) ?? Promise.resolve());
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * Убрать один свой checkout базы: `git worktree remove --force`; не вышло —
 * его собственную запись в `<common>/worktrees/` (без общего `prune`) и
 * каталог. Свой — только записанный в запись окружения (`recorded`), с
 * префиксом внутри `dir`; любой другой не трогается. Возвращает заметку о
 * том, что осталось; `undefined` — убрано (или убирать нечего).
 */
export async function removeBaseCheckout(
  repo: string,
  dir: string,
  path: string,
  options: { recorded?: boolean } = {},
): Promise<string | undefined> {
  if (!prefixed(dir, path)) return `checkout ${path} вне каталога окружения — не тронут`;
  if (!options.recorded) return `каталог ${path} не записан как checkout harness — не тронут`;
  try {
    await git(repo, 'worktree', 'remove', '--force', path);
    return undefined;
  } catch {
    // Каталог уже без `.git`, повреждён или не создан: своя запись и каталог.
  }
  const problems: string[] = [];
  try {
    const { entries } = await worktreeEntries(repo, path, dir);
    for (const entry of entries) await rm(entry, { recursive: true, force: true });
  } catch (error) {
    problems.push(`запись worktree: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await rm(resolve(path), { recursive: true, force: true });
  } catch (error) {
    problems.push(`каталог: ${error instanceof Error ? error.message : String(error)}`);
  }
  return problems.length ? `checkout базы ${path} не убран: ${problems.join('; ')}` : undefined;
}

/**
 * Окружение teardown в checkout базы: запись своего репозитория в
 * `DEVCONTOUR_COMPONENTS_JSON`/`HARNESS_COMPONENTS_JSON` указывает на checkout
 * (а не на дерево кандидата). Проект compose не подставляется: его называет
 * сам teardown (`-p`, мост с явным проектом — правило `infraIssues`).
 */
export function baseCheckoutEnv(
  env: NodeJS.ProcessEnv,
  candidate: string,
  checkout: string,
): NodeJS.ProcessEnv {
  const out = { ...env };
  const own = env.DEVCONTOUR_REPOSITORY_ID ?? env.HARNESS_REPOSITORY_ID;
  for (const key of ['DEVCONTOUR_COMPONENTS_JSON', 'HARNESS_COMPONENTS_JSON']) {
    const raw = env[key];
    if (!raw) continue;
    try {
      const map = JSON.parse(raw) as Record<string, string>;
      for (const [id, path] of Object.entries(map))
        if (id === own || resolve(path) === resolve(candidate)) map[id] = checkout;
      out[key] = JSON.stringify(map);
    } catch {
      // Не наш формат: путь мог вести в кандидата — переменная не передаётся.
      delete out[key];
    }
  }
  return out;
}
