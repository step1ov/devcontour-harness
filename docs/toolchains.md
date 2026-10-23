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
`…-integration`), и `prepare` устанавливает зависимости заново в нём. Изменяемые артефакты
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
