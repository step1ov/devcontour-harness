import { z } from 'zod';

/** Идентификатор сущности harness: поручения, роли, gate, репозитория. */
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,80}$/, 'Ожидается ID [A-Za-z0-9_-]{1,80}');
/** Ссылка на gate или на именованную группу gates (`@имя`). */
export const gateRefSchema = z.string().regex(/^@?[A-Za-z0-9_-]{1,80}$/);
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
/** Имя ветки, которую двигает harness: только собственное пространство имён. */
export const targetRefSchema = z
  .string()
  .regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}$/, 'Ожидается refs/heads/<имя>')
  .refine((r) => !r.includes('..') && !r.endsWith('/') && !r.endsWith('.lock'), 'Недопустимый ref');

/**
 * Относительный путь внутри репозитория: без glob, `.`/`..`, абсолютных
 * префиксов, обратных слешей и NUL. Та же форма, что у области записи
 * DevContour: сохранённые поручения читаются без преобразования.
 */
export const relativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes(':') &&
      !/[*?[\]]/.test(p) &&
      !p.split('/').some((part) => part === '..' || part === '.') &&
      !p.includes('\0'),
    'Ожидается относительный путь без glob, . или ..',
  );

/** Встроенные runtime. `fixture` — управляемые ответы для тестов и демо, не живая модель. */
export const runtimeNames = ['codex', 'claude', 'fixture'] as const;
export const runtimeNameSchema = z.enum(runtimeNames);
export type RuntimeName = (typeof runtimeNames)[number];

/**
 * Вендор runtime. Политика ревью сравнивает вендоров, а не имена runtime:
 * одинаковый вендор у writer и reviewer допустим только явным разрешением.
 */
export const vendorOf = (runtime: RuntimeName) =>
  runtime === 'codex' ? 'openai' : runtime === 'claude' ? 'anthropic' : 'fixture';
export type Vendor = ReturnType<typeof vendorOf>;
