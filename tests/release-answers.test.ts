import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { API_VERSION, INPUT_SOURCE_KIND, WORKSPACE_OWNER } from '../src/contracts/index.ts';
import { releaseBriefsAndAnswers } from '../src/control/review-release.ts';
import { engineOf, graphOf, ready } from './engine-fixture.ts';

/**
 * Ревью A1 (H1, M1, L1, L3): документы-ответы и постановки договора выпуска —
 * только последняя редакция, только нынешний выпуск, только свой репозиторий.
 */

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const pinned = (path: string, data: string) => ({
  path,
  digest: sha256(data),
  bytes: Buffer.byteLength(data),
  content: { encoding: 'utf8' as const, data },
});
const relay = (doc: string) => ({
  id: 'relay-a',
  kind: 'relay-task',
  version: '1',
  required: true,
  files: [pinned('documents/DOC-1.md', doc)],
  references: [],
  digest: 'a'.repeat(64),
});
const input = (revision: number, text: string) => ({
  id: 'input-r1',
  kind: INPUT_SOURCE_KIND,
  version: `r${revision}`,
  required: true,
  files: [pinned('input/r1.md', text)],
  references: [],
  digest: 'b'.repeat(64),
});
const snapshotOf = (...sources: unknown[]) => ({ apiVersion: API_VERSION, sources, missing: [] });
const answerDoc = (a: string) => `# Вопрос\n\n## Вопрос\nКак?\n\n## Ответ\n${a}\n`;

/** Две попытки работ `a`, `b` с закреплёнными снимками и заданным временем начала. */
function twoAttempts(
  pins: [
    { digest: string; at: string; snapshot: unknown },
    { digest: string; at: string; snapshot: unknown },
  ],
) {
  const env = engineOf();
  ready(env.engine, graphOf({ a: [], b: [] }));
  const ids = [env.engine.claim('c1')!.id, env.engine.claim('c1')!.id];
  env.store.transact('run.phase', (tx) => {
    pins.forEach((p, i) => {
      tx.putLocal('context-snapshots', WORKSPACE_OWNER, p.digest, p.snapshot as never);
      tx.putAttempt({ ...tx.attempt(ids[i]!)!, contextSnapshot: p.digest, startedAt: p.at });
    });
  });
  return env;
}

test('H1: пересмотренный ответ DOC-1 A→B в двух попытках — в договоре только B', () => {
  // Digest снимка новой редакции меньше прежнего: порядок по digest дал бы A.
  const env = twoAttempts([
    {
      digest: 'f'.repeat(64),
      at: '2026-01-01T00:00:00.000Z',
      snapshot: snapshotOf(relay(answerDoc('A — через API'))),
    },
    {
      digest: '1'.repeat(64),
      at: '2026-01-02T00:00:00.000Z',
      snapshot: snapshotOf(relay(answerDoc('B — через шлюз'))),
    },
  ]);
  const { answers } = env.engine.read((v) => releaseBriefsAndAnswers(v));
  assert.equal(answers.length, 1);
  assert.match(answers[0]!.text, /B — через шлюз/);
  env.store.close();
});

test('H1: input-answer r1 и r2 в разных снимках — только r2; порядок вывода по источнику', () => {
  const env = twoAttempts([
    {
      digest: 'f'.repeat(64),
      at: '2026-01-01T00:00:00.000Z',
      snapshot: snapshotOf(input(1, 'Ответ r1: синий'), relay(answerDoc('Z'))),
    },
    {
      digest: '1'.repeat(64),
      at: '2026-01-02T00:00:00.000Z',
      snapshot: snapshotOf(input(2, 'Ответ r2: зелёный')),
    },
  ]);
  const { answers } = env.engine.read((v) => releaseBriefsAndAnswers(v));
  assert.deepEqual(
    answers.map((a) => `${a.source}:${a.text}`),
    ['input-r1:Ответ r2: зелёный', `relay-a:${answerDoc('Z')}`],
  );
  env.store.close();
});

test('M1, L1: после release done — только снимки и постановки нынешнего выпуска; та же постановка записывается заново', () => {
  const env = twoAttempts([
    {
      digest: 'f'.repeat(64),
      at: '2026-01-01T00:00:00.000Z',
      snapshot: snapshotOf(relay(answerDoc('прежний выпуск'))),
    },
    {
      digest: '1'.repeat(64),
      at: '2026-01-03T00:00:00.000Z',
      snapshot: snapshotOf(input(1, 'нынешний')),
    },
  ]);
  // Согласование графа закрепило старый снимок до итога прежнего выпуска.
  env.store.transact('run.phase', (tx) => {
    const g = tx.graphs()[0]!;
    tx.putGraph({
      ...g,
      approval: {
        ...g.approval!,
        at: '2026-01-01T00:00:00.000Z',
        context: { digest: 'f'.repeat(64) },
      },
    });
  });
  assert.equal(env.engine.recordBrief('g', 'Постановка'), true);
  const doneAt = '2026-01-02T12:00:00.000Z';
  env.store.transact('run.phase', (tx) =>
    tx.putLocal('lead', WORKSPACE_OWNER, 'log', {
      entries: [],
      release: { doneAt, summary: 'прежний выпуск', works: 0 },
    }),
  );
  // Попытка 2 «нынешняя» только если позже итога.
  env.store.transact('run.phase', (tx) => {
    const a = tx.attempts().find((x) => x.contextSnapshot === '1'.repeat(64))!;
    tx.putAttempt({ ...a, startedAt: '2026-01-03T00:00:00.000Z' });
  });
  const now = env.engine.read((v) => releaseBriefsAndAnswers(v));
  assert.deepEqual(
    now.answers.map((a) => a.text),
    ['нынешний'],
    'ответ прежнего выпуска (попытка и согласование графа) не входит',
  );
  assert.equal(now.briefs.length, 0, 'постановка прежнего выпуска не входит');
  // Та же постановка при новом run после итога — постановка нынешнего выпуска.
  env.clock.now = Date.parse('2026-01-04T00:00:00.000Z');
  assert.equal(env.engine.recordBrief('g', 'Постановка'), true);
  assert.equal(env.engine.read((v) => releaseBriefsAndAnswers(v)).briefs.length, 1);
  env.store.close();
});

test('L3: постановки и ответы другого репозитория не входят; граф без работ — общий', () => {
  const env = twoAttempts([
    {
      digest: 'f'.repeat(64),
      at: '2026-01-01T00:00:00.000Z',
      snapshot: snapshotOf(relay(answerDoc('app'))),
    },
    {
      digest: '1'.repeat(64),
      at: '2026-01-02T00:00:00.000Z',
      snapshot: snapshotOf(input(1, 'тоже app')),
    },
  ]);
  env.engine.recordBrief('g', 'Постановка app');
  env.engine.recordBrief('global', 'Общая постановка');
  const app = env.engine.read((v) => releaseBriefsAndAnswers(v, 'app'));
  const other = env.engine.read((v) => releaseBriefsAndAnswers(v, 'web'));
  assert.equal(app.answers.length, 2);
  assert.equal(app.briefs.length, 2);
  assert.equal(other.answers.length, 0, 'попытки app — не материал web');
  assert.deepEqual(
    other.briefs.map((b) => b.graph),
    ['global'],
  );
  env.store.close();
});
