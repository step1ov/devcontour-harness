// Один и тот же провал gate у разных попыток (0.1.0-alpha.69): те же
// упавшие тесты и то же утверждение у двух и больше засчитанных провалов
// работы, хотя изменения попыток не связаны (не пересекаются по файлам или
// не трогают тестов). Тогда причина, скорее всего, не в коде задачи, а в
// самом gate или в тесте базы: подсказка ведущему — проверить gate и тест
// базы и прогнать gate на базовом коммите (`harness gates --sha <base>`).
// Только подсказка: ничего не запускает и счёт попыток не меняет. Есть уже
// прогон этого gate на базе — строка называет его исход.
// Чистые правила над записанным состоянием: без node:* и zod.

import type { AttemptState, EvidenceRecord, GateFailureSummary } from '../contracts/execution.ts';

type EvidenceLike = Pick<
  EvidenceRecord,
  'kind' | 'gate' | 'passed' | 'sha' | 'runId' | 'failureSummary'
> & { consumer?: unknown };

export type RepeatedFailureAttempt = Pick<
  AttemptState,
  'id' | 'status' | 'failureKind' | 'baseSha' | 'candidateSha'
> & { evidence: readonly EvidenceLike[] };

/** Как связаны изменения попыток с одинаковым провалом. */
export type RepeatedFailureRelation = 'disjoint' | 'tests-untouched';

export interface RepeatedGateFailure {
  gate: string;
  /** Подпись провала: упавшие тесты и утверждение после нормализации. */
  signature: string;
  tests: string[];
  assertion?: string;
  /** Попытки с этой подписью (по порядку). */
  runIds: string[];
  /** База последней из них. */
  baseSha: string;
  relation: RepeatedFailureRelation;
  /** Прогон этого gate на базе, уже записанный в состоянии; нет — не прогоняли. */
  base?: { outcome: 'same-failure' | 'passed' | 'other-failure'; runId: string };
  /** Команда прогона gate на базе. */
  command: string;
  line: { ru: string; en: string };
}

/** Сколько знаков утверждения входит в строку подсказки. */
const ASSERTION_SHOWN = 200;

/**
 * Утверждение без того, что меняется от прогона к прогону: длительности,
 * хеши и идентификаторы, каталоги попыток (абсолютные пути — до двух
 * последних компонентов), пробелы.
 */
export function normalizeAssertion(text: string) {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, '<t>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/(?:\/[^\s/:'"`]+){3,}/g, (p) => '…/' + p.split('/').slice(-2).join('/'))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Подпись провала: упавшие тесты (по алфавиту) и нормализованное утверждение. */
export function failureSignature(s: GateFailureSummary | undefined): string | undefined {
  if (!s || s.withheld) return undefined;
  const tests = [...new Set(s.tests ?? [])].sort();
  const assertion = s.assertion ? normalizeAssertion(s.assertion) : '';
  if (!tests.length && !assertion) return undefined;
  return JSON.stringify([tests, assertion]);
}

/** Файл теста по пути: каталог тестов или имя `*.test.*` / `*.spec.*`. */
export const isTestPath = (path: string) =>
  /(?:^|\/)(?:tests?|__tests__|specs?|e2e)\//i.test(path) ||
  /[._-](?:test|spec)s?\.[cm]?[jt]sx?$/i.test(path) ||
  /(?:^|\/)test_[^/]*\.py$|_test\.(?:go|py)$/i.test(path);

/** Последний непройденный gate попытки, по которому она засчитана. */
const failedGateOf = (a: RepeatedFailureAttempt) =>
  a.evidence.findLast((e) => e.kind === 'test' && !e.passed && !e.consumer && e.gate);

/**
 * Одинаковый провал gate у засчитанных провалов работы с несвязанными
 * изменениями. `changedFiles(runId)` — файлы изменения попытки `база..кандидат`;
 * не известны у какой-то из попыток — подсказки нет (связь не доказана).
 * `evidenceAt(sha, gate)` — записанные прогоны gate на коммите (любой работы).
 */
export function repeatedGateFailure(
  attempts: readonly RepeatedFailureAttempt[],
  options: {
    changedFiles: (runId: string) => readonly string[] | undefined;
    evidenceAt?: (sha: string, gate: string) => readonly EvidenceLike[];
    /** Флаги команды `harness gates` (каталог состояния, репозиторий). */
    gatesArgs?: string;
  },
): RepeatedGateFailure | undefined {
  const counted = attempts.filter(
    (a) => a.status === 'failed' && a.failureKind === 'gate' && a.candidateSha && a.baseSha,
  );
  const groups = new Map<string, { gate: string; runs: RepeatedFailureAttempt[] }>();
  for (const a of counted) {
    const e = failedGateOf(a);
    const signature = e ? failureSignature(e.failureSummary) : undefined;
    if (!e?.gate || !signature) continue;
    const key = `${e.gate}\u0000${signature}`;
    const group = groups.get(key) ?? { gate: e.gate, runs: [] };
    group.runs.push(a);
    groups.set(key, group);
  }
  // Самая свежая группа из двух и больше разных кандидатов.
  const ordered = [...groups.entries()]
    .filter(([, g]) => new Set(g.runs.map((r) => r.candidateSha)).size >= 2)
    .sort(([, a], [, b]) => counted.indexOf(b.runs.at(-1)!) - counted.indexOf(a.runs.at(-1)!));
  for (const [key, group] of ordered) {
    const files = group.runs.map((r) => options.changedFiles(r.id));
    if (files.some((f) => f === undefined)) continue;
    const sets = files.map((f) => new Set(f));
    const disjoint = sets.every((s, i) =>
      sets.slice(i + 1).every((t) => ![...s].some((x) => t.has(x))),
    );
    const testsUntouched = files.every((f) => !f!.some(isTestPath));
    if (!disjoint && !testsUntouched) continue;
    const last = group.runs.at(-1)!;
    const summary = failedGateOf(last)!.failureSummary!;
    const signature = key.slice(group.gate.length + 1);
    const baseSha = last.baseSha!;
    const baseRuns = (options.evidenceAt?.(baseSha, group.gate) ?? []).filter(
      (e) => e.kind === 'test' && !e.consumer,
    );
    const baseRun = baseRuns.at(-1);
    const base = baseRun
      ? {
          outcome: baseRun.passed
            ? ('passed' as const)
            : failureSignature(baseRun.failureSummary) === signature
              ? ('same-failure' as const)
              : ('other-failure' as const),
          runId: baseRun.runId,
        }
      : undefined;
    const command = `harness gates ${options.gatesArgs ? options.gatesArgs + ' ' : ''}--sha ${baseSha} --gate ${group.gate}`;
    const tests = summary.tests ?? [];
    const what = tests.length
      ? `упали ${tests.slice(0, 3).join('; ')}${tests.length > 3 ? ` и ещё ${tests.length - 3}` : ''}`
      : '';
    const assertion = summary.assertion
      ? summary.assertion.length > ASSERTION_SHOWN
        ? summary.assertion.slice(0, ASSERTION_SHOWN - 1) + '…'
        : summary.assertion
      : undefined;
    const sig = [what, assertion ? `«${assertion}»` : ''].filter(Boolean).join(', ');
    const whatEn = tests.length
      ? `failed ${tests.slice(0, 3).join('; ')}${tests.length > 3 ? ` and ${tests.length - 3} more` : ''}`
      : '';
    const sigEn = [whatEn, assertion ? `"${assertion}"` : ''].filter(Boolean).join(', ');
    const related = disjoint
      ? {
          ru: 'изменения попыток не пересекаются по файлам',
          en: 'the attempts changed disjoint files',
        }
      : { ru: 'изменения попыток не трогают тестов', en: 'the attempts changed no test files' };
    const short = baseSha.slice(0, 12);
    const baseLine =
      base?.outcome === 'same-failure'
        ? {
            ru: `На базе ${short} gate ${group.gate} уже падал так же (прогон ${base.runId}): провал не из кода задачи — ход ведущего — исправить gate или тест базы.`,
            en: `On the base ${short} the gate ${group.gate} already failed the same way (run ${base.runId}): the failure is not from the task code — the lead fixes the gate or the base test.`,
          }
        : base?.outcome === 'passed'
          ? {
              ru: `На базе ${short} gate ${group.gate} проходил (прогон ${base.runId}): проверьте, не задевают ли изменения общий тест или его окружение.`,
              en: `On the base ${short} the gate ${group.gate} passed (run ${base.runId}): check whether the changes touch a shared test or its environment.`,
            }
          : {
              ru: `Проверьте gate и тест базы: прогоните gate на базовом коммите — ${command}.`,
              en: `Check the gate and the base test: run the gate on the base commit — ${command}.`,
            };
    return {
      gate: group.gate,
      signature,
      tests,
      ...(summary.assertion ? { assertion: summary.assertion } : {}),
      runIds: group.runs.map((r) => r.id),
      baseSha,
      relation: disjoint ? 'disjoint' : 'tests-untouched',
      ...(base ? { base } : {}),
      command,
      line: {
        ru: `Один и тот же провал gate ${group.gate} у ${group.runs.length} попыток (${group.runs.map((r) => r.id).join(', ')}): ${sig}, хотя ${related.ru}. ${baseLine.ru}`,
        en: `The same failure of the gate ${group.gate} in ${group.runs.length} attempts (${group.runs.map((r) => r.id).join(', ')}): ${sigEn}, although ${related.en}. ${baseLine.en}`,
      },
    };
  }
  return undefined;
}
