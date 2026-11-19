// devcontour-harness/report — отчёт об эффекте: чистая функция данных
// исполнения и два рендера. Без node:* (браузерный бандл); те же функции
// экспортирует корень пакета: реализация одна. Загрузка из хранилища —
// `collectReportInput` корня пакета.

export {
  valueReport,
  failureBucketOf,
  attemptSummaryOf,
  attemptSummaryLine,
  acceptingAttemptOf,
  interruptedByShutdown,
  assertReportBytes,
  callCostKnown,
  reportPath,
  isoWeekOf,
  reportVersion,
  reportLimits,
  failureBucketNames,
  type ValueReportInput,
  type ValueReportOptions,
  type AttemptSummary,
  type AttemptBudget,
  type LastFailure,
} from './compute.ts';
// Почему повтор (`attemptSummary.lastFailure`) и что проверено и как (`verification`).
export {
  failurePlainOf,
  failureBucketText,
  failureKindText,
  type PlainText,
} from './failure-plain.ts';
export {
  verificationOf,
  verificationRows,
  verificationLines,
  verificationAttemptOf,
  verificationResultNames,
  verificationHowNames,
  type VerificationRow,
  type WorkVerification,
} from './verification.ts';
export { reportMarkdown } from './markdown.ts';
export { reportHtml } from './html.ts';
export type { ValueReport, ReportMeasure, ReportDist, FailureBucket } from '../contracts/report.ts';
