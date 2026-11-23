/**
 * Список процессов внутри песочницы ОС проверок (gate).
 *
 * На macOS `/bin/ps` и `/usr/bin/top` — setuid-программы: ядро не запускает
 * setuid-программу из процесса в песочнице (Seatbelt), даже при профиле
 * `(allow default)`, и `exec` отвечает EPERM («Operation not permitted»,
 * в Node — `spawn EPERM`). `pgrep`/`pkill` не setuid, но песочница
 * sandbox-runtime открывает сведения только о процессах той же песочницы и
 * закрывает службу sysmond: они печатают «Cannot get process list». Ни одно
 * правило Seatbelt и ни один параметр sandbox-runtime этого не открывают.
 *
 * Открыть список процессов проверкам по умолчанию было бы и небезопасно:
 * `ps -E` показывает окружение каждого процесса того же пользователя (хост
 * harness, CLI моделей с токенами API), а код проверки пишет исполнитель.
 * Разрешение «этот gate — вне песочницы» тоже не вводится: что исполняет
 * gate, не ограничено его путями (импорты модулей, `package.json` и скрипты
 * менеджера пакетов, `node_modules`, неотслеживаемые файлы дерева — всё это
 * пишет исполнитель), а вне песочницы проверка читает учётные данные, ходит
 * в сеть и пишет куда угодно. Поэтому harness распознаёт этот отказ, называет
 * его отказом среды с советом и сообщает о нём до попыток (`doctor`, `smoke`).
 */

/** Код отказа gate, запускающего список процессов в песочнице ОС. */
export const GATE_SANDBOX_PROCESS_LIST = 'GATE_SANDBOX_PROCESS_LIST';

/** Что сделать, когда проверке нужен список процессов (`ps`). */
export const PROCESS_LIST_ADVICE =
  'тест не должен требовать список всех процессов хоста: проверяйте свои дочерние процессы по их pid ' +
  '(process.kill(pid, 0)) или по файлам-меткам, которые они пишут, либо вынесите такие тесты из команды gate ' +
  'и запускайте их на хосте; isolation.mode: none снимает песочницу со всех проверок и не рекомендуется';

/** Возможность списка процессов в песочнице проверок на этой машине. */
export interface ProcessListCapability {
  /**
   * `available` — `ps` отработал в песочнице; `unavailable` — песочница его
   * не запустила или он не получил список; `unknown` — проба не исполнилась
   * (песочницы нет, `ps` не найден, отказ запуска); `not-isolated` —
   * проверки идут без песочницы ОС (`isolation.mode: none`).
   */
  status: 'available' | 'unavailable' | 'unknown' | 'not-isolated';
  /** Команда пробы. */
  command?: string[];
  /** Что ответила проба (код и выжимка вывода) или почему её нет. */
  detail: string;
}

/**
 * Последний ответ пробы списка процессов в этом процессе harness (или его
 * нет — проба не исполнялась). Удержание gate по отказу `ps` снимается,
 * когда проба ответила `available`: отказ перестал быть свойством среды.
 */
export const processListSeen: { status?: ProcessListCapability['status'] } = {};

/** Признак отказа списка процессов в выводе проверки. */
export interface ProcessListSignature {
  /** Строка вывода с признаком (обрезана). */
  line: string;
  /** Признак называет программу списка процессов, а не только `spawn EPERM`. */
  named: boolean;
}

const tool = String.raw`(?:\/(?:usr\/)?s?bin\/)?(?:ps|pgrep|pkill|top)`;
/** Признаки, называющие программу: `spawn /bin/ps EPERM`, `/bin/ps: Operation not permitted`. */
const namedSignatures = [
  new RegExp(String.raw`\bspawn(?:Sync)?\s+${tool}\s+EPERM\b`),
  new RegExp(
    String.raw`(?<![\w./-])(?:execvp\(\) of )?['"]?${tool}['"]?(?: failed)?: operation not permitted`,
    'i',
  ),
  /\bCannot get process list\b/,
];
/** `spawn EPERM` без пути: Node так называет синхронный отказ exec (например, `/bin/ps`). */
const bareSpawn = /\bspawn(?:Sync)? EPERM\b/;

/**
 * Признак отказа списка процессов в тексте, или undefined. Признак, который
 * называет программу, сильнее голого `spawn EPERM`.
 */
export function processListSignature(text: string): ProcessListSignature | undefined {
  let bare: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (namedSignatures.some((r) => r.test(line))) return { line: line.slice(0, 200), named: true };
    if (bare === undefined && bareSpawn.test(line)) bare = line.slice(0, 200);
  }
  return bare === undefined ? undefined : { line: bare, named: false };
}

/**
 * Отказ проверки — отказ списка процессов: признак есть в выводе, а если
 * отчёт JUnit назвал упавшие testcases — в тексте каждого из них. Провал
 * теста без признака рядом с ним остаётся провалом gate: признак одного
 * теста не прячет настоящий провал другого.
 */
export function processListFailure(
  output: string,
  failures?: { total: number; texts: string[] },
): ProcessListSignature | undefined {
  if (failures && failures.total > 0) {
    // Не все упавшие testcases прочитаны — доказать признак у каждого нельзя.
    if (failures.texts.length < failures.total) return undefined;
    const found = failures.texts.map(processListSignature);
    if (found.some((s) => !s)) return undefined;
    return found.find((s) => s!.named) ?? found[0];
  }
  // Без отчёта JUnit упавшие тесты читаются по блокам отчёта TAP или spec
  // (`node --test`): заголовки, итоги и упавшие наборы (`subtestsFailed`) —
  // не провалы. Отказ среды — только когда у каждого упавшего теста свой
  // признак и ни у одного нет проваленного утверждения.
  const blocks = failedBlocks(output);
  if (blocks) return blocksFailure(blocks);
  // Другие отчёты: отказ среды — только признак, называющий программу
  // (голый `spawn EPERM` бывает и в предупреждении рядом с настоящим
  // провалом), и ни одного другого признака провала: упавших тестов не
  // больше строк признака, нет проваленных утверждений. Иначе — обычный
  // засчитанный провал gate.
  const signature = processListSignature(output);
  if (!signature?.named) return undefined;
  return otherFailures(output) ? undefined : signature;
}

/** Упавшие тесты отчёта и итог прогона (`# fail N`, `ℹ fail N`). */
export interface FailedBlocks {
  /** Тексты упавших тестов (без упавших наборов). */
  tests: string[];
  /** Упавших тестов вместе с наборами — сверка с итогом прогона. */
  count: number;
  /** Итог прогона, если напечатан. */
  total?: number;
}

/** Упавший набор (его провал — упавшие тесты внутри), а не свой провал. */
const suiteFailure = /failureType:\s*'subtestsFailed'|\b\d+ subtests? failed\b/;
/** Строка TAP упавшего теста. */
const tapFailed = /^\s*not ok\b/;
/** Строка spec упавшего теста и заголовок списка упавших. */
const specFailed = /^\s*✖\s/;
const specHeader = /^\s*✖\s+failing tests:\s*$/;

/**
 * Блоки упавших тестов отчёта TAP или spec, или undefined, если отчёт не
 * такой. В spec упавшие тесты повторяются: в ходе прогона без текста и в
 * списке `✖ failing tests:` с текстом — читается список, если он есть.
 */
export function failedBlocks(output: string): FailedBlocks | undefined {
  const lines = output.split('\n');
  let total: number | undefined;
  for (const l of lines) {
    const m = /^\s*(?:#|ℹ)\s*fail\s+(\d+)\s*$/.exec(l);
    if (m) total = Math.max(total ?? 0, Number(m[1]));
  }
  let start: RegExp;
  let from = 0;
  if (lines.some((l) => tapFailed.test(l))) start = tapFailed;
  else if (lines.some((l) => specFailed.test(l))) {
    start = specFailed;
    const header = lines.findIndex((l) => specHeader.test(l));
    if (header >= 0) from = header + 1;
  } else return undefined;
  const texts: string[] = [];
  let current: string[] | undefined;
  for (const l of lines.slice(from)) {
    if (start.test(l) && !specHeader.test(l)) {
      if (current) texts.push(current.join('\n'));
      current = [l];
    } else current?.push(l);
  }
  if (current) texts.push(current.join('\n'));
  return {
    tests: texts.filter((t) => !suiteFailure.test(t)),
    count: texts.length,
    ...(total === undefined ? {} : { total }),
  };
}

/** Строка признака — сама ошибка запуска, а не другая ошибка теста. */
const otherError = /\b(?:[A-Z]\w*)?Error\b/;
/** Блок называет программу списка процессов: путь, имя строкой, вызов. */
const namesTool = new RegExp(String.raw`(?:^|[\s'"\`(=:])${tool}(?=['"\`\s,)]|$)`, 'm');

/** Признак отказа списка процессов в тексте одного упавшего теста. */
function blockSignature(text: string): ProcessListSignature | undefined {
  const lines = text.split('\n');
  if (lines.some((l) => assertionMarkers.some((r) => r.test(l)))) return undefined;
  const signature = processListSignature(text);
  if (!signature || signature.named) return signature;
  // Асинхронный отказ (`execFile('ps')` → `spawn EPERM` без пути): признак,
  // если текст называет программу или другой ошибки в нём нет.
  if (namesTool.test(text)) return signature;
  const other = lines.some(
    (l) => otherError.test(l) && !bareSpawn.test(l) && !namedSignatures.some((r) => r.test(l)),
  );
  return other ? undefined : signature;
}

function blocksFailure(blocks: FailedBlocks): ProcessListSignature | undefined {
  // Итог прогона называет больше упавших, чем прочитано блоков, — у
  // непрочитанных признак не доказать.
  if (!blocks.tests.length || (blocks.total !== undefined && blocks.total > blocks.count))
    return undefined;
  const found = blocks.tests.map(blockSignature);
  if (found.some((s) => !s)) return undefined;
  return found.find((s) => s!.named) ?? found[0];
}

/** Проваленное утверждение (node:assert, chai, jest/vitest), а не отказ запуска. */
export const assertionMarkers = [
  /\bAssertionError\b/,
  /\bERR_ASSERTION\b/,
  /^\s*(?:Expected|Received)(?: value)?:/,
  /\bexpected\b.+\bto (?:be|equal|deep|have|include|match|throw)/i,
];
/** Строка упавшего теста: TAP `not ok`, `✖`/`✗`/`×`/`●` в начале, jest `FAIL`. */
const failedTestLine = /^\s*(?:not ok\b|[✖✗×●]\s|FAIL\s)/;
/** Итог прогона с числом упавших: `# fail 2`, `ℹ fail 2`, `Tests: 2 failed`, `2 failing`. */
const failedTotals = [
  /^\s*(?:#|ℹ)\s*fail\s+(\d+)/,
  /\bTests?:?\s.*?\b(\d+) failed\b/,
  /^\s*(\d+) (?:failing|failed)\b/,
];

/**
 * В выводе есть провал, который признак списка процессов не объясняет:
 * проваленное утверждение или больше упавших тестов, чем строк признака.
 * Отчёты повторяют упавший тест (список и итог), поэтому строки упавших
 * считаются без повторов, и берётся большее из них и итога прогона.
 */
export function otherFailures(
  output: string,
  signed: (line: string) => boolean = (line) => Boolean(processListSignature(line)?.named),
): boolean {
  const lines = output.split('\n');
  if (lines.some((l) => assertionMarkers.some((r) => r.test(l)))) return true;
  const signatures = new Set(lines.filter(signed).map((l) => l.trim())).size;
  const failedLines = new Set(lines.filter((l) => failedTestLine.test(l)).map((l) => l.trim()))
    .size;
  let total = 0;
  for (const l of lines)
    for (const r of failedTotals) {
      const m = r.exec(l);
      if (m) total = Math.max(total, Number(m[1]));
    }
  return Math.max(total, failedLines) > Math.max(signatures, 1);
}

/** Текст отказа gate для evidence и следующей попытки. */
export function processListMessage(signature: ProcessListSignature, tail: string) {
  return (
    `${GATE_SANDBOX_PROCESS_LIST}: gate запускает ps (список процессов), а в песочнице ОС проверок он недоступен — ` +
    `«${signature.line}». Ядро macOS не запускает setuid-программы (/bin/ps, /usr/bin/top) в песочнице, ` +
    'а pgrep в ней не видит процессов вне песочницы; вызов не из изменения задачи, и его правка этого не снимет. ' +
    `Что сделать: ${PROCESS_LIST_ADVICE}. ${tail}`
  );
}

/**
 * Текст провала gate, когда вызов списка процессов добавлен изменением
 * задачи (его вызывают добавленные строки `база..кандидат`): исправляет
 * исполнитель.
 */
export function processListCodeMessage(
  signature: ProcessListSignature,
  files: readonly string[],
  tail: string,
) {
  return (
    `${GATE_SANDBOX_PROCESS_LIST}: тест вызывает ps, в песочнице проверок это запрещено; уберите вызов — ` +
    `«${signature.line}»; вызов добавлен изменением задачи (${files.join(', ')}). ` +
    `Что сделать: ${PROCESS_LIST_ADVICE}. ${tail}`
  );
}

/** Строка возможности для `doctor` и `smoke`. */
export function processListLine(capability: ProcessListCapability) {
  const what = 'список процессов (ps) в песочнице проверок';
  switch (capability.status) {
    case 'available':
      return `${what}: доступен`;
    case 'not-isolated':
      return `${what}: проверки идут без песочницы ОС (isolation.mode: none)`;
    case 'unknown':
      return `${what}: не выяснен — ${capability.detail}`;
    case 'unavailable':
      return (
        `${what}: недоступен (${capability.detail}); gate, вызывающий ps, pgrep или top, упадёт с ` +
        `${GATE_SANDBOX_PROCESS_LIST} (spawn EPERM). Что сделать: ${PROCESS_LIST_ADVICE}`
      );
  }
}

const ereTool = String.raw`(/(usr/)?s?bin/)?(ps|pgrep|pkill|top)`;
/**
 * Шаблоны `git grep -E` (POSIX ERE) вызовов списка процессов в файлах
 * дерева. Вызов — это запуск программы, а не любое слово `ps`: вызов
 * `exec`/`execSync`/`execFile`/`spawn`/`execa` (и `child_process.…`) с
 * командой `ps` или `/bin/ps`, строка с абсолютным путём программы,
 * шаблон `` $`ps …` ``, команда в начале строки shell или скрипта
 * `package.json` и после `$(`, `|`, `;`, `&&`. Строка `'ps'` в массиве или
 * другом литерале вызовом не считается.
 */
export const processListCallPatterns = [
  String.raw`(^|[^A-Za-z0-9_$])(exec|execSync|execFile|execFileSync|spawn|spawnSync|execa|execaSync|execaCommand|execaCommandSync)[[:space:]]*\([[:space:]]*['"` +
    '`' +
    String.raw`]${ereTool}(['"` +
    '`' +
    String.raw`]|[[:space:]])`,
  String.raw`['"` + '`' + String.raw`]/(usr/)?s?bin/(ps|pgrep|pkill|top)['"` + '`' + String.raw`]`,
  String.raw`\$` + '`' + String.raw`[[:space:]]*${ereTool}[[:space:]]`,
  String.raw`^[[:space:]]*(sudo[[:space:]]+)?${ereTool}[[:space:]]+(-|aux)`,
  String.raw`(\$\(|[|;&]|":[[:space:]]*")[[:space:]]*${ereTool}[[:space:]]+(-|aux)`,
];

/** Те же шаблоны для строк в JavaScript (`[[:space:]]` — `\s`). */
const processListCallRegexps = processListCallPatterns.map(
  (p) => new RegExp(p.replaceAll('[[:space:]]', String.raw`\s`)),
);

/** Строка кода вызывает список процессов (`processListCallPatterns`). */
export function processListCall(line: string) {
  return processListCallRegexps.some((r) => r.test(line));
}
