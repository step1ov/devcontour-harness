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
import type { SetupProgress } from '../contracts/setup-progress.ts';
import { ruCount } from '../contracts/plural.ts';
import { fitLine, named, type LinePart } from './clip.ts';
import { maskSecrets, maskText, type MaskContext } from './mask.ts';
import { attemptLine, type AttemptLineFacts } from '../contracts/attempt-line.ts';
import { holdLineParts } from './blocker-line.ts';
import { remoteLineParts } from './remote-line.ts';
import { sha256Hex } from './sha256.ts';
import { resourcesOf, type ResourcesInput, type ResourcesView } from './view-resources.ts';
import { decisionSettingsView, type Bilingual, type DecisionSetting } from './decisions.ts';
import type { TrackStep } from './track.ts';

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
  /** Ревизия 6: настройки решений с объяснением и итог одной фразой. */
  decisions?: { items: DecisionSetting[]; summary: Bilingual; warning?: Bilingual };
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
  rounds: { used: number; max: number | null; remaining?: number | null; free?: number };
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
  /** Варианты ответа (ревизия 4). */
  options?: { id: string; label: string; recommended?: true }[];
  /** Обоснование исполнителя (ревизия 4). */
  rationale?: string;
  createdAt: string;
  /** Ревизия 4: где применённый ответ (`carrierLine`). */
  line?: string;
}

/** Вопрос владельцу из источника задач (ревизия 4), только чтение. */
export interface SourceQuestionView {
  connector: string;
  provider: string;
  id: string;
  ref: string;
  title?: string;
  question?: string;
  options?: string[];
  recommendation?: string;
  provisional?: string;
  tasks?: string[];
  url?: string;
  readAt: string;
}

/** Весь срез прогона (ревизия 4, P10). */
export interface ScopeView {
  total?: number;
  tasks: {
    id: string;
    connector: string;
    key?: string;
    title?: string;
    workId?: string;
    state: 'in-harness' | 'not-handed-over' | 'not-ready';
    plain?: string;
  }[];
}

/**
 * Прогноз выпуска (ревизия 4, P11): готовность всего объёма и время. Числа
 * и строки — одни для `status --human` и панели. Неизвестное — без поля,
 * никогда не нулём.
 */
export interface ForecastView {
  progress: {
    /** Готово, % от всего объёма (взвешенно по этапам). */
    percent: number;
    /** Сумма весов: принято — 1, в работе — доля пройденных этапов. */
    weighted: number;
    total: number;
    done: number;
    inWork: number;
    left: number;
    /**
     * Объём: задачи связки (`scope`) или только работы harness. С ревизии 5
     * `scope` — весь выпуск (все задачи всех снимков связки и все работы
     * состояния), а не последний срез `run`.
     */
    basis: 'scope' | 'works';
    line: string;
    /** Открытые доработки после приёмки (вес 1 у работы, остаток — во времени); нет — доработок нет. */
    rework?: number;
    /** Ревизия 5: задачи, добавленные в выпуск после его начала (по первому снимку с ними). */
    added?: {
      key: string;
      workId?: string;
      at: string;
      before: number;
      after: number;
      line: string;
    }[];
    /**
     * Ревизия 5: готовность каждой работы — не падает на повторе (наибольший
     * дошедший этап всех попыток), засчитанная попытка из предела и что идёт.
     */
    works?: {
      workId: string;
      key?: string;
      percent: number;
      attempt?: { n: number; max: number };
      /** `repair` — повтор исправляет замечания прошлой попытки; `answer` — продолжает после вопроса. */
      retry?: 'repair' | 'answer';
      /** Доработка после приёмки: `percent` — её готовность. */
      rework?: true;
      line: string;
    }[];
    /**
     * Ревизия 6: планируемые задачи — ещё не утверждённые (задачи
     * несогласованных снимков, задачи выпуска вне снимков, зарегистрированные
     * несогласованные работы); вес 0. `line` — две цифры: «по утверждённому
     * плану ~X %; с планируемыми (N задач, не утверждены: …) ~Y %».
     */
    planned?: { count: number; keys: string[]; line: string };
    /** Ревизия 6: готовность и время только по утверждённому плану (есть при планируемых). */
    approved?: {
      percent: number;
      total: number;
      done: number;
      left: number;
      loMs?: number;
      hiMs?: number;
    };
    /** Ревизия 6: шаги ведущего — 10 % выпуска поровну: план, вопросы, доставка, отчёт. */
    lead?: {
      steps: {
        step: 'plan' | 'questions' | 'delivery' | 'report';
        weight: number;
        done: boolean;
      }[];
      weighted: number;
      total: number;
    };
    /**
     * Ревизия 6: состояние выпуска — `in-work`, `code-accepted` (весь код
     * принят, итогового отчёта ведущего ещё нет) или `done` (после `harness
     * release done`).
     */
    release?: {
      state: 'in-work' | 'code-accepted' | 'done';
      doneAt?: string;
      summary?: string;
      line: string;
    };
  };
  time: {
    /** Начало выпуска (первый снимок связки или первая попытка объёма) и сколько прошло с него. */
    startedAt?: string;
    elapsedMs?: number;
    /** Ревизия 5: выпуск закончен (всё принято) — конец последней попытки; `elapsedMs` — до него. */
    finishedAt?: string;
    /** Осталось: диапазон по наблюдённым попыткам; нет — неизвестно. */
    remaining?: { loMs: number; hiMs: number; samples: number; attemptsPerTask: number };
    /**
     * Ревизия 5: грубая оценка, пока закончившихся попыток выпуска меньше
     * `OPERATOR_VIEW_TYPICAL_MIN_SAMPLES` (но хотя бы одна): разброс — от
     * самой короткой до самой долгой попытки; строка — «грубо, по N попыткам».
     */
    rough?: { loMs: number; hiMs: number; samples: number; attemptsPerTask: number };
    /** Ревизия 5: чем названо «осталось» — `precise`, `rough`, `unknown` (ни одной закончившейся попытки) или `nothing`. */
    estimate?: 'precise' | 'rough' | 'unknown' | 'nothing';
    /** Ревизия 6: длина цепочки зависимостей незаконченных работ (в долях задачи) — нижняя граница не короче её. */
    chain?: number;
    /** Ревизия 6: работа ведущего отдельной долей (не входит в `remaining`). */
    lead?: { ms: number; samples: number; line: string };
    /** Ожидание людей и ведущего сейчас (`ms` — самое долгое) — в прогноз не входит. */
    humanWait: { works: number; ms: number; since?: string };
    line: string;
  };
  assumptions: string[];
}

/** Принятые работы связки, оставленные на проверку человеку в источнике (ревизия 5). */
export interface SourceReviewView {
  connector: string;
  provider: string;
  tasks: { taskId: string; key?: string; workId: string; column: string; since: string }[];
  line: string;
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
  /** Ревизия 4: порядок снятия, когда блокировки снимают разные участники. */
  step?: number;
}

export interface WorkView {
  id: string;
  graphId: string;
  title?: string;
  status: string;
  /** Ревизия 6: план работы ещё не согласован, попыток не было — «ещё не утверждена». */
  planned?: true;
  /** Ревизия 7: работа инфраструктуры harness (`kind: infra`). */
  kind?: 'infra';
  /**
   * Ревизия 6: работа, отменённая прежней версией harness во время доработки
   * после приёмки (`cancelled` с доработкой), показана принятой (`done`,
   * `resultSha` — прежняя приёмка); состояние не переписано — его чинит
   * `harness cancel`. `restoredLine` — «принято на <sha>; доработка отменена».
   */
  restoredFrom?: 'cancelled-rework';
  restoredLine?: string;
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
    /** Ревизия 5: запусков всего, в том числе незасчитанных; `used` — засчитанные. */
    runs?: number;
    /** Доработка после приёмки: прежняя приёмка и свой ли предел попыток. */
    rework?: { revision: number; fresh: boolean; acceptedSha: string; acceptedAt?: string };
    line?: string;
    /**
     * `kind` — класс отказа движка (`failureKind`), `counted` — засчитана ли
     * попытка в предел (ревизия 4): панель не разбирает фразу `plain`.
     */
    lastFailure?: {
      attempt: number;
      bucket: string;
      plain: string;
      at?: string;
      kind?: string;
      counted?: boolean;
    };
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
  /** `line` (ревизия 4) — где ответ: у идущей попытки или ждёт следующей. */
  question?: { requestId: string; state: string; severity: number; line?: string };
  spend: { calls: number; usd: Bounded; durationMs: number };
  resultSha?: string;
  /** Ревизия 6: путь работы целиком (`workTrack`). */
  track?: { steps: TrackStep[]; truncated?: number };
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
  /** Связки с источниками задач (ревизия 4). */
  sources?: {
    connector: string;
    provider: string;
    level?: string;
    taskContext?: boolean;
    contractVersion?: number;
    line?: string;
    checkedAt: string;
  }[];
}

export type TruncatedKey =
  | 'scope'
  | 'sourceQuestions'
  | 'sourceReviews'
  | 'forecastWorks'
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
  | 'activity'
  | 'workFields'
  | 'whatsNew'
  | 'planned'
  | 'leadNotes'
  | 'resources'
  | 'previews';

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
    queue: {
      paused: boolean;
      reason?: string;
      detail?: string;
      actor?: string;
      action?: string;
      /** Ревизия 4: кто двигает очередь (`status.runner`). */
      runner?: 'running' | 'not-running';
      /**
       * Ревизия 4 (0.1.0-alpha.62): harness с этим каталогом ещё ничего не
       * запускал — ни работ, ни попыток, ни controller; `line` — фраза о
       * первом запуске. Поля нет — состояние уже есть.
       */
      neverRun?: true;
      restartBy?: string;
      line?: string;
    };
  };
  history: ViewHistory;
  health: ViewHealth;
  activity?: ActivityView[];
  scope?: ScopeView;
  /**
   * Почему `scope` нет (0.1.0-alpha.62): `no-snapshot` — ни одна связка ещё не
   * записала снимок задач трекера в каталог состояния; `unreadable` — база
   * коннектора есть, но эта версия её не прочитала (чужая схема, другая
   * версия, повреждение). Раздел `scope`, опущенный по размеру, называет
   * `truncated.scope`, а не это поле.
   */
  scopeReason?: 'no-snapshot' | 'unreadable';
  sourceQuestions?: SourceQuestionView[];
  /** Ревизия 5: принятые работы, ждущие проверки человека в источнике задач. */
  sourceReviews?: SourceReviewView[];
  /** Ревизия 5: этап проекта — `setup` (настройка, задач нет) или `work`; ревизия 7 — ход настройки. */
  stage?: { name: 'setup' | 'work'; lines: string[]; progress?: SetupProgress };
  forecast?: ForecastView;
  updates?: UpdatesView;
  /**
   * Ревизия 6: планируемые задачи без работы harness — в несогласованном
   * снимке связки (`validated`) или только в последнем чтении (`read`).
   * Карточка «ещё не утверждена»: попыток и действий нет.
   */
  planned?: PlannedView[];
  /** Ревизия 6: ведущий — сессия, последняя запись, журнал (новые сверху). */
  lead?: LeadView;
  /** Ревизия 6: что задействовано (модели, изоляция, toolchain, сервисы, проверки). */
  resources?: ResourcesView;
  /** Живые превью результата (0.1.0-alpha.66); нет — ни одно не идёт. */
  previews?: PreviewView[];
  truncated?: Partial<Record<TruncatedKey, number>>;
}

/** Планируемая задача (ревизия 6). */
export interface PlannedView {
  id: string;
  connector: string;
  taskId: string;
  key?: string;
  title?: string;
  status: 'planned';
  from: 'validated' | 'read';
  graphId?: string;
  dependsOn?: string[];
  line: string;
}

/** Ведущий (ревизия 6): сессия `lead begin|end`, заметки и команды. */
export interface LeadView {
  active: boolean;
  since?: string;
  until?: string;
  endedAt?: string;
  lastNote?: { at: string; plain: string };
  notes: { at: string; kind: string; action: string; workId?: string; plain: string }[];
  line: string;
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
  stages: { stage: string; durationMs?: number; outcome?: 'passed' | 'failed'; unused?: true }[];
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
  /**
   * Ревизия 6: работа зарегистрирована, но её план не согласован и попыток
   * не было (не доработка) — планируемая, «ещё не утверждена».
   */
  planned?: true;
  /** Ревизия 6: проекция показывает её принятой (`acceptedAsRestored`); загрузчик поле не ставит. */
  restoredFrom?: 'cancelled-rework';
  /** Ревизия 7: работа инфраструктуры harness (`kind: infra`). */
  kind?: 'infra';
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
    /**
     * Доработка после приёмки (`status` `attemptSummary.rework`): числа
     * сводки — только её попытки. Нет — доработок не было.
     */
    rework?: {
      revision: number;
      fresh: boolean;
      acceptedSha: string;
      acceptedAt?: string;
      earlierRuns: number;
    };
    /** alpha.55 (`attemptSummary.lastFailure`); `kind`, `counted` — alpha.60. */
    lastFailure?: {
      runId: string;
      bucket: string;
      plain: string;
      plainEn?: string;
      at?: string;
      kind?: string;
      counted?: boolean;
    };
  };
  /** Путь работы (`workTrack`): шаги на языке представления; нет — поля нет. */
  track?: {
    ru: { steps: TrackStep[]; truncated: number };
    en: { steps: TrackStep[]; truncated: number };
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
    step?: number;
  }[];
  input?: {
    requestId: string;
    state: string;
    severity: number;
    carrier?: { attempt: number; running: boolean };
  };
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
  /** Попытка прежней редакции работы, доработанной после приёмки: готовность доработки её не считает. */
  earlier?: true;
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
  /** Самый дальний этап попытки (`prepare` … `integration`) по её замерам: прогресс не падает на повторе. */
  reached?: string;
  stages?: readonly {
    stage: string;
    startedAt: string;
    finishedAt?: string;
    outcome?: 'passed' | 'failed';
    unused?: true;
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
  /** Варианты ответа (сырые) и рекомендуемый вариант. */
  options?: readonly { id: string; label: string }[];
  recommended?: string | null;
  /** Сырое обоснование исполнителя. */
  rationale?: string;
  /** Действующая политика разрешает ответ ведущему (`leadMayAnswer`). */
  leadMay: boolean;
  /** Попытка, за которой закреплён применённый ответ (`status.works[].input.carrier`). */
  carrier?: { attempt: number; running: boolean };
}

/** Предмет ревью: план и контракт (`reviewSubjectSummary`) и код (`review-code`). */
export interface OperatorReviewInput {
  kind: 'plan' | 'contract' | 'code';
  subject: string;
  workId?: string;
  at: string;
  approved: boolean;
  rounds: { used: number; max: number | null; remaining?: number | null; free?: number };
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
      /** Новая редакция изменила постановку принятой работы: доработка `revision`. */
      kind: 'work.reopened';
      at: string;
      workId: string;
      revision: number;
      /** Прежняя приёмка. */
      sha: string;
      /** У доработки свой предел попыток (иначе перенесён). */
      fresh: boolean;
    }
  | {
      /** Ревизия 6: доработка оставлена — работа вернулась к принятой редакции. */
      kind: 'work.rework-abandoned';
      at: string;
      workId: string;
      revision: number;
      /** Принятый результат, к которому вернулась работа. */
      sha: string;
      by: 'operator' | 'host' | 'graph';
    }
  | {
      /** Ревизия 6: запись журнала ведущего (команда harness, заметка, начало и конец сессии, итог). */
      kind: 'lead';
      at: string;
      action: string;
      workId?: string;
      plain: string;
      plainEn?: string;
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
  /** Ревизия 7: ход настройки по записям на диске; показывается, пока работ нет. */
  setup?: SetupProgress;
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
    /** `status.runner`: кто двигает очередь и фраза о нём. */
    runner?: 'running' | 'not-running';
    /** Состояния ещё нет или в нём нет ни работ, ни попыток, ни controller; `line` — о первом запуске. */
    neverRun?: boolean;
    restartBy?: HarnessActor;
    /** alpha.67: работы, которые сдвинет новый запуск (`status.runner.ready`). */
    ready?: number;
    /** alpha.67: их ID (`status.runner.readyWorks`, все). */
    readyWorks?: readonly string[];
    /** alpha.67: работы, которые держит только вопрос исполнителя (`status.runner.heldByQuestion`). */
    heldByQuestion?: readonly string[];
    line?: string;
    lineEn?: string;
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
  /**
   * Связки с источниками задач (состояние коннекторов в каталоге состояния):
   * последний снимок и последнее наблюдение backend. Нет — связок нет (полей
   * `scope`, `sourceQuestions`, `health.sources` в документе нет).
   */
  sources?: readonly OperatorSourceInput[];
  /** Баз коннектора, которые есть, но не прочитаны; есть — `scopeReason: unreadable`, а не `no-snapshot`. */
  sourcesUnread?: number;
  /** Обновления по последней проверке `harness update --check` (ревизия 4); нет — поля нет. */
  updates?: UpdatesView;
  /** Журнал ведущего (ревизия 6, `harness lead …`, `release done`); нет — ведущий не записывал. */
  lead?: OperatorLeadInput;
  /** Что задействовано (ревизия 6, P4-8); нет — поля нет. */
  resources?: ResourcesInput;
  /** Живые превью результата (receipt `harness preview-start`); нет — поля нет. */
  previews?: readonly PreviewView[];
}

/** Журнал ведущего из состояния (локальная запись `lead`): сессия, записи, итог выпуска. */
export interface OperatorLeadInput {
  session?: { since: string; until: string; endedAt?: string };
  entries: readonly {
    at: string;
    kind: 'note' | 'command' | 'begin' | 'end' | 'release-done';
    action: string;
    workId?: string;
    plain: string;
    plainEn?: string;
  }[];
  release?: { doneAt: string; summary: string };
}

/** Связка с источником задач: срез последнего снимка, совместимость, вопросы владельцу. */
export interface OperatorSourceInput {
  connector: string;
  provider: string;
  /**
   * Объём выпуска: все задачи всех снимков связки (доска), с последним
   * известным состоянием и временем первого снимка задачи. Нет — только срез.
   */
  release?: readonly {
    id: string;
    key: string;
    title?: string;
    workId?: string;
    orderId: string;
    column?: string;
    firstSeenAt?: string;
    /** Граф снимка (выборка задач), в котором задача записана последней. */
    graphId?: string;
    /** Зависимости поручения задачи по снимку (orderId): для критического пути. */
    dependsOn?: readonly string[];
    /** Задача есть в записанном снимке (проверенный план); нет — только в последнем чтении. */
    snapshot?: true;
    problems: readonly { code: string; message: string }[];
  }[];
  /**
   * Работы harness, доставленные в источник (последняя операция доставки —
   * принятая и доставленная): шаг ведущего «доставка в источник».
   */
  delivered?: readonly string[];
  /** Время первого снимка связки: начало выпуска по источнику. */
  releaseStartedAt?: string;
  /** Принятые работы, оставленные в источнике на проверку человеку (`completion.mode: review-only`). */
  reviews?: readonly {
    taskId: string;
    key?: string;
    workId: string;
    column: string;
    since: string;
  }[];
  /** Задачи последнего снимка в порядке конфигурации. */
  tasks: readonly {
    id: string;
    key: string;
    title?: string;
    /** ID работы harness (`orderId`), если такая работа зарегистрирована. */
    workId?: string;
    orderId: string;
    /** Коды и сырые причины, по которым задача не допускается к запуску. */
    problems: readonly { code: string; message: string }[];
  }[];
  compatibility?: {
    level: string;
    taskContext: boolean;
    taskContextUsed: boolean;
    contractVersion: number | null;
    recommended: string;
  };
  /** Когда связка последний раз читала backend (наблюдение). */
  observedAt?: string;
  questions?: readonly {
    id: string;
    key: string;
    title: string;
    question?: string;
    options: readonly string[];
    recommendation?: string;
    provisional?: string;
    targets: readonly string[];
    url?: string;
  }[];
}

/**
 * Обновления harness и панели (ревизия 4): что стоит, что доступно, режим,
 * время проверки, строка для человека, что нового и команда установки.
 */
export interface UpdatesView {
  state: 'up-to-date' | 'available' | 'needs-decision' | 'unavailable' | 'not-checked';
  mode: 'auto' | 'notify' | 'off';
  current: { harness: string; ui?: string };
  available?: { harness: string; ui?: string };
  checkedAt?: string;
  line: string;
  whatsNew?: string[];
  command?: string;
}

/**
 * Живое превью результата (`harness preview-start`, docs/previews.md):
 * панель показывает адрес «Посмотреть результат» и «остановить»
 * (`harness preview-stop --preview <id>`).
 */
export interface PreviewView {
  id: string;
  repositoryId: string;
  title?: string;
  url: string;
  /** Что просили: `accepted` или ref/SHA. */
  ref: string;
  sha: string;
  /** Поручение, чей принятый результат показан. */
  workId?: string;
  startedAt: string;
  expiresAt: string;
  state: 'running';
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
  /**
   * Идёт попытка: сумма ещё растёт — не `exact`; без единой известной
   * стоимости — `unknown` (runtime по подписке стоимость не сообщает).
   */
  running?: boolean;
}): Bounded {
  const uncovered = facts.uncoveredRuns ?? 0;
  if (facts.knownCalls === 0 && (facts.unknownCalls > 0 || uncovered > 0 || facts.running))
    return { value: 0, bound: 'unknown' };
  const lower =
    facts.unknownCalls > 0 || uncovered > 0 || (facts.incompleteCalls ?? 0) > 0 || !!facts.running;
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
  // Прогноз зависит от часов (прошло, ожидание сейчас) — в токен входят его
  // точки отсчёта (`startedAt`, `humanWait.since`), а не прошедшее время.
  if ('forecast' in view && view.forecast) {
    const time: Record<string, unknown> = { ...view.forecast.time };
    delete time.elapsedMs;
    delete time.line;
    const wait: Record<string, unknown> = { ...view.forecast.time.humanWait };
    delete wait.ms;
    time.humanWait = wait;
    rest.forecast = { ...view.forecast, time };
  }
  if ('stage' in view && view.stage?.progress) rest.stage = stageTokenBody(view.stage);
  const src: Record<string, unknown> = { ...view.source };
  delete src.token;
  return sha256Hex(JSON.stringify(canonical({ ...rest, source: src })));
}

/**
 * Этап для токена (ревизия 7): ход настройки зависит от часов — в токен
 * входят начало (`since`), бюджет, превышение и шаги, а не прошедшее время и
 * строка с ним.
 */
function stageTokenBody(stage: { progress?: SetupProgress }): Record<string, unknown> {
  if (!stage.progress) return stage;
  const progress: Record<string, unknown> = { ...stage.progress };
  delete progress.elapsedMs;
  delete progress.line;
  delete progress.lineEn;
  return { ...stage, progress };
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
    decisions: decisionSettingsView(
      p,
      i.defaulted.flatMap((d) =>
        d === 'thresholds.maxAttempts'
          ? ['maxAttempts']
          : d.startsWith('decisions.')
            ? [d.slice('decisions.'.length)]
            : [],
      ),
    ),
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

/**
 * Где применённый ответ (ревизия 4): у идущей попытки — ждать нечего; у
 * закончившейся, не передавшей его исполнителю, — его получит следующая.
 */
export function carrierLine(
  carrier: { attempt: number; running: boolean } | undefined,
  lang: 'ru' | 'en',
  state?: string,
): string | undefined {
  if (!carrier) return undefined;
  if (carrier.running)
    return lang === 'en'
      ? `the answer is with running attempt ${carrier.attempt} — nothing to wait for`
      : `ответ у идущей попытки ${carrier.attempt} — ждать нечего`;
  // Передан исполнителю закончившейся попыткой: он его получил.
  if (state === 'delivered')
    return lang === 'en'
      ? `the answer was passed to attempt ${carrier.attempt}`
      : `ответ передан попытке ${carrier.attempt}`;
  return lang === 'en'
    ? `attempt ${carrier.attempt} had the answer and stopped before passing it to the writer — the next attempt gets it`
    : `ответ был у попытки ${carrier.attempt}, она остановилась до передачи исполнителю — его получит следующая попытка`;
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
    ...(w.planned ? { planned: true as const } : {}),
    ...(w.kind === 'infra' ? { kind: 'infra' as const } : {}),
    ...(w.restoredFrom
      ? {
          restoredFrom: w.restoredFrom,
          restoredLine:
            c.lang === 'en'
              ? `accepted at ${w.resultSha?.slice(0, 7)}; rework cancelled`
              : `принято на ${w.resultSha?.slice(0, 7)}; доработка отменена`,
        }
      : {}),
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
      // Только при расхождении с засчитанными: иначе число то же, что `used`.
      ...(a.lineFacts && a.lineFacts.total !== a.attempts.used ? { runs: a.lineFacts.total } : {}),
      ...(a.rework
        ? {
            rework: {
              revision: a.rework.revision,
              fresh: a.rework.fresh,
              acceptedSha: a.rework.acceptedSha,
              ...(a.rework.acceptedAt ? { acceptedAt: a.rework.acceptedAt } : {}),
            },
          }
        : {}),
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
              ...(last.kind ? { kind: last.kind } : {}),
              ...(last.counted !== undefined ? { counted: last.counted } : {}),
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
        ...(b.step !== undefined ? { step: b.step } : {}),
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
            ...((l) => (l ? { line: l } : {}))(carrierLine(w.input.carrier, c.lang, w.input.state)),
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
        running: !!w.active,
      }),
      durationMs: s.spend.durationMs,
    },
    ...(w.resultSha ? { resultSha: w.resultSha } : {}),
    ...((t) =>
      t
        ? {
            track: {
              steps: t.steps.slice(-L.trackSteps),
              ...(t.truncated + Math.max(0, t.steps.length - L.trackSteps)
                ? { truncated: t.truncated + Math.max(0, t.steps.length - L.trackSteps) }
                : {}),
            },
          }
        : {})(w.track?.[c.lang]),
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
    rounds: {
      used: r.rounds.used,
      max: r.rounds.max,
      ...(r.rounds.remaining !== undefined ? { remaining: r.rounds.remaining } : {}),
      ...(r.rounds.free !== undefined ? { free: r.rounds.free } : {}),
    },
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
    ...(c.titles && q.options?.length
      ? {
          options: q.options.slice(0, L.questionOptions).map((x) => ({
            id: x.id,
            label: text(c, x.label, T.option) ?? x.id,
            ...(q.recommended === x.id ? { recommended: true as const } : {}),
          })),
        }
      : {}),
    ...(c.titles && q.rationale?.trim() ? { rationale: text(c, q.rationale, T.rationale) } : {}),
    createdAt: q.createdAt,
    ...((l) => (l ? { line: l } : {}))(carrierLine(q.carrier, c.lang, q.state)),
  };
}

/** Простые строки причин неготовности задачи по коду снимка (английские — по коду). */
const notReadyEn: Record<string, string> = {
  TASK_DONE: 'the task is already done',
  TASK_CANCELLED: 'the task is cancelled',
  COLUMN_NOT_ELIGIBLE: 'the task column does not allow a run',
  DEPENDENCY_UNFINISHED: 'a dependency is not finished',
  DEPENDENCY_UNPROVEN: 'a dependency is done without proof from this connector',
  LIMIT_EXCEEDED: 'the task exceeds a context limit',
  DOCUMENT_MISSING: 'a required document is missing',
  MAPPING_INVALID: 'the criteria mapping does not match the task',
};

/** Срез прогона по связкам: все задачи последнего снимка (P10). */
function scopeOf(c: Ctx, truncated: Record<string, number>): ScopeView | undefined {
  const sources = c.i.sources;
  if (!sources?.length) return undefined;
  const works = new Set(c.i.works.map((w) => w.id));
  // Две связки одного проекта (два файла состояния) — задача один раз.
  const seen = new Set<string>();
  const all = sources.flatMap((src) =>
    src.tasks
      .flatMap((t) => {
        if (seen.has(t.orderId)) return [];
        seen.add(t.orderId);
        return [t];
      })
      .map((t) => {
        const workId = t.workId ?? (works.has(t.orderId) ? t.orderId : undefined);
        const first = t.problems[0];
        const state: ScopeView['tasks'][number]['state'] = workId
          ? 'in-harness'
          : first
            ? 'not-ready'
            : 'not-handed-over';
        const plain =
          state === 'not-ready'
            ? c.lang === 'en'
              ? (notReadyEn[first!.code] ?? first!.code)
              : text(c, first!.message, T.plain)
            : state === 'not-handed-over'
              ? c.lang === 'en'
                ? 'not handed over to harness yet'
                : 'ещё не передана в harness'
              : undefined;
        return {
          id: t.id,
          connector: src.connector,
          ...(t.key ? { key: t.key.slice(0, 200) } : {}),
          ...(c.titles && t.title ? { title: text(c, t.title, T.title) } : {}),
          ...(workId ? { workId } : {}),
          state,
          ...(plain ? { plain } : {}),
        };
      }),
  );
  const tasks = take(all, L.scope, truncated, 'scope');
  return { ...(all.length > tasks.length ? { total: all.length } : {}), tasks };
}

/** Вопросы владельцу из источников задач: последнее наблюдение связки. */
function sourceQuestionsOf(
  c: Ctx,
  truncated: Record<string, number>,
): SourceQuestionView[] | undefined {
  const sources = c.i.sources?.filter((s) => s.questions && s.observedAt);
  if (!sources?.length) return undefined;
  const all = sources.flatMap((src) =>
    src.questions!.map((q): SourceQuestionView => ({
      connector: src.connector,
      provider: src.provider,
      id: q.id,
      ref: (q.key || q.id).slice(0, 200),
      ...(c.titles ? { title: text(c, q.title, T.questionTitle) } : {}),
      ...(c.titles && q.question ? { question: text(c, q.question, T.questionTitle) } : {}),
      ...(c.titles && q.options.length
        ? {
            options: q.options.slice(0, L.questionOptions).map((x) => text(c, x, T.option) ?? ''),
          }
        : {}),
      ...(c.titles && q.recommendation
        ? { recommendation: text(c, q.recommendation, T.questionPlain) }
        : {}),
      ...(c.titles && q.provisional
        ? { provisional: text(c, q.provisional, T.questionPlain) }
        : {}),
      ...((tasks) => (tasks.length ? { tasks } : {}))(
        q.targets
          .filter((x) => x.length > 0)
          .slice(0, 20)
          .map((x) => x.slice(0, 200)),
      ),
      ...(q.url && q.url.length <= T.url ? { url: q.url } : {}),
      readAt: src.observedAt!,
    })),
  );
  return take(all, L.sourceQuestions, truncated, 'sourceQuestions');
}

/**
 * Планируемые задачи (ревизия 6, P4-5): задачи выпуска без работы harness,
 * не закрытые и не отменённые в источнике, — из несогласованного снимка
 * связки (`validated`) или только из последнего чтения (`read`).
 */
function plannedOf(c: Ctx, truncated: Record<string, number>): PlannedView[] | undefined {
  const sources = c.i.sources;
  if (!sources?.length) return undefined;
  const works = new Set(c.i.works.map((w) => w.id));
  const seen = new Set<string>();
  const all: PlannedView[] = [];
  for (const src of sources)
    for (const t of src.release ?? src.tasks) {
      const id = t.workId ?? t.orderId;
      if (seen.has(id)) continue;
      seen.add(id);
      if (works.has(id)) continue;
      const column = 'column' in t ? (t.column as string | undefined) : undefined;
      if (column === 'done' || column === 'cancelled') continue;
      if (t.problems.some((p) => p.code === 'TASK_DONE' || p.code === 'TASK_CANCELLED')) continue;
      const from = 'snapshot' in t && t.snapshot === true ? 'validated' : 'read';
      const key = t.key ? t.key.slice(0, 200) : undefined;
      const deps = 'dependsOn' in t ? (t.dependsOn as readonly string[] | undefined) : undefined;
      const graphId = 'graphId' in t ? (t.graphId as string | undefined) : undefined;
      const name = key ?? t.id;
      all.push({
        id,
        connector: src.connector,
        taskId: t.id,
        ...(key ? { key } : {}),
        ...(c.titles && t.title ? { title: text(c, t.title, T.title) } : {}),
        status: 'planned',
        from,
        ...(graphId ? { graphId } : {}),
        ...(deps?.length ? { dependsOn: deps.slice(0, L.dependsOn) } : {}),
        line: (c.lang === 'en'
          ? `${name}: not approved yet (${from === 'validated' ? 'in a checked plan that is not approved' : 'read from the source, not in a plan yet'})`
          : `${name}: ещё не утверждена (${from === 'validated' ? 'в проверенном, но не согласованном плане' : 'прочитана из источника, в план ещё не входит'})`
        ).slice(0, T.line),
      });
    }
  return take(all, L.planned, truncated, 'planned');
}

/** Ведущий (ревизия 6, P4-10): сессия с арендой, последняя заметка, журнал новыми сверху. */
function leadOf(c: Ctx, truncated: Record<string, number>): LeadView | undefined {
  const lead = c.i.lead;
  if (!lead) return undefined;
  const en = c.lang === 'en';
  const s = lead.session;
  const active = !!s && !s.endedAt && ms(s.until) > c.i.now;
  const plainOf = (e: OperatorLeadInput['entries'][number]) =>
    text(c, en ? (e.plainEn ?? e.plain) : e.plain, T.activity) || e.action;
  const notes = [...lead.entries].reverse().map((e) => ({
    at: e.at,
    kind: e.kind,
    action: e.action,
    ...(e.workId ? { workId: e.workId } : {}),
    plain: plainOf(e),
  }));
  const note = [...lead.entries].reverse().find((e) => e.kind === 'note');
  const lastNote = note ? { at: note.at, plain: plainOf(note) } : undefined;
  const line = active
    ? en
      ? // Время начала — в данных (`since`): панель показывает его в своём
        // часовом поясе, текст строки его не несёт.
        `the lead is working${lastNote ? `: ${lastNote.plain}` : ''}`
      : `ведущий работает${lastNote ? `: ${lastNote.plain}` : ''}`
    : s?.endedAt
      ? en
        ? 'the lead ended the session'
        : 'ведущий закончил сессию'
      : s
        ? en
          ? 'the lead has not reported for a while (the session lease expired)'
          : 'ведущий давно не отмечался (срок сессии истёк)'
        : en
          ? 'the lead has not started a session'
          : 'ведущий сессию не начинал';
  return {
    active,
    ...(s ? { since: s.since, until: s.until } : {}),
    ...(s?.endedAt ? { endedAt: s.endedAt } : {}),
    ...(lastNote ? { lastNote } : {}),
    notes: take(notes, L.leadNotes, truncated, 'leadNotes'),
    line: line.slice(0, T.line),
  };
}

/** Доля шагов ведущего в готовности выпуска (ревизия 6): план, вопросы, доставка, отчёт. */
const LEAD_SHARE = 0.1;

/** Наименьший остаток открытой доработки в прогнозе времени (доля задачи). */
const REWORK_MIN_REST = 0.05;

/** Этапы попытки по порядку: вес работы в прогнозе — доля пройденных до текущего. */
const STAGE_ORDER = ['prepare', 'writer', 'gates', 'review', 'integration'] as const;

/** Длительность словами: «2 ч 50 мин», «45 мин», «меньше минуты». */
function durationText(msValue: number, lang: 'ru' | 'en'): string {
  const minutes = Math.round(msValue / 60_000);
  if (minutes < 1) return lang === 'en' ? 'under a minute' : 'меньше минуты';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (lang === 'en') return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
  return h ? `${h} ч${m ? ` ${m} мин` : ''}` : `${m} мин`;
}

const rank = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;

/** Попыток: «1 попытке», «2 попыткам», «5 попыткам» (дательный — «по N попыткам»). */
const byAttempts = (n: number, en: boolean) =>
  en
    ? `${n} attempt${n === 1 ? '' : 's'}`
    : `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'попытке' : 'попыткам'}`;

/**
 * Прогноз выпуска (P11, ревизии 5–6). Объём — весь выпуск: все задачи всех
 * снимков связки (доска, а не последний срез `run`) и все работы состояния;
 * отменённые не входят, а отменённая прежней версией доработка принятой
 * работы — принятая работа. Принятая работа — 1, остальные — доля этапов до
 * наибольшего, до которого дошла любая её попытка (`prepare` … `integration`):
 * повтор готовность не снижает. Планируемые (ревизия 6) — задачи
 * несогласованных снимков и задачи выпуска вне снимков, а также
 * зарегистрированные, но не согласованные работы: вес 0, отдельной цифрой
 * «по утверждённому плану» и «с планируемыми». Шаги ведущего (план, вопросы,
 * доставка в источник, итоговый отчёт) — 10 % выпуска поровну; 100 % — только после
 * `release done`. Осталось: незавершённая доля × длительность попытки ×
 * попыток на принятую задачу — от 5 закончившихся попыток выпуска (всех его
 * работ, в том числе отменённых) p50 / p90, меньше — грубый разброс; ни
 * одной — неизвестно. Нижняя граница — не меньше цепочки зависимостей
 * (критический путь) и доли на `concurrency`, верхняя — последовательно.
 * Работа ведущего — отдельной долей по разрывам «приёмка → следующий запуск»
 * этого проекта. Ожидание людей в прогноз не входит и называется отдельно.
 */
function forecastOf(
  c: Ctx,
  scope: ScopeView | undefined,
  truncated: Record<string, number>,
): ForecastView | undefined {
  const i = c.i;
  const en = c.lang === 'en';
  const work = new Map(i.works.map((w) => [w.id, w]));
  const stageWeight = (name: string | undefined) => {
    const k = name ? (STAGE_ORDER as readonly string[]).indexOf(name) : -1;
    return k < 0 ? 0 : k / STAGE_ORDER.length;
  };
  // Наибольший дошедший этап всех попыток работы: повтор не роняет готовность.
  // У доработки после приёмки — только попытки её редакции.
  const reached = new Map<string, number>();
  for (const a of i.attempts)
    if (!a.earlier)
      reached.set(a.workId, Math.max(reached.get(a.workId) ?? 0, stageWeight(a.reached)));
  // Доработка принятой работы, отменённая прежней версией harness (P4-7):
  // отмена доработки — «вернуться к принятому», работа остаётся принятой.
  const abandonedEarlier = (w: OperatorWorkInput) =>
    w.status === 'cancelled' && !!w.attemptSummary.rework;
  const accepted = (w: OperatorWorkInput) =>
    w.status === 'done' || w.stage.name === 'done' || abandonedEarlier(w);
  const progressOf = (w: OperatorWorkInput) =>
    Math.max(stageWeight(w.stage.name), reached.get(w.id) ?? 0);
  // Открытая доработка после приёмки: работа уже принималась, новая редакция — ещё нет.
  const reopened = (w: OperatorWorkInput | undefined) =>
    !!w && !!w.attemptSummary.rework && !accepted(w) && w.status !== 'cancelled';
  // Принятая ранее работа весит 1 и на доработке: прежняя приёмка прогноз не
  // роняет, остаток доработки входит во время, а не в процент.
  const weightOf = (w: OperatorWorkInput | undefined) => {
    if (!w) return 0;
    if (accepted(w) || reopened(w)) return 1;
    return progressOf(w);
  };
  // Единица объёма — работа harness или задача выпуска без работы. Выпуск —
  // все задачи всех снимков связки (доска), а не последний срез `run`, и все
  // работы состояния. Задача, закрытая в источнике без работы harness
  // (`TASK_DONE`, колонка done), — готова; отменённая и отменённая работа в
  // объём не входят. Задача без работы — планируемая (ревизия 6).
  type Unit = {
    id: string;
    work?: OperatorWorkInput;
    closed?: true;
    key?: string;
    title?: string;
    firstSeenAt?: string;
    planned?: 'validated' | 'read' | 'registered';
    deps: readonly string[];
  };
  const seen = new Set<string>();
  const tasks = (i.sources ?? []).flatMap((src) => src.release ?? src.tasks);
  const fromTasks = tasks.flatMap((t): Unit[] => {
    const id = t.workId ?? t.orderId;
    if (seen.has(id)) return [];
    seen.add(id);
    const first = 'firstSeenAt' in t ? (t.firstSeenAt as string | undefined) : undefined;
    const deps =
      ('dependsOn' in t ? (t.dependsOn as readonly string[] | undefined) : undefined) ?? [];
    const meta = {
      id,
      key: t.key,
      ...(t.title ? { title: t.title } : {}),
      ...(first ? { firstSeenAt: first } : {}),
      deps,
    };
    const w = work.get(id);
    if (w)
      return [
        {
          ...meta,
          work: w,
          deps: w.dependsOn ?? deps,
          ...(w.planned ? { planned: 'registered' as const } : {}),
        },
      ];
    const column = 'column' in t ? (t.column as string | undefined) : undefined;
    if (column === 'cancelled' || t.problems.some((p) => p.code === 'TASK_CANCELLED')) return [];
    if (column === 'done' || t.problems.some((p) => p.code === 'TASK_DONE'))
      return [{ ...meta, closed: true }];
    const inSnapshot = 'snapshot' in t && t.snapshot === true;
    return [{ ...meta, planned: inSnapshot ? 'validated' : 'read' }];
  });
  const units: Unit[] = [
    ...fromTasks,
    ...i.works
      .filter((w) => !seen.has(w.id))
      .map((w) => ({
        id: w.id,
        work: w,
        deps: w.dependsOn ?? [],
        ...(w.planned ? { planned: 'registered' as const } : {}),
      })),
  ];
  const basis: ForecastView['progress']['basis'] = tasks.length ? 'scope' : 'works';
  const live = units.filter((u) => !u.work || u.work.status !== 'cancelled' || accepted(u.work));
  const unitWeight = (u: Unit) => (u.closed ? 1 : weightOf(u.work));
  if (!live.length) return undefined;
  const plannedUnits = live.filter((u) => u.planned);
  const approvedUnits = live.filter((u) => !u.planned);
  const total = live.length;
  const weighted = live.reduce((n, u) => n + unitWeight(u), 0);
  const done = live.filter((u) => unitWeight(u) === 1).length;
  const reworks = live.filter((u) => reopened(u.work));
  const inWork = live.filter(
    (u) =>
      u.work !== undefined &&
      (unitWeight(u) < 1 || reopened(u.work)) &&
      runningStages.has(u.work.stage.name),
  ).length;
  const left = total - done;
  const codeAccepted = left === 0 && !reworks.length;
  // Шаги ведущего (ревизия 6): план и согласование, вопросы, доставка в
  // источник, итоговый отчёт — вместе доля выпуска `LEAD_SHARE`, поровну между
  // шагами. Шаг без предмета (вопросов не было, связки нет) в объём не входит.
  const LEAD_STEP = 0;
  const openQuestionStates = new Set(['awaiting-answer', 'answered-not-applied', 'carry-stale']);
  const sourceQuestions = (i.sources ?? []).reduce((n, s) => n + (s.questions?.length ?? 0), 0);
  const delivered = new Set((i.sources ?? []).flatMap((s) => s.delivered ?? []));
  const sourced = new Set(
    tasks.flatMap((t) => t.workId ?? (work.has(t.orderId) ? t.orderId : undefined) ?? []),
  );
  const toDeliver = live.filter(
    (u) => u.work && sourced.has(u.work.id) && accepted(u.work) && !abandonedEarlier(u.work),
  );
  const release = i.lead?.release;
  // Отчёт прежнего выпуска не закрывает новый: он не раньше последнего конца
  // попытки работ выпуска.
  const lastEnd = i.attempts
    .map((a) => ms(a.finishedAt))
    .filter(Number.isFinite)
    .reduce((n, x) => Math.max(n, x), -Infinity);
  const reportDone =
    !!release && codeAccepted && (!Number.isFinite(lastEnd) || ms(release.doneAt) >= lastEnd);
  const leadSteps: {
    step: 'plan' | 'questions' | 'delivery' | 'report';
    weight: number;
    done: boolean;
  }[] = [
    {
      step: 'plan',
      weight: LEAD_STEP,
      done: !plannedUnits.length && !live.some((u) => u.work?.status === 'draft'),
    },
    ...(i.questions.length || sourceQuestions
      ? [
          {
            step: 'questions' as const,
            weight: LEAD_STEP,
            done:
              !sourceQuestions &&
              !i.questions.some((q) => !q.closed && openQuestionStates.has(q.state)),
          },
        ]
      : []),
    ...(sourced.size
      ? [
          {
            step: 'delivery' as const,
            weight: LEAD_STEP,
            done: codeAccepted && toDeliver.every((u) => delivered.has(u.work!.id)),
          },
        ]
      : []),
    { step: 'report', weight: LEAD_STEP, done: reportDone },
  ];
  for (const s of leadSteps) s.weight = round4(LEAD_SHARE / leadSteps.length);
  const leadTotal = LEAD_SHARE;
  const leadWeighted = round4(
    (LEAD_SHARE * leadSteps.filter((s) => s.done).length) / leadSteps.length,
  );
  const releaseDone = codeAccepted && reportDone;
  // Код — (1 − LEAD_SHARE) выпуска, шаги ведущего — LEAD_SHARE. Пока задачи,
  // доработки или шаги ведущего остаются, «100 %» не показывается.
  // Итоговый отчёт ведущего закрывает выпуск: 100 %.
  const percentOf = (w: number, t: number, finished: boolean) =>
    finished
      ? 100
      : Math.min(99, Math.round(100 * ((t ? ((1 - LEAD_SHARE) * w) / t : 0) + leadWeighted)));
  const percent = percentOf(weighted, total, releaseDone);
  // Попытки всех работ выпуска, в том числе отменённых: длительность попытки
  // — по ним (P4-7: «ни одна не закончилась» не говорится при закончившихся).
  const unitIds = new Set(units.flatMap((u) => (u.work ? [u.work.id] : [])));
  const liveIds = new Set(live.flatMap((u) => (u.work ? [u.work.id] : [])));
  const own = i.attempts.filter((a) => unitIds.has(a.workId));
  // Начало выпуска — первый снимок связки или первая попытка объёма, что раньше.
  const starts = [
    ...own.map((a) => ms(a.startedAt)),
    ...(i.sources ?? []).map((src) => ms(src.releaseStartedAt)),
  ].filter(Number.isFinite);
  const startedAt = starts.length ? Math.min(...starts) : undefined;
  // Выпуск закончен (всё принято, ничего не идёт) — время до последнего конца попытки.
  const ends = own.map((a) => ms(a.finishedAt)).filter(Number.isFinite);
  const finishedAt =
    startedAt !== undefined &&
    ends.length &&
    own.every((a) => a.status !== 'active') &&
    live.every((u) => unitWeight(u) === 1) &&
    !reworks.length
      ? Math.max(startedAt, ...ends)
      : undefined;
  const elapsedMs =
    startedAt !== undefined ? Math.max(0, (finishedAt ?? i.now) - startedAt) : undefined;
  const samples = own
    .filter((a) => a.status !== 'active' && a.finishedAt && !a.interrupted)
    .map((a) => ms(a.finishedAt) - ms(a.startedAt))
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  const acceptedIds = new Set(
    live.flatMap((u) => (u.work && accepted(u.work) && liveIds.has(u.work.id) ? [u.work.id] : [])),
  );
  // Попытки, прерванные остановкой, не считаются ни образцами, ни попытками задачи.
  // У принятой доработки — только попытки её редакции (как сводка попыток).
  const acceptedAttempts = own.filter(
    (a) => a.status !== 'active' && !a.interrupted && !a.earlier && acceptedIds.has(a.workId),
  ).length;
  const attemptsPerTask = acceptedIds.size
    ? Math.max(1, Math.round((acceptedAttempts / acceptedIds.size) * 10) / 10)
    : 1;
  const concurrency = Math.max(1, i.policy.concurrency);
  // Остаток единицы: незавершённая доля; у открытой доработки — не меньше
  // малой доли («осталось: ничего» при ней не говорится).
  const restOf = (u: Unit) =>
    reopened(u.work) ? Math.max(REWORK_MIN_REST, 1 - progressOf(u.work!)) : 1 - unitWeight(u);
  // Критический путь (P4-5): самая длинная цепочка остатков по зависимостям
  // внутри набора — параллельно её не сократить.
  const chainOf = (set: readonly Unit[]) => {
    const byId = new Map(set.map((u) => [u.id, u]));
    const memo = new Map<string, number>();
    const walk = (u: Unit, path: Set<string>): number => {
      const hit = memo.get(u.id);
      if (hit !== undefined) return hit;
      if (path.has(u.id)) return 0;
      path.add(u.id);
      let longest = 0;
      for (const d of u.deps) {
        const dep = byId.get(d);
        if (dep) longest = Math.max(longest, walk(dep, path));
      }
      path.delete(u.id);
      const value = restOf(u) + longest;
      memo.set(u.id, value);
      return value;
    };
    return set.reduce((n, u) => Math.max(n, walk(u, new Set())), 0);
  };
  const estimateOf = (set: readonly Unit[]) => {
    const rest = set.reduce((n, u) => n + restOf(u), 0);
    const chain = chainOf(set);
    // Параллельно — не быстрее одной задачи и не быстрее цепочки зависимостей.
    const lowShare = Math.max(rest / concurrency, Math.min(rest, 1), chain);
    const range = (lo: number, hi: number) => ({
      loMs: Math.round(lowShare * lo * attemptsPerTask),
      hiMs: Math.round(Math.max(rest, lowShare) * hi * attemptsPerTask),
      samples: samples.length,
      attemptsPerTask,
    });
    const precise = samples.length >= OPERATOR_VIEW_TYPICAL_MIN_SAMPLES;
    const remaining =
      precise && rest > 0 ? range(rank(samples, 0.5), rank(samples, 0.9)) : undefined;
    // Меньше образцов — грубый разброс от самой короткой до самой долгой попытки выпуска.
    const rough =
      !precise && samples.length > 0 && rest > 0
        ? range(samples[0]!, samples[samples.length - 1]!)
        : undefined;
    return { rest, chain, remaining, rough };
  };
  const whole = estimateOf(live);
  const { rest, remaining, rough } = whole;
  const estimate: NonNullable<ForecastView['time']['estimate']> =
    rest <= 0 && !reworks.length ? 'nothing' : remaining ? 'precise' : rough ? 'rough' : 'unknown';
  // Работа ведущего (P4-10): разрывы «приёмка → следующий запуск» этого
  // проекта (p50) на каждую незаконченную задачу и несделанный шаг ведущего.
  const sorted = [...i.attempts]
    .map((a) => ({ start: ms(a.startedAt), end: ms(a.finishedAt), ok: a.status === 'succeeded' }))
    .filter((a) => Number.isFinite(a.start))
    .sort((a, b) => a.start - b.start);
  const gaps = sorted
    .filter((a) => a.ok && Number.isFinite(a.end))
    .flatMap((a) => {
      const next = sorted.find((b) => b.start >= a.end);
      return next ? [next.start - a.end] : [];
    })
    .sort((a, b) => a - b);
  const leadLeft =
    leadSteps.filter((s) => !s.done).length + live.filter((u) => restOf(u) > 0).length;
  const leadTime =
    gaps.length && leadLeft > 0 && !releaseDone
      ? { ms: Math.round(rank(gaps, 0.5) * leadLeft), samples: gaps.length }
      : undefined;
  const waits = i.stops.filter(
    (s) => (s.actor === 'user' || s.actor === 'lead') && s.workId && liveIds.has(s.workId),
  );
  // Самое долгое текущее ожидание (не сумма: работы ждут параллельно).
  const waitMs = waits.reduce(
    (n, s) => Math.max(n, Number.isFinite(ms(s.since)) ? Math.max(0, i.now - ms(s.since)) : 0),
    0,
  );
  const since = waits
    .map((s) => ms(s.since))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  const humanWait = {
    works: new Set(waits.map((s) => s.workId)).size,
    ms: waitMs,
    ...(since !== undefined ? { since: iso(since) } : {}),
  };
  // Задачи, добавленные после начала выпуска: первый снимок с ними позже первого снимка связки.
  const firstSeen = live
    .map((u) => ms(u.firstSeenAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const releaseFirst = firstSeen[0];
  const added = live
    .filter((u) => u.key && Number.isFinite(ms(u.firstSeenAt)) && ms(u.firstSeenAt) > releaseFirst!)
    .sort((a, b) => ms(a.firstSeenAt) - ms(b.firstSeenAt))
    .slice(0, 10)
    .map((u) => {
      const at = ms(u.firstSeenAt);
      const before = firstSeen.filter((x) => x < at).length;
      const after = firstSeen.filter((x) => x <= at).length;
      const key = text(c, u.key, 200) ?? u.key!;
      return {
        key,
        ...(u.work ? { workId: u.work.id } : {}),
        at: iso(at),
        before,
        after,
        line: en
          ? `task ${key} added (tasks ${before} → ${after})`
          : `добавлена задача ${key} (задач ${before} → ${after})`,
      };
    });
  // Только незаконченные работы и открытые доработки: принятые видны в
  // `works[]` и весят 100 %.
  const open = live.filter((u) => u.work && (unitWeight(u) < 1 || reopened(u.work)));
  if (open.length > L.forecastWorks) truncated.forecastWorks = open.length - L.forecastWorks;
  const works = open.slice(0, L.forecastWorks).map((u) => {
    const w = u.work!;
    const rework = reopened(w);
    const share = rework ? progressOf(w) : unitWeight(u);
    const p = Math.round(100 * share);
    const name = text(c, u.key, 200) ?? w.id;
    const n = w.attemptSummary.attempts.used;
    const max = w.attemptSummary.attempts.max;
    const running = runningStages.has(w.stage.name);
    const failedBefore = w.attemptSummary.failed > 0 || w.attemptSummary.interrupted > 0;
    const retry: 'repair' | 'answer' | undefined =
      running && failedBefore
        ? w.attemptSummary.lastFailure?.bucket === 'input'
          ? 'answer'
          : 'repair'
        : undefined;
    const percentText = `~${Math.min(p === 100 || share === 1 ? 100 : 99, p)} %`;
    const started = running || n > 0 || failedBefore;
    const status =
      share === 1
        ? en
          ? 'accepted'
          : 'принято'
        : running
          ? en
            ? `${percentText}, attempt ${n} of ${max}` +
              (retry === 'repair'
                ? ', fixing the findings'
                : retry === 'answer'
                  ? ', continuing after the answer'
                  : '')
            : `${percentText}, попытка ${n} из ${max}` +
              (retry === 'repair'
                ? ', исправляет замечания'
                : retry === 'answer'
                  ? ', продолжает после ответа'
                  : '')
          : started
            ? en
              ? `${percentText}, between attempts (used ${n} of ${max})`
              : `${percentText}, между попытками (использовано ${n} из ${max})`
            : u.planned
              ? en
                ? 'not approved yet'
                : 'ещё не утверждена'
              : en
                ? 'not started'
                : 'ещё не начата';
    // Доработка принятой ранее работы: «принято ранее; доработка …».
    const line = !rework
      ? `${name}: ${status}`
      : en
        ? `${name}: accepted earlier; rework ${started ? '' : '— '}${status}`
        : `${name}: принято ранее; доработка ${started ? '' : '— '}${status}`;
    return {
      workId: w.id,
      ...(u.key ? { key: name } : {}),
      percent: share === 1 ? 100 : Math.min(99, p),
      ...(n > 0 ? { attempt: { n, max } } : {}),
      ...(retry ? { retry } : {}),
      ...(rework ? { rework: true as const } : {}),
      line: line.slice(0, T.line),
    };
  });
  const spanText = (r: { loMs: number; hiMs: number }) =>
    durationText(r.loMs, c.lang) === durationText(r.hiMs, c.lang)
      ? durationText(r.hiMs, c.lang)
      : `${durationText(r.loMs, c.lang)} – ${durationText(r.hiMs, c.lang)}`;
  // Планируемые (ревизия 6): две цифры — по утверждённому плану и с ними.
  const plannedKeys = plannedUnits
    .map((u) => text(c, u.key, 200) ?? u.id)
    .slice(0, L.forecastPlanned);
  const approvedProgress = (() => {
    if (!plannedUnits.length) return undefined;
    const t = approvedUnits.length;
    const w = approvedUnits.reduce((n, u) => n + unitWeight(u), 0);
    const d = approvedUnits.filter((u) => unitWeight(u) === 1).length;
    const pct = percentOf(w, t, false);
    const est = estimateOf(approvedUnits);
    const r = est.remaining ?? est.rough;
    return {
      percent: pct,
      total: t,
      done: d,
      left: t - d,
      ...(r ? { loMs: r.loMs, hiMs: r.hiMs } : {}),
    };
  })();
  const plannedLine = approvedProgress
    ? (() => {
        const n = plannedUnits.length;
        const keys = plannedKeys.join(', ');
        const approvedLeft =
          approvedProgress.loMs !== undefined
            ? (en ? ', left ~' : ', осталось ~') +
              spanText({ loMs: approvedProgress.loMs, hiMs: approvedProgress.hiMs! })
            : '';
        const allLeft =
          (remaining ?? rough)
            ? (en ? ', left ~' : ', осталось ~') + spanText((remaining ?? rough)!)
            : '';
        return en
          ? `approved plan ~${approvedProgress.percent} %${approvedLeft}; with planned (${n} task(s), not approved: ${keys}) ~${percent} %${allLeft}`
          : `по утверждённому плану ~${approvedProgress.percent} %${approvedLeft}; с планируемыми (${n} ${n % 10 === 1 && n % 100 !== 11 ? 'задача' : 'задач'}, не утверждены: ${keys}) ~${percent} %${allLeft}`;
      })()
    : undefined;
  // Состояние выпуска (ревизия 6): код принят — ещё не «выпуск готов».
  const lastNote = i.lead?.entries.filter((e) => e.kind === 'note').at(-1);
  const releaseState: 'in-work' | 'code-accepted' | 'done' = releaseDone
    ? 'done'
    : codeAccepted
      ? 'code-accepted'
      : 'in-work';
  const releaseLine =
    releaseState === 'done'
      ? en
        ? 'release done: the lead wrote the final report'
        : 'выпуск готов: ведущий написал итоговый отчёт'
      : releaseState === 'code-accepted'
        ? en
          ? `code accepted, the lead is still working${lastNote ? `: ${text(c, lastNote.plainEn ?? lastNote.plain, 120)}` : ''}`
          : `код принят, ведущий ещё работает${lastNote ? `: ${text(c, lastNote.plain, 120)}` : ''}`
        : en
          ? 'code is in work'
          : 'код в работе';
  const progressLine =
    releaseState === 'code-accepted'
      ? `${en ? 'done' : 'готово'} ~${percent} % · ${releaseLine}`
      : en
        ? `done ~${percent} %, ${left} of ${total} task(s) left` +
          (inWork ? `, ${inWork} in work` : '') +
          (reworks.length ? `, reworks after acceptance: ${reworks.length}` : '') +
          (plannedUnits.length ? `, planned (not approved): ${plannedUnits.length}` : '')
        : `готово ~${percent} %, осталось задач: ${left} из ${total}` +
          (inWork ? `, в работе: ${inWork}` : '') +
          (reworks.length ? `, доработок после приёмки: ${reworks.length}` : '') +
          (plannedUnits.length ? `, планируемых (не утверждены): ${plannedUnits.length}` : '');
  const elapsedText =
    elapsedMs === undefined
      ? en
        ? 'not started yet'
        : 'ещё не начиналось'
      : (en ? 'elapsed ' : 'прошло ') + durationText(elapsedMs, c.lang);
  const remainingText =
    estimate === 'nothing'
      ? en
        ? 'nothing left'
        : 'осталось: ничего'
      : remaining
        ? (en ? 'left ~' : 'осталось ~') + spanText(remaining)
        : rough
          ? (en ? 'left ~' : 'осталось ~') +
            spanText(rough) +
            (en
              ? ` (rough, from ${byAttempts(rough.samples, true)})`
              : ` (грубо, по ${byAttempts(rough.samples, false)})`)
          : en
            ? 'time left unknown (no attempt has finished yet)'
            : 'сколько осталось — неизвестно (ещё ни одна попытка не закончилась)';
  const leadText = leadTime
    ? en
      ? ` + lead work ~${durationText(leadTime.ms, c.lang)}`
      : ` + работа ведущего ~${durationText(leadTime.ms, c.lang)}`
    : '';
  // «до 45 мин», но «меньше минуты» — без «до».
  const upTo =
    waitMs < 30_000
      ? durationText(waitMs, c.lang)
      : (en ? 'up to ' : 'до ') + durationText(waitMs, c.lang);
  const waitText = humanWait.works
    ? en
      ? `; waiting for people now: ${humanWait.works} work(s), ${upTo} — not in the estimate`
      : `; ждут людей сейчас: ${humanWait.works}, ${upTo} — в прогноз не входит`
    : '';
  const timeLine = `${elapsedText} · ${remainingText}${leadText}${waitText}`;
  const assumptions = en
    ? [
        basis === 'scope'
          ? 'scope: the whole release — tasks of all source snapshots and harness works; not approved — 0; done in the source — 100 %; cancelled — out'
          : 'scope: all harness works (no task source)',
        'accepted = 100 %; a work — the furthest stage any of its attempts reached',
        `time left: unfinished share × attempt duration × attempts per task; from ${OPERATOR_VIEW_TYPICAL_MIN_SAMPLES} attempts p50–p90, fewer — rough; low end parallel, not below the dependency chain`,
        'lead: 10 % of the release, 100 % after release done; lead time — median gap acceptance → next attempt',
      ]
    : [
        basis === 'scope'
          ? 'объём: весь выпуск — задачи всех снимков связки и работы harness; не утверждённые — 0; закрытая в источнике — 100 %; отменённая — вне'
          : 'объём: все работы harness (связки нет)',
        'принято — 100 %; работа — наибольший этап любой её попытки',
        `осталось: незавершённая доля × длительность попытки × попыток на задачу; от ${OPERATOR_VIEW_TYPICAL_MIN_SAMPLES} попыток p50–p90, меньше — грубо; нижняя — параллельно, не короче цепочки зависимостей`,
        'ведущий: 10 % выпуска, 100 % — после release done; его время — медиана «приёмка → следующая попытка»',
      ];
  void scope;
  return {
    progress: {
      percent,
      weighted: Math.round(weighted * 100) / 100,
      total,
      done,
      inWork,
      left,
      basis,
      line: progressLine.slice(0, T.line),
      ...(reworks.length ? { rework: reworks.length } : {}),
      ...(added.length ? { added } : {}),
      ...(works.length ? { works } : {}),
      ...(approvedProgress && plannedLine
        ? {
            planned: {
              count: plannedUnits.length,
              keys: plannedKeys,
              line: plannedLine.slice(0, T.line),
            },
            approved: approvedProgress,
          }
        : {}),
      lead: {
        steps: leadSteps,
        weighted: leadWeighted,
        total: leadTotal,
      },
      release: {
        state: releaseState,
        ...(release && releaseDone ? { doneAt: release.doneAt } : {}),
        ...(release && releaseDone && c.titles
          ? { summary: text(c, release.summary, T.releaseSummary)! }
          : {}),
        line: releaseLine.slice(0, T.line),
      },
    },
    time: {
      ...(startedAt !== undefined && elapsedMs !== undefined
        ? { startedAt: iso(startedAt), elapsedMs }
        : {}),
      ...(finishedAt !== undefined ? { finishedAt: iso(finishedAt) } : {}),
      ...(remaining ? { remaining } : {}),
      ...(rough ? { rough } : {}),
      estimate,
      ...(whole.chain > 0 ? { chain: Math.round(whole.chain * 100) / 100 } : {}),
      ...(leadTime
        ? {
            lead: {
              ...leadTime,
              line: (en
                ? `lead work ~${durationText(leadTime.ms, c.lang)} (from ${leadTime.samples} gap(s) acceptance → next attempt)`
                : `работа ведущего ~${durationText(leadTime.ms, c.lang)} (по ${leadTime.samples} разрывам «приёмка → следующая попытка»)`
              ).slice(0, T.line),
            },
          }
        : {}),
      humanWait,
      line: timeLine.slice(0, T.line),
    },
    assumptions,
  };
}

/** Строка совместимости связки для раздела «Здоровье». */
function sourceLine(
  c: Ctx,
  src: OperatorSourceInput,
): NonNullable<ViewHealth['sources']>[number] | undefined {
  if (!src.observedAt) return undefined;
  const k = src.compatibility;
  const line = !k
    ? undefined
    : k.taskContextUsed
      ? c.lang === 'en'
        ? 'Relay with task context: the writer gets the feature and scenario description'
        : 'Relay с контекстом задачи: исполнитель получает описание функции и сценария'
      : k.taskContext
        ? c.lang === 'en'
          ? 'task context is turned off in the connector configuration'
          : 'контекст задачи выключен в конфигурации связки'
        : c.lang === 'en'
          ? `Relay without task context: the writer does not get the feature and scenario description; Relay ≥ ${k.recommended} (expected release) or a build with task context is needed`
          : `Relay без контекста задачи: исполнитель не получит описание функции и сценария; нужна Relay ≥ ${k.recommended} (ожидаемый выпуск) или сборка с контекстом задачи`;
  return {
    connector: src.connector,
    provider: src.provider,
    ...(k ? { level: k.level, taskContext: k.taskContext } : {}),
    ...(k?.contractVersion !== null && k?.contractVersion !== undefined
      ? { contractVersion: k.contractVersion }
      : {}),
    ...(line ? { line } : {}),
    checkedAt: src.observedAt,
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
    ...((list) => (list.length ? { sources: list.slice(0, L.sources) } : {}))(
      (i.sources ?? [])
        .map((src) => sourceLine(c, src))
        .filter((x): x is NonNullable<typeof x> => !!x),
    ),
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
  // Принятые работы, оставленные в источнике на проверку человеку: ход владельца.
  const checks = (i.sources ?? []).flatMap((src) =>
    (src.reviews ?? []).map((r) => ({
      workId: r.workId,
      ...(r.key ? { subject: r.key.slice(0, 200) } : {}),
      code: 'SOURCE_REVIEW',
      actor: 'operator',
      action: 'review-in-source',
      since: r.since,
    })),
  );
  return [...stops, ...reviews, ...checks];
}

/** Имя источника задач для людей: Relay у коннекторов relay-*, иначе провайдер. */
const providerName = (provider: string) => (/^relay(-|$)/.test(provider) ? 'Relay' : provider);

/** Принятые работы, ждущие проверки человека в источнике (ревизия 5). */
function sourceReviewsOf(
  c: Ctx,
  truncated: Record<string, number>,
): SourceReviewView[] | undefined {
  const out = (c.i.sources ?? []).flatMap((src): SourceReviewView[] => {
    if (!src.reviews?.length) return [];
    const all = src.reviews.map((r) => ({
      taskId: r.taskId,
      ...(r.key ? { key: r.key.slice(0, 200) } : {}),
      workId: r.workId,
      column: r.column.slice(0, 40),
      since: r.since,
    }));
    const tasks = take(all, L.sourceReviewTasks, truncated, 'sourceReviews');
    const names = tasks.map((t) => t.key ?? t.workId);
    const where = providerName(src.provider);
    const line = (
      c.lang === 'en'
        ? `waiting for your review in ${where}: ${names.join(', ')}`
        : `ждут вашей проверки в ${where}: ${names.join(', ')}`
    ).slice(0, T.line);
    return [{ connector: src.connector, provider: src.provider, tasks, line }];
  });
  return out.length ? out.slice(0, L.sources) : undefined;
}

/**
 * Документ настройки (ревизия 5): harness в проекте ещё не настроен — нет
 * manifest, политики или привязанного состояния. Панель, запущенная вместе с
 * источником задач до настройки, показывает простые строки и перечитывает
 * представление, пока не появится полный документ.
 */
export interface SetupView {
  viewVersion: typeof OPERATOR_VIEW_VERSION;
  viewRevision: number;
  generatedAt: string;
  source: ViewSource;
  stage: { name: 'setup'; lines: string[]; progress?: SetupProgress };
  /** Чего ещё нет: `project` — `.harness/project.json`, `policy` — политики и привязки. */
  setup: { waitingFor: 'project' | 'policy' };
}

export function setupView(
  input: {
    now: number;
    harnessVersion: string;
    stateVersion: number;
    waitingFor: 'project' | 'policy';
    producer?: string;
    /** Ревизия 7: ход настройки по записям на диске. */
    progress?: SetupProgress;
  },
  o: { lang?: 'ru' | 'en' } = {},
): SetupView {
  const stage = stageOf(0, o.lang ?? 'ru', input.progress) as SetupView['stage'];
  const body = { stage, setup: { waitingFor: input.waitingFor } };
  return {
    viewVersion: OPERATOR_VIEW_VERSION,
    viewRevision: OPERATOR_VIEW_REVISION,
    generatedAt: iso(input.now),
    source: {
      producer: input.producer ?? 'devcontour-harness',
      producerVersion: input.harnessVersion,
      stateVersion: input.stateVersion,
      token: sha256Hex(JSON.stringify(canonical({ ...body, stage: stageTokenBody(stage) }))),
    },
    ...body,
  };
}

/** Этап проекта (ревизия 5): без работ — настройка, с простыми строками для панели. */
export function stageOf(
  works: number,
  lang: 'ru' | 'en',
  /** Ревизия 7: ход настройки (`setupProgress` загрузчика); показывается только без работ. */
  progress?: SetupProgress,
): { name: 'setup' | 'work'; lines: string[]; progress?: SetupProgress } {
  if (works > 0) return { name: 'work', lines: [] };
  return {
    name: 'setup',
    lines:
      lang === 'en'
        ? ['Harness setup is in progress', 'No tasks yet']
        : ['Идёт настройка harness', 'Задач пока нет'],
    ...(progress ? { progress } : {}),
  };
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
    case 'work.reopened': {
      const sha = sha12(e.sha)!;
      const budget = e.fresh
        ? ru
          ? 'свой предел попыток'
          : 'its own attempt budget'
        : ru
          ? 'попытки перенесены'
          : 'attempts carried over';
      return {
        actor: 'lead',
        action: e.kind,
        workId: e.workId,
        plain: ru
          ? parts`принятая на ${[sha]} работа ${e.workId} изменена новой редакцией: доработка ${e.revision}, ${[budget]}`
          : parts`${e.workId}, accepted at ${[sha]}, was changed by a new revision: rework ${e.revision}, ${[budget]}`,
      };
    }
    case 'work.rework-abandoned': {
      const sha = sha12(e.sha)!;
      return {
        actor: e.by === 'graph' ? 'lead' : e.by,
        action: e.kind,
        workId: e.workId,
        plain: ru
          ? parts`доработка ${e.revision} работы ${e.workId} оставлена: работа вернулась к принятой на ${[sha]} редакции`
          : parts`rework ${e.revision} of ${e.workId} abandoned: the work is back at the revision accepted at ${[sha]}`,
      };
    }
    case 'lead':
      return {
        actor: 'lead',
        action: e.action,
        ...(e.workId ? { workId: e.workId } : {}),
        plain: [ru ? e.plain : (e.plainEn ?? e.plain)],
      };
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
  // Журнал ведущего (ревизия 6) — в той же ленте, актёр `lead`.
  const leadRows: OperatorActivityInput[] = (c.i.lead?.entries ?? []).map((e) => ({
    kind: 'lead',
    at: e.at,
    action: e.action,
    ...(e.workId ? { workId: e.workId } : {}),
    plain: e.plain,
    ...(e.plainEn ? { plainEn: e.plainEn } : {}),
  }));
  if (!c.i.activity && !leadRows.length) return undefined;
  const events = [...(c.i.activity ?? []), ...leadRows];
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
/**
 * Доработка, отменённая alpha.65 и старше (P4-7): работа `cancelled` со
 * сводкой доработки (`attemptSummary.rework`) — для представления принятая
 * работа на прежней приёмке. Состояние не переписывается: его возвращает к
 * принятой редакции `harness cancel` (событие `work.rework-abandoned`).
 */
function acceptedAsRestored(i: OperatorViewInput): OperatorViewInput {
  if (!i.works.some((w) => w.status === 'cancelled' && w.attemptSummary.rework)) return i;
  return {
    ...i,
    works: i.works.map((w) => {
      const r = w.attemptSummary.rework;
      if (w.status !== 'cancelled' || !r) return w;
      const stage = { ...w.stage, name: 'done', next: [] as string[] };
      delete stage.needs;
      delete stage.step;
      return {
        ...w,
        status: 'done',
        stage,
        resultSha: r.acceptedSha,
        blockers: [],
        restoredFrom: 'cancelled-rework' as const,
      };
    }),
  };
}

/**
 * Вопрос владельцу в источнике задач (alpha.67, P5-4) держит только свои
 * задачи: если никто не запущен, а готовые работы есть, строка очереди
 * называет новый запуск ходом ведущего — «запустите harness run: готово N
 * задач, вопрос блокирует только X». Строка статуса о вопросе исполнителя
 * (`heldByQuestion`) — главнее.
 */
function runnerWithSourceQuestions(
  q: OperatorViewInput['queue'],
  sources: OperatorViewInput['sources'],
  works: OperatorViewInput['works'],
): OperatorViewInput['queue'] {
  if (q.paused || q.runner !== 'not-running' || !q.ready) return q;
  const tasks = [
    ...new Set((sources ?? []).flatMap((s) => (s.questions ?? []).flatMap((x) => x.targets))),
  ];
  if (!tasks.length) return q;
  // Задачи вопроса — ключи или ID источника; работы — по связке задач. Вопрос
  // держит и свои работы, и зависящие от них: из всех готовых (до обрезки
  // списка) они вычитаются.
  const asked = new Set(tasks);
  const held = new Set(
    (sources ?? []).flatMap((s) =>
      s.tasks
        .filter((t) => t.workId && (asked.has(t.key) || asked.has(t.id)))
        .map((t) => t.workId!),
    ),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const w of works)
      if (!held.has(w.id) && (w.dependsOn ?? []).some((d) => held.has(d))) {
        held.add(w.id);
        grew = true;
      }
  }
  const n = q.readyWorks ? q.readyWorks.filter((id) => !held.has(id)).length : q.ready;
  // Вопрос исполнителя (`heldByQuestion`) и вопрос владельцу — одним списком.
  const blocking = [...new Set([...(q.heldByQuestion ?? []), ...tasks])];
  const many = blocking.length > 1;
  const ids =
    blocking.slice(0, 10).join(', ') +
    (blocking.length > 10 ? ` и ещё ${blocking.length - 10}` : '');
  const idsEn =
    blocking.slice(0, 10).join(', ') +
    (blocking.length > 10 ? ` and ${blocking.length - 10} more` : '');
  if (n <= 0)
    return {
      ...q,
      restartBy: 'lead',
      line: `Очередь стоит — никто не запущен: готовых задач нет — ${many ? 'вопросы держат' : 'вопрос держит'} ${ids}; после ответа нужен новый запуск (ведущий: harness run).`,
      lineEn: `The queue is idle — nothing is running: no task is ready — the ${many ? 'questions hold' : 'question holds'} ${idsEn}; after the answer a new run is needed (the lead: harness run).`,
    };
  return {
    ...q,
    restartBy: 'lead',
    line: `Очередь стоит — никто не запущен: запустите harness run: готово ${ruCount(n, ['задача', 'задачи', 'задач'])}, ${q.heldByQuestion?.length ? (many ? 'вопросы блокируют' : 'вопрос блокирует') : many ? 'вопросы владельцу блокируют' : 'вопрос владельцу блокирует'} только ${ids} (ведущий).`,
    lineEn: `The queue is idle — nothing is running: start harness run: ${n} ${n === 1 ? 'task is' : 'tasks are'} ready, the ${q.heldByQuestion?.length ? '' : "owner's "}${many ? 'questions block' : 'question blocks'} only ${idsEn} (the lead).`,
  };
}

export function operatorView(input: OperatorViewInput, o: OperatorViewOptions = {}): OperatorView {
  const i = acceptedAsRestored(input);
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
  const q = runnerWithSourceQuestions(i.queue, i.sources, i.works);
  const drift = i.works.map((w) => driftOf(c, w)).filter((d): d is DriftView => !!d);
  const activity = activityOf(c, o, truncated);
  const scope = scopeOf(c, truncated);
  const sourceQuestions = sourceQuestionsOf(c, truncated);
  // Прогноз — по всему срезу, даже если `scope` в документе усечён.
  const forecast = forecastOf(c, scope, truncated);
  const sourceReviews = sourceReviewsOf(c, truncated);
  const planned = plannedOf(c, truncated);
  const lead = leadOf(c, truncated);
  const resources = i.resources
    ? resourcesOf(i.resources, {
        lang: c.lang,
        now: i.now,
        mask: (x, max) => text(c, x, max) ?? '',
      })
    : undefined;
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
        ...(q.runner ? { runner: q.runner } : {}),
        ...(q.neverRun && !q.runner ? { neverRun: true as const } : {}),
        ...(q.restartBy ? { restartBy: actorOf(q.restartBy)! } : {}),
        ...((l) => (l ? { line: text(c, l, T.line) } : {}))(
          c.lang === 'en' ? (q.lineEn ?? q.line) : q.line,
        ),
      },
    },
    history,
    health,
    ...(activity ? { activity } : {}),
    ...(scope
      ? { scope }
      : { scopeReason: i.sourcesUnread ? ('unreadable' as const) : ('no-snapshot' as const) }),
    ...(sourceQuestions ? { sourceQuestions } : {}),
    ...(sourceReviews ? { sourceReviews } : {}),
    stage: stageOf(i.works.length, c.lang, i.setup),
    ...(forecast ? { forecast } : {}),
    ...(i.updates ? { updates: updatesOf(c, i.updates, truncated) } : {}),
    ...(planned?.length ? { planned } : {}),
    ...(lead ? { lead } : {}),
    ...(resources ? { resources } : {}),
    ...(i.previews?.length ? { previews: previewsOf(c, i.previews, truncated) } : {}),
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
  const full: OperatorView = {
    ...fitted,
    health: { ...fitted.health, warnings: warnings.slice(0, L.warnings) },
    ...(tr ? { truncated: tr } : {}),
  };
  return fitSize(full, maxBytes, c.lang, truncated);
}

/** Поля ревизии 4 у работы, которые документ сверх предела теряет после разделов связки (путь работы — раньше, шаг 0). */
function withoutWorkFields(w: WorkView): WorkView | undefined {
  const last = w.attempts.lastFailure;
  const lastExtra = !!last && (last.kind !== undefined || last.counted !== undefined);
  const steps = w.blockers.some((b) => b.step !== undefined);
  const line = w.question?.line !== undefined;
  if (!lastExtra && !steps && !line) return undefined;
  const out: WorkView = { ...w };
  if (lastExtra) {
    const rest = { ...last };
    delete rest.kind;
    delete rest.counted;
    out.attempts = { ...w.attempts, lastFailure: rest };
  }
  if (steps)
    out.blockers = w.blockers.map((b) => {
      const copy = { ...b };
      delete copy.step;
      return copy;
    });
  if (line) {
    const q = { ...w.question! };
    delete q.line;
    out.question = q;
  }
  return out;
}

/** Первые `n/64` записей списка (не меньше 0); опущенное — в счётчик. */
const share = <T>(list: T[], n: number, add: (k: number) => void): T[] => {
  const keep = Math.floor((list.length * n) / 64);
  if (keep < list.length) add(list.length - keep);
  return list.slice(0, keep);
};

/**
 * Документ сверх байтового предела не отказывает целиком, а теряет
 * необязательное в одном порядке (docs/contracts.md, «Размер»):
 * 0. путь работы `works[].track` у всех работ (число работ —
 *    `truncated.workFields`; путь целиком — `view --work`);
 * 1. разделы связки `scope` и `sourceQuestions` (`VIEW_SECTIONS_DROPPED`),
 *    планируемые задачи `planned`, записи журнала ведущего `lead.notes` и
 *    готовность по работам `forecast.progress.works`;
 * 2. поля ревизии 4 у работ — `attempts.lastFailure.kind`/`counted`,
 *    `blockers[].step`, `question.line` (число работ — `truncated.workFields`);
 * 3. лента `activity`, затем раздел `resources` (`truncated.resources: 1`);
 * 4. хвосты списков `works`, `reviews` (и находок предметов), `questions`,
 *    `escalations`, `drift` — одной долей, наибольшей, при которой документ
 *    помещается (опущенное — в `truncated` по спискам).
 * С шага 0 (с шага 2, если путей работ нет) — предупреждение
 * `VIEW_SIZE_REDUCED`. Живые превью `previews`, сессия ведущего и его
 * последняя запись (`lead` без `notes`) не опускаются. Отказ `VIEW_TOO_LARGE`
 * остаётся только для предела меньше документа без всех этих списков.
 */
function fitSize(
  full: OperatorView,
  maxBytes: number,
  lang: 'ru' | 'en',
  counted: Record<string, number>,
): OperatorView {
  const tryFinish = (v: OperatorView) => {
    try {
      return finish(v, maxBytes);
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'VIEW_TOO_LARGE') return undefined;
      throw error;
    }
  };
  const first = tryFinish(full);
  if (first) return first;
  const en = lang === 'en';
  const truncated: Record<string, number> = { ...counted };
  const add = (key: string) => (k: number) => {
    if (k > 0) truncated[key] = (truncated[key] ?? 0) + k;
  };
  const base = full.health.warnings.filter((w) => w.code !== 'VIEW_TRUNCATED');
  const truncatedNote = {
    code: 'VIEW_TRUNCATED',
    message: en
      ? 'some lists exceed the view limits: see truncated for the omitted counts'
      : 'часть списков длиннее пределов представления: число опущенных — в truncated',
  };
  const sectionsNote = {
    code: 'VIEW_SECTIONS_DROPPED',
    message: en
      ? 'the run scope and source questions exceed the view size limit and are omitted'
      : 'срез прогона и вопросы источника не помещаются в предел представления и опущены',
  };
  const reducedNote = {
    code: 'VIEW_SIZE_REDUCED',
    message: en
      ? 'the view exceeds its size limit: optional work fields and list tails are omitted, see truncated'
      : 'представление больше предела размера: необязательные поля работ и хвосты списков опущены — число в truncated',
  };
  // Работы, потерявшие поля ревизии 4: считаются только оставшиеся в документе
  // (опущенная целиком работа — уже в `truncated.works`).
  const stripped = new Set<string>();
  const assemble = (v: OperatorView, extra: Record<string, number>, reduced: boolean) => {
    const all = { ...truncated, ...extra };
    for (const [k, n] of Object.entries(extra)) all[k] = (truncated[k] ?? 0) + n;
    const fields = v.works.filter((w) => stripped.has(w.id)).length;
    if (fields) all.workFields = fields;
    const notes = [
      ...(full.scope || full.sourceQuestions ? [sectionsNote] : []),
      ...(reduced ? [reducedNote] : []),
    ];
    const room = L.warnings - 1 - notes.length;
    const kept = base.slice(0, room);
    if (base.length > kept.length) all.warnings = (all.warnings ?? 0) + base.length - kept.length;
    // VIEW_TRUNCATED всегда виден: документ что-то опустил.
    return {
      ...v,
      health: { ...v.health, warnings: [...kept, ...notes, truncatedNote] },
      truncated: truncation<TruncatedKey>(all)!,
    } as OperatorView;
  };
  // 0. Путь работы (`works[].track`, ревизия 6) — самое объёмное и
  // восстановимое (`view --work`) поле: первым, у всех работ.
  let v: OperatorView = full;
  if (full.works.some((w) => w.track)) {
    v = {
      ...v,
      works: v.works.map((w) => {
        if (!w.track) return w;
        stripped.add(w.id);
        const out = { ...w };
        delete out.track;
        return out;
      }),
    };
    const done = tryFinish(assemble(v, {}, true));
    if (done) return done;
  }
  // 1. Разделы связки и готовность по работам в прогнозе (строки прогноза остаются).
  // Ревизия 6: планируемые задачи и журнал ведущего — вместе с разделами
  // связки (строки прогона и ведущего остаются).
  const { scope, sourceQuestions, planned, ...rest } = v;
  v = rest;
  if (scope) add('scope')(scope.tasks.length);
  if (sourceQuestions) add('sourceQuestions')(sourceQuestions.length);
  if (planned) add('planned')(planned.length);
  if (v.lead?.notes.length) {
    add('leadNotes')(v.lead.notes.length);
    v = { ...v, lead: { ...v.lead, notes: [] } };
  }
  const perWork = v.forecast?.progress.works;
  if (perWork) {
    add('forecastWorks')(perWork.length);
    const progress = { ...v.forecast!.progress };
    delete progress.works;
    v = { ...v, forecast: { ...v.forecast!, progress } };
  }
  if (scope || sourceQuestions || perWork || planned || full.lead?.notes.length) {
    const done = tryFinish(assemble(v, {}, stripped.size > 0));
    if (done) return done;
  }
  // 2. Поля ревизии 4 у работ.
  v = {
    ...v,
    works: v.works.map((w) => {
      const out = withoutWorkFields(w);
      if (out) stripped.add(w.id);
      return out ?? w;
    }),
  };
  {
    const done = tryFinish(assemble(v, {}, true));
    if (done) return done;
  }
  // 3. Лента.
  if (v.activity) {
    add('activity')(v.activity.length);
    const noFeed = { ...v };
    delete noFeed.activity;
    v = noFeed;
    const done = tryFinish(assemble(v, {}, true));
    if (done) return done;
  }
  // 3a. Раздел «Что задействовано» (ревизия 6) — справка, не ход: раньше
  // хвостов работ. Живые превью и сессия ведущего остаются всегда.
  if (v.resources) {
    add('resources')(1);
    const noResources = { ...v };
    delete noResources.resources;
    v = noResources;
    const done = tryFinish(assemble(v, {}, true));
    if (done) return done;
  }
  // 4. Хвосты списков одной долей n/64: наибольшая n, при которой помещается.
  const cut = (n: number) => {
    const extra: Record<string, number> = {};
    const put = (key: string) => (k: number) => {
      extra[key] = (extra[key] ?? 0) + k;
    };
    const reviews = share(v.reviews, n, put('reviews'));
    // Опущенный предмет уносит и находки, и находки своей эскалации.
    for (const r of v.reviews.slice(reviews.length))
      put('findings')(r.findings.length + (r.escalation?.findings.length ?? 0));
    return assemble(
      {
        ...v,
        works: share(v.works, n, put('works')),
        reviews: reviews.map((r) => ({ ...r, findings: share(r.findings, n, put('findings')) })),
        questions: share(v.questions, n, put('questions')),
        escalations: share(v.escalations, n, put('escalations')),
        drift: share(v.drift, n, put('drift')),
      },
      extra,
      true,
    );
  };
  let lo = 0;
  let hi = 63;
  let best: OperatorView | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const done = tryFinish(cut(mid));
    if (done) {
      best = done;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best ?? finish(cut(0), maxBytes);
}

/** Обновления: строки через ту же маску (путь каталога состояния в команде), с пределами. */
function updatesOf(c: Ctx, u: UpdatesView, truncated: Record<string, number>): UpdatesView {
  if (u.whatsNew && u.whatsNew.length > L.updatesWhatsNew)
    truncated.whatsNew = u.whatsNew.length - L.updatesWhatsNew;
  return {
    state: u.state,
    mode: u.mode,
    current: u.current,
    ...(u.available ? { available: u.available } : {}),
    ...(u.checkedAt ? { checkedAt: u.checkedAt } : {}),
    line: text(c, u.line, T.updateLine) ?? '',
    ...(u.whatsNew?.length
      ? {
          whatsNew: u.whatsNew
            .slice(0, L.updatesWhatsNew)
            .map((x) => text(c, x, T.updateLine) ?? ''),
        }
      : {}),
    ...(u.command ? { command: text(c, u.command, T.updateLine) ?? '' } : {}),
  };
}

/** Живые превью: в пределе списка, заголовок — через маску. */
function previewsOf(
  c: Ctx,
  list: readonly PreviewView[],
  truncated: Record<string, number>,
): PreviewView[] {
  if (list.length > L.previews) truncated.previews = list.length - L.previews;
  return list.slice(0, L.previews).map((p) => ({
    id: p.id,
    repositoryId: p.repositoryId,
    ...(p.title ? { title: text(c, p.title, T.title) ?? p.id } : {}),
    url: p.url,
    ref: text(c, p.ref, T.line) ?? p.ref,
    sha: p.sha,
    ...(p.workId ? { workId: p.workId } : {}),
    startedAt: p.startedAt,
    expiresAt: p.expiresAt,
    state: p.state,
  }));
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
  input: OperatorViewInput,
  workId: string,
  o: OperatorViewOptions = {},
): WorkDetailView {
  const i = acceptedAsRestored(input);
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
        ...(s.unused ? { unused: true as const } : {}),
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
