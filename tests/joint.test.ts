/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тесты правят сырой JSON политики и графа до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  HarnessError,
  sha256,
  workGraphSchema,
  type ErrorCode,
  type ExecutionPolicy,
  type JointVerificationState,
} from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { JointRunner } from '../src/engine/joint-runner.ts';
import { Harness } from '../src/control/harness.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { isolationSupport } from '../src/environment/isolation.ts';
import { jointImpact } from '../src/verification/joint.ts';
import { components, node } from './components-fixture.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';

const refused = (code: ErrorCode, message?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  if (message) assert.match(e.message, message);
  return true;
};

const workspaceGate = (id: string, repositoryId: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'test',
  repositoryId,
  command: ['node', 'combo.js'],
  report: { type: 'junit', path: `reports/${id}.xml` },
  ...extra,
});

/** Пометить поручения принятыми (их приёмку проверяют другие тесты). */
function accept(engine: Engine, ids: Record<string, string>) {
  engine.host.store.transact('task.done', (tx) => {
    for (const [id, resultSha] of Object.entries(ids))
      tx.putWork({ ...tx.work(id)!, status: 'done', resultSha });
  });
}

const manifestOf = (policy: ExecutionPolicy, c = 'a') =>
  Object.fromEntries(policy.repositories.map((r) => [r.id, { sha: sha(c), tree: sha('f') }]));

test('T24: fencing совместной проверки — выдача стоит; manifest всех репозиториев; без PASS не принять; истёкшая, сменённая политика и сменённое основание отклоняются', () => {
  const noGates = engineOf();
  ready(noGates.engine, graphOf({ a: [] }));
  accept(noGates.engine, { a: sha('1') });
  assert.throws(
    () => noGates.engine.jointStart({ workIds: ['a'] }),
    refused('INVALID_INPUT', /workspaceGates/),
  );

  const policy = policyOf((p: any) => {
    p.workspaceGates = [workspaceGate('combo', 'app')];
    p.maxAttempts = 3;
  });
  const { engine, clock, dir } = engineOf(policy);
  ready(engine, graphOf({ a: [], b: [], c: [] }));
  const live = engine.claim('c1')!;
  assert.throws(() => engine.jointStart({ workIds: ['a'] }), refused('NOT_READY', /попыток/));
  engine.fail(live.id, live.token, 'stop', { kind: 'gate' });
  assert.throws(() => engine.jointStart({ workIds: ['a'] }), refused('NOT_READY', /завершите/));
  accept(engine, { a: sha('1'), b: sha('2') });
  const v = engine.jointStart({ workIds: ['a', 'b'] });
  assert.equal(
    engine.read((x) => x.work('c')!.status),
    'ready',
  );
  assert.equal(engine.claim('c1'), undefined, 'идущая совместная проверка держит выдачу');
  assert.ok(
    engine
      .read((x) => engine.blockers(x.work('c')!, x))
      .some((b) => /совместная проверка/.test(b.message)),
  );
  assert.throws(
    () => engine.jointStart({ workIds: ['a'] }),
    refused('NOT_READY', /уже выполняется/),
  );
  assert.throws(
    () => engine.jointManifest(v.id, v.token, { other: { sha: sha('a'), tree: sha('b') } }),
    refused('INVALID_INPUT', /каждого репозитория/),
  );
  engine.jointManifest(v.id, v.token, manifestOf(policy));
  assert.throws(() => engine.jointFinish(v.id, v.token), refused('GATE_FAILED', /combo/));
  // Истёкшая проверка закрывается следующей; её токен больше ничего не пишет.
  clock.now += policy.leaseMs + 1;
  const retry = engine.jointStart({ workIds: ['b', 'a'] });
  assert.equal(
    engine.read((x) => x.verification(v.id)!.status),
    'failed',
  );
  assert.throws(() => engine.jointFinish(v.id, v.token), refused('LEASE_STALE'));
  // Сменилась политика совместной проверки — другой процесс не продлевает.
  const changed = policyOf((p: any) => {
    p.workspaceGates = [workspaceGate('combo', 'app', { command: ['changed-test'] })];
    p.maxAttempts = 3;
  });
  const other = new Engine({
    host: standaloneHost(new SqliteExecutionStore(join(dir, 'state.sqlite'), 't'), changed),
    policy: changed,
    now: () => clock.now,
  });
  assert.throws(() => other.jointHeartbeat(retry.id, retry.token), refused('APPROVAL_STALE'));
  // Сменился результат поручения набора — проверка устарела.
  accept(engine, { b: sha('3') });
  assert.throws(
    () => engine.jointHeartbeat(retry.id, retry.token),
    refused('APPROVAL_STALE', /Состав/),
  );
  assert.equal(engine.jointFail(retry.id, retry.token, 'основание сменилось'), true);
  const third = engine.jointStart({ workIds: ['a', 'b'] });
  engine.jointFail(third.id, third.token, 'x');
  assert.throws(
    () => engine.jointStart({ workIds: ['a', 'b'] }),
    refused('ATTEMPTS_EXHAUSTED'),
    'предел проверок набора',
  );
  assert.deepEqual(engine.jointResult(['a', 'b']).current, false);
  engine.lead('c1');
  assert.equal(engine.claim('c1')?.workId, 'c', 'без живой проверки выдача идёт');
  // Пока операция применяет политику, совместная проверка не начинается.
  engine.requestReconfigure('op-1', '9'.repeat(64));
  assert.throws(() => engine.jointStart({ workIds: ['a'] }), refused('NOT_READY', /op-1/));
});

test('T24: область affected — изменённые компоненты, их потребители и prerequisites; без базы — все', () => {
  const policy = policyOf((p: any) => {
    const base = p.repositories[0];
    p.repositories = [
      { ...base, id: 'lib', path: 'lib', kind: 'library' },
      { ...base, id: 'app', path: 'app', dependsOn: ['lib'] },
      { ...base, id: 'docs', path: 'docs', kind: 'library' },
    ];
    p.verificationMode = 'affected';
    p.workspaceGates = [
      workspaceGate('lib-unit', 'lib'),
      workspaceGate('app-e2e', 'app', { dependsOn: ['docs-build'] }),
      workspaceGate('docs-build', 'docs', { kind: 'check', report: undefined }),
    ];
  });
  const manifest = {
    lib: { sha: sha('1'), tree: sha('f') },
    app: { sha: sha('2'), tree: sha('f') },
    docs: { sha: sha('3'), tree: sha('f') },
  };
  assert.equal(jointImpact(policy, manifest, 'p').mode, 'all');
  const baseline = {
    status: 'passed',
    id: 'JV-0',
    policyDigest: 'p',
    manifest: { ...manifest, lib: { sha: sha('0'), tree: sha('f') } },
  } as unknown as JointVerificationState;
  const impact = jointImpact(policy, manifest, 'p', baseline);
  assert.equal(impact.mode, 'affected');
  assert.deepEqual(impact.changed, ['lib']);
  assert.deepEqual(impact.affected.sort(), ['app', 'lib']);
  assert.deepEqual(impact.gateIds, ['lib-unit', 'docs-build', 'app-e2e']);
  assert.equal(jointImpact(policy, manifest, 'other', baseline).mode, 'all', 'другая политика');
  assert.equal(
    jointImpact({ ...policy, verificationMode: 'all' }, manifest, 'p', baseline).mode,
    'all',
  );
});

/** Проверка комбинации: значение библиотеки равно значению продукта. */
const combo = `const fs = require('fs');
const paths = JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON);
const lib = fs.readFileSync(paths.library + '/value.json', 'utf8').trim();
const own = fs.readFileSync('value.json', 'utf8').trim();
const ok = lib === own && fs.existsSync(process.env.DEVCONTOUR_MANIFEST_PATH);
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="combo"' + (ok ? '/>' : '><failure message="' + lib + ' vs ' + own + '"/></testcase>') + '</testsuite>');
process.exit(ok ? 0 : 1);
`;

function jointContour(gate: string = combo, patch: (p: any) => void = () => {}) {
  const ctx = components({
    policy: (p) => {
      for (const r of p.repositories) if (r.id !== 'product') r.kind = 'library';
      p.workspaceGates = [
        {
          id: 'combo',
          kind: 'test',
          repositoryId: 'product',
          command: node(gate),
          report: { type: 'junit', path: 'reports/combo.xml' },
          artifacts: ['value.json'],
        },
      ];
      patch(p);
    },
  });
  const joint = new JointRunner({
    engine: ctx.engine,
    stateDir: ctx.state,
    baseDir: ctx.state,
    resourceDatabase: join(ctx.state, 'resources.sqlite'),
  });
  return { ...ctx, joint };
}

test('T24: два репозитория — принятые поручения, комбинация падает; исправление проходит; смена SHA и основания делает результат неактуальным', async () => {
  const ctx = jointContour();
  await ctx.runner.init();
  ready(ctx.engine, ctx.graph, 'runner-1');
  await ctx.runner.drain();
  const lib = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(lib.status, 'done', lib.failure);
  // Библиотека 2, продукт ещё 1: комбинация не работает.
  const failed = await ctx.joint.verify([lib.id]);
  assert.equal(failed.status, 'failed');
  assert.match(failed.status === 'failed' ? failed.error : '', /combo/);
  assert.equal(Object.keys(failed.manifest ?? {}).length, 3, 'manifest всех репозиториев');
  assert.equal(failed.manifest!.library!.sha, ctx.ref('library'));
  assert.equal(ctx.engine.jointResult([lib.id]).current, false);
  assert.ok(existsSync(join(ctx.state, 'joint', failed.id, 'combo.log')), 'диагностика сохранена');
  assert.equal(ctx.worktrees('product'), 1, 'снимки компонентов убраны');
  // Поручение продукта выравнивает значение.
  const fix = workGraphSchema.parse({
    ...ctx.graph,
    id: 'product-fix',
    source: { connector: 'files', ref: 'product-fix', revision: '1' },
    orders: [
      {
        ...ctx.graph.orders[0],
        id: 'product-value',
        source: { connector: 'files', ref: 'product-value', revision: '1' },
        repositoryId: 'product',
        consumers: [],
      },
    ],
  });
  ready(ctx.engine, fix, 'runner-1');
  await ctx.runner.drain();
  assert.equal(
    ctx.engine.read((v) => v.work('product-value')!.status),
    'done',
  );
  const set = ['add-greeting', 'product-value'];
  const passed = await ctx.joint.verify(set);
  assert.equal(passed.status, 'passed', JSON.stringify(passed.evidence.map((e) => e.summary)));
  assert.equal(passed.evidence[0]!.artifacts[0]!.path, 'product/value.json');
  assert.equal(passed.evidence[0]!.artifacts[0]!.digest.length, 64);
  assert.equal(ctx.engine.jointResult(set).current, true);
  // Проверка набора без продукта — другой предмет: прежний отказ остаётся отказом.
  assert.equal(ctx.engine.jointResult(['add-greeting']).current, false);
  // Сдвиг target ref после проверки — наблюдение свежести, а не запрет.
  const h = Harness.open({
    stateDir: ctx.state,
    policy: ctx.policy,
    baseDir: ctx.state,
    adapters: {},
  });
  const fresh = await h.jointResult(set);
  assert.equal(fresh.current, true);
  assert.ok('freshness' in fresh && fresh.freshness.every((f) => f.fresh));
  const library = ctx.repos.library!;
  library.git('commit', '--allow-empty', '-qm', 'later');
  library.git('update-ref', ctx.policy.repositories[0]!.targetRef, 'HEAD');
  const moved = await h.jointResult(set);
  assert.ok(
    'freshness' in moved &&
      moved.freshness.some((f) => f.repositoryId === 'library' && !f.fresh && f.head !== f.sha),
    'manifest больше не совпадает с target ref библиотеки',
  );
  h.close();
  // Новая редакция поручения библиотеки — основание сменилось.
  ready(
    ctx.engine,
    workGraphSchema.parse({
      ...ctx.graph,
      source: { ...ctx.graph.source, revision: '2' },
      orders: [
        {
          ...ctx.graph.orders[0],
          goal: ctx.graph.orders[0]!.goal + ' (вторая редакция)',
          source: { ...ctx.graph.orders[0]!.source, revision: '2' },
        },
      ],
    }),
    'runner-1',
  );
  const stale = ctx.engine.jointResult(set);
  assert.equal(stale.current, false);
  assert.match(stale.reason ?? '', /изменились/);
});

test('T24: результат поручения, которого нет в target ref, не проверяется как комбинация', async () => {
  const ctx = jointContour();
  ready(ctx.engine, ctx.graph, 'runner-1');
  const lib = ctx.repos.library!;
  lib.git('checkout', '-q', '-b', 'side');
  lib.git('commit', '--allow-empty', '-qm', 'not integrated');
  const side = lib.git('rev-parse', 'HEAD');
  accept(ctx.engine, { 'add-greeting': side });
  const failed = await ctx.joint.verify(['add-greeting']);
  assert.equal(failed.status, 'failed');
  assert.match(failed.status === 'failed' ? failed.error : '', /отсутствует/);
  assert.equal(failed.manifest, undefined, 'manifest не закреплён');
});

test('T24: gate совместной проверки не может изменить manifest или исходники другого компонента', async () => {
  const modes = isolationSupport().ok ? (['none', 'os'] as const) : (['none'] as const);
  for (const mode of modes) {
    const writeManifest = `require('fs').writeFileSync(process.env.DEVCONTOUR_MANIFEST_PATH, '{}'); require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="x"/></testsuite>');`;
    const ctx = jointContour(writeManifest, (p) => (p.isolation = { mode, domains: [] }));
    ready(ctx.engine, ctx.graph, 'runner-1');
    accept(ctx.engine, { 'add-greeting': ctx.ref('library') });
    const first = await ctx.joint.verify(['add-greeting']);
    assert.equal(first.status, 'failed');
    if (mode === 'os') {
      const log = readFileSync(join(ctx.state, 'joint', first.id, 'combo.log'), 'utf8');
      assert.match(log, /EPERM|not permitted|exit=1/, 'запись в manifest отклонена ОС');
    } else assert.match(first.status === 'failed' ? first.error : '', /manifest/);
    const writeOther = `require('fs').writeFileSync(JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON).library + '/value.json', '99'); require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="x"/></testsuite>');`;
    const ctx2 = jointContour(writeOther, (p) => (p.isolation = { mode, domains: [] }));
    ready(ctx2.engine, ctx2.graph, 'runner-1');
    accept(ctx2.engine, { 'add-greeting': ctx2.ref('library') });
    const second = await ctx2.joint.verify(['add-greeting']);
    assert.equal(second.status, 'failed');
    if (mode === 'none')
      assert.match(second.status === 'failed' ? second.error : '', /исходники компонента library/);
    assert.equal(ctx2.engine.jointResult(['add-greeting']).current, false);
  }
});

test('T24/T30: секрет окружения маскируется в копии JUnit, логе, evidence и причине отказа', async () => {
  const secret = 'joint-secret-' + Math.random().toString(16).slice(2);
  process.env.HARNESS_TEST_JOINT_SECRET = secret;
  try {
    const leak = `const fs = require('fs'); const s = process.env.JOINT_TOKEN; console.log('token ' + s);
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="leak"><failure message="' + s + '"/></testcase></testsuite>');`;
    const ctx = jointContour(leak, (p) => {
      p.environment = {
        ...p.environment,
        secrets: { JOINT_TOKEN: 'HARNESS_TEST_JOINT_SECRET' },
      };
    });
    ready(ctx.engine, ctx.graph, 'runner-1');
    accept(ctx.engine, { 'add-greeting': ctx.ref('library') });
    const failed = await ctx.joint.verify(['add-greeting']);
    assert.equal(failed.status, 'failed');
    const dir = join(ctx.state, 'joint', failed.id);
    assert.ok(existsSync(join(dir, 'combo.xml')), 'копия отчёта сохранена');
    const texts = [
      JSON.stringify(failed),
      JSON.stringify(ctx.engine.read((v) => v.verification(failed.id))),
      ...readdirSync(dir)
        .filter((f) => f.endsWith('.log') || f.endsWith('.xml'))
        .map((f) => readFileSync(join(dir, f), 'utf8')),
    ];
    assert.ok(texts.join('').includes('[REDACTED]'), 'значение было и замаскировано');
    for (const text of texts) assert.ok(!text.includes(secret), 'секрет сохранён');
  } finally {
    delete process.env.HARNESS_TEST_JOINT_SECRET;
  }
});

test('T24: формулы хоста — digest политики и основания совместной проверки по хосту; их смена делает проверку устаревшей', () => {
  const policy = policyOf((p: any) => {
    p.workspaceGates = [workspaceGate('combo', 'app')];
    p.maxAttempts = 3;
  });
  const dir = engineOf(policy).dir;
  let hostPolicy = sha256('host-policy-1');
  let hostSpec = sha256('host-spec-1');
  const seen: (string | undefined)[] = [];
  const store = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  const host = standaloneHost(store, policy);
  const engine = new Engine({
    host: {
      ...host,
      basis: {
        ...host.basis,
        jointPolicyDigest: () => hostPolicy,
        jointSpecDigest: (_ids, _view, id) => (seen.push(id), hostSpec),
      },
    },
    policy,
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  });
  ready(engine, graphOf({ a: [] }));
  accept(engine, { a: sha('1') });
  const v = engine.jointStart({ workIds: ['a'] });
  assert.equal(v.policyDigest, sha256('host-policy-1'));
  assert.equal(v.specDigest, sha256('host-spec-1'));
  assert.equal(seen[0], undefined, 'при начале проверки её id ещё нет');
  engine.jointManifest(v.id, v.token, manifestOf(policy));
  assert.ok(seen.includes(v.id), 'при сверке хост получает id проверки');
  engine.jointEvidence(v.id, v.token, {
    gate: 'combo',
    command: ['node', 'combo.js'],
    passed: true,
    exitCode: 0,
    log: 'combo.log',
    digest: sha256('log'),
    summary: 'ok',
    artifacts: [],
    durationMs: 1,
  });
  hostSpec = sha256('host-spec-2');
  assert.throws(() => engine.jointFinish(v.id, v.token), refused('APPROVAL_STALE'));
  hostSpec = sha256('host-spec-1');
  engine.jointFinish(v.id, v.token);
  assert.equal(engine.jointResult(['a']).current, true);
  hostPolicy = sha256('host-policy-2');
  assert.match(engine.jointResult(['a']).reason ?? '', /Политика совместной проверки изменилась/);
  store.close();
});

test('T24: хост начинает проверку сам и передаёт её runner; каталог, окружение и подготовка хоста; продуктовое условие держит manifest', async () => {
  const markGate = `const fs = require('fs');
console.log('host mark=' + process.env.HOST_MARK);
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="combo"/></testsuite>');
`;
  const ctx = jointContour(markGate);
  await ctx.runner.init();
  ready(ctx.engine, ctx.graph, 'runner-1');
  await ctx.runner.drain();
  const set = ['add-greeting'];
  let refusal: { code: 'NOT_READY'; message: string } | null = null;
  const kinds: string[] = [];
  const manifests: boolean[] = [];
  const guards = ctx.engine.host.guards as unknown as Record<string, unknown>;
  guards.joint = (v: JointVerificationState, _view: unknown, kind: string) => {
    kinds.push(kind);
    // Условие видит состояние после записи: закреплённый manifest.
    if (kind === 'workspace.manifest') manifests.push(!!v.manifest);
    return refusal;
  };
  let prepared = 0;
  const runner = new JointRunner({
    engine: ctx.engine,
    stateDir: ctx.state,
    baseDir: ctx.state,
    resourceDatabase: join(ctx.state, 'resources.sqlite'),
    directory: (v) => join(ctx.state, 'host-checks', v.id),
    env: () => ({ HOST_MARK: 'cs-1' }),
    prepare: () => Promise.resolve(void prepared++),
  });
  // Продуктовое условие отказало — manifest не закрепляется, проверка не проходит.
  refusal = { code: 'NOT_READY', message: 'ChangeSet уже принят' };
  const held = await runner.run(ctx.engine.jointStart({ workIds: set }));
  assert.equal(held.status, 'failed');
  assert.match(held.status === 'failed' ? held.error : '', /ChangeSet уже принят/);
  assert.equal(held.manifest, undefined, 'manifest не закреплён: отказ откатил запись');
  assert.deepEqual(manifests, [true], 'условие проверило закрепляемый manifest');
  assert.ok(kinds.includes('workspace.manifest'));
  assert.ok(!kinds.includes('heartbeat'), 'продление срока условием не проверяется');
  refusal = null;
  const v = ctx.engine.jointStart({ workIds: set });
  const passed = await runner.run(v);
  assert.equal(passed.status, 'passed');
  assert.equal(prepared, 2, 'подготовка хоста перед каждой проверкой');
  const log = readFileSync(join(ctx.state, 'host-checks', v.id, 'combo.log'), 'utf8');
  assert.match(log, /host mark=cs-1/, 'окружение хоста передано gate');
  assert.ok(!existsSync(join(ctx.state, 'joint', v.id)), 'каталог хоста вместо умолчания');
  // Оценка указанной проверки, а не последней набора.
  assert.equal(ctx.engine.jointResult(set, held.id).current, false);
  assert.equal(ctx.engine.jointResult(set, v.id).current, true);
  assert.match(ctx.engine.jointResult(['other'], v.id).reason ?? '', /другому набору/);
});

test('S4-R1-02: совместную проверку, начатую движком другой версии, новая версия не продолжает её token', () => {
  const policy = policyOf((p: any) => {
    p.workspaceGates = [workspaceGate('combo', 'app')];
  });
  const { engine, clock, dir } = engineOf(policy);
  ready(engine, graphOf({ a: [] }));
  accept(engine, { a: sha('1') });
  const v = engine.jointStart({ workIds: ['a'] });
  assert.equal(
    engine.read((x) => x.verification(v.id)?.engineVersion),
    engine.version,
  );
  const newer = new Engine({
    host: standaloneHost(new SqliteExecutionStore(join(dir, 'state.sqlite'), 't'), policy),
    policy,
    now: () => clock.now,
    version: '9.9.9-newer',
  });
  assert.throws(() => newer.jointHeartbeat(v.id, v.token), refused('LEASE_STALE', /версии|движок/));
  assert.throws(
    () => newer.jointManifest(v.id, v.token, manifestOf(policy)),
    refused('LEASE_STALE'),
  );
  assert.equal(newer.jointFail(v.id, v.token, 'чужая версия'), false);
  assert.equal(
    engine.read((x) => x.verification(v.id)?.status),
    'active',
  );
  engine.jointHeartbeat(v.id, v.token);
});
