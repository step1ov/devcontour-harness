import { expandGateRefs, type ExecutionPolicy, type RunResult } from '../../contracts/index.ts';
import type { ConnectorConfig, TaskMapping } from './config.ts';

/**
 * Проверка привязок критериев до запуска (P4-6): каждый критерий связанной
 * задачи обязан доказываться тем, что коннектор умеет доказать, — прошедшим
 * gate (`evidence: gate`) или названным testcase JUnit (`evidence: test`)
 * gate задачи с JUnit-отчётом. ID testcase — `classname.name` отчёта:
 * node:test пишет `classname="test"`, и тест `orders.api.access` в отчёте —
 * `test.orders.api.access`. Привязка без этой приставки ни одного критерия не
 * закроет: принятый результат доставится, а задача останется открытой.
 *
 * Известные testcases берутся из evidence фазы интеграции прежних попыток
 * этого каталога состояния (`knownTestcases`). Новый тест, которого ещё не
 * было ни в одном отчёте, не ошибка: его напишет исполнитель.
 */

export interface BindingIssue {
  /** `error` — критерий не доказать (отказ запуска); `warning` — вероятная ошибка ID. */
  level: 'error' | 'warning';
  ref: string;
  criterion: string;
  message: string;
}

/** testcases gate по evidence интеграции: gate → ID. */
export type KnownTestcases = Map<string, Set<string>>;

export function knownTestcases(evidence: Iterable<RunResult['evidence'][number]>): KnownTestcases {
  const out: KnownTestcases = new Map();
  for (const e of evidence) {
    if (e.phase !== 'integration' || e.consumer || !e.tests?.length) continue;
    const set = out.get(e.gate) ?? new Set<string>();
    for (const t of e.tests) if (!t.opaque) set.add(t.id);
    out.set(e.gate, set);
  }
  return out;
}

/** Приставка classname, общая для всех известных testcases gate (`test.`), или undefined. */
const commonClassname = (ids: Set<string>) => {
  let prefix: string | undefined;
  for (const id of ids) {
    const dot = id.indexOf('.');
    if (dot <= 0) return undefined;
    const p = id.slice(0, dot + 1);
    if (prefix === undefined) prefix = p;
    else if (prefix !== p) return undefined;
  }
  return prefix;
};

const label = (c: TaskMapping['criteria'][number]) => c.id ?? c.title ?? '?';

export function criteriaBindingIssues(
  config: ConnectorConfig,
  policy: ExecutionPolicy | undefined,
  known: KnownTestcases = new Map(),
): BindingIssue[] {
  const issues: BindingIssue[] = [];
  for (const m of config.tasks) {
    const repoId = m.repositoryId ?? config.repository.id;
    const repo = policy?.repositories.find((r) => r.id === repoId);
    let scope: string[] | undefined;
    try {
      // Evidence результата — по своим и регрессионным gates (alpha.76).
      scope = repo
        ? [
            ...expandGateRefs(repo, m.gates),
            ...(m.regressionGates ? expandGateRefs(repo, m.regressionGates) : []),
          ]
        : undefined;
    } catch {
      scope = undefined;
    }
    for (const c of m.criteria) {
      const issue = (level: BindingIssue['level'], message: string) =>
        issues.push({ level, ref: m.ref, criterion: label(c), message });
      if (repo) {
        const gate = repo.gates.find((g) => g.id === c.gate);
        if (!gate) {
          issue('error', `gate ${c.gate} не объявлен в политике репозитория ${repoId}`);
          continue;
        }
        if (scope && !scope.includes(c.gate)) {
          issue(
            'error',
            `gate ${c.gate} не входит в gates задачи: его evidence у результата не будет`,
          );
          continue;
        }
        if (c.evidence === 'test' && !gate.report) {
          issue(
            'error',
            `evidence: test, но у gate ${c.gate} нет JUnit-отчёта: testcase ${c.testId} не доказать (evidence: gate или отчёт у gate)`,
          );
          continue;
        }
      }
      if (c.evidence !== 'test' || !c.testId) continue;
      const ids = known.get(c.gate);
      if (!ids?.size || ids.has(c.testId)) continue;
      const near = [...ids].find(
        (id) => id.endsWith('.' + c.testId) || c.testId!.endsWith('.' + id),
      );
      if (near) {
        issue(
          'error',
          `testcase ${c.testId} нет в отчётах gate ${c.gate}, есть ${near}: ID testcase — classname.name, укажите testId «${near}»`,
        );
        continue;
      }
      const prefix = commonClassname(ids);
      if (prefix && !c.testId.startsWith(prefix))
        issue(
          'warning',
          `testcase ${c.testId} ещё не встречался в отчётах gate ${c.gate}, а все его testcases начинаются с «${prefix}» (classname.name): проверьте testId`,
        );
    }
  }
  return issues;
}

export const bindingIssueText = (i: BindingIssue) =>
  `${i.ref}: критерий «${i.criterion}»: ${i.message}`;
