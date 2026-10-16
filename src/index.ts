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
