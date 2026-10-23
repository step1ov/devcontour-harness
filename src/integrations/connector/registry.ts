import { HarnessError } from '../../contracts/index.ts';
import { resolveFrom, type LoadedConfig } from './config.ts';
import type { RelayTransport } from './transport.ts';

/**
 * Реестр транспортов по явному provider. Модуль адаптера загружается только
 * для выбранного provider (opt-in): core и файловый сценарий не загружают
 * Relay-адаптеры и не требуют их окружения.
 *
 * Договор адаптера: модуль `src/integrations/<adapter>/index.ts` экспортирует
 * `createTransport(settings, options?)`, где `settings` — объект `relay` из
 * конфигурации коннектора, дополненный `projectId` и `actor` верхнего уровня
 * (и для relay-v2-cli — абсолютными путями `binary`/`config`, разрешёнными от
 * каталога файла конфигурации). Неверные настройки — `INVALID_INPUT`.
 */
export function settingsFor(loaded: LoadedConfig): Record<string, unknown> {
  const { config, baseDir } = loaded;
  const relay = { ...config.relay } as Record<string, unknown>;
  for (const key of ['projectId', 'actor'] as const)
    if (key in relay && relay[key] !== config[key])
      throw new HarnessError(
        'INVALID_INPUT',
        `source.relay.${key} не совпадает с ${key} конфигурации коннектора`,
      );
  const settings: Record<string, unknown> = {
    ...relay,
    projectId: config.projectId,
    actor: config.actor,
  };
  if (config.provider === 'relay-v2-cli') {
    settings.binary = resolveFrom(baseDir, config.relay.binary);
    settings.config = resolveFrom(baseDir, config.relay.config);
  }
  return settings;
}

export async function createTransportFor(loaded: LoadedConfig): Promise<RelayTransport> {
  const settings = settingsFor(loaded);
  switch (loaded.config.provider) {
    case 'relay-v1-http': {
      const adapter = await import('../relay-v1/index.ts');
      return adapter.createTransport(settings);
    }
    case 'relay-v2-cli': {
      const adapter = await import('../relay-v2/index.ts');
      return adapter.createTransport(settings as Parameters<typeof adapter.createTransport>[0]);
    }
  }
}
