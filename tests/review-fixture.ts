/**
 * Помощники тестов протокола ревью кода (docs/review-protocol.md). Ответы
 * fixture reviewer строятся только из того, что controller выдал в запросе:
 * ID находок берутся из раздела открытых находок, а не вычисляются тестом.
 */
import { existsSync, readFileSync } from 'node:fs';
import { CLOSED_FINDINGS_HEADER, OPEN_FINDINGS_HEADER } from '../src/engine/prompt.ts';

/** Находки раздела истории запроса (как их видит reviewer). */
export function issuedFindings(prompt: string, kind: 'open' | 'closed' = 'open') {
  const header = kind === 'open' ? OPEN_FINDINGS_HEADER : CLOSED_FINDINGS_HEADER;
  const escaped = header.replace(/[()]/g, '\\$&');
  const m = new RegExp('^' + escaped + '[^\\n]*\\n(\\[.*\\])$', 'm').exec(prompt);
  return m ? (JSON.parse(m[1]!) as { id: string; severity: string; status: string }[]) : [];
}

export const finding = (message: string, severity: 'blocking' | 'note' = 'blocking') => ({
  severity,
  message,
  path: 'src/greet.js',
  line: 1,
  rule: null,
  consequence: null,
  evidence: null,
  reproduction: null,
});

const execution = { commands: [], noCommandsReason: 'Проверка по diff и evidence' };

/** Вердикт reviewer; `previous` — как есть (может ссылаться на `$open:N`). */
export const verdict = (
  approved: boolean,
  options: { findings?: unknown[]; previous?: unknown[]; summary?: string } = {},
) => ({
  result: {
    approved,
    summary: options.summary ?? (approved ? 'Критерии выполнены' : 'Есть замечания'),
    findings: options.findings ?? [],
    discoveries: [],
    execution,
    previous: options.previous ?? [],
  },
});

/** Закрыть N-ю выданную открытую находку с основанием. */
export const close = (n = 0, basis = 'Исправлено: greet проверяет пустое имя') => ({
  id: `$open:${n}`,
  status: 'closed',
  basis,
});

/** Число вызовов роли fixture runtime по счётчику сценария. */
export const fixtureCalls = (scenario: string, runtime: string, role: string) => {
  const file = `${scenario}.${runtime}.${role}.count`;
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
};

/** Запрос N-го вызова роли (если шаг сценария его записал: `recordPrompt`). */
export const recordedPrompt = (scenario: string, role: string, index: number) =>
  readFileSync(`${scenario}.${role}.${index}.prompt`, 'utf8');

/** ID, которые fixture reviewer извлёк из своего запроса. */
export const seenFindings = (scenario: string, role: string, index: number) =>
  JSON.parse(readFileSync(`${scenario}.${role}.${index}.findings`, 'utf8')) as {
    open: { id: string }[];
    closed: { id: string }[];
  };
