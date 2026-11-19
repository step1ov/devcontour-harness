import { z } from 'zod';
import { idSchema, isoTimeSchema, runtimeNameSchema } from './primitives.ts';

/**
 * Что проверено у поручения и как (`status`, `explain`, `result`, `report`):
 * строка на gate или ревью попытки и сводная строка. Литералы повторяют
 * `src/report/verification.ts` (модуль без zod); тест сверяет поэлементно.
 *
 * - `result`: `passed`/`failed` — исход записи, `reused` — запись интеграции
 *   взята из записи кандидата при том же дереве, `skipped` — обязательный
 *   gate закончившейся попытки без записи, `not-applicable` — gate с
 *   `when.paths` не исполнялся: diff его не задел;
 * - `how`: `executed-by-harness` — команду gate запустил harness,
 *   `reused-evidence` — взята прежняя запись, `read-by-reviewer` — агент
 *   прочитал diff и ничего не запускал, `not-run` — не исполнялось.
 */
export const verificationResults = [
  'passed',
  'failed',
  'reused',
  'skipped',
  'not-applicable',
] as const;
export const verificationHows = [
  'executed-by-harness',
  'reused-evidence',
  'read-by-reviewer',
  'not-run',
] as const;
/** Предел строк `rows`: остальные — числом `rowsTruncated`. */
export const VERIFICATION_ROWS = 40;
/** Предел строк `rows` у поручения отчёта (`report`). */
export const VERIFICATION_REPORT_ROWS = 6;
/** Предел сводной строки у поручения отчёта. */
export const VERIFICATION_REPORT_LINE = 500;

export const verificationRowSchema = z.strictObject({
  /** ID gate (команды нет); у ревью — ID записи ревью (`independent-review`). */
  gate: z.string().min(1).max(200),
  kind: z.enum(['gate', 'review']),
  phase: z.enum(['candidate', 'integration']),
  /** Проверка потребителя: компонент, в дереве которого она выполнена. */
  consumer: idSchema.optional(),
  result: z.enum(verificationResults),
  how: z.enum(verificationHows),
  /** Время записи; нет — записи нет (`skipped`). */
  at: isoTimeSchema.optional(),
  /** Только у ревью: runtime и вендор reviewer. */
  reviewer: z
    .strictObject({ runtime: runtimeNameSchema, vendor: z.string().min(1).max(40) })
    .optional(),
});

export const workVerificationSchema = z.strictObject({
  /** Попытка, чьи записи показаны: принявшая у принятого, иначе последняя. */
  runId: z.string().min(1).max(200),
  rows: z.array(verificationRowSchema).max(VERIFICATION_ROWS),
  rowsTruncated: z.number().int().positive().optional(),
  /**
   * Одна строка: «Проверено harness (запущено): …; ревью: прочитал агент
   * <vendor> (<runtime>), только diff, ничего не запускал — одобрил; не
   * проверялось: …» — и английская (`lineEn`).
   */
  line: z.string().max(1000),
  lineEn: z.string().max(1000),
});
export type WorkVerificationView = z.infer<typeof workVerificationSchema>;
