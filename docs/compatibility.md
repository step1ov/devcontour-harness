# Совместимость форматов

Harness выделен из DevContour. Первая миграция DevContour на пакет **не
переносит данные**: состояние остаётся в прежнем хранилище, а адаптер
отображает существующие записи в нейтральные структуры в той же транзакции.
Ниже — как устроен адаптер, что сохраняется байт-в-байт и что меняется
намеренно.

## Транзакции адаптера DevContour

DevContour хранит состояние одним JSON-документом в SQLite (`node:sqlite`) —
в центральной базе или распределённо по базам компонентов, присоединённым к
coordinator. `Store.change(type, fn)` открывает `BEGIN IMMEDIATE` (вложенный
`Store.atomic` — SAVEPOINT), читает документ, вызывает `fn`, записывает
документ целиком и вставляет событие журнала с `data` = возвращённым `fn`
значением (кроме `heartbeat`).

Адаптер `ExecutionStore`:

1. **Внешняя транзакция** — ровно одна `Store.change(kind, …)`. Документ,
   прочитанный ею, — текущий документ транзакции; `ExecutionView` и `put*`
   читают и пишут его объекты (`Task`, `Run`, поля управления).
2. **Вложенная транзакция** не вызывает второй `Store.change`: она работает с
   тем же документом внутри `Store.atomic` (SAVEPOINT для локальных записей).
   Перед ней адаптер снимает копию документа и длину списка событий; при
   исключении восстанавливает документ на месте и отбрасывает её события.
   Так изменения вложенной и внешней сохраняются обе — прямой вложенный
   `Store.change` этого не обеспечивает: внешний снимок перезаписал бы
   внутреннее изменение.
3. **Журнал.** Возвращённое движком значение в журнал не идёт. Адаптер
   записывает в `data` события прежнюю форму данных этого типа (для типов,
   чьи данные читают хост и его экраны: `scheduler.error` → `{error}`,
   `changeset.accepted` → `{changeSetId}` и т. д.) **без полей `token` на
   любой глубине** и добавляет ключ `harnessEvents` — нейтральные события
   транзакции по порядку. `seq` нейтрального события =
   `id события журнала × 16 + индекс` (не больше 16 событий на транзакцию);
   `ExecutionStore.events(after)` строит `RunEvent` из `harnessEvents`.
4. Возврат Promise из `fn` отклоняется до записи.
5. `heartbeat` — `Store.change('heartbeat', …)`: растёт только счётчик сроков,
   события нет.
6. Приёмка: CAS `git update-ref <target> <integration> <base>` выполняется
   внутри внешней транзакции до фиксации (как сейчас `finish(…, publish)`).

Эти свойства подтверждены пробой поверх baseline `Store`: вложенное и внешнее
изменение сохраняются; исключение вложенной откатывает только её; исключение
внешней не оставляет ни изменений, ни события; токенов в журнале нет;
локальные записи с одним ключом у разных владельцев различаются.

### Локальные записи

`local_workflow(namespace, owner, key, data)` — та же таблица. `owner` —
репозиторий-компонент или `@workspace`. У хранения по компонентам запись
владельца-компонента живёт в базе компонента (`componentN.local_workflow`),
`@workspace` — в coordinator. Адаптер не меняет правило размещения.

## Отображение записей

| Нейтральная запись       | Запись DevContour                                                                                               | Правило                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkState`              | `Task` (поля исполнения)                                                                                        | `status`, `attempt`, `activeRunId`, `resultSha`, `failure`, `failureKind`, `failureFingerprint`, `approvedAt`, `approvedDigest`, `approvedScope`, `approval`, `hold`, `budgetBlock`, `checkVersion`, `recovery`, `recoveryHistory` — те же имена и формы. `graphId` — доска, в активной ревизии которой задача                                                                                                |
| `WorkOrder`              | `Task` (поля постановки)                                                                                        | `description` → `goal`; `writePaths` (или область роли) → `writeScope`; `contracts` + `contractDigests` → `contracts[{id, digest}]`; `contextPacks` → `context`; `source` = `{connector: 'devcontour', ref: <taskId>, revision: <approvedDigest>}`. Продуктовые поля (`preparation`, `featureId`, `assignee`, `supersedes`, `finding`, `sharedCompletion`, `scope`) в поручение не входят и остаются в `Task` |
| `AttemptState`           | `Run`                                                                                                           | Те же имена и формы, включая `context` (краткие pins), `consumers[].checked`, `partial`, `continuedFrom`, `dispatch`, `timings`; `taskId` ↔ `workId`; runtime `demo` ↔ `fixture` на границе (сохранённое значение не переписывается); `memory` остаётся полем `Run` хоста; `engineVersion`, `consumerVersion`, `contextSnapshot` — новые необязательные поля                                                  |
| `EvidenceRecord`         | `Evidence`                                                                                                      | Без изменений                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ControlState`           | `paused`, `pauseReason`, `pausedAt`, `pauseOperation`, `pauseFailures`, `waits`, `appliedConfig`, `reconfigure` | Те же формы; `appliedConfig` ↔ `appliedPolicy`                                                                                                                                                                                                                                                                                                                                                                |
| `ControllerLease`        | `leader`                                                                                                        | Без изменений                                                                                                                                                                                                                                                                                                                                                                                                 |
| `JointVerificationState` | `Verification`                                                                                                  | `manifest`, `manifestDigest`, `policyDigest`, `specDigest`, `impact`, `evidence`, `token`, `leaseUntil`, `status` — те же формы; `tasks` → `workIds` (снимок задач остаётся в `Verification`); `boards`, `productRelease` — поля хоста                                                                                                                                                                        |
| `CallRecord`             | `UsageRecord` (`local_workflow` `usage`)                                                                        | Те же поля; `taskId` ↔ `workId`, `boardId` ↔ `groupId`, `taskIds` ↔ `workIds`                                                                                                                                                                                                                                                                                                                                 |
| `ReviewRecord`           | `ContractAttempt` (`contractAttempts`)                                                                          | Прежние попытки читаются как раунды: `subject`, `attempt` → `round`, `approved`, `summary`, находки без прежних статусов получают `open` в своём раунде; история не переписывается. Новые раунды пишут статусы `open/closed/withdrawn`                                                                                                                                                                        |

Адаптер записывает только поля нейтральной модели и сохраняет остальные поля
записи хоста как есть; неизвестные поля не удаляются.

## Основания, которые не пересчитываются

Формулы digest записаны в принятой истории и receipts. Движок их не вычисляет —
их даёт хост через `BasisProvider`:

- digest постановки задачи (включает продуктовые поля), digest области
  проверок, digest контракта по своей формуле закрепления;
- digest политики задачи, включая прежний вариант для старых receipts.

Формулы действующей версии проверок, основания реализации, seed свойства,
digest манифеста свойств и ключа ресурса переносятся в пакет без изменения.
Pins контекста DevContour сохраняют свой digest (`hostDigest` → `ContextPin.digest`);
`sourceDigest` снимка считается harness отдельно.

Standalone-хост использует `digestOf` (SHA-256 канонического JSON) от
нейтральных структур; эти digests с digests DevContour не сравниваются.

## Бюджеты

| Область harness | DevContour                  |
| --------------- | --------------------------- |
| `work`          | задача                      |
| `group`         | доска со всеми её ревизиями |
| `total`         | workspace                   |

`BudgetScopes` DevContour: `groupOf` — доска задачи в текущем графе,
`members` — задачи всех ревизий доски, `legacy` — прежнее правило атрибуции
(задача по попытке или предмету вызова, доска по текущему графу) для записей
без закреплённых `taskId`/`boardId`/`taskIds`; результат закрепляется один
раз. Расход остаётся за доской, на которой он сделан, при переносе задачи.
Тариф выбирается по модели, о которой сообщил runtime (`RuntimeResponse.model`
→ `CallRecord.model`), а не по модели из политики.

## Reviewer

Правило ревью кода роли собирается адаптером по прежней цепочке
`role.reviewer` компонента → `repository.reviewer` → `config.reviewer`;
одноимённые роли разных компонентов не схлопываются (политика строится на
компонент). Прежнее требование «writer ≠ reviewer» — `different-vendor`.

## Сохраняемые форматы

| Что                                     | Правило                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Состояние `version: 1`                  | Читается как есть; иная версия отклоняется до записи                                                                |
| Типы событий журнала                    | Прежние строки, см. `transactionKinds`                                                                              |
| Ветки                                   | Целевая `devcontour/accepted` (в политике `refs/heads/devcontour/accepted`), ветки попыток `devcontour/run-<runId>` |
| Каталоги попыток                        | `worktrees/<runId>`, `worktrees/<runId>-integration`, `artifacts/<runId>/…`, `dependencies/<runId>/manifest.json`   |
| Receipt среды                           | `environment.json` `version: 1`                                                                                     |
| Отчёт свойств, договор проверки, корпус | `version: 1`                                                                                                        |
| Владение репозиторием                   | `<git-common-dir>/devcontour-owner.json`                                                                            |
| Ресурсы                                 | Отдельная база блокировок ресурсов `resources.sqlite`: блокировки устройств и портов, а не состояние исполнения     |
| Probe ревьюера                          | MCP-сервер `devcontour_probe`, инструмент `run_check`                                                               |

## Переменные окружения gates

Gates, шаги подготовки и проверки потребителей получают переменные с
историческим префиксом `DEVCONTOUR_`: `DEVCONTOUR_REPOSITORY_ID`,
`DEVCONTOUR_RUN_ID`, `DEVCONTOUR_TASK_ID`, `DEVCONTOUR_PHASE`,
`DEVCONTOUR_RESOURCES_JSON`, `DEVCONTOUR_DEPENDENCIES_JSON`,
`DEVCONTOUR_COMPONENTS_JSON`, `DEVCONTOUR_REPORT_PATH`, `DEVCONTOUR_SEED`,
`DEVCONTOUR_PROPERTY_REPORT`, `DEVCONTOUR_PROPERTIES`, `DEVCONTOUR_CORPUS`,
`DEVCONTOUR_CASE`, `DEVCONTOUR_CASE_RESULT`, `DEVCONTOUR_MANIFEST_PATH`,
`DEVCONTOUR_CHANGESET_ID`, `DEVCONTOUR_PROCESS_MARK`. Имена — часть договора
проверок пользователей, а не связь с хостом; harness сохраняет их и задаёт
`HARNESS_*` с теми же значениями. Оба пространства резервирует controller:
политика не может задать переменные с этими префиксами.

## Что меняется намеренно

| Изменение                       | Следствие                                                                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Версия движка в основании reuse | Попытка записывает `engineVersion` (и `consumerVersion`). Кандидат попытки другой версии движка повторно не используется: новая попытка заново проходит gates и ревью. Прежние попытки сохраняют своё основание; отсутствующая версия не выдумывается                 |
| Reviewer задаётся правилом      | `different-vendor` по умолчанию; `same-vendor-allowed` включается явно                                                                                                                                                                                                |
| Токены вне журнала              | Исправление утечки: прежде `run.claimed` и `run.recovered` записывали в журнал попытку целиком, с fencing-токеном. Новые события пишутся без токенов; при выдаче старых событий наружу (CLI, HTTP, RunEvent) токены удаляются. Историю базы физически не переписываем |
| История находок ревью           | Reviewer называет состояние прежних находок; прежние попытки читаются без статусов                                                                                                                                                                                    |

## Состояние standalone

Standalone SQLite хранит документ `execution-document` (`stateVersion: 1`),
события и локальные записи в одной базе и запись о версии писателя. Процесс
другой версии с несовместимым форматом не открывает базу на запись. Матрица
поддерживаемых переходов и порядок upgrade/rollback публикуются вместе с
первой поставкой архива.
