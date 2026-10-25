/**
 * H3: типы каталога, pager-а и профиля с текстом листа из `.d.ts`
 * установленного архива. Проверяется внешним tsc; не исполняется. Импорты —
 * корень, ./contracts, ./projections и zod.
 */
import { z } from 'zod';
import {
  checkJsonBytes,
  harnessCapabilities,
  jsonBytes,
  operationCatalog,
  pageItems,
  resolveProfile,
  sharedOperationNames,
  sharedOperations,
  utf8Bytes,
  type CatalogOperation,
  type OperationCatalog,
  type Page,
  type PageOptions,
  type ResolvedProfile,
  type ResolvedProfileWithLeaf,
  type SharedOperationName,
} from 'devcontour-harness';
import { operationCatalogSchema, type CatalogTool } from 'devcontour-harness/contracts';
import { clipDeep } from 'devcontour-harness/projections';

// Pager: заголовок хоста сохраняется, ключи страницы — общие.
interface FileItem {
  path: string;
}
const page: Page<FileItem, { kind: string }> = pageItems<FileItem, { kind: string }>(
  [{ path: 'a' }],
  { kind: 'files' },
  { revision: 'r', binding: 'b', limit: 20 },
);
const kind: string = page.kind;
const items: FileItem[] = page.items;
const next: string | null = page.nextCursor;
const total: number = page.total;
const hasMore: boolean = page.hasMore;
void [kind, items, next, total, hasMore];

const context: PageOptions = { revision: 'r', binding: 'b', limit: 1 };
const observability: PageOptions = {
  cursorFormat: 'digest-offset',
  measure: 'items',
  revision: 'a'.repeat(64),
  limit: 20,
  maxBytes: 48000,
  reserveBytes: 0,
};
const withBinding = {
  cursorFormat: 'digest-offset',
  revision: 'r',
  limit: 1,
  binding: 'b',
} as const;
// @ts-expect-error у digest-offset нет binding
const misuse: PageOptions = withBinding;
// @ts-expect-error json-base64url требует binding
const unbound: PageOptions = { revision: 'r', limit: 1 };
void [context, observability, misuse, unbound];

// Каталог хоста и каталог harness — один тип.
const op: CatalogOperation = { description: 'd', readOnly: true, input: z.strictObject({}) };
const hostCatalog: OperationCatalog = operationCatalog({
  name: 'devcontour',
  version: '0.4.0',
  protocolVersion: 1,
  maxInputBytes: 100000,
  maxResultBytes: 65536,
  operations: { preview_status: op },
});
const harness: OperationCatalog = harnessCapabilities();
const parsed: OperationCatalog = operationCatalogSchema.parse(hostCatalog);
const tool: CatalogTool | undefined = harness.tools[0];
const output: Record<string, unknown> | undefined = tool?.outputSchema;
void [parsed, output];

const name: SharedOperationName = sharedOperationNames[0];
const api: string = sharedOperations[name].api;
const limit: number = sharedOperations['plan-check'].limits.maxResultBytes;
// @ts-expect-error status — не общая операция
const notShared: SharedOperationName = 'status';
void [api, limit, notShared];

// Байтовая граница.
const bytes: number = jsonBytes({ a: 1 }) + utf8Bytes('ж');
const within: boolean = checkJsonBytes({ a: 1 }, 65536).within;
const clipped: { a: string } = clipDeep({ a: 'x' });
void [bytes, within, clipped];

// Профиль: leafContent только с опцией.
const withLeaf: ResolvedProfileWithLeaf = resolveProfile('node-checks', {
  includeLeafContent: true,
});
const leaf: string = withLeaf.leafContent;
const plain: ResolvedProfile = resolveProfile('node-checks');
// @ts-expect-error без includeLeafContent поля leafContent нет
const missing: string = resolveProfile('node-checks').leafContent;
void [leaf, plain, missing];
