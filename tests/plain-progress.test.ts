/**
 * Простые слова для оператора: почему поручение повторяется (последний отказ
 * в строке этапа и `attemptSummary.lastFailure`), почему не выдаётся
 * (`blockers[].plain`, кто снимает) и что проверено и как (`verification`):
 * кто запускал gates, кто читал diff, что не проверялось. Слово «проверено»
 * в тексте для человека — только с тем, кто и как проверял.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cliDataSchemas,
  digestOf,
  resultEnvelopeSchema,
  verificationHows,
  verificationResults,
  vendorOf,
  type AttemptState,
  type ControlState,
} from '../src/contracts/index.ts';
import { statusOf, statusText } from '../src/control/status.ts';
import { blockerCodeText, plainBlocker, type BlockerCode } from '../src/control/blocker-plain.ts';
import { stageLine, workStageOf } from '../src/control/stage.ts';
import { Harness } from '../src/control/harness.ts';
import { explainText } from '../src/explain/diagnose.ts';
import { collectReportInput } from '../src/control/report.ts';
import { reportMarkdown, valueReport } from '../src/report/index.ts';
import { failureBucketText, failureKindText, failurePlainOf } from '../src/report/failure-plain.ts';
import {
  verificationHowNames,
  verificationLines,
  verificationOf,
  verificationResultNames,
  verificationRows,
} from '../src/report/verification.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';
import type { Engine } from '../src/engine/engine.ts';

const noJobs = { list: () => [], continues: () => false };
const sourceOf = (engine: Engine) => ({ engine, policy: engine.policy, workflows: noJobs });

/** «Проверено»/"checked" — только с тем, кто проверял, или с отрицанием. */
function assertNoBareChecked(text: string, where: string) {
  for (const m of text.matchAll(/проверено/gi)) {
    const before = text.slice(Math.max(0, m.index - 3), m.index).toLowerCase();
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 8);
    assert.ok(
      after.startsWith(' harness') || before === 'не ',
      `${where}: «проверено» без того, кто проверял: …${text.slice(Math.max(0, m.index - 40), m.index + 40)}…`,
    );
  }
  for (const m of text.matchAll(/\bchecked\b/gi)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 11);
    assert.ok(
      after === ' by harness',
      `${where}: "checked" без того, кто проверял: …${text.slice(Math.max(0, m.index - 40), m.index + 40)}…`,
    );
  }
}

const evidence = (
  e: Engine,
  a: { id: string; token: string },
  phase: 'candidate' | 'integration',
  at: string,
  gate: string,
  passed: boolean,
  kind: 'test' | 'review' = 'test',
) =>
  e.evidence(a.id, a.token, {
    kind,
    phase,
    sha: at,
    gate,
    passed,
    command: ['npm', 'run', 'secret-gate-command'],
    exitCode: passed ? 0 : 1,
    log: '',
    digest: digestOf(phase + gate + String(passed)),
    summary: passed ? 'ok' : 'fail',
    ...(kind === 'review' ? { findings: [] } : {}),
  });

/** Провести попытку обеими фазами с PASS gate `unit` и ревью; принять. */
function accept(e: Engine, a: { id: string; token: string }) {
  e.phase(a.id, a.token, 'verifying', { baseSha: sha('c'), candidateSha: sha('a') });
  evidence(e, a, 'candidate', sha('a'), 'unit', true);
  evidence(e, a, 'candidate', sha('a'), 'independent-review', true, 'review');
  e.phase(a.id, a.token, 'integrating', { integrationSha: sha('b') });
  evidence(e, a, 'integration', sha('b'), 'unit', true);
  evidence(e, a, 'integration', sha('b'), 'independent-review', true, 'review');
  e.finish(a.id, a.token, sha('b'));
}

test('P1-b: повтор после отказа окружения — «попытка N из M; прошлая остановлена: окружение — порт занят»; lastFailure в status', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [] }));
  const first = env.engine.claim('c1')!;
  env.engine.fail(
    first.id,
    first.token,
    'Порт 3000 (ресурс web) занят до начала фазы: держит node (pid 4242), токен sk-secret',
    { kind: 'environment', blocked: true },
  );
  env.clock.now += 1000;
  // Отказ окружения ставит выдачу на паузу runtime: её снимает человек.
  // Отказ окружения ставит выдачу на паузу runtime: человек снимает её и
  // назначает повтор.
  env.engine.resume();
  env.engine.retry('w', { reason: 'порт освобождён' });
  const second = env.engine.claim('c1')!;
  assert.ok(second, 'отказ окружения не засчитан: повтор выдан');
  env.engine.timingStarted(second.id, second.token, 'implementation');
  const data = cliDataSchemas.status.parse(statusOf(sourceOf(env.engine)));
  const w = data.works[0]!;
  assert.deepEqual(
    {
      bucket: w.attemptSummary!.lastFailure!.bucket,
      kind: w.attemptSummary!.lastFailure!.kind,
      plain: w.attemptSummary!.lastFailure!.plain,
      plainEn: w.attemptSummary!.lastFailure!.plainEn,
      runId: w.attemptSummary!.lastFailure!.runId,
    },
    {
      bucket: 'environment',
      kind: 'environment',
      plain: 'окружение — порт 3000 занят',
      plainEn: 'environment — port 3000 is busy',
      runId: first.id,
    },
  );
  const max = env.engine.policy.maxAttempts;
  assert.match(
    w.stage!.line,
    new RegExp(
      `^w: исполнитель пишет код \\(implementation\\) — 0 с; попытка ${w.attempt} из ${max}; прошлая остановлена: окружение — порт 3000 занят; дальше:`,
    ),
  );
  assert.match(
    w.stage!.lineEn,
    new RegExp(
      `attempt ${w.attempt} of ${max}; previous stopped: environment — port 3000 is busy; next:`,
    ),
  );
  // Свободный текст ошибки (держатель порта, токен) в простой текст не попадает.
  assert.ok(!JSON.stringify(w.attemptSummary!.lastFailure).includes('sk-secret'));
  assert.ok(!JSON.stringify(w.stage).includes('pid'));
});

test('P1-b: остановленное — «попыток использовано N из M; последняя остановлена: дефект — не прошли проверки: unit»', () => {
  const env = engineOf(policyOf((p) => (p.maxAttempts = 1)));
  ready(env.engine, graphOf({ w: [] }));
  const a = env.engine.claim('c1')!;
  env.engine.phase(a.id, a.token, 'verifying', { candidateSha: sha('a') });
  evidence(env.engine, a, 'candidate', sha('a'), 'unit', false);
  env.engine.fail(a.id, a.token, 'gate unit failed', { kind: 'gate' });
  const w = cliDataSchemas.status.parse(statusOf(sourceOf(env.engine))).works[0]!;
  assert.equal(w.stage!.name, 'stopped');
  assert.match(
    w.stage!.line,
    /^w: остановлено — 0 с; попыток использовано 1 из 1; последняя остановлена: дефект — не прошли проверки: unit; дальше:/,
  );
  assert.match(w.stage!.lineEn, /attempts used 1 of 1; last stopped: defect — gates failed: unit;/);
  // Первая попытка без отказа и итог — без номера попытки.
  const fresh = engineOf();
  ready(fresh.engine, graphOf({ w: [] }));
  fresh.engine.claim('c1');
  const line = statusOf(sourceOf(fresh.engine)).works[0]!.stage.line;
  assert.doesNotMatch(line, /попытк/);
});

test('P1-b: failurePlainOf — у каждого класса и корзины есть текст; без класса — по признакам попытки', () => {
  const base = { evidence: [], status: 'failed' } as unknown as AttemptState;
  for (const [kind, text] of Object.entries(failureKindText)) {
    const plain = failurePlainOf({ ...base, failureKind: kind } as AttemptState, 'defect');
    assert.ok(text.ru && text.en, kind);
    if (kind !== 'gate') assert.equal(plain.ru, `дефект — ${text.ru}`, kind);
  }
  for (const text of Object.values(failureBucketText)) assert.ok(text.ru && text.en);
  assert.equal(
    failurePlainOf({ ...base, status: 'expired' }, 'environment').ru,
    'окружение — процесс попытки пропал (владение истекло)',
  );
  assert.equal(
    failurePlainOf({ ...base, blocked: true }, 'environment').en,
    'environment — the environment blocked the start',
  );
});

/** Коды из объявления результата `Engine.blockers` (src/engine/engine.ts). */
function engineBlockerCodes(): string[] {
  const src = readFileSync(new URL('../src/engine/engine.ts', import.meta.url), 'utf8');
  const start = src.indexOf('  blockers(work: WorkState, view: ExecutionView) {');
  assert.ok(start > 0, 'объявление Engine.blockers найдено');
  const decl = src.slice(start, src.indexOf('message: string;', start));
  return [...decl.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!).sort();
}

test('P1-c: у каждого кода Engine.blockers есть простой текст и кто снимает (новый код без текста — провал)', () => {
  const codes = engineBlockerCodes();
  assert.ok(codes.length >= 10, codes.join());
  assert.deepEqual(Object.keys(blockerCodeText).sort(), codes);
  const control: ControlState = { paused: false };
  for (const code of codes) {
    const t = plainBlocker(
      { code: code as BlockerCode, message: 'сообщение хоста' },
      { control, approvalMode: 'agent' },
    );
    assert.ok(t.plain.length > 0 && t.plainEn.length > 0, code);
    assert.ok(['user', 'lead', 'controller', null].includes(t.actor), code);
  }
});

test('P1-c: разновидности блокировок — зависимость, черновик, согласование, вопрос, пауза очереди по причине', () => {
  const ctx = {
    control: { paused: false } as ControlState,
    approvalMode: 'agent' as 'agent' | 'operator',
  };
  const of = (code: BlockerCode, message: string, c = ctx) => plainBlocker({ code, message }, c);
  assert.deepEqual(of('NOT_READY', 'Ждёт a'), {
    plain: 'ждёт зависимости a',
    plainEn: 'waiting for dependency a',
    actor: 'controller',
  });
  assert.equal(of('NOT_READY', 'Статус draft').plain, 'черновик — не утверждён');
  assert.equal(of('NOT_READY', 'Статус draft').actor, 'lead');
  assert.equal(
    of('NOT_READY', 'Статус draft', { ...ctx, approvalMode: 'operator' }).actor,
    'user',
    'согласует оператор',
  );
  assert.equal(of('APPROVAL_REQUIRED', 'Граф не согласован').plain, 'ждёт согласования плана');
  assert.equal(
    of('INPUT_REQUIRED', 'Ждёт ответа на вопрос исполнителя IR-1').plain,
    'ждёт вашего ответа на вопрос исполнителя',
  );
  assert.equal(
    of('INPUT_REQUIRED', 'Ответ на вопрос IR-1 записан, но не применён (applyInput)').actor,
    'lead',
  );
  assert.equal(
    of('NOT_READY', 'Удержано операцией base-move').plain,
    'удержано операцией base-move — ждёт её конца',
  );
  assert.equal(
    of('ATTEMPTS_EXHAUSTED', 'Исчерпано 3 из 3 попыток').plain,
    'попытки исчерпаны (3 из 3) — нужен ваш сброс попыток',
  );
  const paused = (control: ControlState) =>
    of('PAUSED', 'Очередь на паузе: x', { ...ctx, control });
  assert.equal(paused({ paused: true, pauseReason: 'operator' }).actor, 'user');
  assert.equal(
    paused({ paused: true, pauseReason: 'runtime', pauseFailures: ['budget'] }).plain,
    'пауза очереди: бюджет — нужно ваше решение',
  );
  assert.equal(paused({ paused: true, pauseReason: 'shutdown' }).actor, 'controller');
  assert.equal(
    of('PAUSED', 'Очередь ждёт подтверждения перенесённой базы').plain,
    'пауза очереди: ждёт вашего подтверждения перенесённой базы',
  );
  // Сообщение хоста — общий текст кода, без пересказа сообщения.
  assert.equal(of('NOT_READY', 'Продуктовое условие X').plain, blockerCodeText.NOT_READY.ru);
});

test('P1-c: status — blockers[] с plain и actor (прежние поля на месте), queued «просто ждёт очереди», --human — простым текстом', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [], b: ['a'] }));
  const data = cliDataSchemas.status.parse(statusOf(sourceOf(env.engine)));
  const a = data.works.find((w) => w.id === 'a')!;
  const b = data.works.find((w) => w.id === 'b')!;
  assert.deepEqual(a.blockers, []);
  assert.equal(a.stage!.name, 'queued');
  assert.match(a.stage!.line, /^a: просто ждёт очереди — ничего не нужно; дальше:/);
  assert.match(a.stage!.lineEn, /^a: just waiting in the queue — nothing needed; next:/);
  assert.deepEqual(b.blockers, [
    {
      code: 'NOT_READY',
      message: 'Ждёт a',
      plain: 'ждёт зависимости a',
      plainEn: 'waiting for dependency a',
      actor: 'controller',
    },
  ]);
  assert.match(b.stage!.line, /^b: не выдаётся: ждёт зависимости a; дальше:/);
  const human = statusText(data);
  assert.ok(
    human.includes('  не выдаётся: ждёт зависимости a (harness сам) [коды: NOT_READY]\n'),
    human,
  );
  assertNoBareChecked(human, 'status --human');
  // Пауза оператора: человеку — снять паузу, его блокировка — первой.
  env.engine.pause('operator');
  const paused = cliDataSchemas.status.parse(statusOf(sourceOf(env.engine)));
  const pb = paused.works.find((w) => w.id === 'b')!;
  assert.match(pb.stage!.line, /^b: не выдаётся: пауза очереди: поставил оператор/);
  assert.match(
    statusText(paused),
    /не выдаётся: пауза очереди: поставил оператор — снимите паузу, когда готовы \(нужно от вас\); ждёт зависимости a/,
  );
});

test('P1-d: строки проверки — запущено harness, повтор, неприменимо, взято с кандидата, ревью читал агент, не запускался', () => {
  const at = '2026-01-01T03:00:00.000+03:00';
  const rec = (patch: Record<string, unknown>) => ({
    id: String(patch.gate) + String(patch.phase),
    runId: 'r1',
    kind: 'test',
    phase: 'candidate',
    sha: sha('a'),
    passed: true,
    createdAt: at,
    command: ['npm', 'run', 'secret-gate-command'],
    exitCode: 0,
    log: '',
    digest: digestOf('x'),
    summary: '',
    ...patch,
  });
  const attempt = {
    id: 'r1',
    status: 'succeeded',
    reviewer: 'codex',
    requiredGates: ['lint', 'unit', 'e2e', 'smoke'],
    evidence: [
      rec({ gate: 'lint' }),
      rec({ gate: 'unit', passed: false }),
      rec({ gate: 'unit', recheck: { of: 'unitcandidate', outcome: 'flaky' } }),
      rec({ gate: 'e2e', kind: 'not-applicable', passed: false }),
      rec({ gate: 'independent-review', kind: 'review' }),
      rec({
        gate: 'lint',
        phase: 'integration',
        reusedEvidence: { evidenceId: 'x', phase: 'candidate', sha: sha('a'), tree: sha('c') },
      }),
      rec({ gate: 'unit', phase: 'integration', passed: false }),
    ],
  } as unknown as AttemptState;
  const rows = verificationRows(attempt);
  assert.deepEqual(
    rows.map((r) => [r.phase, r.gate, r.result, r.how]),
    [
      ['candidate', 'lint', 'passed', 'executed-by-harness'],
      ['candidate', 'unit', 'passed', 'executed-by-harness'],
      ['candidate', 'e2e', 'not-applicable', 'not-run'],
      ['candidate', 'independent-review', 'passed', 'read-by-reviewer'],
      ['integration', 'lint', 'reused', 'reused-evidence'],
      ['integration', 'unit', 'failed', 'executed-by-harness'],
      ['candidate', 'smoke', 'skipped', 'not-run'],
    ],
  );
  assert.equal(rows[0]!.at, '2026-01-01T00:00:00.000Z', 'момент — в UTC');
  assert.deepEqual(rows[3]!.reviewer, { runtime: 'codex', vendor: vendorOf('codex') });
  const { line, lineEn } = verificationLines(rows);
  assert.equal(
    line,
    'Проверено harness (запущено): ничего; не прошло (запущено harness): unit; взято из записи кандидата (то же дерево): lint; ревью: прочитал агент openai (codex), только diff, ничего не запускал — одобрил; не проверялось: e2e (изменения его не задели), smoke (не запускался)',
  );
  assert.equal(
    lineEn,
    'Checked by harness (executed): nothing; failed (executed by harness): unit; reused from the candidate record (same tree): lint; review: read by agent openai (codex), diff only, ran nothing — approved; not covered: e2e (not touched by the changes), smoke (not run)',
  );
  // Только ID gates: команды в ответ не попадают.
  assert.ok(!JSON.stringify({ rows, line, lineEn }).includes('secret-gate-command'));
  assertNoBareChecked(line + '\n' + lineEn, 'verification');
  // Литералы модуля без zod совпадают с договором.
  assert.deepEqual([...verificationResultNames], [...verificationResults]);
  assert.deepEqual([...verificationHowNames], [...verificationHows]);
  // Идущая попытка без записей — проверки ещё нет (не «ничего не проверено»).
  assert.equal(
    verificationOf({ status: 'running' }, [{ ...attempt, status: 'active', evidence: [] }]),
    undefined,
  );
});

test('P1-d: status, explain, result и report называют, что проверено и как; текст для человека без голого «проверено»', () => {
  const env = engineOf();
  ready(env.engine, graphOf({ w: [], x: [] }));
  const a = env.engine.claim('c1')!;
  accept(env.engine, a);
  const data = cliDataSchemas.status.parse(statusOf(sourceOf(env.engine)));
  const done = data.works.find((w) => w.id === a.workId)!;
  const v = done.verification!;
  assert.equal(v.runId, a.id);
  assert.deepEqual(
    v.rows.map((r) => [r.phase, r.gate, r.result, r.how]),
    [
      ['candidate', 'unit', 'passed', 'executed-by-harness'],
      ['candidate', 'independent-review', 'passed', 'read-by-reviewer'],
      ['integration', 'unit', 'passed', 'executed-by-harness'],
      ['integration', 'independent-review', 'passed', 'read-by-reviewer'],
    ],
  );
  const reviewer = env.engine.read((x) => x.attempt(a.id))!.reviewer;
  assert.equal(
    v.line,
    `Проверено harness (запущено): unit; ревью: прочитал агент ${vendorOf(reviewer)} (${reviewer}), только diff, ничего не запускал — одобрил`,
  );
  const other = data.works.find((w) => w.id !== a.workId)!;
  assert.equal(other.verification, undefined, 'без попыток — проверки нет');
  const human = statusText(data);
  assert.ok(human.includes(`  проверки: ${v.line}\n`), human);
  assertNoBareChecked(human, 'status --human');
  assert.ok(!JSON.stringify(data).includes('npm'), 'команды gates не выводятся');

  // Отчёт: строка поручения с проверкой; в Markdown — сводной строкой.
  const report = valueReport(collectReportInput(env.store), {
    stateDir: env.dir,
    harnessVersion: 'test',
    asOf: '2026-01-02T00:00:00.000Z',
  });
  const row = report.works.rows.find((r) => r.id === a.workId)!;
  assert.equal(row.verification?.lineEn, v.lineEn);
  const md = reportMarkdown(report);
  assert.ok(md.includes(`- ${a.workId}: ${v.lineEn}.`), md);
  assertNoBareChecked(md, 'report markdown');

  // result и explain — та же проверка попытки.
  env.store.close();
  const h = Harness.open({
    stateDir: env.dir,
    policy: env.engine.policy,
    baseDir: env.dir,
    readOnly: true,
    readOnlyState: true,
  });
  try {
    const envelope = resultEnvelopeSchema.parse(h.result(a.workId));
    assert.deepEqual(envelope.verification, v);
  } finally {
    h.close();
  }
  const explain = {
    diagnoses: [],
    verification: [{ workId: a.workId, ...v }],
  };
  cliDataSchemas.explain.parse(explain);
  const text = explainText(explain);
  assert.ok(text.includes(`Проверки и ревью — кто и как:\n  ${a.workId}: ${v.line}\n`), text);
  assertNoBareChecked(text, 'explain --human');
});

test('P1-d: тексты для человека — словари этапов, блокировок и отказов без голого «проверено»/"checked"', () => {
  const texts: string[] = [];
  for (const t of Object.values(blockerCodeText)) texts.push(t.ru, t.en);
  for (const t of Object.values(failureKindText)) texts.push(t.ru, t.en);
  for (const t of Object.values(failureBucketText)) texts.push(t.ru, t.en);
  const base = { attempts: [], records: [], now: 0 };
  for (const status of ['ready', 'draft', 'done', 'cancelled', 'failed']) {
    const s = workStageOf({
      ...base,
      work: { id: 'w', status, attempt: 2 } as never,
      blocked: status === 'draft',
    });
    texts.push(s.line, s.lineEn, stageLine('w', s, 'ru'), stageLine('w', s, 'en'));
  }
  assertNoBareChecked(texts.join('\n'), 'словари');
});
