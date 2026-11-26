// `harness guide <topic>` (alpha.71, E3): разделы инструкции ведущего по
// темам. Текст живёт в одном месте — файлах `skills/harness/guide/<topic>.md`
// пакета (тема `relay` — раздел «Task source» skill установки); короткий
// SKILL.md несёт только оглавление, построенное из тех же файлов
// (`guideIndex`), и тест сверяет его с файлами.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { HarnessError } from '../contracts/index.ts';

export const skillsRoot = fileURLToPath(new URL('../../skills/', import.meta.url));

/** Темы `harness guide` в порядке маршрута. */
export const guideTopics = [
  // Правила сессии ведущего — первыми (ревью D/E MEDIUM-2): их читает каждая сессия.
  'session',
  'setup',
  'plan',
  'review',
  'run',
  'recovery',
  'release',
  'relay',
] as const;
export type GuideTopic = (typeof guideTopics)[number];

/** Тема `relay` — раздел skill установки от этого заголовка до следующего `### `. */
const RELAY_HEADING = '### 10. Task source';

export interface GuideSection {
  topic: GuideTopic;
  title: string;
  headings: string[];
  text: string;
}

const headingsOf = (text: string) =>
  text
    .split('\n')
    .filter((l) => /^#{2,3} /.test(l))
    .map((l) => l.replace(/^#+ /, ''));

export function guideSection(topic: string, root = skillsRoot): GuideSection {
  if (!(guideTopics as readonly string[]).includes(topic))
    throw new HarnessError(
      'INVALID_INPUT',
      `Тема guide: ожидается ${guideTopics.join(', ')}; получено «${topic}»`,
      [{ path: ['topic'], message: topic }],
    );
  if (topic === 'relay') {
    const file = join(root, 'harness-setup', 'SKILL.md');
    const all = readFileSync(file, 'utf8');
    const start = all.indexOf(RELAY_HEADING);
    if (start < 0) throw new HarnessError('NOT_FOUND', 'Раздел источника задач не найден: ' + file);
    const next = all.indexOf('\n### ', start + RELAY_HEADING.length);
    const text = all.slice(start, next < 0 ? undefined : next).trimEnd() + '\n';
    return {
      topic,
      title: 'Task source: graph files or a connected task tracker (connector.json)',
      headings: headingsOf(text),
      text,
    };
  }
  const file = join(root, 'harness', 'guide', `${topic}.md`);
  if (!existsSync(file)) throw new HarnessError('NOT_FOUND', 'Раздел guide не найден: ' + file);
  const raw = readFileSync(file, 'utf8');
  const title = /^<!-- harness guide [a-z]+: (.+?) -->\n/.exec(raw)?.[1];
  if (!title) throw new HarnessError('INVALID_INPUT', 'Нет заголовка темы guide: ' + file);
  const text = raw.replace(/^<!--.*?-->\n+/, '');
  return { topic: topic as GuideTopic, title, headings: headingsOf(text), text };
}

/** Оглавление для SKILL.md: тема, о чём она и её разделы. */
export function guideIndex(root = skillsRoot): string {
  const rows = guideTopics.map((t) => {
    const s = guideSection(t, root);
    return `- \`$H guide ${t}\` — ${s.title}. Sections: ${s.headings.join('; ')}.`;
  });
  return [
    '## Guide: read the section you need',
    '',
    'The full instructions are split by topic. Before a step, print its',
    'section with `$H guide <topic>` (plain text, read-only) and follow it.',
    '`$H` is the CLI of the exact installed version (`guide setup`, step 1).',
    'Before it is installed, read the same text from `guide/<topic>.md` next',
    'to this file.',
    'Every session, new or resumed, starts with `$H guide session` (lead begin,',
    'who your commands speak for, notes; resuming). Route: setup → plan →',
    'review → run (block on `$H wait` with a long timeout, not a `status` loop;',
    'with `HARNESS_LEAD_DRIVE=1` end your turn instead — the driver wakes you) →',
    'recovery when it stops → release.',
    '',
    ...rows,
  ].join('\n');
}
