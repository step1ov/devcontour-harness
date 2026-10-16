export type Redactor = ((text: string) => string) & { secrets?: readonly string[] };
const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
/**
 * Формы, в которых секрет встречается в сохраняемом тексте. Сырой вывод
 * проверки — не единственный путь: секрет с кавычкой или переводом строки
 * в JSON-отчёте выглядит как `\"`, в JSON внутри JSON — экранирован дважды,
 * в JUnit — как XML-сущность. Маска только по исходной строке их пропускала.
 */
function forms(secret: string) {
  const out = new Set([secret, encodeURIComponent(secret), xml(secret)]);
  let escaped = secret;
  for (let level = 0; level < 2; level++) {
    escaped = JSON.stringify(escaped).slice(1, -1);
    out.add(escaped);
  }
  return [...out];
}
export function redactor(values: readonly string[]): Redactor {
  const secrets = [...new Set(values.filter(Boolean).flatMap(forms))].sort(
    (a, b) => b.length - a.length,
  );
  return Object.assign(
    (text: string) => secrets.reduce((out, secret) => out.split(secret).join('[REDACTED]'), text),
    { secrets },
  );
}
export function composeRedactors(...values: Redactor[]): Redactor {
  return Object.assign((text: string) => values.reduce((out, redact) => redact(out), text), {
    ...(values.every((v) => v.secrets !== undefined)
      ? { secrets: values.flatMap((v) => [...v.secrets!]) }
      : {}),
  });
}
// Hold suffixes that may be the beginning of a secret in a later OS pipe chunk.
// Arbitrary custom redactors without metadata cannot safely stream; only flush at EOF.
export function outputRedactor(redact?: Redactor) {
  let pending = '';
  const secrets = redact?.secrets;
  const window = Math.max(0, ...(secrets ?? []).map((s) => s.length));
  return (text: string, final = false) => {
    pending += text;
    let cut = final
      ? pending.length
      : redact && !secrets
        ? 0
        : Math.max(0, pending.length - window);
    for (let prior = -1; prior !== cut;) {
      prior = cut;
      for (const secret of secrets ?? []) {
        const start = pending.lastIndexOf(secret, cut - 1);
        if (start >= 0 && start < cut && start + secret.length > cut) cut = start;
      }
    }
    const ready = pending.slice(0, cut);
    pending = pending.slice(cut);
    // The fallback is deliberately bounded; truncated runtime output is not complete usage.
    if (pending.length > 2_000_000) pending = pending.slice(-2_000_000);
    return redact ? redact(ready) : ready;
  };
}

/**
 * Замаскировать все строки во вложенной структуре перед сохранением.
 *
 * Доказательство собирается из многих полей: итог, команда, команда повтора,
 * разобранный отчёт, находки ревью, наблюдённые команды. Маскировать каждое
 * поле в месте его сборки — значит однажды пропустить одно; сохраняемая
 * запись проходит через эту функцию целиком.
 */
export function redactDeep<T>(value: T, redact?: (text: string) => string): T {
  if (!redact) return value;
  const walk = (v: unknown): unknown =>
    typeof v === 'string'
      ? redact(v)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
          : v;
  return walk(value) as T;
}
