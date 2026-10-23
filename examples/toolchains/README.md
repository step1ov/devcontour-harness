# Toolchains: семь вариантов target-проекта

Каждый каталог — маленький target-проект с детерминированной функцией `label(n)` и поручением
дополнять номер нулями до трёх знаков (`item-007`). Тесты проекта уже описывают новое
поведение и защищены от записи.

| Каталог        | Проект                                                            | Установка                        | Проверки                                                    |
| -------------- | ----------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `npm`          | Node + npm                                                        | `npm ci`                         | `npm run check`, `npm run test` (node --test, JUnit)        |
| `pnpm`         | pnpm workspace, локальный бинарник `fx-check`                     | `pnpm install --frozen-lockfile` | `pnpm run check`, `pnpm run test` (фильтр `@fx/label`)      |
| `turbo`        | pnpm + Turborepo 2.11.10                                          | `pnpm install --frozen-lockfile` | `turbo run check/test --filter=@fx/label`, test — `--force` |
| `go`           | Go-модуль без package.json                                        | `go mod download`                | `go vet`, `gotestsum … -- -count=1`                         |
| `python`       | uv-проект без package.json                                        | `uv sync --locked`               | `ruff check`, `pytest --junitxml`                           |
| `mixed-go`     | один Git root: pnpm `frontend/` + Go `backend/` + `contract/`     | оба рецепта                      | gates с `cwd`, проверка контракта                           |
| `mixed-python` | один Git root: pnpm `frontend/` + Python `backend/` + `contract/` | оба рецепта                      | gates с `cwd`, проверка контракта                           |

Состав каталога: `repo/` — target-проект (`_gitignore` при подготовке становится
`.gitignore`), `policy.json` — политика (`path: "repo"`), `task.json` — поручение и требования
с `testId`, `good/` и `bad/` — файлы, которые пишет fixture writer в положительном и
отрицательном прогоне.

<!-- repo-only -->

В репозитории harness (не входит в пакет). Сквозной прогон через обычный путь harness (нужны npm, pnpm, go + gotestsum, uv):

```sh
node --import tsx scripts/acceptance/t01.mjs
```

<!-- /repo-only -->

Подробности — `docs/toolchains.md`.
