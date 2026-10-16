import { readFile, writeFile, mkdir, mkdtemp, rm, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, delimiter, relative, dirname } from 'node:path';
import { accessSync, constants, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  sha256,
  type EvidenceRecord,
  type ExecutionPolicy,
  type GatePolicy,
} from '../contracts/index.ts';
import { command, git } from '../environment/process.ts';
import { isolation, isolatedCommand, isolationSupport } from '../environment/isolation.ts';
import { TaskFailure, type FailureKind } from '../engine/failure.ts';

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
        const raw = [named['@_classname'], named['@_name']].filter(Boolean).join('.');
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
/**
 * Короткая выжимка вывода провалившейся проверки.
 *
 * Полный лог лежит в артефакте, но исполнителю следующей попытки он не
 * доступен, а в отказ попадал только «Код выхода 1». Два разных провала одной
 * проверки выглядели одной причиной — предел одинаковых повторов исчерпывался
 * на несвязанных ошибках, и подсказка повтора не содержала ничего, кроме кода
 * возврата. Берутся последние содержательные строки обоих потоков: ошибку
 * одни инструменты пишут в stdout, другие в stderr, и одинаковое
 * предупреждение в одном потоке не должно закрывать ошибку в другом. Секреты
 * снимаются тем же redact, что и в логе; объём ограничен.
 */
function diagnostic(stderr: string, stdout: string, redact?: (value: string) => string) {
  // У каждого потока свой бюджет: общий лимит, заполняемый по очереди,
  // позволял нескольким длинным строкам одного потока вытеснить ошибку
  // другого. Redact — до обрезки, иначе префикс секрета остаётся.
  const tail = (text: string) => {
    const joined = text
      .split('\n')
      .map((line) => (redact ? redact(line) : line).trim())
      .filter(Boolean)
      .slice(-4)
      .map((line) => (line.length > 140 ? line.slice(0, 140) + '…' : line))
      .join(' | ');
    return joined.length > 290 ? '…' + joined.slice(-290) : joined;
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
    settingsDir: string;
  },
) {
  let argv = options.argv,
    env = options.env,
    started: string | undefined;
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
      const policy = isolation({
        write: [...options.write, scratch, marks],
        controller: options.controller,
        readable: options.readable,
        domains: h.config.isolation.domains,
      });
      started = join(marks, 'started');
      const wrapped = await isolatedCommand(policy, argv, options.settingsDir, scratch, started);
      argv = wrapped.argv;
      env = { ...env, ...wrapped.env };
    }
    const execute = () =>
      command(argv, options.cwd, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        env,
        redact: options.redact,
        // Отсоединившийся потомок проверки не переживает её: и при успехе,
        // и по таймауту, отмене или падению.
        // Каталоги проверки принадлежат только ей: процесс, запущенный в них
        // во время проверки, — её потомок, даже без метки и родства.
        contain: { dirs: [...options.write, scratch, marks] },
      });
    let result = await execute(),
      attempts = 1;
    // sandbox-runtime ищет shell через `which` с таймаутом в секунду и под
    // нагрузкой отказывает до запуска команды. Повтор допустим, только если
    // команда точно не начиналась: метки старта нет.
    for (; attempts < 3 && sandboxNotStarted(result, started); attempts++) {
      await new Promise((r) => setTimeout(r, 500 * attempts));
      result = await execute();
    }
    return { ...result, attempts };
  } finally {
    // Каждый каталог убирается независимо: отказ уборки временного каталога
    // проверки (она могла снять с него права) не должен оставлять и метки.
    const removed = await Promise.allSettled([
      rm(scratch, { recursive: true, force: true }),
      rm(marks, { recursive: true, force: true }),
    ]);
    const failed = removed.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
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
  boundary: { hidden: string[]; readable: string[] };
  /** Проверка потребителя: evidence несёт его компонент и не закрывает собственные gates. */
  consumer?: string;
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
  let kind: FailureKind = 'gate';
  let passed = false,
    summary = '',
    log = '',
    exitCode = -1,
    manifest: ReturnType<typeof junitSummary> | undefined;
  try {
    const result = await runCheck(
      { config: run.policy },
      {
        argv: gate.command,
        cwd: gateCwd,
        env: {
          ...run.execution.env,
          ...(reportPath
            ? { DEVCONTOUR_REPORT_PATH: reportPath, HARNESS_REPORT_PATH: reportPath }
            : {}),
        },
        redact,
        timeoutMs: gate.timeoutMs,
        signal,
        write: [cwd],
        readable: run.boundary.readable,
        controller: run.boundary.hidden,
        settingsDir: join(artifactDir, gate.id),
      },
    );
    exitCode = result.code;
    log = result.stdout + '\n' + result.stderr;
    if (result.timedOut || signal.aborted)
      throw new Error('Проверка прервана или превысила timeout');
    if (result.code !== 0) {
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
      const counts = reportPath
        ? await readReport(reportPath, cwd, redact).catch(() => undefined)
        : undefined;
      if (counts) manifest = counts;
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
    const message = error instanceof Error ? error.message : String(error);
    summary = redact(message);
    log += '\n' + summary;
  }
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
  });
  if (!passed)
    throw new TaskFailure(
      kind,
      `${phase}/${run.consumer ? run.consumer + ':' : ''}${gate.id}: ${evidence.summary}`,
    );
  return evidence;
}
