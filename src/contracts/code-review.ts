import { z } from 'zod';
import { reviewPassesRecordSchema } from './review-passes.ts';
import {
  authorSchema,
  digestSchema,
  gitShaSchema,
  idSchema,
  isoTimeSchema,
  runtimeNameSchema,
} from './primitives.ts';
import { reviewFindingSchema } from './review.ts';

/**
 * Gates, исполненные `harness gates --sha` на проверяемом коммите: итог,
 * найденный в каталоге состояния (`gates-at/<id>/result.json`). Это
 * наблюдение controller, приложенное к ревью, а не новое исполнение.
 */
export const codeReviewGatesSchema = z.strictObject({
  /** ID проверки `harness gates` (каталог `gates-at/<id>`). */
  id: z.string().min(1).max(200),
  sha: gitShaSchema,
  passed: z.boolean(),
  /** Время записи итога проверки. */
  at: isoTimeSchema,
  gates: z
    .array(
      z.strictObject({
        gate: z.string().min(1).max(200),
        status: z.enum(['passed', 'failed', 'cancelled', 'not-run', 'skipped']),
      }),
    )
    .max(200),
  logs: z.string().max(1000),
});
export type CodeReviewGates = z.infer<typeof codeReviewGatesSchema>;

/**
 * Технический обзор уже написанной ветки (`harness review-code`): reviewer
 * читает diff `mergeBase..head` в отдельном рабочем дереве на `head`, только
 * чтение. Запись — наблюдение, а не приёмка: `acceptance` всегда `false`,
 * target ref не меняется, поручений и попыток нет. Поля находок и reviewer —
 * те же, что у раунда ревью плана и контракта (`reviewRecordSchema`).
 *
 * `kind: release` (alpha.69, P7-6) — ревью выпуска (`harness review-release`):
 * та же запись в той же коллекции, предмет — репозиторий, роль и база
 * выпуска; head — принятая цель, в запросе ещё договор выпуска (`contextDigest`).
 */
export const codeReviewRecordSchema = z.strictObject({
  id: z.string().min(1).max(200),
  kind: z.enum(['code', 'release']),
  /** Запись ревью ветки не принимает работу: приёмку даёт только `harness run`. */
  acceptance: z.literal(false),
  /**
   * Предмет обзора: репозиторий, роль и названные ref (`digestOf`). Повтор по
   * тем же ref — следующий раунд: reviewer называет состояние прежних
   * открытых находок, как в ревью плана.
   */
  subject: digestSchema,
  repositoryId: idSchema,
  /** Роль, правило ревью кода которой выбрало reviewer. */
  role: idSchema,
  /** Названные ref (как переданы) и их SHA. */
  refs: z.strictObject({ base: z.string().min(1).max(500), head: z.string().min(1).max(500) }),
  base: gitShaSchema,
  head: gitShaSchema,
  /** Общий предок base и head: diff обзора — `mergeBase..head`. */
  mergeBase: gitShaSchema,
  /** Изменённые пути diff (не больше 500; `filesTotal` — всего). */
  files: z.array(z.string().max(1000)).max(500),
  filesTotal: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(),
  /** Digest diff, который получил reviewer. */
  diffDigest: digestSchema,
  /**
   * Только `kind: release`: digest договора выпуска в запросе (постановки,
   * критерии, ответы владельца, топология). Другой договор на том же head —
   * новый раунд, а не прежнее одобрение.
   */
  contextDigest: digestSchema.optional(),
  round: z.number().int().positive(),
  at: isoTimeSchema,
  approved: z.boolean(),
  summary: z.string().max(12000),
  authorRuntime: authorSchema,
  reviewerRuntime: runtimeNameSchema,
  reviewerModel: z.string().optional(),
  sameVendor: z.boolean(),
  /** Digest назначения reviewer (runtime, модель, effort, профиль, правило вендора). */
  reviewerBinding: digestSchema,
  /** Итог `harness gates --sha` на head, если он есть в каталоге состояния. */
  gates: codeReviewGatesSchema.optional(),
  /** Второй проход (0.1.0-alpha.70; приёмка выпуска — умолчание `always`). */
  passes: reviewPassesRecordSchema.optional(),
  findings: z.array(reviewFindingSchema),
  artifact: z.string().max(1000),
});
export type CodeReviewRecord = z.infer<typeof codeReviewRecordSchema>;
