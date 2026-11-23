/**
 * Отказы песочницы ОС проверок (gate), которые повтор не снимет, кроме списка
 * процессов (`process-list.ts`): сигнал процессу вне песочницы и браузер
 * (0.1.0-alpha.68).
 *
 * - `sandbox-signal` — проверка посылает сигнал (`process.kill`, `kill`)
 *   процессу, который запущен не внутри её песочницы (обёртка gate, процессы
 *   хоста): Seatbelt разрешает сигналы только процессам той же песочницы, и
 *   ядро отвечает EPERM (`Error: kill EPERM`, `kill: … Operation not
 *   permitted`).
 * - `sandbox-browser` — проверка запускает браузер или его демон
 *   (агент-браузер, Playwright, Puppeteer, Chrome), а в песочнице ОС проверок
 *   он не стартует (`Foreground browser daemon unavailable`, `Failed to
 *   launch the browser process`, отказ `bootstrap_check_in` Chromium).
 *
 * Правило то же, что у `sandbox-process-list`: признак есть у каждого
 * упавшего теста и ни у одного нет проваленного утверждения; провал теста без
 * признака остаётся провалом gate. Вызов, который добавили строки изменения
 * задачи, — обычный засчитанный провал исполнителю с советом.
 */

import { BROWSER_LAUNCH } from '../control/browser-checks.ts';
import { NO_RETRY_GATE_CODES } from '../contracts/execution.ts';
import { assertionMarkers, failedBlocks, otherFailures } from './process-list.ts';

/** Классы отказа песочницы этого модуля. */
export type SandboxSignatureCause = 'sandbox-signal' | 'sandbox-browser';

/** Код отказа gate: сигнал процессу вне песочницы ОС проверок. */
export const GATE_SANDBOX_SIGNAL = NO_RETRY_GATE_CODES['sandbox-signal'];
/** Код отказа gate: браузер не стартует в песочнице ОС проверок. */
export const GATE_SANDBOX_BROWSER = NO_RETRY_GATE_CODES['sandbox-browser'];

/** Код отказа по классу. */
export const SANDBOX_SIGNATURE_CODES: Record<SandboxSignatureCause, string> = {
  'sandbox-signal': GATE_SANDBOX_SIGNAL,
  'sandbox-browser': GATE_SANDBOX_BROWSER,
};

/** Что сделать, когда проверка шлёт сигнал чужому процессу. */
export const SIGNAL_ADVICE =
  'тест не должен посылать сигналы процессам, запущенным не им (обёртка gate, процессы хоста): ' +
  'останавливайте только дочерние процессы, которые тест запустил сам, или вынесите такую проверку из ' +
  'команды gate и запускайте её на хосте; isolation.mode: none снимает песочницу со всех проверок и не рекомендуется';

/** Что сделать, когда проверке нужен живой браузер. */
export const BROWSER_GATE_ADVICE =
  'вынесите проверку в браузере из команды gate (запускайте её на хосте, вне песочницы проверок) ' +
  'или проверяйте без живого браузера (HTTP-уровень, рендер DOM без браузера); ' +
  'isolation.mode: none снимает песочницу со всех проверок и не рекомендуется';

const signalLines = [
  // Node: `Error: kill EPERM` (process.kill), в том числе `kill EPERM` в сообщении.
  /\bkill EPERM\b/,
  // Shell: `kill: (123) - Operation not permitted`, zsh `kill: kill 123 failed: operation not permitted`.
  /\bkill: .*operation not permitted/i,
];
/** Объект ошибки Node, напечатанный отдельно: `syscall: 'kill'` рядом с `code: 'EPERM'`. */
const signalSyscall = /\bsyscall: ['"]kill['"]/;
const epermCode = /\bcode: ['"]EPERM['"]|\bEPERM\b/;

const browserLines = [
  // Демон агента-браузера не поднялся в песочнице проверок.
  /\bbrowser daemon (?:is )?(?:unavailable|not available|failed to start|did not start|exited)\b/i,
  // Chromium в песочнице ОС: служба Mach-портов закрыта (`Permission denied (1100)`).
  /\bbootstrap_check_in\b.*\bPermission denied \(1100\)/,
  /\bFATAL:mach_port_rendezvous/,
  BROWSER_LAUNCH,
];

const clip = (line: string) => line.trim().slice(0, 200);

/** Строка признака отказа сигнала в тексте, или undefined. */
export function signalSignature(text: string): string | undefined {
  const lines = text.split('\n');
  const line = lines.find((l) => signalLines.some((r) => r.test(l)));
  if (line) return clip(line);
  const syscall = lines.find((l) => signalSyscall.test(l));
  return syscall && epermCode.test(text) ? clip(syscall) : undefined;
}

/** Строка признака отказа браузера в тексте, или undefined. */
export function browserSignature(text: string): string | undefined {
  const line = text.split('\n').find((l) => browserLines.some((r) => r.test(l)));
  return line ? clip(line) : undefined;
}

export const SANDBOX_SIGNATURES: Record<
  SandboxSignatureCause,
  (text: string) => string | undefined
> = {
  'sandbox-signal': signalSignature,
  'sandbox-browser': browserSignature,
};

/** Признак проваленного утверждения или иной ошибки в тексте упавшего теста. */
const failureMarkers = [
  ...assertionMarkers,
  /\b(?:[A-Z]\w*)?(?:Error|Exception)\b/,
  /\berror:/i,
  /\btimed out\b|\btimeout\b/i,
  /\bE[A-Z]{3,}\b/,
];

/**
 * Упавший testcase отчёта JUnit без своей причины: обёртка gate добавляет
 * общий провал прогона («Gate execution failed») к тестам, которые упали на
 * самом деле. Короткий текст без утверждения, ошибки и кода системной ошибки.
 */
function opaqueCompanion(text: string) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    lines.length <= 2 &&
    lines.join(' ').length <= 200 &&
    !lines.some((l) => failureMarkers.some((r) => r.test(l)))
  );
}

/**
 * Отказ проверки — отказ класса `cause`: признак в выводе, а если отчёт JUnit
 * назвал упавшие testcases — в тексте каждого из них (общий провал обёртки
 * без своей причины признак не отменяет, но и сам его не даёт). Без отчёта
 * JUnit — по блокам TAP или spec, иначе — по выводу без других провалов.
 */
export function sandboxSignatureFailure(
  cause: SandboxSignatureCause,
  output: string,
  failures?: { total: number; texts: string[] },
): string | undefined {
  const signature = SANDBOX_SIGNATURES[cause];
  const own = (text: string) =>
    text.split('\n').some((l) => assertionMarkers.some((r) => r.test(l)))
      ? undefined
      : signature(text);
  const blocks = failedBlocks(output);
  /** Упавшие тесты вывода (TAP, spec): у каждого признак, итог прогона напечатан и сходится. */
  const fromBlocks = (exact: boolean) => {
    if (!blocks?.tests.length) return undefined;
    if (exact ? blocks.total !== blocks.count : (blocks.total ?? 0) > blocks.count)
      return undefined;
    const found = blocks.tests.map(own);
    return found.every(Boolean) ? found[0] : undefined;
  };
  if (failures && failures.total > 0) {
    if (failures.texts.length < failures.total) return undefined;
    const found = failures.texts.map(own);
    if (found.every(Boolean)) return found[0];
    // Обёртка gate дописала в отчёт общий провал прогона без своей причины
    // («Gate execution failed»): признак принимается, только когда вывод сам
    // называет упавшие тесты, у каждого из них признак, итог прогона
    // сходится, а лишние testcases отчёта — ровно такие общие провалы.
    const signed = fromBlocks(true);
    const unsigned = failures.texts.filter((_, i) => !found[i]);
    if (
      signed &&
      unsigned.length === failures.total - blocks!.tests.length &&
      unsigned.every(opaqueCompanion)
    )
      return signed;
    return undefined;
  }
  if (blocks) return fromBlocks(false);
  const line = signature(output);
  if (!line) return undefined;
  return otherFailures(output, (l) => Boolean(signature(l))) ? undefined : line;
}

/**
 * Признак класса хотя бы у одного упавшего теста (или в выводе), когда
 * остальные провалы — свои: провал остаётся засчитанным, но текст называет
 * ведущему, какую часть gate закрыла песочница.
 */
export function sandboxSignaturePartial(
  cause: SandboxSignatureCause,
  output: string,
  failures?: { texts: string[] },
): string | undefined {
  const signature = SANDBOX_SIGNATURES[cause];
  for (const text of failures?.texts ?? []) {
    const s = signature(text);
    if (s) return s;
  }
  return signature(output);
}

const WHAT: Record<SandboxSignatureCause, { does: string; why: string; advice: string }> = {
  'sandbox-signal': {
    does: 'gate посылает сигнал (kill) процессу вне своей песочницы, а песочница ОС проверок это запрещает',
    why: 'Песочница ОС разрешает сигналы только процессам той же песочницы (обёртка gate и процессы хоста — вне её)',
    advice: SIGNAL_ADVICE,
  },
  'sandbox-browser': {
    does: 'gate запускает браузер (или демон браузера), а в песочнице ОС проверок он не стартует',
    why: 'Браузер не поднимается внутри песочницы ОС проверок (закрыты службы, которые ему нужны)',
    advice: BROWSER_GATE_ADVICE,
  },
};

/** Текст отказа среды для evidence и следующей попытки. */
export function sandboxSignatureMessage(cause: SandboxSignatureCause, line: string, tail: string) {
  const w = WHAT[cause];
  return (
    `${SANDBOX_SIGNATURE_CODES[cause]}: ${w.does} — «${line}». ${w.why}; вызов не из изменения задачи, ` +
    `и его правка этого не снимет. Что сделать: ${w.advice}. ${tail}`
  );
}

/** Текст засчитанного провала, когда вызов добавлен изменением задачи. */
export function sandboxSignatureCodeMessage(
  cause: SandboxSignatureCause,
  line: string,
  files: readonly string[],
  tail: string,
) {
  const w = WHAT[cause];
  return (
    `${SANDBOX_SIGNATURE_CODES[cause]}: ${w.does}; уберите вызов — «${line}»; вызов добавлен изменением ` +
    `задачи (${files.join(', ')}). Что сделать: ${w.advice}. ${tail}`
  );
}

/** Пометка к засчитанному провалу: часть упавших тестов закрыла песочница. */
export function sandboxSignaturePartialNote(cause: SandboxSignatureCause, line: string) {
  return (
    `часть провала — причина окружения ${cause}, а не дефект решения (${SANDBOX_SIGNATURE_CODES[cause]}: «${line}»); ` +
    'попытка засчитана за остальные провалы без этого признака; ' +
    `для части, которую закрыла песочница: ${WHAT[cause].advice}`
  );
}

/**
 * Строка кода, которая шлёт сигнал или запускает браузер: по ней изменение
 * задачи узнаётся автором вызова (`addedCallFiles`).
 */
const CALLS: Record<SandboxSignatureCause, RegExp[]> = {
  'sandbox-signal': [
    /\b(?:process|os)\.kill\s*\(/,
    /\bsyscall\.Kill\s*\(/,
    /^\s*(?:sudo\s+)?kill\s+(?:-|%|\$|\d)/,
    /(?:\$\(|[|;&]|":\s*")\s*kill\s+(?:-|%|\$|\d)/,
  ],
  'sandbox-browser': [
    /\bagent-browser\b/,
    /\b(?:chromium|firefox|webkit|puppeteer)\.launch(?:PersistentContext|Server)?\s*\(/,
    /\bplaywright\s+test\b/,
    /(?:from\s+|require\s*\(\s*|import\s*\(\s*)['"](?:@playwright\/test|playwright(?:-core)?|puppeteer(?:-core)?)['"]/,
  ],
};

/** Строка кода вызывает то, что закрыла песочница класса `cause`. */
export function sandboxSignatureCall(cause: SandboxSignatureCause, line: string) {
  return CALLS[cause].some((r) => r.test(line));
}
