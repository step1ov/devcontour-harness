import { z } from 'zod';
import type { EvidenceRecord } from '../contracts/index.ts';
import {
  probeStatuses,
  type ProbeJournal,
  type ProbeJournalRecord,
  type ProbeRecord,
} from './review-probe.ts';

type ReviewInspection = NonNullable<EvidenceRecord['inspection']>;
type InspectionCommand = ReviewInspection['commands'][number];
type Origin = NonNullable<InspectionCommand['origins']>[number];
type Excluded = NonNullable<ReviewInspection['excluded']>[number];
export type InspectionContext = NonNullable<ReviewInspection['context']>;

/** Пределы итога: число команд и длины сохраняемых строк (docs/review-probes.md). */
export const inspectionLimits = {
  commands: 100,
  command: 12000,
  output: 4000,
  note: 2000,
  excluded: 100,
} as const;

const noExecution =
  'Нет подтверждённого выполнения команд: ни события runtime, ни журнал проверок controller этого вызова reviewer не содержат запущенной команды.';

export const unobservedReview = (): ReviewInspection => ({
  mode: 'diff-only',
  source: 'unavailable',
  commands: [],
  reason: 'Runtime не предоставил подтверждение выполненных команд.',
});

const completedCommand = z.object({
  type: z.literal('item.completed'),
  item: z.object({
    id: z.string().min(1).max(200).optional(),
    type: z.literal('command_execution'),
    command: z.string().min(1),
    exit_code: z.number().int(),
    aggregated_output: z.string().default(''),
    status: z.enum(['completed', 'failed']),
  }),
});

const identity = (text: string) => text;

/**
 * Что reviewer действительно выполнил — по событиям runtime, а не по словам
 * модели. Завершённая команда — выполнение при любом коде выхода: ненулевой
 * код — исход проверки, а не признак того, что её не было. Повтор события
 * того же item ID — одна команда.
 */
export function inspectReview(
  runtime: string,
  output: string,
  redact: (text: string) => string = identity,
): ReviewInspection {
  if (runtime !== 'codex') return unobservedReview();
  const commands: InspectionCommand[] = [];
  const items = new Set<string>();
  for (const line of output.split('\n')) {
    try {
      const event = completedCommand.safeParse(JSON.parse(line));
      if (!event.success) continue;
      const item = event.data.item;
      if (item.id !== undefined) {
        if (items.has(item.id)) continue;
        items.add(item.id);
      }
      commands.push({
        // Маскирование — до обрезки: иначе обрезка разрезала бы секрет.
        command: redact(item.command).slice(0, inspectionLimits.command),
        exitCode: item.exit_code,
        output: redact(item.aggregated_output).slice(-inspectionLimits.output),
        origins: [{ type: 'runtime', runtime, item: item.id ?? null }],
        status: item.status,
      });
    } catch {
      /* Обрезанная или не-JSON строка не подтверждает выполнения команды. */
    }
  }
  return {
    mode: commands.length ? 'commands' : 'diff-only',
    source: 'codex-events',
    commands: commands.slice(-inspectionLimits.commands),
    reason: commands.length ? null : noExecution,
    ...(commands.length > inspectionLimits.commands ? { total: commands.length } : {}),
  };
}

const statuses = ['passed', 'failed', 'timeout', 'cancelled', 'error'] as const;
const known = new Set<string>([...statuses, 'budget-exhausted', 'rejected']);

/** argv как одна строка: аргументы с пробелами и кавычками — в одинарных кавычках. */
const argvText = (argv: string[]) =>
  argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');

/** stdout и stderr в одном ограниченном output; при нехватке места — хвосты поровну. */
function joinOutput(stdout: string, stderr: string, limit: number) {
  const both = stdout && stderr;
  const joined = both ? `${stdout}\n${stderr}` : stdout || stderr;
  if (joined.length <= limit) return joined;
  if (!both) return '…' + joined.slice(-(limit - 1));
  const half = Math.floor((limit - 3) / 2);
  const cut = (t: string, n: number) => (t.length > n ? '…' + t.slice(-(n - 1)) : t);
  const out = cut(stdout, Math.max(half, limit - 3 - Math.min(stderr.length, half)));
  return `${out}\n${cut(stderr, limit - 1 - out.length)}`.slice(-limit);
}

/** Почему запись журнала не засчитана выполнением этого вызова. */
function exclusion(
  record: ProbeJournalRecord,
  context: InspectionContext,
): Excluded['reason'] | null {
  if (!known.has(record.status)) return 'unknown-status';
  // Явно чужие вызов, фаза или SHA — не наблюдение этого ревью.
  const s = record.scope;
  if (
    s &&
    (s.attempt !== context.attempt ||
      s.phase !== context.phase ||
      s.sha !== context.sha ||
      s.call !== context.call)
  )
    return 'foreign-scope';
  const g = record.gate;
  if (g && ((g.phase && g.phase !== context.phase) || (g.sha && g.sha !== context.sha)))
    return 'foreign-scope';
  // Явный признак старта главнее правила старых записей.
  if (record.started === false) return 'not-started';
  if (record.started === true) return null;
  // В alpha.6 и ранее признака старта не было: passed/failed — исход завершившейся
  // команды; error/timeout/cancelled без подтверждения старта не засчитываются.
  return record.status === 'passed' || record.status === 'failed' ? null : 'legacy-unconfirmed';
}

function controllerCommand(
  record: ProbeJournalRecord,
  redact: (text: string) => string,
): InspectionCommand {
  return {
    command: redact(argvText(record.argv)).slice(0, inspectionLimits.command),
    // Неизвестный код остаётся неизвестным: из `passed` не выводится 0.
    exitCode: record.exitCode ?? null,
    output: joinOutput(
      redact(record.stdout ?? ''),
      redact(record.stderr ?? ''),
      inspectionLimits.output,
    ),
    origins: [{ type: 'controller', runId: record.runId }],
    status: record.status as (typeof statuses)[number],
    ...(record.failure ? { failure: record.failure } : {}),
    ...(record.gate?.id ? { gate: record.gate.id } : {}),
    ...(record.note ? { note: redact(record.note).slice(0, inspectionLimits.note) } : {}),
  };
}

/**
 * Итог `inspection` одного вызова reviewer: события runtime этого вызова и
 * журнал проверок controller этого вызова. Самоотчёт модели (`execution`,
 * `reproduction.executed`, runId в тексте) сюда не входит.
 *
 * Операция одна, если совпадает надёжная идентичность: runId запуска
 * controller, item ID runtime внутри его потока или явная структурированная
 * связь наблюдения runtime с runId controller (origin `controller` у команды
 * runtime). Совпадение текста, вывода или замаскированных аргументов
 * операции не склеивает.
 *
 * Порядок: команды runtime в порядке потока, затем запуски controller в
 * порядке журнала; при превышении предела сохраняются последние
 * {@link inspectionLimits.commands}, `total` — число всех подтверждённых.
 * Mode — по всему набору. Пользовательский текст маскируется до обрезки;
 * перечисления и идентификаторы controller не маскируются.
 */
export function reviewInspection(input: {
  /** Наблюдение runtime (ответ адаптера); нет — runtime его не дал. */
  runtime?: ReviewInspection;
  /** Журнал проверок controller этого вызова или сохранённая проекция `review.json.probes`. */
  journal?: ProbeJournal;
  context: InspectionContext;
  redact?: (text: string) => string;
}): ReviewInspection {
  const redact = input.redact ?? identity;
  const commands: InspectionCommand[] = [];
  const excluded: Excluded[] = [];
  const byItem = new Map<string, InspectionCommand>();
  const byRun = new Map<string, InspectionCommand>();
  for (const c of input.runtime?.commands ?? []) {
    const origins: Origin[] = c.origins?.length
      ? c.origins
      : [
          {
            type: 'runtime',
            runtime: input.runtime?.source === 'codex-events' ? 'codex' : 'unknown',
            item: null,
          },
        ];
    const runtimeOrigin = origins.find((o) => o.type === 'runtime');
    const item =
      runtimeOrigin?.type === 'runtime' && runtimeOrigin.item
        ? `${runtimeOrigin.runtime}\0${runtimeOrigin.item}`
        : undefined;
    const existing = item ? byItem.get(item) : undefined;
    if (existing) {
      // Повтор того же item: связь с запуском controller, пришедшая лишь в
      // повторном наблюдении, — тоже связь этой операции.
      merge(existing, origins);
      for (const o of origins) if (o.type === 'controller') byRun.set(o.runId, existing);
      continue;
    }
    const command: InspectionCommand = {
      ...c,
      command: redact(c.command).slice(0, inspectionLimits.command),
      output: redact(c.output).slice(-inspectionLimits.output),
      origins: [...origins],
    };
    commands.push(command);
    if (item) byItem.set(item, command);
    for (const o of origins) if (o.type === 'controller') byRun.set(o.runId, command);
  }
  for (const record of input.journal?.records ?? []) {
    const reason = exclusion(record, input.context);
    if (reason) {
      excluded.push({ runId: record.runId, status: record.status, reason });
      continue;
    }
    const linked = byRun.get(record.runId);
    const own = controllerCommand(record, redact);
    if (linked) {
      // Связанная операция: данные controller, происхождение обоих.
      const runtimeOrigins = linked.origins?.filter((o) => o.type === 'runtime') ?? [];
      Object.assign(linked, own, { origins: [...runtimeOrigins, ...own.origins!] });
      byRun.delete(record.runId);
      continue;
    }
    commands.push(own);
  }
  // Связь с runId, которого нет среди засчитанных запусков, не подтверждает
  // запуск controller: остаётся только наблюдение runtime.
  for (const [runId, linked] of byRun)
    linked.origins = linked.origins?.filter((o) => o.type !== 'controller' || o.runId !== runId);
  for (const r of input.journal?.reservations ?? [])
    excluded.push({
      runId: r.runId,
      status: null,
      reason: r.abandoned ? 'abandoned' : 'unfinished',
    });
  const runtimeSeen = commands.some((c) => c.origins?.some((o) => o.type === 'runtime'));
  const controllerSeen = commands.some((c) => c.origins?.some((o) => o.type === 'controller'));
  const source: ReviewInspection['source'] =
    runtimeSeen && controllerSeen
      ? 'runtime-and-controller'
      : controllerSeen
        ? 'controller-probes'
        : (input.runtime?.source ?? 'unavailable');
  // Команды runtime, не вошедшие в его ограниченный список, — тоже
  // подтверждённые операции: они учитываются в total и mode.
  const dropped = Math.max(0, (input.runtime?.total ?? 0) - (input.runtime?.commands.length ?? 0));
  const total = commands.length + dropped;
  const observed = total > 0;
  return {
    mode: observed ? 'commands' : 'diff-only',
    source,
    commands: commands.slice(-inspectionLimits.commands),
    reason: observed ? null : noExecution,
    context: input.context,
    total,
    ...(input.journal?.invalid ? { invalid: input.journal.invalid } : {}),
    ...(excluded.length
      ? {
          excluded: excluded.slice(0, inspectionLimits.excluded),
          ...(excluded.length > inspectionLimits.excluded
            ? { excludedTotal: excluded.length }
            : {}),
        }
      : {}),
  };
}

/**
 * Маскирование сохранённого inspection: только свободный текст (`command`,
 * `output`, `note`, `reason`) и с обрезкой до пределов после маски — замена
 * секрета может удлинить строку. Перечисления, origins, контекст и
 * идентификаторы controller не маскируются — короткий секрет, совпавший с
 * их частью, не делает запись невалидной.
 */
export function redactInspection(
  inspection: ReviewInspection,
  redact: (text: string) => string,
): ReviewInspection {
  return {
    ...inspection,
    commands: inspection.commands.map((c) => ({
      ...c,
      command: redact(c.command).slice(0, inspectionLimits.command),
      output: redact(c.output).slice(-inspectionLimits.output),
      ...(c.note !== undefined ? { note: redact(c.note).slice(0, inspectionLimits.note) } : {}),
    })),
    reason: inspection.reason === null ? null : redact(inspection.reason),
  };
}

function merge(target: InspectionCommand, origins: Origin[]) {
  const key = (o: Origin) =>
    o.type === 'runtime' ? `r\0${o.runtime}\0${o.item}` : `c\0${o.runId}`;
  const have = new Set((target.origins ?? []).map(key));
  target.origins = [...(target.origins ?? []), ...origins.filter((o) => !have.has(key(o)))];
}

/**
 * Сохранённая проекция `review.json.probes` (alpha.6 и ранее: без кода, вывода и
 * признака старта) как журнал для {@link reviewInspection}. Пересчёт старого
 * состояния не выполняется: это вход для отдельной агрегации старых данных.
 */
export function journalFromProjection(probes: unknown): ProbeJournal {
  const records: ProbeJournalRecord[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const p of Array.isArray(probes) ? probes : []) {
    const r = p as Partial<ProbeRecord> | null;
    if (
      !r ||
      typeof r !== 'object' ||
      typeof r.runId !== 'string' ||
      !r.runId ||
      typeof r.status !== 'string' ||
      !Array.isArray(r.argv) ||
      !r.argv.every((a) => typeof a === 'string')
    ) {
      invalid++;
      continue;
    }
    if (seen.has(r.runId)) continue;
    if (probeStatuses.has(r.status)) seen.add(r.runId);
    records.push({ ...(r as ProbeRecord) });
  }
  return { records, invalid, reservations: [] };
}
