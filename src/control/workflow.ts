import { randomUUID } from 'node:crypto';
import {
  HarnessError,
  WORKSPACE_OWNER,
  digestOf,
  type ExecutionPolicy,
  type ExecutionStore,
  type ExecutionView,
  type NotPromise,
  type WorkflowJob,
} from '../contracts/index.ts';

/** Стадии работы над графом: 0 — ревью и согласование плана, 1 — исполнение, 2 — завершено. */
export const GRAPH_STAGES = 2;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Техническая очередь ведущего: долговечные задания над группой поручений
 * (у standalone — граф). Постановка идемпотентна по ключу (предмет и digest
 * входа); владелец задания fenced токеном и сроком; смена или удаление входа
 * делает задание `stale`; стадия сохраняется и переживает рестарт процесса;
 * автоматические восстановления считаются в задании и списываются в одной
 * транзакции с самим повтором.
 */
export class WorkflowQueue {
  constructor(
    private readonly store: ExecutionStore,
    private readonly policy: ExecutionPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  /** Digest входа задания: граф, политика и режим согласования. Нет графа — входа нет. */
  input(kind: string, id: string, view: ExecutionView) {
    if (kind !== 'graph')
      throw new HarnessError('INVALID_INPUT', 'Неизвестный вид задания: ' + kind);
    const graph = view.graph(id);
    if (!graph) return undefined;
    return digestOf({
      kind,
      id,
      graph: graph.digest,
      policy: digestOf(this.policy),
      approvalMode: this.policy.approvalMode,
    });
  }

  private current(job: WorkflowJob, view: ExecutionView) {
    return this.input(job.kind, job.id, view) === job.inputDigest;
  }

  list() {
    return this.store.read((v) => v.locals('workflow-jobs', WORKSPACE_OWNER).map((r) => r.value));
  }

  get(key: string) {
    const job = this.store.read((v) => v.local('workflow-jobs', WORKSPACE_OWNER, key));
    if (!job) throw new HarnessError('NOT_FOUND', 'Задание не найдено: ' + key);
    return job;
  }

  /** Безопасное представление задания: без токена и срока владения. */
  view(key: string) {
    const job = this.get(key);
    return {
      key: job.key,
      kind: job.kind,
      id: job.id,
      stage: job.stage,
      status: job.status,
      attempts: job.attempts,
      repairs: job.repairs ?? 0,
      repairBudget: this.policy.repairBudget,
      ...(job.error ? { error: job.error } : {}),
      history: job.history.slice(-20),
    };
  }

  /** Поставить задание; повтор того же входа возвращает прежнее, другой автор — отказ. */
  start(input: {
    kind: 'graph';
    id: string;
    authorRuntime: WorkflowJob['authorRuntime'];
    maxAttempts?: number;
  }) {
    return this.store.transact('workflow.updated', (tx) => {
      const digest = this.input(input.kind, input.id, tx);
      if (!digest) throw new HarnessError('NOT_FOUND', 'Предмет задания не найден: ' + input.id);
      const key = digestOf({ kind: input.kind, id: input.id, input: digest });
      const old = tx.local('workflow-jobs', WORKSPACE_OWNER, key);
      if (old) {
        if (old.authorRuntime !== input.authorRuntime)
          throw new HarnessError(
            'INVALID_INPUT',
            'Runtime автора уже закреплён за этим входом: ' + old.authorRuntime,
          );
        return old;
      }
      const job: WorkflowJob = {
        kind: input.kind,
        id: input.id,
        authorRuntime: input.authorRuntime,
        maxAttempts: input.maxAttempts ?? 3,
        key,
        inputDigest: digest,
        stage: 0,
        attempts: 0,
        status: 'queued',
        startedAt: iso(this.now()),
        history: [],
      };
      tx.putLocal('workflow-jobs', WORKSPACE_OWNER, key, job);
      return job;
    });
  }

  /**
   * Взять стадию задания. Пока применяется политика, стадии не начинаются:
   * они читали бы прежний контекст. Изменившийся вход — `stale`; исчерпанные
   * попытки стадии — `failed`. Чужое действующее владение не перехватывается.
   */
  claim(key: string) {
    return this.store.transact('workflow.updated', (tx) => {
      if (tx.control().pauseReason === 'reconfigure') return undefined;
      const job = tx.local('workflow-jobs', WORKSPACE_OWNER, key);
      if (!job) throw new HarnessError('NOT_FOUND', 'Задание не найдено: ' + key);
      if (
        !['queued', 'running'].includes(job.status) ||
        (job.status === 'running' && job.leaseUntil! > this.now())
      )
        return undefined;
      const next: WorkflowJob = { ...job, history: [...job.history] };
      if (!this.current(job, tx)) {
        next.status = 'stale';
        next.error = 'Вход задания изменился или удалён';
        delete next.token;
        delete next.leaseUntil;
      } else if (job.attempts >= job.maxAttempts) {
        next.status = 'failed';
        next.error = 'Исчерпаны попытки стадии';
        delete next.token;
        delete next.leaseUntil;
      } else {
        next.status = 'running';
        next.token = randomUUID();
        next.leaseUntil = this.now() + this.policy.leaseMs;
        next.attempts = job.attempts + 1;
      }
      next.history.push({ at: iso(this.now()), stage: job.stage, event: next.status });
      tx.putLocal('workflow-jobs', WORKSPACE_OWNER, key, next);
      return next.status === 'running' ? next : undefined;
    });
  }

  /** Владение заданием и актуальность входа; иначе — отказ. */
  guard(job: WorkflowJob, view?: ExecutionView) {
    const check = (v: ExecutionView) => {
      const current = v.local('workflow-jobs', WORKSPACE_OWNER, job.key);
      if (
        current?.status !== 'running' ||
        current.token !== job.token ||
        current.leaseUntil! <= this.now()
      )
        throw new HarnessError('LEASE_STALE', 'Владение заданием утрачено');
      if (!this.current(job, v)) throw new HarnessError('APPROVAL_STALE', 'Вход задания изменился');
      return current;
    };
    return view ? check(view) : this.store.read(check);
  }

  heartbeat(job: WorkflowJob) {
    this.store.transact('workflow.updated', (tx) => {
      const current = this.guard(job, tx);
      tx.putLocal('workflow-jobs', WORKSPACE_OWNER, job.key, {
        ...current,
        leaseUntil: this.now() + this.policy.leaseMs,
      });
    });
  }

  /**
   * Завершить стадию. `wait` — стадия ждёт доменного состояния (повтор,
   * пауза) и внешнего действия не выполняла: попытка стадии возвращается, а
   * её запись о захвате снимается. Именно запись о захвате: последним в
   * истории может стоять решение о восстановлении, и оно должно остаться.
   */
  finish(job: WorkflowJob, wait = false, stages = GRAPH_STAGES) {
    return this.store.transact('workflow.updated', (tx) => {
      const current = this.guard(job, tx);
      const next: WorkflowJob = { ...current, history: [...current.history] };
      if (!wait) {
        next.stage = current.stage + 1;
        next.attempts = 0;
      } else {
        next.attempts = current.attempts - 1;
        const claimed = next.history.map((h) => h.event).lastIndexOf('running');
        if (claimed >= 0) next.history.splice(claimed, 1);
      }
      next.status = next.stage >= stages ? 'completed' : 'queued';
      if (next.status === 'completed') next.finishedAt = iso(this.now());
      delete next.token;
      delete next.leaseUntil;
      delete next.error;
      if (!wait) next.history.push({ at: iso(this.now()), stage: job.stage, event: 'completed' });
      tx.putLocal('workflow-jobs', WORKSPACE_OWNER, job.key, next);
      return next;
    });
  }

  /** Отказ стадии: прерванная — снова в очереди, изменившийся вход — `stale`, иначе `failed`. */
  fail(job: WorkflowJob, message: string, interrupted = false) {
    this.store.transact('workflow.updated', (tx) => {
      const current = tx.local('workflow-jobs', WORKSPACE_OWNER, job.key);
      if (!current || current.token !== job.token || current.status !== 'running') return;
      const next: WorkflowJob = {
        ...current,
        status: !this.current(job, tx) ? 'stale' : interrupted ? 'queued' : 'failed',
        error: message.slice(0, 1000),
      };
      delete next.token;
      delete next.leaseUntil;
      tx.putLocal('workflow-jobs', WORKSPACE_OWNER, job.key, next);
    });
  }

  /**
   * Записать восстановление и выполнить его одной транзакцией. Счётчик и само
   * действие неразделимы: прерывание между ними дало бы либо повтор без учёта
   * (цикл крутился бы мимо бюджета), либо учёт без повтора.
   */
  repair<T>(job: WorkflowJob, event: string, apply: () => NotPromise<T>) {
    return this.store.transact('task.retry', (tx) => {
      const current = this.guard(job, tx);
      tx.putLocal('workflow-jobs', WORKSPACE_OWNER, job.key, {
        ...current,
        repairs: (current.repairs ?? 0) + 1,
        history: [...current.history, { at: iso(this.now()), stage: job.stage, event }],
      });
      return apply();
    });
  }

  /** Повтор остановленного задания — решение человека, в пределах попыток стадии. */
  retry(key: string) {
    return this.store.transact('workflow.updated', (tx) => {
      const job = tx.local('workflow-jobs', WORKSPACE_OWNER, key);
      if (!job) throw new HarnessError('NOT_FOUND', 'Задание не найдено: ' + key);
      if (job.status !== 'failed' || job.attempts >= job.maxAttempts)
        throw new HarnessError(
          'NOT_READY',
          'Повтор задания недоступен; проверьте статус и попытки',
        );
      if (!this.current(job, tx))
        throw new HarnessError('APPROVAL_STALE', 'Вход задания изменился: нужно новое задание');
      const next: WorkflowJob = { ...job, status: 'queued' };
      delete next.error;
      tx.putLocal('workflow-jobs', WORKSPACE_OWNER, key, next);
      return next;
    });
  }
}
