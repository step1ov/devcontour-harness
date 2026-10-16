import { randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ExecutionPolicy, ProbeServer } from '../contracts/index.ts';
import { redactor } from '../environment/redaction.ts';
import { runCheck } from '../verification/gates.ts';

/**
 * Пробные проверки reviewer под пределами harness.
 *
 * Reviewer, запускавший проверки своим shell, зависал на проверяемом коде:
 * срок команды задавал сам CLI модели, и одна зависшая команда съедала весь
 * срок ревью — готовый кандидат падал без вердикта. Здесь срок задаёт
 * controller: команда исполняется тем же исполнителем, что и gates (песочница
 * ОС, исходники только для чтения, остановка потомков), с пределом на
 * команду, общим бюджетом проверок и резервом времени на заключение.
 * Превышение — результат, который получает модель, а не зависание.
 */
export const probeServer = 'devcontour_probe';
export const probeTool = 'run_check';

export const probeSpec = z.object({
  cwd: z.string().min(1),
  /** Закрытое проверке и открытое на чтение — граница reviewer. */
  controller: z.array(z.string()),
  readable: z.array(z.string()),
  isolation: z.object({ mode: z.enum(['os', 'none']), domains: z.array(z.string()) }),
  commandTimeoutMs: z.number().int().min(1000),
  budgetMs: z.number().int().min(1000),
  /** Момент, к которому ревью должно быть готово дать заключение (epoch ms). */
  deadline: z.number().int(),
  /** Переменные окружения, передаваемые по имени; значения на диск не пишутся. */
  env: z.array(z.string()),
  secrets: z.array(z.string()),
  settingsDir: z.string().min(1),
  log: z.string().min(1),
});
export type ProbeSpec = z.infer<typeof probeSpec>;

export const probeInput = z.object({
  argv: z.array(z.string().min(1)).min(1).max(64),
  timeoutMs: z.number().int().min(1).optional(),
});

export type ProbeResult = {
  /**
   * Id запуска. Reviewer ссылается на него в воспроизведении, и «наблюдено»
   * ставится по журналу controller, а не по тексту команды: замаскированные
   * аргументы разных команд могут совпадать.
   */
  runId: string;
  argv: string[];
  /**
   * `timeout` — команда не уложилась в предел и остановлена вместе с
   * потомками; это наблюдение о команде на данном входе, а не доказанный
   * дефект. `budget-exhausted` — команда не запускалась: бюджет проверок или
   * время до заключения исчерпаны. `error` — команда не запустилась.
   */
  status: 'passed' | 'failed' | 'timeout' | 'budget-exhausted' | 'error';
  exitCode: number | null;
  durationMs: number;
  limitMs: number;
  budgetLeftMs: number;
  stdout: string;
  stderr: string;
  note?: string;
};

const tail = (text: string) => (text.length > 8000 ? '…' + text.slice(-8000) : text);

export class ReviewProbes {
  private spent = 0;
  constructor(
    readonly spec: ProbeSpec,
    private readonly now = () => Date.now(),
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}
  /** Сколько может длиться следующая команда: меньшее из трёх пределов. */
  limit(requested?: number) {
    return Math.max(
      0,
      Math.min(
        requested ?? this.spec.commandTimeoutMs,
        this.spec.commandTimeoutMs,
        this.spec.budgetMs - this.spent,
        this.spec.deadline - this.now(),
      ),
    );
  }
  async run(
    input: z.infer<typeof probeInput>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProbeResult> {
    const source = this.environment;
    const env = Object.fromEntries(
      this.spec.env.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]]])),
    ) as NodeJS.ProcessEnv;
    const redact = redactor(
      this.spec.secrets.flatMap((name) => (source[name] ? [source[name]] : [])),
    );
    const limitMs = this.limit(input.timeoutMs);
    // Аргументы — тоже сохраняемое поле: секрет в них попадал в результат и журнал.
    const base = {
      runId: randomUUID(),
      argv: input.argv.map((part) => redact(part)),
      limitMs,
      stdout: '',
      stderr: '',
    };
    let result: ProbeResult;
    // Меньше секунды на команду — это уже не проверка, а гарантированный
    // таймаут: честнее сказать, что время кончилось.
    if (limitMs < 1000)
      result = {
        ...base,
        status: 'budget-exhausted',
        exitCode: null,
        durationMs: 0,
        budgetLeftMs: Math.max(0, this.spec.budgetMs - this.spent),
        note: 'Бюджет проверок ревью или время до заключения исчерпаны; дай заключение по уже собранному.',
      };
    else {
      const started = this.now();
      // Предел команды резервируется до запуска, в том же синхронном шаге,
      // что и расчёт: одновременные вызовы иначе видели один остаток и
      // вместе превышали бюджет. После завершения резерв заменяется
      // фактической длительностью.
      this.spent += limitMs;
      try {
        const r = await runCheck(
          { config: { isolation: this.spec.isolation } },
          {
            argv: input.argv,
            cwd: this.spec.cwd,
            env: { ...env, CI: '1' },
            redact,
            timeoutMs: limitMs,
            signal,
            // Проверяемые исходники — только чтение; пишет проверка во
            // временный каталог, который runCheck создаёт и убирает сам.
            write: [],
            readable: this.spec.readable,
            controller: this.spec.controller,
            settingsDir: this.spec.settingsDir,
          },
        );
        const durationMs = this.now() - started;
        this.spent += durationMs - limitMs;
        result = {
          ...base,
          status: r.timedOut ? 'timeout' : r.code === 0 ? 'passed' : 'failed',
          exitCode: r.timedOut ? null : r.code,
          durationMs,
          budgetLeftMs: Math.max(0, this.spec.budgetMs - this.spent),
          stdout: tail(r.stdout),
          stderr: tail(r.stderr),
          ...(r.timedOut
            ? {
                note: `Команда не завершилась за ${limitMs} мс и остановлена вместе с потомками. Это наблюдение о команде на этом входе, а не доказанный дефект: назови вход и предел, если делаешь из него замечание.`,
              }
            : {}),
        };
      } catch (error) {
        const durationMs = this.now() - started;
        this.spent += durationMs - limitMs;
        result = {
          ...base,
          status: 'error',
          exitCode: null,
          durationMs,
          budgetLeftMs: Math.max(0, this.spec.budgetMs - this.spent),
          note:
            'Команда не запустилась — это отказ среды, а не результат проверки: ' +
            redact(error instanceof Error ? error.message : String(error)),
        };
      }
    }
    // Журнал — наблюдение controller, а не самоотчёт модели.
    await appendFile(
      this.spec.log,
      JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n',
    ).catch(() => undefined);
    return result;
  }
}

/**
 * Stdio MCP-сервер с одним инструментом — его запускает CLI reviewer.
 * Протокол — построчный JSON-RPC 2.0 (`initialize`, `tools/list`,
 * `tools/call`, `ping`); вызовы исполняются одновременно, бюджет общий —
 * один экземпляр `ReviewProbes` на сервер.
 */
export function serveReviewProbes(
  probes: ReviewProbes,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
) {
  const send = (message: unknown) => output.write(JSON.stringify(message) + '\n');
  const tool = {
    name: probeTool,
    description: `Run a check command (argv, no shell) in the candidate's directory with read-only sources. The controller stops it after ${probes.spec.commandTimeoutMs} ms per command and a total probe budget of ${probes.spec.budgetMs} ms; a timeout is returned as a result. The result carries a runId: cite it in reproduction.run when a finding rests on that run.`,
    inputSchema: z.toJSONSchema(probeInput, { target: 'draft-7' }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  };
  const pending = new Set<Promise<unknown>>();
  const lines = createInterface({ input });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const { id, method, params } = message;
    // Уведомления (без id) ответа не требуют.
    if (id === undefined) return;
    const reply = (result: unknown) => send({ jsonrpc: '2.0', id, result });
    const fail = (code: number, text: string) =>
      send({ jsonrpc: '2.0', id, error: { code, message: text } });
    if (method === 'initialize')
      return reply({
        protocolVersion:
          typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: probeServer, version: '1' },
      });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: [tool] });
    if (method === 'tools/call') {
      if (params?.name !== probeTool) return fail(-32602, 'Неизвестный инструмент');
      const parsed = probeInput.safeParse(params.arguments);
      if (!parsed.success) return fail(-32602, 'Неверные аргументы: ' + parsed.error.message);
      const call = probes
        .run(parsed.data)
        .then((result) =>
          reply({
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          }),
        )
        .catch((error: unknown) => fail(-32603, String(error)))
        .finally(() => pending.delete(call));
      pending.add(call);
      return;
    }
    fail(-32601, 'Метод не поддерживается: ' + String(method));
  });
  return { lines, pending };
}

/** Пределы проверок ревью, выведенные из срока фазы. */
export function probeLimits(policy: Pick<ExecutionPolicy, 'runTimeoutMs' | 'reviewProbes'>) {
  const reserveMs = Math.max(policy.reviewProbes.reserveMs, Math.round(policy.runTimeoutMs * 0.2));
  return {
    commandTimeoutMs: Math.min(policy.reviewProbes.commandTimeoutMs, policy.runTimeoutMs),
    budgetMs: Math.max(
      1000,
      Math.min(policy.reviewProbes.budgetMs, policy.runTimeoutMs - reserveMs),
    ),
    reserveMs,
  };
}

/** Срок вызова инструмента в CLI — с запасом сверх предела команды controller. */
export const probeCallMs = (probe: ProbeServer) => probe.commandTimeoutMs + 30000;

/**
 * Команда, которой CLI reviewer запускает сервер проверок — этот же пакет.
 * CLI стартует её из проверяемого каталога, поэтому загрузчик исходников
 * указан абсолютным путём: из worktree он бы не разрешился.
 */
export function probeCommand(specPath: string) {
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(
    new URL(source ? './probe-server.ts' : './probe-server.js', import.meta.url),
  );
  return {
    command: process.execPath,
    args: [...(source ? ['--import', import.meta.resolve('tsx')] : []), entry, '--spec', specPath],
  };
}

/** Запуск из журнала controller в том виде, в каком он входит в review.json. */
export interface ProbeRecord {
  runId: string;
  argv: string[];
  status: ProbeResult['status'];
  durationMs: number;
  limitMs: number;
}

/** Журнал проверок reviewer: по записи на запуск; нечитаемая строка — не запуск. */
export async function probeRecords(log: string): Promise<ProbeRecord[]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const p = JSON.parse(line) as ProbeRecord;
        return [
          {
            runId: String(p.runId),
            argv: p.argv,
            status: p.status,
            durationMs: p.durationMs,
            limitMs: p.limitMs,
          },
        ];
      } catch {
        return [];
      }
    });
}

/**
 * Воспроизведения находок, сверенные с журналом controller. «Наблюдено» —
 * только по запуску, на который сослался reviewer: он состоялся (исчерпанный
 * бюджет и отказ до старта — не наблюдение), совпадение единственное, и
 * команда в записи — та, что действительно запускалась. Команда из текста
 * находки не исполняется. Ответ reviewer мог прийти уже замаскированным, и
 * короткий секрет задевает символы id: id журнала сравниваются и в той же маске.
 */
export function observeReproductions<
  F extends { reproduction?: { command: string[] | null; run?: string | null } | null },
>(findings: F[], probes: ProbeRecord[] | undefined, redact: (text: string) => string) {
  return findings.map((f) => {
    const r = f.reproduction;
    if (!r) return f;
    const matches = r.run
      ? (probes ?? []).filter((p) => p.runId === r.run || redact(p.runId) === r.run)
      : [];
    const cited = matches.length === 1 ? matches[0] : undefined;
    const ran = !!cited && ['passed', 'failed', 'timeout'].includes(cited.status);
    return {
      ...f,
      reproduction: {
        ...r,
        command: ran ? cited.argv : r.command,
        run: ran ? cited.runId : null,
        observed: ran,
      },
    };
  });
}
