/**
 * Безопасная выжимка провала gate (0.1.0-alpha.68): имена упавших тестов,
 * строка утверждения или ошибки и хвост вывода с маской секретов. Её видят
 * evidence (`failureSummary`), `harness gates`, explain и подсказка следующей
 * попытки — и тогда, когда обёртка gate печатает только «gate failed (details
 * withheld)».
 *
 * Источники по убыванию точности: отчёт JUnit gate (без общих провалов
 * обёртки без своей причины), упавшие тесты вывода (`node --test` spec, TAP),
 * JUnit-файлы, которые команда gate пишет сама (`--test-reporter-destination=
 * …xml` и подобные пути в argv, внутри дерева, записанные этим запуском).
 * Нет ни имени теста, ни строки ошибки, а вывод говорит, что подробности
 * скрыты (или в нём не больше двух строк), — вывод скрыт (`withheld`): gate
 * должен печатать безопасную выжимку сам.
 */

import { constants, existsSync } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { GateFailureSummary } from '../contracts/index.ts';
import { assertionMarkers, failedBlocks } from './process-list.ts';

/** Пределы выжимки. */
export const SUMMARY_TESTS = 20;
export const SUMMARY_TEST_NAME = 200;
export const SUMMARY_ASSERTION = 300;
export const SUMMARY_TAIL = 1200;
const TAIL_LINES = 12;
/** Отчёт команды больше этого не читается. */
const REPORT_BYTES = 5 * 1024 * 1024;

/** Упавший testcase (как `junitFailures`): имя и текст. */
export interface FailedCase {
  testcase: string;
  message: string;
  body: string;
}

const clip = (text: string, limit: number) =>
  text.length > limit ? text.slice(0, limit - 1) + '…' : text;

/** Строка ошибки: утверждение, исключение, код системной ошибки, таймаут. */
const errorLines = [
  ...assertionMarkers,
  /\b[A-Z]\w*(?:Error|Exception)\b/,
  /\berrors?\b/i,
  /\bE[A-Z]{3,}\b/,
  /\btimed out\b|\btimeout\b/i,
  /\bpanic:/,
  /\b(?:expected|received|actual)\b/i,
  /\bfail(?:ed|ure|s)?\b/i,
];
/**
 * Строка обёртки, которая говорит, что подробности скрыты («gate failed
 * (details withheld)»): причиной она не служит, хотя и содержит «failed».
 */
const withheldPhrase =
  /\b(?:details?|output|reason|cause)s? (?:are |is )?(?:withheld|hidden|suppressed)\b|\(withheld\)/i;
const isErrorLine = (line: string) =>
  !withheldPhrase.test(line) && errorLines.some((r) => r.test(line));

/**
 * Общий провал прогона без своей причины, который обёртка gate дописывает в
 * отчёт («Gate execution failed», «Tests failed»): одна короткая строка о
 * провале без ошибки, утверждения и кода. Имени упавшего теста он не даёт.
 */
export function opaqueFailure(text: string) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== 1 || lines[0]!.length > 80) return false;
  const line = lines[0]!;
  return (
    /\bfail(?:ed|ure)\b/i.test(line) &&
    !errorLines.some((r) => !/fail/.test(r.source) && r.test(line))
  );
}

/** Первая строка ошибки текста (без пустых), обрезанная. */
function firstError(text: string) {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && isErrorLine(l));
  return line ? clip(line, SUMMARY_ASSERTION) : undefined;
}

/** Имя упавшего теста по первой строке блока spec/TAP. */
function blockName(block: string) {
  const first = block.split('\n')[0]!.trim();
  return clip(
    first
      .replace(/^not ok\s+\d+\s*(?:-\s*)?/, '')
      .replace(/^✖\s+/, '')
      .replace(/\s+\(\d+(?:\.\d+)?m?s\)\s*$/, '')
      .replace(/\s+#\s+(?:SKIP|TODO)\b.*$/i, '')
      .trim(),
    SUMMARY_TEST_NAME,
  );
}

/** Хвост вывода: последние содержательные строки обоих потоков, маска до обрезки. */
export function maskedTail(
  stdout: string,
  stderr: string,
  redact: (value: string) => string,
  limit = SUMMARY_TAIL,
) {
  const lines = (stdout + '\n' + stderr)
    .split('\n')
    .map((l) => redact(l.replace(ansiEscape, '')).trimEnd())
    .filter((l) => l.trim())
    .slice(-TAIL_LINES)
    .map((l) => clip(l, 200));
  const text = lines.join('\n');
  return text.length > limit ? '…' + text.slice(-(limit - 1)) : text;
}

const ansiEscape = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Выжимка провала. `junit` — упавшие testcases отчёта gate, `reports` —
 * отчётов, которые команда записала сама; `output` — stdout и stderr (уже с
 * маской, `redact` применяется ещё раз).
 */
export function failureSummary(input: {
  junit?: FailedCase[];
  reports?: FailedCase[];
  stdout: string;
  stderr: string;
  redact: (value: string) => string;
}): GateFailureSummary {
  const { redact } = input;
  const output = input.stdout + '\n' + input.stderr;
  const text = (f: FailedCase) => `${f.message}\n${f.body}`;
  const named = (input.junit ?? []).filter((f) => !opaqueFailure(text(f)));
  const blocks = failedBlocks(output)?.tests ?? [];
  const reports = (input.reports ?? []).filter((f) => !opaqueFailure(text(f)));
  let source: GateFailureSummary['source'];
  let tests: string[] = [];
  let assertion: string | undefined;
  if (named.length) {
    source = 'junit';
    tests = named.map((f) => f.testcase);
    assertion = named.map((f) => firstError(text(f)) ?? f.message.trim()).find(Boolean);
  } else if (blocks.length) {
    source = 'output';
    tests = blocks.map(blockName).filter(Boolean);
    assertion = blocks.map((b) => firstError(b.split('\n').slice(1).join('\n'))).find(Boolean);
  } else if (reports.length) {
    source = 'command-report';
    tests = reports.map((f) => f.testcase);
    assertion = reports.map((f) => firstError(text(f)) ?? f.message.trim()).find(Boolean);
  }
  assertion ??= firstError(output);
  const tail = maskedTail(input.stdout, input.stderr, redact);
  const unique = [...new Set(tests.map((t) => clip(redact(t), SUMMARY_TEST_NAME)))];
  return {
    ...(unique.length ? { tests: unique.slice(0, SUMMARY_TESTS) } : {}),
    ...(unique.length > SUMMARY_TESTS ? { testsTruncated: true as const } : {}),
    ...(assertion ? { assertion: clip(redact(assertion), SUMMARY_ASSERTION) } : {}),
    ...(tail ? { tail } : {}),
    ...(source ? { source } : {}),
    ...(!unique.length && !assertion && (withheldPhrase.test(output) || meaningful(output) <= 2)
      ? { withheld: true as const }
      : {}),
  };
}

/** Непустые строки вывода. */
const meaningful = (output: string) => output.split('\n').filter((l) => l.trim()).length;

/** Флаги, значение которых — путь отчёта JUnit (`--flag=path.xml` или `--flag path.xml`). */
const reportFlag =
  /^--?(?:test-reporter-destination|reporter-options|outputFile(?:\.junit)?|output-file|junit[\w-]*|report[\w-]*|xml[\w-]*)$/i;

/**
 * JUnit-файлы, которые команда gate пишет сама: пути `*.xml` из argv
 * (`--test-reporter-destination=x.xml`, `--outputFile x.xml`, `mocha-file=x.xml`),
 * внутри дерева, кроме отчёта gate. Читаются только записанные этим запуском
 * (`since`) обычные файлы до 5 МБ; отказ чтения — пустой список.
 *
 * Граница — без ссылок на всём пути: отчёт открывается по компонентам от
 * настоящего корня дерева (`readReportFile`), ни родитель, ни сам отчёт
 * ссылкой не бывают (и ссылка внутрь дерева тоже), у отчёта ровно одно имя
 * (`nlink` 1). Тип, размер и время берутся `fstat` открытого дескриптора, и
 * читается не больше предела из него.
 */
export async function commandReports(
  argv: readonly string[],
  cwd: string,
  root: string,
  since: number,
  exclude?: string,
): Promise<{ path: string; xml: string }[]> {
  const paths = new Set<string>();
  argv.forEach((arg, i) => {
    const eq = /^(--?[\w.-]+)=(.+)$/.exec(arg);
    const value = eq
      ? /(?:^|[,=])([^,=]+\.xml)$/i.exec(eq[2]!)?.[1]
      : i > 0 && reportFlag.test(argv[i - 1]!) && /\.xml$/i.test(arg)
        ? arg
        : undefined;
    if (value) paths.add(value);
  });
  const out: { path: string; xml: string }[] = [];
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return out;
  }
  for (const p of paths) {
    const full = resolve(cwd, p);
    if (full !== root && !full.startsWith(root + sep)) continue;
    if (exclude && full === exclude) continue;
    const xml = await readReportFile(full, root, realRoot, since).catch(() => undefined);
    if (xml === undefined) continue;
    out.push({ path: relative(root, full), xml });
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Шаги чтения отчёта для теста гонки: вызывается после открытия каталога
 * (`directory`) и после открытия самого отчёта до сверки (`file`) с путём
 * компонента. Только для тестов.
 */
export const reportReadHooks: { step?: (stage: 'directory' | 'file', path: string) => void } = {};

/** Каталог дескрипторов процесса, через который путь открывается от дескриптора каталога. */
const FD_DIR = '/proc/self/fd';
const fdWalk = process.platform === 'linux' && existsSync(FD_DIR);

const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
  a.dev === b.dev && a.ino === b.ino;

/**
 * Отчёт команды по пути `full` внутри `root` (настоящий корень — `realRoot`)
 * или undefined: ссылка на любом компоненте пути, не обычный файл, у файла
 * больше одного имени (жёсткая ссылка), больше предела, старее запуска.
 *
 * Обход по компонентам: дескриптор настоящего корня, затем каждый каталог
 * открывается `O_DIRECTORY | O_NOFOLLOW`, отчёт — `O_NOFOLLOW | O_NONBLOCK`.
 * - Linux (`/proc/self/fd`): компонент открывается относительно дескриптора
 *   предыдущего каталога (`/proc/self/fd/<fd>/<имя>` — тот же каталог, что
 *   открыт, как у `openat`). Подмена родителя ссылкой после его открытия на
 *   обход не влияет: без гонки, каждое имя проверено `O_NOFOLLOW` в каталоге,
 *   который уже открыт внутри дерева.
 * - Иначе (macOS — `/dev/fd/<fd>/<имя>` там не обходится): компонент
 *   открывается полным путём от настоящего корня с `O_NOFOLLOW`; после
 *   открытия отчёта сверка: каждый префикс по `lstat` — каталог, не ссылка, с
 *   тем же устройством и inode, что его открытый дескриптор, а путь отчёта по
 *   `lstat` — тот же файл, что открыт, и у него одно имя. Подмена родителя,
 *   которая держится на любом из этих вызовов, отклоняется; подмена, снятая до
 *   сверки, — тоже: открытый чужой файл не совпадёт с файлом по пути, а
 *   внести его в дерево вторым именем нельзя (`nlink` 1), переносом — только
 *   с правом записи в его каталог вне дерева. Остаётся окно: процесс, который
 *   переключает родителя между отдельными вызовами сверки с точностью до
 *   вызова. Отчёт читается после остановки процессов gate, так что такой
 *   процесс — только уцелевший потомок.
 */
async function readReportFile(full: string, root: string, realRoot: string, since: number) {
  const parts = relative(root, full).split(sep);
  if (!parts.length || parts.some((p) => !p || p === '.' || p === '..')) return undefined;
  const handles: FileHandle[] = [];
  const opened = (h: FileHandle) => (handles.push(h), h);
  try {
    let dir = opened(await open(realRoot, constants.O_RDONLY | constants.O_DIRECTORY));
    const dirs: { path: string; id: { dev: number; ino: number } }[] = [];
    let path = realRoot;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      path = join(path, parts[i]!);
      const target = fdWalk ? `${FD_DIR}/${dir.fd}/${parts[i]}` : path;
      const handle = opened(
        await open(
          target,
          constants.O_RDONLY |
            constants.O_NOFOLLOW |
            (last ? constants.O_NONBLOCK : constants.O_DIRECTORY),
        ),
      );
      reportReadHooks.step?.(last ? 'file' : 'directory', path);
      if (last) break;
      const st = await handle.stat();
      if (!st.isDirectory()) return undefined;
      dirs.push({ path, id: st });
      dir = handle;
    }
    const file = handles.at(-1)!;
    const st = await file.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > REPORT_BYTES || st.mtimeMs < since - 1000)
      return undefined;
    if (!fdWalk) {
      for (const d of dirs) {
        const now = await lstat(d.path);
        if (now.isSymbolicLink() || !now.isDirectory() || !same(now, d.id)) return undefined;
      }
      const now = await lstat(path);
      if (now.isSymbolicLink() || !same(now, st) || now.nlink !== 1) return undefined;
    }
    const buffer = Buffer.alloc(Math.min(st.size, REPORT_BYTES) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    // Файл изменился после fstat (вырос) — не читается.
    if (length > st.size) return undefined;
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await Promise.all(handles.map((h) => h.close().catch(() => undefined)));
  }
}

/** Текст для сообщения отказа, когда gate не назвал причину. */
export const WITHHELD_NOTE =
  'gate не назвал причину провала: в выводе нет ни упавших тестов, ни строки ошибки (например, обёртка gate скрыла подробности). ' +
  'Gate должен печатать безопасную выжимку провала — имена упавших тестов, строку утверждения и хвост вывода с маской секретов; ' +
  'это правка команды gate (ход ведущего), а не кода задачи';

/** Строка выжимки для людей: тесты, утверждение, скрытый вывод. */
export function failureSummaryLine(s: GateFailureSummary) {
  if (s.withheld) return WITHHELD_NOTE;
  return [
    s.tests?.length
      ? `упали ${s.tests.join('; ')}${s.testsTruncated ? ' и другие' : ''}`
      : undefined,
    s.assertion ? `ошибка: ${s.assertion}` : undefined,
  ]
    .filter(Boolean)
    .join('; ');
}
