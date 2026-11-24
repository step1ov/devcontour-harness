import {
  REVIEW_ESCALATION_ROUNDS,
  WORKSPACE_OWNER,
  escalatedFindings,
  escalationQuestion,
  findingCounts,
  openRounds,
  reviewVerdictText,
  roundBudget,
  type RoundBudget,
  type ExecutionPolicy,
  type ExecutionView,
  type ReviewRecord,
  type ReviewSubjectSummary,
} from '../contracts/index.ts';
import { callRecords, knownCost } from '../engine/usage.ts';
import { planRoundEpoch, reviewRoundCap } from './review.ts';
import { spendText } from './stage.ts';

/** Предел предметов в сводке ревью `status` и `explain`: последние по времени раунда. */
export const REVIEW_SUMMARY_ROWS = 50;

/**
 * Сводка ревью плана и контрактов по хранилищу (`status`, `explain`): на
 * предмет — последний раунд, раунды из предела, открытые находки, принятые
 * ограничения, расход вызовов ревью и эскалация. Только чтение.
 */
export function reviewSummaries(
  view: ExecutionView,
  policy: Pick<ExecutionPolicy, 'maxAttempts'>,
  options: { graphId?: string } = {},
): ReviewSubjectSummary[] {
  return reviewSummaryRows(view, policy, options).reviews;
}

/**
 * Та же сводка с числом предметов сверх предела: `reviewsTruncated` — сколько
 * предметов не вошло в `REVIEW_SUMMARY_ROWS` (0 — все показаны).
 */
export function reviewSummaryRows(
  view: ExecutionView,
  policy: Pick<ExecutionPolicy, 'maxAttempts'>,
  options: { graphId?: string } = {},
): { reviews: ReviewSubjectSummary[]; reviewsTruncated: number } {
  const last = new Map<string, ReviewRecord>();
  const all = new Map<string, ReviewRecord[]>();
  for (const { value: r } of view.locals('reviews', WORKSPACE_OWNER)) {
    if (options.graphId !== undefined && !(r.kind === 'plan' && r.subject === options.graphId))
      continue;
    const key = `${r.kind}\u0000${r.subject}`;
    const prev = last.get(key);
    if (!prev || r.round > prev.round) last.set(key, r);
    all.set(key, [...(all.get(key) ?? []), r]);
  }
  if (!last.size) return { reviews: [], reviewsTruncated: 0 };
  const spend = new Map<string, { calls: number; knownUsd: number; unknownCalls: number }>();
  for (const c of callRecords(view)) {
    if ((c.stage !== 'plan-review' && c.stage !== 'contract-review') || !c.subjectId) continue;
    const key = `${c.stage === 'plan-review' ? 'plan' : 'contract'}\u0000${c.subjectId}`;
    const s = spend.get(key) ?? { calls: 0, knownUsd: 0, unknownCalls: 0 };
    s.calls += 1;
    if (knownCost(c)) s.knownUsd += c.costUsd ?? 0;
    else s.unknownCalls += 1;
    spend.set(key, s);
  }
  const max = reviewRoundCap(policy);
  const reviews = [...last.entries()]
    .sort((a, b) => b[1].at.localeCompare(a[1].at) || a[0].localeCompare(b[0]))
    .slice(0, REVIEW_SUMMARY_ROWS)
    .map(([key, r]) =>
      reviewSubjectSummary(
        r,
        max,
        spend.get(key),
        subjectRoundBudget(view, r.kind, r.subject, all.get(key) ?? [r], max),
      ),
    );
  return { reviews, reviewsTruncated: Math.max(0, last.size - REVIEW_SUMMARY_ROWS) };
}

/**
 * Раунды ревью без предела — облегчённый режим (0.1.0-alpha.69): счёта нет,
 * бюджет выпуска — время и стоимость (`budgets.group`/`total`).
 */
export const LIGHT_ROUNDS_RU = 'без предела (облегчённый режим; бюджет — время/стоимость выпуска)';
export const LIGHT_ROUNDS_EN = 'no limit (light mode; the budget is release time/cost)';

/** Сводка одного предмета по его последнему раунду. */
export function reviewSubjectSummary(
  r: ReviewRecord,
  max: number | null,
  spent: { calls: number; knownUsd: number; unknownCalls: number } = {
    calls: 0,
    knownUsd: 0,
    unknownCalls: 0,
  },
  /** Предел раундов по всем раундам предмета (0.1.0-alpha.68); нет — по номеру последнего. */
  budget?: RoundBudget,
): ReviewSubjectSummary {
  const counts = findingCounts(r.findings);
  const waiting = escalatedFindings(r.findings, r.round);
  const escalation = waiting.length
    ? (() => {
        const rows = waiting.slice(0, 50).map((f) => ({
          id: f.id,
          severity: f.severity,
          message: f.message.slice(0, 500),
          rounds: openRounds(f, r.round),
        }));
        const q = escalationQuestion(r.kind, r.subject, rows);
        return { ...q, findings: rows };
      })()
    : undefined;
  const spend = { ...spent, knownUsd: Math.round(spent.knownUsd * 1e6) / 1e6 };
  const line = [
    `${r.kind === 'plan' ? 'план' : 'контракт'} ${r.subject}: ${reviewVerdictText(r.approved, counts, 'ru')}`,
    budget
      ? max === null
        ? `раундов ${r.round}, ${LIGHT_ROUNDS_RU}`
        : `раундов ${budget.used}/${max}` +
          (budget.remaining !== null
            ? budget.remaining === 0
              ? ', осталось 0: раунд изменённого плана — после решения о пределе'
              : `, осталось ${budget.remaining}`
            : '') +
          (budget.free ? `, без траты предела ${budget.free}` : '') +
          (budget.since ? ' (с доработки)' : '')
      : max === null
        ? `раундов ${r.round}, ${LIGHT_ROUNDS_RU}`
        : `раундов ${r.round}/${max}`,
    `ревью ${spendText(spend, 'ru')}`,
    ...(escalation
      ? [
          `ждёт решения оператора: находок ${waiting.length} открыты ${REVIEW_ESCALATION_ROUNDS}+ раундов`,
        ]
      : []),
  ].join('; ');
  return {
    kind: r.kind,
    subject: r.subject,
    digest: r.digest,
    approved: r.approved,
    rounds: budget
      ? {
          used: budget.used,
          max,
          remaining: budget.remaining,
          free: budget.free,
          ...(budget.since ? { since: budget.since } : {}),
        }
      : { used: r.round, max },
    open: { blocking: counts.blocking, notes: counts.notes },
    accepted: counts.accepted,
    spend,
    ...(escalation ? { escalation } : {}),
    line: line.slice(0, 1000),
  };
}

/**
 * Раздел «Ревью» текста `--human` (`status`, `explain`); предметы сверх
 * предела — числом сразу после строк раздела.
 */
export function reviewsText(
  rows: readonly { line: string }[] | undefined,
  truncated?: number,
): string {
  if (!rows?.length) return '';
  return [
    'Ревью:',
    ...rows.map((r) => `  ${r.line}`),
    ...(truncated ? [`  … и ещё предметов ревью: ${truncated}`] : []),
  ]
    .join('\n')
    .concat('\n');
}

/**
 * Предел раундов предмета по всем его раундам (0.1.0-alpha.68): у плана —
 * с эпохи доработки принятой работы графа.
 */
export function subjectRoundBudget(
  view: ExecutionView,
  kind: 'plan' | 'contract',
  subject: string,
  records: readonly ReviewRecord[],
  max: number | null,
) {
  return roundBudget(records, max, {
    since: kind === 'plan' ? planRoundEpoch(view, subject) : undefined,
  });
}
