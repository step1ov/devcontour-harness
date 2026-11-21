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
 * Строка вывода, по которой видно, что запускался браузер и он не стартовал:
 * агент-браузер («Daemon process exited during startup»), Puppeteer и
 * Playwright («Failed to launch the browser process», `browserType.launch`),
 * Chrome и Chromium. Только по ней проба называет шаг `outside`: имя шага и
 * его аргументы этого не доказывают.
 */
export const BROWSER_LAUNCH =
  /Daemon process exited during startup|Failed to launch (?:the )?(?:browser process|chrome|chromium)|Browser process exited|Chrome failed to start|browserType\.launch(?:PersistentContext)?:|(?:Chrome|Chromium)(?: for Testing)? (?:crashed|exited)|Could not start (?:the )?browser/i;

const INSTALL = /^(?:add|install|i|remove|rm|update|up|upgrade|dlx|exec-install)$/;
const SCRIPT = /^(?:(?:verify|test|e2e|check)[:-]browser|browser[:-](?:test|check|verify|e2e))$/;

/**
 * Шаг запускает проверку в браузере — для `doctor`, который команды не
 * исполняет: инструмент запуска в argv (`agent-browser`, `playwright test`,
 * `cypress run`) или скрипт `verify:browser` и подобные. Id шага и подстроки
 * аргументов не считаются (`browser-bundle`, `headless-cms-build`), установка
 * пакета (`pnpm add -D @playwright/test`) — не проверка.
 */
export const isBrowserRunner = (step: { id: string; command: readonly string[] }) => {
  const argv = step.command.map((t) => t.split('/').pop() ?? t);
  if (argv.some((t) => INSTALL.test(t))) return false;
  return argv.some(
    (t, i) =>
      t === 'agent-browser' ||
      (t === 'playwright' && argv[i + 1] === 'test') ||
      (t === 'cypress' && argv[i + 1] === 'run') ||
      SCRIPT.test(t),
  );
};
