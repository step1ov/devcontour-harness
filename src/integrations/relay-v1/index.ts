/**
 * Opt-in entrypoint `devcontour-harness/integrations/relay-v1`: транспорт
 * публичного REST `/api/v1` Relay v1 (сервер `@oim-dev/relay-server` 0.13.x).
 *
 * Зависит только от wire-контракта: `fetch` из Node, без `@relay/rest-sdk` и
 * любых upstream-модулей. Все вызовы проекта идут через project-scoped routes
 * `/api/v1/projects/{projectId}/...`; корневые — только `GET /health`.
 * Каждый ответ проверяется по envelope `{ok,data}` / `{ok:false,error}` и по
 * схеме данных операции; несовместимый ответ — `protocol`, а не пустой успех.
 * `requestId` уникален для каждого вызова и служит только корреляции:
 * сервер не делает dedup, поэтому мутация выполняется ровно один раз, а
 * повтор/read-back — решение ядра коннектора.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HarnessError } from '../../contracts/index.ts';
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
  type SourceQuestionRecord,
  type TaskColumn,
  type TaskContextOutcome,
  type TaskContextRecord,
  type TaskRead,
  type TaskSummary,
  type TransportErrorKind,
  type TransportIdentity,
} from '../connector/transport.ts';

export const RELAY_V1_PROVIDER = 'relay-v1-http' as const satisfies ProviderId;
/** Capability истории работы; без неё методы истории не вызывают routes. */
export const WORK_HISTORY_CAPABILITY = 'relay-work-history-v1';
/**
 * Capability контекста исполнения задачи (`GET /board-tasks/:ref/context`).
 * Без неё транспорт контекст не читает, и связка работает как прежде.
 */
export const TASK_CONTEXT_CAPABILITY = 'relay-task-context-v1';
/** Версия формы ответа контекста (`TaskContext.contractVersion`), с которой проверен транспорт. */
export const TASK_CONTEXT_CONTRACT_VERSION = 1;
/** Capability библиотеки документов: фильтр по типу и состоянию документа. */
export const DOCUMENT_LIBRARY_CAPABILITY = 'relay-document-library-v1';
/** Признак документа-вопроса владельцу по соглашению Relay (`Вопрос: …`). */
export const QUESTION_TITLE = /^\s*(вопрос|question)\s*:/i;

/* ------------------------------------------------------------------ */
/* Настройки                                                           */
/* ------------------------------------------------------------------ */

export const relayV1SettingsSchema = z
  .object({
    /** Origin сервера (`http://127.0.0.1:4700`); суффикс `/api/v1` допустим и отбрасывается. */
    endpoint: z
      .string()
      .url()
      .refine((v) => /^https?:\/\//.test(v), 'endpoint должен быть http(s) URL'),
    /** Постоянный ID проекта Relay (`GET /context` → `projectId`), не имя и не `local`. */
    projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    /** Автор мутаций (`actor` в теле запроса). */
    actor: z.string().min(1).max(256),
    timeoutMs: z.number().int().positive().max(600_000).default(15_000),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024)
      .default(4 * 1024 * 1024),
  })
  .strict();
export type RelayV1Settings = z.input<typeof relayV1SettingsSchema>;
type Settings = z.output<typeof relayV1SettingsSchema>;

export interface RelayV1Options {
  /** Подмена `fetch` (тесты); по умолчанию глобальный `fetch` Node. */
  fetch?: typeof fetch;
  /** Генератор requestId; по умолчанию `dc-<uuid>`. Не идемпотентность. */
  requestId?: () => string;
  /** Сколько раз перезапускать постраничное чтение при смене версии списка. */
  maxPageRestarts?: number;
  /** Сколько раз повторять полное чтение задачи при несогласованных токенах. */
  maxReadRetries?: number;
  /** Роль автора комментариев. */
  actorRole?: 'operator' | 'orchestrator' | 'worker';
}

/* ------------------------------------------------------------------ */
/* Схемы ответов (только поля, которые использует адаптер)             */
/* ------------------------------------------------------------------ */

const envelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().min(1).max(128),
      message: z.string(),
      exitCode: z.number().optional(),
      details: z.unknown().optional(),
    }),
  }),
]);

/** Предел массива в ответе Relay: страница запрашивается по 100 элементов. */
const MAX_ITEMS = 10_000;

const columnSchema = z.enum(['inbox', 'ready', 'in-progress', 'review', 'done', 'cancelled']);
const revisionSchema = z.number().int().nonnegative();
const idString = z.string().min(1);

const taskSummarySchema = z.object({
  id: idString,
  key: z.string(),
  title: z.string(),
  column: columnSchema,
  revision: revisionSchema,
  parentId: z.string().nullable(),
  dependencies: z.array(z.string()).max(MAX_ITEMS),
  canComplete: z.boolean().optional(),
});
const taskViewSchema = taskSummarySchema.extend({ description: z.string() });

const offsetPage = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item).max(MAX_ITEMS),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    version: z.string().min(1),
  });

const criterionSummarySchema = z.object({
  id: idString,
  title: z.string(),
  completed: z.boolean(),
});
const criterionViewSchema = z.object({
  criterion: z.object({
    id: idString,
    title: z.string(),
    summary: z.string(),
    description: z.string(),
    completed: z.boolean(),
  }),
  revision: revisionSchema,
});
const taskSavedSchema = z.object({ id: idString, revision: revisionSchema, action: z.string() });

const commentSummarySchema = z.object({
  id: idString,
  sequence: z.number().int().positive(),
  at: z.string(),
  actor: z.string(),
  title: z.string(),
});
const commentSchema = commentSummarySchema.extend({ description: z.string() });
const commentsPageSchema = z.object({
  items: z.array(commentSummarySchema).max(MAX_ITEMS),
  nextCursor: z.string().nullable(),
  snapshot: z.number().int().nonnegative(),
});
const commentSavedSchema = z.object({
  id: idString,
  commentId: idString,
  action: z.literal('comment-publish'),
});

const entitySummarySchema = z.object({
  ref: z.object({ kind: z.literal('document'), id: idString }),
  key: z.string(),
  revision: revisionSchema,
});
const documentDetailSchema = entitySummarySchema.extend({
  data: z.object({ kind: z.literal('document'), name: z.string(), body: z.string() }),
});

const healthSchema = z.object({ status: z.string(), contractVersion: z.number().int() });

const refSchema = z.object({ kind: z.string().min(1), id: idString });
/** Запись контекста: только поля, которые переносятся в пакет (лишние поля backend допустимы). */
const contextRecordSchema = z.object({
  record: z.object({
    ref: refSchema,
    key: z.string(),
    title: z.string(),
    summary: z.string().optional(),
    revision: revisionSchema,
    implementation: z
      .object({
        type: z.string(),
        application: z.object({ key: z.string() }).nullable().optional(),
        target: z.object({ key: z.string() }).nullable().optional(),
      })
      .nullable()
      .optional(),
    data: z.object({
      description: z.string().optional(),
      body: z.string().optional(),
      summary: z.string().optional(),
    }),
  }),
  reasons: z
    .array(z.object({ code: z.string().min(1).max(80), from: refSchema.nullable() }))
    .min(1)
    .max(MAX_ITEMS),
});
const contextRecords = z.array(contextRecordSchema).max(MAX_ITEMS);
const taskContextSchema = z.object({
  contractVersion: z.number().int(),
  task: z.object({ id: idString, key: z.string(), revision: revisionSchema }),
  targets: contextRecords,
  requirements: contextRecords,
  applications: contextRecords,
  product: contextRecordSchema.nullable(),
  documents: contextRecords,
  consistency: z.string().min(1).max(500),
  complete: z.literal(true),
});
/**
 * Контекст задачи на клиенте (alpha.69): поля, которые Relay 0.13 уже отдаёт
 * по `GET /board-tasks/:ref` (явные цели «Реализует») и `GET /entities/get`
 * (полная запись). Лишние поля backend допустимы.
 */
const taskLinksSchema = z.object({
  id: idString,
  key: z.string(),
  revision: revisionSchema,
  productLinks: z.array(refSchema).max(100).optional(),
});
const contextEntitySchema = z.object({
  ref: refSchema,
  key: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  revision: revisionSchema,
  data: z.object({
    kind: z.string().optional(),
    description: z.string().optional(),
    body: z.string().optional(),
    featureId: z.string().nullable().optional(),
    scenarioId: z.string().nullable().optional(),
    applicationId: z.string().nullable().optional(),
  }),
});
const entityRevisionSchema = z.object({ ref: refSchema, revision: revisionSchema });
/** Предел записей клиентского контекста (как у сервера Relay): больше — `too-large`. */
export const TASK_CONTEXT_RECORD_LIMIT = 1000;
const questionSummarySchema = entitySummarySchema.extend({
  title: z.string(),
  updatedAt: z.string().optional(),
  status: z.string().nullable().optional(),
  document: z
    .object({ kind: z.string().optional(), status: z.string().optional() })
    .nullable()
    .optional(),
});
const questionDetailSchema = documentDetailSchema.extend({
  data: z.object({
    kind: z.literal('document'),
    name: z.string(),
    body: z.string(),
    relations: z
      .array(z.object({ target: refSchema }))
      .max(MAX_ITEMS)
      .optional(),
  }),
  references: z
    .array(z.object({ ref: refSchema, key: z.string() }))
    .max(MAX_ITEMS)
    .optional(),
});
/**
 * Версия договора REST Relay v1 (`GET /api/v1/health` → `contractVersion`),
 * с которой проверен этот транспорт. Другая версия — отказ
 * `CONNECTOR_VERSION_MISMATCH` до чтения проекта и любых мутаций: поля и
 * коды отказов другой версии транспорт не знает.
 */
export const RELAY_V1_CONTRACT_VERSION = 1;
const contextSchema = z.object({
  projectId: z.string().min(1),
  capabilities: z.array(z.string()).max(MAX_ITEMS).optional(),
});

const sessionSchema = z.object({
  id: idString,
  key: z.string(),
  title: z.string(),
  description: z.string(),
  parentSessionId: z.string().nullable(),
  status: z.enum(['pending', 'open', 'paused', 'completed', 'cancelled']),
  currentRunId: z.string().nullable(),
  result: z.string(),
  revision: revisionSchema,
});
const sessionOverviewSchema = z.object({ id: idString, title: z.string() });
const checkpointSchema = z.object({
  id: idString,
  key: z.string(),
  sessionId: idString,
  runId: idString,
  kind: z.enum(['intent', 'progress', 'result', 'cancel']),
  intentId: z.string().nullable(),
  title: z.string(),
  body: z.string(),
});
const mutationSchema = z.object({
  session: sessionSchema,
  run: z.object({ id: idString }).nullable(),
  checkpoint: checkpointSchema.nullable(),
  childSession: sessionSchema.nullable(),
});
const sessionDetailSchema = z.object({ session: sessionSchema });
const historyItemSchema = z.object({ kind: z.string(), checkpoint: checkpointSchema.optional() });

/* ------------------------------------------------------------------ */
/* Классификация отказов                                               */
/* ------------------------------------------------------------------ */

/** Коды, по которым мутация точно не применена из-за CAS/состояния. */
const CONFLICT_CODES = new Set([
  'REVISION_CONFLICT',
  'WORK_RUN_NOT_CURRENT',
  'VERSION_CONFLICT',
  'BOARD_CHANGED',
  'ENTITIES_CHANGED',
  'CONFLICT',
]);
/** Доменные отказы backend: мутация не применена. */
const REFUSED_CODES = new Set([
  'TASK_ACCEPTANCE_INCOMPLETE',
  'TASK_BLOCKED',
  'TASK_ACCEPTANCE_LOCKED',
  'VALIDATION_ERROR',
  'INVALID_ARGUMENT',
  'INVALID_ID',
  'INVALID_CURSOR',
  'INVALID_REFERENCE',
  'DEPENDENCY_CYCLE',
  'UNKNOWN_STATUS',
  'TASK_TOO_LARGE',
  'RESPONSE_TOO_LARGE',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'FORBIDDEN_ORIGIN',
  'ENTITY_KEY_CONFLICT',
  'STORAGE_MIGRATION_REQUIRED',
  'STORAGE_INDEX_STALE',
]);
const UNAVAILABLE_CODES = new Set(['SYNC_NETWORK_UNAVAILABLE']);
const UNSUPPORTED_CODES = new Set(['UNSUPPORTED', 'SERVER_INCOMPATIBLE']);
/** Коды, при которых постраничное чтение начинается заново. */
const PAGE_RESTART_CODES = new Set(['BOARD_CHANGED', 'VERSION_CONFLICT', 'ENTITIES_CHANGED']);
/** Сетевые ошибки, при которых запрос точно не отправлен. */
const PRE_SEND_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_INVALID_URL',
]);

export function classifyCode(code: string, status: number, mutation: boolean): TransportErrorKind {
  if (CONFLICT_CODES.has(code) || code.startsWith('WORK_')) return 'conflict';
  if (REFUSED_CODES.has(code)) return 'refused';
  if (code === 'NOT_FOUND' || code.endsWith('_NOT_FOUND') || code === 'ENTITY_RELOCATED')
    return 'not-found';
  if (UNAVAILABLE_CODES.has(code)) return 'unavailable';
  if (UNSUPPORTED_CODES.has(code)) return 'unsupported';
  if (status >= 400 && status < 500) return 'refused';
  /* 5xx с неизвестным кодом: для мутации исход не доказан. */
  return mutation ? 'uncertain' : 'unavailable';
}

/** Безопасный фрагмент текста backend: одна строка, ограниченная длина. */
function safe(text: string, max = 200): string {
  const line = text.replace(/[\r\n\t]+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function errorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Транспорт                                                           */
/* ------------------------------------------------------------------ */

interface CallOptions {
  method: 'GET' | 'POST';
  /** Путь относительно `/api/v1/projects/{p}` (или абсолютный `/api/v1/...` при `root`). */
  path: string;
  /** Массив — повтор параметра (`refs=a&refs=b`). */
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: Record<string, unknown>;
  root?: boolean;
  signal?: AbortSignal | undefined;
  /** Предел ответа этого вызова; по умолчанию `maxResponseBytes`. */
  maxBytes?: number;
}

class PageRestart extends Error {}

/** Код ответа больше локального предела чтения (не код backend). */
const RESPONSE_LIMIT = 'RESPONSE_LIMIT';

export class RelayV1Transport implements RelayTransport {
  readonly provider = RELAY_V1_PROVIDER;
  readonly settings: Readonly<Settings>;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nextRequestId: () => string;
  private readonly maxPageRestarts: number;
  private readonly maxReadRetries: number;
  private readonly actorRole: 'operator' | 'orchestrator' | 'worker';
  private capabilities: Promise<string[]> | undefined;

  constructor(settings: Settings, options: RelayV1Options = {}) {
    this.settings = Object.freeze({ ...settings });
    this.base = settings.endpoint.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.nextRequestId = options.requestId ?? (() => `dc-${randomUUID()}`);
    this.maxPageRestarts = options.maxPageRestarts ?? 3;
    this.maxReadRetries = options.maxReadRetries ?? 3;
    this.actorRole = options.actorRole ?? 'worker';
  }

  private fail(
    kind: TransportErrorKind,
    operation: string,
    reason: string,
    extra: { code?: string; actualRevision?: number; mutation?: boolean } = {},
  ): TransportError {
    return new TransportError(
      kind,
      operation,
      `relay-v1 ${operation} (project ${this.settings.projectId}): ${reason}`,
      { provider: this.provider, projectId: this.settings.projectId, ...extra },
    );
  }

  private url(o: CallOptions): string {
    const prefix = o.root ? '' : `/api/v1/projects/${encodeURIComponent(this.settings.projectId)}`;
    const u = new URL(`${this.base}${prefix}${o.path}`);
    for (const [k, v] of Object.entries(o.query ?? {}))
      if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, item);
      else if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** Один HTTP-вызов без повторов: envelope, классификация, схема данных. */
  private async call<T extends z.ZodTypeAny>(
    operation: string,
    schema: T,
    o: CallOptions,
  ): Promise<z.output<T>> {
    const mutation = o.method === 'POST';
    // Мутация — только после сверки версии договора сервера (один раз на транспорт).
    if (mutation) await this.compatible(operation, o.signal);
    if (o.signal?.aborted)
      throw this.fail('unavailable', operation, 'aborted before send', { mutation: false });
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.settings.timeoutMs);
    const onAbort = () => controller.abort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const body = mutation
      ? JSON.stringify({ ...o.body, requestId: this.nextRequestId(), actor: this.settings.actor })
      : undefined;
    let status: number;
    let text: string;
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url(o), {
          method: o.method,
          headers: {
            accept: 'application/json',
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body,
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (e) {
        throw this.transportFailure(operation, e, mutation, timedOut, 'request');
      }
      status = res.status;
      try {
        text = await this.readLimited(res, operation, mutation, o.maxBytes);
      } catch (e) {
        if (e instanceof TransportError) throw e;
        throw this.transportFailure(operation, e, mutation, timedOut, 'response');
      }
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw this.fail('protocol', operation, `invalid JSON response (HTTP ${status})`, {
        mutation,
      });
    }
    const env = envelopeSchema.safeParse(json);
    if (!env.success) {
      throw this.fail('protocol', operation, `response is not a Relay envelope (HTTP ${status})`, {
        mutation,
      });
    }
    if (!env.data.ok) {
      const { code, message, details } = env.data.error;
      if (status < 400) {
        throw this.fail('protocol', operation, `error envelope with HTTP ${status}`, {
          code,
          mutation,
        });
      }
      const kind = classifyCode(code, status, mutation);
      const actual = (details as { actual?: unknown } | undefined)?.actual;
      throw this.fail(kind, operation, `${code}: ${safe(message)}`, {
        code,
        mutation,
        ...(typeof actual === 'number' ? { actualRevision: actual } : {}),
      });
    }
    if (status < 200 || status >= 300) {
      throw this.fail('protocol', operation, `success envelope with HTTP ${status}`, { mutation });
    }
    const data = schema.safeParse(env.data.data);
    if (!data.success) {
      const issue = data.error.issues[0];
      throw this.fail(
        'protocol',
        operation,
        `incompatible response data at ${issue?.path.join('.') || '<root>'}: ${safe(issue?.message ?? 'invalid')}`,
        { mutation },
      );
    }
    return data.data;
  }

  private transportFailure(
    operation: string,
    e: unknown,
    mutation: boolean,
    timedOut: boolean,
    phase: string,
  ) {
    const code = errorCode(e);
    if (phase === 'request' && code && PRE_SEND_CODES.has(code)) {
      return this.fail('unavailable', operation, `server unreachable (${code})`, {
        mutation: false,
      });
    }
    const reason = timedOut
      ? `timeout after ${this.settings.timeoutMs}ms`
      : `connection failed (${code ?? 'aborted'})`;
    if (mutation) {
      return this.fail(
        'uncertain',
        operation,
        `${reason} after send; outcome unknown, read back before retry`,
        {
          mutation: true,
        },
      );
    }
    return this.fail('unavailable', operation, `${reason} during ${phase}`, { mutation: false });
  }

  private async readLimited(
    res: Response,
    operation: string,
    mutation: boolean,
    limit?: number,
  ): Promise<string> {
    const max = limit ?? this.settings.maxResponseBytes;
    const declared = Number(res.headers.get('content-length') ?? NaN);
    const tooLarge = () =>
      this.fail('protocol', operation, `response exceeds ${max} bytes (HTTP ${res.status})`, {
        code: RESPONSE_LIMIT,
        mutation,
      });
    if (Number.isFinite(declared) && declared > max) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    if (!res.body) return '';
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** Полное постраничное чтение offset/limit/version; частичный список не возвращается. */
  private async pages<T extends z.ZodTypeAny>(
    operation: string,
    item: T,
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    signal?: AbortSignal,
  ): Promise<{ items: z.output<T>[]; version: string }> {
    const schema = offsetPage(item);
    for (let attempt = 0; attempt <= this.maxPageRestarts; attempt++) {
      try {
        return (await this.pagesOnce(operation, schema, path, query, signal)) as {
          items: z.output<T>[];
          version: string;
        };
      } catch (e) {
        if (e instanceof PageRestart) continue;
        throw e;
      }
    }
    throw this.fail(
      'conflict',
      operation,
      `list kept changing after ${this.maxPageRestarts} restarts`,
    );
  }

  private async pagesOnce(
    operation: string,
    schema: z.ZodType<{
      items: unknown[];
      total: number;
      nextOffset: number | null;
      version: string;
    }>,
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    signal?: AbortSignal,
  ): Promise<{ items: unknown[]; version: string }> {
    const items: unknown[] = [];
    let offset = 0;
    let version: string | undefined;
    let total: number | undefined;
    for (let page = 0; ; page++) {
      if (page > 10_000) throw this.fail('protocol', operation, 'pagination does not terminate');
      let data: { items: unknown[]; total: number; nextOffset: number | null; version: string };
      try {
        data = await this.call(operation, schema, {
          method: 'GET',
          path,
          query: { ...query, offset, limit: 100, version },
          signal,
        });
      } catch (e) {
        if (
          e instanceof TransportError &&
          page > 0 &&
          e.details.code &&
          PAGE_RESTART_CODES.has(e.details.code)
        ) {
          throw new PageRestart();
        }
        throw e;
      }
      if (version !== undefined && data.version !== version) throw new PageRestart();
      if (total !== undefined && data.total !== total) throw new PageRestart();
      version = data.version;
      total = data.total;
      items.push(...data.items);
      if (data.nextOffset === null) break;
      if (data.nextOffset <= offset || data.items.length === 0) {
        throw this.fail('protocol', operation, 'pagination offset does not advance');
      }
      offset = data.nextOffset;
    }
    if (items.length !== total) {
      throw this.fail('protocol', operation, `list incomplete: ${items.length} of ${total}`);
    }
    return { items, version: version ?? '' };
  }

  private enc(ref: string): string {
    if (!ref) throw this.fail('refused', 'ref', 'empty reference');
    return encodeURIComponent(ref);
  }

  /* ---------------- Подключение ---------------- */

  /** Сверенная версия договора сервера; отказ сверки запоминается. */
  private version?: Promise<z.output<typeof healthSchema>>;

  /** Health и сверка `contractVersion` (`RELAY_V1_CONTRACT_VERSION`). */
  private async health(operation: string, signal?: AbortSignal) {
    const health = await this.call(`${operation}.health`, healthSchema, {
      method: 'GET',
      path: '/api/v1/health',
      root: true,
      signal,
    });
    if (health.contractVersion !== RELAY_V1_CONTRACT_VERSION)
      throw this.fail(
        'unsupported',
        `${operation}.health`,
        `Relay сообщает версию договора REST ${health.contractVersion}, а этот harness работает с версией ${RELAY_V1_CONTRACT_VERSION} (Relay 0.13.x и новее с тем же договором; сервер сообщает contractVersion ${health.contractVersion}, транспорт проверен с ${RELAY_V1_CONTRACT_VERSION}). ` +
          (health.contractVersion > RELAY_V1_CONTRACT_VERSION
            ? 'Relay новее, чем знает harness: обновите devcontour-harness'
            : 'Relay старее, чем нужно harness: обновите Relay'),
        { code: 'CONNECTOR_VERSION_MISMATCH', mutation: false },
      );
    return health;
  }

  /**
   * Версия договора сверена до первой мутации: путь доставки и разбора не
   * обязан начинаться с `identity`. Отказ несовпадения запоминается; сбой
   * сети — нет (следующая мутация сверяет снова).
   */
  private async compatible(operation: string, signal?: AbortSignal) {
    if (!this.version) {
      const p = this.health(operation, signal);
      this.version = p;
      p.catch((error: unknown) => {
        if (
          this.version === p &&
          !(error instanceof TransportError && error.details.code === 'CONNECTOR_VERSION_MISMATCH')
        )
          this.version = undefined;
      });
    }
    await this.version;
  }

  async identity(signal?: AbortSignal): Promise<TransportIdentity> {
    let health: z.output<typeof healthSchema>;
    try {
      health = await this.health('identity', signal);
    } catch (error) {
      // Несовпадение, замеченное identity, закрывает и мутации — даже после
      // прежней успешной сверки.
      if (error instanceof TransportError && error.details.code === 'CONNECTOR_VERSION_MISMATCH') {
        const refused = Promise.reject(error);
        refused.catch(() => undefined);
        this.version = refused;
      }
      throw error;
    }
    this.version = Promise.resolve(health);
    const ctx = await this.call('identity.context', contextSchema, {
      method: 'GET',
      path: '/context',
      signal,
    });
    const capabilities = [...(ctx.capabilities ?? [])].sort();
    this.capabilities = Promise.resolve(capabilities);
    return {
      provider: this.provider,
      projectId: ctx.projectId,
      capabilities,
      build: { api: 'v1', contractVersion: String(health.contractVersion), health: health.status },
    };
  }

  /** Capabilities проекта (кэш на транспорт); сбой чтения не кэшируется. */
  private async capabilityList(operation: string, signal?: AbortSignal): Promise<string[]> {
    if (!this.capabilities) {
      const p = this.call(`${operation}.capabilities`, contextSchema, {
        method: 'GET',
        path: '/context',
        signal,
      }).then((ctx) => ctx.capabilities ?? []);
      this.capabilities = p;
      p.catch(() => {
        if (this.capabilities === p) this.capabilities = undefined;
      });
    }
    return this.capabilities;
  }

  private async requireCapability(operation: string, capability: string, signal?: AbortSignal) {
    const caps = await this.capabilityList(operation, signal);
    if (!caps.includes(capability)) {
      throw this.fail('unsupported', operation, `server does not declare ${capability}`, {
        code: 'UNSUPPORTED',
      });
    }
  }

  /** Capability истории (кэш на транспорт); без неё route не вызывается. */
  private requireHistory(operation: string, signal?: AbortSignal): Promise<void> {
    return this.requireCapability(operation, WORK_HISTORY_CAPABILITY, signal);
  }

  /* ---------------- Задачи ---------------- */

  private summary(t: z.output<typeof taskSummarySchema>): TaskSummary {
    return {
      id: t.id,
      key: t.key,
      title: t.title,
      column: t.column,
      revision: t.revision,
      finished: t.column === 'done' && t.canComplete === true,
    };
  }

  private async readTaskOnce(ref: string, signal?: AbortSignal) {
    const op = 'task.read';
    const r = this.enc(ref);
    const view = await this.call(op, taskViewSchema, {
      method: 'GET',
      path: `/board-tasks/${r}`,
      signal,
    });
    const id = this.enc(view.id);
    const crit = await this.pages(
      op,
      criterionSummarySchema,
      `/board-tasks/${id}/criteria`,
      {},
      signal,
    );
    const criteria: CriterionRecord[] = [];
    for (const c of crit.items) {
      const full = await this.call(op, criterionViewSchema, {
        method: 'GET',
        path: `/board-tasks/${id}/criteria/${this.enc(c.id)}`,
        signal,
      });
      const { id: cid, title, summary, description, completed } = full.criterion;
      criteria.push({ id: cid, title, summary, description, completed });
    }
    const children = await this.pages(
      op,
      taskSummarySchema,
      '/board-tasks',
      { parentId: view.id },
      signal,
    );
    const dependencies: TaskSummary[] = [];
    for (const dep of view.dependencies) {
      const d = await this.call(op, taskSummarySchema, {
        method: 'GET',
        path: `/board-tasks/${this.enc(dep)}`,
        signal,
      });
      dependencies.push(this.summary(d));
    }
    const docs = await this.pages(
      op,
      entitySummarySchema,
      '/entities',
      { kind: 'document', target: view.id },
      signal,
    );
    const documents: DocumentRecord[] = [];
    for (const d of docs.items) {
      const full = await this.call(op, documentDetailSchema, {
        method: 'GET',
        path: '/entities/get',
        query: { ref: d.ref.id, kind: 'document' },
        signal,
      });
      documents.push({
        id: full.ref.id,
        key: full.key,
        name: full.data.name,
        body: full.data.body,
        revision: full.revision,
      });
    }
    const read: Omit<TaskRead, 'consistency'> = {
      task: {
        id: view.id,
        key: view.key,
        title: view.title,
        description: view.description,
        column: view.column,
        revision: view.revision,
        parentId: view.parentId,
        dependencies: [...view.dependencies],
        criteria,
      },
      children: children.items.map((c) => this.summary(c)),
      dependencies,
      documents,
    };
    const token = digest([
      view.revision,
      crit.version,
      children.version,
      docs.version,
      dependencies.map((d) => [d.id, d.revision, d.finished]),
      documents.map((d) => [d.id, d.revision]),
    ]);
    return { read, token, id: view.id };
  }

  /** Токен текущей редакции без полного чтения тел: ревизии и версии списков. */
  private async probe(id: string, signal?: AbortSignal): Promise<string> {
    const op = 'task.read';
    const r = this.enc(id);
    const view = await this.call(op, taskViewSchema, {
      method: 'GET',
      path: `/board-tasks/${r}`,
      signal,
    });
    const crit = await this.pages(
      op,
      criterionSummarySchema,
      `/board-tasks/${r}/criteria`,
      {},
      signal,
    );
    const children = await this.pages(
      op,
      taskSummarySchema,
      '/board-tasks',
      { parentId: id },
      signal,
    );
    const deps = [];
    for (const dep of view.dependencies) {
      const d = await this.call(op, taskSummarySchema, {
        method: 'GET',
        path: `/board-tasks/${this.enc(dep)}`,
        signal,
      });
      const s = this.summary(d);
      deps.push([s.id, s.revision, s.finished]);
    }
    const docs = await this.pages(
      op,
      entitySummarySchema,
      '/entities',
      { kind: 'document', target: id },
      signal,
    );
    return digest([
      view.revision,
      crit.version,
      children.version,
      docs.version,
      deps,
      docs.items.map((d) => [d.ref.id, d.revision]),
    ]);
  }

  async readTask(ref: string, signal?: AbortSignal): Promise<TaskRead> {
    let last: TaskRead | undefined;
    for (let attempt = 0; attempt <= this.maxReadRetries; attempt++) {
      const { read, token, id } = await this.readTaskOnce(ref, signal);
      const after = await this.probe(id, signal);
      last = { ...read, consistency: { before: token, after } };
      if (token === after) return last;
    }
    /* Не согласовалось за отведённые повторы: ядро увидит before ≠ after. */
    return last!;
  }

  /**
   * Контекст исполнения задачи одним чтением (`relay-task-context-v1`).
   * Ответ больше `maxBytes` или `CONTEXT_TOO_LARGE` backend — `too-large`:
   * усечённого контекста нет. Другая версия формы ответа — именованный отказ
   * `CONNECTOR_VERSION_MISMATCH`, а не чтение по догадке.
   */
  async readTaskContext(
    ref: string,
    options: { targetDocuments: boolean; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<TaskContextOutcome> {
    // Сервер с готовым маршрутом контекста — одно чтение; иначе (Relay
    // 0.13 без доработок) контекст собирает сам транспорт из обычных
    // маршрутов — тот же состав и та же форма (alpha.69).
    const caps = await this.capabilityList('task.context', signal);
    if (!caps.includes(TASK_CONTEXT_CAPABILITY)) return this.buildTaskContext(ref, options, signal);
    return this.readNativeTaskContext(ref, options, signal);
  }

  /**
   * Контекст задачи на клиенте из маршрутов Relay 0.13: задача (явные цели
   * «Реализует»), каждая цель FI/SI, её фича, сценарий и приложение
   * (`GET /entities/get`), паспорт продукта, неархивные документы задачи и,
   * с `targetDocuments`, её целей (`GET /entities?kind=document&target=…`).
   * Состав и основания — как у маршрута `relay-task-context-v1`. Согласованность
   * без токена сервера: после сборки ревизии задачи и всех записей читаются
   * заново (`GET /entities?refs=…`); расхождение — новая сборка (до
   * `maxReadRetries` раз), а снимок дополнительно сверяет два раунда.
   */
  private async buildTaskContext(
    ref: string,
    options: { targetDocuments: boolean; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<TaskContextOutcome> {
    let last: TaskContextOutcome | undefined;
    for (let attempt = 0; attempt <= this.maxReadRetries; attempt++) {
      const built = await this.buildTaskContextOnce(ref, options, signal);
      if (built.outcome.status === 'too-large') return built.outcome;
      last = built.outcome;
      if (await this.contextStable(built.task, built.revisions, signal)) return built.outcome;
    }
    return last!;
  }

  private async buildTaskContextOnce(
    ref: string,
    options: { targetDocuments: boolean; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<{
    outcome: TaskContextOutcome;
    task: { id: string; revision: number };
    revisions: Map<string, { kind: string; id: string; revision: number }>;
  }> {
    const op = 'task.context';
    const task = await this.call(op, taskLinksSchema, {
      method: 'GET',
      path: `/board-tasks/${this.enc(ref)}`,
      signal,
    });
    type Section = TaskContextRecord['section'];
    type Entity = z.output<typeof contextEntitySchema>;
    const address = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;
    const included = new Map<
      string,
      { section: Section; entity: Entity; reasons: { code: string; from: string | null }[] }
    >();
    let bytes = 0;
    const tooLarge = (reason: string) => ({
      outcome: { status: 'too-large' as const, reason },
      task: { id: task.id, revision: task.revision },
      revisions: new Map<string, { kind: string; id: string; revision: number }>(),
    });
    class TooLarge extends Error {}
    const get = (r: { kind: string; id: string }) =>
      this.call(op, contextEntitySchema, {
        method: 'GET',
        path: '/entities/get',
        query: { ref: r.id, kind: r.kind },
        signal,
      });
    const include = async (
      r: { kind: string; id: string },
      section: Section,
      reason: { code: string; from: { kind: string; id: string } | null },
      known?: Entity,
    ): Promise<Entity> => {
      const from = reason.from ? address(reason.from) : null;
      const existing = included.get(address(r));
      if (existing) {
        if (!existing.reasons.some((x) => x.code === reason.code && x.from === from))
          existing.reasons.push({ code: reason.code, from });
        return existing.entity;
      }
      if (included.size >= TASK_CONTEXT_RECORD_LIMIT)
        throw new TooLarge(`записей контекста больше предела ${TASK_CONTEXT_RECORD_LIMIT}`);
      const entity = known ?? (await get(r));
      bytes += Buffer.byteLength(
        (entity.data.description ?? '') + (entity.data.body ?? '') + entity.title,
        'utf8',
      );
      if (bytes > options.maxBytes)
        throw new TooLarge(
          `контекст задачи больше предела taskContext.maxBytes=${options.maxBytes}`,
        );
      included.set(address(entity.ref), {
        section,
        entity,
        reasons: [{ code: reason.code, from }],
      });
      return entity;
    };
    const taskRef = { kind: 'task', id: task.id };
    try {
      // Цели и их владельцы: FI → фича (и сценарий), приложение; SI-сценарий → фича.
      const targets: Entity[] = [];
      for (const link of task.productLinks ?? [])
        targets.push(await include(link, 'target', { code: 'task-target', from: taskRef }));
      const owners: Entity[] = [];
      for (const target of targets) {
        const d = target.data;
        const from = target.ref;
        if (d.kind === 'implementation') {
          if (d.featureId)
            owners.push(
              await include({ kind: 'feature', id: d.featureId }, 'requirement', {
                code: 'target-feature',
                from,
              }),
            );
          if (d.scenarioId)
            owners.push(
              await include({ kind: 'scenario', id: d.scenarioId }, 'requirement', {
                code: 'target-scenario',
                from,
              }),
            );
          if (d.applicationId)
            owners.push(
              await include({ kind: 'application', id: d.applicationId }, 'application', {
                code: 'target-application',
                from,
              }),
            );
        }
        if (d.kind === 'scenario' && d.featureId)
          owners.push(
            await include({ kind: 'feature', id: d.featureId }, 'requirement', {
              code: 'target-feature',
              from,
            }),
          );
      }
      try {
        const passport = await get({ kind: 'product', id: 'passport' });
        await include(passport.ref, 'product', { code: 'product-passport', from: null }, passport);
      } catch (error) {
        if (!(error instanceof TransportError && error.details.code === 'ENTITY_NOT_FOUND'))
          throw error;
      }
      // Неархивные документы, прикреплённые к задаче, и — по настройке — к целям.
      const attached = async (owner: { kind: string; id: string }, code: string) => {
        const list = await this.pages(
          op,
          entityRevisionSchema,
          '/entities',
          { kind: 'document', target: owner.id, archived: 'false' },
          signal,
        );
        for (const item of list.items) await include(item.ref, 'document', { code, from: owner });
      };
      await attached(taskRef, 'task-document');
      if (options.targetDocuments) {
        const seen = new Set<string>();
        for (const { ref: r } of [...targets, ...owners])
          if (!seen.has(address(r))) {
            seen.add(address(r));
            await attached(r, 'target-document');
          }
      }
    } catch (error) {
      if (error instanceof TooLarge) return tooLarge(error.message);
      if (
        error instanceof TransportError &&
        (error.details.code === RESPONSE_LIMIT || error.details.code === 'CONTEXT_TOO_LARGE')
      )
        return tooLarge(`ответ Relay больше предела: ${error.message}`);
      throw error;
    }
    const keys = new Map<string, string>([[address(taskRef), task.key]]);
    for (const [k, v] of included) keys.set(k, v.entity.key);
    const order: Section[] = ['target', 'requirement', 'application', 'product', 'document'];
    const records: TaskContextRecord[] = order.flatMap((section) =>
      [...included.values()]
        .filter((e) => e.section === section)
        .map(({ entity, reasons }) => ({
          section,
          kind: entity.ref.kind,
          id: entity.ref.id,
          key: entity.key,
          title: entity.title,
          revision: entity.revision,
          summary: entity.summary ?? '',
          body: entity.data.description ?? entity.data.body ?? '',
          reasons: reasons.map((x) => ({
            code: x.code,
            from: x.from ? (keys.get(x.from) ?? x.from.split(':').slice(1).join(':')) : null,
          })),
        })),
    );
    const revisions = new Map(
      [...included.values()].map((e) => [
        address(e.entity.ref),
        { kind: e.entity.ref.kind, id: e.entity.ref.id, revision: e.entity.revision },
      ]),
    );
    return {
      outcome: {
        status: 'ok',
        context: {
          contractVersion: TASK_CONTEXT_CONTRACT_VERSION,
          consistency: 'client-v1:' + digest([task.revision, options.targetDocuments, records]),
          taskRevision: task.revision,
          records,
        },
      },
      task: { id: task.id, revision: task.revision },
      revisions,
    };
  }

  /** Ревизии задачи и записей контекста не изменились после сборки. */
  private async contextStable(
    task: { id: string; revision: number },
    revisions: Map<string, { kind: string; id: string; revision: number }>,
    signal?: AbortSignal,
  ) {
    const op = 'task.context';
    const now = await this.call(op, taskLinksSchema, {
      method: 'GET',
      path: `/board-tasks/${this.enc(task.id)}`,
      signal,
    });
    if (now.revision !== task.revision) return false;
    const all = [...revisions.values()];
    for (let i = 0; i < all.length; i += 100) {
      const chunk = all.slice(i, i + 100);
      const page = await this.call(op, offsetPage(entityRevisionSchema), {
        method: 'GET',
        path: '/entities',
        query: { refs: chunk.map((r) => r.id), limit: 100 },
        signal,
      });
      const seen = new Map(page.items.map((x) => [`${x.ref.kind}:${x.ref.id}`, x.revision]));
      if (chunk.some((r) => seen.get(`${r.kind}:${r.id}`) !== r.revision)) return false;
    }
    return true;
  }

  /** Контекст одним чтением маршрута `relay-task-context-v1` (сервер его объявил). */
  private async readNativeTaskContext(
    ref: string,
    options: { targetDocuments: boolean; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<TaskContextOutcome> {
    const op = 'task.context';
    let raw: unknown;
    try {
      raw = await this.call(op, z.unknown(), {
        method: 'GET',
        path: `/board-tasks/${this.enc(ref)}/context`,
        query: { targetDocuments: options.targetDocuments ? 'true' : 'false' },
        signal,
        // Ответ JSON больше файла пакета (обёртка и служебные поля): свой
        // предел, не выше общего предела ответа транспорта.
        maxBytes: Math.min(this.settings.maxResponseBytes, options.maxBytes * 4),
      });
    } catch (error) {
      if (
        error instanceof TransportError &&
        (error.details.code === 'CONTEXT_TOO_LARGE' || error.details.code === RESPONSE_LIMIT)
      )
        return {
          status: 'too-large',
          reason:
            error.details.code === RESPONSE_LIMIT
              ? `ответ Relay больше предела ${Math.min(this.settings.maxResponseBytes, options.maxBytes * 4)} байт (taskContext.maxBytes=${options.maxBytes})`
              : 'Relay: контекст больше предела сервера (CONTEXT_TOO_LARGE)',
        };
      throw error;
    }
    const version = (raw as { contractVersion?: unknown } | null)?.contractVersion;
    if (version !== TASK_CONTEXT_CONTRACT_VERSION)
      throw this.fail(
        'unsupported',
        op,
        `Relay отдаёт контекст задачи в форме версии ${String(version)}, а этот harness читает версию ${TASK_CONTEXT_CONTRACT_VERSION}: обновите devcontour-harness или Relay до пары из docs/compatibility-versions.md`,
        { code: 'CONNECTOR_VERSION_MISMATCH', mutation: false },
      );
    const parsed = taskContextSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw this.fail(
        'protocol',
        op,
        `incompatible response data at ${issue?.path.join('.') || '<root>'}: ${safe(issue?.message ?? 'invalid')}`,
      );
    }
    const data = parsed.data;
    const keys = new Map<string, string>([[data.task.id, data.task.key]]);
    type Entry = [TaskContextRecord['section'], z.output<typeof contextRecordSchema>];
    const tag =
      (section: TaskContextRecord['section']) =>
      (r: Entry[1]): Entry => [section, r];
    const all: Entry[] = [
      ...data.targets.map(tag('target')),
      ...data.requirements.map(tag('requirement')),
      ...data.applications.map(tag('application')),
      ...(data.product ? [tag('product')(data.product)] : []),
      ...data.documents.map(tag('document')),
    ];
    for (const [, r] of all) keys.set(r.record.ref.id, r.record.key);
    const records: TaskContextRecord[] = all.map(([section, r]) => {
      const rec = r.record;
      const impl = rec.implementation;
      return {
        section,
        kind: rec.ref.kind,
        id: rec.ref.id,
        key: rec.key,
        title: rec.title,
        revision: rec.revision,
        summary: rec.summary ?? rec.data.summary ?? '',
        body: rec.data.description ?? rec.data.body ?? '',
        ...(impl
          ? {
              implementation: {
                type: impl.type,
                ...(impl.application ? { application: impl.application.key } : {}),
                ...(impl.target ? { target: impl.target.key } : {}),
              },
            }
          : {}),
        reasons: r.reasons.map((x) => ({
          code: x.code,
          from: x.from ? (keys.get(x.from.id) ?? x.from.id) : null,
        })),
      };
    });
    return {
      status: 'ok',
      context: {
        contractVersion: data.contractVersion,
        consistency: data.consistency,
        taskRevision: data.task.revision,
        records,
      },
    };
  }

  /**
   * Открытые вопросы владельцу по соглашению Relay: документы `Вопрос: …`
   * типа `proposal` в состоянии `draft`. Только чтение; полный текст — для
   * первых `limit` вопросов, `total` — сколько открытых всего.
   */
  async listOpenQuestions(
    options: { limit: number },
    signal?: AbortSignal,
  ): Promise<{ questions: SourceQuestionRecord[]; total: number }> {
    const op = 'question.list';
    await this.requireCapability(op, DOCUMENT_LIBRARY_CAPABILITY, signal);
    const list = await this.pages(
      op,
      questionSummarySchema,
      '/entities',
      { kind: 'document', documentKind: 'proposal', status: 'draft' },
      signal,
    );
    // Фильтр сервера перепроверяется: открытый вопрос — proposal в draft.
    const open = list.items.filter(
      (d) =>
        QUESTION_TITLE.test(d.title) &&
        (d.document?.kind ?? 'proposal') === 'proposal' &&
        (d.document?.status ?? d.status ?? 'draft') === 'draft',
    );
    const questions: SourceQuestionRecord[] = [];
    for (const d of open.slice(0, options.limit)) {
      const full = await this.call(op, questionDetailSchema, {
        method: 'GET',
        path: '/entities/get',
        query: { ref: d.ref.id, kind: 'document' },
        signal,
      });
      const keyOf = new Map((full.references ?? []).map((r) => [r.ref.id, r.key]));
      questions.push({
        id: full.ref.id,
        key: full.key,
        title: full.data.name,
        revision: full.revision,
        body: full.data.body,
        targets: (full.data.relations ?? [])
          .map((r) => keyOf.get(r.target.id) || r.target.id)
          .filter((x) => x.length > 0),
        ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}),
      });
    }
    return { questions, total: open.length };
  }

  async listComments(ref: string, signal?: AbortSignal): Promise<CommentRecord[]> {
    const op = 'comment.list';
    const r = this.enc(ref);
    const seen = new Map<number, z.output<typeof commentSummarySchema>>();
    let cursor: string | undefined;
    let snapshot: number | undefined;
    for (let page = 0; ; page++) {
      if (page > 10_000) throw this.fail('protocol', op, 'comment pagination does not terminate');
      const data = await this.call(op, commentsPageSchema, {
        method: 'GET',
        path: `/board-tasks/${r}/comments`,
        query: { limit: 100, cursor },
        signal,
      });
      if (snapshot !== undefined && data.snapshot !== snapshot) {
        throw this.fail('protocol', op, 'comment snapshot changed during cursor pagination');
      }
      snapshot = data.snapshot;
      for (const c of data.items) seen.set(c.sequence, c);
      if (data.nextCursor === null) break;
      if (data.nextCursor === cursor || data.items.length === 0) {
        throw this.fail('protocol', op, 'comment cursor does not advance');
      }
      cursor = data.nextCursor;
    }
    const ordered = [...seen.values()].sort((a, b) => a.sequence - b.sequence);
    const out: CommentRecord[] = [];
    for (const c of ordered) {
      const full = await this.call(op, commentSchema, {
        method: 'GET',
        path: `/board-tasks/${r}/comments/${this.enc(c.id)}`,
        signal,
      });
      out.push({
        id: full.id,
        title: full.title,
        body: full.description,
        actor: full.actor,
        createdAt: full.at,
      });
    }
    return out;
  }

  async addComment(ref: string, input: { title: string; body: string }, signal?: AbortSignal) {
    const saved = await this.call('comment.add', commentSavedSchema, {
      method: 'POST',
      path: `/board-tasks/${this.enc(ref)}/comments`,
      body: { title: input.title, description: input.body, actorRole: this.actorRole },
      signal,
    });
    return { commentId: saved.commentId };
  }

  async setCriterion(
    ref: string,
    input: { criterionId: string; completed: boolean; ifRevision: number },
    signal?: AbortSignal,
  ) {
    const saved = await this.call('task.criterion', taskSavedSchema, {
      method: 'POST',
      path: `/board-tasks/${this.enc(ref)}/criteria`,
      body: {
        action: 'complete',
        criterionId: input.criterionId,
        completed: input.completed,
        ifRevision: input.ifRevision,
      },
      signal,
    });
    return { revision: saved.revision };
  }

  async move(ref: string, input: { column: TaskColumn; ifRevision: number }, signal?: AbortSignal) {
    const saved = await this.call('task.move', taskSavedSchema, {
      method: 'POST',
      path: `/board-tasks/${this.enc(ref)}/move`,
      body: { column: input.column, ifRevision: input.ifRevision },
      signal,
    });
    return { revision: saved.revision };
  }

  /* ---------------- История работы ---------------- */

  private session(s: z.output<typeof sessionSchema>): SessionRecord {
    return {
      id: s.id,
      key: s.key,
      status: s.status,
      revision: s.revision,
      currentRunId: s.currentRunId,
      parentSessionId: s.parentSessionId,
      title: s.title,
      description: s.description,
      result: s.result,
    };
  }

  private checkpointRecord(c: z.output<typeof checkpointSchema>): CheckpointRecord {
    return {
      id: c.id,
      key: c.key,
      sessionId: c.sessionId,
      runId: c.runId,
      kind: c.kind,
      intentId: c.intentId,
      title: c.title,
      body: c.body,
    };
  }

  private async historyPost(
    operation: string,
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    await this.requireHistory(operation, signal);
    const m = await this.call(operation, mutationSchema, {
      method: 'POST',
      path: `/work-history${path}`,
      body,
      signal,
    });
    const out: HistoryMutation = { session: this.session(m.session) };
    if (m.run) out.runId = m.run.id;
    if (m.checkpoint) out.checkpoint = this.checkpointRecord(m.checkpoint);
    if (m.childSession) out.childSession = this.session(m.childSession);
    return out;
  }

  startSession(
    input: { title: string; description: string; client: string; sourceSessionId?: string },
    signal?: AbortSignal,
  ) {
    return this.historyPost(
      'history.start',
      '/sessions/start',
      {
        title: input.title,
        description: input.description,
        client: input.client,
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      },
      signal,
    );
  }

  async getSession(ref: string, signal?: AbortSignal): Promise<SessionRecord> {
    await this.requireHistory('history.get', signal);
    const d = await this.call('history.get', sessionDetailSchema, {
      method: 'GET',
      path: `/work-history/sessions/${this.enc(ref)}`,
      signal,
    });
    return this.session(d.session);
  }

  async findSessions(marker: string, signal?: AbortSignal): Promise<SessionRecord[]> {
    const op = 'history.find';
    await this.requireHistory(op, signal);
    if (!marker) throw this.fail('refused', op, 'empty marker');
    const list = await this.pages(
      op,
      sessionOverviewSchema,
      '/work-history/sessions',
      { q: marker },
      signal,
    );
    const out: SessionRecord[] = [];
    for (const s of list.items) {
      const full = await this.getSession(s.id, signal);
      if (full.title.includes(marker) || full.description.includes(marker)) out.push(full);
    }
    return out;
  }

  async checkpoints(sessionRef: string, signal?: AbortSignal): Promise<CheckpointRecord[]> {
    const op = 'history.checkpoints';
    await this.requireHistory(op, signal);
    const page = await this.pages(
      op,
      historyItemSchema,
      `/work-history/sessions/${this.enc(sessionRef)}/history`,
      { kind: 'checkpoint', order: 'asc' },
      signal,
    );
    return page.items.map((i) => {
      if (i.kind !== 'checkpoint' || !i.checkpoint) {
        throw this.fail('protocol', op, `unexpected history item kind ${safe(i.kind, 40)}`);
      }
      return this.checkpointRecord(i.checkpoint);
    });
  }

  private checkpointBody(
    input: CheckpointInput & { runId: string; ifRevision: number },
    accepted: boolean,
  ) {
    return {
      runId: input.runId,
      ifRevision: input.ifRevision,
      title: input.title,
      body: input.body,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.checks !== undefined ? { checks: input.checks } : {}),
      ...(input.references ? { references: input.references } : {}),
      ...(accepted && input.acceptedSessionIds
        ? { acceptedSessionIds: input.acceptedSessionIds }
        : {}),
    };
  }

  openIntent(
    sessionRef: string,
    input: CheckpointInput & { runId: string; ifRevision: number },
    signal?: AbortSignal,
  ) {
    if (input.acceptedSessionIds?.length) {
      return Promise.reject(
        this.fail('refused', 'history.intent', 'intent cannot accept child sessions'),
      );
    }
    return this.historyPost(
      'history.intent',
      '/checkpoints/open',
      { ref: sessionRef, ...this.checkpointBody(input, false) },
      signal,
    );
  }

  checkpoint(
    intentRef: string,
    kind: 'progress' | 'result' | 'cancel',
    input: CheckpointInput & { runId: string; ifRevision: number },
    signal?: AbortSignal,
  ) {
    const route = { progress: 'save', result: 'complete', cancel: 'cancel' }[kind];
    return this.historyPost(
      `history.checkpoint.${kind}`,
      `/checkpoints/${route}`,
      { ref: intentRef, ...this.checkpointBody(input, true) },
      signal,
    );
  }

  fork(
    intentRef: string,
    input: { runId: string; ifRevision: number; title: string; description: string },
    signal?: AbortSignal,
  ) {
    return this.historyPost('history.fork', '/sessions/fork', { ref: intentRef, ...input }, signal);
  }

  attach(
    sessionRef: string,
    input: { ifRevision: number; client: string; sourceSessionId?: string },
    signal?: AbortSignal,
  ) {
    return this.historyPost(
      'history.attach',
      '/sessions/attach',
      {
        ref: sessionRef,
        ifRevision: input.ifRevision,
        client: input.client,
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      },
      signal,
    );
  }

  takeover(
    sessionRef: string,
    input: { ifRevision: number; reason: string; client: string },
    signal?: AbortSignal,
  ) {
    return this.historyPost(
      'history.takeover',
      '/sessions/takeover',
      { ref: sessionRef, ifRevision: input.ifRevision, reason: input.reason, client: input.client },
      signal,
    );
  }

  finishSession(
    sessionRef: string,
    outcome: 'complete' | 'cancel',
    input: { runId?: string; ifRevision: number; result: string },
    signal?: AbortSignal,
  ) {
    return this.historyPost(
      `history.${outcome}`,
      `/sessions/${outcome}`,
      {
        ref: sessionRef,
        ifRevision: input.ifRevision,
        result: input.result,
        ...(input.runId ? { runId: input.runId } : {}),
      },
      signal,
    );
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Создаёт транспорт Relay v1 по проверенным настройкам; неверные — `INVALID_INPUT`. */
export function createTransport(settings: unknown, options: RelayV1Options = {}): RelayV1Transport {
  const parsed = relayV1SettingsSchema.safeParse(settings);
  if (!parsed.success) {
    throw new HarnessError(
      'INVALID_INPUT',
      'relay-v1 settings are invalid',
      parsed.error.issues.map((i) => ({
        path: i.path.filter((p) => typeof p !== 'symbol'),
        message: i.message,
      })),
    );
  }
  return new RelayV1Transport(parsed.data, options);
}
