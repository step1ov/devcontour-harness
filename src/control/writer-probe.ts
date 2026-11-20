// Пробный запуск исполнителя без модели (`harness smoke --writer-probe`).
//
// Правила шаблона требуют от исполнителя шагов, которые его песочница может
// закрыть: генератор из реестра (сеть), локальный сервер для проверок в
// браузере (listen), браузерный инструмент (запуск процесса), служебный
// каталог в домашнем каталоге (запись). Без пробы каждый такой конфликт
// находила платная попытка, и исполнитель останавливался до кода. Здесь
// команды `writerProbe` политики исполняются в той же изоляции, что вызов
// исполнителя: то же окружение (профиль инструментов назначения, переменные
// контура, свой TMPDIR в области записи), те же области записи и чтения, та
// же сеть, тем же механизмом — песочница codex (`codex sandbox` с профилем
// прав harness) или sandbox-runtime для claude (тот же класс механизма, что
// песочница Claude Code). Модель не вызывается, попытка не создаётся.

import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  mcpEnvironment,
  profileNetwork,
  roleBinding,
  type ExecutionPolicy,
  type RuntimeName,
} from '../contracts/index.ts';
import { writerRunsChecks } from '../agents/cli-adapter.ts';
import {
  codexLoopbackSupport,
  codexPermissions,
  isolatedCommand,
  isolation,
  withWriterNetwork,
} from '../environment/isolation.ts';
import { executionEnvironment } from '../environment/lifecycle.ts';
import { command } from '../environment/process.ts';
import { writerScratch } from '../engine/writer-block.ts';

type Repo = ExecutionPolicy['repositories'][number];

/** Почему команда исполнителю закрыта (или не прошла сама). */
export type WriterProbeReason =
  | 'listen-denied'
  | 'network-denied'
  | 'network-open'
  | 'write-denied'
  | 'process-abort'
  | 'missing-tool'
  | 'timeout'
  | 'no-shell'
  | 'environment'
  | 'failed';

export interface WriterProbeCommand {
  id: string;
  command: string[];
  /** `ok` — прошла; `blocked` — закрыта изоляцией исполнителя; `failed` — упала сама. */
  status: 'ok' | 'blocked' | 'failed';
  exitCode?: number;
  timedOut?: boolean;
  durationMs: number;
  reason?: WriterProbeReason;
  /** Строка вывода, по которой узнана причина (замаскирована, до 300 знаков). */
  evidence?: string;
  /** Что сделать простыми словами: варианты решения. */
  advice?: string;
  log?: string;
}

export interface WriterProbeWriter {
  runtime: RuntimeName;
  toolProfile?: string;
  /** Роли, у которых этот исполнитель. */
  roles: string[];
  /** Механизм изоляции пробы: тот же, что у вызова исполнителя. */
  mechanism: 'codex-sandbox' | 'sandbox-runtime' | 'none';
  /** Внешняя сеть исполнителя: codex — `network`/`codexNetwork` профиля; claude — домены политики. */
  network: boolean;
  /**
   * Режим сети исполнителя: `none` — закрыта и локальные порты; `loopback` —
   * только 127.0.0.1 и ::1; `full` — вся сеть (поле `network` или
   * `codexNetwork: true`). `legacy` — профиль без поля `network`: у codex
   * закрыта сеть shell, у claude — домены `isolation.domains` и локальные
   * порты; сетевые инструменты runtime (веб-поиск codex, WebFetch/WebSearch
   * claude) этим режимом явно не закрыты.
   */
  networkMode: 'none' | 'loopback' | 'full' | 'legacy';
  commands: WriterProbeCommand[];
}

export interface WriterProbeResult {
  /** Все команды всех исполнителей прошли. */
  ok: boolean;
  writers: WriterProbeWriter[];
  /** Пояснение: команд нет, исполнители без shell и т. п. */
  notes?: string[];
}

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const ADVICE: Record<WriterProbeReason, string> = {
  'listen-denied':
    'Исполнителю закрыт локальный сервер (listen). Варианты: вынести проверку с сервером в gate harness (gates слушают localhost); дать исполнителю только локальную сеть: network: loopback в профиле инструментов (listen и connect на 127.0.0.1 и ::1, без интернета); отключить это правило шаблона для режима harness (раздел controller-mode).',
  'network-denied':
    'Исполнителю закрыта сеть (реестр пакетов или внешний адрес). Варианты: выполнить шаг заранее в prepare (кеш вне рабочего дерева, harness lean); открыть домен в isolation.domains (claude) или всю сеть в профиле инструментов (network: full у codex); вынести шаг в prepare или gate.',
  'network-open':
    'Песочница codex в режиме network: loopback пропустила соединение с внешним адресом: эта версия codex не держит границу loopback. Не запускайте исполнителя с ней: выберите network: none или обновите codex и повторите пробу.',
  'write-denied':
    'Команда пишет вне области записи исполнителя (путь — в строке вывода). Варианты: направить её каталог в рабочее дерево или во временный каталог переменной окружения профиля; выполнить шаг заранее в prepare.',
  'process-abort':
    'Процесс аварийно завершился в песочнице: так ведёт себя браузер без окна на macOS под Seatbelt. Исполнитель этот шаг не выполнит: вынести его в gate harness или службу lifecycle вне песочницы исполнителя, либо отключить правило шаблона для режима harness.',
  'missing-tool':
    'Команда не найдена в PATH исполнителя: установите инструмент, укажите абсолютный путь или поставьте его шагом prepare.',
  timeout:
    'Команда не уложилась в timeoutMs: часто она ждёт сети, ввода или службы. Проверьте её отдельно; ожидание сети — та же причина, что network-denied.',
  'no-shell':
    'У исполнителя нет shell (профиль инструментов): команды он не запустит вовсе. Дайте профилю shell (codexShell / claudeTools: Bash) или вынесите шаг в prepare или gate.',
  environment:
    'Окружение исполнителя не собирается (переменная или секрет профиля не задан): задайте их до запуска.',
  failed:
    'Команда завершилась ошибкой без признаков песочницы: причина — в ней самой (лог). Проверьте команду вне harness.',
};

const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** Префикс задачи turbo и подобных (`@scope/pkg:build: `) перед строкой вывода. */
const taskPrefix = /^[\w@./-]+:[\w:.-]+:\s+/;
/**
 * Шум, который не бывает причиной: предупреждения менеджеров и Node и
 * безвредное чтение `~/.npmrc` pnpm под песочницей («Issue while reading …
 * EPERM» — pnpm идёт дальше без него).
 */
const noise =
  // Предупреждение Node — только в его обычной форме `(node:N) XWarning: …`;
  // строка `XWarning: …` без неё — выброшенное предупреждение
  // (`--throw-deprecation`) и бывает причиной.
  /^(?:\[WARN\]|WARN\b|npm warn\b|warning\b|\(node:\d+\) (?:\[\w+\] )?(?:\w*Warning)\b)|Issue while reading "[^"]*\.npmrc"/i;
/** Предупреждение, выброшенное как ошибка (`--throw-deprecation`): `XWarning: …` после кадра `throw warning`. */
const thrownWarning = /^\w+Warning:/;
const thrownContext = /node:internal\/process\/warning|^\s*throw warning;/;
/** Строки вывода без цвета, префикса задачи и шума — в исходном порядке. */
function significant(text: string) {
  const lines = text
    .replace(ansi, '')
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim());
  // `XWarning: …` без кадра выброса — обычный вывод (console.warn): шум для
  // всех классов, а не только для итоговой ошибки.
  const thrown = lines.some((l) => thrownContext.test(l.replace(taskPrefix, '')));
  return lines.filter((l) => {
    const bare = l.replace(taskPrefix, '');
    return l && !noise.test(bare) && (thrown || !thrownWarning.test(bare));
  });
}
/** Последняя значимая строка с признаком: причина печатается после предупреждений. */
const lastOf = (lines: string[], re: RegExp) => lines.findLast((l) => re.test(l));
/** Строка похожа на итоговую ошибку команды. */
const fatal =
  /\b(?:error|ERR!|ERR_[A-Z_]+|failed|fatal|panicked|Cannot find|not found)\b|Error:|Не удалось/i;
/** Итог менеджера или оркестратора задач: повторяет код выхода, не причину. */
const wrapper =
  /^(?:ELIFECYCLE\b|ERROR\s+run failed\b|npm (?:error|ERR!) (?:code|path|command|Lifecycle|A complete log|errno)\b|Command failed with exit code\b|Failed:\s|\S+#\S+: command .*exited|ERROR: command finished with error\b)/;
/** Путь файловой системы в строке: без него EPERM может быть и не записью. */
const hasPath = /(?:^|[\s'"(=])(?:~?\/|[A-Za-z]:\\)[^\s'")]*\w/;

/**
 * Причина по исходу команды. Экспортируется для тестов. Причина — последняя
 * значимая строка: предупреждения (`[WARN]`, `npm warn`, Node `Warning`) и
 * безвредное чтение `~/.npmrc` pnpm не считаются, иначе их EPERM выдавал
 * отказ записи раньше настоящей ошибки сборки. Порядок классов — от самого
 * конкретного признака к общему: аварийное завершение и браузер, который не
 * запустился, раньше отказа записи (браузер печатает «Permission denied»
 * своего служебного вызова), listen раньше прочих EPERM. EPERM без пути
 * (`Operation not permitted (os error 1)` сборщика на Rust) — отказ записи
 * или локального сокета: совет называет оба.
 */
export function classifyProbe(result: {
  code: number;
  timedOut: boolean;
  output: string;
  signal?: string | null;
  /** Режим сети исполнителя: при закрытой сети совет EPERM без пути называет loopback. */
  networkMode?: WriterProbeWriter['networkMode'];
}): {
  status: WriterProbeCommand['status'];
  reason?: WriterProbeReason;
  evidence?: string;
  /** Совет вместо общего `ADVICE[reason]`, когда причина неоднозначна. */
  advice?: string;
} {
  if (result.timedOut) return { status: 'blocked', reason: 'timeout' };
  if (result.code === 0) return { status: 'ok' };
  const lines = significant(result.output);
  const evidence = (re: RegExp) => ((l) => (l ? { evidence: l } : {}))(lastOf(lines, re));
  const abort =
    /Abort trap|SIGABRT|bootstrap_check_in|TransformProcessType|Trace\/BPT trap|sandbox initialization failed/;
  // Браузерный инструмент, чей процесс браузера умер при старте: тот же класс,
  // что аварийный выход под песочницей, а не отказ записи.
  const browser =
    /Daemon process exited during startup|Failed to launch (?:the )?browser process|Browser process exited|Chrome failed to start/i;
  if (result.code === 134 || result.signal === 'SIGABRT' || lines.some((l) => abort.test(l)))
    return { status: 'blocked', reason: 'process-abort', ...evidence(abort) };
  if (lines.some((l) => browser.test(l)))
    return { status: 'blocked', reason: 'process-abort', ...evidence(browser) };
  const listen = /listen E(?:PERM|ACCES)|bind\b.*(?:EPERM|EACCES|Operation not permitted)/i;
  if (lines.some((l) => listen.test(l)))
    return { status: 'blocked', reason: 'listen-denied', evidence: lastOf(lines, listen)! };
  const network =
    /\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED)\b|getaddrinfo|Could not resolve host|Temporary failure in name resolution|network is unreachable|ERR_PNPM_META_FETCH_FAIL|fetch failed/i;
  if (lines.some((l) => network.test(l)))
    return { status: 'blocked', reason: 'network-denied', evidence: lastOf(lines, network)! };
  const write =
    /\b(?:EROFS|EPERM|EACCES)\b|read-only file system|Operation not permitted|Permission denied/i;
  const denied = lastOf(lines, write);
  if (denied) {
    const pathless = !hasPath.test(denied);
    return {
      status: 'blocked',
      reason: 'write-denied',
      evidence: denied,
      ...(pathless
        ? {
            advice:
              'Отказ EPERM без пути: это запись вне области записи исполнителя или локальный сокет (сборщики на Rust, например Turbopack, открывают его на 127.0.0.1).' +
              (result.networkMode === 'none' || result.networkMode === 'legacy'
                ? ' Сеть исполнителя закрыта и для локальных портов: повторите пробу с network: loopback в профиле инструментов;'
                : '') +
              ' если отказ остаётся — направьте каталоги команды в рабочее дерево или во временный каталог профиля, либо выполните шаг заранее в prepare.',
          }
        : {}),
    };
  }
  if (result.code === 127 || lines.some((l) => /command not found|spawn \S+ ENOENT/i.test(l)))
    return { status: 'failed', reason: 'missing-tool', ...evidence(/not found|ENOENT/i) };
  // Без признаков песочницы: последняя строка ошибки — подсказка, где искать;
  // итог обёртки (pnpm, npm, turbo) — только когда другой строки нет.
  const own = lines.filter((l) => !wrapper.test(l.replace(taskPrefix, '')));
  // Невыброшенные `XWarning:` уже отсеяны (`significant`); оставшиеся — причина.
  const isCause = (l: string) => fatal.test(l) || thrownWarning.test(l.replace(taskPrefix, ''));
  const pick = (list: string[]) => list.findLast(isCause);
  const cause = pick(own) ?? pick(lines);
  return { status: 'failed', reason: 'failed', ...(cause ? { evidence: cause } : {}) };
}

/** ID проверки границы loopback codex в отчёте пробы. */
export const LOOPBACK_CHECK = 'harness-loopback-check';

/**
 * Скрипт проверки границы: локальный сервер на 127.0.0.1, прямое соединение
 * с внешним IP и CONNECT через прокси из окружения. Печатает по строке на
 * исход; сам всегда выходит с кодом 0, решает `loopbackVerdict`.
 */
const LOOPBACK_SCRIPT = `const net=require('net');const r={};
const fin=()=>{for(const k of ['loopback','direct','proxy'])console.log('harness-loopback-check:'+k+':'+r[k]);process.exit(0)};
const tcp=(host,port,cb)=>{const c=net.connect({host,port});const t=setTimeout(()=>{c.destroy();cb('closed:timeout')},5000);
c.on('connect',()=>{clearTimeout(t);cb('open',c)});c.on('error',e=>{clearTimeout(t);cb('closed:'+(e.code||e.message))})};
const proxy=()=>{const u=process.env.HTTPS_PROXY||process.env.https_proxy||process.env.HTTP_PROXY||process.env.http_proxy;
if(!u){r.proxy='none';return fin()}let p;try{p=new URL(u)}catch{r.proxy='none';return fin()}
tcp(p.hostname,Number(p.port||80),(s,c)=>{if(!c){r.proxy=s;return fin()}let b='';
c.on('data',d=>{b+=d;if(b.includes('\\r\\n')){r.proxy=/^HTTP\\/1\\.[01] 2\\d\\d/.test(b)?'open':'closed:'+b.split('\\r\\n')[0].slice(0,80);c.destroy();fin()}});
c.write('CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n')})};
const s=net.createServer(c=>c.end('ok')).on('error',e=>{r.loopback='fail:'+e.code;direct()});
const direct=()=>tcp('1.1.1.1',443,(st,c)=>{if(c)c.destroy();r.direct=st;proxy()});
s.listen(0,'127.0.0.1',()=>tcp('127.0.0.1',s.address().port,(st,c)=>{r.loopback=st==='open'?'ok':'fail:'+st;if(c)c.destroy();s.close();direct()}));`;

/** Исход проверки границы loopback по её выводу. Экспортируется для тестов. */
export function loopbackVerdict(
  code: number,
  output: string,
): Pick<WriterProbeCommand, 'status' | 'reason' | 'evidence'> {
  const value = (k: string) =>
    new RegExp(`^${LOOPBACK_CHECK}:${k}:(.*)$`, 'm').exec(output)?.[1]?.trim();
  const [loopback, direct, proxy] = [value('loopback'), value('direct'), value('proxy')];
  if (code !== 0 || !loopback || !direct || !proxy)
    return {
      status: 'failed',
      reason: 'failed',
      evidence: clip(output.trim().split('\n').slice(-3).join(' | ') || `exit=${code}`),
    };
  if (direct === 'open' || proxy === 'open')
    return {
      status: 'blocked',
      reason: 'network-open',
      evidence: `внешний адрес доступен: напрямую ${direct}, через прокси ${proxy}`,
    };
  if (loopback !== 'ok')
    return { status: 'blocked', reason: 'listen-denied', evidence: `loopback ${loopback}` };
  return { status: 'ok' };
}

async function loopbackCheck(
  sandbox: string[],
  cwd: string,
  execution: { env: NodeJS.ProcessEnv; redact: (s: string) => string },
  callDir: string,
  signal: AbortSignal,
): Promise<WriterProbeCommand> {
  const check = [process.execPath, '-e', LOOPBACK_SCRIPT];
  const started = Date.now();
  const base = { id: LOOPBACK_CHECK, command: [process.execPath, '-e', '<loopback-check>'] };
  let result;
  try {
    result = await command([...sandbox, '--', ...check], cwd, {
      env: execution.env,
      timeoutMs: 60_000,
      signal,
      redact: execution.redact,
      activity: { kind: 'command', label: 'writer-probe loopback-check' },
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      ...base,
      status: 'failed',
      durationMs: Date.now() - started,
      reason: 'missing-tool',
      evidence: clip(`${sandbox[0]}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`),
      advice:
        'Не запускается codex sandbox: установите codex (тот же, что у исполнителя) или задайте HARNESS_CODEX_BIN.',
    };
  }
  const output = result.stdout + '\n' + result.stderr;
  const log = join(callDir, LOOPBACK_CHECK + '.log');
  await writeFile(log, output);
  const verdict = loopbackVerdict(result.timedOut ? -1 : result.code, output);
  return {
    ...base,
    status: verdict.status,
    exitCode: result.code,
    ...(result.timedOut ? { timedOut: true } : {}),
    durationMs: Date.now() - started,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(verdict.evidence ? { evidence: clip(execution.redact(verdict.evidence)) } : {}),
    ...(verdict.reason ? { advice: ADVICE[verdict.reason] } : {}),
    log,
  };
}

/** Различные исполнители ролей репозитория (runtime и профиль инструментов). */
function writersOf(policy: ExecutionPolicy, repo: Repo) {
  const roles = [...new Set([...Object.keys(policy.roles), ...Object.keys(repo.roles ?? {})])];
  const out = new Map<string, { runtime: RuntimeName; toolProfile?: string; roles: string[] }>();
  for (const role of roles) {
    const writer = roleBinding(policy, role, repo.id)?.writer;
    if (!writer) continue;
    const key = `${writer.runtime}\u0000${writer.toolProfile ?? ''}`;
    const entry = out.get(key) ?? {
      runtime: writer.runtime,
      ...(writer.toolProfile ? { toolProfile: writer.toolProfile } : {}),
      roles: [],
    };
    entry.roles.push(role);
    out.set(key, entry);
  }
  return [...out.values()];
}

export interface WriterProbeInput {
  policy: ExecutionPolicy;
  repo: Repo;
  /** Подготовленное рабочее дерево (после prepare). */
  cwd: string;
  /** Граница проверки — та же, что у вызова исполнителя. */
  boundary: { hidden: string[]; readable: string[]; checkouts: string[] };
  /** Каталог логов пробы. */
  dir: string;
  runId: string;
  signal: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  /** Исполняемые файлы runtime (`HARNESS_<RUNTIME>_BIN`); по умолчанию — имя из PATH. */
  executables?: Partial<Record<'codex' | 'claude', string>>;
  platform?: NodeJS.Platform;
}

/** Команды `writerProbe` репозитория в изоляции каждого его исполнителя. */
export async function probeWriter(input: WriterProbeInput): Promise<WriterProbeResult> {
  const { policy, repo, cwd } = input;
  const steps = repo.writerProbe ?? [];
  const notes: string[] = [];
  if (!steps.length)
    notes.push(
      `У репозитория ${repo.id} нет writerProbe: перечислите команды, которые правила проекта (AGENTS.md, навыки) требуют от исполнителя, — harness-setup предлагает их.`,
    );
  if (policy.isolation.mode !== 'os')
    notes.push('isolation.mode не os: исполнитель работает без песочницы, проба тоже.');
  const writers: WriterProbeWriter[] = [];
  let n = 0;
  for (const w of writersOf(policy, repo)) {
    if (w.runtime !== 'codex' && w.runtime !== 'claude') continue;
    const runtime = w.runtime;
    const profile = w.toolProfile ? policy.toolProfiles[w.toolProfile] : undefined;
    const mechanism =
      policy.isolation.mode !== 'os'
        ? 'none'
        : runtime === 'codex'
          ? 'codex-sandbox'
          : 'sandbox-runtime';
    const network = profileNetwork(runtime, profile);
    // Без поля `network` граница прежняя и инструменты runtime не закрыты:
    // проба не называет её режимом `none` или `loopback`.
    const networkMode: WriterProbeWriter['networkMode'] = profile?.network
      ? profile.network
      : network === 'full'
        ? 'full'
        : 'legacy';
    const report: WriterProbeWriter = {
      runtime,
      ...(w.toolProfile ? { toolProfile: w.toolProfile } : {}),
      roles: w.roles,
      mechanism,
      network:
        networkMode === 'full' ||
        (networkMode === 'legacy' && runtime === 'claude' && policy.isolation.domains.length > 0),
      networkMode,
      commands: [],
    };
    writers.push(report);
    const blockAll = (reason: WriterProbeReason, evidence?: string) => {
      for (const step of steps)
        report.commands.push({
          id: step.id,
          command: step.command,
          status: 'blocked',
          durationMs: 0,
          reason,
          ...(evidence ? { evidence: clip(evidence) } : {}),
          advice: ADVICE[reason],
        });
    };
    if (!writerRunsChecks(runtime, profile)) {
      blockAll('no-shell');
      continue;
    }
    // Сеть loopback у codex — только с функцией network_proxy: без неё
    // исполнитель не запустится, и проба говорит это заранее.
    if (mechanism === 'codex-sandbox' && network === 'loopback') {
      const refused = await codexLoopbackSupport(
        input.executables?.codex ?? 'codex',
        input.environment ?? process.env,
      );
      if (refused) {
        blockAll('environment', refused);
        continue;
      }
    }
    let execution;
    try {
      execution = executionEnvironment(
        [
          policy.environment,
          repo.environment,
          profile?.environment,
          ...(profile ? [mcpEnvironment(profile)] : []),
        ],
        {
          DEVCONTOUR_REPOSITORY_ID: repo.id,
          DEVCONTOUR_RUN_ID: input.runId,
          DEVCONTOUR_PHASE: 'candidate',
          // Ресурсов и зависимостей у пробы нет: переменные есть, как у попытки.
          DEVCONTOUR_RESOURCES_JSON: '[]',
          DEVCONTOUR_DEPENDENCIES_JSON: '[]',
          DEVCONTOUR_COMPONENTS_JSON: JSON.stringify({ [repo.id]: cwd }),
        },
        input.environment ?? process.env,
      );
    } catch (error) {
      blockAll('environment', error instanceof Error ? error.message : String(error));
      continue;
    }
    // HOME — как у адаптера runtime.
    execution.env.HOME ??= homedir();
    const callDir = join(input.dir, `writer-${++n}`);
    await mkdir(callDir, { recursive: true });
    // Свой TMPDIR в области записи — как у вызова исполнителя.
    const temp = await writerScratch(execution.env);
    const scratch = temp.dir;
    try {
      const iso = withWriterNetwork(
        isolation({
          write: [cwd, scratch],
          controller: [...input.boundary.hidden, temp.parent],
          readable: [cwd, scratch, ...input.boundary.readable],
          domains: policy.isolation.domains,
          ...(input.boundary.checkouts.length ? { checkouts: input.boundary.checkouts } : {}),
        }),
        runtime === 'claude' ? network : undefined,
      );
      // Граница loopback codex проверяется на деле: функция network_proxy
      // есть, но прокси будущей версии мог бы пропускать всё. Локальный
      // сервер должен работать, внешний адрес — нет (напрямую и через прокси).
      if (mechanism === 'codex-sandbox' && network === 'loopback')
        report.commands.push(
          await loopbackCheck(
            [input.executables?.codex ?? 'codex', 'sandbox', ...codexPermissions(iso, network)],
            cwd,
            execution,
            callDir,
            input.signal,
          ),
        );
      for (const step of steps) {
        let argv: string[];
        let env: NodeJS.ProcessEnv = execution.env;
        let runCwd = cwd;
        if (mechanism === 'codex-sandbox')
          // Профиль прав — тот же, что у `codex exec` исполнителя.
          argv = [
            input.executables?.codex ?? 'codex',
            'sandbox',
            ...codexPermissions(iso, network ?? 'none'),
            '--',
            ...step.command,
          ];
        else if (mechanism === 'sandbox-runtime') {
          // Метка старта обёртки — в своём каталоге, открытом на запись
          // только ей (как у gates); песочница исполнителя — та же граница.
          const marks = join(callDir, step.id + '.marks');
          await mkdir(marks, { recursive: true });
          const wrapped = await isolatedCommand(
            { ...iso, write: [...iso.write, await realpath(marks)] },
            step.command,
            join(callDir, step.id + '.settings'),
            scratch,
            join(marks, 'started'),
            await realpath(cwd),
            [await realpath(cwd)],
            input.platform ?? process.platform,
            '',
            randomBytes(6).toString('hex'),
            // Процесс песочницы получает тот же TMPDIR, что процесс
            // исполнителя (claude кладёт туда сокеты своей песочницы).
            scratch,
          );
          argv = wrapped.argv;
          env = { ...execution.env, ...wrapped.env };
          runCwd = wrapped.cwd;
        } else argv = step.command;
        const started = Date.now();
        let result;
        try {
          result = await command(argv, runCwd, {
            env,
            timeoutMs: step.timeoutMs,
            signal: input.signal,
            redact: execution.redact,
            contain: { dirs: [cwd, scratch] },
            activity: { kind: 'command', label: `writer-probe ${step.id}`.slice(0, 300) },
          });
        } catch (error) {
          // Отмена вызывающим — не исход команды.
          if (input.signal.aborted) throw error;
          const code = (error as NodeJS.ErrnoException).code;
          report.commands.push({
            id: step.id,
            command: step.command,
            status: 'failed',
            durationMs: Date.now() - started,
            reason: 'missing-tool',
            evidence: clip(`${argv[0]}: ${code ?? String(error)}`),
            advice:
              mechanism === 'codex-sandbox' && argv[0] !== step.command[0]
                ? 'Не запускается codex sandbox: установите codex (тот же, что у исполнителя) или задайте HARNESS_CODEX_BIN.'
                : ADVICE['missing-tool'],
          });
          continue;
        }
        const output = result.stdout + '\n' + result.stderr;
        const log = join(callDir, step.id + '.log');
        await writeFile(log, output);
        const verdict = classifyProbe({
          code: result.code,
          timedOut: result.timedOut,
          output,
          signal: result.diagnostics.signal,
          networkMode: report.networkMode,
        });
        report.commands.push({
          id: step.id,
          command: step.command,
          status: verdict.status,
          exitCode: result.code,
          ...(result.timedOut ? { timedOut: true } : {}),
          durationMs: Date.now() - started,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
          ...(verdict.evidence ? { evidence: clip(execution.redact(verdict.evidence)) } : {}),
          ...(verdict.reason ? { advice: verdict.advice ?? ADVICE[verdict.reason] } : {}),
          log,
        });
      }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (!writers.length) notes.push('Ни у одной роли репозитория нет исполнителя codex или claude.');
  // Пустая проба ничего не доказала: без команд она не «зелёная».
  const probed = writers.some((w) => w.commands.some((c) => c.id !== LOOPBACK_CHECK));
  return {
    ok: probed && writers.every((w) => w.commands.every((c) => c.status === 'ok')),
    writers,
    ...(notes.length ? { notes } : {}),
  };
}

const NETWORK_TEXT: Record<Exclude<WriterProbeWriter['networkMode'], 'legacy'>, string> = {
  none: 'закрыта (и локальные порты)',
  loopback: 'только локальная (127.0.0.1, ::1)',
  full: 'есть',
};
const networkText = (w: WriterProbeWriter) =>
  w.networkMode !== 'legacy'
    ? NETWORK_TEXT[w.networkMode]
    : (w.runtime === 'codex'
        ? 'shell закрыта (профиль без поля network)'
        : 'домены isolation.domains и локальная (профиль без поля network)') +
      ', сетевые инструменты runtime не закрыты';

/** Строки пробы для человека (`harness smoke --writer-probe --human`). */
export function writerProbeText(probe: WriterProbeResult) {
  const lines = [`проба исполнителя: ${probe.ok ? 'всё доступно' : 'есть закрытые шаги'}`];
  for (const w of probe.writers) {
    lines.push(
      `  исполнитель ${w.runtime}${w.toolProfile ? ` (${w.toolProfile})` : ''}, роли ${w.roles.join(', ')}; изоляция ${w.mechanism}; сеть ${networkText(w)}`,
    );
    for (const c of w.commands)
      lines.push(
        `    ${c.id}: ${c.status}${c.reason && c.status !== 'ok' ? ` — ${c.reason}` : ''}${c.evidence ? ` (${c.evidence})` : ''}`,
        ...(c.advice && c.status !== 'ok' ? [`      что сделать: ${c.advice}`] : []),
      );
  }
  for (const note of probe.notes ?? []) lines.push(`  заметка: ${note}`);
  return lines.join('\n') + '\n';
}
