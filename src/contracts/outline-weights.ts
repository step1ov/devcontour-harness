// План выпуска ведущего (0.1.0-alpha.68) — лист договоров без импортов: его
// читают и Zod-схема (`outline.ts`), и чистая проекция прогноза (браузерный
// бандл), чтобы веса и пределы были одни.

/** Грубый размер компонента плана выпуска. */
export const OUTLINE_SIZES = ['S', 'M', 'L'] as const;
export type OutlineSize = (typeof OUTLINE_SIZES)[number];

/**
 * Размер → объём в задачах (единица объёма прогноза — одна работа harness):
 * S — 1 задача, M — 1–2 (прогноз считает 2), L — 2–3 (прогноз считает 3;
 * alpha.71, D1: работа — связный сценарий, крупнее прежнего). Явное `tasks`
 * у компонента главнее размера.
 */
export const OUTLINE_SIZE_UNITS: Readonly<Record<OutlineSize, number>> = { S: 1, M: 2, L: 3 };

/** Вид этапа выпуска. */
export const OUTLINE_STAGE_KINDS = ['infra', 'product', 'deploy', 'other'] as const;
export type OutlineStageKind = (typeof OUTLINE_STAGE_KINDS)[number];

/** Кто делает компонент: исполнители (работы harness), окружение, владелец. */
export const OUTLINE_ACTORS = ['writers', 'environment', 'owner'] as const;
export type OutlineActor = (typeof OUTLINE_ACTORS)[number];

export const OUTLINE_LIMITS = {
  /** Этапов в плане. */
  stages: 12,
  /** Компонентов в этапе. */
  componentsPerStage: 20,
  /** Компонентов во всём плане. */
  components: 60,
  /** Явное число задач компонента. */
  tasks: 50,
  /** Ссылок компонента на работы или ключи задач. */
  works: 20,
  /** Символов заголовка этапа или компонента. */
  title: 120,
  /** Символов причины изменения. */
  reason: 300,
  /** Изменений плана в истории (старые вытесняются). */
  changes: 20,
  /** Названий в «добавлено» / «убрано» одного изменения. */
  changeItems: 10,
  /** Совпавших работ компонента в представлении. */
  viewWorks: 5,
} as const;

/**
 * Типичная длительность одной задачи плана, пока в выпуске нет закончившихся
 * попыток: 15–40 мин (оценка; с попытками — их p50/p90 или разброс).
 */
export const OUTLINE_DEFAULT_TASK_MS = { lo: 15 * 60_000, hi: 40 * 60_000 } as const;

/**
 * Без плана выпуска, когда все известные работы — инфраструктура: она
 * считается 30 % выпуска (оценка), продукт — «ещё не спланирован».
 */
export const INFRA_DEFAULT_SHARE = 0.3;

/** Объём компонента в задачах: `tasks`, иначе вес размера. */
export const outlineUnits = (c: { size?: OutlineSize; tasks?: number }) =>
  c.tasks ?? (c.size ? OUTLINE_SIZE_UNITS[c.size] : 1);
