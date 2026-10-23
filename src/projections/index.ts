// devcontour-harness/projections — чистые проекции без node:*. Те же функции
// экспортирует корень пакета: реализация одна.

export { actors, nextActions, activeStatuses, type Actor, type NextAction } from './enums.ts';
export type { FailureKind, PauseReason, WorkStatus } from './enums.ts';
export {
  chainRoots,
  chainRootCodes,
  type ChainWork,
  type ChainRoot,
  type ChainRootCode,
} from './chain.ts';
export {
  workProgress,
  progressReasons,
  type ProgressInput,
  type ProgressReason,
  type ProgressView,
} from './progress.ts';
export { nextAction, nextSteps, type NextInput, type NextStep, type NextView } from './next.ts';
export { queueStop, type QueueStopInput, type QueueStopView } from './queue.ts';
export { CLIP_SHORT, CLIP_DIAGNOSTIC, clipText, clipDeep } from './clip.ts';
export {
  stopCodeOf,
  explainStop,
  stopCauses,
  stopPhases,
  type StopInput,
  type StopCause,
  type StopPhase,
  type StopDiagnosis,
  type EvidenceLink,
} from './stop.ts';
