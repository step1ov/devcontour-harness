import { z } from 'zod';
import { gitShaSchema, idSchema, isoTimeSchema } from './primitives.ts';

/**
 * Принятая версия поручения против текущего target ref (`status`, `result`,
 * `report`): коммиты и файлы после приёмки этим принятием не проверены.
 * `unavailable` — git не ответил (нет репозитория, ref или коммита).
 */
export const acceptedTargetSchema = z.strictObject({
  repositoryId: idSchema,
  ref: z.string().min(1).max(500),
  acceptedSha: gitShaSchema,
  head: gitShaSchema.optional(),
  /** Коммиты `acceptedSha..head`. */
  commitsSinceAccepted: z.number().int().nonnegative().optional(),
  /** Файлы, изменённые между `acceptedSha` и `head`. */
  filesSinceAccepted: z.number().int().nonnegative().optional(),
  /** Принятый коммит не предок текущего ref (ref переписан). */
  diverged: z.literal(true).optional(),
  unavailable: z.string().max(500).optional(),
  /**
   * Есть ли принятый коммит в удалённой ветке — по локальной remote-tracking
   * ref (upstream ветки, иначе `refs/remotes/origin/<имя>`), без fetch и сети.
   * `pushed` — принятый коммит в её истории, `not-pushed` — нет, `unknown` —
   * удалённой ветки нет или git её не прочитал (`reason`). `checkedAt` —
   * последнее обновление этой ref на машине (reflog). Нет поля — сверка
   * удалённой ветки не выполнялась (прежняя версия).
   */
  remote: z
    .strictObject({
      state: z.enum(['pushed', 'not-pushed', 'unknown']),
      trackingRef: z.string().min(1).max(500).optional(),
      /**
       * Куда отправлять принятое: удалённый репозиторий и ветка в нём —
       * `git push <pushRemote> <ref>:<pushRef>` (upstream ветки, иначе
       * `origin` и ветка того же имени). Отправляет человек или ведущий по
       * его согласию, не harness.
       */
      pushRemote: z.string().min(1).max(200).optional(),
      pushRef: z.string().min(1).max(500).optional(),
      checkedAt: isoTimeSchema.optional(),
      reason: z.string().max(200).optional(),
      reasonEn: z.string().max(200).optional(),
      line: z.string().max(500),
      lineEn: z.string().max(500),
    })
    .optional(),
  /** Строка для человека: «принято на X; после приёмки N коммитов — не проверены». */
  line: z.string().max(500),
  /** Та же строка по-английски. */
  lineEn: z.string().max(500),
});
export type AcceptedTarget = z.infer<typeof acceptedTargetSchema>;
