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
export { Runner, type RunnerOptions } from './engine/runner.ts';
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
  portableSuite,
  scrubLocalPaths,
  scrubPortable,
  verifySuite,
  type PortableSuite,
} from './verification/corpus.ts';
export { caseInputSchema, staleArtifacts, type CaseRequest } from './verification/confirm.ts';
export {
  assertResult,
  pinnedCorpus,
  propertyProofProblem,
  resultProblems,
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
