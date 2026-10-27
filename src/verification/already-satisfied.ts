import type {
  AlreadySatisfied,
  ContractDocument,
  EvidenceRecord,
  GatePolicy,
} from '../contracts/index.ts';
import { obligationGates } from './checks.ts';

/** Gates договоров проверки поручения. */
export const contractCheckGates = (contracts: ContractDocument[]) =>
  contracts.flatMap((c) =>
    c.checks ? c.checks.obligations.flatMap((o) => obligationGates(c.checks!, o)) : [],
  );

/**
 * Механическое основание считать работу поручения уже сделанной без изменений.
 * `contract` — договор проверки поручения: его gates в области задачи, и
 * reviewer на них сослался. `dependency` — зависимость поручения своим
 * кандидатом (`sha`) изменила файлы его области записи (`paths`): работу
 * сделала она. Записывает controller, а не reviewer.
 */
export type AlreadySatisfiedBasis = NonNullable<
  NonNullable<EvidenceRecord['alreadySatisfied']>['basis']
>;

const within = (path: string, prefixes: string[]) =>
  prefixes.some((p) => p === '.' || path === p || path.startsWith(p.endsWith('/') ? p : p + '/'));

export interface AlreadySatisfiedInput {
  /** Gates области задачи (исполненные попыткой). */
  scope: Pick<GatePolicy, 'id' | 'kind'>[];
  /** Gates договоров проверки поручения (все, а не только в области). */
  contractGates: string[];
  writeScope: string[];
  dependsOn: string[];
  claim: AlreadySatisfied | undefined;
  /** Основание по зависимости, найденное controller (или записанное им). */
  dependency?: Extract<AlreadySatisfiedBasis, { kind: 'dependency' }>;
}

export type AlreadySatisfiedVerdict =
  | { ok: true; basis: AlreadySatisfiedBasis }
  | { ok: false; kind: 'empty-result' | 'needs-lead'; problem: string };

/**
 * Правило «приёмка уже выполнена» — одно для ревью попытки и для
 * `engine.finish`. Подтверждение reviewer необходимо, но не достаточно:
 * зелёный общий gate на базе не доказывает, что новая работа есть (её тестов
 * ещё нет). Достаточно одного из механических оснований: договор проверки
 * поручения, все gates которого в области задачи и названы reviewer, или
 * зависимость, изменившая область записи поручения. Без основания — решение
 * ведущего (`needs-lead`), а не `done`.
 */
export function alreadySatisfiedVerdict(input: AlreadySatisfiedInput): AlreadySatisfiedVerdict {
  const empty = (problem: string) => ({
    ok: false as const,
    kind: 'empty-result' as const,
    problem,
  });
  const lead = (problem: string) => ({ ok: false as const, kind: 'needs-lead' as const, problem });
  const { claim } = input;
  if (!claim) return empty('ответ не содержит alreadySatisfied');
  if (claim.evidence.replace(/\s+/g, '').length < 20)
    return empty('основание alreadySatisfied.evidence короче 20 знаков');
  const scope = new Set(input.scope.map((g) => g.id));
  const outside = claim.gates.filter((g) => !scope.has(g));
  if (outside.length) return empty('названы gates вне области задачи: ' + outside.join(', '));
  if (!claim.gates.some((id) => input.scope.some((g) => g.id === id && g.kind === 'test')))
    return empty('не назван ни один test gate');
  const contract = [...new Set(input.contractGates)];
  const unscoped = contract.filter((g) => !scope.has(g));
  if (unscoped.length)
    return lead('проверки договора поручения вне области задачи: ' + unscoped.join(', '));
  const missing = contract.filter((g) => !claim.gates.includes(g));
  if (missing.length) return empty('не названы проверки договора поручения: ' + missing.join(', '));
  if (contract.length) return { ok: true, basis: { kind: 'contract', gates: contract } };
  const d = input.dependency;
  if (
    d &&
    input.dependsOn.includes(d.workId) &&
    d.paths.length > 0 &&
    d.paths.every((p) => within(p, input.writeScope))
  )
    return { ok: true, basis: d };
  return lead(
    'нет механического основания: у поручения нет договора проверки, и ни одна его зависимость не меняла его область записи',
  );
}

export { within as withinWriteScope };
