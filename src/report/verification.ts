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
/**
 * Общий предел байт проверки поручений отчёта (JSON UTF-8): сверх него у
 * поручения остаются только строки `line`/`lineEn` с числом `rowsTruncated`,
 * затем проверка опускается — отчёт держит `REPORT_LIMITS.jsonBytes`.
 */
export const verificationReportBytes = 64 * 1024;

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
  /**
   * Только у ревью: что reviewer делал по записи controller (`inspection`:
   * `diff-only` — команд не запускал, `commands` — запускал, `commands` —
   * их число; `unknown` — не записано) и протокол ответа (`invalid`,
   * `unsafe` — вердикта нет).
   */
  review?: {
    inspection: 'commands' | 'diff-only' | 'unknown';
    commands?: number;
    protocol?: 'valid' | 'invalid' | 'unsafe';
  };
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

/** Запуск gate не состоялся: песочница не запустила команду (отказ среды). */
const notLaunched = (summary: string) => summary.includes('песочница ОС не запустила команду');

/** Что известно о действиях reviewer по записи ревью. */
function reviewFacts(e: AttemptState['evidence'][number]): NonNullable<VerificationRow['review']> {
  const protocol = e.reviewRound?.protocol;
  const i = e.inspection;
  const inspection: 'commands' | 'diff-only' | 'unknown' =
    !i || i.source === 'unavailable' ? 'unknown' : i.mode;
  return {
    inspection,
    ...(inspection === 'commands' ? { commands: i!.total ?? i!.commands.length } : {}),
    ...(protocol ? { protocol } : {}),
  };
}

/**
 * Строки проверки попытки: последняя запись каждого gate и ревью в каждой
 * фазе на текущем SHA фазы (запись прежнего SHA кандидата — не проверка
 * текущего). У закончившейся попытки обязательный gate без записи — `skipped`:
 * кандидата всегда, интеграции — если попытка дошла до неё; gate потребителя
 * без записи — `skipped` интеграции.
 */
export function verificationRows(a: AttemptState): VerificationRow[] {
  const rows = new Map<string, VerificationRow>();
  const current = { candidate: a.candidateSha, integration: a.integrationSha };
  for (const e of a.evidence) {
    const at = current[e.phase];
    if (at && e.sha !== at) continue;
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
    if (e.kind === 'review') {
      const review = reviewFacts(e);
      rows.set(key, {
        ...base,
        result: e.passed ? 'passed' : 'failed',
        how: 'read-by-reviewer',
        reviewer: { runtime: a.reviewer, vendor: vendorOfRuntime(a.reviewer) },
        review,
      });
    } else if (e.kind === 'not-applicable')
      rows.set(key, { ...base, result: 'not-applicable', how: 'not-run' });
    else if (e.reusedEvidence)
      rows.set(key, { ...base, result: e.passed ? 'reused' : 'failed', how: 'reused-evidence' });
    else if (!e.passed && notLaunched(e.summary))
      rows.set(key, { ...base, result: 'failed', how: 'not-run' });
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
  if (a.status === 'active') return out;
  const has = (phase: VerificationRow['phase'], gate: string, consumer?: string) =>
    out.some(
      (r) => r.kind === 'gate' && r.phase === phase && r.gate === gate && r.consumer === consumer,
    );
  const missing: VerificationRow[] = [];
  const reachedIntegration =
    !!a.integrationSha || a.evidence.some((e) => e.phase === 'integration');
  for (const phase of reachedIntegration
    ? (['candidate', 'integration'] as const)
    : (['candidate'] as const))
    for (const gate of new Set(a.requiredGates ?? []))
      if (!has(phase, gate))
        missing.push({ gate, kind: 'gate', phase, result: 'skipped', how: 'not-run' });
  for (const c of a.consumers ?? [])
    for (const gate of new Set(c.gates))
      if (!has('integration', gate, c.repositoryId) && !has('candidate', gate, c.repositoryId))
        missing.push({
          gate,
          kind: 'gate',
          phase: 'integration',
          consumer: c.repositoryId,
          result: 'skipped',
          how: 'not-run',
        });
  return [...out, ...missing];
}

const list = (xs: readonly string[]) => {
  const shown = xs.slice(0, 12);
  return shown.join(', ') + (xs.length > shown.length ? ` +${xs.length - shown.length}` : '');
};

/**
 * Сводная строка проверки по gate обеих фаз: запущен harness (и что было на
 * интеграции — запись кандидата или не запускался), не прошёл, взят из
 * записи кандидата, не запустился, неприменим, не запускался; ревью — кто
 * читал, запускал ли команды по записи controller и что решил. Слово
 * «проверено» — только с тем, кто и как проверял.
 */
export function verificationLines(
  rows: readonly VerificationRow[],
  lineMax = 1000,
): { line: string; lineEn: string } {
  const gates = new Map<string, { candidate?: VerificationRow; integration?: VerificationRow }>();
  for (const r of rows) {
    if (r.kind !== 'gate') continue;
    const g = gates.get(gateName(r)) ?? {};
    g[r.phase] = r;
    gates.set(gateName(r), g);
  }
  const executed: string[] = [];
  const failed: string[] = [];
  const reused: string[] = [];
  const integrationReused: string[] = [];
  const integrationSkipped: string[] = [];
  const notLaunched: string[] = [];
  const notApplicable: string[] = [];
  const skipped: string[] = [];
  for (const [name, g] of gates) {
    const both = [g.candidate, g.integration].filter((r): r is VerificationRow => !!r);
    const ran = (r?: VerificationRow) => r?.how === 'executed-by-harness';
    if (both.some((r) => r.result === 'failed' && ran(r))) failed.push(name);
    else if (both.some((r) => r.result === 'failed')) notLaunched.push(name);
    else if (both.some((r) => r.result === 'passed' && ran(r))) {
      executed.push(name);
      if (g.integration?.result === 'reused') integrationReused.push(name);
      if (g.integration?.result === 'skipped') integrationSkipped.push(name);
    } else if (both.some((r) => r.result === 'reused')) reused.push(name);
    else if (both.some((r) => r.result === 'not-applicable')) notApplicable.push(name);
    else skipped.push(name);
  }
  const reviews = rows.filter((r) => r.kind === 'review');
  const review = reviews.find((r) => r.phase === 'integration') ?? reviews.at(-1);
  const ru: string[] = [
    `Проверено harness (запущено): ${executed.length ? list(executed) : 'ничего'}`,
  ];
  const en: string[] = [
    `Checked by harness (executed): ${executed.length ? list(executed) : 'nothing'}`,
  ];
  if (integrationReused.length) {
    ru.push(`на интеграции взято из записи кандидата (то же дерево): ${list(integrationReused)}`);
    en.push(
      `at integration reused from the candidate record (same tree): ${list(integrationReused)}`,
    );
  }
  if (integrationSkipped.length) {
    ru.push(`на интеграции не запускались: ${list(integrationSkipped)}`);
    en.push(`not run at integration: ${list(integrationSkipped)}`);
  }
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
    const facts = review.review;
    const did =
      facts?.inspection === 'diff-only'
        ? { ru: ', только diff, ничего не запускал', en: ', diff only, ran nothing' }
        : facts?.inspection === 'commands'
          ? {
              ru: ` и запускал команды: ${facts.commands ?? 0} (по записи controller)`,
              en: ` and ran commands: ${facts.commands ?? 0} (controller record)`,
            }
          : { ru: ', запуск команд не записан', en: ', command runs not recorded' };
    const verdict =
      facts?.protocol === 'invalid' || facts?.protocol === 'unsafe'
        ? { ru: 'ответ не по протоколу — вердикта нет', en: 'protocol failure — no verdict' }
        : review.result === 'passed'
          ? { ru: 'одобрил', en: 'approved' }
          : { ru: 'отклонил', en: 'rejected' };
    ru.push(`ревью: прочитал агент ${who}${did.ru} — ${verdict.ru}`);
    en.push(`review: read by agent ${who}${did.en} — ${verdict.en}`);
  } else {
    ru.push('ревью: не проводилось');
    en.push('review: none');
  }
  const notRu = [
    ...notLaunched.map((g) => `${g} (не запустилась — отказ среды)`),
    ...notApplicable.map((g) => `${g} (изменения его не задели)`),
    ...skipped.map((g) => `${g} (не запускался)`),
  ];
  const notEn = [
    ...notLaunched.map((g) => `${g} (did not start — environment failure)`),
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
