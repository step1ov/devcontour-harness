import {
  FINDING_BASIS_PATTERN,
  FINDING_ID_PATTERN,
  REVIEW_ITEMS_LIMIT,
  findingStatuses,
} from '../contracts/review.ts';
import { INPUT_LIMITS, INPUT_SEVERITY_MAX, criticalAreas } from '../contracts/input.ts';

/**
 * JSON Schema структурированного ответа для CLI runtime. Codex требует
 * закрытые объекты, где каждое свойство обязательно (необязательность —
 * через `null`), поэтому схемы написаны вручную, а не генерируются из Zod;
 * ответ после этого всё равно разбирается Zod-схемами договора.
 */
const discovery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['bug', 'debt'] },
    title: { type: 'string' },
    path: { type: 'string' },
    line: { type: 'integer', minimum: 1 },
    observation: { type: 'string' },
    consequence: { type: 'string' },
    reproduction: { type: 'string' },
  },
  required: ['kind', 'title', 'path', 'line', 'observation', 'consequence', 'reproduction'],
};

const areas = {
  type: 'array',
  maxItems: criticalAreas.length,
  items: { type: 'string', enum: [...criticalAreas] },
};
const severity = { type: 'integer', minimum: 1, maximum: INPUT_SEVERITY_MAX };

/** Вопрос исполнителя (`inputQuestionSchema`); `null` — вопроса нет. */
const inputRequest = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    question: { type: 'string' },
    options: {
      type: 'array',
      maxItems: INPUT_LIMITS.options,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          consequence: { type: ['string', 'null'] },
        },
        required: ['id', 'label', 'consequence'],
      },
    },
    recommended: { type: ['string', 'null'] },
    severity,
    rationale: { type: 'string' },
    affects: areas,
  },
  required: ['question', 'options', 'recommended', 'severity', 'rationale', 'affects'],
};

const assumption = {
  type: 'object',
  additionalProperties: false,
  properties: {
    question: { type: 'string' },
    chosen: { type: 'string' },
    rationale: { type: 'string' },
    severity,
    affects: areas,
  },
  required: ['question', 'chosen', 'rationale', 'severity', 'affects'],
};

export const implementationOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    completed: { type: 'boolean' },
    summary: { type: 'string' },
    discoveries: { type: 'array', maxItems: 20, items: discovery },
    inputRequest,
    assumptions: { type: 'array', maxItems: INPUT_LIMITS.assumptions, items: assumption },
  },
  required: ['completed', 'summary', 'discoveries', 'inputRequest', 'assumptions'],
};

export const reviewOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    execution: {
      type: 'object',
      additionalProperties: false,
      properties: {
        commands: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              command: { type: 'string' },
              exitCode: { type: 'integer' },
              summary: { type: 'string' },
            },
            required: ['command', 'exitCode', 'summary'],
          },
        },
        noCommandsReason: { type: ['string', 'null'] },
      },
      required: ['commands', 'noCommandsReason'],
    },
    approved: { type: 'boolean' },
    summary: { type: 'string' },
    discoveries: { type: 'array', maxItems: 20, items: discovery },
    findings: {
      type: 'array',
      maxItems: REVIEW_ITEMS_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocking', 'note'] },
          message: { type: 'string' },
          path: { type: ['string', 'null'] },
          line: { type: ['integer', 'null'], minimum: 1 },
          rule: { type: ['string', 'null'] },
          consequence: { type: ['string', 'null'] },
          evidence: { type: ['string', 'null'] },
          reproduction: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  property: { type: ['string', 'null'] },
                  input: { type: 'string' },
                  inputClass: { type: ['string', 'null'] },
                  expected: { type: ['string', 'null'] },
                  actual: { type: ['string', 'null'] },
                  command: { type: ['array', 'null'], items: { type: 'string' } },
                  executed: { type: 'boolean' },
                  run: { type: ['string', 'null'] },
                },
                required: [
                  'property',
                  'input',
                  'inputClass',
                  'expected',
                  'actual',
                  'command',
                  'executed',
                  'run',
                ],
              },
            ],
          },
        },
        required: [
          'severity',
          'message',
          'path',
          'line',
          'rule',
          'consequence',
          'evidence',
          'reproduction',
        ],
      },
    },
    previous: {
      type: 'array',
      maxItems: REVIEW_ITEMS_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        // ID и основание — те же правила, что у Zod (`findingTransitionSchema`):
        // ответ, допустимый для runtime, не отбрасывается поздним парсером.
        // Длина строк structured output не выражается — только `pattern`.
        properties: {
          id: { type: 'string', pattern: FINDING_ID_PATTERN },
          status: { type: 'string', enum: [...findingStatuses] },
          basis: { type: 'string', pattern: FINDING_BASIS_PATTERN },
        },
        required: ['id', 'status', 'basis'],
      },
    },
  },
  required: ['approved', 'summary', 'findings', 'discoveries', 'execution', 'previous'],
};

/**
 * Ответ reviewer попытки без изменений: тот же протокол и обязательное
 * `alreadySatisfied` (`null` — подтверждения нет). Обычное ревью этого поля
 * не получает: его вид ответа не меняется.
 */
export const alreadySatisfiedReviewOutputSchema = {
  ...reviewOutputSchema,
  properties: {
    ...reviewOutputSchema.properties,
    alreadySatisfied: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            gates: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
            evidence: { type: 'string' },
          },
          required: ['gates', 'evidence'],
        },
      ],
    },
  },
  required: [...reviewOutputSchema.required, 'alreadySatisfied'],
};
