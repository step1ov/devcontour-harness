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
 *   он не стартует (`Foreground browser daemon unavailable`, отказ
 *   `bootstrap_check_in` / `mach_port_rendezvous` Chromium). Общие строки
 *   запуска («Failed to launch the browser process», «Chrome crashed») сами
 *   следом песочницы не считаются: их даёт и сломанная настройка запуска.
 *
 * Правило строже, чем у `sandbox-process-list`, и закрыто по умолчанию:
 * след песочницы есть у каждого упавшего теста, ни у одного нет иного провала
 * (утверждение, строка `Error`, статус HTTP, иной код ошибки), лишний
 * testcase отчёта прощается только в точной форме общего провала обёртки, и
 * собственная проба harness в песочнице проверок подтвердила ограничение
 * (`gates.ts`, `sandboxLimitBackend`). Иначе провал засчитан. Вызов, который
 * добавили строки изменения задачи, — обычный засчитанный провал исполнителю
 * с советом.
 */

import { BROWSER_LAUNCH } from '../control/browser-checks.ts';
import { NO_RETRY_GATE_CODES } from '../contracts/execution.ts';
import { assertionMarkers, failedBlocks, otherFailures } from './process-list.ts';

/** Классы отказа песочницы этого модуля. */
export type SandboxSignatureCause = 'sandbox-signal' | 'sandbox-browser';

/**
 * Ответ пробы harness в песочнице ОС проверок: `unavailable` — ограничение
 * подтверждено (только тогда класс назначается); `available` — его нет;
 * `unknown` — проба ничего не доказала (браузера нет, песочница не исполнила
 * пробу); `not-isolated` — проверки без песочницы ОС.
 */
export interface SandboxLimitCapability {
  status: 'available' | 'unavailable' | 'unknown' | 'not-isolated';
  command?: string[];
  detail: string;
}

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
  /\bmach_port_rendezvous\b.*\b(?:Permission denied|denied|failed)\b/i,
];

/**
 * Точный текст следа класса и его сопровождения внутри строки: из строки
 * вырезается только он, а не вся строка. Иной признак провала в остатке
 * (`Error: HTTP status 500; cleanup: kill EPERM`) засчитывает попытку.
 * Объект ошибки `kill` (`errno`, `code: 'EPERM'`, `syscall: 'kill'`) —
 * у сигнала; общие строки запуска браузера, префикс журнала Chromium и имена
 * служб Mach — у браузера. Префикс `Error: ` вырезается только вплотную к
 * следу. Строка о пути к браузеру (`executablePath`, ENOENT) сопровождением
 * не бывает: это настройка запуска.
 */
const errorPrefix = String.raw`(?:\b(?:Uncaught )?Error: )?`;
const companionText: Record<SandboxSignatureCause, RegExp[]> = {
  'sandbox-signal': [
    new RegExp(errorPrefix + String.raw`\bkill EPERM\b`, 'g'),
    /\bkill: (?:\(\d+\) - |kill -?\d+ failed: |-?\d+: )?operation not permitted/gi,
    /\bsyscall: ['"]kill['"]/g,
    /\bcode: ['"]EPERM['"]/g,
    /\berrno: -?\d+/g,
  ],
  'sandbox-browser': [
    new RegExp(
      errorPrefix +
        String.raw`(?:\bForeground )?\bbrowser daemon (?:is )?(?:unavailable|not available|failed to start|did not start|exited)\b`,
      'gi',
    ),
    /\bbootstrap_check_in [\w.-]+: Permission denied \(1100\)/g,
    // Префикс журнала Chromium: `[pid:tid:время:FATAL:mach_port_rendezvous.cc(142)]`.
    /^\[[\d:/.]*:?(?:FATAL|ERROR|WARNING|INFO|VERBOSE\d*):[\w.]+\(\d+\)\]/g,
    new RegExp(errorPrefix + '(?:' + BROWSER_LAUNCH.source + ')', 'gi'),
    /\bbootstrap_check_in\b|\bmach_port\w*/g,
  ],
};
/** Строка целиком — сопровождение: кадр стека. */
const companionLines: RegExp[] = [/^\s*at\s/];
const launchConfig =
  /\bexecutablePath\b|\bexecutable\b.*\b(?:doesn't|does not) exist\b|\bENOENT\b|no such file|not found/i;

/** Признак провала, который след класса не объясняет. */
const foreignMarkers = [
  /\b(?:[A-Z]\w*)?(?:Error|Exception)\b/,
  /\berror:/i,
  /\btimed out\b|\btimeout\b/i,
  /\bE[A-Z]{3,}\b/,
  /\bHTTP\b.*\b[1-5]\d\d\b|\bstatus(?:Code| code)?:?\s*[45]\d\d\b/i,
  /\b(?:panic|Segmentation fault|Abort trap|core dumped|uncaught)\b/i,
];

/**
 * В тексте есть иной провал: проваленное утверждение или строка ошибки, кода
 * ошибки, статуса HTTP, аварии вне точного текста следа класса `cause` и
 * его сопровождения: строка со следом и иной ошибкой — иной провал.
 */
export function foreignFailure(cause: SandboxSignatureCause, text: string) {
  return text.split('\n').some((l) => {
    if (assertionMarkers.some((r) => r.test(l))) return true;
    if (cause === 'sandbox-browser' && launchConfig.test(l)) return true;
    if (!foreignMarkers.some((r) => r.test(l))) return false;
    if (companionLines.some((r) => r.test(l))) return false;
    const rest = companionText[cause].reduce((text, r) => text.replace(r, ' '), l);
    return foreignMarkers.some((r) => r.test(rest));
  });
}

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

/**
 * Общий провал прогона, который обёртка gate дописывает в отчёт JUnit к
 * тестам, упавшим на самом деле: ровно строка «Gate execution failed» (в
 * сообщении, теле или обоих). Только такой лишний testcase не отменяет
 * отказ среды; любой другой текст — свой провал.
 */
export const GATE_WRAPPER_FAILURE = 'Gate execution failed';
export function wrapperCompanion(text: string) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((l) => l === GATE_WRAPPER_FAILURE);
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
  const own = (text: string) => (foreignFailure(cause, text) ? undefined : signature(text));
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
    // сходится, а лишние testcases отчёта — ровно эта строка обёртки.
    const signed = fromBlocks(true);
    const unsigned = failures.texts.filter((_, i) => !found[i]);
    if (
      signed &&
      unsigned.length === failures.total - blocks!.tests.length &&
      unsigned.every(wrapperCompanion)
    )
      return signed;
    return undefined;
  }
  if (blocks) return fromBlocks(false);
  const line = signature(output);
  if (!line || foreignFailure(cause, output)) return undefined;
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

/**
 * Пометка к засчитанному провалу: в выводе след причины окружения `cause`,
 * но собственная проба harness ограничение песочницы не подтвердила.
 */
export function sandboxSignatureSuspectNote(
  cause: SandboxSignatureCause,
  line: string,
  probe: Pick<SandboxLimitCapability, 'status' | 'detail'>,
) {
  return (
    `возможная причина окружения ${cause} (${SANDBOX_SIGNATURE_CODES[cause]}: «${line}») не подтверждена пробой ` +
    `harness в песочнице проверок (${probe.status}: ${probe.detail}); попытка засчитана; ` +
    `если причина всё же в песочнице: ${WHAT[cause].advice}`
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

const PROBE_WHAT: Record<SandboxSignatureCause, { what: string; gate: string }> = {
  'sandbox-signal': {
    what: 'сигнал процессу вне песочницы (kill) из песочницы проверок',
    gate: 'gate, посылающий сигнал процессу, который запустил не он',
  },
  'sandbox-browser': {
    what: 'браузер в песочнице проверок',
    gate: 'gate, запускающий браузер',
  },
};

/** Строка ответа пробы ограничения песочницы для человека (`doctor`, `harness gates`). */
export function sandboxLimitLine(cause: SandboxSignatureCause, capability: SandboxLimitCapability) {
  const { what, gate } = PROBE_WHAT[cause];
  switch (capability.status) {
    case 'available':
      return `${what}: доступен`;
    case 'not-isolated':
      return `${what}: проверки идут без песочницы ОС (isolation.mode: none)`;
    case 'unknown':
      return `${what}: не выяснен — ${capability.detail}; провал gate с этим следом засчитывается`;
    case 'unavailable':
      return (
        `${what}: недоступен (${capability.detail}); ${gate}, упадёт с ` +
        `${SANDBOX_SIGNATURE_CODES[cause]}. Что сделать: ${WHAT[cause].advice}`
      );
  }
}
