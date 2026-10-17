import {
  HarnessError,
  digestOf,
  expandGateRefs,
  type CheckSuite,
  type ContractDocument,
  type EvidenceRecord,
  type ExecutionView,
  type RunResult,
  type WorkOrder,
} from '../contracts/index.ts';
import {
  corpusBindingHolds,
  effectiveChecks,
  obligationOf,
  orderCheckManifest,
  type CorpusSnapshot,
} from './checks.ts';
import { manifestDigest } from './property.ts';
import { unprovenReason, type ProofRecord } from './proof.ts';
import { REQUIREMENT_GATE } from './requirements.ts';

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

type RepositoryGates = Parameters<typeof expandGateRefs>[0] & { dependsOn?: string[] };

/** Запись evidence результата в форме доказательства (у получателя). */
type ReceivedEvidence = ProofEvidence & Pick<ProofRecord, 'tests' | 'testsTruncated'>;

/**
 * Внутренняя согласованность описания проверенных входов: свежесть — это
 * сравнение снимка и головы, а снимок совпадает с записанной зависимостью.
 */
function freshnessProblems(
  where: string,
  freshness: RunResult['checked']['freshness'],
  dependencies: RunResult['checked']['dependencies'],
  own?: { repositoryId: string; sha: string },
) {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const f of freshness) {
    if (seen.has(f.repositoryId))
      problems.push(`${where}: свежесть ${f.repositoryId} описана дважды`);
    seen.add(f.repositoryId);
    if (f.fresh !== (f.snapshot === f.head))
      problems.push(`${where}: свежесть ${f.repositoryId} противоречит снимку и голове`);
    const dependency = dependencies.find((d) => d.repositoryId === f.repositoryId);
    const pinned = dependency?.sha ?? (own?.repositoryId === f.repositoryId ? own.sha : undefined);
    if (pinned !== undefined && pinned !== f.snapshot)
      problems.push(`${where}: снимок ${f.repositoryId} в свежести не совпадает с проверенным`);
  }
  return problems;
}

/**
 * Проверка переносимого результата (receipt) принятой попытки получателем.
 *
 * Получатель повторяет все условия приёмки, которые проверяемы по
 * результату, против того, что знает сам: поручения, договоров, политики
 * репозиториев и корпуса по своей копии. Результат не может сократить
 * обязательную область gates (явную или неявную — все gates репозитория),
 * выдать запись другого вида (`check`, `property`) за test gate, убрать
 * проверку источника требований, потерять доказательство названного
 * testcase, опустить объявленного потребителя или описать его проверку не
 * против интегрированного результата, смешать версии проверок, убрать или
 * занизить манифест свойств. Чего получатель проверить не может, — отказ с
 * требованием недостающего контекста, а не PASS. Результат прежнего формата
 * (без версии проверок и манифестов) у поручения без договора проверки
 * читается на прежнем уровне.
 */
export function resultProblems(
  result: RunResult,
  context: {
    order: WorkOrder;
    contracts: ContractDocument[];
    /** Корпус по id из копии получателя. */
    suite?: (
      id: string,
    ) => Pick<CheckSuite, 'versions' | 'cases' | 'contractId' | 'basis'> | undefined;
    /**
     * Политика репозитория поручения у получателя: область gates раскрывается
     * по ней. Без неё не проверяется поручение с группой gates или без явной
     * области (все gates репозитория).
     */
    repository?: RepositoryGates;
    /** Политика репозиториев потребителей у получателя: их группы gates раскрываются по ней. */
    consumerRepository?: (id: string) => RepositoryGates | undefined;
    /** Digest согласованной постановки у хоста получателя; по умолчанию — digest поручения. */
    specDigest?: string;
    /** Закреплённая за поручением версия корпуса, известная получателю (`null` — без корпуса). */
    checkVersion?: { suite: string; digest: string } | null;
  },
): string[] {
  const problems: string[] = [];
  const { order } = context;
  if (result.outcome !== 'accepted') return [`результат ${result.runId} не принят`];
  if (result.workOrderId !== order.id || result.inputs.workOrderDigest !== digestOf(order))
    return [`результат не соответствует поручению ${order.id}`];
  if (result.shas.integration !== result.shas.result)
    return ['integration SHA результата не совпадает с result SHA'];
  // Вид записи согласован с принадлежностью: проверка потребителя — только
  // `consumer` с его ID, собственная — без него. Записи `check` и `property`
  // gate не доказывают: приёмка требует именно test.
  for (const e of result.evidence)
    if ((e.kind === 'consumer') !== (e.consumer !== undefined))
      problems.push(`запись ${e.id}: вид ${e.kind} не согласован с принадлежностью потребителю`);
  if (problems.length) return problems;
  const effective = result.inputs.checks;
  const evidence: ReceivedEvidence[] = result.evidence
    .filter((e) => e.kind === 'test' || e.kind === 'review' || e.kind === 'consumer')
    .map((e) => ({
      kind: e.kind === 'review' ? ('review' as const) : ('test' as const),
      phase: e.phase,
      gate: e.gate,
      sha: e.sha,
      passed: e.passed,
      consumer: e.consumer,
      checks: e.checks,
      property: e.property,
      tests: e.tests,
      testsTruncated: e.testsTruncated,
    }));
  const sha = (phase: 'candidate' | 'integration') =>
    phase === 'candidate' ? result.shas.candidate : result.shas.result;
  const last = (
    kind: 'test' | 'review',
    phase: 'candidate' | 'integration',
    gate: string,
    consumer?: string,
  ) =>
    evidence.findLast(
      (e) =>
        e.kind === kind &&
        e.phase === phase &&
        e.gate === gate &&
        e.sha === sha(phase) &&
        e.consumer === consumer,
    );
  const gates = propertyGates(order, context.contracts);
  if (gates.problem) return [gates.problem];
  // Область поручения раскрывается у получателя: присланный список не может
  // её сократить, а имя группы не принимается за имя проверки. Отсутствие
  // области — все gates репозитория: без политики получателя её не узнать.
  let own: string[];
  if (context.repository)
    try {
      own = expandGateRefs(context.repository, order.gates);
    } catch (error) {
      return ['область gates поручения: ' + (error as Error).message];
    }
  else if (!order.gates?.length)
    return [
      'поручение без явной области gates (все gates репозитория); нужна политика репозитория получателя',
    ];
  else if (order.gates.some((g) => g.startsWith('@')))
    return ['поручение ссылается на группу gates; нужна политика репозитория получателя'];
  else own = [...order.gates];
  // Источник требований проверяется в обеих фазах, как при приёмке.
  if (order.requirements.length) own.push(REQUIREMENT_GATE);
  const declared = result.inputs.requiredGates;
  const missingOwn = declared ? own.filter((g) => !declared.includes(g)) : [];
  if (missingOwn.length)
    problems.push(`область поручения требует ${missingOwn.join(', ')}, а результат их не проверял`);
  const required = [...new Set([...(declared ?? []), ...own, ...(gates.byGate?.keys() ?? [])])];
  const decisiveAll = (['candidate', 'integration'] as const).flatMap((phase) => [
    ...required.map((gate) => ({ phase, gate, check: last('test', phase, gate) })),
    { phase, gate: 'independent-review', check: last('review', phase, 'independent-review') },
  ]);
  for (const { phase, gate, check } of decisiveAll)
    if (!check?.passed) problems.push(`Нет PASS: ${phase}/${gate}`);
  // Потребители: каждый объявленный описан ровно один раз, его gates (с
  // раскрытыми группами) прошли на integration SHA, проверен он против
  // интегрированного результата; необъявленных нет.
  const declaredConsumers = order.consumers ?? [];
  const checked = result.checked.consumers;
  if (new Set(checked.map((c) => c.repositoryId)).size !== checked.length)
    problems.push('потребитель описан в результате дважды');
  for (const c of checked)
    if (!declaredConsumers.some((d) => d.repositoryId === c.repositoryId))
      problems.push(`результат описывает необъявленного потребителя ${c.repositoryId}`);
  for (const e of evidence)
    if (e.consumer !== undefined && !declaredConsumers.some((d) => d.repositoryId === e.consumer))
      problems.push(`evidence необъявленного потребителя ${e.consumer}`);
  const consumerChecks: { gate: string; check: ReceivedEvidence | undefined }[] = [];
  for (const consumer of declaredConsumers) {
    const id = consumer.repositoryId;
    const repo = context.consumerRepository?.(id);
    let expected: string[];
    if (repo)
      try {
        expected = expandGateRefs(repo, consumer.gates);
      } catch (error) {
        problems.push(`область gates потребителя ${id}: ${(error as Error).message}`);
        continue;
      }
    else if (consumer.gates.some((g) => g.startsWith('@'))) {
      problems.push(`потребитель ${id} ссылается на группу gates; нужна его политика у получателя`);
      continue;
    } else expected = consumer.gates;
    const entry = checked.find((c) => c.repositoryId === id);
    if (!entry) {
      problems.push(`результат не описывает проверку потребителя ${id}`);
      continue;
    }
    const missing = expected.filter((g) => !entry.gates.includes(g));
    if (missing.length) problems.push(`потребитель ${id}: не проверены ${missing.join(', ')}`);
    for (const gate of expected) {
      const check = last('test', 'integration', gate, id);
      consumerChecks.push({ gate: `${id}/${gate}`, check });
      if (!check?.passed) problems.push(`Нет PASS проверки потребителя: ${id}/${gate}`);
    }
    const provider = entry.dependencies.find((d) => d.repositoryId === result.repositoryId);
    if (provider?.sha !== result.shas.result)
      problems.push(`проверка потребителя ${id} выполнена не против интегрированного результата`);
    problems.push(
      ...freshnessProblems(`потребитель ${id}`, entry.freshness, entry.dependencies, {
        repositoryId: id,
        sha: entry.sha,
      }),
    );
  }
  // Снимки зависимостей самой попытки: прямые зависимости репозитория
  // записаны, свежесть с ними согласована (устаревший снимок — сведение, не отказ).
  for (const id of context.repository?.dependsOn ?? [])
    if (!result.checked.dependencies.some((d) => d.repositoryId === id))
      problems.push(`результат не записал снимок зависимости ${id}`);
  problems.push(
    ...freshnessProblems('попытка', result.checked.freshness, result.checked.dependencies),
  );
  if (problems.length) return problems;
  // Названный testcase доказан списком тестов интеграции на принятом SHA.
  const unproven = unprovenReason(order.requirements, evidence, result.shas.result);
  if (unproven) return [unproven];
  if (order.properties?.length && !effective)
    return ['поручение с договором проверки, а результат без версии проверок'];
  // Решающие записи обеих фаз (и проверки потребителей) получены под одной
  // версией проверок, и это видно без агрегатного поля: его удаление не
  // делает допустимым чужой PASS.
  const versioned = [
    ...decisiveAll.map((d) => ({ label: `${d.phase}/${d.gate}`, check: d.check })),
    ...consumerChecks.map((c) => ({ label: `потребитель ${c.gate}`, check: c.check })),
  ];
  if (!effective) {
    if (new Set(versioned.map((d) => d.check?.checks)).size > 1)
      problems.push('решающие проверки получены под разными версиями');
    return problems;
  }
  for (const d of versioned)
    if (d.check?.checks !== effective)
      problems.push(`${d.label} получен под другой версией проверок`);
  if (problems.length) return problems;
  const binding = result.inputs.corpus;
  // Версия проверок вычисляется получателем из постановки, контрактов,
  // политики и корпуса результата: согласованная, но произвольная версия, как
  // и удаление корпуса вместе с его привязкой, её не воспроизводит.
  const expected = effectiveChecks(
    {
      approvedDigest: context.specDigest ?? digestOf(order),
      order,
      ...(binding ? { checkVersion: { ...binding } } : {}),
    },
    result.inputs.policyDigest,
  );
  if (expected !== effective)
    return ['версия проверок не соответствует постановке, контрактам, политике и корпусу'];
  // Пересчитанные вместе версия, манифест и корпус согласованы сами с собой:
  // какой корпус обязателен, знает только получатель.
  if (order.properties?.length && context.checkVersion === undefined)
    return ['поручение с договором проверки: получатель не передал закреплённую версию корпуса'];
  if (
    context.checkVersion !== undefined &&
    (context.checkVersion?.digest ?? null) !== (binding?.digest ?? null)
  )
    return ['корпус результата не совпадает с закреплённым за поручением у получателя'];
  let corpus: CorpusSnapshot | undefined;
  if (binding) {
    const suite = context.suite?.(binding.suite);
    const found = suiteCorpus(suite, binding.digest);
    if (!found)
      return [
        `результат ссылается на версию корпуса ${binding.suite}#${binding.number}, которой нет у получателя`,
      ];
    // Корпус относится к договору поручения с тем же нормативным основанием.
    if (suite?.contractId !== undefined && !corpusBindingHolds(suite, context.contracts))
      return [`корпус ${binding.suite} не относится к договорам поручения`];
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
