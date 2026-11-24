# UI gates: браузер и мобильные

С 0.1.0-alpha.69 gate задачи (`test` или `check`) может нести блок `ui` —
точку расширения для проверок интерфейса. Команда gate остаётся его
`command`; блок описывает, что harness готовит попытке. Базовые
инструменты: Playwright для веба, Maestro для мобильных приложений.

## `browser` (Playwright) — исполняется

```json
{
  "id": "e2e",
  "kind": "test",
  "command": ["pnpm", "exec", "playwright", "test"],
  "report": { "type": "junit", "path": "test-results/junit.xml" },
  "ui": {
    "type": "browser",
    "runner": "playwright",
    "browser": "chromium",
    "headless": true,
    "specs": ["e2e/"],
    "artifacts": ["test-results", "playwright-report"]
  }
}
```

Gate получает `HARNESS_UI=browser`, `HARNESS_UI_RUNNER`,
`HARNESS_BROWSER` (`chromium`/`firefox`/`webkit`),
`HARNESS_BROWSER_HEADLESS` (`1`/`0`) и `HARNESS_UI_SPECS` (по строке на
путь). Конфигурация Playwright проекта читает их (`headless:
process.env.HARNESS_BROWSER_HEADLESS !== '0'`), берёт адрес приложения из
переменных попытки (`HARNESS_GATEWAY_URL` или порт попытки) и пишет профиль
браузера во временный каталог попытки (`$TMPDIR`) — у каждой попытки свой
браузер.

При провале harness сохраняет отчёты и трассы раннера (`artifacts`; по
умолчанию `test-results` и `playwright-report`) как evidence gate, рядом с
обычными `artifacts` gate (они сохраняются при любом исходе).

Браузер работает в облегчённом режиме ([light-mode.md](light-mode.md)): в
строгом песочница ОС проверок браузер не запускает (`sandbox-browser`).
Кеш браузеров Playwright (`~/Library/Caches/ms-playwright`,
`~/.cache/ms-playwright`) открыт границей записи по умолчанию.

## `mobile` (Maestro) — договор

```json
{
  "id": "mobile-e2e",
  "kind": "check",
  "command": [
    "maestro",
    "test",
    "--format",
    "junit",
    "--output",
    "test-results/maestro.xml",
    "flows/"
  ],
  "resources": ["sim-1"],
  "ui": {
    "type": "mobile",
    "runner": "maestro",
    "platform": "ios",
    "flows": ["flows/"],
    "device": { "pool": ["sim-1", "sim-2"], "os": "18.2" },
    "app": {
      "id": "com.example.app",
      "build": ["pnpm", "ios:build:sim"],
      "install": ["xcrun", "simctl", "install", "booted", "build/App.app"]
    },
    "artifacts": [".maestro"],
    "flowTimeoutMs": 600000
  }
}
```

Поля: `platform` (`ios` — симулятор, `android` — эмулятор), `flows`
(потоки Maestro), `device` — пул устройств (ресурсы `kind: device`
политики) или имя и версия ОС (`name`, `os`, `perAttempt` — своё
устройство попытки), `app` — идентификатор, команды сборки и установки и
предел сборки, `artifacts` (при провале; по умолчанию `.maestro`),
`flowTimeoutMs`.

В alpha.69 договор проверяется политикой (пул — объявленные ресурсы
`device`), `doctor` называет такие gates, а gate получает
`HARNESS_UI=mobile`, `HARNESS_MOBILE_PLATFORM`, `HARNESS_MOBILE_APP_ID`,
`HARNESS_UI_FLOWS`, `HARNESS_MOBILE_DEVICE`, `HARNESS_MOBILE_OS`.
Исключительность устройства даёт аренда ресурсов gate (`resources`).
Выбор свободного устройства из пула, создание устройства попытки, сборку и
установку приложения harness пока не делает — это команда gate и lifecycle
проекта; полное исполнение — следующий выпуск, по требованиям
исследования инструментов приёмки.

Граница записи облегчённого режима по умолчанию открывает то, что нужно
Maestro и симуляторам: `~/.maestro`, `~/Library/Developer/CoreSimulator`,
`~/Library/Logs/CoreSimulator`, `~/Library/Developer/Xcode/DerivedData`,
`~/.android`, `~/.gradle`. Другие пути — `writeGuard.add`.
