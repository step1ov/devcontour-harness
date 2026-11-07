import { z } from 'zod';
import {
  digestSchema,
  gitShaSchema,
  idSchema,
  isoTimeSchema,
  relativePathSchema,
} from './primitives.ts';
import { sourceRefSchema } from './work.ts';
import { digestOf } from './digest.ts';

/**
 * Вопрос исполнителя и продолжение после ответа (H02).
 *
 * Writer, не сумевший закончить без решения человека или ведущего, отдаёт
 * вместе с `completed: false` вопрос (`inputRequest`); более мелкие развилки
 * он решает сам и записывает допущением (`assumptions`). Где проходит
 * граница — задаёт `inputPolicy` политики: порог серьёзности, закреплённый в
 * попытке при выдаче, и критические пути. Самооценку модели controller
 * поднимает до потолка (10), когда вопрос касается критической области
 * (`affects`) или попытка изменила критический путь: модель этих минимумов
 * понизить не может.
 *
 * Канонический запрос (`InputRequest`) хранится в локальном пространстве
 * `input-requests` у владельца-репозитория. Вопрос и основание исходной
 * попытки неизменяемы; ответы только дополняются; применение называет
 * точный digest ответа и проверенное основание продолжения (`target`).
 */

/** Области, вопрос о которых всегда критичен: их меняет только согласование, а не исполнитель. */
export const criticalAreas = ['contract', 'acceptance', 'product', 'api', 'migration'] as const;
export const criticalAreaSchema = z.enum(criticalAreas);
export type CriticalArea = (typeof criticalAreas)[number];

/** Пределы вопроса и ответа — как у вопросов подготовки DevContour. */
export const INPUT_LIMITS = {
  question: 1500,
  answer: 3000,
  options: 6,
  answers: 20,
  assumptions: 20,
  rationale: 2000,
} as const;

/** Потолок серьёзности; порог 11 — полностью автономный режим (исполнитель не останавливается). */
export const INPUT_SEVERITY_MAX = 10;
export const INPUT_AUTONOMOUS = 11;

const severitySchema = z.number().int().min(1).max(INPUT_SEVERITY_MAX);

export const inputOptionSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Ожидается ID варианта [A-Za-z0-9_-]{1,40}'),
  label: z.string().min(1).max(300),
  /** Чем обернётся выбор этого варианта; `null` — исполнитель не назвал. */
  consequence: z.string().max(1000).nullable(),
});
export type InputOption = z.infer<typeof inputOptionSchema>;

/**
 * Вопрос исполнителя: текст, варианты (до шести), рекомендуемый вариант,
 * самооценка серьёзности по шкале запроса (1 — косметика, обратимо, локально;
 * 10 — меняет требования, договор, модель данных, безопасность или все
 * задачи), основание оценки и затронутые критические области.
 */
export const inputQuestionSchema = z
  .strictObject({
    question: z.string().min(1).max(INPUT_LIMITS.question),
    options: z.array(inputOptionSchema).max(INPUT_LIMITS.options),
    recommended: z.string().max(40).nullable(),
    severity: severitySchema,
    rationale: z.string().max(INPUT_LIMITS.rationale),
    affects: z.array(criticalAreaSchema).max(criticalAreas.length),
  })
  .superRefine((q, ctx) => {
    const ids = q.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Повтор ID варианта' });
    if (q.recommended !== null && !ids.includes(q.recommended))
      ctx.addIssue({
        code: 'custom',
        path: ['recommended'],
        message: 'Рекомендуемый вариант не входит в варианты',
      });
  });
export type InputQuestion = z.infer<typeof inputQuestionSchema>;

/** Развилка, которую исполнитель решил сам: вопрос, выбор, основание, самооценка, области. */
export const assumptionSchema = z.strictObject({
  question: z.string().min(1).max(INPUT_LIMITS.question),
  chosen: z.string().min(1).max(300),
  rationale: z.string().max(INPUT_LIMITS.rationale),
  severity: severitySchema,
  affects: z.array(criticalAreaSchema).max(criticalAreas.length),
});
export type Assumption = z.infer<typeof assumptionSchema>;

/** Почему серьёзность поднята до потолка: объявленная область или изменённый критический путь. */
export const inputFloors = ['declared', 'critical-path'] as const;
export const inputFloorSchema = z.enum(inputFloors);
export type InputFloor = (typeof inputFloors)[number];

/** Допущение попытки с оценкой controller: действующая серьёзность и сработавшие минимумы. */
export const recordedAssumptionSchema = assumptionSchema.extend({
  effectiveSeverity: severitySchema,
  floors: z.array(inputFloorSchema).max(inputFloors.length),
});
export type RecordedAssumption = z.infer<typeof recordedAssumptionSchema>;

/**
 * Политика вопросов исполнителя. `threshold` 1–10: вопрос с действующей
 * серьёзностью не ниже порога останавливает попытку (`needs-input`), ниже —
 * исполнитель решает сам и записывает допущение. 11 — полностью автономный
 * режим: остановок нет, каждое решение — допущение; критические — ещё и
 * неблокирующий запрос ведущему (follow-up), утверждённое не меняется.
 * `criticalPaths` — пути (как `writeScope`: каталог или файл), изменение
 * которых делает вопрос и допущение попытки критическими.
 *
 * Политика закрепляется в попытке при выдаче: новое значение действует со
 * следующей попытки. В `executionDigest` она не входит — смена порога не
 * требует нового согласования графа и не меняет основания reuse.
 */
export const inputPolicySchema = z.strictObject({
  threshold: z.number().int().min(1).max(INPUT_AUTONOMOUS).default(7),
  criticalPaths: z.array(relativePathSchema).max(50).default([]),
});
export type InputPolicy = z.infer<typeof inputPolicySchema>;
export const DEFAULT_INPUT_POLICY: InputPolicy = { threshold: 7, criticalPaths: [] };

/** Кто ответил или закрыл запрос: оператор, ведущий агент или хост от их имени. */
export const inputActorSchema = z.strictObject({
  kind: z.enum(['operator', 'lead', 'host']),
  id: z.string().min(1).max(200).optional(),
});
export type InputActor = z.infer<typeof inputActorSchema>;

/**
 * Ответ — неизменяемая запись. `kind`: `clarification` — уточнение той же
 * работы (продолжение через `applyInput`), `requirement-change` — изменение
 * требований (обычная ревизия и `supersede`, не продолжение). `messageRef` —
 * непрозрачная ссылка хоста на сообщение обсуждения. `digest` —
 * `answerDigest(requestId, answer)`.
 */
export const inputAnswerSchema = z.strictObject({
  revision: z.number().int().positive(),
  text: z.string().min(1).max(INPUT_LIMITS.answer),
  optionId: z.string().max(40).nullable(),
  kind: z.enum(['clarification', 'requirement-change']),
  actor: inputActorSchema,
  messageRef: z.string().min(1).max(300).optional(),
  digest: digestSchema,
  at: isoTimeSchema,
});
export type InputAnswer = z.infer<typeof inputAnswerSchema>;

/** Digest ответа: запрос, номер версии и содержание (без времени). */
export const answerDigest = (
  requestId: string,
  answer: Pick<InputAnswer, 'revision' | 'text' | 'optionId' | 'kind'>,
) =>
  digestOf({
    requestId,
    revision: answer.revision,
    text: answer.text,
    optionId: answer.optionId,
    kind: answer.kind,
  });

/**
 * Основание исходной попытки: откуда вопрос. Неизменяемо. `inputPolicy` —
 * закреплённая в попытке политика, по которой вопрос стал остановкой.
 */
export const inputOriginSchema = z.strictObject({
  source: sourceRefSchema,
  graphId: idSchema,
  graphDigest: digestSchema,
  orderDigest: digestSchema,
  policyDigest: digestSchema,
  contextDigest: digestSchema.nullable(),
  baseSha: gitShaSchema.nullable(),
  inputPolicy: inputPolicySchema,
  /**
   * Digest содержания постановки без ревизии источника: изменение
   * требований переносится, только если изменилось содержание, а не одна
   * ревизия (пересинхронизация трекера). Нет поля — запрос прежней версии.
   */
  contentDigest: digestSchema.optional(),
});
export type InputOrigin = z.infer<typeof inputOriginSchema>;

/**
 * Основание продолжения, которое активирует `applyInput`: тот же граф и
 * постановка, проверенный снимок контекста с ответом, раунд ревью плана и
 * актёр согласования. `digest` — `targetDigest(target)`.
 */
export const inputTargetSchema = z.strictObject({
  originDigest: digestSchema,
  answerDigest: digestSchema,
  graphDigest: digestSchema,
  orderDigest: digestSchema,
  /**
   * Содержание постановки без ревизии источника на момент цели: по нему, а
   * не по `orderDigest`, судится устаревание (пересинхронизация трекера одной
   * ревизией цель не обесценивает). Нет поля — цель прежней версии.
   */
  contentDigest: digestSchema.optional(),
  policyDigest: digestSchema,
  contextDigest: digestSchema.nullable(),
  review: z
    .strictObject({
      round: z.number().int().positive(),
      approved: z.boolean(),
      reviewerBinding: digestSchema.nullable(),
    })
    .nullable(),
  actor: z.enum(['agent', 'operator']),
  digest: digestSchema,
});
export type InputTarget = z.infer<typeof inputTargetSchema>;
export const targetDigest = (target: Omit<InputTarget, 'digest'>) => digestOf(target);

export const inputLifecycles = [
  'pending',
  'answered',
  'applied',
  'cancelled',
  'superseded',
] as const;
export type InputLifecycle = (typeof inputLifecycles)[number];

/**
 * Состояние вопроса для проекций (`projections/input.ts` повторяет перечень
 * без zod; тест сверяет оба): ждёт ответа, ответ не применён, применён и ждёт
 * вызова, передан исполнителю.
 */
export const inputStateNames = [
  'awaiting-answer',
  'answered-not-applied',
  'applied-awaiting-claim',
  'delivered',
  'carry-stale',
] as const;

/**
 * Канонический запрос. `kind`: `question` — остановка попытки (блокирует
 * claim, retry, repair и finish, пока `pending` или `answered`);
 * `follow-up` — неблокирующий запрос ведущему из автономного режима или
 * отклонённого вопроса ниже порога. `blocking` — блокирует ли запрос
 * работу. `draft` — черновик попытки (digest и файлы `AttemptState.partial`).
 * `version` — CAS записи.
 */
/** Запись закрытия запроса: кто, когда и почему; у замены — преемник и перенос. */
const inputClosedSchema = z.strictObject({
  at: isoTimeSchema,
  by: z.enum(['operator', 'lead', 'host', 'controller']),
  reason: z.string().min(1).max(1000),
  /** Преемник (новая работа или запрос), у `superseded`. */
  successor: z.string().min(1).max(200).optional(),
  /**
   * Только у `superseded`: исходная остановка уже не держалась (новая
   * редакция графа или постановки, другая попытка) — последний ответ
   * можно перенести в контекст новой редакции. `false` или нет поля —
   * перенос запрещён: продолжение остановки — только `applyInput`.
   */
  carry: z.boolean().optional(),
});

export const inputRequestSchema = z.strictObject({
  id: z.string().regex(/^IR-[a-f0-9]{24}$/, 'Ожидается ID запроса IR-<24 hex>'),
  kind: z.enum(['question', 'follow-up']),
  blocking: z.boolean(),
  workId: idSchema,
  graphId: idSchema,
  runId: z.string().min(1).max(200),
  attempt: z.number().int().positive(),
  /** Вызов исполнителя, в ответе которого пришёл вопрос; `null` — неизвестен. */
  callId: z.string().min(1).max(200).nullable(),
  question: inputQuestionSchema,
  effectiveSeverity: severitySchema,
  floors: z.array(inputFloorSchema).max(inputFloors.length),
  /** Изменённые попыткой критические пути (не больше 20). */
  criticalHits: z.array(z.string().min(1).max(500)).max(20),
  draft: z
    .strictObject({ digest: digestSchema, files: z.array(z.string().max(500)).max(500) })
    .nullable(),
  createdAt: isoTimeSchema,
  originBasis: inputOriginSchema,
  lifecycle: z.enum(inputLifecycles),
  answers: z.array(inputAnswerSchema).max(INPUT_LIMITS.answers),
  target: inputTargetSchema.optional(),
  /** Начало вызова runtime попытки, получившей ответ: только по факту вызова. */
  delivered: z
    .strictObject({
      runId: z.string().min(1).max(200),
      callId: z.string().min(1).max(200),
      at: isoTimeSchema,
    })
    .optional(),
  closed: inputClosedSchema
    .extend({
      /**
       * Прежнее закрытие, которое это закрытие сменило: снятие устаревшего
       * переноса (`superseded` → `cancelled`) сохраняет запись замены —
       * преемника, решение о переносе и причину.
       */
      previous: inputClosedSchema.optional(),
    })
    .optional(),
  /**
   * Применённое основание устарело до выдачи попытки с ответом (сменились
   * согласованный снимок, граф, постановка или политика): запрос возвращён в
   * `answered`, работа снова ждёт применения — ответ не теряется молча.
   */
  stale: z
    .strictObject({
      targetDigest: digestSchema,
      reason: z.enum(['context', 'graph', 'order', 'policy']),
      at: isoTimeSchema,
    })
    .optional(),
  /**
   * Ответ writer был вне схемы, и controller привёл вопрос к ней (усёк
   * текст, исправил ID вариантов, ограничил серьёзность): что именно
   * исправлено. Нет поля — вопрос пришёл в схеме.
   */
  normalized: z.array(z.string().min(1).max(300)).min(1).max(10).optional(),
  version: z.number().int().positive(),
});
export type InputRequest = z.infer<typeof inputRequestSchema>;

/** Вопрос или допущение с оценкой controller. */
export interface RatedInput {
  question: InputQuestion;
  effectiveSeverity: number;
  floors: InputFloor[];
}

/**
 * Что ответ writer оставил движку вместе с исходом попытки: вопрос
 * (`question` — остановка `needs-input`, `declined` — вопрос ниже порога у
 * незавершённой попытки), допущения с оценкой, неблокирующие запросы ведущему
 * (автономный режим), изменённые критические пути и вызов, в ответе которого
 * всё это пришло. Только память процесса: сохраняется движком в
 * `input-requests` и `AttemptState.assumptions`.
 */
export interface InputOutcome {
  question?: RatedInput & { mode: 'request' | 'declined' };
  assumptions: RecordedAssumption[];
  followUps: RatedInput[];
  criticalHits: string[];
  callId: string | null;
  /** Ответ был вне схемы: что controller исправил, чтобы не потерять вопрос. */
  normalized?: string[];
}

/** Запрос держит работу: вопрос, ещё не применённый и не закрытый. */
export const blocksWork = (
  r: Pick<InputRequest, 'blocking' | 'lifecycle'> & Partial<Pick<InputRequest, 'stale' | 'target'>>,
) =>
  r.blocking &&
  (r.lifecycle === 'pending' ||
    r.lifecycle === 'answered' ||
    // Перенесённый ответ, основание которого устарело до выдачи: работа ждёт
    // нового переноса, а не идёт без ответа.
    (r.lifecycle === 'superseded' && !!r.stale && !r.target));

/** Ответ запроса связан с основанием выдачи: применённый или перенесённый. */
export const linksAnswer = (r: Pick<InputRequest, 'kind' | 'lifecycle' | 'target'>) =>
  r.kind === 'question' &&
  !!r.target &&
  (r.lifecycle === 'applied' || r.lifecycle === 'superseded');

/** Последний ответ запроса. */
export const latestAnswer = (r: Pick<InputRequest, 'answers'>) => r.answers.at(-1);

/** ID запроса: детерминированный от попытки и порядкового номера внутри неё. */
export const inputRequestId = (runId: string, index: number) =>
  'IR-' + digestOf({ runId, index }).slice(0, 24);

/** Вид источника контекста с ответом на запрос. */
export const INPUT_SOURCE_KIND = 'input-answer';
/** ID источника контекста ответа на запрос `requestId`. */
export const inputSourceId = (requestId: string) => 'input-' + requestId.slice(3);

/**
 * Manifest источника ответа: какой запрос, какой точно ответ (digest и
 * версия) и какие сообщения обсуждения хоста (ID, версия, digest) включены.
 */
export const inputManifestSchema = z.strictObject({
  requestId: inputRequestSchema.shape.id,
  answerDigest: digestSchema,
  revision: z.number().int().positive(),
  messages: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        revision: z.number().int().min(0),
        digest: digestSchema,
      }),
    )
    .max(50),
});
export type InputManifest = z.infer<typeof inputManifestSchema>;
