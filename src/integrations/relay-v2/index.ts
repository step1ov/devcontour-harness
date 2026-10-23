/**
 * Opt-in entrypoint `devcontour-harness/integrations/relay-v2`: транспорт
 * Relay-2 через настроенный CLI binary (subprocess, argv без shell).
 *
 * Адаптер не импортирует Bun-зависимый `@relay/core` и не открывает SQLite
 * получателя: всё идёт через `relay … --format json`. Каждый вызов адресует
 * ровно настроенный проект (`--config` с абсолютным путём, `--project` для
 * workspace); cwd процесса на выбор проекта не влияет. Мутации выполняются
 * один раз, без повторов; перед каждой сверяется projectId хранилища.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { HarnessError } from '../../contracts/errors.ts';
import {
  TransportError,
  type CheckpointInput,
  type CheckpointRecord,
  type CommentRecord,
  type DocumentRecord,
  type HistoryMutation,
  type RelayTransport,
  type SessionRecord,
  type TaskColumn,
  type TaskRead,
  type TaskRecord,
  type TaskSummary,
  type TransportErrorKind,
  type TransportIdentity,
} from '../connector/transport.ts';
import { runCli, type CliRun } from './process.ts';
import {
  checkpointSchema,
  classifyCode,
  commentSchema,
  doctorSchema,
  documentSchema,
  failureSchema,
  itemsSchema,
  pageMetaSchema,
  progressSchema,
  projectSchema,
  sessionSchema,
  storageStatusSchema,
  successSchema,
  taskSchema,
} from './protocol.ts';

export const PROVIDER = 'relay-v2-cli' as const;

/** Переменные, которые выбирают проект/автора в обход явных настроек. */
const RESERVED_ENV = ['RELAY_CONFIG', 'RELAY_ACTOR'];

export const relayV2SettingsSchema = z
  .object({
    /** Абсолютный путь к собранному binary Relay-2 (не имя из PATH). */
    binary: z.string().refine(isAbsolute, 'нужен абсолютный путь'),
    /** Абсолютный путь к `relay.config.json` проекта или `relay.workspace.json`. */
    config: z.string().refine(isAbsolute, 'нужен абсолютный путь'),
    /** Имя проекта в workspace (`--project`). */
    project: z.string().min(1).optional(),
    /** Ожидаемый постоянный ID проекта; расхождение блокирует чтение и мутации. */
    projectId: z.string().min(1),
    /** Автор записей (`--actor`). */
    actor: z.string().min(1),
    /**
     * Явное окружение процесса: `RELAY_HOME`, на macOS — `DYLD_LIBRARY_PATH`
     * к SQLite >= 3.44 и т. п. Наследуются только PATH и HOME.
     */
    env: z
      .record(z.string(), z.string())
      .refine((env) => !RESERVED_ENV.some((k) => k in env), {
        message: `${RESERVED_ENV.join('/')} задаются только через config/actor`,
      })
      .optional(),
    timeoutMs: z.number().int().positive().max(600_000).default(30_000),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024)
      .default(16 * 1024 * 1024),
    /** Ожидаемая идентичность сборки: sha256 binary проверяется, commit записывается. */
    build: z
      .object({
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        commit: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RelayV2Settings = z.input<typeof relayV2SettingsSchema>;
type Settings = z.output<typeof relayV2SettingsSchema>;

/** Запись об одном вызове CLI (для evidence/диагностики). Cursor маскирован. */
export interface RelayV2CallLog {
  operation: string;
  argv: string[];
  cwd: string;
  mutation: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  code?: string;
  outcome: 'ok' | TransportErrorKind;
}

export interface RelayV2TransportOptions {
  /** cwd процесса; на выбор проекта не влияет (всегда `--config`). */
  cwd?: string;
  /** Пауза между SIGTERM и SIGKILL группе процессов. */
  killGraceMs?: number;
  /** Размер страницы списков (1..100). */
  pageLimit?: number;
  /** Предел страниц одного списка. */
  maxPages?: number;
  /** Сколько раз начать список заново после SNAPSHOT_CONFLICT. */
  snapshotRestarts?: number;
  onCall?: (call: RelayV2CallLog) => void;
}

/** Capabilities, выводимые пробами чтения несуществующей записи. */
export const RELAY_V2_CAPABILITIES = {
  'relay-2.task.read': ['task', 'get'],
  'relay-2.task.children': ['task', 'children'],
  'relay-2.task.progress': ['task', 'progress'],
  'relay-2.task.criterion': ['task', 'criterion', 'list'],
  'relay-2.task.comment': ['task', 'comment', 'list'],
  'relay-2.document.target': ['document', 'list', '--target'],
  'relay-2.history.session': ['session', 'get'],
  'relay-2.history.checkpoint': ['checkpoint', 'get'],
  'relay-2.history.list': ['session', 'history'],
} as const;
type Capability = keyof typeof RELAY_V2_CAPABILITIES | 'relay-2.envelope.json-v1';

const PROBE_REF = '00000000-0000-0000-0000-000000000000';
/** Ref/ID в позиционном аргументе: ключ, alias или UUID; не может начинаться с `-`. */
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

interface CallOptions {
  mutation: boolean;
  signal?: AbortSignal | undefined;
}

export function createTransport(
  settings: RelayV2Settings,
  options: RelayV2TransportOptions = {},
): RelayV2Transport {
  const parsed = relayV2SettingsSchema.safeParse(settings);
  if (!parsed.success)
    throw new HarnessError(
      'INVALID_INPUT',
      'Неверные настройки relay-v2-cli',
      parsed.error.issues.map((i) => ({
        path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
        message: i.message,
      })),
    );
  return new RelayV2Transport(parsed.data, options);
}

export class RelayV2Transport implements RelayTransport {
  readonly provider = PROVIDER;
  private verified: { identity: TransportIdentity; databasePath: string } | undefined;
  private readonly cwd: string;

  constructor(
    private readonly settings: Settings,
    private readonly options: RelayV2TransportOptions = {},
  ) {
    this.cwd = options.cwd ?? process.cwd();
  }

  /* ---------- процесс и протокол ---------- */

  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME'] as const) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    // Унаследованные RELAY_CONFIG/RELAY_ACTOR/RELAY_USER_* сюда не попадают:
    // окружение собирается заново, а не копируется.
    return { ...env, ...this.settings.env };
  }

  private argv(args: string[], mutation: boolean): string[] {
    return [
      ...args,
      `--config=${this.settings.config}`,
      '--format=json',
      ...(this.settings.project ? [`--project=${this.settings.project}`] : []),
      ...(mutation ? [`--actor=${this.settings.actor}`] : []),
    ];
  }

  private fail(
    kind: TransportErrorKind,
    operation: string,
    message: string,
    extra: { code?: string; actualRevision?: number; mutation?: boolean } = {},
  ): TransportError {
    return new TransportError(kind, operation, `relay-v2 ${operation}: ${message}`, {
      provider: PROVIDER,
      projectId: this.settings.projectId,
      ...extra,
    });
  }

  private log(
    operation: string,
    argv: string[],
    mutation: boolean,
    run: CliRun | undefined,
    outcome: RelayV2CallLog['outcome'],
    code?: string,
  ) {
    if (!this.options.onCall) return;
    this.options.onCall({
      operation,
      argv: [this.settings.binary, ...argv.map(sanitizeArg)],
      cwd: this.cwd,
      mutation,
      exitCode: run?.code ?? null,
      signal: run?.signal ?? null,
      durationMs: run?.durationMs ?? 0,
      ...(code ? { code } : {}),
      outcome,
    });
  }

  /** Один вызов CLI → `{data, meta}` успешного envelope или TransportError. */
  private async call(
    operation: string,
    args: string[],
    { mutation, signal }: CallOptions,
  ): Promise<{ data: unknown; meta: unknown }> {
    const argv = this.argv(args, mutation);
    const run = await runCli(this.settings.binary, argv, {
      cwd: this.cwd,
      env: this.env(),
      timeoutMs: this.settings.timeoutMs,
      maxOutputBytes: this.settings.maxOutputBytes,
      killGraceMs: this.options.killGraceMs ?? 1000,
      ...(signal ? { signal } : {}),
    });
    const flag = { mutation };
    const done = (kind: RelayV2CallLog['outcome'], code?: string) =>
      this.log(operation, argv, mutation, run, kind, code);

    if (run.spawnError || !run.started) {
      done('unavailable', run.spawnError?.code);
      const reason = run.spawnError
        ? `binary не запущен (${run.spawnError.code ?? 'spawn error'})`
        : 'отменено до запуска';
      throw this.fail('unavailable', operation, reason, {
        ...flag,
        ...(run.spawnError?.code ? { code: run.spawnError.code } : {}),
      });
    }
    if (run.timedOut || run.aborted) {
      const kind = mutation ? 'uncertain' : 'unavailable';
      done(kind);
      throw this.fail(
        kind,
        operation,
        `${run.timedOut ? `таймаут ${this.settings.timeoutMs} мс` : 'отменено'} после запуска процесса${mutation ? '; мутация могла примениться' : ''}`,
        flag,
      );
    }
    if (run.oversized) {
      done('protocol');
      throw this.fail(
        'protocol',
        operation,
        `вывод больше ${this.settings.maxOutputBytes} байт`,
        flag,
      );
    }
    if (run.code === 0) {
      const body = parseLine(run.stdout);
      const ok = successSchema.safeParse(body);
      if (!ok.success) {
        done('protocol');
        throw this.fail('protocol', operation, 'stdout не является envelope {ok:true,data}', flag);
      }
      done('ok');
      return { data: ok.data.data, meta: ok.data.meta };
    }
    const failure = failureSchema.safeParse(parseLine(run.stderr));
    if (!failure.success) {
      // Ненулевой exit без структурной ошибки: процесс убит сигналом или
      // вывод не по договору. Для мутации исход неизвестен.
      const kind = run.code === null && mutation ? 'uncertain' : 'protocol';
      done(kind);
      throw this.fail(
        kind,
        operation,
        run.code === null
          ? `процесс завершён сигналом ${run.signal ?? '?'}`
          : `exit ${run.code} без JSON-ошибки в stderr`,
        flag,
      );
    }
    const { code, message, details } = failure.data.error;
    const kind = classifyCode(code, run.code, mutation);
    const actual = details?.actualRevision;
    done(kind, code);
    throw this.fail(kind, operation, `${code}: ${message.slice(0, 300)}`, {
      ...flag,
      code,
      ...(typeof actual === 'number' ? { actualRevision: actual } : {}),
    });
  }

  private shape<T extends z.ZodTypeAny>(
    operation: string,
    schema: T,
    value: unknown,
    mutation: boolean,
  ): z.output<T> {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw this.fail(
        'protocol',
        operation,
        `неожиданная форма ответа: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim(),
        { mutation },
      );
    return parsed.data;
  }

  /** Полный список по `meta.page.nextCursor`; при SNAPSHOT_CONFLICT — заново, ограниченно. */
  private async list<T extends z.ZodTypeAny>(
    operation: string,
    args: string[],
    item: T,
    signal?: AbortSignal,
  ): Promise<z.output<T>[]> {
    const limit = Math.min(100, Math.max(1, this.options.pageLimit ?? 100));
    const maxPages = this.options.maxPages ?? 100;
    const restarts = this.options.snapshotRestarts ?? 3;
    for (let attempt = 0; attempt <= restarts; attempt++) {
      const items: z.output<T>[] = [];
      let cursor: string | null = null;
      let restart = false;
      for (let page = 0; ; page++) {
        if (page >= maxPages)
          throw this.fail('protocol', operation, `больше ${maxPages} страниц`, { mutation: false });
        let res: { data: unknown; meta: unknown };
        try {
          // nextCommand не исполняется: argv собирается заново с тем же запросом.
          res = await this.call(
            operation,
            cursor ? [...args, `--cursor=${cursor}`] : [...args, `--limit=${limit}`],
            { mutation: false, signal },
          );
        } catch (error) {
          if (error instanceof TransportError && error.details.code === 'SNAPSHOT_CONFLICT') {
            restart = true;
            break;
          }
          throw error;
        }
        const data = this.shape(operation, itemsSchema, res.data, false);
        const meta = this.shape(operation, pageMetaSchema, res.meta, false);
        for (const raw of data.items) items.push(this.shape(operation, item, raw, false));
        cursor = meta.page.nextCursor;
        if (!cursor) break;
      }
      if (!restart) return items;
    }
    throw this.fail(
      'conflict',
      operation,
      `данные менялись во время чтения ${restarts + 1} раз подряд`,
      {
        code: 'SNAPSHOT_CONFLICT',
        mutation: false,
      },
    );
  }

  private ref(operation: string, value: string, mutation: boolean): string {
    if (!REF.test(value))
      throw this.fail('refused', operation, 'недопустимый ref (ожидается ключ или UUID)', {
        mutation,
        code: 'INVALID_REF',
      });
    return value;
  }

  /* ---------- идентичность и защита проекта ---------- */

  private async status(operation: string, signal: AbortSignal | undefined, mutation: boolean) {
    const res = await this.call(`${operation}:storage-status`, ['storage', 'status'], {
      mutation: false,
      signal,
    }).catch((error: unknown) => {
      // Отказ проверки перед мутацией: мутация не отправлена.
      if (mutation && error instanceof TransportError && error.kind === 'uncertain')
        throw this.fail('unavailable', operation, error.message, { mutation });
      throw error;
    });
    const status = this.shape(operation, storageStatusSchema, res.data, false);
    if (status.projectId !== this.settings.projectId)
      throw this.fail(
        'refused',
        operation,
        `projectId ${status.projectId} не совпадает с настроенным`,
        {
          code: 'PROJECT_ID_MISMATCH',
          mutation,
        },
      );
    if (this.verified && status.databasePath !== this.verified.databasePath)
      throw this.fail(
        'refused',
        operation,
        'путь базы проекта изменился после проверки идентичности',
        {
          code: 'PROJECT_ID_MISMATCH',
          mutation,
        },
      );
    return status;
  }

  private async ensure(
    operation: string,
    signal: AbortSignal | undefined,
    mutation: boolean,
    ...caps: Capability[]
  ) {
    if (!this.verified) await this.identity(signal);
    const have = this.verified!.identity.capabilities;
    const missing = caps.filter((c) => !have.includes(c));
    if (missing.length)
      throw this.fail('unsupported', operation, `сборка не поддерживает ${missing.join(', ')}`, {
        mutation,
      });
  }

  /** Перед мутацией: идентичность сборки/проекта и свежая сверка projectId. */
  private async guard(operation: string, signal: AbortSignal | undefined, ...caps: Capability[]) {
    await this.ensure(operation, signal, true, ...caps);
    await this.status(operation, signal, true);
  }

  async identity(signal?: AbortSignal): Promise<TransportIdentity> {
    const op = 'identity';
    const build: Record<string, string> = {};
    let sha256: string;
    try {
      sha256 = await hashFile(this.settings.binary);
    } catch (error) {
      throw this.fail(
        'unavailable',
        op,
        `binary недоступен (${(error as NodeJS.ErrnoException).code ?? 'read error'})`,
        { mutation: false },
      );
    }
    build.sha256 = sha256;
    if (this.settings.build?.commit) build.commit = this.settings.build.commit;
    if (this.settings.build?.sha256) {
      if (this.settings.build.sha256 !== sha256)
        throw this.fail(
          'unsupported',
          op,
          `sha256 binary ${sha256} не совпадает с настроенной сборкой`,
          {
            code: 'BUILD_MISMATCH',
            mutation: false,
          },
        );
      build.sha256Verified = 'true';
    } else build.sha256Verified = 'false';

    // Пока проверка не прошла заново, мутации заблокированы.
    this.verified = undefined;
    const status = await this.status(op, signal, false);
    // project get читает сущности: падает на SQLite < 3.44 (STORAGE_ERROR).
    const project = this.shape(
      op,
      projectSchema,
      (await this.call(`${op}:project-get`, ['project', 'get'], { mutation: false, signal })).data,
      false,
    );
    if (project.id !== this.settings.projectId)
      throw this.fail('refused', op, `project get вернул ${project.id}`, {
        code: 'PROJECT_ID_MISMATCH',
        mutation: false,
      });
    const doctor = this.shape(
      op,
      doctorSchema,
      (await this.call(`${op}:doctor`, ['doctor', 'check'], { mutation: false, signal })).data,
      false,
    );
    if (doctor.projectId !== this.settings.projectId)
      throw this.fail('refused', op, `doctor check вернул ${doctor.projectId}`, {
        code: 'PROJECT_ID_MISMATCH',
        mutation: false,
      });
    if (!doctor.valid)
      throw this.fail(
        'refused',
        op,
        `doctor check: ${doctor.issues.length} нарушений целостности`,
        { code: 'INTEGRITY_INVALID', mutation: false },
      );

    const capabilities: string[] = ['relay-2.envelope.json-v1'];
    const probes = await Promise.all(
      Object.entries(RELAY_V2_CAPABILITIES).map(async ([cap, args]) => {
        const argv =
          args[args.length - 1] === '--target'
            ? [...args.slice(0, -1), `--target=${PROBE_REF}`]
            : [...args, PROBE_REF];
        try {
          await this.call(`${op}:probe`, argv, { mutation: false, signal });
          return cap;
        } catch (error) {
          if (!(error instanceof TransportError)) throw error;
          // Команда есть: несуществующая запись даёт NOT_FOUND.
          if (error.details.code === 'NOT_FOUND') return cap;
          // Нет команды/параметра: ошибка разбора argv.
          if (error.details.code === 'INVALID_ARGUMENT') return undefined;
          throw error;
        }
      }),
    );
    for (const cap of probes) if (cap) capabilities.push(cap);
    build.generation = String(status.generation);
    const identity: TransportIdentity = {
      provider: PROVIDER,
      projectId: status.projectId,
      capabilities,
      build,
    };
    this.verified = { identity, databasePath: status.databasePath };
    return identity;
  }

  /* ---------- чтение ---------- */

  async readTask(ref: string, signal?: AbortSignal): Promise<TaskRead> {
    const op = 'task.read';
    this.ref(op, ref, false);
    await this.ensure(
      op,
      signal,
      false,
      'relay-2.task.read',
      'relay-2.task.children',
      'relay-2.task.progress',
      'relay-2.document.target',
    );
    const before = await this.status(op, signal, false);
    const task = await this.getTask(op, ref, signal);
    const children = await this.list(op, ['task', 'children', task.id], taskSchema, signal);
    const childSummaries: TaskSummary[] = [];
    for (const child of children) childSummaries.push(await this.summary(op, child, signal));
    const dependencies: TaskSummary[] = [];
    for (const id of task.data.dependencies)
      dependencies.push(
        await this.summary(op, await this.getTask(op, this.ref(op, id, false), signal), signal),
      );
    const listed = await this.list(
      op,
      ['document', 'list', `--target=${task.id}`],
      documentSchema,
      signal,
    );
    const documents: DocumentRecord[] = [];
    for (const doc of listed) {
      const full = this.shape(
        op,
        documentSchema,
        (
          await this.call(op, ['document', 'get', this.ref(op, doc.id, false)], {
            mutation: false,
            signal,
          })
        ).data,
        false,
      );
      documents.push({
        id: full.id,
        key: full.key,
        name: full.data.name,
        body: full.data.body,
        revision: full.revision,
      });
    }
    const after = await this.status(op, signal, false);
    return {
      task: taskRecord(task),
      children: childSummaries,
      dependencies,
      documents,
      consistency: { before: String(before.generation), after: String(after.generation) },
    };
  }

  private async getTask(op: string, ref: string, signal?: AbortSignal) {
    return this.shape(
      op,
      taskSchema,
      (await this.call(op, ['task', 'get', ref], { mutation: false, signal })).data,
      false,
    );
  }

  private async summary(
    op: string,
    task: z.output<typeof taskSchema>,
    signal?: AbortSignal,
  ): Promise<TaskSummary> {
    const progress = this.shape(
      op,
      progressSchema,
      (
        await this.call(op, ['task', 'progress', this.ref(op, task.id, false)], {
          mutation: false,
          signal,
        })
      ).data,
      false,
    );
    return {
      id: task.id,
      key: task.key,
      title: task.data.title,
      column: task.data.column,
      revision: task.revision,
      finished: progress.completed,
    };
  }

  async listComments(ref: string, signal?: AbortSignal): Promise<CommentRecord[]> {
    const op = 'task.comments';
    this.ref(op, ref, false);
    await this.ensure(op, signal, false, 'relay-2.task.comment');
    const items = await this.list(op, ['task', 'comment', 'list', ref], commentSchema, signal);
    return items.map((c) => ({
      id: c.id,
      title: c.title,
      body: c.body,
      actor: c.createdBy,
      createdAt: c.createdAt,
    }));
  }

  /* ---------- мутации задачи ---------- */

  async addComment(ref: string, input: { title: string; body: string }, signal?: AbortSignal) {
    const op = 'task.comment';
    this.ref(op, ref, true);
    await this.guard(op, signal, 'relay-2.task.comment');
    // Create-mode: без --if-revision. Комментарий append-only, ревизию задачи не меняет.
    const res = await this.call(
      op,
      [
        'task',
        'comment',
        'add',
        ref,
        ...(input.title ? [`--title=${input.title}`] : []),
        `--body=${input.body}`,
      ],
      { mutation: true, signal },
    );
    const task = this.shape(op, taskSchema, res.data, true);
    const last = task.data.comments?.at(-1);
    if (!last || last.body !== input.body)
      throw this.fail('protocol', op, 'ответ не содержит добавленный комментарий', {
        mutation: true,
      });
    return { commentId: last.id };
  }

  async setCriterion(
    ref: string,
    input: { criterionId: string; completed: boolean; ifRevision: number },
    signal?: AbortSignal,
  ) {
    const op = 'task.criterion';
    this.ref(op, ref, true);
    this.ref(op, input.criterionId, true);
    await this.guard(op, signal, 'relay-2.task.criterion');
    const res = await this.call(
      op,
      [
        'task',
        'criterion',
        input.completed ? 'complete' : 'reopen',
        ref,
        input.criterionId,
        `--if-revision=${revision(input.ifRevision)}`,
      ],
      { mutation: true, signal },
    );
    const task = this.shape(op, taskSchema, res.data, true);
    const criterion = task.data.acceptanceCriteria.find((c) => c.id === input.criterionId);
    if (!criterion || criterion.completed !== input.completed)
      throw this.fail('protocol', op, 'ответ не отражает изменение критерия', { mutation: true });
    return { revision: task.revision };
  }

  async move(ref: string, input: { column: TaskColumn; ifRevision: number }, signal?: AbortSignal) {
    const op = 'task.move';
    this.ref(op, ref, true);
    await this.guard(op, signal, 'relay-2.task.read');
    const res = await this.call(
      op,
      [
        'task',
        'move',
        ref,
        `--column=${input.column}`,
        `--if-revision=${revision(input.ifRevision)}`,
      ],
      { mutation: true, signal },
    );
    const task = this.shape(op, taskSchema, res.data, true);
    if (task.data.column !== input.column)
      throw this.fail('protocol', op, 'ответ не отражает перенос', { mutation: true });
    return { revision: task.revision };
  }

  /* ---------- история ---------- */

  async startSession(
    input: { title: string; description: string; client: string; sourceSessionId?: string },
    signal?: AbortSignal,
  ): Promise<HistoryMutation> {
    const op = 'history.start';
    await this.guard(op, signal, 'relay-2.history.session');
    const res = await this.call(
      op,
      [
        'session',
        'start',
        `--title=${input.title}`,
        ...(input.description ? [`--description=${input.description}`] : []),
        `--client=${input.client}`,
        ...(input.sourceSessionId ? [`--source-session-id=${input.sourceSessionId}`] : []),
      ],
      { mutation: true, signal },
    );
    return this.sessionMutation(op, res.data);
  }

  async getSession(ref: string, signal?: AbortSignal): Promise<SessionRecord> {
    const op = 'history.get';
    this.ref(op, ref, false);
    await this.ensure(op, signal, false, 'relay-2.history.session');
    return sessionRecord(await this.readSession(op, ref, signal, false));
  }

  private async readSession(
    op: string,
    ref: string,
    signal: AbortSignal | undefined,
    mutation: boolean,
  ) {
    try {
      return this.shape(
        op,
        sessionSchema,
        (await this.call(op, ['session', 'get', ref], { mutation: false, signal })).data,
        false,
      );
    } catch (error) {
      if (!mutation) throw error;
      // Мутация уже подтверждена ответом CLI; не удалось только дочитать
      // сессию. Исход для ядра — неизвестен до read-back.
      const reason = error instanceof Error ? error.message : String(error);
      throw this.fail('uncertain', op, `мутация применена, но сессия не дочитана: ${reason}`, {
        mutation: true,
        code: 'READBACK_FAILED',
      });
    }
  }

  async findSessions(marker: string, signal?: AbortSignal): Promise<SessionRecord[]> {
    const op = 'history.find';
    if (!marker.trim()) throw this.fail('refused', op, 'пустой marker', { mutation: false });
    await this.ensure(op, signal, false, 'relay-2.history.session');
    // --q ищет по подстроке, но точность поиска — дело backend: фильтруем сами.
    const items = await this.list(op, ['session', 'list', `--q=${marker}`], sessionSchema, signal);
    return items
      .filter((s) => s.data.title.includes(marker) || s.data.description.includes(marker))
      .map(sessionRecord);
  }

  async checkpoints(sessionRef: string, signal?: AbortSignal): Promise<CheckpointRecord[]> {
    const op = 'history.checkpoints';
    this.ref(op, sessionRef, false);
    await this.ensure(op, signal, false, 'relay-2.history.list', 'relay-2.history.session');
    const session = await this.readSession(op, sessionRef, signal, false);
    const items = await this.list(op, ['session', 'history', session.id], checkpointSchema, signal);
    // История ветки может включать потомков: оставляем только эту сессию.
    return items.filter((c) => c.data.sessionId === session.id).map(checkpointRecord);
  }

  async openIntent(
    sessionRef: string,
    input: CheckpointInput & { runId: string; ifRevision: number },
    signal?: AbortSignal,
  ): Promise<HistoryMutation> {
    const op = 'history.intent';
    this.ref(op, sessionRef, true);
    return this.writeCheckpoint(op, ['checkpoint', 'open', sessionRef], 'intent', input, signal);
  }

  async checkpoint(
    intentRef: string,
    kind: 'progress' | 'result' | 'cancel',
    input: CheckpointInput & { runId: string; ifRevision: number },
    signal?: AbortSignal,
  ): Promise<HistoryMutation> {
    const op = `history.${kind}`;
    this.ref(op, intentRef, true);
    const verb = { progress: 'save', result: 'complete', cancel: 'cancel' }[kind];
    return this.writeCheckpoint(op, ['checkpoint', verb, intentRef], kind, input, signal);
  }

  private async writeCheckpoint(
    op: string,
    head: string[],
    kind: CheckpointRecord['kind'],
    input: CheckpointInput & { runId: string; ifRevision: number },
    signal?: AbortSignal,
  ): Promise<HistoryMutation> {
    this.ref(op, input.runId, true);
    if (input.acceptedSessionIds?.length && kind !== 'result')
      throw this.fail(
        'refused',
        op,
        'acceptedSessionIds допустимы только в checkpoint результата',
        { mutation: true },
      );
    for (const id of [...(input.references ?? []), ...(input.acceptedSessionIds ?? [])])
      this.ref(op, id, true);
    await this.guard(op, signal, 'relay-2.history.checkpoint', 'relay-2.history.session');
    // Каждый checkpoint — новая запись (не no-op), даже с тем же содержанием.
    const res = await this.call(
      op,
      [
        ...head,
        `--run=${input.runId}`,
        `--title=${input.title}`,
        `--body=${input.body}`,
        ...(input.summary ? [`--summary=${input.summary}`] : []),
        ...(input.checks ? [`--checks=${input.checks}`] : []),
        ...(input.references ?? []).map((r) => `--references=${r}`),
        ...(input.acceptedSessionIds ?? []).map((s) => `--accept=${s}`),
        `--if-revision=${revision(input.ifRevision)}`,
      ],
      { mutation: true, signal },
    );
    const cp = this.shape(op, checkpointSchema, res.data, true);
    if (cp.data.kind !== kind)
      throw this.fail('protocol', op, `ожидался checkpoint ${kind}, получен ${cp.data.kind}`, {
        mutation: true,
      });
    const session = await this.readSession(op, cp.data.sessionId, signal, true);
    return {
      session: sessionRecord(session),
      runId: input.runId,
      checkpoint: checkpointRecord(cp),
    };
  }

  async fork(
    intentRef: string,
    input: { runId: string; ifRevision: number; title: string; description: string },
    signal?: AbortSignal,
  ): Promise<HistoryMutation> {
    const op = 'history.fork';
    this.ref(op, intentRef, true);
    this.ref(op, input.runId, true);
    await this.guard(op, signal, 'relay-2.history.session', 'relay-2.history.checkpoint');
    const res = await this.call(
      op,
      [
        'session',
        'fork',
        intentRef,
        `--run=${input.runId}`,
        `--title=${input.title}`,
        ...(input.description ? [`--description=${input.description}`] : []),
        `--if-revision=${revision(input.ifRevision)}`,
      ],
      { mutation: true, signal },
    );
    const child = this.shape(op, sessionSchema, res.data, true);
    if (!child.data.parentSessionId)
      throw this.fail('protocol', op, 'дочерняя сессия без parentSessionId', { mutation: true });
    const parent = await this.readSession(op, child.data.parentSessionId, signal, true);
    return {
      session: sessionRecord(parent),
      runId: input.runId,
      childSession: sessionRecord(child),
    };
  }

  async attach(
    sessionRef: string,
    input: { ifRevision: number; client: string; sourceSessionId?: string },
    signal?: AbortSignal,
  ): Promise<HistoryMutation> {
    const op = 'history.attach';
    this.ref(op, sessionRef, true);
    await this.guard(op, signal, 'relay-2.history.session');
    const res = await this.call(
      op,
      [
        'session',
        'attach',
        sessionRef,
        `--client=${input.client}`,
        ...(input.sourceSessionId ? [`--source-session-id=${input.sourceSessionId}`] : []),
        `--if-revision=${revision(input.ifRevision)}`,
      ],
      { mutation: true, signal },
    );
    return this.sessionMutation(op, res.data);
  }

  async takeover(
    sessionRef: string,
    input: { ifRevision: number; reason: string; client: string },
    signal?: AbortSignal,
  ): Promise<HistoryMutation> {
    const op = 'history.takeover';
    this.ref(op, sessionRef, true);
    await this.guard(op, signal, 'relay-2.history.session');
    const res = await this.call(
      op,
      [
        'session',
        'takeover',
        sessionRef,
        `--reason=${input.reason}`,
        `--client=${input.client}`,
        `--if-revision=${revision(input.ifRevision)}`,
      ],
      { mutation: true, signal },
    );
    return this.sessionMutation(op, res.data);
  }

  async finishSession(
    sessionRef: string,
    outcome: 'complete' | 'cancel',
    input: { runId?: string; ifRevision: number; result: string },
    signal?: AbortSignal,
  ): Promise<HistoryMutation> {
    const op = `history.${outcome}`;
    this.ref(op, sessionRef, true);
    if (input.runId) this.ref(op, input.runId, true);
    await this.guard(op, signal, 'relay-2.history.session');
    const res = await this.call(
      op,
      [
        'session',
        outcome,
        sessionRef,
        ...(input.runId ? [`--run=${input.runId}`] : []),
        `--result=${input.result}`,
        `--if-revision=${revision(input.ifRevision)}`,
      ],
      { mutation: true, signal },
    );
    const session = this.shape(op, sessionSchema, res.data, true);
    const expected = outcome === 'complete' ? 'completed' : 'cancelled';
    if (session.data.status !== expected)
      throw this.fail(
        'protocol',
        op,
        `ожидался статус ${expected}, получен ${session.data.status}`,
        { mutation: true },
      );
    return { session: sessionRecord(session), ...(input.runId ? { runId: input.runId } : {}) };
  }

  private sessionMutation(op: string, data: unknown): HistoryMutation {
    const session = this.shape(op, sessionSchema, data, true);
    if (!session.data.currentRunId)
      throw this.fail('protocol', op, 'сессия без активного run после записи', { mutation: true });
    return { session: sessionRecord(session), runId: session.data.currentRunId };
  }
}

/* ---------- преобразования ---------- */

function taskRecord(task: z.output<typeof taskSchema>): TaskRecord {
  return {
    id: task.id,
    key: task.key,
    title: task.data.title,
    description: task.data.description,
    column: task.data.column,
    revision: task.revision,
    parentId: task.data.parentId,
    dependencies: [...task.data.dependencies],
    criteria: task.data.acceptanceCriteria.map((c) => ({
      id: c.id,
      title: c.title,
      summary: c.summary,
      description: c.description,
      completed: c.completed,
    })),
  };
}

function sessionRecord(s: z.output<typeof sessionSchema>): SessionRecord {
  return {
    id: s.id,
    key: s.key,
    status: s.data.status,
    revision: s.revision,
    currentRunId: s.data.currentRunId,
    parentSessionId: s.data.parentSessionId,
    title: s.data.title,
    description: s.data.description,
    result: s.data.result,
  };
}

function checkpointRecord(c: z.output<typeof checkpointSchema>): CheckpointRecord {
  return {
    id: c.id,
    key: c.key,
    sessionId: c.data.sessionId,
    runId: c.data.runId,
    kind: c.data.kind,
    intentId: c.data.intentId,
    title: c.data.title,
    body: c.data.body,
  };
}

function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TransportError('refused', 'revision', `relay-v2: недопустимая ревизия ${value}`, {
      provider: PROVIDER,
      mutation: true,
    });
  return value;
}

/** Ровно одна JSON-строка (допускается завершающий перевод строки). */
function parseLine(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('\n')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function sanitizeArg(arg: string): string {
  if (arg.startsWith('--cursor=')) return '--cursor=<cursor>';
  return arg.length > 240 ? `${arg.slice(0, 240)}…(${arg.length})` : arg;
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')));
  });
}
