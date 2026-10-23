# Самостоятельный проект

Как подготовить существующий Git-репозиторий npm или pnpm к работе с harness
без внешнего хоста: пользователь называет репозиторий, цель и ограничения,
остальное агент получает от `harness init`. Пошаговый маршрут для агента —
skill [`skills/harness/SKILL.md`](../skills/harness/SKILL.md).

## Установка вне проекта

Пакет ставится в отдельный каталог инструментов, а не в зависимости проекта:
`package.json` и lockfile проекта не меняются.

```sh
npm install --prefix <tooldir> --omit=dev --ignore-scripts ./devcontour-harness-<version>.tgz
H=<tooldir>/node_modules/.bin/harness
$H --version
$H doctor
```

## `harness init`

```sh
$H init --repository <repo> --plan   # только план, ничего не пишет
$H init --repository <repo>          # create-only запись .harness/
```

Профиль: `--profile`, иначе сохранённый в manifest, иначе по lockfile — только
`package-lock.json` даёт `npm-ci`, только `pnpm-lock.yaml` — `pnpm-frozen`;
оба lockfile или ни одного — `NOT_READY` (`stack-ambiguous` /
`stack-unsupported`). Версия менеджера пакетов берётся из
`package.json#packageManager`, без него — из закрепления профиля. Writer —
`--writer claude` (по умолчанию) или `codex`; reviewer всегда другого вендора.
Политика генерируется из профиля и проверяется toolchain inspection: нет
script или подходящей версии инструмента — точная диагностика `NOT_READY`, а
не ослабленная политика.

| Путь                               | Что                                            | Запись                                     | Под Git         |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------------ | --------------- |
| `.harness/.gitignore`              | исключает `project.json`                       | create, существующий сохраняется           | да              |
| `.harness/README.md`               | что лежит в каталоге и как продолжить работу   | create, существующий сохраняется           | да              |
| `.harness/policy.json`             | `ExecutionPolicy` из профиля                   | create; настройку агента не перезаписывает | да              |
| `.harness/project.json`            | manifest: решения init и абсолютный путь state | последним; повтор — только байтово тот же  | нет (локальный) |
| `.harness/work/*.json`             | графы поручений                                | пишет агент                                | по выбору       |
| `.harness/work/context/notes/*.md` | заметки, только при необходимости              | пишет агент                                | по выбору       |
| state                              | состояние исполнения                           | создаёт `run`                              | вне репозитория |

State по умолчанию — `<state home>/projects/<projectId>`, где state home —
`HARNESS_STATE_HOME`, иначе `$XDG_STATE_HOME/devcontour-harness`, иначе
`~/.local/state/devcontour-harness`; `projectId` — `p-` и 16 hex sha256 от
realpath корня, поэтому повтор и новая сессия находят тот же state.
`--state` внутри репозитория отклоняется: worktrees попыток не должны
вкладываться в checkout.

`init` не трогает `AGENTS.md`, `CLAUDE.md`, корневой `.gitignore`, lockfile и
`package.json` и не делает коммитов. Ответ `data` (`cliDataSchemas.init`):
`mode`, `status` до вызова (`new`, `partial`, `complete`), `files` с действием
по каждому файлу, `conflicts`, `created`, `preserved`, `manifest`, `profile`,
`facts` (репозиторий, target ref, роли, gates, каталоги работы и заметок,
путь шаблона графа пакета), `toolchain` и `next` — готовые вызовы `doctor`,
`validate`, `run`, `status`, `explain`.

Отказы, все до записи, в этом порядке:

1. Не каталог или не верхний уровень Git — `INVALID_INPUT` (`not-git-root`).
2. Нет коммитов — `NOT_READY` (`no-commits`).
3. Репозиторием уже владеет другой controller — `CONTROLLER_BUSY`; второй
   controller и state не создаются.
4. Невалидный существующий manifest — `INVALID_INPUT` с путём.
5. Профиль не определён — `NOT_READY` (`stack-ambiguous`, `stack-unsupported`).
6. `--state` внутри репозитория — `INVALID_INPUT` (`state-inside-repository`).
7. Невалидный существующий `.harness/policy.json` (в том числе обрыв посреди
   записи) — `INVALID_INPUT` с путём; файл не перезаписывается.
8. Конфликты плана — `PATH_CONFLICT`, все конфликты в `issues` с абсолютными
   путями: `symlink`, `ancestor-not-directory`, `not-regular-file`,
   `content-differs`, `outside-root`.
9. Проблемы toolchain — `NOT_READY`.

С `--plan` пункты 8–9 не бросаются: ответ `ok: true` с данными, exit 3 при
конфликтах или неготовом toolchain. Иное решение при существующем manifest
(другой `--writer`, профиль с другим digest) — `content-differs` на
`project.json`: решение меняется явно, файл не перезаписывается. Повтор с
теми же решениями даёт `created: []`; после прерывания дописывается
недостающее.

## Граф, запуск, результат

Граф пишется в `.harness/work/<id>.json` по шаблону `templates/graph.json` установленного пакета;
`repositoryId`, роль, gates и область записи берутся только из `facts`.

```sh
$H validate --graph .harness/work/<id>.json --policy .harness/policy.json
$H run --graph .harness/work/<id>.json --policy .harness/policy.json \
  --state <manifest.paths.state> --author claude
$H result --state <manifest.paths.state> --work <order-id>
```

`result.outcome: accepted` и `result.shas.result`, равный
`git rev-parse refs/heads/harness/accepted`, — приёмка; зелёный exit сам по
себе ею не является.

## `harness explain`

```sh
$H explain --state <state> --policy .harness/policy.json [--work <id>] [--human]
```

Только чтение: без повторов, вызовов моделей и изменений попыток, бюджетов,
очереди, событий и refs. Отсутствующий state — `NOT_FOUND`, каталог не
создаётся. Пробу runtime выполняет так же, как `doctor` (`--version`, не вызов
модели). `data.diagnoses[]` (`cliDataSchemas.explain`,
`schemas/stop-diagnosis.schema.json`):

| Поле           | Значение                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `code`         | `ErrorCode` остановки                                                                                                   |
| `cause`        | класс сбоя (`FailureKind`) или `runtime-missing`, `controller-busy`, `operator-pause`, `approval-required`, `not-ready` |
| `phase`        | `preflight`, `claim`, `implementation`, `gates`, `review`, `integration`, `delivery`                                    |
| `actor`        | `controller`, `lead` (ведущий агент), `user` (человек) или `null`                                                       |
| `action`       | допустимый следующий шаг                                                                                                |
| `retryPlanned` | движок сам назначит повтор по политике восстановления                                                                   |
| `message`      | текст, не длиннее 2000 символов                                                                                         |
| `evidence`     | до 20 ссылок `{kind: attempt \| evidence \| event \| doctor, id, sha?}`                                                 |

Класс сбоя берётся из сохранённой попытки, текст повторно не разбирается.
Сначала идут диагнозы runtime, затем controller, затем поручения. Человеку
передаются только действия `user`: `fix-access`, `fix-environment`,
`raise-budget`, `reset-attempts`, `user-decision`, `resume-queue`.

`--human` (только `init` и `explain`) печатает текст вместо успешного
конверта; отказ остаётся JSON-конвертом. Exit code одинаков в обоих режимах.

## Новая сессия

1. `$H init --repository <repo> --plan` — сохранённый manifest и
   `status: complete`, ничего не пишется.
2. `$H status --state <paths.state>` — `NOT_FOUND` значит «ещё не запускали».
3. `$H explain --state <paths.state> --policy <repo>/.harness/policy.json`.
4. Графы `.harness/work/*.json` и заметки.

## Заметки

Внешние сервисы заметок и сообщений не вызываются, модули `integrations/*` не
загружаются. Заметка — Markdown в `.harness/work/context/notes/`; в снимок
контекста она попадает, только если поручение указывает `"context":
["notes"]`, тогда снимок закрепляет её digest и отклоняет symlink.

## Общие проекции

`devcontour-harness/projections` — чистые функции без `node:*` (подходят для
браузерного бандла): `chainRoots`, `workProgress`, `nextAction`, `queueStop`,
`explainStop`, `stopCodeOf`, `clipText`, `clipDeep` и их перечни. Корень пакета
экспортирует те же функции — реализация одна. Безопасная запись файлов —
`inspectPath`, `checkDestination`, `listRegularFiles`, `planFileWrites`,
`applyFileWrites` из корня: план показывает все конфликты сразу, применение
только создаёт файлы и повторно проверяет назначение перед каждой записью.
