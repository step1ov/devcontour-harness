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

/**
 * Каталог операций для агента. `inputSchema` — `z.toJSONSchema(input, { io: 'input' })`
 * той копии zod, что у пакета; `outputSchema` — только у операции с `output`.
 * Хост строит свой каталог этой же функцией отдельно от каталога harness.
 */
export function operationCatalog(input: CatalogInput): OperationCatalog {
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
