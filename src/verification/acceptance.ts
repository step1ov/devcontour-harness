import {
  HarnessError,
  digestOf,
  type CheckSuite,
  type ContractDocument,
  type EvidenceRecord,
  type ExecutionView,
  type RunResult,
  type WorkOrder,
} from '../contracts/index.ts';
import { obligationOf, orderCheckManifest, type CorpusSnapshot } from './checks.ts';
import { manifestDigest } from './property.ts';

/**
 * Доказательство договора проверки на границе приёмки.
 *
 * Бит PASS и верная версия проверок не доказывают, что генеративный gate
 * исполнил договор поручения: сохранённое evidence без манифеста свойств
 * или с заниженным корпусом выдало бы прежний уровень за сильный. Поэтому и
 * `finish` (а через него recovery), и проверка переносимого результата
 * требуют для каждого gate объявленных свойств решающую запись обеих фаз с
 * манифестом ожидаемой проверки и исполненным обязательным корпусом
 * закреплённой версии. Поручение без `properties` — прежний уровень.
 */

type ProofEvidence = Pick<EvidenceRecord, 'kind' | 'phase' | 'gate' | 'sha' | 'passed'> & {
  consumer?: string | undefined;
  checks?: string | undefined;
  exitCode?: number | undefined;
  property?: Pick<NonNullable<EvidenceRecord['property']>, 'level' | 'manifest'> | undefined;
};

export interface PropertyProofInput {
  order: Pick<WorkOrder, 'properties'>;
  contracts: ContractDocument[];
  candidateSha: string;
  resultSha: string;
  /** Версия проверок попытки (`checks.effective`). */
  effective?: string | undefined;
  /** Случаи закреплённой версии корпуса; `null` — закреплённая версия не найдена. */
  corpus?: CorpusSnapshot | null | undefined;
  evidence: ProofEvidence[];
}

/** Решающая запись gate на фазе: последняя запись этой фазы, SHA и версии. */
function decisive(input: PropertyProofInput, phase: 'candidate' | 'integration', gate: string) {
  const sha = phase === 'candidate' ? input.candidateSha : input.resultSha;
  return input.evidence.findLast(
    (e) =>
      e.kind === 'test' &&
      e.phase === phase &&
      e.gate === gate &&
      e.sha === sha &&
      e.consumer === undefined &&
      e.checks === input.effective,
  );
}

/** Gates объявленных свойств поручения и их свойства. */
export function propertyGates(order: Pick<WorkOrder, 'properties'>, contracts: ContractDocument[]) {
  const byGate = new Map<string, string[]>();
  for (const id of order.properties ?? []) {
    const found = obligationOf(contracts, id);
    if (!found) return { problem: `свойство ${id} не объявлено в договорах поручения` };
    byGate.set(found.gate, [...(byGate.get(found.gate) ?? []), id]);
  }
  return { byGate };
}

/** Причина отказа в доказательстве свойств или undefined. */
export function propertyProofProblem(input: PropertyProofInput): string | undefined {
  if (!input.order.properties?.length) return undefined;
  if (!input.effective) return 'поручение с договором проверки без версии проверок';
  if (input.corpus === null) return 'закреплённая версия корпуса не найдена или подменена';
  const gates = propertyGates(input.order, input.contracts);
  if (gates.problem) return gates.problem;
  for (const [gate, ids] of gates.byGate!) {
    const expected = orderCheckManifest(
      input.order,
      input.contracts,
      gate,
      input.corpus ?? undefined,
    );
    const own = expected?.corpus?.cases.length ?? 0;
    for (const phase of ['candidate', 'integration'] as const) {
      // Gate свойства обязателен независимо от состава requiredGates: иначе
      // проваленный gate свойства можно было бы исключить и подставить другой PASS.
      const check = decisive(input, phase, gate);
      if (!check?.passed || (check.exitCode !== undefined && check.exitCode !== 0))
        return `Нет PASS: ${phase}/${gate}`;
      const manifest = check.property?.manifest;
      if (
        check.property?.level !== 'manifest' ||
        !manifest ||
        ids.some((id) => !manifest.properties.includes(id))
      )
        return `${phase}/${gate} без манифеста свойств поручения`;
      if (
        own
          ? manifest.corpus?.digest !== input.corpus!.digest || manifest.corpus.cases !== own
          : manifest.corpus !== undefined
      )
        return `${phase}/${gate} не исполнял обязательный корпус закреплённой версии`;
      if (!expected || manifest.digest !== manifestDigest(expected))
        return `${phase}/${gate}: манифест не соответствует договору поручения`;
    }
  }
  return undefined;
}

/** Случаи закреплённой версии корпуса по состоянию исполнения. */
export function pinnedCorpus(
  view: ExecutionView,
  binding: { suite: string; digest: string },
): CorpusSnapshot | null {
  const suite = view
    .locals('check-suites')
    .map((x) => x.value)
    .find((s) => s.id === binding.suite);
  return suiteCorpus(suite, binding.digest);
}

/** Случаи версии корпуса по digest; `null` — версии нет. */
export function suiteCorpus(
  suite: Pick<CheckSuite, 'versions' | 'cases'> | undefined,
  digest: string,
): CorpusSnapshot | null {
  const version = suite?.versions.find((v) => v.digest === digest);
  if (!suite || !version) return null;
  return {
    digest,
    cases: version.cases.map((id) => ({ id, property: suite.cases[id]?.property ?? '' })),
  };
}

/**
 * Проверка переносимого результата (receipt) принятой попытки получателем.
 *
 * Получатель сверяет результат с поручением и договорами, которые знает сам,
 * и с корпусом по своей копии: результат не может сократить обязательный
 * набор проверок, смешать версии проверок, убрать или занизить манифест
 * свойств. Результат прежнего формата (без версии проверок и манифестов)
 * у поручения без договора проверки читается на прежнем уровне; у поручения
 * с договором проверки такой результат — неполный новый формат.
 */
export function resultProblems(
  result: RunResult,
  context: {
    order: WorkOrder;
    contracts: ContractDocument[];
    /** Корпус по id из копии получателя. */
    suite?: (id: string) => Pick<CheckSuite, 'versions' | 'cases'> | undefined;
  },
): string[] {
  const problems: string[] = [];
  const { order } = context;
  if (result.outcome !== 'accepted') return [`результат ${result.runId} не принят`];
  if (result.workOrderId !== order.id || result.inputs.workOrderDigest !== digestOf(order))
    return [`результат не соответствует поручению ${order.id}`];
  const effective = result.inputs.checks;
  const evidence: ProofEvidence[] = result.evidence.map((e) => ({
    kind: e.kind === 'review' ? 'review' : 'test',
    phase: e.phase,
    gate: e.gate,
    sha: e.sha,
    passed: e.passed,
    consumer: e.consumer,
    checks: e.checks,
    property: e.property,
  }));
  const sha = (phase: 'candidate' | 'integration') =>
    phase === 'candidate' ? result.shas.candidate : result.shas.result;
  const last = (kind: 'test' | 'review', phase: 'candidate' | 'integration', gate: string) =>
    evidence.findLast(
      (e) =>
        e.kind === kind &&
        e.phase === phase &&
        e.gate === gate &&
        e.sha === sha(phase) &&
        e.consumer === undefined,
    );
  const gates = propertyGates(order, context.contracts);
  if (gates.problem) return [gates.problem];
  const required = [
    ...new Set([
      ...(result.inputs.requiredGates ?? order.gates ?? []),
      ...(gates.byGate?.keys() ?? []),
    ]),
  ];
  const decisiveAll = (['candidate', 'integration'] as const).flatMap((phase) => [
    ...required.map((gate) => ({ phase, gate, check: last('test', phase, gate) })),
    { phase, gate: 'independent-review', check: last('review', phase, 'independent-review') },
  ]);
  for (const { phase, gate, check } of decisiveAll)
    if (!check?.passed) problems.push(`Нет PASS: ${phase}/${gate}`);
  if (problems.length) return problems;
  if (order.properties?.length && !effective)
    return ['поручение с договором проверки, а результат без версии проверок'];
  // Решающие записи обеих фаз получены под одной версией проверок, и это
  // видно без агрегатного поля: его удаление не делает допустимым чужой PASS.
  if (!effective) {
    if (new Set(decisiveAll.map((d) => d.check!.checks)).size > 1)
      problems.push('решающие проверки получены под разными версиями');
    return problems;
  }
  for (const { phase, gate, check } of decisiveAll)
    if (check!.checks !== effective)
      problems.push(`${phase}/${gate} получен под другой версией проверок`);
  if (problems.length) return problems;
  const binding = result.inputs.corpus;
  let corpus: CorpusSnapshot | undefined;
  if (binding) {
    const found = suiteCorpus(context.suite?.(binding.suite), binding.digest);
    if (!found)
      return [
        `результат ссылается на версию корпуса ${binding.suite}#${binding.number}, которой нет у получателя`,
      ];
    corpus = found;
  }
  const proof = propertyProofProblem({
    order,
    contracts: context.contracts,
    candidateSha: result.shas.candidate,
    resultSha: result.shas.result,
    effective,
    corpus,
    evidence,
  });
  if (proof) problems.push(proof);
  return problems;
}

/** Отказ получателя: результат не подтверждает приёмку. */
export function assertResult(...args: Parameters<typeof resultProblems>) {
  const problems = resultProblems(...args);
  if (problems.length)
    throw new HarnessError(
      'INVALID_INPUT',
      'Результат не подтверждает приёмку: ' + problems.join('; '),
    );
}
