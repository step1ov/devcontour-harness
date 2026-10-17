import { tmpdir } from 'node:os';
import { z } from 'zod';
import { usageSchema, type Usage } from '../contracts/index.ts';
import { command } from '../environment/process.ts';
import { runtimeEvents } from './runtime-events.ts';

export const unknownUsage = (): Usage => ({
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reportedUsd: null,
  complete: false,
  source: 'unavailable',
});

const number = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const tokens = (v: unknown) => (Number.isSafeInteger(v) ? number(v) : null);

/** Только телеметрия runtime, никогда — структурированный ответ модели или её слова о стоимости. */
export function parseUsage(runtime: 'codex' | 'claude', stdout: string, completed: boolean): Usage {
  try {
    if (runtime === 'claude') {
      const stream = runtimeEvents(stdout);
      const result = stream.events.findLast((e) => e.type === 'result');
      if (!result) return unknownUsage();
      const u = z.record(z.string(), z.unknown()).parse(result.usage);
      const input = tokens(u.input_tokens),
        read = tokens(u.cache_read_input_tokens),
        write = tokens(u.cache_creation_input_tokens);
      return usageSchema.parse({
        inputTokens:
          input !== null && read !== null && write !== null ? input + read + write : null,
        outputTokens: tokens(u.output_tokens),
        cacheReadTokens: read,
        cacheWriteTokens: write,
        reportedUsd: number(result.total_cost_usd),
        complete: completed && !stream.malformed,
        source: 'claude-result',
      });
    }
    const { events, malformed } = runtimeEvents(stdout);
    const turns = events.filter((e) => e.type === 'turn.completed');
    if (!turns.length) return unknownUsage();
    const sum = (key: string) => {
      const values = turns.map((e) =>
        tokens(z.record(z.string(), z.unknown()).parse(e.usage)[key]),
      );
      return values.every((v) => v !== null) ? values.reduce<number>((s, v) => s + v, 0) : null;
    };
    return usageSchema.parse({
      inputTokens: sum('input_tokens'),
      outputTokens: sum('output_tokens'),
      cacheReadTokens: sum('cached_input_tokens'),
      cacheWriteTokens: 0,
      reportedUsd: null,
      complete: completed && !malformed,
      source: 'codex-turn-events',
    });
  } catch {
    return unknownUsage();
  }
}

const versions = new Map<string, Promise<string | null>>();
/** Версия CLI runtime (`<executable> --version`); `null` — неизвестна. */
export function runtimeVersion(executable: string, env?: NodeJS.ProcessEnv) {
  const key = JSON.stringify([executable, env?.PATH ?? process.env.PATH]);
  if (!versions.has(key))
    versions.set(
      key,
      // Предел с запасом: версия спрашивается один раз на процесс, а под
      // нагрузкой запуск интерпретатора runtime занимает секунды.
      command([executable, '--version'], tmpdir(), { timeoutMs: 15_000, env })
        .then((r) => (r.code ? null : (r.stdout.trim().split('\n')[0] ?? '').slice(0, 200) || null))
        .catch(() => null),
    );
  return versions.get(key)!;
}

/** Модель, которую runtime выбрал на самом деле: событие system у claude, ключи modelUsage у codex. */
export function reportedModel(stdout: string): string | null {
  for (const event of runtimeEvents(stdout).events) {
    if (typeof event.model === 'string' && event.model && event.model !== '<synthetic>')
      return event.model;
    const usage = event.modelUsage as Record<string, unknown> | undefined;
    const [name] = Object.keys(usage ?? {});
    if (name) return name;
  }
  return null;
}
