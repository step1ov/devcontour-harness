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

import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
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
  /** Checkout, записанный прежней попыткой очистки (запись окружения). */
  prior?: readonly string[];
  /** Записать путь checkout до `git worktree add` (переживает падение процесса). */
  record?: (path: string) => Promise<void>;
  /** Checkout не убран: заметка в запись окружения; итог teardown она не меняет. */
  leftover?: (note: string) => Promise<void>;
}

const ours = (dir: string, path: string) => {
  const full = resolve(path);
  return full.startsWith(resolve(dir) + sep) && basename(full).startsWith(TRUSTED_CHECKOUT_PREFIX);
};

/**
 * Исполнить `run` в отдельном чистом checkout базы рядом с записью окружения
 * (`dir`): сначала убрать оставшиеся от прежних попыток (записанный путь и
 * любые `trusted-base-*` в `dir`), записать путь нового до `git worktree add`,
 * убрать его после — и при отказе. Ошибка уборки итог `run` не подменяет:
 * она уходит заметкой в `leftover`. `repo` — любое дерево репозитория (дерево
 * кандидата): через него git находит общий каталог.
 */
export async function withBaseCheckout<T>(
  repo: string,
  base: string,
  dir: string,
  run: (cwd: string) => Promise<T>,
  hooks: BaseCheckoutHooks = {},
): Promise<T> {
  const stale = new Set((hooks.prior ?? []).filter((p) => ours(dir, p)));
  for (const name of await readdir(dir).catch(() => [] as string[]))
    if (name.startsWith(TRUSTED_CHECKOUT_PREFIX)) stale.add(join(dir, name));
  for (const path of stale) {
    const note = await removeBaseCheckout(repo, dir, path);
    if (note) await hooks.leftover?.(note);
  }
  const path = await mkdtemp(join(dir, TRUSTED_CHECKOUT_PREFIX));
  await hooks.record?.(path);
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    await git(repo, 'worktree', 'add', '--detach', path, base);
    result = { ok: true, value: await run(path) };
  } catch (error) {
    result = { ok: false, error };
  }
  const note = await removeBaseCheckout(repo, dir, path);
  if (note) await hooks.leftover?.(note).catch(() => undefined);
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * Убрать один checkout базы: `git worktree remove --force`; не вышло — его
 * собственную запись в `<common>/worktrees/` (без общего `prune`) и каталог.
 * Убирается только каталог с префиксом внутри `dir`. Возвращает заметку о
 * том, что осталось; `undefined` — убрано.
 */
export async function removeBaseCheckout(
  repo: string,
  dir: string,
  path: string,
): Promise<string | undefined> {
  if (!ours(dir, path)) return `checkout ${path} вне каталога окружения — не тронут`;
  try {
    await git(repo, 'worktree', 'remove', '--force', path);
    return undefined;
  } catch {
    // Каталог уже без `.git` или повреждён: убирается своя запись и каталог.
  }
  const problems: string[] = [];
  try {
    const common = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const admin = join(common, 'worktrees');
    const wanted = new Set([join(resolve(path), '.git')]);
    await realpath(path)
      .then((p) => wanted.add(join(p, '.git')))
      .catch(() => undefined);
    await realpath(dir)
      .then((d) => wanted.add(join(d, basename(path), '.git')))
      .catch(() => undefined);
    for (const name of await readdir(admin).catch(() => [] as string[])) {
      const entry = join(admin, name);
      const gitdir = (await readFile(join(entry, 'gitdir'), 'utf8').catch(() => '')).trim();
      if (wanted.has(gitdir) && resolve(entry).startsWith(resolve(admin) + sep))
        await rm(entry, { recursive: true, force: true });
    }
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
 * (а не на дерево кандидата); `COMPOSE_PROJECT_NAME` — имя дерева кандидата
 * (как его нормализует compose), если окружение его не задаёт: compose без
 * явного проекта берёт его из имени каталога.
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
  if (!out.COMPOSE_PROJECT_NAME)
    out.COMPOSE_PROJECT_NAME = basename(candidate)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '');
  return out;
}
