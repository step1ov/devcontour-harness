// Журнал ведущего (0.1.0-alpha.66, P4-10): сессия ведущего с арендой
// (`harness lead begin|end`), короткие заметки о работе вне harness (`lead
// note`), команды harness ведущего — записью простыми словами — и итоговый
// отчёт выпуска (`release done`). Всё — одна локальная запись `lead` состояния
// (`Engine.recordLead`); представление оператора читает её как раздел `lead`,
// ленту и шаг «итоговый отчёт» прогноза.

import {
  HarnessError,
  LEAD_LIMITS,
  type ExecutionView,
  type LeadData,
  type LeadEntry,
  type LeadLog,
} from '../contracts/index.ts';
import type { Engine } from '../engine/engine.ts';
import { maskSecrets } from '../projections/mask.ts';

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Строка ведущего: без управляющих символов и ANSI, пробелы схлопнуты,
 * секреты маскированы, длина — не больше `max`. Пусто — отказ `INVALID_INPUT`.
 */
export function cleanLeadText(raw: string | undefined, max: number, what: string): string {
  const text = maskSecrets(
    String(raw ?? '')
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  if (!text) throw new HarnessError('INVALID_INPUT', `${what}: нужна непустая строка`);
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

/** Сессия активна: не закончена и аренда не истекла. */
const activeAt = (log: LeadLog, now: number) =>
  !!log.session && !log.session.endedAt && Date.parse(log.session.until) > now;

/**
 * Добавить запись: старые вытесняются пределом; активная сессия продлевается
 * на свою аренду — ведущий отметился.
 */
function append(log: LeadLog, entry: LeadEntry, now: number): LeadLog {
  const entries = [...log.entries, entry].slice(-LEAD_LIMITS.entries);
  const session =
    log.session && activeAt(log, now)
      ? {
          ...log.session,
          until: iso(Math.max(Date.parse(log.session.until), now + log.session.ttlMs)),
        }
      : log.session;
  return { ...log, ...(session ? { session } : {}), entries };
}

/** Состояние ведущего для ответа команды. */
function leadState(log: LeadLog, now: number): LeadData['lead'] {
  const s = log.session;
  const note = [...log.entries].reverse().find((e) => e.kind === 'note');
  return {
    active: activeAt(log, now),
    ...(s ? { since: s.since, until: s.until } : {}),
    ...(s?.endedAt ? { endedAt: s.endedAt } : {}),
    ...(note ? { lastNote: note.plain } : {}),
  };
}

/** Аренда сессии в минутах (`--ttl`): по умолчанию 30, от 1 до 720. */
export function leadTtlMs(minutes: string | undefined): number {
  if (minutes === undefined) return LEAD_LIMITS.ttlDefaultMs;
  const n = Number(minutes);
  const ms = Math.round(n * 60_000);
  if (!Number.isFinite(n) || ms < LEAD_LIMITS.ttlMinMs || ms > LEAD_LIMITS.ttlMaxMs)
    throw new HarnessError(
      'INVALID_INPUT',
      `--ttl: минуты от ${LEAD_LIMITS.ttlMinMs / 60_000} до ${LEAD_LIMITS.ttlMaxMs / 60_000}`,
    );
  return ms;
}

/**
 * `lead begin`: начать (или продолжить) сессию ведущего с арендой `ttlMs`.
 * Повтор при активной сессии продлевает её, `since` прежний.
 */
export function leadBegin(engine: Engine, options: { ttlMs: number; text?: string }): LeadData {
  const note = options.text
    ? cleanLeadText(options.text, LEAD_LIMITS.note, 'lead begin --text')
    : undefined;
  return engine.recordLead((log, now) => {
    const resumed = activeAt(log, now);
    const session = {
      since: resumed ? log.session!.since : iso(now),
      until: iso(now + options.ttlMs),
      ttlMs: options.ttlMs,
    };
    const entry: LeadEntry = {
      at: iso(now),
      kind: 'begin',
      action: 'lead.begin',
      plain: note ? `ведущий начал работу: ${note}` : 'ведущий начал работу',
      plainEn: note ? `the lead started working: ${note}` : 'the lead started working',
    };
    const next = append({ ...log, session }, entry, now);
    const withNote = note
      ? append(next, { at: iso(now), kind: 'note', action: 'lead.note', plain: note }, now)
      : next;
    return {
      log: withNote,
      result: {
        lead: leadState(withNote, now),
        entry,
        line: resumed
          ? `Сессия ведущего продлена до ${session.until}.`
          : `Сессия ведущего начата; аренда до ${session.until}: продлевается каждой записью ведущего.`,
      },
    };
  });
}

/** `lead note`: короткая строка о том, что ведущий делает (вне harness — тоже). */
export function leadNote(engine: Engine, options: { text: string; workId?: string }): LeadData {
  const plain = cleanLeadText(options.text, LEAD_LIMITS.note, 'lead note --text');
  return engine.recordLead((log, now, view) => {
    if (options.workId && !view.work(options.workId))
      throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + options.workId);
    const entry: LeadEntry = {
      at: iso(now),
      kind: 'note',
      action: 'lead.note',
      ...(options.workId ? { workId: options.workId } : {}),
      plain,
    };
    const next = append(log, entry, now);
    return {
      log: next,
      result: {
        lead: leadState(next, now),
        entry,
        line: activeAt(next, now)
          ? 'Запись ведущего сохранена.'
          : 'Запись ведущего сохранена; сессии нет — начните её: harness lead begin.',
      },
    };
  });
}

/** `lead end`: закончить сессию (необязательная строка — чем закончил). */
export function leadEnd(engine: Engine, options: { text?: string } = {}): LeadData {
  const note = options.text
    ? cleanLeadText(options.text, LEAD_LIMITS.note, 'lead end --text')
    : undefined;
  return engine.recordLead((log, now) => {
    const entry: LeadEntry = {
      at: iso(now),
      kind: 'end',
      action: 'lead.end',
      plain: note ? `ведущий закончил работу: ${note}` : 'ведущий закончил работу',
      plainEn: note ? `the lead stopped working: ${note}` : 'the lead stopped working',
    };
    const base = append(log, entry, now);
    const next: LeadLog = base.session
      ? { ...base, session: { ...base.session, endedAt: iso(now), until: iso(now) } }
      : base;
    return {
      log: next,
      result: { lead: leadState(next, now), entry, line: 'Сессия ведущего закончена.' },
    };
  });
}

/** Работы, которые ещё не приняты: открытые (в том числе открытые доработки). */
function unfinished(view: ExecutionView) {
  return view
    .works()
    .filter((w) => w.status !== 'done' && w.status !== 'cancelled')
    .map((w) => w.id);
}

/**
 * `release done --summary`: итоговый отчёт ведущего. Только когда весь код
 * принят (ни одной открытой работы или доработки): до него представление
 * говорит «код принят, ведущий ещё работает», и готовность меньше 100 %.
 */
export function releaseDone(engine: Engine, options: { summary: string }): LeadData {
  const summary = cleanLeadText(options.summary, LEAD_LIMITS.summary, 'release done --summary');
  return engine.recordLead((log, now, view) => {
    const open = unfinished(view);
    if (open.length)
      throw new HarnessError(
        'NOT_READY',
        `Выпуск не готов: не приняты ${open.slice(0, 10).join(', ')}${open.length > 10 ? ` и ещё ${open.length - 10}` : ''}`,
      );
    const accepted = view.works().filter((w) => w.status === 'done').length;
    if (!accepted) throw new HarnessError('NOT_READY', 'Выпуск не готов: принятых работ нет');
    const release = { doneAt: iso(now), summary, works: accepted };
    const short = summary.length > 150 ? summary.slice(0, 149) + '…' : summary;
    const entry: LeadEntry = {
      at: iso(now),
      kind: 'release-done',
      action: 'release.done',
      plain: `ведущий закончил выпуск: ${short}`.slice(0, LEAD_LIMITS.note),
      plainEn: `the lead finished the release: ${short}`.slice(0, LEAD_LIMITS.note),
    };
    const next = append({ ...log, release }, entry, now);
    return {
      log: next,
      result: {
        lead: leadState(next, now),
        entry,
        release,
        line: `Выпуск готов: принято работ ${accepted}; итоговый отчёт записан.`,
      },
    };
  });
}

/** Значения флагов команды, которые читает строка журнала. */
export interface LeadCommandArgs {
  work?: string;
  request?: string;
  actor?: string;
  reset?: boolean;
}

/** Ответ команды, который уточняет строку журнала. */
type CommandData = { abandoned?: boolean; changed?: boolean } | undefined;

/**
 * Команды harness ведущего, которые журнал записывает сам (P4-10 a): ru и en
 * строка по флагам и ответу. Нет строки — команда не пишется (чтение, или
 * решение оператора `--actor operator`).
 */
export function leadCommandEntry(
  command: string,
  args: LeadCommandArgs,
  data: unknown,
  phase: 'start' | 'end' = 'end',
): Omit<LeadEntry, 'at'> | undefined {
  if (args.actor === 'operator') return undefined;
  const w = args.work;
  const d = data as CommandData;
  const one = (plain: string, plainEn: string, workId = w) => ({
    kind: 'command' as const,
    action: `lead.${command}`,
    ...(workId ? { workId } : {}),
    plain: plain.slice(0, LEAD_LIMITS.note),
    plainEn: plainEn.slice(0, LEAD_LIMITS.note),
  });
  switch (command) {
    case 'run':
      return phase === 'start'
        ? one('ведущий запустил harness run', 'the lead started harness run')
        : one('harness run ведущего закончился', "the lead's harness run ended");
    case 'review-plan':
      return one(
        'ведущий отправил план на независимое ревью',
        'the lead sent the plan to an independent review',
      );
    case 'review-contract':
      return one(
        'ведущий отправил контракт на независимое ревью',
        'the lead sent the contract to an independent review',
      );
    case 'review-accept':
      return one(
        'ведущий принял находки ревью известным ограничением',
        'the lead accepted review findings as a known limitation',
      );
    case 'approve':
      return one('ведущий согласовал план', 'the lead approved the plan');
    case 'reapprove':
      return one(
        'ведущий пересогласовал план после правки политики',
        'the lead re-approved the plan after a policy change',
      );
    case 'retry':
      return one(
        `ведущий повторил работу ${w}${args.reset ? ' со сбросом попыток' : ''}`,
        `the lead retried ${w}${args.reset ? ' with an attempt reset' : ''}`,
      );
    case 'cancel':
      return d?.abandoned
        ? one(
            `ведущий оставил доработку ${w}: работа вернулась к принятой редакции`,
            `the lead abandoned the rework of ${w}: the work is back at its accepted revision`,
          )
        : one(`ведущий отменил работу ${w}`, `the lead cancelled ${w}`);
    case 'pause':
      return one('ведущий поставил очередь на паузу', 'the lead paused the queue');
    case 'resume':
      return one('ведущий снял паузу очереди', 'the lead resumed the queue');
    case 'deliver':
      return one(
        `ведущий повторил доставку результата ${w}`,
        `the lead re-delivered the result of ${w}`,
      );
    case 'source-snapshot':
      return one(
        'ведущий прочитал задачи из источника и проверил план',
        'the lead read the tasks from the source and checked the plan',
      );
    case 'source-deliver':
      return one(
        `ведущий доставил результат ${w ?? ''} в источник задач`.replace('  ', ' '),
        `the lead delivered ${w ? `the result of ${w}` : 'results'} to the task source`,
      );
    case 'source-reconcile':
      return one(
        'ведущий сверил доставку с источником задач',
        'the lead reconciled the delivery with the task source',
      );
    case 'input-answer':
    case 'input-resolve':
      return one(
        `ведущий ответил на вопрос исполнителя ${args.request ?? ''}`.trimEnd(),
        `the lead answered the writer question ${args.request ?? ''}`.trimEnd(),
        undefined,
      );
    case 'input-apply':
    case 'input-carry':
      return one(
        `ведущий передал ответ ${args.request ?? ''} следующей попытке`.replace('  ', ' '),
        `the lead passed answer ${args.request ?? ''} to the next attempt`.replace('  ', ' '),
        undefined,
      );
    case 'input-cancel':
    case 'input-supersede':
      return one(
        `ведущий закрыл вопрос ${args.request ?? ''}`.trimEnd(),
        `the lead closed question ${args.request ?? ''}`.trimEnd(),
        undefined,
      );
    default:
      return undefined;
  }
}

/** Команды, которые журнал ведущего записывает сам. */
export const LEAD_LOGGED_COMMANDS = [
  'run',
  'review-plan',
  'review-contract',
  'review-accept',
  'approve',
  'reapprove',
  'retry',
  'cancel',
  'pause',
  'resume',
  'deliver',
  'source-snapshot',
  'source-deliver',
  'source-reconcile',
  'input-answer',
  'input-resolve',
  'input-apply',
  'input-carry',
  'input-cancel',
  'input-supersede',
] as const;

/** Записать команду ведущего в журнал (продлевает активную сессию). */
export function recordLeadCommand(engine: Engine, entry: Omit<LeadEntry, 'at'>) {
  engine.recordLead((log, now) => ({
    log: append(log, { ...entry, at: iso(now) }, now),
    result: undefined,
  }));
}
