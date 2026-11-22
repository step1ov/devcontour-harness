import './temp-scope.ts';
/**
 * Превью результата (docs/previews.md): профиль `previews[]`, запуск в своём
 * рабочем дереве на свободном loopback-порту, список, остановка, срок,
 * простой, сверка пропавшего supervisor и отказ внутри попытки. Приложение —
 * крошечный node http-сервер во временном Git-репозитории; сеть — только loopback.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  cliCommands,
  cliDataSchemas,
  executionDigest,
  executionPolicySchema,
  isolationDigest,
  operatorViewSchema,
  policyDigest,
  previewStartDataSchema,
  stackProfileSchema,
  type PreviewDefinition,
} from '../src/contracts/index.ts';
import { repositoryFromProfile, resolveProfile } from '../src/profiles/resolve.ts';
import {
  listPreviews,
  readReceipt,
  startPreview,
  stopPreviews,
  type PreviewContext,
} from '../src/control/preview.ts';
import { processAlive } from '../src/environment/lifecycle.ts';
import { harnessView } from '../src/control/operator-view.ts';
import type { OperatorView } from '../src/projections/operator-view.ts';
import { clone, example } from './fixtures.ts';
import { repo } from './git-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const APP = `
import http from 'node:http';
const port = Number(process.env.PORT);
http
  .createServer((req, res) => {
    if (req.url === '/health') return res.end('ok');
    res.end('hello ' + (process.env.GREETING ?? '') + ' ' + (process.argv[2] ?? ''));
  })
  .listen(port, process.env.HOST);
`;

const preview = (extra: Partial<PreviewDefinition> = {}): PreviewDefinition => ({
  id: 'web',
  title: 'Сайт',
  start: [process.execPath, 'app.mjs', 'port={port}'],
  env: { GREETING: 'on-{port}' },
  health: '/health',
  readyTimeoutMs: 20_000,
  ...extra,
});

const contexts: PreviewContext[] = [];
after(async () => {
  for (const ctx of contexts) await stopPreviews(ctx).catch(() => undefined);
});

function project(extra: Partial<PreviewDefinition> = {}, repoExtra: Record<string, unknown> = {}) {
  const r = repo({ 'app.mjs': APP, 'README.md': 'app\n' });
  const raw = clone(example('policy')) as { repositories: Record<string, unknown>[] };
  raw.repositories[0] = {
    ...raw.repositories[0],
    path: r.dir,
    targetRef: 'refs/heads/main',
    previews: [preview(extra)],
    ...repoExtra,
  };
  const policy = executionPolicySchema.parse(raw);
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-preview-state-')));
  const ctx: PreviewContext = { policy, baseDir: r.dir, stateDir };
  contexts.push(ctx);
  return { r, ctx, policy, raw };
}

const text = async (url: string) => (await fetch(url)).text();
const until = async (check: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await delay(100)) if (check()) return;
  assert.fail('условие не наступило за ' + ms + ' мс');
};

test('profile previews[]: разбор, слои объединяются, повтор ID — конфликт, в политику переносится', () => {
  const r = repo({
    'base.json': JSON.stringify({
      id: 'base',
      version: '1.0.0',
      gates: [
        {
          id: 'unit',
          kind: 'test',
          command: ['node', 't.js'],
          report: { type: 'junit', path: 'r.xml' },
        },
      ],
      previews: [{ id: 'web', start: ['npm', 'run', 'start'], health: '/health' }],
    }),
    'leaf.json': JSON.stringify({
      id: 'leaf',
      version: '1.0.0',
      extends: ['./base.json'],
      previews: [{ id: 'docs', start: ['npm', 'run', 'docs'], services: true }],
    }),
    'dup.json': JSON.stringify({
      id: 'dup',
      version: '1.0.0',
      extends: ['./base.json'],
      previews: [{ id: 'web', start: ['x'] }],
    }),
  });
  const leaf = resolveProfile('./leaf.json', { repository: r.dir });
  assert.deepEqual(
    leaf.previews?.map((p) => p.id),
    ['web', 'docs'],
  );
  assert.throws(() => resolveProfile('./dup.json', { repository: r.dir }), /повтор ID превью/);
  const { repository } = repositoryFromProfile(leaf, {
    id: 'app',
    path: '.',
    targetRef: 'refs/heads/main',
  });
  assert.equal(repository.previews?.[1]?.services, true);
  // Без previews — поля нет: ни в профиле, ни в репозитории.
  const base = resolveProfile('./base.json', { repository: r.dir });
  assert.ok('previews' in base);
  const noPreview = resolveProfile('node-checks');
  assert.equal('previews' in noPreview, false);
  assert.equal(
    'previews' in
      repositoryFromProfile(noPreview, { id: 'app', path: '.', targetRef: 'refs/heads/main' })
        .repository,
    false,
  );
  // Схема: start обязателен, health — путь от корня, ID без повторов.
  assert.equal(
    stackProfileSchema.safeParse({ id: 'p', version: '1.0.0', previews: [{ id: 'w' }] }).success,
    false,
  );
  assert.equal(
    stackProfileSchema.safeParse({
      id: 'p',
      version: '1.0.0',
      previews: [{ id: 'w', start: ['x'], health: 'health' }],
    }).success,
    false,
  );
});

test('policy previews: без поля digest прежний; превью не входят в executionDigest и isolationDigest', () => {
  const raw = clone(example('policy')) as { repositories: Record<string, unknown>[] };
  const before = executionPolicySchema.parse(raw);
  assert.equal(policyDigest(before), policyDigest(executionPolicySchema.parse(clone(raw))));
  raw.repositories[0]!.previews = [preview()];
  const withPreviews = executionPolicySchema.parse(raw);
  assert.notEqual(policyDigest(withPreviews), policyDigest(before));
  assert.equal(executionDigest(withPreviews), executionDigest(before));
  assert.equal(isolationDigest(withPreviews), isolationDigest(before));
  raw.repositories[0]!.previews = [preview(), preview()];
  assert.equal(executionPolicySchema.safeParse(raw).success, false, 'повтор ID превью');
});

test('preview-start/list/stop: своё рабочее дерево, loopback-адрес, receipt; остановка убирает процесс и дерево', async () => {
  const { r, ctx } = project();
  const started = await startPreview(ctx, { ref: 'accepted', env: {} });
  previewStartDataSchema.parse(started);
  const p = started.preview;
  assert.equal(started.changed, true);
  assert.equal(p.state, 'running');
  assert.equal(p.sha, r.head());
  assert.match(p.url!, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.notEqual(p.port, p.appPort);
  assert.ok(p.worktree.startsWith(join(ctx.stateDir, 'previews', 'app', 'web')));
  assert.ok(existsSync(join(p.worktree, 'app.mjs')));
  // Порт — в PORT и подстановке {port} (start и env); адрес через прокси.
  assert.equal(await text(p.url!), `hello on-${p.appPort} port=${p.appPort}`);
  assert.ok(processAlive(p.pids.app!));
  assert.ok(Date.parse(p.expiresAt) > Date.parse(p.startedAt));

  // Повтор на том же коммите — то же превью.
  const again = await startPreview(ctx, { env: {} });
  assert.equal(again.changed, false);
  assert.equal(again.preview.pids.supervisor, p.pids.supervisor);

  const listed = await listPreviews(ctx);
  assert.deepEqual(
    listed.previews.map((x) => [x.id, x.state, x.url]),
    [['web', 'running', p.url]],
  );

  const stopped = await stopPreviews(ctx, { previewId: 'web' });
  assert.equal(stopped.changed, true);
  assert.equal(stopped.previews[0]!.state, 'stopped');
  assert.equal(stopped.previews[0]!.reason, 'operator');
  assert.equal(processAlive(p.pids.app!), false);
  assert.equal(processAlive(p.pids.supervisor), false);
  assert.equal(existsSync(p.worktree), false);
  assert.ok(!r.git('worktree', 'list').includes(p.worktree));
  await assert.rejects(fetch(p.url!));
  const repeat = await stopPreviews(ctx, { previewId: 'web' });
  assert.equal(repeat.changed, false);
  assert.equal(repeat.previews[0]!.state, 'stopped');
});

test('preview-start: другой коммит заменяет прежнее превью; --work берёт принятый SHA поручения', async () => {
  const { r, ctx } = project();
  const first = r.head();
  writeFileSync(join(r.dir, 'NEXT.md'), 'next\n');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'next');
  const one = await startPreview(ctx, { ref: first, env: {} });
  assert.equal(one.preview.sha, first);
  const work = (id: string) =>
    id === 'w1'
      ? { status: 'done', resultSha: r.head(), repositoryId: 'app' }
      : id === 'w2'
        ? { status: 'running', repositoryId: 'app' }
        : undefined;
  const two = await startPreview(ctx, { ref: 'accepted', workId: 'w1', work, env: {} });
  assert.equal(two.changed, true);
  assert.equal(two.preview.sha, r.head());
  assert.equal(two.preview.workId, 'w1');
  assert.equal(processAlive(one.preview.pids.app!), false, 'прежнее остановлено');
  await assert.rejects(startPreview(ctx, { workId: 'w2', work, env: {} }), {
    code: 'NOT_READY',
  });
  await assert.rejects(startPreview(ctx, { workId: 'nope', work, env: {} }), {
    code: 'NOT_FOUND',
  });
  await assert.rejects(startPreview(ctx, { ref: 'no-such-ref', env: {} }), { code: 'NOT_FOUND' });
  await stopPreviews(ctx);
});

test('preview: срок (TTL) и простой (idle) останавливают превью сами', async () => {
  const ttl = project();
  const a = await startPreview(ttl.ctx, { ttlMs: 2500, idleMs: 0, env: {} });
  assert.equal(a.preview.state, 'running');
  await until(() => readReceipt(a.preview.dir)?.state === 'stopped');
  const ra = readReceipt(a.preview.dir)!;
  assert.equal(ra.reason, 'ttl');
  assert.equal(existsSync(a.preview.worktree), false);
  assert.equal(processAlive(a.preview.pids.app!), false);

  const idle = project();
  const b = await startPreview(idle.ctx, { idleMs: 1500, env: {} });
  // Запросы держат превью живым дольше простоя.
  for (let i = 0; i < 4; i++) {
    await text(b.preview.url!);
    await delay(600);
  }
  assert.equal(readReceipt(b.preview.dir)?.state, 'running');
  await until(() => readReceipt(b.preview.dir)?.state === 'stopped');
  const rb = readReceipt(b.preview.dir)!;
  assert.equal(rb.reason, 'idle');
  assert.ok(Date.parse(rb.lastActivity!) > Date.parse(b.preview.lastActivity!));
  assert.equal(existsSync(b.preview.worktree), false);
});

test('preview: services — lifecycle setup/ready до запуска и teardown после остановки', async () => {
  const marks = realpathSync(mkdtempSync(join(tmpdir(), 'harness-preview-marks-')));
  const step = (id: string) => ({
    id,
    command: [
      process.execPath,
      '-e',
      `require('fs').appendFileSync(${JSON.stringify(join(marks, 'log'))}, '${id}\\n')`,
    ],
  });
  const { ctx } = project(
    { services: true },
    { lifecycle: { setup: [step('setup')], ready: [step('ready')], teardown: [step('teardown')] } },
  );
  const s = await startPreview(ctx, { env: {} });
  assert.equal(s.preview.services, true);
  assert.equal(readFileSync(join(marks, 'log'), 'utf8'), 'setup\nready\n');
  await stopPreviews(ctx);
  assert.equal(readFileSync(join(marks, 'log'), 'utf8'), 'setup\nready\nteardown\n');
});

test('preview-list: пропавший supervisor — приложение остановлено по receipt, дерево убрано, failed', async () => {
  const { ctx } = project();
  const s = await startPreview(ctx, { env: {} });
  process.kill(s.preview.pids.supervisor, 'SIGKILL');
  await until(() => !processAlive(s.preview.pids.supervisor));
  const listed = await listPreviews(ctx);
  const r = listed.previews[0]!;
  assert.equal(r.state, 'failed');
  assert.equal(r.reason, 'supervisor-gone');
  assert.equal(processAlive(s.preview.pids.app!), false);
  assert.equal(existsSync(s.preview.worktree), false);
});

test('preview-start: приложение не поднялось — LIFECYCLE_FAILED, дерево убрано', async () => {
  const { ctx } = project({ start: [process.execPath, '-e', 'process.exit(7)'] });
  await assert.rejects(startPreview(ctx, { env: {} }), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'LIFECYCLE_FAILED');
    assert.match(error.message, /start/);
    return true;
  });
  const r = readReceipt(join(ctx.stateDir, 'previews', 'app', 'web'))!;
  assert.equal(r.state, 'failed');
  assert.equal(r.reason, 'start');
  assert.equal(existsSync(r.worktree), false);
});

test('preview-start: внутри попытки и gate — отказ NOT_READY (библиотека и CLI)', async () => {
  const { ctx, raw } = project();
  for (const marker of ['DEVCONTOUR_RUN_ID', 'HARNESS_RUN_ID', 'DEVCONTOUR_PHASE', 'HARNESS_PHASE'])
    await assert.rejects(startPreview(ctx, { env: { [marker]: 'r1' } }), { code: 'NOT_READY' });
  const policyPath = join(ctx.stateDir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(raw));
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      cli,
      'preview-start',
      '--state',
      ctx.stateDir,
      '--policy',
      policyPath,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        DEVCONTOUR_RUN_ID: 'r1',
        DEVCONTOUR_PHASE: 'integration',
      },
    },
  );
  assert.equal(r.status, 3, r.stderr);
  const json = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
  assert.equal(json.error.code, 'NOT_READY');
  assert.equal(existsSync(join(ctx.stateDir, 'previews')), false, 'ничего не создано');
});

test('CLI preview-start/list/stop: договор, конверт и данные по схеме', async () => {
  for (const c of ['preview-start', 'preview-stop', 'preview-list'] as const) {
    assert.ok(c in cliCommands && c in cliDataSchemas, c);
    assert.equal(cliCommands[c].writes, true);
  }
  const { ctx, raw } = project();
  const policyPath = join(ctx.stateDir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(raw));
  const harness = (...args: string[]) => {
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        cli,
        ...args,
        '--state',
        ctx.stateDir,
        '--policy',
        policyPath,
      ],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
    );
    return {
      status: r.status,
      stderr: r.stderr,
      json: JSON.parse(r.stdout) as { ok: boolean; data: unknown },
    };
  };
  const start = harness(
    'preview-start',
    '--preview',
    'web',
    '--ref',
    'accepted',
    '--ttl',
    '600',
    '--idle',
    '0',
  );
  assert.equal(start.status, 0, start.stderr);
  const data = cliDataSchemas['preview-start'].parse(start.json.data);
  assert.equal(data.preview.idleMs, 0);
  assert.equal(data.preview.ttlMs, 600_000);
  assert.equal(
    await text(data.preview.url!),
    `hello on-${data.preview.appPort} port=${data.preview.appPort}`,
  );
  const list = harness('preview-list');
  assert.equal(list.status, 0, list.stderr);
  assert.equal(cliDataSchemas['preview-list'].parse(list.json.data).previews[0]!.state, 'running');
  const stop = harness('preview-stop');
  assert.equal(stop.status, 0, stop.stderr);
  const stopped = cliDataSchemas['preview-stop'].parse(stop.json.data);
  assert.equal(stopped.previews[0]!.state, 'stopped');
  assert.equal(existsSync(data.preview.worktree), false);
  const bad = harness('preview-start', '--ttl', '0');
  assert.equal(bad.status, 2);
  const unknown = harness('preview-start', '--preview', 'nope');
  assert.equal(unknown.status, 3);
});

test('view: живые превью — поле previews с адресом и сроком; нет живых — поля нет', async () => {
  const { ctx, raw } = project();
  const policyPath = join(ctx.stateDir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(raw));
  const view = () => harnessView({ stateDir: ctx.stateDir, policyPath }) as OperatorView;
  const empty = view();
  assert.equal('previews' in empty, false);
  const s = await startPreview(ctx, { env: {} });
  const live = view();
  operatorViewSchema.parse(live);
  assert.deepEqual(live.previews, [
    {
      id: 'web',
      repositoryId: 'app',
      title: 'Сайт',
      url: s.preview.url,
      ref: 'accepted',
      sha: s.preview.sha,
      startedAt: s.preview.startedAt,
      expiresAt: s.preview.expiresAt,
      state: 'running',
    },
  ]);
  assert.notEqual(live.source.token, empty.source.token, 'токен содержимого видит превью');
  await stopPreviews(ctx);
  assert.equal('previews' in view(), false);
});
