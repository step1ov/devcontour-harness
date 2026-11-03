// Содержание отчёта для обоих представлений: Markdown и HTML строятся из
// одних и тех же блоков, поэтому разделы и числа в них совпадают. Тексты —
// простые строки; экранирует каждый рендер сам.

import type { ReportDist, ValueReport } from '../contracts/report.ts';
import {
  formatDist,
  formatDuration,
  formatMeasureRatio,
  formatMeasureUsd,
  formatUsd,
  formatWindow,
} from './format.ts';

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string; muted?: true }
  | { kind: 'list'; items: string[] }
  | {
      kind: 'table';
      head: string[];
      rows: string[][];
      /** Столбцы с числами выравниваются вправо. */
      numeric: number[];
    }
  | { kind: 'summary'; summary: ValueReport['summary'] }
  | { kind: 'weeks'; weeks: ValueReport['weeks'] };

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const usdDist = (d: ReportDist) => formatDist(d, formatUsd);
const or = (n: number | null, text: (n: number) => string) =>
  n === null ? 'not recorded' : text(n);

const bucketLabels: Record<string, string> = {
  defect: 'defect (check, review, scope)',
  incomplete: 'incomplete (empty, unfinished, needs lead)',
  integration: 'integration (stale base, merge)',
  environment: 'environment (sandbox, network, provider, lease)',
  'time-limit': 'time limit',
  tool: 'reviewer protocol',
  operator: 'cancelled by a person',
  budget: 'budget',
  unknown: 'unknown',
  unclassified: 'unclassified (legacy)',
};

/** Блоки отчёта в порядке разделов (`docs/contracts.md`, «Отчёт»). */
export function reportBlocks(r: ValueReport): Block[] {
  const c = r.coverage;
  const d = r.defects;
  const a = r.autonomy;
  const s = r.speed;
  const k = r.cost;
  const e = r.environment;
  const blocks: Block[] = [];
  const h = (level: 1 | 2 | 3, text: string) => blocks.push({ kind: 'heading', level, text });
  const p = (text: string, muted?: true) =>
    blocks.push({ kind: 'paragraph', text, ...(muted ? { muted } : {}) });
  const list = (items: string[]) => blocks.push({ kind: 'list', items });
  const table = (head: string[], rows: string[][], numeric: number[] = []) =>
    blocks.push({ kind: 'table', head, rows, numeric });

  h(1, r.label ? `Harness report: ${r.label}` : 'Harness report');
  p(
    `Window: ${formatWindow(r.window)}. As of ${r.window.asOf}. Harness ${r.harnessVersion}. Engines: ${c.engines.length ? c.engines.join(', ') + (c.enginesTruncated ? ', …' : '') : 'unknown'}${c.withEngineVersion < c.attempts && c.engines.length ? ` (${c.attempts - c.withEngineVersion} attempts unknown)` : ''}.`,
    true,
  );
  p(
    `Coverage: ${c.attempts} attempts on ${c.works} tasks; failure class on ${c.withFailureKind} of ${c.failed} failed; stage timings on ${c.withTimings}; call records on ${c.withCalls}; approval wait on ${c.withWait}. ${c.calls} calls, ${c.reviews} plan or contract review rounds, ${c.events} events${c.eventsFrom ? ` (events from ${c.eventsFrom})` : ''}.`,
    true,
  );

  h(2, 'Summary');
  blocks.push({ kind: 'summary', summary: r.summary });

  h(2, 'Defects caught before merge');
  list([
    `Rejected attempts: ${d.rejected} (checks ${d.byKind.gate}, review ${d.byKind.review}, scope ${d.byKind['scope-violation']}; candidate ${d.byPhase.candidate}, integration ${d.byPhase.integration}, phase unknown ${d.byPhase.unknown}).`,
    `Accepted tasks sent back at least once: ${formatMeasureRatio(d.sentBack)}.`,
    `Rejected reviews: ${d.reviews.rejected} (candidate ${d.reviews.candidate}, integration ${d.reviews.integration}) with ${d.reviews.blockingFindings} blocking findings; ${d.reviews.withoutFindings} without findings.`,
    `Rejected by review although every required check passed on the same commit: ${formatMeasureRatio(d.afterGreenGates)} green candidates (diagnostic: what the checks did not catch).`,
    `Caught only against the current target branch (integration): ${d.integration}.`,
    `Plan and contract review: ${d.planContract.rounds} rounds, ${d.planContract.rejected} rejected (plans ${d.planContract.plans.rejected} of ${d.planContract.plans.rounds}, contracts ${d.planContract.contracts.rejected} of ${d.planContract.contracts.rounds}); blocking findings closed before code ${d.planContract.blockingClosed}, open ${d.planContract.blockingOpen}, withdrawn ${d.planContract.blockingWithdrawn}.`,
    `Findings withdrawn by the reviewer (precision proxy): ${formatMeasureRatio(d.withdrawn)}${d.withdrawn.unknown ? `; ${plural(d.withdrawn.unknown, 'finding')} without a status` : ''}.`,
  ]);
  if (d.byGate.length) {
    h(3, 'Rejections by check');
    table(
      ['Check', 'Phase', 'Failed', 'Note'],
      d.byGate.map((g) => [
        g.gate,
        g.phase,
        String(g.failed),
        g.setup ? 'setup check: may be a network error' : '',
      ]),
      [2],
    );
    if (d.byGateTruncated) p(`Only the first ${d.byGate.length} checks are shown.`, true);
  }
  if (d.items.length) {
    h(3, 'Rejection evidence (newest first)');
    table(
      ['When', 'Task', 'Attempt', 'Kind', 'Check', 'Phase', 'Commit', 'Blocking', 'Log'],
      d.items.map((i) => [
        i.at,
        i.workId,
        String(i.attempt),
        i.kind,
        i.gate ?? '',
        i.phase ?? '',
        i.sha ?? '',
        i.blocking === null ? '' : String(i.blocking),
        i.log ?? '',
      ]),
      [2, 7],
    );
    if (d.itemsTruncated) p(`Showing ${d.items.length} of ${d.itemsTotal} items.`, true);
  }

  h(2, 'Autonomy');
  list([
    `Accepted tasks with a recorded human action: ${formatMeasureRatio(a.withAction)}; without one: ${formatMeasureRatio(a.withoutAction)}.`,
    `Recorded actions: operator recovery decisions ${a.actions.operatorDecisions}, holds ${a.actions.holds}, cancelled attempts ${a.actions.cancelledAttempts}; retries ${or(a.actions.retries, String)}, resets ${or(a.actions.resets, String)}, base moves ${or(a.actions.baseMoves, String)}.`,
    `Plan approvals: operator ${a.approvals.operator}, agent ${a.approvals.agent} (${a.approvals.source === 'events' ? 'from events' : a.approvals.source === 'state' ? 'current approvals only' : 'none recorded'}).`,
    `Escalations to a person (recovery awaiting the user or stopped): ${a.escalations}.`,
  ]);
  if (a.pauses.length)
    table(
      ['Queue stop', 'Count', 'Paused', 'Still open', 'Failure classes'],
      a.pauses.map((x) => [
        x.reason,
        String(x.count),
        formatDuration(x.pausedMs),
        String(x.open),
        x.failures.join(', '),
      ]),
      [1, 2, 3],
    );
  else p('No queue stops recorded in the window.', true);

  h(2, 'Speed');
  list([
    `First try: ${formatMeasureRatio(s.firstPass)} accepted tasks (any attempt count: ${formatMeasureRatio(s.firstPassRaw)}). Finished in the window: ${s.finished.accepted} accepted, ${s.finished.failed} failed, ${s.finished.cancelled} cancelled.`,
    `Approval to merge: ${formatDist(s.leadTime)}${s.leadTimeFallback ? `; ${s.leadTimeFallback} from the task approval time` : ''}. Includes queue waits and pauses.`,
    `Waiting for dependencies: ${formatDist(s.dependencyWait)}. Waiting in the queue: ${formatDist(s.queueWait)}.`,
    `Attempts per accepted task: 1 ×${s.attemptsPerAccepted.buckets['1']}, 2 ×${s.attemptsPerAccepted.buckets['2']}, 3 ×${s.attemptsPerAccepted.buckets['3']}, 4–6 ×${s.attemptsPerAccepted.buckets['4-6']}, 7+ ×${s.attemptsPerAccepted.buckets['7+']}${s.attemptsPerAccepted.median !== null ? `; median ${s.attemptsPerAccepted.median}` : ''}${s.attemptsPerAccepted.mean !== null ? `, mean ${s.attemptsPerAccepted.mean}` : ''}. Attempts on tasks not accepted in the window: ${s.attemptsOnOther}.`,
    `Machine time per accepted task (sum of attempt durations, not human time): ${formatDist(s.machineTime)}.`,
  ]);
  if (s.stages.length) {
    table(
      [
        'Stage',
        'Spans',
        'Total',
        'Median',
        'On accepted attempts',
        'On rejected attempts',
        'Unfinished',
      ],
      s.stages.map((x) => [
        x.family,
        String(x.spans),
        formatDuration(x.totalMs),
        x.medianMs === null ? '' : formatDuration(x.medianMs),
        formatDuration(x.acceptedMs),
        formatDuration(x.rejectedMs),
        String(x.incomplete),
      ]),
      [1, 2, 3, 4, 5, 6],
    );
    if (s.stagesTruncated) p(`Only the first ${s.stages.length} stages are shown.`, true);
  }

  h(2, 'Cost');
  list([
    `Known spend ${formatUsd(k.knownUsd)} over ${k.knownCalls} of ${k.calls} calls (reported by the provider ${formatUsd(k.reportedUsd)}, estimated from tariffs ${formatUsd(k.estimatedUsd)}).`,
    `Calls without a known price: ${k.unknown.total} (no tariff ${k.unknown.noPrice}, incomplete telemetry ${k.unknown.incomplete}, active ${k.unknown.active}, abandoned ${k.unknown.abandoned})${k.unknown.byRuntime.length ? `; by runtime: ${k.unknown.byRuntime.map((x) => `${x.runtime} ${x.calls}`).join(', ')}` : ''}. Attempts without call records: ${k.attemptsWithoutCalls}.`,
    `Spend per accepted task: ${formatMeasureUsd(k.perAccepted)}.`,
    `Spend per fully priced attempt: ${usdDist(k.perAttempt)}.`,
    `Spend on attempts that were not accepted: ${formatUsd(k.rejected.usd)} of ${formatUsd(k.rejected.totalUsd)} attributed to ${k.rejected.attempts} attempts${k.rejected.byBucket.length ? ` (${k.rejected.byBucket.map((x) => `${x.bucket} ${formatUsd(x.usd)}`).join(', ')})` : ''}.`,
  ]);
  if (k.byStage.length)
    table(
      ['Stage', 'Calls', 'Known spend', 'Without price'],
      k.byStage.map((x) => [
        x.stage,
        String(x.calls),
        formatUsd(x.knownUsd),
        String(x.unknownCalls),
      ]),
      [1, 2, 3],
    );

  h(2, 'Environment');
  p(
    `Failed attempts: ${e.failed}, of them ${e.classified} classified; attempts interrupted by shutdown are not failures: ${e.interrupted}. Caused by the environment: ${formatMeasureRatio(e.share)} classified.`,
  );
  table(
    ['Failure class', 'Attempts'],
    e.buckets.map((b) => [bucketLabels[b.bucket] ?? b.bucket, String(b.count)]),
    [1],
  );
  list([
    `Environment failures cost ${formatDuration(e.neutral.machineMs)} of machine time and ${formatUsd(e.neutral.knownUsd)} known spend; blocked before work (not counted as an attempt): ${e.neutral.blocked}; queue stops caused by the environment: ${e.neutral.runtimePauses}.`,
    `Integration check rechecks: ${e.rechecks.flaky} flaky (false rejection avoided), ${e.rechecks.confirmed} confirmed.`,
    'Environment sub-causes: not recorded yet.',
  ]);

  h(2, 'Weekly trend');
  if (r.weeks.active) blocks.push({ kind: 'weeks', weeks: r.weeks });
  else p('No activity in the window.', true);

  h(2, 'Tasks');
  if (r.works.rows.length) {
    table(
      [
        'Task',
        'Outcome',
        'Finished',
        'Attempts',
        'Counted',
        'Approval to merge',
        'Known spend',
        'Failures',
      ],
      r.works.rows.map((x) => [
        x.title ? `${x.id}: ${x.title}` : x.id,
        x.outcome,
        x.finishedAt ?? '',
        String(x.attempts),
        String(x.counted),
        x.leadMs === null ? '' : formatDuration(x.leadMs),
        x.costBound === 'unknown'
          ? 'unknown'
          : `${x.costBound === 'lower' ? '≥ ' : ''}${formatUsd(x.knownUsd)}${x.unknownCalls ? ` (+${x.unknownCalls} unpriced)` : ''}`,
        x.rejections.map((j) => `${j.key} ${j.count}`).join(', '),
      ]),
      [3, 4, 5, 6],
    );
    if (r.works.truncated)
      p(`Showing the newest ${r.works.rows.length} of ${r.works.total} tasks.`, true);
  } else p('No task finished in the window.', true);

  h(2, 'Limits and unknowns');
  list(r.limitations.map((l) => l.text));

  h(2, 'Appendix');
  list([
    'Accepted: the task is done; its accepting attempt is the last succeeded attempt. Window membership: accepted tasks by acceptance time, attempts and calls by start time, review rounds and events by their time; the window start is included, the end is not.',
    'Attempts are counted from attempt records, not from the task attempt counter (a reset sets it back to zero).',
    'Percentages are shown only when the denominator is 20 or more; medians only for 5 or more values; with fewer than 3 accepted tasks the summary is replaced by raw counts.',
    'Bounds: "≥" is a lower bound (some inputs are unknown), "≤" an upper bound, "unknown" means not measured; unknown is never shown as zero.',
    `Tokens in the window: input ${k.tokens.input}, output ${k.tokens.output}, cache read ${k.tokens.cacheRead}, cache write ${k.tokens.cacheWrite}; calls with incomplete token counts ${k.tokens.incompleteCalls}.`,
  ]);
  return blocks;
}
