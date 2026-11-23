import { z } from 'zod';
import { isoTimeSchema } from './primitives.ts';

/**
 * Ход настройки harness (alpha.67, docs/infra-works.md «Бюджет настройки»):
 * шаги по порядку — профиль стека, `harness init`, doctor, smoke окружения,
 * проба исполнителя, gates на HEAD, связка с источником задач — с состоянием,
 * временем записи и длительностью, и мягкий бюджет времени настройки.
 */
export const setupStepIds = [
  'profile',
  'init',
  'doctor',
  'smoke',
  'probe',
  'gates',
  'connector',
] as const;
export type SetupStepId = (typeof setupStepIds)[number];
/**
 * Состояние шага: `done`, `failed`, `pending` (ещё не сделан), `skipped` (не
 * нужен: связки нет — задачи из файлов графа), `unknown` (итог не
 * записывается: doctor только читает; запись smoke до alpha.67).
 */
export const setupStepStates = ['done', 'failed', 'pending', 'skipped', 'unknown'] as const;

/** Мягкий бюджет настройки по умолчанию: 30 минут. */
export const SETUP_BUDGET_MS = 30 * 60_000;

export const setupStepSchema = z.strictObject({
  id: z.enum(setupStepIds),
  state: z.enum(setupStepStates),
  /** Время последней записи шага. */
  at: isoTimeSchema.optional(),
  /** Длительность последнего прохода шага (smoke, gates), если записана. */
  elapsedMs: z.number().int().min(0).optional(),
  line: z.string().min(1).max(300),
  lineEn: z.string().min(1).max(300),
});
export type SetupStep = z.infer<typeof setupStepSchema>;

export const setupProgressSchema = z.strictObject({
  /** Начало настройки: самая ранняя запись (файлы `.harness/`, первый smoke или gates). */
  since: isoTimeSchema.optional(),
  elapsedMs: z.number().int().min(0).optional(),
  budgetMs: z.number().int().positive(),
  /** Настройка идёт дольше бюджета: код инфраструктуры — работами `infra` плана. */
  overBudget: z.boolean(),
  steps: z.array(setupStepSchema).max(setupStepIds.length),
  line: z.string().min(1).max(500),
  lineEn: z.string().min(1).max(500),
});
export type SetupProgress = z.infer<typeof setupProgressSchema>;
