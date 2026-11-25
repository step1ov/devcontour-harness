import { z } from 'zod';
import { workProposalSchema } from './proposals.ts';
import { API_VERSION, STATE_VERSION } from './version.ts';
import {
  digestSchema,
  gitShaSchema,
  idSchema,
  isoTimeSchema,
  runtimeNameSchema,
  targetRefSchema,
} from './primitives.ts';
import { HarnessError, errorCodes, type ErrorCode } from './errors.ts';
import {
  controlStateSchema,
  controllerLeaseSchema,
  leadDiagnosisSchema,
  failureKindSchema,
  pauseReasons,
  workStatusSchema,
  activitySchema,
  livenessStateSchema,
  stallActionSchema,
  gateFailureSummarySchema,
} from './execution.ts';
import { environmentCauseSchema, readRunEventSchema } from './events.ts';
import { deliveryStateSchema, resultEnvelopeSchema } from './result.ts';
import {
  reviewAcceptDataSchema,
  reviewRecordSchema,
  reviewSubjectSummarySchema,
} from './review.ts';
import { codeReviewRecordSchema } from './code-review.ts';
import { acceptedTargetSchema } from './target.ts';
import { workVerificationSchema } from './verification-view.ts';
import { viewDataSchema } from './operator-view.ts';
import { decisionSettingsSchema } from './decisions.ts';
import { updateDataSchema, updateCheckStates } from './update.ts';
import { sourceRefSchema } from './work.ts';
import { setupProgressSchema } from './setup-progress.ts';
import { leadDataSchema } from './lead.ts';
import { outlineDataSchema } from './outline.ts';
import { profilePinSchema, resolvedProfileSchema } from './profiles.ts';
import {
  filePlanEntrySchema,
  initWarningCodes,
  projectManifestSchema,
  projectReviewModes,
} from './project.ts';
import {
  diagnosisActions,
  diagnosisActors,
  diagnosisCauses,
  stopDiagnosisSchema,
} from './diagnosis.ts';
import { planCheckDataSchema, planRequestDataSchema } from './planning.ts';
import { toolchainFactsSchema, toolchainReportSchema } from './toolchain.ts';
import { operationCatalogSchema } from './catalog.ts';
import { previewListDataSchema, previewStartDataSchema, previewStopDataSchema } from './preview.ts';
import { failureBuckets, reportDataSchema } from './report.ts';
import { handoffPackSchema } from './handoff.ts';
import {
  inputAnswerSchema,
  inputLifecycles,
  inputRequestSchema,
  inputStateNames,
  inputTargetSchema,
  leadAnswerBases,
} from './input.ts';

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
  /** `duration` — целое число с единицей `s`, `m` или `h` (`90s`, `30m`, `2h`); голое число — отказ. */
  value: 'path' | 'dir' | 'id' | 'digest' | 'number' | 'duration' | 'text' | 'flag' | 'sink';
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
/**
 * `--state` команд, которым его может заменить `--repository` (0.1.0-alpha.65):
 * одно из двух обязательно, поэтому в договоре — необязательный.
 */
const stateOrRepository: CliArgument = {
  ...state,
  required: false,
  description: 'Каталог состояния исполнения; без него — --repository',
};
/** Корень проекта: состояние и политика — из `.harness/project.json` при каждом вызове. */
const projectRepository = (what: string): CliArgument => ({
  name: '--repository',
  value: 'dir',
  required: false,
  description: `Корень Git-репозитория проекта с .harness/project.json вместо --state: состояние и политика читаются из manifest при каждом вызове (0.1.0-alpha.65); ${what}`,
});
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

const inputRequestArg: CliArgument = {
  name: '--request',
  value: 'id',
  required: true,
  description: 'ID запроса исполнителя (IR-…)',
};
const requestVersionArg: CliArgument = {
  name: '--request-version',
  value: 'number',
  required: true,
  description: 'Версия запроса, которую видел вызывающий (CAS)',
};
const contextDigestArg: CliArgument = {
  name: '--context-digest',
  value: 'digest',
  required: true,
  description: 'Digest снимка контекста с ответом (input-context), прошедшего review-plan',
};

/**
 * Решения по находкам плана и контракта (docs/review-protocol.md, §8):
 * применяются раундом, который запускает команда.
 */
const reviewDecisionArgs: CliArgument[] = [
  {
    name: '--accept-limitation',
    value: 'id',
    required: false,
    multiple: true,
    description:
      'ID открытой находки (или список через запятую), принятой известным ограничением; требует --reason. Следующий раунд видит решение, reviewer не поднимает находку без новых доказательств',
  },
  {
    name: '--continue-review',
    value: 'id',
    required: false,
    multiple: true,
    description:
      'ID эскалированной находки (открыта 3+ раундов подряд), по которой оператор разрешает ещё раунды; требует --reason и --actor operator',
  },
  {
    name: '--reason',
    value: 'text',
    required: false,
    description: 'Основание решения по находкам (не короче трёх знаков)',
  },
  {
    name: '--actor',
    value: 'text',
    required: false,
    description:
      'Кто решает: lead (по умолчанию) или operator; эскалированные находки решает только operator',
  },
];

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
      ...reviewDecisionArgs,
    ],
    refusals: [
      'REVIEW_REJECTED',
      'ATTEMPTS_EXHAUSTED',
      'BUDGET_EXHAUSTED',
      'BUDGET_UNKNOWN',
      'NOT_READY',
      'INPUT_REQUIRED',
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
      ...reviewDecisionArgs,
    ],
    refusals: [
      'REVIEW_REJECTED',
      'ATTEMPTS_EXHAUSTED',
      'BUDGET_EXHAUSTED',
      'BUDGET_UNKNOWN',
      'INPUT_REQUIRED',
    ],
  },
  'review-accept': {
    description:
      'Принять открытые находки ревью кода поручения (candidate/integration) известным ограничением с основанием и решающим; следующий раунд видит решение, reviewer не поднимает находку без новых доказательств; не одобрение и не повтор — повтор отдельно (retry); reviewer без протокола переходов может поднять ту же проблему под новым ID — тогда решение не держится; модель не вызывается',
    writes: true,
    idempotency: 'Повтор для уже принятой находки ничего не меняет (changed: false)',
    args: [
      state,
      work,
      {
        name: '--accept-limitation',
        value: 'id',
        required: true,
        multiple: true,
        description:
          'ID открытой находки ревью кода поручения (из result: findings[].id) или список через запятую',
      },
      {
        name: '--reason',
        value: 'text',
        required: true,
        description: 'Основание решения (не короче трёх знаков)',
      },
      {
        name: '--actor',
        value: 'text',
        required: false,
        description: 'Кто решает: lead (по умолчанию) или operator',
      },
    ],
    refusals: ['NOT_FOUND', 'NOT_READY', 'INVALID_INPUT'],
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
    refusals: ['APPROVAL_STALE', 'APPROVAL_REQUIRED', 'REVIEW_REJECTED', 'INPUT_REQUIRED'],
  },
  reapprove: {
    description:
      'Повторное согласование графа после правки политики: тот же digest графа и последний раунд review-plan, согласование привязывается к новой политике с записью, кто и почему (approval.reapproval, событие graph.approved). Правку изоляции, сети, профилей инструментов и их выбора, окружения, protectedPaths, шагов на хосте (lifecycle, prepare, dependencyBuild, preflight), mode и approvalMode прежний раунд не покрывает; держится только на одобренном последнем раунде: отказ APPROVAL_REQUIRED — нужен новый review-plan. Как review-plan, привязывает --policy к каталогу состояния и при отказе. Внутренности библиотеки (Engine.approve) вместо этой команды не вызывать',
    writes: true,
    idempotency: 'Граф уже согласован под текущей политикой — ничего не меняет (changed: false)',
    args: [
      state,
      {
        name: '--policy',
        value: 'path',
        required: true,
        description: 'Изменённая политика; привязывается к каталогу состояния, как в review-plan',
      },
      { name: '--subject', value: 'id', required: true, description: 'ID графа' },
      {
        name: '--digest',
        value: 'digest',
        required: true,
        description: 'Digest графа из ReviewRecord последнего раунда',
      },
      {
        name: '--by',
        value: 'text',
        required: true,
        description: 'Кто согласует заново (ведущий, оператор): записывается в согласование',
      },
      {
        name: '--reason',
        value: 'text',
        required: true,
        description: 'Почему: какая правка политики и почему прежнее ревью её покрывает',
      },
    ],
    refusals: [
      'APPROVAL_STALE',
      'APPROVAL_REQUIRED',
      'REVIEW_REJECTED',
      'INPUT_REQUIRED',
      'NOT_FOUND',
    ],
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
      'CONTEXT_EXHAUSTED',
      'INPUT_REQUIRED',
    ],
  },
  status: {
    description: 'Состояние очереди, графов и поручений с причинами блокировки',
    writes: false,
    idempotency: 'Только чтение',
    args: [
      stateOrRepository,
      projectRepository(
        'до настройки (нет manifest или базы состояния) — пустой статус с полем setup, а не NOT_FOUND',
      ),
      { name: '--graph', value: 'id', required: false, description: 'Только этот граф' },
      {
        name: '--detail',
        value: 'flag',
        required: false,
        description:
          'Добавить detail: почему стоит выдача и активные попытки (стадия, владение, gates)',
      },
      {
        name: '--human',
        value: 'flag',
        required: false,
        description:
          'Текст для человека вместо JSON: строка сводки попыток и этап простыми словами на поручение',
      },
      {
        name: '--watch',
        value: 'flag',
        required: false,
        description:
          'Только с --human: обновлять текст, пока идут попытки или их сдвинет живой controller; выход — когда доска успокоилась или по Ctrl-C',
      },
      {
        name: '--interval',
        value: 'number',
        required: false,
        description: 'Период обновления --watch в секундах (1–3600, по умолчанию 5)',
      },
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
      'Отменить поручение: активная попытка теряет владение, поручение становится cancelled; это не retry. Открытая доработка принятого поручения не отменяет задачу: работа возвращается к принятой редакции (done, прежняя приёмка, abandoned: true)',
    writes: true,
    idempotency:
      'Повтор для отменённого ничего не меняет; доработка, отменённая прежней версией, при повторе возвращается к принятой редакции',
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
      {
        name: '--by',
        value: 'text',
        required: false,
        description:
          'lead — сброс ведущего по свежему техническому разбору (policy.recovery.mode: lead, предел leadResets); operator — решение оператора (operator явно не пишется в журнал ведущего и при его активной сессии); без флага — operator; в открытой сессии ведущего флаг обязателен (иначе INVALID_INPUT)',
      },
      {
        name: '--diagnosis',
        value: 'id',
        required: false,
        description: 'Разбор (D<n>), по которому ведущий даёт новый предел; по умолчанию — свежий',
      },
    ],
    refusals: [
      'NOT_FOUND',
      'NOT_READY',
      'ATTEMPTS_EXHAUSTED',
      'BUDGET_EXHAUSTED',
      'BUDGET_UNKNOWN',
      'INPUT_REQUIRED',
      'DIAGNOSIS_REQUIRED',
    ],
  },
  diagnose: {
    description:
      'Записать разбор ведущего повторных засчитанных отказов работы: причина (coverage — добавить случаи, approach — новая гипотеза, split — разделить с ревью плана, contradiction — вопрос человеку, environment, other), гипотеза (обязательна для coverage и approach, не повторяет прежние) и доказательства. Следующая попытка получает гипотезу; при исчерпанных попытках техническая причина даёт ведущему право на сброс (retry --reset --by lead). Модель не вызывается',
    writes: true,
    idempotency:
      'Каждый вызов — новый разбор D<n>; повтор той же гипотезы — отказ. С --addendum — дополнение свежего разбора (до 5), не новый разбор',
    args: [
      state,
      work,
      {
        name: '--cause',
        value: 'text',
        required: false,
        description:
          'coverage | approach | split | contradiction | environment | other (обязательна без --addendum)',
      },
      {
        name: '--addendum',
        value: 'text',
        required: false,
        description:
          'Дополнить свежий разбор того же засчитанного отказа (вторая причина, заметка ведущего; 10–2000 знаков): следующая попытка получит его вместе с разбором; граф не перерегистрируется, новый предел не даётся. Без --cause и --hypothesis',
      },
      {
        name: '--hypothesis',
        value: 'text',
        required: false,
        description:
          'Проверяемая гипотеза: что исполнитель сделает иначе и как это проверить (10–2000 знаков)',
      },
      {
        name: '--evidence',
        value: 'text',
        required: false,
        multiple: true,
        description: 'Доказательство (ID попытки, evidence, строка лога), до 10',
      },
    ],
    refusals: ['NOT_FOUND', 'NOT_READY', 'INVALID_INPUT'],
  },
  proposal: {
    description:
      'Решение ведущего по предложению исполнителя (0.1.0-alpha.70): задача-продолжение на остаток или разделение из разбора в начале попытки. accept — внести в план (сам граф команда не меняет: принятое ведущий вносит обычным ревью плана), reject — отклонить с основанием (после отклонённого разделения — retry --by lead). Исполнитель предложения не принимает. Модель не вызывается',
    writes: true,
    idempotency: 'Решённое предложение второй раз не решается (NOT_READY)',
    args: [
      state,
      work,
      {
        name: '--proposal',
        value: 'id',
        required: true,
        description: 'ID предложения (P-…)',
      },
      {
        name: '--decision',
        value: 'text',
        required: true,
        description: 'accept | reject',
      },
      {
        name: '--reason',
        value: 'text',
        required: true,
        description: 'Основание решения (3–2000 знаков)',
      },
      {
        name: '--by',
        value: 'text',
        required: false,
        description: 'lead (по умолчанию) | operator',
      },
    ],
    refusals: ['NOT_FOUND', 'NOT_READY', 'INVALID_INPUT'],
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
  'worktree-cleanup': {
    description:
      'Убрать рабочие деревья закончившихся попыток: ветки и достижимые коммиты остаются, неподтверждённые правки сохраняются проверенным патчем в артефактах попытки, игнорируемые файлы не сохраняются и перечисляются в ответе; индекс, который патч не сохранит, — отказ; в сомнении дерево остаётся, а отказ назван; модель не вызывается',
    writes: true,
    idempotency: 'Повтор не находит уже убранных деревьев и ничего не меняет',
    args: [
      state,
      {
        name: '--dry-run',
        value: 'flag',
        required: false,
        description:
          'Только показать, что было бы убрано, что исчезнет (игнорируемое) и почему отказано; ничего не пишет',
      },
    ],
    refusals: ['NOT_FOUND', 'NOT_READY'],
  },
  cleanup: {
    description:
      'Довести незавершённую очистку закончившейся попытки: повторить teardown по сохранённым receipt окружений и убрать её рабочие деревья; с ID smoke (LS-…) — повторить teardown его окружения или сверить запись cleanup-failed без рабочего дерева в cleaned (событие environment.reconciled), только когда шаги вызывают docker/podman сами, демон тот же, что у фазы, и ресурсов с меткой прогона нет; иначе NOT_READY; модели, gates и Git-приёмка не вызываются',
    writes: true,
    idempotency: 'Повтор после успешной очистки отвечает nothing-pending и ничего не меняет',
    args: [
      state,
      {
        name: '--run',
        value: 'id',
        required: true,
        description: 'ID попытки (runId) или запуска smoke (LS-…)',
      },
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
      {
        ...source,
        required: false,
        description:
          'Конфигурация связки задач: сверить версию Relay (договор и capabilities) и предупредить, если она ниже рекомендуемой; без флага — connector.json рядом с --policy, если он есть',
      },
      {
        name: '--probe-sandbox',
        value: 'flag',
        required: false,
        description:
          'Проверить ограничения песочницы проверок пробами (сигнал процессу вне песочницы, запуск браузера — до 30 с); без флага — уже известный ответ процесса или «не проверялось»',
      },
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
        name: '--lead',
        value: 'id',
        required: false,
        description:
          'Ведущий (автор планов и контрактов): claude или codex; без него — из manifest, иначе по окружению (CLAUDECODE, CODEX_THREAD_ID), иначе NOT_READY lead-unknown',
      },
      {
        name: '--writer',
        value: 'id',
        required: false,
        description: 'Runtime writer: claude или codex; по умолчанию — из manifest, иначе ведущий',
      },
      {
        name: '--review',
        value: 'text',
        required: false,
        description:
          'cross — reviewer другого вендора; same — тот же runtime с явным same-vendor-allowed; auto (по умолчанию) — cross, если другой CLI установлен и вошёл, иначе same',
      },
      {
        name: '--model',
        value: 'text',
        required: false,
        description:
          'Одна модель на writer и всех reviewers политики (только с ревью одного вендора)',
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
        name: '--lead-technical-answers',
        value: 'flag',
        required: false,
        description:
          'Технические вопросы исполнителя (результат для пользователя не меняется) решает ведущий с записанной причиной: inputPolicy.leadAnswers.technical в новой политике; без флага на вопросы, останавливающие работу, отвечает человек. Сохранённая политика без этого правила — PATH_CONFLICT content-differs',
      },
      {
        name: '--harness-mode',
        value: 'text',
        required: false,
        description:
          'Режим harness новой политики (alpha.69): light — по умолчанию (исполнитель и gates на хосте с Docker, браузером и сетью; одна граница — запись только в своё дерево попытки, временный каталог и кеши); strict — прежняя песочница ОС, заморожен, выбор владельца для чужого кода или секретов production (harnessMode: strict)',
      },
      {
        name: '--recovery',
        value: 'text',
        required: false,
        description:
          'Кто решает после повторных отказов (policy.recovery.mode): lead — ведущий разбирает и сам даёт ещё попытки в пределах бюджета; user — исчерпание решает человек. Без флага — lead при --lead-technical-answers, иначе user',
      },
      {
        name: '--diagnose-after',
        value: 'number',
        required: false,
        description:
          'После скольких засчитанных отказов разбор ведущего до следующей попытки (recovery.diagnoseAfter, 1–10, по умолчанию 2)',
      },
      {
        name: '--lead-resets',
        value: 'number',
        required: false,
        description:
          'Сколько раз ведущий сам даёт новый предел попыток (recovery.leadResets, 0–5, по умолчанию 2; 0 — только человек)',
      },
      {
        name: '--lean',
        value: 'flag',
        required: false,
        description:
          'Новый проект на слабой машине: слой lean (одна попытка за раз, runTimeoutMs 1800000, gateTimeoutFloorMs 240000); для pnpm-профиля с pnpm-lock.yaml — dependencyStore',
      },
      {
        name: '--human',
        value: 'flag',
        required: false,
        description: 'Текст для человека вместо JSON',
      },
      {
        ...source,
        required: false,
        description:
          'Конфигурация связки задач: сверить версию Relay и предупредить (relay-compatibility), если она ниже рекомендуемой; без флага — .harness/connector.json репозитория, если он есть',
      },
    ],
    refusals: ['PATH_CONFLICT', 'CONTROLLER_BUSY', 'NOT_READY'],
  },
  lean: {
    description:
      'Включить или выключить слой lean (слабая машина) в подготовленном проекте: поля политики (concurrency, runTimeoutMs, gateTimeoutFloorMs, dependencyStore для pnpm) и profile.layers manifest; прежние значения записываются в manifest, выключение возвращает их точно',
    writes: true,
    idempotency:
      'Повтор с тем же направлением ничего не пишет (changed: false); прерванное переключение дописывает недостающее; файлы, изменённые между чтением и записью, — REVISION_CONFLICT без записи',
    args: [
      {
        name: '--repository',
        value: 'dir',
        required: true,
        description:
          'Корень Git-репозитория проекта с .harness/project.json и .harness/policy.json',
      },
      {
        name: '--state',
        value: 'dir',
        required: false,
        description:
          'Каталог состояния для проверки идущего run (роль controller, попытки, совместные проверки); по умолчанию — paths.state manifest',
      },
      {
        name: '--off',
        value: 'flag',
        required: false,
        description:
          'Выключить слой: вернуть значения, записанные при включении, иначе — профиля без слоя',
      },
      {
        name: '--plan',
        value: 'flag',
        required: false,
        description: 'Только изменения полей, без записи (exit 3 при проблемах)',
      },
      {
        name: '--human',
        value: 'flag',
        required: false,
        description: 'Текст для человека вместо JSON',
      },
    ],
    refusals: ['NOT_READY', 'CONTROLLER_BUSY', 'PATH_CONFLICT', 'REVISION_CONFLICT'],
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
  report: {
    description:
      'Отчёт об эффекте по данным каталога состояния: принятые поручения, отказы проверок и ревью, автономность, скорость, расход, окружение, недели; только чтение, без вызовов моделей',
    writes: false,
    idempotency:
      'Только чтение. Тот же каталог, те же параметры и те же target ref дают те же байты: момент отчёта по умолчанию — последняя метка времени в данных, а не часы; сверка принятых поручений (`targets`) читает текущие target ref',
    args: [
      state,
      {
        name: '--since',
        value: 'text',
        required: false,
        description:
          'Начало окна включительно: ISO-время с поясом, дата YYYY-MM-DD или Nd/Nw до --as-of',
      },
      {
        name: '--until',
        value: 'text',
        required: false,
        description: 'Конец окна не включительно: ISO-время с поясом или дата',
      },
      {
        name: '--as-of',
        value: 'text',
        required: false,
        description: 'Момент отчёта; по умолчанию — последняя метка времени в данных',
      },
      {
        name: '--format',
        value: 'text',
        required: false,
        description:
          'json (по умолчанию, в конверте), md или html (текст в stdout без конверта; отказ — JSON-конверт)',
      },
      {
        name: '--no-titles',
        value: 'flag',
        required: false,
        description: 'Без заголовков поручений и метки проекта',
      },
      {
        name: '--out',
        value: 'path',
        required: false,
        description:
          'Записать отчёт выбранного формата в файл (не символическую ссылку и не файл состояния); в stdout — конверт с путём и размером',
      },
    ],
    refusals: ['NOT_FOUND', 'PATH_CONFLICT'],
  },
  handoff: {
    description:
      'Пакет передачи контекста для новой сессии ведущего агента из хранилища: активная работа и стадия, решения и остановки, незавершённые попытки, последние провалы, бюджеты, следующий шаг; только чтение',
    writes: false,
    idempotency: 'Только чтение; агент добавляет только намерения (--intent)',
    args: [
      state,
      { name: '--graph', value: 'id', required: false, description: 'Только этот граф' },
      {
        name: '--intent',
        value: 'text',
        required: false,
        multiple: true,
        description:
          'Намерение агента (до 20, каждое до 1000 знаков); единственный текст не из хранилища',
      },
      {
        name: '--format',
        value: 'text',
        required: false,
        description: 'json (по умолчанию, конверт HandoffPack) или md (Markdown без конверта)',
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
  view: {
    description:
      'Представление оператора: один документ только для чтения для панели оператора (настройки, работы с этапом и попытками, ревью, вопросы, эскалации, сверка принятого, прогресс, история за окно, здоровье) с viewVersion и viewRevision; с --work — детали работы; не пишет и не создаёт каталог состояния',
    writes: false,
    idempotency:
      'Только чтение. Те же состояние, политика, часы и параметры дают те же байты; source.token — SHA-256 содержимого без generatedAt: равный токен — то же представление',
    args: [
      stateOrRepository,
      projectRepository(
        'до настройки (нет manifest или ни привязки, ни базы, ни политики) — документ настройки (setupViewSchema), а не отказ',
      ),
      {
        name: '--policy',
        value: 'path',
        required: false,
        description:
          'Политика исполнения; без неё — привязанная к состоянию (binding.json). Нет состояния и нет --policy — POLICY_REQUIRED; нет состояния с --policy — пустое представление. Отличие от привязанной — предупреждение POLICY_DIGEST_MISMATCH',
      },
      {
        name: '--work',
        value: 'id',
        required: false,
        description: 'Детали работы (WorkDetailView): строки попыток, проверки, ревью, вопросы',
      },
      {
        name: '--no-titles',
        value: 'flag',
        required: false,
        description: 'Без заголовков работ, текста вопросов и находок и queue.detail',
      },
      {
        name: '--window',
        value: 'text',
        required: false,
        description: 'Окно истории: 24h (по умолчанию) или 7d',
      },
      {
        name: '--bucket',
        value: 'text',
        required: false,
        description: 'Интервал истории: 15m (по умолчанию) или 1h',
      },
      {
        name: '--lang',
        value: 'text',
        required: false,
        description: 'Язык простых строк harness: ru (по умолчанию) или en',
      },
      {
        name: '--view-version',
        value: 'number',
        required: false,
        description: 'Мажорная версия документа; поддерживается 1',
      },
    ],
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
      {
        name: '--reprove',
        value: 'flag',
        required: false,
        description:
          'Повторно доказать критерии уже принятого результата по текущим привязкам criteria[] (после их правки): новый ключ операции, тот же результат и evidence, без моделей, gates и Git; те же привязки — тот же ключ, повтор ничего не отправляет; изменённая постановка — conflict с причиной',
      },
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
  'input-list': {
    description:
      'Вопросы исполнителей (H02): ID, поручение, вид, состояние, серьёзность и версия запроса — без текста',
    writes: false,
    idempotency: 'Только чтение',
    args: [state, { ...work, required: false, description: 'Только вопросы этого поручения' }],
    refusals: ['NOT_FOUND'],
  },
  'input-show': {
    description: 'Запрос исполнителя целиком: вопрос, варианты, основание, ответы, цель применения',
    writes: false,
    idempotency: 'Только чтение',
    args: [state, inputRequestArg],
    refusals: ['NOT_FOUND'],
  },
  'input-answer': {
    description:
      'Записать ответ на вопрос исполнителя новой неизменяемой версией; работу ответ не возобновляет — дальше input-context, review-plan, input-target, input-apply',
    writes: true,
    idempotency:
      'Тот же текст, вариант и вид — прежний ответ без записи; иначе новая версия при совпадении --request-version (CAS); закрытый запрос — NOT_READY',
    args: [
      state,
      inputRequestArg,
      { name: '--text', value: 'text', required: true, description: 'Ответ (до 3000 знаков)' },
      { name: '--option', value: 'id', required: false, description: 'Выбранный вариант (ID)' },
      {
        name: '--kind',
        value: 'text',
        required: false,
        description:
          'clarification (по умолчанию: продолжение той же работы) или requirement-change (новая ревизия: input-supersede)',
      },
      {
        name: '--actor',
        value: 'text',
        required: false,
        description:
          'Кто отвечает: operator (словами человека) или lead — только на неблокирующие запросы или с разрешения inputPolicy.leadAnswers (technical: технические вопросы с --reason; maxSeverity: до порога серьёзности); без флага — operator, и в открытой сессии ведущего: ответ ведущего — только явно --actor lead',
      },
      {
        name: '--reason',
        value: 'text',
        required: false,
        description:
          'Почему ведущий выбрал ответ (до 1000 знаков); обязательна для --actor lead на технический вопрос по inputPolicy.leadAnswers.technical',
      },
      requestVersionArg,
    ],
    refusals: ['NOT_FOUND', 'REVISION_CONFLICT', 'NOT_READY', 'OPERATOR_ANSWER_REQUIRED'],
  },
  'input-context': {
    description:
      'Снимок контекста с последним ответом: действующий снимок графа и источник input-answer (вопрос, ответ, manifest с точным digest и версией ответа); сохраняется по digest и пишется в --out, но не активируется',
    writes: true,
    idempotency: 'Тот же ответ и тот же действующий снимок — тот же digest и те же байты',
    args: [
      state,
      inputRequestArg,
      {
        name: '--out',
        value: 'path',
        required: true,
        description: 'Файл ContextSnapshot JSON для review-plan --context',
      },
    ],
    refusals: ['NOT_FOUND', 'INPUT_REQUIRED'],
  },
  'input-target': {
    description:
      'Основание продолжения для снимка с ответом (только чтение): digest, который назовёт input-apply, и причины, по которым применение сейчас откажет',
    writes: false,
    idempotency: 'Только чтение',
    args: [state, inputRequestArg, contextDigestArg],
    refusals: ['NOT_FOUND'],
  },
  'input-apply': {
    description:
      'Применить ответ одной транзакцией: проверки approve и retry, активация согласования снимка с ответом, запрос applied и обычный повтор поручения; модель не вызывается, пауза и удержания остаются',
    writes: true,
    idempotency:
      'Повтор того же применения ничего не меняет и второй попытки не создаёт; идущие попытки графа, исчерпанные попытки или бюджет — applied:false, запрос и согласование не меняются (exit 3)',
    args: [
      state,
      inputRequestArg,
      {
        name: '--answer',
        value: 'digest',
        required: true,
        description: 'Digest последнего ответа (input-show)',
      },
      requestVersionArg,
      contextDigestArg,
      {
        name: '--target',
        value: 'digest',
        required: true,
        description: 'Digest основания из input-target',
      },
      {
        name: '--reset',
        value: 'flag',
        required: false,
        description: 'Сбросить исчерпанный счётчик попыток; требует --reason',
      },
      { name: '--reason', value: 'text', required: false, description: 'Причина сброса' },
    ],
    refusals: [
      'NOT_FOUND',
      'REVISION_CONFLICT',
      'APPROVAL_STALE',
      'APPROVAL_REQUIRED',
      'REVIEW_REJECTED',
      'INPUT_REQUIRED',
      'NOT_READY',
      'ATTEMPTS_EXHAUSTED',
      'BUDGET_EXHAUSTED',
    ],
  },
  'input-cancel': {
    description:
      'Отменить вопрос: работа больше его не ждёт (обычный повтор снова по своим правилам); применённый ответ не отменяется',
    writes: true,
    idempotency: 'Повтор для отменённого ничего не меняет',
    args: [
      state,
      inputRequestArg,
      requestVersionArg,
      { name: '--reason', value: 'text', required: true, description: 'Причина' },
    ],
    refusals: ['NOT_FOUND', 'REVISION_CONFLICT', 'NOT_READY'],
  },
  'input-resolve': {
    description:
      'От ответа до применения одним вызовом: снимок с последним ответом (хранится по digest, файлов не нужно), ревью плана с ним (прежний одобренный раунд того же снимка под текущей политикой — без вызова модели), основание и input-apply с точными версией и digest; работа ушла из остановки вопроса — отказ с выходом input-carry',
    writes: true,
    idempotency:
      'Применённый запрос — applied:true, changed:false без записи; идущие попытки графа, исчерпанные попытки или бюджет — applied:false с причиной (exit 3), ответ сохранён',
    args: [
      state,
      inputRequestArg,
      {
        ...policy,
        required: false,
        description:
          'ExecutionPolicy JSON: после правки политики — применяемая политика (как у run); без неё — политика каталога состояния',
      },
      {
        ...author,
        required: false,
        description:
          'Runtime ведущего (автор плана) для ревью плана со снимком ответа; не нужен, если этот снимок уже одобрен последним раундом',
      },
      {
        name: '--reset',
        value: 'flag',
        required: false,
        description: 'Сбросить исчерпанный счётчик попыток; требует --reason',
      },
      { name: '--reason', value: 'text', required: false, description: 'Причина сброса' },
    ],
    refusals: [
      'NOT_FOUND',
      'NOT_READY',
      'INPUT_REQUIRED',
      'APPROVAL_REQUIRED',
      'APPROVAL_STALE',
      'REVIEW_REJECTED',
      'REVISION_CONFLICT',
      'ATTEMPTS_EXHAUSTED',
      'BUDGET_EXHAUSTED',
    ],
  },
  'input-carry': {
    description:
      'Перенести ответ в новую попытку или редакцию одним вызовом: вопрос, исходная остановка которого не держится (была другая попытка, новая редакция постановки), заменяется той же работой с причиной; затем снимок с ответом, ревью плана с ним, основание и перенос в действующее согласование; упавшая вопросом работа возвращается в очередь',
    writes: true,
    idempotency:
      'Повтор того же переноса — carried:true, changed:false; исходная остановка держится — отказ NOT_READY с выходом input-resolve',
    args: [
      state,
      inputRequestArg,
      {
        name: '--reason',
        value: 'text',
        required: true,
        description: 'Почему ответ переносится (запись замены вопроса и причина сброса с --reset)',
      },
      {
        ...policy,
        required: false,
        description:
          'ExecutionPolicy JSON: после правки политики — применяемая политика (как у run); без неё — политика каталога состояния',
      },
      {
        ...author,
        required: false,
        description:
          'Runtime ведущего (автор плана) для ревью плана со снимком ответа; не нужен, если этот снимок уже одобрен последним раундом',
      },
      {
        name: '--reset',
        value: 'flag',
        required: false,
        description: 'Сбросить исчерпанный счётчик попыток (причина — --reason)',
      },
      {
        name: '--actor',
        value: 'text',
        required: false,
        description: 'Кто заменяет вопрос: lead (по умолчанию) или operator — запись замены',
      },
    ],
    refusals: [
      'NOT_FOUND',
      'NOT_READY',
      'INPUT_REQUIRED',
      'APPROVAL_REQUIRED',
      'APPROVAL_STALE',
      'REVIEW_REJECTED',
      'REVISION_CONFLICT',
      'ATTEMPTS_EXHAUSTED',
      'BUDGET_EXHAUSTED',
    ],
  },
  'input-supersede': {
    description:
      'Заменить вопрос преемником: ответ меняет требования — новая ревизия или работа, а не продолжение этой',
    writes: true,
    idempotency: 'Повтор для заменённого ничего не меняет',
    args: [
      state,
      inputRequestArg,
      requestVersionArg,
      { name: '--reason', value: 'text', required: true, description: 'Причина' },
      {
        name: '--successor',
        value: 'id',
        required: true,
        description: 'Преемник: новая работа или запрос',
      },
    ],
    refusals: ['NOT_FOUND', 'REVISION_CONFLICT', 'NOT_READY'],
  },
  gates: {
    description:
      'Исполнить gates компонента на коммите вне попытки — тем же исполнением, что integration (рабочее дерево, снимки зависимостей, ресурсы, lifecycle, prepare, песочница); попыток и состояния поручений не пишет',
    writes: true,
    idempotency:
      'Каждый вызов — новая проверка со своими логами в <state>/gates-at/<id>; в базе состояния — только запись прогона (gates-runs: digest итога и основание gates, alpha.71), попытки и поручения не меняются',
    args: [
      {
        ...state,
        description: 'Каталог состояния: логи проверки; политика — из него, если нет --policy',
      },
      { ...policy, required: false },
      {
        name: '--sha',
        value: 'text',
        required: true,
        description: 'Проверяемый коммит: SHA, ref или HEAD checkout репозитория',
      },
      {
        name: '--gate',
        value: 'text',
        required: false,
        description:
          'Gates и группы (@имя) через запятую; предпосылки (dependsOn) добавляются сами; нет — все gates',
      },
      {
        name: '--repository',
        value: 'id',
        required: false,
        description: 'ID репозитория политики; нужен, если их несколько',
      },
      {
        name: '--fail-fast',
        value: 'flag',
        required: false,
        description: 'Остановиться на первом непрошедшем gate: следующие не исполняются (skipped)',
      },
      {
        name: '--human',
        value: 'flag',
        required: false,
        description: 'Таблица исходов для человека вместо JSON',
      },
    ],
    refusals: ['GATE_FAILED', 'CANCELLED', 'NOT_FOUND'],
  },
  'review-code': {
    description:
      'Технический обзор уже написанной ветки (код вне harness): reviewer по правилу ревью кода роли читает diff merge-base(base, head)..head в отдельном рабочем дереве на head, только чтение; итог `harness gates --sha` на head прикладывается, если он есть. Запись — наблюдение, не приёмка: поручений, попыток и target ref не меняет',
    writes: true,
    idempotency:
      'Повтор по тем же ref — следующий раунд предмета (repositoryId, роль, base, head как названы): reviewer называет состояние прежних открытых находок. Те же SHA, автор, назначение reviewer и итог gates на head, уже одобренные последним раундом, — тот же раунд без вызова модели. Автор, не допускаемый правилом вендора, — REVIEWER_SAME_VENDOR до вызова модели',
    args: [
      {
        ...state,
        description:
          'Каталог состояния: запись обзора и его артефакты; политика — из него, если нет --policy',
      },
      { ...policy, required: false },
      {
        name: '--base',
        value: 'text',
        required: true,
        description: 'База обзора: SHA или ref; diff считается от merge-base(base, head)',
      },
      {
        name: '--head',
        value: 'text',
        required: true,
        description: 'Проверяемый коммит: SHA, ref или HEAD checkout репозитория',
      },
      {
        name: '--role',
        value: 'id',
        required: false,
        description:
          'Роль политики, чьё правило ревью кода выбирает reviewer; нужна, если ролей несколько',
      },
      {
        ...author,
        required: false,
        description:
          'Автор кода: codex, claude, fixture или external; по нему применяется правило вендора. Нет — writer роли',
      },
      {
        name: '--repository',
        value: 'id',
        required: false,
        description: 'ID репозитория политики; нужен, если их несколько',
      },
    ],
    refusals: [
      'REVIEW_REJECTED',
      'CANCELLED',
      'REVIEWER_SAME_VENDOR',
      'REVIEWER_MISSING',
      'ATTEMPTS_EXHAUSTED',
      'BUDGET_EXHAUSTED',
      'BUDGET_UNKNOWN',
      'NOT_FOUND',
    ],
  },
  'review-release': {
    description:
      'Ревью выпуска перед `release done` (0.1.0-alpha.69): независимый reviewer по правилу ревью кода роли проверяет принятую цель против договора выпуска — постановок и критериев приёмки всех работ зарегистрированных графов, ответов владельца, топологии развёртывания (`release.topology`: шлюз/прокси и окружение production, прочитанные на head) — и diff base..head в отдельном рабочем дереве, только чтение. Перед ревью (alpha.71) нужен годный полный прогон всех gates на цели: нет его — исполняет и записывает его сам (gates-runs) со своим пределом времени, отдельным от reviewer; провал — NOT_READY с ходом по виду провала (код — работой, среда или инструмент — исправить и повторить harness gates, прерван — повторить). Запись — `kind: release`, не приёмка; находки исправляют обычные работы',
    writes: true,
    idempotency:
      'Предмет — репозиторий, роль и SHA базы выпуска: каждый вызов — следующий раунд, reviewer называет состояние прежних открытых находок. Тот же head, договор выпуска, автор, назначение reviewer и итог gates, уже одобренные последним раундом, — тот же раунд без вызова модели',
    args: [
      {
        ...state,
        description:
          'Каталог состояния: постановки и ответы выпуска, запись ревью и его артефакты; политика — из него, если нет --policy',
      },
      { ...policy, required: false },
      {
        name: '--base',
        value: 'text',
        required: false,
        description:
          'База выпуска: SHA или ref; нет — база самой ранней попытки репозитория в состоянии',
      },
      {
        name: '--head',
        value: 'text',
        required: false,
        description: 'Проверяемая цель: SHA или ref; нет — target ref репозитория (принятая цель)',
      },
      {
        name: '--role',
        value: 'id',
        required: false,
        description:
          'Роль политики, чьё правило ревью кода выбирает reviewer; нужна, если ролей несколько',
      },
      {
        ...author,
        required: false,
        description: 'Автор кода выпуска для правила вендора; нет — writer роли',
      },
      {
        name: '--repository',
        value: 'id',
        required: false,
        description: 'ID репозитория политики; нужен, если их несколько',
      },
    ],
    refusals: [
      'INVALID_INPUT',
      'REVIEW_REJECTED',
      'CANCELLED',
      'REVIEWER_SAME_VENDOR',
      'REVIEWER_MISSING',
      'ATTEMPTS_EXHAUSTED',
      'BUDGET_EXHAUSTED',
      'BUDGET_UNKNOWN',
      'NOT_FOUND',
      'NOT_READY',
    ],
  },
  smoke: {
    description:
      'Поднять только окружение репозитория на коммите — снимки зависимостей, рабочее дерево, lifecycle setup/ready, хранилище зависимостей, prepare, teardown — тем же исполнением, что integration, без gates и без вызовов моделей; замер каждого шага и класс отказа (port-busy, timeout, crash, missing-tool, cleanup, tree-changed, environment)',
    writes: true,
    idempotency:
      'Каждый вызов — новая проверка со своими логами в <state>/gates-at/<id>; попытки, поручения и записи прогонов gates не меняются',
    args: [
      {
        ...state,
        description: 'Каталог состояния: логи шагов; политика — из него, если нет --policy',
      },
      { ...policy, required: false },
      {
        name: '--sha',
        value: 'text',
        required: true,
        description: 'Проверяемый коммит: SHA, ref или HEAD checkout репозитория',
      },
      {
        name: '--repository',
        value: 'id',
        required: false,
        description: 'ID репозитория политики; нужен, если их несколько',
      },
      {
        name: '--human',
        value: 'flag',
        required: false,
        description: 'Таблица шагов, класс отказа и совет для человека вместо JSON',
      },
      {
        name: '--writer-probe',
        value: 'flag',
        required: false,
        description:
          'После prepare прогнать команды writerProbe репозитория в изоляции каждого его исполнителя (окружение, TMPDIR, сеть, области записи; codex sandbox или sandbox-runtime), без модели: по каждой ok/blocked/outside, причина и совет; шаг, закрытый только локальным портом, проба сама повторяет под network: loopback; проверка в браузере, которую песочница не запускает, — outside (ожидаемо, не помеха); закрытый шаг или пустой writerProbe — exit 4',
      },
      {
        name: '--apply-loopback',
        value: 'flag',
        required: false,
        description:
          'С --writer-probe и --policy: если сеть loopback (127.0.0.1 и ::1, без интернета) открывает закрытые локальным портом шаги, записать network: "loopback" в профиль инструментов исполнителя (нет профиля — новый writer-loopback), приложить запись с причиной и повторить пробу; больше ничего в политике не меняется. Техническое решение ведущего',
      },
    ],
    refusals: ['CANCELLED', 'NOT_FOUND'],
  },
  update: {
    description:
      'Обновления harness и панели оператора: проверить в реестре npm (единственный сетевой запрос harness, через npm, без телеметрии), поставить совместимую пару только когда нет прогона — с копией состояния, doctor и автоматическим откатом, — откатить, включить ежедневную проверку; смена форматов договоров — только решением владельца',
    writes: true,
    idempotency:
      'check пишет только <state>-updates/last-check.json; повтор apply без новой версии — up-to-date; rollback снимает одну запись истории; schedule daily перезаписывает своё задание',
    args: [
      {
        ...state,
        description:
          'Каталог состояния: копии, история и последняя проверка — рядом, в <state>-updates',
      },
      {
        ...policy,
        required: false,
        description:
          'ExecutionPolicy JSON: каталог .harness проекта, если у состояния нет привязки',
      },
      {
        name: '--check',
        value: 'flag',
        required: false,
        description:
          'Проверить реестр: текущая и доступная пара, что нового простыми словами, нужна ли смена форматов; офлайн — «не удалось проверить»',
      },
      {
        name: '--apply',
        value: 'flag',
        required: false,
        description:
          'Поставить найденную пару: не во время прогона, копия состояния, точные версии, doctor, перезапуск панели; при сбое — автоматический возврат',
      },
      {
        name: '--rollback',
        value: 'flag',
        required: false,
        description:
          'Вернуть прошлую пару; состояние — из последней копии, только если форматы различались',
      },
      {
        name: '--schedule',
        value: 'text',
        required: false,
        description:
          'daily — ежедневное задание launchd пользователя (macOS; для Linux — текст systemd/cron), off — убрать',
      },
      {
        name: '--mode',
        value: 'text',
        required: false,
        description: 'Записать режим в .harness/updates.json: auto, notify или off',
      },
      {
        name: '--prefix',
        value: 'dir',
        required: false,
        description: 'Каталог установки пакетов; по умолчанию — корень проекта (родитель .harness)',
      },
      {
        name: '--wait',
        value: 'number',
        required: false,
        description:
          'apply/rollback: идёт прогон — поставить очередь на паузу и ждать его окончания до N минут (1–720)',
      },
      {
        name: '--scheduled',
        value: 'flag',
        required: false,
        description:
          'apply из расписания: notify — только проверка, auto — установка в пределах autoScope, off — ничего',
      },
      {
        name: '--confirm-formats',
        value: 'text',
        required: false,
        description:
          'apply: решение владельца поставить пару со сменой форматов — ровно harness@<версия>[+ui@<версия>] из --check; другая пара — отказ; из расписания не принимается',
      },
      {
        name: '--human',
        value: 'flag',
        required: false,
        description: 'Строка для человека, что нового и шаги вместо JSON',
      },
    ],
    refusals: ['CONTROLLER_BUSY', 'APPROVAL_REQUIRED', 'NOT_FOUND'],
  },
  'lead-begin': {
    description:
      'Ведущий начинает (или продлевает) свою сессию: панель видит «ведущий работает» до конца аренды; каждая запись ведущего её продлевает (0.1.0-alpha.66). Синоним: harness lead begin',
    writes: true,
    idempotency: 'Повтор при активной сессии продлевает аренду; начало сессии прежнее',
    args: [
      state,
      {
        name: '--ttl',
        value: 'duration',
        required: false,
        description:
          'Аренда сессии — длительность с единицей s, m или h (90s, 30m, 2h): от 1m до 12h, по умолчанию 30m; голое число — отказ INVALID_INPUT',
      },
      {
        name: '--text',
        value: 'text',
        required: false,
        description: 'Чем ведущий начинает — короткая строка простыми словами (до 200 символов)',
      },
    ],
    refusals: ['NOT_FOUND'],
  },
  'lead-note': {
    description:
      'Короткая строка простыми словами о том, что ведущий делает сейчас, в том числе вне harness (запись в источнике задач, проверка в браузере): журнал ведущего и строка панели; очищается от управляющих символов и секретов, до 200 символов (0.1.0-alpha.66). Синоним: harness lead note "<строка>"',
    writes: true,
    idempotency: 'Каждый вызов — новая запись журнала; старые вытесняются пределом 200 записей',
    args: [
      state,
      {
        name: '--text',
        value: 'text',
        required: true,
        description: 'Строка ведущего простыми словами',
      },
      { ...work, required: false, description: 'ID поручения, о котором запись' },
    ],
    refusals: ['NOT_FOUND'],
  },
  'lead-end': {
    description:
      'Ведущий заканчивает сессию: панель больше не говорит «ведущий работает» (0.1.0-alpha.66). Готовые работы, а никто не запущен, — предупреждение READY_WORKS_NOT_RUNNING в stderr и readyNotRunning в ответе; сессия всё равно закончена, выход 0 (0.1.0-alpha.68). Синоним: harness lead end',
    writes: true,
    idempotency: 'Повтор закрывает уже закрытую сессию ещё одной записью журнала',
    args: [
      state,
      {
        name: '--text',
        value: 'text',
        required: false,
        description: 'Чем ведущий закончил — короткая строка',
      },
    ],
    refusals: ['NOT_FOUND'],
  },
  'release-done': {
    description:
      'Итоговый отчёт ведущего: выпуск готов — только когда весь код принят (ни одной открытой работы или доработки); до него представление говорит «код принят, ведущий ещё работает», готовность ниже 100 % (0.1.0-alpha.66). Ревью выпуска (0.1.0-alpha.69): при `release.review: required` (умолчание облегчённого режима) нужен одобренный раунд `harness review-release` на текущей принятой цели без открытых блокирующих находок, иначе NOT_READY; `advisory` (умолчание строгого) — выпуск закрывается с полем warning. Синоним: harness release done --summary "<отчёт>"',
    writes: true,
    idempotency: 'Повтор заменяет итоговый отчёт новым с новым временем',
    args: [
      state,
      {
        name: '--summary',
        value: 'text',
        required: true,
        description: 'Итоговый отчёт простыми словами (до 2000 символов)',
      },
    ],
    refusals: ['NOT_FOUND', 'NOT_READY'],
  },
  'env-up': {
    description:
      'Сервисы попытки облегчённого режима (0.1.0-alpha.70): из шага lifecycle или gate попытки поднимает docker compose под именем проекта попытки (COMPOSE_PROJECT_NAME задаёт harness) с up -d --wait, убрав остатки того же проекта; динамические порты (ports: "127.0.0.1::<порт>") дописывает в файл окружения попытки (HARNESS_ATTEMPT_ENV_FILE) переменными HX_<СЕРВИС>_<ПОРТ> — gates попытки получают их в окружении; при отказе готовности — compose ps -a и хвосты журналов нездоровых сервисов (замаскированные) в compose-readiness.json и ответе. Модель не вызывается',
    writes: true,
    idempotency: 'Повтор поднимает стек заново (прежний того же проекта снимается)',
    args: [
      {
        name: '--file',
        value: 'path',
        required: false,
        description: 'Файл compose (по умолчанию — правила docker compose в каталоге)',
      },
      {
        name: '--wait',
        value: 'number',
        required: false,
        description: 'Предел ожидания готовности (--wait-timeout, по умолчанию 120 с)',
      },
    ],
    refusals: ['INVALID_INPUT', 'NOT_READY', 'RUNTIME_UNAVAILABLE'],
  },
  'env-down': {
    description:
      'Убрать сервисы попытки (0.1.0-alpha.70): docker compose down -v --remove-orphans -t 2 под именем проекта попытки; для шага teardown',
    writes: true,
    idempotency: 'Повтор без стека — без изменений',
    args: [
      {
        name: '--file',
        value: 'path',
        required: false,
        description: 'Файл compose',
      },
    ],
    refusals: ['INVALID_INPUT', 'RUNTIME_UNAVAILABLE'],
  },
  'env-sweep': {
    description:
      'Уборка стеков попыток (0.1.0-alpha.70): только проекты docker compose, которые поднял harness env-up попыток ЭТОГО каталога состояния (записи compose-services.json), и только у попыток, которые не идут (живость перепроверяется перед каждым снятием); проекты других установок, harness gates --sha и чужие hx-* не трогаются. Без --yes — только список (dry run); с --yes — down -v --remove-orphans',
    writes: true,
    idempotency: 'Повтор после уборки — пустой список',
    args: [
      state,
      {
        name: '--yes',
        value: 'flag',
        required: false,
        description: 'Снять найденные стеки (без флага — только список)',
      },
    ],
    refusals: ['NOT_FOUND', 'RUNTIME_UNAVAILABLE'],
  },
  guide: {
    description:
      'Раздел инструкции ведущего по теме (alpha.71): session (читается первой в каждой сессии), setup, plan, review, run, recovery, release, relay; печатает текст раздела без конверта, `--json` — конверт с текстом и заголовками; только чтение файлов пакета',
    writes: false,
    idempotency: 'Только чтение. Та же версия пакета и тема дают тот же текст',
    args: [
      {
        name: '--topic',
        value: 'text',
        required: true,
        description:
          'Тема: session, setup, plan, review, run, recovery, release, relay; можно позиционно: `harness guide run`',
      },
      { name: '--json', value: 'flag', required: false, description: 'JSON-конверт вместо текста' },
    ],
    refusals: ['NOT_FOUND'],
  },
  wait: {
    description:
      'Ждать следующего значимого события (alpha.71): принятие, отказ или удержание работы, вопрос исполнителя, готовность выпуска, остановка очереди; итог — что случилось, следующий шаг из explain и строка состояния. Читает журнал событий только на чтение, controller не опрашивает',
    writes: false,
    idempotency:
      'Только чтение состояния (продлевает лишь активную сессию ведущего). Без --after сначала сообщает уже ждущее, затем ждёт событий после конца журнала; с --after <cursor> — событий после курсора; ответ несёт cursor сразу за сообщённым событием. Уже готовый выпуск или очередь без controller и попыток — сразу. Коды выхода — исходы ожидания, не ошибки: 0 accepted, 10 release-ready, 11 question, 12 held, 13 failed, 14 stopped, 15 timeout, 16 aborted (сигнал); решает поле `kind` JSON-ответа (`ok: true` при любом исходе), коды — для скриптов',
    args: [
      state,
      {
        ...policy,
        required: true,
        description: 'ExecutionPolicy JSON: для следующего шага (explain)',
      },
      {
        name: '--until',
        value: 'text',
        required: false,
        description:
          'Какие исходы ждать через запятую: accepted, failed, held, question, release-ready, stopped; release-ready, stopped и таймаут кончают ожидание всегда',
      },
      {
        name: '--timeout',
        value: 'duration',
        required: false,
        description: 'Предел ожидания: Nm, Nh или Ns; по умолчанию 30m',
      },
      {
        name: '--after',
        value: 'number',
        required: false,
        description:
          'Курсор прошлого wait (`data.cursor`): события строго после него. Без него wait сначала сообщает уже ждущее (отказ, удержание, вопрос), затем ждёт новых',
      },
    ],
    refusals: ['NOT_FOUND'],
  },
  'lead-outline': {
    description:
      'План выпуска ведущего до первого графа (и до первого run — с --policy): этапы × компоненты с грубым размером (S/M/L или число задач) и тем, кто их делает (writers, environment, owner). Прогноз считает незарегистрированные части плана объёмом выпуска; без плана status и панель подсказывают RELEASE_OUTLINE_MISSING, run не блокируется (0.1.0-alpha.68). Синоним: harness lead outline --file F',
    writes: true,
    idempotency:
      'Тот же план — без изменений (changed: false); другой — новая редакция с причиной («план вырос: +…») и строкой журнала ведущего',
    args: [
      state,
      {
        name: '--file',
        value: 'path',
        required: true,
        description:
          'JSON {stages:[{id, title, kind: infra|product|deploy|other, components:[{id, title, size: S|M|L, tasks?, actor: writers|environment|owner, works?}]}], reason?}',
      },
      {
        name: '--reason',
        value: 'text',
        required: false,
        description:
          'Почему план изменился (главнее reason файла); нет — «план вырос: +…» по разнице',
      },
      {
        name: '--policy',
        value: 'path',
        required: false,
        description:
          'ExecutionPolicy JSON: до первого run привязывает к ней каталог состояния (как run) и создаёт его, чтобы план записывался до первого графа (0.1.0-alpha.69); без него каталог должен быть уже привязан',
      },
    ],
    refusals: ['NOT_FOUND'],
  },
  'preview-start': {
    description:
      'Превью результата (docs/previews.md): собрать и запустить приложение по previews[] репозитория на принятом коммите в своём рабочем дереве каталога состояния, на свободном loopback-порту за loopback-прокси, с lifecycle репозитория при services; ждёт health и возвращает адрес. Harness сам останавливает превью по сроку (--ttl) и простою без запросов (--idle). Запускает только оператор или ведущий по его просьбе: внутри попытки и gate — отказ NOT_READY; run превью не запускает',
    writes: true,
    idempotency:
      'То же превью на том же коммите уже идёт — возвращается оно (changed: false); на другом коммите прежнее останавливается (replaced) и запускается новое',
    args: [
      {
        ...state,
        description:
          'Каталог состояния: рабочее дерево, логи и receipt превью — в <state>/previews; политика — из него, если нет --policy',
      },
      { ...policy, required: false },
      {
        name: '--preview',
        value: 'id',
        required: false,
        description: 'ID превью из previews[] репозитория; нужен, если их несколько',
      },
      {
        name: '--ref',
        value: 'text',
        required: false,
        description:
          'accepted (по умолчанию) — принятый результат: с --work принятый SHA поручения, без него — вершина target ref репозитория; иначе SHA или ref checkout',
      },
      {
        ...work,
        required: false,
        description: 'Поручение, чей принятый результат показать (только с --ref accepted)',
      },
      {
        name: '--repository',
        value: 'id',
        required: false,
        description: 'ID репозитория политики; нужен, если превью есть у нескольких',
      },
      {
        name: '--ttl',
        value: 'duration',
        required: false,
        description:
          'Срок жизни превью — длительность с единицей s, m или h (90s, 30m, 2h): от 1s до 24h; голое число — отказ INVALID_INPUT; нет — ttlMs превью, иначе 2h',
      },
      {
        name: '--idle',
        value: 'duration',
        required: false,
        description:
          'Остановить после такого простоя без запросов — длительность с единицей s, m или h (90s, 30m, 2h), до 24h; 0 — не останавливать по простою; другое голое число — отказ INVALID_INPUT; нет — idleMs превью, иначе 30m',
      },
    ],
    refusals: ['NOT_FOUND', 'NOT_READY'],
  },
  'preview-stop': {
    description:
      'Остановить превью: группа процессов приложения (TERM, затем KILL), lifecycle teardown при services, рабочее дерево превью убирается, receipt — stopped; без --preview — все живые превью',
    writes: true,
    idempotency: 'Повтор для остановленного превью ничего не меняет (changed: false)',
    args: [
      {
        ...state,
        description: 'Каталог состояния; политика — из него, если нет --policy',
      },
      { ...policy, required: false },
      {
        name: '--preview',
        value: 'id',
        required: false,
        description: 'ID превью; нет — все живые',
      },
      {
        name: '--repository',
        value: 'id',
        required: false,
        description: 'Только превью этого репозитория',
      },
      {
        name: '--all',
        value: 'flag',
        required: false,
        description:
          'С --preview без --repository: остановить превью с этим ID во всех репозиториях; без флага такой ID в нескольких репозиториях — отказ INVALID_INPUT с их списком',
      },
    ],
    refusals: ['NOT_FOUND', 'INVALID_INPUT'],
  },
  'preview-list': {
    description:
      'Превью каталога состояния с адресом, коммитом, сроком и состоянием; receipt сверяются с живыми процессами: превью, чей надзирающий процесс пропал, останавливается по receipt (приложение, teardown, рабочее дерево) и становится failed',
    writes: true,
    idempotency: 'Повтор без изменившихся процессов отвечает тем же списком',
    args: [
      {
        ...state,
        description: 'Каталог состояния; политика — из него, если нет --policy',
      },
      { ...policy, required: false },
    ],
    refusals: ['NOT_FOUND'],
  },
} as const satisfies Record<string, CliCommandContract>;
export type CliCommand = keyof typeof cliCommands;

/* ------------------------------------------------------------------ */
/* Данные ответов                                                      */
/* ------------------------------------------------------------------ */

const blocker = z.strictObject({
  code: z.enum(Object.keys(errorCodes) as [ErrorCode, ...ErrorCode[]]),
  message: z.string().max(4000),
  /**
   * Только `status`: причина простыми словами по-русски и по-английски
   * («ждёт зависимости a», «пауза очереди: бюджет») и кто её снимает
   * (`actor` — как у диагноза `explain`; `null` — никто, итог). Нет полей —
   * ответ другой команды или версии.
   */
  plain: z.string().min(1).max(300).optional(),
  plainEn: z.string().min(1).max(300).optional(),
  actor: z.enum(diagnosisActors).nullable().optional(),
  /**
   * Только `status` (alpha.60): порядок снятия, когда блокировок несколько —
   * 1 снимается первым (согласование раньше сброса попыток: сброс до него
   * ничего не изменит). Нет поля — блокировка одна или порядок не важен.
   */
  step: z.number().int().positive().optional(),
});

export const validateDataSchema = z.strictObject({
  graphId: idSchema,
  graphDigest: digestSchema,
  policyDigest: digestSchema,
  contextDigest: digestSchema.optional(),
  orders: z.number().int().positive(),
});

/** Активная попытка `status --detail` (`attemptView`). */
export const attemptViewSchema = z.strictObject({
  runId: z.string().min(1).max(200),
  workId: idSchema,
  attempt: z.number().int().positive(),
  status: z.string(),
  phase: workStatusSchema,
  runtime: z.string(),
  model: z.string().optional(),
  startedAt: isoTimeSchema,
  elapsedMs: z.number().int().min(0),
  /** Текущая стадия (последний незакрытый замер); нет — между стадиями. */
  stage: z
    .strictObject({
      name: z.string().min(1),
      family: z.string(),
      startedAt: isoTimeSchema,
      elapsedMs: z.number().int().min(0),
    })
    .optional(),
  /** Последний heartbeat — `leaseUntil − leaseMs`; `stale` — срок истёк. */
  lease: z.strictObject({
    owner: z.string().min(1).max(300),
    leaseUntil: z.number().int().min(0),
    leaseMs: z.number().int().positive(),
    /** Нет при сроке `0` (владение отозвано). */
    sinceHeartbeatMs: z.number().int().min(0).optional(),
    stale: z.boolean(),
  }),
  /**
   * Обязательные gates текущей фазы на её текущем SHA:
   * `passed + failed + remaining (+ notApplicable) = required`.
   */
  gates: z.strictObject({
    phase: z.enum(['candidate', 'integration']),
    required: z.number().int().min(0),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    remaining: z.number().int().min(0),
    /** Не исполнены по `when.paths` (нет поля — таких нет). */
    notApplicable: z.number().int().positive().optional(),
    /** Из `passed`: взяты из кандидата при совпавшем дереве (нет поля — таких нет). */
    reused: z.number().int().positive().optional(),
  }),
  /** Живость по обходу controller; `idleMs` — только у `quiet` и `stalled`. */
  liveness: z
    .strictObject({
      state: livenessStateSchema,
      since: isoTimeSchema,
      lastMovementAt: isoTimeSchema,
      idleMs: z.number().int().min(0).optional(),
      activity: activitySchema.optional(),
      action: stallActionSchema.optional(),
    })
    .optional(),
});

/**
 * Почему выдача стоит (`status --detail`): причина паузы (`queueStop`), кто и
 * что её снимает (`queuePause`, то же рассуждение, что у `explain`), классы
 * отказа паузы runtime и последнее сообщение отказа этих классов.
 */
export const queueViewSchema = z.strictObject({
  paused: z.boolean(),
  reason: z.enum(pauseReasons).optional(),
  detail: z.string().optional(),
  since: isoTimeSchema.optional(),
  operation: z.string().optional(),
  /**
   * Пауза есть, но её снимет следующий run (очередь не запускали, штатная
   * остановка, применимый запрос политики) — как в `explain`.
   */
  liftedByRun: z.literal(true).optional(),
  failures: z.array(failureKindSchema).optional(),
  code: z.enum(Object.keys(errorCodes) as [ErrorCode, ...ErrorCode[]]).optional(),
  cause: z.enum(diagnosisCauses).optional(),
  actor: z.enum(diagnosisActors).nullable().optional(),
  action: z.enum(diagnosisActions).optional(),
});

/**
 * Сводка попыток поручения (`status`, `explain`): числа — теми же правилами,
 * что строка поручения отчёта (`attemptSummaryOf`, `src/report/compute.ts`);
 * `line` — та же сводка одной строкой (`attemptSummaryLine`). Ведущий агент
 * на вопрос о сроке цитирует её, а не оценивает время.
 */
export const attemptSummarySchema = z.strictObject({
  /** Записей попыток всего. */
  total: z.number().int().min(0),
  /** Идущие. */
  active: z.number().int().min(0),
  /** Отказы: без прерванных штатной остановкой. */
  failed: z.number().int().min(0),
  /** Отказы по корзинам отчёта (`failureBucketOf`). */
  failures: z
    .array(z.strictObject({ key: z.enum(failureBuckets), count: z.number().int().positive() }))
    .max(failureBuckets.length),
  /** Из отказов — по превышению времени (`timeout`). */
  timeouts: z.number().int().min(0),
  /** Прерванные штатной остановкой controller: не отказы. */
  interrupted: z.number().int().min(0),
  /** 1 — поручение принято принявшей попыткой. */
  accepted: z.number().int().min(0).max(1),
  /**
   * Засчитанные попытки (`attempt` поручения), предел политики и остаток.
   * `used` включает идущую попытку; закончившаяся незасчитанным отказом
   * (окружение, вопрос, штатная остановка) возвращается.
   */
  attempts: z.strictObject({
    used: z.number().int().min(0),
    max: z.number().int().positive(),
    left: z.number().int().min(0),
  }),
  /**
   * Незасчитанные отказы поручения (`neutralFailures`) и их предел: на пределе
   * повтор — только со сбросом человека, и `line` говорит это вместо остатка
   * попыток.
   */
  neutral: z.strictObject({
    used: z.number().int().min(0),
    max: z.number().int().positive(),
  }),
  /** Восстановления задания графа по правилу `explain`; нет — задания нет. */
  repairs: z
    .strictObject({
      used: z.number().int().min(0),
      budget: z.number().int().min(0),
      left: z.number().int().min(0),
    })
    .optional(),
  /**
   * Почему поручение повторяется: последний отказ (последняя по порядку
   * попытка с корзиной `failureBucketOf`) — попытка, корзина, класс, время и
   * причина простыми словами по-русски и по-английски («окружение — порт
   * 3000 занят»). Текст строится из класса отказа, ID gates и номера порта,
   * без свободного текста ошибки; исключение — итог исполнителя
   * незавершённой попытки (`writerSummary`) в кавычках. Нет поля — отказов нет.
   */
  lastFailure: z
    .strictObject({
      runId: z.string().min(1).max(200),
      bucket: z.enum(failureBuckets),
      kind: failureKindSchema.optional(),
      at: isoTimeSchema.optional(),
      plain: z.string().min(1).max(300),
      plainEn: z.string().min(1).max(300),
      /** Справочник причин (0.1.0-alpha.70): `docs/failure-causes.md#…`. */
      reference: z.string().min(1).max(200).optional(),
    })
    .optional(),
  /**
   * Доработка после приёмки (`WorkState.rework`): новая редакция изменила
   * постановку принятого поручения. Числа сводки и предел — только попытки
   * доработки; `earlierRuns` — запусков прежних редакций (в сводку не входят),
   * `acceptedSha`/`acceptedAt` — прежняя приёмка, `fresh` — у доработки свой
   * предел попыток (иначе перенесён). `line` начинается с «принято ранее на
   * <sha>; доработка N: ». Нет поля — доработок не было.
   */
  rework: z
    .strictObject({
      revision: z.number().int().positive(),
      fresh: z.boolean(),
      acceptedSha: gitShaSchema,
      acceptedAt: isoTimeSchema.optional(),
      earlierRuns: z.number().int().min(0),
    })
    .optional(),
  line: z.string().max(1000),
});

/**
 * Этапы поручения для оператора (`works[].stage.name`, `src/control/stage.ts`):
 * ждёт выдачи, не выдаётся, подготовка зависимостей, исполнитель пишет код,
 * проверки, независимое ревью, интеграция, ждёт вопроса исполнителя,
 * остановлено, принято, отменено.
 */
export const workStages = [
  'queued',
  'blocked',
  /** Ревью плана идёт в живом процессе `harness run` (alpha.60): harness сам. */
  'plan-review',
  'prepare',
  'writer',
  'gates',
  'review',
  'integration',
  'input',
  'stopped',
  'done',
  'cancelled',
] as const;
/** Этапы попытки по порядку: `works[].stage.next` — оставшиеся. */
export const pipelineStages = ['writer', 'gates', 'review', 'integration'] as const;

/**
 * Прогресс поручения глазами оператора: текущий этап и время в нём
 * (`since`, `elapsedMs`; у идущей попытки — открытый замер `step` события
 * `attempt.stage`), оставшиеся этапы, что нужно и от кого (`needs` — как у
 * диагноза `explain`; нет поля — неизвестно), собственный расход вызовов
 * поручения и одна строка — по-русски (`line`) и по-английски (`lineEn`).
 * Ведущий агент на вопрос «что сейчас происходит» цитирует строку.
 */
export const workStageSchema = z.strictObject({
  name: z.enum(workStages),
  step: z.string().min(1).max(300).optional(),
  since: isoTimeSchema.optional(),
  elapsedMs: z.number().int().min(0).optional(),
  next: z.array(z.enum(pipelineStages)).max(pipelineStages.length),
  needs: z
    .strictObject({
      actor: z.enum(diagnosisActors).nullable(),
      action: z.enum(diagnosisActions),
    })
    .optional(),
  spend: z.strictObject({
    calls: z.number().int().min(0),
    knownUsd: z.number().min(0),
    unknownCalls: z.number().int().min(0),
    durationMs: z.number().int().min(0),
  }),
  line: z.string().max(1000),
  lineEn: z.string().max(1000),
});

export const statusDataSchema = z.strictObject({
  stateVersion: z.literal(STATE_VERSION),
  /**
   * Обновления по последней проверке `harness update --check` (0.1.0-alpha.60):
   * исход и строка для человека; проверки не было и режим off — поля нет.
   */
  updates: z
    .strictObject({
      state: z.enum([...updateCheckStates, 'not-checked']),
      line: z.string().min(1).max(300),
    })
    .optional(),
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
      /**
       * Активная попытка без движения по обходу controller: `quiet` или
       * `stalled` (с `status --detail` — подробности в `detail.attempts`).
       * Нет поля — движется или не оценивалась.
       */
      liveness: z.enum(['quiet', 'stalled']).optional(),
      resultSha: gitShaSchema.optional(),
      /**
       * Последний незакрытый вопрос исполнителя (H02): ID, состояние, версия
       * и действующая серьёзность, без текста. Нет поля — вопросов нет.
       */
      input: z
        .strictObject({
          requestId: inputRequestSchema.shape.id,
          state: z.enum(inputStateNames),
          version: z.number().int().positive(),
          severity: z.number().int().min(1).max(10),
          /** Кто записал последний ответ; нет поля — ответа нет. */
          answeredBy: z.enum(['operator', 'lead', 'host']).optional(),
          /** Исполнитель пометил вопрос техническим; нет поля — вопрос меняет результат для пользователя. */
          impact: z.literal('technical').optional(),
          /** Правило политики, по которому принят последний ответ ведущего (`technical` — «решено ведущим (технический вопрос)»). */
          answerBasis: z.enum(leadAnswerBases).optional(),
          /** Ждёт ответа, и действующая политика разрешает ответ ведущему — по этому правилу. */
          leadMay: z.enum(leadAnswerBases).optional(),
          /**
           * Попытка, за которой закреплён применённый ответ (alpha.60):
           * `running` — она идёт (состояние тогда `delivered`: ответ уже у
           * попытки, ждать нечего); `false` — она закончилась, не передав
           * ответ исполнителю, и ответ получит следующая попытка.
           */
          carrier: z
            .strictObject({ attempt: z.number().int().positive(), running: z.boolean() })
            .optional(),
        })
        .optional(),
      /** Неблокирующие запросы ведущему в ожидании (автономный режим). */
      followUps: z.number().int().positive().optional(),
      /** Почему поручение сейчас не выдаётся; пусто — может быть выдано. */
      blockers: z.array(blocker),
      /** Сводка попыток и остаток пределов (`attemptSummarySchema`). */
      attemptSummary: attemptSummarySchema.optional(),
      /** Этап, время в нём, что дальше и что нужно от оператора (`workStageSchema`). */
      stage: workStageSchema.optional(),
      /**
       * Что проверено и как: gates и ревью принявшей (иначе последней)
       * попытки и сводная строка (`workVerificationSchema`). Нет поля —
       * попыток нет или идущая попытка ещё ничего не записала.
       */
      verification: workVerificationSchema.optional(),
      /**
       * Принятая работа против текущего target ref (`harness status`): коммиты
       * и файлы после приёмки не проверены. Нет поля — работа не принята или
       * хост его не вычисляет.
       */
      target: acceptedTargetSchema.optional(),
      /**
       * Восстановление ведущим (`policy.recovery.mode: lead`): последний сброс
       * ведущего простыми словами — «ведущий дал ещё N попыток (сброс K из M):
       * причина …; гипотеза …». Нет поля — сброса ведущего в этом пределе нет.
       */
      recovery: z
        .strictObject({ line: z.string().min(1).max(600), lineEn: z.string().min(1).max(600) })
        .optional(),
    }),
  ),
  /**
   * Кто двигает очередь (alpha.60): `running` — живой controller, идущая
   * попытка с действующим владением или ревью плана в живом `harness run`
   * (`planReviews`); `not-running` — никто не запущен, и открытые поручения
   * сдвинет только новый запуск (`restartBy` — кто его делает: ведущий,
   * `harness run`). `line`/`lineEn` — то же одной фразой. Нет поля — открытых
   * поручений нет.
   */
  runner: z
    .strictObject({
      state: z.enum(['running', 'not-running']),
      planReviews: z
        .array(z.strictObject({ graphId: idSchema, since: isoTimeSchema }))
        .max(50)
        .optional(),
      restartBy: z.enum(diagnosisActors).optional(),
      /**
       * alpha.67: сколько открытых работ сдвинет новый запуск (готовы к
       * выдаче или к повтору в пределе попыток), и работы, которые держит
       * только вопрос исполнителя. Оба есть — строка «запустите harness run:
       * готово N задач, вопрос блокирует только X» (ход ведущего).
       */
      ready: z.number().int().min(1).optional(),
      /**
       * alpha.67: ID всех готовых работ (`ready` штук) — представление
       * вычитает из них задачи вопроса владельцу до подсчёта.
       */
      readyWorks: z.array(idSchema).min(1).max(10_000).optional(),
      heldByQuestion: z.array(idSchema).min(1).max(50).optional(),
      line: z.string().min(1).max(500),
      lineEn: z.string().min(1).max(500),
    })
    .optional(),
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
  /**
   * Ревью плана и контрактов: на предмет — итог последнего раунда
   * («одобрено, открытых заметок N»), раунды из предела, расход ревью и
   * эскалация, ждущая решения оператора. Нет поля — раундов ревью нет.
   */
  reviews: z.array(reviewSubjectSummarySchema).max(50).optional(),
  /** Предметов ревью сверх предела строк `reviews` (50); нет поля — все показаны. */
  reviewsTruncated: z.number().int().positive().optional(),
  /**
   * Кто решает после повторных отказов и на технические вопросы — те же
   * тексты, что у панели и doctor (`decisionSettingsSchema`); `--human`
   * печатает итог строкой «Решения: …». Нет поля — этап настройки или
   * ответ до alpha.66.
   */
  decisions: decisionSettingsSchema.optional(),
  /**
   * 0.1.0-alpha.65: harness ещё настраивается — нет `.harness/project.json`
   * (`waitingFor: project`) или привязанного состояния (`state`). Вместо
   * NOT_FOUND — пустой статус с этапом настройки простыми строками
   * («Идёт настройка harness», «Задач пока нет»). Нет поля — состояние есть.
   */
  setup: z
    .strictObject({
      waitingFor: z.enum(['project', 'state']),
      lines: z.array(z.string().min(1).max(200)).min(1).max(5),
      linesEn: z.array(z.string().min(1).max(200)).min(1).max(5),
    })
    .optional(),
  /**
   * 0.1.0-alpha.67: ход настройки, пока работ нет (и до состояния, и с
   * состоянием без графов) — шаги, время и мягкий бюджет настройки
   * (`setupProgressSchema`, docs/infra-works.md). Нет поля — работы есть или
   * раскладка проекта harness (`.harness/`) неизвестна.
   */
  setupProgress: setupProgressSchema.optional(),
  /**
   * 0.1.0-alpha.68: план выпуска ведущего (`harness lead outline`). Записан —
   * `recorded` с редакцией и объёмом (задач); нет, а работы есть и выпуск не
   * закрыт, — `missing` с кодом `RELEASE_OUTLINE_MISSING`: прогноз тогда по
   * зарегистрированным работам. Подсказка, а не блокировка: `run` идёт.
   * Нет поля — работ нет, выпуск закрыт или `status --graph`.
   */
  outline: z
    .strictObject({
      state: z.enum(['recorded', 'missing']),
      code: z.literal('RELEASE_OUTLINE_MISSING').optional(),
      revision: z.number().int().positive().optional(),
      units: z.number().int().positive().optional(),
      stages: z.number().int().positive().optional(),
      line: z.string().min(1).max(300),
      lineEn: z.string().min(1).max(300),
    })
    .optional(),
  /**
   * 0.1.0-alpha.69: приёмка выпуска (`harness review-release`) — требование,
   * состояние, база выпуска (откуда: регистрация графа, план выпуска или
   * ранняя попытка), раунд и блокирующие находки. Нет поля — принятых работ
   * нет или `status --graph`.
   */
  releaseReview: z
    .strictObject({
      required: z.boolean(),
      status: z.enum(['not-run', 'stale', 'findings', 'approved']),
      base: z.string().max(100).optional(),
      baseSource: z.enum(['register', 'outline', 'attempt']).optional(),
      round: z.number().int().positive().optional(),
      blocking: z.number().int().min(0).optional(),
      line: z.string().min(1).max(300),
    })
    .optional(),
  /**
   * Только `status --detail`: время снимка, почему стоит выдача и активные
   * попытки (стадия, длительность, владение, gates). Без флага поля нет.
   */
  detail: z
    .strictObject({
      at: isoTimeSchema,
      queue: queueViewSchema,
      attempts: z.array(attemptViewSchema),
    })
    .optional(),
});

/** Раздел `harness guide` (alpha.71, E3). */
export const guideDataSchema = z.strictObject({
  topic: z.enum(['session', 'setup', 'plan', 'review', 'run', 'recovery', 'release', 'relay']),
  title: z.string().min(1).max(300),
  headings: z.array(z.string().max(300)).max(100),
  text: z.string().min(1).max(100_000),
});

/** Итог `harness wait` (alpha.71, E1). */
export const waitDataSchema = z.strictObject({
  kind: z.enum([
    'accepted',
    'failed',
    'held',
    'question',
    'release-ready',
    'stopped',
    'timeout',
    'aborted',
  ]),
  event: z
    .strictObject({ seq: z.number().int().positive(), type: z.string(), at: isoTimeSchema })
    .optional(),
  workId: idSchema.optional(),
  next: z
    .strictObject({
      actor: z.string().nullable(),
      action: z.string(),
      message: z.string().max(500),
    })
    .optional(),
  status: z.string().max(500),
  /** Номер события, с которого продолжит `wait --after <cursor>` (ревью D/E HIGH-1). */
  cursor: z.number().int().min(0),
  waitedMs: z.number().int().min(0),
});

export const eventsDataSchema = z.strictObject({
  /** Событие неизвестного этой версии типа — `{type: 'unknown', original}`. */
  events: z.array(readRunEventSchema),
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
  /**
   * `run --source` (0.1.0-alpha.68): после закреплённого снимка изменились
   * только необязательные документы задач — согласование действует,
   * исполняется закреплённый снимок; документы вносит новый source-snapshot.
   */
  documentsDrift: z
    .strictObject({
      pinnedRevision: z.string().min(1).max(100),
      freshRevision: z.string().min(1).max(100),
      documents: z
        .array(
          z.strictObject({
            taskKey: z.string().max(200),
            name: z.string().max(300),
            change: z.enum(['added', 'removed', 'changed']),
          }),
        )
        .max(20),
      note: z.string().max(2000),
    })
    .optional(),
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
  /**
   * `cancel` открытой доработки принятого поручения (0.1.0-alpha.66): работа
   * вернулась к принятой редакции (`done`), а не отменена; нет — обычная отмена.
   */
  abandoned: z.literal(true).optional(),
  /**
   * Итог `retry --reset`: сброс выполнен (сколько попыток было потрачено) или
   * не выполнен с объяснением; без `--reset` поля нет.
   */
  reset: z
    .strictObject({
      performed: z.boolean(),
      spent: z.number().int().min(0).optional(),
      note: z.string().optional(),
      /** Сброс ведущего (`--by lead`): разбор, номер сброса из предела и сколько попыток дано. */
      by: z.literal('lead').optional(),
      diagnosis: z.string().optional(),
      index: z.number().int().min(1).optional(),
      cap: z.number().int().min(0).optional(),
      granted: z.number().int().min(1).optional(),
    })
    .optional(),
  /**
   * `retry` (0.1.0-alpha.68): кем исполнен повтор и откуда актёр — `flag`
   * (`--by`) или `default` (без флага и без сессии ведущего: оператор). В
   * открытой сессии ведущего `--by` обязателен.
   */
  by: z.enum(['lead', 'operator']).optional(),
  bySource: z.enum(['flag', 'default']).optional(),
});

/** `harness env-up` / `env-down` / `env-sweep`: сервисы попытки (alpha.70). */
const composePortSchema = z.strictObject({ host: z.string().max(100), port: z.number().int() });
export const envUpDataSchema = z.strictObject({
  project: z.string().max(100),
  ok: z.boolean(),
  services: z.record(
    z.string().max(100),
    z.strictObject({
      ports: z.record(z.string().max(10), composePortSchema),
      state: z.string().max(40).optional(),
      health: z.string().max(40).optional(),
    }),
  ),
  env: z.record(z.string().max(200), z.string().max(10)),
  envFile: z.string().max(4096).optional(),
  warnings: z.array(z.string().max(500)).max(5).optional(),
  readiness: z
    .strictObject({
      services: z.array(
        z.strictObject({
          service: z.string().max(100),
          state: z.string().max(40),
          health: z.string().max(40).optional(),
          exitCode: z.number().int().optional(),
        }),
      ),
      logs: z.record(z.string().max(100), z.string().max(8000)),
      error: z.string().max(4000),
    })
    .optional(),
});
export const envDownDataSchema = z.strictObject({
  project: z.string().max(100),
  ok: z.boolean(),
  error: z.string().max(2000).optional(),
});
export const envSweepDataSchema = z.strictObject({
  ok: z.boolean(),
  /** Без `--yes` — только список. */
  dryRun: z.boolean(),
  stale: z.array(z.string().max(100)),
  removed: z.array(z.string().max(100)),
  kept: z.array(z.string().max(100)),
  /** Проекты hx-* без записи env-up этого состояния — не тронуты. */
  ignored: z.number().int().min(0),
  error: z.string().max(2000).optional(),
});

/** `harness proposal`: решённое предложение исполнителя (alpha.70). */
export const proposalDataSchema = z.strictObject({
  workId: idSchema,
  proposal: workProposalSchema,
});

/** `harness diagnose`: записанный разбор, что дальше и действующее правило. */
export const diagnoseDataSchema = z.strictObject({
  workId: idSchema,
  diagnosis: leadDiagnosisSchema,
  /** Нет у дополнения (`--addendum`): что дальше, оно не меняет. */
  next: z
    .enum(['attempt', 'diagnose', 'replan', 'user-decision', 'lead-reset', 'user-reset'])
    .optional(),
  mode: z.enum(['lead', 'user']).optional(),
  /** Дополнение свежего разбора записано (`--addendum`, 0.1.0-alpha.68). */
  amended: z.literal(true).optional(),
});

export const approveDataSchema = z.strictObject({
  subject: idSchema,
  digest: digestSchema,
  at: isoTimeSchema,
  changed: z.boolean(),
});

export const reapproveDataSchema = z.strictObject({
  subject: idSchema,
  digest: digestSchema,
  at: isoTimeSchema,
  changed: z.boolean(),
  /** `executionDigest` политики, к которой привязано согласование. */
  policyDigest: digestSchema,
  /** Политика прежнего согласования. */
  previousPolicyDigest: digestSchema,
  /** Раунд ревью плана, на котором держится согласование. */
  round: z.number().int().positive().optional(),
});

/** Совместимость с Relay v1 по договору REST и capabilities (alpha.60). */
export const relayCompatibilitySchema = z.strictObject({
  provider: z.literal('relay-v1-http'),
  contractVersion: z.number().int().nullable(),
  taskContext: z.boolean(),
  /** alpha.69: откуда контекст — маршрут сервера или сборка harness из маршрутов Relay 0.13. */
  taskContextSource: z.enum(['server', 'client']).optional(),
  taskContextUsed: z.boolean(),
  level: z.enum(['recommended', 'below-recommended']),
  minimum: z.string(),
  recommended: z.string(),
  line: z.string(),
  lineEn: z.string(),
});

/**
 * Список процессов (`ps`) в песочнице ОС проверок (0.1.0-alpha.66): проба
 * `ps -o pid= -p 1` в той же изоляции, что gates. `unavailable` — gate,
 * вызывающий ps/pgrep/top, упадёт `GATE_SANDBOX_PROCESS_LIST`.
 */
const processListCapabilitySchema = z.strictObject({
  status: z.enum(['available', 'unavailable', 'unknown', 'not-isolated']),
  command: z.array(z.string()).optional(),
  detail: z.string(),
  /** Строка для человека с советом. */
  line: z.string(),
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
  sandbox: z.strictObject({
    os: z.boolean(),
    reason: z.string().optional(),
    /** Список процессов в песочнице проверок (CLI `doctor`). */
    processList: processListCapabilitySchema.optional(),
    /** Сигнал процессу вне песочницы проверок (`kill`), проба harness (0.1.0-alpha.68). */
    signal: processListCapabilitySchema.optional(),
    /** Браузер в песочнице проверок, проба harness (0.1.0-alpha.68). */
    browser: processListCapabilitySchema.optional(),
  }),
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
  /**
   * Закреплённый toolchain политики (`policy.toolchain.node`, 0.1.0-alpha.65):
   * запрошенное, разрешённый каталог и версия, node первым в PATH процесса
   * `doctor` и совпадают ли они. Нет — закрепления нет или оно не разрешилось
   * (тогда строка в `problems`).
   */
  toolchainPin: z
    .strictObject({
      requested: z.string(),
      binDir: z.string(),
      version: z.string(),
      pathNode: z.strictObject({ version: z.string(), path: z.string() }).optional(),
      matches: z.boolean(),
    })
    .optional(),
  /**
   * Порты ресурсов `port` политики: проба без остановки процессов; `leased` —
   * под арендой идущей попытки, не пробуется. Нет — портов в политике нет.
   */
  ports: z
    .array(
      z.strictObject({
        id: z.string(),
        port: z.number().int(),
        status: z.enum(['free', 'busy', 'wildcard-only', 'leased']),
        hosts: z.array(z.string()).optional(),
        holder: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * Ведущий внутри песочницы (например, Codex seatbelt): признаки
   * (`nested-sandbox`, `ps-denied`, `git-readonly:<путь>`, `state-readonly`,
   * `codex-env` — подсказка), совет простыми словами и флаги запуска ведущего.
   * Есть, когда проверка выполнялась (CLI `doctor`).
   */
  leadSandbox: z
    .strictObject({
      inside: z.boolean(),
      signals: z.array(z.string()),
      advice: z.string(),
      adviceEn: z.string(),
      flags: z.string(),
      narrowFlags: z.string(),
    })
    .optional(),
  /**
   * Режим harness (alpha.69): `light` по умолчанию или `strict` (явный выбор
   * владельца, заморожен); строка для человека и граница записи облегчённого
   * режима — механизм и открытые на запись кеши. Есть, когда задана политика.
   */
  mode: z
    .strictObject({
      mode: z.enum(['light', 'strict']),
      default: z.boolean(),
      line: z.string(),
      lineEn: z.string(),
      writeGuard: z
        .strictObject({
          active: z.boolean(),
          mechanism: z.string().optional(),
          reason: z.string().optional(),
          caches: z.array(z.string()).max(200),
        })
        .optional(),
      /**
       * Уровень безопасности (0.1.0-alpha.70): определённый текущий уровень
       * шкалы write-guard → os-user → container → vm (строгий режим —
       * `os-sandbox`); выбирает владелец.
       */
      securityTier: z
        .strictObject({
          current: z.enum(['none', 'write-guard', 'os-user', 'container', 'vm', 'os-sandbox']),
          container: z.boolean(),
          vm: z.boolean(),
          separateUser: z.boolean(),
          line: z.string(),
          lineEn: z.string(),
        })
        .optional(),
    })
    .optional(),
  problems: z.array(z.string()),
  /**
   * Ожидаемые состояния простыми словами — не проблема и не предупреждение:
   * `browser-checks <repo> (<шаги>)` — проверки в браузере среди writerProbe,
   * песочница исполнителя их не запускает.
   */
  notes: z.array(z.string()).optional(),
  /**
   * Настройки решений (есть, когда задана политика): кто решает после
   * повторных отказов и на технические вопросы, с объяснением и итогом —
   * те же тексты, что у панели (`view.settings.decisions`).
   */
  decisions: decisionSettingsSchema.optional(),
  /**
   * Действующее правило ответов на вопросы исполнителя (есть, когда задана
   * политика): технические решает ведущий (`inputPolicy.leadAnswers.technical`),
   * порог ответов ведущего (`maxSeverity`), правило простыми словами.
   */
  questions: z
    .strictObject({
      leadTechnical: z.boolean(),
      maxSeverity: z.number().int().min(1).max(10).optional(),
      line: z.string(),
      lineEn: z.string(),
    })
    .optional(),
  /**
   * Модель и effort каждого назначения политики (alpha.64): `writer <роль>`,
   * `code-review <роль>`, `plan-review`, `contract-review`, запасные reviewer
   * и переопределения репозитория в скобках. Нет `model` — модель runtime по
   * умолчанию. Есть, когда задана политика.
   */
  models: z
    .array(
      z.strictObject({
        use: z.string(),
        runtime: runtimeNameSchema,
        model: z.string().optional(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
      }),
    )
    .optional(),
  /**
   * Предупреждения, не делающие среду негодной; есть, когда задана политика.
   * Источники: порт ресурса занят только на wildcard-адресе, а loopback
   * свободен (служба попытки должна слушать 127.0.0.1); ревью тем же вендором,
   * что автор (`review-same-vendor: …`); сумма пределов шагов
   * одной фазы больше `runTimeoutMs` (`timeBudgetWarnings`); советы о ресурсах
   * машины — `DEPENDENCY_STORE_RECOMMENDED`, `LOW_RESOURCES`,
   * `DIGEST_THREADS_INVALID` (`resourceWarnings`); расхождение manifest
   * проекта рядом с политикой и её полей по слою lean — `LEAN_MISMATCH`;
   * Relay ниже рекомендуемой или несовместим — `RELAY_COMPATIBILITY`;
   * модель Codex или её effort вне `$CODEX_HOME/models_cache.json` —
   * `codex-model-unknown`, `codex-effort-unknown` (alpha.64).
   */
  warnings: z.array(z.string()).optional(),
  /** Сверка Relay по связке (`--source` или connector.json рядом с политикой), alpha.60. */
  relay: z
    .strictObject({
      source: z.string(),
      compatibility: relayCompatibilitySchema.optional(),
      code: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
});

/** Ответ `gates`: исход каждого gate проверки на коммите вне попытки. */
export const gatesDataSchema = z.strictObject({
  /** ID проверки (`runId` evidence, `DEVCONTOUR_RUN_ID` gates). */
  id: z.string().min(1).max(200),
  repositoryId: idSchema,
  sha: gitShaSchema,
  /** Все gates проверки прошли. */
  passed: z.boolean(),
  failFast: z.boolean(),
  /** Проверка прервана сигналом или пределом `runTimeoutMs`: причина. */
  interrupted: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  /** Gates в порядке исполнения (с предпосылками). */
  gates: z.array(
    z.strictObject({
      gate: z.string().min(1).max(200),
      /**
       * `not-run` — не исполнен: не прошла предпосылка или потомки прежнего
       * gate не остановлены или проверка прервана; `skipped` — не исполнен
       * из-за `--fail-fast`; `cancelled` — прерван сигналом или пределом
       * проверки (CLI тогда отвечает отказом `CANCELLED`).
       */
      status: z.enum(['passed', 'failed', 'cancelled', 'not-run', 'skipped']),
      /** Digest определения gate (`gateDigest`, alpha.69). */
      definition: digestSchema.optional(),
      exitCode: z.number().int().optional(),
      summary: z.string().optional(),
      /** Лог gate. */
      log: z.string().optional(),
      message: z.string().optional(),
      /**
       * Фактический toolchain запуска (0.1.0-alpha.65): первый node в PATH
       * окружения проверки, его версия, pnpm при наличии. Успешный запуск —
       * основание сверки провала попытки под другим node.
       */
      toolchain: toolchainFactsSchema.optional(),
      /**
       * Причина отказа среды, названная gate (0.1.0-alpha.66), например
       * `sandbox-process-list` — gate запускает ps, а в песочнице ОС список
       * процессов недоступен. Правка кода её не снимет.
       */
      environment: environmentCauseSchema.optional(),
      /**
       * Выжимка провала (0.1.0-alpha.68): упавшие тесты, строка ошибки, хвост
       * вывода с маской; `withheld` — gate не назвал причину.
       */
      failureSummary: gateFailureSummarySchema.optional(),
    }),
  ),
  /** Каталог логов и артефактов проверки. */
  logs: z.string(),
  /**
   * Предупреждения пробы портов ресурсов: порт на всех адресах держит чужой
   * процесс, loopback свободен (например, AirPlay Receiver на macOS).
   */
  warnings: z.array(z.string()).optional(),
  /**
   * Ответы проб ограничений песочницы ОС проверок, полученные этим процессом
   * harness (0.1.0-alpha.68): сигнал вне песочницы и браузер. Проба идёт,
   * когда провал gate несёт след класса; без неё поля нет.
   */
  sandbox: z
    .strictObject({
      signal: processListCapabilitySchema.optional(),
      browser: processListCapabilitySchema.optional(),
    })
    .optional(),
});

/** Ответ `smoke`: шаги окружения на коммите без gates, их длительность и класс отказа. */

const writerProbeReasonSchema = z.enum([
  'listen-denied',
  'network-denied',
  'network-open',
  'write-denied',
  'process-abort',
  'missing-tool',
  'timeout',
  'no-shell',
  'environment',
  'failed',
]);

/**
 * Исход команды пробы исполнителя: `outside` — проверка в браузере, которую
 * песочница исполнителя не запускает (ожидаемо, не помеха пробе).
 */
const writerProbeCommandSchema = z.strictObject({
  id: z.string().min(1).max(200),
  command: z.array(z.string()),
  status: z.enum(['ok', 'blocked', 'failed', 'outside']),
  exitCode: z.number().int().optional(),
  timedOut: z.boolean().optional(),
  durationMs: z.number().int().nonnegative(),
  reason: writerProbeReasonSchema.optional(),
  evidence: z.string().optional(),
  advice: z.string().optional(),
  log: z.string().optional(),
});

export const smokeDataSchema = z.strictObject({
  /** ID проверки (`DEVCONTOUR_RUN_ID` шагов, каталог логов). */
  id: z.string().min(1).max(200),
  repositoryId: idSchema,
  sha: gitShaSchema,
  /** Все шаги окружения прошли, teardown — тоже. */
  passed: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  /**
   * Шаги в порядке исполнения: `dependencies`, `dependency-build:<репозиторий>`,
   * `worktree`, `setup`, `ready`, `dependency-store`, `prepare`, `teardown`
   * (стадия) и ID шага политики.
   */
  steps: z.array(
    z.strictObject({
      stage: z.string().min(1).max(200),
      id: z.string().min(1).max(200),
      status: z.enum(['passed', 'failed']),
      durationMs: z.number().int().nonnegative(),
      exitCode: z.number().int().optional(),
      timedOut: z.boolean().optional(),
      /** Сигнал, которым завершился процесс упавшего шага (0.1.0-alpha.68). */
      signal: z.string().max(40).optional(),
      /** Хвост вывода упавшего шага с маской секретов (0.1.0-alpha.68). */
      tail: z.string().max(1200).optional(),
      log: z.string().optional(),
      /** Исход хранилища зависимостей: `hit`, `partial`, `miss: причина` (промах — не отказ). */
      detail: z.string().optional(),
      /**
       * Шаг не отказал, но ничего не дал: хранилище зависимостей не использовано
       * (промах, отказ сборки seed; причина — в `detail`). alpha.61.
       */
      unused: z.boolean().optional(),
    }),
  ),
  /** Отказ окружения: класс, где, сообщение и что сделать. */
  failure: z
    .strictObject({
      class: z.enum([
        'port-busy',
        'timeout',
        'crash',
        'missing-tool',
        'cleanup',
        'tree-changed',
        'environment',
      ]),
      stage: z.string().optional(),
      step: z.string().optional(),
      message: z.string(),
      /** Хвост вывода упавшего шага с маской секретов (0.1.0-alpha.68). */
      tail: z.string().max(1200).optional(),
      advice: z.string(),
    })
    .optional(),
  logs: z.string(),
  warnings: z.array(z.string()).optional(),
  /**
   * Список процессов в песочнице проверок (`isolation.mode: os`) и файлы
   * дерева, которые вызывают ps/pgrep/top (до 10).
   */
  processList: processListCapabilitySchema
    .extend({ callers: z.array(z.string()).max(10).optional() })
    .optional(),
  /** Проба исполнителя (`--writer-probe`): команды `writerProbe` в изоляции каждого исполнителя. */
  writerProbe: z
    .strictObject({
      ok: z.boolean(),
      writers: z.array(
        z.strictObject({
          runtime: runtimeNameSchema,
          toolProfile: z.string().optional(),
          roles: z.array(z.string()),
          mechanism: z.enum(['codex-sandbox', 'sandbox-runtime', 'none']),
          network: z.boolean(),
          /** Режим сети исполнителя: `none`, `loopback` (127.0.0.1 и ::1), `full`; `legacy` — профиль без поля `network`. */
          networkMode: z.enum(['none', 'loopback', 'full', 'legacy']).optional(),
          commands: z.array(writerProbeCommandSchema),
          /**
           * Повтор пробы под `network: loopback`: шаги закрыты только
           * локальным портом, а сеть исполнителя закрыта и для него.
           */
          loopback: z
            .strictObject({
              status: z.enum(['resolves', 'not-enough', 'unavailable']),
              steps: z.array(z.string()),
              reason: z.string(),
              decision: z.literal('lead'),
              change: z.strictObject({
                toolProfile: z.string(),
                created: z.boolean(),
                roles: z.array(z.string()),
              }),
              commands: z.array(writerProbeCommandSchema),
            })
            .optional(),
        }),
      ),
      notes: z.array(z.string()).optional(),
      /** Команда, которая применяет найденную сеть loopback и повторяет пробу. */
      loopbackCommand: z.string().optional(),
      /** Сеть loopback применена (`--apply-loopback`): запись с причиной. */
      loopbackApplied: z
        .strictObject({
          policy: z.string(),
          at: z.string(),
          reason: z.string(),
          changes: z.array(
            z.strictObject({
              runtime: runtimeNameSchema,
              toolProfile: z.string(),
              created: z.boolean(),
              roles: z.array(z.string()),
            }),
          ),
          note: z.string(),
        })
        .optional(),
    })
    .optional(),
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

/** Открытый вопрос владельцу из backend (документ `Вопрос: …`), только чтение (alpha.60). */
export const sourceQuestionSchema = z.strictObject({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  revision: z.number().int(),
  question: z.string().optional(),
  options: z.array(z.string()),
  recommendation: z.string().optional(),
  provisional: z.string().optional(),
  targets: z.array(z.string()),
  updatedAt: z.string().optional(),
  url: z.string().optional(),
});
const sourceQuestionsSchema = z.strictObject({
  items: z.array(sourceQuestionSchema),
  total: z.number().int().nonnegative(),
  error: z.string().optional(),
});

const taskContextManifestSchema = z.strictObject({
  status: z.enum(['included', 'too-large']),
  records: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
  digest: digestSchema.optional(),
  reason: z.string().optional(),
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
    z.strictObject({
      ref: z.string(),
      key: z.string().optional(),
      problems: z.array(z.string()),
      /** Контекст исполнения задачи из backend прочитан (`included`) или не помещается (`too-large`). */
      taskContext: z.enum(['included', 'too-large']).optional(),
    }),
  ),
  ownership: ownershipSchema,
  compatibility: relayCompatibilitySchema.optional(),
  /** Предупреждения простыми словами (не отказ): Relay ниже рекомендуемой, задач ещё нет. */
  warnings: z.array(z.string()).optional(),
  problems: z.array(z.string()),
});

/** Закреплённый локальный пакет `tasks[].context`: то, что называет manifest снимка. */
export const localContextManifestSchema = z.strictObject({
  id: idSchema,
  digest: digestSchema,
  files: z.number().int().nonnegative(),
  references: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type LocalContextManifest = z.infer<typeof localContextManifestSchema>;

export const sourceSnapshotDataSchema = z.strictObject({
  connector: idSchema,
  graphId: idSchema,
  graphDigest: digestSchema,
  contextDigest: digestSchema,
  /** Пакеты `tasks[].context`; без них поля нет. */
  localContext: z.array(localContextManifestSchema).optional(),
  /** Semantic digest набора задач (`graph.source.revision`); не Git SHA. */
  revision: digestSchema,
  created: z.boolean(),
  eligible: z.boolean(),
  problems: z.array(z.string()),
  truncated: z.array(z.string()),
  baseline: baselineViewSchema.optional(),
  compatibility: relayCompatibilitySchema.optional(),
  tasks: z.array(
    z.strictObject({
      identity: z.string(),
      key: z.string(),
      orderId: idSchema,
      semanticDigest: digestSchema,
      casRevision: z.number().int(),
      column: z.string(),
      taskContext: taskContextManifestSchema.optional(),
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
  compatibility: relayCompatibilitySchema.optional(),
  warnings: z.array(z.string()).optional(),
  questions: sourceQuestionsSchema.optional(),
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
      /**
       * Принятое поручение, чья задача у получателя не закрыта: сколько
       * критериев докажут текущие привязки (`reprovable`), что не доказано и
       * почему, и следующий шаг (`source-deliver --reprove`, без нового
       * плана). Нет поля — поручение не принято или задача закрыта.
       */
      proof: z
        .strictObject({
          reprovable: z.number().int().min(0),
          unproven: z.array(z.strictObject({ title: z.string(), reason: z.string() })),
          next: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

export const sourceDeliverDataSchema = z.strictObject({
  connector: idSchema,
  /** `source-deliver --reprove`: повторное доказательство критериев принятых результатов. */
  reprove: z.literal(true).optional(),
  deliveries: z.array(
    z.strictObject({
      workId: idSchema,
      outcome: z.string(),
      delivery: z.array(deliveryStateSchema),
    }),
  ),
  /** Только `--reprove` без `--work`: поручения без принятого результата. */
  skipped: z.array(z.strictObject({ workId: idSchema, reason: z.string() })).optional(),
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
  z.strictObject({
    status: z.literal('cleaned'),
    receipts: z.array(z.string()),
    /**
     * 0.1.0-alpha.67, `cleanup LS-…`: записи smoke, сверенные без teardown —
     * рабочего дерева и ресурсов Docker с меткой прогона уже нет (событие
     * `environment.reconciled`).
     */
    reconciled: z
      .array(
        z.strictObject({
          receipt: z.string(),
          from: z.enum(['cleanup-failed', 'active']),
          worktree: z.literal('absent'),
          docker: z.enum(['absent', 'not-used']),
        }),
      )
      .optional(),
  }),
]);

export const worktreeCleanupDataSchema = z.strictObject({
  dryRun: z.boolean(),
  removed: z.number().int(),
  removable: z.number().int(),
  refused: z.number().int(),
  failed: z.number().int(),
  reclaimedKb: z.number().int(),
  worktrees: z.array(
    z.strictObject({
      path: z.string(),
      repositoryId: z.string(),
      attemptId: z.string().optional(),
      action: z.enum(['remove', 'removed', 'refused', 'failed']),
      reason: z
        .enum([
          'active',
          'recoverable',
          'cleanup-pending',
          'cleanup-unreadable',
          'unknown-attempt',
          'untrusted',
          'embedded-repository',
          'scan-limit',
          'scan-failed',
          'read-only-path',
          'undecodable-path',
          'worktree-locked',
          'clean-filter',
          'tree-changed',
          'ignore-rules-changed',
          'hidden-changes',
          'staged-ignored',
          'staged-differs',
          'unreachable-head',
          'patch-unusable',
          'removal-incomplete',
          'not-registered',
        ])
        .optional(),
      error: z.string().optional(),
      head: z.string().optional(),
      sizeKb: z.number().int().optional(),
      uncommitted: z.number().int().optional(),
      ignored: z.strictObject({ count: z.number().int(), paths: z.array(z.string()) }).optional(),
      record: z.string().optional(),
      removalStarted: z.boolean().optional(),
      registered: z.boolean().optional(),
      treePresent: z.boolean().optional(),
      patch: z.string().optional(),
    }),
  ),
});

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
  /** Ведущий и откуда он взят: `--lead`, manifest, writer прежнего manifest, сохранённая политика, окружение, `--writer`. */
  lead: z.strictObject({
    runtime: z.enum(['claude', 'codex']),
    source: z.enum(['option', 'manifest', 'legacy-writer', 'policy', 'env', 'writer']),
  }),
  /**
   * Решение о ревью: `cross` или `same`; источник — `--review`, manifest,
   * прежний manifest (`legacy`), сохранённая политика или выбор `auto` по
   * доступности CLI.
   */
  review: z.strictObject({
    mode: z.enum(projectReviewModes),
    source: z.enum(['option', 'manifest', 'legacy', 'policy', 'auto']),
  }),
  /** Наличие CLI runtime (`--version`) и вход (`claude auth status`, `codex login status`). */
  runtimes: z.array(
    z.strictObject({
      runtime: z.enum(['claude', 'codex']),
      status: z.enum(['available', 'missing', 'version-error']),
      version: z.string().optional(),
      auth: z.enum(['ok', 'missing', 'unknown']),
    }),
  ),
  /**
   * Кто отвечает на вопросы исполнителя, останавливающие работу, при
   * действующей политике: технические решает ведущий (`leadTechnical`,
   * `inputPolicy.leadAnswers.technical`; `init --lead-technical-answers`) или
   * все — человек; `maxSeverity` — прежний порог ответов ведущего. Источник —
   * флаг для новой политики, сохранённая политика или умолчание; `line` /
   * `lineEn` — правило простыми словами. Нет поля — ответ до alpha.55.
   */
  questions: z
    .strictObject({
      leadTechnical: z.boolean(),
      maxSeverity: z.number().int().min(1).max(10).optional(),
      source: z.enum(['option', 'policy', 'default']),
      line: z.string(),
      lineEn: z.string(),
    })
    .optional(),
  /** Настройки решений новой или сохранённой политики (`decisionSettingsSchema`). */
  decisions: decisionSettingsSchema.optional(),
  /**
   * Закреплённый node новой политики (`policy.toolchain.node`,
   * 0.1.0-alpha.65): версия и откуда она — `.nvmrc`, `.node-version`,
   * `package.json engines.node` (точная и установленная) или node, который
   * запустил init. Нет — политика сохранена прежде, закрепление не менялось.
   */
  toolchainPin: z
    .strictObject({ node: z.string(), version: z.string(), source: z.string() })
    .optional(),
  /** Предупреждения подготовки: не отказ, но требуют внимания до запуска. */
  warnings: z.array(
    z.strictObject({
      code: z.enum(initWarningCodes),
      message: z.string(),
    }),
  ),
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

/**
 * `lean`: включение или выключение слоя `lean` в подготовленном проекте —
 * изменения полей политики и manifest (план или применённые).
 */
export const leanDataSchema = z.strictObject({
  mode: z.enum(['plan', 'apply']),
  layer: z.literal('lean'),
  /** Слой включён до вызова (`profile.layers` manifest). */
  enabledBefore: z.boolean(),
  /** Слой включён после вызова (`apply`) или после применения плана (`plan`). */
  enabled: z.boolean(),
  /** Есть изменения файлов: в плане — будут, в `apply` — записаны. */
  changed: z.boolean(),
  root: z.string(),
  policyPath: z.string(),
  manifestPath: z.string(),
  /**
   * Изменения полей: файл, путь поля, значение до и после (нет `before` —
   * поля не было, нет `after` — поле удаляется).
   */
  changes: z.array(
    z.strictObject({
      file: z.enum(['policy', 'manifest']),
      field: z.string(),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
    }),
  ),
  /** Пояснения: явные значения, которые слой заменил, расхождения, переформатирование. */
  notes: z.array(z.string()),
  /**
   * Почему изменение не применяется: идёт run (`CONTROLLER_BUSY`) или поле
   * изменено вручную после включения (`PATH_CONFLICT`). В плане — данные и
   * exit 3; без `--plan` — отказ с тем же кодом до записи.
   */
  problems: z.array(
    z.strictObject({
      code: z.enum(['CONTROLLER_BUSY', 'PATH_CONFLICT']),
      field: z.string().optional(),
      message: z.string(),
    }),
  ),
  /** `policyDigest` политики до и после: согласования прежней политики устаревают. */
  policyDigest: z.strictObject({ before: digestSchema, after: digestSchema }),
  /** Графы, согласованные под прежней политикой: после смены — `APPROVAL_STALE`, нужен review-plan. */
  staleApprovals: z.array(idSchema),
  next: z.array(
    z.strictObject({ command: z.string(), args: z.array(z.string()), why: z.string() }),
  ),
});

/** `explain`: объяснения остановок. */
export const explainDataSchema = z.strictObject({
  diagnoses: z.array(stopDiagnosisSchema),
  /**
   * alpha.67 (P5-4): следующий шаг очереди, когда никто не запущен, а
   * готовые работы есть — новый `harness run` ведущего; `heldByQuestion` —
   * работы, которые держит только вопрос. Та же строка, что `status.runner`.
   */
  queue: z
    .strictObject({
      actor: z.literal('lead'),
      action: z.literal('start-run'),
      ready: z.number().int().min(1),
      heldByQuestion: z.array(idSchema).min(1).max(50).optional(),
      line: z.string().min(1).max(500),
      lineEn: z.string().min(1).max(500),
    })
    .optional(),
  /** Сводка попыток по каждому поручению выбора (`--work` — одно), в порядке состояния. */
  attempts: z
    .array(z.strictObject({ workId: idSchema, ...attemptSummarySchema.shape }))
    .max(100)
    .optional(),
  /** Поручений сверх предела строк `attempts` (100); нет поля — все показаны. */
  attemptsTruncated: z.number().int().positive().optional(),
  /**
   * Что проверено и как по каждому поручению выбора с попытками — та же
   * проверка, что `status` (`workVerificationSchema`); строк не больше 100.
   */
  verification: z
    .array(z.strictObject({ workId: idSchema, ...workVerificationSchema.shape }))
    .max(100)
    .optional(),
  /** Сводка ревью плана и контрактов — та же, что у `status`; нет поля — раундов нет. */
  reviews: z.array(reviewSubjectSummarySchema).max(50).optional(),
  /** Предметов ревью сверх предела строк `reviews` (50); нет поля — все показаны. */
  reviewsTruncated: z.number().int().positive().optional(),
});

const requestIdSchema = inputRequestSchema.shape.id;

export const inputListDataSchema = z.strictObject({
  requests: z.array(
    z.strictObject({
      id: requestIdSchema,
      workId: idSchema,
      kind: z.enum(['question', 'follow-up']),
      blocking: z.boolean(),
      lifecycle: z.enum(inputLifecycles),
      state: z.enum(inputStateNames).optional(),
      severity: z.number().int().min(1).max(10),
      version: z.number().int().positive(),
      answers: z.number().int().min(0),
      createdAt: isoTimeSchema,
    }),
  ),
});
export const inputAnswerDataSchema = z.strictObject({
  request: inputRequestSchema,
  answer: inputAnswerSchema,
  changed: z.boolean(),
});
export const inputContextDataSchema = z.strictObject({
  requestId: requestIdSchema,
  answerDigest: digestSchema,
  digest: digestSchema,
  out: z.string().min(1),
});
export const inputTargetDataSchema = z.strictObject({
  requestId: requestIdSchema,
  target: inputTargetSchema.optional(),
  problems: z.array(z.string()),
});
export const inputApplyDataSchema = z.strictObject({
  requestId: requestIdSchema,
  applied: z.boolean(),
  changed: z.boolean(),
  lifecycle: z.enum(inputLifecycles),
  work: z
    .strictObject({ id: idSchema, status: workStatusSchema, attempt: z.number().int().min(0) })
    .optional(),
  active: z.array(z.strictObject({ id: z.string().min(1), workId: idSchema })).optional(),
  joint: z.literal(true).optional(),
  blocker: blocker.optional(),
});
/** Ответ `input-resolve` и `input-carry`: что сделано за один вызов. */
const inputResolveFields = {
  requestId: requestIdSchema,
  changed: z.boolean(),
  lifecycle: z.enum(inputLifecycles),
  /** Снимок с ответом (хранится по digest). */
  contextDigest: digestSchema.optional(),
  /** Раунд ревью плана, на котором основано применение. */
  reviewRound: z.number().int().positive().optional(),
  /** `reused` — прежний одобренный раунд этого снимка; `new` — проведён сейчас. */
  reviewed: z.enum(['reused', 'new']).optional(),
  work: z
    .strictObject({ id: idSchema, status: workStatusSchema, attempt: z.number().int().min(0) })
    .optional(),
  active: z.array(z.strictObject({ id: z.string().min(1), workId: idSchema })).optional(),
  joint: z.literal(true).optional(),
  blocker: blocker.optional(),
};
export const inputResolveDataSchema = z.strictObject({
  ...inputResolveFields,
  applied: z.boolean(),
});
export const inputCarryDataSchema = z.strictObject({
  ...inputResolveFields,
  carried: z.boolean(),
  /** Вопрос заменён этим вызовом (исходная остановка не держалась). */
  superseded: z.boolean(),
});
export const inputCloseDataSchema = z.strictObject({
  requestId: requestIdSchema,
  lifecycle: z.enum(inputLifecycles),
  version: z.number().int().positive(),
  changed: z.boolean(),
});

/** Схема `data` каждой команды. */
export const cliDataSchemas = {
  validate: validateDataSchema,
  'review-plan': reviewRecordSchema,
  'review-contract': reviewRecordSchema,
  'review-accept': reviewAcceptDataSchema,
  approve: approveDataSchema,
  reapprove: reapproveDataSchema,
  run: runDataSchema,
  status: statusDataSchema,
  events: eventsDataSchema,
  wait: waitDataSchema,
  guide: guideDataSchema,
  pause: controlDataSchema,
  resume: controlDataSchema,
  cancel: workActionDataSchema,
  retry: workActionDataSchema,
  diagnose: diagnoseDataSchema,
  proposal: proposalDataSchema,
  'env-up': envUpDataSchema,
  'env-down': envDownDataSchema,
  'env-sweep': envSweepDataSchema,
  result: resultEnvelopeSchema,
  deliver: resultEnvelopeSchema,
  cleanup: cleanupDataSchema,
  'worktree-cleanup': worktreeCleanupDataSchema,
  profile: profileDataSchema,
  doctor: doctorDataSchema,
  init: initDataSchema,
  explain: explainDataSchema,
  lean: leanDataSchema,
  report: reportDataSchema,
  handoff: handoffPackSchema,
  'plan-request': planRequestDataSchema,
  'plan-check': planCheckDataSchema,
  capabilities: operationCatalogSchema,
  view: viewDataSchema,
  'source-check': sourceCheckDataSchema,
  'source-snapshot': sourceSnapshotDataSchema,
  'source-status': sourceStatusDataSchema,
  'source-deliver': sourceDeliverDataSchema,
  'source-reconcile': sourceReconcileDataSchema,
  'input-list': inputListDataSchema,
  'input-show': inputRequestSchema,
  'input-answer': inputAnswerDataSchema,
  'input-context': inputContextDataSchema,
  'input-target': inputTargetDataSchema,
  'input-apply': inputApplyDataSchema,
  'input-cancel': inputCloseDataSchema,
  'input-supersede': inputCloseDataSchema,
  'input-resolve': inputResolveDataSchema,
  'input-carry': inputCarryDataSchema,
  gates: gatesDataSchema,
  'review-code': codeReviewRecordSchema,
  'review-release': codeReviewRecordSchema,
  smoke: smokeDataSchema,
  update: updateDataSchema,
  'lead-begin': leadDataSchema,
  'lead-note': leadDataSchema,
  'lead-end': leadDataSchema,
  'release-done': leadDataSchema,
  'lead-outline': outlineDataSchema,
  'preview-start': previewStartDataSchema,
  'preview-stop': previewStopDataSchema,
  'preview-list': previewListDataSchema,
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

/**
 * Нарушение схемы внутри harness (ответ команды вне договора, собственная
 * запись) — дефект, а не ошибка ввода: INTERNAL с путями полей вместо дампа
 * ZodError в сообщении.
 */
export const contractViolation = (error: z.ZodError) =>
  new HarnessError(
    'INTERNAL',
    'Данные harness не соответствуют его договору (дефект harness, а не настроек): ' +
      error.issues.map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`).join('; '),
    error.issues.map((i) => ({
      path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
      message: i.message,
    })),
  );

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
