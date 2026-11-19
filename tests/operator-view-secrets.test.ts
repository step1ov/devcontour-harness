import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { operatorViewSchema, workDetailViewSchema } from '../src/contracts/index.ts';
import { harnessView } from '../src/control/operator-view.ts';
import { maskText, operatorView, workDetailView } from '../src/projections/index.ts';
import { at, baseInput, policy, review, work } from './operator-view-input.ts';
import { viewState } from './view-fixture.ts';

const KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const GH = 'ghp_0123456789abcdefABCDEF0123456789';
const BEARER = 'eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl';
const CREDS = 'bob:hunter2pass';
const HOME = '/Users/alice';
const OTHER = '/opt/private/deploy-key.pem';
const KNOWN = 'policy-secret-value-42';
const HEX = 'deadbeef'.repeat(6);
const planted = [KEY, 'sk-ant', GH, BEARER, CREDS, 'hunter2pass', HOME, '/opt/private', KNOWN, HEX];
const dirty = (where: string) =>
  `${where}: key ${KEY} gh ${GH} auth Bearer ${BEARER} url https://${CREDS}@example.com/r.git home ${HOME}/proj/notes.txt other ${OTHER} known ${KNOWN} hex ${HEX}`;

const assertClean = (text: string) => {
  for (const p of planted) assert.ok(!text.includes(p), `в представлении осталось «${p}»`);
};

test('view secrets: каждое свободное поле маскируется до обрезки', () => {
  const input = baseInput({
    works: [
      work('a', {
        // Ключ поперёк границы обрезки заголовка (120): первые символы ключа
        // попали бы в заголовок при обрезке до маскирования.
        title: 'x'.repeat(109) + ' ' + KEY,
        stage: { ...work('a').stage, step: dirty('step') },
        attemptSummary: {
          ...work('a').attemptSummary,
          failed: 1,
          line: dirty('line'),
          lastFailure: { runId: 'a-run-1', bucket: 'environment', plain: dirty('failure') },
        },
        blockers: [{ code: 'PAUSED', plain: dirty('blocker'), actor: 'user' }],
        status: 'done',
        target: {
          repositoryId: 'app',
          ref: 'refs/heads/main',
          acceptedSha: 'a'.repeat(40),
          unavailable: dirty('git'),
        },
      }),
    ],
    attempts: [
      {
        workId: 'a',
        runId: 'a-run-1',
        attempt: 1,
        status: 'failed',
        startedAt: at(20),
        finishedAt: at(10),
        runtime: 'claude',
        stages: [{ stage: dirty('timing'), startedAt: at(20), finishedAt: at(15) }],
      },
    ],
    questions: [
      {
        requestId: 'q1',
        workId: 'a',
        state: 'awaiting-answer',
        version: 1,
        severity: 8,
        createdAt: at(5),
        text: dirty('question'),
        plain: dirty('plain'),
        leadMay: false,
      },
    ],
    reviews: [
      review('g1', {
        findings: [{ id: 'f1', severity: 'blocking', status: 'open', message: dirty('finding') }],
        line: dirty('review'),
      }),
    ],
    queue: { paused: true, reason: 'runtime', detail: dirty('attempt error') },
    warnings: [{ code: 'X', message: dirty('warning') }],
    mask: { home: HOME, roots: ['/work/checkout'], secrets: [KNOWN] },
  });
  const view = operatorView(input);
  operatorViewSchema.parse(view);
  const text = JSON.stringify(view);
  assertClean(text);
  assert.equal(view.works[0]!.title!.length <= 120, true);
  assert.ok(view.works[0]!.title!.startsWith('x'.repeat(109) + ' ‹mask'));
  assert.match(text, /‹masked›/);
  assert.match(text, /~\/proj\/notes\.txt/);
  assert.match(text, /‹path›/);
  const detail = workDetailView(input, 'a');
  workDetailViewSchema.parse(detail);
  assertClean(JSON.stringify(detail));
  for (const lang of ['ru', 'en'] as const)
    assertClean(JSON.stringify(operatorView(input, { lang })));
});

test('view secrets: маска — пути репозитория относительные, обычный текст не тронут', () => {
  const ctx = { home: '/home/bob', roots: ['/work/checkout'] };
  assert.equal(
    maskText('see /work/checkout/src/a.ts and /home/bob/x', 200, ctx),
    'see src/a.ts and ~/x',
  );
  assert.equal(
    maskText('plain words: lint, unit/e2e; 3 of 6', 200, ctx),
    'plain words: lint, unit/e2e; 3 of 6',
  );
  assert.equal(maskText('candidate-test:unit', 100, ctx), 'candidate-test:unit');
  assert.equal(maskText('token=abcd1234efgh', 200), 'token=‹masked›');
  assert.equal(maskText('C:\\Users\\bob\\key.txt', 200), '‹path›');
  // Маскирование до обрезки: префикс ключа не остаётся у границы.
  assert.equal(maskText('ab ' + KEY, 10), 'ab ‹masked');
  // Формы путей: file URI, после двоеточия, Windows с `/`, UNC.
  for (const path of [
    'file:///opt/private/k.pem',
    'path:/opt/private/k.pem',
    'C:/private/k.pem',
    '\\\\srv\\share\\k.pem',
  ])
    assert.ok(
      !maskText(path, 200)!.includes('private') && !maskText(path, 200)!.includes('share'),
      path,
    );
  // Известные значения — любой длины и в формах URI, XML и JSON.
  const known = { secrets: ['a&b-secret', '123', 'p"q-secret'] };
  for (const t of [
    'a%26b-secret',
    'a&amp;b-secret',
    'pin 123',
    JSON.stringify({ v: 'x p"q-secret' }),
  ])
    assert.ok(!/a(&|%26|&amp;)b-secret|123|q-secret/.test(maskText(t, 200, known)!), t);
});

test('view secrets: имена моделей политики маскируются до обрезки', () => {
  const p = policy((raw) => {
    (raw.roles as Record<string, { writer: Record<string, unknown> }>).developer!.writer.model =
      'x'.repeat(140) + ' ' + KEY;
    (raw.review as Record<string, { reviewer: Record<string, unknown> }>).code!.reviewer.model =
      `model-${KNOWN}`;
  });
  const view = operatorView(baseInput({ policy: p, mask: { secrets: [KNOWN] } }));
  operatorViewSchema.parse(view);
  assertClean(JSON.stringify(view));
  assert.ok(view.settings.roles[0]!.writer.model!.length <= 200);
});

test('view secrets: загрузчик маскирует заголовки и находки состояния (домашний каталог, ключ)', () => {
  const s = viewState(
    () => {},
    (input) => {
      const w = input.works[0] as { order: { title: string } };
      w.order.title = `Fix ${homedir()}/repo leak ${KEY}`.slice(0, 180);
      const r = input.reviews![0]!;
      r.findings[0]!.message = `token in https://${CREDS}@host/x and ${GH}`;
    },
  );
  const view = harnessView({
    stateDir: s.state,
    policyPath: s.policyPath,
    now: Date.parse('2026-10-08T12:00:00Z'),
  });
  const text = JSON.stringify(view);
  for (const p of [KEY, 'sk-ant', GH, CREDS, homedir()]) assert.ok(!text.includes(p), p);
  assert.match(text, /Fix ~\/repo leak ‹masked›/);
});
