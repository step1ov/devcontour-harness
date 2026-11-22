import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { executionPolicySchema, type ExecutionPolicyInput } from '../src/contracts/index.ts';
import { RESOURCES_LIMITS, resourcesViewSchema } from '../src/contracts/view-resources.ts';
import { resourcesInputOf } from '../src/control/view-resources.ts';
import {
  RESOURCES_VIEW_LIMITS,
  environmentState,
  imageLabel,
  resourcesOf,
  type ResourcesInput,
} from '../src/projections/view-resources.ts';
import { maskText } from '../src/projections/mask.ts';

const mask = (s: string, max: number) => maskText(s, max, { home: '/Users/someone' }) ?? '';
const NOW = Date.parse('2026-11-22T10:30:00.000Z');
const ru = { lang: 'ru' as const, mask, now: NOW };
const en = { lang: 'en' as const, mask, now: NOW };

const lifecycle = {
  setup: [{ id: 'compose-setup', command: ['node', '.harness/compose-bridge.mjs', 'setup'] }],
  ready: [{ id: 'compose-ready', command: ['node', '.harness/compose-bridge.mjs', 'ready'] }],
  teardown: [
    { id: 'compose-teardown', command: ['node', '.harness/compose-bridge.mjs', 'teardown'] },
  ],
};

function policyOf(over: Partial<ExecutionPolicyInput> = {}) {
  return executionPolicySchema.parse({
    policyVersion: 1,
    repositories: [
      {
        id: 'app',
        path: '.',
        targetRef: 'refs/heads/harness/accepted',
        gates: [
          { id: 'unit', kind: 'check', command: ['node', 'test.js'] },
          { id: 'lint', kind: 'check', command: ['node', 'lint.js'] },
        ],
        lifecycle,
        dependencyStore: { manager: 'pnpm' },
        toolchain: { tools: { pnpm: '11.25.0', go: '>=1.24' }, packageManagers: { '.': 'pnpm' } },
      },
      {
        id: 'web',
        path: 'web',
        targetRef: 'refs/heads/harness/accepted',
        gates: [{ id: 'build', kind: 'check', command: ['node', 'build.js'] }],
        roles: { designer: { writer: { runtime: 'claude', model: 'claude-opus-4-1' } } },
      },
    ],
    roles: {
      developer: {
        writer: { runtime: 'codex', model: 'gpt-5.1', effort: 'medium', toolProfile: 'closed' },
        review: { reviewer: { runtime: 'claude' } },
      },
    },
    review: {
      code: { reviewer: { runtime: 'claude' }, alternates: [{ runtime: 'codex' }] },
      plan: { reviewer: { runtime: 'claude', model: 'claude-opus-4-1' } },
      contract: { reviewer: { runtime: 'claude' } },
    },
    toolProfiles: { closed: { runtime: 'codex', network: 'none' } },
    toolchain: { node: '24.22.3' },
    workspaceGates: [
      { id: 'joint', kind: 'check', repositoryId: 'app', command: ['node', 'joint.js'] },
    ],
    ...over,
  });
}

/** Каталог проекта: `.harness/project.json` и каталог состояния в своём temp. */
function fixtureDirs(lead?: 'claude' | 'codex') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-resources-')));
  const baseDir = join(root, '.harness');
  const stateDir = join(root, 'state');
  mkdirSync(baseDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  if (lead)
    writeFileSync(
      join(baseDir, 'project.json'),
      JSON.stringify({
        apiVersion: 'devcontour-harness/v1alpha1',
        kind: 'harness-project',
        manifestVersion: 1,
        projectId: 'p-0123456789abcdef',
        root,
        repository: { id: 'app', targetRef: 'refs/heads/harness/accepted' },
        profile: { ref: 'node', pin: { id: 'node', version: '1.0.0', digest: 'a'.repeat(64) } },
        lead,
        runtimes: { writer: 'codex', reviewer: 'claude' },
        paths: {
          policy: '.harness/policy.json',
          work: '.harness/work',
          notes: '.harness/work/context/notes',
          state: stateDir,
        },
      }),
    );
  return { root, baseDir, stateDir };
}

/** Запись окружения, как её пишет `phaseEnvironment`, и мост compose примера turbo-starter. */
function receipt(
  dir: string,
  r: { status: string; ownerPid?: number; runId: string; repo?: string; startedAt?: string },
  image?: string,
) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'environment.json'),
    JSON.stringify({
      version: 1,
      ...(r.ownerPid ? { ownerPid: r.ownerPid } : {}),
      devcontourEnv: r.repo ? { DEVCONTOUR_REPOSITORY_ID: r.repo } : {},
      cwd: '/somewhere/worktree',
      lifecycle,
      policyDigest: 'x',
      status: r.status,
      startedAt: r.startedAt ?? '2026-11-22T10:00:00.000Z',
      runId: r.runId,
    }),
  );
  if (image) {
    mkdirSync(join(dir, 'bridge'), { recursive: true });
    writeFileSync(
      join(dir, 'bridge', 'compose.json'),
      JSON.stringify({ services: { postgres: { image } } }),
    );
  }
}

/** Снимок дерева: путь → размер и mtime, чтобы увидеть любую запись. */
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(d, e.name);
      const s = statSync(p);
      out.push(`${relative(dir, p)} ${e.isDirectory() ? 'd' : s.size} ${s.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.join('\n');
}

test('пределы проекции совпадают с RESOURCES_LIMITS договора', () => {
  assert.deepEqual(RESOURCES_VIEW_LIMITS, RESOURCES_LIMITS);
});

test('роли и вендоры: исполнители, проверяющие с запасными, ведущий из манифеста', () => {
  const { baseDir, stateDir } = fixtureDirs('claude');
  const input = resourcesInputOf(policyOf(), stateDir, baseDir)!;
  const v = resourcesViewSchema.parse(resourcesOf(input, ru));
  const lead = v.roles[0]!;
  assert.equal(lead.kind, 'lead');
  assert.equal(lead.vendor, 'Anthropic');
  assert.equal(lead.line, 'Ведёт проект: Claude (Anthropic)');
  const dev = v.roles.find((r) => r.kind === 'writer' && r.role === 'developer')!;
  assert.equal(dev.vendor, 'OpenAI');
  assert.equal(dev.model, 'gpt-5.1');
  assert.equal(dev.effort, 'medium');
  assert.equal(dev.network, 'closed');
  assert.match(
    dev.line,
    /^Пишет код — роль developer: Codex \(OpenAI\), модель gpt-5\.1; сеть: сеть закрыта$/,
  );
  const designer = v.roles.find((r) => r.role === 'designer')!;
  assert.equal(designer.repositoryId, 'web');
  assert.equal(designer.vendor, 'Anthropic');
  // claude без поля network: прежняя граница — локальные порты (доменов нет).
  assert.equal(designer.network, 'loopback');
  const roleReview = v.roles.find((r) => r.kind === 'reviewer' && r.role === 'developer')!;
  assert.equal(
    roleReview.line,
    'Проверяет код роли developer: Claude (Anthropic), модель по умолчанию',
  );
  const plan = v.roles.find((r) => r.review === 'plan')!;
  assert.equal(plan.model, 'claude-opus-4-1');
  const alt = v.roles.find((r) => r.alternate)!;
  assert.equal(alt.review, 'code');
  assert.equal(alt.vendor, 'OpenAI');
  assert.match(alt.line, /^Запасной проверяющий кода: Codex \(OpenAI\)/);
  assert.equal(v.roles.filter((r) => r.kind === 'reviewer').length, 5);
  assert.match(
    v.lines[0]!,
    /^Модели: ведёт Claude \(Anthropic\); пишет Codex \(OpenAI, gpt-5\.1\), Claude \(Anthropic, claude-opus-4-1\); проверяет /,
  );
});

test('без манифеста ведущего нет; fixture — тестовые ответы без сети', () => {
  const { baseDir, stateDir } = fixtureDirs();
  const policy = policyOf({
    mode: 'fixture',
    roles: { developer: { writer: { runtime: 'fixture' } } },
    review: {
      code: { reviewer: { runtime: 'fixture' } },
      plan: { reviewer: { runtime: 'fixture' } },
      contract: { reviewer: { runtime: 'fixture' } },
    },
  });
  const v = resourcesViewSchema.parse(
    resourcesOf(resourcesInputOf(policy, stateDir, baseDir)!, ru),
  );
  assert.equal(
    v.roles.some((r) => r.kind === 'lead'),
    false,
  );
  const dev = v.roles.find((r) => r.role === 'developer' && r.kind === 'writer')!;
  assert.equal(dev.vendor, 'fixture');
  assert.equal(dev.network, undefined);
  assert.match(dev.line, /тестовые ответы \(fixture\)/);
});

test('изоляция: сеть закрыта, только локальные адреса, разрешённые домены, по-разному, песочница выключена', () => {
  const { baseDir, stateDir } = fixtureDirs();
  const only = (network: 'none' | 'loopback' | 'full') =>
    policyOf({
      repositories: [policyOf().repositories[0]!],
      toolProfiles: { closed: { runtime: 'codex', network } },
    });
  const closed = resourcesOf(resourcesInputOf(only('none'), stateDir, baseDir)!, ru).isolation;
  assert.equal(closed.sandbox, 'os');
  assert.equal(closed.writers, 'closed');
  assert.equal(closed.gates, 'loopback');
  assert.equal(
    closed.line,
    'Песочница системы: исполнители — сеть закрыта; проверки — только локальные адреса (127.0.0.1), без интернета',
  );
  const loop = resourcesOf(resourcesInputOf(only('loopback'), stateDir, baseDir)!, ru).isolation;
  assert.equal(loop.writers, 'loopback');
  assert.equal(
    loop.line,
    'Песочница системы: у исполнителей и проверок только локальные адреса (127.0.0.1), без интернета',
  );
  const loopEn = resourcesOf(resourcesInputOf(only('loopback'), stateDir, baseDir)!, en).isolation;
  assert.equal(
    loopEn.line,
    'OS sandbox: writers and checks — local addresses only (127.0.0.1), no internet',
  );
  // Роль codex с закрытой сетью и claude без поля (локальные порты) — по-разному.
  const mixed = resourcesOf(resourcesInputOf(policyOf(), stateDir, baseDir)!, ru).isolation;
  assert.equal(mixed.writers, 'mixed');
  const domains = policyOf({
    repositories: [policyOf().repositories[0]!],
    roles: { developer: { writer: { runtime: 'claude' } } },
    isolation: { mode: 'os', domains: ['registry.npmjs.org', 'api.github.com'] },
  });
  const d = resourcesOf(resourcesInputOf(domains, stateDir, baseDir)!, ru).isolation;
  assert.equal(d.writers, 'domains');
  assert.equal(d.gates, 'domains');
  assert.equal(d.domains, 2);
  assert.match(d.line, /только разрешённые адреса \(2\) и локальные/);
  const off = resourcesOf(
    resourcesInputOf(policyOf({ isolation: { mode: 'none', domains: [] } }), stateDir, baseDir)!,
    ru,
  ).isolation;
  assert.equal(off.sandbox, 'none');
  assert.equal(off.writers, 'open');
  assert.equal(off.gates, 'open');
  assert.match(off.line, /^Песочница выключена/);
});

test('закреплённые инструменты и хранилище зависимостей', () => {
  const { baseDir, stateDir } = fixtureDirs();
  mkdirSync(join(stateDir, 'dependency-store', 'app', 'seeds', 'a1'), { recursive: true });
  mkdirSync(join(stateDir, 'dependency-store', 'app', 'seeds', 'b2'), { recursive: true });
  mkdirSync(join(stateDir, 'dependency-store', 'app', 'tmp'), { recursive: true });
  const v = resourcesViewSchema.parse(
    resourcesOf(resourcesInputOf(policyOf(), stateDir, baseDir)!, ru),
  );
  assert.deepEqual(v.toolchain.tools, [
    { name: 'node', version: '24.22.3' },
    { name: 'pnpm', version: '11.25.0', repositoryId: 'app' },
    { name: 'go', version: '>=1.24', repositoryId: 'app' },
  ]);
  assert.equal(
    v.toolchain.line,
    'Закреплено: Node 24.22.3 для всех процессов; app: pnpm 11.25.0, go не ниже 1.24; менеджер пакетов pnpm',
  );
  assert.equal(v.dependencyStore.state, 'partial');
  assert.deepEqual(v.dependencyStore.repositories, [
    { repositoryId: 'app', manager: 'pnpm', seeds: 2 },
  ]);
  assert.equal(
    v.dependencyStore.line,
    'Хранилище зависимостей включено для app (pnpm), выключено для web; готовых наборов: 2',
  );

  const bare = policyOf({
    repositories: [{ ...policyOf().repositories[1]! }],
    toolchain: undefined,
  });
  const b = resourcesViewSchema.parse(resourcesOf(resourcesInputOf(bare, stateDir, baseDir)!, ru));
  assert.deepEqual(b.toolchain.tools, []);
  assert.match(b.toolchain.line, /^Версии инструментов не закреплены/);
  assert.equal(b.dependencyStore.state, 'off');
  assert.equal(
    b.dependencyStore.line,
    'Хранилище зависимостей выключено: каждая попытка ставит пакеты сама',
  );
  const bEn = resourcesOf(resourcesInputOf(bare, stateDir, baseDir)!, en);
  assert.equal(
    bEn.dependencyStore.line,
    'Dependency store is off: every attempt installs packages itself',
  );
  assert.match(bEn.toolchain.line, /^Tool versions are not pinned/);

  const on = policyOf({ repositories: [policyOf().repositories[0]!] });
  const o = resourcesOf(resourcesInputOf(on, stateDir, baseDir)!, ru);
  assert.equal(o.dependencyStore.state, 'on');
  assert.match(
    o.dependencyStore.line,
    /^Хранилище зависимостей включено \(pnpm\): пакеты ставятся один раз/,
  );
});

test('службы lifecycle: работает, остановлены и остались после попыток — по записям, без записи в состояние', () => {
  const { baseDir, stateDir } = fixtureDirs('codex');
  const art = (id: string, phase: string) => join(stateDir, 'artifacts', id, phase, 'environment');
  const image = 'postgres:16-alpine';
  // Работает: запись active, владелец жив, попытка не закончена.
  receipt(
    art('a-run', 'candidate'),
    {
      status: 'active',
      ownerPid: 101,
      runId: 'a-run',
      repo: 'app',
      startedAt: '2026-11-22T10:18:00.000Z',
    },
    image,
  );
  // Остановлены: teardown прошёл.
  receipt(
    art('a-done', 'candidate'),
    { status: 'cleaned', ownerPid: 102, runId: 'a-done', repo: 'app' },
    image,
  );
  receipt(
    art('a-done', 'integration'),
    { status: 'cleaned', ownerPid: 102, runId: 'a-done', repo: 'app' },
    image,
  );
  receipt(
    join(stateDir, 'artifacts', 'a-done', 'integration', 'consumer', 'app', 'environment'),
    { status: 'cleaned', runId: 'a-done', repo: 'app' },
    image,
  );
  // Остались: владелец умер без teardown; очистка не удалась; попытка закончена при живом pid.
  receipt(
    art('a-dead', 'candidate'),
    { status: 'active', ownerPid: 103, runId: 'a-dead', repo: 'app' },
    image,
  );
  receipt(
    art('a-fail', 'candidate'),
    { status: 'cleanup-failed', ownerPid: 101, runId: 'a-fail', repo: 'app' },
    image,
  );
  receipt(
    art('a-over', 'candidate'),
    { status: 'active', ownerPid: 101, runId: 'a-over', repo: 'app' },
    image,
  );
  // `harness gates-at` и совместная проверка без моста compose.
  receipt(
    join(stateDir, 'gates-at', 'LS-1', 'artifacts', 'environment'),
    { status: 'cleaned', runId: 'LS-1', repo: 'app' },
    image,
  );
  receipt(join(stateDir, 'joint', 'J-1', 'environment'), {
    status: 'active',
    ownerPid: 101,
    runId: 'J-1',
  });
  const policy = policyOf({ workspaceLifecycle: lifecycle });
  const before = snapshot(stateDir);
  const asked: number[] = [];
  const input = resourcesInputOf(policy, stateDir, baseDir, {
    processAlive: (pid) => (asked.push(pid), pid === 101),
    attemptFinished: (id) => (id === 'a-over' ? true : id === 'a-run' ? false : undefined),
  })!;
  assert.equal(snapshot(stateDir), before, 'каталог состояния не изменился');
  // Процесс проверяется только у незакрытых записей.
  assert.deepEqual([...new Set(asked)].sort(), [101, 103]);
  const v = resourcesViewSchema.parse(resourcesOf(input, ru));
  const pg = v.services.find((s) => s.name === 'PostgreSQL 16')!;
  assert.equal(pg.engine, 'docker');
  assert.equal(pg.scope, 'attempt');
  assert.equal(pg.repositoryId, 'app');
  assert.deepEqual([pg.running, pg.stopped, pg.leftover], [1, 4, 3]);
  assert.equal(pg.since, '2026-11-22T10:18:00.000Z');
  assert.deepEqual(pg.leftoverRuns, ['a-dead', 'a-fail', 'a-over']);
  assert.equal(
    pg.line,
    'Docker: PostgreSQL 16, контейнер на каждую попытку (app) — сейчас работает 1 (12 мин) · остановлено: 4 · осталось после попыток: 3 — убрать: harness cleanup --run <id>',
  );
  const joint = v.services.find((s) => s.scope === 'workspace')!;
  assert.equal(joint.repositoryId, '@workspace');
  assert.equal(joint.name, 'окружение (шаги compose-setup)');
  assert.equal(joint.running, 1);
  assert.match(
    joint.line,
    /на каждую совместную проверку \(совместная проверка\) — сейчас работает 1/,
  );
  assert.ok(v.lines.includes(pg.line));
  const pgEn = resourcesOf(input, en).services.find((s) => s.name === 'PostgreSQL 16')!;
  assert.equal(
    pgEn.line,
    'Docker: PostgreSQL 16, a container per attempt (app) — running now: 1 (12 min) · stopped: 4 · left after attempts: 3 — clean up: harness cleanup --run <id>',
  );
});

test('lifecycle политики без записей — служба «ещё не запускалось»; нечитаемая запись пропускается', () => {
  const { baseDir, stateDir } = fixtureDirs();
  mkdirSync(join(stateDir, 'artifacts', 'broken', 'candidate', 'environment'), { recursive: true });
  writeFileSync(
    join(stateDir, 'artifacts', 'broken', 'candidate', 'environment', 'environment.json'),
    '{not json',
  );
  const v = resourcesViewSchema.parse(
    resourcesOf(resourcesInputOf(policyOf(), stateDir, baseDir)!, ru),
  );
  assert.equal(v.services.length, 1);
  const s = v.services[0]!;
  assert.deepEqual([s.running, s.stopped, s.leftover], [0, 0, 0]);
  // Шаги lifecycle запускают мост compose: окружение — контейнеры.
  assert.equal(s.engine, 'docker');
  assert.equal(
    s.line,
    'Docker: окружение (шаги compose-setup), контейнер на каждую попытку (app) — ещё не запускалось',
  );
});

test('классификация записи окружения', () => {
  assert.equal(environmentState({ status: 'cleaned', ownerAlive: true }), 'stopped');
  assert.equal(environmentState({ status: 'cleanup-failed' }), 'leftover');
  assert.equal(environmentState({ status: 'active', ownerAlive: true }), 'running');
  assert.equal(environmentState({ status: 'active' }), 'running');
  assert.equal(environmentState({ status: 'active', ownerAlive: false }), 'leftover');
  assert.equal(
    environmentState({ status: 'active', ownerAlive: true, attemptFinished: true }),
    'leftover',
  );
  assert.equal(imageLabel('postgres:16-alpine'), 'PostgreSQL 16');
  assert.equal(imageLabel('docker.io/library/redis:7.2'), 'Redis 7.2');
  assert.equal(imageLabel('ghcr.io/acme/thing:1.0@sha256:abc'), 'thing 1.0');
  assert.equal(imageLabel('localhost:5000/minio'), 'MinIO');
});

test('число проверок по репозиториям и всего; ru и en', () => {
  const { baseDir, stateDir } = fixtureDirs();
  const v = resourcesViewSchema.parse(
    resourcesOf(resourcesInputOf(policyOf(), stateDir, baseDir)!, ru),
  );
  assert.deepEqual(v.gates, {
    total: 4,
    workspace: 1,
    repositories: [
      { repositoryId: 'app', count: 2 },
      { repositoryId: 'web', count: 1 },
    ],
    line: '4 проверки (gates): app 2, web 1, совместных 1',
  });
  assert.equal(v.lines.at(-1), v.gates.line);
  const e = resourcesOf(resourcesInputOf(policyOf(), stateDir, baseDir)!, en);
  assert.equal(e.gates.line, '4 checks (gates): app 2, web 1, joint 1');
  const one = policyOf({ repositories: [policyOf().repositories[1]!], workspaceGates: [] });
  assert.equal(
    resourcesOf(resourcesInputOf(one, stateDir, baseDir)!, ru).gates.line,
    '1 проверка (gates)',
  );
});

test('строки маскируются и ограничены, списки ограничены с числом отброшенного', () => {
  const secret = 'sk-ant-' + 'a'.repeat(40);
  const many = Array.from({ length: 130 }, (_, i) => ({
    role: 'r' + i,
    kind: 'writer' as const,
    runtime: 'codex',
    vendor: 'openai',
    model: i === 0 ? secret : 'm'.repeat(500),
  }));
  const input: ResourcesInput = {
    mode: 'live',
    sandbox: 'os',
    domains: 0,
    roles: many,
    toolchain: {
      node: '/Users/someone/.nvm/versions/node/v24/bin',
      tools: Array.from({ length: 60 }, (_, i) => ({
        name: 't' + i,
        version: '1',
        repositoryId: 'app',
      })),
      packageManagers: [],
    },
    dependencyStores: [],
    lifecycles: [],
    environments: Array.from({ length: 60 }, (_, i) => ({
      repositoryId: 'app',
      scope: 'attempt' as const,
      status: 'cleaned',
      setup: [],
      docker: true,
      services: [{ name: 's' + i, image: 'img' + i + ':1' }],
      startedAt: 'not-a-date',
    })),
    environmentsTruncated: 7,
    gates: [{ repositoryId: 'app', count: 1 }],
    workspaceGates: 0,
  };
  const v = resourcesViewSchema.parse(resourcesOf(input, ru));
  assert.equal(v.roles.length, RESOURCES_LIMITS.roles);
  assert.equal(v.truncated?.roles, 30);
  assert.equal(v.truncated?.tools, 11);
  assert.equal(v.truncated?.services, 10);
  assert.equal(v.truncated?.receipts, 7);
  assert.ok(!JSON.stringify(v).includes(secret), 'секрет замаскирован');
  assert.equal(v.toolchain.tools[0]!.version, '~/.nvm/versions/node/v24/bin');
  assert.ok(v.roles.every((r) => (r.model?.length ?? 0) <= RESOURCES_LIMITS.text.model));
  assert.ok(v.lines.length <= RESOURCES_LIMITS.lines);
});
