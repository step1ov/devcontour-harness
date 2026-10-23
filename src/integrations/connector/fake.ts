import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  TransportError,
  type CheckpointInput,
  type CheckpointRecord,
  type CommentRecord,
  type CriterionRecord,
  type DocumentRecord,
  type HistoryMutation,
  type ProviderId,
  type RelayTransport,
  type SessionRecord,
  type TaskColumn,
  type TaskRead,
  type TaskSummary,
  type TransportIdentity,
} from './transport.ts';

/**
 * Управляемый поддельный backend задач для contract tests — **fixture, не
 * настоящий Relay**. Он воспроизводит договор транспорта: CAS-ревизии задач
 * и сессий, done guards, append-only комментарии, сессии с fencing по run,
 * счётчик поколения, который растёт при каждой записи (как generation
 * Relay-2), и многостраничное чтение задачи (между страницами может пройти
 * чужая запись). Состояние — в памяти или в файле SQLite: второй вариант
 * разделяется несколькими процессами (crash/restart и гонки владельцев).
 */

interface FakeTask {
  id: string;
  key: string;
  title: string;
  description: string;
  column: TaskColumn;
  revision: number;
  parentId: string | null;
  dependencies: string[];
  criteria: CriterionRecord[];
}
interface FakeSession extends SessionRecord {
  runs: { id: string; state: 'active' | 'ended' }[];
  /** ID intent-чекпоинтов, ещё не закрытых. */
  openIntents: string[];
  accepted: string[];
}
interface FakeCheckpoint extends CheckpointRecord {
  closed: boolean;
  children: string[];
  acceptedSessionIds: string[];
}
export interface FakeState {
  provider: ProviderId;
  projectId: string;
  generation: number;
  seq: number;
  tasks: Record<string, FakeTask>;
  comments: Record<string, CommentRecord[]>;
  documents: Record<string, DocumentRecord & { targets: string[] }>;
  sessions: Record<string, FakeSession>;
  checkpoints: Record<string, FakeCheckpoint>;
  /** Принятые мутации по операциям (для отчёта; проверки считают по записям получателя). */
  mutations: Record<string, number>;
}

/** Хранилище состояния подделки: в памяти либо в общей SQLite. */
export interface FakeBackend {
  with<T>(fn: (state: FakeState) => T, write: boolean): T;
  close(): void;
}

export const emptyFakeState = (provider: ProviderId, projectId: string): FakeState => ({
  provider,
  projectId,
  generation: 1,
  seq: 0,
  tasks: {},
  comments: {},
  documents: {},
  sessions: {},
  checkpoints: {},
  mutations: {},
});

export function memoryBackend(state: FakeState): FakeBackend {
  return {
    with: (fn, write) => {
      if (!write) return fn(structuredClone(state));
      const draft = structuredClone(state);
      const out = fn(draft);
      Object.assign(state, draft);
      return out;
    },
    close: () => undefined,
  };
}

/** Состояние в файле SQLite: каждая операция — транзакция `BEGIN IMMEDIATE`. */
export function fileBackend(file: string, init?: FakeState): FakeBackend {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=20000;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)',
  );
  if (init) db.prepare('INSERT OR IGNORE INTO state VALUES(1, ?)').run(JSON.stringify(init));
  return {
    with: (fn, write) => {
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        const row = db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string };
        const state = JSON.parse(row.data) as FakeState;
        const out = fn(state);
        if (write) db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(state));
        db.exec('COMMIT');
        return out;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

const columns: TaskColumn[] = ['inbox', 'ready', 'in-progress', 'review', 'done', 'cancelled'];

/** Транспорт поверх подделки — тот же договор, что у настоящих адаптеров. */
export class FakeRelayTransport implements RelayTransport {
  readonly provider: ProviderId;
  /** Хук между страницами чтения задачи: тесты вносят здесь чужую запись. */
  onPage?: (page: 'task' | 'links' | 'documents', ref: string) => void | Promise<void>;

  private readonly projectId: string;

  constructor(
    readonly backend: FakeBackend,
    readonly options: { provider: ProviderId; actor: string; history?: boolean },
  ) {
    this.provider = options.provider;
    this.projectId = backend.with((s) => s.projectId, false);
  }

  private fail(
    kind: TransportError['kind'],
    operation: string,
    message: string,
    extra: { code?: string; actualRevision?: number; mutation?: boolean } = {},
  ): never {
    throw new TransportError(kind, operation, message, {
      provider: this.provider,
      projectId: this.projectId,
      ...extra,
    });
  }

  private read<T>(fn: (s: FakeState) => T) {
    return this.backend.with(fn, false);
  }
  private write<T>(operation: string, fn: (s: FakeState) => T) {
    return this.backend.with((s) => {
      const out = fn(s);
      s.generation++;
      s.mutations[operation] = (s.mutations[operation] ?? 0) + 1;
      return out;
    }, true);
  }

  private static resolve(s: FakeState, ref: string) {
    return s.tasks[ref] ?? Object.values(s.tasks).find((t) => t.key === ref);
  }

  private taskOf(s: FakeState, ref: string, operation: string) {
    const task = FakeRelayTransport.resolve(s, ref);
    if (!task)
      this.fail('not-found', operation, 'Задача не найдена: ' + ref, { code: 'NOT_FOUND' });
    return task;
  }

  /** Транзитивно завершена: done, все критерии, дети и зависимости. */
  static finished(s: FakeState, id: string, seen = new Set<string>()): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    const t = s.tasks[id];
    if (!t || t.column !== 'done' || t.criteria.some((c) => !c.completed)) return false;
    const children = Object.values(s.tasks).filter((x) => x.parentId === id);
    return (
      children.every((c) => FakeRelayTransport.finished(s, c.id, seen)) &&
      t.dependencies.every((d) => FakeRelayTransport.finished(s, d, seen))
    );
  }

  private static summary(s: FakeState, t: FakeTask): TaskSummary {
    return {
      id: t.id,
      key: t.key,
      title: t.title,
      column: t.column,
      revision: t.revision,
      finished: FakeRelayTransport.finished(s, t.id),
    };
  }

  async identity(): Promise<TransportIdentity> {
    await tick();
    return this.read((s) => ({
      provider: this.provider,
      projectId: s.projectId,
      capabilities: [
        'fake-task-v1',
        ...(this.options.history === false ? [] : ['fake-work-history-v1']),
      ],
      build: { implementation: 'devcontour-harness fake relay (fixture)' },
    }));
  }

  async readTask(ref: string): Promise<TaskRead> {
    await tick();
    const before = this.read((s) => String(s.generation));
    const task = this.read((s) => structuredClone(this.taskOf(s, ref, 'task.read')));
    await this.onPage?.('task', ref);
    await tick();
    const links = this.read((s) => ({
      children: Object.values(s.tasks)
        .filter((x) => x.parentId === task.id)
        .map((x) => FakeRelayTransport.summary(s, x)),
      dependencies: task.dependencies
        .filter((d) => s.tasks[d])
        .map((d) => FakeRelayTransport.summary(s, s.tasks[d]!)),
    }));
    await this.onPage?.('links', ref);
    await tick();
    const documents = this.read((s) =>
      Object.values(s.documents)
        .filter((d) => d.targets.includes(task.id))
        .map(({ targets, ...d }) => (void targets, d)),
    );
    await this.onPage?.('documents', ref);
    const after = this.read((s) => String(s.generation));
    return { task, ...links, documents, consistency: { before, after } };
  }

  async listComments(ref: string): Promise<CommentRecord[]> {
    await tick();
    return this.read((s) =>
      structuredClone(s.comments[this.taskOf(s, ref, 'comment.list').id] ?? []),
    );
  }

  async addComment(ref: string, input: { title: string; body: string }) {
    await tick();
    if (!input.body.trim())
      this.fail('refused', 'comment.add', 'Пустой комментарий', {
        code: 'INVALID_INPUT',
        mutation: true,
      });
    return this.write('comment.add', (s) => {
      const task = this.taskOf(s, ref, 'comment.add');
      const id = String(++s.seq);
      (s.comments[task.id] ??= []).push({
        id,
        title: input.title,
        body: input.body,
        actor: this.options.actor,
        createdAt: new Date().toISOString(),
      });
      return { commentId: id };
    });
  }

  async setCriterion(
    ref: string,
    input: { criterionId: string; completed: boolean; ifRevision: number },
  ) {
    await tick();
    return this.write('task.criterion', (s) => {
      const task = this.taskOf(s, ref, 'task.criterion');
      if (task.column === 'done')
        this.fail('refused', 'task.criterion', 'Задача в done', {
          code: 'TASK_ACCEPTANCE_LOCKED',
          mutation: true,
        });
      if (task.revision !== input.ifRevision)
        this.fail('conflict', 'task.criterion', 'Ревизия изменилась', {
          code: 'REVISION_CONFLICT',
          actualRevision: task.revision,
          mutation: true,
        });
      const c = task.criteria.find((x) => x.id === input.criterionId);
      if (!c) this.fail('not-found', 'task.criterion', 'Критерий не найден', { code: 'NOT_FOUND' });
      c.completed = input.completed;
      task.revision++;
      return { revision: task.revision };
    });
  }

  async move(ref: string, input: { column: TaskColumn; ifRevision: number }) {
    await tick();
    if (!columns.includes(input.column))
      this.fail('refused', 'task.move', 'Колонка', { code: 'INVALID_INPUT' });
    return this.write('task.move', (s) => {
      const task = this.taskOf(s, ref, 'task.move');
      if (task.revision !== input.ifRevision)
        this.fail('conflict', 'task.move', 'Ревизия изменилась', {
          code: 'REVISION_CONFLICT',
          actualRevision: task.revision,
          mutation: true,
        });
      if (input.column === 'done') {
        if (task.criteria.some((c) => !c.completed))
          this.fail('refused', 'task.move', 'Критерии не выполнены', {
            code: 'TASK_ACCEPTANCE_INCOMPLETE',
            mutation: true,
          });
        const children = Object.values(s.tasks).filter((x) => x.parentId === task.id);
        if (
          children.some((c) => !FakeRelayTransport.finished(s, c.id)) ||
          task.dependencies.some((d) => !FakeRelayTransport.finished(s, d))
        )
          this.fail('refused', 'task.move', 'Есть блокеры', {
            code: 'TASK_BLOCKED',
            mutation: true,
          });
      }
      task.column = input.column;
      task.revision++;
      return { revision: task.revision };
    });
  }

  /* ---------------------------------------------------------------- */
  /* История                                                           */
  /* ---------------------------------------------------------------- */

  private requireHistory(operation: string) {
    if (this.options.history === false)
      this.fail('unsupported', operation, 'История не поддерживается', { code: 'UNSUPPORTED' });
  }

  private sessionOf(s: FakeState, ref: string, operation: string) {
    const session = s.sessions[ref] ?? Object.values(s.sessions).find((x) => x.key === ref);
    if (!session)
      this.fail('not-found', operation, 'Сессия не найдена: ' + ref, { code: 'NOT_FOUND' });
    return session;
  }

  private view(session: FakeSession): SessionRecord {
    const { runs, openIntents, accepted, ...record } = session;
    void runs;
    void openIntents;
    void accepted;
    return structuredClone(record);
  }

  /** CAS ревизии сессии и fencing по run. */
  private guard(
    session: FakeSession,
    operation: string,
    input: { ifRevision: number; runId?: string },
    owner = true,
  ) {
    if (session.status === 'completed' || session.status === 'cancelled')
      this.fail('conflict', operation, 'Сессия закрыта', {
        code: 'WORK_SESSION_CLOSED',
        mutation: true,
      });
    if (session.revision !== input.ifRevision)
      this.fail('conflict', operation, 'Ревизия сессии изменилась', {
        code: 'REVISION_CONFLICT',
        actualRevision: session.revision,
        mutation: true,
      });
    if (
      owner &&
      (session.status !== 'open' || !input.runId || input.runId !== session.currentRunId)
    )
      this.fail('conflict', operation, 'Run не владеет сессией', {
        code: 'WORK_RUN_NOT_CURRENT',
        mutation: true,
      });
  }

  private newRun(s: FakeState, session: FakeSession) {
    for (const r of session.runs) r.state = 'ended';
    const run = { id: 'run' + ++s.seq, state: 'active' as const };
    session.runs.push(run);
    session.currentRunId = run.id;
    session.status = 'open';
    return run.id;
  }

  async startSession(input: {
    title: string;
    description: string;
    client: string;
  }): Promise<HistoryMutation> {
    await tick();
    this.requireHistory('history.start');
    return this.write('history.start', (s) => {
      const id = 's' + ++s.seq;
      const session: FakeSession = {
        id,
        key: 'S-' + id,
        status: 'open',
        revision: 1,
        currentRunId: null,
        parentSessionId: null,
        title: input.title,
        description: input.description,
        result: '',
        runs: [],
        openIntents: [],
        accepted: [],
      };
      const runId = this.newRun(s, session);
      s.sessions[id] = session;
      return { session: this.view(session), runId };
    });
  }

  async getSession(ref: string) {
    await tick();
    this.requireHistory('history.get');
    return this.read((s) => this.view(this.sessionOf(s, ref, 'history.get')));
  }

  async findSessions(marker: string) {
    await tick();
    this.requireHistory('history.find');
    return this.read((s) =>
      Object.values(s.sessions)
        .filter((x) => x.title.includes(marker) || x.description.includes(marker))
        .map((x) => this.view(x)),
    );
  }

  async checkpoints(sessionRef: string) {
    await tick();
    this.requireHistory('history.checkpoints');
    return this.read((s) => {
      const session = this.sessionOf(s, sessionRef, 'history.checkpoints');
      return Object.values(s.checkpoints)
        .filter((c) => c.sessionId === session.id)
        .map(
          ({ closed, children, acceptedSessionIds, ...c }) => (
            void closed,
            void children,
            void acceptedSessionIds,
            structuredClone(c)
          ),
        );
    });
  }

  async openIntent(
    sessionRef: string,
    input: CheckpointInput & { runId: string; ifRevision: number },
  ) {
    await tick();
    this.requireHistory('history.intent');
    return this.write('history.intent', (s) => {
      const session = this.sessionOf(s, sessionRef, 'history.intent');
      this.guard(session, 'history.intent', input);
      if (!input.body.trim())
        this.fail('refused', 'history.intent', 'Пустое тело', { code: 'INVALID_INPUT' });
      const id = 'cp' + ++s.seq;
      const checkpoint: FakeCheckpoint = {
        id,
        key: 'CP-' + id,
        sessionId: session.id,
        runId: input.runId,
        kind: 'intent',
        intentId: null,
        title: input.title,
        body: input.body,
        closed: false,
        children: [],
        acceptedSessionIds: [],
      };
      s.checkpoints[id] = checkpoint;
      session.openIntents.push(id);
      session.revision++;
      return { session: this.view(session), checkpoint: structuredClone(checkpoint) };
    });
  }

  async checkpoint(
    intentRef: string,
    kind: 'progress' | 'result' | 'cancel',
    input: CheckpointInput & { runId: string; ifRevision: number },
  ) {
    await tick();
    this.requireHistory('history.checkpoint');
    return this.write('history.checkpoint', (s) => {
      const intent =
        s.checkpoints[intentRef] ?? Object.values(s.checkpoints).find((c) => c.key === intentRef);
      if (!intent || intent.kind !== 'intent')
        this.fail('not-found', 'history.checkpoint', 'Intent не найден', { code: 'NOT_FOUND' });
      const session = s.sessions[intent.sessionId]!;
      this.guard(session, 'history.checkpoint', input);
      if (intent.closed)
        this.fail('conflict', 'history.checkpoint', 'Intent закрыт', {
          code: 'WORK_INTENT_CLOSED',
          mutation: true,
        });
      if (kind !== 'progress') {
        const accepted = [...intent.acceptedSessionIds, ...(input.acceptedSessionIds ?? [])];
        for (const child of intent.children.map((c) => s.sessions[c]!)) {
          if (child.status !== 'completed' && child.status !== 'cancelled')
            this.fail('conflict', 'history.checkpoint', 'Дочерние сессии открыты', {
              code: 'WORK_CHILDREN_OPEN',
              mutation: true,
            });
          if (child.status === 'completed' && !accepted.includes(child.id))
            this.fail('conflict', 'history.checkpoint', 'Дочерний результат не принят', {
              code: 'WORK_CHILDREN_UNACCEPTED',
              mutation: true,
            });
        }
        intent.acceptedSessionIds = accepted;
        intent.closed = true;
        session.openIntents = session.openIntents.filter((x) => x !== intent.id);
      }
      const id = 'cp' + ++s.seq;
      const checkpoint: FakeCheckpoint = {
        id,
        key: 'CP-' + id,
        sessionId: session.id,
        runId: input.runId,
        kind,
        intentId: intent.id,
        title: input.title,
        body: input.body,
        closed: true,
        children: [],
        acceptedSessionIds: input.acceptedSessionIds ?? [],
      };
      s.checkpoints[id] = checkpoint;
      session.revision++;
      return { session: this.view(session), checkpoint: structuredClone(checkpoint) };
    });
  }

  async fork(
    intentRef: string,
    input: { runId: string; ifRevision: number; title: string; description: string },
  ) {
    await tick();
    this.requireHistory('history.fork');
    return this.write('history.fork', (s) => {
      const intent =
        s.checkpoints[intentRef] ?? Object.values(s.checkpoints).find((c) => c.key === intentRef);
      if (!intent || intent.kind !== 'intent' || intent.closed)
        this.fail('conflict', 'history.fork', 'Нужен открытый intent', {
          code: 'WORK_INTENT_REQUIRED',
          mutation: true,
        });
      const parent = s.sessions[intent.sessionId]!;
      this.guard(parent, 'history.fork', input);
      const id = 's' + ++s.seq;
      const child: FakeSession = {
        id,
        key: 'S-' + id,
        status: 'pending',
        revision: 1,
        currentRunId: null,
        parentSessionId: parent.id,
        title: input.title,
        description: input.description,
        result: '',
        runs: [],
        openIntents: [],
        accepted: [],
      };
      s.sessions[id] = child;
      intent.children.push(id);
      parent.revision++;
      return { session: this.view(parent), childSession: this.view(child) };
    });
  }

  async attach(sessionRef: string, input: { ifRevision: number; client: string }) {
    await tick();
    this.requireHistory('history.attach');
    return this.write('history.attach', (s) => {
      const session = this.sessionOf(s, sessionRef, 'history.attach');
      this.guard(session, 'history.attach', input, false);
      if (session.status !== 'pending')
        this.fail('conflict', 'history.attach', 'Нужно состояние pending', {
          code: 'WORK_SESSION_STATE',
          mutation: true,
        });
      const runId = this.newRun(s, session);
      session.revision++;
      return { session: this.view(session), runId };
    });
  }

  async takeover(
    sessionRef: string,
    input: { ifRevision: number; reason: string; client: string },
  ) {
    await tick();
    this.requireHistory('history.takeover');
    return this.write('history.takeover', (s) => {
      const session = this.sessionOf(s, sessionRef, 'history.takeover');
      this.guard(session, 'history.takeover', input, false);
      if (session.status !== 'open')
        this.fail('conflict', 'history.takeover', 'Нужно состояние open', {
          code: 'WORK_SESSION_STATE',
          mutation: true,
        });
      const runId = this.newRun(s, session);
      session.revision++;
      return { session: this.view(session), runId };
    });
  }

  async finishSession(
    sessionRef: string,
    outcome: 'complete' | 'cancel',
    input: { runId?: string; ifRevision: number; result: string },
  ) {
    await tick();
    this.requireHistory('history.finish');
    return this.write('history.finish', (s) => {
      const session = this.sessionOf(s, sessionRef, 'history.finish');
      const owner = session.status === 'open' || outcome === 'complete';
      if (!owner && input.runId)
        this.fail('conflict', 'history.finish', 'runId только для open', {
          code: 'WORK_RUN_NOT_CURRENT',
          mutation: true,
        });
      this.guard(session, 'history.finish', input, owner);
      if (session.openIntents.length)
        this.fail('conflict', 'history.finish', 'Есть открытые intent', {
          code: 'WORK_INTENTS_OPEN',
          mutation: true,
        });
      session.status = outcome === 'complete' ? 'completed' : 'cancelled';
      session.result = input.result;
      session.currentRunId = null;
      for (const r of session.runs) r.state = 'ended';
      session.revision++;
      return { session: this.view(session) };
    });
  }
}

/**
 * Действия «другого участника» прямо в подделке: постановка задач, правки,
 * перехват сессии. Ядро коннектора ими не пользуется.
 */
export class FakeAdmin {
  constructor(readonly backend: FakeBackend) {}

  private write<T>(fn: (s: FakeState) => T) {
    return this.backend.with((s) => {
      const out = fn(s);
      s.generation++;
      return out;
    }, true);
  }

  createTask(input: {
    title: string;
    description: string;
    column?: TaskColumn;
    criteria?: { title: string; summary?: string }[];
    dependencies?: string[];
    parentId?: string;
  }) {
    return this.write((s) => {
      const n = Object.keys(s.tasks).length + 1;
      const id = 't' + n;
      s.tasks[id] = {
        id,
        key: 'PRODUCT-' + n,
        title: input.title,
        description: input.description,
        column: input.column ?? 'ready',
        revision: 1,
        parentId: input.parentId ?? null,
        dependencies: input.dependencies ?? [],
        criteria: (input.criteria ?? []).map((c, i) => ({
          id: `${id}c${i + 1}`,
          title: c.title,
          summary: c.summary ?? '',
          description: '',
          completed: false,
        })),
      };
      return { id, key: s.tasks[id].key, criteria: s.tasks[id].criteria.map((c) => c.id) };
    });
  }

  task(id: string) {
    return this.backend.with((s) => structuredClone(s.tasks[id]), false);
  }

  updateTask(id: string, patch: { title?: string; description?: string }) {
    this.write((s) => {
      Object.assign(s.tasks[id]!, patch);
      s.tasks[id]!.revision++;
    });
  }

  addCriterion(id: string, title: string) {
    return this.write((s) => {
      const task = s.tasks[id]!;
      const cid = `${id}c${task.criteria.length + 1}`;
      task.criteria.push({ id: cid, title, summary: '', description: '', completed: false });
      task.revision++;
      return cid;
    });
  }

  updateCriterion(id: string, criterionId: string, title: string) {
    this.write((s) => {
      const c = s.tasks[id]!.criteria.find((x) => x.id === criterionId)!;
      c.title = title;
      c.completed = false;
      s.tasks[id]!.revision++;
    });
  }

  completeCriterion(id: string, criterionId: string, completed = true) {
    this.write((s) => {
      s.tasks[id]!.criteria.find((x) => x.id === criterionId)!.completed = completed;
      s.tasks[id]!.revision++;
    });
  }

  addDocument(taskId: string, doc: { name: string; body: string }) {
    return this.write((s) => {
      const n = Object.keys(s.documents).length + 1;
      const id = 'd' + n;
      s.documents[id] = {
        id,
        key: 'DOC-' + n,
        name: doc.name,
        body: doc.body,
        revision: 1,
        targets: [taskId],
      };
      return { id };
    });
  }

  updateDocument(id: string, body: string) {
    this.write((s) => {
      s.documents[id]!.body = body;
      s.documents[id]!.revision++;
    });
  }

  addDependency(id: string, dependsOn: string) {
    this.write((s) => {
      s.tasks[id]!.dependencies.push(dependsOn);
      s.tasks[id]!.revision++;
    });
  }

  /** Перемещение с соблюдением done guards (как у человека в backend). */
  move(id: string, column: TaskColumn) {
    this.write((s) => {
      const task = s.tasks[id]!;
      if (
        column === 'done' &&
        (task.criteria.some((c) => !c.completed) ||
          Object.values(s.tasks).some(
            (x) => x.parentId === id && !FakeRelayTransport.finished(s, x.id),
          ) ||
          task.dependencies.some((d) => !FakeRelayTransport.finished(s, d)))
      )
        throw new Error('done guard: задача не может быть завершена');
      task.column = column;
      task.revision++;
    });
  }

  comment(id: string, body: string, actor = 'someone-else') {
    this.write((s) => {
      (s.comments[id] ??= []).push({
        id: String(++s.seq),
        title: 'note',
        body,
        actor,
        createdAt: new Date().toISOString(),
      });
    });
  }

  takeover(sessionId: string) {
    this.write((s) => {
      const session = s.sessions[sessionId]!;
      for (const r of session.runs) r.state = 'ended';
      const run = { id: 'run' + ++s.seq, state: 'active' as const };
      session.runs.push(run);
      session.currentRunId = run.id;
      session.revision++;
    });
  }

  state() {
    return this.backend.with((s) => structuredClone(s), false);
  }
}

/* ------------------------------------------------------------------ */
/* Барьеры и отказы                                                    */
/* ------------------------------------------------------------------ */

export interface Barrier {
  /** Вызывается внутри транспорта: отметить прибытие и ждать разрешения. */
  arrive(): Promise<void>;
}

/** Барьер одного процесса. */
export class LocalBarrier implements Barrier {
  private arrived!: () => void;
  private released!: () => void;
  readonly reached = new Promise<void>((r) => (this.arrived = r));
  private readonly gate = new Promise<void>((r) => (this.released = r));
  async arrive() {
    this.arrived();
    await this.gate;
  }
  release() {
    this.released();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Барьер между процессами: файлы `<name>.reached` и `<name>.release` в общем каталоге. */
export class FileBarrier implements Barrier {
  constructor(
    readonly dir: string,
    readonly name: string,
    readonly timeoutMs = 30_000,
  ) {}
  private file(kind: 'reached' | 'release') {
    return join(this.dir, `${this.name}.${kind}`);
  }
  async arrive() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file('reached'), String(process.pid));
    const until = Date.now() + this.timeoutMs;
    while (!existsSync(this.file('release'))) {
      if (Date.now() > until)
        throw new Error(`Барьер ${this.name}: нет разрешения за ${this.timeoutMs} мс`);
      await sleep(20);
    }
  }
  /** Ждать прибытия (конечный срок). */
  async reached(timeoutMs = this.timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (!existsSync(this.file('reached'))) {
      if (Date.now() > until)
        throw new Error(`Барьер ${this.name}: никто не прибыл за ${timeoutMs} мс`);
      await sleep(20);
    }
    return Number(readFileSync(this.file('reached'), 'utf8'));
  }
  release() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file('release'), '1');
  }
}

export type FaultAction =
  /** Отказ до отправки (`unavailable`): получатель запроса не видел. */
  | 'fail-before-send'
  /** Запрос выполнен получателем, ответ потерян (`uncertain`). */
  | 'drop-response'
  /** Таймаут без применения (`uncertain`): исход для ядра неизвестен. */
  | 'timeout'
  /** Ответ не по договору после выполнения (`protocol`, мутация могла пройти). */
  | 'protocol-after'
  /** Подтверждённый структурный отказ получателя без выполнения (`refused`/`conflict` с кодом). */
  | 'refuse'
  /** Ждать барьер перед вызовом. */
  | 'barrier'
  /** Завершить процесс до вызова (crash до отправки). */
  | 'exit-before'
  /** Завершить процесс после выполнения получателем (crash до сохранения итога). */
  | 'exit-after'
  /** После вызова выполнить действие (чужая запись между страницами/чтениями). */
  | 'after';

export interface FaultRule {
  /** Метод транспорта (`addComment`, `readTask`, `checkpoint`…). */
  op: keyof RelayTransport;
  /** Номер вызова (с 1); без него — каждый вызов. */
  nth?: number;
  /** Сколько вызовов подряд, начиная с `nth`. */
  times?: number;
  action: FaultAction;
  barrier?: Barrier;
  after?: () => void | Promise<void>;
  exitCode?: number;
  /** Текст ошибки получателя вместо стандартного (например, с canary-строкой). */
  message?: string;
  /** Для `refuse`: класс и код отказа (по умолчанию refused/VALIDATION_ERROR). */
  refusal?: { kind: 'refused' | 'conflict'; code: string };
}

const mutating = new Set<string>([
  'addComment',
  'setCriterion',
  'move',
  'startSession',
  'openIntent',
  'checkpoint',
  'fork',
  'attach',
  'takeover',
  'finishSession',
]);

/**
 * Обёртка отказов вокруг **любого** транспорта (подделки или настоящего
 * адаптера): управляемые точки отказа без случайных задержек.
 */
export function faultyTransport(
  inner: RelayTransport,
  rules: FaultRule[],
): RelayTransport & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const wrap =
    (op: keyof RelayTransport) =>
    async (...args: unknown[]) => {
      const n = (calls[op] = (calls[op] ?? 0) + 1);
      const rule = rules.find(
        (r) => r.op === op && (r.nth === undefined || (n >= r.nth && n < r.nth + (r.times ?? 1))),
      );
      const call = () => (inner[op] as (...a: unknown[]) => Promise<unknown>).apply(inner, args);
      const error = (kind: TransportError['kind'], message: string) =>
        new TransportError(kind, String(op), 'injected: ' + (rule?.message ?? message), {
          provider: inner.provider,
          mutation: mutating.has(op),
        });
      if (!rule) return call();
      switch (rule.action) {
        case 'refuse': {
          const refusal = rule.refusal ?? { kind: 'refused', code: 'VALIDATION_ERROR' };
          throw new TransportError(
            refusal.kind,
            String(op),
            'injected: ' + (rule.message ?? 'отказ получателя'),
            {
              provider: inner.provider,
              code: refusal.code,
              mutation: mutating.has(op),
            },
          );
        }
        case 'fail-before-send':
          throw error('unavailable', 'запрос не отправлен');
        case 'timeout':
          throw error('uncertain', 'таймаут, исход неизвестен');
        case 'drop-response':
          await call();
          // Чужая запись между фиксацией у получателя и read-back (гонка).
          await rule.after?.();
          throw error('uncertain', 'ответ потерян после выполнения');
        case 'protocol-after':
          await call();
          throw error('protocol', 'ответ вне договора');
        case 'barrier':
          await rule.barrier!.arrive();
          return call();
        case 'exit-before':
          process.exit(rule.exitCode ?? 75);
          break;
        case 'exit-after': {
          await call();
          process.exit(rule.exitCode ?? 75);
          break;
        }
        case 'after': {
          const out = await call();
          await rule.after?.();
          return out;
        }
      }
      return call();
    };
  const proxy = {
    provider: inner.provider,
    calls,
    identity: wrap('identity'),
    readTask: wrap('readTask'),
    listComments: wrap('listComments'),
    addComment: wrap('addComment'),
    setCriterion: wrap('setCriterion'),
    move: wrap('move'),
    startSession: wrap('startSession'),
    getSession: wrap('getSession'),
    findSessions: wrap('findSessions'),
    checkpoints: wrap('checkpoints'),
    openIntent: wrap('openIntent'),
    checkpoint: wrap('checkpoint'),
    fork: wrap('fork'),
    attach: wrap('attach'),
    takeover: wrap('takeover'),
    finishSession: wrap('finishSession'),
  };
  return proxy as unknown as RelayTransport & { calls: Record<string, number> };
}
