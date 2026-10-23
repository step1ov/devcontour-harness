/**
 * A01: прежнее хранилище хоста проходит публичный договор `ExecutionStore`
 * из `devcontour-harness/testing` установленного архива. Типы `LegacyStore`
 * проверяет `ports.mts` (`implements ExecutionStore`).
 *
 *   node --test src/store-contract.mjs
 */
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionStoreContract } from 'devcontour-harness/testing';
import { LegacyStore } from './ports.mts';

executionStoreContract(
  'A01 legacy store',
  test,
  (dir) => new LegacyStore(join(dir, 'state.sqlite'), 'consumer-alpha5'),
  () => mkdtempSync(join(tmpdir(), 'consumer-alpha5-store-')),
);
