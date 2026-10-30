import { readFile, writeFile, mkdir, mkdtemp, rm, realpath, lstat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, delimiter, relative, dirname } from 'node:path';
import { accessSync, constants, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  sha256,
  type EvidenceRecord,
  type ExecutionPolicy,
  type GatePolicy,
} from '../contracts/index.ts';
import { command, git } from '../environment/process.ts';
import {
  isolation,
  isolatedCommand,
  isolationSupport,
  protectedChanges,
  protectedSnapshot,
  SandboxPolicyError,
  sandboxDenials,
  watchSandboxLog,
  type Isolation,
  type SandboxViolation,
} from '../environment/isolation.ts';
import { UntrustedCheckoutError } from '../environment/git-trust.ts';
import { TaskFailure, type FailureKind } from '../engine/failure.ts';
import { redactDeep } from '../environment/redaction.ts';
import {
  expectsReference,
  manifestDigest,
  propertyCoverage,
  propertyFailure,
  propertySeed,
  readPropertyReport,
  type CheckManifest,
} from './property.ts';

/** Длинное имя testcase заменяется хешем, а не обрезается: обрезка дала бы ложные совпадения. */
export const TEST_ID_LIMIT = 1000;
export function portableTest<T extends { id: string; opaque?: true }>(test: T): T {
  return test.id.length > TEST_ID_LIMIT
    ? { ...test, id: 'sha256:' + createHash('sha256').update(test.id).digest('hex'), opaque: true }
    : test;
}
/** Предел манифеста: полный список тестов крупного проекта в состояние не кладётся. */
const MANIFEST_LIMIT = 2000;
/**
 * Полный текст провала testcase: атрибут message или содержимое элемента.
 * Первая строка выделяется после redaction: многострочный секрет, обрезанный
 * до первой строки раньше, redactor уже не узнал бы.
 */
function failureText(value: unknown): string {
  const first: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
  if (typeof first === 'string') return entities(first);
  if (first && typeof first === 'object') {
    const node = first as Record<string, unknown>;
    const text = node['@_message'] ?? node['#text'];
    if (typeof text === 'string') return entities(text);
  }
  return '';
}
/**
 * Пять предопределённых сущностей XML. Разбор идёт без обработки сущностей
 * (DOCTYPE запрещён), и сообщение с JSON показывалось как `&quot;`.
 */
const entities = (text: string) =>
  text.replace(
    /&(quot|apos|lt|gt|amp);/g,
    (_m, name: string) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[name]!,
  );
/**
 * Сводка JUnit-отчёта.
 *
 * `redact` применяется к именам и сообщениям до любой обрезки: обрезанный
 * секрет redactor уже не узнаёт, и в сводке оставался бы его префикс. Имя
 * testcase тоже проходит redact — оно попадает в состояние, журнал и API.
 * Изменённое так имя не совпадёт с названным критерием, и подтверждения
 * не будет: для секрета в имени теста это правильный исход.
 */
/**
 * Значение атрибута XML: парсер работает без обработки сущностей (DOCTYPE
 * запрещён, внешних сущностей нет), поэтому предопределённые сущности и
 * числовые ссылки раскрываются здесь — один раз, без рекурсии. Иначе testcase
 * `a["b"]` сохранялся как `a[&quot;b&quot;]` и не совпадал с названным
 * testId требования или критерия. Репортер JUnit Node.js экранирует `"`
 * дважды (`&amp;quot;`); оставшийся после раскрытия `&quot;` поэтому тоже
 * читается как `"`.
 */
export function xmlAttribute(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (all, ref: string) => {
      if (!ref.startsWith('#')) return named[ref] ?? all;
      const code = ref.startsWith('#x') ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    })
    .replace(/&quot;/g, '"');
}

export function junitSummary(
  xml: string,
  redact: (value: string) => string = (value) => value,
): {
  tests: number;
  failures: number;
  skipped: number;
  /** Имена провалившихся testcases: по ним различаются разные провалы. */
  failed: string[];
  /** Те же testcases с первыми словами сообщения о провале. */
  failedDetails: string[];
  /** Что именно выполнилось и с каким исходом. */
  cases: NonNullable<EvidenceRecord['tests']>;
  /** Список обрезан: отсутствие теста по нему доказать нельзя. */
  truncated: boolean;
} {
  if (xml.includes('<!DOCTYPE') || XMLValidator.validate(xml) !== true)
    throw new Error('Некорректный JUnit XML');
  const document: unknown = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
  }).parse(xml);
  const summary = {
    tests: 0,
    failures: 0,
    skipped: 0,
    failed: [] as string[],
    failedDetails: [] as string[],
    cases: [] as NonNullable<EvidenceRecord['tests']>,
    truncated: false,
  };
  function visit(value: unknown, key = '') {
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, key));
      return;
    }
    if (key === 'testcase') {
      summary.tests++;
      if (value && typeof value === 'object') {
        const named = value as Record<string, unknown>;
        const raw = [named['@_classname'], named['@_name']]
          .filter(Boolean)
          .map((v) => xmlAttribute(String(v)))
          .join('.');
        const redacted = redact(raw);
        // Длинное имя заменяется хешем: обрезка дала бы коллизии и ложные
        // совпадения, а без замены receipt не перенёс бы манифест.
        const name = portableTest({ id: redacted }).id;
        const opaque = name !== raw;
        const broken = 'failure' in value || 'error' in value;
        if (broken) {
          summary.failures++;
          if (name && summary.failed.length < 10) {
            summary.failed.push(String(name));
            summary.failedDetails.push(
              [
                String(name),
                redact(failureText(named['failure'] ?? named['error']))
                  .trim()
                  .split('\n')[0],
              ]
                .filter(Boolean)
                .join(': ')
                .slice(0, 200),
            );
          }
        }
        if ('skipped' in value) summary.skipped++;
        if (name) {
          if (summary.cases.length < MANIFEST_LIMIT)
            summary.cases.push({
              id: String(name),
              status: broken ? 'failed' : 'skipped' in value ? 'skipped' : 'passed',
              ...(opaque ? { opaque: true as const } : {}),
            });
          else summary.truncated = true;
        }
      }
      return;
    }
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
  }
  visit(document);
  if (!summary.tests) throw new Error('JUnit не содержит выполненных testcases');
  return summary;
}
const ansiEscape = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** Путь с расширением и координаты, после необязательного префикса `пакет скрипт: `. */
const compilerError =
  /^(?:\S+(?: \S+)?: )?[^\s:]+?\.[A-Za-z][A-Za-z0-9]{0,9}(?:\(\d+,\d+\): |:\d+(?::\d+)?(?:: | - ))(?:fatal )?error(?: [A-Z]+\d+)?:/;
/**
 * Короткая выжимка вывода провалившейся проверки.
 *
 * Полный лог лежит в артефакте, но исполнителю следующей попытки он не
 * доступен, а в отказ попадал только «Код выхода 1». Два разных провала одной
 * проверки выглядели одной причиной — предел одинаковых повторов исчерпывался
 * на несвязанных ошибках, и подсказка повтора не содержала ничего, кроме кода
 * возврата. Берутся последние содержательные строки обоих потоков и первая
 * ошибка компилятора с координатами перед ними: ошибку
 * одни инструменты пишут в stdout, другие в stderr, и одинаковое
 * предупреждение в одном потоке не должно закрывать ошибку в другом. Секреты
 * снимаются тем же redact, что и в логе; объём ограничен.
 */
function diagnostic(stderr: string, stdout: string, redact?: (value: string) => string) {
  // У каждого потока свой бюджет: общий лимит, заполняемый по очереди,
  // позволял нескольким длинным строкам одного потока вытеснить ошибку
  // другого. Redact — до обрезки, иначе префикс секрета остаётся.
  const clip = (line: string) => (line.length > 140 ? line.slice(0, 140) + '…' : line);
  const tail = (text: string) => {
    const lines = text
      .split('\n')
      .map((line) => (redact ? redact(line) : line).trim())
      .filter(Boolean);
    const last = lines.slice(-4);
    const joined = last.map(clip).join(' | ');
    const ending = joined.length > 290 ? '…' + joined.slice(-290) : joined;
    // Компилятор печатает причину раньше итогов package manager, и хвост её
    // вытесняет. Первая ошибка дописывается к хвосту, а не заменяет его: отпечаток
    // отказа различает провалы по хвосту, а распознавание по строке — эвристика.
    // Цвет снимается до redact, иначе обрезка оставит склеенный им префикс секрета.
    // Проверяется обрезанная строка: это ограничивает разбор и гарантирует, что
    // найденное попадёт в итог.
    const cause = text
      .split('\n')
      .map((line) => line.replace(ansiEscape, ''))
      .map((line) => clip((redact ? redact(line) : line).trim()))
      .find((line) => compilerError.test(line));
    const visible = cause && ending.replace(ansiEscape, '').includes(cause.replace(/…$/, ''));
    return cause && !visible ? cause + ' | ' + ending : ending;
  };
  return [tail(stdout), tail(stderr)].filter(Boolean).join(' | ');
}
/** Упавшие testcases с их сообщениями — то, чем провалы отличаются друг от друга. */
function failedCases(counts: ReturnType<typeof junitSummary>) {
  return counts.failedDetails.join('; ').slice(0, 600);
}
/**
 * Песочница отказала до запуска команды: процесс завершился неуспешно, а
 * метка старта, которую обёртка создаёт перед exec, не появилась. Текст
 * stderr признаком не служит — его может напечатать и сама проверка.
 */
export function sandboxNotStarted(result: { code: number }, started: string | undefined) {
  return started !== undefined && result.code !== 0 && !existsSync(started);
}
/** Команда проверки находится — иначе ENOENT, как при обычном запуске. */
function assertExecutable(name: string, path: string | undefined, cwd: string) {
  const candidates = name.includes('/')
    ? [resolve(cwd, name)]
    : (path ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, name));
  if (
    !candidates.some((file) => {
      try {
        accessSync(file, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })
  )
    throw new Error(`spawn ${name} ENOENT`);
}
/** Отчёт внутри worktree, прочитанный без выхода за его границы. */
async function readReport(reportPath: string, cwd: string, redact?: (value: string) => string) {
  const real = await realpath(reportPath);
  if (!real.startsWith((await realpath(cwd)) + sep))
    throw new Error('Report symlink выходит из worktree');
  const xml = await readFile(real, 'utf8');
  return { ...junitSummary(xml, redact), xml };
}
/**
 * Путь отчёта внутри корня, созданный без выхода за него.
 *
 * Раньше каталоги создавались рекурсивно, а граница проверялась потом:
 * symlink внутри worktree успевал увести создание каталога наружу до отказа.
 * Теперь путь проходится от корня по одному компоненту: существующий symlink
 * или не-каталог — отказ до любой записи, недостающий каталог создаётся
 * только внутри уже проверенного родителя.
 */
export async function prepareReportPath(root: string, path: string, escape: string) {
  const base = await realpath(root);
  const target = resolve(base, path);
  if (!target.startsWith(base + sep)) throw new Error(escape);
  let current = base;
  for (const part of relative(base, dirname(target)).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat = await lstat(current).catch(() => undefined);
    if (!stat) {
      await mkdir(current);
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(escape);
  }
  await rm(target, { force: true });
  return target;
}
/**
 * Команда проверки — задачи или общей приёмки workspace — в песочнице ОС.
 *
 * Прежде проверка шла обычным процессом хоста и могла читать базу контура и
 * соседние файлы, писать вне worktree и ходить в сеть: сверка HEAD и
 * отслеживаемых файлов после неё этого не видит. Без механизма песочницы
 * проверка не запускается — снять изоляцию можно только явным
 * isolation.mode: none. Запись — в `write` и собственный scratch (TMPDIR).
 */
export async function runCheck(
  // Нужна только политика изоляции: проверки ревьюера исполняются вне сервера.
  h: { config: Pick<ExecutionPolicy, 'isolation'> },
  options: {
    argv: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    redact?: (value: string) => string;
    timeoutMs?: number;
    signal: AbortSignal;
    write: string[];
    readable: string[];
    controller: string[];
    /** Корни рабочих деревьев вне каталога состояния: закрыты целиком, свои деревья открыты. */
    checkouts?: string[];
    settingsDir: string;
    /**
     * Собрать отказы песочницы из журнала ядра (macOS): по ним, а не по
     * тексту вывода, отказ среды отличается от ошибки кода.
     */
    violations?: boolean;
    /**
     * Запуск проверки подтверждён: без песочницы — порождён её процесс, в
     * песочнице — обёртка создала метку старта перед exec. Запуск самой
     * обёртки песочницы запуском проверки не считается. Вызывается не более
     * одного раза, в том числе когда проверка затем завершилась исключением.
     */
    onStart?: () => void;
  },
) {
  let launched = false;
  const confirm = () => {
    if (launched) return;
    launched = true;
    options.onStart?.();
  };
  let argv = options.argv,
    env = options.env,
    cwd = options.cwd,
    policy: Isolation | undefined,
    started: string | undefined,
    result: Awaited<ReturnType<typeof command>> | undefined,
    monitor: Awaited<ReturnType<typeof watchSandboxLog>>,
    violations: SandboxViolation[] | undefined,
    attempts = 1;
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dc-gate-')));
  // Метка старта — вне TMPDIR команды: проверка, чистящая свой временный
  // каталог, не должна стирать признак того, что она уже начиналась.
  const marks = await realpath(await mkdtemp(join(tmpdir(), 'dc-start-')));
  try {
    if (h.config.isolation.mode === 'os') {
      const support = isolationBackend.check();
      if (!support.ok)
        throw new Error(
          `Изоляция проверок недоступна: ${support.detail}. Установите зависимости или явно задайте isolation.mode: none`,
        );
      // Отсутствующая команда внутри песочницы выглядела бы как «код 127»
      // от обёртки. Причина та же, что и без неё, — называем её так же.
      assertExecutable(argv[0]!, env.PATH, options.cwd);
      policy = isolation({
        write: [...options.write, scratch, marks],
        controller: options.controller,
        readable: options.readable,
        domains: h.config.isolation.domains,
        ...(options.checkouts?.length ? { checkouts: options.checkouts } : {}),
      });
      started = join(marks, 'started');
      // Обязательные запреты записи — для checkout проверки целиком, а не
      // только для её рабочего каталога: gate из подкаталога иначе оставлял
      // корень дерева без них.
      const workdir = await realpath(options.cwd);
      const tag = options.violations ? 'dc' + randomUUID().replace(/-/g, '').slice(0, 16) : '';
      const roots = isolation({ write: options.write, controller: [] }).write.filter(
        (w) => workdir === w || workdir.startsWith(w + sep),
      );
      const wrapped = await isolatedCommand(
        policy,
        argv,
        options.settingsDir,
        scratch,
        started,
        workdir,
        roots.length ? roots : [workdir],
        process.platform,
        tag,
      );
      argv = wrapped.argv;
      env = { ...env, ...wrapped.env };
      cwd = wrapped.cwd;
      if (tag) monitor = await watchSandboxLog(tag);
    }
    const execute = () => {
      // Уже отменённый вызов не запускается: слушатель отмены на отменённом
      // сигнале не срабатывает, и команда шла бы до таймаута.
      if (options.signal.aborted)
        throw Object.assign(new Error('Проверка отменена до запуска'), { name: 'AbortError' });
      return command(argv, cwd, {
        signal: options.signal,
        ...(started === undefined ? { onSpawn: confirm } : {}),
        timeoutMs: options.timeoutMs,
        env,
        redact: options.redact,
        // Отсоединившийся потомок проверки не переживает её: и при успехе,
        // и по таймауту, отмене или падению.
        // Каталоги проверки принадлежат только ей: процесс, запущенный в них
        // во время проверки, — её потомок, даже без метки и родства.
        contain: { dirs: [...options.write, scratch, marks] },
      });
    };
    try {
      result = await execute();
      // sandbox-runtime ищет shell через `which` с таймаутом в секунду и под
      // нагрузкой отказывает до запуска команды. Повтор допустим, только если
      // команда точно не начиналась: метки старта нет.
      for (; attempts < 3 && sandboxNotStarted(result, started); attempts++) {
        await new Promise((r) => setTimeout(r, 500 * attempts));
        result = await execute();
      }
    } finally {
      // Факт старта читается до удаления метки — и при исключении после него.
      if (started !== undefined && existsSync(started)) confirm();
      // Отказы нужны только для разбора провала: успешной проверке ждать
      // записей ядра незачем.
      violations = await monitor?.stop(result && result.code !== 0 ? 400 : 0);
    }
    // Без песочницы завершившийся процесс точно порождался.
    if (started === undefined) confirm();
    return {
      ...result,
      attempts,
      started: launched,
      ...(policy ? { isolation: policy } : {}),
      ...(violations ? { violations } : {}),
    };
  } finally {
    // Наблюдение за журналом не переживает проверку и при исключении.
    if (monitor && violations === undefined) await monitor.stop(0);
    // Каждый каталог убирается независимо: отказ уборки временного каталога
    // проверки (она могла снять с него права) не должен оставлять и метки.
    const removed = await Promise.allSettled([
      checkCleanup.remove(scratch),
      checkCleanup.remove(marks),
    ]);
    const failed = removed.find((r) => r.status === 'rejected');
    if (failed) {
      // Отказ уборки после завершения не стирает исход проверки: код и
      // вывод доступны вызывающему через ошибку (`completedCheck`).
      const error =
        failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));

      throw result
        ? Object.assign(error, {
            [checkResult]: {
              ...result,
              attempts,
              started: launched,
              ...(policy ? { isolation: policy } : {}),
              ...(violations ? { violations } : {}),
            },
          })
        : error;
    }
  }
}
const checkResult = Symbol('runCheck.result');
/** Исход проверки, завершившейся до исключения (например, отказа уборки), если он есть. */
export function completedCheck(error: unknown) {
  return error && typeof error === 'object' && checkResult in error
    ? (error as Record<typeof checkResult, Awaited<ReturnType<typeof runCheck>>>)[checkResult]
    : undefined;
}
/** Уборка каталогов проверки; тест подменяет её, чтобы проверить отказ после исхода. */
export const checkCleanup = {
  remove: (dir: string) => rm(dir, { recursive: true, force: true }),
};
/** Проверка механизма песочницы; тест подменяет её, чтобы проверить отказ. */
export const isolationBackend = { check: isolationSupport };
/**
 * Хосты, в сети к которым проверке, по всей видимости, отказала песочница.
 *
 * Прокси песочницы отвечает на запрещённый домен `403`, но клиенты вроде
 * pnpm показывают только «Forbidden - 403» и URL. На пилоте такой отказ
 * записывался провалом проверки, и контур переписывал код, который был ни
 * при чём. Признак узкий: в выводе есть отказ (403, Forbidden, прокси или
 * тело ответа песочницы) и URL хоста, которого нет в `isolation.domains`.
 */
export function sandboxBlockedHosts(output: string, allowed: string[]) {
  if (
    !/\b403\b|forbidden|denied by sandbox policy|blocked-by-sandbox-runtime|proxy|connect EPERM/i.test(
      output,
    )
  )
    return [];
  const hosts = new Set<string>();
  for (const m of output.matchAll(/\bhttps?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi))
    hosts.add(m[1]!.toLowerCase());
  return [...hosts].filter(
    (host) =>
      host !== '127.0.0.1' &&
      !allowed.some((d) => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase())),
  );
}

/**
 * Окружение свежести test gate: те же переменные у gate движка и у gate,
 * запущенного проверкой reviewer, — иначе probe мог бы прочитать cache там,
 * где gate исполняет тесты заново.
 */
/**
 * Переменная пути отчёта свойств. Ту же и только её выставляет и probe
 * reviewer (путь — в его scratch): проверка видит одно имя в обоих запусках.
 */
export const propertyReportEnv = 'DEVCONTOUR_PROPERTY_REPORT';

export function freshnessEnv(kind: GatePolicy['kind'], env: NodeJS.ProcessEnv) {
  return kind === 'test'
    ? { TURBO_FORCE: 'true', GOFLAGS: [env.GOFLAGS, '-count=1'].filter(Boolean).join(' ') }
    : ({} as Record<string, string>);
}

/**
 * Граница проверки: закрытое (состояние controller, исходные checkout),
 * открытое внутри него и корни рабочих деревьев вне каталога состояния,
 * закрытые целиком (свои деревья проверки открыты).
 */
export interface Boundary {
  hidden: string[];
  readable: string[];
  checkouts?: string[];
}

/** Что нужно для запуска gate попытки. */
export interface GateRun {
  policy: Pick<ExecutionPolicy, 'isolation'>;
  /** Запись evidence под fencing попытки. */
  record: (evidence: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>) => EvidenceRecord;
  cwd: string;
  sha: string;
  phase: EvidenceRecord['phase'];
  gate: GatePolicy;
  artifactDir: string;
  signal: AbortSignal;
  /** Окружение фазы: переменные и маска секретов. */
  execution: { env: NodeJS.ProcessEnv; redact: (value: string) => string };
  /** Закрытое проверке (состояние controller, чужие checkout) и открытое внутри него. */
  boundary: Boundary;
  /** Проверка потребителя: evidence несёт его компонент и не закрывает собственные gates. */
  consumer?: string;
  /** Повтор провала: ID записи, которую повторяет запуск; исход пишется в `recheck`. */
  recheck?: string;
  /**
   * Генеративный gate (`gate.property`): попытка, от которой seed, и
   * ожидаемая проверка поручения. Без `expected` — прежний уровень (отчёт
   * сверяется сам с собой и с JUnit).
   */
  property?: {
    runId: string;
    expected?: CheckManifest;
    /** Закреплённый корпус попытки: материализуется вне worktree только для чтения. */
    corpus?: { digest: string; content: string };
    /** Контракты поручения по digest и их закреплённые файлы. */
    contracts: Record<string, string>;
    artifacts: { path: string; blob: string }[];
  };
}

/**
 * Gate попытки. `test` принимается только по свежему (прежний отчёт удалён до
 * запуска) непустому JUnit без failures, errors и skips на этом SHA; exit 0
 * без отчёта — отказ. Gate, изменивший HEAD или отслеживаемые файлы, не
 * проходит. Evidence записывается при любом исходе; провал — `TaskFailure`.
 */
export async function runGate(run: GateRun): Promise<EvidenceRecord> {
  const { cwd, sha, phase, gate, artifactDir, signal } = run;
  const redact = run.execution.redact;
  // У проверки потребителя дерево — его голова, а `sha` — интегрированный
  // результат провайдера: неизменной обязана остаться голова потребителя.
  const expectedHead = run.consumer ? await git(cwd, 'rev-parse', 'HEAD') : sha;
  const root = await realpath(cwd);
  const gateCwd = gate.cwd ? await realpath(resolve(cwd, gate.cwd)) : root;
  if (gateCwd !== root && !gateCwd.startsWith(root + sep))
    throw new Error('Gate cwd выходит из worktree');
  const reportPath = gate.report
    ? await prepareReportPath(cwd, gate.report.path, 'Report выходит из worktree')
    : undefined;
  // Генеративная проверка: seed задаёт controller, поэтому он известен и
  // тогда, когда проверка зависла и не успела ничего записать. Отчёт свойств
  // лежит в каталоге controller вне worktree: проверка пишет внутрь него, но
  // заменить сам каталог на ссылку наружу не может.
  // Эталонная проверка поручения отчитывается тем же отчётом свойств и
  // получает его путь и селектор и у gate без генератора.
  const property =
    run.property && (gate.property || expectsReference(run.property.expected))
      ? run.property
      : undefined;
  const reference = expectsReference(run.property?.expected);
  const label = !gate.property
    ? 'Проверка по эталонным наборам'
    : reference
      ? 'Проверка свойств и эталонных наборов'
      : 'Генеративная проверка';
  const propertyDir = property
    ? await realpath(await mkdtemp(join(tmpdir(), 'harness-property-')))
    : undefined;
  const propertyPath = propertyDir ? join(propertyDir, 'report.json') : undefined;
  const seed = property ? propertySeed(property.runId, phase, gate.id) : 0;
  const expected = property?.expected;
  // Корпус закреплён за попыткой при выдаче: его случаи материализуются из
  // закреплённых байтов в каталоге controller вне worktree, только для чтения.
  const corpus = expected?.corpus && property?.corpus ? property.corpus : undefined;
  const corpusDir = corpus
    ? await realpath(await mkdtemp(join(tmpdir(), 'harness-corpus-')))
    : undefined;
  const corpusPath = corpusDir ? join(corpusDir, 'corpus.json') : undefined;
  if (corpusPath) {
    await writeFile(corpusPath, corpus!.content);
    await chmod(corpusPath, 0o444);
  }
  const propertyEnv: Record<string, string> = propertyPath
    ? {
        DEVCONTOUR_SEED: String(seed),
        [propertyReportEnv]: propertyPath,
        ...(expected
          ? { DEVCONTOUR_PROPERTIES: expected.properties.map((p) => p.id).join(',') }
          : {}),
        ...(corpusPath ? { DEVCONTOUR_CORPUS: corpusPath } : {}),
      }
    : {};
  // Test gate исполняет тесты заново, через какую бы обёртку (package
  // script, task runner) ни шла команда: Turbo не читает cache (`TURBO_FORCE`),
  // Go не берёт результат из кэша тестов (`-count=1` в GOFLAGS, последним).
  // Восстановленный из cache зелёный отчёт иначе выглядел бы свежим.
  const freshness = freshnessEnv(gate.kind, run.execution.env);
  let kind: FailureKind = 'gate';
  // Заголовок лога — фактические каталог и argv запуска: digest лога входит в
  // evidence, и запись называет, где и чем проверка исполнялась.
  let passed = false,
    summary = '',
    log = `# harness gate ${gate.id}: cwd=${relative(root, gateCwd) || '.'} argv=${JSON.stringify(gate.command.map(redact))}${gate.kind === 'test' ? ` fresh=${redact(JSON.stringify(freshness))}` : ''}\n`,
    exitCode = -1,
    manifest: ReturnType<typeof junitSummary> | undefined;
  try {
    // Снимок защищённых путей до проверки: запреты песочницы видят только
    // путь операции, перенос готового каталога ими не закрыт.
    const before = run.policy.isolation.mode === 'os' ? protectedSnapshot(root) : undefined;
    const result = await runCheck(
      { config: run.policy },
      {
        argv: gate.command,
        cwd: gateCwd,
        env: {
          ...run.execution.env,
          ...freshness,
          ...(reportPath
            ? { DEVCONTOUR_REPORT_PATH: reportPath, HARNESS_REPORT_PATH: reportPath }
            : {}),
          ...propertyEnv,
          ...Object.fromEntries(
            Object.entries(propertyEnv).map(([k, v]) => [k.replace(/^DEVCONTOUR_/, 'HARNESS_'), v]),
          ),
        },
        redact,
        timeoutMs: gate.timeoutMs,
        signal,
        write: [cwd, ...(propertyDir ? [propertyDir] : [])],
        readable: [...run.boundary.readable, ...(corpusDir ? [corpusDir] : [])],
        controller: run.boundary.hidden,
        ...(run.boundary.checkouts?.length ? { checkouts: run.boundary.checkouts } : {}),
        settingsDir: join(artifactDir, gate.id),
        violations: true,
      },
    );
    exitCode = result.code;
    log += result.stdout + '\n' + result.stderr;
    // Путь, который после проверки не прочитать, проверка и закрыла: это
    // нарушение области, а не отказ среды (снимок до проверки прочитался).
    let planted: string[] = [];
    try {
      if (before) planted = protectedChanges(before, root);
    } catch (error) {
      if (error instanceof SandboxPolicyError) kind = 'scope-violation';
      throw error instanceof SandboxPolicyError ? new Error(error.message) : error;
    }
    if (planted.length) {
      kind = 'scope-violation';
      throw new Error(
        'проверка создала или изменила защищённые пути (конфигурация IDE, shell, git или Claude): ' +
          planted
            .slice(0, 5)
            .map((p) => relative(root, p))
            .join(', ') +
          (planted.length > 5 ? ` и ещё ${planted.length - 5}` : ''),
      );
    }
    if (result.timedOut || signal.aborted)
      throw new Error('Проверка прервана или превысила timeout');
    if (result.code !== 0) {
      // Сохраняем валидный отчёт и при отказе команды, до классификации
      // песочницы: после очистки worktree иначе остаётся только хвост лога.
      const counts = reportPath
        ? await readReport(reportPath, cwd, redact).catch(() => undefined)
        : undefined;
      if (counts) {
        manifest = counts;
        await mkdir(artifactDir, { recursive: true });
        await writeFile(join(artifactDir, `${gate.id}.xml`), redact(counts.xml));
      }
      const blocked =
        run.policy.isolation.mode === 'os'
          ? sandboxBlockedHosts(result.stdout + '\n' + result.stderr, run.policy.isolation.domains)
          : [];
      if (blocked.length) {
        kind = 'environment';
        throw new Error(
          `песочница проверки закрыла сеть к ${blocked.join(', ')}: этих доменов нет в isolation.domains. ` +
            `Код выхода ${result.code}: ${diagnostic(result.stderr, result.stdout, redact)}`,
        );
      }
      // Отказ файловой песочницы — отказ среды: правка кода его не снимет,
      // а класс gate сжигал бы бюджет ремонтов.
      const denied =
        result.isolation && result.violations
          ? sandboxDenials(
              result.violations,
              result.isolation,
              result.stdout + '\n' + result.stderr,
              gateCwd,
            )
          : [];
      if (denied.length) {
        kind = 'environment';
        throw new Error(
          `песочница проверки отказала в доступе: ` +
            denied
              .slice(0, 3)
              .map(
                (d) =>
                  `${relative(root, d.path).startsWith('..') ? d.path : relative(root, d.path)} — ${d.rule}`,
              )
              .join('; ') +
            (denied.length > 3 ? ` и ещё ${denied.length - 3}` : '') +
            `. Код выхода ${result.code}: ${diagnostic(result.stderr, result.stdout, redact)}`,
        );
      }
      throw new Error(
        [
          `Код выхода ${result.code}`,
          counts?.failures ? `упали ${failedCases(counts)}` : '',
          diagnostic(result.stderr, result.stdout, redact),
        ]
          .filter(Boolean)
          .join(': '),
      );
    }
    if (reportPath) {
      const counts = (manifest = await readReport(reportPath, cwd, redact));
      summary = `${counts.tests} tests, ${counts.failures} failures, ${counts.skipped} skipped`;
      if (counts.failures || counts.skipped)
        throw new Error(summary + (counts.failures ? `: ${failedCases(counts)}` : ''));
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, `${gate.id}.xml`), redact(counts.xml));
    } else summary = 'Команда завершилась успешно';
    if ((await git(cwd, 'rev-parse', 'HEAD')) !== expectedHead)
      throw new Error('Gate изменил HEAD');
    if (await git(cwd, 'status', '--porcelain', '--untracked-files=no'))
      throw new Error('Gate изменил отслеживаемые файлы');
    passed = true;
  } catch (error) {
    // Сборка политики не удалась — отказ среды; checkout, который увёл бы
    // git хоста в чужую конфигурацию, — нарушение области.
    if (error instanceof SandboxPolicyError) kind = 'environment';
    if (error instanceof UntrustedCheckoutError) kind = 'scope-violation';
    const message = error instanceof Error ? error.message : String(error);
    summary = redact(message);
    log += '\n' + summary;
  }
  // Отчёт свойств читается при любом исходе: провал и таймаут — ровно те
  // случаи, когда контрпример и вход нужны больше всего.
  let propertyEvidence: EvidenceRecord['property'];
  if (property && propertyPath) {
    const read = await readPropertyReport(propertyPath, propertyDir!, redact);
    // Уборка каталога — не повод потерять evidence: проверка могла снять с
    // него права. Права возвращаются; если убрать всё же не удалось, это
    // отказ gate с причиной, а не исключение до записи доказательства.
    let cleanup: string | undefined;
    try {
      await rm(propertyDir!, { recursive: true, force: true });
    } catch {
      try {
        await chmod(propertyDir!, 0o700);
        await rm(propertyDir!, { recursive: true, force: true });
      } catch (error) {
        cleanup =
          'каталог отчёта свойств не убран: ' +
          redact(error instanceof Error ? error.message : String(error));
      }
    }
    const join2 = (text: string) =>
      summary && summary !== 'Команда завершилась успешно' ? `${summary}; ${text}` : text;
    if (cleanup) {
      passed = false;
      summary = join2(cleanup);
    }
    // Корпус исполнялся из закреплённых байтов: проверка без песочницы могла
    // бы их переписать, и тогда свидетельство относилось бы к другим случаям.
    if (corpusDir) {
      const intact = await readFile(corpusPath!, 'utf8')
        .then((text) => text === corpus!.content)
        .catch(() => false);
      await chmod(corpusPath!, 0o600).catch(() => undefined);
      await rm(corpusDir, { recursive: true, force: true }).catch(() => undefined);
      if (!intact) {
        passed = false;
        summary = 'Проверка изменила файл закреплённого корпуса';
      }
    }
    const failure = read.report ? propertyFailure(read.report) : '';
    // Покрытие сверяется всегда, когда отчёт прочитан: зелёный код выхода при
    // пустом отчёте, нуле входов или пропущенном свойстве не доказывает
    // объявленного. Провал свойства уже назван — недобор при нём следствие.
    const coverage = read.report
      ? propertyCoverage(
          read.report,
          expected,
          gate.report && manifest
            ? { cases: manifest.cases, truncated: manifest.truncated }
            : undefined,
        )
      : [];
    if (failure) {
      passed = false;
      summary = join2(failure);
    } else if (coverage.length) {
      passed = false;
      summary = join2(`${label} не подтвердила покрытие: ` + coverage.join('; '));
    } else if (passed && read.problem) {
      // Прошедшая команда без отчёта не доказывает свойство: зелёный код
      // выхода был у неё и до реализации.
      passed = false;
      summary = `${label} не отчиталась: ${read.problem}`;
    }
    propertyEvidence = {
      seed,
      reproduce: redact(`DEVCONTOUR_SEED=${seed} ${gate.command.join(' ')}`),
      ...(read.report
        ? { report: redactDeep(read.report, redact) }
        : { problem: redact(read.problem) }),
      ...(cleanup && read.report ? { problem: cleanup } : {}),
      contracts: property.contracts,
      artifacts: property.artifacts,
      level: expected ? 'manifest' : 'legacy',
      ...(expected
        ? {
            manifest: {
              digest: manifestDigest(expected),
              properties: expected.properties.map((p) => p.id),
              ...(expected.corpus
                ? {
                    corpus: { digest: expected.corpus.digest, cases: expected.corpus.cases.length },
                  }
                : {}),
            },
          }
        : {}),
      ...(coverage.length ? { coverage } : {}),
    };
    if (!passed) log += '\n' + summary;
  } else if (corpusDir)
    await rm(corpusDir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(artifactDir, { recursive: true });
  const logPath = join(artifactDir, `${gate.id}.log`);
  log = redact(log);
  await writeFile(logPath, log);
  const evidence = run.record({
    kind: 'test',
    phase,
    sha,
    gate: gate.id,
    passed,
    command: gate.command.map(redact),
    exitCode,
    log: logPath,
    digest: sha256(log),
    summary: redact(summary),
    ...(manifest ? { tests: manifest.cases } : {}),
    ...(manifest?.truncated ? { testsTruncated: true } : {}),
    ...(run.consumer ? { consumer: run.consumer } : {}),
    ...(propertyEvidence ? { property: propertyEvidence } : {}),
    ...(run.recheck
      ? {
          recheck: {
            of: run.recheck,
            outcome: passed ? ('flaky' as const) : ('confirmed' as const),
          },
        }
      : {}),
  });
  if (!passed) {
    // Отказ связывается со свойствами по отчёту проверки, а не по тексту:
    // объявленные поручением — для эпизода восстановления, прочие — для разбора.
    const report = propertyEvidence?.report;
    const failing = [
      ...(report?.properties.filter((p) => p.status === 'failed').map((p) => p.testId) ?? []),
      ...(report?.corpus?.failed.map((c) => c.property) ?? []),
    ];
    const declared = new Set(expected?.properties.map((p) => p.id) ?? []);
    throw new TaskFailure(
      kind,
      `${phase}/${run.consumer ? run.consumer + ':' : ''}${gate.id}: ${evidence.summary}`,
      failing.length
        ? {
            bound: [...new Set(failing.filter((id) => declared.has(id)))],
            unbound: [...new Set(failing.filter((id) => !declared.has(id)))],
          }
        : undefined,
    );
  }
  return evidence;
}
