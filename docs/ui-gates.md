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

Браузерные gates — только облегчённый режим ([light-mode.md](light-mode.md)):
на macOS в песочнице ОС проверок не стартует ни одна сборка Chromium (ей
нужна регистрация mach-сервисов), поэтому политика отклоняет блок `ui` в
строгом режиме. Нужна строгая изоляция — браузер в контейнере (образ
Playwright в сети compose попытки) обычным gate без блока `ui`.

Раннер gate — Playwright Test с собственным headless Chromium: его
ревизия закреплена, кеш браузеров (`~/Library/Caches/ms-playwright`,
`~/.cache/ms-playwright`) ставится один раз при настройке и открыт границей
записи, профиль браузера у каждого прогона свой. Под границей записи он
проходит и параллельно. Рекомендуемая конфигурация gate: `headless: true`,
`workers: 1` (параллельность — попытками), `retries: 0`, `trace:
'retain-on-failure'`, `screenshot: 'only-on-failure'`, `baseURL` — адрес
шлюза попытки (`HARNESS_GATEWAY_URL`). Системный Chrome и общий профиль в
gates не используйте: Chrome держит сокет профиля во временном каталоге
пользователя и пишет Crashpad в профиль пользователя — ложные «профиль
занят». agent-browser — инструмент исследования для агентов, не раннер
gates; если он всё же запускается в проверке, harness даёт ей свой каталог
сокетов (`AGENT_BROWSER_SOCKET_DIR`), а потомки проверки останавливаются
вместе с ней.

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

Выходы gates вне кандидата (alpha.75): новые файлы исполнителя под
объявленными `ui.artifacts` (у `browser` без них — `test-results/` и
`playwright-report/` от `cwd` gate) не коммитятся в кандидата. `.maestro/`
по умолчанию выходом не считается — там исходники потоков; объявленный путь,
пересекающийся с `flows` или `when.paths` или с отслеживаемыми на базе
файлами, тоже не убирается.

В alpha.69 договор проверяется политикой (пул — объявленные ресурсы
`device`; в строгом режиме блок `ui` отклоняется — симулятору нужны
CoreSimulator и запись в `~/Library/Developer`), `doctor` называет такие
gates, а gate получает `HARNESS_UI=mobile`, `HARNESS_MOBILE_PLATFORM`,
`HARNESS_MOBILE_APP_ID`, `HARNESS_UI_FLOWS`, `HARNESS_MOBILE_DEVICE`,
`HARNESS_MOBILE_OS`, `HARNESS_MOBILE_LOCALE` (`device.locale`),
`MAESTRO_CLI_NO_ANALYTICS=1`, `MAESTRO_DRIVER_STARTUP_TIMEOUT`
(`driverStartupTimeoutMs`, по умолчанию 60 с) и под границей записи свой
`JAVA_OPTS` (`-Duser.home`, `-Djava.io.tmpdir` во временном каталоге
проверки, `-Djava.net.preferIPv4Stack=true`): Maestro пишет в
`~/.maestro` и игнорирует HOME, а два прогона, начатые в одну секунду,
делили бы один каталог журналов.
Исключительность устройства даёт аренда ресурсов gate (`resources`).
Выбор свободного устройства из пула, создание устройства попытки, сборку и
установку приложения harness пока не делает — это команда gate и lifecycle
проекта; полное исполнение — следующий выпуск, по требованиям
исследования инструментов приёмки.

Требования к полному исполнению (следующий выпуск):

- **пул устройств**, а не устройство на попытку (клон стоит гигабайты и
  загрузку): N закреплённых устройств (модель, runtime, локаль), аренда
  одного на попытку — `simctl erase` → локаль → `boot` → `bootstatus`,
  возврат — `shutdown`; UDID в квитанции; Android — тот же пул AVD
  (`emulator -avd X -no-window -read-only`);
- **локаль закреплена**: селекторы потоков иначе зависят от языка системы
  (лучше — по id или accessibility id);
- **сборка и установка** приложения до потоков, сборка — с кешем по
  содержимому (самая долгая часть);
- **потоки в репозитории**, один вызов `maestro test <каталог>` на попытку
  (старт около 10 с), адрес API — шлюз попытки через `-e`;
- **артефакты**: всегда `commands.json`, журнал maestro и JUnit; при
  провале — снимок экрана и иерархия экрана;
- **причины среды** (не засчитываются): «iOS driver not ready in time»,
  отказ прав `xcodebuild`, предел загрузки устройства, «No devices found»;
- **подготовка при настройке**: Maestro CLI и его зависимости, первая
  установка драйвера на каждое устройство пула.

Граница записи облегчённого режима по умолчанию открывает то, что нужно
Maestro и симуляторам: журналы и состояние `~/.maestro` (`tests`, `sessions`,
файлы состояния; `deps/` готовится при настройке), `~/Library/Developer/CoreSimulator`,
`~/Library/Logs/CoreSimulator`, `~/Library/Developer/Xcode/DerivedData`,
`~/.android`, `~/.gradle`. Другие пути — `writeGuard.add`.
