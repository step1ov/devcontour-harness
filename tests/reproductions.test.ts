/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Сценарий fixture runtime — сырой JSON.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { Engine } from '../src/engine/engine.ts';
import { Runner } from '../src/engine/runner.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { approve, bin, implement, runAll, setup } from './runner-fixture.ts';

const MARKER = 'REPRODUCTION-INPUT-74299';
const finding = (message: string, reproduction: unknown) => ({
  severity: 'blocking',
  message,
  path: null,
  line: null,
  rule: 'acceptance',
  consequence: null,
  evidence: null,
  reproduction,
});
const rejecting = (secret: string) => ({
  result: {
    ...approve().result,
    approved: false,
    summary: 'Ломается на пустом запросе',
    findings: [
      finding('Пустой запрос падает', {
        property: 'catalog-search',
        input: `{"q":"${MARKER}"}`,
        expected: '{"items":[]}',
        actual: 'TypeError',
        command: ['node', 'check.js', '--token=' + secret],
        executed: false,
        run: null,
      }),
      finding('Юникод может ломать', {
        property: 'catalog-search',
        input: `{"q":"é ${secret}"}`,
        expected: null,
        actual: null,
        command: null,
        executed: true,
        run: 'run-that-controller-never-saw',
      }),
      finding('Неясное имя', null),
    ],
  },
});

test('S2-R2-05/T28: воспроизведения ревью — реестр поручения без дублей, гипотезы не наблюдены, замаскированы; следующая попытка получает входы, и после перезапуска', async () => {
  const secret = 'repro-secret-5c1e';
  process.env.HARNESS_REPRO_SECRET = secret;
  try {
    const ctx = setup({
      scenario: {
        writer: { ...implement(), recordPrompt: true },
        reviewer: rejecting(secret),
      },
      policy: (p: any) => {
        p.environment.secrets = { TOKEN: 'HARNESS_REPRO_SECRET' };
        p.maxAttempts = 3;
      },
    });
    const graph = await runAll(ctx);
    void graph;
    const first = ctx.engine.read((v) => v.attempts('add-greeting'));
    assert.equal(first.length, 1);
    assert.equal(first[0]!.failureKind, 'review');
    let registry = ctx.engine.reproductions('add-greeting');
    assert.equal(registry.length, 2, 'находка без входа в реестр не попадает');
    const empty = registry.find((r) => r.input.includes(MARKER))!;
    assert.equal(empty.observed, false);
    assert.equal(empty.claimed, false);
    assert.deepEqual(empty.command, ['node', 'check.js', '--token=[REDACTED]']);
    const unicode = registry.find((r) => !r.input.includes(MARKER))!;
    assert.equal(unicode.claimed, true, 'reviewer сообщил о запуске');
    assert.equal(unicode.observed, false, 'журнал controller запуска не видел — гипотеза');
    assert.equal(unicode.run, null);
    assert.ok(!JSON.stringify(registry).includes(secret), 'реестр замаскирован');
    ctx.runner.release();
    ctx.store.close();

    // Перезапуск: новый процесс, то же состояние; повтор поручения.
    const store = new SqliteExecutionStore(join(ctx.state, 'state.sqlite'), 'restart');
    const engine = new Engine({ host: standaloneHost(store, ctx.policy), policy: ctx.policy });
    const runner = new Runner({
      engine,
      stateDir: ctx.state,
      baseDir: ctx.repo.dir,
      adapters: {
        claude: cliAdapter('claude', { executable: bin('fake-claude') }),
        codex: cliAdapter('codex', { executable: bin('fake-codex') }),
      },
      owner: 'restart',
      resourceDatabase: join(ctx.state, 'resources.sqlite'),
    });
    engine.retry('add-greeting');
    engine.resume();
    await runner.drain();
    const attempts = engine.read((v) => v.attempts('add-greeting'));
    assert.equal(attempts.length, 2);
    // Следующий исполнитель видит входы, на которых поручение ломалось.
    const firstPrompt = readFileSync(`${ctx.scenarioPath}.writer.0.prompt`, 'utf8');
    const secondPrompt = readFileSync(`${ctx.scenarioPath}.writer.1.prompt`, 'utf8');
    assert.doesNotMatch(firstPrompt, /Reproductions recorded/);
    assert.match(secondPrompt, /Reproductions recorded/);
    assert.ok(secondPrompt.includes(MARKER), 'вход воспроизведения в запросе следующей попытки');
    assert.ok(!secondPrompt.includes(secret));
    // Тот же вход второго отклонения — та же запись, ещё один прогон.
    registry = engine.reproductions('add-greeting');
    assert.equal(registry.length, 2);
    assert.deepEqual(
      registry.find((r) => r.input.includes(MARKER))!.runs.map((r) => r.runId),
      attempts.map((a) => a.id),
    );
    store.close();
  } finally {
    delete process.env.HARNESS_REPRO_SECRET;
  }
});

test('S2-R2-05: подтверждение запуском не отменяется последующей гипотезой; реестр ограничен, вытесняются старые записи', () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  const { graph } = ctx.engine.register(ctx.graph, { trusted: () => false, reachable: () => true });
  void graph;
  ctx.store.close();
  const store = new SqliteExecutionStore(join(ctx.state, 'state.sqlite'), 'unit');
  const engine = new Engine({ host: standaloneHost(store, ctx.policy), policy: ctx.policy });
  const reviewRound = engine.reviewerBinding('plan', 'claude')!;
  engine.recordReview({
    id: 'RV-1',
    kind: 'plan',
    subject: ctx.graph.id,
    digest: engine.read((v) => v.graph(ctx.graph.id)!.digest),
    round: 1,
    at: '2026-01-01T00:00:00.000Z',
    approved: true,
    summary: 'ok',
    authorRuntime: 'claude',
    reviewerRuntime: 'codex',
    sameVendor: false,
    reviewerBinding: reviewRound,
    findings: [],
    artifact: 'r.json',
  });
  engine.approve(ctx.graph.id, 'agent');
  engine.lead('c1');
  engine.resume();
  const a = engine.claim('c1')!;
  const item = (input: string, observed: boolean) => ({
    property: 'p',
    input,
    expected: null,
    actual: null,
    command: observed ? ['ran'] : ['claimed'],
    message: 'm',
    claimed: true,
    observed,
    run: observed ? 'run-1' : null,
  });
  engine.recordReproductions(a.id, a.token, 'a'.repeat(40), [item('x', true)]);
  engine.recordReproductions(a.id, a.token, 'b'.repeat(40), [item('x', false)]);
  const kept = engine.reproductions('add-greeting')[0]!;
  assert.equal(kept.observed, true);
  assert.deepEqual(kept.command, ['ran']);
  assert.equal(kept.run, 'run-1');
  engine.recordReproductions(
    a.id,
    a.token,
    'c'.repeat(40),
    Array.from({ length: 510 }, (_, i) => item('input-' + i, false)),
  );
  const all = engine.reproductions('add-greeting');
  assert.equal(all.length, 500);
  assert.equal(all.at(-1)!.input, 'input-509');
  assert.ok(!all.some((r) => r.input === 'x'), 'старейшие вытеснены');
  // Старый токен не пишет.
  engine.fail(a.id, a.token, 'x', { kind: 'stale-base' });
  assert.throws(() =>
    engine.recordReproductions(a.id, a.token, 'd'.repeat(40), [item('y', false)]),
  );
  store.close();
});
