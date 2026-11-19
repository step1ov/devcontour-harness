// Версия и пределы представления оператора (`OperatorView`) — лист договоров
// без импортов: его читают и Zod-схема (`operator-view.ts`), и чистая проекция
// (`src/projections/operator-view.ts`, браузерный бандл), чтобы числа были одни.

/** Мажорная версия документа: меняется, только когда поле удалено, переименовано или меняет смысл. */
export const OPERATOR_VIEW_VERSION = 1 as const;
/** Ревизия внутри мажорной версии: растёт при добавлениях (необязательное поле, значение перечисления). */
export const OPERATOR_VIEW_REVISION = 0;

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
} as const;

/** Окно истории и интервал по умолчанию: 24 ч по 15 минут (96 значений). */
export const OPERATOR_VIEW_DEFAULT_WINDOW_MS = DAY_MS;
export const OPERATOR_VIEW_DEFAULT_BUCKET_MS = 15 * 60 * 1000;
