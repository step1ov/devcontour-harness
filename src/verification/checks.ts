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

type Declared = {
  contract: ContractDocument;
  /** Первый gate обязательства (у обязательства без `gates` — gate договора). */
  gate: string;
  gates: string[];
  obligation: Obligation;
};

/** Gates обязательства: свои `gates` или gate договора. */
export function obligationGates(declaration: Pick<CheckDeclaration, 'gate'>, o: Obligation) {
  return o.gates?.length ? o.gates : [declaration.gate];
}

/** Обязательство проверяется закреплёнными эталонными наборами. */
export const isReference = (o: Obligation) => o.verification === 'reference';

/** Обязательства договоров поручения, исполняемые данным gate. */
function declared(contracts: ContractDocument[], gate?: string): Declared[] {
  return contracts
    .filter((c) => c.checks)
    .flatMap((c) =>
      c.checks!.obligations.flatMap((o) => {
        const gates = obligationGates(c.checks!, o);
        return gate === undefined || gates.includes(gate)
          ? [{ contract: c, gate: gates[0]!, gates, obligation: o }]
          : [];
      }),
    );
}

/** Основание случаев корпуса: закреплённые файлы, gate и смысл обязательств. */
export function suiteBasis(contract: ContractDocument) {
  const declaration = contract.checks!;
  return digestOf({
    artifacts: (contract.artifacts ?? []).map((a) => ({ path: a.path, blob: a.blob })),
    gate: declaration.gate,
    // Поля эталонной проверки и gates обязательства входят, только когда
    // объявлены: основание прежних договоров и их корпусов не меняется.
    obligations: declaration.obligations.map((o) => ({
      property: o.property,
      domain: o.domain,
      answer: o.answer,
      method: o.method,
      ...(o.gates ? { gates: o.gates } : {}),
      ...(o.verification ? { verification: o.verification } : {}),
      ...(o.reference ? { reference: o.reference } : {}),
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
 * Структурные пропуски эталонной проверки. Наборы — артефакты контракта;
 * каждый gate обязательства сверяет хотя бы один набор, а доли наборов
 * покрывают общий минимум и минимум каждого семейства: иначе gates прошли бы,
 * не доказав объявленного покрытия. Сверка эталона с расхождениями — не
 * основание для эталона.
 */
function referenceProblems(o: Obligation, gates: string[], artifacts: string[]) {
  const at = `свойство ${o.property}`;
  const r = o.reference;
  if (!r) return [`${at}: для способа reference опишите эталонные наборы (reference)`];
  const problems: string[] = [];
  for (const c of r.crossChecks)
    if (c.matches > c.total)
      problems.push(`${at}: сверка эталона «${c.family}»: совпало ${c.matches} из ${c.total}`);
    else if (c.matches < c.total)
      problems.push(
        `${at}: сверка эталона «${c.family}» расходится (${c.matches} из ${c.total}): эталон с расхождениями не закрепляет ответы`,
      );
  const families = new Map(o.coverage.families.map((f) => [f.id, 0]));
  let total = 0;
  for (const [i, set] of r.sets.entries()) {
    const label = `${at}, набор ${i + 1}`;
    if (!gates.includes(set.gate))
      problems.push(
        `${label}: gate ${set.gate} не среди gates обязательства (${gates.join(', ')})`,
      );
    for (const path of set.artifacts)
      if (!artifacts.includes(path))
        problems.push(`${label}: ${path} не объявлен артефактом контракта и не закреплён`);
    const ids = set.families.map((f) => f.id);
    if (new Set(ids).size !== ids.length) problems.push(`${label}: id семейств повторяются`);
    const own = set.families.reduce((n, f) => n + f.minCases, 0);
    if (own > set.minCases)
      problems.push(
        `${label}: семейства требуют ${own} входов, больше минимума набора ${set.minCases}`,
      );
    for (const f of set.families)
      if (!families.has(f.id)) problems.push(`${label}: семейство ${f.id} не объявлено в покрытии`);
      else families.set(f.id, families.get(f.id)! + f.minCases);
    total += set.minCases;
  }
  for (const id of gates)
    if (!r.sets.some((s) => s.gate === id))
      problems.push(`${at}: gate ${id} не сверяет ни одного эталонного набора`);
  if (total < o.coverage.minCases)
    problems.push(
      `${at}: наборы требуют ${total} входов, меньше общего минимума ${o.coverage.minCases}`,
    );
  for (const f of o.coverage.families) {
    const seen = families.get(f.id) ?? 0;
    if (seen < f.minCases)
      problems.push(
        `${at}, семейство ${f.id}: наборы требуют ${seen} входов, меньше минимума семейства ${f.minCases}`,
      );
  }
  return problems;
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
    const gates = obligationGates(declaration, o);
    if (new Set(gates).size !== gates.length) problems.push(`${at}: gates повторяются`);
    const configured = (id: string) => context.gates.find((g) => g.id === id);
    if (o.gates)
      for (const id of new Set(o.gates))
        if (id !== declaration.gate && !configured(id))
          problems.push(`${at}: gate ${id} не настроен в репозитории ${context.repositoryId}`);
    const reference = isReference(o);
    if (reference) problems.push(...referenceProblems(o, gates, context.artifacts));
    else if (o.reference)
      problems.push(`${at}: эталонные наборы объявлены, но способ исполнения не reference`);
    if (strongPromises.has(o.promise)) {
      if (!['oracle', 'certificate', 'analytic', 'invariant'].includes(o.method.kind))
        problems.push(
          `${at}: для обещания ${o.promise} нужен независимый способ проверки (эталон, сертификат, аналитическое основание или инвариант), а не ${o.method.kind}`,
        );
      if (!o.method.artifacts.length && o.method.kind !== 'analytic')
        problems.push(`${at}: способ проверки не ссылается на закреплённый checker или эталон`);
      // Генеративность нужна генератору: эталонная проверка сверяет
      // реализацию с закреплёнными наборами и отчитывается тем же отчётом.
      if (!reference)
        for (const id of new Set(gates)) {
          const g = configured(id);
          if (g && !g.property) problems.push(`${at}: gate ${g.id} не генеративный (нет property)`);
        }
    }
    if (o.promise === 'performance' && !o.resources.benchmark)
      problems.push(`${at}: для производительности укажите метод измерения и среду`);
    if (o.coverage.corpus && !declaration.corpus)
      problems.push(`${at}: корпус включён, но политика расширения корпуса не описана`);
    // Случай корпуса подтверждает и исполняет один gate договора.
    if (o.coverage.corpus && (reference || gates.some((id) => id !== declaration.gate)))
      problems.push(
        reference
          ? `${at}: корпус пополняет генератор; эталонные наборы закреплены артефактами контракта`
          : `${at}: корпус исполняет gate договора ${declaration.gate}, а не свои gates обязательства`,
      );
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
 * Подсказка reviewer контракта об эталонных обязательствах: что наборы
 * доказывают, чего — нет (`gaps`), чем сверен эталон. Пустая строка — таких
 * обязательств нет. Reviewer видит пределы способа рядом с самим договором,
 * а не выводит их из длинного описания.
 */
export function referenceNote(declaration: CheckDeclaration | undefined) {
  const list = (declaration?.obligations ?? []).filter((o) => isReference(o) && o.reference);
  if (!list.length) return '';
  return (
    'Reference-set obligations (verification "reference"): the gates replay pinned reference answer sets (contract artifacts) against the implementation and report the replayed inputs per property and family; the controller requires each gate to reach its declared share. Judge them as follows: the oracle must be independent of the implementation and its stated limits must not silently bias the sets toward easy inputs; a cross-check with mismatches or on an unrelated family is not evidence; the sets prove the answer only on the inputs they contain. The "gaps" of each obligation state what the sets do not prove (generalization beyond the set, input classes outside it): a promise that rests on a gap without another declared method (a generative property, an invariant or an analytic argument) is a blocking finding. Obligations: ' +
    JSON.stringify(
      list.map((o) => ({
        property: o.property,
        promise: o.promise,
        gates: obligationGates(declaration!, o),
        oracle: o.reference!.oracle,
        crossChecks: o.reference!.crossChecks,
        sets: o.reference!.sets.map((s) => ({
          gate: s.gate,
          artifacts: s.artifacts,
          minCases: s.minCases,
        })),
        gaps: o.reference!.gaps,
      })),
    )
  );
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
    const { gates: own, obligation } = found[0]!;
    for (const gate of own) {
      if (gates.scope && !gates.scope.includes(gate))
        problems.push(
          `${order.id}: свойство ${id} проверяет gate ${gate}, которого нет в поручении`,
        );
      // Селектор свойств передаёт controller, а исполняет harness генеративного
      // gate: без него область поручения в общем файле проверок не выбрать.
      // Эталонная проверка получает тот же селектор и путь отчёта от
      // controller по манифесту поручения, без генератора.
      const configured = gates.configured.find((g) => g.id === gate);
      if (!configured) problems.push(`${order.id}: gate ${gate} свойства ${id} не настроен`);
      else if (!configured.property && !isReference(obligation))
        problems.push(
          `${order.id}: gate ${gate} свойства ${id} не генеративный — селектор свойств не подготовлен`,
        );
    }
  }
  // Сценарий, названный тем же id, проверяет тот же gate: иначе требование
  // ссылается на свойство, а подтверждается другой проверкой.
  for (const link of order.requirements ?? []) {
    if (!link.testId) continue;
    const found = all.find((x) => x.obligation.property === link.testId);
    if (found && !found.gates.includes(link.gate))
      problems.push(
        `${order.id}: ${link.id} ссылается на свойство ${link.testId}, но через gate ${link.gate}, а не ${found.gates.join(' или ')}`,
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
    properties: obligations.map(({ obligation: o }) =>
      isReference(o) && o.reference
        ? referenceShare(o, gate)
        : {
            id: o.property,
            minCases: o.coverage.minCases,
            families: o.coverage.families.map((f) => ({ id: f.id, minCases: f.minCases })),
          },
    ),
    ...(corpus && cases.length ? { corpus: { digest: corpus.digest, cases } } : {}),
  };
}

/**
 * Доля gate в эталонной проверке: сумма минимумов его наборов и их семейств
 * и закреплённые файлы этих наборов. Отчёт gate обязан подтвердить именно
 * её — общий минимум обязательства складывается из долей его gates.
 */
function referenceShare(o: Obligation, gate: string): CheckManifest['properties'][number] {
  const sets = o.reference!.sets.filter((s) => s.gate === gate);
  const families = new Map<string, number>();
  for (const s of sets)
    for (const f of s.families) families.set(f.id, (families.get(f.id) ?? 0) + f.minCases);
  return {
    id: o.property,
    minCases: sets.reduce((n, s) => n + s.minCases, 0),
    families: [...families].map(([id, minCases]) => ({ id, minCases })),
    reference: { artifacts: [...new Set(sets.flatMap((s) => s.artifacts))] },
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
