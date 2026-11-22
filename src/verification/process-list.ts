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
  return processListSignature(output);
}

/** Текст отказа gate для evidence и следующей попытки. */
export function processListMessage(signature: ProcessListSignature, tail: string) {
  return (
    `${GATE_SANDBOX_PROCESS_LIST}: gate запускает ps (список процессов), а в песочнице ОС проверок он недоступен — ` +
    `«${signature.line}». Ядро macOS не запускает setuid-программы (/bin/ps, /usr/bin/top) в песочнице, ` +
    'а pgrep в ней не видит процессов вне песочницы; правка кода задачи этого не снимет. ' +
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

/**
 * Шаблоны `git grep -E` вызовов списка процессов в файлах дерева: абсолютный
 * путь программы, её имя строкой (`execFile('ps', …)`) и вызов в shell.
 */
export const processListCallPatterns = [
  String.raw`/(usr/)?s?bin/(ps|pgrep|pkill|top)([^a-zA-Z0-9_.-]|$)`,
  String.raw`['"\`](ps|pgrep|pkill)['"\` ]`,
  String.raw`(^|[;&|(]|[[:space:]])(ps|pgrep|pkill) -[a-zA-Z]`,
];
