// `harness wait` (alpha.71, E1): ожидание следующего значимого события
// вместо цикла `status`. Читает журнал событий и запись состояния только на
// чтение (WAL: новые фиксации видны), раз в `pollMs`; controller не
// спрашивает. Итог — что случилось, следующий шаг из explain и строка
// состояния.

import { join, resolve } from 'node:path';
import type { ExecutionPolicy, ExecutionView, RunEvent } from '../contracts/index.ts';
import { HarnessError } from '../contracts/index.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';
import { diagnoseState } from '../explain/diagnose.ts';

/** Значимые события ожидания. */
export const waitKinds = [
  'accepted',
  'failed',
  'held',
  'question',
  'release-ready',
  'stopped',
] as const;
export type WaitKind = (typeof waitKinds)[number];

/** Коды выхода `harness wait` — у каждого исхода свой. */
export const WAIT_EXIT_CODES: Record<WaitKind | 'timeout', number> = {
  accepted: 0,
  'release-ready': 10,
  question: 11,
  held: 12,
  failed: 13,
  stopped: 14,
  timeout: 15,
};

export interface WaitData {
  kind: WaitKind | 'timeout';
  /** Событие, которым кончилось ожидание (нет — состояние уже было таким). */
  event?: { seq: number; type: string; at: string };
  workId?: string;
  /** Следующий шаг по explain: кто действует, что сделать. */
  next?: { actor: string | null; action: string; message: string };
  /** Короткая строка состояния: работы по статусам и попытки в работе. */
  status: string;
  waitedMs: number;
}

/** Строка состояния: `принято 2/5; в работе 1; упало 1; готово 1`. */
export function waitStatusLine(view: ExecutionView): string {
  const works = view.works();
  const count = (s: string[]) => works.filter((w) => s.includes(w.status)).length;
  const active = view.attempts().filter((a) => a.status === 'active').length;
  const parts = [
    `принято ${count(['done'])}/${works.length}`,
    active ? `в работе ${active}` : '',
    count(['failed']) ? `упало ${count(['failed'])}` : '',
    count(['ready']) ? `готово к выдаче ${count(['ready'])}` : '',
    view.control().paused ? `пауза (${view.control().pauseReason ?? 'operator'})` : '',
  ];
  return parts.filter(Boolean).join('; ');
}

/** Значимое ли событие и что оно значит по текущему состоянию. */
function classify(event: RunEvent, view: ExecutionView): WaitKind | undefined {
  switch (event.type) {
    case 'work.accepted':
      return 'accepted';
    case 'input.requested':
      return 'question';
    case 'work.held':
      return 'held';
    case 'control.paused':
      return 'stopped';
    case 'attempt.failed': {
      const w = event.workId ? view.work(event.workId) : undefined;
      if (!w || w.status !== 'failed') return undefined;
      return w.environmentHold ? 'held' : 'failed';
    }
    default:
      return undefined;
  }
}

/** Весь выпуск принят: работы есть и все приняты или отменены. */
const releaseReady = (view: ExecutionView) => {
  const works = view.works();
  return (
    works.length > 0 &&
    works.some((w) => w.status === 'done') &&
    works.every((w) => w.status === 'done' || w.status === 'cancelled')
  );
};

/** Никто не работает: нет живой роли controller и нет активных попыток. */
const idle = (view: ExecutionView, now: number) =>
  !view.attempts().some((a) => a.status === 'active') &&
  !((view.controller()?.leaseUntil ?? 0) > now);

export async function waitFor(input: {
  stateDir: string;
  policy: ExecutionPolicy;
  baseDir: string;
  /** Какие исходы ждать; `release-ready`, `stopped` и таймаут кончают ожидание всегда. */
  until?: readonly WaitKind[];
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<WaitData> {
  const now = input.now ?? Date.now;
  const started = now();
  const file = join(resolve(input.stateDir), 'state.sqlite');
  let store: SqliteExecutionStore;
  try {
    store = new SqliteExecutionStore(file, 'harness-wait', { readOnly: true });
  } catch {
    throw new HarnessError('NOT_FOUND', 'Каталог состояния не найден: ' + input.stateDir);
  }
  const wanted = new Set<WaitKind>(input.until?.length ? input.until : waitKinds);
  wanted.add('release-ready');
  wanted.add('stopped');
  let after = 0;
  try {
    // Ожидание — событий после начала: прежние уже прочитаны ведущим.
    for (let batch = store.events(after, 500); batch.length; batch = store.events(after, 500))
      after = batch.at(-1)!.seq;
    let found: { kind: WaitKind; event?: RunEvent } | undefined;
    for (;;) {
      const events = store.events(after, 500);
      if (events.length) after = events.at(-1)!.seq;
      found = store.read((view) => {
        for (const e of events) {
          const kind = classify(e, view);
          if (kind && wanted.has(kind)) return { kind, event: e };
        }
        if (releaseReady(view)) return { kind: 'release-ready' as const };
        if (!events.length && idle(view, now())) return { kind: 'stopped' as const };
        return undefined;
      });
      if (found) break;
      if (now() - started >= input.timeoutMs || input.signal?.aborted) break;
      await new Promise((r) => setTimeout(r, input.pollMs ?? 1000));
    }
    const status = store.read((view) => waitStatusLine(view));
    const workId = found?.event?.workId;
    const base = {
      status,
      waitedMs: now() - started,
      ...(found?.event
        ? { event: { seq: found.event.seq, type: found.event.type, at: found.event.at } }
        : {}),
      ...(workId ? { workId } : {}),
    };
    if (!found) return { kind: 'timeout', ...base };
    store.close();
    // Следующий шаг — из explain (только чтение) по работе события.
    const explain = await diagnoseState({
      stateDir: input.stateDir,
      policy: input.policy,
      baseDir: input.baseDir,
      ...(workId ? { workId } : {}),
    }).catch(() => undefined);
    const d =
      explain?.diagnoses.find((x) => !workId || x.workId === workId) ?? explain?.diagnoses[0];
    return {
      kind: found.kind,
      ...base,
      ...(d
        ? { next: { actor: d.actor, action: d.action, message: d.message.slice(0, 500) } }
        : {}),
    };
  } finally {
    try {
      store.close();
    } catch {
      /* уже закрыто */
    }
  }
}
