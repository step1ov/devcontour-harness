/* eslint-disable @typescript-eslint/no-explicit-any --
 * Тесты собирают сырые ответы reviewer до разбора схемой.
 */
/**
 * Круг раундов ревью плана и контракта (docs/review-protocol.md, §8):
 * переформулированная находка сохраняет ID и счёт раундов, решение ведущего
 * `accepted-limitation` видно следующему раунду, находка, открытая три раунда
 * подряд, — решение оператора без нового оплаченного раунда, «одобрено,
 * открытых заметок N» и расход ревью — в status, explain и отчёте. Reviewer —
 * управляемый адаптер по сценарию, не живая модель.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HarnessError,
  REVIEW_ESCALATION_ROUNDS,
  findingId,
  reviewResultSchema,
  reviewSubjectSummarySchema,
  statusDataSchema,
  type ErrorCode,
  type ReviewRecord,
  type RuntimeAdapter,
  type RuntimeName,
  type RuntimeRequest,
  type WorkGraph,
} from '../src/contracts/index.ts';
import { Harness } from '../src/control/harness.ts';
import { applyDispositions, mergeTechnicalRound } from '../src/control/review.ts';
import { statusText } from '../src/control/status.ts';
import { technicalReviewOutputSchema } from '../src/agents/schemas.ts';
import { valueReport } from '../src/report/compute.ts';
import { reportMarkdown } from '../src/report/markdown.ts';
import { graphOf, policyOf } from './engine-fixture.ts';

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};

/** Reviewer по сценарию: каждый вызов берёт следующий ответ и стоит `usd`. */
function scripted(outputs: unknown[], usd = 0.25) {
  const requests: RuntimeRequest[] = [];
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: (request) => {
      requests.push(request);
      const output = outputs.shift();
      assert.ok(output, 'сценарий reviewer исчерпан: лишний оплаченный вызов');
      return Promise.resolve({
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'scripted',
        output,
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

const finding = (message: string, extra: Record<string, unknown> = {}) => ({
  severity: 'blocking',
  message,
  path: 'orders[0].acceptance',
  line: null,
  rule: 'acceptance-measurable',
  consequence: null,
  evidence: null,
  reproduction: null,
  sameAs: null,
  ...extra,
});
const verdict = (approved: boolean, findings: unknown[], previous: unknown[] = []) => ({
  approved,
  summary: approved ? 'ok' : 'нет',
  discoveries: [],
  findings,
  previous,
});

const open = (outputs: unknown[]) => {
  const { requests, adapters } = scripted(outputs);
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-review-loop-'));
  const policy = policyOf();
  const h = Harness.open({ policy, stateDir, baseDir: process.cwd(), adapters });
  return { h, requests, stateDir, policy };
};

/** Ведущий правит план между раундами: новый digest того же графа. */
const revise = (graph: WorkGraph, n: number) => {
  const next = structuredClone(graph);
  next.orders[0]!.title = `Правка ${n}`;
  return next;
};

test('H14: reviewer переформулирует ту же находку — ID и счёт раундов сохраняются; на третьем раунде — решение оператора без оплаченного вызова; принятое ограничение не поднимается снова', async () => {
  const graph = graphOf({ a: [] });
  const id = findingId('g', { rule: 'acceptance-measurable', message: 'Критерий не измерим' });
  const { h, requests, policy } = open([
    // 1: находка.
    verdict(false, [finding('Критерий не измерим')]),
    // 2: прежний круг — старая «закрыта», та же проблема другими словами
    // (тот же путь и правило, без sameAs).
    verdict(
      false,
      [finding('Приёмка не проверяется командой')],
      [{ id, status: 'closed', basis: 'формулировка изменена' }],
    ),
    // 3: снова другими словами, теперь со ссылкой sameAs и без записи в previous.
    verdict(false, [finding('Нет измеримого критерия готовности', { sameAs: id, path: null })]),
    // 4 (после решения оператора): reviewer поднимает принятое ограничение
    // без новых доказательств и одобряет.
    verdict(true, [finding('Критерий всё ещё не измерим', { sameAs: id })]),
  ]);
  let g = graph;
  const r1 = await h.review({ kind: 'plan', graph: g, author: 'claude' });
  assert.equal(r1.approved, false);
  assert.equal(r1.findings.length, 1);
  assert.equal(r1.findings[0]!.id, id);
  assert.equal(r1.findings[0]!.rounds, 1);

  g = revise(graph, 2);
  const r2 = await h.review({ kind: 'plan', graph: g, author: 'claude' });
  assert.equal(r2.findings.length, 1, 'переформулировка не заводит новую находку');
  assert.equal(r2.findings[0]!.id, id, 'ID прежний');
  assert.equal(r2.findings[0]!.status, 'open', 'закрытие вопреки повтору отклонено');
  assert.equal(r2.findings[0]!.rounds, 2);
  assert.equal(r2.findings[0]!.openedIn, 1);
  assert.equal(r2.findings[0]!.message, 'Приёмка не проверяется командой', 'текущая формулировка');
  assert.match(r2.findings[0]!.basis!, /тот же путь и правило.*closed отклонён/);

  g = revise(graph, 3);
  const r3 = await h.review({ kind: 'plan', graph: g, author: 'claude' });
  assert.equal(r3.findings.length, 1);
  assert.equal(r3.findings[0]!.id, id);
  assert.equal(r3.findings[0]!.rounds, REVIEW_ESCALATION_ROUNDS);
  assert.match(
    requests[2]!.prompt,
    new RegExp(`"id":"${id}"[^}]*"rounds":2`),
    'reviewer видит счёт',
  );
  assert.match(requests[2]!.prompt, /sameAs/);
  assert.equal(requests[2]!.outputSchema, technicalReviewOutputSchema);

  // Эскалация: следующего оплаченного раунда нет, пока нет решения оператора.
  g = revise(graph, 4);
  await assert.rejects(h.review({ kind: 'plan', graph: g, author: 'claude' }), (e: unknown) => {
    refused('INPUT_REQUIRED')(e);
    const err = e as HarnessError;
    assert.match(err.message, /accept-limitation/);
    assert.match(err.message, /continue/);
    assert.deepEqual(err.issues[0]!.path, ['findings', id]);
    return true;
  });
  assert.equal(requests.length, 3, 'эскалация — без вызова reviewer');
  const status = statusDataSchema.parse(h.status());
  const row = status.reviews![0]!;
  reviewSubjectSummarySchema.parse(row);
  assert.deepEqual(row.rounds, { used: 3, max: policy.maxAttempts * 2 });
  assert.deepEqual(row.open, { blocking: 1, notes: 0 });
  assert.equal(row.spend.calls, 3);
  assert.equal(row.spend.knownUsd, 0.75);
  assert.deepEqual(
    row.escalation!.options.map((o) => o.id),
    ['accept-limitation', 'continue', 'stop'],
  );
  assert.deepEqual(
    row.escalation!.findings.map((f) => [f.id, f.rounds]),
    [[id, 3]],
  );
  assert.match(
    row.line,
    /не одобрено, открытых блокирующих 1; раундов 3\/6; ревью \$0\.75; ждёт решения оператора/,
  );
  assert.match(statusText(status), /Ревью:\n {2}план g: не одобрено/);

  // Ведущий эскалированную находку сам не решает.
  const accept = (by: 'lead' | 'operator') => ({
    finding: id,
    decision: 'accepted-limitation' as const,
    by,
    reason: 'Измеримость задаёт следующий этап; известное ограничение',
  });
  await assert.rejects(
    h.review({ kind: 'plan', graph: g, author: 'claude', dispositions: [accept('lead')] }),
    refused('INPUT_REQUIRED'),
  );
  assert.equal(requests.length, 3);

  // Решение оператора применяется раундом 4 до вызова: reviewer видит
  // принятое ограничение; повтор без новых доказательств не открывает его и
  // не мешает одобрению.
  const r4 = await h.review({
    kind: 'plan',
    graph: g,
    author: 'claude',
    dispositions: [accept('operator')],
  });
  assert.match(requests[3]!.prompt, /Accepted limitations/);
  assert.match(requests[3]!.prompt, /известное ограничение/);
  assert.doesNotMatch(requests[3]!.prompt, /Previous open findings/);
  assert.equal(r4.approved, true, r4.summary);
  assert.equal(r4.findings.length, 1);
  const f4 = r4.findings[0]!;
  assert.equal(f4.status, 'accepted-limitation');
  assert.equal(f4.changedIn, 4);
  assert.deepEqual(f4.disposition, {
    decision: 'accepted-limitation',
    by: 'operator',
    reason: accept('operator').reason,
    round: 4,
    rounds: 3,
  });
  assert.match(r4.summary, /повтор принятого ограничения без новых доказательств/);
  const after = statusDataSchema.parse(h.status()).reviews![0]!;
  assert.equal(after.escalation, undefined);
  assert.equal(after.accepted, 1);
  assert.match(after.line, /одобрено, открытых заметок 0, принятых ограничений 1; раундов 4\/6/);
  // Одобренный digest с решением — отказ: решения применяет только раунд.
  await assert.rejects(
    h.review({ kind: 'plan', graph: g, author: 'claude', dispositions: [accept('lead')] }),
    refused('INVALID_INPUT'),
  );
  assert.equal(requests.length, 4);
  h.close();
});

test('H14: одобрено с открытой заметкой — «одобрено, открытых заметок 1» в status, explain-сводке и отчёте; расход ревью виден', async () => {
  const note = { ...finding('Стоит уточнить имя ветки'), severity: 'note', rule: null, path: null };
  const { h, stateDir, policy } = open([verdict(true, [note])]);
  const record = await h.review({ kind: 'plan', graph: graphOf({ a: [] }), author: 'claude' });
  assert.equal(record.approved, true);
  const status = statusDataSchema.parse(h.status());
  const row = status.reviews![0]!;
  assert.deepEqual(row.open, { blocking: 0, notes: 1 });
  assert.match(row.line, /^план g: одобрено, открытых заметок 1; раундов 1\/6; ревью \$0\.25$/);
  const reviews = h.engine.read((v) => v.locals('reviews').map((r) => r.value));
  const calls = h.engine.read((v) => v.locals('usage').map((r) => r.value));
  h.close();
  const { diagnoseState } = await import('../src/explain/diagnose.ts');
  const explained = await diagnoseState({ stateDir, policy, baseDir: process.cwd(), adapters: {} });
  assert.equal(explained.reviews?.[0]?.line, row.line, 'explain — та же сводка');
  const report = valueReport({ works: [], attempts: [], reviews, calls });
  assert.equal(report.defects.planContract.approvedWithOpenNotes, 1);
  assert.equal(report.defects.planContract.openNotes, 1);
  assert.equal(report.defects.planContract.calls, 1);
  assert.match(
    reportMarkdown(report),
    /1 subject approved, 1 open note; review calls 1, known spend \$0\.25/,
  );
});

test('H14: решение ведущего accepted-limitation по неэскалированной находке; continue оператора — ещё три раунда до новой эскалации', async () => {
  const graph = graphOf({ a: [] });
  const a = findingId('g', { rule: 'acceptance-measurable', message: 'A' });
  const b = findingId('g', { rule: 'scope', message: 'B' });
  const { h, requests } = open([
    verdict(false, [finding('A'), finding('B', { rule: 'scope', path: 'orders[0].scope' })]),
    // 2: A принято ведущим; B остаётся.
    verdict(false, [], [{ id: b, status: 'open', basis: 'не исправлено' }]),
    verdict(false, [], [{ id: b, status: 'open', basis: 'не исправлено' }]),
    // 4 (после continue оператора).
    verdict(false, [], [{ id: b, status: 'open', basis: 'не исправлено' }]),
    verdict(false, [], [{ id: b, status: 'open', basis: 'не исправлено' }]),
    verdict(false, [], [{ id: b, status: 'open', basis: 'не исправлено' }]),
  ]);
  await h.review({ kind: 'plan', graph, author: 'claude' });
  // continue по неэскалированной находке не нужен.
  await assert.rejects(
    h.review({
      kind: 'plan',
      graph: revise(graph, 2),
      author: 'claude',
      dispositions: [{ finding: b, decision: 'continue', by: 'operator', reason: 'ещё раунд' }],
    }),
    refused('INVALID_INPUT'),
  );
  const r2 = await h.review({
    kind: 'plan',
    graph: revise(graph, 2),
    author: 'claude',
    dispositions: [
      { finding: a, decision: 'accepted-limitation', by: 'lead', reason: 'вне объёма плана' },
    ],
  });
  assert.equal(r2.findings.find((f) => f.id === a)!.status, 'accepted-limitation');
  assert.equal(r2.findings.find((f) => f.id === a)!.disposition!.by, 'lead');
  assert.equal(r2.findings.find((f) => f.id === b)!.rounds, 2);
  // Решение по не открытой находке — отказ до вызова.
  await assert.rejects(
    h.review({
      kind: 'plan',
      graph: revise(graph, 3),
      author: 'claude',
      dispositions: [{ finding: a, decision: 'accepted-limitation', by: 'lead', reason: 'снова' }],
    }),
    refused('INVALID_INPUT'),
  );
  await h.review({ kind: 'plan', graph: revise(graph, 3), author: 'claude' });
  await assert.rejects(
    h.review({ kind: 'plan', graph: revise(graph, 4), author: 'claude' }),
    refused('INPUT_REQUIRED'),
  );
  assert.equal(requests.length, 3);
  const proceed = {
    finding: b,
    decision: 'continue' as const,
    by: 'operator' as const,
    reason: 'план переписан по сути находки',
  };
  const r4 = await h.review({
    kind: 'plan',
    graph: revise(graph, 4),
    author: 'claude',
    dispositions: [proceed],
  });
  const fb = r4.findings.find((f) => f.id === b)!;
  assert.equal(fb.rounds, 4, 'общий счёт сохраняется');
  assert.equal(fb.disposition!.decision, 'continue');
  assert.equal(fb.disposition!.rounds, 3);
  await h.review({ kind: 'plan', graph: revise(graph, 5), author: 'claude' });
  await h.review({ kind: 'plan', graph: revise(graph, 6), author: 'claude' });
  assert.equal(requests.length, 6);
  // Три раунда после решения — снова решение оператора (а не предел раундов).
  await assert.rejects(
    h.review({ kind: 'plan', graph: revise(graph, 7), author: 'claude' }),
    refused('INPUT_REQUIRED'),
  );
  assert.equal(requests.length, 6);
  h.close();
});

test('H14: mergeTechnicalRound — sameAs неизвестен — подсказка, не ошибка; неоднозначный путь и правило и пустой путь не сопоставляются; принятое ограничение с новыми доказательствами открывается заново', () => {
  const parse = (r: unknown) => reviewResultSchema.parse(r);
  const base = (id: string, extra: Partial<ReviewRecord['findings'][number]> = {}) => ({
    id,
    severity: 'blocking' as const,
    message: 'm-' + id.slice(0, 4),
    rule: 'r',
    path: 'p',
    line: null,
    status: 'open' as const,
    openedIn: 1,
    changedIn: 1,
    rounds: 1,
    ...extra,
  });
  const x = 'a'.repeat(64);
  const y = 'b'.repeat(64);
  const z = 'c'.repeat(64);

  // Неизвестный sameAs: находка новая, раунд валиден, причина — в заметке.
  let m = mergeTechnicalRound(
    [base(x, { status: 'closed' })],
    parse(verdict(false, [finding('новое', { sameAs: 'f'.repeat(64), rule: 'q' })])),
    2,
    'g',
  );
  assert.deepEqual(m.issues, []);
  assert.equal(m.findings.length, 2);
  assert.match(m.notes.join(), /sameAs не применён/);

  // Два открытых кандидата с тем же путём и правилом — не угадывается.
  m = mergeTechnicalRound(
    [base(x), base(y)],
    parse(
      verdict(
        false,
        [finding('третья', { rule: 'r', path: 'p' })],
        [
          { id: x, status: 'open', basis: 'остаётся' },
          { id: y, status: 'open', basis: 'остаётся' },
        ],
      ),
    ),
    2,
    'g',
  );
  assert.deepEqual(m.issues, []);
  assert.equal(m.findings.length, 3);

  // Пустой путь: правило одно — сопоставления нет.
  m = mergeTechnicalRound(
    [base(x, { path: null, status: 'closed' })],
    parse(verdict(false, [finding('иначе', { rule: 'r', path: null })])),
    2,
    'g',
  );
  assert.equal(m.findings.length, 2);

  // Открытая находка, поднятая снова, не требует записи в previous; одобрение
  // при ней (blocking) — ошибка протокола.
  m = mergeTechnicalRound(
    [base(x)],
    parse(verdict(true, [finding('другими словами', { sameAs: x })])),
    2,
    'g',
  );
  assert.deepEqual(m.issues, ['approved при блокирующей находке']);

  // Принятое ограничение с новыми доказательствами открывается заново: счёт и
  // решение сбрасываются.
  const accepted = base(z, {
    status: 'accepted-limitation',
    disposition: { decision: 'accepted-limitation', by: 'lead', reason: 'ок', round: 2, rounds: 1 },
  });
  m = mergeTechnicalRound(
    [accepted],
    parse(verdict(false, [finding('снова', { sameAs: z, evidence: 'новый сбой на входе X' })])),
    3,
    'g',
  );
  assert.deepEqual(m.issues, []);
  const reopened = m.findings[0]!;
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.rounds, 1);
  assert.equal(reopened.disposition, undefined);
  assert.match(reopened.basis!, /новые доказательства: новый сбой/);
  // Запись в previous для принятого ограничения — не открытой находки — ошибка.
  m = mergeTechnicalRound(
    [accepted],
    parse(verdict(false, [], [{ id: z, status: 'open', basis: 'всё ещё' }])),
    3,
    'g',
  );
  assert.deepEqual(m.issues, ['Состояние неизвестной находки: ' + z]);

  // Повтор решения по одной находке — отказ.
  assert.throws(
    () =>
      applyDispositions(
        [base(x)],
        [
          { finding: x, decision: 'accepted-limitation', by: 'lead', reason: 'one' },
          { finding: x, decision: 'accepted-limitation', by: 'lead', reason: 'two' },
        ],
        2,
        1,
      ),
    refused('INVALID_INPUT'),
  );
});

test('H14: запись прежней версии без rounds — счёт из openedIn; заметка не эскалируется', () => {
  const old = {
    id: 'd'.repeat(64),
    severity: 'blocking' as const,
    message: 'old',
    path: null,
    line: null,
    status: 'open' as const,
    openedIn: 1,
    changedIn: 3,
  };
  const note = { ...old, id: 'e'.repeat(64), severity: 'note' as const };
  assert.throws(
    () =>
      applyDispositions(
        [old, note],
        [{ finding: old.id, decision: 'accepted-limitation', by: 'lead', reason: 'без оператора' }],
        4,
        3,
      ),
    refused('INPUT_REQUIRED'),
  );
  const decided = applyDispositions(
    [old, note],
    [{ finding: note.id, decision: 'accepted-limitation', by: 'lead', reason: 'заметка принята' }],
    4,
    3,
  );
  assert.equal(decided[1]!.status, 'accepted-limitation');
  assert.equal(decided[1]!.disposition!.rounds, 3);
});

test('H14: CLI — решения по находкам только у review-plan/review-contract; неверный ID и решающий — INVALID_INPUT до записи', () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'harness-review-loop-cli-'));
  const harness = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const json = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    return { status: r.status, json };
  };
  const common = [
    '--state',
    join(dir, 'state'),
    '--graph',
    join(dir, 'graph.json'),
    '--policy',
    join(dir, 'policy.json'),
    '--author',
    'claude',
  ];
  let r = harness(
    'review-plan',
    ...common,
    '--accept-limitation',
    'not-a-digest',
    '--reason',
    'ок ок',
  );
  assert.equal(r.status, 2);
  assert.equal(r.json.error.code, 'INVALID_INPUT');
  r = harness(
    'review-plan',
    ...common,
    '--accept-limitation',
    'a'.repeat(64),
    '--reason',
    'основание',
    '--actor',
    'writer',
  );
  assert.equal(r.status, 2);
  assert.match(r.json.error.message, /--actor/);
  r = harness('review-plan', ...common, '--actor', 'operator');
  assert.equal(r.status, 2);
  assert.match(r.json.error.message, /--accept-limitation/);
  r = harness('status', '--state', join(dir, 'state'), '--accept-limitation', 'a'.repeat(64));
  assert.equal(r.status, 2);
  assert.match(r.json.error.message, /review-plan, review-contract/);
});
