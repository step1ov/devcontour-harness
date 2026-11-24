// Двухпроходное ревью (0.1.0-alpha.70): «подозрение → опровержение».
//
// Первый проход — обычное независимое ревью. Когда он отклоняет результат
// (`on-reject`) или всегда (`always`), второй вызов reviewer в свежей сессии
// пытается опровергнуть каждую блокирующую находку первого прохода:
// подтверждённые остаются, опровергнутые снимаются с записанным основанием.
// В режиме `always` второй проход проверяет и одобрение: он может назвать
// блокирующую находку, которую первый пропустил. Настраивает ведущий
// (техническое правило ревью); кто решает — прежнее.

import { z } from 'zod';
import { FINDING_BASIS_PATTERN } from './review.ts';
import { workLabelSchema } from './primitives.ts';

export const reviewPassModes = ['off', 'on-reject', 'always'] as const;
export const reviewPassModeSchema = z.enum(reviewPassModes);
export type ReviewPassMode = (typeof reviewPassModes)[number];

/** Метки работ, для которых по умолчанию второй проход — всегда. */
export const SENSITIVE_WORK_LABELS = ['security', 'payments', 'auth'] as const;

/**
 * `review.passes` политики. Строка — режим ревью кода попыток; объект —
 * по видам: `code` (попытки, умолчание `on-reject`), `release` (приёмка
 * выпуска, умолчание `always`), `sensitive` (работы с метками
 * `sensitiveLabels`, умолчание `always`). Нет поля — умолчания; поле не
 * входит в `executionDigest`: это надзор ревью, не условие исполнения кода.
 */
export const reviewPassesPolicySchema = z.union([
  reviewPassModeSchema,
  z.strictObject({
    code: reviewPassModeSchema.optional(),
    release: reviewPassModeSchema.optional(),
    sensitive: reviewPassModeSchema.optional(),
    sensitiveLabels: z.array(workLabelSchema).max(20).optional(),
  }),
]);
export type ReviewPassesPolicy = z.infer<typeof reviewPassesPolicySchema>;

export interface ReviewPassChoice {
  mode: ReviewPassMode;
  /** Откуда режим: поле политики или умолчание; `sensitive` — по метке работы. */
  source: 'policy' | 'default';
  sensitive?: string;
}

/** Действующий режим второго прохода для ревью кода попытки или приёмки выпуска. */
export function reviewPassModeOf(
  passes: ReviewPassesPolicy | undefined,
  subject: { kind: 'code' | 'release'; labels?: readonly string[] },
): ReviewPassChoice {
  const object = typeof passes === 'object' ? passes : undefined;
  if (subject.kind === 'release')
    return object?.release
      ? { mode: object.release, source: 'policy' }
      : { mode: 'always', source: 'default' };
  const labels: readonly string[] = object?.sensitiveLabels ?? SENSITIVE_WORK_LABELS;
  const sensitive = subject.labels?.find((l) => labels.includes(l));
  if (sensitive)
    return object?.sensitive
      ? { mode: object.sensitive, source: 'policy', sensitive }
      : { mode: 'always', source: 'default', sensitive };
  if (typeof passes === 'string') return { mode: passes, source: 'policy' };
  return object?.code
    ? { mode: object.code, source: 'policy' }
    : { mode: 'on-reject', source: 'default' };
}

/** Нужен ли второй проход по итогу первого. */
export function needsSecondPass(
  mode: ReviewPassMode,
  first: { approved: boolean; blocking: number },
): boolean {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return !first.approved && first.blocking > 0;
}

const basis = z.string().regex(new RegExp(FINDING_BASIS_PATTERN), 'Основание пусто');

/**
 * Ответ второго прохода: вердикт по каждой блокирующей находке первого
 * (`index` — номер в списке, который дал controller) и, только в режиме
 * `always`, пропущенные блокирующие находки. Находка без вердикта —
 * подтверждена (безопасная сторона).
 */
export const refuteResultSchema = z.object({
  summary: z.string().max(12000),
  verdicts: z
    .array(
      z.object({
        index: z.number().int().min(0),
        verdict: z.enum(['confirmed', 'refuted']),
        basis,
      }),
    )
    .max(500),
  missed: z
    .array(
      z.object({
        message: z.string().min(3).max(12000),
        path: z.string().max(500).nullable().optional(),
        line: z.number().int().positive().nullable().optional(),
        rule: z.string().max(200).nullable().optional(),
        evidence: z.string().max(4000).nullable().optional(),
      }),
    )
    .max(50)
    .default([]),
});
export type RefuteResult = z.infer<typeof refuteResultSchema>;

/**
 * Итог второго прохода в evidence ревью (`EvidenceRecord.reviewPasses`).
 * `status`: `ran` — вердикт применён; `skipped` — не требовался; `failed` —
 * второй вызов не дал валидного ответа: действует вердикт первого прохода
 * (находки остаются).
 */
export const reviewPassesRecordSchema = z.strictObject({
  mode: reviewPassModeSchema,
  source: z.enum(['policy', 'default']),
  sensitive: workLabelSchema.optional(),
  status: z.enum(['ran', 'skipped', 'failed']),
  /** Блокирующих находок первого прохода. */
  first: z.number().int().min(0),
  confirmed: z.number().int().min(0),
  refuted: z
    .array(z.strictObject({ message: z.string().max(4000), basis: z.string().max(4000) }))
    .max(500),
  missed: z.number().int().min(0),
  /** Первый проход отклонил, второй снял все блокирующие находки. */
  overturned: z.boolean(),
  reason: z.string().max(1000).optional(),
  log: z.string().max(1000).optional(),
});
export type ReviewPassesRecord = z.infer<typeof reviewPassesRecordSchema>;

export interface FirstPassFinding {
  severity: 'blocking' | 'note';
  message: string;
  path?: string | null;
  line?: number | null;
  rule?: string | null;
  consequence?: string | null;
  evidence?: string | null;
}

/** Блокирующие находки первого прохода по порядку: их номера видит второй проход. */
export const blockingOf = <F extends FirstPassFinding>(findings: readonly F[]) =>
  findings.flatMap((f, i) => (f.severity === 'blocking' ? [{ index: i, finding: f }] : []));

/**
 * Слияние проходов: опровергнутые блокирующие находки снимаются, пропущенные
 * (только `always`) добавляются блокирующими. Одобрение пересчитывается:
 * нет ни одной блокирующей находки и ни одной прежней, оставшейся открытой;
 * явный отказ первого прохода снимается, только если второй опроверг все
 * его блокирующие находки (отказ без них остаётся отказом).
 */
export function mergePasses<F extends FirstPassFinding>(
  first: { approved: boolean; findings: readonly F[]; reopened: boolean },
  refute: RefuteResult,
  mode: ReviewPassMode,
): {
  findings: (F | FirstPassFinding)[];
  approved: boolean;
  refuted: { message: string; basis: string }[];
  confirmed: number;
  missed: number;
} {
  const blocking = blockingOf(first.findings);
  const verdicts = new Map<number, { verdict: 'confirmed' | 'refuted'; basis: string }>();
  for (const v of refute.verdicts)
    if (!verdicts.has(v.index) && blocking.some((b) => b.index === v.index))
      verdicts.set(v.index, v);
  const refuted: { message: string; basis: string }[] = [];
  const kept: (F | FirstPassFinding)[] = [];
  first.findings.forEach((f, i) => {
    const v = verdicts.get(i);
    if (f.severity === 'blocking' && v?.verdict === 'refuted')
      // Полный текст: вызывающий маскирует, затем обрезает (ревью alpha.70).
      refuted.push({ message: f.message, basis: v.basis.trim() });
    else kept.push(f);
  });
  const missed: FirstPassFinding[] =
    mode === 'always'
      ? refute.missed.map((m) => ({
          severity: 'blocking' as const,
          message: m.message,
          path: m.path ?? null,
          line: m.line ?? null,
          rule: m.rule ?? null,
          consequence: null,
          evidence: m.evidence ?? null,
        }))
      : [];
  const findings = [...kept, ...missed];
  const clear = !first.reopened && !findings.some((f) => f.severity === 'blocking');
  // Явный отказ первого прохода стоит, пока второй не опроверг каждую
  // блокирующую находку, которая его вызвала; отказ без блокирующих
  // находок второй проход не снимает (ревью alpha.70).
  const approved = first.approved
    ? clear
    : blocking.length > 0 && refuted.length === blocking.length && clear;
  return {
    findings,
    approved,
    refuted,
    confirmed: blocking.length - refuted.length,
    missed: missed.length,
  };
}

/** Запрос второго прохода: только находки и основание опровержения, без вердикта первого. */
export function refutePromptText(
  blocking: { index: number; finding: FirstPassFinding }[],
  mode: ReviewPassMode,
): string {
  return [
    'Second review pass (refute). A first, independent review pass of this exact commit raised the blocking findings listed below. Your job is to try to REFUTE each one against the code, the diff, the acceptance criteria and the gate evidence: a finding is refuted only when you can show concretely (file, line, behaviour, test) that it is wrong, already handled, or outside the approved acceptance criteria. Otherwise it is confirmed. Do not soften a real defect; a missing acceptance criterion or a weakened test is always confirmed.',
    'Return one entry in `verdicts` per finding with its exact `index`, `verdict` (confirmed | refuted) and a concrete `basis`. A finding without a verdict counts as confirmed.',
    mode === 'always'
      ? 'This work requires two passes on every review: also check the commit yourself and list in `missed` any blocking defect the first pass did not report (concrete path, line and evidence). Leave `missed` empty when there is none.'
      : 'Return `missed` as an empty list.',
    'Blocking findings of the first pass:\n' +
      JSON.stringify(
        blocking.map((b) => ({
          index: b.index,
          message: b.finding.message,
          path: b.finding.path ?? null,
          line: b.finding.line ?? null,
          rule: b.finding.rule ?? null,
          evidence: b.finding.evidence ?? null,
        })),
      ),
  ].join('\n\n');
}
