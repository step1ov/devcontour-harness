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

export const implementationOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    completed: { type: 'boolean' },
    summary: { type: 'string' },
    discoveries: { type: 'array', maxItems: 20, items: discovery },
  },
  required: ['completed', 'summary', 'discoveries'],
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
                  expected: { type: ['string', 'null'] },
                  actual: { type: ['string', 'null'] },
                  command: { type: ['array', 'null'], items: { type: 'string' } },
                  executed: { type: 'boolean' },
                  run: { type: ['string', 'null'] },
                },
                required: ['property', 'input', 'expected', 'actual', 'command', 'executed', 'run'],
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
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['open', 'closed', 'withdrawn'] },
          basis: { type: 'string' },
        },
        required: ['id', 'status', 'basis'],
      },
    },
  },
  required: ['approved', 'summary', 'findings', 'discoveries', 'execution', 'previous'],
};
