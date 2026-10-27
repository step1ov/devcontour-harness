import { z } from 'zod';
import { API_VERSION } from './version.ts';
import {
  digestSchema,
  gitShaSchema,
  idSchema,
  relativePathSchema,
  trimmedText,
} from './primitives.ts';
import { propertyIdSchema } from './work.ts';

/**
 * Договор проверки: структурированное описание существенных обязательств.
 *
 * Обязательство связывает существующие требования и критерии приёмки с
 * property ID, областью входов, правилами ответа, независимым способом
 * проверки и покрытием. Второго реестра требований здесь нет: property ID —
 * тот же, что testcase в JUnit и `testId` в отчёте свойств.
 *
 * Схема отклоняет структурные пропуски до вызова модели. Достаточность
 * описания и независимость эталона оценивает reviewer контракта.
 */
const text = (max = 2000) => z.string().trim().min(3).max(max);
const familyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const promiseKinds = [
  'functional',
  'accuracy',
  'optimality',
  'completeness',
  'performance',
  'invariant',
  'other',
] as const;
/** Вычислительные обещания: без независимого способа проверки их не утверждают. */
export const strongPromises: ReadonlySet<string> = new Set([
  'accuracy',
  'optimality',
  'completeness',
  'performance',
]);
/**
 * Проверка по закреплённым эталонным наборам (`verification: 'reference'`).
 *
 * Ответы независимого эталона (решатель, полный перебор, таблица DP)
 * получены заранее, сверены с другим способом на семействах входов и
 * закреплены артефактами контракта. Gate сверяет реализацию с наборами и
 * отчитывается тем же отчётом свойств: число проверенных входов по свойству
 * и по семействам. Каждый набор принадлежит одному gate: его минимум и
 * минимумы семейств — доля этого gate в покрытии обязательства. Обобщения за
 * пределы наборов такой способ не доказывает — это называет `gaps`.
 */
export const referenceSchema = z.strictObject({
  /** Эталон и его пределы: версия, предел времени, что исключено из наборов. */
  oracle: z.strictObject({ description: text(), limits: text() }),
  /** Сверка эталона с другим способом: семейство, способ, совпало из всего. */
  crossChecks: z
    .array(
      z.strictObject({
        family: text(200),
        against: text(500),
        matches: z.number().int().min(0).max(100_000_000),
        total: z.number().int().min(1).max(100_000_000),
        /**
         * Закреплённые файлы, воспроизводящие сверку (скрипт, журнал) — среди
         * артефактов контракта. Без них числа — утверждение автора.
         */
        artifacts: z.array(relativePathSchema).min(1).max(10).optional(),
      }),
    )
    .min(1)
    .max(10),
  sets: z
    .array(
      z.strictObject({
        /** Gate, который сверяет реализацию с этим набором. */
        gate: idSchema,
        /** Файлы набора — среди артефактов контракта. */
        artifacts: z.array(relativePathSchema).min(1).max(10),
        /** Сколько входов набора gate обязан проверить за прогон. */
        minCases: z.number().int().min(1).max(1_000_000),
        /** Доля семейств покрытия обязательства в этом наборе. */
        families: z
          .array(
            z.strictObject({
              id: familyIdSchema,
              minCases: z.number().int().min(1).max(1_000_000),
            }),
          )
          .max(20)
          .default([]),
      }),
    )
    .min(1)
    .max(20),
  /** Чего наборы не доказывают: обобщение за пределы входов, классы вне наборов. */
  gaps: text(),
});
export type ReferenceVerification = z.infer<typeof referenceSchema>;

export const obligationSchema = z.strictObject({
  property: propertyIdSchema,
  /** Существующие требования или критерии приёмки, которые обязательство уточняет. */
  requirements: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
  promise: z.enum(promiseKinds),
  /** Для `other` — что за обещание и почему оно не укладывается в остальные. */
  explanation: text().optional(),
  domain: z.strictObject({
    inputs: text(),
    bounds: text(),
    units: text().optional(),
    invalid: text(),
  }),
  answer: z.strictObject({
    rules: text(),
    ties: text().optional(),
    rounding: text().optional(),
    tolerance: text().optional(),
    refusals: text().optional(),
  }),
  method: z.strictObject({
    kind: z.enum(['oracle', 'certificate', 'analytic', 'invariant', 'scenario', 'other']),
    description: text(),
    /** Где способ применим: размеры, классы входов. За пределами — не доказательство. */
    applicability: text(),
    /** Закреплённые checker/oracle/generator — среди артефактов контракта. */
    artifacts: z.array(relativePathSchema).max(10).default([]),
  }),
  coverage: z.strictObject({
    families: z
      .array(
        z.strictObject({
          id: familyIdSchema,
          kind: z.enum(['typical', 'boundary', 'adversarial']),
          description: text(500),
          minCases: z.number().int().min(1).max(1_000_000),
        }),
      )
      .min(1)
      .max(20),
    /** Сколько входов генератора обязательно на свойство в одном прогоне gate. */
    minCases: z.number().int().min(1).max(1_000_000),
    /** Свойство пополняется подтверждёнными случаями корпуса. */
    corpus: z.boolean().default(false),
  }),
  resources: z.strictObject({
    subject: text(),
    oracle: text(),
    benchmark: z.strictObject({ method: text(), environment: text() }).optional(),
  }),
  /**
   * Gates, исполняющие обязательство; без поля — gate договора. У
   * генеративного обязательства каждый из них проверяет полное покрытие, у
   * эталонного — свои наборы.
   */
  gates: z.array(idSchema).min(1).max(10).optional(),
  /** Способ исполнения: `property` (без поля) — генератор; `reference` — эталонные наборы. */
  verification: z.enum(['property', 'reference']).optional(),
  reference: referenceSchema.optional(),
  /** Тяжёлый точный алгоритм или жёсткое время: до реализации нужен ограниченный эксперимент. */
  hard: z.boolean().default(false),
  feasibility: z
    .strictObject({
      spike: z.string().regex(/^SP-[A-Za-z0-9_-]{1,80}$/),
      digest: digestSchema,
    })
    .optional(),
});
export type Obligation = z.infer<typeof obligationSchema>;

export const checkDeclarationSchema = z.strictObject({
  version: z.literal(1),
  /**
   * Gate проверки по умолчанию: исполняет обязательства без своих `gates`
   * (генеративный, с закреплённым checker).
   */
  gate: idSchema,
  obligations: z.array(obligationSchema).min(1).max(30),
  /**
   * Политика расширения: разрешено ли добавлять подтверждённые случаи без
   * изменения договора — под тем же checker/oracle, той же областью входов и
   * теми же правилами ответа.
   */
  corpus: z
    .strictObject({
      format: text(),
      extensible: z.boolean(),
      /** Предел числа случаев на свойство: корпус — регрессия, не замена генератора. */
      maxCases: z.number().int().min(1).max(5000).default(500),
    })
    .optional(),
});
export type CheckDeclaration = z.infer<typeof checkDeclarationSchema>;

/** Закреплённый файл контракта: путь в репозитории и Git blob его содержимого. */
export const contractArtifactSchema = z.strictObject({
  path: relativePathSchema,
  blob: gitShaSchema,
});
export type ContractArtifact = z.infer<typeof contractArtifactSchema>;

/**
 * Документ контракта. `checks` — договор проверки; `artifacts` — его
 * закреплённые checker/oracle/generator в репозитории `repositoryId`. Ревью
 * контракта относится к digest всего документа: смена договора проверки или
 * закреплённого файла — новый digest и новое ревью.
 */
export const contractDocumentSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  id: idSchema,
  repositoryId: idSchema.optional(),
  title: trimmedText(3, 180),
  content: z.string().min(10).max(200000),
  artifacts: z.array(contractArtifactSchema).max(50).optional(),
  checks: checkDeclarationSchema.optional(),
});
export type ContractDocument = z.infer<typeof contractDocumentSchema>;

/**
 * Ограниченный эксперимент выполнимости (spike).
 *
 * Невыполнимые или неизмеримые обязательства обнаруживались после серии
 * попыток реализации. Для тяжёлого точного алгоритма или жёсткого времени до
 * реализации запускается короткий эксперимент: команда эталона или прототипа
 * на закреплённом SHA, seed и размеры входов, предел времени. Результат
 * сохраняется с версиями и пределами вывода. Таймаут — `inconclusive` для
 * выбранного способа и бюджета: он не доказывает трудность или
 * невозможность и не даёт права менять требование. Успех на выборке не
 * доказывает верхней границы на любом входе.
 */
export const spikeInputSchema = z.strictObject({
  repositoryId: idSchema.optional(),
  /** Commit эталона или прототипа; по умолчанию — HEAD репозитория. */
  sha: gitShaSchema.optional(),
  command: z.array(z.string().min(1)).min(1).max(50),
  sizes: z.array(z.number().int().min(0).max(1_000_000_000)).min(1).max(20),
  seed: z.number().int().min(0).max(4294967295).default(1),
  /** Предел на один размер. */
  timeoutMs: z.number().int().min(100).max(600000),
  /** Что исследуется: набор входов и вопрос эксперимента. */
  question: trimmedText(10, 2000),
});
export type SpikeInput = z.input<typeof spikeInputSchema>;

export const spikeSchema = z.strictObject({
  id: z.string().regex(/^SP-[A-Za-z0-9_-]{1,80}$/),
  repositoryId: idSchema,
  sha: gitShaSchema,
  command: z.array(z.string().min(1)).min(1).max(50),
  seed: z.number().int().min(0),
  sizes: z.array(z.number().int().min(0)),
  timeoutMs: z.number().int().min(1),
  question: z.string().min(1).max(2000),
  results: z.array(
    z.strictObject({
      size: z.number().int().min(0),
      ms: z.number().int().min(0),
      outcome: z.enum(['ok', 'timeout', 'error']),
      exitCode: z.number().int(),
    }),
  ),
  outcome: z.enum(['feasible', 'inconclusive', 'failed']),
  /** Пределы вывода: что эксперимент показывает, а что — нет. */
  limits: z.string().min(1).max(2000),
  environment: z.strictObject({
    platform: z.string(),
    arch: z.string(),
    node: z.string(),
    cpus: z.number().int().min(0),
    isolation: z.string(),
  }),
  at: z.string().min(1),
  digest: digestSchema,
});
export type Spike = z.infer<typeof spikeSchema>;
