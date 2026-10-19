import {
  codeReview,
  roleBinding,
  HarnessError,
  digestOf,
  expandGateRefs,
  selectReviewer,
  vendorOf,
  type CheckSuite,
  type ContractDocument,
  type EvidenceRecord,
  type ExecutionPolicy,
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
      if (check.property?.level !== 'manifest' || !manifest)
        return `${phase}/${gate} без манифеста свойств поручения`;
      // Свойства манифеста — ровно свойства договора этого gate, без повторов:
      // список не входит в digest манифеста и сверяется отдельно.
      const declared = expected?.properties.map((p) => p.id) ?? ids;
      if (
        manifest.properties.length !== declared.length ||
        new Set(manifest.properties).size !== declared.length ||
        declared.some((id) => !manifest.properties.includes(id))
      )
        return `${phase}/${gate}: свойства манифеста не совпадают со свойствами поручения`;
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

/** Запись evidence результата в форме доказательства (у получателя). */
type ReceivedEvidence = ProofEvidence & Pick<ProofRecord, 'tests' | 'testsTruncated'>;

/** Политика получателя: репозитории (gates, группы, зависимости, target), роли и правила ревью. */
export type ReceiverPolicy = Pick<ExecutionPolicy, 'repositories' | 'roles' | 'review'>;

/**
 * Что получатель знает сам и передаёт проверке. Всё, что результат
 * утверждает о поручении, его области, входах и ревью, сверяется с этим, а не
 * с другими полями того же результата: согласованная сама с собой подделка
 * иначе проходила бы.
 */
export interface ReceiverContext {
  /** Постановка поручения у получателя. */
  order: WorkOrder;
  /** Граф, в котором получатель держит поручение. */
  graphId: string;
  /** Договоры поручения по его ссылкам (документы у получателя). */
  contracts: ContractDocument[];
  /** Политика получателя: репозиторий поручения, потребители и их зависимости, роли, ревью. */
  policy: ReceiverPolicy;
  /**
   * Снимок контекста, закреплённый согласованием графа у получателя; `null` —
   * согласование без контекста.
   */
  contextDigest: string | null;
  /** Корпус по id из копии получателя. */
  suite?: (
    id: string,
  ) => Pick<CheckSuite, 'versions' | 'cases' | 'contractId' | 'basis'> | undefined;
  /** Digest согласованной постановки у хоста получателя; по умолчанию — digest поручения. */
  specDigest?: string;
  /** Закреплённая за поручением версия корпуса у получателя (`null` — без корпуса). */
  checkVersion?: { suite: string; digest: string } | null;
  /**
   * Формула версии проверок хоста получателя (как `BasisProvider.checksDigest`);
   * без неё — формула harness.
   */
  checksDigest?(input: {
    specDigest: string;
    order: WorkOrder;
    policyDigest: string;
    corpus?: { suite: string; digest: string };
  }): string;
  /** Основание корпуса по формуле хоста получателя (как `BasisProvider.suiteBasis`). */
  suiteBasis?(contract: ContractDocument): string;
  /**
   * Результат прежнего формата хоста, в котором входы попытки не
   * наблюдались: `dependencies` — снимков собственных зависимостей и их
   * свежести нет; `consumers` — у потребителей нет свежести. Тогда пустые
   * списки не сверяются с замыканием — их нет, и проверке они не подлежат;
   * непустые, снимки зависимостей потребителя, провайдер и всё остальное
   * сверяются как обычно. Какой результат имеет прежний формат, решает хост
   * по своим правилам формата.
   */
  unobserved?: { dependencies?: boolean; consumers?: boolean };
  /**
   * Чем подтверждено ревью: `current` (по умолчанию) — writer и reviewer
   * назначены текущей политикой получателя; `recorded` — результат несёт
   * своё назначение (writer и reviewer записаны при приёмке) и хост
   * перепроверяет его позже, когда назначение ролей могло смениться: тогда
   * оба должны быть runtime политики получателя, а правило вендора роли —
   * соблюдено.
   */
  assignment?: 'current' | 'recorded';
}

/** Runtime, которые политика получателя назначает writer-ами и reviewer-ами. */
function policyRuntimes(policy: ReceiverPolicy) {
  const rules = (r?: { reviewer: { runtime: string }; alternates?: { runtime: string }[] }) =>
    r ? [r.reviewer.runtime, ...(r.alternates ?? []).map((a) => a.runtime)] : [];
  const roles = [
    ...Object.values(policy.roles),
    ...policy.repositories.flatMap((r) => Object.values(r.roles ?? {})),
  ];
  return new Set([
    ...roles.flatMap((r) => [r.writer.runtime, ...rules(r.review)]),
    ...policy.repositories.flatMap((r) => rules(r.review)),
    ...rules(policy.review.code),
    ...rules(policy.review.plan),
    ...rules(policy.review.contract),
  ]);
}

/**
 * Модель доверия получателя: для каждого поля принятого `RunResult` — как
 * оно участвует в вердикте.
 *
 * - `expected` — сверяется с ожиданием, которое получатель вычисляет сам из
 *   `ReceiverContext` (поручение, граф, политика, договоры, корпус, контекст);
 * - `consistency` — сверяется на согласованность с другими полями результата
 *   (SHA фаз, свежесть со снимками, уникальность записей);
 * - `informative` — сведение, которое ничего не доказывает: вердикт на него
 *   не опирается, и его изменение вердикт не меняет;
 * - `schema` — значение фиксировано схемой.
 *
 * Подлинность SHA, деревьев, artifacts и записей (их наличие в Git и в
 * хранилище исполнителя) получатель не удостоверяет: это транспорт хоста.
 * Таблица — проверяемое утверждение: `tests/receipt-trust.test.ts` строит
 * подделку каждого поля `expected`/`consistency` и требует отказа, а изменение
 * поля `informative` — того же вердикта.
 */
export const receiptTrust = {
  apiVersion: ['schema', 'литерал версии API'],
  outcome: ['expected', 'только accepted подтверждает приёмку'],
  workOrderId: ['expected', 'ID поручения получателя'],
  graphId: ['expected', 'граф поручения у получателя'],
  'source.connector': ['expected', 'источник поручения получателя'],
  'source.ref': ['expected', 'источник поручения получателя'],
  'source.revision': ['expected', 'редакция поручения получателя'],
  runId: ['informative', 'идентификатор попытки у исполнителя'],
  attempt: ['informative', 'номер попытки у исполнителя'],
  repositoryId: ['expected', 'репозиторий поручения'],
  targetRef: ['expected', 'target ref репозитория в политике получателя'],
  'inputs.harnessVersion': ['informative', 'версия исполнителя'],
  'inputs.consumerVersion': ['informative', 'версия хоста исполнителя'],
  'inputs.stateVersion': ['schema', 'литерал версии состояния'],
  'inputs.workOrderDigest': ['expected', 'digest поручения получателя'],
  'inputs.graphDigest': [
    'informative',
    'граф мог получить новую редакцию при неизменном поручении; привязка — digest поручения и его источник',
  ],
  'inputs.policyDigest': ['consistency', 'входит в вычисление версии проверок'],
  'inputs.contextDigest': ['expected', 'снимок контекста согласования у получателя'],
  'inputs.checks': ['expected', 'версия проверок, вычисленная получателем'],
  'inputs.corpus.suite': ['expected', 'корпус, закреплённый за поручением у получателя'],
  'inputs.corpus.number': ['expected', 'номер этой версии в корпусе получателя'],
  'inputs.corpus.digest': ['expected', 'версия корпуса, закреплённая у получателя'],
  'inputs.corpus': ['expected', 'привязка к корпусу, закреплённому у получателя'],
  'inputs.requiredGates': [
    'expected',
    'область поручения, раскрытая по политике получателя; без поля — область получателя',
  ],
  'inputs.requiredGates[]': ['expected', 'ровно эта область, без повторов'],
  'inputs.writer': ['expected', 'writer роли поручения; без поля — writer роли получателя'],
  'inputs.writer.runtime': ['expected', 'writer роли поручения в политике получателя'],
  'inputs.writer.model': ['informative', 'модель writer'],
  'checked.dependencies': ['expected', 'замыкание зависимостей репозитория по политике получателя'],
  'checked.dependencies[]': ['expected', 'ровно один снимок каждой зависимости замыкания'],
  'checked.dependencies[].repositoryId': ['expected', 'зависимость из замыкания'],
  'checked.dependencies[].sha': ['consistency', 'совпадает со снимком в свежести'],
  'checked.dependencies[].tree': ['informative', 'подлинность дерева — Git хоста'],
  'checked.dependencies[].artifacts': ['informative', 'подлинность artifacts — Git хоста'],
  'checked.dependencies[].artifacts[]': ['informative', 'подлинность artifacts — Git хоста'],
  'checked.dependencies[].artifacts[].path': ['informative', 'подлинность artifacts — Git хоста'],
  'checked.dependencies[].artifacts[].digest': ['informative', 'подлинность artifacts — Git хоста'],
  'checked.freshness': ['expected', 'свежесть каждой зависимости замыкания'],
  'checked.freshness[]': ['expected', 'ровно одна запись на зависимость'],
  'checked.freshness[].repositoryId': ['expected', 'зависимость из замыкания'],
  'checked.freshness[].snapshot': ['consistency', 'совпадает со снимком зависимости'],
  'checked.freshness[].head': [
    'consistency',
    'fresh ⇔ head = snapshot; значение головы — наблюдение',
  ],
  'checked.freshness[].fresh': ['consistency', 'fresh ⇔ head = snapshot'],
  'checked.consumers': ['expected', 'объявленные потребители поручения'],
  'checked.consumers[]': ['expected', 'ровно одно описание каждого объявленного потребителя'],
  'checked.consumers[].repositoryId': ['expected', 'объявленный потребитель'],
  'checked.consumers[].gates': [
    'expected',
    'область потребителя, раскрытая по политике получателя',
  ],
  'checked.consumers[].gates[]': ['expected', 'ровно эта область, без повторов'],
  'checked.consumers[].sha': ['consistency', 'совпадает со снимком потребителя в его свежести'],
  'checked.consumers[].tree': ['informative', 'подлинность дерева — Git хоста'],
  'checked.consumers[].dependencies': [
    'expected',
    'замыкание зависимостей потребителя по политике получателя',
  ],
  'checked.consumers[].dependencies[]': [
    'expected',
    'ровно один снимок каждой зависимости замыкания',
  ],
  'checked.consumers[].dependencies[].repositoryId': ['expected', 'зависимость из замыкания'],
  'checked.consumers[].dependencies[].sha': [
    'consistency',
    'у провайдера — result SHA; у прочих — снимок в свежести',
  ],
  'checked.consumers[].dependencies[].tree': ['informative', 'подлинность дерева — Git хоста'],
  'checked.consumers[].dependencies[].artifacts': [
    'informative',
    'подлинность artifacts — Git хоста',
  ],
  'checked.consumers[].dependencies[].artifacts[]': [
    'informative',
    'подлинность artifacts — Git хоста',
  ],
  'checked.consumers[].dependencies[].artifacts[].path': [
    'informative',
    'подлинность artifacts — Git хоста',
  ],
  'checked.consumers[].dependencies[].artifacts[].digest': [
    'informative',
    'подлинность artifacts — Git хоста',
  ],
  'checked.consumers[].freshness': [
    'expected',
    'свежесть каждого входа потребителя, кроме провайдера, и его самого',
  ],
  'checked.consumers[].freshness[]': ['expected', 'ровно одна запись на вход'],
  'checked.consumers[].freshness[].repositoryId': ['expected', 'вход потребителя'],
  'checked.consumers[].freshness[].snapshot': ['consistency', 'совпадает со снимком входа'],
  'checked.consumers[].freshness[].head': [
    'consistency',
    'fresh ⇔ head = snapshot; значение головы — наблюдение',
  ],
  'checked.consumers[].freshness[].fresh': ['consistency', 'fresh ⇔ head = snapshot'],
  evidence: ['expected', 'решающие записи всех обязательных проверок обеих фаз'],
  'evidence[]': ['consistency', 'записи уникальны по ID'],
  'evidence[].id': ['consistency', 'уникален'],
  'evidence[].kind': [
    'consistency',
    'согласован с gate (ревью ⇔ independent-review) и с потребителем',
  ],
  'evidence[].phase': ['consistency', 'SHA записи — SHA её фазы'],
  'evidence[].gate': ['expected', 'обязательная проверка поручения, потребителя или ревью'],
  'evidence[].sha': ['consistency', 'SHA фазы: candidate или result'],
  'evidence[].passed': ['expected', 'решающая запись каждой обязательной проверки — PASS'],
  'evidence[].digest': ['informative', 'подлинность записи — хранилище исполнителя'],
  'evidence[].summary': ['informative', 'описание записи'],
  'evidence[].consumer': ['expected', 'объявленный потребитель'],
  'evidence[].checks': ['expected', 'версия проверок, вычисленная получателем, у каждой записи'],
  'evidence[].tests': ['expected', 'доказательство названного testcase решающей записью'],
  'evidence[].tests[]': ['expected', 'элемент названного testcase; прочие элементы — сведения'],
  'evidence[].tests[].id': ['expected', 'ID названного testcase'],
  'evidence[].tests[].status': ['expected', 'названный testcase прошёл'],
  'evidence[].tests[].opaque': ['expected', 'имя названного testcase не скрыто'],
  'evidence[].testsTruncated': ['expected', 'список решающей записи полон'],
  'evidence[].property': [
    'expected',
    'доказательство договора проверки; у записи потребителя — только legacy без манифеста',
  ],
  'evidence[].property.level': ['expected', 'уровень manifest; у записи потребителя — legacy'],
  'evidence[].property.manifest': ['expected', 'манифест договора поручения'],
  'evidence[].property.manifest.digest': ['expected', 'манифест, вычисленный получателем'],
  'evidence[].property.manifest.properties': ['expected', 'свойства поручения'],
  'evidence[].property.manifest.properties[]': ['expected', 'свойства поручения'],
  'evidence[].property.manifest.corpus': ['expected', 'корпус закреплённой версии'],
  'evidence[].property.manifest.corpus.digest': ['expected', 'версия корпуса у получателя'],
  'evidence[].property.manifest.corpus.cases': ['expected', 'число случаев этой версии'],
  'evidence[].reviewer': ['expected', 'reviewer, назначенный политикой получателя'],
  'evidence[].reviewer.runtime': ['expected', 'reviewer роли в политике получателя'],
  'evidence[].reviewer.model': ['informative', 'модель reviewer'],
  'evidence[].reviewer.sameVendor': ['consistency', 'вендоры writer и reviewer'],
  findings: ['informative', 'сводка находок может относиться к отклонённым раундам'],
  'findings[]': ['informative', 'сводка находок'],
  'findings[].severity': ['informative', 'сводка находок'],
  'findings[].message': ['informative', 'сводка находок'],
  'findings[].path': ['informative', 'сводка находок'],
  'findings[].line': ['informative', 'сводка находок'],
  'findings[].rule': ['informative', 'сводка находок'],
  limitations: ['informative', 'чего результат не доказывает'],
  'limitations[]': ['informative', 'чего результат не доказывает'],
  finishedAt: ['informative', 'время окончания'],
  'shas.base': ['informative', 'база кандидата; подлинность — Git хоста'],
  'shas.candidate': ['consistency', 'SHA решающих записей кандидата'],
  'shas.integration': ['consistency', 'равен result SHA'],
  'shas.result': [
    'consistency',
    'SHA решающих записей интеграции и снимка провайдера у потребителей',
  ],
} as const satisfies Record<
  string,
  readonly ['expected' | 'consistency' | 'informative' | 'schema', string]
>;

const sameSet = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  expected.every((x) => actual.includes(x));

/**
 * Замыкание зависимостей репозитория по политике получателя в
 * топологическом порядке; неизвестный репозиторий или цикл — отказ.
 */
function dependencyClosure(policy: ReceiverPolicy, ids: readonly string[]) {
  const ordered: string[] = [];
  const active = new Set<string>();
  const visit = (id: string) => {
    if (ordered.includes(id)) return;
    if (active.has(id)) throw new Error('цикл зависимостей ' + id);
    const repo = policy.repositories.find((r) => r.id === id);
    if (!repo) throw new Error(`репозиторий ${id} не описан в политике получателя`);
    active.add(id);
    repo.dependsOn.forEach(visit);
    active.delete(id);
    ordered.push(id);
  };
  ids.forEach(visit);
  return ordered;
}

/**
 * Проверенные входы — ровно ожидаемые: один снимок на каждую зависимость
 * замыкания, одна запись свежести на каждый ожидаемый вход, свежесть —
 * сравнение снимка и головы, снимок совпадает с проверенным. Устаревший, но
 * правдиво описанный снимок — сведение, не отказ.
 */
function inputsProblems(
  where: string,
  dependencies: RunResult['checked']['dependencies'],
  freshness: RunResult['checked']['freshness'],
  expectedDependencies: readonly string[],
  expectedFreshness: readonly { repositoryId: string; sha: string | undefined }[],
) {
  const problems: string[] = [];
  if (
    !sameSet(
      dependencies.map((d) => d.repositoryId),
      expectedDependencies,
    )
  )
    problems.push(
      `${where}: снимки зависимостей [${dependencies.map((d) => d.repositoryId).join(', ')}] — ожидались ровно [${expectedDependencies.join(', ')}]`,
    );
  if (
    !sameSet(
      freshness.map((f) => f.repositoryId),
      expectedFreshness.map((f) => f.repositoryId),
    )
  )
    problems.push(
      `${where}: свежесть [${freshness.map((f) => f.repositoryId).join(', ')}] — ожидалась ровно [${expectedFreshness.map((f) => f.repositoryId).join(', ')}]`,
    );
  for (const f of freshness) {
    if (f.fresh !== (f.snapshot === f.head))
      problems.push(`${where}: свежесть ${f.repositoryId} противоречит снимку и голове`);
    const pinned = expectedFreshness.find((x) => x.repositoryId === f.repositoryId)?.sha;
    if (pinned !== f.snapshot)
      problems.push(`${where}: снимок ${f.repositoryId} в свежести не совпадает с проверенным`);
  }
  return problems;
}

/**
 * Проверка переносимого результата (receipt) принятой попытки получателем.
 *
 * Получатель повторяет все условия приёмки, проверяемые по результату, против
 * того, что знает сам (`ReceiverContext`); как участвует каждое поле, задаёт
 * `receiptTrust`. Результат не может: относиться к другому поручению,
 * графу, редакции источника, репозиторию или ветке; сократить или подменить
 * область gates; выдать запись другого вида или ревью за test gate;
 * доказать testcase не решающей записью или записью другой версии; убрать
 * проверку источника требований; опустить, повторить или выдумать
 * потребителя, его область или входы; описать неполный, повторный или
 * противоречивый состав зависимостей и свежести; заявить ревью reviewer-ом,
 * которого политика получателя не назначает, или того же вендора без явного
 * разрешения; смешать версии проверок; убрать или занизить манифест и корпус.
 * Чего не хватает в контексте получателя, — отказ, а не PASS. Результат
 * прежнего формата (без версии проверок, области и writer) у поручения без
 * договора проверки читается на прежнем уровне.
 */
export function resultProblems(result: RunResult, context: ReceiverContext): string[] {
  const { order, policy } = context;
  if (result.outcome !== 'accepted') return [`результат ${result.runId} не принят`];
  // Реквизиты: к какому поручению, графу, редакции, репозиторию и ветке
  // относится результат, — не верный digest поручения заменяет их сверку.
  if (result.workOrderId !== order.id || result.inputs.workOrderDigest !== digestOf(order))
    return [`результат не соответствует поручению ${order.id}`];
  const repo = policy.repositories.find((r) => r.id === order.repositoryId);
  if (!repo) return [`репозиторий ${order.repositoryId} не описан в политике получателя`];
  const identity: string[] = [];
  if (result.graphId !== context.graphId)
    identity.push(`результат относится к графу ${result.graphId}, а не ${context.graphId}`);
  if (digestOf(result.source) !== digestOf(order.source))
    identity.push(
      `результат относится к источнику ${result.source.connector}:${result.source.ref}@${result.source.revision}, а не к редакции поручения`,
    );
  if (result.repositoryId !== order.repositoryId)
    identity.push(`результат относится к репозиторию ${result.repositoryId}`);
  if (result.targetRef !== repo.targetRef)
    identity.push(`результат относится к ветке ${result.targetRef}, а не ${repo.targetRef}`);
  if (result.shas.integration !== result.shas.result)
    identity.push('integration SHA результата не совпадает с result SHA');
  if ((result.inputs.contextDigest ?? null) !== context.contextDigest)
    identity.push('снимок контекста результата не совпадает с согласованным у получателя');
  if (identity.length) return identity;
  const sha = (phase: 'candidate' | 'integration') =>
    phase === 'candidate' ? result.shas.candidate : result.shas.result;
  // Целостность записей: уникальны; вид согласован с gate и принадлежностью;
  // SHA — SHA фазы; одна версия проверок у всех; список тестов и манифест —
  // только у собственных записей test, сведения о reviewer — только у ревью.
  const integrity: string[] = [];
  const effective = result.inputs.checks;
  if (new Set(result.evidence.map((e) => e.id)).size !== result.evidence.length)
    integrity.push('записи evidence повторяются');
  for (const e of result.evidence) {
    if ((e.kind === 'consumer') !== (e.consumer !== undefined))
      integrity.push(`запись ${e.id}: вид ${e.kind} не согласован с принадлежностью потребителю`);
    if ((e.kind === 'review') !== (e.gate === 'independent-review'))
      integrity.push(`запись ${e.id}: вид ${e.kind} не согласован с gate ${e.gate}`);
    if (e.sha !== sha(e.phase))
      integrity.push(`запись ${e.id}: SHA не принадлежит фазе ${e.phase}`);
    if (e.consumer !== undefined && e.phase !== 'integration')
      integrity.push(`запись ${e.id}: проверка потребителя не на интеграции`);
    if (e.checks !== effective)
      integrity.push(`запись ${e.id} получена под другой версией проверок`);
    if (
      (e.tests !== undefined || e.testsTruncated !== undefined) &&
      (e.kind !== 'test' || e.phase !== 'integration')
    )
      integrity.push(`запись ${e.id}: список тестов у записи не собственной проверки интеграции`);
    // Сведения о свойствах: у собственной записи — доказательство договора
    // поручения; у записи потребителя — только уровень его собственного gate
    // (`legacy`, без манифеста): договор свойств провайдера к потребителю не
    // применяется, и его запись ничего о провайдере не доказывает.
    if (
      e.property !== undefined &&
      e.kind !== 'test' &&
      !(e.kind === 'consumer' && e.property.level === 'legacy' && !e.property.manifest)
    )
      integrity.push(`запись ${e.id}: сведения о свойствах недопустимы у записи вида ${e.kind}`);
    if ((e.reviewer !== undefined) !== (e.kind === 'review'))
      integrity.push(`запись ${e.id}: сведения о reviewer не согласованы с видом записи`);
  }
  if (integrity.length) return integrity;
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
  const problems: string[] = [];
  const gates = propertyGates(order, context.contracts);
  if (gates.problem) return [gates.problem];
  // Область поручения раскрывается по политике получателя; присланный список
  // обязан быть ровно ею (без повторов), имя группы не принимается за проверку.
  let own: string[];
  try {
    own = expandGateRefs(repo, order.gates);
  } catch (error) {
    return ['область gates поручения: ' + (error as Error).message];
  }
  // Источник требований проверяется в обеих фазах, как при приёмке.
  if (order.requirements.length) own.push(REQUIREMENT_GATE);
  const declared = result.inputs.requiredGates;
  if (declared && !sameSet(declared, own))
    problems.push(
      `область результата [${declared.join(', ')}] — ожидалась ровно [${own.join(', ')}]`,
    );
  const required = [...new Set([...own, ...(gates.byGate?.keys() ?? [])])];
  const decisiveAll = (['candidate', 'integration'] as const).flatMap((phase) => [
    ...required.map((gate) => ({ phase, gate, check: last('test', phase, gate) })),
    { phase, gate: 'independent-review', check: last('review', phase, 'independent-review') },
  ]);
  for (const { phase, gate, check } of decisiveAll)
    if (!check?.passed) problems.push(`Нет PASS: ${phase}/${gate}`);
  // Ревью: writer — роли поручения в политике получателя; reviewer решающих
  // записей обеих фаз — тот, кого политика назначает этому writer, и правило
  // вендора соблюдено (тот же вендор — только явным разрешением). Для
  // результата с записанным назначением (`assignment: 'recorded'`) writer и
  // reviewer — записанные: они не сверяются с текущим назначением роли, но
  // оба — runtime политики получателя, и правило вендора роли соблюдено.
  const role = roleBinding(policy, order.role, order.repositoryId);
  if (!role) return [`роль ${order.role} не описана в политике получателя`];
  const recorded = context.assignment === 'recorded';
  if (recorded && !result.inputs.writer) return ['результат с записанным назначением без writer'];
  const writer = result.inputs.writer?.runtime ?? role.writer.runtime;
  const known = policyRuntimes(policy);
  if (recorded && !known.has(writer))
    problems.push(`writer ${writer} не используется политикой получателя`);
  if (!recorded && writer !== role.writer.runtime)
    problems.push(`writer ${writer} не назначен ролью ${order.role} в политике получателя`);
  const rule = codeReview(policy, order.role, order.repositoryId);
  const choice = selectReviewer(
    policy,
    'code',
    { runtime: writer },
    order.role,
    order.repositoryId,
  );
  if (!recorded && !choice.ok) problems.push(`ревью результата: ${choice.message}`);
  for (const phase of ['candidate', 'integration'] as const) {
    const decisive = result.evidence.findLast(
      (e) => e.kind === 'review' && e.phase === phase && e.sha === sha(phase),
    );
    // Сведения о reviewer у записи ревью обязательны (проверено выше).
    const reviewer = decisive?.reviewer;
    if (!reviewer) continue;
    const same = vendorOf(reviewer.runtime) === vendorOf(writer);
    if (recorded) {
      if (!known.has(reviewer.runtime))
        problems.push(
          `ревью ${phase}: reviewer ${reviewer.runtime} не используется политикой получателя`,
        );
      if (same && rule.vendor !== 'same-vendor-allowed')
        problems.push(
          `ревью ${phase}: reviewer ${reviewer.runtime} того же вендора, что writer ${writer}; правило роли этого не разрешает`,
        );
    } else if (choice.ok && reviewer.runtime !== choice.reviewer.runtime)
      problems.push(
        `ревью ${phase}: reviewer ${reviewer.runtime} не назначен политикой получателя (${choice.reviewer.runtime})`,
      );
    if (reviewer.sameVendor !== same)
      problems.push(`ревью ${phase}: признак того же вендора противоречит writer и reviewer`);
  }
  // Потребители: каждый объявленный описан ровно один раз; его область,
  // раскрытая по политике получателя, — ровно описанная, и каждая её проверка
  // прошла на integration SHA; входы — ровно замыкание его зависимостей,
  // провайдер — интегрированный результат; необъявленных нет.
  const declaredConsumers = order.consumers ?? [];
  const checked = result.checked.consumers;
  if (
    !sameSet(
      checked.map((c) => c.repositoryId),
      declaredConsumers.map((c) => c.repositoryId),
    )
  )
    problems.push(
      `результат описывает потребителей [${checked.map((c) => c.repositoryId).join(', ')}] — объявлены [${declaredConsumers.map((c) => c.repositoryId).join(', ')}]`,
    );
  for (const e of evidence)
    if (e.consumer !== undefined && !declaredConsumers.some((d) => d.repositoryId === e.consumer))
      problems.push(`evidence необъявленного потребителя ${e.consumer}`);
  const consumerChecks: { gate: string; check: ReceivedEvidence | undefined }[] = [];
  for (const consumer of declaredConsumers) {
    const id = consumer.repositoryId;
    const crepo = policy.repositories.find((r) => r.id === id);
    if (!crepo) {
      problems.push(`потребитель ${id} не описан в политике получателя`);
      continue;
    }
    let expected: string[];
    let closure: string[];
    try {
      expected = expandGateRefs(crepo, consumer.gates);
      closure = dependencyClosure(policy, crepo.dependsOn);
    } catch (error) {
      problems.push(`потребитель ${id}: ${(error as Error).message}`);
      continue;
    }
    const entry = checked.find((c) => c.repositoryId === id);
    if (!entry) continue;
    if (!sameSet(entry.gates, expected))
      problems.push(
        `потребитель ${id}: область [${entry.gates.join(', ')}] — ожидалась ровно [${expected.join(', ')}]`,
      );
    for (const gate of expected) {
      const check = last('test', 'integration', gate, id);
      consumerChecks.push({ gate: `${id}/${gate}`, check });
      if (!check?.passed) problems.push(`Нет PASS проверки потребителя: ${id}/${gate}`);
    }
    if (!closure.includes(result.repositoryId))
      problems.push(`потребитель ${id} не зависит от ${result.repositoryId} в политике получателя`);
    const provider = entry.dependencies.find((d) => d.repositoryId === result.repositoryId);
    if (provider?.sha !== result.shas.result)
      problems.push(`проверка потребителя ${id} выполнена не против интегрированного результата`);
    const unobserved = context.unobserved?.consumers && !entry.freshness.length;
    problems.push(
      ...inputsProblems(
        `потребитель ${id}`,
        entry.dependencies,
        entry.freshness,
        closure,
        unobserved
          ? []
          : [
              ...closure
                .filter((d) => d !== result.repositoryId)
                .map((d) => ({
                  repositoryId: d,
                  sha: entry.dependencies.find((x) => x.repositoryId === d)?.sha,
                })),
              { repositoryId: id, sha: entry.sha },
            ],
      ),
    );
  }
  // Снимки зависимостей самой попытки — ровно замыкание зависимостей её
  // репозитория по политике получателя, каждая со свежестью.
  let ownClosure: string[];
  try {
    ownClosure = dependencyClosure(policy, repo.dependsOn);
  } catch (error) {
    return [...problems, 'зависимости репозитория: ' + (error as Error).message];
  }
  const ownUnobserved =
    context.unobserved?.dependencies &&
    !result.checked.dependencies.length &&
    !result.checked.freshness.length;
  if (!ownUnobserved)
    problems.push(
      ...inputsProblems(
        'попытка',
        result.checked.dependencies,
        result.checked.freshness,
        ownClosure,
        ownClosure.map((d) => ({
          repositoryId: d,
          sha: result.checked.dependencies.find((x) => x.repositoryId === d)?.sha,
        })),
      ),
    );
  if (problems.length) return problems;
  // Названный testcase доказан решающей записью интеграции на принятом SHA под
  // версией проверок результата.
  const unproven = unprovenReason(order.requirements, evidence, result.shas.result, effective);
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
  const specDigest = context.specDigest ?? digestOf(order);
  const expectedChecks = context.checksDigest
    ? context.checksDigest({
        specDigest,
        order,
        policyDigest: result.inputs.policyDigest,
        ...(binding ? { corpus: { suite: binding.suite, digest: binding.digest } } : {}),
      })
    : effectiveChecks(
        {
          approvedDigest: specDigest,
          order,
          ...(binding ? { checkVersion: { ...binding } } : {}),
        },
        result.inputs.policyDigest,
      );
  if (expectedChecks !== effective)
    return ['версия проверок не соответствует постановке, контрактам, политике и корпусу'];
  // Какой корпус обязателен, знает только получатель.
  if (order.properties?.length && context.checkVersion === undefined)
    return ['поручение с договором проверки: получатель не передал закреплённую версию корпуса'];
  if (
    context.checkVersion !== undefined &&
    digestOf(
      context.checkVersion
        ? { suite: context.checkVersion.suite, digest: context.checkVersion.digest }
        : null,
    ) !== digestOf(binding ? { suite: binding.suite, digest: binding.digest } : null)
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
    if (suite?.versions.find((v) => v.digest === binding.digest)?.number !== binding.number)
      return [
        `номер версии корпуса ${binding.suite}#${binding.number} не совпадает с копией получателя`,
      ];
    // Корпус относится к договору поручения с тем же нормативным основанием.
    if (
      suite?.contractId !== undefined &&
      !corpusBindingHolds(
        suite,
        context.contracts,
        context.suiteBasis && ((c) => context.suiteBasis!(c)),
      )
    )
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
