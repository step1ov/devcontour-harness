import { z } from 'zod';

/** Пределы транспорта операции: UTF-8 байты JSON входа и ответа. */
export interface OperationLimits {
  maxInputBytes: number;
  maxResultBytes: number;
}

/** Запись каталога: операция, признак только чтения и JSON Schema входа (и ответа). */
export const catalogToolSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

/** Каталог операций агенту; порядок ключей нормативен (байты ответа хоста). */
export const operationCatalogSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  protocolVersion: z.number().int().positive(),
  maxInputBytes: z.number().int().positive(),
  maxResultBytes: z.number().int().positive(),
  tools: z.array(catalogToolSchema),
});

export type CatalogTool = z.infer<typeof catalogToolSchema>;
export type OperationCatalog = z.infer<typeof operationCatalogSchema>;
