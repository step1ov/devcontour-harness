/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тесты правят сырой JSON политики и графа до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_VERSION,
  WORKSPACE_OWNER,
  HarnessError,
  sha256,
  sourceDigest,
  type ContextSnapshot,
  type ErrorCode,
  type ExecutionPolicy,
  type RuntimeAdapter,
  type RuntimeName,
  type RuntimeRequest,
} from '../src/contracts/index.ts';
import { Harness } from '../src/control/harness.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { callRecords } from '../src/engine/usage.ts';
import { graphOf, policyOf, ready } from './engine-fixture.ts';

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};

/**
 * Управляемый reviewer: каждый вызов записывается и сообщает стоимость `usd`.
 * Это проверка механики harness, не качества модели.
 */
function reviewers(usd = 2) {
  const requests: RuntimeRequest[] = [];
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: (request) => {
      requests.push(request);
      return Promise.resolve({
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'controlled',
        output: { approved: true, summary: 'ok', findings: [], previous: [] },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: usd,
          complete: true,
          source: 'claude-result',
        },
        diagnostics: { exitCode: 0 },
      });
    },
  });
  return { requests, adapters: { codex: adapter('codex'), claude: adapter('claude') } };
}
const open = (
  policy: ExecutionPolicy,
  adapters: Partial<Record<RuntimeName, RuntimeAdapter>>,
  stateDir = mkdtempSync(join(tmpdir(), 'harness-plan-review-')),
) => ({ h: Harness.open({ policy, stateDir, baseDir: process.cwd(), adapters }), stateDir });

const snapshot = (text: string, id = 'norms'): ContextSnapshot => {
  const entry = {
    id,
    kind: 'files',
    version: '1',
    required: true,
    files: [
      {
        path: 'norms.md',
        digest: sha256(text),
        bytes: Buffer.byteLength(text),
        content: { encoding: 'utf8' as const, data: text },
      },
    ],
    references: [],
  };
  return {
    apiVersion: API_VERSION,
    sources: [{ ...entry, digest: sourceDigest(entry) }],
    missing: [],
  };
};
const needsNorms = () => {
  const graph = graphOf({ a: [] });
  graph.orders[0]!.context = ['norms'];
  return graph;
};

test('S2-R1-04/S2.4: reviewer плана получает закреплённый контекст; без снимка и с испорченным снимком — отказ до вызова; другой снимок — новый раунд (оба вендора)', async () => {
  for (const [author, reviewer] of [
    ['claude', 'codex'],
    ['codex', 'claude'],
  ] as const) {
    const { requests, adapters } = reviewers(0);
    const policy = policyOf((p: any) => {
      for (const k of ['plan', 'contract', 'code'])
        p.review[k] = { reviewer: { runtime: reviewer } };
    });
    const { h } = open(policy, adapters);
    const graph = needsNorms();
    await assert.rejects(h.review({ kind: 'plan', graph, author }), refused('NOT_READY'));
    const broken = snapshot('PINNED-CONTEXT-S2-7b6');
    broken.sources[0]!.files[0]!.digest = sha256('другое');
    await assert.rejects(
      h.review({ kind: 'plan', graph, context: broken, author }),
      refused('INVALID_INPUT'),
    );
    const other = snapshot('x', 'other');
    await assert.rejects(
      h.review({ kind: 'plan', graph, context: other, author }),
      refused('NOT_READY'),
    );
    assert.equal(requests.length, 0, 'отказы — до вызова reviewer');

    const first = await h.review({
      kind: 'plan',
      graph,
      context: snapshot('PINNED-CONTEXT-S2-7b6'),
      author,
    });
    assert.equal(first.reviewerRuntime, reviewer);
    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert.match(
      request.prompt,
      /PINNED-CONTEXT-S2-7b6/,
      'текст закреплённого контекста в запросе',
    );
    assert.match(request.prompt, new RegExp(first.contextDigest!), 'идентичность снимка в запросе');
    assert.deepEqual(request.session, { kind: 'fresh' });
    assert.deepEqual(request.sandbox.writable, []);
    // Тот же граф и снимок — прежний раунд без вызова.
    await h.review({ kind: 'plan', graph, context: snapshot('PINNED-CONTEXT-S2-7b6'), author });
    assert.equal(requests.length, 1);
    // Тот же граф, другой снимок — новый раунд, прежнее одобрение не возвращается.
    const second = await h.review({
      kind: 'plan',
      graph,
      context: snapshot('ИЗМЕНЁННЫЕ НОРМЫ'),
      author,
    });
    assert.equal(second.round, 2);
    assert.equal(requests.length, 2);
    assert.notEqual(second.contextDigest, first.contextDigest);
    assert.match(requests[1]!.prompt, /ИЗМЕНЁННЫЕ НОРМЫ/);
    h.close();
  }
});

test('S2-R1-04: run с другим снимком контекста при неизменном графе проводит новый раунд ревью плана', async () => {
  const { requests, adapters } = reviewers(0);
  const { h } = open(policyOf(), adapters);
  const graph = needsNorms();
  // Только регистрация и согласование: очередь не ведётся без репозитория,
  // поэтому runner останавливается до выдачи — проверяется ревью плана.
  await h.run({ graph, context: snapshot('нормы v1'), author: 'claude' }).catch(() => undefined);
  const before = requests.filter((r) => r.task === 'review-plan').length;
  assert.equal(before, 1);
  await h.run({ graph, context: snapshot('нормы v2'), author: 'claude' }).catch(() => undefined);
  const plans = requests.filter((r) => r.task === 'review-plan');
  assert.equal(plans.length, 2, 'другой контекст — новый раунд');
  assert.match(plans[1]!.prompt, /нормы v2/);
  h.close();
});

test('S2-R1-02/T25: ревью ещё не зарегистрированного плана закрепляет расход за графом и поручениями; повтор после исчерпания — отказ до вызова, и после перезапуска', async () => {
  const { requests, adapters } = reviewers(2);
  const policy = policyOf((p: any) => (p.budgets = { group: { usd: 1 }, work: { usd: 1 } }));
  const { h, stateDir } = open(policy, adapters);
  const graph = graphOf({ a: [] });
  await h.review({ kind: 'plan', graph, author: 'claude' });
  const record = h.engine.read((v) => callRecords(v))[0]!;
  assert.equal(record.groupId, 'g');
  assert.deepEqual(record.workIds, ['a']);
  assert.equal(
    h.engine.read((v) => v.graphs().length),
    0,
    'граф не регистрировался',
  );
  const changed = structuredClone(graph);
  changed.orders[0]!.title = 'Изменённый план';
  await assert.rejects(
    h.review({ kind: 'plan', graph: changed, author: 'claude' }),
    refused('BUDGET_EXHAUSTED'),
  );
  // Изменённый состав (другое поручение) — группа уже исчерпана.
  await assert.rejects(
    h.review({ kind: 'plan', graph: graphOf({ b: [] }), author: 'claude' }),
    refused('BUDGET_EXHAUSTED'),
  );
  assert.equal(requests.length, 1, 'запрещённые вызовы до reviewer');
  h.close();
  const again = open(policy, adapters, stateDir).h;
  await assert.rejects(
    again.review({ kind: 'plan', graph: changed, author: 'claude' }),
    refused('BUDGET_EXHAUSTED'),
  );
  assert.equal(requests.length, 1);
  again.close();
});

test('S2-R1-01/T27: процесс, чью политику сменили на более строгий бюджет, не начинает новых вызовов reviewer', async () => {
  const { requests, adapters } = reviewers(2);
  const loose = policyOf((p: any) => (p.budgets = { total: { usd: 10 } }));
  const { h } = open(loose, adapters);
  h.engine.lead('old');
  h.engine.release('old');
  await h.review({ kind: 'plan', graph: graphOf({ a: [] }), author: 'claude' });
  const strict = policyOf((p: any) => (p.budgets = { total: { usd: 1 } }));
  const next = new Engine({ host: standaloneHost(h.store, strict), policy: strict });
  assert.equal(next.lead('new'), true, 'новая политика применена новым controller');
  assert.ok(h.engine.policyState().stale);
  const before = requests.length;
  const calls = h.engine.read((v) => callRecords(v).length);
  await assert.rejects(
    h.review({ kind: 'plan', graph: graphOf({ b: [] }, '1', 'g-new'), author: 'claude' }),
    refused('APPROVAL_STALE'),
  );
  assert.equal(requests.length, before, 'reviewer не вызывался');
  assert.equal(
    h.engine.read((v) => callRecords(v).length),
    calls,
    'запись вызова не создана',
  );
  assert.equal(h.engine.reviews('plan', 'g-new').length, 0, 'одобрения нет');
  await assert.rejects(
    h.review({
      kind: 'contract',
      contract: { apiVersion: API_VERSION, id: 'api', title: 'API', content: 'Контракт.' },
      author: 'claude',
    }),
    refused('APPROVAL_STALE'),
    'ревью контракта — тот же барьер',
  );
  assert.equal(requests.length, before);
  next.release('new');
  h.close();
});

/** Reviewer плана с решением на каждый вызов; `hold` — вызов ждёт снаружи. */
function decidingReviewer(decisions: (boolean | 'fail' | 'hold')[]) {
  const requests: RuntimeRequest[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: async (request) => {
      requests.push(request);
      const decision = decisions.shift() ?? true;
      if (decision === 'hold') await held;
      if (decision === 'fail')
        return {
          status: 'failed',
          text: '',
          model: null,
          diagnostics: { exitCode: 1 },
        } as unknown as Awaited<ReturnType<RuntimeAdapter['invoke']>>;
      return {
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'controlled',
        output: { approved: decision !== false, summary: 'решение', findings: [], previous: [] },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: 0,
          complete: true,
          source: 'claude-result',
        },
        diagnostics: { exitCode: 0 },
      };
    },
  });
  return { requests, release, adapters: { codex: adapter('codex'), claude: adapter('claude') } };
}

test('S2-R2-01/S2.4: снимок контекста действует только вместе с согласованием — отклонённый, упавший, ожидающий и операторский не исполняются, и после перезапуска', async () => {
  const graph = needsNorms();
  const a = snapshot('APPROVED-CONTEXT');
  const b = snapshot('REJECTED-CONTEXT-NEW');
  const { adapters, release } = decidingReviewer([true, false, 'fail', 'hold', true]);
  const { h, stateDir } = open(policyOf(), adapters);
  const effective = (x: Harness) =>
    (x as unknown as { contextOf(id: string): ContextSnapshot | undefined }).contextOf(graph.id);
  const claimed = (x: Harness) => {
    const issued = x.engine.claim('probe');
    if (issued) x.engine.cancel(issued.workId, 'проверка выдачи');
    return issued?.workId;
  };
  // Очередь на паузе человека: run регистрирует и согласует, но не исполняет.
  h.engine.pause('operator');
  await h.run({ graph, context: a, author: 'claude' });
  assert.equal(effective(h)?.sources[0]!.files[0]!.content!.data, 'APPROVED-CONTEXT');
  // Отклонённый новый снимок не становится действующим.
  await assert.rejects(h.run({ graph, context: b, author: 'claude' }), refused('REVIEW_REJECTED'));
  assert.equal(effective(h)?.sources[0]!.files[0]!.content!.data, 'APPROVED-CONTEXT');
  // Отказ runtime reviewer — тоже.
  await assert.rejects(h.run({ graph, context: b, author: 'claude' }));
  assert.equal(effective(h)?.sources[0]!.files[0]!.content!.data, 'APPROVED-CONTEXT');
  // Пока идёт ревью нового снимка, выдача видит прежний согласованный.
  h.engine.lead('probe');
  h.engine.resume();
  const pending = h.review({ kind: 'plan', graph, context: b, author: 'claude' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(claimed(h), 'a', 'выдача продолжается по прежнему основанию');
  assert.equal(effective(h)?.sources[0]!.files[0]!.content!.data, 'APPROVED-CONTEXT');
  release();
  const approvedB = await pending;
  assert.equal(approvedB.approved, true);
  // Одобренный раунд без согласования ещё не делает снимок действующим.
  assert.equal(effective(h)?.sources[0]!.files[0]!.content!.data, 'APPROVED-CONTEXT');
  h.engine.release('probe');
  h.close();
  // Перезапуск: действующий снимок прежний.
  const reopened = Harness.open({ policy: policyOf(), stateDir, baseDir: process.cwd(), adapters });
  assert.equal(effective(reopened)?.sources[0]!.files[0]!.content!.data, 'APPROVED-CONTEXT');
  // Законное согласование нового снимка делает его действующим.
  reopened.engine.approve(graph.id, 'agent', { bindContext: true });
  assert.equal(effective(reopened)?.sources[0]!.files[0]!.content!.data, 'REJECTED-CONTEXT-NEW');
  reopened.close();
});

test('S2-R2-01: в режиме operator новый снимок не действует до approve', async () => {
  const graph = needsNorms();
  const { adapters } = decidingReviewer([true, true]);
  const policy = policyOf((p: any) => (p.approvalMode = 'operator'));
  const { h } = open(policy, adapters);
  const effective = () =>
    (h as unknown as { contextOf(id: string): ContextSnapshot | undefined }).contextOf(graph.id)
      ?.sources[0]!.files[0]!.content!.data;
  h.engine.pause('operator');
  await assert.rejects(
    h.run({ graph, context: snapshot('v1'), author: 'claude' }),
    refused('APPROVAL_REQUIRED'),
  );
  await h.review({ kind: 'plan', graph, context: snapshot('v1'), author: 'claude' });
  const digest = h.engine.read((v) => v.graph(graph.id)!.digest);
  h.approve(graph.id, digest);
  assert.equal(effective(), 'v1');
  await assert.rejects(
    h.run({ graph, context: snapshot('v2'), author: 'claude' }),
    refused('APPROVAL_REQUIRED'),
  );
  assert.equal(effective(), 'v1', 'run не подменил действующий снимок');
  await h.review({ kind: 'plan', graph, context: snapshot('v2'), author: 'claude' });
  assert.equal(effective(), 'v1', 'одобренный раунд без approve оператора');
  h.approve(graph.id, digest);
  assert.equal(effective(), 'v2');
  h.close();
});

test('S2-R2-02/T25: ID графа, совпавший с ID поручения, не обходит бюджет остальных участников; и после перезапуска', async () => {
  const { requests, adapters } = reviewers(2);
  const policy = policyOf((p: any) => (p.budgets = { work: { usd: 1 } }));
  const { h, stateDir } = open(policy, adapters);
  // Ревью ещё не зарегистрированного графа g с поручением b исчерпывает бюджет b.
  await h.review({ kind: 'plan', graph: graphOf({ b: [] }), author: 'claude' });
  assert.deepEqual(h.engine.read((v) => callRecords(v))[0]!.workIds, ['b']);
  // Новая редакция того же графа содержит поручение с ID графа.
  const collided = graphOf({ g: [], b: [] }, '2');
  h.engine.register(collided, { trusted: () => false, reachable: () => true });
  await assert.rejects(
    h.review({ kind: 'plan', graph: collided, author: 'claude' }),
    refused('BUDGET_EXHAUSTED'),
    'ревью группы проверяет исчерпанного участника b',
  );
  assert.equal(requests.length, 1, 'второго вызова reviewer нет');
  h.close();
  const again = open(policy, adapters, stateDir).h;
  await assert.rejects(
    again.review({ kind: 'plan', graph: collided, author: 'claude' }),
    refused('BUDGET_EXHAUSTED'),
  );
  assert.equal(requests.length, 1);
  again.close();
});

test('S2-R2-02: вызов о группе засчитывается её участникам, а не поручению с тем же ID; контракт с ID поручения — не расход поручения', async () => {
  const { adapters } = reviewers(2);
  const policy = policyOf((p: any) => (p.budgets = { work: { usd: 3 }, total: { usd: 100 } }));
  const { h } = open(policy, adapters);
  const graph = graphOf({ g: [], b: [] });
  h.engine.register(graph, { trusted: () => false, reachable: () => true });
  await h.review({ kind: 'plan', graph, author: 'claude' });
  const plan = h.engine.read((v) => callRecords(v))[0]!;
  assert.equal(plan.subjectKind, 'group');
  assert.equal(plan.workId, undefined, 'вызов о графе не стал вызовом поручения g');
  assert.deepEqual([...plan.workIds!].sort(), ['b', 'g']);
  await h.review({
    kind: 'contract',
    contract: { apiVersion: API_VERSION, id: 'b', title: 'API', content: 'Контракт API целиком.' },
    author: 'claude',
  });
  const contract = h.engine.read((v) => callRecords(v)).find((r) => r.stage === 'contract-review')!;
  assert.equal(contract.subjectKind, 'other');
  assert.equal(contract.workId, undefined, 'контракт с ID поручения не тратит его бюджет');
  const work = h.engine
    .budgets()!
    .budgets.find((b) => b.scope.kind === 'work' && b.scope.id === 'b')!;
  assert.equal(work.reportedUsd, 2, 'у b только его доля ревью плана');
  h.close();
});

test('S2-R3-01/T25/T26: прежняя запись вызова о группе (группа закреплена, вида и состава нет) при совпавшем ID остаётся расходом всех участников — до закрепления, после, после перезапуска; закреплённый workId не меняется', async () => {
  const { requests, adapters } = reviewers(2);
  const policy = policyOf((p: any) => (p.budgets = { work: { usd: 1 } }));
  const { h, stateDir } = open(policy, adapters);
  const graph = graphOf({ g: [], b: [] });
  h.engine.register(graph, { trusted: () => false, reachable: () => true });
  await h.review({ kind: 'plan', graph, author: 'claude' });
  const spent = (engine: Engine, id: string) =>
    engine.budgets()!.budgets.find((b) => b.scope.kind === 'work' && b.scope.id === id)!
      .reportedUsd;
  const original = h.engine.read((v) => callRecords(v)[0]!);
  // Прежняя форма записи: группа закреплена при вызове, вида предмета и состава нет.
  const legacy = { ...original };
  delete legacy.subjectKind;
  delete legacy.workIds;
  // И прежняя запись вызова о поручении g с закреплённым workId — она остаётся за g.
  const workCall = { ...legacy, id: 'legacy-work-call', workId: 'g' };
  h.store.transact('usage.recorded', (tx) => {
    tx.putLocal('usage', WORKSPACE_OWNER, legacy.id, legacy);
    tx.putLocal('usage', WORKSPACE_OWNER, workCall.id, workCall);
  });
  assert.equal(spent(h.engine, 'b'), 2, 'до закрепления: расход группы у b');
  h.engine.pinLegacyCalls();
  const pinned = h.engine.read((v) => callRecords(v).find((r) => r.id === legacy.id)!);
  assert.equal(pinned.workId, undefined, 'вызов группы не стал вызовом поручения g');
  assert.deepEqual([...(pinned.workIds ?? [])].sort(), ['b', 'g'], 'дописан состав группы');
  assert.equal(
    h.engine.read((v) => callRecords(v).find((r) => r.id === workCall.id)!.workId),
    'g',
    'закреплённый workId прежнего вызова не меняется',
  );
  assert.equal(spent(h.engine, 'b'), 2, 'после закрепления');
  h.close();
  const again = open(policy, adapters, stateDir).h;
  assert.equal(spent(again.engine, 'b'), 2, 'после перезапуска');
  // Новая редакция графа с новым участником c: закреплённый состав не
  // меняется — расход остаётся за g и b, новый участник его не получает.
  const grown = graphOf({ g: [], b: [], c: [] }, '2');
  ready(again.engine, grown, 'controller');
  assert.equal(spent(again.engine, 'b'), 2, 'после смены состава');
  assert.equal(spent(again.engine, 'c'), 0, 'новый участник не получает прежний расход');
  assert.equal(
    again.engine.claim('controller')?.workId,
    'c',
    'исчерпанные участники g и b не выдаются; выдан только c',
  );
  assert.equal(requests.length, 1);
  again.close();
});

test('S3-R1-03: раунды хоста до harness — история первого раунда движка: прежние находки в запросе, нумерация продолжается, без выдуманного одобрения', async () => {
  const { technicalReview } = await import('../src/control/review.ts');
  const { findingId } = await import('../src/contracts/review.ts');
  const prompts: string[] = [];
  let output: unknown;
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: (request) => {
      prompts.push(request.prompt);
      return Promise.resolve({
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'controlled',
        output,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: 0,
          complete: true,
          source: 'claude-result',
        },
        diagnostics: { exitCode: 0 },
      });
    },
  });
  const adapters = { codex: adapter('codex'), claude: adapter('claude') };
  const policy = policyOf();
  const { h, stateDir } = open(policy, adapters);
  const legacy = { severity: 'blocking' as const, message: 'Legacy finding must survive' };
  const id = findingId('g', legacy);
  const round = (digestChar: string, history?: Parameters<typeof technicalReview>[3]['history']) =>
    technicalReview(h.engine, policy, adapters, {
      kind: 'plan',
      subject: 'g',
      digest: digestChar.repeat(64),
      author: 'claude',
      instructions: ['Review the plan.'],
      cwd: process.cwd(),
      artifactDir: join(stateDir, 'r-' + digestChar),
      denied: [stateDir],
      meta: { subjectId: 'g', subjectKind: 'other' },
      ...(history ? { history } : {}),
    });
  // Ответ без состояния прежней находки не одобряет предмет.
  output = { approved: true, summary: 'ok', findings: [], previous: [] };
  const silent = await round('a', { rounds: 2, findings: [legacy] });
  assert.equal(silent.round, 3, 'нумерация продолжает раунды хоста');
  assert.equal(silent.approved, false, 'прежняя находка без состояния — не одобрение');
  assert.match(prompts[0]!, /Legacy finding must survive/);
  assert.match(prompts[0]!, /round 3/);
  const carried = silent.findings.find((f) => f.id === id)!;
  assert.deepEqual(
    { status: carried.status, openedIn: carried.openedIn },
    { status: 'open', openedIn: 2 },
  );
  // Дальше история движка: находка остаётся, история хоста больше не учитывается.
  output = {
    approved: true,
    summary: 'ok',
    findings: [],
    previous: [{ id, status: 'closed', basis: 'Addressed in the plan' }],
  };
  const next = await round('b', { rounds: 9, findings: [] });
  assert.equal(next.round, 4);
  assert.equal(next.approved, true);
  assert.match(prompts[1]!, /Legacy finding must survive/);
  const closed = next.findings.find((f) => f.id === id)!;
  assert.deepEqual(
    { status: closed.status, openedIn: closed.openedIn, changedIn: closed.changedIn },
    { status: 'closed', openedIn: 2, changedIn: 4 },
  );
  assert.deepEqual(
    h.engine.reviews('plan', 'g').map((r) => r.round),
    [3, 4],
  );
  // Номер вне последовательности движок не записывает.
  assert.throws(
    () => h.engine.recordReview({ ...next, id: 'RV-plan-g-9', round: 9 }),
    refused('INVALID_INPUT'),
  );
  h.close();
});
