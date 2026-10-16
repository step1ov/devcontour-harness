/**
 * Версии договоров. Они независимы: смена формата состояния не обязана
 * менять API, а новая версия пакета не меняет формат молча.
 *
 * - `apiVersion` — формат публичных входов/выходов (WorkOrder, RunResult...).
 * - `stateVersion` — формат сохранённого состояния исполнения.
 * - `policyVersion` — формат ExecutionPolicy; входит в digest политики.
 *
 * Пакет читает только перечисленные версии. Неизвестная версия отклоняется
 * до любой мутации состояния и до выдачи claim.
 */
export const API_VERSION = 'devcontour-harness/v1alpha1' as const;
export const SUPPORTED_API_VERSIONS = [API_VERSION] as const;
export const STATE_VERSION = 1 as const;
export const SUPPORTED_STATE_VERSIONS = [STATE_VERSION] as const;
export const POLICY_VERSION = 1 as const;
export const SUPPORTED_POLICY_VERSIONS = [POLICY_VERSION] as const;
