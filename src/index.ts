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
