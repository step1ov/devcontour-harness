import { z } from 'zod';
import { API_VERSION, STATE_VERSION } from './version.ts';
import {
  digestSchema,
  gitShaSchema,
  idSchema,
  isoTimeSchema,
  runtimeNameSchema,
} from './primitives.ts';
import { errorCodes, type ErrorCode } from './errors.ts';
import { controlStateSchema, controllerLeaseSchema, workStatusSchema } from './execution.ts';
import { runEventSchema } from './events.ts';
import { resultEnvelopeSchema } from './result.ts';
import { reviewRecordSchema } from './review.ts';
import { sourceRefSchema } from './work.ts';

/**
 * Договор CLI `harness`.
 *
 * - Каждая команда получает явные пути; бинарник не хранит настроек проекта
 *   и не помнит «последний активный проект».
 * - `--state <каталог>` — каталог состояния исполнения (SQLite, артефакты
 *   попыток). Создаётся только командами, которые пишут (`run`,
 *   `review-*`, `approve`); читающие команды на отсутствующем каталоге
 *   отвечают `NOT_FOUND` и ничего не создают.
 * - stdout — ровно один JSON `CliEnvelope`; диагностика — stderr.
 * - Exit: 0 — успех; 2 — неверный вход; 3 — отказ или блокировка по
 *   правилам; 4 — инфраструктура. Exit 1 не используется.
 *
 * Библиотека и CLI вызывают одни и те же доменные операции; у CLI нет
 * операции «передать PASS» или «принять без проверок».
 */
export interface CliArgument {
  name: string;
  value: 'path' | 'dir' | 'id' | 'digest' | 'number' | 'text' | 'flag' | 'sink';
  required: boolean;
  description: string;
}
export interface CliCommandContract {
  description: string;
  /** Пишет ли команда состояние. `false` — гарантированно без побочных эффектов. */
  writes: boolean;
  /** Что делает повтор той же команды с теми же аргументами. */
  idempotency: string;
  args: CliArgument[];
  /** Отказы по существу (exit 3), которые команда обязана различать кодом. */
  refusals: ErrorCode[];
}

const state: CliArgument = {
  name: '--state',
  value: 'dir',
  required: true,
  description: 'Каталог состояния исполнения',
};
const graph: CliArgument = {
  name: '--graph',
  value: 'path',
  required: true,
  description: 'WorkGraph JSON',
};
const policy: CliArgument = {
  name: '--policy',
  value: 'path',
  required: true,
  description: 'ExecutionPolicy JSON',
};
const context: CliArgument = {
  name: '--context',
  value: 'path',
  required: false,
  description: 'ContextSnapshot JSON; без него — файловый ContextSource каталога графа',
};
const author: CliArgument = {
  name: '--author',
  value: 'id',
  required: true,
  description:
    'Автор предложения: codex, claude, fixture или external (человек/инструмент вне harness); по нему применяется правило вендора',
};
const work: CliArgument = {
  name: '--work',
  value: 'id',
  required: true,
  description: 'ID поручения',
};

export const cliCommands = {
  validate: {
    description:
      'Проверить граф, политику, их связь и (если задан) снимок контекста без вызова моделей и записи состояния',
    writes: false,
    idempotency: 'Чистая функция входов',
    args: [graph, policy, context],
    refusals: [],
  },
  'review-plan': {
    description:
      'Техническое ревью плана (графа) с конкретным digest; новый раунд сохраняет историю находок предмета',
    writes: true,
    idempotency:
      'Повтор с тем же digest и тем же автором, уже согласованный последним раундом, возвращает этот раунд без вызова модели; иначе — новый раунд в пределах maxAttempts. Автор, не допускаемый правилом вендора, — REVIEWER_SAME_VENDOR до вызова модели',
    args: [state, graph, policy, context, author],
    refusals: ['REVIEW_REJECTED', 'ATTEMPTS_EXHAUSTED', 'BUDGET_EXHAUSTED', 'BUDGET_UNKNOWN'],
  },
  'review-contract': {
    description: 'Техническое ревью контракта с конкретным digest',
    writes: true,
    idempotency: 'Как review-plan, предмет — ID контракта',
    args: [
      state,
      { name: '--contract', value: 'path', required: true, description: 'ContractDocument JSON' },
      policy,
      author,
    ],
    refusals: ['REVIEW_REJECTED', 'ATTEMPTS_EXHAUSTED', 'BUDGET_EXHAUSTED', 'BUDGET_UNKNOWN'],
  },
  approve: {
    description:
      'Согласование оператором (approvalMode: operator) конкретного digest графа или контракта, уже прошедшего ревью',
    writes: true,
    idempotency: 'Повтор для того же digest ничего не меняет',
    args: [
      state,
      {
        name: '--digest',
        value: 'digest',
        required: true,
        description: 'Digest из ReviewRecord последнего раунда',
      },
      { name: '--subject', value: 'id', required: true, description: 'ID графа или контракта' },
    ],
    refusals: ['APPROVAL_STALE', 'APPROVAL_REQUIRED', 'REVIEW_REJECTED'],
  },
  run: {
    description:
      'Зарегистрировать согласованный граф (идемпотентно по connector, ref, revision, digest) и вести работу до простоя',
    writes: true,
    idempotency:
      'Тот же граф той же редакции продолжает прежнюю работу; другой digest для той же редакции источника — REVISION_CONFLICT',
    args: [
      state,
      graph,
      policy,
      context,
      {
        name: '--sink',
        value: 'sink',
        required: false,
        description: 'Получатель результата, `file:<каталог>`',
      },
      {
        name: '--once',
        value: 'flag',
        required: false,
        description: 'Один шаг очереди вместо работы до простоя',
      },
      {
        name: '--author',
        value: 'id',
        required: false,
        description: 'Автор графа для ревью плана; по умолчанию external',
      },
    ],
    refusals: [
      'APPROVAL_REQUIRED',
      'APPROVAL_STALE',
      'PAUSED',
      'CONTROLLER_BUSY',
      'REVISION_CONFLICT',
      'GATE_FAILED',
      'REVIEW_REJECTED',
      'SCOPE_VIOLATION',
      'BUDGET_EXHAUSTED',
      'BUDGET_UNKNOWN',
      'ATTEMPTS_EXHAUSTED',
    ],
  },
  status: {
    description: 'Состояние очереди, графов и поручений с причинами блокировки',
    writes: false,
    idempotency: 'Только чтение',
    args: [
      state,
      { name: '--graph', value: 'id', required: false, description: 'Только этот граф' },
    ],
    refusals: ['NOT_FOUND'],
  },
  events: {
    description: 'События строго после номера, по возрастанию',
    writes: false,
    idempotency: 'Только чтение',
    args: [
      state,
      { name: '--after', value: 'number', required: false, description: 'Номер, по умолчанию 0' },
      { name: '--limit', value: 'number', required: false, description: '1–500, по умолчанию 100' },
    ],
    refusals: ['NOT_FOUND'],
  },
  pause: {
    description: 'Пауза оператора: новые claims запрещены, активные попытки продолжаются',
    writes: true,
    idempotency: 'Повтор ничего не меняет',
    args: [state],
    refusals: ['NOT_FOUND'],
  },
  resume: {
    description:
      'Снять паузу — решение человека: паузу оператора, штатной остановки и отказа runtime (с её классами отказов); паузу операции reconfigure не снимает',
    writes: true,
    idempotency: 'Повтор без паузы ничего не меняет',
    args: [state],
    refusals: ['NOT_FOUND', 'PAUSED'],
  },
  cancel: {
    description:
      'Отменить поручение: активная попытка теряет владение, поручение становится cancelled; это не retry',
    writes: true,
    idempotency: 'Повтор для отменённого ничего не меняет',
    args: [
      state,
      work,
      { name: '--reason', value: 'text', required: false, description: 'Причина' },
    ],
    refusals: ['NOT_FOUND'],
  },
  retry: {
    description:
      'Новая попытка неуспешного (failed) поручения в пределах maxAttempts и бюджета; --reset сбрасывает счётчик попыток с причиной, учёт расходов не сбрасывается',
    writes: true,
    idempotency: 'Повтор для уже готового к выдаче поручения ничего не меняет',
    args: [
      state,
      work,
      {
        name: '--reset',
        value: 'flag',
        required: false,
        description: 'Сбросить счётчик попыток; требует --reason',
      },
      { name: '--reason', value: 'text', required: false, description: 'Причина сброса' },
    ],
    refusals: ['NOT_FOUND', 'ATTEMPTS_EXHAUSTED', 'BUDGET_EXHAUSTED', 'BUDGET_UNKNOWN'],
  },
  result: {
    description: 'Машинный результат последней завершённой попытки поручения и состояние доставки',
    writes: false,
    idempotency: 'Только чтение',
    args: [state, work],
    refusals: ['NOT_FOUND'],
  },
  deliver: {
    description:
      'Повторить доставку результата получателю с тем же ключом; модели, gates и интеграция не вызываются',
    writes: true,
    idempotency: 'Доставленный результат повторно не доставляется',
    args: [
      state,
      work,
      {
        name: '--sink',
        value: 'sink',
        required: true,
        description: 'Получатель, `file:<каталог>`',
      },
    ],
    refusals: ['NOT_FOUND', 'REVISION_CONFLICT'],
  },
  doctor: {
    description:
      'Версии, наличие runtime и их capabilities, OS-sandbox, совместимость каталога состояния; без live-вызова модели',
    writes: false,
    idempotency: 'Только чтение',
    args: [
      { ...state, required: false },
      { ...policy, required: false },
    ],
    refusals: [],
  },
} as const satisfies Record<string, CliCommandContract>;
export type CliCommand = keyof typeof cliCommands;

/* ------------------------------------------------------------------ */
/* Данные ответов                                                      */
/* ------------------------------------------------------------------ */

const blocker = z.strictObject({
  code: z.enum(Object.keys(errorCodes) as [ErrorCode, ...ErrorCode[]]),
  message: z.string().max(4000),
});

export const validateDataSchema = z.strictObject({
  graphId: idSchema,
  graphDigest: digestSchema,
  policyDigest: digestSchema,
  contextDigest: digestSchema.optional(),
  orders: z.number().int().positive(),
});

export const statusDataSchema = z.strictObject({
  stateVersion: z.literal(STATE_VERSION),
  control: controlStateSchema,
  controller: controllerLeaseSchema.optional(),
  graphs: z.array(
    z.strictObject({
      id: idSchema,
      digest: digestSchema,
      source: sourceRefSchema,
      approved: z.boolean(),
    }),
  ),
  works: z.array(
    z.strictObject({
      id: idSchema,
      graphId: idSchema,
      status: workStatusSchema,
      attempt: z.number().int().min(0),
      activeRunId: z.string().optional(),
      resultSha: gitShaSchema.optional(),
      /** Почему поручение сейчас не выдаётся; пусто — может быть выдано. */
      blockers: z.array(blocker),
    }),
  ),
  /**
   * Бюджеты по сохранённым записям вызовов: общий, групп с незавершённой
   * работой и незавершённых поручений. Нет поля — бюджеты не заданы.
   * `remainingUsd`/`remainingMs` — `null`, когда расход не известен полностью.
   */
  budgets: z
    .strictObject({
      onUnknown: z.enum(['stop', 'continue']),
      budgets: z.array(
        z.strictObject({
          scope: z.strictObject({
            kind: z.enum(['work', 'group', 'total']),
            id: z.string().max(200).optional(),
          }),
          state: z.enum(['within', 'exceeded', 'undetermined']),
          limit: z.strictObject({
            usd: z.number().positive().optional(),
            timeMs: z.number().int().positive().optional(),
          }),
          reportedUsd: z.number().min(0),
          estimatedUsd: z.number().min(0),
          unknownCalls: z.number().int().min(0),
          unfinishedCalls: z.number().int().min(0),
          abandonedCalls: z.number().int().min(0),
          errorCalls: z.number().int().min(0),
          uncoveredRuns: z.number().int().min(0),
          durationMs: z.number().min(0),
          remainingUsd: z.number().min(0).nullable(),
          remainingMs: z.number().min(0).nullable(),
          reason: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

export const eventsDataSchema = z.strictObject({
  events: z.array(runEventSchema),
  /** Номер для следующего `--after`. */
  next: z.number().int().min(0),
});

export const runDataSchema = z.strictObject({
  graphId: idSchema,
  digest: digestSchema,
  /** Граф уже был зарегистрирован этой редакцией: работа продолжена. */
  resumed: z.boolean(),
  works: z.array(
    z.strictObject({
      id: idSchema,
      status: workStatusSchema,
      runId: z.string().optional(),
      resultSha: gitShaSchema.optional(),
      blockers: z.array(blocker),
    }),
  ),
  /**
   * Задание технической очереди графа (режим agent): сохранённая стадия,
   * статус, использованные восстановления и причина остановки.
   */
  workflow: z
    .strictObject({
      key: digestSchema,
      kind: idSchema,
      id: idSchema,
      stage: z.number().int().min(0),
      status: z.enum(['queued', 'running', 'failed', 'stale', 'completed']),
      attempts: z.number().int().min(0),
      repairs: z.number().int().min(0),
      repairBudget: z.number().int().min(0),
      error: z.string().optional(),
      history: z.array(
        z.strictObject({ at: isoTimeSchema, stage: z.number().int().min(0), event: z.string() }),
      ),
    })
    .optional(),
});

export const controlDataSchema = z.strictObject({
  control: controlStateSchema,
  changed: z.boolean(),
});

export const workActionDataSchema = z.strictObject({
  workId: idSchema,
  status: workStatusSchema,
  attempt: z.number().int().min(0),
  changed: z.boolean(),
});

export const approveDataSchema = z.strictObject({
  subject: idSchema,
  digest: digestSchema,
  at: isoTimeSchema,
  changed: z.boolean(),
});

export const doctorDataSchema = z.strictObject({
  harness: z.string(),
  apiVersion: z.literal(API_VERSION),
  node: z.string(),
  platform: z.string(),
  runtimes: z.array(
    z.strictObject({
      runtime: runtimeNameSchema,
      available: z.boolean(),
      version: z.string().optional(),
      structuredOutput: z.boolean(),
      cancellation: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
  sandbox: z.strictObject({ os: z.boolean(), reason: z.string().optional() }),
  state: z
    .strictObject({
      stateVersion: z.number().int(),
      compatible: z.boolean(),
      writer: z.string().optional(),
    })
    .optional(),
  problems: z.array(z.string()),
});

export const versionDataSchema = z.strictObject({
  harness: z.string(),
  apiVersion: z.literal(API_VERSION),
});

/** Схема `data` каждой команды. */
export const cliDataSchemas = {
  validate: validateDataSchema,
  'review-plan': reviewRecordSchema,
  'review-contract': reviewRecordSchema,
  approve: approveDataSchema,
  run: runDataSchema,
  status: statusDataSchema,
  events: eventsDataSchema,
  pause: controlDataSchema,
  resume: controlDataSchema,
  cancel: workActionDataSchema,
  retry: workActionDataSchema,
  result: resultEnvelopeSchema,
  deliver: resultEnvelopeSchema,
  doctor: doctorDataSchema,
  version: versionDataSchema,
} as const satisfies Record<CliCommand | 'version', z.ZodType>;

export const cliErrorSchema = z.strictObject({
  code: z.enum(Object.keys(errorCodes) as [ErrorCode, ...ErrorCode[]]),
  class: z.enum(['input', 'refused', 'infrastructure']),
  message: z.string(),
  issues: z.array(
    z.strictObject({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }),
  ),
});

export type CliEnvelope<C extends CliCommand | 'version' = CliCommand | 'version'> =
  | {
      apiVersion: typeof API_VERSION;
      command: C;
      ok: true;
      data: z.infer<(typeof cliDataSchemas)[C]>;
    }
  | {
      apiVersion: typeof API_VERSION;
      command: C | null;
      ok: false;
      error: z.infer<typeof cliErrorSchema>;
    };

/** Входной документ контракта для `review-contract` — см. `checks.ts`. */
export { contractDocumentSchema, type ContractDocument } from './checks.ts';
