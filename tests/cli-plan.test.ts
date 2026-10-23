/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
 * Тест читает JSON-ответы CLI как есть; их форму проверяет сам CLI схемой команды.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  API_VERSION,
  digestOf,
  executionPolicySchema,
  sha256,
  workGraphDigest,
  type ContractDocument,
} from '../src/contracts/index.ts';
import { FileContextSource } from '../src/connectors/files.ts';
import { planCheck, planRequestOf } from '../src/planning/check.ts';
import { requirementProof } from '../src/verification/proof.ts';
import { requirementSnapshot } from '../src/verification/requirements.ts';
import {
  SPEC,
  greetingDraft,
  planningProject,
  requirementsInPrompt,
  spec,
  type Cli,
  type PlanningProject,
} from './planning-fixture.ts';

/**
 * Матрица H2-01…H2-03 через настоящий CLI на копии fixture npm-приложения.
 * Тест играет ведущего агента: читает prompt plan-request, сам пишет draft и
 * проверяет его plan-check. Ответы runtime в `review-plan`/`run` — scripted
 * fixtures (`tests/fixtures/bin/fake-*`), не модель; на время планирования
 * HARNESS_CODEX_BIN/HARNESS_CLAUDE_BIN указывают на ловушки.
 */

const ok = (r: Cli, what: string) => assert.equal(r.status, 0, `${what}: ${r.stderr}${r.stdout}`);

function brief(p: PlanningProject, text = 'Implement greet(name) for the npm app.\n') {
  return p.write('greeting.brief.md', text);
}

function request(p: PlanningProject, briefPath: string) {
  const r = p.planning(
    'plan-request',
    '--brief',
    briefPath,
    '--policy',
    p.policyPath,
    '--requirements',
    SPEC,
  );
  ok(r, 'plan-request');
  return r.json.data;
}

/** Требование REQ-greet так, как его выдал plan-request (T6). */
function greetRequirement(prompt: string) {
  const [snapshot] = requirementsInPrompt(prompt);
  assert.equal(snapshot?.source, SPEC);
  const found = snapshot.requirements.find((r) => r.id === 'REQ-greet');
  assert.ok(found, 'REQ-greet в снимке prompt');
  return found;
}

function check(p: PlanningProject, draftPath: string, ...extra: string[]) {
  return p.planning('plan-check', '--draft', draftPath, '--policy', p.policyPath, ...extra);
}

/** Ответ с проблемой: указанный код, путь и exit; графа и digest нет. */
function refused(r: Cli, code: string, path: (string | number)[], exit: number) {
  assert.equal(r.status, exit, r.stderr + r.stdout);
  assert.equal(r.json.ok, true, 'ответ с проблемами — данные, не отказ команды');
  assert.equal(r.json.data.issues[0]?.code, code, JSON.stringify(r.json.data.issues));
  assert.deepEqual(r.json.data.issues[0]?.path, path);
  assert.equal(r.json.data.graph, undefined);
  assert.equal(r.json.data.graphDigest, undefined);
}

/** Факты и входы библиотеки — тем же способом, что CLI (каталог политики, контекст по умолчанию). */
async function libraryInputs(p: PlanningProject) {
  const policy = executionPolicySchema.parse(JSON.parse(readFileSync(p.policyPath, 'utf8')));
  const baseDir = dirname(p.policyPath);
  const dir = join(baseDir, 'work', 'context');
  const ids =
    existsSync(dir) && lstatSync(dir).isDirectory()
      ? readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
      : [];
  const context = ids.length ? await new FileContextSource(dir).snapshot(ids) : undefined;
  return { policy, baseDir, ...(context ? { context } : {}) };
}

test('H2-01/H2-03 route: init → plan-request → draft ведущего → plan-check → validate → review-plan → run → accepted с testcase-доказательством', () => {
  const p = planningProject();
  const briefPath = brief(p);

  // plan-request: read-only, моделей нет, state и Git не тронуты.
  const g0 = p.gitState();
  const req = request(p, briefPath);
  assert.deepEqual(p.gitState(), g0, 'plan-request не меняет рабочее дерево и refs');
  assert.equal(req.readOnly, true);
  assert.equal(req.draftSchema, 'plan-draft');
  assert.equal(req.maxTasks, 30);
  assert.match(req.basis, /^[a-f0-9]{64}$/);
  for (const fact of [
    `"repositoryId":"${p.facts.repositoryId}"`,
    `"role":"${p.facts.roles[0].id}"`,
    ...p.facts.gates.map(
      (g: { id: string; kind: string }) => `{"id":"${g.id}","kind":"${g.kind}"}`,
    ),
    `"id":"${p.facts.repositoryId}"`,
  ])
    assert.ok(req.prompt.includes(fact), `prompt содержит факт политики ${fact}`);
  assert.ok(req.prompt.endsWith('User brief:\nImplement greet(name) for the npm app.\n'));
  assert.equal(existsSync(p.state), false, 'plan-request не создаёт state');

  // Ведущий агент сам пишет draft: из prompt — требование, из facts — роль и gate.
  const requirement = greetRequirement(req.prompt);
  const snapshot = requirementSnapshot(p.app, SPEC, 'HEAD').requirements[0]!;
  assert.deepEqual(requirement, { id: snapshot.id, text: snapshot.text, digest: snapshot.digest });
  const draftPath = p.write('greeting.draft.json', greetingDraft(p.facts, requirement));

  // Ожидаемый red: base-тест greet.greets красный (fixture greet бросает).
  const report = join(p.scratch, 'base-junit.xml');
  const base = spawnSync(process.execPath, ['test/greet.test.js'], {
    cwd: p.app,
    encoding: 'utf8',
    env: { ...process.env, DEVCONTOUR_REPORT_PATH: report },
  });
  assert.equal(base.status, 1, 'base-тест красный до реализации');
  assert.match(readFileSync(report, 'utf8'), /name="greets"><failure/);

  const g1 = p.gitState();
  const checked = check(p, draftPath, '--brief', briefPath, '--basis', req.basis);
  ok(checked, 'plan-check');
  assert.deepEqual(p.gitState(), g1, 'plan-check не меняет рабочее дерево и refs');
  assert.equal(existsSync(p.state), false, 'plan-check не создаёт state и ReviewRecord');
  assert.equal(existsSync(join(p.app, '.reports')), false, 'plan-check не запускает gates');
  assert.deepEqual(p.trapCalls(), [], 'H2-03: планирование не вызвало ни одного runtime');
  const data = checked.json.data;
  assert.deepEqual(data.issues, []);
  assert.deepEqual(data.checkPlan, []);
  assert.equal(data.basis, req.basis);
  const graph = data.graph;
  assert.equal(graph.id, 'greeting', 'ID графа — имя draft без .draft.json');
  assert.equal(data.graphDigest, workGraphDigest(graph));
  assert.deepEqual(graph.source, {
    connector: 'files',
    ref: 'work/greeting.json',
    revision: req.basis,
  });
  const text = JSON.stringify(graph);
  assert.ok(!/"approved"|"status"/.test(text), 'лишние ключи draft не дошли до графа');
  const [order] = graph.orders;
  assert.equal(order.id, 'add-greeting');
  assert.deepEqual(order.writeScope, ['src']);
  assert.deepEqual(order.requirements[0], {
    id: 'REQ-greet',
    source: SPEC,
    digest: requirement.digest,
    text: requirement.text,
    gate: p.facts.gates.find((g: { kind: string }) => g.kind === 'test').id,
    scenario: 'greet("Ada") returns "Hello, Ada!"',
    testId: 'greet.greets',
  });

  // Агент сохраняет граф в рабочий каталог; дальше обычный маршрут.
  const graphPath = p.write('greeting.json', graph);
  const valid = p.harness('validate', '--graph', graphPath, '--policy', p.policyPath);
  ok(valid, 'validate');
  assert.equal(valid.json.data.graphDigest, data.graphDigest, 'сохранённый граф — тот же digest');

  const review = p.harness(
    'review-plan',
    '--graph',
    graphPath,
    '--policy',
    p.policyPath,
    '--state',
    p.state,
    '--author',
    'claude',
  );
  ok(review, 'review-plan');
  assert.equal(review.json.data.approved, true, 'fixture codex одобряет план');
  assert.equal(review.json.data.digest, data.graphDigest, 'ревью относится к графу plan-check');

  const run = p.harness(
    'run',
    '--graph',
    graphPath,
    '--policy',
    p.policyPath,
    '--state',
    p.state,
    '--author',
    'claude',
  );
  ok(run, 'run');
  const result = p.harness('result', '--state', p.state, '--work', 'add-greeting');
  ok(result, 'result');
  const accepted = p.git('rev-parse', p.facts.targetRef);
  assert.equal(result.json.data.result.outcome, 'accepted');
  assert.equal(result.json.data.result.shas.result, accepted);
  // Ловушки действительно подставлены: команда, опрашивающая runtime, их вызывает.
  assert.deepEqual(p.trapCalls(), [], 'review-plan/run шли через fixture runtime');
  p.planning('doctor', '--policy', p.policyPath);
  assert.ok(p.trapCalls().length > 0, 'doctor с теми же переменными вызвал ловушку');

  const proof = requirementProof(
    order.requirements[0],
    result.json.data.result.evidence,
    result.json.data.result.shas.result,
  );
  assert.equal(proof.level, 'testcase', proof.reason);
});

test('H2-02: неизвестные роль, gate, контракт; выдуманное и отсутствующее требование — код, путь, exit, без графа', () => {
  const p = planningProject();
  const briefPath = brief(p);
  const req = request(p, briefPath);
  const requirement = greetRequirement(req.prompt);
  const draft = (name: string, patch: (task: Record<string, any>) => void) =>
    p.write(name, greetingDraft(p.facts, requirement, patch));
  const testGate = p.facts.gates.find((g: { kind: string }) => g.kind === 'test').id;

  // Неизвестная роль.
  refused(
    check(
      p,
      draft('role.draft.json', (t) => (t.role = 'qa')),
    ),
    'INVALID_INPUT',
    ['draft', 'tasks', 0, 'role'],
    2,
  );

  // Неизвестный gate: GATE_UNKNOWN и план подготовки проверки; draft не переписан.
  const gatePath = draft('gate.draft.json', (t) => (t.gates = [testGate, 'e2e']));
  const gateBytes = readFileSync(gatePath, 'utf8');
  const gate = check(p, gatePath);
  refused(gate, 'GATE_UNKNOWN', ['draft', 'tasks', 0, 'gates', 1], 2);
  assert.deepEqual(gate.json.data.checkPlan, [
    {
      kind: 'gate-undeclared',
      taskKey: 'add-greeting',
      repositoryId: p.facts.repositoryId,
      ref: 'e2e',
      testGates: [testGate],
      action: 'declare-gate',
    },
  ]);
  assert.equal(readFileSync(gatePath, 'utf8'), gateBytes, 'gates draft не изменены');
  // Единственный gate неизвестен: ещё и в области нет test gate.
  const only = check(
    p,
    draft('only-gate.draft.json', (t) => (t.gates = ['e2e'])),
  );
  refused(only, 'GATE_UNKNOWN', ['draft', 'tasks', 0, 'gates', 0], 2);
  assert.deepEqual(
    only.json.data.checkPlan.map((g: { kind: string; action: string }) => [g.kind, g.action]),
    [
      ['gate-undeclared', 'declare-gate'],
      ['test-gate-missing', 'add-test-gate'],
    ],
  );
  assert.ok(
    only.json.data.checkPlan.every(
      (g: { testGates: string[] }) => JSON.stringify(g.testGates) === JSON.stringify([testGate]),
    ),
  );

  // Неизвестный контракт: digest не подставляется.
  const contract = check(
    p,
    draft('contract.draft.json', (t) => (t.contracts = ['greet-api'])),
  );
  refused(contract, 'INVALID_INPUT', ['draft', 'tasks', 0, 'contracts', 0], 2);
  // Тот же контракт, объявленный каталогом --contracts: digest — из фактов (review-contract).
  const doc: ContractDocument = {
    apiVersion: API_VERSION,
    id: 'greet-api',
    title: 'Greet API',
    content: 'greet(name) returns "Hello, <name>!"',
  };
  const contracts = join(p.scratch, 'contracts');
  mkdirSync(contracts);
  writeFileSync(join(contracts, 'greet-api.json'), JSON.stringify(doc));
  const known = check(p, join(p.workDir, 'contract.draft.json'), '--contracts', contracts);
  ok(known, 'plan-check с объявленным контрактом');
  assert.deepEqual(known.json.data.graph.orders[0].contracts, [
    { id: 'greet-api', digest: digestOf(doc) },
  ]);

  // Выдуманный digest требования.
  refused(
    check(
      p,
      draft('digest.draft.json', (t) => (t.requirements[0].digest = 'a'.repeat(64))),
    ),
    'INVALID_INPUT',
    ['draft', 'tasks', 0, 'requirements', 0, 'digest'],
    2,
  );

  // Требования нет в источнике на HEAD (digest согласован с текстом — выдумано целиком).
  refused(
    check(
      p,
      draft('missing.draft.json', (t) => {
        const text = '## REQ-farewell\n\nfarewell(name) says goodbye.';
        Object.assign(t.requirements[0], { id: 'REQ-farewell', text, digest: sha256(text) });
      }),
    ),
    'INVALID_INPUT',
    ['draft', 'tasks', 0, 'requirements', 0, 'id'],
    2,
  );

  // Форма draft: ошибка схемы с путём от draft.
  refused(
    check(
      p,
      draft('shape.draft.json', (t) => (t.acceptance = [])),
    ),
    'INVALID_INPUT',
    ['draft', 'tasks', 0, 'acceptance'],
    2,
  );

  // ID графа из имени файла не проходит формат ID.
  refused(
    check(p, p.write('bad id.draft.json', greetingDraft(p.facts, requirement))),
    'INVALID_INPUT',
    ['--draft'],
    2,
  );
  // --basis без --brief — неверный вход команды.
  const noBrief = check(p, join(p.workDir, 'role.draft.json'), '--basis', req.basis);
  assert.equal(noBrief.status, 2);
  assert.equal(noBrief.json.ok, false);

  assert.equal(existsSync(p.state), false, 'ни один отказ не создал state');
  assert.deepEqual(p.trapCalls(), []);
});

test('H2-02: устаревшая постановка — изменённое закоммиченное требование и brief при --basis → APPROVAL_STALE; без --basis новый revision', () => {
  const p = planningProject();
  const briefPath = brief(p);
  const req = request(p, briefPath);
  const draftPath = p.write(
    'greeting.draft.json',
    greetingDraft(p.facts, greetRequirement(req.prompt)),
  );
  const first = check(p, draftPath, '--brief', briefPath, '--basis', req.basis);
  ok(first, 'plan-check');

  // Brief изменён после plan-request.
  writeFileSync(briefPath, 'Implement greet(name) and a farewell.\n');
  refused(
    check(p, draftPath, '--brief', briefPath, '--basis', req.basis),
    'APPROVAL_STALE',
    ['--basis'],
    3,
  );
  // Без --basis: другой revision и другой graphDigest — прежнее ревью к нему не относится.
  const fresh = check(p, draftPath, '--brief', briefPath);
  ok(fresh, 'plan-check без --basis');
  assert.notEqual(fresh.json.data.basis, req.basis);
  assert.equal(fresh.json.data.graph.source.revision, fresh.json.data.basis);
  assert.notEqual(fresh.json.data.graph.source.revision, first.json.data.graph.source.revision);
  assert.notEqual(fresh.json.data.graphDigest, first.json.data.graphDigest);
  // Без --brief revision — digest draft, тоже не basis.
  const plain = check(p, draftPath);
  ok(plain, 'plan-check без --brief');
  assert.equal(plain.json.data.basis, undefined);
  assert.notEqual(plain.json.data.graphDigest, first.json.data.graphDigest);

  // Требование изменено и закоммичено: draft со старым digest устарел.
  writeFileSync(join(p.app, SPEC), spec('greet(name) returns "Hi, <name>!" for any name.'));
  p.git('commit', '-qam', 'change REQ-greet');
  refused(
    check(p, draftPath),
    'APPROVAL_STALE',
    ['draft', 'tasks', 0, 'requirements', 0, 'digest'],
    3,
  );
  // Источник не закоммичен — NOT_READY у plan-request и plan-check.
  writeFileSync(join(p.app, 'docs', 'draft-spec.md'), spec());
  const untracked = p.planning(
    'plan-request',
    '--brief',
    briefPath,
    '--policy',
    p.policyPath,
    '--requirements',
    `${p.facts.repositoryId}:docs/draft-spec.md`,
  );
  assert.equal(untracked.status, 3, untracked.stdout);
  assert.equal(untracked.json.error.code, 'NOT_READY');
  const notReady = check(
    p,
    p.write(
      'untracked.draft.json',
      greetingDraft(p.facts, greetRequirement(req.prompt), (t) => {
        t.requirements[0].source = 'docs/draft-spec.md';
      }),
    ),
  );
  refused(notReady, 'NOT_READY', ['draft', 'tasks', 0, 'requirements', 0, 'source'], 3);
  assert.deepEqual(p.trapCalls(), []);
});

test('H2-01: данные CLI plan-request/plan-check равны библиотечным planRequestOf/planCheck', async () => {
  const p = planningProject();
  const briefPath = brief(p);
  const req = request(p, briefPath);
  const requirement = greetRequirement(req.prompt);
  const inputs = await libraryInputs(p);
  const briefText = readFileSync(briefPath, 'utf8');
  assert.deepEqual(
    planRequestOf({
      ...inputs,
      brief: briefText,
      requirementSources: [{ repositoryId: p.facts.repositoryId, source: SPEC }],
    }),
    req,
  );
  const human = p.planning(
    'plan-request',
    '--brief',
    briefPath,
    '--policy',
    p.policyPath,
    '--requirements',
    SPEC,
    '--human',
  );
  ok(human, 'plan-request --human');
  assert.equal(human.stdout, req.prompt + '\n');

  for (const [name, patch] of [
    ['greeting.draft.json', () => {}],
    ['role.draft.json', (t: Record<string, any>) => (t.role = 'qa')],
    ['gate.draft.json', (t: Record<string, any>) => (t.gates = ['e2e'])],
  ] as const) {
    const draft = greetingDraft(p.facts, requirement, patch);
    const path = p.write(name, draft);
    const cli = check(p, path, '--brief', briefPath, '--basis', req.basis);
    assert.deepEqual(
      planCheck({
        ...inputs,
        draft,
        graphId: name.replace(/\.draft\.json$/, ''),
        brief: briefText,
        basis: req.basis,
      }),
      cli.json.data,
      name,
    );
  }
  assert.deepEqual(p.trapCalls(), []);
});

test('H2-02: нечитаемые входы plan-request — INVALID_INPUT, exit 2, а не INTERNAL', () => {
  const p = planningProject();
  const briefPath = brief(p);
  for (const [args, path] of [
    [['--contracts', join(p.scratch, 'no-such-dir')], '--contracts'],
    [['--requirements', '/etc/passwd'], '--requirements'],
    [['--requirements', '../outside.md'], '--requirements'],
  ] as const) {
    const r = p.planning('plan-request', '--brief', briefPath, '--policy', p.policyPath, ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.json.error.code, 'INVALID_INPUT', args.join(' '));
    assert.equal(r.json.error.issues[0].path[0], path);
  }
});
