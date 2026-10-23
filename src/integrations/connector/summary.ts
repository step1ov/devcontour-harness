import type { RunResult } from '../../contracts/index.ts';
import { redactor, type Redactor } from '../../environment/redaction.ts';

/**
 * Краткий итог для внешнего хранилища задач. В нём: исход, проверяемые SHA,
 * сводка gates, сопоставление критериев, источник снимка и receipt. Не
 * попадают: полный runtime log, вызовы инструментов, локальные пути (они не
 * являются ссылками, доступными с другого компьютера), lease/fencing токены
 * и секреты (маскируются `redact`).
 */

export interface CriterionOutcome {
  criterionId: string;
  title: string;
  gate?: string;
  testId?: string;
  /** `closed` — закрыт этой доставкой; `already` — уже был отмечен; остальные — блокеры. */
  outcome: 'closed' | 'already' | 'unproven' | 'manual';
  reason?: string;
}

/** Абсолютные пути (POSIX и Windows) заменяются — они не ссылки для другого компьютера. */
const PATHS = /(?<![\w.:/\\])(?:[A-Za-z]:\\|\/)(?:[\w.@+-]+[\\/])+[\w.@+-]*/g;
export const stripPaths = (text: string) => text.replace(PATHS, '[локальный путь]');

const shortSha = (sha?: string) => (sha ? sha.slice(0, 12) : '—');

export function summaryText(input: {
  marker: string;
  result: RunResult;
  task: { key: string; identity: string };
  snapshot: { revision: string; casRevision: number };
  criteria: CriterionOutcome[];
  completion: string;
  historical?: boolean;
  redact?: Redactor;
}): { title: string; body: string } {
  const r = input.result;
  const redact = input.redact ?? redactor([]);
  const gates = [...new Map(r.evidence.map((e) => [`${e.gate}/${e.phase}`, e])).values()]
    .filter((e) => e.kind !== 'review')
    .map((e) => {
      const tests = e.tests
        ? ` (${e.tests.filter((t) => t.status === 'passed').length}/${e.tests.length} тестов)`
        : '';
      return `- ${e.gate} [${e.phase}]: ${e.passed ? 'passed' : 'failed'}${tests} @ ${shortSha(e.sha)}`;
    });
  const reviews = r.evidence.filter((e) => e.kind === 'review');
  const lines = [
    input.marker,
    input.historical
      ? `**devcontour-harness: исторический результат** — относится к прежней постановке (снимок ${input.snapshot.revision.slice(0, 12)}), **не подтверждает текущие критерии и не закрывает задачу**.`
      : `**devcontour-harness: ${r.outcome}** — ${input.task.key}`,
    '',
    `- Попытка: ${r.runId} (№ ${r.attempt}), репозиторий ${r.repositoryId}, target ${r.targetRef}`,
    r.outcome === 'accepted'
      ? `- SHA: base ${shortSha(r.shas.base)}, candidate ${r.shas.candidate}, integration/result ${r.shas.result}`
      : `- SHA: candidate ${shortSha(r.shas.candidate)}, integration ${shortSha(r.shas.integration)}`,
    ...(r.outcome !== 'accepted'
      ? [`- Причина: ${r.stopReason.code}: ${r.stopReason.message.slice(0, 500)}`]
      : []),
    `- Снимок постановки: ${input.task.identity} @ ${input.snapshot.revision} (CAS ${input.snapshot.casRevision})`,
    '',
    '**Gates**',
    ...(gates.length ? gates : ['- нет записей']),
    ...(reviews.length
      ? [
          `- независимое ревью: ${reviews.map((e) => `${e.phase} ${e.passed ? 'approved' : 'rejected'}`).join(', ')}`,
        ]
      : []),
    '',
    '**Критерии**',
    ...(input.criteria.length
      ? input.criteria.map(
          (c) =>
            `- ${c.title}: ${c.outcome}` +
            (c.gate ? ` ← ${c.gate}${c.testId ? '/' + c.testId : ''}` : '') +
            (c.reason ? ` (${c.reason})` : ''),
        )
      : ['- нет критериев']),
    '',
    `Завершение: ${input.completion}`,
    ...(r.limitations.length
      ? ['', '**Ограничения**', ...r.limitations.slice(0, 10).map((l) => '- ' + l)]
      : []),
  ];
  const body = stripPaths(redact(lines.join('\n'))).slice(0, 8000);
  const title = stripPaths(
    redact(
      input.historical
        ? `devcontour-harness: исторический результат ${input.task.key}`
        : `devcontour-harness: ${r.outcome} ${input.task.key}`,
    ),
  ).slice(0, 200);
  // Маркер не маскируется и не обрезается: по нему выполняется read-back.
  return { title, body: body.startsWith(input.marker) ? body : input.marker + '\n' + body };
}
