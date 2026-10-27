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

/** Модель события runtime: событие system у claude, ключи modelUsage у codex. */
function eventModel(event: Record<string, unknown>): string | null {
  if (typeof event.model === 'string' && event.model && event.model !== '<synthetic>')
    return event.model;
  const usage = event.modelUsage as Record<string, unknown> | undefined;
  const [name] = Object.keys(usage ?? {});
  return name ?? null;
}

/** Модель, которую runtime выбрал на самом деле: событие system у claude, ключи modelUsage у codex. */
export function reportedModel(stdout: string): string | null {
  for (const event of runtimeEvents(stdout).events) {
    const model = eventModel(event);
    if (model) return model;
  }
  return null;
}

/** Строка потока длиннее — не разбирается и делает телеметрию неполной. */
export const LINE_LIMIT = 8_000_000;

/**
 * Только числовые поля верхнего уровня `usage`: вложенная структура любой
 * глубины не хранится и не сериализуется (глубокая вложенность роняла бы
 * `JSON.stringify` в обработчике вывода процесса).
 */
const flatUsage = (usage: unknown) =>
  usage && typeof usage === 'object' && !Array.isArray(usage)
    ? Object.fromEntries(
        Object.entries(usage).filter(([, v]) => typeof v === 'number' || v === null),
      )
    : usage === undefined
      ? undefined
      : {};

/**
 * Телеметрия, собранная по ходу потока runtime, а не из хвоста вывода. Хвост
 * stdout и журнал вызова ограничены, и у долгого вызова итоговое событие
 * `result` (стоимость и счётчики claude) или ранние `turn.completed` codex
 * оказывались за пределом: стоимость, сообщённая провайдером, терялась или
 * учитывалась неполной. Здесь каждая строка разбирается сразу; хранятся
 * только поля телеметрии — последнее событие `result`, события
 * `turn.completed` и первая сообщённая модель, — а не текст вывода.
 */
export function usageStream(runtime: 'codex' | 'claude') {
  let partial = '',
    overflow = false,
    malformed = false,
    model: string | null = null,
    result: string | undefined;
  const turns: string[] = [];
  const line = (text: string) => {
    if (!text.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      malformed = true;
      return;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      malformed = true;
      return;
    }
    const e = event as Record<string, unknown>;
    model ??= eventModel(e);
    if (runtime === 'claude' && e.type === 'result')
      result = JSON.stringify({
        type: e.type,
        usage: flatUsage(e.usage),
        total_cost_usd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : null,
      });
    if (runtime === 'codex' && e.type === 'turn.completed')
      turns.push(JSON.stringify({ type: e.type, usage: flatUsage(e.usage) }));
  };
  const flush = () => {
    if (overflow) malformed = true;
    else line(partial);
    partial = '';
    overflow = false;
  };
  const append = (piece: string) => {
    if (overflow) return;
    if (partial.length + piece.length > LINE_LIMIT) {
      partial = '';
      overflow = true;
    } else partial += piece;
  };
  const consume = (text: string) => {
    let start = 0;
    for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n', start)) {
      append(text.slice(start, end));
      flush();
      start = end + 1;
    }
    append(text.slice(start));
  };
  return {
    /**
     * Очередной фрагмент stdout runtime (без маски: берутся только числа).
     * Вызывается из обработчика вывода процесса и не бросает: сбой разбора —
     * неполная телеметрия, а не падение controller.
     */
    push(text: string) {
      try {
        consume(text);
      } catch {
        malformed = true;
        partial = '';
        overflow = true;
      }
    },
    /** Телеметрия всего потока; `completed` — вызов завершился штатно. */
    usage(completed: boolean): Usage {
      flush();
      return parseUsage(
        runtime,
        [...turns, ...(result ? [result] : [])].join('\n'),
        completed && !malformed,
      );
    },
    model: () => model,
  };
}
