// Маскирование свободного текста для представлений оператора (`operatorView`):
// без node:* и zod — модуль годится для браузерного бандла. Порядок —
// маскирование, затем обрезка (`redactThenClip`): секрет, разрезанный
// границей обрезки, иначе оставил бы префикс, который маска уже не узнаёт.

import { redactThenClip } from './clip.ts';

/** Замена значения, похожего на секрет. */
export const MASKED = '‹masked›';
/** Замена абсолютного пути вне домашнего каталога и репозиториев. */
export const MASKED_PATH = '‹path›';

/** Что известно о машине: домашний каталог, корни репозиториев, значения секретов. */
export interface MaskContext {
  /** Домашний каталог: путь внутри него становится `~/…`. */
  home?: string;
  /** Корни checkout репозиториев: путь внутри становится относительным. */
  roots?: readonly string[];
  /** Известные значения секретов (например, `policySecrets`): заменяются целиком. */
  secrets?: readonly string[];
}

// Префиксы ключей провайдеров и токенов: значение — до первого разделителя.
const providerKey =
  /\b(?:sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,})/g;
const bearer = /\b(Bearer|Basic|token)(\s+|=)[A-Za-z0-9._~+/=-]{8,}/gi;
// `scheme://user:pass@host` и `scheme://token@host`.
const urlCredentials = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi;
// `password=…`, `api_key: …` и подобные пары.
const secretPair =
  /((["']?)\b(?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?key|token|auth)\2\s*[=:]\s*)(["']?)[^\s"'`,;}]{4,}\3/gi;
const longHex = /\b[A-Fa-f0-9]{32,}\b/g;
const longBase64 = /[A-Za-z0-9+/_=-]{32,}/g;
// `file://…`, путь Windows с любым разделителем и путь UNC (`\\host\share`).
const fileUri = /\bfile:\/\/[^\s"'`<>]*/gi;
const windowsPath = /\b[A-Za-z]:[\\/][^\s"'`<>|]*/g;
const uncPath = /\\\\[^\s"'<>|\\]+\\[^\s"'<>|]*/g;
// Абсолютный POSIX-путь: начало строки или разделитель (в том числе `:`) перед
// `/`, не `//` URL.
const posixPath = /(^|[\s"'`(=,:[{<])\/(?!\/)[^\s"'`()<>,;\]}]*/g;

const xml = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!,
  );
/**
 * Формы известного секрета в тексте — те же, что у `redactor` хранилища:
 * исходная, URI, XML и JSON-экранирование одного и двух уровней.
 */
function secretForms(secret: string): string[] {
  const out = new Set([secret, xml(secret)]);
  try {
    out.add(encodeURIComponent(secret));
  } catch {
    /* одиночный суррогат — без URI-формы */
  }
  let escaped = secret;
  for (let level = 0; level < 2; level++) {
    escaped = JSON.stringify(escaped).slice(1, -1);
    out.add(escaped);
  }
  return [...out];
}

/** Похоже на путь: каждый сегмент — короткое слово, а не одна длинная строка. */
const pathLike = (s: string) =>
  s.includes('/') &&
  s.split('/').every((seg) => seg.length < 32 && !/^[A-Za-z0-9+_=-]{24,}$/.test(seg));

/** Длинная строка, похожая на секрет: буквы и цифры вперемешку. */
const tokenLike = (s: string) => /\d/.test(s) && /[A-Za-z]/.test(s) && !pathLike(s);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const trimSlash = (p: string) => (p.length > 1 ? p.replace(/[/\\]+$/, '') : p);

/** Шаг маскирования без обрезки: секреты, затем пути. */
export function maskSecrets(text: string, context: MaskContext = {}): string {
  let out = text;
  // 1. Известные значения: длинные первыми, чтобы часть не открыла остаток.
  for (const secret of [
    ...new Set((context.secrets ?? []).filter(Boolean).flatMap(secretForms)),
  ].sort((a, b) => b.length - a.length))
    out = out.split(secret).join(MASKED);
  // 2. Формы токенов.
  out = out
    .replace(urlCredentials, `$1${MASKED}@`)
    .replace(bearer, (_m, kind: string, sep: string) => `${kind}${sep}${MASKED}`)
    .replace(providerKey, MASKED)
    .replace(secretPair, (_m, head: string) => `${head}${MASKED}`)
    .replace(longHex, MASKED)
    .replace(longBase64, (m) => (tokenLike(m) ? MASKED : m));
  // 3. Пути: корни репозиториев → относительные, домашний каталог → `~`,
  // прочие абсолютные → `‹path›`.
  for (const root of [...new Set(context.roots ?? [])]
    .map(trimSlash)
    .filter((r) => r.length > 1)
    .sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRe(root) + '(?:[/\\\\]|(?![^\\s"\'),;]))', 'g'), (m) =>
      m.length > root.length ? '' : '.',
    );
  }
  const home = context.home ? trimSlash(context.home) : undefined;
  if (home && home.length > 1)
    out = out.replace(new RegExp(escapeRe(home) + '(?=$|[/\\\\\\s"\'),;])', 'g'), '~');
  // Домашние каталоги других пользователей и других машин.
  out = out.replace(/(^|[^\w~.-])\/(?:Users|home)\/[^/\s"'()<>,;]+/g, '$1~');
  out = out
    .replace(fileUri, MASKED_PATH)
    .replace(uncPath, MASKED_PATH)
    .replace(windowsPath, MASKED_PATH)
    .replace(posixPath, (m, lead: string) => `${lead}${MASKED_PATH}`);
  return out;
}

/**
 * Свободный текст представления: маскирование (`maskSecrets`), затем обрезка
 * до `max` символов. Пустой результат — `undefined`.
 */
export function maskText(
  text: string | undefined,
  max: number,
  context: MaskContext = {},
): string | undefined {
  if (text === undefined || text === null) return undefined;
  const out = redactThenClip(String(text), max, (t) => maskSecrets(t, context)).trim();
  return out.length ? out : undefined;
}
