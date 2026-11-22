import { z } from 'zod';
import { idSchema, isoTimeSchema } from './primitives.ts';

/**
 * Журнал ведущего (0.1.0-alpha.66, P4-10): что ведущий делает сам — своими
 * командами harness и вне его (записи в источнике задач, проверки в
 * браузере), — короткими строками простыми словами, сессия ведущего с
 * арендой (`harness lead begin|end`) и итоговый отчёт выпуска (`harness
 * release done`). Одна локальная запись `lead` у `@workspace`, ключ `log`;
 * пишут только операции журнала (`lead.recorded`), событий журнала нет.
 */
export const LEAD_LIMITS = {
  /** Символов в заметке ведущего и строке записи после очистки. */
  note: 200,
  /** Символов в итоговом отчёте выпуска. */
  summary: 2000,
  /** Записей журнала: старые вытесняются. */
  entries: 200,
  /** Аренда сессии: по умолчанию, наименьшая и наибольшая. */
  ttlDefaultMs: 30 * 60_000,
  ttlMinMs: 60_000,
  ttlMaxMs: 12 * 60 * 60_000,
} as const;

/** Вид записи: заметка, команда harness ведущего, начало и конец сессии, итог выпуска. */
export const leadEntryKinds = ['note', 'command', 'begin', 'end', 'release-done'] as const;

export const leadEntrySchema = z.strictObject({
  at: isoTimeSchema,
  kind: z.enum(leadEntryKinds),
  /** Код записи: `lead.note`, `lead.begin`, `lead.end`, `release.done`, `lead.<команда>`. */
  action: z.string().min(1).max(80),
  workId: idSchema.optional(),
  plain: z.string().min(1).max(LEAD_LIMITS.note),
  plainEn: z.string().min(1).max(LEAD_LIMITS.note).optional(),
});
export type LeadEntry = z.infer<typeof leadEntrySchema>;

export const leadLogSchema = z.strictObject({
  /** Сессия ведущего: активна, пока нет `endedAt` и `until` в будущем; продлевается записями. */
  session: z
    .strictObject({
      since: isoTimeSchema,
      until: isoTimeSchema,
      ttlMs: z.number().int().min(LEAD_LIMITS.ttlMinMs).max(LEAD_LIMITS.ttlMaxMs),
      endedAt: isoTimeSchema.optional(),
    })
    .optional(),
  entries: z.array(leadEntrySchema).max(LEAD_LIMITS.entries),
  /** Итоговый отчёт выпуска (`release done`): весь код к этому моменту принят. */
  release: z
    .strictObject({
      doneAt: isoTimeSchema,
      summary: z.string().min(1).max(LEAD_LIMITS.summary),
      works: z.number().int().min(0),
    })
    .optional(),
});
export type LeadLog = z.infer<typeof leadLogSchema>;

/** Ответ `lead-begin`, `lead-note`, `lead-end` и `release-done`. */
export const leadDataSchema = z.strictObject({
  lead: z.strictObject({
    active: z.boolean(),
    since: isoTimeSchema.optional(),
    until: isoTimeSchema.optional(),
    endedAt: isoTimeSchema.optional(),
    lastNote: z.string().min(1).max(LEAD_LIMITS.note).optional(),
  }),
  entry: leadEntrySchema.optional(),
  release: z
    .strictObject({
      doneAt: isoTimeSchema,
      summary: z.string().min(1).max(LEAD_LIMITS.summary),
      works: z.number().int().min(0),
    })
    .optional(),
  line: z.string().min(1).max(300),
});
export type LeadData = z.infer<typeof leadDataSchema>;
