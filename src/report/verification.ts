// Что проверено у поручения и как — из записей evidence одной попытки:
// команду gate запустил harness, запись взята прежняя, агент прочитал diff
// и ничего не запускал, или проверки не было. Модуль без node:* и без zod
// (его импортирует браузер через отчёт); схема — `workVerificationSchema`
// (src/contracts/verification-view.ts). Команды gates не выводятся — только ID.

import type { AttemptState, WorkState } from '../contracts/execution.ts';

/** Литералы `src/contracts/verification-view.ts` (тест сверяет поэлементно). */
export const verificationResultNames = [
  'passed',
  'failed',
  'reused',
  'skipped',
  'not-applicable',
] as const;
export const verificationHowNames = [
  'executed-by-harness',
  'reused-evidence',
  'read-by-reviewer',
  'not-run',
] as const;
export const verificationRowLimit = 40;
export const verificationReportRowLimit = 6;
/** Предел сводной строки у поручения отчёта: отчёт держит предел байт (`REPORT_LIMITS`). */
export const verificationReportLineLimit = 500;

export type VerificationResult = (typeof verificationResultNames)[number];
export type VerificationHow = (typeof verificationHowNames)[number];

export interface VerificationRow {
  gate: string;
  kind: 'gate' | 'review';
  phase: 'candidate' | 'integration';
  consumer?: string;
  result: VerificationResult;
  how: VerificationHow;
  at?: string;
  reviewer?: { runtime: AttemptState['reviewer']; vendor: string };
}

export interface WorkVerification {
  runId: string;
  rows: VerificationRow[];
  rowsTruncated?: number;
  line: string;
  lineEn: string;
}

/** Вендор runtime — то же правило, что `vendorOf` (src/contracts/primitives.ts). */
const vendorOfRuntime = (runtime: string) =>
  runtime === 'codex'
    ? 'openai'
    : runtime === 'claude'
      ? 'anthropic'
      : runtime === 'fixture'
        ? 'fixture'
        : 'external';

/**
 * Попытка, чью проверку показывать: у принятого — принявшая (последняя
 * успешная), иначе последняя попытка поручения. Нет — попыток нет.
 */
export function verificationAttemptOf(
  work: Pick<WorkState, 'status'>,
  attempts: readonly AttemptState[],
): AttemptState | undefined {
  if (work.status === 'done') {
    const accepting = attempts.filter((a) => a.status === 'succeeded').at(-1);
    if (accepting) return accepting;
  }
  return attempts.at(-1);
}

const utc = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : iso;
};

const gateName = (r: Pick<VerificationRow, 'gate' | 'consumer'>) =>
  r.consumer ? `${r.gate}@${r.consumer}` : r.gate;

/** Строки проверки попытки: последняя запись каждого gate и ревью в каждой фазе. */
export function verificationRows(a: AttemptState): VerificationRow[] {
  const rows = new Map<string, VerificationRow>();
  for (const e of a.evidence) {
    const kind = e.kind === 'review' ? 'review' : 'gate';
    const key = [e.phase, kind, e.consumer ?? '', e.gate].join('\0');
    const base = {
      gate: e.gate,
      kind,
      phase: e.phase,
      ...(e.consumer ? { consumer: e.consumer } : {}),
      // Момент — в UTC: тот же момент с другим поясом даёт ту же строку.
      at: utc(e.createdAt),
    } as const;
    // Повтор того же gate в фазе (recheck) заменяет прежнюю запись.
    rows.delete(key);
    if (e.kind === 'review')
      rows.set(key, {
        ...base,
        result: e.passed ? 'passed' : 'failed',
        how: 'read-by-reviewer',
        reviewer: { runtime: a.reviewer, vendor: vendorOfRuntime(a.reviewer) },
      });
    else if (e.kind === 'not-applicable')
      rows.set(key, { ...base, result: 'not-applicable', how: 'not-run' });
    else if (e.reusedEvidence)
      rows.set(key, { ...base, result: e.passed ? 'reused' : 'failed', how: 'reused-evidence' });
    else
      rows.set(key, {
        ...base,
        result: e.passed ? 'passed' : 'failed',
        how: 'executed-by-harness',
      });
  }
  const out = [...rows.values()].sort((x, y) =>
    x.phase === y.phase ? 0 : x.phase === 'candidate' ? -1 : 1,
  );
  // Обязательный gate закончившейся попытки без записи кандидата — не исполнялся.
  if (a.status !== 'active')
    for (const gate of a.requiredGates ?? [])
      if (
        !out.some(
          (r) => r.kind === 'gate' && r.phase === 'candidate' && r.gate === gate && !r.consumer,
        )
      )
        out.push({ gate, kind: 'gate', phase: 'candidate', result: 'skipped', how: 'not-run' });
  return out;
}

const list = (xs: readonly string[]) => {
  const shown = xs.slice(0, 12);
  return shown.join(', ') + (xs.length > shown.length ? ` +${xs.length - shown.length}` : '');
};

/**
 * Сводная строка проверки: по gate — итог последней фазы (интеграция, иначе
 * кандидат); ревью — кто читал и что решил. Слово «проверено» — только с
 * тем, кто и как проверял.
 */
export function verificationLines(
  rows: readonly VerificationRow[],
  lineMax = 1000,
): { line: string; lineEn: string } {
  const final = new Map<string, VerificationRow>();
  for (const r of rows) {
    if (r.kind !== 'gate') continue;
    const key = gateName(r);
    const prior = final.get(key);
    if (!prior || r.phase === 'integration' || prior.phase !== 'integration') final.set(key, r);
  }
  const by = (result: VerificationResult) =>
    [...final.values()].filter((r) => r.result === result).map(gateName);
  const executed = by('passed');
  const failed = by('failed');
  const reused = by('reused');
  const notApplicable = by('not-applicable');
  const skipped = by('skipped');
  const reviews = rows.filter((r) => r.kind === 'review');
  const review = reviews.find((r) => r.phase === 'integration') ?? reviews.at(-1);
  const ru: string[] = [
    `Проверено harness (запущено): ${executed.length ? list(executed) : 'ничего'}`,
  ];
  const en: string[] = [
    `Checked by harness (executed): ${executed.length ? list(executed) : 'nothing'}`,
  ];
  if (failed.length) {
    ru.push(`не прошло (запущено harness): ${list(failed)}`);
    en.push(`failed (executed by harness): ${list(failed)}`);
  }
  if (reused.length) {
    ru.push(`взято из записи кандидата (то же дерево): ${list(reused)}`);
    en.push(`reused from the candidate record (same tree): ${list(reused)}`);
  }
  if (review) {
    const who = review.reviewer ? `${review.reviewer.vendor} (${review.reviewer.runtime})` : '—';
    ru.push(
      `ревью: прочитал агент ${who}, только diff, ничего не запускал — ${review.result === 'passed' ? 'одобрил' : 'отклонил'}`,
    );
    en.push(
      `review: read by agent ${who}, diff only, ran nothing — ${review.result === 'passed' ? 'approved' : 'rejected'}`,
    );
  } else {
    ru.push('ревью: не проводилось');
    en.push('review: none');
  }
  const notRu = [
    ...notApplicable.map((g) => `${g} (изменения его не задели)`),
    ...skipped.map((g) => `${g} (не запускался)`),
  ];
  const notEn = [
    ...notApplicable.map((g) => `${g} (not touched by the changes)`),
    ...skipped.map((g) => `${g} (not run)`),
  ];
  if (notRu.length) {
    ru.push(`не проверялось: ${list(notRu)}`);
    en.push(`not covered: ${list(notEn)}`);
  }
  const clip = (s: string) => (s.length > lineMax ? s.slice(0, lineMax - 1) + '…' : s);
  return { line: clip(ru.join('; ')), lineEn: clip(en.join('; ')) };
}

/**
 * Проверка поручения: строки попытки (`verificationAttemptOf`) не больше
 * `limit` и сводная строка по всем строкам. Нет — попыток нет или идущая
 * попытка ещё ничего не записала.
 */
export function verificationOf(
  work: Pick<WorkState, 'status'>,
  attempts: readonly AttemptState[],
  limits: { rows?: number; line?: number } = {},
): WorkVerification | undefined {
  const limit = limits.rows ?? verificationRowLimit;
  const a = verificationAttemptOf(work, attempts);
  if (!a) return undefined;
  const rows = verificationRows(a);
  if (!rows.length && a.status === 'active') return undefined;
  return {
    runId: a.id,
    rows: rows.slice(0, limit),
    ...(rows.length > limit ? { rowsTruncated: rows.length - limit } : {}),
    ...verificationLines(rows, limits.line),
  };
}
