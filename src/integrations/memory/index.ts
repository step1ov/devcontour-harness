/**
 * Opt-in entrypoint `devcontour-harness/integrations/memory`: нейтральная
 * точка подключения внешней памяти. Корень пакета и `./contracts` его не
 * импортируют; реального Hindsight-адаптера здесь нет (docs/integrations/hindsight.md).
 */
export {
  composeContext,
  mergeSnapshots,
  memoryContextSource,
  memoryProvenance,
  MemoryContextSource,
  type ContextPart,
  type MemoryContextOptions,
  type MemoryLimits,
  type MemoryMode,
  type MemoryProvenance,
  type MemoryUsage,
} from './context.ts';
export {
  memoryContent,
  memoryDocumentId,
  memoryResultSink,
  uuidOf,
  MemoryResultSink,
  type MemoryResultSinkOptions,
  type MemoryRetainUsage,
} from './sink.ts';
export {
  memoryItemSchema,
  memoryRecallBodySchema,
  memoryRetainAckSchema,
  type MemoryDocument,
  type MemoryItem,
  type MemoryProvider,
  type MemoryQuery,
  type MemoryRecallBody,
  type MemoryRecallProvider,
  type MemoryRecallResponse,
  type MemoryRetainAck,
  type MemoryRetainProvider,
} from './provider.ts';
