# Проверки reviewer (`run_check`) и объявленные gates

Reviewer кода, которому профиль разрешает запускать команды, получает MCP-инструмент
`devcontour_probe.run_check`. Его исполняет controller: песочница ОС, исходники только для
чтения, предел на команду, общий бюджет проверок и резерв времени на заключение.

## Два вида вызова

| Вызов                           | Что исполняется                                                                | Куда можно писать                           |
| ------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| `{"argv": ["node", "-e", "…"]}` | исследовательская команда reviewer, без shell, в корне проверяемого дерева     | только собственный `TMPDIR`                 |
| `{"gate": "domain"}`            | объявленный gate из эффективной политики: его `command`, `cwd`, окружение фазы | только scratch отчёта controller и `TMPDIR` |

Других полей нет: `env`, `cwd`, `reportPath`, `write`, `scope` и любые неизвестные поля —
ошибка протокола (`-32602`), ничего не запускается. Можно передать `timeoutMs`, но он только
уменьшает предел controller. Неизвестный ID и генеративный gate (`property`) — результат
`rejected`, бюджет не тратится.

Запрос reviewer содержит готовый вызов для каждого объявленного gate, например:

```text
To run a declared gate, call run_check with exactly {"gate":"domain"}, {"gate":"api"} (one gate per call).
```

## Что делает controller при `{"gate": "<id>"}`

1. Берёт gate из спецификации probe (копия gates поручения из эффективной политики).
2. Проверяет `cwd`: реальный путь внутри проверяемого дерева, иначе `rejected`.
3. Если путь отчёта зашит в argv (см. ниже) — не запускает, возвращает ошибку среды с рецептом.
4. Создаёт каталог evidence `<каталог ревью>/probe-runs/<runId>/` (вне дерева, без перезаписи) и
   уникальный scratch `dc-probe-report-*` во временном каталоге системы.
5. Выставляет `HARNESS_REPORT_PATH` и `DEVCONTOUR_REPORT_PATH` = `<scratch>/<id>.xml`, `CI=1`;
   у `test` gate ещё `TURBO_FORCE=true` и `GOFLAGS=… -count=1`, как у gate движка.
6. Запускает команду в песочнице: запись — только в scratch и `TMPDIR`; дерево, `.git`,
   каталог controller и прежние `.reports/*.xml` закрыты на запись.
7. Читает отчёт: symlink, жёсткая ссылка, путь вне scratch — `unsafe` (не читается); файл старше
   запуска — `stale`; не JUnit или без testcases — `corrupt`; нет файла — `missing`.
8. Сохраняет замаскированную копию отчёта (`<id>.xml`), журнал (`<id>.log`) и `run.json`, затем
   удаляет scratch. Таймаут и отмена (`notifications/cancelled`) останавливают процессы проверки,
   evidence сохраняется тоже.

Результат и запись в `probes.jsonl` содержат `runId`, `status`, фактический `argv`, `gate.id`,
`gate.phase`, `gate.sha`, `gate.cwd`, `gate.controllerEnv` (только имена), `gate.report`
(`status`, `path`, `digest` — SHA-256 сохранённых байтов, `tests`, `failures`, `skipped`),
`gate.scratchRemoved` и `log` — журнал controller. `review.json` переносит эти записи в
`probes`; `reproduction.run` находки ссылается на `runId`, а через него — на журнал.

## Бюджет проверок и авария controller

Бюджет проверок общий на логическое ревью (область, фаза, SHA), включая повторы reviewer и
рестарт controller. Учёт — журнал `probes.jsonl` каждого вызова:

1. До запуска команды controller резервирует её предел и синхронно пишет строку
   `{"type":"start","runId","reservedMs","startedAt","pid"}` с fsync. Не удалось записать —
   `error`/`environment`, команда не запускается.
2. Команда и все её потомки получают `HARNESS_PROBE_RUN=<runId>`.
3. Строка исхода (обычная запись запуска) разрешает резерв фактической длительностью.
4. Новый controller перед следующим вызовом reviewer считает расход: завершённые — по
   длительности, начатые без исхода — **весь резерв** (время до гибели не известно точно и не
   больше резерва; засчитывается верхняя граница). Пережившие процессы такого запуска (по метке
   и их группам процессов) останавливаются, в журнал дописывается
   `{"type":"abandoned","runId","chargedMs"}`; повторное восстановление расход не меняет, а
   строка исхода, пришедшая позже, заменяет списание фактом без двойного счёта.
5. Следующий вызов получает бюджет `budget − spent` и прежний срок логического ревью; остаток
   меньше секунды — вызов без инструмента проверок.

Ограничение: на macOS `ps -E` не показывает окружение системных бинарников (например,
`/bin/sleep`); такой процесс останавливается, если он в группе процессов запуска.

## Статусы

| `status`                       | `failure`     | Смысл                                                                                                                                   |
| ------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `passed`                       | —             | код 0 и (для gate с отчётом) свежий JUnit без failures и skips                                                                          |
| `failed`                       | —             | код ≠ 0 или упали testcases: наблюдение о коде                                                                                          |
| `failed`                       | `report`      | код 0, но отчёт `missing`/`stale`/`corrupt`/`unsafe`: не прохождение и не находка в коде                                                |
| `error`                        | `environment` | путь отчёта зашит в argv, отказ записи (EPERM/EACCES) мимо `HARNESS_REPORT_PATH`, отказ scratch, сеть закрыта песочницей, нет песочницы |
| `timeout`, `cancelled`         | —             | команда остановлена вместе с потомками                                                                                                  |
| `budget-exhausted`, `rejected` | —             | команда не запускалась                                                                                                                  |

Ошибка среды и ошибка отчёта — не находка в коде; находка, сославшаяся на запуск с
`failure: environment`, не получает `observed`.

**Probe — наблюдение reviewer.** Обязательные gates candidate и integration запускает и
оценивает движок; probe не записывает evidence gate, не ставит технический PASS и не двигает
target ref.

## Рецепт: путь отчёта из переменной controller

Gate пригоден для probe, если команда пишет JUnit в `HARNESS_REPORT_PATH` (или
`DEVCONTOUR_REPORT_PATH`). Gate движка получает ту же переменную с путём `report.path` внутри
дерева, поэтому рецепт с прежним путём по умолчанию не меняет поведение gate движка.

Controller не ищет и не заменяет подстроки в argv. Если элемент argv целиком или после `=`
(`--junitxml=…`) совпадает с `report.path` относительно `cwd` gate, probe возвращает
`error`/`environment` с номером аргумента и рецептом, не запуская команду. Если путь зашит в
скрипт (package script), запуск идёт, запись в дерево получает EPERM, и результат —
та же ошибка среды с рецептом.

| Инструмент                                                              | Сейчас в профилях/примерах                                                          | Пригодно для probe                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| demo runner (`test/run-tests.mjs`)                                      | читает `DEVCONTOUR_REPORT_PATH`/`HARNESS_REPORT_PATH`, иначе `.reports/<suite>.xml` | да, как есть                                                                                                                                                                                        |
| npm (`profiles/npm-ci.json`, `examples/toolchains/npm`)                 | `npm run test` → `--test-reporter-destination=.reports/junit.xml` в package script  | `"test": "node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=${HARNESS_REPORT_PATH:-.reports/junit.xml} test/*.test.js"`         |
| pnpm (`profiles/pnpm-frozen.json`, `examples/toolchains/pnpm`, `turbo`) | тот же путь в package script пакета                                                 | то же в script пакета; для вложенного пакета — абсолютный `HARNESS_REPORT_PATH` не зависит от каталога                                                                                              |
| Go (`profiles/go-gotestsum.json`)                                       | `["gotestsum", "--junitfile", ".reports/junit.xml", "--", "-count=1", "./..."]`     | `["sh", "-c", "GOCACHE=\"${GOCACHE:-$TMPDIR/go-build}\" exec gotestsum --junitfile \"${HARNESS_REPORT_PATH:-.reports/junit.xml}\" -- -count=1 ./..."]`                                              |
| Python (`profiles/python-uv.json`)                                      | `["uv", "run", "--no-sync", "pytest", "--junitxml=.reports/junit.xml"]`             | `["sh", "-c", "PYTHONDONTWRITEBYTECODE=1 UV_CACHE_DIR=\"${UV_CACHE_DIR:-$TMPDIR/uv}\" exec uv run --no-sync pytest -p no:cacheprovider --junitxml=\"${HARNESS_REPORT_PATH:-.reports/junit.xml}\""]` |
| mixed-python (`cwd: backend`)                                           | `--junitxml=../.reports/backend.xml`                                                | `--junitxml="${HARNESS_REPORT_PATH:-../.reports/backend.xml}"` через `sh -c`                                                                                                                        |

Рецепты npm, Go и Python проверены на настоящих инструментах под песочницей ОС
<!-- repo-only -->(`tests/integration/probe-recipes.test.ts`)<!-- /repo-only -->: команда профиля даёт `error`/`environment` (для

npm — после EPERM записи из package script), рецепт проходит в probe со свежим JUnit вне
дерева и в gate движка с отчётом в дереве. Под `isolation.mode: os` cache Go и uv по умолчанию
лежит вне доступного на запись, поэтому рецепт направляет `GOCACHE`/`UV_CACHE_DIR` в `TMPDIR`
(если они не заданы), а pytest — без `.pytest_cache` и байткода в дереве. pnpm и turbo
используют тот же механизм package script, что и npm; отдельным прогоном не проверялись.

Встроенные профили не меняются (их байты закреплены digest). Для них probe по ID даёт
проверяемую диагностику вместо EPERM; gate движка работает как прежде. Новый профиль с рецептом —
новый файл и новый ID.
