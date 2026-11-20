import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ExecutionPolicy } from '../contracts/index.ts';
import { seedRegistryHosts } from '../verification/store-registry.ts';
import {
  declaredManagerVersion,
  dependencyStoreSupports,
  dependencyStoreVersions,
} from '../toolchains/probe.ts';

/**
 * Советы о хранилище зависимостей, которые нельзя пропустить: `doctor`, `init`
 * и `lean` печатают их одинаково.
 *
 * - `DEPENDENCY_STORE_UNSUPPORTED` — репозиторий закрепил (`packageManager`)
 *   версию pnpm вне проверенных: хранилище не применяется, и каждый checkout
 *   (попытка, integration) ставит все пакеты из сети заново.
 * - `DEPENDENCY_CACHE_PATH` — команда `prepare`/`dependencyBuild`/`preflight`/
 *   `lifecycle`/gate или окружение политики задаёт свой store или кэш pnpm
 *   (`--store-dir`, `--cache-dir`, `store-dir`/`cache-dir` в `pnpm config set`,
 *   `npm_config_*`/`pnpm_config_*`). Относительный путь лежит в рабочей копии —
 *   каждая попытка начинает с пустого и скачивает всё; абсолютный — общее
 *   изменяемое состояние попыток вне границы доверия хранилища (seed сверяется
 *   по манифесту, такой кэш — нет), и путь не переносим.
 * - `DEPENDENCY_STORE_REGISTRY` — `.npmrc` в корне репозитория задаёт реестр
 *   (`registry=`, `@scope:registry=`), которого нет среди хостов сборки seed:
 *   сборка `.npmrc` проекта не читает (граница доверия) и идёт к реестру из
 *   окружения политики, иначе к registry.npmjs.org. Пакеты того реестра seed не
 *   соберёт, и каждый checkout ставит их из сети.
 */
export interface StoreAdvice {
  code: 'DEPENDENCY_STORE_UNSUPPORTED' | 'DEPENDENCY_CACHE_PATH' | 'DEPENDENCY_STORE_REGISTRY';
  message: string;
}

const MANIFEST_LIMIT = 1024 * 1024;
const CACHE_KEY = /^(?:npm|pnpm)_config_(?:store|cache)[-_]dir$/i;
const CACHE_FLAG = /^--(?:config\.)?(store|cache)[-_]dir(?:=(.*))?$/i;
const CACHE_ASSIGN = /^(?:npm|pnpm)_config_(store|cache)[-_]dir=(.*)$/i;
const CACHE_SETTING = /^(store|cache)[-_]dir$/i;

/** Корень проекта harness политики: каталог над `.harness/`; иначе политика вне проекта. */
const projectRootOf = (baseDir: string) => {
  const dir = resolve(baseDir);
  return basename(dir) === '.harness' ? dirname(dir) : undefined;
};

/** Закреплённая версия pnpm репозитория из `package.json`, если она есть. */
export function pinnedPnpm(repoDir: string) {
  try {
    // Не по ссылке и не больше предела: файл пишет проект.
    const path = join(repoDir, 'package.json');
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MANIFEST_LIMIT) return undefined;
    const raw = readFileSync(path);
    const field = (JSON.parse(raw.toString('utf8')) as { packageManager?: unknown } | null)
      ?.packageManager;
    return declaredManagerVersion(field, 'pnpm');
  } catch {
    return undefined;
  }
}

const NPMRC_LIMIT = 256 * 1024;
const NPMRC_REGISTRY = /^\s*((?:@[^:\s=]+:)?registry)\s*=\s*(\S+)/gm;

/** Реестры из `.npmrc` в корне репозитория: ключ и хост. Не по ссылке и не больше предела. */
function projectRegistries(repoDir: string) {
  try {
    const path = join(repoDir, '.npmrc');
    const st = lstatSync(path);
    if (!st.isFile() || st.size > NPMRC_LIMIT) return [];
    const text = readFileSync(path, 'utf8');
    return [...text.matchAll(NPMRC_REGISTRY)].flatMap((m) => {
      try {
        const host = new URL(m[2]!.replace(/^['"]|['"]$/g, '')).hostname.toLowerCase();
        return host ? [{ key: m[1]!, host }] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

const isFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

type Where = 'worktree' | 'shared';
/** Где лежит путь: в рабочей копии (у каждой попытки свой, пустой) или общий. */
function placeOf(value: string): Where {
  const v = value.replace(/^['"]|['"]$/g, '');
  if (/^(?:~|\$HOME|\$\{HOME\}|\$XDG_|\$\{XDG_|\$TMPDIR|\$\{TMPDIR\})/.test(v)) return 'shared';
  const local = v.replace(/^(?:\$PWD|\$\{PWD\}|\$\(pwd\))\/?/, '');
  // Путь, уходящий выше корня рабочей копии, — общий.
  if (local.split('/').includes('..')) return 'shared';
  if (local !== v) return 'worktree';
  return isAbsolute(v) ? 'shared' : 'worktree';
}

interface Found {
  at: string;
  what: string;
  where: Where;
}

const MANAGER = /(?:^|\/)(?:pnpm|pnpx|npm|npx|corepack)$/;
const SEPARATOR = /^(?:&&|\|\||;|\||&)$/;

/**
 * Store и кэш pnpm в аргументах одной команды (и в строке `sh -c`). Флаги
 * `--store-dir`/`--cache-dir` считаются только в части команды с менеджером
 * пакетов (`pnpm`, `npm`, `corepack`): у turbo, pip, ruff они свои.
 */
function argvCaches(argv: string[], at: string, out: Found[]) {
  const tokens = argv.flatMap((a) =>
    a
      .split(/\s+/)
      .flatMap((t) => t.split(/(&&|\|\||;)/))
      .filter(Boolean),
  );
  const manager = new Array<boolean>(tokens.length).fill(false);
  let segment = 0;
  let seen = false;
  tokens.forEach((t, i) => {
    if (SEPARATOR.test(t)) {
      for (let j = segment; j < i; j++) manager[j] = seen;
      segment = i + 1;
      seen = false;
    } else if (MANAGER.test(t)) seen = true;
  });
  for (let j = segment; j < tokens.length; j++) manager[j] = seen;
  tokens.forEach((token, i) => {
    const flag = CACHE_FLAG.exec(token);
    const assign = CACHE_ASSIGN.exec(token);
    const next = tokens[i + 1];
    if (flag && manager[i]) {
      const value = flag[2] ?? (next && !next.startsWith('-') ? next : undefined);
      if (value !== undefined)
        out.push({ at, what: `--${flag[1]!.toLowerCase()}-dir ${value}`, where: placeOf(value) });
    } else if (assign) out.push({ at, what: token, where: placeOf(assign[2]!) });
    else if (
      manager[i] &&
      CACHE_SETTING.test(token) &&
      tokens[i - 1] === 'set' &&
      tokens[i - 2] === 'config' &&
      next
    )
      out.push({ at, what: `config set ${token} ${next}`, where: placeOf(next) });
  });
}

function envCaches(env: ExecutionPolicy['environment'], at: string, out: Found[]) {
  if (!env) return;
  for (const [key, value] of Object.entries(env.values))
    if (CACHE_KEY.test(key)) out.push({ at, what: `${key}=${value}`, where: placeOf(value) });
  for (const key of env.inherit)
    if (CACHE_KEY.test(key)) out.push({ at, what: `${key} (из окружения хоста)`, where: 'shared' });
  for (const key of Object.keys(env.secrets))
    if (CACHE_KEY.test(key)) out.push({ at, what: `${key} (секрет)`, where: 'shared' });
}

export function storeAdvice(policy: ExecutionPolicy, baseDir: string): StoreAdvice[] {
  const advice: StoreAdvice[] = [];
  const project = projectRootOf(baseDir);
  const lean = project
    ? `harness lean --repository ${project} --plan, затем без --plan`
    : 'harness lean --repository <корень проекта> --plan, затем без --plan';
  const { from, below } = dependencyStoreVersions.pnpm;
  const unsupported = new Map<string, string>();
  policy.repositories.forEach((repo, i) => {
    const dir = isAbsolute(repo.path) ? repo.path : resolve(baseDir, repo.path);
    const pnpmRepo = Boolean(repo.dependencyStore) || isFile(join(dir, 'pnpm-lock.yaml'));
    const pinned = pnpmRepo ? pinnedPnpm(dir) : undefined;
    if (pinned && !dependencyStoreSupports('pnpm', pinned)) {
      unsupported.set(repo.id, pinned);
      advice.push({
        code: 'DEPENDENCY_STORE_UNSUPPORTED',
        message:
          `репозиторий ${repo.id}: package.json закрепил pnpm ${pinned}, а хранилище зависимостей проверено на ${from} … <${below} — ` +
          (repo.dependencyStore
            ? `repositories[${i}].dependencyStore НЕ ПРИМЕНЯЕТСЯ`
            : 'dependencyStore не поможет') +
          ': каждый checkout (попытка, integration) ставит все пакеты из сети заново, минуты на каждую попытку. ' +
          'Сообщите оператору как находку по harness; не собирайте свой общий кэш в аргументах проверок (--store-dir, store-dir, cache-dir): абсолютный путь и общее изменяемое состояние обходят границу доверия хранилища и не переносимы',
      });
    }
  });
  // Сборка seed идёт в песочнице только в isolation.mode: os; иначе сеть та же, что у хоста.
  if (policy.isolation.mode === 'os')
    policy.repositories.forEach((repo, i) => {
      if (!repo.dependencyStore || unsupported.has(repo.id)) return;
      const dir = isAbsolute(repo.path) ? repo.path : resolve(baseDir, repo.path);
      // Окружение сборки seed — как у фазы (`executionEnvironment`): наследуемые
      // переменные хоста, затем значения и секреты профилей по порядку.
      const env: NodeJS.ProcessEnv = {};
      for (const profile of [policy.environment, repo.environment]) {
        if (!profile) continue;
        for (const key of profile.inherit) env[key] = process.env[key];
        Object.assign(env, profile.values);
        for (const [key, from] of Object.entries(profile.secrets)) env[key] = process.env[from];
      }
      const hosts = seedRegistryHosts(env);
      // Домен в isolation.domains не помогает: сборка не знает, что пакеты идут туда.
      const foreign = projectRegistries(dir).filter((r) => !hosts.includes(r.host));
      if (!foreign.length) return;
      const scoped = foreign.some((r) => r.key !== 'registry');
      advice.push({
        code: 'DEPENDENCY_STORE_REGISTRY',
        message: (
          `репозиторий ${repo.id}: .npmrc проекта задаёт реестр ${foreign.map((r) => `${r.host} (${r.key})`).join(', ')}, ` +
          `а сборка seed (repositories[${i}].dependencyStore) .npmrc проекта не читает (граница доверия) и берёт пакеты с ${hosts.join(', ') || 'реестра из окружения политики'}: ` +
          'пакеты этого реестра seed не соберёт — сборка откажет или каждый checkout докачает их из сети. ' +
          (foreign.some((r) => r.key === 'registry')
            ? 'Задайте реестр по умолчанию в environment политики (npm_config_registry и pnpm_config_registry; токен — секретом): сборка seed получит его хост сама. '
            : '') +
          (scoped
            ? 'Реестр области (@scope:registry) окружение политики задать не может: для таких пакетов хранилище не ускоряет установку.'
            : '')
        ).trimEnd(),
      });
    });
  policy.repositories.forEach((repo, i) => {
    const found: Found[] = [];
    const field = `repositories[${i}]`;
    for (const [name, list] of [
      ['prepare', repo.prepare],
      ['dependencyBuild', repo.dependencyBuild],
      ['preflight', repo.preflight],
    ] as const)
      list.forEach((step, j) =>
        argvCaches(step.command, `${field}.${name}[${j}] ${step.id}`, found),
      );
    const lifecycle = repo.lifecycle ?? policy.lifecycle;
    if (lifecycle)
      for (const phase of ['setup', 'ready', 'teardown'] as const)
        lifecycle[phase].forEach((step, j) =>
          argvCaches(
            step.command,
            `${repo.lifecycle ? field + '.' : ''}lifecycle.${phase}[${j}] ${step.id}`,
            found,
          ),
        );
    repo.gates.forEach((gate, j) =>
      argvCaches(gate.command, `${field}.gates[${j}] ${gate.id}`, found),
    );
    envCaches(repo.environment, `${field}.environment`, found);
    for (const f of found) advice.push(cacheAdvice(repo.id, f, unsupported.get(repo.id), lean));
  });
  const global: Found[] = [];
  envCaches(policy.environment, 'environment', global);
  for (const [id, profile] of Object.entries(policy.toolProfiles))
    envCaches(profile.environment, `toolProfiles.${id}.environment`, global);
  policy.workspaceGates.forEach((gate, j) =>
    argvCaches(gate.command, `workspaceGates[${j}] ${gate.id}`, global),
  );
  for (const f of global) advice.push(cacheAdvice(undefined, f, undefined, lean));
  // Одна и та же находка из двух мест — одна строка.
  return [...new Map(advice.map((a) => [a.code + a.message, a])).values()];
}

function cacheAdvice(
  repo: string | undefined,
  f: Found,
  unsupported: string | undefined,
  lean: string,
): StoreAdvice {
  const fix = unsupported
    ? `хранилище harness для pnpm ${unsupported} не действует — сообщите это оператору как находку по harness и уберите свой кэш, а не переносите его в общий путь`
    : `уберите его и включите dependencyStore: ${lean} (общий seed по lockfile целевой ветки, сверка по манифесту, копия в каждом checkout)`;
  return {
    code: 'DEPENDENCY_CACHE_PATH',
    message:
      `${repo ? `репозиторий ${repo}: ` : ''}${f.at}: свой store/кэш pnpm (${f.what}) ` +
      (f.where === 'worktree'
        ? 'внутри рабочей копии: у каждой попытки он свой и пустой, и пакеты скачиваются заново в каждой попытке'
        : 'по общему пути вне рабочей копии: общее изменяемое состояние попыток вне границы доверия хранилища (его байты никто не сверяет), путь не переносим') +
      `. Исправление: ${fix}`,
  };
}
