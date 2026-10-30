import { z } from 'zod';
import { API_VERSION, STATE_VERSION } from './version.ts';
import {
  digestSchema,
  gitShaSchema,
  idSchema,
  isoTimeSchema,
  runtimeNameSchema,
  targetRefSchema,
} from './primitives.ts';
import { errorCodes, type ErrorCode } from './errors.ts';
import { controlStateSchema, controllerLeaseSchema, workStatusSchema } from './execution.ts';
import { runEventSchema } from './events.ts';
import { deliveryStateSchema, resultEnvelopeSchema } from './result.ts';
import { reviewRecordSchema } from './review.ts';
import { sourceRefSchema } from './work.ts';
import { profilePinSchema, resolvedProfileSchema } from './profiles.ts';
import { filePlanEntrySchema, projectManifestSchema } from './project.ts';
import { stopDiagnosisSchema } from './diagnosis.ts';
import { planCheckDataSchema, planRequestDataSchema } from './planning.ts';
import { toolchainReportSchema } from './toolchain.ts';
import { operationCatalogSchema } from './catalog.ts';

/**
 * Договор CLI `harness`.
 *
 * - Каждая команда получает явные пути; бинарник не хранит настроек проекта
 *   и не помнит «последний активный проект».
 * - `--state <каталог>` — каталог состояния исполнения (SQLite, артефакты
 *   попыток). Создаётся только командами, которые пишут (`run`,
 *   `review-*`, `approve`); читающие команды на отсутствующем каталоге
 *   отвечают `NOT_FOUND` и ничего не создают.
 * - stdout — ровно один JSON `CliEnvelope`; диагностика — stderr. Явный
 *   `--human` (init, explain) заменяет успешный ответ текстом; отказ — тот же
 *   JSON на stdout, exit code одинаков в обоих режимах.
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
  /** Аргумент можно повторить; значения — список. */
  multiple?: true;
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

const source: CliArgument = {
  name: '--source',
  value: 'path',
  required: true,
  description: 'Конфигурация коннектора задач (provider relay-v1-http | relay-v2-cli)',
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
    args: [
      state,
      graph,
      policy,
      context,
      author,
      {
        name: '--source',
        value: 'path',
        required: false,
        description:
          'Конфигурация коннектора задач: внешние предпосылки графа допускаются по решению источника (trusts) и доступности SHA в target ref; без неё доверенных receipt нет',
      },
    ],
    refusals: [
      'REVIEW_REJECTED',
      'ATTEMPTS_EXHAUSTED',
      'BUDGET_EXHAUSTED',
      'BUDGET_UNKNOWN',
      'NOT_READY',
    ],
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
      { ...graph, required: false, description: 'WorkGraph JSON; не нужен с --source' },
      policy,
      context,
      {
        name: '--source',
        value: 'path',
        required: false,
        description:
          'Конфигурация коннектора (relay-v1-http | relay-v2-cli): перед запуском задачи перечитываются, semantic digest сверяется с закреплённым снимком и eligibility — до любого вызова runtime; результат доставляется в исходную задачу',
      },
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
  cleanup: {
    description:
      'Довести незавершённую очистку закончившейся попытки: повторить teardown по сохранённым receipt окружений и убрать её рабочие деревья; модели, gates и Git-приёмка не вызываются',
    writes: true,
    idempotency: 'Повтор после успешной очистки отвечает nothing-pending и ничего не меняет',
    args: [
      state,
      { name: '--run', value: 'id', required: true, description: 'ID попытки (runId)' },
    ],
    refusals: ['NOT_FOUND', 'NOT_READY'],
  },
  profile: {
    description:
      'Разрешить профиль стека (встроенный ID или ./file.json репозитория): слои, gates, закрепление; только чтение манифестов, без команд проекта',
    writes: false,
    idempotency: 'Чистая функция файлов профиля',
    args: [
      {
        name: '--profile',
        value: 'text',
        required: true,
        description: 'Встроенный ID профиля или относительный ./file.json',
      },
      {
        name: '--repository',
        value: 'dir',
        required: false,
        description: 'Корень репозитория для локального профиля',
      },
    ],
    refusals: [],
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
  init: {
    description:
      'Подготовить существующий Git npm/pnpm-репозиторий: план или create-only запись .harness/ (политика из профиля и toolchain inspection; manifest до политики, политика последней); чужие файлы не меняются',
    writes: true,
    idempotency:
      'Повтор с теми же решениями ничего не пишет (created пуст); после прерывания дописывает недостающее; иные решения при существующем manifest — PATH_CONFLICT content-differs',
    args: [
      {
        name: '--repository',
        value: 'dir',
        required: true,
        description: 'Корень Git-репозитория проекта',
      },
      {
        name: '--profile',
        value: 'text',
        required: false,
        description:
          'Встроенный профиль или ./file.json репозитория; без него — из manifest, иначе по lockfile (npm-ci | pnpm-frozen)',
      },
      {
        name: '--writer',
        value: 'id',
        required: false,
        description: 'Runtime writer: claude (по умолчанию) или codex; reviewer — другой вендор',
      },
      {
        name: '--state',
        value: 'dir',
        required: false,
        description:
          'Каталог состояния вне репозитория; по умолчанию <state home>/projects/<projectId>',
      },
      { name: '--plan', value: 'flag', required: false, description: 'Только план, без записи' },
      {
        name: '--human',
        value: 'flag',
        required: false,
        description: 'Текст для человека вместо JSON',
      },
    ],
    refusals: ['PATH_CONFLICT', 'CONTROLLER_BUSY', 'NOT_READY'],
  },
  explain: {
    description:
      'Объяснить остановки: код, причина, фаза, кто действует, допустимый следующий шаг и evidence; без повторов, вызовов моделей и изменений состояния',
    writes: false,
    idempotency: 'Только чтение',
    args: [
      state,
      {
        ...policy,
        required: true,
        description: 'ExecutionPolicy JSON: maxAttempts, repairBudget и runtime политики',
      },
      { name: '--work', value: 'id', required: false, description: 'ID поручения' },
      {
        name: '--human',
        value: 'flag',
        required: false,
        description: 'Текст для человека вместо JSON',
      },
    ],
    refusals: ['NOT_FOUND'],
  },
  'plan-request': {
    description:
      'Собрать read-only запрос планирования из постановки и фактов проекта (роли, gates, репозитории, контекст, ресурсы, контракты, требования) для ведущего агента; модель не вызывается, ничего не пишется',
    writes: false,
    idempotency: 'Чистая функция входов: те же постановка и факты дают тот же prompt и basis',
    args: [
      {
        name: '--brief',
        value: 'path',
        required: true,
        description: 'Постановка пользователя, UTF-8',
      },
      policy,
      {
        ...context,
        description:
          'ContextSnapshot JSON; без него — каталоги <каталог политики>/work/context/<id>',
      },
      {
        name: '--contracts',
        value: 'dir',
        required: false,
        description: 'Каталог ContractDocument JSON, на которые может ссылаться план',
      },
      {
        name: '--requirements',
        value: 'path',
        required: false,
        description:
          'Закоммиченный файл с разделами ## REQ-*: [<repositoryId>:]<путь от корня репозитория>; можно повторять',
        multiple: true,
      },
      {
        name: '--human',
        value: 'flag',
        required: false,
        description: 'Только текст prompt вместо JSON',
      },
    ],
    refusals: ['NOT_READY'],
  },
  'plan-check': {
    description:
      'Проверить draft плана против фактов проекта и собрать WorkGraph без вызова моделей, ревью и записи; согласования не выдаёт',
    writes: false,
    idempotency: 'Чистая функция входов и HEAD источников требований',
    args: [
      {
        name: '--draft',
        value: 'path',
        required: true,
        description:
          'Draft JSON (schemas/plan-draft.schema.json); ID графа — имя файла без .draft.json/.json',
      },
      policy,
      context,
      { name: '--contracts', value: 'dir', required: false, description: 'Как у plan-request' },
      {
        name: '--brief',
        value: 'path',
        required: false,
        description: 'Постановка: revision графа = basis',
      },
      {
        name: '--basis',
        value: 'digest',
        required: false,
        description:
          'basis из plan-request, по которому составлен draft; расхождение — APPROVAL_STALE',
      },
    ],
    refusals: ['APPROVAL_STALE', 'NOT_READY'],
  },
  capabilities: {
    description:
      'Каталог общих операций harness для агента: имя, версия, protocolVersion, пределы UTF-8 байт и для каждой операции описание, readOnly, JSON Schema входа и данных ответа; только чтение',
    writes: false,
    idempotency: 'Чистая функция установленной версии пакета',
    args: [],
    refusals: [],
  },
  'source-check': {
    description:
      'Коннектор задач: подключение, идентичность и capabilities backend, совпадение проекта, проверка mapping; без мутаций, записи истории и создания состояния',
    writes: false,
    idempotency: 'Только чтение получателя',
    args: [
      source,
      { ...state, required: false },
      {
        ...policy,
        required: false,
        description: 'ExecutionPolicy JSON для сверки gates/ролей mapping',
      },
    ],
    refusals: ['NOT_READY'],
  },
  'source-snapshot': {
    description:
      'Коннектор задач: согласованное чтение задач, предпросмотр и закрепление снимка (graph/context/manifest) для review-plan и approve',
    writes: true,
    idempotency:
      'Неизменная постановка — тот же semantic digest, тот же граф и контекст; новых записей у получателя нет',
    args: [
      source,
      state,
      {
        ...policy,
        required: false,
        description: 'ExecutionPolicy JSON: её секреты маскируются в диагностике',
      },
      {
        name: '--out',
        value: 'dir',
        required: false,
        description: 'Каталог graph.json, context.json, manifest.json',
      },
    ],
    refusals: ['NOT_READY'],
  },
  'source-status': {
    description:
      'Коннектор задач: локально принято / доставлено / конфликт / неизвестный исход и независимое чтение получателя',
    writes: false,
    idempotency: 'Только чтение',
    args: [source, state],
    refusals: ['NOT_FOUND'],
  },
  'source-deliver': {
    description:
      'Коннектор задач: доставить или продолжить доставку принятых результатов с тем же ключом операции; модели, gates и Git не вызываются',
    writes: true,
    idempotency:
      'Подтверждённая доставка не повторяется; неизвестный исход не отправляется повторно до source-reconcile',
    args: [
      source,
      state,
      { ...work, required: false, description: 'ID поручения; без него — все с результатом' },
    ],
    refusals: ['NOT_FOUND', 'CONTROLLER_BUSY', 'REVISION_CONFLICT'],
  },
  'source-reconcile': {
    description:
      'Коннектор задач: разобрать неизвестный исход или конфликт операции доставки по фактам получателя; неоднозначность — только явным решением',
    writes: true,
    idempotency: 'Разобранная операция не меняется; мутаций без решения и фактов нет',
    args: [
      source,
      state,
      {
        name: '--operation',
        value: 'digest',
        required: true,
        description: 'Ключ операции из source-status',
      },
      {
        name: '--decision',
        value: 'text',
        required: false,
        description:
          'resend (записи у получателя нет), adopt:<id> (одна из нескольких записей с маркером), recheck (CAS-конфликт без изменения постановки)',
      },
    ],
    refusals: ['NOT_FOUND', 'CONTROLLER_BUSY'],
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

/** Зависимости, принятые человеком по базовой линии: решение, а не доказательство. */
const baselineViewSchema = z.strictObject({
  sha: gitShaSchema,
  reason: z.string(),
  tasks: z.array(z.string()),
});

export const runDataSchema = z.strictObject({
  graphId: idSchema,
  digest: digestSchema,
  /** Граф уже был зарегистрирован этой редакцией: работа продолжена. */
  resumed: z.boolean(),
  baseline: baselineViewSchema.optional(),
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
      engineVersions: z
        .strictObject({ controller: z.string().optional(), attempts: z.array(z.string()) })
        .optional(),
    })
    .optional(),
  /**
   * Корень рабочих деревьев попыток: вне дерева (`cache`, `configured`) или
   * прежнее место (`in-place`, `cross-volume` — кэш на другом томе).
   */
  checkouts: z
    .strictObject({
      placement: z.enum(['configured', 'in-place', 'cache', 'cross-volume']),
      root: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
  /** Диагностика toolchain репозиториев политики; есть, когда задана политика. */
  toolchains: z.array(toolchainReportSchema).optional(),
  problems: z.array(z.string()),
});

export const profileDataSchema = z.strictObject({
  pin: profilePinSchema,
  profile: resolvedProfileSchema,
});

export const versionDataSchema = z.strictObject({
  harness: z.string(),
  apiVersion: z.literal(API_VERSION),
});

const providerSchema = z.enum(['relay-v1-http', 'relay-v2-cli']);
const ownershipSchema = z.strictObject({
  stateDir: z.string(),
  store: z.string(),
  note: z.string(),
});

export const sourceCheckDataSchema = z.strictObject({
  provider: providerSchema,
  projectId: z.string(),
  connector: idSchema,
  connected: z.boolean(),
  projectMatches: z.boolean(),
  identity: z
    .strictObject({ capabilities: z.array(z.string()), build: z.record(z.string(), z.string()) })
    .optional(),
  history: z.strictObject({ enabled: z.boolean(), capability: z.boolean() }),
  mapping: z.array(
    z.strictObject({ ref: z.string(), key: z.string().optional(), problems: z.array(z.string()) }),
  ),
  ownership: ownershipSchema,
  problems: z.array(z.string()),
});

export const sourceSnapshotDataSchema = z.strictObject({
  connector: idSchema,
  graphId: idSchema,
  graphDigest: digestSchema,
  contextDigest: digestSchema,
  /** Semantic digest набора задач (`graph.source.revision`); не Git SHA. */
  revision: digestSchema,
  created: z.boolean(),
  eligible: z.boolean(),
  problems: z.array(z.string()),
  truncated: z.array(z.string()),
  baseline: baselineViewSchema.optional(),
  tasks: z.array(
    z.strictObject({
      identity: z.string(),
      key: z.string(),
      orderId: idSchema,
      semanticDigest: digestSchema,
      casRevision: z.number().int(),
      column: z.string(),
    }),
  ),
  files: z.strictObject({ graph: z.string(), context: z.string(), manifest: z.string() }),
});

const operationViewSchema = z.strictObject({
  key: digestSchema,
  runId: z.string(),
  outcome: z.string(),
  status: z.enum(['intent', 'in-progress', 'delivered', 'conflict', 'uncertain', 'failed']),
  reason: z.string().optional(),
  currentRevision: z.string().optional(),
  steps: z.array(
    z.strictObject({
      n: z.number().int(),
      kind: z.string(),
      status: z.string(),
      marker: z.string(),
    }),
  ),
  lease: z.strictObject({ owner: z.string(), expiresAt: isoTimeSchema }).optional(),
});

export const sourceStatusDataSchema = z.strictObject({
  connector: idSchema,
  provider: providerSchema,
  projectId: z.string(),
  snapshot: z
    .strictObject({
      revision: digestSchema,
      graphId: idSchema,
      baseline: baselineViewSchema.optional(),
    })
    .optional(),
  ownership: ownershipSchema,
  tasks: z.array(
    z.strictObject({
      index: z.number().int(),
      ref: z.string(),
      key: z.string().optional(),
      identity: z.string().optional(),
      workId: idSchema,
      local: z.strictObject({
        status: z.string(),
        attempt: z.number().int().optional(),
        resultSha: gitShaSchema.optional(),
      }),
      deliveries: z.array(
        z.strictObject({ status: z.string(), key: z.string(), operation: z.string().optional() }),
      ),
      operations: z.array(operationViewSchema),
      remote: z.union([
        z.strictObject({
          reachable: z.literal(true),
          column: z.string(),
          casRevision: z.number().int(),
          semanticDigest: digestSchema,
          matchesSnapshot: z.boolean(),
          criteria: z.array(
            z.strictObject({ id: z.string(), title: z.string(), completed: z.boolean() }),
          ),
          markers: z.record(z.string(), z.number().int()),
        }),
        z.strictObject({ reachable: z.literal(false), error: z.string() }),
      ]),
    }),
  ),
});

export const sourceDeliverDataSchema = z.strictObject({
  connector: idSchema,
  deliveries: z.array(
    z.strictObject({
      workId: idSchema,
      outcome: z.string(),
      delivery: z.array(deliveryStateSchema),
    }),
  ),
});

export const sourceReconcileDataSchema = z.strictObject({
  operation: digestSchema,
  workId: idSchema,
  before: z.string(),
  after: z.string(),
  resolved: z.boolean(),
  facts: z.array(z.string()),
  delivery: z.array(deliveryStateSchema).optional(),
});

export const cleanupDataSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('nothing-pending') }),
  /** Очищено: receipts окружений, по которым повторён teardown. */
  z.strictObject({ status: z.literal('cleaned'), receipts: z.array(z.string()) }),
]);

/** `init`: план или результат подготовки проекта. */
export const initDataSchema = z.strictObject({
  mode: z.enum(['plan', 'apply']),
  /** Состояние до вызова. */
  status: z.enum(['new', 'partial', 'complete']),
  projectId: z.string(),
  root: z.string(),
  manifestPath: z.string(),
  manifest: projectManifestSchema,
  files: z.array(filePlanEntrySchema),
  conflicts: z.number().int().min(0),
  created: z.array(z.string()),
  preserved: z.array(z.string()),
  profile: profilePinSchema,
  shadowed: z.array(z.string()),
  facts: z.strictObject({
    repositoryId: idSchema,
    targetRef: targetRefSchema,
    roles: z.array(
      z.strictObject({
        id: z.string(),
        runtime: z.enum(['claude', 'codex']),
        writePaths: z.array(z.string()).optional(),
      }),
    ),
    gates: z.array(z.strictObject({ id: idSchema, kind: z.enum(['check', 'test']) })),
    workDir: z.string(),
    contextDir: z.string(),
    notesDir: z.string(),
  }),
  toolchain: z.strictObject({ ready: z.boolean(), problems: z.array(z.string()) }),
  next: z.array(
    z.strictObject({ command: z.string(), args: z.array(z.string()), why: z.string() }),
  ),
});

/** `explain`: объяснения остановок. */
export const explainDataSchema = z.strictObject({ diagnoses: z.array(stopDiagnosisSchema) });

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
  cleanup: cleanupDataSchema,
  profile: profileDataSchema,
  doctor: doctorDataSchema,
  init: initDataSchema,
  explain: explainDataSchema,
  'plan-request': planRequestDataSchema,
  'plan-check': planCheckDataSchema,
  capabilities: operationCatalogSchema,
  'source-check': sourceCheckDataSchema,
  'source-snapshot': sourceSnapshotDataSchema,
  'source-status': sourceStatusDataSchema,
  'source-deliver': sourceDeliverDataSchema,
  'source-reconcile': sourceReconcileDataSchema,
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
