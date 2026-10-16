# Договоры devcontour-harness

Источник истины — Zod-схемы в `src/contracts`. TypeScript-типы экспортируются
из `devcontour-harness` и `devcontour-harness/contracts`.

## JSON Schema и семантическая проверка

`schemas/<имя>.schema.json` генерируется из тех же схем (`npm run schemas`);
`npm run check` падает, если закоммиченные файлы устарели, а тест паритета
сверяет вердикты Zod и JSON Schema (Ajv, draft 2020-12) на положительных и
отрицательных примерах.

Harness не нормализует значения: строки вроде `title`, `goal`, критериев и
значений ресурсов обязаны быть уже без пробелов по краям — правило выражено
регулярным выражением и одинаково в Zod и JSON Schema.

Программная проверка доступна из `devcontour-harness`: `validateInputs`
(то же, что `harness validate`) и отдельные функции ниже.

JSON Schema выражает всё, что относится к одному значению: типы,
обязательность, закрытость объектов, пределы, регулярные выражения путей и
refs, варианты исходов. Связи **между** значениями проверяются только
функциями пакета и `harness validate`:

| Функция         | Что проверяет                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `graphIssues`   | Повтор ID, неизвестная зависимость, цикл графа                                                                               |
| `policyIssues`  | Циклы компонентов и gates, test gate у репозитория, ресурсы, профили инструментов, `effort`, `fixture`, пары writer/reviewer |
| `crossIssues`   | Связь поручений с политикой: роль, ресурсы, область записи и доказательства, требования, потребители, предпосылки            |
| `contextIssues` | Содержимое снимка контекста совпадает с digests и пределами                                                                  |
| `reviewIssues`  | Ответ reviewer согласован с историей находок предмета                                                                        |

Опубликованы: `work-order`, `work-graph`, `execution-policy`,
`context-snapshot`, `contract-document`, `run-result`, `result-envelope`,
`run-event`, `review-record`, `joint-verification`, `execution-document`.

## Версии

| Версия        | Значение                           | Поле / константа            |
| ------------- | ---------------------------------- | --------------------------- |
| Пакет         | `0.1.0-alpha.N` до стабильного API | `HARNESS_VERSION`           |
| Публичный API | `devcontour-harness/v1alpha1`      | `apiVersion`, `API_VERSION` |
| Политика      | `1`                                | `policyVersion`             |
| Состояние     | `1`                                | `stateVersion`              |

Версии независимы. Пакет читает только перечисленные в
`SUPPORTED_*_VERSIONS`; неизвестная версия входа, политики или состояния
отклоняется до любой мутации и до выдачи claim. Для `0.x`: patch — совместимые
исправления, minor — отдельно описанные изменения договора, включая
несовместимые. Выпущенная версия неизменяема.

Digests (`workGraphDigest`, `policyDigest`, `sourceDigest`, `findingId`) —
SHA-256 канонического JSON (`canonicalJson`: ключи по порядку, `undefined`
опускается). Формула — часть договора; тесты закрепляют эталонные значения.

## Входы

### WorkOrder

Исполняемое поручение — снимок постановки, а не редактируемая задача. Лишние
поля отклоняются: поручение не несёт статуса, результата или согласования.

| Поле               | Смысл                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `apiVersion`, `id` | Версия договора и ID                                                                                             |
| `source`           | `{connector, ref, revision}` — откуда и какая редакция                                                           |
| `title`, `goal`    | Название и цель                                                                                                  |
| `acceptance[]`     | Критерии приёмки (1–30)                                                                                          |
| `role`             | Роль из политики                                                                                                 |
| `repositoryId`     | Репозиторий из политики; `relatedRepositories[]` — поручение уровня workspace (минимум два)                      |
| `writeScope[]`     | Область записи: относительные пути без glob, `.`/`..`; пересекается с областью роли                              |
| `dependsOn[]`      | Поручения графа или подтверждённые предпосылки                                                                   |
| `gates[]`          | Область доказательства: gates и группы `@имя`, замкнута по `dependsOn`, содержит test gate; нет поля — все gates |
| `consumers[]`      | Потребители (зависят от репозитория поручения) и их gates                                                        |
| `properties[]`     | Свойства договора проверки, подтверждаемые сейчас                                                                |
| `resources[]`      | Ресурсы политики                                                                                                 |
| `requirements[]`   | Требование: текст, его SHA-256, test gate из области, testcase                                                   |
| `contracts[]`      | `{id, digest}` закреплённых контрактов                                                                           |
| `context[]`        | ID обязательных источников контекста                                                                             |

### WorkGraph

`{apiVersion, id, source, orders[], prerequisites[]}` — неизменяемый снимок
состава и зависимостей одного согласования; `workGraphDigest` закрепляет
согласование. Предпосылка — `{id, repositoryId, resultSha, receipt}`,
`receipt` — `{kind: 'engine', runId}` или `{kind: 'trusted', issuer, digest}`.
Доверие к `trusted` решает `WorkSource.trusts`: `Harness.run({ source })`
спрашивает источник графа (его `id` обязан совпасть с `graph.source.connector`);
без источника доверенных receipt нет. В обоих случаях движок проверяет, что
result SHA доступен в target ref.

### ExecutionPolicy

| Поле                                                         | Смысл                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `policyVersion`, `mode`                                      | `1`; `live` или `fixture` (runtime `fixture` только в нём)                                                                                                                                                                                                   |
| `repositories[]`                                             | ID, путь, `targetRef` по правилам `git check-ref-format`, `dependsOn`, gates (`test` с обязательным JUnit внутри worktree, `check`), группы gates (≤100), защищённые и генерируемые пути, среда, lifecycle, шаги подготовки, сборки зависимостей и preflight |
| `workspaceGates[]`, `verificationMode`, `workspaceLifecycle` | Gates совместной проверки комбинации репозиториев; `all` или `affected`; окружение совместной проверки                                                                                                                                                       |
| `roles{}`                                                    | `writer`, `writePaths`, своё правило `review` кода, `requiresContract`                                                                                                                                                                                       |
| `review.code / plan / contract`                              | `{reviewer, vendor}`; reviewer задан явно                                                                                                                                                                                                                    |
| `approvalMode`                                               | `agent` или `operator` для технического согласования                                                                                                                                                                                                         |
| `isolation`                                                  | `{mode: 'os' \| 'none', domains[]}`, по умолчанию `os`                                                                                                                                                                                                       |
| `toolProfiles{}`, `environment`, `lifecycle`, `resources[]`  | Инструменты, среда, ресурсы (порты 1024–65535)                                                                                                                                                                                                               |
| `concurrency`, `leaseMs`, `runTimeoutMs`, `reviewProbes`     | Пределы исполнения                                                                                                                                                                                                                                           |
| `maxAttempts`, `repairBudget`, `reuseImplementation`         | Повторы и повторное использование кандидата                                                                                                                                                                                                                  |
| `budgets{work, group, total, onUnknown}`, `prices[]`         | Пределы USD и/или времени; тарифы                                                                                                                                                                                                                            |

Переменные `HARNESS_*` и `DEVCONTOUR_*` политика задать не может.

`policyDigest(policy)` — digest загруженной политики целиком: им сверяются
применённая политика (`control.appliedPolicy`) и запрос операции
`control.reconfigure`. `executionDigest(policy)` — digest исполнительной
части без `budgets` и `prices`: основание согласования графа
(`GraphState.policyDigest`) и fencing попыток (`AttemptState.policyDigest`
у standalone-хоста). Поднятый предел бюджета поэтому согласования не
сбрасывает.

Автор (`--author`): `codex`, `claude`, `fixture` или `external` — человек или
инструмент вне harness; вендор `external` не совпадает ни с одним runtime.

**Выбор reviewer** — только `selectReviewer(policy, kind, writer, role)`:
`different-vendor` (умолчание) отклоняет reviewer того же вендора
(`REVIEWER_SAME_VENDOR`), `same-vendor-allowed` разрешает его. Неявного
«противоположного runtime» нет. Проверка входов отклоняет такую политику
целиком; хост, ведущий движок без неё, получает блокер
`REVIEWER_SAME_VENDOR` только у поручений этой роли — остальная очередь
выдаётся.

### ContextSnapshot

`{apiVersion, sources[], missing[]}`. Источник —
`{id, kind, version, repositoryId?, revision?, required, files[], references[], digest, hostDigest?}`;
файл — `{path, digest, bytes, content: {encoding: 'utf8' | 'base64', data}}`.
Содержимое передаётся в снимке: источник может не быть Git, и движок обязан
получить ровно те байты, на которые выдан digest. `contextIssues` сверяет
SHA-256 и размер каждого файла и `sourceDigest` источника; `pinnedBytes`
отдаёт байты только после проверки. Пределы: 2 МиБ на файл, 16 МиБ на снимок.
Снимок попытки сохраняется по digest (`context-snapshots`) и используется
после рестарта без повторного чтения источника.

### ContractDocument

`{apiVersion, id, repositoryId?, title, content, artifacts?, checks?}` — вход
`review-contract`. `artifacts` — закреплённые файлы контракта (`{path, blob}`,
Git blob в репозитории `repositoryId`); `checks` — договор проверки
(`checkDeclarationSchema`, `version: 1`): gate, обязательства по property ID
(требования, тип обещания, область входов, правила ответа, способ проверки и
его файлы, семейства и минимальные выборки, корпус) и политика расширения
корпуса. Прошедший ревью документ хранится по digest (`contract-documents`):
из него движок строит манифест генеративного gate поручения.

## Модель исполнения

Схемы в `execution.ts` — то, что `ExecutionStore` хранит транзакционно:

| Запись            | Содержание                                                                                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GraphState`      | Граф, его digest, digest политики, техническое согласование                                                                                                                                                                                                                                   |
| `WorkState`       | Закреплённое поручение, статус, попытки, результат, класс отказа, согласованные digests, удержание, блок бюджета, версия корпуса, эпизод восстановления по свойству                                                                                                                           |
| `AttemptState`    | Владение (`token`, `owner`, `leaseUntil`), runtime и reviewer, фаза, SHA, evidence, раскрытые gates, потребители и что у них проверено, версия проверок, контекст, зависимости и свежесть, основание и источник reuse, черновик, выбор из очереди, замеры, `engineVersion`, `consumerVersion` |
| `EvidenceRecord`  | Фаза, SHA, gate, исход, команда, лог, digest, testcases, отчёт свойств, осмотр ревью, версия проверок                                                                                                                                                                                         |
| `ControlState`    | Пауза и её причина, классы отказов, ожидания, применённая политика, reconfigure                                                                                                                                                                                                               |
| `ControllerLease` | Единственный действующий controller                                                                                                                                                                                                                                                           |
| `CallRecord`      | Вызов модели: стадия, runtime, сообщённая модель, версия, исход, процесс, монотонное время, закреплённая атрибуция (`workId`, `groupId`, `workIds`), счётчики, стоимость и её источник                                                                                                        |
| `ReviewRecord`    | Раунд ревью плана/контракта: предмет, digest, номер раунда, вердикт, все находки предмета со статусами `open/closed/withdrawn`                                                                                                                                                                |

Локальные записи адресуются `(namespace, owner, key)`; пространства и их
схемы — `localSchemas` (`usage`, `context-snapshots`, `run-keys`, `delivery`,
`reviews`, `check-suites` — корпус подтверждённых случаев, `workflow-jobs` —
техническая очередь ведущего, `contract-documents` — документы контрактов,
прошедшие ревью, по digest). `owner` — репозиторий или `@workspace`.

## Ответы исполнителей

Runtime возвращает сырой ответ; движок разбирает его
`implementationResultSchema` и `reviewResultSchema`. Ответ вне схемы — отказ,
а не самооценка writer. Reviewer называет состояние каждой прежней открытой
находки (`previous[]`); `reviewIssues` отклоняет `approved` при блокирующей
находке, в том числе прежней открытой, неназванную прежнюю находку и ссылку на
неизвестную. Идентичность находки — `findingId(subject, {rule, message})`.

## Выходы

### RunResult

Варианты по `outcome`:

- `accepted` — `shas{base, candidate, integration, result}` все обязательны
  (result = integration; он уже в target ref);
- `rejected | blocked | cancelled | stopped` — `stopReason{code, message}` с
  кодом из договора ошибок; result SHA нет.

Общие поля: `workOrderId`, `graphId`, `source`, `runId`, `attempt`,
`repositoryId`, `targetRef`, `inputs` (версии harness и потребителя, версия
состояния, digests поручения, графа, политики, контекста, версия проверок),
`checked` (снимки зависимостей, их свежесть, проверенная комбинация каждого
потребителя), `evidence[]`, `findings[]`, `limitations[]`, `finishedAt`.
Свежесть записывается, а не запрещает приёмку.

### DeliveryState и ResultEnvelope

Доставка — отдельно от исхода: `{sink, key, revision, status: pending |
delivered | failed | conflict, attempts, lastError?, currentRevision?,
receipt?, updatedAt}`. `harness result` выдаёт `{apiVersion, result,
delivery[]}`.

### JointVerification

Совместная проверка закреплённой комбинации SHA нескольких репозиториев:
`{id, status, policyDigest, specDigest, workIds[], manifest{repo: {sha, tree}},
manifestDigest, impact?, evidence[], error?}`. Смена любого SHA делает
результат устаревшим; атомарность продвижения нескольких репозиториев не
заявляется. Продуктовое принятие комбинации решает хост. Пока manifest не
закреплён, `impact` может нести только ссылку на базовую проверку
(`baseline`), выбранную хостом для режима `affected`.

### RunEvent

`{apiVersion, seq, at, type, graphId?, workId?, runId?, attempt?, payload}`.
`seq` строго возрастает. Нагрузка каждого из типов (`eventPayloads`) — закрытая
схема: лишних полей нет, поэтому токен владения, секрет или объект попытки в
событие не попадает.

`transactionKinds` — имена транзакций исполнения; совпадают с сохранёнными
типами событий журнала хоста (`run.claimed`, `task.done`, `run.failed`,
`scheduler.error`, …). `workflow.updated` пишет только локальные записи
технической очереди (`workflow-jobs`) и событий журнала не создаёт.
`usage.recorded` пишет только локальные записи учёта вызовов (`usage`): начало
вызова вместе с проверкой бюджетов, ход и итог вызова, закрытие прерванных,
закрепление атрибуции прежних записей; событий журнала не создаёт.
`checks.recorded` пишет только локальные записи корпуса (`check-suites`):
начало, продление и завершение операции подтверждения, решение и новую
версию. `checks.adopted`, `checks.awaiting-operator` и
`checks.adoption-abandoned` меняют принятую поручением версию корпуса и
удержание выдачи (`work.held`, `corpus.adopted`). Эпизод по свойству меняется
транзакциями `recovery.*`, отказом и выдачей (`work.recovery`).
`workspace.verification.started`, `workspace.manifest`, `workspace.evidence`,
`workspace.verified`, `workspace.failed` — транзакции совместной проверки
(`joint.started`, `joint.finished`). `config.started`, `config.reconfigure-*`
и `config.reconfigured` меняют применённую политику и запрос операции
(`policy.applied`, `policy.reconfigure`). `base.moved` — проверка владения
операцией и CAS-сдвиг ref базы; записей и событий не создаёт.

## Порты

| Порт                                     | Договор                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ExecutionStore`                         | `transact(kind, fn)`: синхронная сериализуемая транзакция; исключение откатывает изменения и события; вложенная видит несохранённые изменения внешней, её исключение откатывает только её часть, а изменения обеих сохраняются; событиями становятся только `emit`, возвращаемое значение в журнал не попадает; событие фиксируется и в транзакции без изменения записей модели; `heartbeat` без события; единственный внешний эффект — CAS update-ref при приёмке до фиксации |
| `ExecutionView` / `ExecutionTransaction` | Чтение и запись записей модели, типизированных локальных записей, событий                                                                                                                                                                                                                                                                                                                                                                                                      |
| `BasisProvider`                          | Digest постановки, области проверок и политики поручения; движок сравнивает, но не вычисляет основания хоста                                                                                                                                                                                                                                                                                                                                                                   |
| `HostGuards`                             | `claimable`, `claimBarrier`, `current`, `beforeAccept` — дополнительные запреты хоста в той же транзакции                                                                                                                                                                                                                                                                                                                                                                      |
| `BudgetScopes`                           | Группа поручения, её состав, атрибуция прежних записей вызовов                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `RuntimeAdapter`                         | `capabilities()`, `invoke(request, signal)`: сессия `fresh` для reviewer и planner (`continue` — только writer той же попытки), JSON Schema ответа, сообщённая модель и версия runtime, usage, диагностика, отмена дерева процессов                                                                                                                                                                                                                                            |
| `WorkSource`                             | `fetch(ref)` с редакцией; `revision(ref)`; `trusts(prerequisite)`, по умолчанию нет                                                                                                                                                                                                                                                                                                                                                                                            |
| `ContextSource`                          | `snapshot(ids, at)` — `ContextSnapshot` с содержимым                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ResultSink`                             | `deliver({key, result})` идемпотентно по ключу: `delivered` или `conflict` с текущей редакцией                                                                                                                                                                                                                                                                                                                                                                                 |

## Ошибки и exit codes

`HarnessError {code, class, message, issues[{path, message}]}`; класс задаёт
exit code CLI.

| Exit | Класс            | Коды                                                                                                                                                                                                                                                           |
| ---- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | успех            | —                                                                                                                                                                                                                                                              |
| 2    | `input`          | `INVALID_INPUT`, `UNSUPPORTED_COMMAND`, `UNSUPPORTED_VERSION`, `GRAPH_*`, `GATE_*`, `REVIEWER_*`                                                                                                                                                               |
| 3    | `refused`        | `APPROVAL_STALE`, `APPROVAL_REQUIRED`, `LEASE_STALE`, `CONTROLLER_BUSY`, `PAUSED`, `NOT_READY`, `SCOPE_VIOLATION`, `GATE_FAILED`, `REVIEW_REJECTED`, `BUDGET_EXHAUSTED`, `BUDGET_UNKNOWN`, `ATTEMPTS_EXHAUSTED`, `REVISION_CONFLICT`, `CANCELLED`, `NOT_FOUND` |
| 4    | `infrastructure` | `STATE_VERSION_UNSUPPORTED`, `RUNTIME_UNAVAILABLE`, `SANDBOX_UNAVAILABLE`, `GIT_FAILED`, `STORAGE_FAILED`, `DELIVERY_FAILED`, `INTERNAL`                                                                                                                       |

Exit 1 не используется: им Node завершает процесс при необработанном
исключении.

## CLI

stdout — один JSON `CliEnvelope`: `{apiVersion, command, ok: true, data}` или
`{apiVersion, command, ok: false, error}`. `data` каждой команды проверяется
её схемой (`cliDataSchemas`) перед выводом. Диагностика — stderr. Команды
получают явные пути; `--state <каталог>` создают только пишущие команды,
читающие на отсутствующем каталоге отвечают `NOT_FOUND` и ничего не создают.
Бинарник не хранит настроек проекта и не помнит «последний активный проект».

| Команда           | Аргументы                                                               | Пишет | `data`                                            | Повтор                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------- | ----- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `validate`        | `--graph F --policy F [--context F]`                                    | нет   | digests, число поручений                          | Чистая функция входов                                                                                                                                  |
| `review-plan`     | `--state D --graph F --policy F --author A [--context F]`               | да    | `ReviewRecord`                                    | Тот же digest и автор, уже согласованные, — тот же раунд без вызова модели; автор, не допускаемый правилом вендора, — `REVIEWER_SAME_VENDOR` до вызова |
| `review-contract` | `--state D --contract F --policy F --author A`                          | да    | `ReviewRecord`                                    | Как `review-plan`                                                                                                                                      |
| `approve`         | `--state D --subject ID --digest H`                                     | да    | subject, digest, at                               | Тот же digest — без изменений; только `approvalMode: operator`                                                                                         |
| `run`             | `--state D --graph F --policy F [--context F] [--sink file:D] [--once]` | да    | граф, поручения и их блокеры, задание `workflow`  | Та же редакция продолжает работу; другой digest той же редакции — `REVISION_CONFLICT`                                                                  |
| `status`          | `--state D [--graph ID]`                                                | нет   | очередь, графы, поручения с блокерами, бюджеты    | Только чтение                                                                                                                                          |
| `events`          | `--state D [--after N] [--limit 1–500]`                                 | нет   | события, `next`                                   | Только чтение                                                                                                                                          |
| `pause`           | `--state D`                                                             | да    | `ControlState`                                    | Без изменений                                                                                                                                          |
| `resume`          | `--state D`                                                             | да    | `ControlState`                                    | Решение человека: снимает паузу оператора, штатной остановки и отказа runtime вместе с её классами; паузу операции reconfigure — `PAUSED`              |
| `cancel`          | `--state D --work ID [--reason T]`                                      | да    | статус поручения                                  | Отменённое — без изменений; это не retry                                                                                                               |
| `retry`           | `--state D --work ID [--reset --reason T]`                              | да    | статус поручения                                  | В пределах `maxAttempts` и бюджета; `--reset` с причиной сбрасывает счётчик попыток, но не учёт расходов                                               |
| `result`          | `--state D --work ID`                                                   | нет   | `ResultEnvelope`                                  | Только чтение                                                                                                                                          |
| `deliver`         | `--state D --work ID --sink file:D`                                     | да    | `ResultEnvelope`                                  | Доставленное не доставляется повторно; моделей и интеграции нет                                                                                        |
| `doctor`          | `[--state D] [--policy F]`                                              | нет   | версии, runtime, sandbox, совместимость состояния | Без live-вызова модели                                                                                                                                 |
| `--version`       | —                                                                       | нет   | версия пакета и API                               | —                                                                                                                                                      |

Полная форма каждой команды — `cliCommands` (аргументы, обязательность,
идемпотентность, отказы exit 3). Все команды реализованы. `run` принимает `--author` (по умолчанию `external`) — автора графа для ревью плана. `HARNESS_CODEX_BIN` и `HARNESS_CLAUDE_BIN` подменяют исполняемые файлы runtime (fixture executables в тестах).
После приёмки договора имена и параметры меняются только совместимо или
отдельным согласованным изменением.
