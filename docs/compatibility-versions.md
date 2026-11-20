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

| Что                 | Версия / commit                                                                                                                                                                                              | Где проверено                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay v1 (server)   | договор REST `contractVersion: 1`; сборка для R01 закреплена на commit `d692b5b` (`relay-v1-server.mjs`); контекст задачи — `@oim-dev/relay-server` 0.13.1-harness.1 (локальная сборка, `DC_RELAY_V1_BUILD`) | договор: транспорт отказывает `CONNECTOR_VERSION_MISMATCH` на другой версии (`tests/relay-v1-transport.test.ts`, поддельный HTTP-сервер). Настоящий сервер 0.13.1-harness.1: контекст задачи, вопросы владельцу и Relay без capability (`tests/integration/relay-v1-context.test.ts`), R01 и общий набор коннектора (`relay-v1-real`, `relay-v1-suite`). W01 на этом выпуске — **не проверено** |
| Relay-2 (CLI) / Bun | версия не сообщается; совместимость — sha256 binary из `relay.build`                                                                                                                                         | sha256 и отказ `BUILD_MISMATCH` → `CONNECTOR_VERSION_MISMATCH` — на fixture CLI (`tests/relay-v2-transport.test.ts`). Настоящая сборка (R02, R03) и W01, версия Bun — **не проверено**                                                                                                                                                                                                          |

## Relay: минимальная и рекомендуемая версия

Связка `relay-v1-http` сверяет Relay по тому, что сервер сообщает о себе:
версия договора REST (`GET /api/v1/health` → `contractVersion`) и
capabilities проекта (`GET /context`). Номер пакета Relay по REST не
сообщается: уровень определяется по договору и capabilities, а номера ниже —
по выпускам Relay.

| harness          | Минимальная Relay       | Рекомендуемая Relay                                                          | Что даёт рекомендуемая                                                                                                                       |
| ---------------- | ----------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.0-alpha.60   | 0.13.0 (договор REST 1) | 0.14.0 (ожидается; до выпуска — сборка 0.13.1-harness.1 с той же capability) | контекст исполнения задачи `relay-task-context-v1`: полные FI/SI, фичи, сценарии, приложения, паспорт и документы целей в пакете исполнителя |
| ≤ 0.1.0-alpha.59 | 0.13.0 (договор REST 1) | —                                                                            | —                                                                                                                                            |

- Ниже рекомендуемой (нет capability) связка работает как прежде: задача,
  критерии и документы задачи передаются, описание функции и сценария — нет.
  `doctor`, `init`, `source-check`, `source-snapshot` и `source-status`
  предупреждают об этом одной строкой; это не отказ.
- Другая версия договора REST или формы контекста —
  `CONNECTOR_VERSION_MISMATCH` (exit 4) до чтения задач и мутаций, с тем,
  что обновить.
- Номер 0.14.0 — ожидаемый первый выпуск Relay с контекстом задачи; таблица
  обновится по фактическому выпуску (`RELAY_TASK_CONTEXT_VERSION`).

Строки транспортов не означают, что другие версии Relay несовместимы: они
говорят только, что проверено. Настоящие серверы проверяются отдельным
прогоном (`npm run test:integration` при подготовленной сборке) и в обычную
проверку выпуска не входят.

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
