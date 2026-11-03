// HTML отчёта: один самодостаточный файл без скриптов и внешних ресурсов
// (CSP запрещает всё, кроме встроенных стилей). Модуль без node:*.

import type { ValueReport } from '../contracts/report.ts';
import { reportBlocks, type Block } from './document.ts';
import { weekCells, weekColumns, weekNumeric } from './markdown.ts';
import { assertReportBytes, reportLimits } from './compute.ts';

const esc = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const style = `
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#62625d;--line:#dcdcd6;--card:#ffffff;--accent:#2c6e49;--bar:#c9d8cf;--warn:#8a5a00}
@media (prefers-color-scheme: dark){:root{--bg:#161615;--fg:#ececea;--muted:#a3a39d;--line:#3a3a37;--card:#1f1f1d;--accent:#7cc29a;--bar:#3c5446;--warn:#e0b45c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.6rem;margin:0 0 8px}
h2{font-size:1.2rem;margin:32px 0 8px;padding-top:12px;border-top:1px solid var(--line)}
h3{font-size:1rem;margin:20px 0 6px}
p.muted{color:var(--muted);font-size:.9rem;margin:4px 0}
ul{padding-left:20px}
li{margin:4px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.card .value{font-size:1.6rem;font-weight:650;color:var(--accent);overflow-wrap:anywhere}
.card .text{margin:4px 0}
.card .basis{color:var(--muted);font-size:.82rem;margin:0}
.notice{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--warn);border-radius:8px;padding:12px 14px}
.scroll{overflow-x:auto;margin:8px 0}
table{border-collapse:collapse;font-size:.88rem;min-width:100%}
th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
th{font-weight:600;white-space:nowrap}
td.num,th.num{text-align:right;white-space:nowrap}
svg{max-width:100%;height:auto;display:block}
svg .attempts{fill:var(--bar)}
svg .accepted{fill:var(--accent)}
svg text{fill:var(--muted);font-size:10px}
`;

function table(head: string[], rows: string[][], numeric: number[]): string {
  const cell = (tag: 'th' | 'td', text: string, i: number) =>
    `<${tag}${numeric.includes(i) ? ' class="num"' : ''}>${esc(text)}</${tag}>`;
  return (
    '<div class="scroll"><table><thead><tr>' +
    head.map((x, i) => cell('th', x, i)).join('') +
    '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((x, i) => cell('td', x, i)).join('') + '</tr>').join('') +
    '</tbody></table></div>'
  );
}

/** Столбики попыток и принятых по неделям (старые слева); только при 3 и более активных неделях. */
function chart(weeks: ValueReport['weeks']): string {
  const rows = weeks.rows.filter((w) => w.kind === 'week').reverse();
  if (weeks.active < 3 || rows.length < 3) return '';
  const max = Math.max(1, ...rows.map((w) => w.attempts));
  const slot = 40;
  const height = 120;
  const bars = rows
    .map((w, i) => {
      const x = i * slot + 6;
      const ha = Math.round((w.attempts / max) * height);
      const hc = Math.round((w.accepted / max) * height);
      return (
        `<rect class="attempts" x="${x}" y="${height - ha}" width="14" height="${ha}"><title>${esc(w.week)}: ${w.attempts} attempts</title></rect>` +
        `<rect class="accepted" x="${x + 15}" y="${height - hc}" width="14" height="${hc}"><title>${esc(w.week)}: ${w.accepted} accepted</title></rect>` +
        `<text x="${x}" y="${height + 14}">${esc(w.week.slice(5))}</text>`
      );
    })
    .join('');
  return `<svg viewBox="0 0 ${rows.length * slot} ${height + 20}" role="img" aria-label="Attempts (light) and accepted tasks (dark) per active week">${bars}</svg>`;
}

function block(b: Block): string {
  switch (b.kind) {
    case 'heading':
      return `<h${b.level}>${esc(b.text)}</h${b.level}>`;
    case 'paragraph':
      return b.muted ? `<p class="muted">${esc(b.text)}</p>` : `<p>${esc(b.text)}</p>`;
    case 'list':
      return '<ul>' + b.items.map((i) => `<li>${esc(i)}</li>`).join('') + '</ul>';
    case 'table':
      return table(b.head, b.rows, b.numeric);
    case 'summary': {
      const s = b.summary;
      if (s.status === 'not-enough-data')
        return (
          `<div class="notice"><p><strong>${esc(s.text)}</strong></p><ul>` +
          `<li>Accepted tasks: ${s.accepted}</li><li>Attempts: ${s.attempts} on ${s.works} tasks</li>` +
          `<li>Failed attempts: ${s.failedAttempts}</li></ul></div>`
        );
      return (
        '<div class="cards">' +
        s.headlines
          .map(
            (x) =>
              `<section class="card"><div class="value">${esc(x.value)}</div><p class="text">${esc(x.text)}</p><p class="basis">${esc(x.basis)}</p></section>`,
          )
          .join('') +
        '</div>'
      );
    }
    case 'weeks':
      return chart(b.weeks) + table(weekColumns, weekCells(b.weeks), weekNumeric);
  }
}

/**
 * Отчёт одним HTML-файлом: встроенный CSS, светлая и тёмная схема по
 * `prefers-color-scheme`, читается на ширине телефона; скриптов, шрифтов,
 * изображений и внешних ссылок нет.
 */
export function reportHtml(report: ValueReport): string {
  const title = report.label ? `Harness report: ${report.label}` : 'Harness report';
  const html =
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">\n` +
    `<title>${esc(title)}</title>\n<style>${style}</style>\n</head>\n<body>\n<main>\n` +
    reportBlocks(report).map(block).join('\n') +
    '\n</main>\n</body>\n</html>\n';
  assertReportBytes(html, reportLimits.htmlBytes, 'HTML');
  return html;
}
