import { compareVersions } from './semver.ts';

/**
 * «Что нового» простыми словами из заметок выпуска пакета
 * (`docs/release-notes/<версия>.md` внутри tarball): по каждой версии после
 * установленной и до найденной включительно — пункты раздела «Коротко»
 * (`## Коротко` / `## Что нового`), иначе заголовки `###` раздела
 * «Изменения», иначе заголовки `##`, иначе первый абзац. Markdown-разметка
 * снимается, длина ограничена.
 */
export function plainPoints(markdown: string, max = 5): string[] {
  const lines = markdown.split(/\r?\n/);
  const clean = (s: string) =>
    s
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  const section = (title: RegExp) => {
    const start = lines.findIndex((l) => /^##\s/.test(l) && title.test(l.replace(/^##\s+/, '')));
    if (start < 0) return undefined;
    const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
    return lines.slice(start + 1, end < 0 ? undefined : end);
  };
  const short = section(/^(Коротко|Что нового|In short|What's new)(?=[\s:.]|$)/i);
  if (short) {
    const items = short
      .filter((l) => /^\s*[-*]\s+/.test(l))
      .map((l) => clean(l.replace(/^\s*[-*]\s+/, '')));
    if (items.length) return items.slice(0, max);
  }
  const changes = section(/^(Изменения|Changes)(?=[\s:.]|$)/i);
  if (changes) {
    const items = changes
      .filter((l) => /^###\s/.test(l))
      .map((l) => clean(l.replace(/^###\s+/, '')));
    if (items.length) return items.slice(0, max);
  }
  const headings = lines
    .filter((l) => /^##\s/.test(l))
    .map((l) => clean(l.replace(/^##\s+/, '')))
    .filter((h) => !/^(Изменения|Changes|Совместимость|Обновление|Upgrade)(?=[\s:.]|$)/i.test(h));
  if (headings.length) return headings.slice(0, max);
  const paragraph = lines
    .filter((l) => !/^#/.test(l))
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => clean(p))
    .find(Boolean);
  return paragraph ? [paragraph] : [];
}

/**
 * Пункты по версиям из файлов заметок пакета: версии строго новее `after` и
 * не новее `upTo`, от новых к старым; не больше `max` пунктов всего.
 */
export function whatsNewOf(
  files: Map<string, string>,
  pkg: string,
  after: string | undefined,
  upTo: string,
  max = 10,
): string[] {
  const versions = [...files.keys()]
    .map((path) => /release-notes\/(.+)\.md$/.exec(path)?.[1])
    .filter((v): v is string => !!v)
    .filter(
      (v) =>
        compareVersions(v, upTo) <= 0 && (after === undefined || compareVersions(v, after) > 0),
    )
    .sort((a, b) => compareVersions(b, a));
  const out: string[] = [];
  for (const v of versions) {
    const text = [...files.entries()].find(([p]) => p.endsWith(`release-notes/${v}.md`))?.[1];
    if (!text) continue;
    for (const point of plainPoints(text)) {
      if (out.length >= max) return out;
      out.push(`${pkg} ${v}: ${point}`);
    }
  }
  return out;
}
