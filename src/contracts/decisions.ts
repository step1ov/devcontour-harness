import { z } from 'zod';
import { decisionSettingKeys } from './decision-rules.ts';

const bilingual = z.strictObject({
  ru: z.string().min(1).max(600),
  en: z.string().min(1).max(600),
});

/**
 * Настройки решений с объяснением (docs/principles.md «Кто принимает
 * решения»): одни тексты у панели (`view.settings.decisions`), doctor и
 * status. `source` — поле политики, вывод из соседней настройки
 * (`recovery` из `inputPolicy.leadAnswers.technical`) или умолчание.
 */
export const decisionSettingsSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        key: z.enum(decisionSettingKeys),
        value: z.union([z.number(), z.boolean(), z.string().max(40)]),
        source: z.enum(['policy', 'derived', 'default']),
        explain: bilingual,
      }),
    )
    .max(10),
  /** Действующий итог одной фразой: «после 2 отказов — разбор ведущего; …; дальше — вы». */
  summary: bilingual,
  /** Необычное сочетание (`recovery.mode: lead` без `leadAnswers.technical`): допустимо, но названо. */
  warning: bilingual.optional(),
});
export type DecisionSettingsView = z.infer<typeof decisionSettingsSchema>;
