/**
 * Публичный вход пакета. На этапе 0 экспортируются только договоры; движок,
 * хранилище и коннекторы добавляются следующими этапами под этими же типами.
 */
export * from './contracts/index.ts';
export { HARNESS_VERSION } from './package.ts';
/**
 * Полная проверка входов — та же, что выполняет `harness validate`:
 * схемы, `graphIssues`, `policyIssues`, `crossIssues` и, если передан,
 * `contextIssues`. Отказ — `HarnessError` с кодом и путями нарушений.
 */
export { validateInputs, validationIssues, crossIssues, withinPaths } from './validate.ts';
export { Harness, type HarnessOptions } from './control/harness.ts';
export { doctor } from './control/doctor.ts';
export { Engine, type EngineOptions } from './engine/engine.ts';
export { Runner, type RunnerHooks, type RunnerOptions } from './engine/runner.ts';
export { standaloneHost } from './engine/standalone.ts';
export { runResult } from './engine/result.ts';
export { SqliteExecutionStore } from './storage/sqlite.ts';
export { cliAdapter, type CliAdapterOptions } from './agents/cli-adapter.ts';
export { FileContextSource, FileResultSink, FileWorkSource } from './connectors/files.ts';
/**
 * Бюджеты и учёт вызовов: статус области по сохранённым записям, обзор и
 * вызов runtime под учётом (бюджет проверяется до вызова).
 */
export {
  budgetOverview,
  budgetStatus,
  budgetView,
  workBudgets,
  type BudgetContext,
  type BudgetScope,
  type BudgetStatus,
  type CallMeta,
} from './engine/budget.ts';
export { measuredInvoke } from './engine/measured.ts';
export { callDurationMs, callRecords, usageTotals } from './engine/usage.ts';
/**
 * Договор проверки, генеративные gates и корпус подтверждённых случаев:
 * ожидаемая проверка поручения, сверка отчёта свойств, закреплённые версии
 * корпуса, подтверждение примера эталоном и переносимая форма корпуса.
 */
export {
  contractDocuments,
  declarationProblems,
  corpusBindingHolds,
  effectiveChecks,
  isReference,
  obligationGates,
  orderCheckManifest,
  orderPropertyProblems,
  referenceCodeNote,
  referenceNote,
  referenceSetFiles,
  setFileReference,
  suiteBasis,
} from './verification/checks.ts';
export {
  corpusWitness,
  expectsReference,
  manifestDigest,
  propertyCoverage,
  propertyFailure,
  propertySeed,
  readPropertyReport,
  type CheckManifest,
} from './verification/property.ts';
export {
  CorpusStore,
  canonicalJson,
  caseId,
  corpusFile,
  parseCanonical,
  versionOf,
  portableSuite,
  scrubLocalPaths,
  scrubPortable,
  verifySuite,
  type PortableSuite,
} from './verification/corpus.ts';
export {
  caseHooks,
  caseInputSchema,
  staleArtifacts,
  submitCase,
  type CaseRequest,
  type ConfirmContext,
} from './verification/confirm.ts';
export {
  assertResult,
  pinnedCorpus,
  propertyProofProblem,
  resultProblems,
  type ReceiverContext,
  type ReceiverPolicy,
} from './verification/acceptance.ts';
export { runSpike, spikeOf, spikesOf } from './verification/spike.ts';
export { writeSelfCheck, type SelfCheckPlan } from './verification/self-check.ts';
/**
 * Профили стека: разрешение встроенного или локального профиля (только чтение
 * манифестов), закрепление и сборка описания репозитория и ролей политики.
 */
export {
  builtinProfiles,
  builtinProfilesRoot,
  profilePin,
  profileRoles,
  repositoryFromProfile,
  resolveProfile,
  type ProfileLayer,
  type ResolvedProfileOf,
  type ResolveProfileLayerOptions,
  type ResolveProfileOptions,
} from './profiles/resolve.ts';
/**
 * Строительные блоки для хоста, который ведёт движок поверх своего хранилища
 * (например, продукт с собственной очередью, ревью и операциями): очередь
 * технических заданий, совместная проверка, перенос базы под владением,
 * исполнение gate, доказательство testcase, наблюдение команд reviewer,
 * маскирование и ограниченный разбор по свойству.
 */
export {
  WorkflowQueue,
  GRAPH_STAGES,
  compareWorkflowJobs,
  newestWorkflowJob,
  type WorkflowSubjects,
} from './control/workflow.ts';
export {
  acceptanceGap,
  repairDecision,
  type AcceptanceGap,
  type RepairDecision,
} from './engine/repair.ts';
export { technicalReview, type TechnicalReviewInput } from './control/review.ts';
/**
 * Вопрос исполнителя (H02): решение по ответу writer и политике вопросов,
 * чтение запросов, источник контекста с ответом и проверка снимка на
 * неприменённые ответы — для хоста со своим согласованием (`InputHost`).
 */
/** Wire-схема ответа writer для CLI runtime (JSON Schema): хост переиспользует её, а не копирует. */
export { implementationOutputSchema } from './agents/schemas.ts';
export {
  evaluateInput,
  inputPolicyText,
  assumptionQuestion,
  type InputEvaluation,
  type InputDecision,
} from './engine/input-policy.ts';
export {
  requestsOf,
  requestById,
  blockingRequest,
  inputContextSource,
  withInput,
  inputManifestOf,
  unappliedInputs,
  type InputMessageRef,
} from './engine/input-requests.ts';
export { JointRunner, type JointRunnerOptions } from './engine/joint-runner.ts';
export { moveBase, fencedRefMove, type BaseMoved, type RefMove } from './control/base-move.ts';
export {
  junitSummary,
  prepareReportPath,
  runCheck,
  runGate,
  sandboxBlockedHosts,
  type GateRun,
} from './verification/gates.ts';
export {
  generatorNote,
  runGenerators,
  selectGenerators,
  type GeneratorOutcome,
  type GeneratorsRun,
} from './verification/generators.ts';
export { scopeViolations, type ScopeRules } from './engine/scope.ts';
export {
  runGatesAt,
  type GatesAtContext,
  type GatesAtInput,
  type GatesAtResult,
  type LivenessReport,
} from './verification/gates-at.ts';
export { checkGates, type GateCheckInput, type GateCheckStatus } from './control/gates-check.ts';
export {
  smokeLifecycle,
  classifyLifecycleFailure,
  type LifecycleFailureClass,
  type LifecycleSmokeFailure,
  type LifecycleSmokeInput,
  type LifecycleSmokeResult,
  type LifecycleSmokeStep,
} from './control/lifecycle-smoke.ts';
export { lifecyclePreflight, preflightFile, type PreflightOutcome } from './control/preflight.ts';
export {
  listPreviews,
  livePreviews,
  startPreview,
  stopPreviews,
  type PreviewContext,
  type StartPreviewInput,
} from './control/preview.ts';
export {
  dependencyStoreRoot,
  materializeStore,
  type StoreContext,
  type StoreReceipt,
} from './verification/dependency-store.ts';
export {
  explicitPrerequisites,
  gatePrerequisites,
  orderedScope,
  standaloneScope,
} from './verification/gate-scope.ts';
export {
  gateChain,
  longestGateChain,
  timeBudgetWarnings,
  type BudgetPhase,
  type GateChain,
  type TimeBudgetWarning,
} from './verification/time-budget.ts';
export { requirementProof, uncoveredGates, unprovenReason } from './verification/proof.ts';
export {
  changedPaths,
  conditionalGate,
  coverageChanges,
  derivationAllowed,
  derivedRecordChecks,
  explicitCondition,
  gateBasis,
  gateDecisions,
  gatePathRegExp,
  matchingPaths,
  notApplicableProblem,
  pathApplicability,
  proofGates,
  providerMovement,
  type ChangedPaths,
  type GateCondition,
  type GateDecision,
  type PathDecision,
  type ProviderSnapshot,
} from './verification/applicability.ts';
export {
  packageBinding,
  packageClosure,
  workspaceGraphAt,
  type PackageSelector,
  type WorkspacePackage,
} from './verification/workspace-graph.ts';
export {
  reusedEvidenceProblem,
  type ReuseCheck,
  type ReuseRecord,
} from './verification/integration-reuse.ts';
export { ReviewProbes, probeLimits, observeReproductions } from './agents/review-probe.ts';
export {
  composeRedactors,
  outputRedactor,
  /**
   * Значения секретов политики (`secrets`-карты на любом уровне) из
   * окружения процесса — маска пакета передачи контекста и коннектора по
   * умолчанию. Хост, составляющий свою маску (`composeRedactors`), берёт
   * секреты политики этим же обходом.
   */
  policySecrets,
  redactDeep,
  redactError,
  redactor,
  type Redactor,
} from './environment/redaction.ts';
// Git хоста над checkout, где исполнялся чужой код: хост, запускающий свой
// git над теми же деревьями, сверяет репозиторий теми же правилами.
export { hostGitArgs } from './environment/process.ts';
// Отказ остановки потомков сдерживаемой команды: хост со своим запуском
// команд называет и классифицирует его так же (`environment`/`process-reap`).
export { ReapFailure, reapFailure } from './environment/process.ts';
export { hostLoad, loadText, type HostLoad } from './environment/host-load.ts';
export { CleanupFailure } from './environment/lifecycle.ts';
export { failureOrigin } from './engine/classify.ts';
export {
  UntrustedCheckoutError,
  assertTrustedCheckout,
  forgetWorktree,
  gitHardening,
  rememberWorktree,
  resetGitTrust,
  worktreeAddPath,
  worktreeKey,
} from './environment/git-trust.ts';
/**
 * Корень рабочих деревьев попыток: хост выбирает его сам (`checkoutRoot`)
 * или показывает в диагностике выбор по умолчанию.
 */
export {
  checkoutCacheBase,
  checkoutPath,
  chooseCheckoutRoot,
  type CheckoutPlacement,
  type CheckoutRoot,
  type CheckoutRootInput,
} from './environment/checkout-root.ts';
export { closeIfBasisChanged } from './engine/property-recovery.ts';
export {
  analyzeRecovery,
  applyCases,
  recoveryBrief,
  recoveryOutputSchema,
  recoveryResultSchema,
} from './control/recovery.ts';

// Классы отказов и правила отказов: хост бросает их из своих хуков и
// читает класс отказа попытки теми же правилами, что и движок.
export { BlockedError, classifyFailure, providerRefusal } from './engine/classify.ts';
export {
  TaskFailure,
  failureFingerprint,
  repairPolicy,
  repairRepeats,
  lastContextLimit,
  MAX_NEUTRAL_FAILURES,
  MAX_REWORK_BUDGETS,
  type RepairRule,
} from './engine/failure.ts';
export * from './projections/index.ts';
export * from './report/index.ts';
export { collectReportInput } from './control/report.ts';
/**
 * Представление оператора (`harness view`): загрузчик для node над открытым
 * harness и операция по каталогу состояния. Чистая проекция
 * (`operatorView`, `workDetailView`) — в `devcontour-harness/projections`.
 */
export {
  collectOperatorViewInput,
  defaultedPaths,
  harnessView,
  maskContextOf,
  viewPolicy,
  type HarnessViewOptions,
  type ViewPolicy,
} from './control/operator-view.ts';
/**
 * Запись файла отчёта (`harness report --out`): во временный файл каталога
 * цели и rename, без записи сквозь symlink и жёсткие ссылки, вне каталога
 * состояния; новый файл — `0600`. Использует `node:fs`, поэтому только в
 * корне пакета, а не в `./report` (тот без `node:*`).
 */
export { REPORT_FILE_MODE, writeReportFile, type ReportFileIo } from './control/report-file.ts';
export {
  handoffPack,
  handoffMarkdown,
  type HandoffOptions,
  type HandoffSource,
} from './handoff/index.ts';
// Состояние доски над движком и политикой хоста (`Harness.status` — та же функция).
export {
  statusOf,
  statusText,
  attemptSummaryView,
  attemptSummaries,
  attemptsByWork,
  statusSettled,
  statusFrame,
  type StatusSource,
} from './control/status.ts';
// Этап поручения для оператора (`works[].stage`).
export {
  workStageOf,
  stageLine,
  stageOfStep,
  durationText,
  type WorkStage,
  type WorkStageView,
  type StageNeeds,
  type StageLineExtra,
} from './control/stage.ts';
// Блокировки простыми словами и кто их снимает (`works[].blockers[].plain`).
export {
  plainBlocker,
  blockerCodeText,
  type BlockerCode,
  type PlainBlocker,
} from './control/blocker-plain.ts';
export {
  inspectPath,
  checkDestination,
  listRegularFiles,
  planFileWrites,
  applyFileWrites,
  type FileConflict,
  type FileIntent,
  type FileWriteInput,
  type FilePlanEntry,
  type FilePlan,
} from './setup/files.ts';
export {
  initProject,
  readProjectManifest,
  defaultStateDir,
  projectIdOf,
  type InitOptions,
  type InitData,
} from './init/project.ts';
export { switchLean, type LeanOptions, type LeanData } from './init/lean.ts';
export {
  inspectProject,
  gitFacts,
  type GitFacts,
  type InspectProjectOptions,
} from './init/inspect.ts';
export {
  diagnoseState,
  explainText,
  EXPLAIN_ATTEMPT_ROWS,
  type DiagnoseOptions,
  type ExplainData,
  type AttemptSummaryRow,
} from './explain/diagnose.ts';
export {
  stopInputsOf,
  repairJobOf,
  type StopInputOptions,
  type StopSource,
} from './explain/state.ts';
export * from './planning/index.ts';
export * from './catalog/index.ts';
