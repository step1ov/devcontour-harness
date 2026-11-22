// Версия и пределы представления оператора (`OperatorView`) — лист договоров
// без импортов: его читают и Zod-схема (`operator-view.ts`), и чистая проекция
// (`src/projections/operator-view.ts`, браузерный бандл), чтобы числа были одни.

/** Мажорная версия документа: меняется, только когда поле удалено, переименовано или меняет смысл. */
export const OPERATOR_VIEW_VERSION = 1 as const;
/** Ревизия внутри мажорной версии: растёт при добавлениях (необязательное поле, значение перечисления). */
export const OPERATOR_VIEW_REVISION = 6;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Пределы списков и размера документа. Список сверх предела усекается
 * детерминированно (первые записи в порядке harness), выброшенное — числом в
 * `truncated`. Байтовый предел `bytes` — отдельная граница: документ сверх
 * него — отказ `VIEW_TOO_LARGE`, частичного документа нет (наибольший
 * документ при всех списках до предела больше 256 КБ — решение владельца).
 */
export const OPERATOR_VIEW_LIMITS = {
  works: 500,
  reviews: 50,
  findingsPerSubject: 50,
  questions: 50,
  escalations: 50,
  drift: 50,
  roles: 100,
  reviewRules: 100,
  warnings: 20,
  detailAttempts: 20,
  stagesPerAttempt: 50,
  blockersPerWork: 10,
  dependsOn: 50,
  alternates: 10,
  buckets: 500,
  windowMs: 7 * DAY_MS,
  bytes: 262144,
  activity: 50,
  decisions: 50,
  verificationPerWork: 50,
  /** Задачи среза прогона (`scope.tasks`, ревизия 4). */
  scope: 200,
  /** Вопросы владельцу из источника задач (`sourceQuestions`, ревизия 4). */
  sourceQuestions: 50,
  /** Варианты ответа вопроса (`questions[].options`, `sourceQuestions[].options`). */
  questionOptions: 10,
  /** Связки с источниками задач в здоровье (`health.sources`, ревизия 4). */
  sources: 10,
  /** Пунктов «что нового» в `updates.whatsNew` (ревизия 4). */
  updatesWhatsNew: 10,
  /** Задачи, добавленные в выпуск после его начала (`forecast.progress.added`, ревизия 5). */
  forecastAdded: 10,
  /** Незаконченные работы в `forecast.progress.works` (ревизия 5). */
  forecastWorks: 50,
  /** Задачи, ждущие проверки человека в источнике (`sourceReviews[].tasks`, ревизия 5). */
  sourceReviewTasks: 50,
  /** Строки этапа настройки (`stage.lines`, ревизия 5). */
  stageLines: 5,
  /** Ключи планируемых задач в `forecast.progress.planned.keys` (ревизия 6). */
  forecastPlanned: 20,
  /** Планируемые задачи `planned[]` (ревизия 6). */
  planned: 200,
  /** Записи журнала ведущего в `lead.notes` (ревизия 6). */
  leadNotes: 20,
  /** Живые превью результата (`previews`, 0.1.0-alpha.66). */
  previews: 20,
  /** Шаги пути работы (`works[].track.steps`, ревизия 6). */
  trackSteps: 120,
} as const;

/** Пределы свободных строк (символов) после маскирования. */
export const OPERATOR_VIEW_TEXT = {
  title: 120,
  questionTitle: 200,
  questionPlain: 200,
  line: 200,
  step: 100,
  plain: 160,
  detail: 200,
  message: 200,
  unavailable: 200,
  model: 200,
  reason: 200,
  activity: 200,
  /** Вариант ответа вопроса (ревизия 4). */
  option: 200,
  /** Обоснование вопроса (ревизия 4). */
  rationale: 200,
  /** Ссылка на запись источника задач (ревизия 4). */
  url: 500,
  /** Строка, пункт «что нового» и команда `updates` (ревизия 4). */
  updateLine: 300,
  /** Итоговый отчёт ведущего (`forecast.progress.release.summary`, ревизия 6). */
  releaseSummary: 2000,
} as const;

/**
 * Наблюдаемая длительность этапа (`works[].stage.typical`): поле есть, только
 * когда закончившихся образцов этапа не меньше этого числа.
 */
export const OPERATOR_VIEW_TYPICAL_MIN_SAMPLES = 5;

/** Окно истории и интервал по умолчанию: 24 ч по 15 минут (96 значений). */
export const OPERATOR_VIEW_DEFAULT_WINDOW_MS = DAY_MS;
export const OPERATOR_VIEW_DEFAULT_BUCKET_MS = 15 * 60 * 1000;

/** Пределы раздела «Что задействовано» (`resources`, ревизия 6): договор и проекция. */
export const RESOURCES_LIMITS = {
  /** Роли: исполнители, проверяющие (с запасными) и ведущий. */
  roles: 100,
  /** Закреплённые инструменты (`policy.toolchain` и `toolchain` репозиториев). */
  tools: 50,
  /** Репозитории в хранилище зависимостей и счёте проверок (как `policy.repositories`). */
  repositories: 10,
  /** Службы lifecycle (репозиторий × служба). */
  services: 50,
  /** Примеры попыток с оставшимся окружением у службы. */
  leftoverRuns: 5,
  /** Строки сводки для домашнего экрана. */
  lines: 8,
  /** Длины строк (символов) после маскирования. */
  text: {
    line: 300,
    id: 80,
    model: 200,
    name: 120,
    version: 120,
  },
} as const;
