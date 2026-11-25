/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тест правит JSON политики примера как есть; форму проверяет схема политики.
 */
/**
 * 0.1.0-alpha.69, P7-6: ревью выпуска (`harness review-release`) перед
 * `release done`. Reviewer — fixture executable (fake-codex), не живая
 * модель; работы принимаются движком напрямую, цель — настоящий git-репозиторий.
 * Проверяется: договор выпуска в запросе (постановки и критерии, ответы
 * владельца, топология с head), запись `kind: release`, раунды с переходами
 * находок, отказ `release done` без ревью / на прежней цели / с блокирующей
 * находкой, проход после одобренного ревью, рекомендательный режим и
 * умолчания режимов.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  HarnessError,
  cliCommands,
  cliDataSchemas,
  codeReviewRecordSchema,
  digestOf,
  gateDigest,
  sha256,
  API_VERSION,
  WORKSPACE_OWNER,
  leadDataSchema,
  type InputQuestion,
  type WorkState,
} from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { releaseDone } from '../src/control/lead.ts';
import { FAILURE_PATHS_RELEASE_TEXT } from '../src/engine/prompt.ts';
import {
  releaseBaseOf,
  briefMissingLine,
  releaseContract,
  RELEASE_CONTRACT_LIMIT,
  RELEASE_TOPOLOGY_FILE_LIMIT,
  reviewRelease,
  type ReleaseReviewInput,
} from '../src/control/review-release.ts';
import {
  fullGatesProblem,
  recordGatesRun,
  releaseGatesProblems,
} from '../src/control/release-gates.ts';
import { checkGates } from '../src/control/gates-check.ts';
import { releaseReviewRequired, releaseReviewState } from '../src/control/release-review-state.ts';
import { releaseDocsLine, releaseDocsState } from '../src/control/release-docs.ts';
import { engineOf, graphOf, policyOf, ready } from './engine-fixture.ts';
import { bin } from './runner-fixture.ts';
import { junit } from './git-fixture.ts';
import { finding, recordedPrompt, verdict } from './review-fixture.ts';

const CADDY = 'example.com {\n  reverse_proxy /api/* api:3000\n}\n';

function fixture(patch: (p: Record<string, any>) => void = () => {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-review-release-')));
  const app = join(root, 'app');
  mkdirSync(app);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: app,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(app, file)), { recursive: true });
      writeFileSync(join(app, file), text);
    }
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  const base = commit({ 'README.md': 'app\n' }, 'init');
  const head = commit(
    {
      'deploy/Caddyfile': CADDY,
      'src/media.js': 'exports.mediaUrl = (id) => "http://localhost:3000/media/" + id;\n',
    },
    'media',
  );
  const scenarioPath = join(root, 'scenario.json');
  const scenario = (s: unknown) => writeFileSync(scenarioPath, JSON.stringify(s));
  scenario({ reviewer: { ...verdict(true), recordPrompt: true } });
  const policy = policyOf((p: Record<string, any>) => {
    p.repositories[0].path = app;
    p.isolation = { mode: 'none', domains: [] };
    p.environment = { values: { FIXTURE_SCENARIO: scenarioPath } };
    p.release = { review: 'required', topology: ['deploy/Caddyfile', 'deploy/prod.env'] };
    // Gate unit проходит на любом SHA: полный прогон gates цели — настоящий.
    p.repositories[0].gates[0].command = [
      process.execPath,
      '-e',
      junit('<testcase classname="app" name="ok"/>'),
    ];
    patch(p);
  });
  const targetRef = policy.repositories[0]!.targetRef;
  git('update-ref', targetRef, head);
  const state = join(root, 'state');
  mkdirSync(state);
  const env = engineOf(policy, state);
  const ctx = {
    engine: env.engine,
    policy,
    adapters: {
      codex: cliAdapter('codex', {
        executable: bin('fake-codex'),
        toolProfiles: policy.toolProfiles,
      }),
      claude: cliAdapter('claude', {
        executable: bin('fake-claude'),
        toolProfiles: policy.toolProfiles,
      }),
    },
    stateDir: state,
    repoPath: (path: string) => path,
  };
  // Полный прогон gates на цели (alpha.71): здесь не предмет — исполняется
  // тем же путём, что у harness gates и review-release, и записывается в
  // состояние (ревью B2 M4).
  const fullGates = async (sha: string) =>
    recordGatesRun(
      env.engine,
      policy,
      await checkGates({
        policy,
        baseDir: '',
        repoPath: (r) => r.path,
        stateDir: state,
        repositoryId: 'app',
        rev: sha,
      }),
    );
  // review-release сам исполняет полный прогон, когда годного нет.
  const review = (input: ReleaseReviewInput = {}) => reviewRelease(ctx, input);
  const reviewBare = (input: ReleaseReviewInput = {}) => reviewRelease(ctx, input);
  const heads = () => ({ app: git('rev-parse', targetRef) });
  return {
    ...env,
    policy,
    app,
    git,
    commit,
    base,
    head,
    targetRef,
    scenario,
    scenarioPath,
    review,
    reviewBare,
    fullGates,
    state,
    heads,
  };
}

/** Принять текущую попытку работы на `sha` (обе фазы с PASS gate и ревью). */
function accept(e: Engine, base: string, sha: string) {
  const a = e.claim('c1')!;
  e.phase(a.id, a.token, 'running', { baseSha: base });
  e.phase(a.id, a.token, 'verifying', { candidateSha: sha });
  for (const phase of ['candidate', 'integration'] as const) {
    if (phase === 'integration') e.phase(a.id, a.token, 'integrating', { integrationSha: sha });
    for (const kind of ['test', 'review'] as const)
      e.evidence(a.id, a.token, {
        kind,
        phase,
        sha,
        gate: kind === 'test' ? 'unit' : 'independent-review',
        passed: true,
        command: ['x'],
        exitCode: 0,
        log: '',
        digest: digestOf(kind + phase),
        summary: 'ok',
        ...(kind === 'review' ? { findings: [] } : {}),
      });
  }
  e.finish(a.id, a.token, sha);
}

const question: InputQuestion = {
  question: 'Через какой адрес отдавать медиа в production?',
  options: [
    { id: 'gateway', label: 'Через шлюз /media', consequence: null, forUser: null },
    { id: 'direct', label: 'Напрямую с порта API', consequence: null, forUser: null },
  ],
  recommended: 'gateway',
  severity: 8,
  rationale: 'Адрес видят пользователи',
  affects: [],
};

const notReady = (fn: () => unknown, pattern: RegExp) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HarnessError, String(e));
    assert.equal(e.code, 'NOT_READY');
    assert.match(e.message, pattern);
    return true;
  });

test('P7-6: review-release — договор выпуска в запросе: постановки и критерии, ответы владельца, топология с head; запись kind release', async () => {
  const f = fixture();
  ready(f.engine, graphOf({ w: [] }));
  // Попытка остановилась вопросом; владелец ответил.
  const a = f.engine.claim('c1')!;
  f.engine.phase(a.id, a.token, 'running', { baseSha: f.base });
  f.engine.fail(a.id, a.token, 'вопрос', {
    kind: 'needs-input',
    input: {
      question: { question, effectiveSeverity: 8, floors: [], mode: 'request' },
      assumptions: [],
      followUps: [],
      criticalHits: [],
      callId: 'call-1',
    },
  });
  const [request] = f.engine.inputRequests({ workId: 'w' });
  f.engine.answerInput(
    request!.id,
    { text: 'Только через шлюз Caddy: /media/*', optionId: 'gateway', actor: { kind: 'operator' } },
    1,
  );
  // Без --base: база — самой ранней попытки репозитория; head — target ref.
  const rec = await f.review();
  codeReviewRecordSchema.parse(rec);
  assert.equal(rec.kind, 'release');
  assert.equal(rec.acceptance, false);
  assert.equal(rec.round, 1);
  assert.equal(rec.approved, true);
  assert.equal(rec.base, f.base);
  assert.equal(rec.head, f.head);
  assert.equal(rec.refs.head, f.targetRef);
  assert.equal(rec.authorRuntime, 'claude');
  assert.equal(rec.reviewerRuntime, 'codex');
  assert.ok(rec.contextDigest);
  assert.match(rec.id, /^RR-/);
  const prompt = recordedPrompt(f.scenarioPath, 'reviewer', 0);
  assert.match(prompt, /RELEASE CONTRACT/);
  // A2: чеклист сбойных путей в ревью выпуска.
  assert.ok(prompt.includes(FAILURE_PATHS_RELEASE_TEXT), 'чеклист сбойных путей');
  // (a) постановки и критерии приёмки
  assert.match(prompt, /Add a greeting function/);
  assert.match(prompt, /greet\('Ada'\) returns 'Hello, Ada!'/);
  // (b) ответы владельца
  assert.match(prompt, /Через какой адрес отдавать медиа в production\?/);
  assert.match(prompt, /Только через шлюз Caddy: \/media\/\*/);
  // (c) топология: содержимое с head и отсутствующий файл назван
  assert.ok(prompt.includes(CADDY), 'Caddyfile с head в запросе');
  assert.match(prompt, /deploy\/prod\.env: MISSING at head/);
  assert.match(prompt, /production gateway/);
  // (d) diff base..head
  assert.match(prompt, /\+exports\.mediaUrl/);
  // Тот же head и договор, уже одобренные, — тот же раунд без вызова.
  const again = await f.review();
  assert.equal(again.id, rec.id);
  // Новый ответ меняет договор — новый раунд.
  f.engine.answerInput(
    request!.id,
    { text: 'Через шлюз, путь /files/*', optionId: 'gateway', actor: { kind: 'operator' } },
    f.engine.inputRequest(request!.id).version,
  );
  const next = await f.review();
  assert.equal(next.round, 2);
  assert.notEqual(next.contextDigest, rec.contextDigest);
  // Без попыток в состоянии и без --base — отказ.
  const empty = fixture();
  await assert.rejects(empty.review(), /назовите --base/);
});

test('P7-6: release done при required — отказ без ревью, с блокирующей находкой и на прежней цели; проход после одобренного ревью на текущей цели', async () => {
  const f = fixture();
  ready(f.engine, graphOf({ w: [] }));
  accept(f.engine, f.base, f.head);
  notReady(
    () =>
      releaseDone(f.engine, { summary: 'готово', heads: f.heads(), fullGates: { app: undefined } }),
    /ревью выпуска не проводилось.*harness review-release/,
  );
  assert.equal(
    releaseReviewState(
      f.engine.read((v) => v),
      f.policy,
      f.heads(),
    ).status,
    'not-run',
  );
  // Раунд 1: блокирующая находка о маршруте медиа.
  f.scenario({
    reviewer: verdict(false, {
      findings: [finding('Медиа не проходит через Caddy: /media/* → 404 в production')],
    }),
  });
  const r1 = await f.review();
  assert.equal(r1.kind, 'release');
  assert.equal(r1.approved, false);
  const blocking = r1.findings[0]!;
  notReady(
    () =>
      releaseDone(f.engine, { summary: 'готово', heads: f.heads(), fullGates: { app: undefined } }),
    /не одобрено: открытых находок 1, блокирующих 1.*Открытых находок: 1/,
  );
  const findings = f.engine.read((v) => releaseReviewState(v, f.policy, f.heads()));
  assert.deepEqual(
    {
      status: findings.status,
      round: findings.round,
      open: findings.open,
      blocking: findings.blocking,
    },
    { status: 'findings', round: 1, open: 1, blocking: 1 },
  );
  // Исправление — новая принятая цель: прежнее ревью устарело.
  const fixed = f.commit(
    { 'deploy/Caddyfile': CADDY + 'handle /media/* { reverse_proxy api:3000 }\n' },
    'fix',
  );
  f.git('update-ref', f.targetRef, fixed);
  const stale = f.engine.read((v) => releaseReviewState(v, f.policy, f.heads()));
  assert.equal(stale.status, 'stale');
  assert.equal(stale.head, f.head);
  assert.equal(stale.target, fixed);
  notReady(
    () =>
      releaseDone(f.engine, { summary: 'готово', heads: f.heads(), fullGates: { app: undefined } }),
    /раунд 1\) на [0-9a-f]{12}, а принятая цель — [0-9a-f]{12}/,
  );
  // Раунд 2 на новой цели: прежняя находка закрыта, одна заметка — не блокирует.
  f.scenario({
    reviewer: verdict(true, {
      previous: [{ id: blocking.id, status: 'closed', basis: 'Caddy маршрутизирует /media/*' }],
      findings: [finding('Стоит добавить кэш для /media', 'note')],
    }),
  });
  const r2 = await f.review();
  assert.equal(r2.round, 2);
  assert.equal(r2.subject, r1.subject, 'предмет — база выпуска, не head');
  assert.equal(r2.head, fixed);
  assert.equal(r2.approved, true);
  assert.equal(r2.findings.find((x) => x.id === blocking.id)?.status, 'closed');
  const done = leadDataSchema.parse(
    releaseDone(f.engine, {
      summary: 'Выпуск готов',
      heads: f.heads(),
      fullGates: { app: undefined },
    }),
  );
  assert.equal(done.release?.works, 1);
  // Шаг документации по умолчанию — совет (alpha.70): предупреждение, не отказ.
  assert.match(done.warning ?? '', /нет работы с меткой docs/);
  assert.equal(done.releaseReview?.status, 'approved');
  assert.equal(done.releaseReview?.required, true);
  assert.deepEqual(done.releaseReview?.notes, ['Стоит добавить кэш для /media']);
  assert.match(done.line, /Ревью выпуска одобрено; неблокирующих замечаний 1/);
});

test('P7-6: advisory — release done проходит с предупреждением; без поля release — required в обоих режимах', () => {
  const f = fixture((p) => {
    p.release = { review: 'advisory' };
  });
  ready(f.engine, graphOf({ w: [] }));
  accept(f.engine, f.base, f.head);
  const done = leadDataSchema.parse(
    releaseDone(f.engine, { summary: 'готово', heads: f.heads(), fullGates: { app: undefined } }),
  );
  assert.equal(done.release?.works, 1);
  assert.equal(done.releaseReview?.required, false);
  assert.equal(done.releaseReview?.status, 'not-run');
  assert.match(
    done.warning ?? '',
    /не пройдено.*ревью выпуска не проводилось.*harness review-release/,
  );
  assert.match(done.line, /Ревью выпуска не пройдено/);

  // Строгий режим (пример тестов) без поля release — тоже обязательная
  // приёмка (решение владельца: P7-6 прошёл и в строгом режиме).
  const strict = fixture((p) => {
    delete p.release;
  });
  assert.equal(strict.policy.harnessMode, 'strict');
  ready(strict.engine, graphOf({ w: [] }));
  accept(strict.engine, strict.base, strict.head);
  assert.throws(
    () => releaseDone(strict.engine, { summary: 'готово', fullGates: { app: undefined } }),
    (e: unknown) => e instanceof HarnessError && e.code === 'NOT_READY',
  );

  assert.equal(releaseReviewRequired({}), true, 'нет harnessMode — light — required');
  assert.equal(releaseReviewRequired({ harnessMode: 'light' }), true);
  assert.equal(releaseReviewRequired({ harnessMode: 'strict' }), true);
  assert.equal(
    releaseReviewRequired({ harnessMode: 'strict', release: { review: 'required' } }),
    true,
  );
  assert.equal(
    releaseReviewRequired({ harnessMode: 'light', release: { review: 'advisory' } }),
    false,
  );

  // Облегчённый режим без поля release: отказ без ревью.
  const light = fixture((p) => {
    delete p.release;
    p.harnessMode = 'light';
  });
  ready(light.engine, graphOf({ w: [] }));
  accept(light.engine, light.base, light.head);
  notReady(
    () =>
      releaseDone(light.engine, {
        summary: 'готово',
        heads: light.heads(),
        fullGates: { app: undefined },
      }),
    /harness review-release/,
  );
});

test('P7-6: CLI review-release — договор команды и данные', () => {
  const c = cliCommands['review-release'];
  assert.equal(c.writes, true);
  assert.deepEqual(
    c.args.map((a) => [a.name, a.required]),
    [
      ['--state', true],
      ['--policy', false],
      ['--base', false],
      ['--head', false],
      ['--role', false],
      ['--author', false],
      ['--repository', false],
    ],
  );
  assert.equal(cliDataSchemas['review-release'], codeReviewRecordSchema);
  assert.match(cliCommands['release-done'].description, /harness review-release/);
});

test('база выпуска: записана при регистрации или плане выпуска, не переписывается до release done; без записи — ранняя попытка', () => {
  const f = fixture((p) => {
    p.release = { review: 'advisory' };
  });
  ready(f.engine, graphOf({ w: [] }));
  accept(f.engine, f.base, f.head);
  // Прежнее состояние без записи: база — ранняя попытка.
  const legacy = f.engine.read((v) => releaseReviewState(v, f.policy));
  assert.equal(legacy.base, f.base);
  assert.equal(legacy.baseSource, 'attempt');
  // Записанная база главнее и не переписывается в том же выпуске.
  const other = f.commit({ 'x.txt': 'x\n' }, 'other');
  assert.deepEqual(f.engine.recordReleaseBases({ app: f.head }, 'register'), ['app']);
  assert.deepEqual(f.engine.recordReleaseBases({ app: other }, 'outline'), []);
  const recorded = f.engine.read((v) => releaseReviewState(v, f.policy));
  assert.equal(recorded.base, f.head);
  assert.equal(recorded.baseSource, 'register');
  // Новый выпуск (после release done) записывает новую базу.
  f.clock.now += 1000;
  releaseDone(f.engine, { summary: 'готово', heads: f.heads(), fullGates: { app: undefined } });
  f.clock.now += 1000;
  assert.deepEqual(f.engine.recordReleaseBases({ app: other }, 'outline'), ['app']);
  assert.equal(f.engine.read((v) => releaseReviewState(v, f.policy)).baseSource, 'outline');
});

test('ревью выпуска — только от базы выпуска и по нынешнему договору; цель не определена — отказ; выпуск без изменений проверяется', async () => {
  const f = fixture();
  ready(f.engine, graphOf({ w: [] }));
  accept(f.engine, f.base, f.head);
  f.engine.recordReleaseBases({ app: f.base }, 'register');
  // Сужённое ревью: --base не база выпуска — выпуск не принимает.
  const narrowed = f.commit({ 'x.txt': 'x\n' }, 'narrow');
  f.git('update-ref', f.targetRef, narrowed);
  const head = narrowed;
  f.scenario({ reviewer: verdict(true) });
  await f.review({ base: f.head });
  let state = f.engine.read((v) => releaseReviewState(v, f.policy, { app: head }));
  assert.equal(state.status, 'stale');
  assert.equal(state.repositories[0]!.staleReason, 'base-mismatch');
  notReady(
    () =>
      releaseDone(f.engine, {
        summary: 'готово',
        heads: { app: head },
        fullGates: { app: undefined },
      }),
    /не от базы выпуска/,
  );
  // Ревью от базы выпуска одобрено; договор изменился (ответ владельца) — снова нет.
  await f.review();
  const before = {
    app: (await releaseContract({ engine: f.engine, policy: f.policy }, 'app', f.app, head)).digest,
  };
  state = f.engine.read((v) =>
    releaseReviewState(v, f.policy, { app: head }, { strict: true, contracts: before }),
  );
  assert.equal(state.status, 'approved');
  notReady(
    () =>
      releaseDone(f.engine, {
        summary: 'готово',
        heads: { app: head },
        contracts: { app: 'changed-contract' },
        fullGates: { app: undefined },
      }),
    /договор выпуска изменился/,
  );
  // Цель не определена (target ref не читается) — выпуск не закрывается.
  notReady(
    () =>
      releaseDone(f.engine, {
        summary: 'готово',
        heads: {},
        contracts: before,
        fullGates: { app: undefined },
      }),
    /принятая цель не определена/,
  );
  // Выпуск без изменений: база = цель, ревью идёт с пустым diff.
  const g = fixture();
  ready(g.engine, graphOf({ w: [] }));
  accept(g.engine, g.base, g.head);
  g.scenario({ reviewer: { ...verdict(true), recordPrompt: true } });
  const empty = await g.review({ base: g.head });
  assert.equal(empty.approved, true);
  assert.equal(empty.filesTotal, 0);
  assert.match(
    recordedPrompt(g.scenarioPath, 'reviewer', 0),
    /There are no changes between the release base/,
  );
});

test('выпуск, начатый до alpha.69: база — самая ранняя попытка после прежнего итога, а не нынешняя цель', () => {
  const f = fixture();
  ready(f.engine, graphOf({ w: [] }));
  accept(f.engine, f.base, f.head);
  const later = f.commit({ 'y.txt': 'y\n' }, 'later');
  // Регистрация нового графа того же выпуска: нынешняя цель — later.
  assert.deepEqual(
    f.engine.recordReleaseBases({ app: later }, 'register', {
      app: f.engine.read((v) => releaseBaseOf(v, 'app')),
    }),
    ['app'],
  );
  const state = f.engine.read((v) => releaseReviewState(v, f.policy));
  assert.equal(state.base, f.base);
  assert.equal(state.baseSource, 'attempt');
});

test('digest договора выпуска — по полному тексту: правка за пределом обрезки запроса делает раунд устаревшим', async () => {
  const f = fixture();
  ready(f.engine, graphOf({ w: [] }));
  accept(f.engine, f.base, f.head);
  const long = 'x'.repeat(RELEASE_TOPOLOGY_FILE_LIMIT + 100);
  const a = f.commit({ 'deploy/Caddyfile': long + 'A\n' }, 'a');
  const b = f.commit({ 'deploy/Caddyfile': long + 'B\n' }, 'b');
  const ctx = { engine: f.engine, policy: f.policy };
  const ca = await releaseContract(ctx, 'app', f.app, a);
  const cb = await releaseContract(ctx, 'app', f.app, b);
  assert.equal(ca.prompt, cb.prompt, 'в запросе правка за пределом не видна');
  assert.notEqual(ca.digest, cb.digest, 'но договор — другой');
  // Раунд по договору A на той же цели с договором B выпуск не принимает.
  f.git('update-ref', f.targetRef, a);
  f.scenario({ reviewer: verdict(true) });
  await f.review();
  const state = f.engine.read((v) =>
    releaseReviewState(v, f.policy, { app: a }, { strict: true, contracts: { app: cb.digest } }),
  );
  assert.equal(state.repositories[0]!.staleReason, 'contract-changed');
  const ok = f.engine.read((v) =>
    releaseReviewState(v, f.policy, { app: a }, { strict: true, contracts: { app: ca.digest } }),
  );
  assert.equal(ok.status, 'approved');
});

test('alpha.70: приёмка выпуска — второй проход по умолчанию always: опровергнутая находка снята, пропущенная — держит; off — один проход', async () => {
  const f = fixture();
  ready(f.engine, graphOf({ w: [] }));
  accept(f.engine, f.base, f.head);
  f.scenario({
    reviewer: verdict(false, { findings: [finding('Медиа не через Caddy')] }),
    refuter: {
      result: {
        summary: 'неверно',
        verdicts: [{ index: 0, verdict: 'refuted', basis: 'Caddyfile проксирует /media/* на api' }],
        missed: [],
      },
    },
  });
  const r1 = await f.review();
  assert.equal(r1.approved, true);
  assert.equal(r1.passes?.mode, 'always');
  assert.equal(r1.passes?.status, 'ran');
  assert.equal(r1.passes?.overturned, true);
  assert.deepEqual(r1.findings, []);
  assert.equal(codeReviewRecordSchema.safeParse(r1).success, true);

  const g = fixture();
  ready(g.engine, graphOf({ w: [] }));
  accept(g.engine, g.base, g.head);
  g.scenario({
    reviewer: verdict(true),
    refuter: {
      result: {
        summary: 'пропущено',
        verdicts: [],
        missed: [
          {
            message: 'prod.env без MEDIA_URL',
            path: 'deploy/prod.env',
            line: null,
            rule: null,
            evidence: null,
          },
        ],
      },
    },
  });
  const r2 = await g.review();
  assert.equal(r2.approved, false);
  assert.equal(r2.passes?.missed, 1);
  assert.equal(r2.findings[0]?.message, 'prod.env без MEDIA_URL');

  const h = fixture((p) => (p.review.passes = { release: 'off' }));
  ready(h.engine, graphOf({ w: [] }));
  accept(h.engine, h.base, h.head);
  h.scenario({ reviewer: verdict(false, { findings: [finding('Медиа не через Caddy')] }) });
  const r3 = await h.review();
  assert.equal(r3.approved, false);
  assert.equal(r3.passes, undefined);
});

test('alpha.70: шаг документации выпуска — корни, работа docs после них; required — review-release без неё отказывает', async () => {
  const states = (graph: ReturnType<typeof graphOf>, docs?: 'required' | 'advisory' | 'off') =>
    releaseDocsState(
      {
        works: () =>
          graph.orders.map((order) => ({ id: order.id, status: 'ready', order }) as WorkState),
      },
      { release: docs ? { docs } : {} },
    );
  const g = graphOf({ api: [], ui: ['api'], cli: [] });
  assert.deepEqual(states(g).roots, ['cli', 'ui']);
  assert.equal(states(g).status, 'missing');
  assert.equal(states(g).mode, 'advisory');
  assert.equal(states(g, 'off').status, 'off');
  const withDocs = graphOf({ api: [], ui: ['api'], cli: [], docs: ['ui'] });
  withDocs.orders[3]!.labels = ['docs'];
  assert.equal(states(withDocs).status, 'not-after-roots');
  assert.deepEqual(states(withDocs).missingRoots, ['cli']);
  withDocs.orders[3]!.dependsOn = ['ui', 'cli'];
  assert.equal(states(withDocs).status, 'pending');
  assert.match(releaseDocsLine(states(withDocs)) ?? '', /docs ещё не принята/);

  const f = fixture((p) => (p.release.docs = 'required'));
  ready(f.engine, graphOf({ w: [] }));
  accept(f.engine, f.base, f.head);
  f.scenario({ reviewer: verdict(true) });
  await assert.rejects(f.review(), (e: unknown) => {
    assert.ok(e instanceof HarnessError);
    assert.equal(e.code, 'NOT_READY');
    assert.match(e.message, /нет работы с меткой docs после корневых работ \(w\)/);
    return true;
  });
});

test('ревью 1: отказ приёмки выпуска без блокирующих находок второй проход (always) не снимает', async () => {
  const f = fixture();
  ready(f.engine, graphOf({ w: [] }));
  accept(f.engine, f.base, f.head);
  f.scenario({
    reviewer: verdict(false, { findings: [finding('Не проверить маршрут /media', 'note')] }),
    refuter: { result: { summary: 'нечего опровергать', verdicts: [], missed: [] } },
  });
  const r = await f.review();
  assert.equal(r.approved, false);
  assert.equal(r.passes?.status, 'ran');
  assert.equal(r.passes?.overturned, false);
});

test('ревью 1: release.docs: required держит release done и при review: advisory; advisory — предупреждение; следующий выпуск — свои корни', () => {
  const f = fixture((p) => (p.release = { review: 'advisory', docs: 'required' }));
  ready(f.engine, graphOf({ w: [] }));
  accept(f.engine, f.base, f.head);
  notReady(
    () =>
      releaseDone(f.engine, { summary: 'готово', heads: f.heads(), fullGates: { app: undefined } }),
    /нет работы с меткой docs после корневых работ \(w\).*release\.docs: required/,
  );
  const g = fixture((p) => (p.release = { review: 'advisory', docs: 'advisory' }));
  ready(g.engine, graphOf({ w: [] }));
  accept(g.engine, g.base, g.head);
  const done = leadDataSchema.parse(
    releaseDone(g.engine, { summary: 'готово', heads: g.heads(), fullGates: { app: undefined } }),
  );
  assert.match(done.warning ?? '', /нет работы с меткой docs.*release\.docs: advisory/);
  // Второй выпуск: принятая в первом w не корень нового выпуска.
  const next = graphOf({ w: [], w2: [], d2: ['w2'] }, '2');
  next.orders[2]!.labels = ['docs'];
  ready(g.engine, next);
  const state = g.engine.read((v) => releaseDocsState(v, { release: { docs: 'advisory' } }));
  assert.deepEqual(state.roots, ['w2']);
  assert.equal(state.status, 'pending');
});

test('ревью 2: второй проход приёмки выпуска, изменивший своё дерево, не принимается — действует первый', async () => {
  const f = fixture();
  ready(f.engine, graphOf({ w: [] }));
  accept(f.engine, f.base, f.head);
  f.scenario({
    reviewer: verdict(false, { findings: [finding('Медиа не через Caddy')] }),
    refuter: {
      files: { 'deploy/Caddyfile': 'handle /media/* { reverse_proxy api:3000 }\n' },
      result: {
        summary: 'после правки маршрут есть',
        verdicts: [{ index: 0, verdict: 'refuted', basis: 'Caddyfile проксирует /media/*' }],
        missed: [],
      },
    },
  });
  const r = await f.review();
  assert.equal(r.approved, false);
  assert.equal(r.passes?.status, 'failed');
  assert.match(r.passes?.reason ?? '', /изменил своё дерево/);
  assert.equal(r.findings.length, 1);
});

test('ревью 3: отмена во время второго прохода — деревья обоих проходов убраны', async () => {
  const f = fixture();
  ready(f.engine, graphOf({ w: [] }));
  accept(f.engine, f.base, f.head);
  f.scenario({
    reviewer: verdict(false, { findings: [finding('Медиа не через Caddy')] }),
    refuter: { sleepMs: 5000, result: { summary: 'x', verdicts: [], missed: [] } },
  });
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 1500);
  await assert.rejects(f.review({ signal: abort.signal }));
  assert.ok(
    existsSync(`${f.scenarioPath}.refuter.0.started`),
    'отмена пришла во время второго прохода',
  );
  const trees = f
    .git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '));
  assert.equal(trees.length, 1, trees.join('\n'));
});

test('ревью B, страховка выпуска: review-release исполняет полный прогон сам и отказывает при провале; годен только прогон из состояния под нынешним основанием; release done без него — отказ', async () => {
  // Gate unit падает на цели: review-release исполняет все gates и отказывает.
  const failing = fixture(
    (p) => (p.repositories[0].gates[0].command = [process.execPath, '-e', 'process.exit(1)']),
  );
  ready(failing.engine, graphOf({ a: [] }));
  accept(failing.engine, failing.base, failing.head);
  await assert.rejects(
    () => failing.reviewBare(),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'NOT_READY' &&
      /полный прогон gates app .* не прошёл: unit/.test(e.message),
  );
  const f = fixture();
  ready(f.engine, graphOf({ a: [] }));
  accept(f.engine, f.base, f.head);
  const repo = f.policy.repositories[0]!;
  const problem = (policy = f.policy) =>
    f.engine.read((v) =>
      fullGatesProblem(v, f.state, policy, policy.repositories[0]!, f.head, f.engine.version),
    );
  // Итог, написанный руками, без записи в состоянии — не прогон.
  const forged = join(f.state, 'gates-at', 'GA-forged');
  mkdirSync(forged, { recursive: true });
  writeFileSync(
    join(forged, 'result.json'),
    JSON.stringify({
      at: new Date().toISOString(),
      data: {
        id: 'GA-forged',
        repositoryId: 'app',
        sha: f.head,
        passed: true,
        gates: [{ gate: 'unit', status: 'passed', definition: gateDigest(repo.gates[0]!) }],
      },
    }),
  );
  assert.match(problem() ?? '', /нет полного прогона gates app/);
  // review-release сам исполняет и записывает прогон; ревью идёт.
  const record = await f.reviewBare();
  assert.equal(record.kind, 'release');
  assert.equal(problem(), undefined);
  // Основание gate сменилось (окружение) — прогон устарел.
  const moved = {
    ...f.policy,
    environment: {
      inherit: [],
      secrets: {},
      ...f.policy.environment,
      values: { ...f.policy.environment?.values, NEW: '1' },
    },
  };
  assert.match(problem(moved) ?? '', /устарел: основание gate unit/);
  // Подменённый файл итога записанного прогона — не годен.
  const runs = f.engine.read((v) => v.local('gates-runs', WORKSPACE_OWNER, `app@${f.head}`)!.runs);
  const file = join(f.state, 'gates-at', runs.at(-1)!.id, 'result.json');
  writeFileSync(file, readFileSync(file, 'utf8') + ' ');
  assert.match(problem() ?? '', /не совпадает с записью состояния/);
  // release done: причина полного прогона — отказ при любом правиле ревью.
  notReady(
    () =>
      releaseDone(f.engine, {
        summary: 'готово',
        heads: f.heads(),
        fullGates: { app: 'нет полного прогона gates app' },
      }),
    /нет полного прогона gates app/,
  );
  // Ревью B2 L1: репозиторий с принятыми работами без проверки — отказ.
  notReady(
    () => releaseDone(f.engine, { summary: 'готово', heads: f.heads(), fullGates: {} }),
    /полный прогон gates app не проверен/,
  );
  // Ревью B2 M2: цель не читается — причина с ходом при любом правиле ревью.
  const problems = f.engine.read((v) =>
    releaseGatesProblems(v, f.state, f.policy, {}, new Set(['app']), f.engine.version),
  );
  assert.match(problems.app ?? '', /не читается — полный прогон gates на ней не проверить/);
  notReady(
    () => releaseDone(f.engine, { summary: 'готово', heads: f.heads(), fullGates: problems }),
    /не читается/,
  );
});

test('A1: договор выпуска содержит постановку графа и документы-ответы владельца из закреплённого контекста; смена постановки меняет digest', async () => {
  const f = fixture();
  ready(f.engine, graphOf({ a: [] }));
  const ctxOf = { engine: f.engine, policy: f.policy };
  const before = await releaseContract(ctxOf, 'app', f.app, f.head);
  assert.match(before.prompt, /\(c\) Briefs: none recorded/);
  assert.match(before.prompt, /\(d\) Owner answer documents: none pinned/);
  const brief =
    'Каталог чая с фото. Загрузка фото может оборваться — повтор не должен удалять снимки.';
  assert.equal(f.engine.recordBrief('g1', brief), true);
  assert.equal(f.engine.recordBrief('g1', brief), false, 'та же постановка — без записи');
  // Документ-ответ владельца в закреплённом контексте попытки.
  const pinned = (path: string, data: string) => ({
    path,
    digest: sha256(data),
    bytes: Buffer.byteLength(data),
    content: { encoding: 'utf8' as const, data },
  });
  const answer =
    '# Вопрос: адрес медиа\n\n## Вопрос\nКак отдавать медиа?\n\n## Ответ\nЧерез шлюз /media.\n';
  const question = '# Вопрос: цвет\n\n## Вопрос\nКакой цвет?\n\n## Ответ\n\n## Варианты\n- синий\n';
  const snapshot = {
    apiVersion: API_VERSION,
    sources: [
      {
        id: 'relay-a',
        kind: 'relay-task',
        version: '1',
        required: true,
        files: [pinned('documents/DOC-1.md', answer), pinned('documents/DOC-2.md', question)],
        references: [],
        digest: 'a'.repeat(64),
      },
    ],
    missing: [],
  };
  f.store.transact('run.phase', (tx) => {
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, 'c'.repeat(64), snapshot);
    const a = tx.attempts()[0];
    if (a) tx.putAttempt({ ...a, contextSnapshot: 'c'.repeat(64) });
  });
  if (!f.engine.read((v) => v.attempts().length)) {
    const a = f.engine.claim('c1')!;
    f.store.transact('run.phase', (tx) =>
      tx.putAttempt({ ...tx.attempt(a.id)!, contextSnapshot: 'c'.repeat(64) }),
    );
  }
  const after = await releaseContract(ctxOf, 'app', f.app, f.head);
  assert.ok(after.prompt.includes(brief), 'постановка в договоре');
  assert.ok(after.prompt.includes('Через шлюз /media.'), 'документ-ответ в договоре');
  assert.ok(!after.prompt.includes('Какой цвет?'), 'вопрос без ответа — не ответ');
  assert.notEqual(after.digest, before.digest);
  // Новая редакция постановки — другой digest договора (раунд устаревает).
  f.engine.recordBrief('g1', brief + ' И офлайн-загрузка не роняет экран.');
  const changed = await releaseContract(ctxOf, 'app', f.app, f.head);
  assert.notEqual(changed.digest, after.digest);
  assert.match(changed.prompt, /офлайн-загрузка/);
});

test('A1 (Relay): документ-постановка из закреплённого контекста — в разделе постановок; без постановки — BRIEF_MISSING', async () => {
  const f = fixture();
  ready(f.engine, graphOf({ a: [] }));
  const ctxOf = { engine: f.engine, policy: f.policy };
  // Ни .brief.md, ни документа-постановки: заметка BRIEF_MISSING.
  assert.match(f.engine.read((v) => briefMissingLine(v)) ?? '', /^BRIEF_MISSING: /);
  assert.match((await releaseContract(ctxOf, 'app', f.app, f.head)).prompt, /BRIEF_MISSING/);
  const pinned = (path: string, data: string) => ({
    path,
    digest: sha256(data),
    bytes: Buffer.byteLength(data),
    content: { encoding: 'utf8' as const, data },
  });
  const brief = '# Каталог чая\n\nЗагрузка фото, оборвавшаяся посреди, не должна удалять снимки.\n';
  const other = '# Заметки дизайнера\n\nЦвета.\n';
  const provenance = JSON.stringify({
    documents: [
      { id: 'DOC-1', key: 'DOC-1', name: 'Исходная постановка', included: 'full', required: true },
      { id: 'DOC-2', key: 'DOC-2', name: 'Заметки', included: 'full', required: false },
    ],
  });
  const snapshot = {
    apiVersion: API_VERSION,
    sources: [
      {
        id: 'relay-a',
        kind: 'relay-task',
        version: '1',
        required: true,
        files: [pinned('documents/DOC-1.md', brief), pinned('documents/DOC-2.md', other)],
        references: [pinned('references/provenance.json', provenance)],
        digest: 'a'.repeat(64),
      },
    ],
    missing: [],
  };
  const a = f.engine.claim('c1')!;
  f.store.transact('run.phase', (tx) => {
    tx.putLocal('context-snapshots', WORKSPACE_OWNER, 'c'.repeat(64), snapshot);
    tx.putAttempt({ ...tx.attempt(a.id)!, contextSnapshot: 'c'.repeat(64) });
  });
  assert.equal(
    f.engine.read((v) => briefMissingLine(v)),
    undefined,
  );
  const contract = await releaseContract(ctxOf, 'app', f.app, f.head);
  assert.match(contract.prompt, /\(c\) Briefs of the release[\s\S]*relay-a\/documents\/DOC-1\.md/);
  assert.ok(contract.prompt.includes('не должна удалять снимки'));
  assert.ok(
    !contract.prompt.includes('Заметки дизайнера'),
    'необязательный документ — не постановка',
  );
  assert.doesNotMatch(contract.prompt, /BRIEF_MISSING/);
});

test('ревью A1 M2, L2: большая постановка обрезается в своём пределе — топология и её проверка в запросе целиком; правка за обрезкой меняет digest', async () => {
  const f = fixture();
  ready(f.engine, graphOf({ a: [] }));
  const ctxOf = { engine: f.engine, policy: f.policy };
  const big = 'Сценарий. '.repeat(70_000);
  f.engine.recordBrief('g1', big + 'конец A');
  const one = await releaseContract(ctxOf, 'app', f.app, f.head);
  assert.match(one.prompt, /\[обрезано: \d+ символов\]/);
  assert.ok(one.prompt.length < RELEASE_CONTRACT_LIMIT + 1000);
  assert.ok(one.prompt.includes('--- deploy/Caddyfile\n' + CADDY), 'топология целиком');
  assert.match(one.prompt, /Topology check: compare the production routing/);
  assert.match(one.prompt, /\(f\) The diff base\.\.head follows\.$/);
  // Правка за пределом обрезки и записи (512 KiB) — другой digest договора.
  f.engine.recordBrief('g1', big + 'конец B');
  const two = await releaseContract(ctxOf, 'app', f.app, f.head);
  assert.notEqual(two.digest, one.digest);
});

test('ревью final M3: отказ review-release по виду провала — код (работой, when.always), инструмент (среда), отмена (повторить, без записи)', async () => {
  const refusal = async (
    patch: (p: Record<string, any>) => void,
    input: (f: ReturnType<typeof fixture>) => ReleaseReviewInput = () => ({}),
  ) => {
    const f = fixture(patch);
    ready(f.engine, graphOf({ a: [] }));
    accept(f.engine, f.base, f.head);
    let message = '';
    await f.reviewBare(input(f)).catch((e: unknown) => {
      assert.ok(e instanceof HarnessError && e.code === 'NOT_READY', String(e));
      message = e.message;
    });
    const runs = f.engine.read(
      (v) => v.local('gates-runs', WORKSPACE_OWNER, `app@${f.head}`)?.runs,
    );
    return { message, runs };
  };
  const code = await refusal(
    (p) => (p.repositories[0].gates[0].command = [process.execPath, '-e', 'process.exit(1)']),
  );
  assert.match(code.message, /провал кода \(unit\) исправьте обычной работой/);
  assert.match(code.message, /"when": \{"always": true\}/);
  assert.doesNotMatch(code.message, /исправьте окружение/);
  const tool = await refusal(
    (p) => (p.repositories[0].gates[0].command = ['sh', '-c', 'harness-no-such-tool-xyz --run']),
  );
  assert.match(tool.message, /\[среда: [a-z-]+\]/, tool.message);
  assert.match(tool.message, /исправьте окружение или определение gate и повторите harness gates/);
  assert.doesNotMatch(tool.message, /провал кода/);
  const abort = new AbortController();
  setTimeout(() => abort.abort(new Error('отменено')), 400);
  const cancelled = await refusal(
    (p) =>
      (p.repositories[0].gates[0].command = [
        process.execPath,
        '-e',
        'setTimeout(() => {}, 20000)',
      ]),
    () => ({ signal: abort.signal }),
  );
  assert.match(cancelled.message, /прерван .* это не провал кода: повторите review-release/);
  assert.equal(cancelled.runs, undefined, 'прерванный прогон не записан');
});
