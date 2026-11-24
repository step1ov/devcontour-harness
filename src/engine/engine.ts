import { RU, ruCount } from '../contracts/plural.ts';
import { randomUUID } from 'node:crypto';
import {
  canonicalContextDigest,
  contextDigestMatches,
  STAGE_NAME_LIMIT,
  noRetryEnvironmentCauses,
  NO_RETRY_GATE_CODES,
  type NoRetryEnvironmentCause,
  codeReviewDecisionSchema,
  codeReviewHistory,
  codeReviewScope,
  type CodeReviewDecision,
  roleBinding,
  integrationReuseProblem,
  executionDigest,
  isolationDigest,
  HarnessError,
  WORKSPACE_OWNER,
  MAX_REPRODUCTIONS,
  sha256,
  type ReproductionRecord,
  digestOf,
  expandGateRefs,
  gateDigest,
  policyDigest,
  graphIssues,
  selectReviewer,
  vendorOf,
  workGraphDigest,
  type AttemptState,
  type RunEventPayload,
  type CancelActor,
  type ContextLimit,
  type EnvironmentCause,
  type RetryActor,
  type JointBudgetReset,
  type JointResetActor,
  type ControllerLease,
  type ControlState,
  type Author,
  type CallRecord,
  type ContractDocument,
  type EvidenceRecord,
  type ExecutionHost,
  type ExecutionPolicy,
  type ExecutionStore,
  type ExecutionTransaction,
  type ExecutionView,
  type LeadLog,
  type ReleaseOutline,
  type FailureKind,
  type GraphState,
  type InputActor,
  type InputAnswer,
  type InputOutcome,
  type InputRequest,
  type InputTarget,
  type InputTargetRequest,
  linksAnswer,
  type ContextSnapshot,
  INPUT_LIMITS,
  INPUT_SOURCE_KIND,
  answerDigest,
  inputAnswerSchema,
  inputRequestSchema,
  inputPolicyOf,
  inputRequestId,
  inputSourceId,
  latestAnswer,
  leadAnswerBasis,
  impactOf,
  pinnedInputPolicy,
  targetDigest,
  type JointVerification,
  type JointVerificationState,
  type NotPromise,
  type Prerequisite,
  type PropertyRecovery,
  type ReviewRecord,
  type TechnicalApproval,
  type TransactionKind,
  type WorkGraph,
  type WorkOrder,
  type WorkState,
  harnessModeOf,
} from '../contracts/index.ts';
import { HARNESS_VERSION } from '../package.ts';
import {
  assertBudget,
  blockingBudget,
  budgetOverview,
  callAttribution,
  callBudgets,
  legacyGroupCall,
  recordWorkOf,
  uncoveredAttempts,
  workBudgets,
  workBudgetsOf,
  type BudgetContext,
  type BudgetStatus,
  type CallMeta,
  type RecordWork,
} from './budget.ts';
import { callDurationMs, callOwner, callRecords, ownerGone, processGone } from './usage.ts';
import {
  MAX_NEUTRAL_FAILURES,
  MAX_REWORK_BUDGETS,
  failureFingerprint,
  repairPolicy,
} from './failure.ts';
import { reusableImplementation } from './reuse.ts';
import { uncoveredGates, unprovenReason } from '../verification/proof.ts';
import { alreadySatisfiedVerdict, contractCheckGates } from '../verification/already-satisfied.ts';
import {
  contractDocuments,
  corpusBindingHolds,
  effectiveChecks,
  episodeBasis,
  orderPropertyProblems,
} from '../verification/checks.ts';
import {
  afterFailure,
  afterSuccess,
  blocksClaim,
  closeIfBasisChanged,
} from './property-recovery.ts';
import { recoveryPolicyOf } from '../projections/decisions.ts';
import { maskSecrets } from '../projections/mask.ts';
import {
  environmentGateHolds,
  gateHoldLine,
  gateHoldsFor,
  retryRoute,
  type EnvironmentGateHold,
  type RetryRoute,
} from '../projections/gate-hold.ts';
import {
  LEAD_RECOVERY_LIMIT,
  type LeadDiagnosis,
  type LeadDiagnosisCause,
  type LeadReset,
} from '../contracts/execution.ts';
import {
  countedFailure,
  epochOf,
  exhaustedStep,
  freshDiagnosis,
  leadHold,
  normalizedHypothesis,
  pendingFailures,
  type LeadHold,
} from '../projections/lead-recovery.ts';
import { REQUIREMENT_GATE } from '../verification/requirements.ts';
import { processListSeen } from '../verification/process-list.ts';
import {
  notApplicableProblem,
  proofGates,
  type ChangedPaths,
} from '../verification/applicability.ts';
import {
  blockingRequest,
  inputManifestOf,
  requestById,
  requestsOf,
  unappliedInputs,
} from './input-requests.ts';
import { pinnedCorpus, propertyProofProblem } from '../verification/acceptance.ts';
import { reusedEvidenceProblem } from '../verification/integration-reuse.ts';
import {
  jointImpact,
  jointPolicyDigest,
  jointSpecDigest,
  publicJoint,
  sameWorks,
  jointBudgetWindow,
  jointInterrupted,
} from '../verification/joint.ts';

/** Префикс причины неудавшегося продления: первая причина не затирается следствиями. */
export const HEARTBEAT_FAILED = 'Продление владения не удалось';

export interface EngineOptions {
  host: ExecutionHost;
  policy: ExecutionPolicy;
  /** Версия движка в попытках; по умолчанию — версия пакета. */
  version?: string;
  now?: () => number;
  id?: () => string;
  /**
   * Источник политики не менялся с её загрузки: `undefined` — да, иначе
   * причина. Без источника (политика передана объектом) право записать свою
   * политику как применённую ограничено остальными условиями.
   */
  provenance?: () => string | undefined;
  /**
   * Тождество применённой политики по формуле хоста — digest (64 hex),
   * например, файла конфигурации, из которого хост строит политику. По умолчанию —
   * `policyDigest(policy)`. Им сравниваются применённая и загруженная
   * политика в барьере и reconfigure; изменение политики в памяти после
   * создания движка проверяется по-прежнему по её содержимому.
   */
  policyIdentity?: string;
  /**
   * Записывать политику процесса применённой при получении роли controller
   * (по умолчанию — да). Хост, который записывает применённую политику сам
   * при запуске своего планировщика, выключает это: прямая выдача попытки
   * без запуска очереди тогда не меняет применённую политику.
   */
  recordPolicyOnLead?: boolean;
  /**
   * Обновление пакетов этого каталога состояния идёт или ждёт возврата
   * (замок живого `harness update`, запись «идёт»): причина или `undefined`.
   * `Harness` передаёт чтение `<state>-updates`; без него судят только роль
   * controller и пауза обновления в состоянии.
   */
  updateBusy?: () => string | undefined;
  /**
   * Процесс обновления, чей замок остался (`<state>-updates/lock`), умер — нет
   * его или pid достался другому процессу — и незавершённого возврата нет:
   * его pid. Тогда пауза обновления устарела. Без чтения — устаревших пауз нет.
   */
  updaterGone?: () => { pid: number } | undefined;
}

export type Phase = 'running' | 'verifying' | 'reviewing' | 'integrating';

const iso = (ms: number) => new Date(ms).toISOString();
/** Хост ждёт подтверждения перенесённой базы: выдача закрыта при любом `paused`. */
const awaitsBaseCheck = (control: Pick<ControlState, 'waits'>) =>
  (control.waits ?? []).some((w) => w.kind === 'base-check');

/** Открытая доработка после приёмки: новая редакция принятой работы ещё не принята и не оставлена. */
const openRework = (w: WorkState) =>
  !!w.rework && !w.rework.abandoned && w.status !== 'done' && w.status !== 'cancelled';

/** Содержание поручения без номера редакции источника: одинаковое содержание — та же работа. */
const contentDigest = (order: WorkState['order']) =>
  digestOf({ ...order, source: { connector: order.source.connector, ref: order.source.ref } });

/**
 * Правила исполнения и технической приёмки. Все решения — внутри одной
 * транзакции хранилища: состояние, на котором решение принято, и запись
 * решения неразделимы. Хост может только добавить запрет (`HostGuards`) и
 * дать основания (`BasisProvider`); снять отказ движка он не может.
 */
/**
 * Отказ, который ничего не говорит о работе, бюджет попыток поручения не
 * тратит: окружение или провайдер не дали исполнить или проверить её.
 * Бесконечного цикла это не открывает: такие отказы держат выдачу
 * (`repairPolicy.blocksQueue`), а повтор ограничен пределом одинаковых
 * отпечатков и общим бюджетом восстановлений.
 */
const uncounted = (kind: FailureKind, blocked: boolean, writerBlocked = false) =>
  blocked || kind === 'environment' || kind === 'provider-auth' || writerBlocked;

/** Сброс попыток: причина; у сброса ведущего — разбор, по которому он дан. */
export interface RetryReset {
  reason: string;
  diagnosis?: string;
}

/** Что дальше после разбора (`harness diagnose`). */
export type DiagnoseNext =
  'attempt' | 'diagnose' | 'replan' | 'user-decision' | 'lead-reset' | 'user-reset';

/** Удержание правилом восстановления — блокировкой выдачи (`Engine.blockers`). */
function leadHoldBlocker(hold: LeadHold) {
  switch (hold.kind) {
    case 'diagnosis-required':
      return {
        code: 'DIAGNOSIS_REQUIRED' as const,
        message: `Нужен разбор ведущего: ${hold.failures.length} засчитанных отказа без разбора (${hold.failures.join(', ')}) — harness diagnose`,
      };
    case 'replan':
      return {
        code: 'NOT_READY' as const,
        message: `Разбор ${hold.diagnosis.id}: задача велика — ждёт перепланирования и согласования`,
      };
    case 'contradiction':
      return {
        code: 'NOT_READY' as const,
        message: `Разбор ${hold.diagnosis.id}: противоречивое обещание — ждёт решения человека`,
      };
  }
}

const leadHoldError = (hold: LeadHold) => {
  const b = leadHoldBlocker(hold);
  return new HarnessError(b.code, b.message);
};

/**
 * Остановка вопросом (`needs-input`) — не неудача работы: попытка
 * возвращается в предел, а предел незасчитанных отказов не тратится; ответ
 * на последней попытке продолжает работу без сброса. Ответ может дать
 * модель (режим согласования `agent`), поэтому возврат ограничен: поручение
 * получает не больше `maxAttempts` таких остановок за всю жизнь — сброс их
 * не возвращает. Счёт — по записям попыток поручения (`earlier` — прежние
 * остановки вопросом, кроме прерванных остановкой controller); остановка
 * сверх предела засчитывается как обычная попытка.
 */
const returnsAttempt = (kind: FailureKind, earlier: number, maxAttempts: number) =>
  kind === 'needs-input' && earlier < maxAttempts;

/** Прежние остановки вопросом поручения, кроме попытки `except`. */
const inputStopsOf = (attempts: readonly AttemptState[], except?: string) =>
  attempts.filter(
    (x) => x.id !== except && x.failureKind === 'needs-input' && x.interrupted !== 'shutdown',
  ).length;

/**
 * Причина отказа для `attempt.diagnosed`: отказ не окружения — `none`;
 * окружения — названная в точке обнаружения или по классу отказа.
 */
const causeOf = (
  kind: FailureKind,
  cause: EnvironmentCause | undefined,
  blocked: boolean,
): EnvironmentCause => {
  if (kind === 'stalled') return 'stalled';
  // Отказ до работы (`blocked`) — отказ окружения при любом классе: отчёт
  // относит его к окружению, и причина не `none`.
  if (blocked && kind !== 'provider-auth' && kind !== 'environment') return 'preflight';
  if (kind === 'provider-auth')
    return cause === 'provider-limit' ? 'provider-limit' : 'provider-auth';
  if (kind === 'needs-lead' && cause === 'writer-environment') return cause;
  if (kind !== 'environment') return 'none';
  return cause && cause !== 'none' && cause !== 'provider-auth' && cause !== 'provider-limit'
    ? cause
    : 'other';
};

/** Нарушение схемы входа операции — `INVALID_INPUT` с путями, а не исключение zod. */
function invalidInput(
  what: string,
  result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } },
) {
  if (result.success) return;
  const issues = (result.error?.issues ?? []).map((i) => ({
    path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
    message: i.message,
  }));
  throw new HarnessError(
    'INVALID_INPUT',
    `${what}: ${issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    issues,
  );
}

/** Поручение исчерпало предел незасчитанных отказов: повтор — только со сбросом. */
export const neutralExhausted = (w: Pick<WorkState, 'neutralFailures'>) =>
  (w.neutralFailures ?? 0) >= MAX_NEUTRAL_FAILURES;

/**
 * Провал, названный свойством или случаем корпуса, — найденный контрпример, а
 * не сбой среды: генеративная проверка недетерминирована, и удачный повтор
 * не отменяет найденного входа. Такой провал не повторяется.
 */
export function namesFailingCases(e: Pick<EvidenceRecord, 'property'>) {
  const report = e.property?.report;
  return (
    !!report &&
    (report.properties.some((p) => p.status === 'failed') ||
      (report.corpus?.failed.length ?? 0) > 0)
  );
}

/**
 * Повтор `recheck` провала `failed` провален только кодом выхода исполнителя
 * тестов: отчёт полон и не называет ни одного упавшего теста, каждый тест,
 * упавший в первом запуске (`failed` называет хотя бы один), теперь прошёл,
 * свойств и корпуса нет. Так выглядит падение процесса исполнителя (worker
 * SIGSEGV) после прохождения тестов, а не дефект кода: такой повтор
 * получает ещё один запуск с той же ссылкой.
 */
export function crashedRecheck(
  failed: Pick<EvidenceRecord, 'tests' | 'testsTruncated' | 'property'>,
  recheck: Pick<
    EvidenceRecord,
    'passed' | 'exitCode' | 'tests' | 'testsTruncated' | 'property' | 'recheck'
  >,
) {
  if (recheck.passed || recheck.recheck?.outcome !== 'confirmed') return false;
  if (!recheck.exitCode || recheck.exitCode < 0) return false;
  if (failed.testsTruncated || recheck.testsTruncated || failed.property || recheck.property)
    return false;
  const before = (failed.tests ?? []).filter((t) => t.status === 'failed');
  const after = new Map((recheck.tests ?? []).map((t) => [t.id, t.status]));
  return (
    before.length > 0 &&
    !(recheck.tests ?? []).some((t) => t.status === 'failed') &&
    before.every((t) => after.get(t.id) === 'passed')
  );
}

/** Активные попытки снимка: быстрый путь адаптера или фильтр всех. */
export function activeOf(v: ExecutionView): AttemptState[] {
  return v.activeAttempts ? v.activeAttempts() : v.attempts().filter((a) => a.status === 'active');
}

/** Операция паузы `harness update` (пакеты harness и панели меняются). */
export const UPDATE_PAUSE_OPERATION = 'harness-update';

export class Engine {
  readonly host: ExecutionHost;
  readonly policy: ExecutionPolicy;
  readonly version: string;
  private readonly now: () => number;
  private readonly id: () => string;
  /** Digest политики процесса на момент создания движка. */
  readonly loadedPolicy: string;
  /** Содержимое политики при создании движка: изменение в памяти — отказ применения. */
  private readonly loadedContent: string;
  /** Поколение применённой политики, которое процесс застал при запуске. */
  private readonly observedGeneration: number;
  private readonly provenance: () => string | undefined;
  /** Владелец роли controller, под которым этот процесс её получил. */
  private ownLeader?: string;

  private readonly recordOnLead: boolean;
  private readonly updateBusy: () => string | undefined;
  private readonly updaterGone: () => { pid: number } | undefined;
  constructor(options: EngineOptions) {
    this.host = options.host;
    this.policy = options.policy;
    const reuse = integrationReuseProblem(this.policy, this.host);
    if (reuse) throw new HarnessError('INVALID_INPUT', reuse);
    this.version = options.version ?? HARNESS_VERSION;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.provenance = options.provenance ?? (() => undefined);
    this.recordOnLead = options.recordPolicyOnLead !== false;
    this.updateBusy = options.updateBusy ?? (() => undefined);
    this.updaterGone = options.updaterGone ?? (() => undefined);
    this.loadedContent = policyDigest(this.policy);
    this.loadedPolicy = options.policyIdentity ?? this.loadedContent;
    this.observedGeneration = this.host.store.read(
      (v) => v.control().appliedPolicy?.generation ?? 0,
    );
  }

  /** Часы движка: по ним считаются сроки владения. */
  clock() {
    return this.now();
  }

  /** Версия проверок поручения: формула хоста, если он её задал, иначе harness. */
  private checksOf(work: WorkState, view: ExecutionView) {
    const policy = this.host.basis.policyDigest(work, view);
    return this.host.basis.checksDigest?.(work, policy, view) ?? effectiveChecks(work, policy);
  }

  /**
   * Основание эпизода разбора по свойству: формула хоста, если он её задал,
   * иначе harness. Хост с принятой историей держит свою — ею подписаны его
   * прежние эпизоды и попытки, и они не закрываются как «новое основание».
   */
  episodeOf(work: WorkState, view: ExecutionView) {
    return this.host.basis.episodeBasis?.(work, view) ?? episodeBasis(work);
  }

  private tx<T>(kind: TransactionKind, fn: (tx: ExecutionTransaction) => NotPromise<T>): T {
    return this.host.store.transact(kind, fn);
  }
  private repository(id: string) {
    const repo = this.policy.repositories.find((r) => r.id === id);
    if (!repo) throw new HarnessError('INVALID_INPUT', 'Репозиторий не объявлен: ' + id);
    return repo;
  }

  read<T>(fn: (view: ExecutionView) => NotPromise<T>): T {
    return this.host.store.read(fn);
  }

  /* ---------------------------------------------------------------- */
  /* Граф и согласование                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Регистрация графа. Повтор той же редакции источника с тем же digest —
   * продолжение прежней работы; другой digest той же редакции или того же
   * ID графа — `REVISION_CONFLICT`. Предпосылки должны быть подтверждены:
   * `engine` — успешной попыткой этого хранилища с тем же result SHA,
   * `trusted` — решением источника (`trusted`), переданным вызывающим вместе
   * с проверкой доступности SHA в target ref (`reachable`).
   */
  register(
    graph: WorkGraph,
    prerequisites: {
      trusted: (p: Prerequisite) => boolean;
      reachable: (p: Prerequisite) => boolean;
    },
  ): { graph: GraphState; resumed: boolean; replaced?: boolean } {
    const issues = graphIssues(graph);
    if (issues.length)
      throw new HarnessError(
        issues[0]!.code,
        `Граф отклонён: ${ruCount(issues.length, RU.violation)}`,
        issues.map(({ path, message }) => ({ path: ['graph', ...path], message })),
      );
    const digest = workGraphDigest(graph);
    const key = digestOf([graph.source.connector, graph.source.ref, graph.source.revision]);
    return this.tx('graph.registered', (tx) => {
      this.assertNoUpdate(tx);
      const known = tx.local('run-keys', WORKSPACE_OWNER, key);
      const existing = tx.graph(graph.id);
      if (known && known.digest !== digest)
        throw new HarnessError(
          'REVISION_CONFLICT',
          `Редакция ${graph.source.revision} источника ${graph.source.ref} уже зарегистрирована с другим содержанием`,
        );
      if (existing?.digest === digest) return { graph: existing, resumed: true };
      // Новая редакция графа заменяет прежнюю, только пока у него нет активных
      // попыток. Принятые поручения с неизменной постановкой остаются принятыми;
      // изменённые и новые — черновики до нового согласования; история попыток
      // не переписывается. Изменённое принятое — доработка (`rework`) со своим
      // пределом попыток; изменённое непринятое сохраняет счётчик.
      if (existing && tx.works(graph.id).some((w) => w.activeRunId))
        throw new HarnessError(
          'REVISION_CONFLICT',
          `У графа ${graph.id} есть активные попытки; новая редакция подождёт их`,
        );
      for (const p of graph.prerequisites) {
        const ok =
          p.receipt.kind === 'engine'
            ? tx
                .attempts()
                .some(
                  (a) =>
                    a.id === (p.receipt as { runId: string }).runId &&
                    a.status === 'succeeded' &&
                    a.integrationSha === p.resultSha,
                )
            : prerequisites.trusted(p);
        if (!ok || !prerequisites.reachable(p))
          throw new HarnessError(
            'NOT_READY',
            `Предпосылка ${p.id} не подтверждена: нужен результат движка или доверенный receipt с доступным SHA`,
          );
      }
      const at = iso(this.now());
      const state: GraphState = {
        id: graph.id,
        digest,
        graph,
        policyDigest: executionDigest(this.policy),
        registeredAt: at,
      };
      tx.putGraph(state);
      const reopened: { workId: string; rework: NonNullable<WorkState['rework']> }[] = [];
      // Эпохи раундов, открытые до записи `round-epochs` (состояние прежней
      // сборки): первая запись начинается с них, израсходованные остаются
      // израсходованными (ревью r3).
      const legacyEpochs = tx.local('round-epochs', WORKSPACE_OWNER, graph.id)
        ? []
        : tx.works(graph.id).flatMap((w) => {
            const r = w.rework;
            const start =
              r && (r.roundEpochAt ?? (r.fresh && !r.resumed ? r.reopenedAt : undefined));
            return start ? [{ at: start, workId: w.id }] : [];
          });
      for (const order of graph.orders) {
        const prior = tx.work(order.id);
        if (prior && prior.graphId !== graph.id)
          throw new HarnessError(
            'REVISION_CONFLICT',
            `Поручение ${order.id} уже принадлежит другому графу`,
          );
        // Принятая постановка не меняется — работа остаётся принятой. Кроме
        // оставленной доработки без возвращённой постановки: у поручения
        // записано содержание, которое не принималось, и та же постановка
        // снова открывает доработку.
        if (
          prior?.status === 'done' &&
          contentDigest(prior.order) === contentDigest(order) &&
          !(
            prior.rework?.abandoned &&
            !prior.rework.abandoned.restored &&
            prior.rework.abandoned.orderDigest === contentDigest(order)
          )
        )
          continue;
        // Принятая версия корпуса остаётся за поручением, пока среди его
        // договоров есть договор этого корпуса с тем же нормативным основанием; эпизод восстановления и его история — тоже: закрывает их
        // согласование нового основания, а не новая редакция источника.
        const corpus =
          prior?.checkVersion &&
          corpusBindingHolds(
            tx
              .locals('check-suites')
              .map((x) => x.value)
              .find((x) => x.id === prior.checkVersion!.suite),
            contractDocuments(order, tx),
            this.host.basis.suiteBasis && ((c) => this.host.basis.suiteBasis!(c)),
          )
            ? prior.checkVersion
            : undefined;
        // Изменённая постановка принятого поручения — доработка, а не повтор
        // проваленного договора: своя редакция со своим пределом попыток (не
        // больше MAX_REWORK_BUDGETS раз, дальше счётчик переносится). У
        // непринятого счётчик и незасчитанные отказы остаются: новой
        // редакцией предел не обойти.
        const reopen = prior?.status === 'done' ? this.reworkOf(tx, prior, order, at) : undefined;
        const rework = reopen ?? prior?.rework;
        const fresh = reopen?.fresh === true;
        // Та же постановка после отказа от доработки продолжает оставленную:
        // её засчитанные попытки и незасчитанные отказы, а не предел заново.
        const resumed = reopen?.resumed ? prior?.rework?.abandoned : undefined;
        const neutral = fresh
          ? undefined
          : resumed
            ? resumed.neutralFailures
            : prior?.neutralFailures;
        tx.putWork({
          id: order.id,
          graphId: graph.id,
          order,
          status: 'draft',
          attempt: fresh
            ? 0
            : resumed
              ? (resumed.attempt ?? this.abandonedReworkSpent(tx, prior!))
              : (prior?.attempt ?? 0),
          ...(neutral ? { neutralFailures: neutral } : {}),
          ...(rework ? { rework } : {}),
          ...(corpus ? { checkVersion: corpus } : {}),
          ...(prior?.recovery ? { recovery: prior.recovery } : {}),
          ...(prior?.recoveryHistory ? { recoveryHistory: prior.recoveryHistory } : {}),
          // Разборы и сбросы ведущего — история работы: новой редакцией
          // предел сбросов не обойти (счёт — по пределу попыток, `rework.budgets`).
          ...(prior?.leadRecovery ? { leadRecovery: prior.leadRecovery } : {}),
          // Удержание операции принадлежит ей: новая редакция источника его не
          // снимает — только release или передача владельцем.
          ...(prior?.hold ? { hold: prior.hold } : {}),
          // Удержание gate отказом без повтора — свойство gate и среды, а не
          // редакции графа: оно переносится и снимается, как прежде, сменой
          // определения gate или среды, повтором ведущего, приёмкой или
          // отменой работы.
          ...(prior?.environmentHold && prior.status !== 'done' && prior.status !== 'cancelled'
            ? { environmentHold: prior.environmentHold }
            : {}),
        });
        if (reopen) reopened.push({ workId: order.id, rework: reopen });
        // Эпоха раундов ревью плана — запись графа, которая не стирается:
        // её не вернуть ни новой доработкой, ни отказом (ревью r2).
        if (reopen?.fresh && reopen.roundEpochAt === at) {
          const prev = tx.local('round-epochs', WORKSPACE_OWNER, graph.id)?.epochs ?? legacyEpochs;
          tx.putLocal('round-epochs', WORKSPACE_OWNER, graph.id, {
            epochs: [...prev, { at, workId: order.id }].slice(-100),
          });
        }
        // Первое появление работы в выпуске (alpha.68): по нему прогноз
        // называет рост плана. Новая редакция прежнюю запись не трогает.
        if (!prior && !tx.local('work-seen', WORKSPACE_OWNER, order.id))
          tx.putLocal('work-seen', WORKSPACE_OWNER, order.id, { at, graphId: graph.id });
      }
      for (const prior of existing ? tx.works(graph.id) : [])
        if (!graph.orders.some((o) => o.id === prior.id) && prior.status !== 'done') {
          // Открытая доработка принятой работы, убранная из плана, — не отмена
          // задачи: работа возвращается к принятой редакции.
          if (openRework(prior)) {
            this.abandonReworkIn(tx, prior, 'graph');
            continue;
          }
          tx.putWork({ ...prior, status: 'cancelled', activeRunId: undefined });
          this.closeRequestsOf(tx, prior, 'controller');
          if (prior.status !== 'cancelled')
            tx.emit({
              type: 'work.cancelled',
              graphId: graph.id,
              workId: prior.id,
              payload: { by: 'graph', hadAttempt: Boolean(prior.activeRunId) },
            });
        }
      tx.putLocal('run-keys', WORKSPACE_OWNER, key, { graphId: graph.id, digest, at });
      tx.emit({
        type: 'graph.registered',
        graphId: graph.id,
        payload: { digest, orders: graph.orders.length, source: graph.source },
      });
      for (const { workId, rework } of reopened)
        tx.emit({
          type: 'work.reopened',
          graphId: graph.id,
          workId,
          payload: {
            revision: rework.revision,
            budget: rework.fresh ? 'fresh' : 'carried',
            acceptedSha: rework.accepted.resultSha,
            spent: rework.spent,
          },
        });
      return { graph: state, resumed: false, replaced: Boolean(existing) };
    });
  }

  /**
   * Доработка принятого поручения `prior` новой редакцией (`register`):
   * приёмка, после которой она открыта, — принявшая попытка (последняя
   * успешная) и результат поручения. Свой предел попыток — пока доработок с
   * ним меньше `MAX_REWORK_BUDGETS`. Принятое без результата (не бывает у
   * приёмки движком) доработкой не считается: счётчик остаётся.
   */
  private reworkOf(
    tx: ExecutionView,
    prior: WorkState,
    order: WorkOrder,
    at: string,
  ): WorkState['rework'] | undefined {
    const run = tx
      .attempts(prior.id)
      .filter((a) => a.status === 'succeeded')
      .at(-1);
    const resultSha = prior.resultSha ?? run?.integrationSha;
    if (!resultSha) return undefined;
    const budgets = prior.rework?.budgets ?? 0;
    // Отказ от доработки и та же постановка снова (P3-1): это продолжение
    // оставленной доработки, а не новая — предел попыток, счёт сбросов
    // ведущего (`budgets` — эпоха) и попытки переносятся с неё. Иначе
    // «оставить и открыть заново» давал бы свежий предел каждый раз. Другая
    // постановка после отказа — новая доработка по общему правилу: свой
    // предел, пока таких меньше `MAX_REWORK_BUDGETS`, дальше — перенос.
    const abandoned = prior.rework?.abandoned;
    const resumed = !!abandoned && abandoned.orderDigest === contentDigest(order);
    const fresh = !resumed && budgets < MAX_REWORK_BUDGETS;
    return {
      revision: (prior.rework?.revision ?? 0) + 1,
      budgets: fresh ? budgets + 1 : budgets,
      fresh,
      ...(resumed ? { resumed: true as const } : {}),
      accepted: {
        ...(run ? { runId: run.id } : {}),
        resultSha,
        ...(run?.finishedAt ? { at: run.finishedAt } : {}),
      },
      reopenedAt: at,
      // Эпоха раундов ревью плана: своя у доработки со своим пределом,
      // прежняя — у продолжения оставленной и у перенесённого счётчика.
      ...((epoch) => (epoch ? { roundEpochAt: epoch } : {}))(
        fresh
          ? at
          : (prior.rework?.roundEpochAt ??
              (prior.rework?.fresh && !prior.rework.resumed ? prior.rework.reopenedAt : undefined)),
      ),
      spent: prior.attempt,
      acceptedOrder: prior.order,
    };
  }

  /**
   * Засчитанные попытки оставленной доработки для записи прежней сборки
   * (`rework.abandoned` без `attempt`): `prior.attempt` там — счёт принятой
   * редакции, и продолжение по нему дало бы предел заново. Счёт выводится,
   * когда известна принятая попытка (`rework.accepted.runId`): перенесённый
   * с прежней редакции счёт (`spent` у доработки без своего предела) плюс
   * засчитанные отказы после принятой попытки. Сбросы внутри доработки
   * здесь не вычитаются — ошибка только в строгую сторону. Не вывести —
   * строгая сторона: предел исчерпан (`maxAttempts`), продолжение решает
   * сброс.
   */
  private abandonedReworkSpent(tx: ExecutionView, prior: WorkState): number {
    const r = prior.rework;
    const own = tx.attempts(prior.id);
    const from = r?.accepted.runId ? own.findIndex((a) => a.id === r.accepted.runId) : -1;
    if (!r || from < 0) return this.policy.maxAttempts;
    const counted = own.slice(from + 1).filter(countedFailure).length;
    return Math.min(this.policy.maxAttempts, (r.fresh ? 0 : r.spent) + counted);
  }

  /**
   * Отказ от открытой доработки принятого поручения (0.1.0-alpha.66):
   * идущая попытка доработки отменяется, работа возвращается к принятой
   * редакции — `done`, результат прежней приёмки, постановка принятой
   * редакции (`acceptedOrder`; у доработки прежней версии её нет — остаётся
   * текущая с отметкой `abandoned.orderDigest`). Засчитанные попытки
   * принятой редакции возвращаются (у доработки со своим пределом); счёт
   * доработок со своим пределом (`budgets`) и история попыток сохраняются:
   * отказом и новой доработкой предел не обойти.
   */
  private abandonReworkIn(tx: ExecutionTransaction, w: WorkState, by: CancelActor) {
    const r = w.rework!;
    const at = iso(this.now());
    const a = w.activeRunId ? tx.attempt(w.activeRunId) : undefined;
    if (a && a.status === 'active') {
      tx.putAttempt({ ...a, status: 'cancelled', finishedAt: at, failureKind: 'cancelled' });
      tx.emit({
        type: 'attempt.cancelled',
        workId: w.id,
        runId: a.id,
        attempt: a.attempt,
        payload: { reason: 'доработка оставлена: работа вернулась к принятой редакции' },
      });
    }
    const { acceptedOrder, ...kept } = r;
    const next: WorkState = {
      id: w.id,
      graphId: w.graphId,
      order: acceptedOrder ?? w.order,
      status: 'done',
      attempt: r.fresh ? r.spent : w.attempt,
      resultSha: r.accepted.resultSha,
      ...(w.approvedAt ? { approvedAt: w.approvedAt } : {}),
      ...(w.approvedDigest ? { approvedDigest: w.approvedDigest } : {}),
      ...(w.approvedScope ? { approvedScope: w.approvedScope } : {}),
      ...(w.approval ? { approval: w.approval } : {}),
      ...(w.hold ? { hold: w.hold } : {}),
      ...(w.checkVersion ? { checkVersion: w.checkVersion } : {}),
      ...(w.recovery ? { recovery: w.recovery } : {}),
      ...(w.recoveryHistory ? { recoveryHistory: w.recoveryHistory } : {}),
      ...(w.neutralFailures ? { neutralFailures: w.neutralFailures } : {}),
      ...(w.codeReviewDecisions ? { codeReviewDecisions: w.codeReviewDecisions } : {}),
      // Разборы и сбросы ведущего — история работы, как при новой редакции:
      // отказом от доработки предел сбросов не обойти (номера D<n>, отказ от
      // повторённой гипотезы и счёт сбросов предела `rework.budgets` остаются).
      ...(w.leadRecovery ? { leadRecovery: w.leadRecovery } : {}),
      rework: {
        ...kept,
        abandoned: {
          at,
          by,
          orderDigest: contentDigest(w.order),
          restored: acceptedOrder !== undefined,
          // Засчитанные попытки оставленной доработки: та же постановка
          // снова продолжает этот счёт, а не начинает предел заново.
          attempt: w.attempt,
          ...(w.neutralFailures ? { neutralFailures: w.neutralFailures } : {}),
        },
      },
    };
    tx.putWork(next);
    this.closeRequestsOf(tx, w, by === 'graph' ? 'controller' : by);
    tx.emit({
      type: 'work.rework-abandoned',
      graphId: w.graphId,
      workId: w.id,
      ...(a ? { runId: a.id, attempt: a.attempt } : {}),
      payload: {
        by,
        revision: r.revision,
        acceptedSha: r.accepted.resultSha,
        restored: acceptedOrder !== undefined,
        hadAttempt: Boolean(a && a.status === 'active'),
      },
    });
    return next;
  }

  /** Раунд технического ревью плана или контракта сохраняется в истории предмета. */
  /**
   * `document` — документ контракта, который ревью рассматривало: он
   * сохраняется по своему digest, и из него движок берёт договор проверки.
   */
  /**
   * `historyRounds` — раунды предмета, проведённые хостом до harness
   * (`TechnicalReviewInput.history`): первый раунд движка следует за ними, и
   * дальше нумерация идёт подряд от него.
   */
  recordReview(record: ReviewRecord, document?: ContractDocument, historyRounds = 0) {
    if (document && (record.kind !== 'contract' || digestOf(document) !== record.digest))
      throw new HarnessError('INVALID_INPUT', 'Документ не соответствует ревью контракта');
    // Раунд отмечает политику, под которой он записан: прежний раунд не покроет
    // её правку, что бы ни передал вызывающий.
    record = {
      ...record,
      policyDigest: executionDigest(this.policy),
      isolationDigest: isolationDigest(this.policy),
    };
    return this.tx('graph.reviewed', (tx) => {
      this.assertNoUpdate(tx);
      if (document) tx.putLocal('contract-documents', WORKSPACE_OWNER, record.digest, document);
      const previous = tx
        .locals('reviews', WORKSPACE_OWNER)
        .map((r) => r.value)
        .filter((r) => r.kind === record.kind && r.subject === record.subject);
      const offset = previous.length
        ? Math.min(...previous.map((r) => r.round)) - 1
        : historyRounds;
      if (record.round !== offset + previous.length + 1)
        throw new HarnessError(
          'INVALID_INPUT',
          `Раунд ${record.round} не следует за ${offset + previous.length}`,
        );
      tx.putLocal('reviews', WORKSPACE_OWNER, record.id, record);
      tx.emit({
        type: 'graph.reviewed',
        graphId: record.kind === 'plan' ? record.subject : undefined,
        payload: {
          kind: record.kind,
          subject: record.subject,
          digest: record.digest,
          round: record.round,
          approved: record.approved,
          open: record.findings.filter((f) => f.status === 'open').length,
        },
      });
      return record;
    });
  }

  reviews(kind: 'plan' | 'contract', subject: string): ReviewRecord[] {
    return this.read((v) =>
      v
        .locals('reviews', WORKSPACE_OWNER)
        .map((r) => r.value)
        .filter((r) => r.kind === kind && r.subject === subject)
        .sort((a, b) => a.round - b.round),
    );
  }

  /**
   * Digest назначения reviewer вида `kind` для автора по текущей политике:
   * runtime, модель, effort, содержимое профиля и правило вендора. Раунд ревью
   * подтверждает предмет только при том же назначении.
   */
  reviewerBinding(kind: 'plan' | 'contract' | 'code', author: Author): string | undefined {
    const choice = selectReviewer(this.policy, kind, { runtime: author });
    if (!choice.ok) return undefined;
    // Содержимое профиля, а не только его имя: другой набор инструментов —
    // другое назначение.
    const profile = choice.reviewer.toolProfile;
    return digestOf({
      reviewer: choice.reviewer,
      vendor: this.policy.review[kind].vendor,
      ...(profile ? { tools: this.policy.toolProfiles[profile] ?? null } : {}),
    });
  }

  /**
   * Контракты поручения: последний раунд ревью каждого контракта — его digest,
   * одобрен, при текущем назначении reviewer; у хоста с портом `contracts` —
   * редакция этого digest согласована хостом. Иначе поручение не выдаётся и не
   * принимается.
   */
  contractBlocker(work: WorkState, view: ExecutionView): string | undefined {
    for (const ref of work.order.contracts) {
      // Хост, ведущий согласование контрактов сам, подтверждает редакцию по digest.
      if (this.host.contracts) {
        const refusal = this.host.contracts.approved(ref, view);
        if (refusal) return refusal.message;
        continue;
      }
      const last = view
        .locals('reviews', WORKSPACE_OWNER)
        .map((r) => r.value)
        .filter((r) => r.kind === 'contract' && r.subject === ref.id)
        .sort((a, b) => a.round - b.round)
        .at(-1);
      if (!last) return `Контракт ${ref.id} не проходил технического ревью`;
      if (last.digest !== ref.digest)
        return `Контракт ${ref.id}: последнее ревью относится к другому digest`;
      if (!last.approved) return `Контракт ${ref.id}: последний раунд ревью не одобрил его`;
      if (last.reviewerBinding !== this.reviewerBinding('contract', last.authorRuntime))
        return `Контракт ${ref.id}: ревью проведено при другом назначении reviewer`;
    }
    return undefined;
  }

  /**
   * Согласование графа. Привязано к digest проверенного предложения: в
   * режиме `agent` нужен одобренный последний раунд ревью этого digest, в
   * режиме `operator` — проведённое ревью этого digest и решение оператора.
   * Другого способа сделать поручения готовыми к выдаче нет.
   */
  approve(
    graphId: string,
    actor: TechnicalApproval['actor'],
    options: {
      /**
       * Связать согласование со снимком контекста последнего раунда ревью
       * плана: другой снимок при том же графе — новое согласование.
       */
      bindContext?: boolean;
      /** Кто и почему согласует заново после правки политики (`reapprove`): запись в согласовании и событии. */
      reapproval?: { by: string; reason: string };
    } = {},
  ) {
    return this.tx('graph.approved', (tx) => {
      this.assertNoUpdate(tx);
      const { graph, last } = this.approvalCheck(tx, graphId, actor);
      // Снимок с ответом на вопрос исполнителя становится действующим только
      // через applyInput: обходное согласование его не активирует.
      if (options.bindContext && last.contextDigest) {
        const snapshot = tx.local('context-snapshots', WORKSPACE_OWNER, last.contextDigest);
        const unapplied = this.unappliedInputs(tx, snapshot);
        if (unapplied.length)
          throw new HarnessError(
            'INPUT_REQUIRED',
            'Снимок контекста содержит неприменённый ответ на вопрос исполнителя; активирует его только applyInput: ' +
              unapplied.map((u) => `${u.requestId ?? u.source} (${u.reason})`).join(', '),
          );
        // Новый ответ в снимке не становится действующим под идущими
        // попытками графа (H02-I) — и через обычное согласование.
        const busy = this.inputActivationRefusal(tx, graphId, snapshot);
        if (busy) throw new HarnessError('NOT_READY', busy);
      }
      return this.activateApproval(tx, graph, last, actor, options);
    });
  }

  /**
   * Проверки согласования графа (`approve`): политика процесса применена,
   * актёр — режим политики, последний раунд ревью плана относится к текущему
   * digest графа (в режиме `agent` — одобрен) и проведён при текущем
   * назначении reviewer, договоры проверки поручений согласованы. Ничего не
   * пишет, кроме записи применённой политики барьером; отказ — исключение.
   * Общая для `approve` и `applyInput`: продолжение после ответа проходит те
   * же проверки, а не ослабленные.
   */
  approvalCheck(tx: ExecutionTransaction, graphId: string, actor: TechnicalApproval['actor']) {
    this.assertCurrentPolicy(tx);
    return this.approvalRules(tx, graphId, actor);
  }

  /**
   * Перепроверить основание применённого, но ещё не переданного ответа сейчас,
   * а не при следующей выдаче: разошлось (постановка, контекст, у хоста —
   * политика) — запрос возвращается в `answered` с записью `stale`, как при
   * claim. Возвращает текущий запрос.
   */
  refreshApplied(id: string) {
    return this.tx('input.applied', (tx) => {
      this.assertNoUpdate(tx);
      const { request } = this.requestIn(tx, id);
      const work = tx.work(request.workId);
      if (work && linksAnswer(request) && !request.delivered && request.target)
        this.staleTargets(tx, work);
      return this.requestIn(tx, id).request;
    });
  }

  /**
   * Покрывает ли последний раунд ревью плана снимок `contextDigest` по тем же
   * правилам, что у согласования (`approvalRules`): `{ round }` — да, иначе
   * причина. Только чтение; им `Harness.resolveInput` и `carryInputOf`
   * решают, нужен ли новый раунд.
   */
  planRoundCovers(graphId: string, contextDigest: string | null, snapshot?: ContextSnapshot) {
    return this.read((v): { round: number } | { reason: string } => {
      try {
        const { last } = this.approvalRules(v, graphId, this.policy.approvalMode);
        // Отклонённый раунд не переиспользуется ни в каком режиме: новый раунд
        // с отказом — тоже отказ (REVIEW_REJECTED).
        if (!last.approved) return { reason: `раунд ${last.round} не одобрил граф` };
        // Тот же снимок в другом порядке источников или записанный digest
        // прежней версии — тот же контекст (0.1.0-alpha.68).
        if (
          (last.contextDigest ?? null) !== contextDigest &&
          !(snapshot && contextDigestMatches(last.contextDigest, snapshot))
        )
          return { reason: `раунд ${last.round} рассматривал другой снимок контекста` };
        return { round: last.round };
      } catch (error) {
        if (!(error instanceof HarnessError)) throw error;
        return { reason: error.message };
      }
    });
  }

  /**
   * Правила согласования без барьера политики (`approvalCheck` — с ним):
   * только чтение, отказ — исключение. Им же `proposeTarget` называет
   * причины отказа, не повторяя правил.
   */
  private approvalRules(tx: ExecutionView, graphId: string, actor: TechnicalApproval['actor']) {
    const graph = tx.graph(graphId);
    if (!graph) throw new HarnessError('NOT_FOUND', 'Граф не найден: ' + graphId);
    if (actor !== this.policy.approvalMode)
      throw new HarnessError(
        'APPROVAL_REQUIRED',
        `Политика требует согласования ${this.policy.approvalMode === 'operator' ? 'оператором' : 'агентом-ревьюером'}`,
      );
    const rounds = tx
      .locals('reviews', WORKSPACE_OWNER)
      .map((r) => r.value)
      .filter((r) => r.kind === 'plan' && r.subject === graphId)
      .sort((a, b) => a.round - b.round);
    const last = rounds.at(-1);
    if (!last || last.digest !== graph.digest)
      throw new HarnessError('APPROVAL_REQUIRED', 'Нет ревью плана для текущего digest графа');
    if (actor === 'agent' && !last.approved)
      throw new HarnessError('REVIEW_REJECTED', 'Последний раунд ревью плана не одобрил граф');
    if (last.reviewerBinding !== this.reviewerBinding('plan', last.authorRuntime))
      throw new HarnessError(
        'APPROVAL_REQUIRED',
        'Ревью плана проведено при другом назначении reviewer; нужен новый раунд',
      );
    // Изоляция, сеть и профили инструментов — граница исполнения: её правку
    // покрывает только раунд, проведённый под ней. Раунд без отметки (до
    // alpha.59) покрывает лишь политику, под которой граф уже согласован.
    const covered = last.isolationDigest
      ? last.isolationDigest === isolationDigest(this.policy)
      : Boolean(graph.approval) && graph.policyDigest === executionDigest(this.policy);
    if (!covered && !last.isolationDigest)
      throw new HarnessError(
        'APPROVAL_REQUIRED',
        `Раунд ревью плана ${last.round} записан версией до 0.1.0-alpha.59 без отметки политики: он не покрывает изменённую политику и не согласует граф впервые — нужен новый раунд review-plan`,
      );
    if (!covered)
      throw new HarnessError(
        'APPROVAL_REQUIRED',
        'Изоляция, сеть или профили инструментов политики изменились после ревью плана (раунд ' +
          last.round +
          '): прежнее одобрение их не покрывает — нужен новый раунд review-plan',
      );
    // Свойства поручений существуют в их договорах проверки и исполняются
    // их генеративными gates: иначе ожидаемая проверка не определена.
    const problems = tx.works(graphId).flatMap((w) => {
      const repo = this.repository(w.order.repositoryId);
      return orderPropertyProblems(w.order, contractDocuments(w.order, tx), {
        configured: repo.gates,
        ...(w.order.gates ? { scope: expandGateRefs(repo, w.order.gates) } : {}),
      });
    });
    if (problems.length)
      throw new HarnessError(
        'INVALID_INPUT',
        'Договор проверки поручений не согласован: ' + problems.join('; '),
      );
    return { graph, last };
  }

  /**
   * Записать согласование графа по проверенному раунду (`approvalCheck`):
   * digest, политика, при `bindContext` — снимок контекста раунда; черновые
   * поручения становятся готовыми. Повтор того же согласования ничего не
   * меняет. Только внутри транзакции после `approvalCheck`.
   */
  activateApproval(
    tx: ExecutionTransaction,
    graph: GraphState,
    last: ReviewRecord,
    actor: TechnicalApproval['actor'],
    options: { bindContext?: boolean; reapproval?: { by: string; reason: string } } = {},
  ) {
    const graphId = graph.id;
    const policy = executionDigest(this.policy);
    const context = options.bindContext ? { digest: last.contextDigest ?? null } : undefined;
    if (
      graph.approval?.digest === graph.digest &&
      graph.policyDigest === policy &&
      graph.approval.context?.digest === context?.digest
    )
      return { graph, changed: false };
    const at = iso(this.now());
    const approval: TechnicalApproval = {
      actor,
      digest: graph.digest,
      authorRuntime: last.authorRuntime === 'external' ? undefined : last.authorRuntime,
      reviewerRuntime: last.reviewerRuntime,
      artifact: last.artifact,
      ...(context ? { context } : {}),
    };
    const reapproval =
      options.reapproval && graph.policyDigest !== policy
        ? {
            ...options.reapproval,
            round: last.round,
            previousPolicyDigest: graph.policyDigest,
          }
        : undefined;
    tx.putGraph({
      ...graph,
      policyDigest: policy,
      approval: { ...approval, ...(reapproval ? { reapproval } : {}), at },
    });
    tx.emit({
      type: 'graph.approved',
      graphId,
      payload: {
        digest: graph.digest,
        actor,
        ...(reapproval ? { reapproval: { ...reapproval, policyDigest: policy } } : {}),
      },
    });
    for (const work of tx.works(graphId)) {
      if (work.status !== 'draft') continue;
      const ready: WorkState = structuredClone({
        ...work,
        status: 'ready' as const,
        approvedAt: at,
        approvedDigest: this.host.basis.orderDigest(work, tx),
        approvedScope: this.host.basis.scopeDigest(work, tx),
        approval,
      });
      if (closeIfBasisChanged(ready, at, this.episodeOf(ready, tx)))
        this.recoveryEvent(tx, ready, ready.recoveryHistory!.at(-1)!);
      tx.putWork(ready);
      tx.emit({
        type: 'work.ready',
        graphId,
        workId: work.id,
        payload: { orderDigest: ready.approvedDigest! },
      });
    }
    return { graph: tx.graph(graphId)!, changed: true };
  }

  /* ---------------------------------------------------------------- */
  /* Controller и очередь                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Роль принадлежит этому процессу: тот же владелец и та же версия движка
   * (роль прежней версии под тем же именем держит другой процесс); живая,
   * если не `expired`.
   */
  private mine(lease: ControllerLease | undefined, owner: string | undefined, expired = false) {
    return (
      !!lease &&
      lease.owner === owner &&
      lease.engineVersion === this.version &&
      (expired || lease.leaseUntil > this.now())
    );
  }

  /**
   * Роль controller для операции вне run (`harness update`): захват или
   * продление без записи политики; пока роль жива, `harness run` не
   * становится controller и не пишет состояние.
   */
  holdController(owner: string, takeOver?: (lease: ControllerLease) => boolean): boolean {
    return this.tx('heartbeat', (tx) => {
      const lease = tx.controller();
      const live = !!lease && lease.leaseUntil > this.now();
      // Роль умершего процесса той же операции (`takeOver`) переходит сразу.
      if (
        live &&
        (lease.owner !== owner || lease.engineVersion !== this.version) &&
        !takeOver?.(lease)
      )
        return false;
      tx.setController({
        owner,
        leaseUntil: this.now() + this.policy.leaseMs,
        engineVersion: this.version,
      });
      return true;
    });
  }

  /**
   * Пауза обновления пакетов, чей процесс умер до изменений (например, во
   * время `--wait`): замок обновления называет процесс, которого больше нет,
   * и незавершённого возврата (`in-progress.json`) нет (`updaterGone`). Такая
   * пауза не держит `run`, регистрацию и совместную проверку; `run` её
   * снимает. Нет замка или он живой — пауза держит.
   */
  staleUpdatePause(view: ExecutionView): { pid: number } | undefined {
    const control = view.control();
    if (
      !control.paused ||
      control.pauseReason !== 'reconfigure' ||
      control.pauseOperation !== UPDATE_PAUSE_OPERATION ||
      this.updateBusy()
    )
      return undefined;
    return this.updaterGone();
  }

  /** Снять устаревшую паузу обновления (`staleUpdatePause`); true — снята. */
  clearStaleUpdatePause(): boolean {
    return this.tx('scheduler.started', (tx) => {
      if (!this.staleUpdatePause(tx)) return false;
      const control = tx.control();
      tx.setControl({
        ...control,
        paused: false,
        pauseReason: undefined,
        pauseOperation: undefined,
        pausedAt: undefined,
      });
      tx.emit({ type: 'control.resumed', payload: { reason: 'reconfigure' } });
      return true;
    });
  }

  /**
   * Идёт обновление пакетов (`harness update`): роль controller у живого
   * `harness-update:<pid>`, пауза его операции (обновление идёт или
   * прервалось с незавершённым возвратом) или замок и запись «идёт» каталога
   * обновлений. Регистрация графа, согласование, совместная проверка и записи
   * библиотеки (ответы, перенос, находки ревью, повтор) в это время отказывают
   * `CONTROLLER_BUSY`: они писали бы состояние посреди установки, и возврат
   * копии их бы потерял.
   */
  private assertNoUpdate(view: ExecutionView) {
    const lease = view.controller();
    const control = view.control();
    const updater = lease && /^harness-update:(\d+)$/.exec(lease.owner);
    const busy =
      this.updateBusy() ??
      (lease &&
      lease.leaseUntil > this.now() &&
      updater &&
      !processGone({ pid: Number(updater[1]) })
        ? `идёт harness update (процесс ${updater[1]})`
        : undefined) ??
      (control.paused &&
      control.pauseReason === 'reconfigure' &&
      control.pauseOperation === UPDATE_PAUSE_OPERATION &&
      !this.staleUpdatePause(view)
        ? 'идёт harness update'
        : undefined);
    if (busy)
      throw new HarnessError(
        'CONTROLLER_BUSY',
        `Идёт обновление harness (${busy}): дождитесь его окончания; если обновление прервалось — harness update --check или resume`,
      );
  }

  /** Проверка `assertNoUpdate` вне транзакции: перед долгими шагами библиотеки (вызов модели). */
  assertNotUpdating() {
    this.read((v) => this.assertNoUpdate(v));
  }

  /** Захват или продление роли единственного controller. */
  lead(owner: string): boolean {
    let acquired = false;
    const result = this.tx('heartbeat', (tx) => {
      const lease = tx.controller();
      const live = !!lease && lease.leaseUntil > this.now();
      if (live && lease.owner !== owner) return false;
      // Живая роль другой версии движка — другой процесс, даже под тем же
      // именем владельца: роль переходит только после истечения срока.
      if (live && lease.engineVersion !== this.version) return false;
      acquired = !live || lease.owner !== owner;
      tx.setController({
        owner,
        leaseUntil: this.now() + this.policy.leaseMs,
        engineVersion: this.version,
      });
      return true;
    });
    if (result) this.ownLeader = owner;
    if (result && acquired) {
      this.tx('scheduler.started', (tx) =>
        tx.emit({ type: 'controller.acquired', payload: { owner } }),
      );
      if (this.recordOnLead) this.recordPolicy(owner);
    }
    return result;
  }

  release(owner: string) {
    return this.tx('scheduler.released', (tx) => {
      // Роль прежней версии под тем же именем держит другой процесс.
      if (!this.mine(tx.controller(), owner, true)) return false;
      tx.setController(undefined);
      tx.emit({ type: 'controller.released', payload: { owner } });
      return true;
    });
  }

  /**
   * Пауза оператора или штатной остановки: новые claims запрещены (семантика
   * DevContour `pause`). Штатная остановка поверх существующей паузы её не
   * подменяет, кроме паузы операции reconfigure. Пауза оператора — решение
   * человека: она заменяет любую паузу, и классы отказов прежней паузы с ней
   * не переживают.
   */
  pause(reason: 'operator' | 'shutdown') {
    return this.tx('scheduler.paused', (tx) => {
      const control = tx.control();
      if (control.paused && reason === 'shutdown' && control.pauseReason !== 'reconfigure')
        return { control, changed: false };
      // Пауза обновления пакетов (`harness update`) штатной остановкой не подменяется:
      // иначе следующий run снял бы её посреди установки.
      if (
        control.paused &&
        reason === 'shutdown' &&
        control.pauseReason === 'reconfigure' &&
        control.pauseOperation === UPDATE_PAUSE_OPERATION
      )
        return { control, changed: false };
      // Повторная пауза человека — его новое решение: время паузы обновляется.
      // Хост сравнивает его с началом своей работы (пауза до старта снимается
      // циклом, после — нет), и сохранённое прежнее время выдало бы свежее
      // решение за давнее.
      const next = {
        ...control,
        paused: true,
        pauseReason: reason,
        pausedAt: iso(this.now()),
        pauseOperation: undefined,
        pauseFailures: undefined,
      };
      tx.setControl(next);
      tx.emit({ type: 'control.paused', payload: { reason } });
      return { control: next, changed: true };
    });
  }

  /**
   * Снять паузу — решение человека (семантика DevContour `pause(false)`):
   * снимает паузу оператора, штатной остановки и отказа runtime вместе с её
   * классами отказов. Паузу операции reconfigure снимает только сама
   * операция: `PAUSED`. Это и явный маршрут человека «подтвердить базу и
   * начать»: `resume` снимает ожидания `base-check`. Других путей снять их у
   * движка нет — пока такое ожидание есть, `claim` не выдаёт работу при
   * любом значении `paused`.
   */
  resume() {
    return this.tx('scheduler.started', (tx) => {
      const control = tx.control();
      if (!control.paused) return { control, changed: false };
      // Паузу обновления пакетов человек снять может (обновление прервалось);
      // пока обновление идёт, run всё равно не начнётся: роль controller у него.
      if (
        control.pauseReason === 'reconfigure' &&
        control.pauseOperation !== UPDATE_PAUSE_OPERATION
      )
        throw new HarnessError(
          'PAUSED',
          'Выдачу держит операция применения политики; её снимает сама операция',
        );
      const reason = control.pauseReason ?? 'operator';
      const next = {
        ...control,
        paused: false,
        pauseReason: undefined,
        pausedAt: undefined,
        pauseOperation: undefined,
        pauseFailures: undefined,
        waits: control.waits?.filter((w) => w.kind !== 'base-check'),
      };
      if (!next.waits?.length) delete next.waits;
      tx.setControl(next);
      tx.emit({ type: 'control.resumed', payload: { reason } });
      return { control: next, changed: true };
    });
  }

  /**
   * Снять паузу отказа после устранения причины: только названные классы.
   * Пока есть ожидание `base-check`, пауза остаётся и переходит в паузу
   * `base-check`: устранённый отказ не подтверждает перенесённую базу (это
   * делает человек через `resume`), а пауза `runtime` без классов отказа
   * звала бы чинить окружение. Новая причина — новая пауза: `pausedAt` —
   * время перехода (как у перехода хоста DevContour).
   */
  clearFailure(kinds: FailureKind[]) {
    return this.tx('scheduler.started', (tx) => {
      const control = tx.control();
      const left = (control.pauseFailures ?? []).filter((k) => !kinds.includes(k));
      if (left.length === (control.pauseFailures ?? []).length) return control;
      const cleared = !left.length && control.pauseReason === 'runtime';
      const waits = cleared && awaitsBaseCheck(control);
      const next = {
        ...control,
        pauseFailures: left.length ? left : undefined,
        ...(cleared
          ? waits
            ? { pauseReason: 'base-check' as const, pausedAt: iso(this.now()) }
            : { paused: false, pauseReason: undefined, pausedAt: undefined }
          : {}),
      };
      tx.setControl(next);
      if (waits) tx.emit({ type: 'control.paused', payload: { reason: 'base-check' } });
      else if (cleared) tx.emit({ type: 'control.resumed', payload: { reason: 'runtime' } });
      return next;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Бюджеты и учёт вызовов                                            */
  /* ---------------------------------------------------------------- */

  /** Правила и области бюджетов: политика движка и группы хоста. */
  budgetContext(): BudgetContext {
    return { policy: this.policy, scopes: this.host.budgets };
  }

  /**
   * Бюджетное удержание готовых поручений. Бюджеты считаются по сохранённым
   * записям вызовов: сброс попыток и перезапуск их не уменьшают. Удержанное
   * поручение несёт причину, пока бюджет не позволит снова; выключенные
   * бюджеты удержание снимают.
   */
  private budgetBlocks(tx: ExecutionTransaction) {
    const ready = tx.works().filter((w) => w.status === 'ready');
    if (!this.policy.budgets) {
      for (const w of ready) if (w.budgetBlock) tx.putWork({ ...w, budgetBlock: undefined });
      return;
    }
    if (!ready.length) return;
    const c = this.budgetContext();
    // Записи вызовов, попытки без учёта вызовов и поручения прежних записей —
    // один раз на выдачу (и между выдачами, пока данные те же). Статусы — по
    // поручению на свой момент, как у `workBudgets`: ответ тот же. Общий
    // бюджет и бюджеты групп пересчитываются, только когда момент сменился.
    // Идущий вызов меряется ещё и монотонными часами и живостью владельца —
    // помимо момента: с ним статусы считаются заново для каждого поручения.
    const usage = this.usageOf(tx);
    const live = usage.records.some((r) => r.outcome === 'active');
    let moment: { at: number; of: (workId: string) => BudgetStatus[] } | undefined;
    for (const w of ready) {
      const at = Date.now();
      if (live || moment?.at !== at)
        moment = { at, of: workBudgetsOf(c, tx, usage.records, at, usage) };
      const blocking = blockingBudget(c, moment.of(w.id));
      if (!blocking) {
        if (w.budgetBlock) tx.putWork({ ...w, budgetBlock: undefined });
        continue;
      }
      if (w.budgetBlock?.reason === blocking.reason) continue;
      tx.putWork({ ...w, budgetBlock: { reason: blocking.reason!, at: iso(this.now()) } });
      tx.emit({
        type: 'budget.blocked',
        graphId: w.graphId,
        workId: w.id,
        payload: {
          scope: blocking.scope.kind,
          ...(blocking.scope.id ? { scopeId: blocking.scope.id } : {}),
          state: blocking.state as 'exceeded' | 'undetermined',
          reason: blocking.reason!.slice(0, 4000),
        },
      });
    }
  }

  /**
   * Записи вызовов и попытки без учёта вызовов — по версии данных хранилища.
   * Пока версия та же, история не перечитывается: такт выдачи на простое
   * иначе разбирал бы все прежние попытки и записи вызовов. Кэш берётся и
   * пополняется только в нетронутой внешней транзакции (`pristine`): её
   * данные — ровно зафиксированные при этой `dataVersion`. Во вложенной или
   * уже писавшей транзакции (её записи могут быть не зафиксированы или
   * откатиться) и у хранилища без `dataVersion`/`pristine` — заново каждый
   * раз. Ключ — хранилище и версия: версии разных хранилищ несравнимы.
   * Значения только для чтения.
   */
  private usageMemo?: {
    store: ExecutionStore;
    version: number;
    records: CallRecord[];
    uncovered: AttemptState[];
    workOf: RecordWork;
  };
  private usageOf(tx: ExecutionView) {
    const store = this.host.store;
    const version = tx.pristine?.() ? tx.dataVersion?.() : undefined;
    const memo = this.usageMemo;
    if (version !== undefined && memo?.store === store && memo.version === version) return memo;
    const records = callRecords(tx);
    // Поручения прежних записей (по попытке) — сразу: кэш переживает этот
    // вид, и вопрос к закрытой транзакции позже был бы ошибкой.
    const lookup = recordWorkOf(tx);
    const works = new Map(
      records.filter((r) => r.workId === undefined).map((r) => [r, lookup(r)] as const),
    );
    const usage = {
      store,
      version: version ?? -1,
      records,
      uncovered: uncoveredAttempts(tx, records),
      workOf: (r: CallRecord) => r.workId ?? works.get(r),
    };
    if (version !== undefined) this.usageMemo = usage;
    return usage;
  }

  /**
   * Начало вызова модели: атрибуция на момент вызова и проверка бюджетов — в
   * одной транзакции с регистрацией идущего вызова. Превышенный или
   * неопределённый бюджет — отказ `budget` до вызова, без записи; два процесса
   * не проходят проверку оба, не видя друг друга. Процесс не с применённой
   * политикой — отказ `APPROVAL_STALE` до вызова.
   */
  beginCall(record: CallRecord, meta: CallMeta): CallRecord {
    return this.tx('usage.recorded', (tx) => {
      // Барьер применённой политики — на границе каждого нового вызова, в той
      // же транзакции: процесс, чью политику сменили (например, понизили
      // бюджет), не начинает вызовов по прежним пределам. Идущий вызов
      // завершается, но разрешением нового он не служит.
      const stale = this.staleReason(tx);
      if (stale) throw new HarnessError('APPROVAL_STALE', stale);
      const c = this.budgetContext();
      const started = { ...record, ...callAttribution(c, tx, meta) };
      if (this.policy.budgets) assertBudget(c, callBudgets(c, tx, meta, callRecords(tx)));
      tx.putLocal('usage', callOwner(started), started.id, started);
      return started;
    });
  }

  /** Ход или итог вызова: запись заменяется целиком. */
  saveCall(record: CallRecord) {
    this.tx('usage.recorded', (tx) => tx.putLocal('usage', callOwner(record), record.id, record));
  }

  /**
   * Закрывает записи вызовов, чей процесс умер, исходом `abandoned`. Запись
   * без процесса закрывается, когда её попытка уже не активна, а без попытки —
   * спустя два предела времени вызова. Под транзакцией запись перечитывается:
   * вызов мог завершиться между сканированием и закрытием, и его исход и
   * стоимость не затираются устаревшим снимком.
   */
  abandonCalls(at = Date.now()): string[] {
    const dead = (r: CallRecord, view: ExecutionView) =>
      r.outcome === 'active' &&
      (r.process
        ? ownerGone(r)
        : r.runId
          ? view.attempt(r.runId)?.status !== 'active'
          : at - Date.parse(r.startedAt) > 2 * this.policy.runTimeoutMs);
    const candidates = this.read((v) => callRecords(v).filter((r) => dead(r, v)));
    if (!candidates.length) return [];
    return this.tx('usage.recorded', (tx) => {
      const closedIds: string[] = [];
      for (const seen of candidates) {
        const r = tx.local('usage', callOwner(seen), seen.id);
        if (!r || !dead(r, tx)) continue;
        // Время прерванного вызова фиксируется монотонно (часы ОС, сохранённый
        // замер), пока запись ещё идущая; измерить нельзя — время неизвестно,
        // а не берётся по системным часам, которые могли откатиться.
        const elapsed = callDurationMs(r, at);
        tx.putLocal('usage', callOwner(r), r.id, {
          ...r,
          ...(elapsed !== null ? { durationMs: elapsed } : { durationUnknown: true as const }),
          outcome: 'abandoned',
          abandonedAt: iso(at),
        });
        closedIds.push(r.id);
      }
      return closedIds;
    });
  }

  /**
   * Закрепляет атрибуцию прежних записей вызовов (без закреплённых поручения и
   * группы) по текущему составу — до того, как новая редакция графа его
   * изменит: иначе перенос поручения снял бы или разделил учтённый расход
   * группы. Уже закреплённое не меняется; запись перечитывается под
   * транзакцией.
   */
  pinLegacyCalls(): number {
    const unpinned = (r: CallRecord) => !r.workIds && (!r.workId || !r.groupId);
    const legacy = this.read((v) => callRecords(v).filter(unpinned));
    if (!legacy.length) return 0;
    return this.tx('usage.recorded', (tx) => {
      let pinned = 0;
      for (const seen of legacy) {
        const r = tx.local('usage', callOwner(seen), seen.id);
        if (!r || !unpinned(r)) continue;
        const found = this.host.budgets.legacy(r, tx);
        if (!(r.groupId ?? found.groupId)) continue;
        const next: CallRecord = { ...r, groupId: r.groupId ?? found.groupId };
        // Прежний вызов о группе остаётся расходом её участников, даже если
        // хост по совпавшему ID назвал его вызовом поручения.
        const workId = r.workId ?? (legacyGroupCall(r) ? undefined : found.workId);
        if (workId) next.workId = workId;
        if (!next.workId && found.workIds) next.workIds = found.workIds;
        if (!next.workId && !next.workIds) continue;
        tx.putLocal('usage', callOwner(next), next.id, next);
        pinned++;
      }
      return pinned;
    });
  }

  /** Обзор бюджетов для статуса; `undefined` — бюджеты не заданы. */
  budgets() {
    return this.read((v) => budgetOverview(this.budgetContext(), v));
  }

  /**
   * Причина, по которой бюджет не даст выдать поручение при следующем claim, —
   * тот же расчёт, которым claim ставит `budgetBlock` (и до того, как поле
   * записано). Только чтение; бюджеты выключены — `undefined`. `records` —
   * записи вызовов, уже прочитанные в этом виде (диагноз многих работ читает
   * их один раз).
   */
  budgetBlockOf(workId: string, view: ExecutionView, records?: CallRecord[]) {
    if (!this.policy.budgets) return undefined;
    const c = this.budgetContext();
    return blockingBudget(c, workBudgets(c, view, workId, records ?? callRecords(view)))?.reason;
  }

  /**
   * Внутреннее (диагноз `stopInputsOf`); хосту — `budgetBlocksOf`.
   * `budgetBlockOf` для многих работ одного вида на один момент (`at` —
   * время создания проверки): записи вызовов, общий бюджет, бюджеты групп и
   * попытки без учёта вызовов считаются один раз. Ответ по работе — тот же,
   * что у `budgetBlockOf` в тот момент; проверка действует только в пределах
   * этого вида (одного чтения) и не переживает его.
   */
  budgetBlockers(view: ExecutionView): (workId: string) => string | undefined {
    if (!this.policy.budgets) return () => undefined;
    const c = this.budgetContext();
    const statuses = workBudgetsOf(c, view);
    return (workId) => blockingBudget(c, statuses(workId))?.reason;
  }

  /**
   * Бюджетные блоки набора работ за одно чтение (без `workIds` — всех работ
   * вида): по каждой работе — то же, что `budgetBlockOf(workId, view)` на
   * момент вызова, `undefined` — не держит. Общее (записи вызовов, общий
   * бюджет, бюджеты групп, попытки без учёта вызовов) считается один раз.
   */
  budgetBlocksOf(
    workIds: readonly string[] | undefined,
    view: ExecutionView,
  ): Map<string, string | undefined> {
    const ids = workIds ?? view.works().map((w) => w.id);
    const blockOf = this.budgetBlockers(view);
    return new Map(ids.map((id) => [id, blockOf(id)]));
  }

  /**
   * Внутреннее (диагноз `stopInputsOf`): проверка действует только внутри
   * чтения своего вида. Первая причина `APPROVAL_STALE` из `blockers` — без
   * остальных проверок
   * выдачи (бюджет, вопросы, предпосылки, контракт). Порядок причин тот же:
   * процесс не с применённой политикой, политика после согласования графа,
   * постановка готовой работы после согласования, отказ хоста. Возвращает
   * проверку для многих работ одного вида: общее для них (применённая
   * политика, согласование графа) считается один раз.
   */
  approvalStaleness(view: ExecutionView): (work: WorkState) => string | undefined {
    let process: { reason: string | undefined } | undefined;
    let policy: string | undefined;
    const graphs = new Map<string, boolean>();
    return (work) => {
      process ??= { reason: this.staleReason(view) };
      if (process.reason) return process.reason;
      if (!graphs.has(work.graphId)) {
        const graph = view.graph(work.graphId);
        graphs.set(
          work.graphId,
          Boolean(graph?.approval) &&
            graph!.policyDigest !== (policy ??= executionDigest(this.policy)),
        );
      }
      if (graphs.get(work.graphId))
        return 'Политика изменилась после согласования; согласуйте заново: harness reapprove --by --reason (прежний раунд review-plan, с записью), а после правки изоляции, сети или профилей инструментов — новый review-plan';
      if (
        work.status === 'ready' &&
        work.approvedDigest !== this.host.basis.orderDigest(work, view)
      )
        return 'Постановка изменилась после согласования';
      const refusal = this.host.guards.claimable(work, view);
      return refusal?.code === 'APPROVAL_STALE' ? refusal.message : undefined;
    };
  }

  /**
   * Работу выдаст `claim` (условия самой работы, без глобальных: пауза,
   * барьер хоста, проверка базы, применение политики, совместная проверка,
   * предел параллельности — `claimBlockedGlobally`). Одна проверка для
   * `claim` и для строки очереди `status` (`runner.ready`). `fresh` —
   * чтение вне транзакции claim: записанный `budgetBlock` может отставать,
   * бюджет считается заново (`budgetBlockOf`, или `budgetBlock` — общий
   * расчёт для многих работ, `Engine.budgetBlockers`), записанный блок не
   * читается, а устаревшая постановка или область — не готова (claim на ней
   * откажет).
   */
  claimableWork(
    w: WorkState,
    view: ExecutionView,
    options: {
      gateHolds?: ReturnType<Engine['environmentGateHolds']>;
      infraPending?: (w: WorkState) => string[];
      fresh?: boolean;
      budgetBlock?: (workId: string) => string | undefined;
    } = {},
  ): boolean {
    if (w.status !== 'ready' || w.hold) return false;
    if (
      options.fresh
        ? (options.budgetBlock ?? ((id: string) => this.budgetBlockOf(id, view)))(w.id)
        : w.budgetBlock
    )
      return false;
    // Gate удержан отказом без повтора (ps в песочнице): тот же gate
    // откажет снова — ход ведущего, а не новая попытка.
    if (this.gateHoldsOf(w, options.gateHolds ?? this.environmentGateHolds(view)).length)
      return false;
    // Два содержательных отказа по одному свойству: третья выдача — только
    // после разбора. Принятие корпуса, ждущее оператора, удерживает выдачу.
    if (blocksClaim(w) || this.awaitsOperator(w, view)) return false;
    if (w.attempt >= this.policy.maxAttempts) return false;
    // После `recovery.diagnoseAfter` засчитанных отказов — только после
    // разбора ведущего; `split` ждёт перепланирования, противоречие — человека.
    if (this.leadHoldOf(w, view)) return false;
    if (neutralExhausted(w)) return false;
    // Вопрос без применённого ответа: новая редакция графа и согласование
    // делают поручение готовым, но выдачи нет до applyInput.
    if (blockingRequest(view, w)) return false;
    const graph = view.graph(w.graphId);
    // Согласование привязано к graph digest и к политике, под которой оно дано.
    if (!graph?.approval || graph.approval.digest !== graph.digest) return false;
    if (graph.policyDigest !== executionDigest(this.policy)) return false;
    const external = new Set(graph.graph.prerequisites.map((p) => p.id));
    if (!w.order.dependsOn.every((d) => external.has(d) || view.work(d)?.status === 'done'))
      return false;
    // Инфраструктура раньше продукта и между графами: открытая работа
    // инфраструктуры прежнего графа держит продуктовые работы своих репозиториев.
    if ((options.infraPending ?? infraPendingIndex(view))(w).length) return false;
    // Контракты поручения согласованы ревью своего digest при текущем назначении reviewer.
    if (this.contractBlocker(w, view)) return false;
    // Недопустимое назначение reviewer держит только это поручение.
    if (this.reviewerBlocker(w)) return false;
    if (options.fresh) {
      if (w.approvedDigest !== this.host.basis.orderDigest(w, view)) return false;
      if (w.approvedScope && w.approvedScope !== this.host.basis.scopeDigest(w, view)) return false;
      if (this.host.guards.current(w, undefined, view)) return false;
    }
    return !this.host.guards.claimable(w, view);
  }

  /**
   * Глобальные препятствия выдачи, кроме паузы (её снятие run решает
   * `nextRunControl`): барьер хоста, неподтверждённая база, применение
   * политики, идущая совместная проверка. Неприменённая политика процесса —
   * свойство процесса claim, а не состояния: её здесь нет.
   */
  claimBlockedGlobally(view: ExecutionView): boolean {
    return (
      Boolean(this.host.guards.claimBarrier(view)) ||
      awaitsBaseCheck(view.control()) ||
      Boolean(this.reconfiguring(view)) ||
      Boolean(this.liveJoint(view))
    );
  }

  /** Почему поручение сейчас не выдаётся; пусто — может быть выдано. */
  blockers(work: WorkState, view: ExecutionView) {
    const out: {
      code:
        | 'NOT_READY'
        | 'PAUSED'
        | 'ATTEMPTS_EXHAUSTED'
        | 'DIAGNOSIS_REQUIRED'
        | 'ENVIRONMENT_GATE_HELD'
        | 'APPROVAL_STALE'
        | 'APPROVAL_REQUIRED'
        | 'BUDGET_EXHAUSTED'
        | 'REVIEWER_SAME_VENDOR'
        | 'REVIEWER_MISSING'
        | 'INVALID_INPUT'
        | 'INPUT_REQUIRED';
      message: string;
    }[] = [];
    if (view.control().paused)
      out.push({
        code: 'PAUSED',
        message: 'Очередь на паузе: ' + (view.control().pauseReason ?? 'operator'),
      });
    else if (awaitsBaseCheck(view.control()))
      out.push({ code: 'PAUSED', message: 'Очередь ждёт подтверждения перенесённой базы' });
    const reconfigure = this.reconfiguring(view);
    if (reconfigure)
      out.push({
        code: 'PAUSED',
        message: `Операция ${reconfigure.operation} применяет политику`,
      });
    const stale = this.staleReason(view);
    if (stale) out.push({ code: 'APPROVAL_STALE', message: stale });
    if (this.liveJoint(view))
      out.push({ code: 'NOT_READY', message: 'Идёт совместная проверка репозиториев' });
    if (work.status === 'draft')
      out.push({ code: 'APPROVAL_REQUIRED', message: 'Граф не согласован' });
    const graph = view.graph(work.graphId);
    if (graph?.approval && graph.policyDigest !== executionDigest(this.policy))
      out.push({
        code: 'APPROVAL_STALE',
        message:
          'Политика изменилась после согласования; согласуйте заново: harness reapprove --by --reason (прежний раунд review-plan, с записью), а после правки изоляции, сети или профилей инструментов — новый review-plan',
      });
    else if (work.status !== 'ready')
      out.push({ code: 'NOT_READY', message: 'Статус ' + work.status });
    for (const dep of work.order.dependsOn) {
      const d = view.work(dep);
      const external = view.graph(work.graphId)?.graph.prerequisites.some((p) => p.id === dep);
      if (!external && d?.status !== 'done')
        out.push({ code: 'NOT_READY', message: 'Ждёт ' + dep });
    }
    if (work.attempt >= this.policy.maxAttempts)
      out.push({
        code: 'ATTEMPTS_EXHAUSTED',
        message:
          `Исчерпано ${work.attempt} из ${ruCount(this.policy.maxAttempts, RU.attemptGen)}` +
          (work.rework?.resumed
            ? `; доработка ${work.rework.revision} продолжает оставленную доработку той же постановки: попытки перенесены с неё`
            : work.rework && !work.rework.fresh
              ? `; доработка ${work.rework.revision} после приёмки без своего предела: своих пределов у доработок не больше ${MAX_REWORK_BUDGETS}, попытки перенесены с прежней редакции`
              : ''),
      });
    if (work.hold)
      out.push({ code: 'NOT_READY', message: 'Удержано операцией ' + work.hold.operation });
    const infra = infraPendingIndex(view)(work);
    if (infra.length)
      out.push({
        code: 'NOT_READY',
        message: `Ждёт работы инфраструктуры прежнего графа: ${infra.join(', ')}`,
      });
    // Вопрос исполнителя без применённого ответа держит поручение сам по себе.
    const question = blockingRequest(view, work);
    if (question)
      out.push({
        code: 'INPUT_REQUIRED',
        message:
          question.lifecycle === 'pending'
            ? `Ждёт ответа на вопрос исполнителя ${question.id}`
            : question.lifecycle === 'superseded'
              ? `Перенесённый ответ на вопрос ${question.id} устарел до выдачи: нужен новый перенос (harness input-carry)`
              : `Ответ на вопрос ${question.id} записан, но не применён (harness input-resolve)`,
      });
    // Записанный budgetBlock — кэш расчёта claim: готовую работу держит текущий расчёт.
    const budget = work.status === 'ready' ? this.budgetBlockOf(work.id, view) : undefined;
    if (budget) out.push({ code: 'BUDGET_EXHAUSTED', message: budget });
    if (blocksClaim(work))
      out.push({
        code: 'NOT_READY',
        message: `Разбор свойства ${work.recovery!.property}: ${work.recovery!.reason ?? work.recovery!.status}`,
      });
    const hold = this.leadHoldOf(work, view);
    if (hold) out.push(leadHoldBlocker(hold));
    for (const h of this.gateHoldsOf(work, this.environmentGateHolds(view))) {
      const holder = view.work(h.workId);
      out.push({
        code: 'ENVIRONMENT_GATE_HELD',
        message: gateHoldLine(h, work.id, holder ? this.retryRouteOf(holder, view) : undefined).ru,
      });
    }
    if (this.awaitsOperator(work, view))
      out.push({
        code: 'APPROVAL_REQUIRED',
        message: 'Принятие версии корпуса ждёт подтверждения оператора',
      });
    if (work.status === 'ready' && work.approvedDigest !== this.host.basis.orderDigest(work, view))
      out.push({ code: 'APPROVAL_STALE', message: 'Постановка изменилась после согласования' });
    const contract = this.contractBlocker(work, view);
    if (contract) out.push({ code: 'APPROVAL_REQUIRED', message: contract });
    const reviewer = this.reviewerBlocker(work);
    if (reviewer) out.push(reviewer);
    const refusal = this.host.guards.claimable(work, view);
    if (refusal) out.push(refusal);
    return out;
  }

  /**
   * Назначение ревью кода для роли поручения недопустимо политикой (reviewer
   * того же вендора без явного разрешения, нет reviewer или роли). Такое
   * поручение не выдаётся и видно блокером; остальная очередь идёт дальше.
   */
  private reviewerBlocker(work: WorkState) {
    const role = roleBinding(this.policy, work.order.role, work.order.repositoryId);
    if (!role)
      return { code: 'INVALID_INPUT' as const, message: 'Роль не объявлена: ' + work.order.role };
    const reviewer = selectReviewer(
      this.policy,
      'code',
      role.writer,
      work.order.role,
      work.order.repositoryId,
    );
    return reviewer.ok ? undefined : { code: reviewer.code, message: reviewer.message };
  }

  /**
   * Выдать следующую готовую работу. Только действующий controller; не на
   * паузе; не сверх `concurrency`; первое готовое поручение в порядке
   * регистрации. Поручение с согласованием, не совпадающим с текущим
   * основанием, — отказ `APPROVAL_STALE`, а не выдача.
   */
  claim(owner: string): AttemptState | undefined {
    return this.tx('run.claimed', (tx) => {
      const lease = tx.controller();
      if (!this.mine(lease, owner))
        throw new HarnessError(
          'CONTROLLER_BUSY',
          'Выдавать попытки может только действующий controller',
        );
      if (tx.control().paused || this.host.guards.claimBarrier(tx)) return undefined;
      // Перенесённая база не подтверждена хостом: снятый мимо `resume` флаг
      // паузы (например, восстановлением отказа) выдачу не открывает.
      if (awaitsBaseCheck(tx.control())) return undefined;
      // Пока операция применяет политику, попытки не выдаются, даже если
      // человек снял паузу: попытка под прежней политикой не нужна.
      if (this.reconfiguring(tx)) return undefined;
      // Процесс с не применённой политикой не выдаёт: условия попытки
      // разошлись бы с применёнными.
      if (this.policyStale(tx)) return undefined;
      // Идущая совместная проверка закрепила комбинацию SHA: новые попытки
      // сдвинули бы target ref под ней.
      if (this.liveJoint(tx)) return undefined;
      const active = activeOf(tx);
      if (active.length >= this.policy.concurrency) return undefined;
      this.budgetBlocks(tx);
      // Применённый ответ, основание которого сменилось до выдачи, не
      // теряется молча: запрос возвращается в `answered` (работа снова ждёт
      // применения и не выдаётся), причина записана.
      for (const ready of tx.works().filter((w) => w.status === 'ready'))
        this.staleTargets(tx, ready);
      for (const ready of tx.works().filter((w) => w.status === 'ready' && w.recovery)) {
        const next = structuredClone(ready);
        if (closeIfBasisChanged(next, iso(this.now()), this.episodeOf(next, tx))) {
          tx.putWork(next);
          this.recoveryEvent(tx, next, next.recoveryHistory!.at(-1)!);
        }
      }
      const gateHolds = this.environmentGateHolds(tx);
      const infraPending = infraPendingIndex(tx);
      const eligible = tx
        .works()
        .filter((w) => this.claimableWork(w, tx, { gateHolds, infraPending }));
      const work = eligible[0];
      if (!work) return undefined;
      if (work.approvedDigest !== this.host.basis.orderDigest(work, tx))
        throw new HarnessError(
          'APPROVAL_STALE',
          `Постановка ${work.id} изменилась после согласования`,
        );
      if (work.approvedScope && work.approvedScope !== this.host.basis.scopeDigest(work, tx))
        throw new HarnessError(
          'APPROVAL_STALE',
          `Область проверок ${work.id} изменилась после согласования`,
        );
      const current = this.host.guards.current(work, undefined, tx);
      if (current) throw new HarnessError(current.code, current.message);
      const role = roleBinding(this.policy, work.order.role, work.order.repositoryId);
      if (!role) throw new HarnessError('INVALID_INPUT', 'Роль не объявлена: ' + work.order.role);
      const reviewer = selectReviewer(
        this.policy,
        'code',
        role.writer,
        work.order.role,
        work.order.repositoryId,
      );
      if (!reviewer.ok) throw new HarnessError(reviewer.code, reviewer.message);
      const repo = this.policy.repositories.find((r) => r.id === work.order.repositoryId);
      if (!repo)
        throw new HarnessError(
          'INVALID_INPUT',
          'Репозиторий не объявлен: ' + work.order.repositoryId,
        );
      const candidates = eligible.map((w) => ({
        taskId: w.id,
        repositoryId: w.order.repositoryId,
        attempt: w.attempt,
      }));
      const at = this.now();
      const ready = work.approvedAt ? this.host.readyAt?.(work, tx) : undefined;
      // Действующий снимок контекста выдачи: runner загружает именно его, и
      // смена согласования после выдачи не подменяет контекст попытки.
      const approvedContext = tx.graph(work.graphId)!.approval?.context;
      const contextPin = this.host.input
        ? this.host.input.contextDigestOf(work, tx)
        : approvedContext
          ? approvedContext.digest
          : undefined;
      const attempt: AttemptState = {
        id: this.id(),
        workId: work.id,
        repositoryId: work.order.repositoryId,
        attempt: work.attempt + 1,
        token: this.id() + this.id(),
        owner,
        runtime: role.writer.runtime,
        reviewer: reviewer.reviewer.runtime,
        ...(role.writer.model ? { model: role.writer.model } : {}),
        ...(reviewer.reviewer.model ? { reviewerModel: reviewer.reviewer.model } : {}),
        ...(role.writer.effort ? { effort: role.writer.effort } : {}),
        ...(reviewer.reviewer.effort ? { reviewerEffort: reviewer.reviewer.effort } : {}),
        policyDigest: this.host.basis.policyDigest(work, tx),
        status: 'active',
        phase: 'running',
        startedAt: iso(at),
        leaseUntil: at + this.policy.leaseMs,
        requiredGates: [
          ...expandGateRefs(repo, work.order.gates),
          ...(work.order.requirements.length ? [REQUIREMENT_GATE] : []),
        ],
        // Проверки потребителей закрепляются раскрытыми: смена групп
        // потребителя после выдачи не меняет состав, который доказывает попытка.
        ...(work.order.consumers?.length
          ? {
              consumers: work.order.consumers.map((c) => ({
                repositoryId: c.repositoryId,
                gates: expandGateRefs(this.repository(c.repositoryId), c.gates),
              })),
            }
          : {}),
        pinned: {
          graphId: work.graphId,
          graphDigest: tx.graph(work.graphId)!.digest,
          orderDigest: digestOf(work.order),
          targetRef: repo.targetRef,
          source: work.order.source,
          ...(contextPin !== undefined ? { contextDigest: contextPin } : {}),
        },
        // Порог вопросов исполнителя закрепляется при выдаче: смена политики
        // действует со следующей попытки.
        inputPolicy: pinnedInputPolicy(inputPolicyOf(this.policy)),
        dispatch: {
          policy: 'fifo-ready-v1',
          at: iso(at),
          eligible: candidates,
          activeCount: active.length,
          concurrency: this.policy.concurrency,
          inputDigest: digestOf(candidates),
        },
        ...(work.approvedAt
          ? {
              wait: {
                approvedAt: work.approvedAt,
                ...(ready ? { readyAt: ready } : {}),
              },
            }
          : {}),
        engineVersion: this.version,
        ...(this.host.consumerVersion ? { consumerVersion: this.host.consumerVersion } : {}),
        // Версия проверок закрепляется при выдаче: принятие нового корпуса
        // посередине попытки ждёт её окончания, и evidence этой попытки
        // относится к этой версии.
        checks: {
          effective: this.checksOf(work, tx),
          ...(work.checkVersion ? { corpus: work.checkVersion } : {}),
        },
        episodeBasis: this.episodeOf(work, tx),
        callsRecorded: true,
        evidence: [],
      };
      // Ответ на вопрос исполнителя связывается с попыткой, только если
      // применённое основание совпало с основанием выдачи: смена согласования
      // после apply не приписывает старый ответ новой попытке.
      const answered = requestsOf(tx, work)
        .filter((r) => linksAnswer(r) && !r.delivered)
        .at(-1);
      const target = answered?.target;
      // То же правило, что у устаревания (`targetDrift`): ответ связан, пока
      // закреплённый снимок несёт именно его.
      if (
        target &&
        answered &&
        (target.policyDigest === attempt.policyDigest || this.approvalRebound(tx, work)) &&
        !this.targetDrift(tx, work, answered, target)
      )
        attempt.input = {
          requestId: answered.id,
          answerDigest: target.answerDigest,
          targetDigest: target.digest,
        };
      tx.putAttempt(attempt);
      const recovery =
        work.recovery?.status === 'retry'
          ? {
              ...structuredClone(work.recovery),
              // Разрешённый разбором повтор выдан: второй раз он не выдаётся.
              status: 'retrying' as const,
              retryRun: attempt.id,
              version: work.recovery.version + 1,
              history: [
                ...work.recovery.history,
                { at: iso(at), event: 'retry-claimed', detail: attempt.id },
              ],
            }
          : work.recovery;
      tx.putWork({
        ...work,
        status: 'running',
        attempt: attempt.attempt,
        activeRunId: attempt.id,
        failure: undefined,
        ...(recovery ? { recovery } : {}),
      });
      if (recovery && recovery !== work.recovery) this.recoveryEvent(tx, work, recovery);
      tx.emit({
        type: 'attempt.claimed',
        graphId: work.graphId,
        workId: work.id,
        runId: attempt.id,
        attempt: attempt.attempt,
        payload: {
          owner,
          runtime: attempt.runtime,
          reviewer: attempt.reviewer,
          policyDigest: attempt.policyDigest,
          engineVersion: this.version,
        },
      });
      return attempt;
    });
  }

  /**
   * Единственная точка fencing: операция попытки выполняется, только если
   * попытка активна, токен её, срок владения не истёк, она — текущая попытка
   * поручения, политика не сменилась и хост не возражает.
   */
  withAttempt<T>(
    id: string,
    token: string,
    kind: TransactionKind,
    fn: (attempt: AttemptState, work: WorkState, tx: ExecutionTransaction) => NotPromise<T>,
  ): T {
    return this.tx(kind, (tx) => {
      const attempt = tx.attempt(id);
      if (!attempt) throw new HarnessError('NOT_FOUND', 'Попытка не найдена: ' + id);
      const work = tx.work(attempt.workId)!;
      if (
        attempt.status !== 'active' ||
        attempt.token !== token ||
        attempt.leaseUntil <= this.now() ||
        work.activeRunId !== attempt.id
      )
        throw new HarnessError('LEASE_STALE', 'Устаревшая попытка: владение утрачено');
      // Попытку ведёт только движок той версии, что её выдал. Прежняя (или
      // без версии, записанная до неё) не продолжается новой прежним token:
      // только истечение и recovery с новым владением.
      if (attempt.engineVersion !== this.version)
        throw new HarnessError(
          'LEASE_STALE',
          `Попытку выдал движок ${attempt.engineVersion ?? 'прежней версии'}, а работает ${this.version}: продолжение прежним token запрещено, нужна новая попытка`,
        );
      if (attempt.policyDigest !== this.host.basis.policyDigest(work, tx))
        throw new HarnessError('APPROVAL_STALE', 'Политика изменилась; нужна новая попытка');
      const refusal = this.host.guards.current(work, attempt, tx);
      if (refusal) throw new HarnessError(refusal.code, refusal.message);
      return fn(attempt, work, tx);
    });
  }

  /**
   * Когда продление попытки последний раз проверяло политику и guards
   * полностью: token, версия данных и момент проверки (D53).
   */
  private readonly leaseChecks = new Map<
    string,
    { token: string; dataVersion: number; at: number }
  >();

  /**
   * Продление владения попыткой. У хранилища со строками аренды (D53) —
   * условное продление одной строки: документ не читается и не пишется.
   * Политика и guards, которые раньше проверяло каждое продление,
   * проверяются полностью (`withAttempt`), когда сменилась версия данных
   * или с прошлой полной проверки прошёл срок аренды: смена политики или
   * отказ хоста по-прежнему прерывают идущую попытку.
   */
  heartbeat(id: string, token: string) {
    this.tx('heartbeat', (tx) => {
      if (!tx.renewLease || !tx.attemptLease || !tx.dataVersion) {
        this.withAttempt(id, token, 'heartbeat', (a, _w, inner) => {
          inner.putAttempt({ ...a, leaseUntil: this.now() + this.policy.leaseMs });
        });
        return;
      }
      const now = this.now();
      try {
        const lease = tx.attemptLease(id);
        if (!lease || lease.token !== token || lease.leaseUntil <= now)
          throw new HarnessError('LEASE_STALE', 'Устаревшая попытка: владение утрачено');
        if (lease.engineVersion !== this.version)
          throw new HarnessError(
            'LEASE_STALE',
            `Попытку выдал движок ${lease.engineVersion ?? 'прежней версии'}, а работает ${this.version}: продолжение прежним token запрещено, нужна новая попытка`,
          );
        const version = tx.dataVersion();
        const checked = this.leaseChecks.get(id);
        if (
          !checked ||
          checked.token !== token ||
          checked.dataVersion !== version ||
          now - checked.at >= this.policy.leaseMs
        ) {
          // Полная проверка — та же, что у любой операции попытки.
          this.withAttempt(id, token, 'heartbeat', () => undefined);
          this.leaseChecks.set(id, { token, dataVersion: version, at: now });
          if (this.leaseChecks.size > 1000)
            this.leaseChecks.delete(this.leaseChecks.keys().next().value!);
        }
        if (
          !tx.renewLease(
            'attempt',
            id,
            token,
            lease.owner,
            lease.engineVersion,
            now + this.policy.leaseMs,
            now,
          )
        )
          throw new HarnessError('LEASE_STALE', 'Устаревшая попытка: владение утрачено');
      } catch (error) {
        this.leaseChecks.delete(id);
        throw error;
      }
    });
  }

  /** Причина неудавшегося продления: записывается первой и не затирается. Истёкший срок допустим, чужой токен — нет. */
  heartbeatFailed(id: string, token: string, reason: string) {
    return this.tx('run.heartbeat-failed', (tx) => {
      const a = tx.attempt(id);
      if (
        a?.status !== 'active' ||
        a.token !== token ||
        a.engineVersion !== this.version ||
        a.error?.startsWith(HEARTBEAT_FAILED)
      )
        return false;
      tx.putAttempt({ ...a, error: `${HEARTBEAT_FAILED}: ${reason.slice(0, 500)}` });
      return true;
    });
  }

  phase(
    id: string,
    token: string,
    phase: Phase,
    data: Partial<
      Pick<AttemptState, 'baseSha' | 'candidateSha' | 'integrationSha' | 'worktree'>
    > = {},
  ) {
    this.withAttempt(id, token, 'run.phase', (a, w, tx) => {
      tx.putAttempt({ ...a, ...data, phase });
      tx.putWork({ ...w, status: phase });
      tx.emit({
        type: 'attempt.phase',
        workId: w.id,
        runId: id,
        attempt: a.attempt,
        payload: {
          phase,
          ...((data.integrationSha ?? data.candidateSha ?? data.baseSha)
            ? { sha: (data.integrationSha ?? data.candidateSha ?? data.baseSha)! }
            : {}),
        },
      });
    });
  }

  /**
   * Снимок контекста попытки обязан совпасть с закреплённым при выдаче
   * (`pinned.contextDigest`, `null` — без контекста). Попытки без
   * закрепления (прежних версий, хост без связи согласования с контекстом)
   * не проверяются.
   */
  private assertPinnedContext(a: AttemptState, snapshot: string | null) {
    const pinned = a.pinned?.contextDigest;
    if (pinned === undefined || pinned === snapshot) return;
    throw new HarnessError(
      'APPROVAL_STALE',
      `Снимок контекста попытки ${snapshot ?? 'null'} не совпадает с закреплённым при выдаче ${pinned}: загрузчик контекста хоста обязан загружать снимок по attempt.pinned.contextDigest`,
    );
  }

  /** Дополнить попытку сведениями её хода (контекст, ресурсы, замеры) под тем же fencing. */
  update(
    id: string,
    token: string,
    kind: TransactionKind,
    patch: Partial<
      Pick<AttemptState, 'context' | 'contextSnapshot' | 'resources' | 'model' | 'timings'>
    >,
  ) {
    this.withAttempt(id, token, kind, (a, _w, tx) => {
      // Снимок, закреплённый при выдаче, — единственный допустимый: загрузчик
      // хоста, не учитывающий закрепление, отказывает сразу, а не при приёмке.
      if (patch.contextSnapshot !== undefined) this.assertPinnedContext(a, patch.contextSnapshot);
      tx.putAttempt({ ...a, ...patch });
    });
  }

  /** Снимок зависимостей, против которого идёт попытка; закрепляется до реализации. */
  dependencies(id: string, token: string, snapshots: NonNullable<AttemptState['dependencies']>) {
    this.withAttempt(id, token, 'run.dependencies', (a, _w, tx) =>
      tx.putAttempt({ ...a, dependencies: snapshots }),
    );
  }

  /** Свежесть снимка зависимостей на момент окончания: записывается, не отклоняет. */
  dependencyFreshness(
    id: string,
    token: string,
    freshness: NonNullable<AttemptState['dependencyFreshness']>,
  ) {
    this.withAttempt(id, token, 'run.dependency-freshness', (a, _w, tx) =>
      tx.putAttempt({ ...a, dependencyFreshness: freshness }),
    );
  }

  /** Что проверено у потребителя: его голова и снимок всех его зависимостей. */
  consumerChecked(
    id: string,
    token: string,
    repositoryId: string,
    checked: NonNullable<NonNullable<AttemptState['consumers']>[number]['checked']>,
  ) {
    this.withAttempt(id, token, 'run.consumer-checked', (a, _w, tx) => {
      if (!a.consumers?.some((c) => c.repositoryId === repositoryId))
        throw new HarnessError(
          'INVALID_INPUT',
          'Потребитель не объявлен попыткой: ' + repositoryId,
        );
      tx.putAttempt({
        ...a,
        consumers: a.consumers.map((c) =>
          c.repositoryId === repositoryId ? { ...c, checked } : c,
        ),
      });
    });
  }

  /**
   * Gates репозиториев, не пройденные на integration ни одним из принятых
   * поручений: покрытие — по фактическому собственному evidence на принятом
   * SHA попытки под текущим основанием политики, для любой области. Evidence потребителя — проверка другого
   * компонента и не в счёт; запись ревью не закрывает одноимённый test gate.
   * Gate с `when`, признанный где-то неприменимым, решается по объединённому
   * diff набора `changes` (`uncoveredGates` проверки). Решение о приёмке набора
   * поручений — за хостом.
   */
  uncoveredGates(
    workIds: string[],
    changes?: Readonly<Record<string, ChangedPaths>>,
    finalShas?: Readonly<Record<string, string>>,
  ) {
    return this.read((v) => {
      const works = workIds.map((id) => v.work(id)).filter((w): w is WorkState => !!w);
      const repositories = [...new Set(works.map((w) => w.order.repositoryId))].map((id) =>
        this.repository(id),
      );
      return uncoveredGates(
        repositories,
        works.map((w) => ({
          repositoryId: w.order.repositoryId,
          resultSha: w.resultSha,
          // Покрытие — только evidence попытки под текущим основанием
          // политики: тот же ID gate с другой командой или профилем —
          // другая проверка.
          evidence: v
            .attempts(w.id)
            .filter((a) => a.policyDigest === this.host.basis.policyDigest(w, v))
            .flatMap((a) => a.evidence),
        })),
        changes,
        finalShas,
      );
    });
  }

  /**
   * Основания реализации записываются до неё: по ним следующая попытка решит,
   * можно ли взять этого кандидата. В той же транзакции решается, берётся ли
   * кандидат предыдущей попытки вместо новой реализации.
   */
  implementationBasis(id: string, token: string, basis: string) {
    return this.withAttempt(id, token, 'run.implementation-basis', (a, w, tx) => {
      const decision = this.policy.reuseImplementation
        ? reusableImplementation(tx, w, id, basis)
        : ({ reuse: false, reason: 'переиспользование выключено политикой' } as const);
      const reusedFrom = decision.reuse
        ? { runId: decision.from.id, candidateSha: decision.candidateSha }
        : undefined;
      tx.putAttempt({ ...a, implementationBasis: basis, ...(reusedFrom ? { reusedFrom } : {}) });
      return reusedFrom ? { reusedFrom } : { reason: (decision as { reason: string }).reason };
    });
  }

  /** Черновик реализации, оборванной до кандидата (см. `AttemptState.partial`). */
  recordPartial(id: string, token: string, partial: NonNullable<AttemptState['partial']>) {
    this.withAttempt(id, token, 'run.partial', (a, _w, tx) => tx.putAttempt({ ...a, partial }));
  }

  /** Попытка начала с черновика предыдущей (см. `AttemptState.continuedFrom`). */
  continuation(id: string, token: string, from: NonNullable<AttemptState['continuedFrom']>) {
    this.withAttempt(id, token, 'run.continuation', (a, _w, tx) =>
      tx.putAttempt({ ...a, continuedFrom: from }),
    );
  }

  /**
   * Начало стадии попытки; `timingFinished` закрывает её исходом. Замер и
   * событие `attempt.stage` пишутся одной транзакцией под fencing: утративший
   * владение не публикует ни того, ни другого.
   */
  timingStarted(id: string, token: string, stage: string) {
    const timing = { id: this.id(), stage, startedAt: iso(this.now()) };
    this.withAttempt(id, token, 'run.timing.started', (a, w, tx) => {
      tx.putAttempt({ ...a, timings: [...(a.timings ?? []), timing] });
      tx.emit({
        type: 'attempt.stage',
        graphId: w.graphId,
        workId: w.id,
        runId: id,
        attempt: a.attempt,
        payload: {
          timingId: timing.id,
          stage: stage.slice(0, STAGE_NAME_LIMIT),
          phase: 'started',
          at: timing.startedAt,
        },
      });
    });
    return timing.id;
  }

  /**
   * Переход живости попытки по обходу controller: запись `liveness` и событие
   * `attempt.liveness` — одной транзакцией под fencing; утративший владение
   * не публикует ни того, ни другого.
   */
  liveness(
    id: string,
    token: string,
    liveness: NonNullable<AttemptState['liveness']>,
    payload: RunEventPayload<'attempt.liveness'>,
  ) {
    this.withAttempt(id, token, 'run.liveness', (a, w, tx) => {
      tx.putAttempt({ ...a, liveness });
      tx.emit({
        type: 'attempt.liveness',
        graphId: w.graphId,
        workId: w.id,
        runId: id,
        attempt: a.attempt,
        payload,
      });
    });
  }

  timingFinished(
    id: string,
    token: string,
    timingId: string,
    outcome: 'passed' | 'failed',
    /** `unused` — стадия прошла, но её средство не применялось (хранилище без seed). */
    extra: { unused?: true } = {},
  ) {
    this.withAttempt(id, token, 'run.timing.finished', (a, w, tx) => {
      const at = iso(this.now());
      const open = (a.timings ?? []).find((t) => t.id === timingId);
      // Не больше одного `finished` на стадию: закрытый или чужой замер не
      // переписывается, событие не создаётся — запись и журнал согласованы.
      if (!open || open.finishedAt) return;
      tx.putAttempt({
        ...a,
        timings: (a.timings ?? []).map((t) =>
          t.id === timingId
            ? { ...t, finishedAt: at, outcome, ...(extra.unused ? { unused: true as const } : {}) }
            : t,
        ),
      });
      tx.emit({
        type: 'attempt.stage',
        graphId: w.graphId,
        workId: w.id,
        runId: id,
        attempt: a.attempt,
        payload: {
          timingId,
          stage: open.stage.slice(0, STAGE_NAME_LIMIT),
          phase: 'finished',
          at,
          durationMs: Math.max(0, Date.parse(at) - Date.parse(open.startedAt)),
          outcome,
          ...(extra.unused ? { unused: true as const } : {}),
        },
      });
    });
  }

  /**
   * Записать воспроизведения из находок ревью попытки. Одно свойство на одном
   * входе — одна запись поручения: повтор добавляет прогон, а не запись;
   * подтверждение запуском не отменяется последующим неподтверждённым.
   * Реестр ограничен: старые записи вытесняются, а не копятся без предела.
   */
  recordReproductions(
    id: string,
    token: string,
    sha: string,
    items: Omit<ReproductionRecord, 'key' | 'inputHash' | 'runs'>[],
  ) {
    return this.withAttempt(id, token, 'reproduction.recorded', (a, w, tx) => {
      const registry = tx.local('reproductions', WORKSPACE_OWNER, w.id) ?? {
        workId: w.id,
        items: [],
      };
      const list = registry.items.map((x) => structuredClone(x));
      const at = iso(this.now());
      for (const item of items) {
        const inputHash = sha256(item.input);
        const key = digestOf({ workId: w.id, property: item.property, inputHash });
        const run = { runId: a.id, sha, at };
        const existing = list.find((x) => x.key === key);
        if (existing) {
          if (!existing.runs.some((r) => r.runId === a.id)) existing.runs.push(run);
          existing.runs = existing.runs.slice(-200);
          // Подтверждённый запуском — с командой и id этого запуска вместе.
          if (item.observed && !existing.observed) {
            existing.observed = true;
            existing.run = item.run;
            existing.command = item.command;
          }
          existing.claimed ||= item.claimed;
          continue;
        }
        list.push({ ...item, key, inputHash, runs: [run] });
      }
      tx.putLocal('reproductions', WORKSPACE_OWNER, w.id, {
        workId: w.id,
        items: list.slice(-MAX_REPRODUCTIONS),
      });
      return list.length;
    });
  }

  /** Воспроизведения поручения, от старых к новым. */
  reproductions(workId: string): ReproductionRecord[] {
    return this.read((v) => v.local('reproductions', WORKSPACE_OWNER, workId)?.items ?? []);
  }

  evidence(
    id: string,
    token: string,
    evidence: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>,
  ) {
    return this.withAttempt(id, token, 'evidence.recorded', (a, w, tx) => {
      if (evidence.checks !== undefined && evidence.checks !== a.checks?.effective)
        throw new HarnessError('APPROVAL_STALE', 'Evidence другой версии проверок, чем у попытки');
      // Вид записи согласован с gate: ревью — только `independent-review`, и
      // это имя не принадлежит проверке. Иначе запись ревью под именем gate
      // доказывала бы его (и названный testcase).
      if ((evidence.kind === 'review') !== (evidence.gate === 'independent-review'))
        throw new HarnessError(
          'INVALID_INPUT',
          `Evidence вида ${evidence.kind} не может относиться к gate ${evidence.gate}`,
        );
      // Неприменимость (`when.paths`) — только у gate с `when` области
      // попытки, под его текущим определением, без исполнения и не PASS;
      // сведения о ней — только у такой записи.
      if ((evidence.kind === 'not-applicable') !== (evidence.notApplicable !== undefined))
        throw new HarnessError(
          'INVALID_INPUT',
          'Сведения о неприменимости — только у записи вида not-applicable',
        );
      if (evidence.kind === 'not-applicable') {
        const problem =
          evidence.passed ||
          evidence.consumer !== undefined ||
          evidence.recheck !== undefined ||
          evidence.tests !== undefined ||
          evidence.property !== undefined ||
          evidence.artifactFiles !== undefined ||
          !(a.requiredGates ?? []).includes(evidence.gate)
            ? 'запись неприменимости не может быть PASS, исполнением или gate вне области'
            : // Решение — о SHA текущей фазы, diff заканчивается на нём.
              evidence.sha !==
                  (evidence.phase === 'candidate' ? a.candidateSha : a.integrationSha) ||
                evidence.notApplicable!.ranges.at(-1)?.to !== evidence.sha
              ? 'запись неприменимости не относится к SHA фазы попытки'
              : // Исполненный gate не становится неприменимым на том же SHA.
                a.evidence.some(
                    (e) =>
                      e.kind === 'test' &&
                      e.gate === evidence.gate &&
                      e.phase === evidence.phase &&
                      e.sha === evidence.sha &&
                      e.consumer === undefined,
                  )
                ? 'gate уже исполнялся на этом SHA: запись неприменимости не заменяет его исход'
                : notApplicableProblem({
                    gates: this.repository(a.repositoryId).gates,
                    gate: evidence.gate,
                    record: evidence,
                    proof: proofGates(w.order, contractDocuments(w.order, tx)),
                    ran: [],
                  });
        if (problem) throw new HarnessError('INVALID_INPUT', problem);
      }
      // Запись, взятая из кандидата (`integrationReuse`), — только под
      // политикой, которая это включила, и по правилу переноса; деревья
      // сверил controller, записавший её (и сверяет recovery).
      if (evidence.reusedEvidence) {
        const problem =
          this.policy.integrationReuse !== 'identical-tree'
            ? 'Запись, взятая из кандидата, без integrationReuse в политике'
            : !a.candidateSha || !a.integrationSha
              ? 'Запись, взятая из кандидата, до интеграции'
              : evidence.recheck !== undefined
                ? 'Запись, взятая из кандидата, не бывает повтором'
                : reusedEvidenceProblem({
                    record: {
                      ...evidence,
                      id: 'new',
                      ...(a.checks ? { checks: a.checks.effective } : {}),
                    },
                    evidence: a.evidence,
                    candidateSha: a.candidateSha,
                    resultSha: a.integrationSha,
                    proof: proofGates(w.order, contractDocuments(w.order, tx)),
                    gates: this.repository(a.repositoryId).gates,
                    trees: null,
                  });
        if (problem) throw new HarnessError('INVALID_INPUT', problem);
      }
      // Повтор ссылается на провал того же gate этой попытки на том же SHA, и
      // попытка повторяет не больше одного провала на фазу. Повтор, упавший
      // только кодом выхода исполнителя тестов (`crashedRecheck`), получает
      // один запуск сверх этого с той же ссылкой.
      if (evidence.recheck) {
        const of = evidence.recheck.of;
        const first = a.evidence.find((e) => e.id === of);
        const prior = a.evidence.filter((e) => e.recheck && e.phase === evidence.phase);
        const extra =
          prior.length === 1 &&
          prior[0]!.recheck!.of === of &&
          !!first &&
          crashedRecheck(first, prior[0]!);
        if (
          evidence.kind !== 'test' ||
          !first ||
          first.passed ||
          first.kind !== 'test' ||
          first.gate !== evidence.gate ||
          first.phase !== evidence.phase ||
          first.sha !== evidence.sha ||
          first.consumer !== evidence.consumer ||
          namesFailingCases(first) ||
          (prior.length > 0 && !extra)
        )
          throw new HarnessError(
            'INVALID_INPUT',
            'Повтор gate не относится к провалу этой попытки',
          );
        if (evidence.recheck.outcome !== (evidence.passed ? 'flaky' : 'confirmed'))
          throw new HarnessError('INVALID_INPUT', 'Исход повтора gate не согласован с записью');
      }
      const record: EvidenceRecord = {
        ...evidence,
        ...(a.checks ? { checks: a.checks.effective } : {}),
        id: this.id(),
        runId: id,
        createdAt: iso(this.now()),
      };
      tx.putAttempt({ ...a, evidence: [...a.evidence, record] });
      const common = { workId: w.id, runId: id, attempt: a.attempt };
      if (record.kind === 'review')
        tx.emit({
          type: 'attempt.review',
          ...common,
          payload: {
            phase: record.phase,
            sha: record.sha,
            passed: record.passed,
            evidenceId: record.id,
            reviewer: a.reviewer,
            sameVendor: vendorOf(a.reviewer) === vendorOf(a.runtime),
            blocking: (record.findings ?? []).filter((f) => f.severity === 'blocking').length,
          },
        });
      else
        tx.emit({
          type: 'attempt.gate',
          ...common,
          payload: {
            phase: record.phase,
            gate: record.gate,
            sha: record.sha,
            passed: record.passed,
            evidenceId: record.id,
            ...(record.consumer ? { consumer: record.consumer } : {}),
            ...(record.kind === 'not-applicable' ? { notApplicable: true as const } : {}),
            ...(record.recheck ? { recheck: record.recheck } : {}),
            ...(record.reusedEvidence ? { reusedFrom: record.reusedEvidence.evidenceId } : {}),
          },
        });
      return record;
    });
  }

  /**
   * Техническая приёмка. Требует фазу интеграции и integration SHA, PASS
   * каждого обязательного gate в обеих фазах на точных SHA, PASS
   * независимого ревью в обеих фазах; затем условие хоста `beforeAccept`.
   * `publish` — CAS продвижения target ref — выполняется внутри той же
   * транзакции до фиксации: его отказ откатывает приёмку целиком.
   */
  finish(id: string, token: string, sha: string, publish?: () => void) {
    return this.withAttempt(id, token, 'task.done', (a, w, tx) => {
      // Процесс с не применённой политикой не принимает: сравнение двух его
      // же старых digest актуальности не доказывает.
      this.assertCurrentPolicy(tx);
      if (a.phase !== 'integrating' || !a.candidateSha || a.integrationSha !== sha)
        throw new HarnessError('NOT_READY', 'Нет интеграционного коммита');
      const question = blockingRequest(tx, w);
      if (question)
        throw new HarnessError(
          'INPUT_REQUIRED',
          `Поручение ждёт ответа на вопрос исполнителя ${question.id}; приёмка невозможна`,
        );
      // Принять можно только под той версией проверок, под которой шла
      // попытка: новый корпус, принятый поручением, требует новой попытки.
      if (a.checks && this.checksOf(w, tx) !== a.checks.effective)
        throw new HarnessError(
          'APPROVAL_STALE',
          'Версия проверок поручения изменилась; нужна новая попытка',
        );
      const decisive = (
        kinds: EvidenceRecord['kind'][],
        phase: EvidenceRecord['phase'],
        at: string,
        gate: string,
      ) =>
        a.evidence.findLast(
          (e) =>
            kinds.includes(e.kind) &&
            e.phase === phase &&
            e.sha === at &&
            e.gate === gate &&
            e.consumer === undefined &&
            (!a.checks || e.checks === a.checks.effective),
        );
      const last = (
        kind: EvidenceRecord['kind'],
        phase: EvidenceRecord['phase'],
        at: string,
        gate: string,
      ) => decisive([kind], phase, at, gate)?.passed === true;
      // Обязательный gate закрыт PASS или — только обычный gate с `when` —
      // записью неприменимости под текущим определением (`notApplicableProblem`).
      const repoGates = this.repository(a.repositoryId).gates;
      const named = proofGates(w.order, contractDocuments(w.order, tx));
      const shaOf = (phase: EvidenceRecord['phase']) =>
        phase === 'candidate' ? a.candidateSha! : sha;
      const ran = Object.fromEntries(
        (['candidate', 'integration'] as const).map((phase) => [
          phase,
          (a.requiredGates ?? []).filter(
            (gate) => decisive(['test'], phase, shaOf(phase), gate) !== undefined,
          ),
        ]),
      ) as Record<EvidenceRecord['phase'], string[]>;
      for (const gate of a.requiredGates ?? [])
        for (const phase of ['candidate', 'integration'] as const) {
          // Исход исполнения решает всегда; неприменимость — только без него.
          const record =
            decisive(['test'], phase, shaOf(phase), gate) ??
            decisive(['not-applicable'], phase, shaOf(phase), gate);
          if (record?.kind === 'test' && record.passed && !record.reusedEvidence) continue;
          // Взятая из кандидата запись — PASS только по правилу переноса под
          // политикой, которая его включила (и после recovery).
          if (record?.kind === 'test' && record.passed) {
            const reused =
              this.policy.integrationReuse !== 'identical-tree'
                ? 'политика не включает integrationReuse'
                : reusedEvidenceProblem({
                    record,
                    evidence: a.evidence,
                    candidateSha: a.candidateSha,
                    resultSha: sha,
                    proof: named,
                    gates: repoGates,
                    trees: null,
                  });
            if (!reused) continue;
            throw new HarnessError('GATE_FAILED', `Нет PASS: ${phase}/${gate}: ${reused}`);
          }
          const problem =
            record?.kind === 'not-applicable'
              ? notApplicableProblem({
                  gates: repoGates,
                  gate,
                  record,
                  proof: named,
                  ran: ran[phase],
                })
              : 'нет записи';
          if (problem)
            throw new HarnessError(
              'GATE_FAILED',
              `Нет PASS: ${phase}/${gate}` +
                (record?.kind === 'not-applicable' ? ': ' + problem : ''),
            );
        }
      for (const phase of ['candidate', 'integration'] as const)
        if (
          !last('review', phase, phase === 'candidate' ? a.candidateSha : sha, 'independent-review')
        )
          throw new HarnessError('REVIEW_REJECTED', `Нет независимого ревью: ${phase}`);
      // Попытка без изменений (кандидат — база) принимается только с
      // подтверждением reviewer обеих фаз, что приёмка уже выполнена.
      if (a.candidateSha === a.baseSha)
        for (const phase of ['candidate', 'integration'] as const) {
          const decisive = a.evidence.findLast(
            (e) =>
              e.kind === 'review' &&
              e.phase === phase &&
              e.sha === (phase === 'candidate' ? a.candidateSha : sha) &&
              e.gate === 'independent-review' &&
              e.consumer === undefined &&
              (!a.checks || e.checks === a.checks.effective),
          );
          const confirmed = decisive?.alreadySatisfied;
          // Правило повторяется целиком по записанному: область задачи,
          // договор поручения и основание по зависимости, сверенное с её
          // принятой попыткой.
          const basis = confirmed?.basis;
          const dependency =
            basis?.kind === 'dependency' &&
            tx
              .attempts(basis.workId)
              .some(
                (x) =>
                  x.status === 'succeeded' &&
                  x.candidateSha === basis.sha &&
                  x.candidateSha !== x.baseSha &&
                  tx.work(basis.workId)?.resultSha === x.integrationSha,
              )
              ? basis
              : undefined;
          const repo = this.repository(a.repositoryId);
          const verdict = confirmed
            ? alreadySatisfiedVerdict({
                scope: repo.gates.filter((g) => (a.requiredGates ?? []).includes(g.id)),
                contractGates: contractCheckGates(contractDocuments(w.order, tx)),
                writeScope: w.order.writeScope,
                dependsOn: w.order.dependsOn,
                claim: { gates: confirmed.gates, evidence: confirmed.evidence },
                ...(dependency ? { dependency } : {}),
              })
            : undefined;
          if (!verdict?.ok)
            throw new HarnessError(
              'REVIEW_REJECTED',
              `Изменений нет, а ревью ${phase} не подтвердило, что приёмка уже выполнена` +
                (verdict ? ': ' + verdict.problem : ''),
            );
        }
      // Проверки потребителей — на integration, против интегрированного
      // результата: evidence потребителя закрывает только его проверку.
      for (const consumer of a.consumers ?? []) {
        for (const gate of consumer.gates)
          if (
            a.evidence.findLast(
              (e) =>
                e.kind === 'test' &&
                e.phase === 'integration' &&
                e.sha === sha &&
                e.gate === gate &&
                e.consumer === consumer.repositoryId &&
                (!a.checks || e.checks === a.checks.effective),
            )?.passed !== true
          )
            throw new HarnessError(
              'GATE_FAILED',
              `Нет PASS проверки потребителя: ${consumer.repositoryId}/${gate}`,
            );
        // Что проверено, обязано быть записано: иначе проверку потребителя не с
        // чем сверить, и результат нельзя перенести.
        const provider = consumer.checked?.dependencies.find(
          (d) => d.repositoryId === a.repositoryId,
        );
        if (provider?.sha !== sha)
          throw new HarnessError(
            'GATE_FAILED',
            `Проверка потребителя ${consumer.repositoryId} не записала снимок с интегрированным результатом`,
          );
      }
      const unproven = unprovenReason(w.order.requirements, a.evidence, sha, a.checks?.effective);
      if (unproven) throw new HarnessError('GATE_FAILED', unproven);
      // Договор проверки доказан манифестом и корпусом закреплённой версии на
      // обеих фазах, а не только битом PASS: сохранённое evidence без них
      // (в том числе при recovery) не принимается.
      const proof = propertyProofProblem({
        order: w.order,
        contracts: contractDocuments(w.order, tx),
        candidateSha: a.candidateSha,
        resultSha: sha,
        effective: a.checks?.effective,
        corpus: a.checks?.corpus ? pinnedCorpus(tx, a.checks.corpus) : undefined,
        evidence: a.evidence,
      });
      if (proof) throw new HarnessError('GATE_FAILED', proof);
      const contract = this.contractBlocker(w, tx);
      if (contract) throw new HarnessError('APPROVAL_STALE', contract);
      // Попытка исполнена ровно на снимке, закреплённом при выдаче.
      this.assertPinnedContext(a, a.contextSnapshot ?? null);
      // Согласование, связанное с контекстом, принимает только попытку на
      // том же снимке: новый одобренный контекст требует новой попытки.
      const bound = tx.graph(w.graphId)?.approval?.context;
      if (bound && (a.contextSnapshot ?? null) !== bound.digest)
        throw new HarnessError(
          'APPROVAL_STALE',
          'Согласованный контекст изменился после выдачи; нужна новая попытка',
        );
      const refusal = this.host.guards.beforeAccept(w, a, tx);
      if (refusal) throw new HarnessError(refusal.code, refusal.message);
      const at = iso(this.now());
      tx.putAttempt({ ...a, status: 'succeeded', finishedAt: at });
      const accepted = structuredClone(w);
      const open = accepted.recovery;
      afterSuccess(accepted, at);
      if (open) this.recoveryEvent(tx, w, accepted.recoveryHistory!.at(-1)!);
      tx.putWork({
        ...accepted,
        status: 'done',
        resultSha: sha,
        activeRunId: undefined,
        failure: undefined,
        failureKind: undefined,
        failureFingerprint: undefined,
      });
      tx.emit({
        type: 'work.accepted',
        graphId: w.graphId,
        workId: w.id,
        runId: id,
        attempt: a.attempt,
        payload: { resultSha: sha, integrationSha: sha },
      });
      publish?.();
      return { workId: w.id, runId: id, sha };
    });
  }

  /**
   * Отказ попытки. Класс и отпечаток записываются вместе с отказом. Отказ
   * окружения до кандидата (`blocked`) попытку не засчитывает. Отказ,
   * который повторится на любой работе (`repairPolicy.blocksQueue`), ставит
   * паузу `runtime` с классом отказа — снимает её устранение причины.
   */
  fail(
    id: string,
    token: string,
    error: string,
    options: {
      kind?: FailureKind;
      blocked?: boolean;
      heartbeatCause?: string;
      /**
       * Свойства отказа: `bound` — объявленные поручением, `unbound` — прочие
       * названные; `classes` — классы входов, названные ревьюером.
       */
      properties?: {
        bound: string[];
        unbound: string[];
        classes?: string[];
        pairs?: { property: string; inputClass: string }[];
      };
      /**
       * Попытку прервала штатная остановка controller: отказ окружения без
       * паузы по классу; поручение возвращается в очередь (`ready`), а не
       * ждёт восстановления. Интегрированная попытка так не возвращается.
       */
      interrupted?: boolean;
      /**
       * Причина отказа окружения, известная в точке обнаружения
       * (`attempt.diagnosed`). Для отказа не окружения — всегда `none`;
       * без неё — по классу отказа.
       */
      cause?: EnvironmentCause;
      /** Предел окна контекста — пишется только у отказа `context-exhausted`. */
      contextLimit?: ContextLimit;
      /**
       * Вопрос, допущения и неблокирующие запросы из ответа writer:
       * записываются той же транзакцией, что и отказ (`needs-input` —
       * блокирующий запрос; `unfinished` — отклонённый вопрос ниже порога).
       */
      input?: InputOutcome;
      /** Итог исполнителя незавершённой попытки своими словами (до 500 знаков). */
      writerSummary?: string;
    } = {},
  ) {
    const kind = options.kind ?? 'unknown';
    // Исполнитель остановился из-за окружения: ход ведущего, попытка не засчитана.
    const writerBlocked = kind === 'needs-lead' && options.cause === 'writer-environment';
    // Отказ окружения, который повтор не снимет (gate зовёт ps в песочнице):
    // без автоматического повтора и без паузы выдачи — ход ведущего.
    const noRetry =
      kind === 'environment' &&
      (noRetryEnvironmentCauses as readonly string[]).includes(options.cause ?? '')
        ? (options.cause as NoRetryEnvironmentCause)
        : undefined;
    return this.withAttempt(id, token, 'run.failed', (a, w, tx) => {
      const fingerprint = failureFingerprint(kind, error);
      const prefix = a.error?.startsWith(HEARTBEAT_FAILED)
        ? a.error
        : options.heartbeatCause
          ? `${HEARTBEAT_FAILED}: ${options.heartbeatCause.slice(0, 500)}`
          : undefined;
      const shown = prefix ? `${prefix}. ${error}` : error;
      const blocked = Boolean(options.blocked);
      const interrupted = Boolean(options.interrupted) && !a.integrationSha && !!w.approvedDigest;
      // Свойство отказа — только объявленное поручением: неизвестное
      // сохраняется для разбора, но счётчик эпизода не выбирает.
      const declared = new Set(w.order.properties ?? []);
      const pairs = (options.properties?.pairs ?? [])
        .filter((p) => !declared.has(p.property))
        .slice(0, 20);
      const bound = [...new Set((options.properties?.bound ?? []).filter((p) => declared.has(p)))];
      const unbound = [
        ...new Set([
          ...(options.properties?.unbound ?? []),
          ...(options.properties?.bound ?? []).filter((p) => !declared.has(p)),
        ]),
      ];
      const failed: AttemptState = {
        ...a,
        status: 'failed',
        error: shown,
        ...(blocked ? { blocked: true } : {}),
        ...(writerBlocked ? { writerBlocked: true as const } : {}),
        ...(options.writerSummary?.trim()
          ? { writerSummary: options.writerSummary.trim().slice(0, 500) }
          : {}),
        failureKind: kind,
        ...(kind === 'context-exhausted' && options.contextLimit
          ? { contextLimit: options.contextLimit }
          : {}),
        ...(noRetry ? { environmentCause: noRetry } : {}),
        failureFingerprint: fingerprint,
        finishedAt: iso(this.now()),
        ...(bound.length ? { properties: bound } : {}),
        ...(unbound.length ? { unboundProperties: unbound } : {}),
        ...(options.properties?.classes?.length
          ? { inputClasses: options.properties.classes.slice(0, 20) }
          : {}),
        // Пары по объявленным свойствам ведёт эпизод разбора, не пробел приёмки.
        ...(pairs.length ? { classified: pairs } : {}),
        ...(interrupted ? { interrupted: 'shutdown' as const } : {}),
        ...(options.input?.assumptions.length
          ? { assumptions: options.input.assumptions.slice(0, 20) }
          : {}),
      };
      tx.putAttempt(failed);
      const givesBack = returnsAttempt(
        kind,
        inputStopsOf(tx.attempts(w.id), id),
        this.policy.maxAttempts,
      );
      const next = structuredClone(w);
      const before = next.recovery?.status;
      const episode = afterFailure(
        next,
        tx.attempts(w.id).map((x) => (x.id === id ? failed : x)),
        failed,
        iso(this.now()),
        this.episodeOf(next, tx),
      );
      if (episode && (episode.status !== before || !w.recovery || w.recovery.id !== episode.id))
        this.recoveryEvent(tx, w, episode);
      // Отказ без повтора на вызове ps из базы: gate удержан для работ
      // репозитория с этим gate, пока его определение то же и ведущий не
      // повторил эту работу. Ни решения человека, ни общей паузы.
      const environmentHold = noRetry && !interrupted ? this.environmentHoldOf(failed) : undefined;
      tx.putWork({
        ...next,
        ...(environmentHold ? { environmentHold } : {}),
        // Прерванная остановкой работа не упала: она снова в очереди.
        ...(interrupted
          ? {
              status: 'ready' as const,
              failure: undefined,
              failureKind: undefined,
              failureFingerprint: undefined,
            }
          : {
              status: 'failed' as const,
              failure: shown,
              failureKind: kind,
              failureFingerprint: fingerprint,
            }),
        activeRunId: undefined,
        attempt:
          (interrupted || uncounted(kind, blocked, writerBlocked) || givesBack) && w.attempt > 0
            ? w.attempt - 1
            : w.attempt,
        // Отказ до работы (blocked), штатная остановка и вопрос предел
        // незасчитанных отказов не тратят; вопрос сверх своего предела
        // засчитан как попытка.
        ...(uncounted(kind, blocked, writerBlocked) && !blocked && !interrupted
          ? { neutralFailures: (w.neutralFailures ?? 0) + 1 }
          : {}),
      });
      tx.emit({
        type: 'attempt.failed',
        graphId: w.graphId,
        workId: w.id,
        runId: id,
        attempt: a.attempt,
        payload: { failureKind: kind, message: shown.slice(0, 4000), blocked },
      });
      tx.emit({
        type: 'attempt.diagnosed',
        graphId: w.graphId,
        workId: w.id,
        runId: id,
        attempt: a.attempt,
        payload: {
          failureKind: kind,
          cause: interrupted ? 'shutdown' : causeOf(kind, options.cause, blocked),
          counted: !interrupted && !uncounted(kind, blocked, writerBlocked) && !givesBack,
        },
      });
      if (options.input && !interrupted)
        this.writeInput(tx, failed, w, options.input, kind === 'needs-input');
      // Остановка — не неисправность окружения: её пауза уже стоит. Отказ
      // без повтора выдачу не держит: другие работы с другими gates идут, а
      // эта ждёт ведущего (повторять её движок не будет).
      if (repairPolicy[kind].blocksQueue && !interrupted && !noRetry) {
        const control = tx.control();
        const failures = [...new Set([...(control.pauseFailures ?? []), kind])];
        tx.setControl({
          ...control,
          paused: true,
          pauseReason: control.paused ? control.pauseReason : 'runtime',
          pausedAt: control.pausedAt ?? iso(this.now()),
          pauseFailures: failures,
        });
        tx.emit({
          type: 'control.paused',
          payload: {
            reason: control.paused ? (control.pauseReason ?? 'runtime') : 'runtime',
            failures,
          },
        });
      }
      return {
        workId: w.id,
        runId: id,
        kind,
        blocked,
        /** Работа возвращена в очередь (штатная остановка); иначе — обычный отказ. */
        interrupted,
        ...(bound.length ? { properties: bound } : {}),
        ...(episode ? { recovery: { id: episode.id, status: episode.status } } : {}),
      };
    });
  }

  /**
   * Допущения и неблокирующие запросы готовой реализации (`completed: true`)
   * записываются до кандидата под тем же fencing. Вопрос, ставший
   * остановкой, сюда не попадает — его пишет `fail`.
   */
  recordAssumptions(id: string, token: string, input: InputOutcome) {
    this.withAttempt(id, token, 'run.implementation-basis', (a, w, tx) => {
      const next: AttemptState = {
        ...a,
        ...(input.assumptions.length ? { assumptions: input.assumptions.slice(0, 20) } : {}),
      };
      tx.putAttempt(next);
      this.writeInput(tx, next, w, { ...input, question: undefined }, false);
    });
  }

  /**
   * Основание исходной попытки запроса: источник и digests, под которыми шла
   * попытка, снимок контекста, база и закреплённая политика вопросов.
   */
  private originOf(tx: ExecutionView, a: AttemptState, w: WorkState) {
    return {
      source: structuredClone(w.order.source),
      graphId: w.graphId,
      graphDigest: a.pinned?.graphDigest ?? tx.graph(w.graphId)!.digest,
      orderDigest: this.host.basis.orderDigest(w, tx),
      policyDigest: a.policyDigest,
      contextDigest: a.contextSnapshot ?? null,
      baseSha: a.baseSha ?? null,
      inputPolicy: pinnedInputPolicy(a.inputPolicy ?? inputPolicyOf(this.policy)),
      contentDigest: contentDigest(w.order),
    };
  }

  /**
   * Запись вопроса и запросов попытки в `input-requests` (владелец —
   * репозиторий поручения) и событий с ID, digests и числами — без текста.
   * `stop` — попытка кончилась `needs-input`: вопрос — блокирующий запрос
   * `pending`. Иначе вопрос ниже порога записывается отклонённым
   * (`cancelled`, без блокировки), если он не стал неблокирующим запросом
   * автономного режима. ID детерминированы попыткой: повтор записи той же
   * попытки записей не плодит.
   */
  private writeInput(
    tx: ExecutionTransaction,
    a: AttemptState,
    w: WorkState,
    input: InputOutcome,
    stop: boolean,
  ) {
    const owner = w.order.repositoryId;
    const at = iso(this.now());
    const origin = this.originOf(tx, a, w);
    const draft = a.partial
      ? {
          digest: a.partial.digest,
          files: a.partial.files.slice(0, 500).map((f) => f.slice(0, 500)),
        }
      : null;
    const base = {
      workId: w.id,
      graphId: w.graphId,
      runId: a.id,
      attempt: a.attempt,
      callId: input.callId,
      criticalHits: input.criticalHits.slice(0, 20).map((path) => path.slice(0, 500)),
      draft,
      createdAt: at,
      originBasis: origin,
      answers: [],
      version: 1,
    };
    const written: InputRequest[] = [];
    const put = (request: InputRequest) => {
      if (tx.local('input-requests', owner, request.id)) return;
      tx.putLocal('input-requests', owner, request.id, request);
      written.push(request);
    };
    const question = input.question;
    // Вопрос ниже порога, ставший неблокирующим запросом автономного режима,
    // отклонённым не пишется второй раз.
    const asFollowUp = !!question && input.followUps.some((f) => f.question === question.question);
    if (question && (stop || !asFollowUp))
      put({
        ...base,
        id: inputRequestId(a.id, 0),
        kind: 'question',
        blocking: stop,
        question: structuredClone(question.question),
        effectiveSeverity: question.effectiveSeverity,
        floors: [...question.floors],
        ...(input.normalized?.length
          ? { normalized: input.normalized.slice(0, 10).map((n) => n.slice(0, 300)) }
          : {}),
        lifecycle: stop ? 'pending' : 'cancelled',
        ...(stop
          ? {}
          : {
              closed: {
                at,
                by: 'controller' as const,
                reason: `Вопрос ниже порога политики (${question.effectiveSeverity} < ${origin.inputPolicy.threshold}): исполнитель решает сам и записывает допущение`,
              },
            }),
      });
    input.followUps.forEach((f, i) =>
      put({
        ...base,
        id: inputRequestId(a.id, i + 1),
        kind: 'follow-up',
        blocking: false,
        question: structuredClone(f.question),
        effectiveSeverity: f.effectiveSeverity,
        floors: [...f.floors],
        lifecycle: 'pending',
      }),
    );
    for (const r of written)
      tx.emit({
        type: 'input.requested',
        graphId: w.graphId,
        workId: w.id,
        runId: a.id,
        attempt: a.attempt,
        payload: {
          requestId: r.id,
          kind: r.kind,
          blocking: r.blocking,
          lifecycle: r.lifecycle === 'pending' ? 'pending' : 'cancelled',
          effectiveSeverity: r.effectiveSeverity,
          floors: r.floors,
          criticalHits: r.criticalHits.length,
          questionDigest: digestOf(r.question),
          draftDigest: r.draft?.digest ?? null,
        },
      });
    if (input.assumptions.length || input.followUps.length)
      tx.emit({
        type: 'attempt.assumptions',
        graphId: w.graphId,
        workId: w.id,
        runId: a.id,
        attempt: a.attempt,
        payload: {
          count: Math.min(input.assumptions.length, 20),
          maxSeverity: Math.max(0, ...input.assumptions.map((x) => x.effectiveSeverity)),
          floors: input.assumptions.filter((x) => x.floors.length).length,
          followUps: input.followUps.length,
          digest: digestOf(input.assumptions),
        },
      });
    return written;
  }

  /* ---------------------------------------------------------------- */
  /* Вопросы исполнителя: ответ, применение, закрытие                   */
  /* ---------------------------------------------------------------- */

  /** Запросы исполнителя: все или поручения; по времени создания. */
  inputRequests(filter: { workId?: string } = {}) {
    return this.read((v) => {
      const work = filter.workId ? v.work(filter.workId) : undefined;
      if (filter.workId && !work)
        throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + filter.workId);
      return requestsOf(v, work);
    });
  }

  /** Запрос по ID; нет — `NOT_FOUND`. */
  inputRequest(id: string) {
    return this.read((v) => this.requestIn(v, id).request);
  }

  private requestIn(view: ExecutionView, id: string) {
    const found = requestById(view, id);
    if (!found) throw new HarnessError('NOT_FOUND', 'Запрос исполнителя не найден: ' + id);
    return found;
  }

  /** CAS версии запроса: устаревшая версия — `REVISION_CONFLICT` без записи. */
  private expectVersion(request: InputRequest, expected: number) {
    if (request.version !== expected)
      throw new HarnessError(
        'REVISION_CONFLICT',
        `Запрос ${request.id}: версия ${request.version}, ожидалась ${expected}; перечитайте запрос`,
      );
  }

  /**
   * Записать ответ — новую неизменяемую версию (`answered`). Ответ работу не
   * возобновляет: продолжение — только `applyInput` после ревью контекста с
   * ответом. Повтор того же содержания (текст, вариант, вид) — тот же ответ
   * без записи, при любой версии: повтор после обрыва связи не создаёт
   * второй версии. Закрытый или применённый запрос новых ответов не
   * принимает (`NOT_READY`): поздний ответ остаётся историей хоста.
   */
  answerInput(
    id: string,
    answer: {
      text: string;
      optionId?: string | null;
      kind?: InputAnswer['kind'];
      actor: InputActor;
      messageRef?: string;
      /** Почему ведущий выбрал ответ; обязательна для технического вопроса (`leadAnswers.technical`). */
      reason?: string;
    },
    expectedVersion: number,
  ) {
    return this.tx('input.answered', (tx) => {
      this.assertNoUpdate(tx);
      const { owner, request } = this.requestIn(tx, id);
      // Блокирующий вопрос адресован человеку: ведущий отвечает только с явного
      // разрешения политики — технический вопрос без минимумов
      // (`leadAnswers.technical`, с причиной) или до порога серьёзности
      // (`leadAnswers.maxSeverity`). Проверка — до повтора: прежний ответ
      // ведущего не подтверждается после отзыва разрешения.
      const inputPolicy = inputPolicyOf(this.policy);
      const basis =
        answer.actor.kind === 'lead' ? leadAnswerBasis(request, inputPolicy) : undefined;
      if (basis === null) {
        const lead = inputPolicy.leadAnswers;
        const impact = impactOf(request.question);
        const why =
          lead?.technical === true
            ? 'политика разрешает ведущему только технические вопросы без критических областей и путей' +
              (lead.maxSeverity !== undefined ? ` до серьёзности ${lead.maxSeverity}` : '') +
              (impact !== 'technical'
                ? ', а этот меняет результат для пользователя'
                : request.floors.length
                  ? ', а этот касается критической области или пути'
                  : ', а этот серьёзнее порога')
            : lead?.maxSeverity !== undefined
              ? `политика разрешает ведущему ответы до серьёзности ${lead.maxSeverity}`
              : 'политика не разрешает ответы ведущего (inputPolicy.leadAnswers)';
        throw new HarnessError(
          'OPERATOR_ANSWER_REQUIRED',
          `Запрос ${id}: блокирующий вопрос исполнителя (серьёзность ${request.effectiveSeverity}, ${impact === 'technical' ? 'технический' : 'меняет результат для пользователя'}) адресован человеку — ` +
            why +
            '. ' +
            'Передайте человеку вопрос, варианты и рекомендацию дословно и запишите его ответ: input-answer --actor operator.',
        );
      }
      const reason = answer.reason?.trim() || undefined;
      if (basis === 'technical' && !reason)
        throw new HarnessError(
          'INVALID_INPUT',
          `Запрос ${id}: технический вопрос ведущий решает с причиной — input-answer --actor lead --reason "<почему этот вариант>"`,
          [{ path: ['--reason'], message: 'reason-required' }],
        );
      const leadBasis = basis === 'technical' || basis === 'severity' ? basis : undefined;
      const text = answer.text.trim();
      const content = {
        text,
        optionId: answer.optionId ?? null,
        kind: answer.kind ?? ('clarification' as const),
      };
      const last = latestAnswer(request);
      if (
        last &&
        last.text === content.text &&
        last.optionId === content.optionId &&
        last.kind === content.kind &&
        // Другой актёр или другое сообщение хоста — другой ответ, а не повтор.
        last.actor.kind === answer.actor.kind &&
        last.actor.id === answer.actor.id &&
        last.messageRef === answer.messageRef &&
        // Другая причина или другое правило приёма — новая версия ответа.
        last.reason === reason &&
        last.basis === leadBasis
      )
        return { request, answer: last, changed: false };
      if (!['pending', 'answered'].includes(request.lifecycle))
        throw new HarnessError(
          'NOT_READY',
          `Запрос ${id} ${request.lifecycle}: новый ответ не принимается`,
        );
      this.expectVersion(request, expectedVersion);
      if (!text) throw new HarnessError('INVALID_INPUT', 'Пустой ответ');
      if (request.answers.length >= INPUT_LIMITS.answers)
        throw new HarnessError(
          'INVALID_INPUT',
          `У запроса ${id} уже ${INPUT_LIMITS.answers} версий ответа`,
        );
      if (
        content.optionId !== null &&
        !request.question.options.some((o) => o.id === content.optionId)
      )
        throw new HarnessError(
          'INVALID_INPUT',
          `Вариант ${content.optionId} не входит в варианты вопроса`,
        );
      const revision = request.answers.length + 1;
      const recorded: InputAnswer = {
        revision,
        ...content,
        actor: structuredClone(answer.actor),
        ...(answer.messageRef ? { messageRef: answer.messageRef } : {}),
        ...(leadBasis ? { basis: leadBasis } : {}),
        ...(reason ? { reason } : {}),
        digest: answerDigest(id, { revision, ...content }),
        at: iso(this.now()),
      };
      // Пределы ответа (длина, ссылка хоста, ID актёра) — типизированным
      // отказом, а не исключением схемы при записи.
      invalidInput('Ответ', inputAnswerSchema.safeParse(recorded));
      const next: InputRequest = {
        ...request,
        lifecycle: 'answered',
        answers: [...request.answers, recorded],
        version: request.version + 1,
      };
      tx.putLocal('input-requests', owner, id, next);
      tx.emit({
        type: 'input.answered',
        graphId: request.graphId,
        workId: request.workId,
        runId: request.runId,
        payload: {
          requestId: id,
          revision,
          answerDigest: recorded.digest,
          kind: recorded.kind,
          actor: recorded.actor.kind,
        },
      });
      return { request: next, answer: recorded, changed: true };
    });
  }

  /** Закрыть запрос без продолжения в транзакции: `cancelled` или `superseded`. */
  private closeIn(
    tx: ExecutionTransaction,
    owner: string,
    request: InputRequest,
    lifecycle: 'cancelled' | 'superseded',
    closed: NonNullable<InputRequest['closed']>,
  ) {
    const next: InputRequest = {
      ...request,
      lifecycle,
      closed,
      version: request.version + 1,
    };
    tx.putLocal('input-requests', owner, request.id, next);
    tx.emit({
      type: 'input.closed',
      graphId: request.graphId,
      workId: request.workId,
      runId: request.runId,
      payload: {
        requestId: request.id,
        lifecycle,
        by: closed.by,
        ...(closed.successor ? { successor: closed.successor } : {}),
      },
    });
    return next;
  }

  /** Отмена или замена открытого запроса с CAS версии. */
  private close(
    id: string,
    lifecycle: 'cancelled' | 'superseded',
    input: { by: InputActor['kind']; reason: string; successor?: string },
    expectedVersion: number,
  ) {
    return this.tx('input.closed', (tx) => {
      this.assertNoUpdate(tx);
      const { owner, request } = this.requestIn(tx, id);
      // Перенесённый ответ, устаревший до выдачи, можно снять: работа
      // перестаёт его ждать и продолжает без него (второй выход — новый перенос).
      const staleCarry =
        lifecycle === 'cancelled' &&
        request.lifecycle === 'superseded' &&
        !!request.stale &&
        !request.target;
      if (request.lifecycle === lifecycle && !staleCarry) return { request, changed: false };
      if (!['pending', 'answered'].includes(request.lifecycle) && !staleCarry)
        throw new HarnessError(
          'NOT_READY',
          `Запрос ${id} ${request.lifecycle}: ${lifecycle === 'cancelled' ? 'отмена' : 'замена'} невозможна`,
        );
      this.expectVersion(request, expectedVersion);
      const reason = input.reason.trim();
      if (!reason) throw new HarnessError('INVALID_INPUT', 'Нужна причина');
      const closed = {
        at: iso(this.now()),
        by: input.by,
        reason: reason.slice(0, 1000),
        ...(input.successor ? { successor: input.successor } : {}),
        // Перенос ответа в контекст новой редакции — только когда исходная
        // остановка уже не держится; иначе продолжение — только applyInput.
        // Сведение для истории: решает перенос его чтение (`carryAllowed`).
        ...(lifecycle === 'superseded'
          ? { carry: this.carryAllowed(tx, { ...request, lifecycle: 'superseded' }) }
          : {}),
        // Снятие устаревшего переноса не стирает запись замены (преемник,
        // перенос, причина): она остаётся прежним закрытием.
        ...(staleCarry && request.closed
          ? {
              previous: {
                at: request.closed.at,
                by: request.closed.by,
                reason: request.closed.reason,
                ...(request.closed.successor ? { successor: request.closed.successor } : {}),
                ...(request.closed.carry !== undefined ? { carry: request.closed.carry } : {}),
              },
            }
          : {}),
      };
      invalidInput('Закрытие запроса', inputRequestSchema.shape.closed.safeParse(closed));
      return { request: this.closeIn(tx, owner, request, lifecycle, closed), changed: true };
    });
  }

  /**
   * Отменить вопрос: работа больше не ждёт ответа (обычный повтор снова
   * доступен по своим правилам). Применённый ответ не отменяется.
   */
  cancelInput(
    id: string,
    input: { by: InputActor['kind']; reason: string },
    expectedVersion: number,
  ) {
    return this.close(id, 'cancelled', input, expectedVersion);
  }

  /**
   * Заменить вопрос преемником: ответ — изменение требований, оно идёт
   * обычной ревизией или новой работой (`successor`), а не продолжением этой
   * работы через `applyInput`.
   */
  supersedeInput(
    id: string,
    input: { by: InputActor['kind']; reason: string; successor: string },
    expectedVersion: number,
  ) {
    if (!input.successor.trim())
      throw new HarnessError('INVALID_INPUT', 'Нужен преемник (новая работа или запрос)');
    return this.close(id, 'superseded', input, expectedVersion);
  }

  /** Закрыть открытые запросы отменённого поручения (в транзакции отмены). */
  private closeRequestsOf(
    tx: ExecutionTransaction,
    work: WorkState,
    by: NonNullable<InputRequest['closed']>['by'],
  ) {
    for (const request of requestsOf(tx, work))
      if (request.lifecycle === 'pending' || request.lifecycle === 'answered')
        this.closeIn(tx, work.order.repositoryId, request, 'cancelled', {
          at: iso(this.now()),
          by,
          reason: 'Поручение отменено',
        });
  }

  /**
   * Раунд ревью, на котором основано продолжение: у хоста с портом —
   * его проверка; у standalone — та же проверка, что у `approve`
   * (`approvalCheck`), и снимок последнего раунда ревью плана обязан быть
   * `contextDigest`. Только внутри транзакции.
   */
  private targetReview(
    tx: ExecutionView,
    work: WorkState,
    contextDigest: string | null,
    actor: TechnicalApproval['actor'],
    request: InputTargetRequest,
  ) {
    // Актёр согласования — режим политики и у хоста с портом: порт правил
    // движка не ослабляет.
    if (actor !== this.policy.approvalMode)
      throw new HarnessError(
        'APPROVAL_REQUIRED',
        `Политика требует согласования ${this.policy.approvalMode === 'operator' ? 'оператором' : 'агентом-ревьюером'}`,
      );
    if (this.host.input)
      return { review: this.host.input.review(work, contextDigest, actor, tx, request) };
    const checked = this.approvalRules(tx, work.graphId, actor);
    // Снимок раунда и снимок ответа сверяются по содержанию: тот же снимок
    // в другом порядке источников (записанный прежней версией) — тот же
    // контекст (0.1.0-alpha.68).
    const same = (a: string | null, b: string | null) => {
      if (a === b) return true;
      if (!a || !b) return false;
      const x = tx.local('context-snapshots', WORKSPACE_OWNER, a);
      const y = tx.local('context-snapshots', WORKSPACE_OWNER, b);
      return !!x && !!y && canonicalContextDigest(x) === canonicalContextDigest(y);
    };
    if (!same(checked.last.contextDigest ?? null, contextDigest))
      throw new HarnessError(
        'APPROVAL_REQUIRED',
        'Последний раунд ревью плана рассматривал другой снимок контекста: проведите review-plan со снимком ответа',
      );
    return {
      review: {
        round: checked.last.round,
        approved: checked.last.approved,
        reviewerBinding: checked.last.reviewerBinding ?? null,
      },
      checked,
    };
  }

  /**
   * Исходная остановка запроса держится: работа на попытке вопроса
   * (остановлена needs-input или готова после устаревшего применения), граф
   * и постановка — те же. Тогда продолжение — только `applyInput`.
   */
  originHolds(view: ExecutionView, request: InputRequest) {
    const work = view.work(request.workId);
    if (!work) return false;
    const atOrigin =
      (work.status === 'failed' && work.failureKind === 'needs-input') || work.status === 'ready';
    return (
      atOrigin &&
      view.attempts(work.id).at(-1)?.id === request.runId &&
      // Своя постановка, а не весь граф: согласование соседней работы (у хоста
      // граф — активная ревизия доски) остановку не обесценивает.
      !this.orderMoved(view, work, request.originBasis)
    );
  }

  /**
   * Можно ли перенести ответ заменённого запроса в контекст сейчас — в
   * момент переноса, а не замены (порядок «замена, потом новая редакция»
   * тоже ведёт к переносу). Уточнение: исходная остановка уже не держится.
   * Изменение требований: изменилась постановка самой этой работы — иначе
   * требование вошло бы в неизменную постановку одним файлом контекста.
   * Переносится только последний ответ (`carried`).
   */
  /**
   * Изменилась ли постановка работы против запомненной: по содержанию без
   * ревизии источника (`contentDigest`), если оно записано, иначе по digest
   * постановки хоста (записи прежних версий).
   */
  private orderMoved(
    view: ExecutionView,
    work: WorkState | undefined,
    basis: { orderDigest: string; contentDigest?: string },
  ) {
    if (!work) return true;
    return basis.contentDigest !== undefined
      ? contentDigest(work.order) !== basis.contentDigest
      : this.host.basis.orderDigest(work, view) !== basis.orderDigest;
  }

  carryAllowed(view: ExecutionView, request: InputRequest) {
    if (request.lifecycle !== 'superseded') return false;
    const answer = latestAnswer(request);
    if (!answer) return false;
    const work = view.work(request.workId);
    // По содержанию постановки, без ревизии источника: пересинхронизация
    // трекера одной ревизией перенос не открывает.
    const orderChanged = this.orderMoved(view, work, request.originBasis);
    if (answer.kind === 'requirement-change') return orderChanged;
    return orderChanged || !this.originHolds(view, request);
  }

  /**
   * Перенос, который принимают `proposeCarry` и `carryInput` (0.1.0-alpha.68):
   * правило переноса (`carryAllowed`) или уточнение заменённого вопроса, чья
   * исходная остановка снова держится (новая редакция вернула работу в
   * готовую с той же постановкой и попыткой вопроса). `applyInput` берёт
   * только `answered`, и без этого у такого вопроса не было бы публичного
   * пути к работе. Перенесённый так ответ с записанным основанием —
   * применённый и для `unappliedInputs` (`carried`).
   */
  private carryPermitted(view: ExecutionView, request: InputRequest) {
    if (this.carryAllowed(view, request)) return true;
    const answer = latestAnswer(request);
    return (
      request.lifecycle === 'superseded' &&
      answer?.kind === 'clarification' &&
      this.originHolds(view, request)
    );
  }

  /** Неприменённые источники ответов снимка с правилом переноса этого движка. */
  unappliedInputs(view: ExecutionView, snapshot: ContextSnapshot | undefined) {
    return unappliedInputs(view, snapshot, (r) => this.carryAllowed(view, r));
  }

  /**
   * Почему снимок с ответами нельзя сделать действующим сейчас: в нём
   * источник ответа, которого нет в действующем согласовании, а в графе идут
   * попытки — их согласование обесценилось бы (H02-I). `undefined` — можно.
   */
  inputActivationRefusal(
    view: ExecutionView,
    graphId: string,
    snapshot: ContextSnapshot | undefined,
  ) {
    const sources = (snapshot?.sources ?? []).filter((s) => s.kind === INPUT_SOURCE_KIND);
    if (!sources.length) return undefined;
    const digest = view.graph(graphId)?.approval?.context?.digest;
    const current = digest ? view.local('context-snapshots', WORKSPACE_OWNER, digest) : undefined;
    const added = sources.filter(
      (s) => !current?.sources.some((c) => c.id === s.id && c.digest === s.digest),
    );
    if (!added.length) return undefined;
    const active = activeOf(view).filter((a) => view.work(a.workId)?.graphId === graphId);
    return active.length
      ? `в графе идут попытки (${active.map((a) => a.id).join(', ')}): снимок с новым ответом станет действующим после их окончания`
      : undefined;
  }

  /** Действующий снимок контекста поручения для выдачи (`pinned.contextDigest`). */
  private contextPinOf(view: ExecutionView, work: WorkState) {
    if (this.host.input) return this.host.input.contextDigestOf(work, view);
    const approved = view.graph(work.graphId)?.approval?.context;
    return approved ? approved.digest : undefined;
  }

  /** Чем основание выдачи сейчас расходится с применённым; `undefined` — совпадает. */
  private targetDrift(
    view: ExecutionView,
    work: WorkState,
    request: InputRequest,
    target: InputTarget,
  ) {
    // Граф целиком не сравнивается: согласование другой работы того же графа
    // применённый ответ не обесценивает (причина `graph` больше не ставится).
    if (this.orderMoved(view, work, target)) return 'order' as const;
    // Standalone: правка политики применённый ответ сама не обесценивает —
    // граф под новой политикой не выдаётся до повторного согласования
    // (reapprove или новый раунд ревью), а оно проверяется ниже снимком:
    // действующий снимок обязан нести этот ответ. Пока граф не согласован
    // заново, устаревания нет (выдача другого графа его не вызывает).
    if (this.host.input && target.policyDigest !== this.host.basis.policyDigest(work, view))
      return 'policy' as const;
    const pin = this.contextPinOf(view, work) ?? null;
    // Другой снимок, который несёт тот же ответ (например, с ответом на
    // второй вопрос графа), основание не обесценивает.
    const answer = request.answers.find((a) => a.digest === target.answerDigest);
    if (target.contextDigest !== pin && !(answer && this.carriesAnswer(view, request, answer, pin)))
      return 'context' as const;
    return undefined;
  }

  /**
   * Правка политики, после которой граф снова согласован под текущей
   * политикой (reapprove или новый раунд ревью плана), применённый ответ не
   * обесценивает: его основание — то же согласование, а снимок контекста
   * проверяется отдельно (`targetDrift`: действующий снимок обязан нести этот
   * ответ). Только standalone: у хоста с портом согласования основание
   * политики решает хост.
   */
  private approvalRebound(view: ExecutionView, work: WorkState) {
    if (this.host.input) return false;
    const graph = view.graph(work.graphId);
    return (
      !!graph?.approval &&
      graph.approval.digest === graph.digest &&
      graph.policyDigest === this.host.basis.policyDigest(work, view)
    );
  }

  /** Вернуть в `answered` применённые, но не переданные ответы с устаревшим основанием. */
  private staleTargets(tx: ExecutionTransaction, work: WorkState) {
    for (const r of requestsOf(tx, work)) {
      if (!linksAnswer(r) || r.delivered || !r.target) continue;
      const reason = this.targetDrift(tx, work, r, r.target);
      if (!reason) continue;
      const { target, ...rest } = r;
      // Применённый — снова `answered`; перенесённый остаётся заменённым без
      // цели: работа ждёт нового переноса (`blocksWork`).
      tx.putLocal('input-requests', work.order.repositoryId, r.id, {
        ...rest,
        lifecycle: r.lifecycle === 'applied' ? 'answered' : 'superseded',
        stale: { targetDigest: target.digest, reason, at: iso(this.now()) },
        version: r.version + 1,
      });
      tx.emit({
        type: 'input.stale',
        graphId: work.graphId,
        workId: work.id,
        runId: r.runId,
        payload: { requestId: r.id, targetDigest: target.digest, reason },
      });
    }
  }

  /**
   * Снимок `contextDigest` несёт источник ответа этого запроса с точным
   * digest и версией ответа (manifest). Снимок — порта хоста или локальный.
   */
  private carriesAnswer(
    view: ExecutionView,
    request: InputRequest,
    answer: InputAnswer,
    contextDigest: string | null,
  ) {
    if (contextDigest === null) return false;
    const snapshot =
      this.host.input?.snapshot?.(contextDigest, view) ??
      view.local('context-snapshots', WORKSPACE_OWNER, contextDigest);
    const source = snapshot?.sources.find((s) => s.id === inputSourceId(request.id));
    const manifest = source ? inputManifestOf(source) : undefined;
    return (
      !!manifest &&
      manifest.requestId === request.id &&
      manifest.answerDigest === answer.digest &&
      manifest.revision === answer.revision
    );
  }

  /** Основание продолжения без digest: исходное, ответ, текущие основания, контекст, ревью, актёр. */
  private targetOf(
    view: ExecutionView,
    request: InputRequest,
    work: WorkState,
    contextDigest: string | null,
    review: InputTarget['review'],
    actor: TechnicalApproval['actor'],
  ): Omit<InputTarget, 'digest'> {
    return {
      originDigest: digestOf(request.originBasis),
      answerDigest: latestAnswer(request)!.digest,
      graphDigest: view.graph(work.graphId)!.digest,
      orderDigest: this.host.basis.orderDigest(work, view),
      contentDigest: contentDigest(work.order),
      policyDigest: this.host.basis.policyDigest(work, view),
      contextDigest,
      review,
      actor,
    };
  }

  /**
   * Предложить основание продолжения для снимка `contextDigest` (только
   * чтение): digest, который назовёт `applyInput`, и причины, по которым
   * применение сейчас откажет. Ничего не пишет и не активирует.
   */
  proposeTarget(id: string, contextDigest: string | null, actor = this.policy.approvalMode) {
    return this.read((v) => {
      const { request } = this.requestIn(v, id);
      const work = v.work(request.workId);
      if (!work) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + request.workId);
      const problems: string[] = [];
      if (request.kind !== 'question') problems.push('неблокирующий запрос не применяется');
      if (request.lifecycle !== 'answered')
        problems.push(`запрос ${request.lifecycle}, нужен answered`);
      // Та же проверка исходной остановки, что у applyInput, — с выходом.
      const last = v.attempts(work.id).at(-1);
      const atOrigin =
        (work.status === 'failed' && work.failureKind === 'needs-input') || work.status === 'ready';
      if (!atOrigin || last?.id !== request.runId || this.orderMoved(v, work, request.originBasis))
        problems.push(
          'работа уже не в исходной остановке (новая редакция постановки или другая попытка): выход — перенос ответа одной командой: harness input-carry --request <id> --reason …',
        );
      const answer = latestAnswer(request);
      if (!answer) {
        problems.push('ответа нет');
        return { request, problems };
      }
      if (answer.kind !== 'clarification')
        problems.push('ответ — изменение требований: новая ревизия, не продолжение');
      if (!this.carriesAnswer(v, request, answer, contextDigest))
        problems.push('снимок контекста не содержит этот ответ');
      // Те же проверки, что у applyInput: барьер политики (только чтение) и
      // правила согласования — причинами, а не исключением.
      const stale = this.staleReason(v);
      if (stale) problems.push(stale);
      let review: InputTarget['review'] = null;
      try {
        review = this.targetReview(v, work, contextDigest, actor, {
          id: request.id,
          answerDigest: answer.digest,
          mode: 'apply',
        }).review;
      } catch (error) {
        if (!(error instanceof HarnessError)) throw error;
        problems.push(error.message);
      }
      const target = this.targetOf(v, request, work, contextDigest, review, actor);
      const active = activeOf(v).filter((a) => v.work(a.workId)?.graphId === work.graphId);
      if (active.length)
        problems.push('в графе идут попытки: ' + active.map((a) => a.id).join(', '));
      return {
        request,
        target: { ...target, digest: targetDigest(target) },
        problems,
      };
    });
  }

  /**
   * Применить ответ одной транзакцией: проверить точную версию запроса и
   * digest ответа, исходное основание (поручение всё ещё в этой остановке),
   * актуальность политики, раунд ревью снимка с ответом и актёра — теми же
   * проверками, что `approve` (`approvalCheck`) и `retry` (`retryIn`), —
   * пересчитать основание продолжения и сверить его с `targetDigest`;
   * затем активировать согласование снимка, записать `applied` и цель и
   * вернуть поручение в очередь обычным повтором (без сброса, если сброс не
   * назван явно). Модель не вызывается; пауза оператора и чужие удержания
   * остаются.
   *
   * Без изменения запроса и согласования: идут попытки графа или совместная проверка — `{ applied:
   * false, active }` (их согласование не обесценивается); исчерпаны попытки
   * или бюджет — `{ applied: false, blocker }`, запрос остаётся `answered`.
   * Повтор того же применения — `{ applied: true, changed: false }`, второй
   * попытки нет.
   */
  applyInput(
    id: string,
    options: {
      answerDigest: string;
      expectedVersion: number;
      /** Снимок контекста с ответом, прошедший ревью (`null` — без контекста). */
      contextDigest: string | null;
      targetDigest: string;
      actor: TechnicalApproval['actor'];
      /** Сброс исчерпанных попыток — с причиной, как у `retry`. */
      reset?: { reason: string };
    },
  ) {
    return this.tx('input.applied', (tx) => {
      this.assertNoUpdate(tx);
      const { owner, request } = this.requestIn(tx, id);
      const answer = latestAnswer(request);
      if (request.kind !== 'question' || !request.blocking)
        throw new HarnessError('INVALID_INPUT', `Запрос ${id} неблокирующий: применять нечего`);
      if (request.lifecycle === 'applied') {
        if (
          answer?.digest === options.answerDigest &&
          request.target?.digest === options.targetDigest
        )
          return { applied: true as const, changed: false, request };
        throw new HarnessError(
          'REVISION_CONFLICT',
          `Запрос ${id} уже применён с другим ответом или основанием`,
        );
      }
      if (request.lifecycle === 'pending')
        throw new HarnessError('INPUT_REQUIRED', `На вопрос ${id} ещё нет ответа`);
      if (request.lifecycle !== 'answered')
        throw new HarnessError(
          'NOT_READY',
          request.lifecycle === 'superseded'
            ? `Запрос ${id} superseded: ответ заменённого вопроса доводится до работы переносом — harness input-carry --request ${id} --reason <почему> --author <runtime ведущего>`
            : `Запрос ${id} ${request.lifecycle}`,
        );
      this.expectVersion(request, options.expectedVersion);
      if (!answer || answer.digest !== options.answerDigest)
        throw new HarnessError(
          'APPROVAL_STALE',
          `Ответ на запрос ${id} изменился: применяется только последний ответ`,
        );
      if (answer.kind !== 'clarification')
        throw new HarnessError(
          'INVALID_INPUT',
          'Ответ меняет требования: это новая ревизия (supersedeInput), а не продолжение работы',
        );
      const work = tx.work(request.workId);
      if (!work) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + request.workId);
      // Работа всё ещё в той остановке, из которой задан вопрос: устаревший
      // ответ не применяется к другой работе или другой попытке.
      const last = tx.attempts(work.id).at(-1);
      // Готовая без новой попытки — после устаревшего применения (`stale`).
      const atOrigin =
        (work.status === 'failed' && work.failureKind === 'needs-input') || work.status === 'ready';
      if (!atOrigin || last?.id !== request.runId)
        throw new HarnessError(
          'NOT_READY',
          `Поручение ${work.id} уже не в остановке попытки ${request.runId}: ответ не применяется`,
        );
      // Своя постановка, а не весь граф: другие работы графа меняются своим
      // чередом (у хоста граф — активная ревизия доски).
      if (this.orderMoved(tx, work, request.originBasis))
        throw new HarnessError(
          'APPROVAL_STALE',
          'Постановка работы изменилась после вопроса: продолжение этой остановки невозможно. Выход с сохранением ответа — supersedeInput (преемник — новая редакция работы), затем снимок с ответом (input-context), review-plan с ним и обычное согласование',
        );
      const contextDigest = options.contextDigest;
      // Политика процесса применена — и у хоста с портом согласования.
      this.assertCurrentPolicy(tx);
      const targetRequest = { id, answerDigest: answer.digest, mode: 'apply' as const };
      const { review, checked } = this.targetReview(
        tx,
        work,
        contextDigest,
        options.actor,
        targetRequest,
      );
      const target: Omit<InputTarget, 'digest'> = this.targetOf(
        tx,
        request,
        work,
        contextDigest,
        review,
        options.actor,
      );
      const digest = targetDigest(target);
      if (digest !== options.targetDigest)
        throw new HarnessError(
          'APPROVAL_STALE',
          'Основание продолжения изменилось после предложения (proposeTarget); предложите заново',
        );
      // Снимок обязан нести ровно этот ответ этого запроса.
      if (!this.carriesAnswer(tx, request, answer, contextDigest))
        throw new HarnessError(
          'INVALID_INPUT',
          `Снимок контекста ${contextDigest ?? 'null'} не содержит этот ответ на запрос ${id}`,
        );
      // Попытки графа идут под действующим согласованием: новое не
      // активируется до их окончания.
      const active = activeOf(tx).filter((a) => tx.work(a.workId)?.graphId === work.graphId);
      if (active.length || this.liveJoint(tx))
        return {
          applied: false as const,
          changed: false,
          request,
          active: active.map((a) => ({ id: a.id, workId: a.workId })),
          ...(this.liveJoint(tx) ? { joint: true } : {}),
        };
      const exhausted = work.attempt >= this.policy.maxAttempts || neutralExhausted(work);
      if (exhausted && !options.reset?.reason.trim())
        return {
          applied: false as const,
          changed: false,
          request,
          blocker: {
            code: 'ATTEMPTS_EXHAUSTED' as const,
            message: `Исчерпано ${work.attempt} из ${ruCount(this.policy.maxAttempts, RU.attemptGen)}; ответ сохранён, продолжение — со сбросом и причиной`,
          },
        };
      const budget = this.budgetBlockOf(work.id, tx);
      if (budget)
        return {
          applied: false as const,
          changed: false,
          request,
          blocker: { code: 'BUDGET_EXHAUSTED' as const, message: budget },
        };
      const full: InputTarget = { ...target, digest };
      if (this.host.input) this.host.input.activate(tx, work, full, targetRequest);
      else
        this.activateApproval(tx, checked!.graph, checked!.last, options.actor, {
          bindContext: true,
        });
      // Прежнее устаревшее основание — история события `input.stale`.
      const { stale: _stale, ...current } = request;
      void _stale;
      const next: InputRequest = {
        ...current,
        lifecycle: 'applied',
        target: full,
        version: request.version + 1,
      };
      tx.putLocal('input-requests', owner, id, next);
      const retried = this.retryIn(
        tx,
        tx.work(work.id)!,
        options.reset,
        options.actor === 'operator' ? 'operator' : 'recovery',
      );
      tx.emit({
        type: 'input.applied',
        graphId: work.graphId,
        workId: work.id,
        runId: request.runId,
        payload: {
          requestId: id,
          answerDigest: answer.digest,
          targetDigest: digest,
          contextDigest,
          retried: retried.changed,
        },
      });
      return { applied: true as const, changed: true, request: next, work: retried.work };
    });
  }

  /**
   * Предложить основание переноса ответа заменённого запроса (только
   * чтение): digest, который назовёт `carryInput`, и причины, по которым
   * перенос сейчас откажет.
   */
  proposeCarry(id: string, contextDigest: string, actor = this.policy.approvalMode) {
    return this.read((v) => {
      const { request } = this.requestIn(v, id);
      const work = v.work(request.workId);
      if (!work) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + request.workId);
      const problems: string[] = [];
      if (request.lifecycle !== 'superseded')
        problems.push(`запрос ${request.lifecycle}, нужен superseded`);
      const answer = latestAnswer(request);
      if (!answer) return { request, problems: [...problems, 'ответа нет'] };
      if (!this.carryPermitted(v, request))
        problems.push('правило переноса не позволяет перенести ответ');
      if (!this.carriesAnswer(v, request, answer, contextDigest))
        problems.push('снимок контекста не содержит последний ответ');
      const stale = this.staleReason(v);
      if (stale) problems.push(stale);
      let review: InputTarget['review'] = null;
      try {
        review = this.targetReview(v, work, contextDigest, actor, {
          id,
          answerDigest: answer.digest,
          mode: 'carry',
        }).review;
      } catch (error) {
        if (!(error instanceof HarnessError)) throw error;
        problems.push(error.message);
      }
      const active = activeOf(v).filter((a) => v.work(a.workId)?.graphId === work.graphId);
      if (active.length)
        problems.push('в графе идут попытки: ' + active.map((a) => a.id).join(', '));
      const target = this.targetOf(v, request, work, contextDigest, review, actor);
      return { request, target: { ...target, digest: targetDigest(target) }, problems };
    });
  }

  /**
   * Перенести ответ заменённого запроса в действующее согласование работы —
   * у хоста с портом согласования так же, как у standalone. Одна
   * транзакция: правило переноса (`carryAllowed`), снимок несёт ровно
   * последний ответ и не несёт неприменённых, политика процесса применена,
   * ревью снимка и актёр — по правилам хоста или `approvalRules`, в графе нет
   * идущих попыток и совместной проверки; затем активация (`InputHost.activate`
   * с `mode: 'carry'` или согласование графа), цель записывается в запрос
   * (он остаётся `superseded`), и упавшая работа возвращается в очередь
   * обычным повтором. Модель не вызывается; повтор того же переноса —
   * `{ carried: true, changed: false }`.
   */
  carryInput(
    id: string,
    options: {
      /** Снимок с ответом, прошедший ревью. */
      contextDigest: string;
      actor: TechnicalApproval['actor'];
      /** Версия запроса, которую видел вызывающий (CAS). */
      expectedVersion: number;
      /** Digest основания из `proposeCarry`: перенос — на том ревью, которое видел вызывающий. */
      targetDigest: string;
      /** Сброс исчерпанных попыток упавшей работы — с причиной, как у `retry`. */
      reset?: { reason: string };
    },
  ) {
    return this.tx('input.applied', (tx) => {
      this.assertNoUpdate(tx);
      const { owner, request } = this.requestIn(tx, id);
      if (request.kind !== 'question' || !request.blocking)
        throw new HarnessError('INVALID_INPUT', `Запрос ${id} неблокирующий: переносить нечего`);
      if (request.lifecycle !== 'superseded')
        throw new HarnessError(
          'NOT_READY',
          `Запрос ${id} ${request.lifecycle}: перенос — только для заменённого (supersedeInput); продолжение остановки — applyInput`,
        );
      const answer = latestAnswer(request);
      if (!answer) throw new HarnessError('INPUT_REQUIRED', `На вопрос ${id} нет ответа`);
      if (
        request.target?.digest === options.targetDigest &&
        request.target.answerDigest === answer.digest
      )
        return { carried: true as const, changed: false, request };
      this.expectVersion(request, options.expectedVersion);
      if (!this.carryPermitted(tx, request))
        throw new HarnessError(
          'INPUT_REQUIRED',
          answer.kind === 'requirement-change'
            ? `Изменение требований переносится, только если изменилась постановка работы ${request.workId}`
            : `Исходная остановка запроса ${id} держится: продолжение — applyInput, а не перенос`,
        );
      if (!this.carriesAnswer(tx, request, answer, options.contextDigest))
        throw new HarnessError(
          'INVALID_INPUT',
          `Снимок ${options.contextDigest} не содержит последний ответ на запрос ${id}`,
        );
      const snapshot =
        this.host.input?.snapshot?.(options.contextDigest, tx) ??
        tx.local('context-snapshots', WORKSPACE_OWNER, options.contextDigest);
      // Ответ, который переносится этим вызовом, — не «неприменённый»: его
      // правило — `carryPermitted` выше; другие неприменённые ответы — отказ.
      const unapplied = this.unappliedInputs(tx, snapshot).filter((u) => u.requestId !== id);
      if (unapplied.length)
        throw new HarnessError(
          'INPUT_REQUIRED',
          'Снимок содержит неприменённый ответ: ' +
            unapplied.map((u) => `${u.requestId ?? u.source} (${u.reason})`).join(', '),
        );
      const work = tx.work(request.workId);
      if (!work) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + request.workId);
      if (work.status === 'cancelled' || work.status === 'done')
        throw new HarnessError(
          'NOT_READY',
          `Поручение ${work.id} ${work.status}: переносить некуда`,
        );
      this.assertCurrentPolicy(tx);
      const targetRequest = { id, answerDigest: answer.digest, mode: 'carry' as const };
      const { review, checked } = this.targetReview(
        tx,
        work,
        options.contextDigest,
        options.actor,
        targetRequest,
      );
      const active = activeOf(tx).filter((a) => tx.work(a.workId)?.graphId === work.graphId);
      if (active.length || this.liveJoint(tx))
        return {
          carried: false as const,
          changed: false,
          request,
          active: active.map((a) => ({ id: a.id, workId: a.workId })),
          ...(this.liveJoint(tx) ? { joint: true } : {}),
        };
      const target = this.targetOf(tx, request, work, options.contextDigest, review, options.actor);
      const full: InputTarget = { ...target, digest: targetDigest(target) };
      if (full.digest !== options.targetDigest)
        throw new HarnessError(
          'APPROVAL_STALE',
          'Основание переноса изменилось после предложения (proposeCarry); предложите заново',
        );
      // Пределы — до активации, как у applyInput: согласование не
      // переключается под работу, которую сейчас не выдать.
      const stopped = work.status === 'failed' && work.failureKind === 'needs-input';
      if (
        stopped &&
        (work.attempt >= this.policy.maxAttempts || neutralExhausted(work)) &&
        !options.reset?.reason.trim()
      )
        return {
          carried: false as const,
          changed: false,
          request,
          blocker: {
            code: 'ATTEMPTS_EXHAUSTED' as const,
            message: `Исчерпано ${work.attempt} из ${ruCount(this.policy.maxAttempts, RU.attemptGen)}; перенос — со сбросом и причиной`,
          },
        };
      const budget = this.budgetBlockOf(work.id, tx);
      if (budget)
        return {
          carried: false as const,
          changed: false,
          request,
          blocker: { code: 'BUDGET_EXHAUSTED' as const, message: budget },
        };
      if (this.host.input) this.host.input.activate(tx, work, full, targetRequest);
      else
        this.activateApproval(tx, checked!.graph, checked!.last, options.actor, {
          bindContext: true,
        });
      const { stale: _stale, ...current0 } = request;
      void _stale;
      const next: InputRequest = { ...current0, target: full, version: request.version + 1 };
      tx.putLocal('input-requests', owner, id, next);
      const current = tx.work(work.id)!;
      // В очередь возвращается только работа, остановленная вопросом; иной
      // отказ после редакции — решение по его правилам, не перенос ответа.
      const retried =
        current.status === 'failed' && current.failureKind === 'needs-input'
          ? this.retryIn(
              tx,
              current,
              options.reset,
              options.actor === 'operator' ? 'operator' : 'recovery',
            )
          : { work: current, changed: false };
      tx.emit({
        type: 'input.applied',
        graphId: work.graphId,
        workId: work.id,
        runId: request.runId,
        payload: {
          requestId: id,
          answerDigest: answer.digest,
          targetDigest: full.digest,
          contextDigest: options.contextDigest,
          retried: retried.changed,
        },
      });
      return { carried: true as const, changed: true, request: next, work: retried.work };
    });
  }

  /**
   * Ответ передан исполнителю: начался вызов runtime попытки, выданной с этим
   * ответом (`AttemptState.input`). Под fencing попытки и один раз: ни apply,
   * ни claim доставку не подтверждают.
   */
  inputDelivered(id: string, token: string, callId: string) {
    return this.withAttempt(id, token, 'input.delivered', (a, w, tx) => {
      if (!a.input) return false;
      const request = requestsOf(tx, w).find((r) => r.id === a.input!.requestId);
      if (
        !request ||
        request.delivered ||
        !linksAnswer(request) ||
        request.target?.digest !== a.input.targetDigest
      )
        return false;
      tx.putLocal('input-requests', w.order.repositoryId, request.id, {
        ...request,
        delivered: { runId: a.id, callId, at: iso(this.now()) },
        version: request.version + 1,
      });
      tx.emit({
        type: 'input.delivered',
        graphId: w.graphId,
        workId: w.id,
        runId: a.id,
        attempt: a.attempt,
        payload: { requestId: request.id, answerDigest: a.input.answerDigest, callId },
      });
      return true;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Эпизоды восстановления по свойству                                 */
  /* ---------------------------------------------------------------- */

  private recoveryEvent(tx: ExecutionTransaction, work: WorkState, r: PropertyRecovery) {
    tx.emit({
      type: 'work.recovery',
      graphId: work.graphId,
      workId: work.id,
      payload: {
        recoveryId: r.id,
        property: r.property,
        status: r.status,
        ...(r.reason ? { reason: r.reason.slice(0, 4000) } : {}),
      },
    });
  }

  /** Принятие корпуса, ждущее оператора, удерживает выдачу поручения. */
  private awaitsOperator(work: WorkState, view: ExecutionView) {
    return view
      .locals('check-suites', work.order.repositoryId)
      .some((x) =>
        x.value.pending.some(
          (p) => p.status === 'waiting' && p.awaitingOperator && p.tasks.includes(work.id),
        ),
      );
  }

  private episode(
    kind: TransactionKind,
    workId: string,
    recoveryId: string,
    fn: (r: PropertyRecovery, w: WorkState) => string | undefined,
  ): PropertyRecovery {
    return this.tx(kind, (tx) => {
      const w = tx.work(workId);
      if (!w) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + workId);
      if (!w.recovery || w.recovery.id !== recoveryId)
        throw new HarnessError('NOT_FOUND', 'Эпизод восстановления не найден');
      const r = structuredClone(w.recovery);
      const event = fn(r, w);
      if (event === undefined) return r;
      r.version++;
      r.history.push({
        at: iso(this.now()),
        event,
        ...(r.reason ? { detail: r.reason.slice(0, 1000) } : {}),
      });
      tx.putWork({ ...w, recovery: r });
      this.recoveryEvent(tx, w, r);
      return r;
    });
  }

  /**
   * Учесть разбор ведущего до вызова модели. Один автоматический разбор на
   * эпизод: повторная регистрация, рестарт или дубликат бесплатного вызова
   * не получают. Исчерпанные попытки — решение человека.
   */
  recoveryReserve(workId: string, recoveryId: string) {
    return this.episode('recovery.reserved', workId, recoveryId, (r, w) => {
      if (r.status !== 'awaiting-lead')
        throw new HarnessError('NOT_READY', `Эпизод ${r.id} не ждёт разбора: ${r.status}`);
      if (r.calls >= 1) {
        r.status = 'awaiting-user';
        r.reason = 'Автоматический разбор эпизода уже использован; повторный вызов не выполняется.';
      } else if (w.attempt >= this.policy.maxAttempts) {
        r.status = 'awaiting-user';
        r.reason =
          'Попытки поручения исчерпаны: разрешённого повтора не осталось, сброс — решение человека.';
      } else {
        r.calls++;
        r.status = 'analyzing';
      }
      return r.status === 'analyzing' ? 'analysis-reserved' : 'refused';
    });
  }

  /**
   * Записать решение разбора — ведущего или ручное — и перевести эпизод в
   * состояние разрешённого действия. Ручное решение сверяет версию записи:
   * устаревшее не применяется.
   */
  recoveryDecide(
    workId: string,
    recoveryId: string,
    decision: NonNullable<PropertyRecovery['decision']>,
    expectedVersion?: number,
  ) {
    if (decision.reason.trim().length < 10)
      throw new HarnessError('INVALID_INPUT', 'Решение требует причины не короче 10 символов');
    return this.episode('recovery.decided', workId, recoveryId, (r, w) => {
      if (expectedVersion !== undefined && r.version !== expectedVersion)
        throw new HarnessError('APPROVAL_STALE', 'Эпизод изменился; прочитайте его заново');
      const manual = decision.source.kind === 'operator';
      if (!manual && r.status !== 'analyzing')
        throw new HarnessError('NOT_READY', `Эпизод ${r.id} не в разборе: ${r.status}`);
      if (manual && !['awaiting-lead', 'awaiting-user', 'stopped', 'analyzing'].includes(r.status))
        throw new HarnessError('NOT_READY', `Эпизод ${r.id} уже исполняет решение: ${r.status}`);
      if (w.status === 'cancelled') throw new HarnessError('NOT_READY', 'Поручение отменено');
      r.decision = decision;
      const retryable = w.attempt < this.policy.maxAttempts;
      switch (decision.action) {
        case 'add-cases':
          if (!decision.cases?.length)
            throw new HarnessError('INVALID_INPUT', 'add-cases без случаев');
          r.status = 'applying';
          break;
        case 'new-approach':
          if (!decision.hypothesis?.trim() || !decision.plan?.trim())
            throw new HarnessError(
              'INVALID_INPUT',
              'Новый подход требует гипотезы и плана проверки',
            );
          r.status = retryable ? 'retry' : 'awaiting-user';
          if (!retryable) r.reason = 'Попытки исчерпаны: повтор с новой гипотезой невозможен.';
          break;
        case 'strengthen-checker':
        case 'split-task':
          if (!decision.proposal?.trim())
            throw new HarnessError('INVALID_INPUT', 'Предложение для обычного ревью обязательно');
          r.status = 'stopped';
          r.reason = `Подготовлено предложение (${decision.action}); оно проходит обычное ревью или перепланирование и автоматически не применяется.`;
          break;
        case 'clarify-obligation':
          r.status = 'awaiting-user';
          r.reason = `Нужно решение человека: ${decision.conflict ?? decision.reason}`;
          break;
        case 'environment':
          r.status = 'stopped';
          r.reason = `Причина в среде или не установлена: ${decision.reason}`;
          break;
      }
      return 'decided';
    });
  }

  /** Итог добавления случаев: подтверждённый случай разрешает один повтор. */
  recoveryApplied(
    workId: string,
    recoveryId: string,
    outcomes: { outcome: string; reason: string }[],
  ) {
    return this.episode('recovery.applied', workId, recoveryId, (r, w) => {
      if (r.status !== 'applying')
        throw new HarnessError('NOT_READY', 'Эпизод не исполняет добавление случаев');
      const confirmed = outcomes.filter((o) => o.outcome === 'confirmed').length;
      if (confirmed && w.attempt < this.policy.maxAttempts) {
        r.status = 'retry';
        r.reason = `${confirmed} из ${ruCount(outcomes.length, RU.caseGen)} подтверждено`;
      } else {
        r.status = 'stopped';
        r.reason = confirmed
          ? 'Случаи подтверждены, но попытки поручения исчерпаны.'
          : 'Ни один предложенный случай не подтверждён эталоном: ' +
            outcomes
              .map((o) => o.reason)
              .join('; ')
              .slice(0, 800);
      }
      return 'applied';
    });
  }

  /** Разбор прервался без решения: вызов учтён, повтор не бесплатен. */
  recoveryInterrupted(workId: string, recoveryId: string, reason: string) {
    return this.episode('recovery.interrupted', workId, recoveryId, (r) => {
      if (!['analyzing', 'applying'].includes(r.status)) return undefined;
      r.status = 'awaiting-user';
      r.reason = reason.slice(0, 1000);
      return 'interrupted';
    });
  }

  /* ---------------------------------------------------------------- */
  /* Применённая политика и операция reconfigure                       */
  /* ---------------------------------------------------------------- */

  /**
   * Применённая политика в хранилище — единственный источник правды; у
   * процесса нет своего «поколения», которое мог бы рассинхронизировать
   * откат транзакции. Процесс текущий, только если его политика совпадает с
   * применённой. Записать свою вместо применённой (перезапуск с другой
   * политикой) он может, только если нет живого чужого controller, политика
   * не менялась в памяти после создания движка, её источник не менялся с
   * загрузки и после запуска процесса никто не применил другую: поколение
   * считается по записям, а не по часам.
   */
  private mayAdopt(view: ExecutionView): string | undefined {
    const lease = view.controller();
    if (lease && lease.leaseUntil > this.now() && !this.mine(lease, this.ownLeader))
      return `работает controller ${lease.owner} с другой политикой`;
    if (policyDigest(this.policy) !== this.loadedContent)
      return 'политика изменена в памяти после загрузки';
    const applied = view.control().appliedPolicy;
    if (applied && (applied.generation ?? 0) !== this.observedGeneration)
      return `после запуска процесса применена политика поколения ${applied.generation ?? 0}`;
    return this.provenance();
  }

  private adoptPolicy(tx: ExecutionTransaction, by: string, operation?: string) {
    const control = tx.control();
    const generation = (control.appliedPolicy?.generation ?? 0) + 1;
    const limits = budgetLimitsOf(this.policy);
    tx.setControl({
      ...control,
      appliedPolicy: { digest: this.loadedPolicy, generation, at: iso(this.now()), by, limits },
    });
    // Поднятые пределы бюджета — решение о бюджете: запись в журнале с
    // прежним и новым значением (0.1.0-alpha.68). Без записанных пределов
    // прежнего применения (до alpha.68) сравнивать не с чем.
    const before = control.appliedPolicy?.limits;
    if (before) {
      const changes = budgetRaises(before, limits);
      if (changes.length)
        tx.emit({
          type: 'budget.raised',
          payload: { by, generation, policyDigest: executionDigest(this.policy), changes },
        });
    }
    tx.emit({
      type: 'policy.applied',
      payload: {
        digest: this.loadedPolicy,
        generation,
        by,
        ...(operation ? { operation } : {}),
      },
    });
  }

  /** Почему процесс не вправе действовать под своей политикой; `undefined` — вправе. */
  private staleReason(view: ExecutionView): string | undefined {
    const applied = view.control().appliedPolicy;
    if (!applied || applied.digest === this.loadedPolicy) return undefined;
    const refusal = this.mayAdopt(view);
    return refusal
      ? `Процесс работает не с применённой политикой (${refusal}); перезапустите его`
      : undefined;
  }
  private policyStale(tx: ExecutionTransaction) {
    try {
      this.assertCurrentPolicy(tx);
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Общий барьер: в транзакциях выдачи, согласования, приёмки и совместной
   * проверки процесс сверяет свою политику с применённой. Первый процесс,
   * действующий после законной смены политики без живого controller,
   * записывает свою как применённую в той же транзакции — откат отменит и её.
   */
  assertCurrentPolicy(tx: ExecutionTransaction) {
    const applied = tx.control().appliedPolicy;
    if (!applied || applied.digest === this.loadedPolicy) return;
    const stale = this.staleReason(tx);
    if (stale) throw new HarnessError('APPROVAL_STALE', stale);
    this.adoptPolicy(tx, 'process');
  }

  /**
   * Запуск controller записывает его политику применённой, если её ещё нет
   * или процесс вправе её сменить. Неприменённый запрос операции остаётся.
   * Хост с `recordPolicyOnLead: false` вызывает это сам при запуске controller.
   */
  /**
   * Журнал ведущего (0.1.0-alpha.66): прочитать и заменить запись `lead`
   * одной транзакцией `lead.recorded`. `fn` получает прежнюю запись (нет —
   * пустая), часы движка и вид той же транзакции; событий журнала нет.
   */
  recordLead<T>(
    fn: (log: LeadLog, now: number, view: ExecutionView) => { log: LeadLog; result: NotPromise<T> },
  ): T {
    return this.tx('lead.recorded', (tx) => {
      this.assertNoUpdate(tx);
      const prev = tx.local('lead', WORKSPACE_OWNER, 'log') ?? { entries: [] };
      const { log, result } = fn(prev, this.now(), tx);
      tx.putLocal('lead', WORKSPACE_OWNER, 'log', log);
      return result;
    });
  }

  /**
   * План выпуска ведущего (alpha.68): одна локальная запись `release-outline`
   * у `@workspace`; `fn` получает прежний план и решает, что записать
   * (`outline: undefined` — ничего не менять).
   */
  recordReleaseOutline<T>(
    fn: (
      prev: ReleaseOutline | undefined,
      now: number,
      view: ExecutionView,
    ) => { outline?: ReleaseOutline; result: NotPromise<T> },
  ): T {
    return this.tx('lead.recorded', (tx) => {
      this.assertNoUpdate(tx);
      const prev = tx.local('release-outline', WORKSPACE_OWNER, 'outline');
      const { outline, result } = fn(prev, this.now(), tx);
      if (outline) tx.putLocal('release-outline', WORKSPACE_OWNER, 'outline', outline);
      return result;
    });
  }

  recordPolicy(owner: string) {
    this.tx('config.started', (tx) => {
      const lease = tx.controller();
      if (!this.mine(lease, owner)) return;
      const control = tx.control();
      const applied = control.appliedPolicy;
      if (applied?.digest === this.loadedPolicy) {
        // Состояние прежней версии: пределы применённой политики ещё не
        // записаны — записываются при первом запуске controller, чтобы
        // первый подъём после обновления попал в журнал (`budget.raised`).
        if (!applied.limits)
          tx.setControl({
            ...control,
            appliedPolicy: { ...applied, limits: budgetLimitsOf(this.policy) },
          });
        return;
      }
      if (applied && this.mayAdopt(tx)) return;
      this.adoptPolicy(tx, owner);
    });
  }

  private reconfiguring(view: ExecutionView) {
    const request = view.control().reconfigure;
    return request && !request.appliedAt ? request : undefined;
  }

  /** Сведения о политике процесса и применённой. */
  policyState() {
    return this.read((v) => ({
      loaded: this.loadedPolicy,
      ...(v.control().appliedPolicy ? { applied: v.control().appliedPolicy } : {}),
      ...(v.control().reconfigure ? { reconfigure: v.control().reconfigure } : {}),
      ...(this.staleReason(v) ? { stale: this.staleReason(v) } : {}),
    }));
  }

  /**
   * Пауза операции: ставится, только если очередь не остановлена, и
   * помечается операцией. Пауза человека не перезаписывается.
   */
  operationPause(operation: string) {
    return this.tx('scheduler.paused', (tx) => {
      // Пауза другой операции (применение политики) во время обновления не
      // ставится: следом её запрос отказал бы, и пауза осталась бы без него.
      if (operation !== UPDATE_PAUSE_OPERATION) this.assertNoUpdate(tx);
      const control = tx.control();
      if (control.paused) return false;
      tx.setControl({
        ...control,
        paused: true,
        pauseReason: 'reconfigure',
        pauseOperation: operation,
        pausedAt: iso(this.now()),
      });
      tx.emit({ type: 'control.paused', payload: { reason: 'reconfigure' } });
      return true;
    });
  }

  /**
   * Запись о смене пакетов harness и панели (`harness update`): одно событие
   * `harness.updated` в журнале; состояние модели не меняется.
   */
  recordUpdate(payload: RunEventPayload<'harness.updated'>) {
    this.tx('harness.updated', (tx) => {
      tx.emit({ type: 'harness.updated', payload });
    });
  }

  /**
   * Сверка записи окружения smoke (`harness cleanup LS-…`, alpha.67): событие
   * `environment.reconciled` в журнале; состояние модели не меняется.
   */
  recordEnvironmentReconciled(runId: string, payload: RunEventPayload<'environment.reconciled'>) {
    this.tx('environment.reconciled', (tx) => {
      tx.emit({ type: 'environment.reconciled', runId, payload });
    });
  }

  /** Снять паузу операции — только свою; паузу человека она не трогает. */
  operationResume(operation: string) {
    return this.tx('scheduler.started', (tx) => {
      const control = tx.control();
      if (
        !control.paused ||
        control.pauseReason !== 'reconfigure' ||
        control.pauseOperation !== operation
      )
        return false;
      tx.setControl({
        ...control,
        paused: false,
        pauseReason: undefined,
        pauseOperation: undefined,
        pausedAt: undefined,
      });
      tx.emit({ type: 'control.resumed', payload: { reason: 'reconfigure' } });
      return true;
    });
  }

  /**
   * Запросить применение политики с ожидаемым digest (`policyDigest`
   * загруженной политики). Идемпотентно; повтор той же операцией сбрасывает
   * прежний отказ — политику могли исправить. Пока запрос не применён, новые
   * попытки не выдаются.
   */
  requestReconfigure(operation: string, digest: string) {
    return this.tx('config.reconfigure-requested', (tx) => {
      this.assertNoUpdate(tx);
      const control = tx.control();
      const current = control.reconfigure;
      if (current && current.operation === operation && current.digest === digest) {
        if (!current.error) return { operation, digest, changed: false };
        tx.setControl({ ...control, reconfigure: { ...current, error: undefined } });
        tx.emit({
          type: 'policy.reconfigure',
          payload: { operation, digest, status: 'requested' },
        });
        return { operation, digest, changed: true, retried: true };
      }
      if (current && current.operation !== operation && !current.appliedAt)
        throw new HarnessError(
          'NOT_READY',
          `Политику уже применяет операция ${current.operation}; дождитесь её`,
        );
      tx.setControl({
        ...control,
        reconfigure: { operation, digest, requestedAt: iso(this.now()) },
      });
      tx.emit({ type: 'policy.reconfigure', payload: { operation, digest, status: 'requested' } });
      return { operation, digest, changed: true };
    });
  }

  /**
   * Работы, идущие под действующей политикой. Запись с истёкшим сроком не
   * держит применение: её результат и так не будет принят (владение
   * проверяется при каждой записи), а держать применение из-за неё значило
   * бы ждать вечно.
   */
  busyWork(view: ExecutionView) {
    const now = this.now();
    return [
      ...view
        .attempts()
        .filter((a) => a.status === 'active' && a.leaseUntil > now)
        .map((a) => a.id),
      ...view
        .verifications()
        .filter((v) => v.status === 'active' && v.leaseUntil > now)
        .map((v) => v.id),
      ...view
        .locals('workflow-jobs')
        .filter((j) => j.value.status === 'running' && (j.value.leaseUntil ?? 0) > now)
        .map((j) => j.key),
      ...view.locals('check-suites').flatMap(({ value }) =>
        Object.values(value.operations)
          .filter((op) => op.status === 'running' && (op.leaseUntil ?? 0) > now)
          .map((op) => `${value.id}:${op.key}`),
      ),
      ...(this.host.guards.busy?.(view) ?? []),
    ];
  }

  /**
   * Применить запрос этим процессом: только если его политика — ровно
   * ожидаемая и работ под прежней не осталось. Политика другого digest —
   * отказ с обоими digest (повтор операции его сбросит). Применение и снятие
   * паузы операции — одна транзакция.
   */
  applyReconfigure(
    by: string,
  ):
    | { status: 'none' }
    | { status: 'busy'; busy: string[] }
    | { status: 'waiting'; expected: string }
    | { status: 'failed'; error: string }
    | { status: 'applied'; generation: number } {
    return this.tx('config.reconfigured', (tx) => {
      const control = tx.control();
      const request = control.reconfigure;
      if (!request || request.appliedAt || request.error) return { status: 'none' as const };
      const busy = this.busyWork(tx);
      if (busy.length) return { status: 'busy' as const, busy };
      if (request.digest !== this.loadedPolicy) {
        const error = `Политика не совпадает с ожидаемой операцией: ожидался digest ${request.digest.slice(0, 16)}, загружен ${this.loadedPolicy.slice(0, 16)}`;
        tx.setControl({ ...control, reconfigure: { ...request, error } });
        tx.emit({
          type: 'policy.reconfigure',
          payload: {
            operation: request.operation,
            digest: request.digest,
            status: 'failed',
            error,
          },
        });
        return { status: 'failed' as const, error };
      }
      const generation = (control.appliedPolicy?.generation ?? 0) + 1;
      const at = iso(this.now());
      const resume =
        control.paused &&
        control.pauseReason === 'reconfigure' &&
        control.pauseOperation === request.operation;
      tx.setControl({
        ...control,
        reconfigure: { ...request, appliedAt: at, appliedBy: by, error: undefined },
        appliedPolicy: {
          digest: request.digest,
          generation,
          at,
          by,
          limits: budgetLimitsOf(this.policy),
        },
        ...(resume
          ? {
              paused: false,
              pauseReason: undefined,
              pauseOperation: undefined,
              pausedAt: undefined,
            }
          : {}),
      });
      tx.emit({
        type: 'policy.applied',
        payload: { digest: request.digest, generation, by, operation: request.operation },
      });
      // Поднятые пределы бюджета — запись решения о бюджете (как при запуске).
      const before = control.appliedPolicy?.limits;
      const raises = before ? budgetRaises(before, budgetLimitsOf(this.policy)) : [];
      if (raises.length)
        tx.emit({
          type: 'budget.raised',
          payload: { by, generation, policyDigest: executionDigest(this.policy), changes: raises },
        });
      if (resume) tx.emit({ type: 'control.resumed', payload: { reason: 'reconfigure' } });
      return { status: 'applied' as const, generation };
    });
  }

  /**
   * Процесс, работающий с прежней политикой, применить запрос не может: он
   * ждёт перезапуска с ожидаемой. Такой процесс применение не отклоняет.
   */
  /**
   * Применит ли этот процесс ожидающий запрос политики при следующем шаге —
   * те же условия, что у `serveReconfigure`/`applyReconfigure`. Только чтение.
   */
  reconfigureApplies(view: ExecutionView) {
    const request = this.reconfiguring(view);
    return Boolean(
      request &&
      !request.error &&
      request.digest === this.loadedPolicy &&
      this.busyWork(view).length === 0,
    );
  }

  serveReconfigure(by: string) {
    const request = this.read((v) => this.reconfiguring(v));
    if (!request || request.error || request.digest !== this.loadedPolicy)
      return { status: 'none' as const };
    return this.applyReconfigure(by);
  }

  /**
   * Записать отказ применения с причиной хоста (например, файл политики не
   * читается или не совпадает с ожидаемым). Только для неприменённого запроса
   * той же операции и digest; повтор операции сбрасывает отказ.
   */
  rejectReconfigure(operation: string, digest: string, error: string) {
    return this.tx('config.reconfigured', (tx) => {
      const control = tx.control();
      const request = control.reconfigure;
      if (!request || request.operation !== operation || request.digest !== digest) return false;
      if (request.appliedAt) return false;
      const message = error.slice(0, 4000) || 'Политика не применена';
      tx.setControl({ ...control, reconfigure: { ...request, error: message } });
      tx.emit({
        type: 'policy.reconfigure',
        payload: { operation, digest, status: 'failed', error: message },
      });
      return true;
    });
  }

  /** Снять завершённый или отменённый запрос операции. */
  clearReconfigure(operation: string) {
    return this.tx('config.reconfigure-cleared', (tx) => {
      const control = tx.control();
      if (control.reconfigure?.operation !== operation) return false;
      tx.setControl({ ...control, reconfigure: undefined });
      tx.emit({
        type: 'policy.reconfigure',
        payload: { operation, digest: control.reconfigure.digest, status: 'cleared' },
      });
      return true;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Удержания операций                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Удержать поручения от выдачи на время операции. Поручение, удерживаемое
   * другой операцией, — конфликт: две операции не меняют одно поручение
   * одновременно. Повтор той же операции ничего не меняет. `fence` —
   * проверка владения операцией в той же транзакции: утративший владение
   * ничего не пишет.
   */
  hold(ids: string[], operation: string, reason: string, fence?: (view: ExecutionView) => void) {
    return this.tx('task.held', (tx) => {
      fence?.(tx);
      const works = ids.map((id) => {
        const w = tx.work(id);
        if (!w) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + id);
        return w;
      });
      const busy = works.filter((w) => w.hold && w.hold.operation !== operation);
      if (busy.length)
        throw new HarnessError(
          'NOT_READY',
          'Поручения удерживает другая операция: ' +
            busy.map((w) => `${w.id} (${w.hold!.operation})`).join(', '),
        );
      for (const w of works) {
        if (w.hold?.operation === operation && w.hold.reason === reason) continue;
        tx.putWork({ ...w, hold: { operation, reason } });
        tx.emit({
          type: 'work.held',
          graphId: w.graphId,
          workId: w.id,
          payload: { operation, reason, released: false },
        });
      }
      return works.map((w) => w.id);
    });
  }

  /** Снять удержание операции — со всех или с перечисленных поручений; чужие не трогаются. */
  releaseHold(operation: string, ids?: string[], fence?: (view: ExecutionView) => void) {
    return this.tx('task.released', (tx) => {
      fence?.(tx);
      const released = tx
        .works()
        .filter((w) => w.hold?.operation === operation && (!ids || ids.includes(w.id)));
      for (const w of released) {
        tx.putWork({ ...w, hold: undefined });
        tx.emit({
          type: 'work.held',
          graphId: w.graphId,
          workId: w.id,
          payload: { operation, reason: w.hold!.reason, released: true },
        });
      }
      return released.map((w) => w.id);
    });
  }

  /** Передать удержание от одной операции другой без окна выдачи. */
  transferHold(from: string, to: string, reason: string, fence?: (view: ExecutionView) => void) {
    return this.tx('task.hold-transferred', (tx) => {
      fence?.(tx);
      const moved = tx.works().filter((w) => w.hold?.operation === from);
      for (const w of moved) {
        tx.putWork({ ...w, hold: { operation: to, reason } });
        tx.emit({
          type: 'work.held',
          graphId: w.graphId,
          workId: w.id,
          payload: { operation: to, reason, released: false },
        });
      }
      return moved.map((w) => w.id);
    });
  }

  /** Попытки, ещё владеющие поручениями (живой срок): операция ждёт их окончания. */
  activeAttempts(workIds?: string[]) {
    return this.read((v) =>
      v
        .attempts()
        .filter(
          (a) =>
            a.status === 'active' &&
            a.leaseUntil > this.now() &&
            (!workIds || workIds.includes(a.workId)),
        )
        .map((a) => ({ id: a.id, workId: a.workId, leaseUntil: a.leaseUntil })),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Совместная проверка комбинации репозиториев                       */
  /* ---------------------------------------------------------------- */

  /** Digest политики совместной проверки: формула хоста, если он её задаёт. */
  private jointPolicy(view: ExecutionView) {
    return this.host.basis.jointPolicyDigest?.(view) ?? jointPolicyDigest(this.policy);
  }

  /** Основание совместной проверки набора: формула хоста, если он её задаёт. */
  private jointSpec(view: ExecutionView, workIds: string[], verificationId?: string) {
    return (
      this.host.basis.jointSpecDigest?.(workIds, view, verificationId) ??
      jointSpecDigest(view, workIds)
    );
  }

  private liveJoint(view: ExecutionView) {
    return view.verifications().some((v) => v.status === 'active' && v.leaseUntil > this.now());
  }

  /**
   * Начать совместную проверку набора принятых поручений. Нужны gates уровня
   * workspace с JUnit, у каждого продуктового репозитория — свой; идущих
   * попыток и другой живой проверки быть не должно; истёкшая проверка
   * закрывается отказом. `baseline` — успешная проверка, которую хост принял
   * (для режима `affected`).
   */
  jointStart(input: { workIds: string[]; baseline?: string }): JointVerificationState {
    const gates = this.policy.workspaceGates;
    if (!gates.some((g) => g.kind === 'test' && g.report))
      throw new HarnessError(
        'INVALID_INPUT',
        'Настройте обязательные gates совместной проверки (workspaceGates) с JUnit',
      );
    for (const repo of this.policy.repositories.filter((r) => r.kind === 'product'))
      if (!gates.some((g) => g.repositoryId === repo.id && g.kind === 'test' && g.report))
        throw new HarnessError('INVALID_INPUT', `Нужна совместная проверка продукта ${repo.id}`);
    if (!input.workIds.length || new Set(input.workIds).size !== input.workIds.length)
      throw new HarnessError('INVALID_INPUT', 'Нужен непустой набор разных поручений');
    return this.tx('workspace.verification.started', (tx) => {
      this.assertCurrentPolicy(tx);
      this.assertNoUpdate(tx);
      const reconfigure = this.reconfiguring(tx);
      if (reconfigure)
        throw new HarnessError(
          'NOT_READY',
          `Операция ${reconfigure.operation} применяет политику; дождитесь её`,
        );
      if (tx.attempts().some((a) => a.status === 'active' && a.leaseUntil > this.now()))
        throw new HarnessError('NOT_READY', 'Дождитесь текущих попыток перед совместной проверкой');
      for (const v of tx.verifications()) {
        if (v.status !== 'active') continue;
        if (v.leaseUntil > this.now())
          throw new HarnessError('NOT_READY', 'Совместная проверка уже выполняется');
        this.closeExpiredJoint(tx, v);
      }
      const exhausted = this.jointExhausted(tx, input.workIds);
      if (exhausted) throw new HarnessError('ATTEMPTS_EXHAUSTED', exhausted);
      const works = input.workIds.map((id) => tx.work(id));
      if (works.some((w) => !w || w.status !== 'done' || !w.resultSha))
        throw new HarnessError('NOT_READY', 'Сначала завершите все поручения набора');
      if (input.baseline && tx.verification(input.baseline)?.status !== 'passed')
        throw new HarnessError('INVALID_INPUT', 'Базовая проверка не найдена или не успешна');
      const at = this.now();
      const v: JointVerificationState = {
        apiVersion: 'devcontour-harness/v1alpha1',
        id: this.id(),
        token: this.id() + this.id(),
        engineVersion: this.version,
        startedAt: iso(at),
        leaseUntil: at + this.policy.leaseMs,
        status: 'active',
        policyDigest: this.jointPolicy(tx),
        specDigest: this.jointSpec(tx, input.workIds),
        workIds: [...input.workIds],
        ...(input.baseline
          ? {
              impact: {
                changed: [],
                affected: [],
                gateIds: [],
                mode: 'all' as const,
                reason: 'manifest ещё не закреплён',
                baseline: input.baseline,
              },
            }
          : {}),
        evidence: [],
      };
      tx.putVerification(v);
      tx.emit({
        type: 'joint.started',
        payload: { verificationId: v.id, workIds: v.workIds, policyDigest: v.policyDigest },
      });
      return v;
    });
  }

  /**
   * Fencing совместной проверки: активна, токен её, срок не истёк, политика
   * и основание (поручения, их постановки и результаты) не изменились.
   */
  private jointUpdate<T>(
    id: string,
    token: string,
    kind: TransactionKind,
    fn: (v: JointVerificationState, tx: ExecutionTransaction) => NotPromise<T>,
  ): T {
    return this.tx(kind, (tx) => {
      if (kind !== 'heartbeat') this.assertCurrentPolicy(tx);
      const v = tx.verification(id);
      if (!v || v.status !== 'active' || v.token !== token || v.leaseUntil <= this.now())
        throw new HarnessError('LEASE_STALE', 'Устаревшая попытка совместной проверки');
      if (v.engineVersion !== this.version)
        throw new HarnessError(
          'LEASE_STALE',
          `Совместную проверку начал движок ${v.engineVersion ?? 'прежней версии'}, а работает ${this.version}: нужна новая проверка`,
        );

      if (
        v.policyDigest !== this.jointPolicy(tx) ||
        v.specDigest !== this.jointSpec(tx, v.workIds, v.id)
      )
        throw new HarnessError(
          'APPROVAL_STALE',
          'Состав набора или политика изменились; нужна новая проверка',
        );
      const out = fn(v, tx);
      // Продуктовые условия хоста — на состоянии после записи (закреплённый
      // manifest, итог): отказ откатывает всю запись.
      if (kind !== 'heartbeat') {
        const after = tx.verification(id)!;
        const refusal = this.host.guards.joint?.(after, tx, kind);
        if (refusal) throw new HarnessError(refusal.code, refusal.message);
      }
      return out;
    });
  }

  jointHeartbeat(id: string, token: string) {
    this.jointUpdate(id, token, 'heartbeat', (v, tx) =>
      tx.putVerification({ ...v, leaseUntil: this.now() + this.policy.leaseMs }),
    );
  }

  /**
   * Закрепить manifest: SHA и tree каждого репозитория политики. Закрепляется
   * один раз; по нему же выбирается область проверки.
   */
  jointManifest(id: string, token: string, manifest: NonNullable<JointVerification['manifest']>) {
    return this.jointUpdate(id, token, 'workspace.manifest', (v, tx) => {
      if (v.manifest) throw new HarnessError('INVALID_INPUT', 'Manifest уже закреплён');
      const ids = this.policy.repositories.map((r) => r.id).sort();
      const sha = /^[a-f0-9]{40,64}$/;
      if (
        JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(ids) ||
        Object.values(manifest).some((m) => !sha.test(m.sha) || !sha.test(m.tree))
      )
        throw new HarnessError(
          'INVALID_INPUT',
          'Manifest должен фиксировать SHA и tree каждого репозитория',
        );
      const baseline = v.impact?.baseline ? tx.verification(v.impact.baseline) : undefined;
      const impact = jointImpact(this.policy, manifest, v.policyDigest, baseline);
      const next = { ...v, manifest, manifestDigest: digestOf(manifest), impact };
      tx.putVerification(next);
      return next;
    });
  }

  /** Переход живости совместной проверки (обход зависших): событие под её fencing. */
  jointLiveness(
    id: string,
    token: string,
    payload: Omit<RunEventPayload<'joint.liveness'>, 'verificationId'>,
  ) {
    this.jointUpdate(id, token, 'workspace.liveness', (_v, tx) => {
      tx.emit({ type: 'joint.liveness', payload: { verificationId: id, ...payload } });
    });
  }

  jointEvidence(id: string, token: string, evidence: JointVerification['evidence'][number]) {
    this.jointUpdate(id, token, 'workspace.evidence', (v, tx) => {
      if (!v.manifest) throw new HarnessError('NOT_READY', 'Нет закреплённого manifest');
      tx.putVerification({ ...v, evidence: [...v.evidence, evidence] });
    });
  }

  private jointMissing(v: JointVerificationState) {
    if (!v.manifest || digestOf(v.manifest) !== v.manifestDigest)
      return 'Нет закреплённого manifest';
    for (const gate of this.policy.workspaceGates.filter(
      (g) => !v.impact || v.impact.gateIds.includes(g.id),
    ))
      if (!v.evidence.findLast((e) => e.gate === gate.id)?.passed) return `Нет PASS: ${gate.id}`;
    return undefined;
  }

  jointFinish(id: string, token: string) {
    return this.jointUpdate(id, token, 'workspace.verified', (v, tx) => {
      const missing = this.jointMissing(v);
      if (missing) throw new HarnessError('GATE_FAILED', missing);
      const next: JointVerificationState = {
        ...v,
        status: 'passed',
        manifest: v.manifest!,
        manifestDigest: v.manifestDigest!,
        finishedAt: iso(this.now()),
      };
      tx.putVerification(next);
      tx.emit({
        type: 'joint.finished',
        payload: { verificationId: id, status: 'passed', manifestDigest: v.manifestDigest! },
      });
      return publicJoint(next);
    });
  }

  /**
   * Отказ проверки её владельцем; истёкший срок допустим, чужой токен — нет.
   * `interrupted` — проверку прервали остановка или потеря владения; движок
   * отмечает её прерванной только без evidence: результат gate тратит предел.
   */
  jointFail(id: string, token: string, error: string, options: { interrupted?: boolean } = {}) {
    return this.tx('workspace.failed', (tx) => {
      const v = tx.verification(id);
      if (!v || v.status !== 'active' || v.token !== token || v.engineVersion !== this.version)
        return false;
      const message = error.slice(0, 4000) || 'Совместная проверка не прошла';
      const interrupted =
        options.interrupted && v.evidence.length === 0 ? { interrupted: true as const } : {};
      tx.putVerification({
        ...v,
        status: 'failed',
        error: message,
        finishedAt: iso(this.now()),
        ...interrupted,
      });
      tx.emit({
        type: 'joint.finished',
        payload: { verificationId: id, status: 'failed', error: message, ...interrupted },
      });
      return true;
    });
  }

  /**
   * Закрыть истёкшую активную проверку отказом. Владение потеряно: без
   * evidence проверка прервана до результата gates, с evidence — обычный отказ.
   */
  private closeExpiredJoint(tx: ExecutionTransaction, v: JointVerificationState) {
    const error = 'Истёк срок владения проверкой';
    const interrupted = v.evidence.length === 0 ? { interrupted: true as const } : {};
    tx.putVerification({
      ...v,
      status: 'failed',
      error,
      finishedAt: iso(this.now()),
      ...interrupted,
    });
    tx.emit({
      type: 'joint.finished',
      payload: { verificationId: v.id, status: 'failed', error, ...interrupted },
    });
  }

  /**
   * Почему набор не может начать совместную проверку по бюджету, или
   * `undefined`. Предел тратят проверки с результатом gates и отказы до них;
   * прерванные до результата gates (`interrupted`) — только свой предел.
   */
  private jointExhausted(tx: ExecutionView, workIds: string[]) {
    const window = jointBudgetWindow(
      tx,
      workIds,
      this.host.basis.jointBudgetCheckpoints
        ? this.host.basis.jointBudgetCheckpoints([...workIds], tx)
        : [],
    );
    const interrupted = window.filter(jointInterrupted).length;
    const counted = window.length - interrupted;
    if (counted >= this.policy.maxAttempts)
      return `Исчерпан предел совместных проверок этого набора: ${counted} из ${this.policy.maxAttempts}. Не считаются только проверки, прерванные остановкой или потерей владения до результата gates. Предел снимает принятие хостом успешной проверки набора; явный сброс (jointBudgetReset) с причиной снимает только проверки без результата gates`;
    if (interrupted >= MAX_NEUTRAL_FAILURES)
      return `Совместные проверки этого набора прерваны до результата gates ${ruCount(interrupted, RU.time)} (предел ${MAX_NEUTRAL_FAILURES}): устраните причину остановок или потери владения и сбросьте бюджет явно (jointBudgetReset) с причиной`;
    return undefined;
  }

  /**
   * Явный сброс бюджета совместных проверок набора оператором или хостом:
   * только при исчерпанном пределе и без живой проверки этого набора, с
   * причиной. Сброс снимает только проверки набора без результата gates
   * (прерванные и отказы до gates, в том числе записанные прежними версиями);
   * проверки с evidence тратят предел и после сброса, поэтому предел,
   * исчерпанный ими одними, сброс не снимает. Истёкшая незакрытая проверка
   * набора закрывается здесь же (как в `jointStart`). Запись — в
   * `joint-budget-resets`, событие — `joint.budget-reset`.
   */
  jointBudgetReset(
    workIds: string[],
    options: { reason: string; actor?: JointResetActor },
  ): JointBudgetReset {
    const reason = options.reason?.trim() ?? '';
    if (!reason)
      throw new HarnessError('INVALID_INPUT', 'Сброс бюджета совместных проверок требует причины');
    if (!workIds.length || new Set(workIds).size !== workIds.length)
      throw new HarnessError('INVALID_INPUT', 'Нужен непустой набор разных поручений');
    return this.tx('workspace.budget-reset', (tx) => {
      for (const v of tx.verifications()) {
        if (v.status !== 'active' || !sameWorks(v.workIds, workIds)) continue;
        if (v.leaseUntil > this.now())
          throw new HarnessError('NOT_READY', 'Совместная проверка этого набора ещё выполняется');
        this.closeExpiredJoint(tx, v);
      }
      if (!this.jointExhausted(tx, workIds))
        throw new HarnessError(
          'NOT_READY',
          'Предел совместных проверок этого набора не исчерпан; сброс не нужен',
        );
      const window = jointBudgetWindow(
        tx,
        workIds,
        this.host.basis.jointBudgetCheckpoints
          ? this.host.basis.jointBudgetCheckpoints([...workIds], tx)
          : [],
      );
      const gated = window.filter((v) => v.evidence.length > 0).length;
      if (gated >= this.policy.maxAttempts)
        throw new HarnessError(
          'ATTEMPTS_EXHAUSTED',
          `Предел совместных проверок этого набора исчерпан проверками с результатом gates: ${gated} из ${this.policy.maxAttempts}. Сброс снимает только проверки без результата gates; дальше — принятие хостом успешной проверки или новый набор`,
        );
      const settled = window.filter((v) => v.status === 'failed' && v.evidence.length === 0);
      // Успешная проверка без принятия (и без evidence) сбросом не снимается:
      // сброс, после которого набор всё равно исчерпан, не записывается. Пустой
      // снимок сюда же: предел исчерпан, значит, остаток — весь предел.
      const remaining = window.length - settled.length;
      if (remaining >= this.policy.maxAttempts)
        throw new HarnessError(
          'ATTEMPTS_EXHAUSTED',
          `Сброс не освобождает предел совместных проверок этого набора: снимаются только отказы без результата gates (${settled.length}), а остальные проверки (${remaining}, в том числе успешные без принятия) тратят ${remaining} из ${this.policy.maxAttempts}; дальше — принятие хостом успешной проверки или новый набор`,
        );
      const record: JointBudgetReset = {
        id: this.id(),
        at: iso(this.now()),
        workIds: [...workIds].sort(),
        reason: reason.slice(0, 2000),
        actor: options.actor ?? 'host',
        settledVerificationIds: settled.map((v) => v.id),
      };
      tx.putLocal('joint-budget-resets', WORKSPACE_OWNER, record.id, record);
      tx.emit({
        type: 'joint.budget-reset',
        payload: {
          resetId: record.id,
          workIds: record.workIds,
          by: record.actor,
          settled: record.settledVerificationIds.length,
          reasonLength: record.reason.length,
        },
      });
      return record;
    });
  }

  /**
   * Актуальный результат совместной проверки набора: последняя проверка этого
   * набора, успешная, с целым manifest, под текущей политикой, на неизменном
   * основании, с PASS каждого gate своей области. Иначе — причина; прежний
   * результат как актуальный не выдаётся.
   */
  jointResult(
    workIds: string[],
    /** Оценить эту проверку набора, а не последнюю (хост выбирает её сам). */
    verificationId?: string,
  ): {
    verification?: JointVerification;
    current: boolean;
    reason?: string;
  } {
    return this.read((v) => {
      const last = verificationId
        ? v.verification(verificationId)
        : v
            .verifications()
            .filter((x) => sameWorks(x.workIds, workIds))
            .at(-1);
      if (last && !sameWorks(last.workIds, workIds))
        return { current: false, reason: 'Проверка относится к другому набору' };
      if (!last) return { current: false, reason: 'Совместной проверки этого набора нет' };
      const verification = publicJoint(last);
      const reason =
        last.status !== 'passed'
          ? `Последняя проверка: ${last.status}${last.status === 'failed' ? ' — ' + last.error : ''}`
          : last.policyDigest !== this.jointPolicy(v)
            ? 'Политика совместной проверки изменилась'
            : last.specDigest !== this.jointSpec(v, last.workIds, last.id)
              ? 'Поручения набора или их результаты изменились'
              : this.jointMissing(last);
      return reason ? { verification, current: false, reason } : { verification, current: true };
    });
  }

  /** Истёкшие попытки: отказ окружения, работа ждёт явного повтора. */
  /**
   * Истечение владения на момент `at` (по умолчанию — сейчас). Хост передаёт
   * момент в будущем, когда снимает всё владение восстановленной копии.
   */
  expire(at = this.now()) {
    // Такт очереди вызывает истечение постоянно: без истёкших попыток
    // транзакции записи (и её снимка состояния) нет.
    if (!this.read((v) => activeOf(v).some((a) => a.leaseUntil <= at))) return [];
    return this.tx('runs.expired', (tx) => {
      const ids: string[] = [];
      for (const a of activeOf(tx))
        if (a.status === 'active' && a.leaseUntil <= at) {
          const error =
            (a.error?.startsWith(HEARTBEAT_FAILED) ? a.error + '. ' : '') +
            'Истёк срок владения. Повторите явно.';
          const fingerprint = failureFingerprint('environment', error);
          tx.putAttempt({
            ...a,
            status: 'expired',
            finishedAt: iso(this.now()),
            error,
            failureKind: 'environment',
            failureFingerprint: fingerprint,
          });
          const w = tx.work(a.workId)!;
          if (w.activeRunId === a.id)
            tx.putWork({
              ...w,
              status: 'failed',
              failure: error,
              failureKind: 'environment',
              failureFingerprint: fingerprint,
              activeRunId: undefined,
              // Владение истекло не по вине кода: попытка не засчитывается,
              // но предел незасчитанных отказов тратится.
              attempt: w.attempt > 0 ? w.attempt - 1 : w.attempt,
              neutralFailures: (w.neutralFailures ?? 0) + 1,
            });
          tx.emit({
            type: 'attempt.expired',
            workId: a.workId,
            runId: a.id,
            attempt: a.attempt,
            payload: { leaseUntil: a.leaseUntil },
          });
          tx.emit({
            type: 'attempt.diagnosed',
            graphId: w.graphId,
            workId: a.workId,
            runId: a.id,
            attempt: a.attempt,
            payload: { failureKind: 'environment', cause: 'lease-expired', counted: false },
          });
          ids.push(a.id);
        }
      return ids;
    });
  }

  /** Восстановление: новый владелец истёкшей активной попытки получает новый токен. Старый токен недействителен. */
  adopt(id: string, owner: string): AttemptState {
    return this.tx('run.recovered', (tx) => {
      const a = tx.attempt(id);
      if (!a) throw new HarnessError('NOT_FOUND', 'Попытка не найдена: ' + id);
      if (a.status !== 'active' || a.leaseUntil > this.now())
        throw new HarnessError('LEASE_STALE', 'Попытка ещё принадлежит владельцу');
      // Новое владение — под этим движком: дальше попытку ведёт он (и только он).
      const adopted = {
        ...a,
        token: this.id() + this.id(),
        owner,
        engineVersion: this.version,
        leaseUntil: this.now() + this.policy.leaseMs,
      };
      tx.putAttempt(adopted);
      return adopted;
    });
  }

  /** Recovery отклонил продолжение: попытка истечёт на следующем `expire`. */
  rejectRecovery(id: string, reason: string) {
    return this.tx('recovery.rejected', (tx) => {
      const a = tx.attempt(id);
      if (a?.status !== 'active') return false;
      tx.putAttempt({ ...a, leaseUntil: 0 });
      if (a.integrationSha)
        tx.emit({
          type: 'attempt.recovered',
          workId: a.workId,
          runId: a.id,
          attempt: a.attempt,
          payload: {
            integrationSha: a.integrationSha,
            accepted: false,
            reason: reason.slice(0, 4000),
          },
        });
      return true;
    });
  }

  /**
   * Отмена: активная попытка теряет владение, поручение — cancelled. Принятое
   * не отменяется. `by` — кто отменил (`work.cancelled`): CLI — `operator`,
   * хост, не назвавший актёра, — `host`.
   */
  cancel(
    workId: string,
    reason = 'отменено оператором',
    by: CancelActor = 'host',
  ): { work: WorkState; changed: boolean; abandoned?: true } {
    return this.tx('task.cancelled', (tx) => {
      this.assertNoUpdate(tx);
      const w = tx.work(workId);
      if (!w) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + workId);
      if (w.status === 'done')
        throw new HarnessError('NOT_READY', 'Принятый результат не отменяется');
      // Отмена открытой доработки принятой работы — «вернуться к принятому»,
      // а не «задача отменена»: принятое не отменяется (0.1.0-alpha.66).
      // Доработка, отменённая прежней версией (`cancelled` с открытой
      // доработкой), так же возвращается к принятой редакции.
      if (openRework(w) || (w.status === 'cancelled' && w.rework && !w.rework.abandoned))
        return { work: this.abandonReworkIn(tx, w, by), changed: true, abandoned: true as const };
      if (w.status === 'cancelled') return { work: w, changed: false };
      const a = w.activeRunId ? tx.attempt(w.activeRunId) : undefined;
      if (a) {
        tx.putAttempt({
          ...a,
          status: 'cancelled',
          finishedAt: iso(this.now()),
          failureKind: 'cancelled',
        });
        tx.emit({
          type: 'attempt.cancelled',
          workId,
          runId: a.id,
          attempt: a.attempt,
          payload: { reason: reason.slice(0, 4000) },
        });
      }
      const next: WorkState = {
        ...w,
        status: 'cancelled',
        activeRunId: undefined,
        failureKind: 'cancelled',
      };
      tx.putWork(next);
      // Отмена работы закрывает её вопросы: поздний ответ работу не возобновит.
      this.closeRequestsOf(tx, w, by === 'graph' ? 'controller' : by);
      tx.emit({
        type: 'work.cancelled',
        graphId: w.graphId,
        workId,
        ...(a ? { runId: a.id, attempt: a.attempt } : {}),
        payload: { by, hadAttempt: Boolean(a) },
      });
      return { work: next, changed: true };
    });
  }

  /**
   * Повтор неуспешного или отменённого поручения. Пока попытки не
   * исчерпаны — без сброса; исчерпаны — только явный сброс с причиной.
   * Класс и отпечаток прошлого отказа снимаются. `by` — кто повторил
   * (`work.retried`): CLI — `operator`, восстановление очереди — `recovery`,
   * хост, не назвавший актёра, — `host`.
   */
  retry(workId: string, reset?: RetryReset, by: RetryActor = 'host') {
    const result = this.tx('task.retry', (tx) => {
      this.assertNoUpdate(tx);
      const w = tx.work(workId);
      if (!w) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + workId);
      return this.retryIn(tx, w, reset, by);
    });
    // Повтор ведущего снял удержание gate, а сам повтор отклонён (например,
    // исчерпан предел): снятие записано, отказ сообщается с ним.
    if (result.refused)
      throw new HarnessError(
        result.refused.code,
        `${result.refused.message}. Удержание gate ${result.gateHoldLifted} снято: работы с этим gate снова выдаются`,
        result.refused.issues,
      );
    return result;
  }

  /** Удержание выдачи правилом восстановления ведущим (`policy.recovery`). */
  /**
   * Удержание gate по отказу без повтора попытки (`sandbox-process-list`,
   * `sandbox-signal`, `sandbox-browser`): упавший gate — последний
   * непройденный evidence попытки с кодом этой причины (не проверка
   * потребителя), его определение — в политике репозитория попытки.
   */
  private environmentHoldOf(a: AttemptState): WorkState['environmentHold'] {
    const cause = a.environmentCause ?? 'sandbox-process-list';
    const code = NO_RETRY_GATE_CODES[cause];
    const e = a.evidence.findLast((x) => !x.passed && !x.consumer && x.summary.startsWith(code));
    if (!e?.gate) return undefined;
    const gate = this.policy.repositories
      .find((r) => r.id === a.repositoryId)
      ?.gates.find((g) => g.id === e.gate);
    if (!gate) return undefined;
    return {
      repositoryId: a.repositoryId,
      gate: gate.id,
      digest: gateDigest(gate),
      runId: a.id,
      at: iso(this.now()),
      isolation: this.policy.isolation.mode,
      ...(cause === 'sandbox-process-list' ? {} : { cause }),
    };
  }

  /** Действующие удержания gates (`WorkState.environmentHold`) по текущей политике. */
  environmentGateHolds(view: ExecutionView): EnvironmentGateHold[] {
    return environmentGateHolds(
      view.works(),
      (repositoryId, id) => {
        const gate = this.policy.repositories
          .find((r) => r.id === repositoryId)
          ?.gates.find((g) => g.id === id);
        return gate ? gateDigest(gate) : undefined;
      },
      {
        isolation: this.policy.isolation.mode,
        ...(processListSeen.status ? { processList: processListSeen.status } : {}),
      },
    );
  }

  /** Удержания gates, которые нужны работе (её обязательные gates репозитория). */
  gateHoldsOf(work: WorkState, holds: readonly EnvironmentGateHold[]): EnvironmentGateHold[] {
    if (!holds.length) return [];
    const repo = this.policy.repositories.find((r) => r.id === work.order.repositoryId);
    if (!repo) return [];
    let gates: string[];
    try {
      gates = expandGateRefs(repo, work.order.gates);
    } catch {
      return [];
    }
    return gateHoldsFor(holds, repo.id, gates);
  }

  /**
   * Маршрут повтора работы (`retryRoute`): тот же вывод, что у отказа
   * `retry --by lead` в `retryRest`, — для строк удержания gate и explain.
   */
  retryRouteOf(work: WorkState, view: ExecutionView): RetryRoute {
    const step = exhaustedStep(
      work,
      view.attempts(work.id),
      recoveryPolicyOf(this.policy),
      Boolean(this.budgetBlockOf(work.id, view)),
    );
    return retryRoute(
      work,
      { maxAttempts: this.policy.maxAttempts, maxNeutral: MAX_NEUTRAL_FAILURES },
      step.actor === 'lead'
        ? {
            actor: 'lead',
            step: step.step,
            ...(step.step === 'diagnose' ? {} : { diagnosis: step.diagnosis.id }),
          }
        : { actor: 'user', why: step.why },
    );
  }

  leadHoldOf(work: WorkState, view: ExecutionView): LeadHold | undefined {
    const rp = recoveryPolicyOf(this.policy);
    if (!rp.enabled) return undefined;
    return leadHold(work, view.attempts(work.id), rp, this.policy.maxAttempts);
  }

  /**
   * Повтор поручения внутри транзакции (`retry`): правила — те же, что у
   * `retry`, — пока попытки не исчерпаны, без сброса; исчерпаны — только
   * явный сброс с причиной. Общий для `retry` и `applyInput`.
   *
   * Правило восстановления ведущим (`policy.recovery.mode: lead`): повтор без
   * сброса не обходит удержание (разбор после `diagnoseAfter` отказов,
   * перепланирование `split`, решение человека по противоречию); сброс
   * ведущего (`by: lead`) — только по свежему техническому разбору и в
   * пределе `leadResets`; сброс человека покрывает отказы без разбора.
   */
  retryIn(
    tx: ExecutionTransaction,
    w: WorkState,
    reset: RetryReset | undefined,
    by: RetryActor,
  ): ReturnType<Engine['retryRest']> & { gateHoldLifted?: string; refused?: HarnessError } {
    // Повтор ведущего всегда снимает удержание gate своей работы — раньше
    // проверок вопроса, исчерпания и удержания разбора: ведущий исправил
    // тест (или gate). Сам повтор дальше идёт по обычным правилам; отказ
    // возвращается вместе со снятием (`retry` сообщает оба), а не
    // откатывает его. Повтор оператора или движка удержание не снимает.
    if (by === 'lead' && w.environmentHold && w.status !== 'done' && w.status !== 'cancelled') {
      const { environmentHold: held, ...rest } = w;
      const lifted = rest as WorkState;
      tx.putWork(lifted);
      try {
        const result = this.retryRest(tx, lifted, reset, by, held.gate);
        if (!result.changed)
          tx.emit({
            type: 'work.retried',
            graphId: w.graphId,
            workId: w.id,
            payload: { by, reset: false, gateHoldLifted: held.gate },
          });
        return { ...result, changed: true, gateHoldLifted: held.gate };
      } catch (error) {
        if (!(error instanceof HarnessError)) throw error;
        tx.emit({
          type: 'work.gate-hold-lifted',
          graphId: w.graphId,
          workId: w.id,
          payload: { gate: held.gate, by: 'lead', refused: error.code },
        });
        return { work: lifted, changed: true, gateHoldLifted: held.gate, refused: error };
      }
    }
    return this.retryRest(tx, w, reset, by);
  }

  private retryRest(
    tx: ExecutionTransaction,
    w: WorkState,
    reset: RetryReset | undefined,
    by: RetryActor,
    liftedGate?: string,
  ) {
    const workId = w.id;
    // Вопрос исполнителя без применённого ответа: ни обычный повтор, ни
    // сброс попыток его не обходят — продолжение только через applyInput
    // (он отмечает запрос применённым до повтора).
    const question = blockingRequest(tx, w);
    if (question)
      throw new HarnessError(
        'INPUT_REQUIRED',
        `Поручение ждёт ${question.lifecycle === 'pending' ? 'ответа' : 'применения ответа'} на вопрос исполнителя ${question.id}; повтор без ответа запрещён`,
      );
    // Принятая работа не повторяется: ни обычный повтор, ни сброс попыток
    // не возвращают её в очередь.
    if (w.status === 'done')
      throw new HarnessError('NOT_READY', `Поручение ${workId} принято: повторять нечего`);
    const exhausted = w.attempt >= this.policy.maxAttempts || neutralExhausted(w);
    // Сброс назван явно (с причиной): он выполняется и тогда, когда попытки
    // ещё не исчерпаны, — ведущий возвращает полный лимит до выдачи. Молча
    // проигнорированного сброса нет: нечего сбросить — это сказано в ответе.
    const resetAsked = !!reset?.reason.trim() || (by === 'lead' && !!reset);
    const spent = w.attempt > 0 || (w.neutralFailures ?? 0) > 0;
    if (w.status === 'ready' && !exhausted && !(resetAsked && spent))
      return {
        work: w,
        changed: false,
        ...(resetAsked
          ? {
              reset: {
                performed: false as const,
                note: 'Сбрасывать нечего: попытки этой работы ещё не тратились',
              },
            }
          : {}),
      };
    if (resetAsked && w.activeRunId)
      throw new HarnessError(
        'NOT_READY',
        `Идёт попытка ${w.activeRunId}: сброс попыток — после её окончания`,
      );
    if (
      !['failed', 'cancelled'].includes(w.status) &&
      !(exhausted && !w.activeRunId) &&
      !(w.status === 'ready' && resetAsked)
    )
      throw new HarnessError('NOT_READY', 'Повтор доступен после отказа или отмены');
    const rp = recoveryPolicyOf(this.policy);
    const attempts = tx.attempts(workId);
    const hold = rp.enabled ? leadHold(w, attempts, rp, this.policy.maxAttempts) : undefined;
    // Повтор без сброса и сброс ведущего удержание не снимают: третьей
    // слепой попытки нет, перепланирование и противоречие сбросом не решаются.
    if (hold && (!resetAsked || by === 'lead')) throw leadHoldError(hold);
    // Текст отказа — из того же правила, что ход в explain и строке
    // удержания gate (`retryRoute`): кто дальше и какой командой.
    if (exhausted && !resetAsked) {
      const route = this.retryRouteOf(w, tx);
      throw new HarnessError(
        'ATTEMPTS_EXHAUSTED',
        (w.attempt >= this.policy.maxAttempts
          ? `Исчерпан лимит попыток (${w.attempt} из ${this.policy.maxAttempts})`
          : `Исчерпан предел незасчитанных отказов (${w.neutralFailures ?? 0} из ${MAX_NEUTRAL_FAILURES})`) +
          `: повтор — только сбросом; ${route.actor === 'lead' ? 'ход ведущего' : 'сброс — решение человека с причиной'} — ${route.command}`,
      );
    }
    const doReset = exhausted || (resetAsked && spent);
    const at = iso(this.now());
    let record: LeadReset | undefined;
    let leadRecovery = w.leadRecovery;
    if (doReset && by === 'lead') {
      const grant = this.leadGrant(tx, w, reset!, rp);
      record = {
        by: 'lead',
        at,
        diagnosis: grant.diagnosis.id,
        epoch: epochOf(w),
        spent: w.attempt,
        granted: this.policy.maxAttempts,
        index: grant.index,
        cap: grant.cap,
        failures: pendingFailures(w, attempts).slice(-20),
      };
    } else if (doReset) {
      // Сброс человеком — его решение по отказам без разбора и по удержанию
      // разбора (`split`, противоречие): оно записано и выдачу не держит.
      // Записывается при любом правиле: после перехода на `lead` отказы,
      // решённые этим сбросом, разбора не требуют.
      record = {
        by: 'operator',
        at,
        epoch: epochOf(w),
        spent: w.attempt,
        granted: this.policy.maxAttempts,
        failures: pendingFailures(w, attempts).slice(-20),
      };
      const fresh = freshDiagnosis(w, attempts);
      if (fresh && !fresh.resolved && (fresh.cause === 'split' || fresh.cause === 'contradiction'))
        leadRecovery = {
          ...(leadRecovery ?? { diagnoses: [], resets: [], seq: 0 }),
          diagnoses: (leadRecovery?.diagnoses ?? []).map((d) =>
            d.id === fresh.id ? { ...d, resolved: { by: 'operator' as const, at } } : d,
          ),
        };
    } else if (by === 'lead' && resetAsked)
      throw new HarnessError(
        'NOT_READY',
        'Сбрасывать нечего: попытки этой работы ещё не тратились',
      );
    if (record)
      leadRecovery = {
        ...(leadRecovery ?? { diagnoses: [], resets: [], seq: 0 }),
        resets: [...(leadRecovery?.resets ?? []), record].slice(-LEAD_RECOVERY_LIMIT),
      };
    // Ведущий повторяет работу, остановленную отказом без повтора, после
    // исправления теста: удержание gate снимается (новый отказ поставит его
    // снова). Повтор оператора или движка его не снимает.
    const next: WorkState = {
      ...w,
      status: w.approvedDigest ? 'ready' : 'draft',
      attempt: doReset ? 0 : w.attempt,
      neutralFailures: doReset ? undefined : w.neutralFailures,
      failure: undefined,
      failureKind: undefined,
      failureFingerprint: undefined,
      ...(leadRecovery ? { leadRecovery } : {}),
    };
    tx.putWork(next);
    const reason = reset?.reason.trim() ?? '';
    tx.emit({
      type: 'work.retried',
      graphId: w.graphId,
      workId,
      payload: {
        by,
        reset: doReset,
        ...(doReset ? { spent: w.attempt, reasonLength: reason.length } : {}),
        ...(record?.by === 'lead'
          ? {
              diagnosis: record.diagnosis!,
              index: record.index!,
              cap: record.cap!,
              granted: record.granted,
            }
          : {}),
        ...(liftedGate ? { gateHoldLifted: liftedGate } : {}),
      },
    });
    return {
      work: next,
      changed: true,
      ...(resetAsked
        ? {
            reset: doReset
              ? {
                  performed: true as const,
                  spent: w.attempt,
                  ...(record?.by === 'lead'
                    ? {
                        by: 'lead' as const,
                        diagnosis: record.diagnosis!,
                        index: record.index!,
                        cap: record.cap!,
                        granted: record.granted,
                      }
                    : {}),
                }
              : {
                  performed: false as const,
                  note: 'Сбрасывать нечего: попытки этой работы ещё не тратились',
                },
          }
        : {}),
    };
  }

  /**
   * Право ведущего дать новый предел попыток (`retry --reset --by lead`):
   * правило `lead`, бюджет расходов работы не исчерпан, сбросы ведущего
   * остались, есть свежий (после последнего засчитанного отказа)
   * технический разбор, по которому ещё не сбрасывали. Иначе — отказ с
   * кодом, по которому ясно, кто дальше: человек (`ATTEMPTS_EXHAUSTED`,
   * `BUDGET_EXHAUSTED`) или ведущий (`DIAGNOSIS_REQUIRED`, перепланирование).
   */
  private leadGrant(
    tx: ExecutionView,
    w: WorkState,
    reset: RetryReset,
    rp: ReturnType<typeof recoveryPolicyOf>,
  ) {
    const attempts = tx.attempts(w.id);
    if (reset.diagnosis && !w.leadRecovery?.diagnoses.some((d) => d.id === reset.diagnosis))
      throw new HarnessError('NOT_FOUND', `Разбора ${reset.diagnosis} у поручения ${w.id} нет`, [
        { path: ['--diagnosis'], message: reset.diagnosis },
      ]);
    const budget = this.budgetBlockOf(w.id, tx);
    const step = exhaustedStep(w, attempts, rp, Boolean(budget));
    if (step.actor === 'user') {
      if (step.why === 'budget')
        throw new HarnessError(
          'BUDGET_EXHAUSTED',
          `Бюджет работы исчерпан (${budget}): новый предел попыток — решение человека`,
        );
      throw new HarnessError(
        'ATTEMPTS_EXHAUSTED',
        {
          mode: 'Правило восстановления — user (policy.recovery): сброс попыток решает человек',
          cap: `Сбросы ведущего этого предела потрачены (${rp.leadResets} из ${rp.leadResets}): дальше решает человек — сброс с причиной`,
          cause: `Разбор ${step.diagnosis?.id} — не техническая причина (${step.diagnosis?.cause}): ведущий сам предел не даёт, решает человек`,
          repeated: `По разбору ${step.diagnosis?.id} уже сбрасывали: тот же разбор второй раз предел не даёт — нужен новый разбор после нового отказа, иначе решает человек`,
          nothing:
            'Засчитанных отказов без разбора нет: ведущему разбирать нечего, сброс решает человек',
        }[step.why],
      );
    }
    if (step.step === 'diagnose')
      throw new HarnessError(
        'DIAGNOSIS_REQUIRED',
        `Нужен свежий разбор последнего засчитанного отказа (${step.failures.at(-1)}): harness diagnose --work ${w.id} --cause … --hypothesis "…"`,
      );
    if (step.step === 'replan')
      throw new HarnessError(
        'NOT_READY',
        `Разбор ${step.diagnosis.id}: задача велика — перепланируйте и согласуйте разделение; сбросом это не решается`,
      );
    if (reset.diagnosis && reset.diagnosis !== step.diagnosis.id)
      throw new HarnessError(
        'DIAGNOSIS_REQUIRED',
        `Разбор ${reset.diagnosis} не свежий: последний засчитанный отказ разбирает ${step.diagnosis.id}`,
        [{ path: ['--diagnosis'], message: reset.diagnosis }],
      );
    return step;
  }

  /**
   * Диагностика ведущего (`harness diagnose`): причина последних засчитанных
   * отказов без разбора, гипотеза (обязательна для `coverage` и `approach`,
   * не повторяет прежние гипотезы работы) и ссылки на доказательства.
   * Последствие — по причине: техническая открывает следующую попытку с
   * гипотезой в контексте исполнителя (при исчерпании — право ведущего на
   * сброс), `split` держит работу до перепланирования, `contradiction`
   * передаёт решение человеку. Модель не вызывается.
   */
  diagnose(
    workId: string,
    input: { cause: LeadDiagnosisCause; hypothesis?: string; evidence?: readonly string[] },
  ) {
    // Разбор — решение о повторе: та же операция, что у retry.
    return this.tx('task.retry', (tx) => {
      this.assertNoUpdate(tx);
      const w = tx.work(workId);
      if (!w) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + workId);
      if (w.status === 'done' || w.status === 'cancelled')
        throw new HarnessError('NOT_READY', `Поручение ${workId} ${w.status}: разбирать нечего`);
      if (w.activeRunId)
        throw new HarnessError(
          'NOT_READY',
          `Идёт попытка ${w.activeRunId}: разбор — после её окончания`,
        );
      const attempts = tx.attempts(workId);
      const failures = pendingFailures(w, attempts);
      if (!failures.length)
        throw new HarnessError(
          'NOT_READY',
          'Засчитанных отказов без разбора нет: отказы окружения, провайдера, вопросы и остановки разбора не требуют',
        );
      // Разбор хранится и показывается в панели и журнале: секреты (токены,
      // ключи, учётные данные в URL) маскируются до записи, как у заметок ведущего.
      const hypothesis = maskSecrets(input.hypothesis ?? '').trim() || undefined;
      if ((input.cause === 'coverage' || input.cause === 'approach') && !hypothesis)
        throw new HarnessError(
          'INVALID_INPUT',
          `--hypothesis обязательна для причины ${input.cause}: что исполнитель сделает иначе и как это проверить`,
          [{ path: ['--hypothesis'], message: 'required' }],
        );
      if (hypothesis && (hypothesis.length < 10 || hypothesis.length > 2000))
        throw new HarnessError('INVALID_INPUT', '--hypothesis: от 10 до 2000 знаков', [
          { path: ['--hypothesis'], message: String(hypothesis.length) },
        ]);
      const earlier = (w.leadRecovery?.diagnoses ?? []).filter((d) => d.hypothesis);
      const same = hypothesis
        ? earlier.find(
            (d) => normalizedHypothesis(d.hypothesis!) === normalizedHypothesis(hypothesis),
          )
        : undefined;
      if (same)
        throw new HarnessError(
          'INVALID_INPUT',
          `Гипотеза повторяет разбор ${same.id}: третья попытка с той же гипотезой — та же слепая попытка; назовите новую или передайте решение человеку`,
          [{ path: ['--hypothesis'], message: same.id }],
        );
      const evidence = (input.evidence ?? []).map((e) => maskSecrets(e).trim()).filter(Boolean);
      if (evidence.length > 10 || evidence.some((e) => e.length > 1000))
        throw new HarnessError('INVALID_INPUT', '--evidence: не больше 10, каждая до 1000 знаков');
      const seq = (w.leadRecovery?.seq ?? 0) + 1;
      const diagnosis: LeadDiagnosis = {
        id: `D${seq}`,
        cause: input.cause,
        ...(hypothesis ? { hypothesis } : {}),
        evidence,
        failures: failures.slice(-20),
        by: 'lead',
        at: iso(this.now()),
        ...(w.approvedDigest ? { approvedDigest: w.approvedDigest } : {}),
        epoch: epochOf(w),
      };
      const leadRecovery = {
        diagnoses: [...(w.leadRecovery?.diagnoses ?? []), diagnosis].slice(-LEAD_RECOVERY_LIMIT),
        resets: w.leadRecovery?.resets ?? [],
        seq,
      };
      const next = { ...w, leadRecovery };
      tx.putWork(next);
      tx.emit({
        type: 'work.diagnosed',
        graphId: w.graphId,
        workId,
        payload: {
          diagnosis: diagnosis.id,
          cause: diagnosis.cause,
          failures: diagnosis.failures,
          hypothesisLength: hypothesis?.length ?? 0,
          evidence: evidence.length,
        },
      });
      const rp = recoveryPolicyOf(this.policy);
      const exhausted = w.attempt >= this.policy.maxAttempts;
      const hold = rp.enabled ? leadHold(next, attempts, rp, this.policy.maxAttempts) : undefined;
      const step = exhausted
        ? exhaustedStep(next, attempts, rp, Boolean(this.budgetBlockOf(w.id, tx)))
        : undefined;
      const nextStep: DiagnoseNext = hold
        ? hold.kind === 'replan'
          ? 'replan'
          : hold.kind === 'contradiction'
            ? 'user-decision'
            : 'diagnose'
        : step
          ? step.actor === 'lead'
            ? step.step === 'reset'
              ? 'lead-reset'
              : step.step === 'replan'
                ? 'replan'
                : 'diagnose'
            : 'user-reset'
          : 'attempt';
      return { workId, diagnosis, next: nextStep, mode: rp.mode };
    });
  }

  /**
   * Дополнить свежий разбор ведущего (`harness diagnose --addendum`,
   * 0.1.0-alpha.68): вторая причина или заметка к тому же засчитанному
   * отказу, найденная после разбора, — без перерегистрации графа и без
   * нового разбора. Следующая попытка получает разбор вместе с
   * дополнениями. Причина, гипотеза, счёт разборов и право на сброс не
   * меняются: тот же разбор второй предел не даёт. Отказ: идёт попытка,
   * свежего разбора нет (засчитанный отказ после него — нужен новый разбор),
   * больше пяти дополнений. Модель не вызывается.
   */
  amendDiagnosis(workId: string, input: { text: string; evidence?: readonly string[] }) {
    return this.tx('task.retry', (tx) => {
      this.assertNoUpdate(tx);
      const w = tx.work(workId);
      if (!w) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + workId);
      if (w.status === 'done' || w.status === 'cancelled')
        throw new HarnessError('NOT_READY', `Поручение ${workId} ${w.status}: дополнять нечего`);
      if (w.activeRunId)
        throw new HarnessError(
          'NOT_READY',
          `Идёт попытка ${w.activeRunId}: дополнение — после её окончания`,
        );
      const attempts = tx.attempts(workId);
      const fresh = freshDiagnosis(w, attempts);
      if (!fresh)
        throw new HarnessError(
          'NOT_READY',
          pendingFailures(w, attempts).length
            ? `Свежего разбора нет: засчитанный отказ после последнего разбора — новый разбор (harness diagnose --work ${workId} --cause … --hypothesis "…")`
            : 'Свежего разбора последнего засчитанного отказа нет: дополнять нечего',
        );
      const text = maskSecrets(input.text).trim();
      if (text.length < 10 || text.length > 2000)
        throw new HarnessError('INVALID_INPUT', '--addendum: от 10 до 2000 знаков', [
          { path: ['--addendum'], message: String(text.length) },
        ]);
      const evidence = (input.evidence ?? []).map((e) => maskSecrets(e).trim()).filter(Boolean);
      if (evidence.length > 10 || evidence.some((e) => e.length > 1000))
        throw new HarnessError('INVALID_INPUT', '--evidence: не больше 10, каждая до 1000 знаков');
      const addenda = fresh.addenda ?? [];
      if (addenda.length >= 5)
        throw new HarnessError(
          'INVALID_INPUT',
          `У разбора ${fresh.id} уже 5 дополнений: новая причина — после следующего отказа новым разбором`,
        );
      const diagnosis: LeadDiagnosis = {
        ...fresh,
        addenda: [...addenda, { at: iso(this.now()), text, evidence }],
      };
      const diagnoses = w.leadRecovery!.diagnoses.map((d) => (d.id === fresh.id ? diagnosis : d));
      tx.putWork({ ...w, leadRecovery: { ...w.leadRecovery!, diagnoses } });
      tx.emit({
        type: 'work.diagnosis-amended',
        graphId: w.graphId,
        workId,
        payload: {
          diagnosis: diagnosis.id,
          addendum: diagnosis.addenda!.length,
          textLength: text.length,
          evidence: evidence.length,
        },
      });
      return { workId, diagnosis };
    });
  }

  /**
   * Решение ведущего или оператора по открытым находкам ревью кода поручения
   * (`review-accept`, docs/review-protocol.md §10): находки принимаются
   * известным ограничением с основанием. Решение — не одобрение и не повтор:
   * оно записывается у поручения и применяется историей находок со
   * следующего раунда (reviewer видит его и не поднимает находку без новых
   * доказательств; writer её больше не исправляет). Неизвестная, не открытая
   * или повторённая находка и поручение с активной попыткой или уже принятое —
   * отказ до записи. Уже принятая тем же решением находка — без изменений.
   */
  acceptCodeFindings(
    workId: string,
    findings: readonly string[],
    reason: string,
    by: CodeReviewDecision['by'],
  ) {
    return this.tx('findings.recorded', (tx) => {
      this.assertNoUpdate(tx);
      const w = tx.work(workId);
      if (!w) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + workId);
      if (w.activeRunId || w.status === 'done')
        throw new HarnessError(
          'NOT_READY',
          w.activeRunId
            ? `Поручение ${workId} исполняется (${w.activeRunId}): решение по находкам — после завершения попытки`
            : `Поручение ${workId} уже принято: следующего раунда ревью нет`,
        );
      if (!findings.length)
        throw new HarnessError('INVALID_INPUT', 'Нужна хотя бы одна находка (--accept-limitation)');
      const history = codeReviewHistory(
        tx.attempts(workId),
        codeReviewScope(w.order.repositoryId, workId),
        w.codeReviewDecisions,
      );
      const byId = new Map(history.findings.map((f) => [f.id, f]));
      const at = iso(this.now());
      const seen = new Set<string>();
      const fresh: CodeReviewDecision[] = [];
      for (const id of findings) {
        if (seen.has(id))
          throw new HarnessError('INVALID_INPUT', 'Находка названа повторно: ' + id, [
            { path: ['--accept-limitation'], message: id },
          ]);
        seen.add(id);
        const f = byId.get(id);
        if (!f)
          throw new HarnessError(
            'INVALID_INPUT',
            'Находки нет в истории ревью кода поручения: ' + id,
            [{ path: ['--accept-limitation'], message: id }],
          );
        if (f.disposition?.decision === 'accepted-limitation' && f.status === 'withdrawn') continue;
        if (f.status !== 'open')
          throw new HarnessError(
            'INVALID_INPUT',
            `Находка ${id} уже ${f.status}: принять можно только открытую`,
            [{ path: ['--accept-limitation'], message: id }],
          );
        const decision = codeReviewDecisionSchema.safeParse({
          finding: id,
          decision: 'accepted-limitation',
          by,
          reason,
          round: history.round,
          at,
        });
        if (!decision.success)
          throw new HarnessError('INVALID_INPUT', '--reason: основание не короче трёх знаков', [
            { path: ['--reason'], message: decision.error.issues[0]?.message ?? '' },
          ]);
        fresh.push(decision.data);
      }
      const decisions = [...(w.codeReviewDecisions ?? []), ...fresh];
      if (decisions.length > 500)
        throw new HarnessError('INVALID_INPUT', 'Предел решений по находкам поручения — 500');
      if (fresh.length) {
        tx.putWork({ ...w, codeReviewDecisions: decisions });
        tx.emit({
          type: 'work.findings-accepted',
          graphId: w.graphId,
          workId,
          payload: {
            findings: fresh.map((d) => d.finding),
            by,
            round: history.round,
            reasonLength: fresh[0]!.reason.length,
          },
        });
      }
      const after = codeReviewHistory(
        tx.attempts(workId),
        codeReviewScope(w.order.repositoryId, workId),
        decisions,
      );
      return {
        workId,
        changed: fresh.length > 0,
        round: history.round,
        accepted: after.findings
          .filter((f) => seen.has(f.id))
          .map((f) => ({
            id: f.id,
            severity: f.severity,
            message: f.message.slice(0, 4000),
            path: f.path,
            status: f.status,
            ...(f.disposition ? { disposition: f.disposition } : {}),
            ...(f.late ? { late: f.late } : {}),
          })),
      };
    });
  }
}

/**
 * Открытые работы инфраструктуры прежних графов (alpha.67, docs/infra-works.md)
 * по репозиториям продуктовой работы — своему и связанным. Внутри графа
 * порядок задаёт `dependsOn` (`plan-check`/`validate`); между графами — эта
 * проверка: продуктовая работа не выдаётся, пока инфраструктура, на которой
 * её проверят, не принята или не отменена (draft и исчерпанная — тоже держат;
 * отменяет их ведущий или план, не движок). Индекс строится одним проходом
 * по работам: на каждую работу — поиск по её репозиториям.
 */
export function infraPendingIndex(view: ExecutionView): (work: WorkState) => string[] {
  const order = new Map(view.graphs().map((g, i) => [g.id, i]));
  // Репозиторий → открытые работы инфраструктуры с индексом их графа.
  const open = new Map<string, { id: string; graph: number }[]>();
  for (const w of view.works())
    if (w.order.kind === 'infra' && w.status !== 'done' && w.status !== 'cancelled') {
      const list = open.get(w.order.repositoryId) ?? [];
      list.push({ id: w.id, graph: order.get(w.graphId) ?? -1 });
      open.set(w.order.repositoryId, list);
    }
  return (work) => {
    if (work.order.kind === 'infra' || !open.size) return [];
    const own = order.get(work.graphId);
    if (own === undefined || own <= 0) return [];
    const out = new Set<string>();
    for (const repo of new Set([work.order.repositoryId, ...work.order.relatedRepositories]))
      for (const x of open.get(repo) ?? []) if (x.graph >= 0 && x.graph < own) out.add(x.id);
    return [...out];
  };
}

/** Одна работа — `infraPendingIndex` без индекса. */
export function infraPendingOf(work: WorkState, view: ExecutionView): string[] {
  return infraPendingIndex(view)(work);
}

/**
 * Пределы бюджета политики (0.1.0-alpha.68) по именам: попытки, раунды ревью
 * плана и контракта, повторы, сбросы ведущего, расходы и время поручения,
 * группы и установки. `null` — без предела.
 */
export function budgetLimitsOf(policy: ExecutionPolicy): Record<string, number | null> {
  const out: Record<string, number | null> = {
    maxAttempts: policy.maxAttempts,
    // Облегчённый режим (0.1.0-alpha.69): раундов ревью не считают — без предела.
    reviewRounds: harnessModeOf(policy) === 'light' ? null : policy.maxAttempts * 2,
    repairBudget: policy.repairBudget,
    leadResets: recoveryPolicyOf(policy).leadResets,
  };
  for (const scope of ['work', 'group', 'total'] as const) {
    const b = policy.budgets?.[scope];
    out[`budgets.${scope}.usd`] = b?.usd ?? null;
    out[`budgets.${scope}.timeMs`] = b?.timeMs ?? null;
  }
  return out;
}

/** Поднятые пределы: больше прежнего или снят (`null` после числа). */
export function budgetRaises(
  before: Record<string, number | null>,
  after: Record<string, number | null>,
) {
  return Object.keys(after)
    .filter((field) => field in before)
    .flatMap((field) => {
      const a = before[field] ?? null;
      const b = after[field] ?? null;
      const raised = a !== null && (b === null || b > a);
      return raised ? [{ field, before: a, after: b }] : [];
    })
    .slice(0, 20);
}
