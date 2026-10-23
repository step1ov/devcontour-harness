import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import type {
  ProbeServer,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeRequest,
  RuntimeResponse,
  toolProfileSchema,
} from '../contracts/index.ts';
import { command } from '../environment/process.ts';
import {
  claudeFileDenies,
  claudeFileTools,
  claudeSandbox,
  codexPermissions,
  isolation,
  type Isolation,
} from '../environment/isolation.ts';
import { redactor } from '../environment/redaction.ts';
import { inspectReview } from './inspect.ts';
import { probeCallMs, probeServer, probeTool } from './review-probe.ts';
import { claudeResult, runtimeEvents } from './runtime-events.ts';
import { parseUsage, reportedModel, runtimeVersion, unknownUsage } from './usage.ts';

type ToolProfile = z.infer<typeof toolProfileSchema>;

/** Встроенные инструменты исполнителя claude, когда профиль их не называет; shell — в песочнице ОС. */
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
    `sandbox_workspace_write.network_access=${profile.codexNetwork}`,
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
}

/**
 * Адаптер CLI codex или claude. Каждый вызов — новая сессия: reviewer и
 * planner не получают сессии writer (`continue` отклоняется). Граница
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
      };
    },
    async invoke(r: RuntimeRequest, signal: AbortSignal): Promise<RuntimeResponse> {
      if (r.session.kind !== 'fresh')
        throw new Error(`${runtime}: продолжение сессии не поддерживается`);
      const review = r.task !== 'implement';
      const dir = r.artifactDir ?? (await mkdtemp(join(tmpdir(), 'harness-call-')));
      await mkdir(dir, { recursive: true });
      const schemaPath = join(dir, 'schema.json'),
        resultPath = join(dir, 'result.json'),
        logPath = join(dir, 'runtime.log');
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
      const policy: Isolation = isolation({
        write: r.sandbox.writable,
        controller: r.sandbox.denied,
        readable: [...(r.sandbox.readable ?? []), ...(review ? [r.cwd] : [])],
        domains: r.sandbox.network.domains,
        ...(options.controllerEntries ? { entries: options.controllerEntries } : {}),
      });
      const argv =
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
              ...codexPermissions(policy, !review && !!profile?.codexNetwork),
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
              review ? 'dontAsk' : 'acceptEdits',
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
                ...((
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
              '--no-session-persistence',
              ...(r.binding.model ? ['--model', r.binding.model] : []),
            ];
      const redact = redactor(r.secrets ?? []);
      const version = await runtimeVersion(executable, r.env);
      await writeFile(logPath, `Runtime ${runtime}; started ${new Date().toISOString()}\n`);
      let logged = 0;
      const unavailable = (reason: string): RuntimeResponse => ({
        status: 'unavailable',
        text: '',
        model: null,
        runtimeVersion: version,
        usage: unknownUsage(),
        diagnostics: { exitCode: null, reason: redact(reason).slice(0, 500), log: logPath },
      });
      let result;
      try {
        result = await command(argv, r.cwd, {
          contain: { dirs: review ? [] : r.sandbox.writable },
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
          env: { ...r.env, HOME: r.env.HOME ?? homedir() },
          redact,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM')
          return unavailable(`${runtime}: runtime не запускается: ${String(error)}`);
        throw error;
      }
      await writeFile(join(dir, 'runtime.json'), JSON.stringify(result.diagnostics, null, 2));
      const usage = parseUsage(
        runtime,
        result.stdout,
        result.code === 0 &&
          !result.timedOut &&
          !signal.aborted &&
          result.stdout.length < 2_000_000,
      );
      const model = reportedModel(result.stdout);
      const bookkeeping = ['system', 'result', 'error', 'session.created', 'thread.started'];
      const started =
        result.timedOut ||
        runtimeEvents(result.stdout).events.some((e) => !bookkeeping.includes(String(e.type)));
      const reason = () => {
        let text: string | undefined;
        if (runtime === 'claude') {
          const last = runtimeEvents(result.stdout).events.findLast((e) => e.type === 'result') as
            { result?: unknown } | undefined;
          if (typeof last?.result === 'string') text = last.result;
        }
        text ??= result.stderr
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .at(-1);
        return text ? redact(text).slice(0, 300) : undefined;
      };
      const base = {
        text: redact(result.stdout).slice(-20000),
        model,
        runtimeVersion: version,
        usage,
        ...(review ? { inspection: inspectReview(runtime, result.stdout) } : {}),
      };
      const diagnostics = (why?: string) => ({
        exitCode: result.code,
        ...(why ? { reason: why } : {}),
        log: logPath,
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
      if (result.code !== 0)
        return {
          ...base,
          status: started ? 'failed' : 'unavailable',
          diagnostics: diagnostics(`код ${result.code}${reason() ? ': ' + reason() : ''}`),
        };
      let output: unknown;
      try {
        if (runtime === 'codex') {
          const cleaned = redact(await readFile(resultPath, 'utf8'));
          await writeFile(resultPath, cleaned);
          output = JSON.parse(cleaned);
        } else {
          const final = claudeResult.parse(
            runtimeEvents(result.stdout).events.findLast((e) => e.type === 'result'),
          );
          if (final.is_error)
            return {
              ...base,
              status: 'failed',
              diagnostics: diagnostics(redact(final.result ?? 'ошибка runtime').slice(0, 300)),
            };
          output = final.structured_output;
        }
      } catch (error) {
        return {
          ...base,
          status: 'failed',
          diagnostics: diagnostics(
            'структурированный ответ не прочитан: ' + redact(String(error)).slice(0, 300),
          ),
        };
      }
      return { ...base, status: 'ok', output, diagnostics: diagnostics() };
    },
  };
}
