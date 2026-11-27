// Запросы writer тонкого режима (alpha.73). Новая сессия получает обычный
// запрос работы (`prompt()`) и короткое правило тонкого режима; продолжение
// — только то, что изменилось с прошлой сдачи: причину отказа, хвосты
// проверок, открытые находки с ID controller и новые ответы. Сводка сдачи —
// для новой сессии вместо утраченной (переполнение, потерянная сессия).

import { pinnedBytes, type ContextSnapshot } from '../contracts/index.ts';
import { findingsText } from '../engine/prompt.ts';
import { scopePathList } from '../engine/scope.ts';
import type { CodeReviewHistory } from '../contracts/index.ts';
import { droppedOutputsWriterText } from '../verification/gate-outputs.ts';

/** Правило тонкого режима в запросе новой сессии. */
export const THIN_WRITER_TEXT =
  'Thin mode: this is the one writer session for the whole work order, and it will be resumed with the controller findings if a handover is rejected. Work like a developer in this worktree: run the gates listed above yourself (the exact commands; only these), fix what fails and repeat until they pass, then hand back (completed=true). The harness commits your worktree, merges it into the current target on a clean checkout (untracked and ignored files such as build output do not travel), reruns these gates there and asks one independent review. Do not switch branches or rewrite history.';

/** Текст ответов на вопросы исполнителя из закреплённого контекста (`input/<id>.md`). */
export function answersText(context: ContextSnapshot | undefined, only?: string): string {
  const files = (context?.sources ?? []).flatMap((s) =>
    s.files.filter(
      (f) =>
        f.path.startsWith('input/') &&
        f.path.endsWith('.md') &&
        (only === undefined || f.path === `input/${only}.md`),
    ),
  );
  return files.length
    ? 'Answers to your questions (owner or lead):\n\n' +
        files.map((f) => pinnedBytes(f).toString('utf8')).join('\n\n')
    : '';
}

/** Что изменилось с прошлой сдачи: общая часть продолжения и сводки сдачи. */
export interface ThinDelta {
  /** Причина отказа прошлой сдачи (текст отказа попытки). */
  reason?: string;
  /** Прошлая сдача не отклонена, а не завершилась (незасчитанная остановка). */
  stopped?: boolean;
  /** Только ответ, с которым выдана эта сдача (новый); нет — ответов нет. */
  answer?: string;
  /** Блок провала gates прошлой сдачи (`gateFeedback`, его пределы). */
  feedback?: string;
  /** Упавшие регрессионные gates засчитанной сдачи: ревью её одобрило (alpha.76). */
  regressed?: string[];
  /** Эта сдача — не прошлая: после неё был незасчитанный отказ. */
  regressedEarlier?: boolean;
  findings?: CodeReviewHistory;
  context?: ContextSnapshot;
  /** Цель слита в дерево работы перед сдачей; `conflicts` — файлы с конфликтом. */
  merged?: { conflicts: string[] };
  /** Подготовка окружения в дереве упала до вызова (хвост отказа). */
  setupError?: string;
  /**
   * Прошлая сдача отклонена только областью (R1): пути, которые надо убрать
   * или вернуть, и база работы; gates и ревью не исполнялись.
   */
  scope?: { paths: string[]; base: string };
  /** Разбор ведущего после прошлой сессии (`leadDiagnosisNote`, R4). */
  diagnosis?: string;
  /** Новые файлы прошлой сдачи, убранные из кандидата как выходы gates (P11-5). */
  dropped?: string[];
}

/**
 * Регрессионные gates поручения (alpha.76, R3): чужие сценарии цели, harness
 * исполняет их после одобренного ревью; writer их не гоняет.
 */
export function regressionGatesText(ids: readonly string[]): string {
  return `Regression gates of this order: ${ids.join(', ')}. They check suites of other works on the target that this work must not break. They are not yours to run: the harness runs them on the merge after the review approves, before accepting; a failure comes back to you with its output.`;
}

/** Reviewer тонкого режима: регрессионные gates — у harness после одобрения. */
export function regressionReviewText(ids: readonly string[]): string {
  return `The harness runs the regression gates ${ids.join(', ')} after approval, before merging; they are not part of this review.`;
}

/**
 * Засчитанная сдача одобрена ревью и упала на регрессионных gates: прошлая
 * или, если после неё был незасчитанный отказ, более ранняя (`earlier`).
 */
export function regressedText(ids: readonly string[], earlier = false): string {
  const which = earlier ? 'an earlier handover' : 'the previous handover';
  return `The review approved ${which}, but the regression gates ${ids.join(', ')} failed after it: your change breaks a suite of another work. Fix that within the write scope; you may rerun the failing cases alone to reproduce. The next handover runs your gates and a new review again.`;
}

/** Подготовка окружения упала на файлах дерева работы: исполнитель их чинит. */
export function setupText(tail: string): string {
  return `The environment setup in this worktree (dependency store, prepare steps or lifecycle) failed before your turn, most likely because of files in this tree (for example a conflicted manifest): ${tail.slice(-2000)}. Fix those files first, then rerun your gates.`;
}

/** Окружение попытки — новое на каждой сдаче (M1). */
export const ENV_CHANGED_TEXT =
  'This handover runs in a new attempt environment: ports, the compose project name, test secrets and HARNESS_ATTEMPT_ENV_FILE may have changed. Read them again from the environment; never reuse values from earlier turns.';

/** Что сказать исполнителю о слиянии цели в его дерево. */
export function mergeText(m: { conflicts: string[] }): string {
  return m.conflicts.length
    ? `The target branch moved; the harness merged it into this worktree and the merge has conflicts in: ${m.conflicts.join(', ')}. Resolve them by editing these files only (keep both intents) and make sure no conflict markers remain; do not run git add, commit or merge — the harness concludes the merge when you hand back. Rerun your gates, then hand back.`
    : 'The target branch moved; the harness merged it into this worktree cleanly. Rerun your gates on the merged tree.';
}

/** Отказ только областью: какие пути убрать или вернуть (R1). */
export function scopeText(s: { paths: string[]; base: string }): string {
  return `The handover was rejected only because it changes files outside the work order's write scope (or protected files); the gates and the review did not run. Drop exactly these paths from your work: ${scopePathList(s.paths)}. Delete the ones you added (outputs of your own check runs included) and restore the ones you changed to the work base (git checkout ${s.base} -- <path>); do not rewrite history.`;
}

/** Последняя строка продолжения после отказа только областью: gates заново не нужны. */
export const SCOPE_ONLY_TEXT =
  'You do not need to rerun the gates for this: rerun them if code inside the write scope uses any removed path. Then hand back with the same JSON response format (completed=true).';

/**
 * Отказ только областью, и других поводов гонять gates заново нет: ни
 * открытых находок, ни провала gates, ни ответа, слияния, отказа подготовки
 * или разбора ведущего.
 */
const scopeOnly = (d: ThinDelta) =>
  d.scope &&
  !d.merged &&
  !d.setupError &&
  !d.answer &&
  !d.diagnosis &&
  !d.feedback &&
  !d.findings?.findings.some((f) => f.status === 'open');

const deltaParts = (d: ThinDelta) => [
  d.reason
    ? `${d.stopped ? 'The previous handover did not complete' : 'The previous handover was rejected'}: ${d.reason.slice(0, 2000)}`
    : '',
  d.scope ? scopeText(d.scope) : '',
  d.diagnosis ?? '',
  d.dropped?.length ? droppedOutputsWriterText(d.dropped) : '',
  d.feedback ?? '',
  d.regressed?.length ? regressedText(d.regressed, d.regressedEarlier) : '',
  findingsText(d.findings, false),
  d.answer ? answersText(d.context, d.answer) : '',
  d.merged ? mergeText(d.merged) : '',
  d.setupError ? setupText(d.setupError) : '',
];

/** Запрос продолжения той же сессии. */
export function resumePrompt(d: ThinDelta): string {
  return [
    d.stopped
      ? 'Your previous handover did not complete. Everything you did before is still in this worktree.'
      : 'The harness checked your handover and it did not pass. Everything you did before is still in this worktree.',
    ...deltaParts(d),
    ENV_CHANGED_TEXT,
    scopeOnly(d)
      ? SCOPE_ONLY_TEXT
      : 'Fix every point above, rerun your gates in this worktree until they pass, then hand back with the same JSON response format (completed=true).',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Сводка сдачи для новой сессии вместо утраченной: что уже сделано в дереве. */
export function handoverSummary(
  d: ThinDelta & { commits: string; diffStat: string; why: string },
): string {
  return [
    `Handover summary: an earlier writer session on this work order is no longer available (${d.why}). Its work is in this worktree; continue from it instead of starting over.`,
    d.commits ? 'Commits since the target base:\n' + d.commits.slice(0, 4000) : '',
    d.diffStat
      ? 'Changes against the target base (git diff --stat):\n' + d.diffStat.slice(0, 4000)
      : '',
    ...deltaParts(d),
  ]
    .filter(Boolean)
    .join('\n\n');
}
