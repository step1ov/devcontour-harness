import { HARNESS_VERSION } from '../package.ts';
import type { OperationCatalog } from '../contracts/catalog.ts';
import { operationCatalog } from './operations.ts';
import { CATALOG_PROTOCOL_VERSION, cliTransportLimits, sharedOperations } from './shared.ts';

/** Каталог общих операций установленного harness (CLI `capabilities`). */
export const harnessCapabilities = (): OperationCatalog =>
  operationCatalog({
    name: 'devcontour-harness',
    version: HARNESS_VERSION,
    protocolVersion: CATALOG_PROTOCOL_VERSION,
    ...cliTransportLimits,
    operations: sharedOperations,
  });
