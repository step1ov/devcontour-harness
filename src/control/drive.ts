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
// Решение владельца (вопрос, на который ведущему отвечать нельзя, бюджет,
// доступ к провайдеру, пауза оператора) — выход с отдельным кодом; сессии
// без изменений состояния подряд — остановка с диагнозом, без бесконечного
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
} from '../contracts/index.ts';
import type { NotPromise } from '../contracts/ports.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';
import { releaseReady, waitFor, waitStatusLine, type WaitData } from './wait.ts';

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
  /** Чем разбужен ведущий. */
  kind: WaitData['kind'];
  workId?: string;
  cursor: number;
  /** Код выхода команды ведущего (`null` — снят сигналом). */
  exitCode: number | null;
  /** Состояние изменилось за сессию (события, журнал ведущего, итог выпуска). */
  progressed: boolean;
  ms: number;
}

export interface DriveData {
  outcome: DriveOutcome;
  /** Итог простыми словами: что случилось и что дальше. */
  message: string;
  sessions: DriveSession[];
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

/** Что ждёт владельца в этом исходе `wait`; undefined — дело ведущего. */
function ownerReason(w: WaitData, stateDir: string, policy: ExecutionPolicy): string | undefined {
  if (w.next && OWNER_ACTIONS.has(w.next.action))
    return `решение владельца (${w.next.action}): ${w.next.message}`;
  return readState(stateDir, (view) => {
    if (w.kind === 'stopped') {
      const control = view.control();
      return control.paused && (control.pauseReason ?? 'operator') === 'operator'
        ? 'очередь на паузе оператора: снять паузу решает человек (harness resume)'
        : undefined;
    }
    if (w.kind !== 'question') return undefined;
    // Вопрос без ответа, на который политика не разрешает отвечать ведущему.
    const inputPolicy = inputPolicyOf(policy);
    const owner = view
      .locals('input-requests')
      .map((r) => r.value)
      .find(
        (r) =>
          r.lifecycle === 'pending' &&
          (!w.workId || r.workId === w.workId) &&
          leadAnswerBasis(r, inputPolicy) === null,
      );
    return owner
      ? `вопрос исполнителя ${owner.id} (работа ${owner.workId}) ждёт ответа владельца: ${owner.question.question.slice(0, 300)}`
      : undefined;
  });
}

/** Сводка события для новой сессии ведущего: что случилось и какие команды есть. */
export function eventSummary(
  w: WaitData,
  input: Pick<DriveInput, 'stateDir' | 'policyPath' | 'harnessBin'> & {
    session: number;
    maxSessions: number;
  },
): string {
  const S = resolve(input.stateDir);
  const P = resolve(input.policyPath);
  const work = w.workId ? ` --work ${w.workId}` : '';
  const what: Record<string, string> = {
    failed: `работа ${w.workId ?? '?'} упала, и harness сам её не повторит`,
    held: `работа ${w.workId ?? '?'} удержана и ждёт ведущего`,
    question: `исполнитель задал вопрос${w.workId ? ` (работа ${w.workId})` : ''}, на который можете ответить вы`,
    'release-ready': 'весь код выпуска принят: нужны ревью выпуска и итоговый отчёт',
    stopped: '`harness run` не идёт (нет controller и попыток), а выпуск не закончен',
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
      `$H input-answer --state ${S} --request <IR-…> --request-version <N> --text "…" --actor lead --reason "…"`,
    ],
    'release-ready': [
      `$H review-release --state ${S} --policy ${P}`,
      `$H release done --state ${S} --summary "…"`,
    ],
    stopped: [
      `$H explain --state ${S} --policy ${P} --human`,
      `nohup $H run --graph <граф> --policy ${P} --state ${S} --author <claude|codex> > <журнал> 2>&1 &`,
    ],
  };
  return [
    `Сообщение драйвера ведущего (harness lead drive), сессия ${input.session} из ${input.maxSessions}.`,
    `Событие: ${w.kind}${w.workId ? ` ${w.workId}` : ''}${w.event ? ` (${w.event.type} #${w.event.seq})` : ''} — ${what[w.kind] ?? w.kind}. Курсор ${w.cursor}.`,
    `Состояние: ${w.status || '—'}`,
    w.next
      ? `Следующий шаг по explain: ${w.next.actor ?? '—'} ${w.next.action}: ${w.next.message}`
      : '',
    '',
    `H=${input.harnessBin}`,
    'Команды для этого события:',
    ...(commands[w.kind] ?? []).map((c) => '  ' + c),
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
  },
): Promise<AgentRun> {
  const started = Date.now();
  return new Promise((done) => {
    let tail = '';
    let settled = false;
    const finish = (r: Omit<AgentRun, 'ms' | 'stderrTail'>) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', kill);
      done({ ...r, stderrTail: tail.slice(-2000), ms: Date.now() - started });
    };
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const kill = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', kill, { once: true });
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

export async function driveLead(input: DriveInput): Promise<DriveData> {
  const maxSessions = input.maxSessions ?? 20;
  const idleLimit = input.idleSessions ?? 3;
  const graceMs = input.graceMs ?? 30_000;
  const log = input.onLog ?? (() => {});
  const sessions: DriveSession[] = [];
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
      waits,
      cursor: cursor ?? 0,
      status: status().slice(0, 500),
      ...(last ? { last } : {}),
    };
  };
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
      } else {
        waits++;
        w = await waitFor({
          stateDir: input.stateDir,
          policy: input.policy,
          baseDir: input.baseDir,
          ...(cursor !== undefined ? { after: cursor } : {}),
          timeoutMs: input.waitTimeoutMs ?? 60 * 60_000,
          ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.onTick ? { onTick: input.onTick } : {}),
        });
        cursor = w.cursor;
      }
      if (w.kind === 'aborted') return result('aborted', 'драйвер остановлен сигналом');
      if (!WAKING.has(w.kind)) {
        if (w.kind === 'accepted') log(`принята ${w.workId ?? ''}; ${w.status}`);
        continue;
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
      last = {
        kind: w.kind,
        ...(w.workId ? { workId: w.workId } : {}),
        ...(w.next ? { next: w.next } : {}),
      };
      if (w.kind === 'release-ready' && readState(input.stateDir, releaseDone))
        return result('release-done', 'выпуск закончен: release done записан, весь код принят');
      const owner = ownerReason(w, input.stateDir, input.policy);
      if (owner)
        return result(
          'owner',
          `нужно решение владельца — ${owner}. Ответьте (панель или harness input-answer) и запустите драйвер снова`,
        );
      if (sessions.length >= maxSessions)
        return result(
          'max-sessions',
          `предел сессий ведущего (${maxSessions}) исчерпан; последнее событие: ${w.kind}${w.workId ? ` ${w.workId}` : ''}`,
        );
      const session = sessions.length + 1;
      const prompt =
        input.goals.trimEnd() +
        '\n\n---\n\n' +
        eventSummary(w, { ...input, session, maxSessions }) +
        '\n';
      const promptFile = join(promptDir, `session-${session}.prompt.md`);
      writeFileSync(promptFile, prompt);
      const argv = input.agent.map((a) =>
        a
          .replaceAll('{session}', String(session))
          .replaceAll('{cursor}', String(w.cursor))
          .replaceAll('{prompt-file}', promptFile),
      );
      log(`сессия ${session}: ${w.kind}${w.workId ? ` ${w.workId}` : ''}, курсор ${w.cursor}`);
      const before = fingerprint(input.stateDir);
      lastRun = await runAgent(argv, prompt, {
        cwd: input.cwd ?? process.cwd(),
        env: {
          ...(input.env ?? process.env),
          HARNESS_LEAD_DRIVE: '1',
          HARNESS_LEAD_DRIVE_CURSOR: String(w.cursor),
          HARNESS_LEAD_DRIVE_SESSION: String(session),
          HARNESS_LEAD_DRIVE_EVENT: w.kind,
        },
        ...(input.logDir
          ? {
              out: join(promptDir, `session-${session}.out`),
              err: join(promptDir, `session-${session}.err`),
            }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      lastAgentEnd = Date.now();
      const progressed = fingerprint(input.stateDir) !== before;
      sessions.push({
        session,
        kind: w.kind,
        ...(w.workId ? { workId: w.workId } : {}),
        cursor: w.cursor,
        exitCode: lastRun.exitCode,
        progressed,
        ms: lastRun.ms,
      });
      log(
        `сессия ${session} закончилась: код ${lastRun.exitCode ?? 'сигнал'}, ${progressed ? 'состояние изменилось' : 'состояние не изменилось'}`,
      );
      if (input.signal?.aborted) return result('aborted', 'драйвер остановлен сигналом');
      if (lastRun.error)
        return result(
          'agent-error',
          `команда ведущего не запустилась: ${lastRun.error} (${input.agent[0]})`,
        );
      idle = progressed ? 0 : idle + 1;
      if (idle >= idleLimit)
        return result(
          'no-progress',
          `${idle} сессии ведущего подряд не изменили состояние (последнее событие: ${w.kind}${w.workId ? ` ${w.workId}` : ''}; код выхода ${lastRun.exitCode ?? 'сигнал'})` +
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
