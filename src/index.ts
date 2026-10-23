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
export { validateInputs, crossIssues, withinPaths } from './validate.ts';
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
  orderCheckManifest,
  orderPropertyProblems,
  suiteBasis,
} from './verification/checks.ts';
export {
  corpusWitness,
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
  type ResolveProfileOptions,
} from './profiles/resolve.ts';
/**
 * Строительные блоки для хоста, который ведёт движок поверх своего хранилища
 * (например, продукт с собственной очередью, ревью и операциями): очередь
 * технических заданий, совместная проверка, перенос базы под владением,
 * исполнение gate, доказательство testcase, наблюдение команд reviewer,
 * маскирование и ограниченный разбор по свойству.
 */
export { WorkflowQueue, GRAPH_STAGES, type WorkflowSubjects } from './control/workflow.ts';
export { repairDecision, type RepairDecision } from './engine/repair.ts';
export { technicalReview, type TechnicalReviewInput } from './control/review.ts';
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
export { requirementProof, uncoveredGates, unprovenReason } from './verification/proof.ts';
export { ReviewProbes, probeLimits, observeReproductions } from './agents/review-probe.ts';
export {
  composeRedactors,
  outputRedactor,
  redactDeep,
  redactError,
  redactor,
  type Redactor,
} from './environment/redaction.ts';
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
  type RepairRule,
} from './engine/failure.ts';
export * from './projections/index.ts';
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
export { diagnoseState, type DiagnoseOptions } from './explain/diagnose.ts';
export { stopInputsOf, type StopInputOptions } from './explain/state.ts';
