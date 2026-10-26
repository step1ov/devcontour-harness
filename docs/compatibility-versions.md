# Проверенные версии

Набор версий, на котором выпуск фактически проверен. Это не список
обязательных требований: другие версии могут работать, но не проверялись.
Строки с «TODO» заполняются по итогам приёмки выпуска.

## Пакет и потребители

| Что                        | Версия                                                                                                        | Где проверено                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ОС / архитектура           | macOS 15 (Darwin 24.6), arm64                                                                                 | все проверки выпуска                                                          |
| Node.js                    | 24.3.0 (`engines: >=24.3.0`)                                                                                  | все проверки выпуска                                                          |
| npm                        | 11.4.2                                                                                                        | C01 (установка архива), A01, A02                                              |
| pnpm                       | 10.12.3                                                                                                       | C01 (`pnpm add <архив> --prod`)                                               |
| TypeScript потребителя     | 6.0.3 + `@types/node` 24.13.5                                                                                 | A01, C01 (ставится отдельно от пакета)                                        |
| Прежний потребитель        | API 0.1.0-alpha.5                                                                                             | A01                                                                           |
| Потребитель общих операций | fixtures `consumer-h1`, `consumer-h2`, `consumer-h3` (формы DevContour)                                       | H1–H3 (установка архива)                                                      |
| DevContour                 | 0.4.0-alpha.7 (`7191b75`), vendored 0.1.0-alpha.11 → архив; обновление с DevContour `ab35a6a` + 0.1.0-alpha.6 | D3: `npm run check`, `check:install`, `check:upgrade` двух пар source+package |
| Git                        | 2.33.0                                                                                                        | все сценарии                                                                  |

## Инструменты целевых проектов

| Что            | Версия | Где проверено  |
| -------------- | ------ | -------------- |
| Turbo          | TODO   | T01/turbo, S01 |
| Go / gotestsum | TODO   | T01/go         |
| Python / uv    | TODO   | T01/python     |
| Docker         | TODO   | S01–S06        |

## Транспорты

| Что                 | Версия / commit | Где проверено |
| ------------------- | --------------- | ------------- |
| Relay v1 (server)   | TODO            | R01, W01      |
| Relay-2 (CLI) / Bun | TODO            | R02, R03, W01 |

## Как повторить

<!-- repo-only -->

Проверки выпуска — инструменты разработки harness: они лежат в checkout
репозитория (`scripts/acceptance/`, `tests/fixtures/consumer-alpha5`, `tests/fixtures/consumer-h*`) и в
npm-архив не входят.

```sh
node scripts/acceptance/package-pack.mjs --out <dir>
node scripts/acceptance/package-check.mjs <dir>/devcontour-harness-<ver>.tgz
node scripts/acceptance/consumer-check.mjs <dir>/devcontour-harness-<ver>.tgz
node scripts/acceptance/core-minimal-env.mjs <dir>/devcontour-harness-<ver>.tgz
node scripts/acceptance/consumer-h1.mjs <dir>/devcontour-harness-<ver>.tgz --out <dir>/h1
node scripts/acceptance/consumer-h2.mjs <dir>/devcontour-harness-<ver>.tgz --out <dir>/h2
node scripts/acceptance/consumer-h3.mjs <dir>/devcontour-harness-<ver>.tgz --out <dir>/h3
node scripts/acceptance/devcontour-check.mjs <dir>/devcontour-harness-<ver>.tgz \
  --devcontour <путь или URL DevContour> --baseline
```

Отчёты скриптов (`report.json`) содержат фактические версии `node`, `npm`,
`pnpm` и компилятора, hash архива и argv каждой команды.

<!-- /repo-only -->
