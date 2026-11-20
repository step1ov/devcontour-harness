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
 * Первая выпущенная Relay с контекстом исполнения задачи
 * (`relay-task-context-v1`). Номер ожидаемый: выпуска ещё нет, до него
 * подходит предварительная сборка `RELAY_TASK_CONTEXT_PREVIEW` — уровень
 * определяется по capability, а не по номеру.
 */
export const RELAY_TASK_CONTEXT_VERSION = '0.14.0';
/** Предварительная сборка Relay с контекстом задачи (принимается наравне с выпуском). */
export const RELAY_TASK_CONTEXT_PREVIEW = '0.13.1-harness.1';
/** Capability контекста исполнения задачи (то же значение, что у адаптера relay-v1). */
export const RELAY_TASK_CONTEXT_CAPABILITY = 'relay-task-context-v1';

export type RelayCompatibilityLevel = 'recommended' | 'below-recommended';

export interface RelayCompatibility {
  provider: 'relay-v1-http';
  /** Версия договора REST, которую сообщил сервер. */
  contractVersion: number | null;
  /** Сервер объявил контекст исполнения задачи. */
  taskContext: boolean;
  /** Контекст задачи используется (capability есть и не выключен в конфигурации). */
  taskContextUsed: boolean;
  level: RelayCompatibilityLevel;
  minimum: string;
  recommended: string;
  /** Строка для человека: что это значит и что делать. */
  line: string;
  lineEn: string;
}

const recommendedText = `${RELAY_TASK_CONTEXT_VERSION} (ожидается; до выпуска подходит сборка ${RELAY_TASK_CONTEXT_PREVIEW})`;
const recommendedTextEn = `${RELAY_TASK_CONTEXT_VERSION} (expected; until it is released the ${RELAY_TASK_CONTEXT_PREVIEW} build works)`;

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
  const taskContext = identity.capabilities.includes(RELAY_TASK_CONTEXT_CAPABILITY);
  const off = config?.taskContext?.mode === 'off';
  const base = {
    provider: 'relay-v1-http' as const,
    contractVersion: Number.isInteger(contract) ? contract : null,
    taskContext,
    taskContextUsed: taskContext && !off,
    minimum: RELAY_MIN_VERSION,
    recommended: RELAY_TASK_CONTEXT_VERSION,
  };
  if (!taskContext)
    return {
      ...base,
      level: 'below-recommended',
      line:
        'Relay без контекста задачи: работаю без полного контекста задачи — исполнитель не получит описание функции и сценария. ' +
        `Нужна Relay ≥ ${recommendedText}. Обновите Relay или продолжайте как сейчас: задачи, критерии и документы задачи передаются по-прежнему.`,
      lineEn:
        'Relay without task context: I work without the full task context — the writer will not get the feature and scenario description. ' +
        `Relay ≥ ${recommendedTextEn} is needed. Update Relay or continue as now: tasks, criteria and task documents are still passed.`,
    };
  if (off)
    return {
      ...base,
      level: 'recommended',
      line: 'Relay умеет отдавать контекст задачи, но он выключен в конфигурации связки (taskContext.mode: off): исполнитель не получит описание функции и сценария.',
      lineEn:
        'Relay can provide the task context, but it is turned off in the connector configuration (taskContext.mode: off): the writer will not get the feature and scenario description.',
    };
  return {
    ...base,
    level: 'recommended',
    line: 'Relay с контекстом задачи: исполнитель получает описание функции и сценария, паспорт продукта и документы задачи в пакете контекста.',
    lineEn:
      'Relay with task context: the writer gets the feature and scenario description, the product passport and the task documents in the context pack.',
  };
}
