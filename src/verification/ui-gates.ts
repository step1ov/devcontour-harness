import { DEFAULT_BROWSER_ARTIFACTS, type UiGatePolicy } from '../contracts/index.ts';

/**
 * UI gates (alpha.69, docs/ui-gates.md) — точка расширения.
 *
 * `browser` (Playwright) исполняется: gate получает переменные, по которым
 * конфигурация Playwright проекта выбирает браузер, режим и каталог
 * профиля, а при провале harness сохраняет отчёты и трассы раннера
 * (`artifacts`, по умолчанию `test-results/` и `playwright-report/`).
 * Браузер у каждой попытки свой: профиль — во временном каталоге проверки
 * (`$TMPDIR`), порты — порты попытки.
 *
 * `mobile` (Maestro) — договор: политика его проверяет, gate получает
 * переменные платформы, устройства и приложения; выбор устройства из пула,
 * сборка и установка приложения harness ещё не делает — это команда gate и
 * lifecycle проекта до отчёта исследования.
 */
export function uiGateEnvironment(ui: UiGatePolicy): Record<string, string> {
  if (ui.type === 'browser')
    return {
      HARNESS_UI: 'browser',
      HARNESS_UI_RUNNER: ui.runner,
      HARNESS_BROWSER: ui.browser,
      HARNESS_BROWSER_HEADLESS: ui.headless ? '1' : '0',
      ...(ui.specs?.length ? { HARNESS_UI_SPECS: ui.specs.join('\n') } : {}),
    };
  return {
    HARNESS_UI: 'mobile',
    HARNESS_UI_RUNNER: ui.runner,
    HARNESS_MOBILE_PLATFORM: ui.platform,
    HARNESS_MOBILE_APP_ID: ui.app.id,
    HARNESS_UI_FLOWS: ui.flows.join('\n'),
    ...(ui.device.name ? { HARNESS_MOBILE_DEVICE: ui.device.name } : {}),
    ...(ui.device.os ? { HARNESS_MOBILE_OS: ui.device.os } : {}),
  };
}

/** Пути артефактов UI gate, сохраняемые при провале. */
export function uiFailureArtifacts(ui: UiGatePolicy): string[] {
  if (ui.artifacts?.length) return [...ui.artifacts];
  return ui.type === 'browser' ? [...DEFAULT_BROWSER_ARTIFACTS] : ['.maestro'];
}
