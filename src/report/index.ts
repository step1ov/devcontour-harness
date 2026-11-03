// devcontour-harness/report — отчёт об эффекте: чистая функция данных
// исполнения и два рендера. Без node:* (браузерный бандл); те же функции
// экспортирует корень пакета: реализация одна. Загрузка из хранилища —
// `collectReportInput` корня пакета.

export {
  valueReport,
  failureBucketOf,
  callCostKnown,
  reportPath,
  isoWeekOf,
  reportVersion,
  reportLimits,
  failureBucketNames,
  type ValueReportInput,
  type ValueReportOptions,
} from './compute.ts';
export { reportMarkdown } from './markdown.ts';
export { reportHtml } from './html.ts';
export type { ValueReport, ReportMeasure, ReportDist, FailureBucket } from '../contracts/report.ts';
