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
5. Выставляет `HARNESS_REPORT_PATH` и `DEVCONTOUR_REPORT_PATH` = `<scratch>/<id>.xml`,
   `DEVCONTOUR_PROPERTY_REPORT` = `<scratch>/<id>.property.json` (то же имя, что у gate движка),
   `CI=1`; у `test` gate ещё `TURBO_FORCE=true` и `GOFLAGS=… -count=1`, как у gate движка.
   Проверка, которая пишет отчёт свойств по пути из переменной, под probe пишет его в scratch, а
   не получает EPERM в дереве только для чтения. `DEVCONTOUR_SEED`, `DEVCONTOUR_PROPERTIES` и
   `DEVCONTOUR_CORPUS` probe не выставляет: генеративные gate он не исполняет.
6. Запускает команду в песочнице: запись — только в scratch и `TMPDIR`; дерево, `.git`,
   каталог controller и прежние `.reports/*.xml` закрыты на запись.
7. Читает отчёт: symlink, жёсткая ссылка, путь вне scratch — `unsafe` (не читается); файл старше
   запуска — `stale`; не JUnit или без testcases — `corrupt`; нет файла — `missing`.
8. Сохраняет замаскированную копию отчёта (`<id>.xml`), отчёта свойств, если он записан
   (`<id>.property.json`, `gate.propertyReport` = `{path, scope: "probe-only"}`: движок его не
   читает), журнал (`<id>.log`) и `run.json`, затем
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

## Итог `inspection`: что reviewer действительно выполнил

`review.json.inspection` и `EvidenceRecord.inspection` ревью кода — один и тот же объект. Его
собирает controller для **одного вызова reviewer** из двух наблюдений: событий runtime этого
вызова (Codex `item.completed`/`command_execution`) и журнала проверок `probes.jsonl` этого
вызова. Самоотчёт модели (`execution.commands`, `reproduction.executed`, runId в тексте) ничего
не подтверждает.

- `mode: commands` — подтверждена хотя бы одна выполненная команда; `reason: null`. Ненулевой
  код, таймаут или отмена после старта и ошибка среды после старта выполнение не отменяют.
- `mode: diff-only` — подтверждённых выполнений нет; `commands: []`, `reason` объясняет.
- `commands` — не PASS: тесты могли упасть, gates и вердикт оценивает движок. Принятие по-прежнему
  зависит только от обязательных gates и валидного вердикта; `commands` не лечит невалидный ответ,
  изменённое дерево или проваленный gate, а неуспешный probe сам не создаёт находку.

### Граница старта

Запуск probe засчитывается по признаку `started` из `runCheck`: без песочницы — процесс порождён
(событие `spawn`), в песочнице — обёртка создала метку старта перед `exec` (запуск самой обёртки
не считается). Признак отмечается на границе и переживает исключение после неё.

| Событие                                                                                   | В `commands` |
| ----------------------------------------------------------------------------------------- | ------------ |
| Команда завершилась с любым кодом                                                         | да           |
| `timeout`/`cancelled` после старта (код `null`, частичный вывод)                          | да           |
| `error`/`environment` после старта (сеть закрыта песочницей, EPERM, сбой записи evidence) | да           |
| `failed`/`report`: код 0, JUnit отсутствует или испорчен                                  | да           |
| Неизвестный gate, бюджет исчерпан, нет executable, отказ песочницы или scratch до старта  | нет          |
| Вызов отменён до запуска (`cancelled`, команда не исполнялась)                            | нет          |
| Только резерв `start`, `abandoned`, битая строка, объект без формы исхода                 | нет          |

Незасчитанные записи перечислены в `inspection.excluded` с причиной; полная диагностика — в
`review.json.probes` и журнале.

### Форма

| Смысл                           | JSON path              | Тип и значения                                                                                                                                                                       |
| ------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Источник итога                  | `source`               | `codex-events`, `unavailable` (прежние), `controller-probes`, `runtime-and-controller`                                                                                               |
| Вызов reviewer                  | `context`              | `{attempt, phase: candidate\|integration, sha, call}`; `attempt` — ID попытки, не runId probe                                                                                        |
| Все подтверждённые операции     | `total`                | целое ≥ 0                                                                                                                                                                            |
| Происхождение команды           | `commands[].origins[]` | `{type: "runtime", runtime, item: string\|null}` или `{type: "controller", runId}`                                                                                                   |
| Код выхода                      | `commands[].exitCode`  | целое или `null` (неизвестен: таймаут, отмена, старая проекция без кода)                                                                                                             |
| Исход                           | `commands[].status`    | `completed`/`failed` (runtime); `passed`/`failed`/`timeout`/`cancelled`/`error` (probe)                                                                                              |
| Неуспех не в коде               | `commands[].failure`   | `environment`, `report`                                                                                                                                                              |
| Gate                            | `commands[].gate`      | ID объявленного gate                                                                                                                                                                 |
| Пояснение controller            | `commands[].note`      | строка ≤ 2000                                                                                                                                                                        |
| Не засчитано                    | `excluded[]`           | `{runId, status, reason}`, `reason`: `not-started`, `legacy-unconfirmed`, `foreign-scope`, `unknown-status`, `unfinished`, `abandoned`; не более 100, полное число — `excludedTotal` |
| Строки журнала без формы исхода | `invalid`              | целое ≥ 0                                                                                                                                                                            |

Пределы: не более 100 команд; `command` ≤ 12000 символов; `output` ≤ 4000 (stdout и stderr через
перевод строки, при нехватке места — хвосты обоих примерно поровну); `note` ≤ 2000. Потоки probe
в журнале по-прежнему ограничены хвостом 8000 с маркером `…`. Порядок: команды runtime в порядке
потока, затем запуски probe в порядке журнала; при превышении сохраняются последние 100, а
`mode` вычисляется по всему набору. Пользовательский текст маскируется до обрезки; перечисления и
идентификаторы controller не маскируются.

### Идентичность и область

Операция одна только при надёжной идентичности: один runId probe; один item ID в потоке runtime;
явная структурированная связь наблюдения runtime с runId probe (origin `controller` у команды
runtime) — тогда у операции оба происхождения. Одинаковый argv с разными runId — две операции;
совпадение текста, вывода или замаскированных аргументов не склеивает.

Каждый исход в журнале несёт `scope: {attempt, phase, sha, call}`. Запись с явно чужими
попыткой, фазой, SHA или вызовом (или gate с чужими `phase`/`sha`) не засчитывается
(`excluded`, `foreign-scope`). `call-2` не получает команд `call-1`, integration — команд
candidate; общий бюджет проверок логического ревью по-прежнему считается по журналам всех вызовов.

### Старые записи

Прежние `inspection` (без новых полей, в том числе противоречивые `diff-only` с командой) и
evidence без `inspection` читаются как есть; чтение не пересчитывает итог, digest и решение.
Для отдельной агрегации старых данных: завершённые события runtime засчитываются как раньше;
записи probe без `started` со статусом `passed`/`failed` — выполнение (код и вывод, если их нет,
остаются неизвестными: `exitCode: null`, пустой `output`); `error`/`timeout`/`cancelled` без
подтверждения старта не засчитываются (`legacy-unconfirmed`) — это ограничение старых данных.
Явный `started: false` главнее правила старых записей.

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
