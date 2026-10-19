import {
  WORKSPACE_OWNER,
  digestOf,
  type CheckDeclaration,
  type CheckSuite,
  type ContractDocument,
  type ExecutionView,
  type GatePolicy,
  type Obligation,
  type WorkOrder,
  type WorkState,
} from '../contracts/index.ts';
import { strongPromises } from '../contracts/index.ts';
import type { CheckManifest } from './property.ts';

/**
 * Договоры проверки поручения. Механизм включает само поручение полем
 * `properties`; поручение без него проверяется на прежнем уровне.
 */

/** Документы контрактов поручения по закреплённым digest; неизвестный — отсутствует. */
export function contractDocuments(
  order: Pick<WorkOrder, 'contracts'>,
  view: ExecutionView,
): ContractDocument[] {
  return order.contracts
    .map((ref) => view.local('contract-documents', WORKSPACE_OWNER, ref.digest))
    .filter((d): d is ContractDocument => !!d);
}

type Declared = { contract: ContractDocument; gate: string; obligation: Obligation };

/** Обязательства договоров поручения, исполняемые данным gate. */
function declared(contracts: ContractDocument[], gate?: string): Declared[] {
  return contracts
    .filter((c) => c.checks)
    .flatMap((c) =>
      c.checks!.gate === gate || gate === undefined
        ? c.checks!.obligations.map((o) => ({ contract: c, gate: c.checks!.gate, obligation: o }))
        : [],
    );
}

/** Основание случаев корпуса: закреплённые файлы, gate и смысл обязательств. */
export function suiteBasis(contract: ContractDocument) {
  const declaration = contract.checks!;
  return digestOf({
    artifacts: (contract.artifacts ?? []).map((a) => ({ path: a.path, blob: a.blob })),
    gate: declaration.gate,
    obligations: declaration.obligations.map((o) => ({
      property: o.property,
      domain: o.domain,
      answer: o.answer,
      method: o.method,
    })),
  });
}

/**
 * Привязка поручения к версии корпуса остаётся в силе, только пока среди его
 * договоров есть договор этого корпуса с тем же нормативным основанием.
 * Изменение постороннего контракта её не снимает; новый ID или новые правила
 * того же ID — снимают: ожидания прежнего основания не становятся нормой для
 * новых правил.
 */
export function corpusBindingHolds(
  suite: Pick<CheckSuite, 'contractId' | 'basis'> | undefined,
  contracts: ContractDocument[],
  /** Основание корпуса по формуле хоста; без неё — формула harness. */
  basisOf: (contract: ContractDocument) => string = suiteBasis,
) {
  if (!suite) return false;
  const contract = contracts.find((c) => c.id === suite.contractId && c.checks);
  return !!contract && basisOf(contract) === suite.basis;
}

/** Обязательство по property ID среди договоров поручения. */
export function obligationOf(contracts: ContractDocument[], id: string) {
  return declared(contracts).find((x) => x.obligation.property === id);
}

/**
 * Структурные пропуски договора проверки — до вызова модели. Способ проверки
 * обязан ссылаться на закреплённые файлы контракта: иначе происхождение
 * эталона не закреплено ничем.
 */
export function declarationProblems(
  declaration: CheckDeclaration,
  context: {
    gates: GatePolicy[];
    repositoryId: string;
    artifacts: string[];
    spike?: (id: string) => { digest: string } | undefined;
  },
): string[] {
  const problems: string[] = [];
  const gate = context.gates.find((g) => g.id === declaration.gate);
  if (!gate)
    problems.push(`gate ${declaration.gate} не настроен в репозитории ${context.repositoryId}`);
  const ids = declaration.obligations.map((o) => o.property);
  for (const id of new Set(ids))
    if (ids.filter((x) => x === id).length > 1) problems.push(`свойство ${id} объявлено дважды`);
  for (const o of declaration.obligations) {
    const at = `свойство ${o.property}`;
    if (o.promise === 'other' && !o.explanation)
      problems.push(`${at}: для типа other объясните, какое это обещание`);
    const families = o.coverage.families.map((f) => f.id);
    if (new Set(families).size !== families.length)
      problems.push(`${at}: id семейств входов повторяются`);
    const sum = o.coverage.families.reduce((n, f) => n + f.minCases, 0);
    if (sum > o.coverage.minCases)
      problems.push(
        `${at}: семейства требуют ${sum} входов, больше общего минимума ${o.coverage.minCases}`,
      );
    for (const path of o.method.artifacts)
      if (!context.artifacts.includes(path))
        problems.push(`${at}: ${path} не объявлен артефактом контракта и не закреплён`);
    if (strongPromises.has(o.promise)) {
      if (!['oracle', 'certificate', 'analytic', 'invariant'].includes(o.method.kind))
        problems.push(
          `${at}: для обещания ${o.promise} нужен независимый способ проверки (эталон, сертификат, аналитическое основание или инвариант), а не ${o.method.kind}`,
        );
      if (!o.method.artifacts.length && o.method.kind !== 'analytic')
        problems.push(`${at}: способ проверки не ссылается на закреплённый checker или эталон`);
      if (gate && !gate.property)
        problems.push(`${at}: gate ${gate.id} не генеративный (нет property)`);
    }
    if (o.promise === 'performance' && !o.resources.benchmark)
      problems.push(`${at}: для производительности укажите метод измерения и среду`);
    if (o.coverage.corpus && !declaration.corpus)
      problems.push(`${at}: корпус включён, но политика расширения корпуса не описана`);
    if (o.hard) {
      if (!o.feasibility)
        problems.push(
          `${at}: тяжёлое обязательство требует ограниченного эксперимента до реализации (spike)`,
        );
      else {
        const spike = context.spike?.(o.feasibility.spike);
        if (!spike) problems.push(`${at}: эксперимент ${o.feasibility.spike} не найден`);
        else if (spike.digest !== o.feasibility.digest)
          problems.push(`${at}: эксперимент ${o.feasibility.spike} изменился после ссылки на него`);
      }
    }
  }
  return problems;
}

/**
 * Свойства, объявленные поручением, существуют в его договорах и исполняются
 * его генеративными gates. Поручение без `properties` — прежний уровень.
 */
export function orderPropertyProblems(
  order: Pick<WorkOrder, 'id' | 'properties' | 'gates' | 'requirements'>,
  contracts: ContractDocument[],
  /** Gates репозитория поручения и раскрытая область поручения. */
  gates: { configured: GatePolicy[]; scope?: string[] },
) {
  if (!order.properties?.length) return [];
  const problems: string[] = [];
  const all = declared(contracts);
  if (new Set(order.properties).size !== order.properties.length)
    problems.push(`${order.id}: свойства поручения повторяются`);
  for (const id of order.properties) {
    const found = all.filter((x) => x.obligation.property === id);
    if (!found.length) {
      problems.push(`${order.id}: свойство ${id} не объявлено в договорах поручения`);
      continue;
    }
    if (found.length > 1)
      problems.push(`${order.id}: свойство ${id} объявлено в нескольких договорах`);
    const gate = found[0]!.gate;
    if (gates.scope && !gates.scope.includes(gate))
      problems.push(`${order.id}: свойство ${id} проверяет gate ${gate}, которого нет в поручении`);
    // Селектор свойств передаёт controller, а исполняет harness генеративного
    // gate: без него область поручения в общем файле проверок не выбрать.
    const configured = gates.configured.find((g) => g.id === gate);
    if (!configured) problems.push(`${order.id}: gate ${gate} свойства ${id} не настроен`);
    else if (!configured.property)
      problems.push(
        `${order.id}: gate ${gate} свойства ${id} не генеративный — селектор свойств не подготовлен`,
      );
  }
  // Сценарий, названный тем же id, проверяет тот же gate: иначе требование
  // ссылается на свойство, а подтверждается другой проверкой.
  for (const link of order.requirements ?? []) {
    if (!link.testId) continue;
    const found = all.find((x) => x.obligation.property === link.testId);
    if (found && found.gate !== link.gate)
      problems.push(
        `${order.id}: ${link.id} ссылается на свойство ${link.testId}, но через gate ${link.gate}, а не ${found.gate}`,
      );
  }
  return problems;
}

/** Случаи корпуса, закреплённые за попыткой. */
export interface CorpusSnapshot {
  digest: string;
  cases: { id: string; property: string }[];
}

/**
 * Манифест ожидаемой проверки gate для поручения или undefined — прежний
 * уровень доказательства (поручение не включило механизм).
 */
export function orderCheckManifest(
  order: Pick<WorkOrder, 'properties'>,
  contracts: ContractDocument[],
  gate: string,
  corpus?: CorpusSnapshot,
): CheckManifest | undefined {
  if (!order.properties?.length) return undefined;
  const obligations = declared(contracts, gate).filter((x) =>
    order.properties!.includes(x.obligation.property),
  );
  if (!obligations.length) return undefined;
  const ids = new Set(obligations.map((x) => x.obligation.property));
  const cases = corpus?.cases.filter((c) => ids.has(c.property)) ?? [];
  return {
    properties: obligations.map(({ obligation: o }) => ({
      id: o.property,
      minCases: o.coverage.minCases,
      families: o.coverage.families.map((f) => ({ id: f.id, minCases: f.minCases })),
    })),
    ...(corpus && cases.length ? { corpus: { digest: corpus.digest, cases } } : {}),
  };
}

/**
 * Действующая версия проверок поручения: согласованная постановка,
 * контракты, политика и принятый snapshot корпуса. Закрепляется в попытке
 * при выдаче и участвует в evidence, finish, recovery и reuse.
 */
export function effectiveChecks(
  work: Pick<WorkState, 'approvedDigest' | 'order' | 'checkVersion'>,
  policyDigest: string,
) {
  return digestOf({
    spec: work.approvedDigest ?? null,
    contracts: Object.fromEntries(work.order.contracts.map((c) => [c.id, c.digest])),
    policy: policyDigest,
    corpus: work.checkVersion?.digest ?? null,
  });
}

/** Основание эпизода восстановления: согласованная постановка и контракты. */
export function episodeBasis(work: Pick<WorkState, 'approvedDigest' | 'order'>) {
  return digestOf({
    spec: work.approvedDigest ?? null,
    contracts: Object.fromEntries(work.order.contracts.map((c) => [c.id, c.digest])),
  });
}
