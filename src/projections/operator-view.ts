// Представление оператора (`OperatorView`, `harness view`): один документ
// только для чтения, который рисует панель оператора. Чистая проекция без
// node:* и zod (браузерный бандл): числа приходят готовыми из harness
// (`status`, сводки попыток и ревью, правила стоимости отчёта) — проекция их
// не выводит заново, а только раскладывает по полям, маскирует и обрезает
// свободный текст, держит пределы списков и размера и считает токен
// содержимого. Схема ответа — `operatorViewSchema` (src/contracts/operator-view.ts).

import { HarnessError } from '../contracts/errors.ts';
import { MAX_NEUTRAL_FAILURES } from '../contracts/repair-policy.ts';
import { REVIEW_ESCALATION_ROUNDS } from '../contracts/review-loop.ts';
import {
  OPERATOR_VIEW_DEFAULT_BUCKET_MS,
  OPERATOR_VIEW_DEFAULT_WINDOW_MS,
  OPERATOR_VIEW_LIMITS,
  OPERATOR_VIEW_REVISION,
  OPERATOR_VIEW_TEXT,
  OPERATOR_VIEW_TYPICAL_MIN_SAMPLES,
  OPERATOR_VIEW_VERSION,
} from '../contracts/operator-view-limits.ts';
import type { ExecutionPolicy, RuntimeBinding } from '../contracts/policy.ts';
import { fitLine, named, type LinePart } from './clip.ts';
import { maskSecrets, maskText, type MaskContext } from './mask.ts';
import { attemptLine, type AttemptLineFacts } from '../contracts/attempt-line.ts';
import { holdLineParts } from './blocker-line.ts';
import { remoteLineParts } from './remote-line.ts';
import { sha256Hex } from './sha256.ts';

export {
  OPERATOR_VIEW_VERSION,
  OPERATOR_VIEW_REVISION,
  OPERATOR_VIEW_LIMITS,
  OPERATOR_VIEW_TEXT,
} from '../contracts/operator-view-limits.ts';

/* ------------------------------------------------------------------ */
/* Документ                                                            */
/* ------------------------------------------------------------------ */

/** Сумма с честной границей: `unknown` никогда не показывается нулём. */
export interface Bounded {
  value: number;
  bound: 'exact' | 'lower' | 'unknown';
}
export type ViewActor = 'operator' | 'lead' | 'controller' | 'host';
export interface ViewBinding {
  runtime: string;
  model?: string;
  effort?: string;
}

export interface ViewSettings {
  policyDigest: string;
  approvalMode: 'agent' | 'operator';
  mode: 'live' | 'fixture';
  concurrency: number;
  roles: { role: string; writer: ViewBinding; repositoryId?: string }[];
  reviews: {
    kind: 'plan' | 'contract' | 'code';
    scope: 'global' | 'repository' | 'role';
    repositoryId?: string;
    role?: string;
    reviewer: ViewBinding;
    alternates: ViewBinding[];
    vendor: 'different-vendor' | 'same-vendor-allowed';
  }[];
  thresholds: {
    inputSeverity: number;
    leadAnswersMaxSeverity?: number;
    leadAnswersTechnical?: boolean;
    criticalPaths: number;
    maxAttempts: number;
    repairBudget: number;
    maxNeutralFailures: number;
    reviewRoundCap: number;
    reviewEscalationRounds: number;
  };
  budgets: { scope: 'work' | 'group' | 'total'; usd?: number; timeMs?: number }[];
  budgetOnUnknown?: 'stop' | 'continue';
  timeouts: {
    runTimeoutMs: number;
    leaseMs: number;
    gateTimeoutFloorMs?: number;
    stall: { intervalMs: number; quietMs: number; stalledMs: number; action: 'stop' | 'report' };
  };
  lean: { state: 'on' | 'off' | 'unknown' };
  defaulted: string[];
}

export interface FindingView {
  id: string;
  severity: string;
  status: string;
  rounds?: number;
  disposition?: {
    decision: 'accepted-limitation' | 'continue';
    by: 'lead' | 'operator';
    round: number;
  };
  title?: string;
}

export interface ReviewSubjectView {
  kind: 'plan' | 'contract' | 'code';
  subject: string;
  workId?: string;
  approved: boolean;
  rounds: { used: number; max: number | null };
  open: { blocking: number; notes: number };
  accepted: number;
  reviewer?: ViewBinding;
  sameVendor?: boolean;
  spend: { calls: number; usd: Bounded };
  findings: FindingView[];
  escalation?: { requestId: string; findings: string[]; answered: boolean };
  line?: string;
}

export interface OperatorQuestion {
  requestId: string;
  workId: string;
  state: string;
  version: number;
  severity: number;
  answerableBy: 'operator' | 'operator-or-lead';
  impact?: string;
  plain?: string;
  answeredBy?: 'operator' | 'lead' | 'host';
  answerBasis?: AnswerBasisView;
  title?: string;
  createdAt: string;
}

/** Основание последнего ответа на вопрос (ревизия 1). */
export interface AnswerBasisView {
  by: 'operator' | 'lead' | 'host';
  /** Правило политики, по которому ответил ведущий. */
  rule?: 'technical' | 'severity';
  /** Причина ведущего; без `--no-titles`. */
  reason?: string;
  impact: string;
  at: string;
  /** «ответил ведущий: <причина>» на языке представления. */
  line: string;
}

export interface Escalation {
  workId?: string;
  subject?: string;
  code: string;
  actor: string;
  action: string;
  since: string;
}

export interface DriftView {
  workId: string;
  repositoryId: string;
  ref: string;
  acceptedSha: string;
  head?: string;
  commitsSinceAccepted?: number;
  filesSinceAccepted?: number;
  diverged?: true;
  unavailable?: string;
}

export interface BlockerView {
  code: string;
  plain?: string;
  actor: string | null;
}

export interface WorkView {
  id: string;
  graphId: string;
  title?: string;
  status: string;
  stage: {
    name: string;
    step?: string;
    since?: string;
    next: string[];
    needs?: { actor: string | null; action: string };
    typical?: StageTypical;
  };
  attempts: {
    used: number;
    max: number;
    left: number;
    failed: number;
    interrupted: number;
    rechecks: number;
    neutral: { used: number; max: number };
    line?: string;
    lastFailure?: { attempt: number; bucket: string; plain: string; at?: string };
  };
  liveness?: 'active' | 'quiet' | 'stalled';
  runtime?: string;
  model?: string;
  blockers: BlockerView[];
  dependsOn?: string[];
  target?: {
    repositoryId: string;
    ref: string;
    acceptedSha?: string;
    remote: {
      state: string;
      trackingRef?: string;
      checkedAt?: string;
      reason?: string;
      line?: string;
    };
  };
  question?: { requestId: string; state: string; severity: number };
  spend: { calls: number; usd: Bounded; durationMs: number };
  resultSha?: string;
}

/** Наблюдаемая длительность этапа: p50 и p90 закончившихся образцов. */
export interface StageTypical {
  p50Ms: number;
  p90Ms: number;
  samples: number;
}

/** Итоги окна истории (ревизия 1). */
export interface ViewHistoryTotals {
  attemptsStarted: number;
  attemptsFailed: number;
  failuresByBucket: Record<string, number>;
  gatesPassed: number;
  gatesFailed: number;
  gatesReused: number;
  reviewRounds: { plan: number; contract: number; code: number; attempt: number };
  spendUsd: Bounded;
  wallMs: number;
  attemptMs: number;
  loadPeak: number;
}

export interface ViewHistory {
  from: string;
  to: string;
  bucketMs: number;
  load: number[];
  attemptsStarted: number[];
  attemptsFailed: number[];
  gatesPassed: number[];
  gatesFailed: number[];
  gatesReused: number[];
  spendUsd: number[];
  spendBound: Bounded['bound'];
  spendOpeningUsd: Bounded;
  budgetUsd?: number;
  totals?: ViewHistoryTotals;
}

export interface ViewHealth {
  controller: { present: boolean; leaseUntil?: string };
  stalledAttempts: number;
  quietAttempts: number;
  environmentFailures: number;
  budgeting: 'on' | 'off';
  budgets: {
    scope: 'work' | 'group' | 'total';
    id?: string;
    state: 'within' | 'exceeded' | 'undetermined';
    spentUsd: Bounded;
    limitUsd?: number;
    spentMs?: number;
    limitMs?: number;
  }[];
  spentTotalUsd: Bounded;
  drift: { checked: number; drifted: number; unavailable: number };
  warnings: { code: string; message: string }[];
}

export type TruncatedKey =
  | 'works'
  | 'reviews'
  | 'findings'
  | 'questions'
  | 'escalations'
  | 'drift'
  | 'roles'
  | 'reviewRules'
  | 'warnings'
  | 'budgets'
  | 'blockers'
  | 'dependsOn'
  | 'alternates'
  | 'activity';

export interface ViewSource {
  producer: string;
  producerVersion: string;
  stateVersion: number;
  token: string;
}

export interface OperatorView {
  viewVersion: typeof OPERATOR_VIEW_VERSION;
  viewRevision: number;
  generatedAt: string;
  source: ViewSource;
  settings: ViewSettings;
  works: WorkView[];
  reviews: ReviewSubjectView[];
  questions: OperatorQuestion[];
  escalations: Escalation[];
  drift: DriftView[];
  progress: {
    total: number;
    byStage: Record<string, number>;
    running: number;
    done: number;
    waitingOperator: number;
    queue: { paused: boolean; reason?: string; detail?: string; actor?: string; action?: string };
  };
  history: ViewHistory;
  health: ViewHealth;
  activity?: ActivityView[];
  truncated?: Partial<Record<TruncatedKey, number>>;
}

/** Запись ленты «кто что делал» (ревизия 2). */
export interface ActivityView {
  at: string;
  actor: string;
  action: string;
  workId?: string;
  subject?: string;
  plain: string;
}

export interface AttemptRow {
  attempt: number;
  status: string;
  failureBucket?: string;
  interrupted?: true;
  runtime: string;
  model?: string;
  startedAt: string;
  finishedAt?: string;
  stages: { stage: string; durationMs?: number; outcome?: 'passed' | 'failed' }[];
}

export interface ViewVerificationRow {
  gate: string;
  kind: 'gate' | 'review';
  phase?: 'candidate' | 'integration';
  result: string;
  how: string;
  by?: string;
  attempt?: number;
  at?: string;
}

export interface WorkDetailView {
  viewVersion: typeof OPERATOR_VIEW_VERSION;
  viewRevision: number;
  generatedAt: string;
  source: ViewSource;
  work: WorkView;
  attempts: AttemptRow[];
  verification?: ViewVerificationRow[];
  reviews: ReviewSubjectView[];
  questions: OperatorQuestion[];
  drift?: DriftView;
  truncated?: Partial<
    Record<
      | 'attempts'
      | 'findings'
      | 'verification'
      | 'stages'
      | 'reviews'
      | 'questions'
      | 'blockers'
      | 'dependsOn',
      number
    >
  >;
}

/* ------------------------------------------------------------------ */
/* Вход                                                                */
/* ------------------------------------------------------------------ */

/** Кто действует в терминах harness (`explain`): `user` — человек. */
type HarnessActor = 'user' | 'lead' | 'controller' | 'host' | 'operator' | null;

/**
 * Поручение глазами `status` (`works[]`): этап, сводка попыток, блокировки,
 * вопрос, сверка принятого. Поля alpha.55 (`blockers[].plain/actor`,
 * `attemptSummary.lastFailure`, `verification`) необязательны: проекция берёт
 * их, когда harness их выдаёт.
 */
export interface OperatorWorkInput {
  id: string;
  graphId: string;
  status: string;
  /** Сырой заголовок узла графа: проекция маскирует и обрезает. */
  title?: string;
  resultSha?: string;
  dependsOn?: readonly string[];
  stage: {
    name: string;
    step?: string;
    since?: string;
    next: readonly string[];
    needs?: { actor: HarnessActor; action: string };
    spend: { calls: number; knownUsd: number; unknownCalls: number; durationMs: number };
  };
  /** Факты учёта для границы суммы: попытки без полного учёта, вызовы с неполным usage. */
  spendFacts?: { uncoveredRuns: number; incompleteCalls: number };
  attemptSummary: {
    failed: number;
    interrupted: number;
    attempts: { used: number; max: number; left: number };
    neutral: { used: number; max: number };
    line?: string;
    /** Та же строка по-английски (`--lang en`); нет — строки нет. */
    lineEn?: string;
    /**
     * Числа той же строки (`attemptLine`). Есть — проекция собирает строку
     * сама в пределе `line`: при нехватке места сокращается список отказов
     * («и ещё N»), а остаток попыток или «повтор — только со сбросом»
     * сохраняется. Нет — `line`/`lineEn`, обрезанные с конца.
     */
    lineFacts?: AttemptLineFacts;
    /** alpha.55 (`attemptSummary.lastFailure`). */
    lastFailure?: { runId: string; bucket: string; plain: string; plainEn?: string; at?: string };
  };
  /** Записи доказательств с `recheck` по всем попыткам работы. */
  rechecks: number;
  liveness?: 'quiet' | 'stalled';
  /** Попытка идёт (`activeRunId` активной попытки). */
  active?: { runtime: string; model?: string };
  blockers: readonly {
    code: string;
    message?: string;
    plain?: string;
    plainEn?: string;
    actor?: HarnessActor;
  }[];
  input?: { requestId: string; state: string; severity: number };
  /** Принятая работа против target ref (`status.works[].target`). */
  target?: {
    repositoryId: string;
    ref: string;
    acceptedSha: string;
    head?: string;
    commitsSinceAccepted?: number;
    filesSinceAccepted?: number;
    diverged?: true;
    unavailable?: string;
    /** Удалённая ветка (`status.works[].target.remote`, alpha.57); нет — не читалась. */
    remote?: {
      state: 'pushed' | 'not-pushed' | 'unknown';
      trackingRef?: string;
      pushRemote?: string;
      pushRef?: string;
      checkedAt?: string;
      reason?: string;
      reasonEn?: string;
      line: string;
      lineEn: string;
    };
  };
  /** alpha.55 (`status.works[].verification`). */
  verification?: {
    runId: string;
    rows: readonly {
      gate: string;
      kind: 'gate' | 'review';
      phase: 'candidate' | 'integration';
      consumer?: string;
      result: string;
      how: string;
      at?: string;
      reviewer?: { runtime: string; vendor: string };
    }[];
  };
}

/** Попытка для истории и деталей работы (загрузчик уже применил правила отчёта). */
export interface OperatorAttemptInput {
  workId: string;
  runId: string;
  attempt: number;
  status: string;
  startedAt: string;
  finishedAt?: string;
  /** `failureBucketOf`; `null` — не отказ. */
  failureBucket?: string | null;
  /** `interruptedByShutdown`. */
  interrupted?: boolean;
  callsRecorded?: boolean;
  runtime: string;
  model?: string;
  stages?: readonly {
    stage: string;
    startedAt: string;
    finishedAt?: string;
    outcome?: 'passed' | 'failed';
  }[];
}

/** Запись gate (`attempt.gate`): применимая, перепроверка, перенесённая с кандидата. */
export interface OperatorGateEvent {
  at: string;
  passed: boolean;
  applicable: boolean;
  recheck?: boolean;
  reused?: boolean;
}

/** Вызов модели по правилам стоимости отчёта (`callCostKnown`, полнота учёта). */
export interface OperatorCallInput {
  /** Конец вызова, иначе начало. */
  at: string;
  /** Известная стоимость; `null` — неизвестна. */
  knownUsd: number | null;
  /** Вызов полностью учтён: завершён, usage полный, цена есть. */
  complete: boolean;
}

/** Вопрос исполнителя — очищенная сводка загрузчика. */
export interface OperatorQuestionInput {
  requestId: string;
  workId: string;
  state: string;
  version: number;
  severity: number;
  createdAt: string;
  /** Сырой текст вопроса: проекция маскирует, затем обрезает. */
  text?: string;
  /** Сырой текст «что изменится для пользователя». */
  plain?: string;
  impact?: string;
  answeredBy?: 'operator' | 'lead' | 'host';
  /** Последний ответ: кто, правило ведущего (`basis`), сырая причина, время. */
  answer?: {
    by: 'operator' | 'lead' | 'host';
    basis?: 'technical' | 'severity';
    reason?: string;
    at: string;
  };
  /** Работа закрыта (`done`, `cancelled`): вопрос виден только в деталях работы. */
  closed?: boolean;
  /** Действующая политика разрешает ответ ведущему (`leadMayAnswer`). */
  leadMay: boolean;
}

/** Предмет ревью: план и контракт (`reviewSubjectSummary`) и код (`review-code`). */
export interface OperatorReviewInput {
  kind: 'plan' | 'contract' | 'code';
  subject: string;
  workId?: string;
  at: string;
  approved: boolean;
  rounds: { used: number; max: number | null };
  open: { blocking: number; notes: number };
  accepted: number;
  reviewer?: { runtime: string; model?: string };
  sameVendor?: boolean;
  spend: { calls: number; knownUsd: number; unknownCalls: number; incompleteCalls?: number };
  findings: readonly {
    id: string;
    severity: string;
    status: string;
    rounds?: number;
    disposition?: {
      decision: 'accepted-limitation' | 'continue';
      by: 'lead' | 'operator';
      round: number;
    };
    /** Сырой текст находки: проекция маскирует, затем обрезает. */
    message?: string;
  }[];
  escalation?: { round: number; findings: readonly string[] };
  line?: string;
  lineEn?: string;
  /**
   * Те же строки по частям: имена (ID предмета, refs) проекция маскирует и
   * сокращает серединой, вердикт и раунды остаются. Есть — вместо `line`.
   */
  lineParts?: { ru: readonly LinePart[]; en: readonly LinePart[] };
}

/** Фаза записи проверки или ревью попытки. */
type Phase = 'candidate' | 'integration';
/** Простой текст на двух языках (причина отказа попытки). */
interface Plain2 {
  ru: string;
  en: string;
}

/**
 * Событие ленты «кто что делал» из записей хранилища (загрузчик): начало и
 * конец попытки, приёмка, проверки, раунды ревью, эскалация, вопросы и
 * ответы. Проекция формулирует фразу, отбирает окно, сортирует и усекает.
 */
export type OperatorActivityInput =
  | { kind: 'attempt.started'; at: string; workId: string; attempt: number; runtime: string }
  | {
      kind: 'attempt.ended';
      at: string;
      workId: string;
      attempt: number;
      /** `failed`, `cancelled`, `expired`, `interrupted` (штатная остановка). */
      outcome: 'failed' | 'cancelled' | 'expired' | 'interrupted';
      /** Почему: класс отказа простыми словами. */
      reason?: Plain2;
      /** Попытка не засчитана в предел (окружение, остановка, вопрос). */
      uncounted?: boolean;
    }
  | {
      kind: 'work.accepted';
      at: string;
      workId: string;
      attempt: number;
      sha?: string;
      ref?: string;
    }
  | {
      kind: 'gate';
      at: string;
      workId: string;
      attempt: number;
      gate: string;
      phase: Phase;
      passed: boolean;
      recheck?: 'flaky' | 'confirmed';
      reused?: boolean;
      /** Команда gate не запустилась (отказ песочницы): проверки не было. */
      notLaunched?: boolean;
    }
  | {
      kind: 'review';
      at: string;
      scope: 'plan' | 'contract' | 'code' | 'attempt';
      subject: string;
      /** Как назвать предмет во фразе (у ревью кода — область и refs); нет — `subject`. */
      label?: string;
      workId?: string;
      attempt?: number;
      phase?: Phase;
      round?: number;
      approved: boolean;
      blocking: number;
      reviewer: string;
      /**
       * Что reviewer делал по записи controller: `diff-only` — команд не
       * запускал, `commands` — запускал (`commands` — сколько); нет —
       * неизвестно, и фраза об этом молчит.
       */
      inspection?: 'diff-only' | 'commands';
      commands?: number;
    }
  | {
      kind: 'review.escalated';
      at: string;
      scope: 'plan' | 'contract' | 'code';
      subject: string;
      workId?: string;
      findings: number;
      round: number;
    }
  | { kind: 'question.asked'; at: string; workId: string; requestId: string; severity: number }
  | {
      kind: 'question.answered';
      at: string;
      workId: string;
      requestId: string;
      by: 'operator' | 'lead' | 'host';
      basis?: 'technical' | 'severity';
    };

/** Бюджет области (`budgetView`). */
export interface OperatorBudgetInput {
  scope: { kind: 'work' | 'group' | 'total'; id?: string };
  state: 'within' | 'exceeded' | 'undetermined';
  limit: { usd?: number; timeMs?: number };
  reportedUsd: number;
  estimatedUsd: number;
  unknownCalls: number;
  uncoveredRuns: number;
  durationMs: number;
}

export interface OperatorViewInput {
  /** Внедрённые часы, epoch ms. */
  now: number;
  producer?: string;
  harnessVersion: string;
  stateVersion: number;
  policy: Pick<
    ExecutionPolicy,
    | 'approvalMode'
    | 'mode'
    | 'concurrency'
    | 'roles'
    | 'review'
    | 'repositories'
    | 'maxAttempts'
    | 'repairBudget'
    | 'budgets'
    | 'runTimeoutMs'
    | 'leaseMs'
    | 'gateTimeoutFloorMs'
  >;
  policyDigest: string;
  /** Действующие значения без умолчаний в политике: вопросы, обход зависших, предел раундов. */
  effective: {
    inputPolicy: {
      threshold: number;
      criticalPaths: readonly unknown[];
      leadAnswers?: { maxSeverity?: number; technical?: boolean };
    };
    stall: { intervalMs: number; quietMs: number; stalledMs: number; action: 'stop' | 'report' };
    reviewRoundCap: number;
  };
  /** Пути настроек представления, взятые из умолчаний harness. */
  defaulted: readonly string[];
  /** `profile.layers` манифеста проекта; нет — манифест не найден. */
  manifestLayers?: readonly string[];
  works: readonly OperatorWorkInput[];
  attempts: readonly OperatorAttemptInput[];
  gateEvents: readonly OperatorGateEvent[];
  calls: readonly OperatorCallInput[];
  questions: readonly OperatorQuestionInput[];
  reviews: readonly OperatorReviewInput[];
  /**
   * Раунды ревью для итогов окна: план, контракт, код (`review-code`) и ревью
   * в попытке (`attempt`: кандидат и интеграция); по одной записи на раунд.
   */
  reviewRounds?: readonly { kind: 'plan' | 'contract' | 'code' | 'attempt'; at: string }[];
  /**
   * Наблюдаемые длительности этапов (`stage.name`) по закончившимся этапам
   * попыток; проекция показывает их у работы на этом этапе при достаточном
   * числе образцов.
   */
  stageTypical?: Readonly<Record<string, StageTypical>>;
  /** Остановки, которые ждут человека или ведущего (`explain`), и пауза очереди. */
  stops: readonly {
    workId?: string;
    subject?: string;
    code: string;
    actor: HarnessActor;
    action: string;
    since?: string;
  }[];
  queue: {
    paused: boolean;
    reason?: string;
    detail?: string;
    actor?: HarnessActor;
    action?: string;
  };
  controller?: { leaseUntil: number };
  /** `budgetOverview`; `undefined` — в политике нет бюджетов. */
  budgets?: readonly OperatorBudgetInput[];
  warnings?: readonly { code: string; message: string; messageEn?: string }[];
  /** Предметов ревью, которых нет в `reviews` (предел сводки загрузчика). */
  reviewsOmitted?: number;
  /** События ленты «кто что делал»; нет — производитель ленту не ведёт (поля нет в документе). */
  activity?: readonly OperatorActivityInput[];
  /** Что маскировать: домашний каталог, корни репозиториев, значения секретов. */
  mask?: MaskContext;
}

export interface OperatorViewOptions {
  /** `false` — без заголовков, текста вопросов, находок и `queue.detail` (`--no-titles`). */
  titles?: boolean;
  /** Окно истории; по умолчанию 24 ч, не больше 7 дней. */
  windowMs?: number;
  /** Ширина интервала истории; по умолчанию 15 мин, у окна длиннее суток — 1 ч. */
  bucketMs?: number;
  /** Язык простых строк harness, у которых есть оба варианта; по умолчанию `ru`. */
  lang?: 'ru' | 'en';
  /** Предел размера документа в байтах UTF-8 (тесты); по умолчанию `OPERATOR_VIEW_LIMITS.bytes`. */
  maxBytes?: number;
}

/* ------------------------------------------------------------------ */
/* Общие правила                                                        */
/* ------------------------------------------------------------------ */

const T = OPERATOR_VIEW_TEXT;
const L = OPERATOR_VIEW_LIMITS;

/** `user` harness — оператор панели. */
const actorOf = (a: HarnessActor | undefined): string | null =>
  a === undefined || a === null ? null : a === 'user' ? 'operator' : a;

const round4 = (x: number) => Math.round(x * 10000) / 10000;
/** Точность сумм `status` (сводка ревью — 1e-6): представление её не огрубляет. */
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | undefined) => (s === undefined ? NaN : Date.parse(s));

/**
 * Граница суммы по правилам отчёта: нет ни одного известного вызова при
 * неизвестных вызовах или попытках без учёта — `unknown`; часть неизвестна
 * или учтена неполно — `lower`; иначе `exact`.
 */
export function boundedUsd(facts: {
  knownUsd: number;
  knownCalls: number;
  unknownCalls: number;
  uncoveredRuns?: number;
  incompleteCalls?: number;
}): Bounded {
  const uncovered = facts.uncoveredRuns ?? 0;
  if (facts.knownCalls === 0 && (facts.unknownCalls > 0 || uncovered > 0))
    return { value: 0, bound: 'unknown' };
  const lower = facts.unknownCalls > 0 || uncovered > 0 || (facts.incompleteCalls ?? 0) > 0;
  return { value: round6(facts.knownUsd), bound: lower ? 'lower' : 'exact' };
}

const utf8 = (s: string) => new TextEncoder().encode(s).length;

/** Каноническая форма: ключи по порядку, `undefined` отброшены (байты детерминированы). */
function canonical<V>(value: V): V {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value) as V;
}

/**
 * Токен содержимого: SHA-256 канонических байтов документа без часов
 * проекции — `generatedAt`, границ окна истории `history.from` и `history.to`
 * (окно кончается в `now`) — и без `source.token`. Равный токен — то же
 * содержимое при тех же языке, окне и работе: два запуска над неизменным
 * состоянием дают один токен. Содержимое, которое честно зависит от часов
 * (истечение аренды, живость, время идущей попытки, событие, вышедшее из
 * окна), меняет токен.
 */
export function viewToken(view: OperatorView | WorkDetailView): string {
  const rest: Record<string, unknown> = { ...view };
  delete rest.generatedAt;
  if ('history' in view) {
    const history: Record<string, unknown> = { ...view.history };
    delete history.from;
    delete history.to;
    rest.history = history;
  }
  const src: Record<string, unknown> = { ...view.source };
  delete src.token;
  return sha256Hex(JSON.stringify(canonical({ ...rest, source: src })));
}

const take = <X>(xs: readonly X[], n: number, truncated: Record<string, number>, key: string) => {
  if (xs.length > n) truncated[key] = (truncated[key] ?? 0) + xs.length - n;
  return xs.slice(0, n);
};

const bindingOf = (
  b: Pick<RuntimeBinding, 'runtime' | 'model' | 'effort'>,
  mask: MaskContext,
): ViewBinding => {
  // Имя модели — свободная строка политики: маскируется до обрезки, как текст.
  const model = maskText(b.model, T.model, mask);
  return {
    runtime: b.runtime,
    ...(model ? { model } : {}),
    ...(b.effort ? { effort: b.effort } : {}),
  };
};

/* ------------------------------------------------------------------ */
/* Разделы                                                             */
/* ------------------------------------------------------------------ */

function settingsOf(i: OperatorViewInput, truncated: Record<string, number>): ViewSettings {
  const p = i.policy;
  const mask = i.mask ?? {};
  const roles: ViewSettings['roles'] = [
    ...Object.entries(p.roles).map(([role, b]) => ({ role, writer: bindingOf(b.writer, mask) })),
    ...p.repositories.flatMap((r) =>
      Object.entries(r.roles ?? {}).map(([role, b]) => ({
        role,
        writer: bindingOf(b.writer, mask),
        repositoryId: r.id,
      })),
    ),
  ];
  type Rule = ExecutionPolicy['review']['code'];
  const rule = (
    kind: 'plan' | 'contract' | 'code',
    r: Rule,
    scope: 'global' | 'repository' | 'role',
    extra: { repositoryId?: string; role?: string } = {},
  ): ViewSettings['reviews'][number] => ({
    kind,
    scope,
    ...extra,
    reviewer: bindingOf(r.reviewer, mask),
    alternates: take(r.alternates ?? [], L.alternates, truncated, 'alternates').map((x) =>
      bindingOf(x, mask),
    ),
    vendor: r.vendor ?? 'different-vendor',
  });
  const reviews: ViewSettings['reviews'] = [
    rule('code', p.review.code, 'global'),
    rule('plan', p.review.plan, 'global'),
    rule('contract', p.review.contract, 'global'),
    ...p.repositories.flatMap((r) =>
      r.review ? [rule('code', r.review, 'repository', { repositoryId: r.id })] : [],
    ),
    ...Object.entries(p.roles).flatMap(([role, b]) =>
      b.review ? [rule('code', b.review, 'role', { role })] : [],
    ),
    ...p.repositories.flatMap((r) =>
      Object.entries(r.roles ?? {}).flatMap(([role, b]) =>
        b.review ? [rule('code', b.review, 'role', { role, repositoryId: r.id })] : [],
      ),
    ),
  ];
  const lead = i.effective.inputPolicy.leadAnswers;
  const budgets: ViewSettings['budgets'] = (['work', 'group', 'total'] as const).flatMap(
    (scope) => {
      const b = p.budgets?.[scope];
      return b
        ? [
            {
              scope,
              ...(b.usd !== undefined ? { usd: b.usd } : {}),
              ...(b.timeMs !== undefined ? { timeMs: b.timeMs } : {}),
            },
          ]
        : [];
    },
  );
  return {
    policyDigest: i.policyDigest,
    approvalMode: p.approvalMode,
    mode: p.mode,
    concurrency: p.concurrency,
    roles: take(roles, L.roles, truncated, 'roles'),
    reviews: take(reviews, L.reviewRules, truncated, 'reviewRules'),
    thresholds: {
      inputSeverity: i.effective.inputPolicy.threshold,
      ...(lead?.maxSeverity !== undefined ? { leadAnswersMaxSeverity: lead.maxSeverity } : {}),
      ...(lead?.technical !== undefined ? { leadAnswersTechnical: lead.technical } : {}),
      criticalPaths: i.effective.inputPolicy.criticalPaths.length,
      maxAttempts: p.maxAttempts,
      repairBudget: p.repairBudget,
      maxNeutralFailures: MAX_NEUTRAL_FAILURES,
      reviewRoundCap: i.effective.reviewRoundCap,
      reviewEscalationRounds: REVIEW_ESCALATION_ROUNDS,
    },
    budgets,
    ...(p.budgets ? { budgetOnUnknown: p.budgets.onUnknown } : {}),
    timeouts: {
      runTimeoutMs: p.runTimeoutMs,
      leaseMs: p.leaseMs,
      ...(p.gateTimeoutFloorMs !== undefined ? { gateTimeoutFloorMs: p.gateTimeoutFloorMs } : {}),
      stall: { ...i.effective.stall },
    },
    lean: {
      state:
        i.manifestLayers === undefined
          ? 'unknown'
          : i.manifestLayers.includes('lean')
            ? 'on'
            : 'off',
    },
    defaulted: [...new Set(i.defaulted)].sort(),
  };
}

interface Ctx {
  i: OperatorViewInput;
  titles: boolean;
  lang: 'ru' | 'en';
  mask: MaskContext;
  attemptOf: Map<string, OperatorAttemptInput>;
}

const text = (c: Ctx, s: string | undefined, max: number) => maskText(s, max, c.mask);
/**
 * Строка из частей не длиннее `max`: имена маскируются и сокращаются
 * серединой, текст шаблона сохраняется (`fitLine`); затем вся строка — через
 * ту же маску, что и `text`.
 */
const fit = (c: Ctx, parts: readonly LinePart[], max: number) =>
  maskText(
    fitLine(parts, max, (t) => maskSecrets(t, c.mask)),
    max,
    c.mask,
  );

/**
 * Имя ветки без `trackingRef`: строка загрузчика длиннее строки без имени —
 * имя было (длиннее предела договора), его заменяет «…»; иначе имени нет.
 */
function unnamed(
  r: { state: 'pushed' | 'not-pushed'; line: string; lineEn: string },
  lang: 'ru' | 'en',
) {
  const loader = (lang === 'en' ? r.lineEn : r.line).trimEnd();
  const bare = fitLine(remoteLineParts(r.state, lang, ''), Infinity).trimEnd();
  return loader.length > bare.length ? '…' : '';
}

/** Удалённая ветка принятой работы: из сверки загрузчика, иначе «неизвестно». */
function remoteView(
  c: Ctx,
  r: NonNullable<OperatorWorkInput['target']>['remote'],
): NonNullable<WorkView['target']>['remote'] {
  if (!r) {
    const reason =
      c.lang === 'en' ? 'the remote branch was not checked' : 'удалённая ветка не проверялась';
    return {
      state: 'unknown',
      reason,
      line: c.lang === 'en' ? `unknown (${reason})` : `неизвестно (${reason})`,
    };
  }
  const reason = c.lang === 'en' ? (r.reasonEn ?? r.reason) : r.reason;
  const trackingRef = text(c, r.trackingRef, 500);
  const reasonText = text(c, reason, T.reason);
  // Строка собирается заново под предел представления: имя ветки
  // маскируется и сокращается серединой, слова состояния остаются. Без
  // `trackingRef` (имя длиннее предела договора) точного имени нет: строка
  // загрузчика несёт его уже сокращённым, без маски — имя заменяет «…».
  const line =
    r.state === 'pushed' || r.state === 'not-pushed'
      ? fit(
          c,
          remoteLineParts(
            r.state,
            c.lang,
            trackingRef ?? unnamed({ ...r, state: r.state }, c.lang),
          ),
          T.line,
        )
      : r.state === 'unknown' && reasonText
        ? fit(c, remoteLineParts(r.state, c.lang, '', reasonText), T.line)
        : text(c, c.lang === 'en' ? r.lineEn : r.line, T.line);
  return {
    state: r.state,
    ...(trackingRef ? { trackingRef } : {}),
    ...(r.checkedAt ? { checkedAt: r.checkedAt } : {}),
    ...(reasonText ? { reason: reasonText } : {}),
    ...(line ? { line } : {}),
  };
}

/** Этапы, у которых есть наблюдаемая длительность: идущие этапы попытки. */
const typicalStages = new Set(['prepare', 'writer', 'gates', 'review', 'integration']);

function workView(c: Ctx, w: OperatorWorkInput, truncated: Record<string, number>): WorkView {
  const s = w.stage;
  const a = w.attemptSummary;
  const facts = w.spendFacts ?? { uncoveredRuns: 0, incompleteCalls: 0 };
  const last = a.lastFailure;
  const lastAttempt = last ? c.attemptOf.get(last.runId)?.attempt : undefined;
  const lastPlain = last
    ? text(c, c.lang === 'en' && last.plainEn ? last.plainEn : last.plain, T.plain)
    : undefined;
  const needsActor = s.needs ? actorOf(s.needs.actor) : null;
  return {
    id: w.id,
    graphId: w.graphId,
    ...(c.titles && w.title ? { title: text(c, w.title, T.title) } : {}),
    status: w.status,
    stage: {
      name: s.name,
      ...(s.step ? { step: text(c, s.step, T.step) } : {}),
      ...(s.since ? { since: s.since } : {}),
      next: [...s.next],
      ...(s.needs ? { needs: { actor: actorOf(s.needs.actor), action: s.needs.action } } : {}),
      ...((t) =>
        t && t.samples >= OPERATOR_VIEW_TYPICAL_MIN_SAMPLES
          ? { typical: { p50Ms: t.p50Ms, p90Ms: t.p90Ms, samples: t.samples } }
          : {})(typicalStages.has(s.name) ? c.i.stageTypical?.[s.name] : undefined),
    },
    attempts: {
      used: a.attempts.used,
      max: a.attempts.max,
      left: a.attempts.left,
      failed: a.failed,
      interrupted: a.interrupted,
      rechecks: w.rechecks,
      neutral: { used: a.neutral.used, max: a.neutral.max },
      // Из чисел строки — уже замаскирована и в пределе: вторая маска поверх
      // метки удлинила бы строку и отрезала хвост. Иначе — строка загрузчика.
      ...((line) => (line ? { line } : {}))(
        a.lineFacts && (c.lang === 'en' ? a.lineEn : a.line) !== undefined
          ? attemptLine(a.lineFacts, c.lang, T.line, (t) => maskSecrets(t, c.mask)).trim() ||
              undefined
          : text(c, c.lang === 'en' ? a.lineEn : a.line, T.line),
      ),
      ...(last && lastAttempt !== undefined && lastPlain
        ? {
            lastFailure: {
              attempt: lastAttempt,
              bucket: last.bucket,
              plain: lastPlain,
              ...(last.at ? { at: last.at } : {}),
            },
          }
        : {}),
    },
    ...(w.liveness ? { liveness: w.liveness } : w.active ? { liveness: 'active' as const } : {}),
    ...(w.active ? { runtime: w.active.runtime } : {}),
    ...((model) => (model ? { model } : {}))(text(c, w.active?.model, T.model)),
    blockers: take(w.blockers, L.blockersPerWork, truncated, 'blockers').map((b) => {
      const plain = c.lang === 'en' && b.plainEn ? b.plainEn : b.plain;
      return {
        code: b.code,
        ...((t) => (t ? { plain: t } : {}))(
          plain
            ? ((parts) => (parts ? fit(c, parts, T.plain) : text(c, plain, T.plain)))(
                holdLineParts(plain),
              )
            : undefined,
        ),
        // Без поля alpha.55 — кто действует по диагнозу этапа работы.
        actor: b.actor !== undefined ? actorOf(b.actor) : needsActor,
      };
    }),
    ...(w.dependsOn?.length
      ? { dependsOn: take(w.dependsOn, L.dependsOn, truncated, 'dependsOn') }
      : {}),
    ...(w.status === 'done' && w.target
      ? {
          target: {
            repositoryId: w.target.repositoryId,
            ref: w.target.ref,
            acceptedSha: w.target.acceptedSha,
            remote: remoteView(c, w.target.remote),
          },
        }
      : {}),
    ...(w.input
      ? {
          question: {
            requestId: w.input.requestId,
            state: w.input.state,
            severity: w.input.severity,
          },
        }
      : {}),
    spend: {
      calls: s.spend.calls,
      usd: boundedUsd({
        knownUsd: s.spend.knownUsd,
        knownCalls: s.spend.calls - s.spend.unknownCalls,
        unknownCalls: s.spend.unknownCalls,
        uncoveredRuns: facts.uncoveredRuns,
        incompleteCalls: facts.incompleteCalls,
      }),
      durationMs: s.spend.durationMs,
    },
    ...(w.resultSha ? { resultSha: w.resultSha } : {}),
  };
}

function reviewView(
  c: Ctx,
  r: OperatorReviewInput,
  truncated: Record<string, number>,
): ReviewSubjectView {
  const findings = take(r.findings, L.findingsPerSubject, truncated, 'findings').map((f) => ({
    id: f.id,
    severity: f.severity,
    status: f.status,
    ...(f.rounds !== undefined ? { rounds: f.rounds } : {}),
    ...(f.disposition ? { disposition: { ...f.disposition } } : {}),
    ...(c.titles && f.message ? { title: text(c, f.message, T.title) } : {}),
  }));
  return {
    kind: r.kind,
    subject: r.subject,
    ...(r.workId ? { workId: r.workId } : {}),
    approved: r.approved,
    rounds: { ...r.rounds },
    open: { ...r.open },
    accepted: r.accepted,
    ...(r.reviewer ? { reviewer: bindingOf(r.reviewer as RuntimeBinding, c.mask) } : {}),
    ...(r.sameVendor !== undefined ? { sameVendor: r.sameVendor } : {}),
    spend: {
      calls: r.spend.calls,
      usd: boundedUsd({
        knownUsd: r.spend.knownUsd,
        knownCalls: r.spend.calls - r.spend.unknownCalls,
        unknownCalls: r.spend.unknownCalls,
        incompleteCalls: r.spend.incompleteCalls ?? 0,
      }),
    },
    findings,
    ...(r.escalation
      ? {
          escalation: {
            // У эскалации ревью нет запроса ввода: ID — предмет и раунд.
            requestId: `${r.kind}:${r.subject}:${r.escalation.round}`,
            findings: take(r.escalation.findings, L.findingsPerSubject, truncated, 'findings'),
            answered: false,
          },
        }
      : {}),
    ...((line) => (line ? { line } : {}))(
      r.lineParts
        ? fit(c, r.lineParts[c.lang], T.line)
        : text(c, c.lang === 'en' ? r.lineEn : r.line, T.line),
    ),
  };
}

const answerer = {
  ru: { operator: 'оператор', lead: 'ведущий', host: 'хост' },
  en: { operator: 'the operator', lead: 'the lead', host: 'the host' },
} as const;
const ruleText = {
  ru: { technical: 'технический вопрос', severity: 'ниже порога серьёзности' },
  en: { technical: 'technical question', severity: 'below the severity threshold' },
} as const;

/**
 * Основание ответа: кто ответил, правило ведущего и его причина. Причина —
 * свободный текст ведущего: маскируется и обрезается, с `--no-titles` её нет
 * (ни в поле, ни в строке).
 */
function answerBasisOf(
  c: Ctx,
  q: OperatorQuestionInput,
  impact: string,
): AnswerBasisView | undefined {
  const a = q.answer;
  if (!a) return undefined;
  const reason = c.titles ? text(c, a.reason, T.reason) : undefined;
  const rule = a.by === 'lead' ? a.basis : undefined;
  const head =
    (c.lang === 'en' ? `answered by ${answerer.en[a.by]}` : `ответил ${answerer.ru[a.by]}`) +
    (rule ? ` (${ruleText[c.lang][rule]})` : '');
  const line = reason ? `${head}: ${reason}` : head;
  return {
    by: a.by,
    ...(rule ? { rule } : {}),
    ...(reason ? { reason } : {}),
    impact,
    at: a.at,
    line: line.length > T.line ? line.slice(0, T.line - 1) + '…' : line,
  };
}

function questionView(c: Ctx, q: OperatorQuestionInput): OperatorQuestion {
  const impact = q.impact ?? 'user-visible';
  const basis = answerBasisOf(c, q, impact);
  return {
    requestId: q.requestId,
    workId: q.workId,
    state: q.state,
    version: q.version,
    severity: q.severity,
    answerableBy: q.leadMay ? 'operator-or-lead' : 'operator',
    impact,
    ...(q.plain ? { plain: text(c, q.plain, T.questionPlain) } : {}),
    ...(q.answeredBy ? { answeredBy: q.answeredBy } : {}),
    ...(basis ? { answerBasis: basis } : {}),
    ...(c.titles && q.text ? { title: text(c, q.text, T.questionTitle) } : {}),
    createdAt: q.createdAt,
  };
}

function driftOf(c: Ctx, w: OperatorWorkInput): DriftView | undefined {
  const t = w.target;
  if (!t || w.status !== 'done') return undefined;
  if (!(t.unavailable !== undefined || t.diverged || (t.commitsSinceAccepted ?? 0) > 0))
    return undefined;
  return {
    workId: w.id,
    repositoryId: t.repositoryId,
    ref: t.ref,
    acceptedSha: t.acceptedSha,
    ...(t.head ? { head: t.head } : {}),
    ...(t.commitsSinceAccepted !== undefined
      ? { commitsSinceAccepted: t.commitsSinceAccepted }
      : {}),
    ...(t.filesSinceAccepted !== undefined ? { filesSinceAccepted: t.filesSinceAccepted } : {}),
    ...(t.diverged ? { diverged: true as const } : {}),
    ...(t.unavailable !== undefined
      ? { unavailable: text(c, t.unavailable, T.unavailable) ?? 'unavailable' }
      : {}),
  };
}

/** Окно истории: `n` интервалов по `bucketMs`, заканчивается в `now`. */
function windowOf(now: number, o: OperatorViewOptions) {
  const windowMs = o.windowMs ?? OPERATOR_VIEW_DEFAULT_WINDOW_MS;
  // Окно длиннее суток без явного интервала — по часу (7 дней — 168 значений).
  const bucketMs =
    o.bucketMs ??
    (windowMs > OPERATOR_VIEW_DEFAULT_WINDOW_MS ? 3_600_000 : OPERATOR_VIEW_DEFAULT_BUCKET_MS);
  if (!Number.isInteger(bucketMs) || bucketMs < 60_000)
    throw new HarnessError('INVALID_INPUT', 'Интервал истории: целое число мс, не меньше минуты');
  if (windowMs % bucketMs !== 0)
    throw new HarnessError('INVALID_INPUT', 'Окно истории должно делиться на интервал без остатка');
  if (!Number.isInteger(windowMs) || windowMs < bucketMs || windowMs > L.windowMs)
    throw new HarnessError(
      'INVALID_INPUT',
      `Окно истории: от одного интервала до ${L.windowMs / 86_400_000} дней`,
    );
  const n = Math.ceil(windowMs / bucketMs);
  if (n > L.buckets)
    throw new HarnessError('INVALID_INPUT', `Окно истории: не больше ${L.buckets} интервалов`);
  return { n, bucketMs, from: now - n * bucketMs, to: now };
}

function historyOf(i: OperatorViewInput, o: OperatorViewOptions): ViewHistory {
  const { n, bucketMs, from, to } = windowOf(i.now, o);
  const zeros = () => new Array<number>(n).fill(0);
  const index = (t: number) =>
    Number.isFinite(t) && t >= from && t <= to
      ? Math.min(n - 1, Math.floor((t - from) / bucketMs))
      : -1;
  const load = zeros();
  const started = zeros();
  const failed = zeros();
  const passed = zeros();
  const gateFailed = zeros();
  const reused = zeros();
  const spend = zeros();
  // Пиковая одновременность попыток в интервале: обход начал и концов.
  const spans = i.attempts
    .map((a) => ({
      s: ms(a.startedAt),
      e: a.finishedAt ? ms(a.finishedAt) : a.status === 'active' ? to : ms(a.startedAt),
    }))
    .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.e) && x.e >= from && x.s <= to);
  for (let b = 0; b < n; b++) {
    const b0 = from + b * bucketMs;
    const b1 = b0 + bucketMs;
    const points: [number, number][] = [];
    for (const x of spans) {
      if (x.e < b0 || x.s >= b1) continue;
      points.push([Math.max(x.s, b0), 1], [Math.max(Math.min(x.e, b1), Math.max(x.s, b0)), -1]);
    }
    points.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    let cur = 0;
    let peak = 0;
    for (const [, d] of points) {
      cur += d;
      if (cur > peak) peak = cur;
    }
    // Мгновенная попытка (начало = конец) всё равно была в работе.
    load[b] = Math.max(peak, spans.some((x) => x.s === x.e && x.s >= b0 && x.s < b1) ? 1 : 0);
  }
  for (const a of i.attempts) {
    const s = index(ms(a.startedAt));
    if (s >= 0) started[s]! += 1;
    if ((a.status === 'failed' || a.status === 'expired') && !a.interrupted) {
      const f = index(ms(a.finishedAt));
      if (f >= 0) failed[f]! += 1;
    }
  }
  for (const g of i.gateEvents) {
    if (!g.applicable) continue;
    const k = index(ms(g.at));
    if (k < 0) continue;
    if (g.reused && g.passed) reused[k]! += 1;
    else if (g.passed) passed[k]! += 1;
    else gateFailed[k]! += 1;
  }
  let windowExact = true;
  let windowKnown = 0;
  let windowKnownCalls = 0;
  let windowUnknown = 0;
  let windowIncomplete = 0;
  let windowUncovered = 0;
  let opening = 0;
  let openingKnown = 0;
  let openingUnknown = 0;
  let openingIncomplete = 0;
  for (const call of i.calls) {
    const t = ms(call.at);
    if (t < from) {
      if (call.knownUsd === null) openingUnknown += 1;
      else {
        opening += call.knownUsd;
        openingKnown += 1;
      }
      if (!call.complete) openingIncomplete += 1;
      continue;
    }
    const k = index(t);
    if (k < 0) continue;
    if (call.knownUsd === null || !call.complete) windowExact = false;
    if (call.knownUsd !== null) {
      spend[k]! += call.knownUsd;
      windowKnown += call.knownUsd;
      windowKnownCalls += 1;
    } else windowUnknown += 1;
    if (!call.complete) windowIncomplete += 1;
  }
  // Попытка без записей вызовов (`callsRecorded`): её расход неизвестен.
  let openingUncovered = 0;
  for (const a of i.attempts) {
    if (a.callsRecorded || a.status === 'active') continue;
    const end = ms(a.finishedAt ?? a.startedAt);
    if (end < from) openingUncovered += 1;
    else if (end <= to) {
      windowExact = false;
      windowUncovered += 1;
    }
  }
  const budgetUsd = i.policy.budgets?.total?.usd;
  // Итоги окна — те же правила, что у рядов: неудачные попытки по классу
  // отказа (сумма равна attemptsFailed), время попыток в пределах окна.
  const byBucket: Record<string, number> = {};
  for (const a of i.attempts) {
    if ((a.status !== 'failed' && a.status !== 'expired') || a.interrupted) continue;
    if (index(ms(a.finishedAt)) < 0) continue;
    const bucket = a.failureBucket ?? 'unclassified';
    byBucket[bucket] = (byBucket[bucket] ?? 0) + 1;
  }
  const clipped = spans
    .map((x) => ({ s: Math.max(x.s, from), e: Math.min(x.e, to) }))
    .filter((x) => x.e >= x.s)
    .sort((x, y) => x.s - y.s || x.e - y.e);
  let wallMs = 0;
  let attemptMs = 0;
  let runS = NaN;
  let runE = NaN;
  for (const x of clipped) {
    attemptMs += x.e - x.s;
    if (!(x.s <= runE)) {
      if (Number.isFinite(runS)) wallMs += runE - runS;
      runS = x.s;
      runE = x.e;
    } else runE = Math.max(runE, x.e);
  }
  if (Number.isFinite(runS)) wallMs += runE - runS;
  const rounds = { plan: 0, contract: 0, code: 0, attempt: 0 };
  for (const r of i.reviewRounds ?? []) if (index(ms(r.at)) >= 0) rounds[r.kind] += 1;
  const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
  const totals: ViewHistoryTotals = {
    attemptsStarted: sum(started),
    attemptsFailed: sum(failed),
    failuresByBucket: byBucket,
    gatesPassed: sum(passed),
    gatesFailed: sum(gateFailed),
    gatesReused: sum(reused),
    reviewRounds: rounds,
    spendUsd: boundedUsd({
      knownUsd: windowKnown,
      knownCalls: windowKnownCalls,
      unknownCalls: windowUnknown,
      uncoveredRuns: windowUncovered,
      incompleteCalls: windowIncomplete,
    }),
    wallMs: Math.round(wallMs),
    attemptMs: Math.round(attemptMs),
    loadPeak: Math.max(0, ...load),
  };
  return {
    from: iso(from),
    to: iso(to),
    bucketMs,
    load,
    attemptsStarted: started,
    attemptsFailed: failed,
    gatesPassed: passed,
    gatesFailed: gateFailed,
    gatesReused: reused,
    spendUsd: spend.map(round4),
    spendBound: windowExact ? 'exact' : 'lower',
    spendOpeningUsd: boundedUsd({
      knownUsd: opening,
      knownCalls: openingKnown,
      unknownCalls: openingUnknown,
      uncoveredRuns: openingUncovered,
      incompleteCalls: openingIncomplete,
    }),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    totals,
  };
}

const runningStages = new Set(['prepare', 'writer', 'gates', 'review', 'integration']);
const budgetRank = { exceeded: 0, undetermined: 1, within: 2 } as const;

function healthOf(
  c: Ctx,
  o: OperatorViewOptions,
  truncated: Record<string, number>,
): Omit<ViewHealth, 'warnings'> & { warnings: ViewHealth['warnings'] } {
  const i = c.i;
  const { from, to } = windowOf(i.now, o);
  const unknownCalls = i.calls.filter((x) => x.knownUsd === null).length;
  const known = i.calls.filter((x) => x.knownUsd !== null);
  const uncovered = i.attempts.filter((a) => !a.callsRecorded && a.status !== 'active').length;
  const accepted = i.works.filter((w) => w.status === 'done' && w.target);
  const budgets = i.budgets
    ? i.budgets
        .map((b, k) => ({ b, k }))
        .sort(
          (x, y) =>
            // Общий и группы — первыми, затем худшие состояния работ: обзор
            // показывает худшее, даже если строки работ усечены.
            Number(x.b.scope.kind === 'work') - Number(y.b.scope.kind === 'work') ||
            (x.b.scope.kind === 'work' ? budgetRank[x.b.state] - budgetRank[y.b.state] : 0) ||
            x.k - y.k,
        )
        .map(({ b }) => {
          const usd = b.reportedUsd + b.estimatedUsd;
          return {
            scope: b.scope.kind,
            ...(b.scope.id !== undefined ? { id: b.scope.id } : {}),
            state: b.state,
            spentUsd:
              usd === 0 && (b.unknownCalls > 0 || b.uncoveredRuns > 0)
                ? { value: 0, bound: 'unknown' as const }
                : {
                    value: round4(usd),
                    bound:
                      b.unknownCalls > 0 || b.uncoveredRuns > 0
                        ? ('lower' as const)
                        : ('exact' as const),
                  },
            ...(b.limit.usd !== undefined ? { limitUsd: b.limit.usd } : {}),
            spentMs: Math.round(b.durationMs),
            ...(b.limit.timeMs !== undefined ? { limitMs: b.limit.timeMs } : {}),
          };
        })
    : [];
  const warnings = [...(i.warnings ?? [])].map((w) => ({
    code: w.code,
    message: text(c, c.lang === 'en' && w.messageEn ? w.messageEn : w.message, T.message) ?? w.code,
  }));
  const driftUnavailable = accepted.filter((w) => w.target!.unavailable !== undefined).length;
  if (driftUnavailable)
    warnings.push({
      code: 'DRIFT_UNAVAILABLE',
      message:
        c.lang === 'en'
          ? `target ref of ${driftUnavailable} accepted work(s) could not be read: not verified since acceptance`
          : `target ref принятых работ (${driftUnavailable}) не прочитан: после приёмки не проверено`,
    });
  return {
    controller: i.controller
      ? { present: i.controller.leaseUntil > i.now, leaseUntil: iso(i.controller.leaseUntil) }
      : { present: false },
    stalledAttempts: i.works.filter((w) => w.liveness === 'stalled').length,
    quietAttempts: i.works.filter((w) => w.liveness === 'quiet').length,
    environmentFailures: i.attempts.filter((a) => {
      const t = ms(a.finishedAt);
      return a.failureBucket === 'environment' && t >= from && t <= to;
    }).length,
    budgeting: i.budgets ? 'on' : 'off',
    budgets: take(budgets, L.reviews, truncated, 'budgets'),
    // Сумма — как `report.cost.knownUsd`: до центов.
    spentTotalUsd: boundedUsd({
      knownUsd: Math.round(known.reduce((s, x) => s + x.knownUsd!, 0) * 100) / 100,
      knownCalls: known.length,
      unknownCalls,
      uncoveredRuns: uncovered,
      incompleteCalls: i.calls.filter((x) => !x.complete).length,
    }),
    drift: {
      checked: accepted.length,
      drifted: accepted.filter(
        (w) =>
          w.target!.unavailable === undefined &&
          (w.target!.diverged || (w.target!.commitsSinceAccepted ?? 0) > 0),
      ).length,
      unavailable: driftUnavailable,
    },
    warnings,
  };
}

function escalationsOf(c: Ctx): Escalation[] {
  const i = c.i;
  // Время из хранилища; момент запроса — только когда его нет и там (пауза
  // записи прежней версии без `pausedAt`): `since` обязателен в версии 1.
  const at = iso(i.now);
  const stops = i.stops
    .filter((s) => s.actor === 'user' || s.actor === 'lead' || s.actor === 'operator')
    .map((s) => ({
      ...(s.workId ? { workId: s.workId } : {}),
      ...(s.subject ? { subject: s.subject } : {}),
      code: s.code,
      actor: actorOf(s.actor)!,
      action: s.action,
      since: s.since ?? at,
    }));
  const reviews = i.reviews
    .filter((r) => r.escalation)
    .map((r) => ({
      subject: r.subject,
      ...(r.workId ? { workId: r.workId } : {}),
      code: 'REVIEW_ESCALATION',
      actor: 'operator',
      action: 'user-decision',
      since: r.at,
    }));
  return [...stops, ...reviews];
}

/* ------------------------------------------------------------------ */
/* Кто что делал                                                       */
/* ------------------------------------------------------------------ */

const phaseWord = {
  ru: { candidate: 'кандидат', integration: 'интеграция' },
  en: { candidate: 'candidate', integration: 'integration' },
} as const;
const scopeWord = {
  ru: { plan: 'план', contract: 'контракт', code: 'код', attempt: 'изменения работы' },
  en: { plan: 'the plan', contract: 'the contract', code: 'the code', attempt: 'the changes of' },
} as const;
const whoAnswered = {
  ru: { operator: 'оператор', lead: 'ведущий', host: 'хост' },
  en: { operator: 'the operator', lead: 'the lead', host: 'the host' },
} as const;
const sha12 = (x: string | undefined) => (x ? x.slice(0, 12) : undefined);

/**
 * Фраза из частей: строка подстановки — имя (ID, ветка, gate; сокращается
 * серединой), число и массив частей — текст шаблона (не сокращается).
 */
function parts(strings: TemplateStringsArray, ...values: (string | number | LinePart[])[]) {
  const out: LinePart[] = [];
  strings.forEach((fixed, i) => {
    if (fixed) out.push(fixed);
    if (i >= values.length) return;
    const v = values[i]!;
    if (typeof v === 'string') out.push(named(v));
    else if (typeof v === 'number') out.push(String(v));
    else out.push(...v);
  });
  return out;
}

/** Фраза, исполнитель и код одного события ленты. */
function activityLine(
  e: OperatorActivityInput,
  lang: 'ru' | 'en',
): { actor: string; action: string; plain: LinePart[]; workId?: string; subject?: string } {
  const ru = lang === 'ru';
  switch (e.kind) {
    case 'attempt.started':
      return {
        actor: 'controller',
        action: e.kind,
        workId: e.workId,
        plain: ru
          ? parts`контроллер запустил попытку ${e.attempt} работы ${e.workId}; пишет ${e.runtime}`
          : parts`the controller started attempt ${e.attempt} of ${e.workId}; ${e.runtime} writes`,
      };
    case 'attempt.ended': {
      const why = e.reason ? (ru ? e.reason.ru : e.reason.en) : undefined;
      const free = e.uncounted
        ? ru
          ? '; попытка не расходуется'
          : '; the attempt is not counted'
        : '';
      const head = ru
        ? {
            failed: parts`попытка ${e.attempt} работы ${e.workId} не удалась`,
            cancelled: parts`попытка ${e.attempt} работы ${e.workId} отменена`,
            expired: parts`попытка ${e.attempt} работы ${e.workId} потеряла владельца`,
            interrupted: parts`попытка ${e.attempt} работы ${e.workId} прервана остановкой`,
          }[e.outcome]
        : {
            failed: parts`attempt ${e.attempt} of ${e.workId} failed`,
            cancelled: parts`attempt ${e.attempt} of ${e.workId} was cancelled`,
            expired: parts`attempt ${e.attempt} of ${e.workId} lost its owner`,
            interrupted: parts`attempt ${e.attempt} of ${e.workId} was interrupted by a shutdown`,
          }[e.outcome];
      return {
        actor: 'controller',
        action: `attempt.${e.outcome}`,
        workId: e.workId,
        plain: [...head, ...(why ? [': ', named(why)] : []), free],
      };
    }
    case 'work.accepted': {
      const sha = sha12(e.sha);
      const at: LinePart[] =
        sha && e.ref
          ? parts`: ${[sha]}${[ru ? ' в ' : ' on ']}${e.ref}`
          : sha
            ? [': ' + sha]
            : e.ref
              ? parts`: ${e.ref}`
              : [];
      return {
        actor: 'controller',
        action: e.kind,
        workId: e.workId,
        plain: ru
          ? parts`работа ${e.workId} принята (попытка ${e.attempt})${at}, локально`
          : parts`${e.workId} was accepted (attempt ${e.attempt})${at}, locally`,
      };
    }
    case 'gate': {
      const where = ru
        ? parts`работа ${e.workId}, попытка ${e.attempt}, ${[phaseWord.ru[e.phase]]}`
        : parts`${e.workId}, attempt ${e.attempt}, ${[phaseWord.en[e.phase]]}`;
      const action = e.notLaunched
        ? 'gate.not-launched'
        : e.reused
          ? 'gate.reused'
          : e.recheck
            ? 'gate.recheck'
            : e.passed
              ? 'gate.passed'
              : 'gate.failed';
      const plain = e.notLaunched
        ? ru
          ? parts`проверка ${e.gate} не запустилась — отказ среды, проверки не было (${where})`
          : parts`check ${e.gate} did not start — environment failure, nothing was checked (${where})`
        : e.reused
          ? ru
            ? parts`проверка ${e.gate} взята с кандидата: то же дерево, не запускалась (${where})`
            : parts`check ${e.gate} was reused from the candidate: same tree, not run (${where})`
          : e.recheck
            ? e.recheck === 'flaky'
              ? ru
                ? parts`перепроверка ${e.gate} прошла: первый провал был случайным (${where})`
                : parts`recheck of ${e.gate} passed: the first failure was random (${where})`
              : ru
                ? parts`перепроверка ${e.gate} подтвердила провал (${where})`
                : parts`recheck of ${e.gate} confirmed the failure (${where})`
            : ru
              ? parts`контроллер запустил проверку ${e.gate}: ${[e.passed ? 'прошла' : 'не прошла']} (${where})`
              : parts`the controller ran check ${e.gate}: ${[e.passed ? 'passed' : 'failed']} (${where})`;
      return { actor: 'controller', action, workId: e.workId, plain };
    }
    case 'review': {
      const phase = e.phase ? [`, ${phaseWord[lang][e.phase]}`] : [];
      const attempt = e.attempt !== undefined ? e.attempt : '?';
      const what =
        e.scope === 'attempt'
          ? ru
            ? parts`изменения работы ${e.workId ?? e.subject} (попытка ${[String(attempt)]}${phase})`
            : parts`the changes of ${e.workId ?? e.subject} (attempt ${[String(attempt)]}${phase})`
          : parts`${[scopeWord[lang][e.scope]]} ${e.label ?? e.subject}`;
      const round = e.round !== undefined ? (ru ? `, раунд ${e.round}` : `, round ${e.round}`) : '';
      const verdict = e.approved
        ? ru
          ? parts`одобрил ${what}`
          : parts`approved ${what}`
        : ru
          ? parts`вернул ${what}: блокирующих замечаний ${e.blocking}`
          : parts`returned ${what}: ${e.blocking} blocking finding${[e.blocking === 1 ? '' : 's']}`;
      const read =
        e.inspection === 'diff-only'
          ? ru
            ? '; читал diff, ничего не запускал'
            : '; read the diff, ran nothing'
          : e.inspection === 'commands'
            ? ru
              ? `; запускал команды: ${e.commands ?? '?'}`
              : `; ran commands: ${e.commands ?? '?'}`
            : '';
      return {
        actor: 'reviewer',
        action: e.approved ? 'review.approved' : 'review.changes-requested',
        ...(e.workId ? { workId: e.workId } : {}),
        subject: e.subject,
        plain: parts`reviewer ${e.reviewer} ${verdict}${[round]}${[read]}`,
      };
    }
    case 'review.escalated':
      return {
        actor: 'controller',
        action: e.kind,
        ...(e.workId ? { workId: e.workId } : {}),
        subject: e.subject,
        plain: ru
          ? parts`эскалация: ${[scopeWord.ru[e.scope]]} ${e.subject} — блокирующие замечания не решились за раунды ревью (${e.findings}), решение за человеком или ведущим`
          : parts`escalation: ${[scopeWord.en[e.scope]]} ${e.subject} — blocking findings were not resolved by review rounds (${e.findings}); a person or the lead decides`,
      };
    case 'question.asked':
      return {
        actor: 'writer',
        action: e.kind,
        workId: e.workId,
        subject: e.requestId,
        plain: ru
          ? parts`исполнитель задал вопрос ${e.requestId} по работе ${e.workId} (важность ${e.severity})`
          : parts`the writer asked question ${e.requestId} on ${e.workId} (severity ${e.severity})`,
      };
    case 'question.answered': {
      const rule = e.basis ? (ru ? ruleText.ru[e.basis] : ruleText.en[e.basis]) : undefined;
      return {
        actor: e.by,
        action: e.kind,
        workId: e.workId,
        subject: e.requestId,
        plain: ru
          ? parts`${[whoAnswered.ru[e.by]]} ответил на вопрос ${e.requestId} по работе ${e.workId}${[rule ? ` (${rule})` : '']}`
          : parts`${[whoAnswered.en[e.by]]} answered question ${e.requestId} on ${e.workId}${[rule ? ` (${rule})` : '']}`,
      };
    }
  }
}

/**
 * Лента «кто что делал»: события окна истории, новые сверху, не больше
 * `OPERATOR_VIEW_LIMITS.activity`; опущенное — `truncated.activity`. Нет
 * событий у загрузчика — поля нет.
 */
function activityOf(
  c: Ctx,
  o: OperatorViewOptions,
  truncated: Record<string, number>,
): ActivityView[] | undefined {
  const events = c.i.activity;
  if (!events) return undefined;
  const { from, to } = windowOf(c.i.now, o);
  const rows = events
    .map((e) => ({ t: ms(e.at), e }))
    .filter((x) => Number.isFinite(x.t) && x.t >= from && x.t <= to)
    .map(({ t, e }) => {
      const line = activityLine(e, c.lang);
      return {
        t,
        // Последний ключ порядка — само событие (сырые ID до маскирования и
        // обрезки): совпавшие после обрезки фразы не зависят от порядка входа.
        key: JSON.stringify(canonical(e)),
        row: {
          at: e.at,
          actor: line.actor,
          action: line.action,
          ...(line.workId ? { workId: line.workId } : {}),
          ...(line.subject ? { subject: line.subject } : {}),
          plain: fit(c, line.plain, T.activity) || line.action,
        },
      };
    })
    .sort(
      (a, b) =>
        b.t - a.t ||
        (a.row.action < b.row.action ? -1 : a.row.action > b.row.action ? 1 : 0) ||
        (a.row.plain < b.row.plain ? -1 : a.row.plain > b.row.plain ? 1 : 0) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .map((x) => x.row);
  return take(rows, L.activity, truncated, 'activity');
}

/* ------------------------------------------------------------------ */
/* Размер                                                              */
/* ------------------------------------------------------------------ */

function finish<V extends OperatorView | WorkDetailView>(view: V, maxBytes: number): V {
  const done = canonical(view);
  done.source.token = viewToken(done);
  const bytes = utf8(JSON.stringify(done));
  if (bytes > maxBytes)
    throw new HarnessError(
      'VIEW_TOO_LARGE',
      `Представление оператора: ${bytes} байт UTF-8 больше предела ${maxBytes}; частичный документ не выдаётся`,
      [{ path: ['view'], message: `${bytes} > ${maxBytes}` }],
    );
  return done;
}

const truncation = <K extends string>(t: Record<string, number>) => {
  const keys = Object.keys(t).filter((k) => t[k]! > 0);
  return keys.length
    ? (Object.fromEntries(keys.sort().map((k) => [k, t[k]!])) as Partial<Record<K, number>>)
    : undefined;
};

function context(i: OperatorViewInput, o: OperatorViewOptions): Ctx {
  return {
    i,
    titles: o.titles !== false,
    lang: o.lang ?? 'ru',
    mask: i.mask ?? {},
    attemptOf: new Map(i.attempts.map((a) => [a.runId, a])),
  };
}

const sourceOf = (i: OperatorViewInput): ViewSource => ({
  producer: i.producer ?? 'devcontour-harness',
  producerVersion: i.harnessVersion,
  stateVersion: i.stateVersion,
  token: '',
});

/** Вопросы: ждущие ответа — первыми, затем новые сверху. */
const questionOrder = (a: OperatorQuestionInput, b: OperatorQuestionInput) =>
  Number(b.state === 'awaiting-answer') - Number(a.state === 'awaiting-answer') ||
  b.createdAt.localeCompare(a.createdAt) ||
  (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0);

/* ------------------------------------------------------------------ */
/* Проекции                                                            */
/* ------------------------------------------------------------------ */

/**
 * Документ обзора (`harness view`). Чистая функция: тот же вход, часы и
 * опции — те же байты. Отказ — `HarnessError` (`INVALID_INPUT` для окна,
 * `VIEW_TOO_LARGE` для размера).
 */
export function operatorView(i: OperatorViewInput, o: OperatorViewOptions = {}): OperatorView {
  const c = context(i, o);
  const maxBytes = o.maxBytes ?? L.bytes;
  const truncated: Record<string, number> = {};
  const settings = settingsOf(i, truncated);
  if (i.reviewsOmitted) truncated.reviews = i.reviewsOmitted;
  const history = historyOf(i, o);
  const health = healthOf(c, o, truncated);
  const byStage: Record<string, number> = {};
  for (const w of i.works) byStage[w.stage.name] = (byStage[w.stage.name] ?? 0) + 1;
  const waiting = i.works.filter((w) =>
    w.stage.needs
      ? w.stage.needs.actor === 'user' || w.stage.needs.actor === 'operator'
      : w.input?.state === 'awaiting-answer',
  ).length;
  const q = i.queue;
  const drift = i.works.map((w) => driftOf(c, w)).filter((d): d is DriftView => !!d);
  const activity = activityOf(c, o, truncated);
  const draft: OperatorView = {
    viewVersion: OPERATOR_VIEW_VERSION,
    viewRevision: OPERATOR_VIEW_REVISION,
    generatedAt: iso(i.now),
    source: sourceOf(i),
    settings,
    works: take(i.works, L.works, truncated, 'works').map((w) => workView(c, w, truncated)),
    reviews: take(i.reviews, L.reviews, truncated, 'reviews').map((r) =>
      reviewView(c, r, truncated),
    ),
    questions: take(
      i.questions.filter((x) => !x.closed).sort(questionOrder),
      L.questions,
      truncated,
      'questions',
    ).map((x) => questionView(c, x)),
    escalations: take(escalationsOf(c), L.escalations, truncated, 'escalations'),
    drift: take(drift, L.drift, truncated, 'drift'),
    progress: {
      total: i.works.length,
      byStage,
      running: i.works.filter((w) => runningStages.has(w.stage.name)).length,
      done: i.works.filter((w) => w.stage.name === 'done').length,
      waitingOperator: waiting,
      queue: {
        paused: q.paused,
        ...(q.reason ? { reason: q.reason } : {}),
        ...(c.titles && q.detail ? { detail: text(c, q.detail, T.detail) } : {}),
        ...(q.actor !== undefined && q.actor !== null ? { actor: actorOf(q.actor)! } : {}),
        ...(q.action ? { action: q.action } : {}),
      },
    },
    history,
    health,
    ...(activity ? { activity } : {}),
  };
  const fitted = draft;
  let warnings = [...fitted.health.warnings];
  // Предупреждение об усечении всегда видно: остальные уступают ему место.
  const overflow = warnings.length > L.warnings;
  if (overflow || Object.values(truncated).some((n) => n > 0)) {
    const keep = L.warnings - 1;
    if (warnings.length > keep) truncated.warnings = warnings.length - keep;
    warnings = [
      ...warnings.slice(0, keep),
      {
        code: 'VIEW_TRUNCATED',
        message:
          c.lang === 'en'
            ? 'some lists exceed the view limits: see truncated for the omitted counts'
            : 'часть списков длиннее пределов представления: число опущенных — в truncated',
      },
    ];
  }
  const tr = truncation<TruncatedKey>(truncated);
  return finish(
    {
      ...fitted,
      health: { ...fitted.health, warnings: warnings.slice(0, L.warnings) },
      ...(tr ? { truncated: tr } : {}),
    },
    maxBytes,
  );
}

/** Строки проверки alpha.55 в словаре представления. */
const resultOf: Record<string, string> = {
  passed: 'passed',
  failed: 'failed',
  reused: 'reused',
  'not-applicable': 'skipped',
  skipped: 'not-run',
};
const howOf: Record<string, string> = {
  'executed-by-harness': 'executed',
  'reused-evidence': 'reused',
  'read-by-reviewer': 'read',
  'not-run': 'not-checked',
};

/**
 * Документ деталей работы (`harness view --work <id>`): та же запись
 * работы, строки попыток (новые сверху), проверки, ревью, вопросы и сверка
 * принятого этой работы. Неизвестная работа — `INVALID_INPUT`.
 */
export function workDetailView(
  i: OperatorViewInput,
  workId: string,
  o: OperatorViewOptions = {},
): WorkDetailView {
  const c = context(i, o);
  const maxBytes = o.maxBytes ?? L.bytes;
  const w = i.works.find((x) => x.id === workId);
  if (!w)
    throw new HarnessError('INVALID_INPUT', 'Нет поручения ' + workId.slice(0, 200), [
      { path: ['--work'], message: workId.slice(0, 200) },
    ]);
  const truncated: Record<string, number> = {};
  const attempts = i.attempts
    .filter((a) => a.workId === workId)
    .sort((a, b) => b.attempt - a.attempt || b.startedAt.localeCompare(a.startedAt));
  const rows: AttemptRow[] = take(attempts, L.detailAttempts, truncated, 'attempts').map((a) => ({
    attempt: a.attempt,
    status: a.status,
    ...(a.failureBucket ? { failureBucket: a.failureBucket } : {}),
    ...(a.interrupted ? { interrupted: true as const } : {}),
    runtime: a.runtime,
    ...((model) => (model ? { model } : {}))(text(c, a.model, T.model)),
    startedAt: a.startedAt,
    ...(a.finishedAt ? { finishedAt: a.finishedAt } : {}),
    stages: take(a.stages ?? [], L.stagesPerAttempt, truncated, 'stages').map((s) => {
      const d = ms(s.finishedAt) - ms(s.startedAt);
      return {
        stage: text(c, s.stage, T.step) ?? 'stage',
        ...(Number.isFinite(d) ? { durationMs: Math.max(0, d) } : {}),
        ...(s.outcome ? { outcome: s.outcome } : {}),
      };
    }),
  }));
  const v = w.verification;
  const attemptNo = v ? c.attemptOf.get(v.runId)?.attempt : undefined;
  const verification = v
    ? take(v.rows, L.verificationPerWork, truncated, 'verification').map((r) => ({
        gate: r.consumer ? `${r.gate}@${r.consumer}` : r.gate,
        kind: r.kind,
        phase: r.phase,
        result: resultOf[r.result] ?? r.result,
        how: howOf[r.how] ?? r.how,
        ...(r.reviewer
          ? { by: r.reviewer.runtime }
          : r.how === 'executed-by-harness'
            ? { by: 'harness' }
            : {}),
        ...(attemptNo !== undefined ? { attempt: attemptNo } : {}),
        ...(r.at ? { at: r.at } : {}),
      }))
    : undefined;
  const reviews = i.reviews.filter(
    (r) => r.workId === workId || (r.kind === 'plan' && r.subject === w.graphId),
  );
  const drift = driftOf(c, w);
  const draft: WorkDetailView = {
    viewVersion: OPERATOR_VIEW_VERSION,
    viewRevision: OPERATOR_VIEW_REVISION,
    generatedAt: iso(i.now),
    source: sourceOf(i),
    work: workView(c, w, truncated),
    attempts: rows,
    ...(verification ? { verification } : {}),
    reviews: take(reviews, L.reviews, truncated, 'reviews').map((r) => reviewView(c, r, truncated)),
    questions: take(
      i.questions.filter((q) => q.workId === workId).sort(questionOrder),
      L.questions,
      truncated,
      'questions',
    ).map((x) => questionView(c, x)),
    ...(drift ? { drift } : {}),
  };
  const fitted = draft;
  const tr = truncation<
    | 'attempts'
    | 'findings'
    | 'verification'
    | 'stages'
    | 'reviews'
    | 'questions'
    | 'blockers'
    | 'dependsOn'
  >(truncated);
  return finish({ ...fitted, ...(tr ? { truncated: tr } : {}) }, maxBytes);
}
