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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  HarnessError,
  cliCommands,
  cliDataSchemas,
  codeReviewRecordSchema,
  digestOf,
  gateDigest,
  leadDataSchema,
  type InputQuestion,
  type WorkState,
} from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { releaseDone } from '../src/control/lead.ts';
import {
  releaseBaseOf,
  releaseContract,
  RELEASE_TOPOLOGY_FILE_LIMIT,
  reviewRelease,
  type ReleaseReviewInput,
} from '../src/control/review-release.ts';
import { fullGatesProblem } from '../src/control/release-gates.ts';
import { releaseReviewRequired, releaseReviewState } from '../src/control/release-review-state.ts';
import { releaseDocsLine, releaseDocsState } from '../src/control/release-docs.ts';
import { engineOf, graphOf, policyOf, ready } from './engine-fixture.ts';
import { bin } from './runner-fixture.ts';
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
  // Полный прогон gates на цели (alpha.71): здесь не предмет — записан
  // проходящим итогом `harness gates`, как его оставил бы ведущий.
  let seq = 0;
  const fullGates = (sha: string, status = 'passed', definition?: string) => {
    seq += 1;
    const dir = join(state, 'gates-at', `GA-${sha.slice(0, 8)}-${seq}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'result.json'),
      JSON.stringify({
        // Каждый следующий итог позже прежнего: решает самый поздний.
        at: new Date(Date.now() + seq * 1000).toISOString(),
        data: {
          id: 'GA-' + sha.slice(0, 8),
          repositoryId: 'app',
          sha,
          passed: status === 'passed',
          gates: policy.repositories[0]!.gates.map((g) => ({
            gate: g.id,
            status,
            definition: definition ?? gateDigest(g),
          })),
        },
      }),
    );
  };
  const review = (input: ReleaseReviewInput = {}) => {
    fullGates(input.head ?? git('rev-parse', targetRef));
    return reviewRelease(ctx, input);
  };
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
    () => releaseDone(f.engine, { summary: 'готово', heads: f.heads() }),
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
    () => releaseDone(f.engine, { summary: 'готово', heads: f.heads() }),
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
    () => releaseDone(f.engine, { summary: 'готово', heads: f.heads() }),
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
    releaseDone(f.engine, { summary: 'Выпуск готов', heads: f.heads() }),
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
  const done = leadDataSchema.parse(releaseDone(f.engine, { summary: 'готово', heads: f.heads() }));
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
    () => releaseDone(strict.engine, { summary: 'готово' }),
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
    () => releaseDone(light.engine, { summary: 'готово', heads: light.heads() }),
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
  releaseDone(f.engine, { summary: 'готово', heads: f.heads() });
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
    () => releaseDone(f.engine, { summary: 'готово', heads: { app: head } }),
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
      }),
    /договор выпуска изменился/,
  );
  // Цель не определена (target ref не читается) — выпуск не закрывается.
  notReady(
    () => releaseDone(f.engine, { summary: 'готово', heads: {}, contracts: before }),
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
    () => releaseDone(f.engine, { summary: 'готово', heads: f.heads() }),
    /нет работы с меткой docs после корневых работ \(w\).*release\.docs: required/,
  );
  const g = fixture((p) => (p.release = { review: 'advisory', docs: 'advisory' }));
  ready(g.engine, graphOf({ w: [] }));
  accept(g.engine, g.base, g.head);
  const done = leadDataSchema.parse(releaseDone(g.engine, { summary: 'готово', heads: g.heads() }));
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

test('ревью B, страховка выпуска: review-release без полного прогона gates на цели исполняет его сам и отказывает при провале; устаревший — заново; release done без него — отказ', async () => {
  const f = fixture();
  ready(f.engine, graphOf({ a: [] }));
  accept(f.engine, f.base, f.head);
  // Нет итога: review-release исполняет все gates на цели; gate unit на ней падает.
  await assert.rejects(
    () => f.reviewBare(),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'NOT_READY' &&
      /полный прогон gates app .* не прошёл: unit/.test(e.message),
  );
  assert.match(fullGatesProblem(f.state, f.policy.repositories[0]!, f.head) ?? '', /не прошёл/);
  // Устаревшее определение gate — прогон не годен.
  f.fullGates(f.head, 'passed', 'f'.repeat(64));
  assert.match(fullGatesProblem(f.state, f.policy.repositories[0]!, f.head) ?? '', /устарел/);
  // Годный прогон — ревью идёт.
  f.fullGates(f.head);
  assert.equal(fullGatesProblem(f.state, f.policy.repositories[0]!, f.head), undefined);
  const record = await f.reviewBare();
  assert.equal(record.kind, 'release');
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
});
