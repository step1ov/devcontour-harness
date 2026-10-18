// Таксономия отказов — часть договора (`contracts/failure.ts`): её читают и
// хосты, в том числе в браузере, без загрузки исполнения.
export {
  TaskFailure,
  failureFingerprint,
  failureKinds,
  repairPolicy,
  type FailureKind,
  type RepairRule,
} from '../contracts/index.ts';
