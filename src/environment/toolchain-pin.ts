import { execFileSync } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { BlockedError, type ToolchainFacts, type ToolchainPin } from '../contracts/index.ts';
import { resolveExecutable } from '../toolchains/probe.ts';

/**
 * Закрепление toolchain политики (`policy.toolchain`): разрешение каталога
 * Node.js и PATH процессов прогона. Каталог ставится первым в PATH каждого
 * окружения фазы (`executionEnvironment`) — gates, `harness gates`, lifecycle,
 * `smoke`, `prepare`, writer и reviewers видят один и тот же node, кто бы ни
 * запустил harness и какой бы PATH ни был у его оболочки.
 */

/** Закреплённый node не найден: отказ окружения до работы, попытка не засчитывается. */
export class ToolchainPinError extends BlockedError {
  override name = 'ToolchainPinError';
}

/** Разрешённое закрепление: каталог с `node` и его версия (без «v»). */
export interface ResolvedNodePin {
  requested: string;
  binDir: string;
  version: string;
}

const PROBE_TIMEOUT_MS = 5000;
const probeCache = new Map<string, string | undefined>();

/** `node -v` исполняемого файла (без «v»); не запускается — undefined. Кешируется на процесс. */
export function nodeVersionAt(node: string): string | undefined {
  if (probeCache.has(node)) return probeCache.get(node);
  let version: string | undefined;
  try {
    const out = execFileSync(node, ['-v'], {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: dirname(node), HOME: tmpdir() },
    });
    version = /v?(\d+\.\d+\.\d+)/.exec(out)?.[1];
  } catch {
    version = undefined;
  }
  probeCache.set(node, version);
  return version;
}

const compare = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};
/** Версия подходит закреплению `24` / `24.22` / `24.22.3`: названные компоненты совпадают. */
export const versionMatches = (version: string, pin: string) => {
  const want = pin.split('.');
  const have = version.split('.');
  return want.every((p, i) => Number(p) === Number(have[i]));
};

/**
 * Исполняемый файл есть: сначала `access` (без чтения каталога), затем
 * `stat` — как поиск по PATH (`resolveExecutable`); отсутствующий файл не
 * открывается и не читается.
 */
const runnable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

const list = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * Каталоги-кандидаты с версией, если её называет путь (`v24.22.3`), в
 * порядке предпочтения при равной версии: каталог текущего node, PATH,
 * менеджеры версий, системные каталоги.
 */
export function nodeCandidates(env: NodeJS.ProcessEnv = process.env) {
  const home = env.HOME || homedir();
  const out: { dir: string; version?: string }[] = [];
  const add = (dir: string, version?: string) => out.push({ dir, ...(version ? { version } : {}) });
  add(dirname(process.execPath));
  // Каталоги node_modules (`.bin` проекта) — не установка node, а код проекта.
  for (const d of (env.PATH ?? '').split(delimiter))
    if (d && isAbsolute(d) && !d.split(sep).includes('node_modules')) add(d);
  const named = (root: string, bin: (name: string) => string) => {
    for (const name of list(root)) {
      const v = /^v?(\d+\.\d+\.\d+)$/.exec(name)?.[1];
      if (v) add(bin(join(root, name)), v);
    }
  };
  named(join(env.NVM_DIR || join(home, '.nvm'), 'versions', 'node'), (d) => join(d, 'bin'));
  for (const root of [
    join(env.FNM_DIR || join(home, '.local', 'share', 'fnm'), 'node-versions'),
    join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
  ])
    named(root, (d) => join(d, 'installation', 'bin'));
  named(join(env.VOLTA_HOME || join(home, '.volta'), 'tools', 'image', 'node'), (d) =>
    join(d, 'bin'),
  );
  named(join(env.ASDF_DATA_DIR || join(home, '.asdf'), 'installs', 'nodejs'), (d) =>
    join(d, 'bin'),
  );
  named(join(home, '.local', 'share', 'mise', 'installs', 'node'), (d) => join(d, 'bin'));
  add('/opt/homebrew/bin');
  add('/usr/local/bin');
  return out;
}

const resolveCache = new Map<string, ResolvedNodePin>();

/**
 * Каталог закреплённого node. Абсолютный каталог — как есть (в нём должен
 * быть исполняемый `node`); версия — самая новая подходящая среди
 * `nodeCandidates`. Не нашлось — `ToolchainPinError` с советом.
 */
export function resolveNodePin(
  pin: ToolchainPin,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedNodePin {
  const key = JSON.stringify([pin.node, env.PATH, env.HOME, env.NVM_DIR, process.execPath]);
  const hit = resolveCache.get(key);
  if (hit) return hit;
  const advice =
    'Установите эту версию (nvm install, fnm install …) или укажите в policy.toolchain.node абсолютный каталог с node; проверить — harness doctor.';
  let resolved: ResolvedNodePin | undefined;
  if (isAbsolute(pin.node)) {
    const dir = resolve(pin.node);
    const node = join(dir, 'node');
    const version = runnable(node) ? nodeVersionAt(node) : undefined;
    if (!version)
      throw new ToolchainPinError(
        `Закреплённый toolchain policy.toolchain.node=${pin.node}: в каталоге нет работающего node. ${advice}`,
      );
    resolved = { requested: pin.node, binDir: dir, version };
  } else {
    let best: ResolvedNodePin | undefined;
    const seen = new Set<string>();
    for (const c of nodeCandidates(env)) {
      if (seen.has(c.dir)) continue;
      seen.add(c.dir);
      const node = join(c.dir, 'node');
      if (!runnable(node)) continue;
      // Версию из имени каталога достаточно сверить с закреплением: проба —
      // только у подходящих и у каталогов без версии в имени.
      if (c.version && !versionMatches(c.version, pin.node)) continue;
      const version = nodeVersionAt(node);
      if (!version || !versionMatches(version, pin.node)) continue;
      if (!best || compare(version, best.version) > 0)
        best = { requested: pin.node, binDir: c.dir, version };
    }
    if (!best)
      throw new ToolchainPinError(
        `Закреплённый toolchain policy.toolchain.node=${pin.node}: подходящий node не установлен (искали каталог текущего node, PATH, nvm, fnm, volta, asdf, mise, Homebrew, /usr/local/bin). ${advice}`,
      );
    resolved = best;
  }
  resolveCache.set(key, resolved);
  return resolved;
}

/** PATH с каталогом закрепления первым; прежние вхождения того же каталога убраны. */
export function pinnedPath(path: string | undefined, binDir: string) {
  const rest = (path ?? '').split(delimiter).filter((d) => d && resolve(d) !== binDir);
  return [binDir, ...rest].join(delimiter);
}

/** Окружение источника с закреплённым PATH; без закрепления — источник как есть. */
export function pinnedSource(
  pin: ToolchainPin | undefined,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!pin) return source;
  const r = resolveNodePin(pin, source);
  return { ...source, PATH: pinnedPath(source.PATH, r.binDir) };
}

const factsCache = new Map<string, ToolchainFacts>();
const canonical = (file: string) => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

/**
 * Фактический toolchain окружения: первый `node` в PATH (абсолютный путь и
 * `node -v`) и, если просили, `pnpm --version`. Кешируется на процесс по PATH.
 */
export function toolchainFacts(
  path: string | undefined,
  options: { pnpm?: boolean } = {},
): ToolchainFacts {
  const key = JSON.stringify([path, Boolean(options.pnpm)]);
  const hit = factsCache.get(key);
  if (hit) return hit;
  const facts: ToolchainFacts = {};
  const node = resolveExecutable('node', path);
  if (node) {
    const version = nodeVersionAt(node);
    if (version) facts.node = { version, path: node };
  }
  if (options.pnpm) {
    const pnpm = resolveExecutable('pnpm', path);
    if (pnpm)
      try {
        const out = execFileSync(pnpm, ['--version'], {
          cwd: tmpdir(),
          encoding: 'utf8',
          timeout: PROBE_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { PATH: path ?? '', HOME: tmpdir(), COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
        });
        const version = /(\d+\.\d+\.\d+)/.exec(out)?.[1];
        if (version) facts.pnpm = { version, path: pnpm };
      } catch {
        /* pnpm не отвечает — версия неизвестна */
      }
  }
  factsCache.set(key, facts);
  return facts;
}

/** Строка toolchain для лога: `node v24.22.3 (/…/bin/node); pnpm 10.1.0 (/…/pnpm)`. */
export function toolchainText(f: ToolchainFacts) {
  const node = f.node ? `node v${f.node.version} (${f.node.path})` : 'node не найден в PATH';
  return node + (f.pnpm ? `; pnpm ${f.pnpm.version} (${f.pnpm.path})` : '');
}

/** Один и тот же node: версия и канонический путь исполняемого файла. */
export function sameNode(a: ToolchainFacts['node'], b: ToolchainFacts['node']) {
  if (!a || !b) return true;
  return a.version === b.version && canonical(a.path) === canonical(b.path);
}

/** Команда, вероятно, вызывает pnpm (первое слово или в `sh -c`). */
export const usesPnpm = (argv: readonly string[]) =>
  argv.some((a) => /(^|[\s/;&|])(pnpm|pnpx)(\s|$)/.test(a));

/**
 * Предложение `init`: версия из `.nvmrc` / `.node-version` / `engines.node`
 * проекта, если она точная и установлена, иначе версия node, который
 * запускает init. `source` называет, откуда взята версия.
 */
export function proposeNodePin(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  current = process.version.replace(/^v/, ''),
): { pin: ToolchainPin; source: string; version: string } {
  const exact = (text: string | undefined) => /^\s*v?(\d+\.\d+\.\d+)\s*$/.exec(text ?? '')?.[1];
  const read = (file: string) => {
    try {
      return readFileSync(join(root, file), 'utf8');
    } catch {
      return undefined;
    }
  };
  const engines = (() => {
    try {
      const pkg = JSON.parse(read('package.json') ?? '') as { engines?: { node?: unknown } };
      return typeof pkg.engines?.node === 'string' ? pkg.engines.node : undefined;
    } catch {
      return undefined;
    }
  })();
  for (const [file, text] of [
    ['.nvmrc', read('.nvmrc')],
    ['.node-version', read('.node-version')],
    ['package.json engines.node', engines],
  ] as const) {
    const version = exact(text);
    if (!version) continue;
    try {
      resolveNodePin({ node: version }, env);
      return { pin: { node: version }, source: file, version };
    } catch {
      /* версия проекта не установлена — следующий источник */
    }
  }
  return { pin: { node: current }, source: 'node, запустивший init', version: current };
}

/** Успешный запуск gate с записанным toolchain — основание сверки провала. */
export interface ToolchainBaseline {
  toolchain: ToolchainFacts;
  at: string;
  where: string;
}

/**
 * Последний успешный запуск `gate` репозитория с записанным toolchain:
 * evidence прежних попыток (`records`) и итоги `harness gates`
 * (`<stateDir>/gates-at/<id>/result.json`). Нет — undefined.
 */
export function toolchainBaseline(
  gate: string,
  repositoryId: string,
  records: readonly {
    runId: string;
    gate: string;
    kind: string;
    passed: boolean;
    consumer?: string;
    createdAt: string;
    toolchain?: ToolchainFacts;
  }[],
  stateDir?: string,
): ToolchainBaseline | undefined {
  let best: ToolchainBaseline | undefined;
  const offer = (c: ToolchainBaseline) => {
    if (!best || Date.parse(c.at) > Date.parse(best.at)) best = c;
  };
  for (const e of records)
    if (e.kind === 'test' && e.gate === gate && e.passed && !e.consumer && e.toolchain?.node)
      offer({ toolchain: e.toolchain, at: e.createdAt, where: `в попытке ${e.runId}` });
  if (stateDir) {
    const root = join(stateDir, 'gates-at');
    for (const name of list(root)) {
      try {
        const raw = JSON.parse(readFileSync(join(root, name, 'result.json'), 'utf8')) as {
          at?: string;
          data?: {
            id?: string;
            repositoryId?: string;
            sha?: string;
            gates?: { gate?: string; status?: string; toolchain?: ToolchainFacts }[];
          };
        };
        if (raw.data?.repositoryId !== repositoryId || typeof raw.at !== 'string') continue;
        const g = raw.data.gates?.find((x) => x.gate === gate && x.status === 'passed');
        if (g?.toolchain?.node?.version && typeof g.toolchain.node.path === 'string')
          offer({
            toolchain: g.toolchain,
            at: raw.at,
            where: `в harness gates ${raw.data.id ?? name}${raw.data.sha ? ` на ${raw.data.sha.slice(0, 12)}` : ''}`,
          });
      } catch {
        /* нет итога или он не по форме */
      }
    }
  }
  return best;
}
