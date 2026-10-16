# Договоры devcontour-harness

Источник истины — Zod-схемы в `src/contracts`. JSON Schema в `schemas/`
генерируется из них (`npm run schemas`), а `npm run check` падает, если
закоммиченные файлы устарели. TypeScript-типы экспортируются из
`devcontour-harness` и `devcontour-harness/contracts`.

## Версии

| Версия        | Значение                           | Поле / константа            |
| ------------- | ---------------------------------- | --------------------------- |
| Пакет         | `0.1.0-alpha.N` до стабильного API | `HARNESS_VERSION`           |
| Публичный API | `devcontour-harness/v1alpha1`      | `apiVersion`, `API_VERSION` |
| Политика      | `1`                                | `policyVersion`             |
| Состояние     | `1`                                | `STATE_VERSION`             |

Версии независимы. Пакет читает только перечисленные в
`SUPPORTED_*_VERSIONS`; неизвестная версия входа, политики или состояния
отклоняется до любой мутации и до выдачи claim. Для `0.x`: patch — совместимые
исправления, minor — отдельно описанные изменения договора, включая
несовместимые. Выпущенная версия неизменяема.

## Входы

### WorkOrder

Исполняемое поручение — снимок постановки, а не редактируемая задача. Поля:

| Поле               | Смысл                                                                |
| ------------------ | -------------------------------------------------------------------- |
| `apiVersion`, `id` | Версия договора и ID поручения                                       |
| `source`           | `{connector, ref, revision}` — откуда и какая редакция               |
| `title`, `goal`    | Название и цель                                                      |
| `acceptance[]`     | Критерии приёмки (1–30)                                              |
| `role`             | Роль исполнителя из политики                                         |
| `repositoryId`     | Репозиторий из политики; `relatedRepositories[]` — уровень workspace |
| `writeScope[]`     | Область записи: относительные пути без glob, `.`/`..`                |
| `dependsOn[]`      | Поручения графа или подтверждённые предпосылки                       |
| `gates[]`          | Область доказательства: gates и группы `@имя`; нет — все gates       |
| `consumers[]`      | Потребители и их gates против integration результата                 |
| `properties[]`     | Свойства договора проверки, подтверждаемые сейчас                    |
| `resources[]`      | Ресурсы политики, нужные попытке                                     |
| `requirements[]`   | Требования с digest источника, gate и testcase                       |
| `contracts[]`      | `{id, digest}` закреплённых контрактов                               |
| `context[]`        | ID обязательных источников контекста                                 |

Лишние поля отклоняются (`strictObject`): поручение не несёт статуса,
результата или согласования.

### WorkGraph

`{apiVersion, id, source, orders[], prerequisites[]}`. Неизменяемый снимок
состава и зависимостей одного согласования; его digest
(`workGraphDigest` — SHA-256 канонического JSON) закрепляет согласование.

`prerequisites[]` — внешние выполненные зависимости:
`{id, repositoryId, resultSha, receipt}`, где `receipt` —
`{kind: 'engine', runId}` или `{kind: 'trusted', issuer, digest}`. Доверие к
`trusted` решает `WorkSource.trusts`; в обоих случаях движок проверяет, что
result SHA доступен в target ref.

`graphIssues(graph)` до любой записи находит: `GRAPH_DUPLICATE_ID`,
`GRAPH_UNKNOWN_DEPENDENCY`, `GRAPH_CYCLE` (включая самозависимость), с путём
нарушения.

### ExecutionPolicy

| Поле                                                        | Смысл                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `policyVersion`                                             | `1`                                                                                                                                                    |
| `repositories[]`                                            | ID, путь, `targetRef` (`refs/heads/...`), gates, группы gates, защищённые и генерируемые пути, среда, lifecycle, шаги подготовки и сборки зависимостей |
| `roles{}`                                                   | `writer` binding, `writePaths`, своё правило `review` кода                                                                                             |
| `review.code / plan / contract`                             | `{reviewer, vendor}`: reviewer задан явно                                                                                                              |
| `approvalMode`                                              | `agent` или `operator` для технического согласования                                                                                                   |
| `isolation`                                                 | `{mode: 'os' \| 'none', domains[]}`, по умолчанию `os`                                                                                                 |
| `toolProfiles{}`, `environment`, `lifecycle`, `resources[]` | Инструменты, среда, ресурсы                                                                                                                            |
| `concurrency`, `leaseMs`, `runTimeoutMs`, `reviewProbes`    | Пределы исполнения                                                                                                                                     |
| `maxAttempts`, `repairBudget`, `reuseImplementation`        | Повторы и повторное использование кандидата                                                                                                            |
| `budgets`, `prices[]`                                       | Пределы расходов/времени, тарифы                                                                                                                       |

Runtime binding: `{runtime: 'codex' | 'claude' | 'fixture', model?, effort?,
toolProfile?}`.

**Выбор reviewer** — только `selectReviewer(policy, kind, writer, role)`.
`vendor: 'different-vendor'` (умолчание) отклоняет reviewer того же вендора
(`REVIEWER_SAME_VENDOR`); `same-vendor-allowed` разрешает его. Неявного
«противоположного runtime» нет. `policyIssues` проверяет все пары ролей до
запуска.

**Группы gates** раскрывает `expandGateRefs`: рекурсивно, каждый gate один
раз, порядок первого появления; `GATE_GROUP_CYCLE`, `GATE_UNKNOWN`.

### ContextSnapshot

`{apiVersion, sources[]}`; источник —
`{id, kind, version, repositoryId?, revision?, required, files[], references[], digest}`,
файл — `{path, digest, bytes}`. `files` вкладываются в запрос исполнителю,
`references` только называются; содержимое обоих входит в digest. Без
обязательного источника попытка не начинается (отказ окружения, попытка не
засчитывается); отсутствие дополнительного записывается в ограничения.

## Выходы

### RunResult

`outcome`: `accepted | rejected | blocked | cancelled | stopped`. Обязательны
`workOrderId`, `graphId`, `source`, `runId`, `attempt`, `repositoryId`,
`targetRef`, `shas{base, candidate, integration, result}`, `inputs` (версия
harness, версия состояния, digests поручения, графа, политики, контекста,
версия проверок), `evidence[]`, `findings[]`, `limitations[]`, `finishedAt`.
`accepted` требует integration и result SHA; любой другой исход — `stopReason`
с кодом ошибки.

`evidence[]` — ссылки `{id, kind, phase, gate, sha, passed, digest, summary,
consumer?, reviewer?}`; сами логи и отчёты хранит `ExecutionStore`.

### DeliveryState и ResultEnvelope

Доставка — отдельно от исхода: `{sink, key, status: pending | delivered |
failed | conflict, attempts, lastError?, currentRevision?, receipt?,
updatedAt}`. `harness result` выдаёт `ResultEnvelope = {apiVersion, result,
delivery[]}`.

### RunEvent

`{apiVersion, seq, at, type, graphId?, workId?, runId?, attempt?, payload}`.
`seq` строго возрастает. Нагрузка — только безопасные значения; ключи вида
`token`, `secret`, `password`, `credential`, `apiKey`, `authorization`,
`cookie` на любой глубине отклоняются схемой.

`transactionKinds` — имена транзакций исполнения. Они совпадают с
сохранёнными типами событий журнала хоста (`run.claimed`, `task.done`,
`run.failed`, `scheduler.error`, …), потому что хост их разбирает.

## Порты

| Порт                                     | Договор                                                                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecutionStore`                         | `transact(kind, fn)` — синхронная сериализуемая транзакция, откат при исключении, вложенность через savepoint, `heartbeat` без события; `read`, `events(after)`                   |
| `ExecutionView` / `ExecutionTransaction` | Чтение и запись нейтральных записей, локальных записей и событий                                                                                                                  |
| `BasisProvider`                          | Digest постановки, области проверок и политики поручения; движок сравнивает, но не вычисляет основания хоста                                                                      |
| `HostGuards`                             | `claimable`, `claimBarrier`, `current`, `beforeAccept` — дополнительные запреты хоста в той же транзакции                                                                         |
| `RuntimeAdapter`                         | `capabilities()`, `invoke(request, signal)`; отдельная сессия (`fresh` для reviewer/planner), структурированный ответ по JSON Schema, usage, диагностика, отмена дерева процессов |
| `WorkSource`                             | `fetch(ref)` с редакцией; `revision(ref)`; `trusts(prerequisite)`, по умолчанию нет                                                                                               |
| `ContextSource`                          | `snapshot(ids, at)` — закрепляемый контекст без хранилища задач                                                                                                                   |
| `ResultSink`                             | `deliver({key, result})` идемпотентно по ключу; `delivered` или `conflict` с текущей редакцией                                                                                    |

Порты не принимают объектов хоста целиком и не используют
`Record<string, unknown>` вместо типов, кроме явно обозначенных расширений
формата (`property`, `inspection`, `recovery`), чьи схемы принадлежат модулю
`verification`.

## Ошибки и exit codes

`HarnessError {code, class, message, issues[{path, message}]}`. Класс задаёт
exit code CLI:

| Exit | Класс            | Примеры кодов                                                                                                                                                                         |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | успех            | —                                                                                                                                                                                     |
| 2    | `input`          | `INVALID_INPUT`, `UNSUPPORTED_COMMAND`, `UNSUPPORTED_VERSION`, `GRAPH_*`, `GATE_*`, `REVIEWER_*`                                                                                      |
| 3    | `refused`        | `APPROVAL_STALE`, `LEASE_STALE`, `CONTROLLER_BUSY`, `PAUSED`, `SCOPE_VIOLATION`, `GATE_FAILED`, `REVIEW_REJECTED`, `BUDGET_*`, `ATTEMPTS_EXHAUSTED`, `REVISION_CONFLICT`, `CANCELLED` |
| 4    | `infrastructure` | `STATE_VERSION_UNSUPPORTED`, `RUNTIME_UNAVAILABLE`, `SANDBOX_UNAVAILABLE`, `GIT_FAILED`, `STORAGE_FAILED`, `DELIVERY_FAILED`, `INTERNAL`                                              |

Exit 1 не используется: им Node завершает процесс при необработанном
исключении.

## CLI

stdout — один JSON `CliEnvelope`
(`{apiVersion, command, ok: true, data}` или `{…, ok: false, error}`);
диагностика — stderr. Каждая команда получает явные пути; бинарник не хранит
настроек проекта и не помнит «последний активный проект».

| Команда                                     | Обязана                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `validate --graph F --policy F`             | Проверить граф, политику и их связь без вызова моделей и записи состояния |
| `review-plan / review-contract`             | Ревью конкретного digest с сохранением истории находок                    |
| `run --graph F --policy F --state D`        | Запустить или идемпотентно продолжить работу                              |
| `status / events --state D`                 | Читать состояние и события без побочных эффектов                          |
| `pause / resume / cancel / retry --state D` | Разные доменные действия с документированными ограничениями               |
| `result --state D --work ID`                | `ResultEnvelope` с SHA, evidence и доставкой                              |
| `doctor`                                    | Версии, runtime/capabilities, среда, совместимость без live-вызова        |
| `--version`                                 | Версия пакета и API                                                       |

В `0.1.0-alpha.0` реализованы `validate` и `--version`; остальные команды
объявлены договором и отвечают `UNSUPPORTED_COMMAND` (exit 2) без побочных
эффектов. Имена и параметры команд после приёмки договора меняются только
совместимо или отдельным согласованным изменением.
