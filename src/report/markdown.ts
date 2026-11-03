// Markdown отчёта: чистая функция `ValueReport`. Модуль без node:*.

import type { ValueReport } from '../contracts/report.ts';
import { reportBlocks, type Block } from './document.ts';
import { formatDuration, formatUsd } from './format.ts';
import { assertReportBytes, reportLimits } from './compute.ts';

/** Текст Markdown: разметка из данных (заголовок поручения, ID) не исполняется. */
const md = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>|#])/g, '\\$1');

function table(head: string[], rows: string[][], numeric: number[]): string[] {
  const line = (cells: string[]) => `| ${cells.map(md).join(' | ')} |`;
  return [
    line(head),
    `| ${head.map((_, i) => (numeric.includes(i) ? '---:' : '---')).join(' | ')} |`,
    ...rows.map(line),
  ];
}

const weekHead = [
  'Week',
  'Attempts',
  'Accepted',
  'First try',
  'Defect rejections',
  'Environment failures',
  'Known spend',
  'Unpriced calls',
  'Median approval to merge',
  'Engines',
];

/** Строки недель (новые сверху) для таблицы. */
export function weekCells(weeks: ValueReport['weeks']): string[][] {
  const rows = weeks.rows.map((w) =>
    w.kind === 'gap'
      ? [
          w.from === w.to ? w.from : `${w.from} – ${w.to}`,
          'no activity',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ]
      : [
          w.week,
          String(w.attempts),
          String(w.accepted),
          `${w.firstPass}/${w.accepted}`,
          String(w.defects),
          String(w.environment),
          formatUsd(w.knownUsd),
          String(w.unknownCalls),
          w.leadMedianMs === null ? '' : formatDuration(w.leadMedianMs),
          (w.engineChanged ? 'changed: ' : '') +
            w.engines.join(', ') +
            (w.enginesTruncated ? ', …' : ''),
        ],
  );
  const e = weeks.earlier;
  if (e)
    rows.push([
      `earlier (${e.from} – ${e.to}, ${e.weeks} active weeks)`,
      String(e.attempts),
      String(e.accepted),
      `${e.firstPass}/${e.accepted}`,
      String(e.defects),
      String(e.environment),
      formatUsd(e.knownUsd),
      String(e.unknownCalls),
      '',
      '',
    ]);
  return rows;
}
export const weekColumns = weekHead;
export const weekNumeric = [1, 2, 3, 4, 5, 6, 7, 8];

function block(b: Block): string[] {
  switch (b.kind) {
    case 'heading':
      return ['#'.repeat(b.level) + ' ' + md(b.text), ''];
    case 'paragraph':
      return [b.muted ? `_${md(b.text)}_` : md(b.text), ''];
    case 'list':
      return [...b.items.map((i) => '- ' + md(i)), ''];
    case 'table':
      return [...table(b.head, b.rows, b.numeric), ''];
    case 'summary': {
      const s = b.summary;
      if (s.status === 'not-enough-data')
        return [
          `**${md(s.text)}**`,
          '',
          `- Accepted tasks: ${s.accepted}`,
          `- Attempts: ${s.attempts} on ${s.works} tasks`,
          `- Failed attempts: ${s.failedAttempts}`,
          '',
        ];
      return [
        ...s.headlines.flatMap((x) => [
          `- **${md(x.value)}**: ${md(x.text)}`,
          `  _${md(x.basis)}_`,
        ]),
        '',
      ];
    }
    case 'weeks':
      return [...table(weekHead, weekCells(b.weeks), weekNumeric), ''];
  }
}

/** Отчёт в Markdown: те же разделы и числа, что в HTML. */
export function reportMarkdown(report: ValueReport): string {
  const md = reportBlocks(report).flatMap(block).join('\n').trimEnd() + '\n';
  assertReportBytes(md, reportLimits.htmlBytes, 'Markdown');
  return md;
}
