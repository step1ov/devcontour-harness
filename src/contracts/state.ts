import type { RuntimeName } from './primitives.ts';
import type { WorkGraph, WorkOrder } from './work.ts';
import type { ContextSnapshot } from './context.ts';
import type { Finding } from './result.ts';

/**
 * Нейтральная модель исполнения — то, что ExecutionStore обязан хранить
 * транзакционно. Поля и их смысл совпадают с записями задач и попыток
 * DevContour: адаптер DevContour отображает существующие записи без
 * переименования сохранённых данных (см. docs/compatibility.md), а
 * standalone SQLite хранит ровно эту модель.
 *
 * Продуктовых сущностей (доски, релизы, INTENT, согласования продукта) здесь
 * нет и не будет: движок их не читает.
 */
export const workStatuses = [
  'draft',
  'ready',
  'running',
  'verifying',
  'reviewing',
  'integrating',
  'done',
  'failed',
  'cancelled',
] as const;
export type WorkStatus = (typeof workStatuses)[number];

export const failureKinds = [
  'provider-auth',
  'environment',
  'timeout',
  'stale-base',
  'empty-result',
  'scope-violation',
  'gate',
  'review',
  'merge',
  'cancelled',
  'budget',
  'unknown',
] as const;
export type FailureKind = (typeof failureKinds)[number];

/** Техническое согласование, привязанное к digest проверенного предложения. */
export interface TechnicalApproval {
  actor: 'operator' | 'agent';
  /** Что согласовано: digest графа, контракта или поручения. */
  digest: string;
  /** Область проверок (gates, потребители), согласованная вместе с постановкой. */
  scope?: string;
  authorRuntime?: RuntimeName;
  reviewerRuntime?: RuntimeName;
  /** Ссылка на сохранённый ответ reviewer. */
  artifact?: string;
  at: string;
}

export interface GraphState {
  id: string;
  digest: string;
  graph: WorkGraph;
  policyDigest: string;
  approval?: TechnicalApproval;
  registeredAt: string;
}

export interface WorkState {
  id: string;
  graphId: string;
  /** Закреплённое поручение; его digest — основание согласования и попыток. */
  order: WorkOrder;
  orderDigest: string;
  status: WorkStatus;
  attempt: number;
  activeRunId?: string;
  resultSha?: string;
  failure?: string;
  failureKind?: FailureKind;
  failureFingerprint?: string;
  approval?: TechnicalApproval;
  /** Выдача удержана операцией (смена контракта, reconfigure); снимает её только эта операция. */
  hold?: { operation: string; reason: string };
  budgetBlock?: { reason: string; at: string };
  /** Принятая версия корпуса подтверждённых случаев. */
  checkVersion?: { suite: string; number: number; digest: string };
  /** Эпизод повторяющихся отказов по свойству; формат — verification/property-recovery. */
  recovery?: unknown;
  recoveryHistory?: unknown[];
}

export interface EvidenceRecord {
  id: string;
  runId: string;
  kind: 'test' | 'review';
  phase: 'candidate' | 'integration';
  sha: string;
  gate: string;
  passed: boolean;
  createdAt: string;
  command: string[];
  exitCode: number;
  log: string;
  digest: string;
  summary: string;
  consumer?: string;
  findings?: Finding[];
  tests?: { id: string; status: 'passed' | 'failed' | 'skipped'; opaque?: true }[];
  testsTruncated?: boolean;
  /** Генеративная проверка и уровень её доказательства; формат — verification/property. */
  property?: unknown;
  /** Действующая версия проверок, под которой получено evidence. */
  checks?: string;
  /** Осмотр дерева ревьюером; формат — verification/review. */
  inspection?: unknown;
}

export interface AttemptState {
  id: string;
  workId: string;
  repositoryId: string;
  attempt: number;
  /** Fencing-токен владения. Никогда не попадает в события, результат и логи. */
  token: string;
  owner: string;
  runtime: RuntimeName;
  reviewer: RuntimeName;
  model?: string;
  reviewerModel?: string;
  effort?: string;
  reviewerEffort?: string;
  policyDigest: string;
  status: 'active' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  phase: WorkStatus;
  startedAt: string;
  finishedAt?: string;
  leaseUntil: number;
  worktree?: string;
  baseSha?: string;
  candidateSha?: string;
  integrationSha?: string;
  error?: string;
  blocked?: boolean;
  failureKind?: FailureKind;
  failureFingerprint?: string;
  requiredGates?: string[];
  consumers?: { repositoryId: string; gates: string[]; checked?: unknown }[];
  checks?: { effective: string; corpus?: { suite: string; number: number; digest: string } };
  context?: ContextSnapshot;
  dependencies?: {
    repositoryId: string;
    sha: string;
    tree: string;
    path: string;
    artifacts: { path: string; digest: string }[];
  }[];
  dependencyFreshness?: { repositoryId: string; snapshot: string; head: string; fresh: boolean }[];
  implementationBasis?: string;
  reusedFrom?: { runId: string; candidateSha: string };
  partial?: unknown;
  continuedFrom?: unknown;
  properties?: string[];
  unboundProperties?: string[];
  episodeBasis?: string;
  callsRecorded?: true;
  /** Версия движка, выдавшего попытку: входит в основание reuse и recovery. */
  engineVersion?: string;
  /** Версия потребителя, через который выдана попытка; не заменяет engineVersion. */
  consumerVersion?: string;
  /** Как выбрана попытка: правило очереди, кандидаты и digest входа выбора. */
  dispatch?: {
    policy: 'fifo-ready-v1';
    at: string;
    eligible: { taskId: string; repositoryId?: string; attempt: number }[];
    activeCount: number;
    concurrency: number;
    inputDigest: string;
  };
  wait?: { approvedAt?: string; readyAt?: string };
  timings?: {
    id: string;
    stage: string;
    startedAt: string;
    finishedAt?: string;
    outcome?: 'passed' | 'failed';
  }[];
  resources?: { id: string; kind: 'device' | 'port' | 'account' | 'service'; value: string }[];
  evidence: EvidenceRecord[];
}

export type PauseReason = 'operator' | 'shutdown' | 'runtime' | 'reconfigure';

export interface ControlState {
  paused: boolean;
  pauseReason?: PauseReason;
  pausedAt?: string;
  /** Операция, поставившая паузу `reconfigure`: снять её может только она. */
  pauseOperation?: string;
  pauseFailures?: FailureKind[];
  appliedPolicy?: { digest: string; at: string; by: string };
}

/** Единственный действующий controller очереди. */
export interface ControllerLease {
  owner: string;
  leaseUntil: number;
}
