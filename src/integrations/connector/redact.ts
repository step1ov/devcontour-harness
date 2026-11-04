import { HarnessError } from '../../contracts/index.ts';
import { policySecrets, redactor, type Redactor } from '../../environment/redaction.ts';
import { TransportError, type RelayTransport } from './transport.ts';

/**
 * Маскирование известных секретов в диагностике коннектора.
 *
 * Ошибка транспорта (HTTP body, stderr CLI) может дословно содержать значение
 * секрета. Обёртка маскирует сообщение каждой ошибки транспорта до того, как
 * она попадёт в отчёт `source-check`, `source-status`, сохранённые причины
 * шагов/операций, `lastError` доставки или вывод CLI. Данные успешных ответов
 * не меняются: это содержимое задач, которое закрепляется по digest.
 */

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|AUTH)/i;

/** Значения настроек provider, по имени похожие на секрет (например, `relay.env.RELAY_TOKEN`). */
export function settingsSecrets(settings: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && SECRET_NAME.test(key) && v.length >= 4) out.push(v);
      else walk(v);
    }
  };
  walk(settings);
  return out;
}

export function maskError(error: unknown, redact: Redactor): unknown {
  if (error instanceof TransportError)
    return new TransportError(error.kind, error.operation, redact(error.message), error.details);
  if (error instanceof HarnessError)
    return new HarnessError(
      error.code,
      redact(error.message),
      error.issues.map((i) => ({ path: i.path, message: redact(i.message) })),
    );
  if (error instanceof Error) {
    const safe = new Error(redact(error.message));
    safe.name = error.name;
    return safe;
  }
  return typeof error === 'string' ? redact(error) : error;
}

const marked = Symbol('redacting-transport');

/** Транспорт, ошибки которого замаскированы `redact`. Повторная обёртка не создаётся. */
export function redactingTransport(inner: RelayTransport, redact: Redactor): RelayTransport {
  if ((inner as unknown as Record<symbol, unknown>)[marked] || !redact.secrets?.length)
    return inner;
  const wrapped = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === marked) return true;
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        let out: unknown;
        try {
          out = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          throw maskError(error, redact);
        }
        return out instanceof Promise
          ? out.catch((error: unknown) => {
              throw maskError(error, redact);
            })
          : out;
      };
    },
  });
  return wrapped;
}

export { policySecrets, redactor };
