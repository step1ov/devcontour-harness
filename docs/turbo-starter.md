# Turbo Starter: рецепт и lifecycle-мост

Это первый продуктовый сценарий harness на настоящем pnpm/Turborepo-проекте.
В копию [Turbo Starter](https://github.com/oim-dev/turbo-starter) на commit
`78f1e76b80f76ae9d4289e0b0994df8a6f2b89cc` вносится небольшое изменение
контракта backend. OpenAPI и SDK генерируются штатной командой starter, затем
проверяется frontend-потребитель. Всё, чего нет в upstream (приёмочные
проверки с JUnit, политика, граф, мост Docker, шаблоны env), лежит в
`examples/turbo-starter/` пакета. Upstream не патчится.

| Файл                                           | Назначение                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `examples/turbo-starter/policy.json`           | Политика основного сценария: `prepare` (`pnpm install --frozen-lockfile --offline`), gates, защищённые пути, toolchain (`pnpm 11.25.0`, `node >=24.3`) |
| `examples/turbo-starter/graph.json`            | Поручение `issued-at`: область записи, gates, контекст `controller-mode`                                                                               |
| `examples/turbo-starter/policy.lifecycle.json` | Политика с lifecycle `compose-bridge` (PostgreSQL на попытку и фазу)                                                                                   |
| `examples/turbo-starter/harness/`              | Копируется в `.harness/` проекта: `compose-bridge.mjs`, `compose.acceptance.yml`, `env/*.template`, `acceptance/*.test.mjs`                            |
| `examples/turbo-starter/changes/*.patch`       | Подготовленные изменения для fixture writer: `issued-at.patch` (верное, вместе с выходом генератора) и `issued-at-consumer-only.patch` (несовместимое) |
| `templates/controller-mode/`                   | Оверлей `AGENTS.controller.md` v1 и инструкция включения                                                                                               |

## Как повторить

Всё нужное лежит в npm-архиве (`examples/turbo-starter/`, `templates/controller-mode/`);
checkout исходников harness не требуется. После `npm install devcontour-harness`:

```sh
# 1. Копия starter + настройка (отдельный baseline-коммит) + pnpm 11.25.0 в <work>/tools,
#    рядом — policy.json, graph.json и context/controller-mode/ (оверлей с provenance)
node node_modules/devcontour-harness/examples/turbo-starter/setup.mjs \
  --work ./ts --source https://github.com/oim-dev/turbo-starter
# 2. Обычный путь harness (writer/reviewer — настоящие codex/claude из PATH)
cd ts && export PATH=$PWD/tools/node_modules/.bin:$PATH   # npx найдёт harness проекта выше по дереву
npx harness validate --graph graph.json --policy policy.json
npx harness run --graph graph.json --policy policy.json --state state --sink file:results
npx harness result --state state --work issued-at
```

Источник можно заменить локальным зеркалом (`--source <path>` или
`STARTER_SOURCE`). Копия клонируется с `--no-local`, после clone у неё
удаляется `origin`, поэтому источник не меняется. Настройка из `.harness/`
фиксируется отдельным коммитом `fixture: devcontour-harness
turbo-starter-setup/v1` с фиксированными автором и датой. При одинаковых
входах получается один и тот же baseline SHA. Манифест копии
(`<work>/fixture.json`) записывает upstream, baseline и sha256 каждого
файла настройки.

`--warm` один раз прогревает pnpm store и dlx-кэш генератора
(`@gromlab/rest-api-codegen@5.2.4`) на основном checkout копии. Без
прогрева `pnpm install --offline` в попытке на холодной машине упадёт с явной
ошибкой.

### Библиотека подготовки (для W01 и своих сценариев)

`examples/turbo-starter/setup.mjs` (только встроенные модули Node, запускается
обычным `node`, импортируется как ES-модуль):

- `prepareStarterFixture({ workDir, source?, commit?, installPnpm?, warm? })`
  возвращает `{ repo, baselineSha, upstream, pathPrepend, env, manifest }`.
- `starterPolicy(fixture, { template?, targetRef?, scenario?, repoPath?, edit? })`
  возвращает политику примера. `scenario` подключает fixture runtime
  (`FIXTURE_SCENARIO`).
- `starterGraph({ edit? })` возвращает граф примера, например для
  отображения поручения Relay.
- `changeFiles(fixture, 'issued-at.patch')` возвращает файлы изменения
  (`путь → содержимое`) для шага fixture writer.
- `controllerContext(fixture, dir)` создаёт источник контекста
  `controller-mode` с provenance; `writeLayout(fixture, options?)` пишет
  `policy.json`, `graph.json` и контекст рядом с копией.
- `approve()` и `implement(files)` возвращают шаги сценария управляемых
  (fixture) runtime для повторяемых прогонов без модели.

<!-- repo-only -->

В checkout harness типы библиотеки — `scripts/acceptance/starter-fixture.d.mts`;
`scripts/acceptance/starter-fixture.mjs` реэкспортирует её для сценариев
приёмки, fixture runtime — `tests/fixtures/bin/fake-*`. Это инструменты
разработки harness, в архив они не входят.

<!-- /repo-only -->

## Gates и кэш

| Gate                    | Команда                                                                       | Что доказывает                                                                   |
| ----------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `backend-types`         | `pnpm --filter @oim/nest-backend check-types`                                 | Backend компилируется (`prisma generate && tsc --noEmit`)                        |
| `sdk-generation` (test) | `node --test --test-reporter=junit … .harness/acceptance/generation.test.mjs` | Закоммиченные OpenAPI и оба SDK совпадают с выходом `pnpm rest-api-sdk:generate` |
| `sdk-build`             | `pnpm --filter @oim/client-rest-api-sdk run build`                            | Web импортирует SDK из `dist`                                                    |
| `web-types`             | `pnpm --filter @oim/next-web-app run check-types`                             | Потребитель frontend типизирован против SDK                                      |
| `acceptance` (test)     | `node --test --test-reporter=junit … .harness/acceptance/issued-at.test.mjs`  | 5 testcases: поле в OpenAPI и SDK обоих realm, потребитель                       |

- JUnit пишет встроенный reporter Node 24, отдельные зависимости не нужны.
  Отчёты лежат в `.artifacts/junit/` (ignored в starter). Harness удаляет
  старый отчёт до запуска и принимает только свежий непустой отчёт на
  проверяемом SHA.
- Turbo-кэш не участвует. Gates вызывают pnpm-фильтры напрямую, поэтому
  результата из кэша (cache hit) нет. Каждая попытка ставит свои
  `node_modules` в своём worktree. Общими между попытками остаются только
  неизменяемый pnpm store и dlx-кэш. Если gate вызывает `turbo run`,
  передавайте `--force`, иначе cache hit не докажет свежести.
  `pnpm exec turbo` предварительная проверка toolchain сейчас отклоняет:
  `turbo ^2.11.6` в package.json starter не закреплён, хотя lockfile
  закрепляет 2.11.6.
- Gate `acceptance` поставляется примером, а не upstream:
  `apps/nest-backend/AGENTS.md` запрещает добавлять тесты в backend.

## Генерация и область записи (S02)

`generatedPaths` в harness означает «защищено»: путь из этого списка не
даёт права его менять. Поэтому выходы генерации OpenAPI и SDK туда **не**
входят. Схема такая:

1. **Явное разрешение поручения.** `writeScope` поручения включает исходники
   изменения и выходы генерации:
   `apps/nest-backend/openapi`, `packages/{client,admin}-rest-api-sdk/src/generated`.
   Без этого изменение генерации отклоняется как выход за область.
2. **Защита входов генератора.** `protectedPaths` включает
   `apps/nest-backend/src/export-openapi.ts`, `package.json` обоих SDK, где
   закреплена версия codegen, lockfile, `.harness/` и AGENTS.md. Попытка не
   может подменить генератор или проверку.
3. **Доказательство детерминизма.** Gate `sdk-generation` на candidate и на
   integration SHA запускает штатную генерацию и сверяет `git diff` и
   неотслеживаемые файлы по каждому пути выхода. Затем он возвращает
   дерево к проверяемому коммиту. Устаревший или вручную правленый выход
   отклоняется с указанием пути.
4. **`generatedPaths` по назначению.** Там остаётся только
   `apps/nest-backend/src/generated`, клиент Prisma. Его никто не правит и не
   коммитит (он ignored).

Проверки области и защищённых путей не выключаются. Защищённый путь важнее
`writeScope`.

## Lifecycle-мост для существующего worktree (S03, S04, S06)

Starter-команды `worktree:create`/`worktree:up` требуют собственный реестр
`~/worktrees/.state` и свой каталог worktree. Harness их не вызывает и реестр
не подделывает. Worktree создаёт harness. `compose-bridge.mjs` поднимает
среду для уже существующего дерева через шаги lifecycle политики:

```json
"lifecycle": {
  "setup":    [{ "id": "compose-setup",    "command": ["node", ".harness/compose-bridge.mjs", "setup", "--port", "POSTGRES_PORT", "--env", ".harness/env/compose.env.template:compose.env", "--secret", "HX_DB_PASSWORD"] }],
  "ready":    [{ "id": "compose-ready",    "command": ["node", ".harness/compose-bridge.mjs", "ready", "--timeout-ms", "120000"] }],
  "teardown": [{ "id": "compose-teardown", "command": ["node", ".harness/compose-bridge.mjs", "teardown"] }]
}
```

Gates, которым нужна база, запускаются через
`node .harness/compose-bridge.mjs exec -- <команда>`. Команда получает
переменные env-файлов среды и `HX_PROJECT`.

- **Каталог среды.** Harness передаёт шагам lifecycle, `prepare` и gates
  фазы переменную `DEVCONTOUR_ENVIRONMENT_DIR` (псевдоним
  `HARNESS_ENVIRONMENT_DIR`): `<state>/artifacts/<run>/<phase>/environment`.
  Это каталог вне worktree, рядом с receipt harness `environment.json`.
  Переменная сохраняется в receipt, поэтому повторная очистка в новом
  процессе видит тот же каталог. Состояние моста лежит в `bridge/`:
  `receipt.json`, `compose.json` (модель без подстановки значений),
  `labels.json`, `env/*.env` (0600) и `diagnostics/`.
- **Уникальность.** Проект называется
  `hx-<runId 12>-<phase>-<repository>`, своё имя на каждую попытку и фазу.
  Порты выделяются свободными на `127.0.0.1` и отмечаются в реестре моста
  (`$TMPDIR/devcontour-compose-bridge/ports`). Это защищает от гонки
  «порт выделен, но ещё не занят». Тома и сеть принадлежат проекту.
- **Владение.** Каждый сервис, том и сеть получают метки
  `devcontour.harness.run`, `devcontour.harness.phase`,
  `devcontour.harness.repository` и `devcontour.harness.project`. Модель
  проверяется до создания: `container_name`, bind mount, внешние тома и
  сети, `network_mode: host` и `privileged` отклоняются.
- **Порядок.** setup (намерение в receipt → порты → env → `compose create`)
  → ready (`up -d --wait --wait-timeout`) → `prepare` → gates → ревью →
  teardown. До ready gates не запускаются. При отказе ready сохраняются
  `ps` и `logs` с замаскированными секретами.
- **Очистка.** Сначала выполняется `compose down --volumes --remove-orphans`
  по снимку модели. Затем то, что осталось, удаляется по меткам, причём
  только при совпадении обеих меток, run и project. `docker prune` не
  вызывается, контекст Docker не меняется, чужие контейнеры и тома не
  трогаются. Env-файлы удаляются при любом исходе teardown. Receipt
  сохраняет, что удалено и что осталось.
- **Окружение и секреты.** Шаги и gates получают только `inherit/values/secrets`
  политики, переменные harness `DEVCONTOUR_*` и `HARNESS_*` и минимальную
  базу (`PATH`, `HOME`, `TMPDIR`, `USER`, `LOGNAME`, `CI`); test-gates
  дополнительно получают от harness `TURBO_FORCE` и `GOFLAGS=-count=1`
  (свежесть, не секреты). Секрет задаётся
  именем переменной оператора (`"secrets": {"HX_DB_PASSWORD": "HX_DB_PASSWORD_SOURCE"}`).
  Его значение маскируют harness (логи шагов и gates, evidence, итог) и мост
  (диагностика). В receipt попадают только имена переменных env-файлов.

### Порядок принятия и очистки (S04)

Harness принимает попытку **после** teardown. Teardown candidate и integration
выполняются до CAS-продвижения target ref. Отсюда:

- сбой setup, ready или gates означает, что попытка не принята, а
  teardown выполняется всё равно;
- сбой teardown тоже означает отказ (`CleanupFailure`). Target ref не
  двигается, и Git-история не переписывается. Receipt получает статус
  `cleanup-failed`, а в `cleanup-pending.json` перечисляются сохранённые
  worktree. Ресурсы среды остаются, и это видно;
- если процесс убит при активной среде, receipt остаётся `active`. Новый
  процесс с тем же state вызывает `Harness.cleanup(runId)`
  (`Runner.finishCleanup`). Тот истекает попытку с просроченной арендой,
  повторяет teardown по receipt только при мёртвом владельце и убирает
  worktree. Повторный вызов безопасен и возвращает `nothing-pending`.
  Evidence и логи сохраняются. Пример запуска (поставляется в пакете):
  `node node_modules/devcontour-harness/examples/turbo-starter/cleanup.mjs --state <state> --run <runId>`.

Состояния «принято» и «очистка не завершена» поэтому не совпадают по
времени: принятая попытка уже прошла очистку своих сред. Остаётся
единственный случай, когда после принятия не удаляется worktree попытки
(`reason: remove-failed`). Он доводится той же очисткой и не трогает
принятый ref.

## Controller mode (S05)

AGENTS.md starter обязывают агента самому создавать worktree, коммитить и
сливать изменения и вести историю Relay. Под harness эти операции выполняет
controller. Оверлей `templates/controller-mode/AGENTS.controller.md` v1
подключается **источником контекста**, а не файлом в репозитории (starter
запрещает новые `.md` файлы):

- `context/controller-mode/AGENTS.controller.md` содержит неизменённый
  оверлей. Он вкладывается в запросы writer и обоих reviewer;
- в `context/controller-mode/references/**/AGENTS.md` лежат копии product
  AGENTS.md. Они закреплены sha256, но в запрос не вкладываются: worker
  читает живые файлы своего worktree;
- `context/controller-mode/provenance.json` содержит версию и sha256
  оверлея, baseline SHA и blob каждого product AGENTS.md;
- в каждом поручении указан `"context": ["controller-mode"]`; для задач
  Relay — в `tasks[].context` коннектора ([connectors](connectors.md#локальные-пакеты-контекста)).

Оверлей перечисляет правила, делегированные controller-у: worktree, commit,
merge, история Relay, `pnpm run setup`, вложенные оркестраторы и `harness`.
Остальные правила продукта продолжают действовать (архитектура, запрет
ручных правок generated, lockfile). В запросе worker есть только запрет
делать commit. Обязанности коммитить в нём нет. Harness проверяет это
независимо от текста: commit worker-а или смена HEAD дают
`scope-violation`, и сценарий это проверяет.

## Известные ограничения upstream

- `scripts/check-env.mjs` (`pnpm env:check`, часть корневого `pnpm lint`)
  падает на Node 24.3.0: `fs.globSync` не находит dotfiles. На Node 24.22.1
  проверка проходит. Пример корневой `pnpm lint` не использует и обходится
  явными pnpm-фильтрами. Патч upstream не нужен.
- `react-admin-panel` `check-types` скачивает `@gromlab/svg-sprites` через
  `npx --yes`, поэтому нужна сеть. В gates примера этот пакет не участвует.
- Изоляция gates в примере выключена (`isolation.mode: none`). pnpm store,
  dlx-кэш и Docker socket лежат вне worktree. Песочница ОС для них
  потребует отдельного списка путей и доменов.

<!-- repo-only -->

## Сценарии приёмки

| ID            | Скрипт                               | Что выполняется                                                                                                                                                                                |
| ------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01, S02, S05 | `scripts/acceptance/starter-s01.mjs` | Позитивный прогон через operator approval (`review-plan`, `approve`, `run`); несовместимый потребитель; область записи, защищённый путь, устаревший и вручную правленый выход; commit worker-а |
| S03           | `scripts/acceptance/starter-s03.mjs` | Две параллельные попытки с отдельными базами, барьер read-back, контрольный контейнер fixture                                                                                                  |
| S04           | `scripts/acceptance/starter-s04.mjs` | Контрольный прогон, сбой setup после create, таймаут ready, сбой gate, сбой teardown, SIGKILL и очистка новым процессом                                                                        |
| S06           | `scripts/acceptance/starter-s06.mjs` | Canary-значения, отказ с выводом секрета, явный повтор, доставка, поиск canary во всех артефактах                                                                                              |

Обёртка `tests/integration/starter-acceptance.test.ts` проверяет каждый
сценарий отдельным тестом. Без Docker или источника upstream тест падает с
`BLOCKED`, а не пропускается. Быстрые тесты без Docker и pnpm лежат в
`tests/starter-{setup,bridge,lifecycle}.test.ts`.

W01 (оба Relay) — `scripts/acceptance/w01.mjs relay-v1|relay-v2` и
`tests/integration/w01-relay-{v1,v2}.test.ts`: тот же Starter, публичный CLI
`source-*`, восстановление доставки и конфликт постановки.

<!-- /repo-only -->
