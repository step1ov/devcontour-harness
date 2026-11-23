// Журнал ведущего (0.1.0-alpha.66, P4-10): сессия ведущего с арендой
// (`harness lead begin|end`), короткие заметки о работе вне harness (`lead
// note`), команды harness ведущего — записью простыми словами — и итоговый
// отчёт выпуска (`release done`). Всё — одна локальная запись `lead` состояния
// (`Engine.recordLead`); представление оператора читает её как раздел `lead`,
// ленту и шаг «итоговый отчёт» прогноза.

import {
  HarnessError,
  LEAD_LIMITS,
  WORKSPACE_OWNER,
  type ExecutionView,
  type LeadData,
  type LeadEntry,
  type LeadLog,
} from '../contracts/index.ts';
import type { Engine } from '../engine/engine.ts';
import { ruCount } from '../contracts/plural.ts';
import { maskSecrets } from '../projections/mask.ts';
import { parseDurationFlag } from './duration.ts';

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

/**
 * Аренда сессии (`--ttl`): длительность с единицей (`90s`, `30m`, `2h`),
 * от 1 минуты до 12 часов; без флага — 30 минут. Голое число — отказ.
 */
export function leadTtlMs(raw: string | undefined): number {
  if (raw === undefined) return LEAD_LIMITS.ttlDefaultMs;
  return parseDurationFlag('ttl', raw, {
    minMs: LEAD_LIMITS.ttlMinMs,
    maxMs: LEAD_LIMITS.ttlMaxMs,
  });
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
  /** `retry --by lead`: сброс ведущего (0.1.0-alpha.66). */
  by?: string;
}

/** Ответ команды, который уточняет строку журнала. */
type CommandData =
  | {
      abandoned?: boolean;
      changed?: boolean;
      /** `retry --reset`: итог сброса (ведущего — с разбором и номером). */
      reset?: {
        performed: boolean;
        by?: 'lead';
        diagnosis?: string;
        index?: number;
        cap?: number;
        granted?: number;
      };
      /** `diagnose`: записанный разбор и что дальше. */
      diagnosis?: { id: string; cause: string };
      next?: string;
    }
  | undefined;

/** Что дальше после разбора — простыми словами. */
const diagnoseNext: Record<string, { ru: string; en: string }> = {
  attempt: { ru: 'следующая попытка получит гипотезу', en: 'the next attempt gets the hypothesis' },
  diagnose: { ru: 'нужен ещё разбор', en: 'another diagnosis is needed' },
  replan: { ru: 'перепланировать задачу', en: 're-plan the task' },
  'user-decision': { ru: 'решает человек', en: 'a human decides' },
  'lead-reset': {
    ru: 'ведущий может дать новый предел попыток',
    en: 'the lead may grant a new attempt limit',
  },
  'user-reset': {
    ru: 'новый предел попыток даёт человек',
    en: 'a human grants a new attempt limit',
  },
};

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
  if (leadCommandActor(command, args) === 'operator') return undefined;
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
    case 'retry': {
      // Сброс ведущего (`--reset --by lead`) — запись восстановления: по какому
      // разбору, какой сброс по счёту, сколько попыток дано.
      const r = d?.reset;
      if (args.by === 'lead' && args.reset && r?.performed && r.by === 'lead')
        return one(
          `ведущий сам дал ${w} ещё ${r.granted ? ruCount(r.granted, ['попытку', 'попытки', 'попыток']) : 'попытки'} по разбору ${r.diagnosis ?? '?'} (сброс ${r.index ?? '?'} из ${r.cap ?? '?'})`,
          `the lead granted ${w} ${r.granted ?? '?'} more attempt${r.granted === 1 ? '' : 's'} after diagnosis ${r.diagnosis ?? '?'} (reset ${r.index ?? '?'} of ${r.cap ?? '?'})`,
        );
      return one(
        `ведущий повторил работу ${w}${args.reset ? ' со сбросом попыток' : ''}`,
        `the lead retried ${w}${args.reset ? ' with an attempt reset' : ''}`,
      );
    }
    case 'diagnose': {
      const next = d?.next ? diagnoseNext[d.next] : undefined;
      return one(
        `ведущий разобрал отказы ${w}: ${d?.diagnosis?.id ?? 'разбор'}, причина ${d?.diagnosis?.cause ?? '?'}${next ? `; дальше — ${next.ru}` : ''}`,
        `the lead diagnosed the failures of ${w}: ${d?.diagnosis?.id ?? 'diagnosis'}, cause ${d?.diagnosis?.cause ?? '?'}${next ? `; next — ${next.en}` : ''}`,
      );
    }
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
  'diagnose',
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

/** Команды, которые по договору подаёт только ведущий: `diagnose` — его разбор. */
const LEAD_ONLY_COMMANDS: readonly string[] = ['diagnose'];
/**
 * Команды, которые движок без `--by lead` исполняет как действие оператора
 * (`retry` — повтор оператора, удержание gate не снимает): без `--by` они
 * оператора, иначе журнал ведущего записал бы чужое решение. В открытой
 * сессии ведущего CLI сам подставляет `--by lead` (alpha.68, `bySource`), и
 * журнал получает этот флаг. `cancel` пути ведущего не имеет (`--by` нет) —
 * решает сессия.
 */
const OPERATOR_UNLESS_LEAD: readonly string[] = ['retry'];

/**
 * Кто подал команду: явный `--by`/`--actor` решает сам — `lead` это ведущий,
 * любое другое значение (`operator`, имя человека у `reapprove --by`) —
 * оператор; команда только ведущего (`diagnose`) — ведущий; `retry` без
 * `--by lead` — оператор, как его исполняет движок. Иначе
 * `undefined`: решает сессия ведущего (`recordLeadCommand`).
 */
export function leadCommandActor(
  command: string,
  args: LeadCommandArgs,
): 'lead' | 'operator' | undefined {
  const explicit = args.by ?? args.actor;
  if (explicit !== undefined) return explicit === 'lead' ? 'lead' : 'operator';
  if (OPERATOR_UNLESS_LEAD.includes(command)) return 'operator';
  return LEAD_ONLY_COMMANDS.includes(command) ? 'lead' : undefined;
}

/**
 * Записать команду ведущего в журнал (продлевает активную сессию). Команда —
 * ведущего, если `actor === 'lead'` (`leadCommandActor`: явный `--by lead`,
 * `--actor lead`, команда только ведущего) или, без явного актёра, если сессия ведущего активна сейчас. Иначе это команда
 * оператора: в журнал ведущего она не пишется, аренду не продлевает и запись
 * `lead` состояния не трогает. Возвращает, записана ли строка.
 */
export function recordLeadCommand(
  engine: Engine,
  entry: Omit<LeadEntry, 'at'>,
  actor?: 'lead' | 'operator',
): boolean {
  if (actor === 'operator') return false;
  if (actor !== 'lead') {
    const log = engine.read((v) => v.local('lead', WORKSPACE_OWNER, 'log'));
    if (!log || !activeAt(log, engine.clock())) return false;
  }
  engine.recordLead((log, now) => ({
    log: append(log, { ...entry, at: iso(now) }, now),
    result: undefined,
  }));
  return true;
}

/**
 * Открыта ли сейчас сессия ведущего (`lead begin` без `lead end`, аренда не
 * истекла; alpha.68, P6-17). `retry` без `--by` внутри открытой сессии —
 * повтор ведущего: движок исполняет его как `--by lead`, с теми же правами и
 * отказами. `input-answer` без `--actor` остаётся ответом оператора: ответ
 * владельца, который передаёт ведущий, не записывается решением ведущего.
 */
export function leadSessionOpen(engine: Engine): boolean {
  const log = engine.read((v) => v.local('lead', WORKSPACE_OWNER, 'log'));
  return !!log && activeAt(log, engine.clock());
}

/** Откуда актёр команды: флаг, открытая сессия ведущего или прежнее умолчание. */
export type LeadActorSource = 'flag' | 'lead-session' | 'default';

/**
 * Отказ команды, которой актёра `lead` дала сессия ведущего: тот же код, к
 * сообщению — откуда актёр и как подать решение человека явно.
 */
export function leadSessionRefusal(error: unknown, flag: '--by'): unknown {
  if (!(error instanceof HarnessError)) return error;
  return new HarnessError(
    error.code,
    `${error.message} (${flag} не задан: в открытой сессии ведущего команда исполняется как ${flag} lead; решение человека — явно ${flag} operator)`,
    error.issues,
  );
}
