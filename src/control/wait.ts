// `harness wait` (alpha.71, E1; ревью D/E HIGH-1): ожидание следующего
// значимого события вместо цикла `status`. Курсор — номер события: ответ
// несёт `cursor` сразу после сообщённого события, следующий `wait --after
// <cursor>` продолжает с него — ни одно событие между вызовами и в одной
// пачке не теряется. Без `--after` wait сначала сообщает уже ждущее
// (отказ, удержание, вопрос, на которые ещё никто не ответил). Читает журнал
// событий и состояние только на чтение (WAL); состояние перечитывается, лишь
// когда его фиксировало другое соединение; controller не спрашивает.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ExecutionPolicy, ExecutionView, RunEvent } from '../contracts/index.ts';
import type { stopDiagnosisSchema } from '../contracts/diagnosis.ts';
import type { z } from 'zod';
import { WORKSPACE_OWNER } from '../contracts/index.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';
import { diagnoseState } from '../explain/diagnose.ts';

type StopDiagnosis = z.infer<typeof stopDiagnosisSchema>;

type StartMarker = { pid: number; at: string; until: string } | undefined;

/** Жив ли процесс этой машины (EPERM — жив, но чужой). */
const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

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

/** Коды выхода `harness wait` — исходы ожидания, не ошибки (`ok: true`). */
export const WAIT_EXIT_CODES: Record<WaitKind | 'timeout' | 'aborted', number> = {
  accepted: 0,
  'release-ready': 10,
  question: 11,
  held: 12,
  failed: 13,
  stopped: 14,
  timeout: 15,
  aborted: 16,
};

export interface WaitData {
  kind: WaitKind | 'timeout' | 'aborted';
  /** Событие, которым кончилось ожидание (нет — сообщено состояние). */
  event?: { seq: number; type: string; at: string };
  workId?: string;
  /** Следующий шаг по explain: кто действует, что сделать. */
  next?: { actor: string | null; action: string; message: string };
  /** Короткая строка состояния: работы по статусам и попытки в работе. */
  status: string;
  /** Номер события, с которого продолжит `wait --after <cursor>`. */
  cursor: number;
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

/** Остановка explain, которую снимет только человек, — и её вид. */
export function pendingKind(
  d: StopDiagnosis,
  view: ExecutionView,
): 'failed' | 'held' | 'question' | undefined {
  if (d.retryPlanned || d.actor === 'controller' || d.actor === null) return undefined;
  if (d.action === 'none' || d.action === 'wait') return undefined;
  if (d.cause === 'needs-input' || d.action === 'answer-input' || d.action === 'apply-input')
    return 'question';
  const w = d.workId ? view.work(d.workId) : undefined;
  if (!w || w.status === 'done' || w.status === 'cancelled') return undefined;
  if (w.environmentHold || d.cause === 'needs-lead' || d.action === 'fix-environment')
    return 'held';
  return w.status === 'failed' ? 'failed' : 'held';
}

/** Значимое ли событие по текущему состоянию (отказ уточняет explain). */
function classify(event: RunEvent, view: ExecutionView): WaitKind | 'failure' | undefined {
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
      return w && w.status === 'failed' ? 'failure' : undefined;
    }
    default:
      return undefined;
  }
}

/** Весь выпуск принят: работы есть и все приняты или отменены. */
export const releaseReady = (view: ExecutionView) => {
  const works = view.works();
  return (
    works.length > 0 &&
    works.some((w) => w.status === 'done') &&
    works.every((w) => w.status === 'done' || w.status === 'cancelled')
  );
};

export async function waitFor(input: {
  stateDir: string;
  policy: ExecutionPolicy;
  baseDir: string;
  /** Какие исходы ждать; `release-ready`, `stopped` и таймаут кончают ожидание всегда. */
  until?: readonly WaitKind[];
  /** Курсор прошлого `wait`: события строго после него. Нет — с конца журнала, сначала ждущее. */
  after?: number;
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Раз в `tickMs` (по умолчанию минута): продление сессии ведущего (CLI). */
  onTick?: () => void;
  tickMs?: number;
  now?: () => number;
}): Promise<WaitData> {
  const now = input.now ?? Date.now;
  const started = now();
  const file = join(resolve(input.stateDir), 'state.sqlite');
  const sleep = () => new Promise((r) => setTimeout(r, input.pollMs ?? 1000));
  // Каталога состояния ещё нет (первый run только начинается, ревью final M2):
  // ждём его в пределах времени, а не отказываем.
  let store: SqliteExecutionStore | undefined;
  for (;;) {
    if (existsSync(file))
      try {
        store = new SqliteExecutionStore(file, 'harness-wait', { readOnly: true });
        break;
      } catch {
        /* база ещё создаётся — следующий опрос */
      }
    const left = now() - started >= input.timeoutMs || input.signal?.aborted;
    if (left)
      return {
        kind: input.signal?.aborted ? 'aborted' : 'timeout',
        status: 'каталог состояния ещё не создан: ' + input.stateDir,
        cursor: input.after ?? 0,
        waitedMs: now() - started,
      };
    await sleep();
  }
  const wanted = new Set<WaitKind>(input.until?.length ? input.until : waitKinds);
  wanted.add('release-ready');
  wanted.add('stopped');
  const explain = (workId?: string) =>
    diagnoseState({
      stateDir: input.stateDir,
      policy: input.policy,
      baseDir: input.baseDir,
      ...(workId ? { workId } : {}),
    }).catch(() => undefined);
  const nextOf = (d: StopDiagnosis | undefined) =>
    d ? { next: { actor: d.actor, action: d.action, message: d.message.slice(0, 500) } } : {};
  let cursor = input.after ?? store.lastEventSeq();
  let lastTick = started;
  const finish = (kind: WaitData['kind'], extra: Partial<WaitData> = {}): WaitData => ({
    kind,
    ...extra,
    status: store.read((view) => waitStatusLine(view)),
    cursor,
    waitedMs: now() - started,
  });
  try {
    // Без курсора — сначала то, что уже ждёт человека (например, отказ до начала wait).
    if (input.after === undefined) {
      const stops = await explain();
      const found = store.read((view) => {
        for (const d of stops?.diagnoses ?? []) {
          const kind = pendingKind(d, view);
          if (kind && wanted.has(kind)) return { kind, d };
        }
        return undefined;
      });
      if (found)
        return finish(found.kind, {
          ...(found.d.workId ? { workId: found.d.workId } : {}),
          ...nextOf(found.d),
        });
    }
    // Прочитанное состояние перечитывается только после чужой фиксации.
    let mark = -1;
    let cached = { ready: false, active: false, leaseUntil: 0, starting: undefined as StartMarker };
    for (;;) {
      if (input.signal?.aborted) return finish('aborted');
      const events = store.events(cursor, 500);
      for (const e of events) {
        const kind = store.read((view) => classify(e, view));
        const event = { seq: e.seq, type: e.type, at: e.at };
        const work = e.workId ? { workId: e.workId } : {};
        if (kind === 'failure') {
          // Отказ и ремонт harness — разные транзакции (ревью D/E LOW-2): отказ
          // проверяется опросом позже; назначенный повтор (работа уже не
          // failed) или повтор, который explain планирует, — не отказ для ведущего.
          await new Promise((r) => setTimeout(r, input.pollMs ?? 1000));
          if (!store.read((view) => view.work(e.workId!)?.status === 'failed')) {
            cursor = e.seq;
            continue;
          }
          const stops = await explain(e.workId);
          const d = stops?.diagnoses.find((x) => x.workId === e.workId);
          const pending = d ? store.read((view) => pendingKind(d, view)) : undefined;
          if (pending && wanted.has(pending)) {
            cursor = e.seq;
            return finish(pending, { event, ...work, ...nextOf(d) });
          }
        } else if (kind && wanted.has(kind)) {
          // Курсор — сразу за сообщённым событием: остаток пачки прочтёт следующий wait.
          cursor = e.seq;
          const stops = await explain(e.workId);
          const d =
            stops?.diagnoses.find((x) => !e.workId || x.workId === e.workId) ?? stops?.diagnoses[0];
          return finish(kind, { event, ...work, ...nextOf(d) });
        }
        cursor = e.seq;
      }
      const changed = store.changeMark();
      if (changed !== mark || events.length) {
        mark = changed;
        cached = store.read((view) => ({
          ready: releaseReady(view),
          active: view.attempts().some((a) => a.status === 'active'),
          leaseUntil: view.controller()?.leaseUntil ?? 0,
          starting: view.local('run-start', WORKSPACE_OWNER, 'marker'),
        }));
      }
      // Run запускается (регистрация, пробы, ревью плана) — очередь не стоит.
      const starting =
        !!cached.starting &&
        Date.parse(cached.starting.until) > now() &&
        processAlive(cached.starting.pid);
      if (cached.ready) return finish('release-ready');
      // Никто не работает: нет живой роли controller и активных попыток.
      if (!events.length && !cached.active && !starting && !(cached.leaseUntil > now()))
        return finish('stopped');
      if (now() - started >= input.timeoutMs) return finish('timeout');
      if (input.onTick && now() - lastTick >= (input.tickMs ?? 60_000)) {
        lastTick = now();
        try {
          input.onTick();
        } catch {
          /* продление — удобство, не условие ожидания */
        }
      }
      await sleep();
    }
  } finally {
    store.close();
  }
}
