// Проверки в браузере (агент-браузер, headless Chrome, Playwright с
// браузером, `verify:browser`) — не работа исполнителя: его песочница браузер
// не запускает, и это ожидаемое состояние, а не закрытый шаг, который ждёт
// решения. Общие для пробы исполнителя и doctor.

/**
 * Совет проверке в браузере: песочница исполнителя её не запускает — это
 * ожидаемо, решать ничего не нужно.
 */
export const BROWSER_ADVICE =
  'Проверки в браузере — вне исполнителя: его песочница браузер не запускает, это ожидаемо и решения не требует. Запускайте такую проверку gate harness (gates работают вне песочницы исполнителя) только если она проходит на HEAD под harness (harness gates --state <каталог состояния> --sha HEAD); иначе оставьте её человеку.';

/**
 * Строка вывода, по которой видно, что процесс браузера сам не стартовал или
 * упал: агент-браузер («Daemon process exited during startup»), Puppeteer
 * («Failed to launch the browser process»), Playwright (`browserType.launch:`
 * с закрытым браузером или вышедшим процессом), Chrome и Chromium. Ошибка
 * настройки до запуска (`browserType.launch: executablePath: expected
 * string…`) и чужой сервер с «browser» в имени (`browser-sync`) — не запуск
 * браузера. Только по этой строке проба называет шаг `outside`: имя шага и
 * его аргументы этого не доказывают.
 */
export const BROWSER_LAUNCH =
  /Daemon process exited during startup|Failed to launch (?:the )?(?:browser process|chrome|chromium)\b|Browser process exited|Chrome failed to start|browserType\.launch(?:PersistentContext)?: (?:Target page, context or browser has been closed|Browser closed|Browser has been closed|Process failed to launch|Browser process (?:exited|crashed))|(?:Google Chrome|Chrome|Chromium)(?: for Testing)? (?:crashed|exited (?:with|unexpectedly|during startup))/i;

const SCRIPT = /^(?:(?:verify|test|e2e|check)[:-]browser|browser[:-](?:test|check|verify|e2e))$/;
/** Менеджеры пакетов, после которых идёт команда или скрипт. */
const MANAGERS = new Set(['pnpm', 'npm', 'npx', 'yarn', 'bun', 'bunx', 'pnpx']);
/** Подкоманды менеджера, после которых идёт запускаемая команда. */
const LAUNCH = new Set(['exec', 'dlx', 'x', 'run', 'run-script']);
/** Флаги менеджера со значением: значение — не команда (`--filter agent-browser`). */
const VALUED = new Set([
  '--filter',
  '-F',
  '-C',
  '--dir',
  '--prefix',
  '--cwd',
  '--workspace',
  '--package',
  '-p',
]);
const RUNNERS = new Set(['agent-browser', 'playwright', 'cypress']);
const base = (t: string) => t.split('/').pop() ?? t;

/** Индекс следующей команды (не флага и не значения флага) с `from`; -1 — нет. */
function commandAt(argv: readonly string[], from: number) {
  for (let i = from; i < argv.length; i++) {
    const t = argv[i]!;
    if (VALUED.has(t)) i++;
    else if (!t.startsWith('-')) return i;
  }
  return -1;
}

/**
 * Шаг запускает проверку в браузере — для `doctor`, который команды не
 * исполняет. Команда берётся по месту, а не по любому слову argv: сам
 * исполняемый файл или первая команда после менеджера пакетов (`pnpm`,
 * `npx`, `npm exec`, `pnpm dlx`, `yarn`; значения флагов вроде `--filter`
 * пропускаются). Проверка — `agent-browser`, `playwright test`, `cypress run`
 * или скрипт `verify:browser` и подобные; подкоманда установки (`playwright
 * install`, `agent-browser install`) — не проверка.
 */
export const isBrowserRunner = (step: { id: string; command: readonly string[] }) => {
  const argv = step.command;
  let i = 0;
  if (MANAGERS.has(base(argv[0] ?? ''))) {
    i = commandAt(argv, 1);
    if (i >= 0 && LAUNCH.has(argv[i]!)) i = commandAt(argv, i + 1);
    if (i < 0) return false;
  }
  const command = base(argv[i] ?? '');
  if (SCRIPT.test(command)) return true;
  if (!RUNNERS.has(command)) return false;
  const j = commandAt(argv, i + 1);
  const sub = j < 0 ? undefined : argv[j];
  if (sub === 'install' || sub === 'add' || sub === 'install-deps') return false;
  if (command === 'playwright') return sub === 'test';
  if (command === 'cypress') return sub === 'run';
  return true;
};
