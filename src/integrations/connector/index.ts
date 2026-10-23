/**
 * Opt-in коннектор внешнего хранилища задач (Relay v1 HTTP, Relay-2 CLI).
 * Корень пакета и `./contracts` этот модуль не импортируют; адаптер backend
 * загружается только для явно выбранного provider.
 */
export * from './transport.ts';
export {
  connectorConfigSchema,
  criterionMappingSchema,
  taskMappingSchema,
  loadConfig,
  parseConfig,
  connectorIdOf,
  taskIdentity,
  parseIdentity,
  orderIdOf,
  graphIdOf,
  contextIdOf,
  mappingDigest,
  completionColumn,
  storeFileOf,
  type ConnectorConfig,
  type ConnectorConfigInput,
  type CriterionMapping,
  type TaskMapping,
  type LoadedConfig,
} from './config.ts';
export {
  ConnectorStore,
  LeaseLost,
  type OperationRecord,
  type OperationStatus,
  type StepRecord,
  type StepStatus,
  type LeaseRecord,
  type ReceiptRecord,
  type SnapshotRecord,
} from './store.ts';
export {
  buildSnapshot,
  checkIdentity,
  readStable,
  semanticDigest,
  takeSnapshot,
  assertEligible,
  type BuiltSnapshot,
  type SnapshotManifest,
  type SnapshotProblem,
  type TaskManifest,
} from './snapshot.ts';
export { RelayWorkSource } from './source.ts';
export { RelaySink, operationKey, type ReconcileDecision, type SinkOptions } from './delivery.ts';
export { HistoryRecorder, type SessionLink } from './history.ts';
export { summaryText, stripPaths, type CriterionOutcome } from './summary.ts';
export { markerOf, type ReadBack } from './steps.ts';
export { createTransportFor, settingsFor } from './registry.ts';
export { Connector, openConnector, OWNERSHIP_NOTE, type OpenOptions } from './commands.ts';
