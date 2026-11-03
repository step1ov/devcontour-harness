import type { WorkStatus } from './enums.ts';

/** Сохранённая попытка в объёме, который нужен проекции (`AttemptState`). */
export interface AttemptViewInput {
  id: string;
  workId: string;
  attempt: number;
  status: string;
  /** Статус поручения на этой попытке (`AttemptState.phase`). */
  phase: WorkStatus;
  owner: string;
  runtime: string;
  model?: string;
  startedAt: string;
  /** Срок владения, epoch ms. */
  leaseUntil: number;
  timings?: readonly {
    id: string;
    stage: string;
    startedAt: string;
    finishedAt?: string;
    outcome?: 'passed' | 'failed';
  }[];
  evidence: readonly {
    kind: 'test' | 'review';
    phase: 'candidate' | 'integration';
    gate: string;
    passed: boolean;
    consumer?: string;
  }[];
  /** Gates, которые попытка обязана пройти в каждой фазе (`AttemptState.requiredGates`). */
  requiredGates?: readonly string[];
}

export interface AttemptViewOptions {
  /** Текущее время, epoch ms. */
  now: number;
  /** Длина владения политики (`leaseMs`): heartbeat продлевает срок на неё. */
  leaseMs: number;
  /** Gates репозитория, когда у попытки нет `requiredGates` (прежние записи). */
  repositoryGates?: readonly string[];
}

export interface AttemptView {
  runId: string;
  workId: string;
  attempt: number;
  status: string;
  phase: WorkStatus;
  runtime: string;
  model?: string;
  startedAt: string;
  elapsedMs: number;
  /**
   * Текущая стадия — последний начатый и не закрытый замер; нет — между
   * стадиями. `family` — имя без уточнений после `:` (`candidate-test`).
   */
  stage?: { name: string; family: string; startedAt: string; elapsedMs: number };
  /**
   * Владение: последний heartbeat выводится из срока (`leaseUntil − leaseMs`);
   * `stale` — срок истёк, владелец больше не может писать.
   */
  lease: {
    owner: string;
    leaseUntil: number;
    leaseMs: number;
    sinceHeartbeatMs: number;
    stale: boolean;
  };
  /**
   * Gates текущей фазы (интеграции — в `integrating`, иначе кандидата) по
   * последней записи каждого gate без проверок потребителей: прошли, не
   * прошли и ещё без записи из обязательных.
   */
  gates: {
    phase: 'candidate' | 'integration';
    required: number;
    passed: number;
    failed: number;
    remaining: number;
  };
}

const ms = (iso: string) => Date.parse(iso);

/**
 * Активная попытка глазами наблюдателя: стадия и её длительность, свежесть
 * владения, прогресс gates. Чистая функция сохранённой попытки и часов —
 * без node:*, её же используют `status --detail` и хост.
 */
export function attemptView(input: AttemptViewInput, options: AttemptViewOptions): AttemptView {
  const { now, leaseMs } = options;
  const open = (input.timings ?? []).filter((t) => !t.finishedAt);
  const current = open.reduce<(typeof open)[number] | undefined>(
    (a, t) => (!a || ms(t.startedAt) >= ms(a.startedAt) ? t : a),
    undefined,
  );
  const phase = input.phase === 'integrating' ? 'integration' : 'candidate';
  const latest = new Map<string, boolean>();
  for (const e of input.evidence)
    if (e.kind === 'test' && e.phase === phase && !e.consumer) latest.set(e.gate, e.passed);
  const required = [...(input.requiredGates ?? options.repositoryGates ?? [])];
  const passed = [...latest.values()].filter(Boolean).length;
  return {
    runId: input.id,
    workId: input.workId,
    attempt: input.attempt,
    status: input.status,
    phase: input.phase,
    runtime: input.runtime,
    ...(input.model ? { model: input.model } : {}),
    startedAt: input.startedAt,
    elapsedMs: Math.max(0, now - ms(input.startedAt)),
    ...(current
      ? {
          stage: {
            name: current.stage,
            family: current.stage.split(':')[0]!,
            startedAt: current.startedAt,
            elapsedMs: Math.max(0, now - ms(current.startedAt)),
          },
        }
      : {}),
    lease: {
      owner: input.owner,
      leaseUntil: input.leaseUntil,
      leaseMs,
      sinceHeartbeatMs: Math.max(0, now - (input.leaseUntil - leaseMs)),
      stale: input.leaseUntil <= now,
    },
    gates: {
      phase,
      required: required.length,
      passed,
      failed: latest.size - passed,
      remaining: required.filter((g) => !latest.has(g)).length,
    },
  };
}
