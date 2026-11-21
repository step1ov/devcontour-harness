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

/** Шаг — проверка в браузере: по id и argv. */
export const isBrowserStep = (step: { id: string; command: readonly string[] }) =>
  /\b(?:agent-browser|playwright|puppeteer|chrom(?:e|ium)|headless|browser|webdriver|cypress|selenium)\b/i.test(
    [step.id, ...step.command].join(' '),
  );
