import { z } from 'zod';
import { idSchema, isoTimeSchema } from './primitives.ts';
import {
  OUTLINE_ACTORS,
  OUTLINE_LIMITS as L,
  OUTLINE_SIZES,
  OUTLINE_STAGE_KINDS,
} from './outline-weights.ts';

export * from './outline-weights.ts';

/**
 * План выпуска ведущего (0.1.0-alpha.68): до первого графа ведущий
 * записывает этапы выпуска × компоненты с грубым размером и тем, кто их
 * делает (`harness lead outline --file F`). Прогноз считает
 * незарегистрированные части плана объёмом выпуска, а не 100 % по одному
 * графу. Одна локальная запись `release-outline` у `@workspace`, ключ
 * `outline`; это подсказка ведущему, а не условие запуска: `run` без плана
 * не блокируется.
 */
const title = z.string().min(1).max(L.title);

export const outlineComponentSchema = z
  .strictObject({
    id: idSchema,
    title,
    size: z.enum(OUTLINE_SIZES).optional(),
    /** Явное число задач компонента — главнее `size`. */
    tasks: z.number().int().min(1).max(L.tasks).optional(),
    actor: z.enum(OUTLINE_ACTORS),
    /**
     * Работы harness (ID) или ключи задач источника, которые реализуют
     * компонент. Нет поля — работы подбираются по виду этапа.
     */
    works: z.array(z.string().min(1).max(200)).min(1).max(L.works).optional(),
  })
  .refine((c) => c.size !== undefined || c.tasks !== undefined, {
    message: 'нужен size (S, M, L) или tasks',
    path: ['size'],
  });
export type OutlineComponent = z.infer<typeof outlineComponentSchema>;

export const outlineStageSchema = z.strictObject({
  id: idSchema,
  title,
  kind: z.enum(OUTLINE_STAGE_KINDS),
  components: z.array(outlineComponentSchema).min(1).max(L.componentsPerStage),
});
export type OutlineStage = z.infer<typeof outlineStageSchema>;

/** Уникальные ID этапов и компонентов, не больше `components` компонентов. */
const stagesSchema = z
  .array(outlineStageSchema)
  .min(1)
  .max(L.stages)
  .superRefine((stages, ctx) => {
    const seen = new Set<string>();
    let n = 0;
    stages.forEach((s, i) => {
      if (seen.has(s.id))
        ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `ID повторяется: ${s.id}` });
      seen.add(s.id);
      s.components.forEach((c, j) => {
        n++;
        if (seen.has(c.id))
          ctx.addIssue({
            code: 'custom',
            path: [i, 'components', j, 'id'],
            message: `ID повторяется: ${c.id}`,
          });
        seen.add(c.id);
      });
    });
    if (n > L.components)
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `компонентов ${n} при пределе ${L.components}`,
      });
  });

/** Файл `harness lead outline --file F`. */
export const releaseOutlineInputSchema = z.strictObject({
  stages: stagesSchema,
  reason: z.string().min(1).max(L.reason).optional(),
});
export type ReleaseOutlineInput = z.infer<typeof releaseOutlineInputSchema>;

/** Изменение плана при повторной записи: объём до и после (в задачах) и причина. */
export const releaseOutlineChangeSchema = z.strictObject({
  at: isoTimeSchema,
  revision: z.number().int().min(2),
  before: z.number().int().min(0),
  after: z.number().int().min(0),
  added: z.array(z.string().min(1).max(L.title)).max(L.changeItems),
  removed: z.array(z.string().min(1).max(L.title)).max(L.changeItems),
  reason: z.string().min(1).max(L.reason),
});
export type ReleaseOutlineChange = z.infer<typeof releaseOutlineChangeSchema>;

export const releaseOutlineSchema = z.strictObject({
  /** Редакция плана: 1 — первая запись, растёт при каждом изменении. */
  revision: z.number().int().positive(),
  recordedAt: isoTimeSchema,
  firstRecordedAt: isoTimeSchema,
  stages: stagesSchema,
  reason: z.string().min(1).max(L.reason).optional(),
  /** Объём плана в задачах (`outlineUnits` по компонентам). */
  units: z.number().int().positive(),
  /** Изменения плана, старые первыми (не больше `changes`). */
  changes: z.array(releaseOutlineChangeSchema).max(L.changes),
});
export type ReleaseOutline = z.infer<typeof releaseOutlineSchema>;

/**
 * Первое появление работы в выпуске (0.1.0-alpha.68): локальная запись
 * `work-seen` у `@workspace` по ID работы — когда её впервые зарегистрировал
 * граф. По ней прогноз называет рост плана («план вырос: +W»). У работ,
 * зарегистрированных раньше alpha.68, записи нет.
 */
export const workSeenSchema = z.strictObject({ at: isoTimeSchema, graphId: idSchema });
export type WorkSeen = z.infer<typeof workSeenSchema>;

/** Ответ `lead-outline`. */
export const outlineDataSchema = z.strictObject({
  outline: releaseOutlineSchema,
  /** Повторная запись изменила план. */
  changed: z.boolean(),
  change: releaseOutlineChangeSchema.optional(),
  line: z.string().min(1).max(500),
});
export type OutlineData = z.infer<typeof outlineDataSchema>;
