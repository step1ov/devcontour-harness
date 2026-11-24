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
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  HarnessError,
  cliCommands,
  cliDataSchemas,
  codeReviewRecordSchema,
  digestOf,
  leadDataSchema,
  type InputQuestion,
} from '../src/contracts/index.ts';
import type { Engine } from '../src/engine/engine.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { releaseDone } from '../src/control/lead.ts';
import { reviewRelease, type ReleaseReviewInput } from '../src/control/review-release.ts';
import { releaseReviewRequired, releaseReviewState } from '../src/control/release-review-state.ts';
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
  const review = (input: ReleaseReviewInput = {}) => reviewRelease(ctx, input);
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
  assert.equal(done.warning, undefined);
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
