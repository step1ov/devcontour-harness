import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  idSchema,
  relativePathSchema,
  sha256,
  type ExecutionPolicy,
  type GatePolicy,
  type ProbeServer,
} from '../contracts/index.ts';
import { redactor } from '../environment/redaction.ts';
import {
  completedCheck,
  freshnessEnv,
  propertyReportEnv,
  junitSummary,
  runCheck,
  sandboxBlockedHosts,
} from '../verification/gates.ts';

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
 *
 * Объявленный gate reviewer запускает по ID (`{"gate":"<id>"}`): argv, cwd и
 * окружение controller берёт из эффективной политики, JUnit пишется в
 * собственный scratch controller вне проверяемого дерева
 * (`HARNESS_REPORT_PATH`/`DEVCONTOUR_REPORT_PATH`), отчёт и метаданные
 * сохраняются в каталоге ревью до удаления scratch. На пилоте reviewer
 * запускал команду gate через argv, проверка писала `.reports/*.xml` в
 * дерево только для чтения и падала с EPERM. Ответ модели не задаёт ни
 * argv gate, ни пути, ни окружение: лишнее поле — отказ протокола.
 */
export const probeServer = 'devcontour_probe';
export const probeTool = 'run_check';

/** Объявленный gate в виде, в каком его исполняет probe: копия из эффективной политики. */
export const probeGate = z.strictObject({
  id: idSchema,
  kind: z.enum(['test', 'check']),
  command: z.array(z.string().min(1)).min(1),
  cwd: relativePathSchema.optional(),
  timeoutMs: z.number().positive(),
  report: z.strictObject({ type: z.literal('junit'), path: relativePathSchema }).optional(),
  /** Генеративный gate: seed и корпус задаёт только движок, probe его не исполняет. */
  property: z.boolean().optional(),
});
export type ProbeGate = z.infer<typeof probeGate>;

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
  /** Объявленные gates, которые reviewer может запустить по ID. */
  gates: z.array(probeGate).optional(),
  /** Фаза и SHA ревью: записываются в каждый запуск gate. */
  phase: z.string().optional(),
  sha: z.string().optional(),
  /**
   * Вызов reviewer, которому принадлежит журнал: попытка harness, фаза, SHA
   * и номер вызова. Записывается в каждый исход — по нему итог ревью не
   * присваивает себе запуски чужого вызова.
   */
  scope: z
    .strictObject({
      attempt: z.string().min(1),
      phase: z.string().min(1),
      sha: z.string().min(1),
      call: z.number().int().positive(),
    })
    .optional(),
  /** Каталог controller для отчётов и журналов запусков gate; вне проверяемого дерева. */
  artifacts: z.string().optional(),
});
export type ProbeSpec = z.infer<typeof probeSpec>;

export const probeInput = z
  .strictObject({
    argv: z.array(z.string().min(1)).min(1).max(64).optional(),
    /** ID объявленного gate: команду, cwd и путь отчёта выбирает controller. */
    gate: idSchema.optional(),
    timeoutMs: z.number().int().min(1).optional(),
  })
  .refine((v) => (v.argv === undefined) !== (v.gate === undefined), {
    message: 'Нужен ровно один из argv или gate',
  });

/** Состояние JUnit-отчёта запуска gate, как его увидел controller. */
export type ProbeReport = {
  /**
   * `fresh` — обычный файл, созданный этим запуском в scratch controller и
   * разобранный; `missing` — отчёта нет; `stale` — файл старше запуска
   * (скопирован с прежним временем); `corrupt` — не JUnit или без testcases;
   * `unsafe` — symlink, жёсткая ссылка или путь вне scratch: не читается.
   */
  status: 'fresh' | 'missing' | 'stale' | 'corrupt' | 'unsafe';
  /** Сохранённая копия (замаскированная) в каталоге controller. */
  path?: string;
  digest?: string;
  tests?: number;
  failures?: number;
  skipped?: number;
  failed?: string[];
  problem?: string;
};

/** Запуск объявленного gate через probe: что, где и на чём исполнено. */
export type ProbeGateRun = {
  id: string;
  phase: string | null;
  sha: string | null;
  /** Каталог запуска относительно проверяемого дерева. */
  cwd: string;
  /** Фактический argv (замаскированный) — из политики, не из ответа модели. */
  argv: string[];
  /** Имена переменных, которые выставил controller (значения не пишутся). */
  controllerEnv: string[];
  report?: ProbeReport;
  /**
   * Копия отчёта свойств, если проверка записала его по пути
   * `DEVCONTOUR_PROPERTY_REPORT` в scratch. Только evidence probe: движок
   * этот отчёт не читает, и свойства по нему не засчитываются.
   */
  propertyReport?: { path: string; scope: 'probe-only' };
  /** Каталог evidence запуска в каталоге ревью controller. */
  artifacts?: string;
  /** Временный каталог отчёта; убран после сохранения evidence. */
  scratch?: string;
  scratchRemoved?: boolean;
};

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
   * время до заключения исчерпаны. `error` — команда не запустилась или
   * отказала среда (`failure`). `rejected` — вход отклонён до запуска
   * (неизвестный gate). `cancelled` — вызов отменён, процессы остановлены.
   */
  status: 'passed' | 'failed' | 'timeout' | 'budget-exhausted' | 'error' | 'rejected' | 'cancelled';
  exitCode: number | null;
  durationMs: number;
  limitMs: number;
  budgetLeftMs: number;
  stdout: string;
  stderr: string;
  note?: string;
  /**
   * Причина неуспеха не в проверяемом коде: `environment` — среда или рецепт
   * отчёта (EPERM, scratch, песочница), `report` — отчёт отсутствует,
   * устарел, битый или небезопасен. Ни то, ни другое не находка в коде.
   */
  failure?: 'environment' | 'report';
  /** Запуск объявленного gate. */
  gate?: ProbeGateRun;
  /** Журнал controller, в котором записан этот запуск. */
  log?: string;
  /**
   * Запуск проверки подтверждён на границе исполнения (`runCheck`): процесс
   * порождён или обёртка песочницы создала метку старта. `false` — команда
   * не начиналась (отказ до старта, бюджет, неизвестный gate, отмена до
   * запуска). У записей alpha.6 и ранее поля нет.
   */
  started: boolean;
  /** Вызов reviewer, которому принадлежит запуск (из спецификации probe). */
  scope?: ProbeSpec['scope'];
};

const tail = (text: string) => (text.length > 8000 ? '…' + text.slice(-8000) : text);
const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
/** Сохраняемый отчёт ограничен: битый многомегабайтный файл — не evidence. */
const REPORT_LIMIT = 5_000_000;

/** Наблюдение reviewer, а не gate движка: напоминание в каждом результате gate. */
const observation =
  'Это наблюдение reviewer: обязательные gates candidate/integration запускает и оценивает движок, probe их не заменяет.';

/** Как сделать gate пригодным для probe: путь отчёта — из переменной controller. */
export const reportRecipe =
  'Рецепт: команда gate берёт путь JUnit из HARNESS_REPORT_PATH (или DEVCONTOUR_REPORT_PATH) с прежним путём по умолчанию — например `sh -c \'gotestsum --junitfile "${HARNESS_REPORT_PATH:-.reports/junit.xml}" -- ./...\'`, `pytest --junitxml="${HARNESS_REPORT_PATH:-.reports/junit.xml}"`, `--test-reporter-destination=${HARNESS_REPORT_PATH:-.reports/junit.xml}` в package script (см. docs/review-probes.md).';

/**
 * Аргумент argv, который сам задаёт путь отчёта gate внутри дерева: целиком
 * или после `=` (`--junitxml=…`), относительно cwd gate. Это диагностика, а
 * не подстановка: argv не переписывается, gate с таким аргументом в probe не
 * запускается — дерево там только для чтения.
 */
export function fixedReportArgument(argv: string[], cwd: string, report: string) {
  for (const [index, token] of argv.entries()) {
    const eq = token.indexOf('=');
    for (const value of eq > 0 ? [token, token.slice(eq + 1)] : [token])
      if (value && resolve(cwd, value) === report) return { index, token };
  }
  return undefined;
}

/**
 * Копия отчёта свойств из scratch в evidence probe. Как и JUnit: symlink,
 * жёсткая ссылка, файл вне scratch и слишком большой файл не читаются.
 */
async function savePropertyReport(
  path: string,
  scratch: string,
  runDir: string,
  id: string,
  redact: (text: string) => string,
): Promise<ProbeGateRun['propertyReport']> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat?.isFile() || stat.nlink > 1 || stat.size > REPORT_LIMIT) return undefined;
  const real = await realpath(path);
  if (!within(dirname(real), scratch)) return undefined;
  const saved = join(runDir, `${id}.property.json`);
  await writeFile(saved, redact(await readFile(real, 'utf8')), { flag: 'wx' });
  return { path: saved, scope: 'probe-only' as const };
}

/**
 * Отчёт запуска gate в scratch controller. Symlink, жёсткая ссылка и путь вне
 * scratch не читаются: так отчёт подменялся бы чужим файлом — прежним
 * `.reports/*.xml` дерева или файлом вне его. Файл старше запуска — не
 * свежий отчёт, даже если он лежит на нужном месте.
 */
async function inspectReport(
  path: string,
  scratch: string,
  started: number,
  redact: (text: string) => string,
): Promise<{ report: ProbeReport; xml?: string }> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) return { report: { status: 'missing', problem: 'JUnit-отчёт не создан' } };
  if (stat.isSymbolicLink() || !stat.isFile())
    return { report: { status: 'unsafe', problem: 'отчёт — symlink или не обычный файл' } };
  if (stat.nlink > 1)
    return { report: { status: 'unsafe', problem: 'отчёт — жёсткая ссылка на другой файл' } };
  const real = await realpath(path);
  if (!within(dirname(real), scratch))
    return { report: { status: 'unsafe', problem: 'отчёт вне scratch controller' } };
  if (stat.size > REPORT_LIMIT)
    return { report: { status: 'corrupt', problem: `отчёт больше ${REPORT_LIMIT} байт` } };
  const xml = await readFile(real, 'utf8');
  if (stat.mtimeMs < started - 1000)
    return {
      report: { status: 'stale', problem: 'отчёт старше запуска: прежний файл, не результат' },
      xml,
    };
  try {
    const counts = junitSummary(xml, redact);
    return {
      report: {
        status: 'fresh',
        tests: counts.tests,
        failures: counts.failures,
        skipped: counts.skipped,
        ...(counts.failed.length ? { failed: counts.failed.slice(0, 20) } : {}),
      },
      xml,
    };
  } catch (error) {
    return {
      report: {
        status: 'corrupt',
        problem: redact(error instanceof Error ? error.message : String(error)),
      },
      xml,
    };
  }
}

/** Временный каталог убирается и тогда, когда проверка сняла с него права. */
async function removeScratch(dir: string) {
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    try {
      await chmod(dir, 0o700);
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/** Признак отказа записи: проверка писала туда, где ей нельзя (дерево только для чтения). */
const writeDenied = /\bEPERM\b|\bEACCES\b|operation not permitted|read-only file system/i;

type Outcome = Pick<
  ProbeResult,
  'status' | 'exitCode' | 'stdout' | 'stderr' | 'note' | 'failure' | 'gate' | 'log'
>;
/** Факт старта, который исполнитель отмечает сразу на границе запуска. */
type Launch = { started: boolean };

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
  /** Каталог evidence запусков gate: из спецификации или рядом с журналом. */
  get artifacts() {
    return this.spec.artifacts ?? join(dirname(this.spec.log), 'probe-runs');
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
    const runId = randomUUID();
    const gate =
      input.gate === undefined
        ? undefined
        : (this.spec.gates ?? []).find((g) => g.id === input.gate);
    const argv = gate ? gate.command : (input.argv ?? []);
    const limitMs = this.limit(
      gate ? Math.min(input.timeoutMs ?? gate.timeoutMs, gate.timeoutMs) : input.timeoutMs,
    );
    // Аргументы — тоже сохраняемое поле: секрет в них попадал в результат и журнал.
    const base = {
      runId,
      argv: argv.map((part) => redact(part)),
      limitMs,
      stdout: '',
      stderr: '',
      started: false,
      ...(this.spec.scope ? { scope: this.spec.scope } : {}),
    };
    const budgetLeft = () => Math.max(0, this.spec.budgetMs - this.spent);
    let result: ProbeResult;
    if (signal.aborted)
      // Отменённый до запуска вызов не исполняется и не резервирует бюджет.
      result = {
        ...base,
        status: 'cancelled',
        exitCode: null,
        durationMs: 0,
        budgetLeftMs: budgetLeft(),
        note: 'Вызов отменён до запуска; команда не исполнялась.',
      };
    else if (input.gate !== undefined && (!gate || gate.property))
      // Неизвестный ID не исполняется и не тратит бюджет: модель не выбирает
      // команду, только объявленный gate.
      result = {
        ...base,
        status: 'rejected',
        exitCode: null,
        durationMs: 0,
        budgetLeftMs: budgetLeft(),
        note: gate
          ? `Gate ${gate.id} генеративный: seed и корпус задаёт движок, probe его не запускает.`
          : `Неизвестный gate ${redact(input.gate)}; объявлены: ${
              (this.spec.gates ?? [])
                .filter((g) => !g.property)
                .map((g) => g.id)
                .join(', ') || 'нет'
            }.`,
      };
    // Меньше секунды на команду — это уже не проверка, а гарантированный
    // таймаут: честнее сказать, что время кончилось.
    else if (limitMs < 1000)
      result = {
        ...base,
        status: 'budget-exhausted',
        exitCode: null,
        durationMs: 0,
        budgetLeftMs: budgetLeft(),
        note: 'Бюджет проверок ревью или время до заключения исчерпаны; дай заключение по уже собранному.',
      };
    else {
      const started = this.now();
      // Предел команды резервируется до запуска, в том же синхронном шаге,
      // что и расчёт: одновременные вызовы иначе видели один остаток и
      // вместе превышали бюджет. После завершения резерв заменяется
      // фактической длительностью.
      this.spent += limitMs;
      // Резерв записан в журнал и сброшен на диск до запуска: controller,
      // убитый посреди команды, не теряет израсходованное — новый процесс
      // засчитывает незавершённый запуск целиком (R3-F01). Без записи
      // проверка не запускается.
      const reserved = reserveProbe(this.spec.log, runId, limitMs, base.argv, gate?.id);
      // Факт старта отмечается на границе исполнения и переживает исключение
      // после неё: упавшее сохранение отчёта не делает запуск «не бывшим».
      const launch: Launch = { started: false };
      let outcome: Outcome;
      try {
        if (reserved) throw reserved;
        // Метка запуска наследуется потомками: по ней recovery находит и
        // останавливает процессы проверки, пережившие controller.
        const marked = { ...env, [probeRunEnv]: runId };
        outcome = gate
          ? await this.gate(gate, runId, limitMs, marked, redact, signal, launch)
          : await this.command(argv, runId, limitMs, marked, redact, signal, launch);
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        // Проверка завершилась, а исключение пришло после (уборка): её код
        // и вывод — исход, который не теряется.
        const done = completedCheck(error);
        outcome = done
          ? {
              status: 'error',
              failure: 'environment',
              exitCode: done.timedOut || signal.aborted ? null : done.code,
              stdout: tail(done.stdout),
              stderr: tail(done.stderr),
              note:
                'Проверка завершилась, но controller не убрал её временные каталоги — отказ среды после исхода: ' +
                message,
            }
          : signal.aborted && !launch.started
            ? {
                status: 'cancelled',
                exitCode: null,
                stdout: '',
                stderr: '',
                note: 'Вызов отменён до запуска; команда не исполнялась.',
              }
            : {
                status: 'error',
                exitCode: null,
                stdout: '',
                stderr: '',
                failure: 'environment',
                note: launch.started
                  ? 'Проверка запустилась, но её исход не получен — отказ среды, а не результат проверки: ' +
                    message
                  : 'Команда не запустилась — это отказ среды, а не результат проверки: ' + message,
              };
      }
      const durationMs = this.now() - started;
      this.spent += durationMs - limitMs;
      result = {
        ...base,
        ...outcome,
        started: launch.started,
        durationMs,
        budgetLeftMs: budgetLeft(),
      };
    }
    // Журнал — наблюдение controller, а не самоотчёт модели. Строка исхода
    // разрешает записанный ранее резерв фактической длительностью.
    await appendFile(
      this.spec.log,
      JSON.stringify({
        at: new Date().toISOString(),
        ...result,
        log: result.log ?? this.spec.log,
      }) + '\n',
    ).catch(() => undefined);
    return { ...result, log: result.log ?? this.spec.log };
  }

  /** Исследовательская команда reviewer: исходники только для чтения, запись — в TMPDIR. */
  private async command(
    argv: string[],
    runId: string,
    limitMs: number,
    env: NodeJS.ProcessEnv,
    redact: (text: string) => string,
    signal: AbortSignal,
    launch: Launch,
  ): Promise<Outcome> {
    const r = await runCheck(
      { config: { isolation: this.spec.isolation } },
      {
        argv,
        onStart: () => (launch.started = true),
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
        // Настройки песочницы — свои у каждого запуска: одновременные
        // вызовы иначе переписывали друг другу границы записи.
        settingsDir: join(this.spec.settingsDir, runId),
      },
    );
    // Команда объявленного gate, запущенная через argv, пишет отчёт в дерево
    // только для чтения: её EPERM — следствие способа запуска, не кода.
    const denied =
      !r.timedOut && !signal.aborted && r.code !== 0 && writeDenied.test(r.stdout + r.stderr);
    const gate = denied
      ? (this.spec.gates ?? []).find(
          (g) => !g.property && JSON.stringify(g.command) === JSON.stringify(argv),
        )
      : undefined;
    const hint = denied
      ? {
          note: gate
            ? `Это команда gate ${gate.id}: через argv она пишет отчёт в дерево только для чтения (EPERM) — ошибка способа запуска, а не находка в коде. Запусти её вызовом {"gate":"${gate.id}"}.`
            : 'Отказ записи (EPERM/EACCES): исходники только для чтения, писать можно в TMPDIR. Объявленный gate запускается вызовом {"gate":"<id>"}.',
          ...(gate ? { failure: 'environment' as const } : {}),
        }
      : {};
    return {
      ...hint,
      status: signal.aborted
        ? 'cancelled'
        : r.timedOut
          ? 'timeout'
          : r.code === 0
            ? 'passed'
            : 'failed',
      exitCode: r.timedOut || signal.aborted ? null : r.code,
      stdout: tail(r.stdout),
      stderr: tail(r.stderr),
      ...(r.timedOut && !signal.aborted
        ? {
            note: `Команда не завершилась за ${limitMs} мс и остановлена вместе с потомками. Это наблюдение о команде на этом входе, а не доказанный дефект: назови вход и предел, если делаешь из него замечание.`,
          }
        : signal.aborted
          ? { note: 'Вызов отменён; команда остановлена вместе с потомками.' }
          : {}),
    };
  }

  /**
   * Объявленный gate. Controller берёт argv, cwd и окружение из спецификации
   * (копии эффективной политики), отчёт направляет в собственный scratch вне
   * дерева, сохраняет отчёт, журнал и метаданные в каталоге ревью и только
   * потом убирает scratch. Дерево и `.git` остаются только для чтения;
   * прежние `.reports/*.xml` дерева не читаются, не удаляются и не
   * перезаписываются.
   */
  private async gate(
    gate: ProbeGate,
    runId: string,
    limitMs: number,
    env: NodeJS.ProcessEnv,
    redact: (text: string) => string,
    signal: AbortSignal,
    launch: Launch,
  ): Promise<Outcome> {
    const meta: ProbeGateRun = {
      id: gate.id,
      phase: this.spec.phase ?? null,
      sha: this.spec.sha ?? null,
      cwd: gate.cwd ?? '.',
      argv: gate.command.map(redact),
      controllerEnv: [],
    };
    const empty = { exitCode: null, stdout: '', stderr: '', gate: meta };
    const environment = (note: string): Outcome => ({
      ...empty,
      status: 'error',
      failure: 'environment',
      note: `${note} Это ошибка среды или рецепта отчёта, а не находка в коде. ${observation}`,
    });
    const root = await realpath(this.spec.cwd);
    const gateCwd = await realpath(resolve(root, gate.cwd ?? '.')).catch(() => undefined);
    if (!gateCwd) return environment(`Каталог gate ${meta.cwd} отсутствует в проверяемом дереве.`);
    if (!within(gateCwd, root))
      return { ...empty, status: 'rejected', note: 'Gate cwd выходит из worktree.' };
    if (gate.report) {
      const fixed = fixedReportArgument(gate.command, gateCwd, resolve(root, gate.report.path));
      // Такой gate в дереве только для чтения упал бы с EPERM: не запускаем
      // и называем аргумент, а не переписываем его.
      if (fixed)
        return environment(
          `Gate ${gate.id} задаёт путь JUnit в argv (аргумент ${fixed.index}: ${redact(fixed.token)}) внутри проверяемого дерева, а в probe дерево только для чтения; controller не подменяет argv. ${reportRecipe}`,
        );
    }
    // Каталог evidence — у controller, вне проверяемого дерева; свой у
    // каждого запуска: одновременные и повторные probes не переписывают
    // друг друга.
    const artifacts = this.artifacts;
    let runDir: string;
    try {
      await mkdir(artifacts, { recursive: true });
      const real = await realpath(artifacts);
      if (within(real, root)) throw new Error('каталог evidence probe внутри проверяемого дерева');
      runDir = join(real, runId);
      await mkdir(runDir);
    } catch (error) {
      return environment(
        `Не подготовлен каталог evidence probe: ${redact(error instanceof Error ? error.message : String(error))}.`,
      );
    }
    meta.artifacts = runDir;
    const logPath = join(runDir, `${gate.id}.log`);
    let scratch: string;
    try {
      scratch = await realpath(await mkdtemp(join(tmpdir(), 'dc-probe-report-')));
      if (within(scratch, root) || this.spec.controller.some((c) => within(scratch, c)))
        throw new Error('scratch отчёта внутри проверяемого дерева или каталога controller');
    } catch (error) {
      const outcome = environment(
        `Не подготовлен scratch отчёта: ${redact(error instanceof Error ? error.message : String(error))}.`,
      );
      await writeFile(logPath, redact(outcome.note ?? ''), { flag: 'wx' }).catch(() => undefined);
      return { ...outcome, log: logPath };
    }
    meta.scratch = scratch;
    const reportPath = join(scratch, `${gate.id}.xml`);
    // Отчёт свойств — тоже в scratch, под тем же именем переменной, что и у
    // gate движка (`propertyReportEnv`): проверка, пишущая отчёт свойств по
    // прежнему пути в дереве, под probe получала бы EPERM. Seed, селектор и
    // корпус probe не выставляет: генеративные gate он не исполняет.
    const propertyPath = join(scratch, `${gate.id}.property.json`);
    const controllerEnv: Record<string, string> = {
      CI: '1',
      ...freshnessEnv(gate.kind, env),
      ...(gate.report
        ? { DEVCONTOUR_REPORT_PATH: reportPath, HARNESS_REPORT_PATH: reportPath }
        : {}),
      [propertyReportEnv]: propertyPath,
    };
    meta.controllerEnv = Object.keys(controllerEnv);
    const started = Date.now();
    let outcome: Outcome;
    let header = `# harness probe gate ${gate.id}: run=${runId} phase=${meta.phase ?? '-'} sha=${meta.sha ?? '-'} cwd=${relative(root, gateCwd) || '.'} argv=${JSON.stringify(meta.argv)} env=${meta.controllerEnv.join(',')}\n`;
    let output = '';
    let finished: Awaited<ReturnType<typeof runCheck>> | undefined;
    try {
      const r = await runCheck(
        { config: { isolation: this.spec.isolation } },
        {
          argv: gate.command,
          onStart: () => (launch.started = true),
          cwd: gateCwd,
          env: { ...env, ...controllerEnv },
          redact,
          timeoutMs: limitMs,
          signal,
          // Писать можно только в scratch отчёта (и собственный TMPDIR
          // runCheck): не в дерево, не в .git, не в каталог controller.
          write: [scratch],
          readable: this.spec.readable,
          controller: this.spec.controller,
          settingsDir: join(this.spec.settingsDir, runId),
        },
      );
      finished = r;
      output = r.stdout + '\n' + r.stderr;
      // Отчёт читается и сохраняется до удаления scratch — при любом исходе.
      const read = gate.report
        ? await inspectReport(reportPath, scratch, started, redact)
        : undefined;
      meta.propertyReport = await savePropertyReport(
        propertyPath,
        scratch,
        runDir,
        gate.id,
        redact,
      );
      if (read) {
        meta.report = read.report;
        if (read.xml !== undefined) {
          const saved = redact(read.xml);
          const path = join(runDir, `${gate.id}.xml`);
          await writeFile(path, saved, { flag: 'wx' });
          meta.report = { ...meta.report, path, digest: sha256(saved) };
        }
      }
      const base = { exitCode: r.timedOut || signal.aborted ? null : r.code, gate: meta };
      const streams = { stdout: tail(r.stdout), stderr: tail(r.stderr) };
      const report = meta.report;
      const blocked =
        this.spec.isolation.mode === 'os' && r.code !== 0
          ? sandboxBlockedHosts(output, this.spec.isolation.domains)
          : [];
      if (signal.aborted)
        outcome = {
          ...base,
          ...streams,
          status: 'cancelled',
          note: 'Вызов отменён; gate остановлен вместе с потомками, evidence сохранено.',
        };
      else if (r.timedOut)
        outcome = {
          ...base,
          ...streams,
          status: 'timeout',
          note: `Gate не завершился за ${limitMs} мс и остановлен вместе с потомками; это наблюдение, а не доказанный дефект. ${observation}`,
        };
      else if (blocked.length)
        outcome = {
          ...base,
          ...streams,
          status: 'error',
          failure: 'environment',
          note: `Песочница закрыла сеть к ${blocked.join(', ')} (нет в isolation.domains): ошибка среды, не находка в коде.`,
        };
      else if (r.code !== 0 && report?.status !== 'fresh' && writeDenied.test(output))
        // Отчёта нет, а проверка получила отказ записи: она писала мимо
        // HARNESS_REPORT_PATH — в дерево, которое здесь только для чтения.
        outcome = {
          ...base,
          ...streams,
          status: 'error',
          failure: 'environment',
          note: `Gate ${gate.id} получил отказ записи (EPERM/EACCES) и не записал JUnit в HARNESS_REPORT_PATH: вероятно, путь отчёта зашит в команду или package script. Это ошибка среды или рецепта отчёта, а не находка в коде. ${reportRecipe}`,
        };
      else if (r.code !== 0)
        outcome = {
          ...base,
          ...streams,
          status: 'failed',
          note: `Код выхода ${r.code}${report?.failures ? `; упали ${report.failed?.join(', ') ?? report.failures}` : ''}. ${observation}`,
        };
      else if (report && report.status !== 'fresh')
        outcome = {
          ...base,
          ...streams,
          status: 'failed',
          failure: 'report',
          note: `Код выхода 0, но JUnit ${report.status}: ${report.problem ?? ''}. Без свежего отчёта это не прохождение; это не находка в коде. ${observation}`,
        };
      else if (report && (report.failures || report.skipped))
        outcome = {
          ...base,
          ...streams,
          status: 'failed',
          note: `${report.tests} tests, ${report.failures} failures, ${report.skipped} skipped. ${observation}`,
        };
      else
        outcome = {
          ...base,
          ...streams,
          status: 'passed',
          note: `${report ? `${report.tests} tests, 0 failures, 0 skipped. ` : ''}${observation}`,
        };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      // Сбой после старта (например, сохранения отчёта) не стирает исход
      // процесса: код и вывод завершившейся проверки остаются в результате.
      outcome = launch.started
        ? {
            ...environment(`Gate запустился, но его evidence не сохранено: ${message}.`),
            ...((finished ??= completedCheck(error))
              ? {
                  exitCode: finished.timedOut || signal.aborted ? null : finished.code,
                  stdout: tail(finished.stdout),
                  stderr: tail(finished.stderr),
                }
              : {}),
          }
        : signal.aborted
          ? {
              ...empty,
              status: 'cancelled',
              note: 'Вызов отменён до запуска gate; gate не исполнялся.',
            }
          : environment(`Gate не запустился: ${message}.`);
    } finally {
      meta.scratchRemoved = await removeScratch(scratch);
    }
    header += `# status=${outcome.status}${outcome.failure ? ` failure=${outcome.failure}` : ''} exit=${outcome.exitCode ?? '-'} report=${meta.report?.status ?? '-'}${meta.report?.digest ? ` digest=${meta.report.digest}` : ''} scratchRemoved=${meta.scratchRemoved}\n`;
    try {
      await writeFile(
        logPath,
        redact(header + output + (outcome.note ? '\n' + outcome.note : '')),
        { flag: 'wx' },
      );
      await writeFile(
        join(runDir, 'run.json'),
        JSON.stringify(
          {
            runId,
            status: outcome.status,
            failure: outcome.failure,
            started: launch.started,
            gate: meta,
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
    } catch (error) {
      // Исход уже получен: отказ записи evidence не стирает код и вывод.
      outcome = {
        ...outcome,
        status: 'error',
        failure: 'environment',
        note: `${outcome.note ?? ''} Evidence запуска не сохранено: ${redact(error instanceof Error ? error.message : String(error))}.`.trim(),
      };
    }
    return { ...outcome, gate: meta, log: logPath };
  }
}

/**
 * Stdio MCP-сервер с одним инструментом — его запускает CLI reviewer.
 * Протокол — построчный JSON-RPC 2.0 (`initialize`, `tools/list`,
 * `tools/call`, `ping`, уведомление `notifications/cancelled`); вызовы
 * исполняются одновременно, бюджет общий — один экземпляр `ReviewProbes` на
 * сервер. Отменённый вызов и закрытие входа останавливают свои проверки.
 */
export function serveReviewProbes(
  probes: ReviewProbes,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
) {
  const send = (message: unknown) => output.write(JSON.stringify(message) + '\n');
  const declared = (probes.spec.gates ?? []).filter((g) => !g.property).map((g) => g.id);
  const tool = {
    name: probeTool,
    description:
      `Run a check in the candidate's directory with read-only sources. Either {"argv": [...]} (no shell; exploratory command, temporary files go to TMPDIR) or {"gate": "<id>"} to run a declared gate exactly as the controller defines it (its argv, cwd and environment; the JUnit report goes to a controller scratch directory outside the sources and is saved by the controller). No other fields are accepted. ` +
      (declared.length ? `Declared gates: ${declared.join(', ')}. ` : '') +
      `The controller stops it after ${probes.spec.commandTimeoutMs} ms per command and a total probe budget of ${probes.spec.budgetMs} ms; a timeout is returned as a result. The result carries a runId: cite it in reproduction.run when a finding rests on that run. A gate run is your observation only; it does not replace the mandatory gates.`,
    inputSchema: z.toJSONSchema(probeInput, { target: 'draft-7' }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  };
  const pending = new Set<Promise<unknown>>();
  const running = new Map<number | string, AbortController>();
  const lines = createInterface({ input });
  lines.on('close', () => {
    for (const controller of running.values()) controller.abort();
  });
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
    if (method === 'notifications/cancelled') {
      const target = params?.requestId;
      if (typeof target === 'string' || typeof target === 'number') running.get(target)?.abort();
      return;
    }
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
        serverInfo: { name: probeServer, version: '2' },
      });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: [tool] });
    if (method === 'tools/call') {
      if (params?.name !== probeTool) return fail(-32602, 'Неизвестный инструмент');
      const parsed = probeInput.safeParse(params.arguments);
      if (!parsed.success) return fail(-32602, 'Неверные аргументы: ' + parsed.error.message);
      const controller = new AbortController();
      running.set(id, controller);
      const call = probes
        .run(parsed.data, controller.signal)
        .then((result) =>
          reply({
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          }),
        )
        .catch((error: unknown) => fail(-32603, String(error)))
        .finally(() => {
          running.delete(id);
          pending.delete(call);
        });
      pending.add(call);
      return;
    }
    fail(-32601, 'Метод не поддерживается: ' + String(method));
  });
  return { lines, pending };
}

/** Объявленные gates репозитория в виде спецификации probe. */
export function probeGates(gates: GatePolicy[]): ProbeGate[] {
  return gates.map((g) => ({
    id: g.id,
    kind: g.kind,
    command: g.command,
    ...(g.cwd ? { cwd: g.cwd } : {}),
    timeoutMs: g.timeoutMs,
    ...(g.report ? { report: { type: g.report.type, path: g.report.path } } : {}),
    ...(g.property ? { property: true } : {}),
  }));
}

/**
 * Часть запроса reviewer о запуске объявленных gates: готовый вызов по ID,
 * без самостоятельного env-wrapper. Пусто, если запускать нечего.
 */
export function gateProbePrompt(gates: ProbeGate[]) {
  const runnable = gates.filter((g) => !g.property);
  if (!runnable.length) return '';
  return [
    `To run a declared gate, call ${probeTool} with exactly ${runnable.map((g) => JSON.stringify({ gate: g.id })).join(', ')} (one gate per call).`,
    'The controller takes the gate argv, cwd and environment from policy and sends its JUnit report (HARNESS_REPORT_PATH/DEVCONTOUR_REPORT_PATH) to its own scratch directory outside the sources; the result gives the gate, argv, cwd, phase, SHA, report status and counts.',
    'Do not run gate commands through argv and do not wrap them with env: sources and .reports are read-only, and a report written into the tree fails with EPERM.',
    'A result with failure "environment" or "report" is a setup or report problem, not a defect in the code: do not turn it into a code finding.',
    'A gate run is your observation only: the harness still runs and judges the mandatory gates itself.',
  ].join(' ');
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
  /** Отказ среды или отчёта — не наблюдение о коде. */
  failure?: ProbeResult['failure'];
  /** Запуск объявленного gate: ID, фаза, SHA, cwd, argv, отчёт и его digest. */
  gate?: ProbeGateRun;
  /** Журнал controller, где записан запуск (у gate — собственный файл). */
  log?: string;
  /** Код процесса; `null` — неизвестен (таймаут, отмена, не запускался). */
  exitCode?: number | null;
  /** Подтверждённый старт; нет у записей alpha.6 и ранее. */
  started?: boolean;
  /** Вызов reviewer, которому принадлежит запуск. */
  scope?: ProbeResult['scope'];
  /** Пояснение controller (ограничено). */
  note?: string;
}

/** Запись журнала с выводом команды — вход итога `inspection`. */
export interface ProbeJournalRecord extends ProbeRecord {
  stdout?: string;
  stderr?: string;
}

/** Журнал проверок вызова reviewer, как его читает controller. */
export interface ProbeJournal {
  /** Строки исхода в порядке журнала; повтор одного runId — одна запись (первая). */
  records: ProbeJournalRecord[];
  /** Строки, не являющиеся ни исходом, ни учётом бюджета: битый JSON, `{}`, чужая форма. */
  invalid: number;
  /** Резервы без строки исхода: учёт бюджета и recovery, не запуски. */
  reservations: { runId: string; abandoned: boolean }[];
}

const NOTE_LIMIT = 2000;
/** Статусы исхода probe; иной статус — диагностика, а не исход. */
export const probeStatuses: ReadonlySet<string> = new Set<ProbeResult['status']>([
  'passed',
  'failed',
  'timeout',
  'budget-exhausted',
  'error',
  'rejected',
  'cancelled',
]);
const text = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * Журнал проверок reviewer: по записи на запуск. Нечитаемая строка, объект
 * без формы исхода (`runId`, `argv`, `status`) и строки резерва/списания —
 * не запуски; они не роняют чтение остальных строк.
 */
export async function readProbeJournal(log: string): Promise<ProbeJournal> {
  const content = await readFile(log, 'utf8').catch(() => '');
  const records: ProbeJournalRecord[] = [];
  const seen = new Set<string>();
  const starts = new Map<string, boolean>();
  let invalid = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let p: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('not an object');
      p = parsed as Record<string, unknown>;
    } catch {
      invalid++;
      continue;
    }
    const runId = text(p.runId);
    // Строки резерва и списания — учёт бюджета, а не запуски.
    if (p.type !== undefined) {
      if (runId && p.type === 'start' && !starts.has(runId)) starts.set(runId, false);
      else if (runId && p.type === 'abandoned') starts.set(runId, true);
      else invalid++;
      continue;
    }
    const argv =
      Array.isArray(p.argv) && p.argv.every((a) => typeof a === 'string') ? p.argv : undefined;
    const status = text(p.status);
    if (!runId || !argv || !status) {
      invalid++;
      continue;
    }
    // Повтор runId — одна запись; запись с неизвестным статусом runId не
    // занимает: следующий валидный исход того же запуска сохраняется.
    if (seen.has(runId)) continue;
    if (probeStatuses.has(status)) seen.add(runId);
    const exitCode =
      p.exitCode === null || Number.isInteger(p.exitCode)
        ? (p.exitCode as number | null)
        : undefined;
    records.push({
      runId,
      argv,
      status: status as ProbeResult['status'],
      durationMs: Number(p.durationMs) || 0,
      limitMs: Number(p.limitMs) || 0,
      ...(p.failure === 'environment' || p.failure === 'report' ? { failure: p.failure } : {}),
      ...(p.gate && typeof p.gate === 'object' ? { gate: p.gate as ProbeGateRun } : {}),
      ...(text(p.log) ? { log: text(p.log) } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(typeof p.started === 'boolean' ? { started: p.started } : {}),
      ...(p.scope && typeof p.scope === 'object' ? { scope: p.scope as ProbeResult['scope'] } : {}),
      ...(text(p.note) ? { note: text(p.note) } : {}),
      ...(text(p.stdout) !== undefined ? { stdout: text(p.stdout) } : {}),
      ...(text(p.stderr) !== undefined ? { stderr: text(p.stderr) } : {}),
    });
  }
  const reservations = [...starts]
    .filter(([runId]) => !seen.has(runId))
    .map(([runId, abandoned]) => ({ runId, abandoned }));
  return { records, invalid, reservations };
}

/** Запуск в виде `review.json.probes`: без потоков вывода, пояснение ограничено. */
export function probeRecord(record: ProbeJournalRecord): ProbeRecord {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { stdout, stderr, ...rest } = record;
  return rest.note && rest.note.length > NOTE_LIMIT
    ? { ...rest, note: rest.note.slice(0, NOTE_LIMIT) + '…' }
    : rest;
}

/** Журнал проверок reviewer: по записи на запуск; нечитаемая строка — не запуск. */
export async function probeRecords(log: string): Promise<ProbeRecord[]> {
  return (await readProbeJournal(log)).records.map(probeRecord);
}

/** Переменная окружения с runId проверки: её наследуют все процессы запуска. */
export const probeRunEnv = 'HARNESS_PROBE_RUN';

/**
 * Резерв проверки в журнале до её запуска: строка `start` с runId, резервом и
 * моментом начала, синхронно и с fsync. Возвращает ошибку, если записать не
 * удалось, — тогда проверка не запускается.
 */
export function reserveProbe(
  log: string,
  runId: string,
  reservedMs: number,
  argv: string[],
  gate?: string,
): Error | undefined {
  try {
    mkdirSync(dirname(log), { recursive: true });
    const fd = openSync(log, 'a');
    try {
      writeSync(
        fd,
        JSON.stringify({
          type: 'start',
          runId,
          reservedMs,
          startedAt: new Date().toISOString(),
          pid: process.pid,
          argv,
          ...(gate ? { gate } : {}),
        }) + '\n',
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return undefined;
  } catch (error) {
    return new Error(
      'резерв проверки не записан в журнал controller, проверка не запускалась: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * Расход бюджета проверок по журналу. Завершённый запуск — его фактическая
 * длительность; начатый без строки исхода (controller погиб посреди
 * команды) — весь резерв: время до гибели не меньше нуля и не больше
 * резерва, поэтому засчитывается верхняя граница, никогда не меньше.
 */
export async function probeLedger(log: string) {
  const text = await readFile(log, 'utf8').catch(() => '');
  const starts = new Map<string, { reservedMs: number; startedAt: string; pid?: number }>();
  const ended = new Map<string, number>();
  const abandoned = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const runId = String(p.runId);
    if (p.type === 'start')
      starts.set(runId, {
        reservedMs: Number(p.reservedMs) || 0,
        startedAt: String(p.startedAt),
        ...(typeof p.pid === 'number' ? { pid: p.pid } : {}),
      });
    else if (p.type === 'abandoned') abandoned.set(runId, Number(p.chargedMs) || 0);
    else ended.set(runId, Number(p.durationMs) || 0);
  }
  let spentMs = 0;
  for (const ms of ended.values()) spentMs += ms;
  const unfinished: { runId: string; reservedMs: number; startedAt: string; pid?: number }[] = [];
  for (const [runId, start] of starts) {
    if (ended.has(runId)) continue;
    spentMs += Math.max(start.reservedMs, abandoned.get(runId) ?? 0);
    if (!abandoned.has(runId)) unfinished.push({ runId, ...start });
  }
  return { spentMs, unfinished };
}

/** Процессы с меткой запуска проверки и их группы (кроме своей). */
async function probeProcesses(runId: string): Promise<{ pid: number; pgid: number }[]> {
  const needle = `${probeRunEnv}=${runId}`;
  const own = process.pid;
  if (process.platform === 'linux') {
    const { readdirSync, readFileSync } = await import('node:fs');
    return readdirSync('/proc').flatMap((entry) => {
      if (!/^\d+$/.test(entry) || Number(entry) === own) return [];
      try {
        if (!readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(needle)) return [];
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return [{ pid: Number(entry), pgid: Number(fields[2]) }];
      } catch {
        return [];
      }
    });
  }
  const stdout = await new Promise<string>((resolve) =>
    execFile(
      'ps',
      ['-Eww', '-ax', '-o', 'pid=,pgid=,command='],
      { encoding: 'utf8', maxBuffer: 64_000_000, timeout: 10000 },
      (error, out) => resolve(error ? '' : out),
    ),
  );
  return stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m && m[3]!.includes(needle) && Number(m[1]) !== own
      ? [{ pid: Number(m[1]), pgid: Number(m[2]) }]
      : [];
  });
}

/**
 * Восстановление журнала проверок после гибели controller: процессы
 * незавершённых запусков останавливаются (по метке и их группам), запуск
 * списывается строкой `abandoned` на весь резерв, и возвращается расход.
 * Строка исхода, пришедшая позже, заменяет списание фактической
 * длительностью — двойного счёта нет.
 */
export async function recoverProbeLog(log: string) {
  const ledger = await probeLedger(log);
  if (!ledger.unfinished.length) return { ...ledger, killed: [] as number[] };
  const ownGroup = process.pid;
  const killed: number[] = [];
  for (const run of ledger.unfinished) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const found = await probeProcesses(run.runId);
      if (!found.length) break;
      for (const { pid, pgid } of found) {
        killed.push(pid);
        for (const target of [pid, pgid > 1 && pgid !== ownGroup ? -pgid : 0])
          if (target)
            try {
              process.kill(target, 'SIGKILL');
            } catch {
              /* уже завершён */
            }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await appendFile(
      log,
      JSON.stringify({
        type: 'abandoned',
        runId: run.runId,
        chargedMs: run.reservedMs,
        at: new Date().toISOString(),
        reason: 'controller завершился до исхода проверки: засчитан весь резерв',
      }) + '\n',
    );
  }
  return { ...ledger, killed: [...new Set(killed)] };
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
    // Отказ среды (EPERM рецепта отчёта, песочница) — не запуск проверяемого
    // кода: на нём наблюдение не ставится.
    const ran =
      !!cited &&
      cited.started !== false &&
      ['passed', 'failed', 'timeout'].includes(cited.status) &&
      cited.failure !== 'environment';
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
