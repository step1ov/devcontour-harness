import type { ConnectorConfig } from './config.ts';
import type { TransportIdentity } from './transport.ts';

/**
 * Совместимость harness ↔ Relay v1 по тому, что сервер сообщает о себе:
 * версия договора REST (`GET /api/v1/health` → `contractVersion`) и
 * capabilities проекта (`GET /context`). Номер пакета Relay сервер по REST не
 * сообщает, поэтому уровень определяется по договору и capabilities, а
 * версии Relay в строках — по таблице docs/compatibility-versions.md.
 */

/** Наименьшая Relay, с которой работает связка `relay-v1-http` (договор REST 1). */
export const RELAY_MIN_VERSION = '0.13.0';
/**
 * Рекомендуемая Relay (alpha.69): обычная 0.13.x — контекст задачи harness
 * собирает сам из маршрутов 0.13 (задача, `entities/get`, документы по цели),
 * сборка Relay с доработками не нужна.
 */
export const RELAY_TASK_CONTEXT_VERSION = RELAY_MIN_VERSION;
/** Capability серверного маршрута контекста: есть — harness читает его одним вызовом. */
export const RELAY_TASK_CONTEXT_CAPABILITY = 'relay-task-context-v1';

export type RelayCompatibilityLevel = 'recommended' | 'below-recommended';

export interface RelayCompatibility {
  provider: 'relay-v1-http';
  /** Версия договора REST, которую сообщил сервер. */
  contractVersion: number | null;
  /** Контекст исполнения задачи доступен (с alpha.69 — у любой Relay 0.13). */
  taskContext: boolean;
  /** Откуда контекст: маршрут сервера (`relay-task-context-v1`) или сборка harness. */
  taskContextSource: 'server' | 'client';
  /** Контекст задачи используется (capability есть и не выключен в конфигурации). */
  taskContextUsed: boolean;
  level: RelayCompatibilityLevel;
  minimum: string;
  recommended: string;
  /** Строка для человека: что это значит и что делать. */
  line: string;
  lineEn: string;
}

/**
 * Уровень совместимости по идентичности backend. Не Relay v1 — `undefined`:
 * у Relay-2 своя сверка сборки. Несовместимая версия договора сюда не
 * доходит: её отклоняет транспорт (`CONNECTOR_VERSION_MISMATCH`).
 */
export function relayCompatibility(
  identity: Pick<TransportIdentity, 'provider' | 'capabilities' | 'build'>,
  config?: Pick<ConnectorConfig, 'taskContext'>,
): RelayCompatibility | undefined {
  if (identity.provider !== 'relay-v1-http') return undefined;
  const contract = Number(identity.build.contractVersion);
  // Контекст задачи есть у любой Relay 0.13: без серверного маршрута его
  // собирает транспорт (alpha.69); маршрут сервера только ускоряет чтение.
  const native = identity.capabilities.includes(RELAY_TASK_CONTEXT_CAPABILITY);
  const off = config?.taskContext?.mode === 'off';
  const base = {
    provider: 'relay-v1-http' as const,
    contractVersion: Number.isInteger(contract) ? contract : null,
    taskContext: true,
    taskContextSource: native ? ('server' as const) : ('client' as const),
    taskContextUsed: !off,
    minimum: RELAY_MIN_VERSION,
    recommended: RELAY_TASK_CONTEXT_VERSION,
  };
  if (off)
    return {
      ...base,
      level: 'recommended',
      line: 'Контекст задачи выключен в конфигурации связки (taskContext.mode: off): исполнитель не получит описание функции и сценария.',
      lineEn:
        'The task context is turned off in the connector configuration (taskContext.mode: off): the writer will not get the feature and scenario description.',
    };
  return {
    ...base,
    level: 'recommended',
    line: `Relay с контекстом задачи (${native ? 'маршрут сервера' : 'собирает harness из маршрутов Relay 0.13'}): исполнитель получает описание функции и сценария, паспорт продукта и документы задачи в пакете контекста.`,
    lineEn: `Relay with task context (${native ? 'server route' : 'built by harness from Relay 0.13 routes'}): the writer gets the feature and scenario description, the product passport and the task documents in the context pack.`,
  };
}
