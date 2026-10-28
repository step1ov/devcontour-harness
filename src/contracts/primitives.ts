import { z } from 'zod';

/** Идентификатор сущности harness: поручения, роли, gate, репозитория. */
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,80}$/, 'Ожидается ID [A-Za-z0-9_-]{1,80}');
/** Ссылка на gate или на именованную группу gates (`@имя`). */
export const gateRefSchema = z.string().regex(/^@?[A-Za-z0-9_-]{1,80}$/);
/**
 * Предел ссылок на gates в одной области (задача, поручение, потребитель,
 * основание ревью). Он равен пределу gates профиля стека: область задачи
 * может назвать весь профиль, и включение каждого gate в задачу выполнимо
 * одной задачей.
 */
export const GATE_SCOPE_LIMIT = 100;
/** Превышение предела области gates — понятный отказ с величиной и исправлением. */
export const gateScopeTooBig = (issue: { input?: unknown }) => {
  const actual = Array.isArray(issue.input) ? issue.input.length : GATE_SCOPE_LIMIT + 1;
  return (
    `область gates: ${actual} при пределе ${GATE_SCOPE_LIMIT}, лишних ${actual - GATE_SCOPE_LIMIT}. ` +
    'Назовите группу gates (@имя) или уберите повторы'
  );
};
/** Ссылки на gates одной области: не больше `GATE_SCOPE_LIMIT`. */
export const gateScopeSchema = <T extends z.ZodType<string>>(item: T) =>
  z.array(item).max(GATE_SCOPE_LIMIT, { error: gateScopeTooBig });
export const roleIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}$/, 'Идентификатор роли: строчные латинские буквы, цифры и дефис');
/** Полный SHA объекта Git (SHA-1 или SHA-256). */
export const gitShaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/, 'Ожидается полный SHA');
/** SHA-256 содержимого в hex. */
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Ожидается SHA-256 hex');
export const isoTimeSchema = z.iso.datetime({ offset: true });
/**
 * Полное имя ветки `refs/heads/<имя>` по правилам `git check-ref-format`:
 * компоненты без ведущей точки и суффикса `.lock`, без `..`, `//`, `@{`,
 * управляющих символов, пробела и `~^:?*[\`, имя не кончается `/` или `.`.
 * Правило выражено одним регулярным выражением, чтобы JSON Schema
 * проверяла то же, что Zod.
 */
export const targetRefPattern =
  '^refs/heads/(?!.*(?:\\.\\.|//|@\\{|\\.lock(?:/|$)|/\\.|[.]$|/$))(?!\\.)[^\\x00-\\x20\\x7f~^:?*\\[\\\\]{1,200}$';
export const targetRefSchema = z
  .string()
  .regex(
    new RegExp(targetRefPattern),
    'Ожидается refs/heads/<имя> по правилам git check-ref-format',
  );

/**
 * Относительный путь внутри репозитория: без glob, `.`/`..`, абсолютных
 * префиксов, обратных слешей, `:` и NUL. Та же форма, что у области записи
 * DevContour: сохранённые поручения читаются без преобразования. Правило —
 * регулярное выражение, поэтому JSON Schema его не теряет.
 */
export const relativePathPattern =
  '^(?!/)(?!.*[\\\\:*?\\[\\]\\x00])(?!(?:.*/)?\\.{1,2}(?:/|$))(?=.{1,500}$).+$';
export const relativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(new RegExp(relativePathPattern), 'Ожидается относительный путь без glob, . или ..');

/** Встроенные runtime. `fixture` — управляемые ответы для тестов и демо, не живая модель. */
export const runtimeNames = ['codex', 'claude', 'fixture'] as const;
export const runtimeNameSchema = z.enum(runtimeNames);
export type RuntimeName = (typeof runtimeNames)[number];

/**
 * Автор проверяемого предложения (плана, контракта, кода). Кроме runtime
 * harness, автором может быть `external` — человек или инструмент вне
 * harness; его вендор не совпадает ни с одним runtime.
 */
export const authorSchema = z.enum([...runtimeNames, 'external']);
export type Author = z.infer<typeof authorSchema>;

/**
 * Вендор runtime. Политика ревью сравнивает вендоров, а не имена runtime:
 * одинаковый вендор у автора и reviewer допустим только явным разрешением.
 */
export const vendorOf = (runtime: Author) =>
  runtime === 'codex'
    ? 'openai'
    : runtime === 'claude'
      ? 'anthropic'
      : runtime === 'fixture'
        ? 'fixture'
        : 'external';
export type Vendor = ReturnType<typeof vendorOf>;

/**
 * Текст без пробельных символов по краям. Zod `.trim()` нормализует значение,
 * а JSON Schema нормализовать не умеет — и тогда «   » проходило бы одну схему
 * и не проходило другую. Поэтому harness не нормализует, а требует уже
 * обрезанный текст: правило выражено регулярным выражением в обеих схемах.
 * Адаптер хоста передаёт обрезанные значения.
 */
export const trimmedTextPattern = '^\\S(?:[\\s\\S]*\\S)?$';
export const trimmedText = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(new RegExp(trimmedTextPattern), 'Текст без пробелов по краям и не пустой');
