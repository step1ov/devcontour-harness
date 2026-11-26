import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { controllerTemp } from '../environment/controller-temp.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import type {
  ContextLimit,
  ProbeServer,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeRequest,
  RuntimeResponse,
  toolProfileSchema,
} from '../contracts/index.ts';
import { profileNetwork } from '../contracts/index.ts';
import { OversizedFile, readBounded } from '../environment/bounded-read.ts';
import { command } from '../environment/process.ts';
import {
  claudeFileDenies,
  claudeFileTools,
  claudeSandbox,
  codexLoopbackSupport,
  codexPermissions,
  isolation,
  withWriterNetwork,
  type Isolation,
} from '../environment/isolation.ts';
import { redactor } from '../environment/redaction.ts';
import {
  WriteGuardUnavailable,
  guardedArgv,
  writerRuntimeHome,
} from '../environment/write-guard.ts';
import { inspectReview } from './inspect.ts';
import { probeCallMs, probeServer, probeTool } from './review-probe.ts';
import { acceptedStructuredOutput, claudeResult, runtimeEvents } from './runtime-events.ts';
import { runtimeVersion, unknownUsage, usageStream } from './usage.ts';

/**
 * Предел окна контекста по итоговому событию claude. `prompt_too_long` на
 * первом ходе (`num_turns` ≤ 1, записанный случай: подсказка сама больше
 * окна) — `prompt-too-long`, повтор только удлинит подсказку. Тот же признак
 * после ходов работы (окно заполнил вывод инструментов) и без `num_turns` —
 * `blocking-limit`, как остановка CLI у предела окна: повтор может читать
 * меньше.
 */
export function claudeContextLimit(
  terminalReason: string | undefined,
  numTurns: number | undefined,
): ContextLimit | undefined {
  if (terminalReason === 'blocking_limit') return 'blocking-limit';
  if (terminalReason !== 'prompt_too_long') return undefined;
  return numTurns !== undefined && numTurns <= 1 ? 'prompt-too-long' : 'blocking-limit';
}

/**
 * Признаки нехватки окна контекста codex (alpha.73): codex не сообщает
 * признака полем, только текстом ошибки. Читаются только события ошибки
 * (`error`, `turn.failed`) и хвост stderr неуспешного вызова — не ответы
 * модели, где те же слова могут быть о задаче. Codex сам сжимает контекст
 * (auto-compact): такая ошибка — только когда сжатие не помогло; другого
 * механизма для codex нет.
 */
export const CODEX_CONTEXT_PATTERNS: readonly RegExp[] = [
  /context[_ ]length[_ ]exceeded/i,
  /ran out of room in the model'?s context window/i,
  /exceeds? (?:the )?(?:model'?s )?context window/i,
  /maximum context length/i,
];
export function codexContextExhausted(stdout: string, stderr: string): boolean {
  const messages = runtimeEvents(stdout)
    .events.filter((e) => e.type === 'error' || e.type === 'turn.failed')
    .map((e) => JSON.stringify(e));
  const tail = stderr.split('\n').slice(-20).join('\n');
  return [...messages, tail].some((t) => CODEX_CONTEXT_PATTERNS.some((p) => p.test(t)));
}

type ToolProfile = z.infer<typeof toolProfileSchema>;

/**
 * Предел файла ответа codex: вдвое выше хвоста stdout, в котором приходит ответ
 * claude (2 000 000 символов). Ответ модели на порядки меньше, а разбор
 * файла на пределе занимает меньше 100 МБ кучи.
 */
export const CODEX_RESULT_LIMIT = 4 * 1024 * 1024;

/** Встроенные инструменты исполнителя claude, когда профиль их не называет; shell — в песочнице ОС. */
/** Встроенные инструменты claude, которые ходят в сеть мимо песочницы Bash. */
export const claudeNetworkTools = ['WebFetch', 'WebSearch'] as const;
export const claudeWriterTools = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] as const;
const writerTools = (profile?: ToolProfile): readonly string[] =>
  profile?.claudeTools ?? claudeWriterTools;
/** Может ли reviewer запускать проверки: у claude — только Bash, явно данный профилем. */
export function reviewerRunsChecks(runtime: 'codex' | 'claude', profile?: ToolProfile) {
  if (runtime === 'codex') return profile ? profile.codexShell : true;
  return !!profile?.claudeTools?.includes('Bash');
}
export function writerRunsChecks(runtime: 'codex' | 'claude', profile?: ToolProfile) {
  if (runtime === 'codex') return profile ? profile.codexShell : true;
  return writerTools(profile).includes('Bash');
}

const toml = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(toml).join(', ') + ']';
  if (value && typeof value === 'object')
    return (
      '{ ' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`)
        .join(', ') +
      ' }'
    );
  return JSON.stringify(value);
};
/**
 * MCP-серверы прогона codex: серверы профиля инструментов назначения и сервер
 * проверок reviewer, если он дан. Глобальная конфигурация оператора и её
 * серверы в прогон не попадают.
 */
export function codexServers(probe?: ProbeServer, profile?: ToolProfile) {
  const servers = {
    ...Object.fromEntries(
      Object.entries(profile?.mcp ?? {}).map(([id, s]) => [
        id,
        {
          enabled: true,
          required: true,
          enabled_tools: s.tools,
          ...(s.transport === 'stdio'
            ? { command: s.command, args: s.args, env_vars: s.env }
            : { url: s.url, bearer_token_env_var: s.bearerTokenEnv }),
        },
      ]),
    ),
    ...(probe
      ? {
          [probeServer]: {
            enabled: true,
            required: true,
            enabled_tools: [probeTool],
            command: probe.command,
            args: probe.args,
            env_vars: probe.env,
            // По умолчанию codex обрывает вызов инструмента через минуту —
            // раньше, чем controller остановил бы команду сам.
            tool_timeout_sec: Math.ceil(probeCallMs(probe) / 1000),
          },
        }
      : {}),
  };
  return Object.keys(servers).length ? `mcp_servers=${toml(servers)}` : 'mcp_servers={}';
}
/** MCP-конфигурация claude: серверы профиля и сервер проверок reviewer. */
export function claudeMcp(probe?: ProbeServer, profile?: ToolProfile) {
  return {
    mcpServers: {
      ...Object.fromEntries(
        Object.entries(profile?.mcp ?? {}).map(([id, s]) => [
          id,
          s.transport === 'stdio'
            ? {
                type: 'stdio',
                command: s.command,
                args: s.args,
                env: Object.fromEntries(s.env.map((key) => [key, '${' + key + '}'])),
              }
            : {
                type: 'http',
                url: s.url,
                ...(s.bearerTokenEnv
                  ? { headers: { Authorization: 'Bearer ${' + s.bearerTokenEnv + '}' } }
                  : {}),
              },
        ]),
      ),
      ...(probe
        ? {
            [probeServer]: {
              type: 'stdio',
              command: probe.command,
              args: probe.args,
              env: Object.fromEntries(probe.env.map((key) => [key, '${' + key + '}'])),
            },
          }
        : {}),
    },
  };
}
/** Разрешения claude на инструменты MCP-серверов профиля. */
const mcpRules = (profile?: ToolProfile) =>
  Object.entries(profile?.mcp ?? {}).flatMap(([id, s]) =>
    s.tools.map((tool) => `mcp__${id}__${tool}`),
  );

function codexTools(profile: ToolProfile | undefined, review: boolean, probe?: ProbeServer) {
  if (!profile)
    // Ревьюеру codex без профиля нужен shell для чтения; запись закрывает профиль прав.
    return [
      '--ignore-user-config',
      '-c',
      codexServers(probe),
      ...(review ? ['-c', 'features.shell_tool=true'] : []),
    ];
  return [
    '--ignore-user-config',
    '-c',
    codexServers(probe, profile),
    '-c',
    `features.shell_tool=${profile.codexShell}`,
    '-c',
    `sandbox_workspace_write.network_access=${profileNetwork('codex', profile) === 'full'}`,
  ];
}

export interface CliAdapterOptions {
  /** Исполняемый файл runtime; по умолчанию — имя runtime из PATH. Тесты подставляют fixture executable. */
  executable?: string;
  toolProfiles?: Record<string, ToolProfile>;
  /**
   * Имена элементов каталога состояния хоста (конфигурация, журналы, решения),
   * которые закрываются для runtime и тогда, когда появляются после старта
   * вызова. Каталог над открытым worktree закрывается поэлементно, и элемент,
   * которого нет в снимке и в этом перечне, остался бы открытым.
   */
  controllerEntries?: string[];
  /** Пробовать продолжение сессии writer (`capabilities().sessionContinue`): тонкий режим. */
  sessionContinue?: boolean;
}

/**
 * Умеет ли CLI продолжить сессию со структурированным ответом (тонкий режим,
 * alpha.73): codex — `exec resume` с --json, --output-schema и -o; claude —
 * `--resume`. Проба — справка CLI, один раз на процесс.
 */
const resumeProbes = new Map<string, Promise<boolean>>();
export function sessionContinueSupport(
  runtime: 'codex' | 'claude',
  executable: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  const key = JSON.stringify([runtime, executable, env?.PATH ?? process.env.PATH]);
  if (!resumeProbes.has(key))
    resumeProbes.set(
      key,
      command(
        runtime === 'codex' ? [executable, 'exec', 'resume', '--help'] : [executable, '--help'],
        tmpdir(),
        { timeoutMs: 15_000, ...(env ? { env } : {}) },
      )
        .then((h) => {
          if (h.code) return false;
          const flags = runtime === 'codex' ? ['--json', '--output-schema', '-o'] : ['--resume'];
          const words = new Set(h.stdout.split(/[\s,=<>[\]]+/));
          return flags.every((f) => words.has(f));
        })
        .catch(() => false),
    );
  return resumeProbes.get(key)!;
}

/**
 * Сообщения CLI о том, что продолжаемой сессии нет (alpha.73). Только по ним
 * продолжение считается потерянным: прочий отказ до начала (вход истёк,
 * лимит, нет CLI) — прежний путь недоступного runtime.
 */
export const SESSION_NOT_FOUND: Record<'codex' | 'claude', RegExp> = {
  codex: /no saved session|session not found|no rollout found|thread not found/i,
  claude: /no conversation found/i,
};

/**
 * Codex `exec resume` (0.165) не знает `--sandbox`: режим песочницы — той
 * же настройкой через `-c sandbox_mode=…`; остальные флаги прежние.
 */
export function codexResumeArgv(argv: readonly string[], id: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sandbox') {
      out.push('-c', `sandbox_mode="${argv[++i]}"`);
      continue;
    }
    out.push(argv[i]!);
    if (i === 1 && argv[i] === 'exec') out.push('resume', id);
  }
  return out;
}

/**
 * Адаптер CLI codex или claude. Каждый вызов — новая сессия, кроме writer
 * тонкого режима: `continue` продолжает его сессию (`codex exec resume`,
 * `claude --resume`); reviewer и planner сессии writer не получают. Граница
 * доступа — нативная песочница runtime с политикой harness: запись только
 * в разрешённые каталоги, состояние controller и учётные данные закрыты.
 * Ответ возвращается сырым (`output`); разбирает и проверяет его движок.
 */
export function cliAdapter(
  runtime: 'codex' | 'claude',
  options: CliAdapterOptions = {},
): RuntimeAdapter {
  const executable = options.executable ?? runtime;
  return {
    runtime,
    async capabilities(): Promise<RuntimeCapabilities> {
      const version = await runtimeVersion(executable);
      // Проба справки — только когда хост её просит (тонкий режим).
      const sessionContinue =
        version && options.sessionContinue
          ? await sessionContinueSupport(runtime, executable)
          : false;
      return {
        runtime,
        ...(version ? { version } : {}),
        structuredOutput: true,
        sandbox: ['os'],
        cancellation: true,
        usage: true,
        fixture: false,
        // Запрос и wire-схема несут протокол переходов находок (docs/review-protocol.md).
        reviewProtocol: 1,
        ...(sessionContinue ? { sessionContinue } : {}),
      };
    },
    async invoke(r: RuntimeRequest, signal: AbortSignal): Promise<RuntimeResponse> {
      // Продолжить можно только сессию writer (тонкий режим, alpha.73).
      if (r.session.kind === 'fork' || (r.session.kind === 'continue' && r.task !== 'implement'))
        throw new Error(`${runtime}: продолжение сессии не поддерживается`);
      const resume = r.session.kind === 'continue' ? r.session.id : undefined;
      const freshId = (r.session.kind === 'fresh' ? r.session.id : undefined) ?? randomUUID();
      const review = r.task !== 'implement';
      const dir = r.artifactDir ?? (await mkdtemp(join(controllerTemp.dir(), 'harness-call-')));
      await mkdir(dir, { recursive: true });
      const schemaPath = join(dir, 'schema.json'),
        logPath = join(dir, 'runtime.log');
      // Облегчённый режим (alpha.69): только исполнитель — без песочницы
      // runtime, сеть открыта; граница записи — обёртка процесса ниже.
      const light = review ? undefined : r.sandbox.light;
      // Каталог вызова — файлы controller (журнал, схема, итог), исполнителю
      // не открыт. Файл ответа codex исполнитель пишет в свой отдельный
      // каталог под каталогом controller; controller читает его без ссылок
      // и с пределом и переносит итог в каталог вызова.
      const outDir =
        light && runtime === 'codex'
          ? await mkdtemp(join(controllerTemp.dir(), 'hx-out-'))
          : undefined;
      const resultPath = join(outDir ?? dir, 'result.json');
      const savedResult = join(dir, 'result.json');
      await writeFile(schemaPath, JSON.stringify(r.outputSchema ?? {}));
      const profile = r.binding.toolProfile
        ? options.toolProfiles?.[r.binding.toolProfile]
        : undefined;
      if (r.binding.toolProfile && !profile)
        throw new Error('Неизвестный профиль инструментов: ' + r.binding.toolProfile);
      // Сервер проверок — только reviewer кода; writer его не получает.
      const probe = review ? r.probe : undefined;
      const mcpPath = join(dir, 'mcp.json');
      const mcp = !!probe || Object.keys(profile?.mcp ?? {}).length > 0;
      if (runtime === 'claude' && mcp)
        await writeFile(mcpPath, JSON.stringify(claudeMcp(probe, profile), null, 2));
      // Сеть профиля — только исполнителю; ревьюер её не получает.
      const network = review ? undefined : profileNetwork(runtime, profile);
      // Явный режим без интернета закрывает и инструменты runtime, которые
      // ходят в сеть мимо песочницы shell: веб-поиск codex, WebFetch и
      // WebSearch claude. Без поля `network` вызов прежний.
      const offline =
        !light && !review && (profile?.network === 'none' || profile?.network === 'loopback');
      if (runtime === 'codex' && network === 'loopback' && !light) {
        const refused = await codexLoopbackSupport(executable, r.env);
        if (refused) throw new Error(`codex: ${refused}`);
      }
      const bounds: Isolation = isolation({
        write: r.sandbox.writable,
        controller: r.sandbox.denied,
        readable: [...(r.sandbox.readable ?? []), ...(review ? [r.cwd] : [])],
        domains: r.sandbox.network.domains,
        ...(options.controllerEntries ? { entries: options.controllerEntries } : {}),
        ...(r.sandbox.checkouts?.length ? { checkouts: r.sandbox.checkouts } : {}),
      });
      const policy: Isolation = runtime === 'claude' ? withWriterNetwork(bounds, network) : bounds;
      const built =
        runtime === 'codex'
          ? [
              executable,
              'exec',
              '--json',
              '-c',
              'approval_policy="never"',
              '--output-schema',
              schemaPath,
              '--output-last-message',
              resultPath,
              ...(r.binding.model ? ['--model', r.binding.model] : []),
              ...(r.binding.effort ? ['-c', `model_reasoning_effort="${r.binding.effort}"`] : []),
              ...codexTools(profile, review, review ? r.probe : undefined),
              ...(light
                ? ['--sandbox', 'danger-full-access']
                : codexPermissions(policy, review ? 'none' : (network ?? 'none'))),
              ...(offline ? ['-c', 'web_search="disabled"'] : []),
              '-',
            ]
          : [
              executable,
              '--print',
              '--output-format',
              'stream-json',
              '--verbose',
              '--json-schema',
              JSON.stringify(r.outputSchema ?? {}),
              '--permission-mode',
              review ? 'dontAsk' : light ? 'bypassPermissions' : 'acceptEdits',
              '--tools',
              (review
                ? [
                    'Read',
                    'Glob',
                    'Grep',
                    ...(reviewerRunsChecks('claude', profile) ? ['Bash'] : []),
                  ]
                : writerTools(profile)
              ).join(','),
              ...(review
                ? [
                    '--disallowedTools',
                    [
                      'Edit',
                      'Write',
                      'NotebookEdit',
                      ...(reviewerRunsChecks('claude', profile) ? [] : ['Bash']),
                    ].join(','),
                  ]
                : offline
                  ? ['--disallowedTools', claudeNetworkTools.join(',')]
                  : []),
              ...(profile?.claudeAllowedTools.length || mcp
                ? [
                    '--allowedTools',
                    [
                      ...(profile?.claudeAllowedTools ?? []),
                      ...mcpRules(profile),
                      ...(probe ? [`mcp__${probeServer}__${probeTool}`] : []),
                    ]
                      .filter(
                        (rule) =>
                          !review ||
                          reviewerRunsChecks('claude', profile) ||
                          !rule.startsWith('Bash'),
                      )
                      .filter(
                        (rule) =>
                          !claudeFileTools.some(
                            (tool) => rule === tool || rule.startsWith(tool + '('),
                          ),
                      )
                      .join(','),
                  ]
                : []),
              '--settings',
              JSON.stringify({
                ...(light
                  ? {}
                  : (
                        review
                          ? reviewerRunsChecks('claude', profile)
                          : writerRunsChecks('claude', profile)
                      )
                    ? claudeSandbox(policy, review, r.cwd)
                    : { permissions: { deny: claudeFileDenies(policy, r.cwd) } }),
                // Сроки CLI для проверок reviewer: вызов инструмента проверок
                // не обрывается раньше controller, а собственный Bash reviewer
                // ограничен тем же пределом команды.
                ...(probe
                  ? {
                      env: {
                        MCP_TOOL_TIMEOUT: String(probeCallMs(probe)),
                        BASH_DEFAULT_TIMEOUT_MS: String(probe.commandTimeoutMs),
                        BASH_MAX_TIMEOUT_MS: String(probe.commandTimeoutMs),
                      },
                    }
                  : {}),
              }),
              ...(mcp ? ['--mcp-config', mcpPath] : []),
              '--setting-sources',
              '',
              '--strict-mcp-config',
              // Сессия writer с постоянным домашним каталогом (тонкий режим)
              // сохраняется: её продолжит следующая сдача.
              ...(light?.home ? [] : ['--no-session-persistence']),
              // ID новой сессии writer задаёт harness (`--session-id`), продолжение — `--resume`.
              ...(resume ? ['--resume', resume] : light?.home ? ['--session-id', freshId] : []),
              ...(r.binding.model ? ['--model', r.binding.model] : []),
            ];
      const argv = runtime === 'codex' && resume ? codexResumeArgv(built, resume) : built;
      const redact = redactor(r.secrets ?? []);
      // Граница записи облегчённого режима: процесс runtime и все его
      // потомки пишут только в свои каталоги, кеши и состояние своего CLI.
      let launch = argv;
      // Свой домашний каталог CLI на вызов (под каталогом controller, не в
      // артефактах): настройки пользователя исполнителю на запись не
      // открыты; в нём — копия файла входа, обратно ничего не переносится
      // (решение владельца 2026-11-24). Постоянный каталог работы
      // (`light.home`, тонкий режим) остаётся после вызова: в нём сессия.
      const runtimeHome = light
        ? (light.home ?? join(controllerTemp.dir(), `hx-home-${randomUUID().slice(0, 12)}`))
        : undefined;
      const transientHome = light && !light.home ? runtimeHome : undefined;
      const userHome = r.env.HOME ?? homedir();
      let homeEnv: Record<string, string> = {};
      // Входа для своего каталога не нашлось: вызов идёт (вход может прийти
      // иначе), а отказ runtime получит подсказку, что сделать.
      let homeHint: string | undefined;
      const cleanup = async () => {
        for (const d of [transientHome, outDir])
          if (d) await rm(d, { recursive: true, force: true }).catch(() => undefined);
      };
      if (light?.guard)
        try {
          // Граница проверяется до создания домашнего каталога: на отказе
          // механизма ничего не создаётся. Открыты: каталог ответа и свой
          // домашний каталог CLI; настоящий файл входа — нет.
          launch = guardedArgv(argv, [
            ...light.guard.map((subpath) => ({ subpath })),
            ...(light.guardDenyRead ?? []).map((denyRead) => ({ denyRead })),
            ...(outDir ? [{ subpath: outDir }] : []),
            ...(runtimeHome ? [{ subpath: runtimeHome }] : []),
          ]);
        } catch (error) {
          await cleanup();
          if (!(error instanceof WriteGuardUnavailable)) throw error;
          return {
            status: 'unavailable',
            text: '',
            model: null,
            runtimeVersion: null,
            usage: unknownUsage(),
            diagnostics: { exitCode: null, reason: error.message.slice(0, 500), log: logPath },
          };
        }
      let version: Awaited<ReturnType<typeof runtimeVersion>>;
      try {
        version = await runtimeVersion(executable, r.env);
        await writeFile(logPath, `Runtime ${runtime}; started ${new Date().toISOString()}\n`);
      } catch (error) {
        // Каталог ответа не переживает отказ до вызова.
        if (outDir) await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      let logged = 0;
      const unavailable = (reason: string): RuntimeResponse => ({
        status: 'unavailable',
        text: '',
        model: null,
        runtimeVersion: version,
        usage: unknownUsage(),
        diagnostics: {
          exitCode: null,
          reason: redact(homeHint ? `${reason}; облегчённый режим: ${homeHint}` : reason).slice(
            0,
            500,
          ),
          log: logPath,
        },
      });
      let result;
      // События runtime для inspection разбираются до маскирования (иначе
      // короткий секрет портит `item.completed`), текст полей маскируется
      // при разборе; сырой поток только в памяти и не сохраняется.
      let raw = '';
      // Телеметрия — по всему потоку, независимо от пределов журнала и
      // хвоста stdout: итоговое событие долгого вызова лежит за ними.
      const telemetry = usageStream(runtime);
      try {
        if (runtimeHome) {
          const prepared = await writerRuntimeHome(runtime, runtimeHome, r.env, userHome);
          if (prepared.refused)
            return {
              status: 'unavailable',
              text: '',
              model: null,
              runtimeVersion: version,
              usage: unknownUsage(),
              diagnostics: {
                exitCode: null,
                reason: redact(`${runtime}: облегчённый режим: ${prepared.refused}`).slice(0, 500),
                log: logPath,
              },
            };
          homeEnv = prepared.env;
          homeHint = prepared.missing;
        }
        result = await command(launch, r.cwd, {
          activity: { kind: 'agent', label: `${runtime} ${r.task}`.slice(0, 300) },
          contain: { dirs: review ? [] : r.sandbox.writable },
          onRawStdout: (text: string) => {
            telemetry.push(text);
            if (review) raw = (raw + text).slice(-2_000_000);
          },
          onOutput: (stream, text) => {
            if (logged >= 10_000_000) return;
            const entry = `[${new Date().toISOString()} ${stream}] ${text}`;
            appendFileSync(logPath, entry);
            logged += Buffer.byteLength(entry);
          },
          signal,
          timeoutMs: r.timeoutMs,
          input:
            r.prompt +
            (r.task === 'review-code'
              ? '\nReport execution.commands with command, exitCode and summary, or an empty list and a concrete execution.noCommandsReason. Never claim a command was run based only on the supplied diff.'
              : ''),
          env: { ...r.env, HOME: r.env.HOME ?? homedir(), ...homeEnv },
          redact,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM')
          return unavailable(`${runtime}: runtime не запускается: ${String(error)}`);
        throw error;
      } finally {
        // Домашний каталог вызова с копией входа убирается на любом исходе;
        // обратно ничего не переносится (решение владельца 2026-11-24).
        if (transientHome)
          await rm(transientHome, { recursive: true, force: true }).catch(() => undefined);
      }
      try {
        const usage = telemetry.usage(result.code === 0 && !result.timedOut && !signal.aborted);
        const model = telemetry.model();
        const terminalReason = telemetry.terminalReason();
        const compactions = telemetry.compactions();
        // Сообщённые runtime счётчики и стоимость — и в диагностике вызова:
        // runtime.log ограничен и итоговой строки может не содержать. Там же
        // исход хода claude и число сжатий контекста (успешное сжатие — не отказ).
        await writeFile(
          join(dir, 'runtime.json'),
          JSON.stringify(
            {
              ...result.diagnostics,
              usage,
              ...(terminalReason ? { terminalReason } : {}),
              ...(compactions ? { compactions } : {}),
            },
            null,
            2,
          ),
        );
        // Нехватка окна контекста — по `terminal_reason` итогового события
        // claude, а не по тексту причины (в нём числа токенов).
        const contextExhausted =
          runtime === 'claude'
            ? claudeContextLimit(terminalReason, telemetry.numTurns())
            : result.code !== 0 && codexContextExhausted(result.stdout, result.stderr)
              ? ('blocking-limit' as const)
              : undefined;
        const bookkeeping = ['system', 'result', 'error', 'session.created', 'thread.started'];
        const started =
          result.timedOut ||
          runtimeEvents(result.stdout).events.some((e) => !bookkeeping.includes(String(e.type)));
        const reason = () => {
          let text: string | undefined;
          if (runtime === 'claude') {
            const last = runtimeEvents(result.stdout).events.findLast(
              (e) => e.type === 'result',
            ) as { result?: unknown } | undefined;
            if (typeof last?.result === 'string') text = last.result;
          }
          text ??= result.stderr
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .at(-1);
          return text ? redact(text).slice(0, 300) : undefined;
        };
        const sessionId =
          telemetry.sessionId() ??
          (runtime === 'claude' && light?.home ? (resume ?? freshId) : undefined);
        const base = {
          text: redact(result.stdout).slice(-20000),
          ...(sessionId ? { sessionId } : {}),
          model,
          runtimeVersion: version,
          usage,
          ...(review ? { inspection: inspectReview(runtime, raw, redact) } : {}),
        };
        const diagnostics = (why?: string) => ({
          exitCode: result.code,
          ...(why ? { reason: why } : {}),
          log: logPath,
          ...(contextExhausted ? { contextExhausted } : {}),
        });
        const expired =
          signal.aborted && (signal.reason as Error | undefined)?.name === 'TimeoutError';
        if (result.timedOut || expired)
          return {
            ...base,
            status: 'timeout',
            diagnostics: diagnostics(`исчерпан лимит времени: ${Math.round(r.timeoutMs / 1000)} с`),
          };
        if (signal.aborted)
          return { ...base, status: 'cancelled', diagnostics: diagnostics('прогон прерван') };
        // Продолжение не началось: сессии нет (удалена, другой каталог) —
        // отказ этого продолжения, а не недоступный runtime: следующая сдача
        // начнёт новую сессию.
        if (
          result.code !== 0 &&
          resume &&
          !started &&
          SESSION_NOT_FOUND[runtime].test(result.stderr + '\n' + result.stdout)
        )
          return {
            ...base,
            status: 'failed',
            diagnostics: {
              ...diagnostics(
                `сессия ${resume} не продолжена: код ${result.code}${reason() ? ': ' + reason() : ''}`,
              ),
              sessionLost: true,
            },
          };
        if (result.code !== 0)
          return {
            ...base,
            // Нехватка окна — ответ runtime о запросе, а не недоступный runtime.
            status: started || contextExhausted ? 'failed' : 'unavailable',
            diagnostics: diagnostics(
              `код ${result.code}${reason() ? ': ' + reason() : ''}` +
                (!started && homeHint ? `; облегчённый режим: ${homeHint}` : ''),
            ),
          };
        let output: unknown;
        try {
          if (runtime === 'codex') {
            // Без ссылок (O_NOFOLLOW) и с пределом; итог — в каталог вызова.
            const cleaned = redact(await readBounded(resultPath, CODEX_RESULT_LIMIT));
            await writeFile(savedResult, cleaned);
            output = JSON.parse(cleaned);
          } else {
            const { events, malformed } = runtimeEvents(result.stdout);
            const last = events.findLast((e) => e.type === 'result');
            // `is_error` проверяется до разбора: `claudeResult` требует поле
            // `structured_output`, которого у такого `result` нет, и отказ
            // runtime при коде 0 читался как непрочитанный ответ.
            if (last?.is_error === true)
              return {
                ...base,
                status: 'failed',
                diagnostics: diagnostics(
                  redact(typeof last.result === 'string' ? last.result : 'ошибка runtime').slice(
                    0,
                    300,
                  ),
                ),
              };
            // Строки `result` нет, а поток содержит неразобранную строку (итог
            // оборван на выходе процесса): ответ — принятый вызов
            // `StructuredOutput` из того же потока (F59). Целая строка `result`
            // без ответа — решение CLI, она остаётся отказом.
            const accepted =
              last === undefined && malformed ? acceptedStructuredOutput(events) : undefined;
            output = accepted ? accepted.value : claudeResult.parse(last).structured_output;
          }
        } catch (error) {
          // Непрочитанный файл не замаскирован: на диске он не остаётся.
          if (error instanceof OversizedFile)
            await rm(savedResult, { force: true }).catch(() => undefined);
          return {
            ...base,
            status: 'failed',
            diagnostics: diagnostics(
              'структурированный ответ не прочитан: ' + redact(String(error)).slice(0, 300),
            ),
          };
        }
        return { ...base, status: 'ok', output, diagnostics: diagnostics() };
      } finally {
        // Каталог ответа исполнителя убирается на любом исходе.
        if (outDir) await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
