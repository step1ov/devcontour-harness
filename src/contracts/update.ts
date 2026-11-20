import { z } from 'zod';
import { isoTimeSchema } from './primitives.ts';

/**
 * Обновление harness и панели (`harness update`, 0.1.0-alpha.60).
 *
 * Движок не ходит в сеть во время работы: реестр npm спрашивает только явная
 * команда `harness update` (через npm, с его registry, proxy и ключами), без
 * телеметрии. Обновление ставится только когда нет прогона, всегда с копией
 * состояния и автоматическим откатом при сбое; смена форматов договоров
 * (`stateVersion`, `policyVersion`, …) никогда не ставится автоматически.
 */

/** Режим обновлений проекта: ставить самому, только сообщать, выключено. */
export const updateModes = ['auto', 'notify', 'off'] as const;
export type UpdateMode = (typeof updateModes)[number];

/**
 * Пределы режима `auto`: `same-formats` — пара harness+панель, у которой
 * форматы договоров прежние; `ui-only` — автоматически только панель,
 * harness — сообщением.
 */
export const updateAutoScopes = ['same-formats', 'ui-only'] as const;

/** `.harness/updates.json`: настройка обновлений проекта (меняется навыком или руками). */
export const updatesConfigSchema = z.strictObject({
  mode: z.enum(updateModes).default('notify'),
  /** dist-tag npm, с которого берутся версии (по умолчанию `alpha`). */
  channel: z
    .string()
    .regex(/^[a-z][a-z0-9._-]{0,40}$/, 'dist-tag npm: строчные буквы, цифры, . _ -')
    .default('alpha'),
  autoScope: z.enum(updateAutoScopes).default('same-formats'),
  /** Реестр вместо настроенного в npm (`npm config get registry`). */
  registry: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .optional(),
});
export type UpdatesConfig = z.output<typeof updatesConfigSchema>;

/**
 * Мажорные форматы договоров пакета (поле `devcontourHarness.formats`
 * package.json): смена любого — обновление с миграцией или новым договором.
 */
export const packageFormatsSchema = z.strictObject({
  api: z.string().min(1).max(100),
  state: z.number().int().positive(),
  policy: z.number().int().positive(),
  handoff: z.number().int().positive(),
  report: z.number().int().positive(),
  view: z.number().int().positive(),
});
export type PackageFormats = z.output<typeof packageFormatsSchema>;

const version = z.string().min(1).max(100);
export const updatePairSchema = z.strictObject({
  harness: version,
  ui: version.optional(),
});
export type UpdatePair = z.output<typeof updatePairSchema>;

/**
 * Исход проверки: `up-to-date` — новее ничего; `available` — пара в
 * пределах прежних форматов; `needs-decision` — смена форматов или
 * неизвестные форматы (только решением владельца); `unavailable` — реестр
 * недоступен или ответ не прочитан.
 */
export const updateCheckStates = [
  'up-to-date',
  'available',
  'needs-decision',
  'unavailable',
] as const;

export const updateCheckSchema = z.strictObject({
  checkedAt: isoTimeSchema,
  state: z.enum(updateCheckStates),
  mode: z.enum(updateModes),
  channel: z.string().min(1).max(50),
  current: updatePairSchema,
  available: updatePairSchema.optional(),
  /** Смены форматов `имя: было → станет`; `unknown` — у версии нет сведений о форматах. */
  formatChanges: z.array(z.string().max(200)).max(10).optional(),
  /** «Что нового» простыми словами: заголовки заметок выпуска между версиями. */
  whatsNew: z.array(z.string().max(300)).max(20).optional(),
  /** Почему панель не обновляется вместе с harness (нет совместимой версии). */
  note: z.string().max(500).optional(),
  /** Одна строка для человека. */
  line: z.string().min(1).max(300),
  /** Команда, которой ставится найденная пара. */
  command: z.string().max(500).optional(),
  error: z.string().max(500).optional(),
});
export type UpdateCheck = z.output<typeof updateCheckSchema>;

/** Исход `--apply` / `--rollback`. */
export const updateOutcomes = [
  'applied',
  'up-to-date',
  'busy',
  'needs-decision',
  'unavailable',
  'restored',
  'restore-failed',
  'rolled-back',
  'nothing-to-roll-back',
  'skipped',
] as const;

export const updateStepSchema = z.strictObject({
  step: z.string().min(1).max(60),
  ok: z.boolean(),
  detail: z.string().max(1000).optional(),
});

export const updateDataSchema = z.strictObject({
  action: z.enum(['check', 'apply', 'rollback', 'schedule', 'mode']),
  /** Настройка после `--mode`. */
  config: updatesConfigSchema.optional(),
  check: updateCheckSchema.optional(),
  outcome: z.enum(updateOutcomes).optional(),
  from: updatePairSchema.optional(),
  to: updatePairSchema.optional(),
  /** Шаги применения или отката по порядку. */
  steps: z.array(updateStepSchema).max(40).optional(),
  /** Копия каталога состояния: путь и SHA-256 её списка файлов. */
  stateCopy: z.strictObject({ path: z.string(), digest: z.string() }).optional(),
  /** Что с панелью: перезапущена, не запущена или как перезапустить. */
  panel: z.string().max(1000).optional(),
  /** Расписание: файл задания или инструкция для этой ОС. */
  schedule: z
    .strictObject({
      enabled: z.boolean(),
      file: z.string().optional(),
      instructions: z.string().max(4000).optional(),
    })
    .optional(),
  line: z.string().min(1).max(500),
});
export type UpdateData = z.output<typeof updateDataSchema>;

/** Запись журнала обновлений (`<state>-updates/journal.jsonl`) и события `harness.updated`. */
export const updateRecordActions = ['applied', 'restored', 'rolled-back'] as const;
