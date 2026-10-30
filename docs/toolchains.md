# Toolchains целевого проекта

Harness — Node.js-инструмент. Исполняемому проекту не нужны package.json, npm или
JavaScript: gates и шаги подготовки — произвольные argv, каталог gate — `cwd`, окружение —
`environment`. npm и pnpm — менеджеры пакетов, Turborepo — планировщик задач, Go и
Python/uv — отдельные toolchain. Единого «типа проекта» нет: репозиторий описывается
композицией шагов.

| Что                                                             | Где в политике                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Установка зависимостей (locked)                                 | `repositories[].prepare[]` — исполняется в каждом worktree попытки до writer, отдельно для candidate и integration       |
| Команды задач и проверки                                        | `repositories[].gates[]` (`check` / `test` с JUnit)                                                                      |
| Каталог                                                         | `gates[].cwd`; у шага `prepare` — собственный флаг инструмента (`pnpm --dir`, `npm --prefix`, `uv --directory`, `go -C`) |
| Окружение                                                       | `environment` политики/репозитория (`values`, `inherit`, `secrets`)                                                      |
| Проверенные версии инструментов и явный выбор менеджера пакетов | `repositories[].toolchain` (`tools`, `packageManagers`), необязательно                                                   |
| Общие пакеты между worktree без скачивания                      | `repositories[].dependencyStore`, необязательно ([хранилище зависимостей](#хранилище-зависимостей))                      |

`toolchain` — необязательное аддитивное поле: политики и профили без него сохраняют прежний
digest. `tools` — `{ "gotestsum": "1.12.3" }` (названные компоненты версии совпадают) или
`{ "go": ">=1.24" }` (не ниже). `packageManagers` — `{ ".": "pnpm", "frontend": "pnpm" }`:
явный выбор снимает неоднозначность, когда в каталоге лежат lockfiles нескольких менеджеров.

## Рецепты

Проверенный набор (macOS arm64, Darwin 24.6): Node 24.3.0, npm 11.4.2, pnpm 10.12.3,
Turbo 2.11.10 (devDependency fixture), Go 1.24.5, gotestsum v1.12.3, uv 0.11.28,
CPython 3.12.9 (выбран uv по `.python-version`), pytest 8.4.1, ruff 0.12.4.

| Вариант                        | prepare                                                                                 | gates                                                                                         | Встроенный профиль                                             |
| ------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Node + npm                     | `npm ci`                                                                                | `npm run check`, `npm run test` (JUnit `.reports/junit.xml`)                                  | `npm-ci@0.1.0`                                                 |
| Node + pnpm                    | `pnpm install --frozen-lockfile`                                                        | `pnpm run check`, `pnpm run test`                                                             | `pnpm-frozen@0.1.0`                                            |
| pnpm + Turborepo               | `pnpm install --frozen-lockfile`                                                        | `pnpm exec turbo run check --filter=<pkg>`, `pnpm exec turbo run test --filter=<pkg> --force` | — (фильтры проекта: политика, см. `examples/toolchains/turbo`) |
| Go                             | `go mod download`                                                                       | `go vet ./...`, `gotestsum --junitfile .reports/junit.xml -- -count=1 ./...`                  | `go-gotestsum@0.1.0`                                           |
| Python                         | `uv sync --locked`                                                                      | `uv run --no-sync ruff check .`, `uv run --no-sync pytest --junitxml=.reports/junit.xml`      | `python-uv@0.1.0`                                              |
| pnpm frontend + Go backend     | `pnpm --dir frontend install --frozen-lockfile`, `go -C backend mod download`           | gates с `cwd: frontend` / `cwd: backend`                                                      | — (`examples/toolchains/mixed-go`)                             |
| pnpm frontend + Python backend | `pnpm --dir frontend install --frozen-lockfile`, `uv sync --locked --directory backend` | gates с `cwd: frontend` / `cwd: backend`                                                      | — (`examples/toolchains/mixed-python`)                         |

Правила рецептов:

- Только locked-установка: `npm ci`, `pnpm install --frozen-lockfile`, `uv sync --locked`,
  `go mod download`. Несовместимый lockfile — отказ шага с диагностикой менеджера, lockfile
  не переписывается. `npm install`, `pnpm install` без `--frozen-lockfile`, `uv sync` без
  `--locked`, `uv run` без `--no-sync`, `go get`, `go mod tidy` — проблема preflight.
- Точные версии, без `@latest`, `npx`, `pnpm dlx` без версии, `uvx` без версии, `--if-present`.
  Отсутствующий test task не заменяется build/lint.
- Отчёт gate лежит относительно корня worktree, а не `cwd`: gate `cwd: backend` пишет JUnit в
  `../.reports/backend.xml`, gate объявляет `.reports/backend.xml`. Harness удаляет файл
  отчёта до запуска и передаёт путь в `HARNESS_REPORT_PATH`.
- Один monorepo — одна запись Git repository с разными `cwd`. `consumers` — только для
  действительно отдельных репозиториев.
- Профили языков (`go-gotestsum`, `python-uv`, прежние `go-api`, `python-api`) не наследуют
  npm-подготовку. Слои профиля с разными версиями одного инструмента или разными менеджерами
  одного каталога — отказ разрешения (`Конфликт частей профиля: toolchain.…`).
- Композиция из кода: `composeRepository(own, components, tools)` и `installRecipes` из
  opt-in entrypoint `devcontour-harness/toolchains`.

## Установка harness для Go/Python-проекта

Target-проекту package.json не нужен. Harness ставится в отдельное окружение инструмента.

npm:

```sh
mkdir -p ~/.local/share/harness-tool && cd ~/.local/share/harness-tool
npm init -y >/dev/null
npm install --save-exact devcontour-harness@<версия>
export PATH="$PWD/node_modules/.bin:$PATH"
harness doctor --policy /path/to/project-harness/policy.json
```

pnpm:

```sh
mkdir -p ~/.local/share/harness-tool && cd ~/.local/share/harness-tool
pnpm init >/dev/null
pnpm add --save-exact devcontour-harness@<версия>
export PATH="$PWD/node_modules/.bin:$PATH"
```

Политика и граф могут лежать вне target-репозитория: `repositories[].path` относителен
каталогу политики (`examples/toolchains/go/policy.json` → `"path": "repo"`).

## Cache и изменяемые каталоги

Каждая попытка исполняется в своём worktree (`<state>/repos/<repo>/worktrees/<attempt>` и
`…-integration`; если каталог состояния лежит внутри репозитория — под корнем вне дерева
`<checkoutRoot>/<repo>/worktrees/<attempt>`), и `prepare` устанавливает зависимости заново в нём. Изменяемые артефакты
одной попытки другой не видны.

| Допустимый общий cache (content-addressed, вне worktree)                                               | Изменяемое, только внутри worktree попытки                       |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| npm cache (`~/.npm`), pnpm store, Go module cache (`GOMODCACHE`), Go build cache (`GOCACHE`), uv cache | `node_modules/`, `.venv/`, `.reports/`, `.turbo/`, выходы сборки |

Cache сборки допустим, но не заменяет тест:

- Во время исполнения каждый gate `kind: test` получает `TURBO_FORCE=true` и `GOFLAGS`,
  оканчивающийся на `-count=1` (после значения политики). Окружение наследуют все потомки, так
  что защита действует при любой обёртке (package script, `pnpm --filter … run`, task runner),
  в библиотечном `Harness.run`/`Runner` и в CLI одинаково. Заголовок лога gate записывает
  применённые значения (`fresh={...}`); digest лога входит в evidence. `check` gates cache
  используют как обычно.
- Turbo: preflight дополнительно требует явной свежести в самой команде — `--force`,
  `--cache=` без чтения или `TURBO_FORCE=true` — и находит turbo внутри package scripts
  (напрямую, через `pnpm run`/`npm run`, `pnpm --filter … run`, `pnpm exec`, `npx`). Без неё —
  `CACHE_REPLAY`. Script turbo-проекта, который не разбирается статически (`$(…)`, обратные
  кавычки, конвейер, `sh -c`, `eval`, `xargs`), — `SCRIPT_UNRESOLVED`: угадывать нельзя.
  Проверено T03: при входах задачи без `src` неверная реализация вне harness даёт «cache hit,
  replaying» и зелёный отчёт; тот же script через gate — «cache bypass, force executing» и
  отказ, в том числе через общий `TURBO_CACHE_DIR` и `Harness.run` без CLI.
- Go: команда без `-count=1` в test gate — предупреждение (`warnings`): прежний `go-api`
  продолжает проходить preflight, а свежесть обеспечивает `GOFLAGS` во время gate.

Isolation `os` пишет только в worktree и временный каталог проверки: для Go/uv/pnpm в
песочнице cache-каталоги (`GOCACHE`, `UV_CACHE_DIR`, store) нужно указать доступными или
использовать `isolation.mode: none`, как в примерах. Установка (`prepare`) идёт вне песочницы.

## Хранилище зависимостей

Свежий worktree в песочнице не видит общий store менеджера и скачивает все пакеты заново.
Настройка одной строкой в политике снимает это для pnpm без скрипта в проекте:

```json
{ "id": "app", "dependencyStore": { "manager": "pnpm" } }
```

Необязательные поля: `lockfile` (`pnpm-lock.yaml`), `maxBytes` (8 ГиБ), `timeoutMs` (600 000).
`timeoutMs` — верхний предел, общий для сборки и ожидания чужой сборки; действует ещё и треть
остатка времени фазы: при `runTimeoutMs` 900 000 это 300 000 мс. Проект, чьей сборке этого мало,
поднимает `runTimeoutMs`, иначе получает `miss`.
В `isolation.domains` должен быть реестр, например `registry.npmjs.org`: seed собирается в той же
песочнице, что и проверки. Другой реестр задаётся через `environment` как `npm_config_registry`;
`.npmrc` проекта в сборку не попадает, поэтому реестр, настроенный только там, даёт `miss`.

Проверенные версии pnpm: от 9.15.0, ниже 11.0.0 (настоящие прогоны в песочнице на 9.15.0, 10.11.1,
10.12.3, 10.13.1). pnpm 11 кладёт в store символические ссылки на проекты, а такой seed отклоняется;
pnpm 12 не читает `npm_config_store_dir`. Версия берётся из PATH и из поля `packageManager`; вне
диапазона хранилище не меняет ни окружение, ни дерево, установка идёт как без него, а причина — в
квитанции и предупреждении `doctor`.

Как это работает:

1. Перед `prepare` каждого checkout, а у совместной проверки — перед её gates, harness читает
   lockfile из `targetRef`. Seed этого lockfile есть — используется, нет — собирается:
   `pnpm fetch` в каталоге только с lockfile, поэтому `.npmrc`, `.pnpmfile.cjs` и
   `pnpm-workspace.yaml` проекта не участвуют и его хуки не исполняются. Новый seed начинается с
   клона предыдущего: сдвиг lockfile докачивает только разницу. Параллельные проверки ждут одну
   сборку.
2. Seed клонируется в `<checkout>/.pnpm-store` (копия-при-записи на APFS и reflink-томах, иначе
   обычная копия, если хватает места), копия сверяется с манифестом, менеджер получает путь через
   `npm_config_store_dir`. Каталог скрыт от git собственным `.gitignore`.
3. Gate установки — обычный `pnpm install --frozen-lockfile`. Он берёт пакеты из копии, а чего нет,
   скачивает через прокси песочницы.

| Исход                                                                                                                             | Что происходит                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Seed того же lockfile                                                                                                             | `hit`: скачивать нечего                                                                               |
| Lockfile checkout другой, или сборка нового seed не удалась                                                                       | `partial`: установка докачивает разницу                                                               |
| Seed нет, сборка не удалась, не хватает места                                                                                     | `miss`: обычная установка; очередь не останавливается, попытка не тратится                            |
| Отказ, зависящий от самого lockfile: патчи (`patchedDependencies`, сборка видит только lockfile), пустой seed, seed сверх предела | `miss`; этот lockfile не собирается, пока не изменится                                                |
| Истёк бюджет хранилища: реестр висит или чужая сборка идёт долго                                                                  | `miss` или старый seed; время фазы остаётся работе, отменяет фазу только отмена попытки или оператора |
| Сборка не удалась недавно                                                                                                         | 10 минут новых сборок этого lockfile нет: отказавший реестр не отнимает `timeoutMs` у каждой попытки  |
| Seed изменён                                                                                                                      | Отказ с причиной в `refused`, seed удаляется и собирается заново                                      |
| `isolation.mode: none` или `.pnpm-store` уже есть в дереве                                                                        | `miss`: без границы seed не используется, в занятый путь harness не пишет                             |

Граница доверия:

- Seed строится только из lockfile целевой ветки. Сам harness не даёт кандидату запустить сборку или
  выбрать её содержимое: его lockfile лишь сравнивается с seed.
- **Условие:** шаги `prepare` и `lifecycle` идут на хосте вне песочницы, а на integration — над слитым
  деревом. Шаг, исполняющий код кандидата (скрипт из репозитория), работает с правами controller и
  может изменить seed и базу закреплений. Граница seed держится только там, где эти шаги кода
  кандидата не исполняют. `doctor` предупреждает о `dependencyStore` рядом с непустым `prepare`.
- Seeds лежат под корнем рабочих деревьев или в каталоге состояния, закрытых песочницей на чтение
  и запись. Манифест закреплён digest в базе ресурсов, вне дерева seed.
- Проверяются байты копии, а не источника: те, что прочитает менеджер.
- Копия принадлежит своему checkout, в seed ничего не возвращается. Integration и следующая попытка
  получают новую копию. Поэтому байты seed проверены всегда, а докачанные байты и всё, что
  исполнитель изменил в своём дереве, доверены не больше, чем его `node_modules`: они не выходят
  за пределы этого дерева.

Диск: хранятся два последних по использованию seed в пределах `maxBytes`, остальное и брошенные
сборки убираются при публикации нового. Seed больше предела размера или 150 000 файлов не публикуется. Копия лежит в checkout и входит в
сверку защищённых путей (предел 200 000 элементов), поэтому checkout, который вместе с копией превысил
бы 180 000 элементов, получает `miss`, а не отказ проверки. Копии уходят вместе с
рабочими деревьями. Seeds лежат в `<корень>/<repo>/dependency-store`, а без корня вне дерева — в
`<state>/dependency-store/<repo>`; их можно удалить, когда harness не запущен, и они соберутся заново.

`doctor` предупреждает об отсутствии менеджера и lockfile, о версии вне диапазона и о непустом
`prepare`; это предупреждения: запуск идёт, установка обычная. Эксперимент выполнимости (`spike`)
хранилища не получает: у него нет `prepare`, его команду задаёт оператор. Что в итоге произошло в конкретной фазе, показывает
`dependency-store.json` в её артефактах. Другие менеджеры добавляются записью в таблице `managers`
(`verification/dependency-store.ts`); пока поддержан только pnpm.

## Диагностика: doctor и preflight

`harness doctor --policy policy.json` (или `--state`) добавляет `toolchains[]` — по
репозиторию политики:

- `plan` — каждый шаг и gate: фаза, `cwd`, argv, путь отчёта, поле конфигурации;
- `tools` — внешние инструменты из PATH (найден, версия по пробе, требования и их источник:
  `toolchain.tools`, `package.json#packageManager`, `go.mod#go`) и инструменты среды проекта
  (`turbo` из `package.json`: диапазон допустим, если lockfile закрепляет точную версию,
  иначе `UNPINNED`; `ruff`/`pytest` из `uv.lock`) — последние не запускаются;
- `lockfiles` — каталоги node-проектов, их lockfiles и выбранный менеджер;
- `reports`, `ambiguities` (с `resolvedBy`), `problems`, `warnings`, `configSource`.

Каждая проблема — код, поле (`repositories.0.gates.1.command`) и путь файла проекта:
`TOOL_MISSING`, `TOOL_VERSION`, `TOOL_VERSION_UNKNOWN`, `TOOL_NOT_LOCKED`, `MANIFEST_MISSING`,
`LOCKFILE_MISSING`, `LOCKFILE_AMBIGUOUS`, `SCRIPT_UNKNOWN`, `TASK_UNKNOWN`, `FILTER_UNKNOWN`,
`INSTALL_UNLOCKED`, `UNPINNED`, `IF_PRESENT`, `CACHE_REPLAY`, `REPORT_MISMATCH`,
`COMPOSITION_CONFLICT`, `CWD_MISSING`, `PROJECT_FILE_MISSING`, `REPOSITORY_MISSING`,
`TOOL_IN_PROJECT`, `SCRIPT_UNRESOLVED`.

Диагностика только читает файлы (package.json, pnpm-workspace.yaml, turbo.json, go.mod,
pyproject.toml, uv.lock) и запускает пробы версий внешних инструментов: `<tool> --version`
(`go version`; для Go-бинарника без метки версии — `go version -m <файл>`), в нейтральном
временном каталоге, по одной на инструмент, с пределом 10 с и одним повтором с пределом 20 с, если проба не
уложилась во время (нагрузка). Перед пробой путь инструмента
разрешается до канонического (все symlink файла и каталога PATH): файл внутри любого
репозитория политики (включая его `node_modules/.bin`, `.venv`) или каталога состояния с
worktrees не запускается — проблема `TOOL_IN_PROJECT`. Ни установки, ни генерации, ни новых
файлов.

`doctor` по-прежнему информационный (exit 0, проблемы в `problems`). С политикой он требует
только runtime, назначенные политикой (`reason: "не назначен политикой"` у остальных).
`harness run` выполняет ту же диагностику как обязательный preflight: при любой проблеме —
exit 3, `NOT_READY` с issues `policy.<поле>` до записи `binding.json`, открытия состояния и
вызова runtime.

## Пример и приёмка

`examples/toolchains/<variant>/` — `repo/` (target-проект; `_gitignore` становится
`.gitignore`), `policy.json`, `task.json`, `good/` и `bad/` (реализации для fixture writer).
<!-- repo-only -->

В репозитории harness (не входит в пакет). Сквозной прогон всех семи вариантов через обычный путь harness:

```sh
node --import tsx scripts/acceptance/t01.mjs            # все варианты
node --import tsx scripts/acceptance/t01.mjs go python  # выборочно
```

<!-- /repo-only -->

Нужны npm, pnpm, go + gotestsum, uv в PATH; отсутствующий инструмент — `BLOCKED`.
