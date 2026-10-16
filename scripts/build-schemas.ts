/**
 * JSON Schema договоров генерируется из тех же Zod-схем, которыми пакет
 * проверяет входы: две независимые редакции схемы разошлись бы. `--check`
 * сверяет закоммиченные файлы с генерацией и падает при расхождении.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  API_VERSION,
  contextSnapshotSchema,
  executionPolicySchema,
  resultEnvelopeSchema,
  runEventSchema,
  runResultSchema,
  workGraphSchema,
  workOrderSchema,
} from '../src/contracts/index.ts';

const dir = fileURLToPath(new URL('../schemas/', import.meta.url));
const schemas: Record<string, z.ZodType> = {
  'work-order': workOrderSchema,
  'work-graph': workGraphSchema,
  'execution-policy': executionPolicySchema,
  'context-snapshot': contextSnapshotSchema,
  'run-result': runResultSchema,
  'result-envelope': resultEnvelopeSchema,
  'run-event': runEventSchema,
};
const check = process.argv.includes('--check');
const stale: string[] = [];
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  const text =
    JSON.stringify({ $id: `${API_VERSION}/${name}.schema.json`, title: name, ...json }, null, 2) +
    '\n';
  const file = dir + name + '.schema.json';
  if (check) {
    let current = '';
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      /* отсутствующий файл — расхождение */
    }
    if (current !== text) stale.push(name);
  } else writeFileSync(file, text);
}
if (stale.length) {
  console.error('Устаревшие JSON Schema: ' + stale.join(', ') + '. Выполните npm run schemas');
  process.exit(1);
}
