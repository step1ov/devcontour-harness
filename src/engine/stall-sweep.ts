import { execFile } from 'node:child_process';
import type {
  Activity,
  LivenessState,
  RunEventPayload,
  StallSweepPolicy,
} from '../contracts/index.ts';
import { ActivityScope, activityScope, type TrackedCommand } from '../environment/activity.ts';
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
 * процента; работающая проверка без вывода — десятки. Расход считается по
 * каждому процессу отдельно (сумма положительных приростов): завершившийся
 * потомок уносит своё время из суммы дерева, и сравнение сумм ложно видело бы
 * простой у сборки из коротких процессов. Накопленный прирост сравнивается с
 * временем от последнего движения: грубое разрешение ps (секунды на Linux) не
 * даёт ни ложного движения, ни ложного простоя.
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
    // Строка команды бывает пустой (процесс-зомби, сменивший argv): такую
    // строку не отбрасывают, иначе её потомки выпали бы из дерева.
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m) return [];
    const cpuMs = parseCpuTime(m[3]!);
    return [
      {
        pid: Number(m[1]),
        parentPid: Number(m[2]),
        ...(cpuMs !== undefined ? { cpuMs } : {}),
        command: (m[4] ?? '').trim(),
      },
    ];
  });
}

let shared: { at: number; rows: Promise<ProcessRow[] | null> } | undefined;
/**
 * Таблица процессов, общая для одновременных обходов (попытки controller,
 * совместная проверка, gates на SHA): снимок моложе `maxAgeMs` берётся
 * готовым, а не новым вызовом ps.
 */
export function sharedSample(maxAgeMs: number): Promise<ProcessRow[] | null> {
  const now = Date.now();
  if (shared && now - shared.at < maxAgeMs) return shared.rows;
  shared = { at: now, rows: sampleProcesses() };
  return shared.rows;
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
  /**
   * ps не дал данных о процессах исполняющихся команд: оценка только по
   * выводу и стадиям, поэтому выше `quiet` она не поднимается.
   */
  cpuUnavailable?: boolean;
  /** Только у `stalled`. */
  snapshot?: StallSnapshot;
  /**
   * Номер эпизода зависания субъекта (с 1): растёт при каждом новом входе в
   * `stalled`, повтор незаписанного перехода сохраняет номер — по нему снимок
   * пишется один раз на эпизод.
   */
  episode: number;
}

/**
 * Исход записи перехода у получателя: `recorded` — записан; `retry` —
 * временный отказ, следующий обход повторит переход; `dropped` — больше не
 * оценивать (владение утрачено, попытка остановлена).
 */
export type ChangeOutcome = 'recorded' | 'retry' | 'dropped';

interface Memo {
  state: LivenessState;
  /** Процессорное время каждого процесса деревьев по прошлому замеру. */
  cpu?: Map<number, number>;
  /** Прирост процессора с последнего движения. */
  pending: number;
  /** Время последнего движения по процессору (опора доли). */
  cpuAt: number;
  /** Остановлен или утрачен: дальнейших переходов нет. */
  done?: boolean;
  /** Эпизоды `stalled` (последний — текущий или прошедший). */
  episode: number;
  /** Подряд незаписанных повторов текущего перехода. */
  retries: number;
  /** Эпизод `episode` начат и не закрыт записанным выходом из `stalled`. */
  stallOpen?: boolean;
}

const SNAPSHOT_PROCESSES = 100;
/** Перерыв обходов (сон машины, занятый event loop) дольше стольких интервалов — не простой работы. */
const GAP_INTERVALS = 3;
/**
 * Перерывов подряд, после которых обход решает как обычно: машина, где каждый
 * обход опаздывает (медленный ps, нагрузка), иначе сбрасывала бы отсчёт
 * бесконечно.
 */
const MAX_GAP_RESETS = 2;
/** Незаписанных повторов одного перехода, после которых субъект больше не оценивается. */
export const MAX_CHANGE_RETRIES = 5;
/** Строка команды без маски не сохраняется. */
export const UNMASKED_COMMAND = '(строка команды скрыта: нет маски)';

/**
 * Периодический обход исполняющегося. Один ps на обход для всех попыток;
 * переходы отдаются `changed` синхронно. Попытка без исполняющихся команд
 * (ждёт hook, ресурс, интеграцию) оценивается от последнего движения с
 * большим порогом (`stalledMs`) и не выше `quiet`: её команды не зависли,
 * а снимать нечего. При `action: stop` попытка после `stalled` больше не
 * оценивается: её остановка сама выглядела бы движением.
 */
export class StallSweep {
  private readonly memo = new Map<string, Memo>();
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  /** Конец прошлого обхода: перерыв считается от него, не от начала. */
  private lastTick?: number;
  private gaps = 0;
  constructor(
    private readonly options: {
      policy: StallSweepPolicy;
      subjects: () => Iterable<SweepSubject>;
      changed: (change: LivenessChange) => ChangeOutcome | void;
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
    // Следующий запуск не считает остановленное время перерывом работы.
    this.lastTick = undefined;
    this.gaps = 0;
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
    const clock = this.options.clock ?? Date.now;
    try {
      await this.decide(clock);
    } finally {
      this.lastTick = clock();
    }
  }

  private async decide(clock: () => number) {
    const { policy } = this.options;
    const startedAt = clock();
    // Сон машины или занятый event loop: обходов не было, и молчание за это
    // время ничего не говорит о работе. Отсчёт начинается заново, решения в
    // этом обходе нет — но не больше MAX_GAP_RESETS раз подряд.
    const late =
      this.lastTick !== undefined && startedAt - this.lastTick > GAP_INTERVALS * policy.intervalMs;
    const gap = late && this.gaps < MAX_GAP_RESETS;
    this.gaps = late ? this.gaps + 1 : 0;
    const subjects = [...this.options.subjects()];
    const ids = new Set(subjects.map((s) => s.id));
    for (const id of this.memo.keys()) if (!ids.has(id)) this.memo.delete(id);
    if (gap) {
      for (const subject of subjects) {
        subject.scope.moved(startedAt);
        const memo = this.memo.get(subject.id);
        if (memo) Object.assign(memo, { cpu: undefined, pending: 0, cpuAt: startedAt });
      }
      return;
    }
    const busy = subjects.some((s) => s.scope.running.size > 0);
    const rows = busy
      ? await (this.options.sample ?? (() => sharedSample(policy.intervalMs / 2)))()
      : null;
    const now = clock();
    for (const subject of subjects) {
      const memo: Memo = this.memo.get(subject.id) ?? {
        state: 'active',
        pending: 0,
        cpuAt: now,
        episode: 0,
        retries: 0,
      };
      this.memo.set(subject.id, memo);
      if (memo.done) continue;
      const { scope } = subject;
      const tracked = [...scope.running];
      const trees = rows
        ? tracked.flatMap((t) => (t.pid ? [{ t, tree: treeOf(rows, t.pid) }] : []))
        : [];
      const known = trees.some(({ tree }) => tree.some((r) => r.cpuMs !== undefined));
      if (known) this.cpuMovement(memo, scope, trees, now);
      else memo.cpu = undefined;
      const idleMs = Math.max(0, now - scope.lastMovementAt);
      let state: LivenessState;
      if (!tracked.length) state = idleMs >= policy.stalledMs ? 'quiet' : 'active';
      else {
        state = livenessOf(idleMs, policy);
        // Без данных о процессах молчание не отличить от счёта: не выше quiet.
        if (!known && state === 'stalled') state = 'quiet';
      }
      if (state === memo.state) continue;
      const previous = memo.state;
      memo.state = state;
      // Повтор незаписанного перехода — тот же эпизод.
      const episode = state === 'stalled' && !memo.stallOpen ? memo.episode + 1 : memo.episode;
      const current = scope.current();
      const change: LivenessChange = {
        subject,
        previous,
        state,
        at: now,
        lastMovementAt: scope.lastMovementAt,
        idleMs,
        episode: state === 'stalled' ? episode : memo.episode,
        ...(current ? { activity: current.activity } : {}),
        ...(tracked.length && !known ? { cpuUnavailable: true } : {}),
      };
      if (state === 'stalled') {
        change.snapshot = snapshotOf(tracked, trees, rows, current);
        if (policy.action === 'stop') memo.done = true;
      }
      let outcome: ChangeOutcome;
      try {
        outcome = this.options.changed(change) ?? 'recorded';
      } catch {
        outcome = 'retry';
      }
      if (state === 'stalled') {
        memo.episode = episode;
        memo.stallOpen = true;
      }
      if (outcome === 'retry' && memo.retries < MAX_CHANGE_RETRIES) {
        // Переход не записан: следующий обход повторит его (ограниченно —
        // устойчивый отказ записи не повторяется бесконечно).
        memo.retries++;
        memo.state = previous;
        memo.done = false;
      } else if (outcome === 'retry' || outcome === 'dropped') memo.done = true;
      else {
        memo.retries = 0;
        if (state !== 'stalled') memo.stallOpen = false;
      }
    }
  }

  /**
   * Движение по процессору: сумма положительных приростов каждого процесса
   * (новый — от нуля). Завершившийся потомок не уменьшает счёт. Смена
   * состава дерева сама по себе движением не считается: цикл ожидания
   * (`until nc -z db 5432; do sleep 1; done`) порождает процессы без конца,
   * не продвигаясь.
   */
  private cpuMovement(
    memo: Memo,
    scope: ActivityScope,
    trees: { tree: ProcessRow[] }[],
    now: number,
  ) {
    const current = new Map<number, number>();
    for (const { tree } of trees) for (const r of tree) current.set(r.pid, r.cpuMs ?? 0);
    const previous = memo.cpu;
    memo.cpu = current;
    if (!previous) {
      memo.pending = 0;
      memo.cpuAt = now;
      return;
    }
    for (const [pid, cpu] of current) memo.pending += Math.max(0, cpu - (previous.get(pid) ?? 0));
    if (memo.pending > 0 && memo.pending >= CPU_ACTIVE_SHARE * Math.max(1, now - memo.cpuAt)) {
      scope.moved(now);
      memo.pending = 0;
      memo.cpuAt = now;
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
      processes.push({
        ...row,
        command: t.redact ? t.redact(row.command).slice(0, 1000) : UNMASKED_COMMAND,
      });
    }
  return {
    processes,
    ...(rows ? {} : { processesUnavailable: true }),
    tail: (current ?? tracked.at(-1))?.tail ?? '',
  };
}

/** Остановка обходом зависших: причина прерывания и текст отказа. */
export class StalledError extends Error {
  override name = 'StalledError';
}

/** Текст остановки по переходу в `stalled`. */
export function stallMessage(change: LivenessChange, policy: StallSweepPolicy, artifact?: string) {
  const what = change.activity
    ? `${change.activity.kind} ${change.activity.label}`
    : 'команда попытки';
  return (
    `Зависание: ${what} не двигалась ${Math.round(change.idleMs / 1000)} с ` +
    `(порог stallSweep.stalledMs ${Math.round(policy.stalledMs / 1000)} с): ` +
    'нет вывода, расхода процессора и смены стадий. Повтор или правка среды, не кода' +
    (artifact ? `; снимок: ${artifact}` : '')
  );
}

/**
 * Обход зависших для операции вне попытки (совместная проверка, gates на
 * SHA): своя область движения, один субъект. Переходы получает `onChange`
 * (запись — у вызывающего); при `action: stop` на `stalled` вызывается
 * `abort` с `StalledError`, и операция завершается отказом с её текстом.
 */
export async function superviseStalls<T>(
  policy: StallSweepPolicy,
  abort: (reason: StalledError) => void,
  fn: () => Promise<T>,
  /** Каждый переход — в обоих режимах; сбой получателя не мешает остановке. */
  onChange?: (change: LivenessChange) => void,
): Promise<T> {
  const scope = new ActivityScope();
  const sweep = new StallSweep({
    policy,
    subjects: () => [{ id: 'operation', scope }],
    changed: (change) => {
      try {
        onChange?.(change);
      } catch {
        /* Сообщение не записано: остановка не зависит от него. */
      }
      if (change.state === 'stalled' && policy.action === 'stop')
        abort(new StalledError(stallMessage(change, policy)));
    },
  });
  sweep.start();
  try {
    return await activityScope.run(scope, fn);
  } finally {
    sweep.stop();
  }
}

/**
 * Нагрузка события перехода (`attempt.liveness`, `joint.liveness`) из
 * перехода обхода: снимок урезан до пределов события, `action` — только у
 * `stalled`, `artifact` — только записанный файл снимка.
 */
export function livenessPayload(
  change: LivenessChange,
  action: StallSweepPolicy['action'],
  artifact?: string,
): RunEventPayload<'attempt.liveness'> {
  const snapshot = change.snapshot;
  return {
    state: change.state,
    previous: change.previous,
    lastMovementAt: new Date(change.lastMovementAt).toISOString(),
    idleMs: Math.round(change.idleMs),
    ...(change.activity ? { activity: change.activity } : {}),
    ...(change.cpuUnavailable ? { cpuUnavailable: true } : {}),
    ...(change.state === 'stalled' ? { action } : {}),
    ...(snapshot
      ? {
          snapshot: {
            processes: snapshot.processes.slice(0, 20).map((p) => ({
              pid: p.pid,
              parentPid: p.parentPid,
              ...(p.cpuMs !== undefined ? { cpuMs: p.cpuMs } : {}),
              command: p.command.slice(0, 300),
            })),
            ...(snapshot.processesUnavailable ? { processesUnavailable: true } : {}),
            tail: snapshot.tail.slice(-2000),
            ...(artifact ? { artifact } : {}),
          },
        }
      : {}),
  };
}
