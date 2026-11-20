import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HarnessError,
  OPERATOR_VIEW_LIMITS as L,
  OPERATOR_VIEW_TEXT as T,
  operatorViewSchema,
} from '../src/contracts/index.ts';
import { operatorView, type OperatorViewInput } from '../src/projections/index.ts';
import { at, attempt, baseInput, policy, review, work } from './operator-view-input.ts';

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const id = (prefix: string, i: number) => `${prefix}-${String(i).padStart(4, '0')}`;
const long = (n: number) => 'ж'.repeat(n);
const sha = 'a'.repeat(40);

/** Вход, у которого каждый список на `n` записей длиннее или равен пределу. */
function full(over: number, text: (n: number) => string | undefined): OperatorViewInput {
  const works = Array.from({ length: L.works + over }, (_, i) =>
    work(id('w', i), {
      title: text(T.title + 50),
      status: 'done',
      stage: { ...work('x').stage, name: 'done', next: [], step: text(T.step + 10) },
      attemptSummary: { ...work('x').attemptSummary, line: text(T.line + 10) },
      blockers: Array.from({ length: L.blockersPerWork }, () => ({
        code: 'NOT_READY',
        plain: text(T.plain + 10),
        actor: 'controller' as const,
      })),
      dependsOn: Array.from({ length: L.dependsOn }, (_, k) => id('dep', k)),
      target: {
        repositoryId: 'app',
        ref: 'refs/heads/main',
        acceptedSha: sha,
        commitsSinceAccepted: 1,
        filesSinceAccepted: 1,
        unavailable: text(T.unavailable + 10),
      },
    }),
  );
  const findings = Array.from({ length: L.findingsPerSubject + over }, (_, k) => ({
    id: 'f'.repeat(60) + String(k).padStart(4, '0'),
    severity: 'blocking',
    status: 'open',
    rounds: 3,
    message: text(T.title + 10),
  }));
  return baseInput({
    works,
    reviews: Array.from({ length: L.reviews + over }, (_, k) =>
      review(id('subject', k), { findings, line: text(T.line + 10) }),
    ),
    questions: Array.from({ length: L.questions + over }, (_, k) => ({
      requestId: id('q', k),
      workId: id('w', k),
      state: 'awaiting-answer',
      version: 1,
      severity: 8,
      createdAt: at(k),
      text: text(T.questionTitle + 10),
      plain: text(T.questionPlain + 10),
      leadMay: false,
    })),
    stops: Array.from({ length: L.escalations + over }, (_, k) => ({
      workId: id('w', k),
      code: 'ATTEMPTS_EXHAUSTED',
      actor: 'user' as const,
      action: 'reset-attempts',
      since: at(k),
    })),
    attempts: [attempt('w-0000', 1)],
    queue: { paused: true, reason: 'runtime', detail: text(T.detail + 10) },
    warnings: Array.from({ length: L.warnings + over }, (_, k) => ({
      code: 'W' + k,
      message: text(T.message + 10) ?? 'w',
    })),
  });
}

test('view limits: наибольший документ (все списки до предела, строки максимальной длины) — VIEW_TOO_LARGE', () => {
  const input = full(0, long);
  assert.throws(
    () => operatorView(input),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'VIEW_TOO_LARGE' &&
      e.class === 'infrastructure' &&
      /больше предела 262144/.test(e.message),
  );
  // Без предела байт тот же документ проходит схему: отказ — только по размеру.
  const view = operatorView(input, { maxBytes: 64 * 1024 * 1024 });
  operatorViewSchema.parse(view);
  assert.ok(bytes(view) > L.bytes);
  // Каждая свободная строка не длиннее своего предела.
  assert.equal(view.works[0]!.title!.length, T.title);
  assert.equal(view.works[0]!.attempts.line!.length, T.line);
  assert.equal(view.questions[0]!.title!.length, T.questionTitle);
  assert.equal(view.reviews[0]!.findings[0]!.title!.length, T.title);
  assert.equal(view.progress.queue.detail!.length, T.detail);
  assert.equal(view.drift[0]!.unavailable!.length, T.unavailable);
});

const REV4_WORKS = 10;
/** Поля ревизии 4 у работы: класс отказа и где применённый ответ. */
const revision4 = (id: string) => ({
  attemptSummary: {
    ...work(id).attemptSummary,
    lastFailure: {
      runId: `${id}-r1`,
      bucket: 'environment',
      plain: 'An ordinary sentence of about sixty characters, plain words.',
      kind: 'environment',
      counted: false,
    },
  },
  input: {
    requestId: `${id}-q`,
    state: 'delivered',
    severity: 5,
    carrier: { attempt: 1, running: false },
  },
});

test('view limits: типичный документ (500 работ без заголовков, остальные списки до предела) — не больше 256 КБ', () => {
  // Строки — обычной длины (60 символов), не на пределе.
  const input = full(0, () => 'An ordinary sentence of about sixty characters, plain words.');
  // Работы — обычные (без блокировок и зависимостей), дрейф — у первых 50;
  // предметы ревью — с двумя находками: 50 × 50 находок одни дают больше 256 КБ.
  const typical = {
    ...input,
    works: input.works.map((w, k) => ({
      ...work(w.id),
      status: 'done',
      stage: { ...work(w.id).stage, name: 'done', next: [] },
      ...(k < L.drift ? { target: w.target! } : {}),
      // Ревизия 4: класс отказа последней попытки и где применённый ответ —
      // у первых 10 работ (~280 байт на работу; запас документа ~10 КБ).
      ...(k < REV4_WORKS ? revision4(w.id) : {}),
    })),
    attempts: [
      ...input.attempts,
      ...input.works.slice(0, REV4_WORKS).map((w) =>
        attempt(w.id, 1, {
          runId: `${w.id}-r1`,
          status: 'failed',
          // До окна истории: лента и ряды — уже на пределе выше.
          startedAt: at(3 * 24 * 60),
          finishedAt: at(3 * 24 * 60 - 10),
        }),
      ),
    ],
    reviews: input.reviews.map((r) => ({ ...r, findings: r.findings.slice(0, 2) })),
    warnings: input.warnings!.slice(0, 2),
    queue: {
      paused: false,
      runner: 'not-running' as const,
      restartBy: 'lead' as const,
      line: 'An ordinary sentence of about sixty characters, plain words.',
    },
  };
  const view = operatorView(typical, { titles: false });
  // Ревизия 4: прогноз и поля P1 входят в типичный документ.
  assert.ok(view.forecast);
  assert.equal(
    view.works.filter((w) => w.attempts.lastFailure?.kind === 'environment').length,
    REV4_WORKS,
  );
  assert.equal(view.works.filter((w) => w.question?.line).length, REV4_WORKS);
  operatorViewSchema.parse(view);
  assert.equal(view.works.length, L.works);
  assert.equal(view.questions.length, L.questions);
  assert.equal(view.escalations.length, L.escalations);
  assert.equal(view.drift.length, L.drift);
  assert.equal(view.reviews.length, L.reviews);
  assert.ok(bytes(view) <= L.bytes, `${bytes(view)} > ${L.bytes}`);
  assert.equal(view.truncated, undefined);
});

test('view limits: truncated считает каждый усечённый список', () => {
  const over = 3;
  const input = full(over, () => undefined);
  const small = {
    ...input,
    works: input.works.map(({ target, ...w }, k) => ({
      ...w,
      // Списки внутри работы — сверх предела только у первой.
      dependsOn: k === 0 ? Array.from({ length: L.dependsOn + over }, (_, d) => id('dep', d)) : [],
      blockers:
        k === 0
          ? Array.from({ length: L.blockersPerWork + over }, () => ({
              code: 'NOT_READY',
              actor: 'controller' as const,
            }))
          : [],
      ...(k < L.drift + over ? { target: target! } : {}),
    })),
    reviews: input.reviews.map((r, k) => ({
      ...r,
      findings: r.findings.slice(0, L.findingsPerSubject + over),
      // Эскалация с находками сверх предела — у первого предмета.
      ...(k === 0
        ? {
            escalation: {
              round: 4,
              findings: Array.from({ length: L.findingsPerSubject + over }, (_, f) => 'e' + f),
            },
          }
        : {}),
    })),
    reviewsOmitted: 2,
    policy: policy((raw) => {
      raw.roles = Object.fromEntries(
        Array.from({ length: L.roles + over }, (_, k) => [
          `role-${k}`,
          {
            writer: { runtime: 'claude' },
            review: {
              reviewer: { runtime: 'codex' },
              ...(k === 0
                ? {
                    alternates: Array.from({ length: L.alternates + over }, () => ({
                      runtime: 'claude',
                    })),
                  }
                : {}),
            },
          },
        ]),
      );
    }),
  };
  const view = operatorView(small, { titles: false, maxBytes: 64 * 1024 * 1024 });
  operatorViewSchema.parse(view);
  assert.deepEqual(view.truncated, {
    alternates: over,
    blockers: over,
    dependsOn: over,
    drift: over,
    // Остановки сверх предела и эскалация ревью первого предмета.
    escalations: over + 1,
    // Находки предметов сверх предела и находки эскалации первого предмета.
    findings: over * L.reviews + over,
    questions: over,
    reviewRules: 3 + L.roles + over - L.reviewRules,
    // Сверх предела списка и опущенные загрузчиком.
    reviews: over + 2,
    roles: over,
    warnings: over + 1,
    works: over,
  });
  assert.equal(view.health.warnings.length, L.warnings);
  assert.ok(view.health.warnings.some((w) => w.code === 'VIEW_TRUNCATED'));
  // Счётчики прогресса — по всем работам, а не по усечённому списку.
  assert.equal(view.progress.total, L.works + over);
  assert.equal(view.progress.done, L.works + over);
});
