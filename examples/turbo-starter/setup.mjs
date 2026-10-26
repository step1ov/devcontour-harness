#!/usr/bin/env node
/**
 * Поставляемая подготовка Turbo Starter для devcontour-harness (только
 * встроенные модули Node; путь — внутри установленного пакета:
 * node_modules/devcontour-harness/examples/turbo-starter/setup.mjs).
 *
 * Шаги (без скрытых патчей внешнего checkout):
 *   1. `git clone` источника (URL или локальное зеркало) в `<work>/turbo-starter`
 *      и checkout закреплённого commit; origin удаляется — push из копии невозможен.
 *   2. Настройка примера `harness/` копируется в `.harness/` и фиксируется
 *      отдельным baseline-коммитом с фиксированными автором и датой.
 *   3. pnpm закреплённой версии ставится в `<work>/tools` (`npm install --prefix`,
 *      без глобальной установки).
 *   4. Рядом с копией пишутся `policy.json`, `graph.json` и источник контекста
 *      `context/controller-mode/` (оверлей templates/controller-mode с provenance).
 *
 * CLI:
 *   node <пакет>/examples/turbo-starter/setup.mjs --work <dir> [--source <url|path>] [--warm] [--no-pnpm]
 * Печатает JSON-манифест; дальше — `npx harness validate|run` в <work> (docs/turbo-starter.md).
 *
 * Библиотека (сценарии S01–S06, W01): prepareStarterFixture, starterPolicy,
 * starterGraph, changeFiles, controllerContext, writeLayout.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** Каталог примера (этот файл лежит в нём) и шаблон controller mode пакета. */
export const EXAMPLE = dirname(fileURLToPath(import.meta.url));
export const CONTROLLER_TEMPLATE = resolve(EXAMPLE, '..', '..', 'templates', 'controller-mode');
export const STARTER = Object.freeze({
  url: 'https://github.com/oim-dev/turbo-starter',
  commit: '78f1e76b80f76ae9d4289e0b0994df8a6f2b89cc',
  pnpm: '11.25.0',
});
/** Версия поставляемой настройки fixture: часть сообщения baseline-коммита и манифеста. */
export const SETUP_VERSION = 'turbo-starter-setup/v1';

const identity = {
  GIT_AUTHOR_NAME: 'devcontour-harness fixture',
  GIT_AUTHOR_EMAIL: 'fixture@devcontour-harness.invalid',
  GIT_COMMITTER_NAME: 'devcontour-harness fixture',
  GIT_COMMITTER_EMAIL: 'fixture@devcontour-harness.invalid',
  GIT_AUTHOR_DATE: '2026-10-22T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-22T00:00:00Z',
};
export const git = (cwd, args, env = {}) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...identity, ...env },
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/**
 * Подготовить fixture в новом каталоге `workDir/turbo-starter`.
 * @param {{ workDir: string, source?: string, commit?: string, installPnpm?: boolean,
 *   warm?: boolean, log?: (line: string) => void }} options
 */
export function prepareStarterFixture(options) {
  const log = options.log ?? (() => {});
  // Канонический путь (realpath): Git сообщает пути worktree именно так.
  mkdirSync(resolve(options.workDir), { recursive: true });
  const workDir = realpathSync(resolve(options.workDir));
  const requested = options.source ?? process.env.STARTER_SOURCE ?? STARTER.url;
  const source = existsSync(requested) ? resolve(requested) : requested;
  const commit = options.commit ?? STARTER.commit;
  const repo = join(workDir, 'turbo-starter');
  if (existsSync(repo)) throw new Error(`Каталог fixture уже существует: ${repo}`);
  log(`clone ${source} @ ${commit}`);
  // Локальное зеркало клонируется копией объектов (--no-local): копия не делит
  // с ним файлы и не может изменить источник.
  const local = existsSync(source);
  // Сетевой clone повторяется до трёх раз (обрыв соединения — не свойство копии).
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(
        'git',
        ['clone', '--quiet', '--no-checkout', ...(local ? ['--no-local'] : []), source, repo],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      break;
    } catch (error) {
      rmSync(repo, { recursive: true, force: true });
      if (local || attempt >= 3) throw error;
      log(`clone: попытка ${attempt} не удалась, повтор`);
    }
  }
  git(repo, ['checkout', '--quiet', '-B', 'main', commit]);
  const head = git(repo, ['rev-parse', 'HEAD']);
  if (head !== commit) throw new Error(`HEAD ${head} не совпадает с закреплённым ${commit}`);
  git(repo, ['remote', 'remove', 'origin']);
  // Поставляемая настройка — отдельный видимый коммит.
  cpSync(join(EXAMPLE, 'harness'), join(repo, '.harness'), { recursive: true });
  git(repo, ['add', '.harness']);
  git(repo, [
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '-m',
    `fixture: devcontour-harness ${SETUP_VERSION}`,
  ]);
  const baselineSha = git(repo, ['rev-parse', 'HEAD']);
  const setup = filesUnder(join(EXAMPLE, 'harness')).map((path) => ({
    path: '.harness/' + relative(join(EXAMPLE, 'harness'), path).split('\\').join('/'),
    sha256: sha256(readFileSync(path)),
  }));
  let pathPrepend = [];
  let pnpm;
  if (options.installPnpm !== false) {
    const tools = join(workDir, 'tools');
    log(`install pnpm@${STARTER.pnpm} into ${tools}`);
    execFileSync(
      'npm',
      [
        'install',
        '--prefix',
        tools,
        `pnpm@${STARTER.pnpm}`,
        '--prefer-offline',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    pathPrepend = [join(tools, 'node_modules', '.bin')];
    pnpm = execFileSync(join(pathPrepend[0], 'pnpm'), ['--version'], { encoding: 'utf8' }).trim();
    if (pnpm !== STARTER.pnpm) throw new Error(`pnpm ${pnpm} вместо ${STARTER.pnpm}`);
  }
  const env = {
    PATH: [...pathPrepend, process.env.PATH].join(':'),
  };
  if (options.warm) {
    // Прогрев pnpm store и dlx-кэша генератора на основном checkout копии
    // (node_modules и выходы игнорируются Git; дерево остаётся чистым).
    log('warm pnpm store and codegen cache');
    const run = (args) =>
      execFileSync('pnpm', args, {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env, DOTENV_CONFIG_PATH: '/dev/null', CHECKPOINT_DISABLE: '1' },
        maxBuffer: 64 * 1024 * 1024,
      });
    run(['install', '--frozen-lockfile', '--prefer-offline']);
    run(['rest-api-sdk:generate']);
    const dirty = git(repo, ['status', '--porcelain']);
    if (dirty) throw new Error('Прогрев изменил отслеживаемые файлы:\n' + dirty);
  }
  const manifest = {
    version: 1,
    setupVersion: SETUP_VERSION,
    upstream: { source, commit },
    baselineSha,
    baselineMessage: git(repo, ['log', '-1', '--format=%s']),
    setup,
    tools: { node: process.version, pnpm: pnpm ?? null },
    repo,
  };
  writeFileSync(join(workDir, 'fixture.json'), JSON.stringify(manifest, null, 2));
  return { workDir, repo, baselineSha, upstream: manifest.upstream, pathPrepend, env, manifest };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Политика примера для fixture: путь репозитория, target ref, fixture
 * runtime (`FIXTURE_SCENARIO`) и необязательные правки `edit(policy)`.
 * Без `scenario` — политика для живых runtime.
 */
export function starterPolicy(fixture, options = {}) {
  const policy = readJson(join(EXAMPLE, options.template ?? 'policy.json'));
  const repo = policy.repositories[0];
  repo.path = options.repoPath ?? fixture.repo;
  if (options.targetRef) repo.targetRef = options.targetRef;
  if (options.scenario)
    policy.environment = {
      ...(policy.environment ?? {}),
      values: { ...(policy.environment?.values ?? {}), FIXTURE_SCENARIO: options.scenario },
    };
  options.edit?.(policy);
  return policy;
}

/** Граф примера; `edit(graph)` — правки (ID, редакция, область, gates). */
export function starterGraph(options = {}) {
  const graph = readJson(join(EXAMPLE, options.template ?? 'graph.json'));
  options.edit?.(graph);
  return graph;
}

/**
 * Файлы изменения: путь → итоговое содержимое после применения patch к
 * baseline. Применяется во временный index (`git apply --cached`), рабочее
 * дерево и refs копии не меняются.
 */
export function changeFiles(fixture, patch) {
  const path = existsSync(patch) ? patch : join(EXAMPLE, 'changes', patch);
  const index = join(tmpdir(), `starter-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(fixture.repo, ['read-tree', fixture.baselineSha], env);
    git(fixture.repo, ['apply', '--cached', path], env);
    const names = git(fixture.repo, ['apply', '--numstat', path])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t')[2]);
    return Object.fromEntries(
      names.map((name) => [
        name,
        execFileSync('git', ['show', ':' + name], {
          cwd: fixture.repo,
          encoding: 'utf8',
          env: { ...process.env, ...env },
          maxBuffer: 64 * 1024 * 1024,
        }),
      ]),
    );
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * Источник контекста `controller-mode` в `<dir>/controller-mode/`: оверлей
 * шаблона без изменений, product AGENTS.md как закреплённые справки
 * (`references/`, не вкладываются в запрос) и provenance.
 */
export function controllerContext(fixture, dir) {
  const target = join(dir, 'controller-mode');
  // Пересборка начинается с пустого каталога: справки удалённых AGENTS.md не
  // остаются, а закоммиченный пакет и .harness/ не попадают в свои же справки.
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, 'references'), { recursive: true });
  const overlay = readFileSync(join(CONTROLLER_TEMPLATE, 'AGENTS.controller.md'));
  writeFileSync(join(target, 'AGENTS.controller.md'), overlay);
  const inside = relative(fixture.repo, resolve(target));
  const exclude = [':(exclude).harness/**'];
  if (inside && !inside.startsWith('..') && !isAbsolute(inside))
    exclude.push(`:(exclude)${inside.split(sep).join('/')}/**`);
  const product = git(fixture.repo, ['ls-files', '--', 'AGENTS.md', '**/AGENTS.md', ...exclude])
    .split('\n')
    .filter(Boolean);
  const references = product.map((path) => {
    const bytes = execFileSync('git', ['show', `${fixture.baselineSha}:${path}`], {
      cwd: fixture.repo,
    });
    mkdirSync(dirname(join(target, 'references', path)), { recursive: true });
    writeFileSync(join(target, 'references', path), bytes);
    return {
      path,
      blob: git(fixture.repo, ['rev-parse', `${fixture.baselineSha}:${path}`]),
      sha256: sha256(bytes),
    };
  });
  const provenance = {
    overlay: {
      template: 'templates/controller-mode/AGENTS.controller.md',
      version: 1,
      sha256: sha256(overlay),
    },
    product: { baselineSha: fixture.baselineSha, upstream: fixture.upstream, files: references },
  };
  writeFileSync(join(target, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  return { dir: target, provenance };
}

/** Ответ fixture reviewer «одобрено» (форма tests/runner-fixture.ts). */
export const approve = (summary = 'Критерии выполнены') => ({
  result: {
    approved: true,
    summary,
    findings: [],
    discoveries: [],
    execution: { commands: [], noCommandsReason: 'Проверка по diff и evidence' },
    previous: [],
  },
});
/** Шаг fixture writer: записать файлы и отчитаться о выполнении. */
export const implement = (files, summary = 'Изменение применено') => ({
  files,
  result: { completed: true, summary, discoveries: [] },
});

/**
 * Пользовательская раскладка рядом с копией: политика (путь `turbo-starter`),
 * граф и контекст controller-mode. Без `scenario` — для живых runtime.
 */
export function writeLayout(fixture, options = {}) {
  const policy = starterPolicy(fixture, { repoPath: 'turbo-starter', ...options });
  writeFileSync(join(fixture.workDir, 'policy.json'), JSON.stringify(policy, null, 2) + '\n');
  writeFileSync(
    join(fixture.workDir, 'graph.json'),
    JSON.stringify(starterGraph(), null, 2) + '\n',
  );
  const context = controllerContext(fixture, join(fixture.workDir, 'context'));
  return {
    policy: join(fixture.workDir, 'policy.json'),
    graph: join(fixture.workDir, 'graph.json'),
    context: context.dir,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      work: { type: 'string' },
      source: { type: 'string' },
      commit: { type: 'string' },
      warm: { type: 'boolean' },
      'no-pnpm': { type: 'boolean' },
    },
  });
  if (!values.work) {
    console.error('usage: setup.mjs --work <dir> [--source <url|path>] [--warm] [--no-pnpm]');
    process.exit(2);
  }
  const fixture = prepareStarterFixture({
    workDir: values.work,
    ...(values.source ? { source: values.source } : {}),
    ...(values.commit ? { commit: values.commit } : {}),
    warm: Boolean(values.warm),
    installPnpm: !values['no-pnpm'],
    log: (line) => console.error('[turbo-starter setup] ' + line),
  });
  const layout = writeLayout(fixture);
  console.log(
    JSON.stringify({ ...fixture.manifest, layout, pathPrepend: fixture.pathPrepend }, null, 2),
  );
}
