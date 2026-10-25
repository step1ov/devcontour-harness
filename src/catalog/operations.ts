import { z } from 'zod';
import { HarnessError } from '../contracts/errors.ts';
import type { OperationCatalog } from '../contracts/catalog.ts';

/** Операция каталога: описание, признак только чтения, схема входа (и ответа). */
export interface CatalogOperation {
  description: string;
  readOnly: boolean;
  input: z.ZodType;
  output?: z.ZodType;
}

export interface CatalogInput {
  name: string;
  version: string;
  protocolVersion: number;
  maxInputBytes: number;
  maxResultBytes: number;
  /** Порядок ключей — порядок `tools`. */
  operations: Readonly<Record<string, CatalogOperation>>;
}

const operationName = /^[A-Za-z][A-Za-z0-9_-]*$/;

// Схема Zod 4 по её внутреннему признаку, а не instanceof: у хоста может быть своя копия zod.
const isZodSchema = (value: unknown) =>
  typeof value === 'object' && value !== null && '_zod' in value;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const refuse = (path: (string | number)[], message: string): never => {
  throw new HarnessError('INVALID_INPUT', `Каталог: ${message}`, [{ path, message }]);
};

/** Форма входа каталога — до построения схем: неверный вызов хоста — INVALID_INPUT. */
function checkInput(input: unknown): asserts input is CatalogInput {
  if (!isRecord(input)) refuse([], 'вход — объект');
  const header = input as Record<string, unknown>;
  for (const key of ['name', 'version'] as const)
    if (typeof header[key] !== 'string') refuse([key], `${key} — строка`);
  for (const key of ['protocolVersion', 'maxInputBytes', 'maxResultBytes'] as const) {
    const value = header[key];
    if (!Number.isSafeInteger(value) || (value as number) < 1) refuse([key], `${key} — целое ≥ 1`);
  }
  if (!isRecord(header.operations)) refuse(['operations'], 'operations — объект');
  for (const [tool, op] of Object.entries(header.operations as Record<string, unknown>)) {
    if (!isRecord(op)) refuse(['operations', tool], `операция ${tool} — объект`);
    const o = op as Record<string, unknown>;
    if (typeof o.description !== 'string')
      refuse(['operations', tool, 'description'], `description операции ${tool} — строка`);
    if (typeof o.readOnly !== 'boolean')
      refuse(['operations', tool, 'readOnly'], `readOnly операции ${tool} — boolean`);
    if (!isZodSchema(o.input))
      refuse(['operations', tool, 'input'], `input операции ${tool} — схема Zod`);
    if (o.output !== undefined && !isZodSchema(o.output))
      refuse(['operations', tool, 'output'], `output операции ${tool} — схема Zod`);
  }
}

/**
 * Каталог операций для агента. `inputSchema` — `z.toJSONSchema(input, { io: 'input' })`
 * той копии zod, что у пакета; `outputSchema` — только у операции с `output`.
 * Хост строит свой каталог этой же функцией отдельно от каталога harness.
 */
export function operationCatalog(input: CatalogInput): OperationCatalog {
  checkInput(input);
  const { name, version, protocolVersion, maxInputBytes, maxResultBytes, operations } = input;
  return {
    name,
    version,
    protocolVersion,
    maxInputBytes,
    maxResultBytes,
    tools: Object.entries(operations).map(([tool, op]) => {
      if (!operationName.test(tool))
        throw new HarnessError('INVALID_INPUT', `Каталог: недопустимое имя операции ${tool}`, [
          { path: ['operations', tool], message: 'invalid-name' },
        ]);
      return {
        name: tool,
        description: op.description,
        readOnly: op.readOnly,
        inputSchema: z.toJSONSchema(op.input, { io: 'input' }),
        ...(op.output
          ? {
              outputSchema: z.toJSONSchema(op.output, {
                io: 'output',
                unrepresentable: 'any',
              }),
            }
          : {}),
      };
    }),
  };
}
