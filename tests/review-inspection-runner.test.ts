/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
 * Тесты правят сырой JSON политики и читают review.json, журнал проверок и документ состояния как есть.
 */
/**
 * IN15–IN19: итог `inspection` ревью кода через обычный runner — fixture CLI
 * reviewer (`tests/fixtures/bin`), настоящий сервер проверок MCP, его журнал
 * `probes.jsonl`, настоящие Git, gate и JUnit. Без живых моделей.
 *
 * Компактные доказательства IN15–IN17 пишутся в `$INSPECTION_EVIDENCE_DIR`
 * (если задан): журнал проверок, review.json, evidence, run result и
 * результаты сравнений — переживают удаление временных каталогов.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  evidenceRecordSchema,
  executionDocumentSchema,
  publishedSchemas,
  reviewInspectionSchema,
  reviewRecordSchema,
  runResultSchema,
  sha256,
  type AttemptState,
  type EvidenceRecord,
} from '../src/contracts/index.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { technicalReview } from '../src/control/review.ts';
import { runResult } from '../src/engine/result.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { fixtureCalls } from './review-fixture.ts';
import { approve, bin, implement, runAll, setup, target } from './runner-fixture.ts';

const WORK = 'add-greeting';
type Ctx = ReturnType<typeof setup>;

// ---------------------------------------------------------------- помощники

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
/** Проверка опубликованной JSON Schema (`schemas/<name>.schema.json`). */
function published(name: keyof typeof publishedSchemas, value: unknown) {
  if (!compiled.has(name))
    compiled.set(
      name,
      ajv.compile(
        JSON.parse(
          readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8'),
        ) as object,
      ),
    );
  const validate = compiled.get(name)!;
  const ok = validate(value);
  assert.ok(ok, `${name}: ${JSON.stringify(validate.errors?.slice(0, 5))}`);
}

/** Пределы проверок, укладывающиеся в срок теста (объявленный gate — тоже). */
const probePolicy = (p: any) => {
  p.runTimeoutMs = 60_000;
  p.reviewProbes = { commandTimeoutMs: 20_000, budgetMs: 40_000, reserveMs: 5_000 };
};
/** Исследовательская команда-probe: печатает метку и выходит с кодом. */
const echo = (marker: string, code = 0) => [
  process.execPath,
  '-e',
  `console.log(${JSON.stringify(marker)}); process.exit(${code})`,
];

const attemptsOf = (ctx: Ctx) => ctx.engine.read((v) => v.attempts(WORK));
const reviewsOf = (a: AttemptState) => a.evidence.filter((e) => e.kind === 'review');
const writerCalls = (ctx: Ctx, runtime = 'claude') =>
  fixtureCalls(ctx.scenarioPath, runtime, 'writer');
const reviewerCalls = (ctx: Ctx, runtime = 'codex') =>
  fixtureCalls(ctx.scenarioPath, runtime, 'reviewer');
/** Что fixture reviewer получил от сервера проверок по MCP в вызове N. */
const mcpResults = (ctx: Ctx, index: number) =>
  JSON.parse(readFileSync(`${ctx.scenarioPath}.reviewer.${index}.probes`, 'utf8')) as any[];

/** Строки журнала проверок вызова reviewer, которому принадлежит evidence. */
function journalOf(e: EvidenceRecord) {
  const text = readFileSync(join(dirname(e.log), 'probes.jsonl'), 'utf8');
  const lines = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const results = lines.filter((l) => l.type === undefined && l.runId && l.status);
  return { text, lines, results };
}

/**
 * Общие проверки одной записи review evidence: артефакт и evidence несут один
 * итог; вид — `commands`, источник — журнал controller; происхождение — runId
 * этого журнала; контекст — попытка/фаза/SHA/вызов evidence; summary с тем же
 * видом; digest — существующей формулой от итогового артефакта.
 */
function checkReview(a: AttemptState, e: EvidenceRecord, source = 'controller-probes') {
  const text = readFileSync(e.log, 'utf8');
  const saved = JSON.parse(text);
  const journal = journalOf(e);
  const runIds = journal.results.map((r) => r.runId);
  const inspection = e.inspection!;
  const origins = inspection.commands.flatMap((c) =>
    (c.origins ?? []).filter((o) => o.type === 'controller').map((o) => (o as any).runId),
  );
  const context = { attempt: a.id, phase: e.phase, sha: e.sha, call: e.reviewRound!.call };
  const comparisons = {
    artifactEqualsEvidence: JSON.stringify(saved.inspection) === JSON.stringify(inspection),
    modeCommands: inspection.mode === 'commands',
    source: inspection.source,
    originsEqualJournal: JSON.stringify(origins) === JSON.stringify(runIds),
    contextMatches: JSON.stringify(inspection.context) === JSON.stringify(context),
    summaryPrefixed: e.summary.startsWith(`[${inspection.mode}] `),
    digestMatches: sha256(JSON.stringify(JSON.parse(text))) === e.digest,
  };
  assert.deepEqual(saved.inspection, inspection, 'review.json.inspection = evidence.inspection');
  reviewInspectionSchema.parse(inspection);
  evidenceRecordSchema.parse(e);
  assert.equal(inspection.mode, 'commands');
  assert.equal(inspection.reason, null);
  assert.equal(inspection.source, source);
  assert.ok(runIds.length > 0, 'журнал вызова содержит исходы проверок');
  assert.deepEqual(origins, runIds, 'происхождение — runId журнала этого вызова');
  assert.equal(inspection.total, runIds.length);
  assert.deepEqual(inspection.context, context);
  // Каждый исход журнала принадлежит этому вызову и подтверждает старт.
  for (const r of journal.results) {
    assert.deepEqual(r.scope, context, 'scope результата probe = контекст вызова');
    assert.equal(r.started, true);
  }
  assert.ok(e.summary.startsWith('[commands] '), e.summary);
  assert.equal(sha256(JSON.stringify(JSON.parse(text))), e.digest, 'digest артефакта');
  assert.equal(sha256(JSON.stringify(saved)), e.digest);
  return { saved, journal, comparisons };
}

/** Состояние, открытое заново только для чтения: тот же inspection у тех же evidence. */
function reloaded(ctx: Ctx, a: AttemptState) {
  const store = new SqliteExecutionStore(join(ctx.state, 'state.sqlite'), 'reader', {
    readOnly: true,
  });
  try {
    const again = store.read((v) => v.attempts(WORK)).find((x) => x.id === a.id)!;
    for (const e of reviewsOf(a)) {
      const r = again.evidence.find((x) => x.id === e.id)!;
      assert.deepEqual(r.inspection, e.inspection, 'после перезагрузки inspection тот же');
      assert.equal(r.digest, e.digest);
      assert.equal(r.summary, e.summary);
    }
  } finally {
    store.close();
  }
  // Сырой документ состояния: Zod и опубликованная JSON Schema.
  const db = new DatabaseSync(join(ctx.state, 'state.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string };
    const doc = JSON.parse(row.data);
    executionDocumentSchema.parse(doc);
    published('execution-document', doc);
    return true;
  } finally {
    db.close();
  }
}

/** Run result: Zod, JSON Schema; ссылки review — с тем же видом, digest и без поля inspection. */
function checkResult(a: AttemptState) {
  const result = runResult(a, 'test');
  runResultSchema.parse(result);
  published('run-result', result);
  const refs = result.evidence.filter((r) => r.kind === 'review');
  for (const ref of refs) {
    const e = a.evidence.find((x) => x.id === ref.id)!;
    assert.equal(ref.summary, e.summary.slice(0, 4000));
    assert.ok(ref.summary.startsWith(`[${e.inspection!.mode}] `), ref.summary);
    assert.equal(ref.digest, e.digest);
    assert.equal('inspection' in ref, false, 'полный inspection в run result не добавлен');
  }
  return result;
}

function saveEvidence(name: string, data: unknown) {
  const dir = process.env.INSPECTION_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(data, null, 2) + '\n');
}

const evidenceOf = (
  a: AttemptState,
  e: EvidenceRecord,
  checked: ReturnType<typeof checkReview>,
) => ({
  phase: e.phase,
  call: e.reviewRound?.call,
  protocol: e.reviewRound?.protocol,
  probeJournal: checked.journal.lines,
  reviewJson: checked.saved,
  evidence: e,
  comparisons: checked.comparisons,
  attempt: { id: a.id, status: a.status, failureKind: a.failureKind ?? null },
});

// ------------------------------------------------- IN15: Codex, обе фазы

/** Один прогон Codex reviewer с настоящими probes — общий для IN15 и IN19. */
let codexRun: Promise<{ ctx: Ctx; a: AttemptState; before: string }> | undefined;
const runCodex = () =>
  (codexRun ??= (async () => {
    const ctx = setup({
      writer: 'claude',
      reviewer: 'codex',
      scenario: {
        writer: implement(),
        // Ни один шаг не выдаёт shell `command_execution` (нет observedCommand):
        // выполнение подтверждается только журналом controller.
        reviewer: [
          { ...approve(), recordPrompt: true, probes: [echo('in15-candidate'), { gate: 'unit' }] },
          { ...approve(), recordPrompt: true, probes: [echo('in15-integration', 3)] },
        ],
      },
      policy: probePolicy,
    });
    const before = target(ctx);
    await runAll(ctx);
    return { ctx, a: attemptsOf(ctx)[0]!, before };
  })());

test('IN15: обычный runner + fake Codex, настоящие probes без shell-событий; candidate и integration — artifact = evidence, commands/controller-probes, перезагрузка, summary и digest', async () => {
  const { ctx, a } = await runCodex();
  assert.equal(a.status, 'succeeded', a.error);
  assert.equal(target(ctx), a.integrationSha, 'принят integration SHA');
  const reviews = reviewsOf(a);
  assert.deepEqual(
    reviews.map((e) => [e.phase, e.reviewRound?.call, e.passed]),
    [
      ['candidate', 1, true],
      ['integration', 1, true],
    ],
  );
  const report: any[] = [];
  for (const [i, e] of reviews.entries()) {
    const checked = checkReview(a, e);
    const runs = mcpResults(ctx, i);
    // То, что reviewer получил по MCP, — те же запуски, что в журнале и inspection.
    assert.deepEqual(
      runs.map((r) => r.runId),
      checked.journal.results.map((r) => r.runId),
    );
    const cmds = e.inspection!.commands;
    if (e.phase === 'candidate') {
      assert.equal(e.sha, a.candidateSha);
      assert.deepEqual(
        cmds.map((c) => [c.status, c.exitCode, c.gate ?? null]),
        [
          ['passed', 0, null],
          ['passed', 0, 'unit'],
        ],
      );
      assert.match(cmds[0]!.output, /in15-candidate/);
      assert.ok(cmds[1]!.command.endsWith('test/run.js'), cmds[1]!.command);
    } else {
      assert.equal(e.sha, a.integrationSha);
      assert.deepEqual(
        cmds.map((c) => [c.status, c.exitCode]),
        [['failed', 3]],
        'ненулевой код — тоже выполнение',
      );
      assert.match(cmds[0]!.output, /in15-integration/);
      // Integration не получает команд candidate.
      assert.doesNotMatch(JSON.stringify(e.inspection), /in15-candidate/);
    }
    assert.ok(
      cmds.every((c) => c.origins!.every((o) => o.type === 'controller')),
      'runtime-команд нет',
    );
    report.push(evidenceOf(a, e, checked));
  }
  assert.ok(reloaded(ctx, a));
  const result = checkResult(a);
  assert.equal(result.outcome, 'accepted');
  saveEvidence('in15.json', { reviews: report, runResult: result, reloadedEqual: true });
});

// ------------------------------------------------- IN16: Claude через MCP

test('IN16: обычный runner + fake Claude reviewer, probe вызван через --mcp-config; пустой runtime inspection — команды controller учтены', async () => {
  const ctx = setup({
    writer: 'codex',
    reviewer: 'claude',
    scenario: {
      writer: implement(),
      reviewer: [
        { ...approve(), recordPrompt: true, probes: [echo('in16-candidate'), { gate: 'unit' }] },
        { ...approve(), recordPrompt: true, probes: [echo('in16-integration')] },
      ],
    },
    policy: (p: any) => {
      probePolicy(p);
      // Claude запускает команды, только если профиль дал ему Bash.
      p.toolProfiles = { rev: { runtime: 'claude', claudeTools: ['Read', 'Bash'] } };
      p.review.code.reviewer.toolProfile = 'rev';
    },
  });
  await runAll(ctx);
  const a = attemptsOf(ctx)[0]!;
  assert.equal(a.status, 'succeeded', a.error);
  assert.equal(reviewerCalls(ctx, 'claude'), 2);
  assert.equal(reviewerCalls(ctx, 'codex'), 0, 'reviewer — именно Claude');
  const reviews = reviewsOf(a);
  assert.deepEqual(
    reviews.map((e) => e.phase),
    ['candidate', 'integration'],
  );
  const report: any[] = [];
  for (const [i, e] of reviews.entries()) {
    // Сервер проверок получен из --mcp-config и вызван по JSON-RPC stdio.
    const prompt = readFileSync(`${ctx.scenarioPath}.reviewer.${i}.prompt`, 'utf8');
    const argv = JSON.parse(prompt.split('\n---ARGS---\n')[1]!) as string[];
    const config = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1]!, 'utf8'));
    const server = JSON.parse(
      readFileSync(`${ctx.scenarioPath}.reviewer.${i}.probe-server`, 'utf8'),
    );
    assert.ok(server?.command, 'fixture Claude нашёл сервер проверок');
    assert.deepEqual(server, config.mcpServers.devcontour_probe, 'тот, что в --mcp-config');
    assert.ok(
      argv[argv.indexOf('--allowedTools') + 1]!.split(',').includes(
        'mcp__devcontour_probe__run_check',
      ),
    );
    const checked = checkReview(a, e);
    const runs = mcpResults(ctx, i);
    assert.deepEqual(
      runs.map((r) => r.runId),
      checked.journal.results.map((r) => r.runId),
      'ответы MCP = исходы журнала = происхождение inspection',
    );
    const cmds = e.inspection!.commands;
    assert.match(cmds[0]!.output, new RegExp(`in16-${e.phase}`));
    if (e.phase === 'candidate') assert.equal(cmds[1]!.gate, 'unit');
    else assert.equal(cmds.length, 1);
    report.push({ ...evidenceOf(a, e, checked), mcpServer: server, mcpResults: runs });
  }
  assert.ok(reloaded(ctx, a));
  const result = checkResult(a);
  assert.equal(result.outcome, 'accepted');
  saveEvidence('in16.json', { reviews: report, runResult: result, reloadedEqual: true });
});

// ------------------------------------- IN17: valid / invalid / unsafe

test('IN17: valid, invalid protocol и unsafe tree — в каждой записанной ветке artifact = evidence; повтор call-2 несёт только свои probes; valid принимается, invalid/unsafe — нет', async () => {
  const report: Record<string, unknown> = {};

  // Ветка invalid → повтор reviewer → valid (тот же SHA, writer один).
  const retry = setup({
    scenario: {
      writer: implement(),
      reviewer: [
        { raw: '{"approved": tru', probes: [echo('in17-call1')] },
        { ...approve(), probes: [echo('in17-call2a'), echo('in17-call2b')] },
        { ...approve(), probes: [echo('in17-integration')] },
      ],
    },
    policy: probePolicy,
  });
  await runAll(retry);
  const all = attemptsOf(retry);
  assert.equal(all.length, 1, 'номер попытки не растёт');
  const a = all[0]!;
  assert.equal(a.status, 'succeeded', a.error);
  assert.equal(target(retry), a.integrationSha);
  assert.equal(writerCalls(retry), 1, 'writer не перезапущен');
  assert.equal(reviewerCalls(retry), 3, '2 вызова candidate + 1 integration');
  const cand = reviewsOf(a).filter((e) => e.phase === 'candidate');
  assert.deepEqual(
    cand.map((e) => [e.reviewRound?.call, e.reviewRound?.protocol, e.passed]),
    [
      [1, 'invalid', false],
      [2, 'valid', true],
    ],
  );
  assert.equal(cand[0]!.sha, cand[1]!.sha);
  assert.notEqual(cand[0]!.log, cand[1]!.log);
  assert.equal(cand[0]!.reviewRound!.issues![0]!.reason, 'schema');
  const [invalid, valid] = cand.map((e) => checkReview(a, e));
  assert.ok(cand[0]!.summary.startsWith('[commands] REVIEW_PROTOCOL_INVALID'), cand[0]!.summary);
  assert.equal(invalid!.saved.protocol.status, 'invalid');
  assert.deepEqual(
    invalid!.saved.inspection.commands.map((c: any) => c.output.trim()),
    ['in17-call1'],
  );
  // call-2: только свои запуски, контекст — вызов 2.
  assert.equal(cand[1]!.inspection!.context!.call, 2);
  assert.match(cand[1]!.log, /call-2/);
  assert.deepEqual(
    valid!.saved.inspection.commands.map((c: any) => c.output.trim()),
    ['in17-call2a', 'in17-call2b'],
  );
  const call1Runs = invalid!.journal.results.map((r) => r.runId);
  assert.ok(
    cand[1]!.inspection!.commands.every((c) =>
      c.origins!.every((o) => o.type !== 'controller' || !call1Runs.includes(o.runId)),
    ),
    'call-2 не получает команд call-1',
  );
  const integration = reviewsOf(a).find((e) => e.phase === 'integration')!;
  const int = checkReview(a, integration);
  assert.ok(reloaded(retry, a));
  const accepted = checkResult(a);
  assert.equal(accepted.outcome, 'accepted');
  // Принятый результат несёт решающие записи; причина ошибки протокола — у валидного вердикта.
  const candRef = accepted.evidence.filter((r) => r.kind === 'review' && r.phase === 'candidate');
  assert.deepEqual(
    candRef.map((r) => r.review?.protocol),
    ['valid'],
  );
  assert.equal(candRef[0]!.review!.issues![0]!.reason, 'schema');
  report.invalidThenValid = {
    reviews: [
      evidenceOf(a, cand[0]!, invalid!),
      evidenceOf(a, cand[1]!, valid!),
      evidenceOf(a, integration, int),
    ],
    runResult: accepted,
    writerCalls: writerCalls(retry),
    reviewerCalls: reviewerCalls(retry),
  };

  // Ветка invalid без повторов: не принято, target на месте.
  const stop = setup({
    scenario: { writer: implement(), reviewer: { raw: 'not json', probes: [echo('in17-only')] } },
    policy: (p: any) => {
      probePolicy(p);
      p.maxAttempts = 1;
      p.reviewProtocolRetries = 0;
    },
  });
  const stopBefore = target(stop);
  await runAll(stop);
  const s = attemptsOf(stop)[0]!;
  assert.notEqual(s.status, 'succeeded');
  assert.equal(s.failureKind, 'review-protocol', s.error);
  assert.equal(target(stop), stopBefore, 'target не сдвинут');
  assert.equal(reviewerCalls(stop), 1);
  assert.equal(writerCalls(stop), 1);
  const [se] = reviewsOf(s);
  assert.equal(reviewsOf(s).length, 1);
  assert.equal(se!.reviewRound?.protocol, 'invalid');
  assert.equal(se!.passed, false);
  const sc = checkReview(s, se!);
  assert.ok(se!.summary.startsWith('[commands] REVIEW_PROTOCOL_INVALID'), se!.summary);
  assert.ok(reloaded(stop, s));
  const rejected = checkResult(s);
  assert.notEqual(rejected.outcome, 'accepted');
  assert.equal(
    rejected.outcome !== 'accepted' && rejected.stopReason.code,
    'REVIEW_PROTOCOL_INVALID',
  );
  report.invalidExhausted = { reviews: [evidenceOf(s, se!, sc)], runResult: rejected };

  // Ветка unsafe: reviewer изменил дерево — вердикт не применяется, повтора нет.
  const unsafe = setup({
    scenario: {
      writer: implement(),
      reviewer: {
        ...approve(),
        probes: [echo('in17-unsafe')],
        files: { 'src/greet.js': 'exports.greet = () => "tampered";\n' },
      },
    },
    policy: (p: any) => {
      probePolicy(p);
      p.maxAttempts = 1;
    },
  });
  const unsafeBefore = target(unsafe);
  await runAll(unsafe);
  const u = attemptsOf(unsafe)[0]!;
  assert.notEqual(u.status, 'succeeded');
  assert.equal(u.failureKind, 'review', u.error);
  assert.equal(target(unsafe), unsafeBefore, 'target не сдвинут');
  assert.equal(reviewerCalls(unsafe), 1, 'протокольного повтора нет');
  const [ue] = reviewsOf(u);
  assert.equal(reviewsOf(u).length, 1);
  assert.equal(ue!.reviewRound?.protocol, 'unsafe');
  assert.equal(ue!.passed, false);
  assert.match(ue!.summary, /^\[commands\] reviewer изменил дерево или HEAD/);
  const uc = checkReview(u, ue!);
  assert.match(ue!.inspection!.commands[0]!.output, /in17-unsafe/);
  assert.ok(reloaded(unsafe, u));
  const unsafeResult = checkResult(u);
  assert.notEqual(unsafeResult.outcome, 'accepted');
  report.unsafe = { reviews: [evidenceOf(u, ue!, uc)], runResult: unsafeResult };

  saveEvidence('in17.json', report);
});

// ------------------------- IN18: probe — не gate; gate — не inspection

test('IN18: валидное одобрение с неуспешным исследовательским probe при зелёных gates принимается без blocking finding и без нового writer', async () => {
  const ctx = setup({
    scenario: {
      writer: implement(),
      reviewer: [{ ...approve(), probes: [echo('in18-red', 1), { gate: 'unit' }] }, approve()],
    },
    policy: probePolicy,
  });
  await runAll(ctx);
  const all = attemptsOf(ctx);
  assert.equal(all.length, 1);
  const a = all[0]!;
  assert.equal(a.status, 'succeeded', a.error);
  assert.equal(target(ctx), a.integrationSha);
  assert.equal(writerCalls(ctx), 1, 'writer не перезапущен');
  const cand = reviewsOf(a).find((e) => e.phase === 'candidate')!;
  checkReview(a, cand);
  assert.equal(cand.passed, true);
  assert.deepEqual(
    cand.inspection!.commands.map((c) => [c.status, c.exitCode]),
    [
      ['failed', 1],
      ['passed', 0],
    ],
  );
  assert.deepEqual(cand.findings, [], 'ошибка probe не создаёт находку');
  // Integration без probes — diff-only: вид считает выполнения своего вызова.
  const int = reviewsOf(a).find((e) => e.phase === 'integration')!;
  assert.equal(int.inspection!.mode, 'diff-only');
  assert.ok(int.summary.startsWith('[diff-only] '), int.summary);
  const result = checkResult(a);
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.findings.filter((f) => f.severity === 'blocking').length, 0);
  // Gates — только от движка.
  assert.deepEqual(
    a.evidence.filter((e) => e.kind === 'test').map((e) => [e.phase, e.passed]),
    [
      ['candidate', true],
      ['integration', true],
    ],
  );
});

test('IN18: отказ обязательного gate не принимается независимо от inspection commands у одобрившего ревью', async () => {
  const ctx = setup({
    files: { FAIL_ON_INTEGRATION: '1\n' },
    scenario: {
      writer: implement(),
      reviewer: { ...approve(), probes: [{ gate: 'unit' }, echo('in18-green')] },
    },
    policy: (p: any) => {
      probePolicy(p);
      p.maxAttempts = 1;
    },
  });
  const before = target(ctx);
  await runAll(ctx);
  const a = attemptsOf(ctx)[0]!;
  assert.notEqual(a.status, 'succeeded');
  assert.equal(target(ctx), before, 'target не сдвинут: integration gate упал');
  const cand = reviewsOf(a).find((e) => e.phase === 'candidate')!;
  checkReview(a, cand);
  assert.equal(cand.passed, true, 'reviewer одобрил кандидата');
  assert.ok(cand.inspection!.commands.every((c) => c.status === 'passed'));
  assert.deepEqual(
    a.evidence.filter((e) => e.kind === 'test').map((e) => [e.phase, e.passed]),
    [
      ['candidate', true],
      ['integration', false],
    ],
  );
  const result = checkResult(a);
  assert.notEqual(result.outcome, 'accepted');
});

// ------------------------------------ IN19: plan/contract и сериализация

test('IN19: plan/contract review сохраняет runtime inspection с исправленным видом; ReviewRecord и run result проходят Zod и опубликованные схемы без нового поля inspection', async () => {
  // Codex: событие завершённой команды с ненулевым кодом — выполнение.
  const codex = setup({
    scenario: {
      reviewer: [
        {
          ...approve('План полон'),
          observedCommand: 'npm test -- plan',
          observedExitCode: 1,
          observedOutput: 'plan boom',
        },
        { ...approve('Контракт полон'), observedCommand: 'ls api', observedOutput: 'api.yaml' },
        approve('Без команд'),
      ],
    },
  });
  const claude = setup({ writer: 'codex', reviewer: 'claude', scenario: { reviewer: approve() } });
  const round = (
    ctx: Ctx,
    kind: 'plan' | 'contract',
    subject: string,
    c: string,
    author: 'claude' | 'codex',
  ) =>
    technicalReview(
      ctx.engine,
      ctx.policy,
      {
        codex: cliAdapter('codex', {
          executable: bin('fake-codex'),
          toolProfiles: ctx.policy.toolProfiles,
        }),
        claude: cliAdapter('claude', {
          executable: bin('fake-claude'),
          toolProfiles: ctx.policy.toolProfiles,
        }),
      },
      {
        kind,
        subject,
        digest: c.repeat(64),
        author,
        instructions: ['Review.'],
        cwd: ctx.repo.dir,
        artifactDir: join(ctx.state, 'reviews', `${kind}-${subject}-${c}`),
        denied: [ctx.state],
        meta: { subjectId: subject, subjectKind: 'other' },
      },
    );
  const cases = [
    {
      record: await round(codex, 'plan', 'g', 'a', 'claude'),
      expected: {
        mode: 'commands',
        source: 'codex-events',
        commands: [
          {
            command: 'npm test -- plan',
            exitCode: 1,
            output: 'plan boom',
            origins: [{ type: 'runtime', runtime: 'codex', item: null }],
            status: 'failed',
          },
        ],
        reason: null,
      },
    },
    {
      record: await round(codex, 'contract', 'api', 'b', 'claude'),
      expected: {
        mode: 'commands',
        source: 'codex-events',
        commands: [
          {
            command: 'ls api',
            exitCode: 0,
            output: 'api.yaml',
            origins: [{ type: 'runtime', runtime: 'codex', item: null }],
            status: 'completed',
          },
        ],
        reason: null,
      },
    },
    { record: await round(codex, 'plan', 'h', 'c', 'claude'), expected: 'diff-only/codex-events' },
    { record: await round(claude, 'plan', 'g', 'd', 'codex'), expected: 'diff-only/unavailable' },
  ];
  for (const { record, expected } of cases) {
    assert.equal(record.approved, true, record.summary);
    // Публичная запись раунда: прежняя форма, без поля inspection.
    reviewRecordSchema.parse(record);
    published('review-record', record);
    assert.equal('inspection' in record, false);
    const artifact = JSON.parse(readFileSync(record.artifact, 'utf8'));
    reviewInspectionSchema.parse(artifact.inspection);
    if (typeof expected === 'string') {
      const [mode, source] = expected.split('/');
      assert.equal(artifact.inspection.mode, mode);
      assert.equal(artifact.inspection.source, source);
      assert.deepEqual(artifact.inspection.commands, []);
      assert.ok(artifact.inspection.reason, 'diff-only с причиной');
    } else assert.deepEqual(artifact.inspection, expected);
    // Runtime inspection плана — без контекста вызова ревью кода.
    assert.equal(artifact.inspection.context, undefined);
  }
  assert.equal(reviewerCalls(codex), 3);
  assert.equal(reviewerCalls(claude, 'claude'), 1);
  assert.equal(codex.engine.reviews('plan', 'g').length, 1);
  assert.equal(codex.engine.reviews('contract', 'api').length, 1);
  // Существующий публичный путь результата ревью кода: run result валиден,
  // ссылки evidence — прежней формы (без inspection), документ состояния валиден.
  const { ctx, a } = await runCodex();
  const result = checkResult(a);
  assert.equal(result.outcome, 'accepted');
  for (const ref of result.evidence) assert.equal('inspection' in ref, false);
  assert.ok(reloaded(ctx, a));
  for (const c of [codex, claude]) assert.ok(reloadedDocument(c));
});

/** Документ состояния без попыток (только раунды ревью) — тоже проходит обе схемы. */
function reloadedDocument(ctx: Ctx) {
  const db = new DatabaseSync(join(ctx.state, 'state.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string };
    const doc = JSON.parse(row.data);
    executionDocumentSchema.parse(doc);
    published('execution-document', doc);
    return true;
  } finally {
    db.close();
  }
}
