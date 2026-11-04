import { execFile } from 'node:child_process';
import type { Activity, LivenessState, StallSweepPolicy } from '../contracts/index.ts';
import type { ActivityScope, TrackedCommand } from '../environment/activity.ts';
import { osTool, osToolEnv } from '../environment/os-tools.ts';

// Обход зависших попыток. Предел времени (`timeoutMs`) отличает только
// «кончилось время»; живой процесс, который ничего не выводит и не считает,
// расходовал бы его целиком и выглядел бы медленной работой. Обход раз в
// интервал оценивает движение каждой исполняющейся попытки — вывод, начало и
// конец команд, границы стадий, расход процессора деревом процессов — и
// сообщает переходы `active → quiet → stalled` (и обратно), не дожидаясь
// вопроса человека.

/**
 * Доля процессорного времени от прошедшего, с которой расход дерева считается
 * движением. Простаивающий event loop или ожидание сети расходуют десятые доли
 * процента; работающая проверка без вывода — десятки. Сравнение — с опорной
 * точкой последнего движения, а не с прошлым замером: грубое разрешение ps
 * (секунды на Linux) не даёт ни ложного движения, ни ложного простоя.
 */
export const CPU_ACTIVE_SHARE = 0.01;

export interface ProcessRow {
  pid: number;
  parentPid: number;
  /** Процессорное время процесса; нет — ps его не сообщил. */
  cpuMs?: number;
  command: string;
}

/** Время `ps -o time`: `[[dd-]hh:]mm:ss[.cc]` (Linux — целые секунды, macOS — сотые). */
export function parseCpuTime(text: string): number | undefined {
  const m = /^\s*(?:(\d+)-)?([\d:.]+)\s*$/.exec(text);
  if (!m) return undefined;
  const parts = m[2]!.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === '')) return undefined;
  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  const days = m[1] ? Number(m[1]) : 0;
  if (![seconds, minutes, hours, days].every(Number.isFinite)) return undefined;
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

/** Строки `ps -axww -o pid=,ppid=,time=,command=`. */
export function parseProcessTable(stdout: string): ProcessRow[] {
  return stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) return [];
    const cpuMs = parseCpuTime(m[3]!);
    return [
      {
        pid: Number(m[1]),
        parentPid: Number(m[2]),
        ...(cpuMs !== undefined ? { cpuMs } : {}),
        command: m[4]!.trim(),
      },
    ];
  });
}

/** Таблица процессов одним вызовом ps; отказ или Windows — `null`, а не исключение. */
export function sampleProcesses(timeoutMs = 5000): Promise<ProcessRow[] | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      osTool('ps'),
      ['-axww', '-o', 'pid=,ppid=,time=,command='],
      { encoding: 'utf8', env: osToolEnv(), timeout: timeoutMs, maxBuffer: 64_000_000 },
      (error, stdout) => resolve(error ? null : parseProcessTable(stdout)),
    );
  });
}

/** Процесс и все его потомки по таблице. */
export function treeOf(rows: readonly ProcessRow[], root: number): ProcessRow[] {
  const ids = new Set([root]);
  for (let size = 0; size !== ids.size;) {
    size = ids.size;
    for (const row of rows) if (ids.has(row.parentPid)) ids.add(row.pid);
  }
  return rows.filter((r) => ids.has(r.pid));
}

export function livenessOf(idleMs: number, policy: StallSweepPolicy): LivenessState {
  if (idleMs >= policy.stalledMs) return 'stalled';
  if (idleMs >= policy.quietMs) return 'quiet';
  return 'active';
}

export interface SweepSubject {
  id: string;
  scope: ActivityScope;
}

export interface StallSnapshot {
  processes: ProcessRow[];
  processesUnavailable?: boolean;
  /** Хвост вывода последней начатой команды (замаскированный). */
  tail: string;
}

export interface LivenessChange {
  subject: SweepSubject;
  previous: LivenessState;
  state: LivenessState;
  /** Время обхода и последнего движения, epoch ms. */
  at: number;
  lastMovementAt: number;
  idleMs: number;
  activity?: Activity;
  /** Только у `stalled`. */
  snapshot?: StallSnapshot;
}

interface Memo {
  state: LivenessState;
  /** Набор отслеживаемых процессов, к которому относится опора расхода. */
  key: string;
  cpuMs?: number;
  cpuAt?: number;
  /** Остановлен по `stop`: дальнейших переходов нет. */
  done?: boolean;
}

const SNAPSHOT_PROCESSES = 100;

/**
 * Периодический обход исполняющегося. Один ps на обход для всех попыток;
 * переходы отдаются `changed` синхронно. При `action: stop` попытка после
 * `stalled` больше не оценивается: её остановка сама выглядела бы движением.
 */
export class StallSweep {
  private readonly memo = new Map<string, Memo>();
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(
    private readonly options: {
      policy: StallSweepPolicy;
      subjects: () => Iterable<SweepSubject>;
      changed: (change: LivenessChange) => void;
      clock?: () => number;
      sample?: () => Promise<ProcessRow[] | null>;
    },
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.policy.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Один обход; параллельный вызов ждёт идущий, а не запускает второй. */
  tick(): Promise<void> {
    this.running ??= this.sweep()
      .catch(() => undefined)
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async sweep() {
    const subjects = [...this.options.subjects()];
    const ids = new Set(subjects.map((s) => s.id));
    for (const id of this.memo.keys()) if (!ids.has(id)) this.memo.delete(id);
    const busy = subjects.some((s) => s.scope.running.size > 0);
    const rows = busy ? await (this.options.sample ?? sampleProcesses)() : null;
    const clock = this.options.clock ?? Date.now;
    const now = clock();
    const { policy } = this.options;
    for (const subject of subjects) {
      const memo = this.memo.get(subject.id) ?? { state: 'active' as const, key: '' };
      this.memo.set(subject.id, memo);
      if (memo.done) continue;
      const { scope } = subject;
      const tracked = [...scope.running];
      const key = tracked
        .map((t) => t.pid ?? 0)
        .sort((a, b) => a - b)
        .join(',');
      const trees = rows
        ? tracked.flatMap((t) => (t.pid ? [{ t, tree: treeOf(rows, t.pid) }] : []))
        : [];
      if (rows) {
        const cpu = trees.reduce(
          (sum, { tree }) => sum + tree.reduce((s, r) => s + (r.cpuMs ?? 0), 0),
          0,
        );
        if (key !== memo.key || memo.cpuMs === undefined || memo.cpuAt === undefined) {
          memo.key = key;
          memo.cpuMs = cpu;
          memo.cpuAt = now;
        } else if (
          cpu > memo.cpuMs &&
          cpu - memo.cpuMs >= CPU_ACTIVE_SHARE * Math.max(1, now - memo.cpuAt)
        ) {
          scope.moved();
          memo.cpuMs = cpu;
          memo.cpuAt = now;
        }
      }
      // Без исполняющихся команд попытка в собственном коде harness: его
      // ограничивают другие сроки, а начало следующей команды — движение.
      const idleMs = tracked.length ? Math.max(0, now - scope.lastMovementAt) : 0;
      const state = livenessOf(idleMs, policy);
      if (state === memo.state) continue;
      const previous = memo.state;
      memo.state = state;
      const current = scope.current();
      const change: LivenessChange = {
        subject,
        previous,
        state,
        at: now,
        lastMovementAt: scope.lastMovementAt,
        idleMs,
        ...(current ? { activity: current.activity } : {}),
      };
      if (state === 'stalled') {
        change.snapshot = snapshotOf(tracked, trees, rows, current);
        if (policy.action === 'stop') memo.done = true;
      }
      try {
        this.options.changed(change);
      } catch {
        /* Получатель перехода не останавливает обход. */
      }
    }
  }
}

function snapshotOf(
  tracked: TrackedCommand[],
  trees: { t: TrackedCommand; tree: ProcessRow[] }[],
  rows: ProcessRow[] | null,
  current: TrackedCommand | undefined,
): StallSnapshot {
  const seen = new Set<number>();
  const processes: ProcessRow[] = [];
  for (const { t, tree } of trees)
    for (const row of tree) {
      if (seen.has(row.pid) || processes.length >= SNAPSHOT_PROCESSES) continue;
      seen.add(row.pid);
      processes.push({ ...row, command: (t.redact ?? String)(row.command).slice(0, 1000) });
    }
  return {
    processes,
    ...(rows ? {} : { processesUnavailable: true }),
    tail: (current ?? tracked.at(-1))?.tail ?? '',
  };
}
