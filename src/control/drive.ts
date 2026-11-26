// `harness lead drive` (alpha.72, P9-9): ожидание за ведущего без модели.
// Ведущий агент, который сам ждёт `harness run` циклом `wait --timeout 50s`,
// на каждом пустом пробуждении заново отправляет модели растущую историю
// сессии (пилот 9: 533 ожидания, 488 пустых, 1,46 млрд входных токенов).
// Драйвер ждёт сам — тем же `waitFor` и тем же курсором — и запускает
// команду ведущего хоста (`--agent`) только на значимом событии: отказ или
// удержание, которые harness сам не чинит, вопрос, готовый выпуск, очередь
// без `harness run`. Каждая сессия — новая (короткий контекст): цели
// оператора и короткая сводка события на stdin, не история. Принятие работы,
// таймаут ожидания и отказ, который harness повторит сам, ведущего не будят.
// Вопрос, на который ведущему отвечать нельзя, — уведомление владельцу
// (stderr и `notices`) и одна сессия ведущего (`owner-question`): передать
// вопрос в канал владельца (Relay), не отвечая; тот же вопрос ведущего больше
// не будит. Драйвер ждёт дальше, отказы независимых работ будят ведущего,
// ответ владельца — тоже. Выход с отдельным
// кодом — когда идти дальше нечему (run не идёт, готовых работ нет, ждут
// только ответа владельца) или шаг только человека (бюджет, доступ к
// провайдеру, пауза оператора). Сессии без изменений состояния подряд и
// сессии сверх `--session-timeout` — остановка с диагнозом, без бесконечного
// перезапуска.

import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  HarnessError,
  WORKSPACE_OWNER,
  inputPolicyOf,
  leadAnswerBasis,
  type ExecutionPolicy,
  type ExecutionView,
  type InputRequest,
} from '../contracts/index.ts';
import { diagnoseState } from '../explain/diagnose.ts';
import type { NotPromise } from '../contracts/ports.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';
import { pendingKind, releaseReady, waitFor, waitStatusLine, type WaitData } from './wait.ts';

/** Исходы драйвера и их коды выхода (коды `wait` 10–16 не пересекаются, кроме aborted). */
export const DRIVE_EXIT_CODES = {
  'release-done': 0,
  aborted: 16,
  owner: 20,
  'no-progress': 21,
  'max-sessions': 22,
  'agent-error': 23,
} as const;
export type DriveOutcome = keyof typeof DRIVE_EXIT_CODES;

/** Исходы `wait`, которые будят ведущего (принятие и таймаут — нет). */
const WAKING = new Set<WaitData['kind']>([
  'failed',
  'held',
  'question',
  'release-ready',
  'stopped',
]);

/** Действия explain, которые совершает только человек: ведущего не будим. */
const OWNER_ACTIONS = new Set(['raise-budget', 'fix-access']);

export interface DriveSession {
  session: number;
  /** Чем разбужен ведущий; `owner-question` — передать новый вопрос владельцу. */
  kind: WaitData['kind'] | 'owner-question';
  workId?: string;
  cursor: number;
  /** Код выхода команды ведущего (`null` — снят сигналом). */
  exitCode: number | null;
  /** Состояние изменилось за сессию (события, журнал ведущего, итог выпуска). */
  progressed: boolean;
  /** Сессия превысила `--session-timeout` и снята (SIGTERM, затем SIGKILL). */
  timedOut?: true;
  ms: number;
}

/** Уведомление владельцу: вопрос, на который ведущему отвечать нельзя. */
export interface DriveNotice {
  at: string;
  kind: 'owner-question' | 'owner-answered';
  requestId: string;
  workId?: string;
  message: string;
}

export interface DriveData {
  outcome: DriveOutcome;
  /** Итог простыми словами: что случилось и что дальше. */
  message: string;
  sessions: DriveSession[];
  /** Уведомления владельцу, пока драйвер ждал дальше. */
  notices: DriveNotice[];
  /** Сколько внутренних ожиданий (`waitFor`) прошло. */
  waits: number;
  cursor: number;
  status: string;
  /** Последнее значимое событие (для owner — то, что ждёт владельца). */
  last?: {
    kind: WaitData['kind'];
    workId?: string;
    next?: WaitData['next'];
  };
}

export interface DriveInput {
  stateDir: string;
  policy: ExecutionPolicy;
  /** Файл политики — для команд в сводке ведущему. */
  policyPath: string;
  baseDir: string;
  /** Команда ведущего хоста: argv, подстановки `{session}`, `{cursor}`, `{prompt-file}`. */
  agent: string[];
  /** Цели оператора (короткий prompt): начало каждой сессии. */
  goals: string;
  /** CLI harness для команд сводки (`H=…`). */
  harnessBin: string;
  maxSessions?: number;
  /** Сессий подряд без изменения состояния до остановки (по умолчанию 3). */
  idleSessions?: number;
  /** Предел одного внутреннего ожидания (по умолчанию 60 мин). */
  waitTimeoutMs?: number;
  /** Предел одной сессии ведущего (по умолчанию 60 мин): дольше — SIGTERM, затем SIGKILL. */
  sessionTimeoutMs?: number;
  /** Между SIGTERM и SIGKILL снятой сессии (по умолчанию 10 с). */
  killGraceMs?: number;
  /** После сессии ведущего `stopped` перепроверяется не раньше этого (по умолчанию 30 с). */
  graceMs?: number;
  pollMs?: number;
  /** Каталог журналов: prompt, stdout и stderr каждой сессии. */
  logDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Строки хода для оператора (CLI — stderr). */
  onLog?: (line: string) => void;
  /** Продление сессии ведущего во время ожидания (CLI). */
  onTick?: () => void;
}

/**
 * Разобрать шаблон команды как оболочка, но без оболочки: пробелы делят
 * аргументы, кавычки `'…'` и `"…"` их склеивают, `\` экранирует символ.
 */
export function parseAgentTemplate(template: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === '\\' && quote === '"' && i + 1 < template.length) current += template[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === '\\' && i + 1 < template.length) {
      current += template[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote)
    throw new HarnessError('INVALID_INPUT', '--agent: незакрытая кавычка в шаблоне команды', [
      { path: ['--agent'], message: template },
    ]);
  if (started) args.push(current);
  if (!args.length)
    throw new HarnessError('INVALID_INPUT', '--agent: пустой шаблон команды', [
      { path: ['--agent'], message: template },
    ]);
  return args;
}

/** Прочитать состояние на чтение; базы ещё нет — undefined. */
function readState<T>(
  stateDir: string,
  fn: (view: ExecutionView, lastSeq: number) => NotPromise<T>,
): T | undefined {
  const file = join(resolve(stateDir), 'state.sqlite');
  if (!existsSync(file)) return undefined;
  let store: SqliteExecutionStore;
  try {
    store = new SqliteExecutionStore(file, 'harness-drive', { readOnly: true });
  } catch {
    return undefined;
  }
  try {
    const seq = store.lastEventSeq();
    return store.read((view) => fn(view, seq));
  } finally {
    store.close();
  }
}

const leadLog = (view: ExecutionView) => view.local('lead', WORKSPACE_OWNER, 'log');

/** Выпуск закончен: `release done` записан, и с тех пор работ не прибавилось. */
const releaseDone = (view: ExecutionView) => {
  const release = leadLog(view)?.release;
  if (!release || !releaseReady(view)) return false;
  return view.works().filter((w) => w.status === 'done').length === release.works;
};

/** Отпечаток изменений состояния: события, записи журнала ведущего, итог выпуска. */
const fingerprint = (stateDir: string) =>
  readState(stateDir, (view, seq) => {
    const log = leadLog(view);
    const entries = log?.entries ?? [];
    return [seq, entries.length, entries.at(-1)?.at ?? '', log?.release?.doneAt ?? ''].join('|');
  }) ?? 'no-state';

/** Вопросы без ответа, на которые политика не разрешает отвечать ведущему. */
const ownerQuestions = (view: ExecutionView, policy: ExecutionPolicy, workId?: string) => {
  const inputPolicy = inputPolicyOf(policy);
  return view
    .locals('input-requests')
    .map((r) => r.value)
    .filter(
      (r) =>
        r.lifecycle === 'pending' &&
        (!workId || r.workId === workId) &&
        leadAnswerBasis(r, inputPolicy) === null,
    );
};

/** Пауза оператора: снять её решает человек. */
const operatorPause = (view: ExecutionView) => {
  const control = view.control();
  return control.paused && (control.pauseReason ?? 'operator') === 'operator'
    ? 'очередь на паузе оператора: снять паузу решает человек (harness resume)'
    : undefined;
};

/** Шаг explain, который совершает только человек (бюджет, доступ к провайдеру). */
const ownerStep = (next: WaitData['next'] | undefined) =>
  next && OWNER_ACTIONS.has(next.action)
    ? `решение владельца (${next.action}): ${next.message}`
    : undefined;

const questionLine = (r: InputRequest) =>
  `вопрос исполнителя ${r.id} (работа ${r.workId}) ждёт ответа владельца: ${r.question.question.slice(0, 300)}`;

/** Сводка события для новой сессии ведущего: что случилось и какие команды есть. */
export function eventSummary(
  w: WaitData,
  input: Pick<DriveInput, 'stateDir' | 'policyPath' | 'harnessBin'> & {
    session: number;
    maxSessions: number;
    /** Новые вопросы владельцу, о которых ведущий ещё не знает. */
    owner?: InputRequest[];
    /** Сессия только ради них (`owner-question`). */
    ownerOnly?: boolean;
  },
): string {
  const owner = input.owner ?? [];
  const S = resolve(input.stateDir);
  const P = resolve(input.policyPath);
  const work = w.workId ? ` --work ${w.workId}` : '';
  const what: Record<string, string> = {
    failed: `работа ${w.workId ?? '?'} упала, и harness сам её не повторит`,
    held: `работа ${w.workId ?? '?'} удержана и ждёт ведущего`,
    question:
      w.event?.type === 'input.answered'
        ? `владелец ответил на вопрос исполнителя${w.workId ? ` (работа ${w.workId})` : ''}: примените ответ`
        : `исполнитель задал вопрос${w.workId ? ` (работа ${w.workId})` : ''}, на который можете ответить вы`,
    'release-ready': 'весь код выпуска принят: нужны ревью выпуска и итоговый отчёт',
    stopped: '`harness run` не идёт (нет controller и попыток), а выпуск не закончен',
    'owner-question': 'исполнитель задал вопрос, на который отвечает только владелец',
  };
  const commands: Record<string, string[]> = {
    failed: [
      `$H explain --state ${S} --policy ${P}${work} --human`,
      `$H diagnose --state ${S}${work} --cause … --evidence …   # разбор повторных отказов`,
      `$H retry --state ${S}${work} --by lead --reason "…"`,
    ],
    held: [
      `$H explain --state ${S} --policy ${P}${work} --human`,
      `$H retry --state ${S}${work} --by lead --reason "…"`,
    ],
    question: [
      `$H input-list --state ${S}${work}`,
      `$H input-show --state ${S} --request <IR-…>`,
      w.event?.type === 'input.answered'
        ? `$H input-resolve --state ${S} --request <IR-…>   # применить ответ ($H guide recovery)`
        : `$H input-answer --state ${S} --request <IR-…> --request-version <N> --text "…" --actor lead --reason "…"`,
    ],
    'release-ready': [
      `$H review-release --state ${S} --policy ${P}`,
      `$H release done --state ${S} --summary "…"`,
    ],
    stopped: [
      `$H explain --state ${S} --policy ${P} --human`,
      `nohup $H run --graph <граф> --policy ${P} --state ${S} --author <claude|codex> > <журнал> 2>&1 &`,
    ],
    'owner-question': [
      `$H input-show --state ${S} --request <IR-…>`,
      `$H explain --state ${S} --policy ${P} --human   # готовые работы — запустите run, вопрос держит только свои`,
    ],
  };
  const kind = input.ownerOnly ? 'owner-question' : w.kind;
  const ownerLines = owner.length
    ? [
        '',
        'Новые вопросы владельцу (драйвер уведомил оператора):',
        ...owner.map((r) => `  - ${questionLine(r)}`),
        'Это вопрос владельцу: не отвечайте сами, передайте его владельцу (Relay) и завершите ход.',
        'Независимые работы пусть идут; ответ владельца драйвер передаст вам отдельной сессией.',
      ]
    : [];
  return [
    `Сообщение драйвера ведущего (harness lead drive), сессия ${input.session} из ${input.maxSessions}.`,
    input.ownerOnly
      ? `Событие: owner-question — ${what['owner-question']}. Курсор ${w.cursor}.`
      : `Событие: ${w.kind}${w.workId ? ` ${w.workId}` : ''}${w.event ? ` (${w.event.type} #${w.event.seq})` : ''} — ${what[w.kind] ?? w.kind}. Курсор ${w.cursor}.`,
    `Состояние: ${w.status || '—'}`,
    ...ownerLines,
    !input.ownerOnly && w.next
      ? `Следующий шаг по explain: ${w.next.actor ?? '—'} ${w.next.action}: ${w.next.message}`
      : '',
    '',
    `H=${input.harnessBin}`,
    'Команды для этого события:',
    ...(commands[kind] ?? []).map((c) => '  ' + c),
    `Правила: $H guide session (lead begin, журнал), $H guide recovery (остановки), $H guide run, $H guide release.`,
    '',
    'HARNESS_LEAD_DRIVE=1: ждёт драйвер. Разберите это событие, при необходимости запустите `harness run` в фоне,',
    'затем закончите ход коротким итогом. Не вызывайте `harness wait` в цикле — драйвер разбудит вас при следующем',
    'значимом событии. Решение, которое может принять только владелец, назовите в итоге простыми словами.',
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');
}

interface AgentRun {
  exitCode: number | null;
  error?: string;
  timedOut?: boolean;
  stderrTail: string;
  ms: number;
}

/** Запустить команду ведущего: prompt — на stdin, журналы — в файлы сессии. */
function runAgent(
  argv: string[],
  prompt: string,
  options: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    out?: string;
    err?: string;
    signal?: AbortSignal;
    timeoutMs: number;
    killGraceMs: number;
  },
): Promise<AgentRun> {
  const started = Date.now();
  return new Promise((done) => {
    let tail = '';
    let settled = false;
    let timedOut = false;
    const timers: { soft?: NodeJS.Timeout; hard?: NodeJS.Timeout } = {};
    const finish = (r: Omit<AgentRun, 'ms' | 'stderrTail'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timers.soft);
      clearTimeout(timers.hard);
      options.signal?.removeEventListener('abort', kill);
      done({
        ...r,
        ...(timedOut ? { timedOut } : {}),
        stderrTail: tail.slice(-2000),
        ms: Date.now() - started,
      });
    };
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Снять сессию: SIGTERM, затем SIGKILL. Только сам процесс ведущего, не
    // группу: `harness run`, запущенный им в фоне, живёт дальше.
    const kill = () => {
      child.kill('SIGTERM');
      timers.hard ??= setTimeout(() => child.kill('SIGKILL'), options.killGraceMs);
    };
    options.signal?.addEventListener('abort', kill, { once: true });
    timers.soft = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const out = options.out ? createWriteStream(options.out) : undefined;
    const err = options.err ? createWriteStream(options.err) : undefined;
    child.stdout.on('data', (d: Buffer) => {
      if (out?.writable) out.write(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err?.writable) err.write(d);
      tail = (tail + d.toString('utf8')).slice(-4000);
    });
    // Команда, которая не читает stdin, закрывает его: EPIPE — не сбой сессии.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.on('error', (error) => {
      out?.end();
      err?.end();
      finish({ exitCode: null, error: error.message });
    });
    // Конец сессии — выход процесса: `harness run`, запущенный ею в фоне без
    // перенаправления, держит её stdout открытым, и `close` пришёл бы только с
    // концом run. Остаток вывода дочитывается секунду.
    const closed = (code: number | null) => {
      out?.end();
      err?.end();
      finish({ exitCode: code });
    };
    child.on('close', closed);
    child.on('exit', (code) => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        closed(code);
      }, 1000);
    });
  });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        done();
      },
      { once: true },
    );
  });

/** Что ждёт в состоянии сейчас: дело ведущего, вопросы владельца, готовые к запуску работы. */
interface Pending {
  /** Первое, что ждёт ведущего (как ждущее у `wait` без курсора). */
  lead?: WaitData;
  owner: InputRequest[];
  /** Шаг только человека (бюджет, доступ, пауза оператора). */
  ownerStop?: string;
  /** Run не идёт, а готовые работы есть (`explain.queue`). */
  runnable: boolean;
}

async function scanPending(input: DriveInput, cursor: number): Promise<Pending> {
  const stops = await diagnoseState({
    stateDir: input.stateDir,
    policy: input.policy,
    baseDir: input.baseDir,
  }).catch(() => undefined);
  return (
    readState(input.stateDir, (view) => {
      const owner = ownerQuestions(view, input.policy);
      const ownerWorks = new Set(owner.map((r) => r.workId));
      let lead: WaitData | undefined;
      let ownerStop = operatorPause(view);
      for (const d of stops?.diagnoses ?? []) {
        const kind = pendingKind(d, view);
        if (!kind) continue;
        const next = { actor: d.actor, action: d.action, message: d.message.slice(0, 500) };
        if (ownerStep(next)) {
          ownerStop ??= ownerStep(next);
          continue;
        }
        // Вопрос владельца — не дело ведущего; прочие остановки — его.
        if (kind === 'question' && d.workId && ownerWorks.has(d.workId)) continue;
        lead ??= {
          kind,
          ...(d.workId ? { workId: d.workId } : {}),
          next,
          status: waitStatusLine(view),
          cursor,
          waitedMs: 0,
        };
      }
      return {
        ...(lead ? { lead } : {}),
        owner,
        ...(ownerStop ? { ownerStop } : {}),
        runnable: !!stops?.queue,
      };
    }) ?? { owner: [], runnable: false }
  );
}

export async function driveLead(input: DriveInput): Promise<DriveData> {
  const maxSessions = input.maxSessions ?? 20;
  const idleLimit = input.idleSessions ?? 3;
  const graceMs = input.graceMs ?? 30_000;
  const log = input.onLog ?? (() => {});
  const sessions: DriveSession[] = [];
  const notices: DriveNotice[] = [];
  /** Вопросы, о которых владелец уже уведомлён: их ответ будит ведущего. */
  const noticed = new Set<string>();
  /** Новые вопросы владельца, которые ведущий ещё не получил (будят его один раз). */
  let relay: InputRequest[] = [];
  let waits = 0;
  let cursor: number | undefined;
  let idle = 0;
  let lastAgentEnd: number | undefined;
  let last: DriveData['last'];
  let lastRun: AgentRun | undefined;
  // Prompt сессии — в каталоге журналов или во временном каталоге драйвера.
  const promptDir = input.logDir
    ? (mkdirSync(resolve(input.logDir), { recursive: true }), resolve(input.logDir))
    : mkdtempSync(join(tmpdir(), 'harness-drive-'));
  const status = () => readState(input.stateDir, (view) => waitStatusLine(view)) ?? '';
  const result = (outcome: DriveOutcome, message: string): DriveData => {
    log(`${outcome}: ${message}`);
    return {
      outcome,
      message: message.slice(0, 2000),
      sessions: sessions.slice(-200),
      notices: notices.slice(-50),
      waits,
      cursor: cursor ?? 0,
      status: status().slice(0, 500),
      ...(last ? { last } : {}),
    };
  };
  const notice = (n: Omit<DriveNotice, 'at'>) => {
    notices.push({ at: new Date().toISOString(), ...n, message: n.message.slice(0, 500) });
    log(`владельцу: ${n.message}`);
  };
  /** Уведомить о новых вопросах владельца; true — уведомлено что-то новое. */
  const noticeOwner = (questions: InputRequest[]) => {
    let fresh = false;
    for (const r of questions)
      if (!noticed.has(r.id)) {
        noticed.add(r.id);
        relay.push(r);
        fresh = true;
        notice({
          kind: 'owner-question',
          requestId: r.id,
          workId: r.workId,
          message: questionLine(r),
        });
      }
    return fresh;
  };
  const ownerExit = (why: string) =>
    result(
      'owner',
      `нужно решение владельца — ${why}. Ответьте (панель или harness input-answer) и запустите драйвер снова`,
    );
  try {
    for (;;) {
      if (input.signal?.aborted) return result('aborted', 'драйвер остановлен сигналом');
      if (readState(input.stateDir, releaseDone))
        return result('release-done', 'выпуск закончен: release done записан, весь код принят');
      let w: WaitData;
      if (!existsSync(join(resolve(input.stateDir), 'state.sqlite'))) {
        // Каталога состояния ещё нет: ведущий должен настроить и запустить run.
        w = {
          kind: 'stopped',
          status: 'каталог состояния ещё не создан: ' + input.stateDir,
          cursor: cursor ?? 0,
          waitedMs: 0,
        };
      } else if (cursor === undefined) {
        // Первое ожидание: всё, что уже ждёт, — разом (вопрос владельца не
        // должен заслонить отказ, которого ждёт ведущий); дальше — по курсору.
        cursor = readState(input.stateDir, (_view, seq) => seq) ?? 0;
        const pending = await scanPending(input, cursor);
        noticeOwner(pending.owner);
        if (pending.ownerStop) return ownerExit(pending.ownerStop);
        if (!pending.lead && !relay.length) continue;
        w = pending.lead ?? {
          kind: 'question',
          ...(relay[0]?.workId ? { workId: relay[0].workId } : {}),
          status: status(),
          cursor,
          waitedMs: 0,
        };
      } else {
        waits++;
        w = await waitFor({
          stateDir: input.stateDir,
          policy: input.policy,
          baseDir: input.baseDir,
          after: cursor,
          timeoutMs: input.waitTimeoutMs ?? 60 * 60_000,
          ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.onTick ? { onTick: input.onTick } : {}),
          // Ответ на вопрос владельца — значимое событие для ведущего.
          wakeOn: (e) =>
            e.type === 'input.answered' &&
            noticed.has(e.payload.requestId) &&
            e.payload.actor !== 'lead',
        });
        cursor = w.cursor;
      }
      if (w.kind === 'aborted') return result('aborted', 'драйвер остановлен сигналом');
      if (!WAKING.has(w.kind)) {
        if (w.kind === 'accepted') log(`принята ${w.workId ?? ''}; ${w.status}`);
        continue;
      }
      const answered = w.event?.type === 'input.answered';
      if (answered)
        notice({
          kind: 'owner-answered',
          requestId: answeredId(input.stateDir, w.event!.seq) ?? '?',
          ...(w.workId ? { workId: w.workId } : {}),
          message: `владелец ответил${w.workId ? ` (работа ${w.workId})` : ''}: будим ведущего применить ответ`,
        });
      // Вопрос владельца: уведомление; ведущего будит только новый — один раз.
      if (w.kind === 'question' && !answered) {
        const owner = readState(input.stateDir, (view) =>
          ownerQuestions(view, input.policy, w.workId),
        );
        if (owner?.length && !noticeOwner(owner) && !relay.length) continue;
      }
      // Только что закончившаяся сессия могла запустить run в фоне: метка
      // запуска появится не сразу — `stopped` перепроверяется после паузы.
      if (w.kind === 'stopped' && lastAgentEnd !== undefined) {
        const left = lastAgentEnd + graceMs - Date.now();
        if (left > 0) {
          await sleep(left, input.signal);
          lastAgentEnd = undefined;
          continue;
        }
      }
      if (w.kind === 'release-ready' && readState(input.stateDir, releaseDone))
        return result('release-done', 'выпуск закончен: release done записан, весь код принят');
      const step = ownerStep(w.next);
      if (step) return ownerExit(step);
      if (w.kind === 'stopped' && existsSync(join(resolve(input.stateDir), 'state.sqlite'))) {
        // Run не идёт: если идти дальше нечему, кроме ответа владельца, — выход.
        const pending = await scanPending(input, w.cursor);
        noticeOwner(pending.owner);
        if (pending.ownerStop) return ownerExit(pending.ownerStop);
        // Новый вопрос владельца сначала получает ведущий (передать владельцу).
        if (pending.owner.length && !pending.runnable && !pending.lead && !relay.length)
          return ownerExit(
            `run не идёт, а дальше всё ждёт ответа владельца: ${pending.owner.map(questionLine).join('; ')}`,
          );
        if (pending.lead && !pending.runnable) w = { ...pending.lead, cursor: w.cursor };
        else if (!pending.runnable && relay.length)
          w = {
            kind: 'question',
            ...(relay[0]?.workId ? { workId: relay[0].workId } : {}),
            status: w.status,
            cursor: w.cursor,
            waitedMs: 0,
          };
      }
      // Сессия только ради новых вопросов владельцу: ни своего события, ни запуска.
      const ownerOnly =
        relay.length > 0 &&
        w.kind === 'question' &&
        w.event?.type !== 'input.answered' &&
        !!readState(input.stateDir, (view) =>
          ownerQuestions(view, input.policy, w.workId).some((r) =>
            relay.some((x) => x.id === r.id),
          ),
        );
      const owner = relay;
      relay = [];
      const sessionKind: DriveSession['kind'] = ownerOnly ? 'owner-question' : w.kind;
      last = {
        kind: w.kind,
        ...(w.workId ? { workId: w.workId } : {}),
        ...(w.next ? { next: w.next } : {}),
      };
      if (sessions.length >= maxSessions)
        return result(
          'max-sessions',
          `предел сессий ведущего (${maxSessions}) исчерпан; последнее событие: ${w.kind}${w.workId ? ` ${w.workId}` : ''}`,
        );
      const session = sessions.length + 1;
      const prompt =
        input.goals.trimEnd() +
        '\n\n---\n\n' +
        eventSummary(w, { ...input, session, maxSessions, owner, ownerOnly }) +
        '\n';
      const promptFile = join(promptDir, `session-${session}.prompt.md`);
      writeFileSync(promptFile, prompt);
      const argv = input.agent.map((a) =>
        a
          .replaceAll('{session}', String(session))
          .replaceAll('{cursor}', String(w.cursor))
          .replaceAll('{prompt-file}', promptFile),
      );
      log(`сессия ${session}: ${sessionKind}${w.workId ? ` ${w.workId}` : ''}, курсор ${w.cursor}`);
      const before = fingerprint(input.stateDir);
      const sessionTimeoutMs = input.sessionTimeoutMs ?? 60 * 60_000;
      lastRun = await runAgent(argv, prompt, {
        cwd: input.cwd ?? process.cwd(),
        env: {
          ...(input.env ?? process.env),
          HARNESS_LEAD_DRIVE: '1',
          HARNESS_LEAD_DRIVE_CURSOR: String(w.cursor),
          HARNESS_LEAD_DRIVE_SESSION: String(session),
          HARNESS_LEAD_DRIVE_EVENT: sessionKind,
        },
        ...(input.logDir
          ? {
              out: join(promptDir, `session-${session}.out`),
              err: join(promptDir, `session-${session}.err`),
            }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: sessionTimeoutMs,
        killGraceMs: input.killGraceMs ?? 10_000,
      });
      lastAgentEnd = Date.now();
      const progressed = fingerprint(input.stateDir) !== before;
      sessions.push({
        session,
        kind: sessionKind,
        ...(w.workId ? { workId: w.workId } : {}),
        cursor: w.cursor,
        exitCode: lastRun.exitCode,
        progressed,
        ...(lastRun.timedOut ? { timedOut: true as const } : {}),
        ms: lastRun.ms,
      });
      const timeoutLine = lastRun.timedOut
        ? `сессия ${session} превысила --session-timeout (${Math.round(sessionTimeoutMs / 1000)} с) и снята (SIGTERM, затем SIGKILL)`
        : '';
      log(
        timeoutLine ||
          `сессия ${session} закончилась: код ${lastRun.exitCode ?? 'сигнал'}, ${progressed ? 'состояние изменилось' : 'состояние не изменилось'}`,
      );
      if (input.signal?.aborted) return result('aborted', 'драйвер остановлен сигналом');
      if (lastRun.error)
        return result(
          'agent-error',
          `команда ведущего не запустилась: ${lastRun.error} (${input.agent[0]})`,
        );
      // Снятая по сроку сессия — неудачная, даже если что-то успела записать.
      idle = progressed && !lastRun.timedOut ? 0 : idle + 1;
      if (idle >= idleLimit)
        return result(
          'no-progress',
          `${idle} сессии ведущего подряд не изменили состояние или не уложились в срок (последнее событие: ${w.kind}${w.workId ? ` ${w.workId}` : ''}; код выхода ${lastRun.exitCode ?? 'сигнал'})` +
            (timeoutLine ? `; ${timeoutLine}` : '') +
            (lastRun.stderrTail.trim()
              ? `; stderr: ${lastRun.stderrTail.trim().slice(-600)}`
              : '') +
            '. Проверьте команду --agent и журналы сессий (--log)',
        );
    }
  } finally {
    if (!input.logDir) rmSync(promptDir, { recursive: true, force: true });
  }
}

/** ID запроса из события ответа `seq`. */
function answeredId(stateDir: string, seq: number): string | undefined {
  const file = join(resolve(stateDir), 'state.sqlite');
  if (!existsSync(file)) return undefined;
  const store = new SqliteExecutionStore(file, 'harness-drive', { readOnly: true });
  try {
    const e = store.events(seq - 1, 1)[0];
    return e?.type === 'input.answered' ? e.payload.requestId : undefined;
  } finally {
    store.close();
  }
}
