# devcontour-harness

Headless-движок исполнения инженерных поручений: согласованный граф работ,
изолированные попытки в Git worktree, обязательные gates, независимое ревью,
интеграция с принятой веткой через compare-and-swap и машинный результат с SHA
и доказательствами.

> Статус: `0.1.0-alpha.8` — предварительный выпуск (alpha). Договоры
> `v1alpha1` могут измениться между alpha-версиями; закрепляйте точную версию.
> Файл → ревью плана → кандидат → интеграция → принятие → результат JSON, с
> ограниченным восстановлением, повторным использованием кандидата, бюджетами,
> потребителями, свойствами и корпусом, совместной проверкой репозиториев и
> явным режимом одного вендора.

Пакет включает встроенные профили стеков (`profiles/`), skill
`skills/harness/SKILL.md` и шаблоны политики, графа и инструкции агентам
(`templates/`).

## Требования

- Node.js ≥ 24.3.0, Git.
- CLI `codex` и `claude`, установленные и авторизованные (для живого запуска).
  `harness doctor` проверяет их без вызова модели.

## Установка

Из npm — точная версия (воспроизводимо) или последняя alpha по тегу:

```sh
npm install --save-exact devcontour-harness@0.1.0-alpha.8   # точная версия
# или: npm install --save-exact devcontour-harness@alpha     # текущая alpha
npx harness --version
```

Выпуски публикуются под тегом `alpha`; ставьте точную версию или `@alpha`,
а не версию по умолчанию без тега.

Из локального архива `devcontour-harness-<version>.tgz` (поддерживаемый
способ без registry):

```sh
npm install --omit=dev --ignore-scripts ./devcontour-harness-<version>.tgz
```

В архиве уже собраны JavaScript, декларации и JSON-схемы: установка не
выполняет скриптов и не требует devDependencies (`--omit=dev
--ignore-scripts` допустимы и для установки из npm). Проверка архива
целиком — `npm run check:install -- <архив>` из checkout пакета: установка в
отдельный каталог без сети, CLI, библиотека, профили, полный цикл на fixture
runtime и отказы.

CLI ставится локально: `npx harness` находит его в `node_modules/.bin`
ближайшего каталога установки (в том числе из его подкаталогов). Вне этого
каталога `npx harness` предложит скачать другой пакет с именем `harness` —
откажитесь; глобальная команда `harness` в `PATH` не предполагается.

## Быстрый старт

Пример — вымышленный репозиторий с одной задачей: добавить `greet(name)`.
Команды выполняются из каталога, где установлен пакет; `harness` в таблице
ниже — тот же CLI (`npx harness …`).

```sh
cp -R node_modules/devcontour-harness/examples/single-task greeting && cd greeting
git init -q && git add -A && git commit -qm init
npx harness validate --graph graph.json --policy policy.json
npx harness run --graph graph.json --policy policy.json --state ../greeting-state \
  --author external --sink file:../greeting-results
npx harness result --state ../greeting-state --work add-greeting
git rev-parse refs/heads/harness/accepted   # совпадает с data.result.shas.result
```

`run` регистрирует граф, проводит ревью плана (reviewer по политике),
согласует его и ведёт очередь до простоя. Принятое поручение — коммит
интеграции в `refs/heads/harness/accepted`; ни основная ветка, ни рабочее
дерево не меняются. Результат и состояние доставки — `harness result`.

Конфигурации примера:

| Файл                      | Вендоры                                    |
| ------------------------- | ------------------------------------------ |
| `policy.json`             | writer claude, reviewer codex              |
| `policy-same-vendor.json` | reviewer того же вендора, разрешённый явно |

## Команды

| Команда                                      | Что делает                                         |
| -------------------------------------------- | -------------------------------------------------- |
| `validate --graph F --policy F`              | Проверка входов без моделей и записи               |
| `review-plan / review-contract … --author A` | Раунд технического ревью с историей находок        |
| `approve --state D --subject ID --digest H`  | Согласование оператором (`approvalMode: operator`) |
| `run --graph F --policy F --state D`         | Регистрация, согласование и работа до простоя      |
| `status / events / result --state D`         | Чтение без побочных эффектов                       |
| `pause / resume / cancel / retry --state D`  | Управление очередью и поручением                   |
| `deliver --state D --work ID --sink file:D`  | Повтор доставки без моделей и интеграции           |
| `profile --profile ID [--repository D]`      | Разрешение профиля стека без команд проекта        |
| `doctor`                                     | Версии, runtime, sandbox, совместимость состояния  |

stdout — один JSON (`devcontour-harness/v1alpha1`), диагностика — stderr. Exit
codes: 0 успех, 2 неверный вход, 3 отказ/блокировка, 4 инфраструктура.
`HARNESS_CODEX_BIN` и `HARNESS_CLAUDE_BIN` подменяют исполняемые файлы runtime
— например, fixture executable в тестах (это не живая модель).

## Библиотека

```js
import { Harness, validateInputs } from 'devcontour-harness';
```

Библиотека и CLI вызывают одни и те же операции `Harness`; операции «передать
PASS» нет. Адаптеры хоста реализуют порты `ExecutionStore`, `WorkSource`,
`ContextSource`, `ResultSink`; набор проверок договора хранилища —
`devcontour-harness/testing`.

Пакет поставляет декларации TypeScript (`lib/**/*.d.ts`) для `.`,
`/contracts` и `/testing`; JSON-схемы входов и выходов —
`devcontour-harness/schemas/<имя>.schema.json`. Декларации используют типы
Node.js: TypeScript-потребителю нужен `@types/node` (или `skipLibCheck`).

## Выпуск 0.1.0-alpha.8

Самостоятельный маршрут для агента пользователя и общие операции для хостов.
Подробно — [заметки выпуска](docs/release-notes/0.1.0-alpha.8.md).

- `harness init` готовит существующий Git npm/pnpm-репозиторий create-only:
  `.harness/` с политикой из профиля и toolchain inspection, state вне
  репозитория, повтор и продолжение после прерывания без перезаписи
  ([standalone](docs/standalone.md)).
- `harness explain` объясняет остановки: код, причина, фаза, кто действует,
  допустимый шаг и evidence — только чтение, без повторов и вызовов моделей.
- Отказы TLS/DNS/соединения (`EPROTO`, `ECONNREFUSED`, `ENOTFOUND`,
  `EAI_AGAIN`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, `TLS handshake
failed/timeout`) — класс `environment` с обычным ограниченным повтором.
- Общие операции для хостов: безопасная подготовка файлов и проекции
  диагностики (`devcontour-harness/projections`, без `node:*`).

## Выпуск 0.1.0-alpha.7

Исправление учёта команд reviewer в `inspection` ревью кода. Подробно —
[заметки выпуска](docs/release-notes/0.1.0-alpha.7.md).

- `inspection` собирается controller из событий runtime и журнала проверок
  `run_check` одного вызова reviewer: запуски probe теперь засчитываются, а
  команда с ненулевым кодом — выполнение, а не `diff-only`
  ([review-probes](docs/review-probes.md#итог-inspection-что-reviewer-действительно-выполнил)).
- Старт probe подтверждается на границе исполнения; отказ до старта, отменённый
  до запуска вызов и резерв бюджета выполнением не считаются. Уже отменённый
  вызов больше не запускает команду.
- Gates, бюджеты, правила находок и принятия не менялись: `inspection` по-прежнему
  не влияет на решение.

Записи alpha.6 читаются без пересчёта; состояние с новыми записями `inspection`
alpha.6 не читает — откат только через копию ([upgrade](docs/upgrade.md)).

## Выпуск 0.1.0-alpha.6

Ядро работает как прежде; всё новое подключается явно. Подробно —
[заметки выпуска](docs/release-notes/0.1.0-alpha.6.md).

- Инструменты целевого проекта: npm, pnpm, Turborepo, Go/gotestsum,
  Python/uv — явными шагами `prepare`, gates и `repositories[].toolchain`;
  `doctor` и обязательный preflight `run` ([toolchains](docs/toolchains.md)).
- Рецепт Turbo Starter с lifecycle-мостом Docker
  ([turbo-starter](docs/turbo-starter.md)).
- Коннектор задач с транспортами Relay v1 и Relay-2: команды `source-*`,
  `run --source`, доставка с намерением, read-back и явным разбором
  неизвестного исхода ([connectors](docs/connectors.md)).
- Протокол ревью кода: ID и переходы находок, ограниченный повтор reviewer,
  `REVIEW_PROTOCOL_INVALID` ([review-protocol](docs/review-protocol.md));
  объявленные gates в проверках reviewer ([review-probes](docs/review-probes.md)).
- Точка подключения внешней памяти — договор без готового адаптера
  ([hindsight](docs/integrations/hindsight.md)).

Состояние alpha.5 читается без преобразования. Standalone-состояние с новыми записями
alpha.5 не читает; прежний DevContour его открывает без отказа — откат только через копию ([upgrade](docs/upgrade.md)).

## Выпуск 0.1.0-alpha.5

Первая публикация в npm. Движок, форматы состояния, политики и договоры — те
же, что в `0.1.0-alpha.4`; меняется поставка: пакет публикуется под тегом
`alpha`, архив собирается со свежей сборкой и проверенными схемами. Номер
версии движка при этом меняется, поэтому обновление с alpha.4 проходит по
процедуре [docs/upgrade.md](docs/upgrade.md): остановка writers, копия
состояния, активные попытки alpha.4 не продолжаются новой версией, а
завершаются через recovery.

Ограничения выпуска:

- Тесты и проверка архива используют fixture runtime: они подтверждают
  механику (gates, область записи, fencing, recovery, результат), но не
  качество живой модели.
- Готовых коннекторов к внешним сервисам задач, памяти и обмена сообщениями
  выпуск не содержит: источники и получатели подключаются через порты библиотеки
  ([examples/external-connector](examples/external-connector/README.md)).

## Документация

- [Быстрый старт по шагам](docs/quickstart.md)
- [Самостоятельный проект: init, explain, проекции](docs/standalone.md)
- [Архитектура и границы доверия](docs/architecture.md)
- [Договоры: входы, выходы, порты, ошибки, CLI](docs/contracts.md)
- [Совместимость форматов](docs/compatibility.md)
- [Обновление и откат](docs/upgrade.md)
- [Примеры конфигурации](examples/README.md)

## Разработка

```sh
npm ci
npm run check         # lint, typecheck, схемы, сборка, тесты, проверка архива
npm run format:check
```

Тесты используют настоящие временные Git-репозитории, SQLite и fixture
executables CLI codex/claude; живые модели не вызываются. Результаты
fixture-тестов не являются проверкой качества моделей.

## Лицензия

MIT, см. [LICENSE](LICENSE).
