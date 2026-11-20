# Самостоятельный проект

Как подготовить существующий Git-репозиторий npm или pnpm к работе с harness
без внешнего хоста: пользователь называет репозиторий, цель и ограничения,
остальное агент получает от `harness init`, а план составляет сам через
`harness plan-request` и `harness plan-check`. Пошаговый маршрут для агента —
skill [`skills/harness/SKILL.md`](../skills/harness/SKILL.md); установку,
первую настройку и обновление версии ведёт skill
[`skills/harness-setup/SKILL.md`](../skills/harness-setup/SKILL.md).

## Установка

Пакет ставится в отдельный каталог инструментов, а не в зависимости проекта:
`package.json` и lockfile проекта не меняются. Каталог — снаружи
репозитория или внутри него, в `.harness-tools/`.

```sh
npm install --prefix <tooldir> --save-exact --omit=dev --ignore-scripts devcontour-harness@<version>
# или из архива: npm install --prefix <tooldir> --omit=dev --ignore-scripts ./devcontour-harness-<version>.tgz
H=<tooldir>/node_modules/.bin/harness
$H --version
$H doctor
```

Внутри проекта (`<tooldir>` = `<repo>/.harness-tools`) версию закрепляют
`.harness-tools/package.json` и `package-lock.json`: их коммитят вместе с
`.harness/`, а `node_modules/` исключает `.harness-tools/.gitignore`. Чтобы
поручение не могло изменить инструмент, которым его проверяют, каталог
добавляют в `protectedPaths` политики. Установка из архива записывает в
`package.json` локальный путь `file:` — такой каталог целиком исключают через
`.git/info/exclude`. Worktrees попыток создаются из Git, поэтому
неотслеживаемый каталог инструментов в них не попадает. Состояние исполнения
в любом случае остаётся вне репозитория.

Обновление — смена закреплённой версии в том же каталоге по процедуре
[upgrade](upgrade.md): остановка writers, копия state, проверка копии новой
версией, установка, `doctor --state`, `init --plan`, `validate` графов,
`resume`. Новая версия не перегенерирует политику: если изменился встроенный
профиль, `init --plan` сообщает `content-differs` на `project.json`, и решение
принимает человек.

## `harness init`

```sh
$H init --repository <repo> --plan   # только план, ничего не пишет
$H init --repository <repo>          # create-only запись .harness/
$H init --repository <repo> --lean   # то же для слабой машины (ниже)
```

Профиль: `--profile`, иначе сохранённый в manifest, иначе по lockfile — только
`package-lock.json` даёт `npm-ci`, только `pnpm-lock.yaml` — `pnpm-frozen`;
оба lockfile или ни одного — `NOT_READY` (`stack-ambiguous` /
`stack-unsupported`). Версия менеджера пакетов берётся из
`package.json#packageManager`, без него — из закрепления профиля.
Политика генерируется из профиля и проверяется toolchain inspection: нет
script или подходящей версии инструмента — точная диагностика `NOT_READY`, а
не ослабленная политика.

### Ведущий, writer и ревью

```sh
$H init --repository <repo> --lead codex --plan           # ревью auto
$H init --repository <repo> --lead claude --review same --model <model>
```

Ведущий (`--lead claude|codex`) — runtime, который ведёт сессию, составляет
планы и контракты (`review-plan --author <ведущий>`). Источник по порядку:
`--lead`, сохранённый manifest (`lead`; у manifest прежнего формата — его
writer), сохранённая политика без manifest (новый checkout: `project.json` не
под Git), признак окружения, `--writer`. Из политики ведущий читается по
правилу ревью плана: `same-vendor-allowed` — его reviewer, иначе другой
вендор; writer — общий writer ролей, иначе по правилу ревью кода. Признак окружения: `CLAUDECODE=1`
(Claude Code задаёт его дочерним процессам) — `claude`; `CODEX_THREAD_ID`
(Codex CLI задаёт его командам агента) — `codex`; оба сразу — признака нет.
Ведущий не определён (пустой проект без признака) — `NOT_READY`
(`lead-unknown`) с вопросом, а не молчаливое `claude`. Writer — `--writer`,
иначе из manifest, иначе из сохранённой политики, иначе ведущий;
`data.lead` называет ведущего и источник.

Ревью (`--review`): reviewer плана и контракта выбирается для ведущего,
reviewer кода — для writer.

| `--review`         | Политика                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cross`            | reviewer другого вендора; нет его CLI — init предупреждает (`runtime-missing`), `doctor` называет проблему до первой попытки                                                                                            |
| `same`             | тот же runtime с явным `vendor: same-vendor-allowed` в каждом правиле; предупреждение `review-same-vendor`                                                                                                              |
| `auto` (умолчание) | `same` с предупреждением — только когда свои CLI ведущего и writer пригодны, а CLI другого вендора нет или он не вошёл; иначе `cross` (без CLI вовсе — `cross` с `runtime-missing`); запасные reviewer не подставляются |

Наличие CLI — `HARNESS_<RUNTIME>_BIN` или имя в PATH и ответ на
`--version`; вход — `claude auth status` и `codex login status` (локальные
проверки без вызова модели, пробы идут параллельно). «Не вошёл» — только по
явному ответу: у claude JSON с `loggedIn: false`, у codex «Not logged in»;
иной ответ — неизвестно, и `auto` считает такой CLI пригодным. Результат — `data.runtimes`. Решение
сохраняется в manifest (`review: cross|same`): повтор и новая сессия его не
пересчитывают; иное явное `--review` — `content-differs` на `project.json`.
`--model` закрепляет одну модель на writer и всех reviewers (поле `model`
привязок); при ревью другим вендором это отказ `INVALID_INPUT`
(`model-cross-vendor`). Роли профиля со своими runtime не меняются; их
отсутствующий CLI — предупреждение `runtime-missing`. Reviewer роли профиля
того же вендора, что её writer, при `same` получает в правиле роли то же
`vendor: same-vendor-allowed`; при `cross` правило роли остаётся
`different-vendor`, и такую роль движок не выдаст — init предупреждает
`review-vendor-conflict`, `doctor` называет это проблемой.

`data.warnings` — предупреждения, не отказ: `review-same-vendor`,
`review-vendor-conflict`, `runtime-missing`, `runtime-unauthenticated`. Те же правила видны дальше:
`doctor` предупреждает о ревью тем же вендором (`warnings`) и называет
отсутствующий назначенный CLI с его назначениями в `problems`; `report`
добавляет ограничение `review-same-vendor`, если в окне были такие ревью.

| Путь                               | Что                                            | Запись                                        | Под Git         |
| ---------------------------------- | ---------------------------------------------- | --------------------------------------------- | --------------- |
| `.harness/.gitignore`              | исключает `project.json`                       | create, существующий сохраняется              | да              |
| `.harness/README.md`               | что лежит в каталоге и как продолжить работу   | create, существующий сохраняется              | да              |
| `.harness/project.json`            | manifest: решения init и абсолютный путь state | до политики; повтор — только байтово тот же   | нет (локальный) |
| `.harness/policy.json`             | `ExecutionPolicy` из решений manifest          | последней; настройку агента не перезаписывает | да              |
| `.harness/work/*.json`             | графы поручений                                | пишет агент                                   | по выбору       |
| `.harness/work/context/notes/*.md` | заметки, только при необходимости              | пишет агент                                   | по выбору       |
| state                              | состояние исполнения                           | создаёт `run`                                 | вне репозитория |

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
`lead`, `review`, `runtimes`, `warnings`,
`facts` (репозиторий, target ref, роли, gates, каталоги работы, контекста и
заметок), `toolchain` и `next` — готовые вызовы `doctor`,
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
8. Ведущий не определён — `NOT_READY` (`lead-unknown`, путь `--lead`).
9. Конфликты плана — `PATH_CONFLICT`, все конфликты в `issues` с абсолютными
   путями: `symlink`, `ancestor-not-directory`, `not-regular-file`,
   `content-differs`, `outside-root`.
10. Проблемы toolchain — `NOT_READY`.

С `--plan` пункты 9–10 не бросаются: ответ `ok: true` с данными, exit 3 при
конфликтах или неготовом toolchain. Иное решение при существующем manifest
(другой `--lead`, `--writer`, `--review`, `--model`, профиль с другим digest)
— `content-differs` на `project.json`: решение меняется явно, файл не
перезаписывается. Сохранённая политика, которая не назначает допустимого
reviewer для решений (план и контракт ведущего, код writer — `selectReviewer`,
например reviewer того же вендора без `same-vendor-allowed`), —
`content-differs` на `policy.json`, в том числе после ручной правки
политики; отказ называет причину. Новый checkout без manifest берёт решения
из самой политики и конфликта не даёт. Повтор с теми же решениями даёт
`created: []`. Manifest записывается до политики: после прерывания
подготовка продолжается по его решениям (профиль, ведущий, writer, ревью,
state) и дописывает недостающее; `status: complete` — только при валидных
manifest и политике. Manifest прежнего формата (без `lead`) продолжает
работать: ведущий — его writer, ревью — `cross`, файл не переписывается и
`content-differs` не возникает, пока решения те же.

### Слабая машина

На машине с 4 производительными ядрами или меньше чем 16 ГБ памяти (например,
ноутбук без вентилятора) две одновременные попытки и их gates делят
процессор, и проверки упираются в свои пределы времени. Для нового проекта
`init --lean` надстраивает профиль встроенным слоем `lean`:

- `concurrency: 1` — одна попытка за раз;
- `runTimeoutMs` не меньше 1800000 — 30 минут на попытку. Это нижняя
  граница, а не предел: если пределам шагов с поднятой границей нужно больше
  (наибольшая сумма фазы с запасом 25 %, вверх до 5 минут), записывается
  этот срок. Слой никогда не даёт срока меньше, чем `init` без слоя: у
  `npm-ci` и `pnpm-frozen` это 2100000 (35 минут, с запуском повтора
  интеграции после падения исполнителя тестов), у `mobile-maestro` — 3000000;
- `gateTimeoutFloorMs: 240000` — каждый gate получает не меньше 4 минут
  (объявленные пределы gates не меняются, см.
  [contracts](contracts.md#executionpolicy));
- у pnpm-профиля с `pnpm-lock.yaml` в корне — `dependencyStore: { "manager": "pnpm" }`:
  пакеты не скачиваются заново в каждый checkout
  ([хранилище зависимостей](toolchains.md#хранилище-зависимостей); seed
  собирается в песочнице, поэтому реестру нужен домен в `isolation.domains`,
  иначе — обычная установка). Для npm хранилища нет.

Решение записывается в manifest (`profile.layers: ["lean"]`): повтор `init`
без флага его сохраняет. В уже подготовленном проекте `init --lean` даёт
`content-differs` на `project.json`; слой там включает и выключает
`harness lean`:

```sh
harness lean --repository <repo> --plan        # изменения полей, без записи
harness lean --repository <repo>               # включить
harness lean --repository <repo> --off --plan  # что вернёт выключение
harness lean --repository <repo> --off         # выключить
```

- **Включение** складывает поля политики со слоем по правилам слоёв:
  `concurrency` — наименьшая (1), `gateTimeoutFloorMs` — наибольшая,
  `runTimeoutMs` — наибольший из текущего, слоя и требуемого пределами шагов
  с новой границей (как у `init --lean`: сумма фазы с запасом 25 %), поэтому
  срок тот же, что дал бы `init --lean`. У
  pnpm-профиля с `pnpm-lock.yaml` добавляется `dependencyStore`, как у
  `init --lean`. Manifest получает `profile.layers` с `lean`, закрепление
  профиля со слоем и запись `lean`: какие поля изменены, их прежние значения
  и кому добавлено хранилище. Явное значение, которое слой заменяет
  (например, `concurrency: 3`), названо в `data.notes`.
- **Выключение** по этой записи возвращает прежние значения точно: включение
  и выключение дают байт в байт прежние `policy.json` и `project.json`.
  Слой, включённый `init --lean` (записи нет), снимается значениями, которые
  `init` вывел бы из профиля без слоя. Поле, изменённое вручную после
  включения, не перезаписывается: это проблема `PATH_CONFLICT` с полем и
  объяснением.
- **План** (`--plan`) ничего не пишет: `data.changes` — файл, поле, значение
  до и после; `data.problems` — почему применение откажет (exit 3). Без
  `--plan` каждый файл заменяется атомарно (временный файл и rename), прочие
  поля и байты прежние; два файла вместе — не одна транзакция. Перед первой
  записью оба файла сверяются с прочитанным, каждый — ещё раз перед своим
  rename: изменённый файл — `REVISION_CONFLICT`. Если изменён первый файл,
  не записано ничего; если второй, первый уже записан, и сообщение называет
  его. Порядок записи (включение — manifest, затем политика; выключение —
  политика, затем manifest) делает такую половину продолжаемой: повтор той же
  команды дописывает недостающее, обратная команда возвращает исходные байты.
  Между последней сверкой и rename остаётся короткое окно: файлы не
  блокируются. Повтор без изменений ничего не пишет (`changed: false`).
  `doctor --policy` показывает половину переключения предупреждением
  `LEAN_MISMATCH` (manifest включает слой, а поля политики другие).
- **Идущий run.** Живая роль controller, попытка или совместная проверка в
  каталоге состояния (`paths.state` manifest или `--state`, если run идёт с
  другим каталогом) — `CONTROLLER_BUSY`: политика не меняется посреди
  исполнения. Проверка и запись разделены: run, запущенный между ними,
  стартует уже с прочитанной политикой, поэтому не запускайте его во время
  переключения. Попытка с истёкшим владением (процесс прерван) — только
  пояснение: следующий `run` восстановит её под новой политикой.
- **Срок фазы.** Возвращённые значения — прежние, даже если их не хватает
  пределам шагов: такое предупреждение (как у `doctor`) — в `data.notes`.
- **Digest.** Изменение политики меняет `policyDigest` и `executionDigest`:
  `data.policyDigest` — оба значения, `data.staleApprovals` — незавершённые графы,
  согласованные под прежней политикой. Их согласование устаревает
  (`APPROVAL_STALE`) — повторите `review-plan`; следующий
  `run --policy .harness/policy.json` применяет новую политику.
- **Без manifest** (новый checkout, `project.json` не под Git) — `NOT_READY`:
  сначала `init --repository <repo>` (manifest восстанавливается по
  сохранённой политике, политика не меняется), затем `lean`.

Пределы времени, условные gates, ресурсы и цена подготовки среды на
медленной машине или в тяжёлом проекте — [медленные окружения](slow-environments.md).

Свой профиль подключает слой через `"extends": ["pnpm-frozen", "lean"]`.
Сверку копии seed можно ограничить переменной `HARNESS_DIGEST_THREADS`
(целое 1–8, по умолчанию ядра минус одно). `doctor` с политикой предупреждает
`LOW_RESOURCES`, если машина слабая, а параллельность политики больше 1, и
`DEPENDENCY_STORE_RECOMMENDED`, если у pnpm-репозитория нет `dependencyStore`
([диагностика](toolchains.md#диагностика-doctor-и-preflight)); для политики
в `.harness/` оба совета называют `harness lean --repository <корень> --plan`.

## Факты репозитория без записи

`inspectProject({ repository })` из корня пакета — библиотечная инспекция до
любой подготовки (схема `project-facts`): Git-корень, вид worktree, base SHA,
ветка, незакоммиченные изменения, их число (`changeCount`) и первые 50 путей; lockfiles корня и менеджер пакетов
(`detected`, `ambiguous`, `none`) с полем `packageManager`; подходящие
встроенные профили с digest; scripts корневого `package.json` и похожие на
проверки (`checks`); версии git, node и менеджера с требуемой версией и её
источником; наличие CLI `claude`/`codex` — `available`, `missing` или
`version-error`, авторизация всегда `unknown`. `diagnostics` — коды с
`severity` (`blocker`, `warning`, `info`), текстом и следующим действием;
`ready` — нет блокирующих.

Инспекция ничего не создаёт (`.harness`, state, refs, индекс Git), не
исполняет scripts манифестов и не вызывает модели: единственные процессы —
Git без optional locks и пробы `--version` во временном каталоге. Маркеры
DevContour и готовый `.harness/` — факты (`info`), а не отказ. `init`
определяет корень и профиль тем же алгоритмом; хост применяет к фактам свои
правила размещения.

## Планирование

План составляет сам ведущий агент: отдельная модель-планировщик не
вызывается, ни `plan-request`, ни `plan-check` не запускают runtime, не
открывают state и ничего не пишут. Draft ничего не согласовывает:
согласование — только `review-plan` / `approve` / `run`.

```sh
$H plan-request --brief .harness/work/<id>.brief.md --policy .harness/policy.json \
  [--requirements [<repositoryId>:]docs/spec.md] [--contracts <dir>] [--context F] [--human]
$H plan-check --draft .harness/work/<id>.draft.json --policy .harness/policy.json \
  [--brief .harness/work/<id>.brief.md --basis <basis>] [--contracts <dir>] [--context F]
```

1. Постановка пользователя — файл `.harness/work/<id>.brief.md`.
   Неоднозначности цели разрешаются вопросами человеку, ответ входит в
   постановку.
2. `plan-request` (`cliDataSchemas['plan-request']`) возвращает `prompt`,
   `readOnly: true`, `recommendedTasks` (15), `maxTasks` (30), `facts`
   (`PlanningFacts`: репозитории, роли с `writePaths` и `requiresContract`,
   gates и группы, пакеты контекста, ресурсы, контракты с digest) и `basis` —
   digest постановки и фактов. `--requirements` называет закоммиченный файл
   с разделами `## REQ-*`: снимок требований на `HEAD` входит в prompt; файл
   вне Git — `NOT_READY`. Контекст по умолчанию — каталоги
   `<каталог политики>/work/context/<id>`. `--human` печатает только prompt.
3. Draft пишется по `schemas/plan-draft.schema.json`; пример —
   `templates/plan-draft.json` установленного пакета. Ключ задачи становится
   ID поручения, `description` — его целью, `writePaths` — областью записи
   (без них — весь репозиторий). Роли, gates, контракты, ресурсы и пакеты
   контекста берутся только из `facts`; требования копируются из снимка без
   изменений. Лишние ключи (например `approved`, `status`) отбрасываются.
4. `plan-check` (`cliDataSchemas['plan-check']`) проверяет draft против
   фактов и собирает `WorkGraph`: ответ `ok: true` с `issues`, `checkPlan`, а
   без проблем — `graph`, `graphDigest` и `basis`. ID графа — имя файла без
   `.draft.json`. Exit — 0 без проблем, иначе по классу первой проблемы.
5. Граф без изменений сохраняется в `.harness/work/<id>.json`; дальше —
   `validate`, `review-plan`, `run`. Digest записи ревью равен `graphDigest`.

| Проблема                                                                                  | Код                                              | Exit | Действие                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------ | ---- | ----------------------------------------------------------------- |
| неизвестная роль, репозиторий, контракт, ресурс, пакет контекста; область записи вне роли | `INVALID_INPUT`                                  | 2    | исправить draft; ID и digest не подставляются                     |
| требование не найдено в источнике на `HEAD` или его digest выдуман                        | `INVALID_INPUT`                                  | 2    | скопировать требование из снимка `plan-request`                   |
| неизвестный gate или группа, цикл групп                                                   | `GATE_UNKNOWN`, `GATE_GROUP_CYCLE` + `checkPlan` | 2    | подготовить проверку (`declare-gate`), а не удалять gate из draft |
| в области задачи нет test gate                                                            | `INVALID_INPUT` + `checkPlan`                    | 2    | подготовить проверку (`add-test-gate`), а не снижать требования   |
| постановка или факты изменились после `plan-request` (`--basis`); требование изменилось   | `APPROVAL_STALE`                                 | 3    | повторить `plan-request` и составить draft заново                 |
| источник требований не обычный Git-файл                                                   | `NOT_READY`                                      | 3    | закоммитить источник                                              |

`checkPlan` — что подготовить, прежде чем согласовывать основную работу:
`gate-undeclared` / `declare-gate` (gate, как он написан в draft) или
`test-gate-missing` / `add-test-gate`, со списком объявленных test gates
репозитория. Gate объявляется в `.harness/policy.json` или локальном профиле
(проверка — `doctor --policy` или `init --plan`), либо отдельный bootstrap-граф,
доказанный уже объявленными gates. Смена политики меняет факты, а с ними
`basis`: draft составляется заново.

`plan-check` не запускает gates и не проверяет наличие `testId`: gates
исполняются только на кандидате и интеграции, никогда на base. Новый тест
пишется в той же задаче, что и поведение, которое он доказывает, и
связывается требованием (test gate, сценарий, `testId`): до реализации он
может падать, на принятом коммите обязан пройти. Задача, чьи gates заведомо
красные, не планируется; проект, падающий уже на base, — отдельная первая
задача.

Без `--basis` новая постановка даёт новый `source.revision` графа и, значит,
новый `graphDigest`: прежнее ревью к нему не относится.

## Граф, запуск, результат

Граф — `data.graph` из `plan-check`, сохранённый в `.harness/work/<id>.json`.
Граф можно написать и вручную по шаблону `templates/graph.json` установленного
пакета; `repositoryId`, роль, gates и область записи берутся только из `facts`.

```sh
$H validate --graph .harness/work/<id>.json --policy .harness/policy.json
$H run --graph .harness/work/<id>.json --policy .harness/policy.json \
  --state <manifest.paths.state> --author claude
$H result --state <manifest.paths.state> --work <order-id>
```

`result.outcome: accepted` и `result.shas.result`, равный
`git rev-parse refs/heads/harness/accepted`, — приёмка; зелёный exit сам по
себе ею не является.

**Принятая версия и текущая.** У принятого поручения `status`
(`works[].target`), `result` (`target`) и `report` (раздел «After acceptance»,
`targets`) сверяют принятый SHA с текущим target ref: `acceptedSha`, `head`,
`commitsSinceAccepted`, `filesSinceAccepted`, `diverged` (ref переписан) или
`unavailable` (git не ответил) и строку `line` / `lineEn`, например
«принято на 3f2a…; после приёмки 2 коммита (3 файла) — не проверены»
(`status --human` печатает обе). Коммиты после приёмки этим принятием не
проверены: их принимает новое поручение `harness run`, а проверяет
`harness gates --sha <target ref>` и `review-code --base <acceptedSha> --head <target ref>` (проверка, не приёмка). Сверка — только чтение Git:
один `rev-parse` на репозиторий и по три вызова на принятый SHA, не дольше 10 с на вызов и 30 с на ответ; причина `unavailable` — класс (ref не прочитан, git не ответил, checkout не доверен), без путей машины.

## Gates на коммите: `harness gates`

Перед долгим циклом сначала прогоните дешёвые решающие gates:
`harness gates --gate …`. Команда исполняет названные gates (и их
предпосылки) на коммите тем же исполнением, что integration поручения, но вне
попытки: ни попыток, ни состояния поручений она не пишет, модели не
вызываются.

```sh
$H gates --state <manifest.paths.state> --policy .harness/policy.json \
  --sha HEAD --gate lint,unit --fail-fast [--human]
```

`data.gates[]` — исход каждого gate: `passed`, `failed`, `not-run` (не прошла
предпосылка) или `skipped` (`--fail-fast` после первого провала); exit 0 — все
прошли, 3 — нет. Без `--gate` исполняются все gates; без `--fail-fast` провал
не останавливает остальные. Логи — в `data.logs`. Это проверка, а не приёмка:
принимает работу только `run`.
Итог проверки записывается рядом с логами (`<state>/gates-at/<id>/result.json`):
его прикладывает `review-code` того же SHA.

## Обзор написанной ветки: `harness review-code`

Код, написанный вне harness (ведущим агентом или человеком), можно отдать на
независимый технический обзор без поручения:

```sh
$H review-code --state <manifest.paths.state> [--policy .harness/policy.json] \
  --base main --head feat/x [--role developer] [--author claude] [--repository app]
```

Reviewer выбирается правилом ревью кода роли (`--role`; одна роль — по
умолчанию) по вендору автора (`--author`, по умолчанию writer роли): другой
вендор, тот же — только при `vendor: same-vendor-allowed`, иначе
`REVIEWER_SAME_VENDOR` до вызова модели; запись отмечает `sameVendor`. Reviewer
получает diff `merge-base(base, head)..head` (не больше 4 МиБ) и читает
отдельное рабочее дерево на `head`, только чтение; дерево убирается после
вызова. Если в каталоге состояния есть итог `harness gates --sha` на этом
`head`, он прикладывается к запросу и к записи (`gates`); gates команда сама не
исполняет.

Ответ — запись `kind: code`, `acceptance: false` (`cliDataSchemas['review-code']`):
`base`, `head`, `mergeBase`, `files`, `commits`, `approved`, `summary`,
reviewer, находки в той же форме, что у ревью плана, и путь `artifact`. Exit 0 —
одобрено, 3 — не одобрено (блокирующие находки, ответ вне протокола, изменённое
reviewer дерево) или прервано (`CANCELLED`). Повтор по тем же `--base`/`--head`
(как названы) — следующий раунд: reviewer называет состояние прежних открытых
находок; тот же одобренный `head` с тем же reviewer и тем же итогом gates — тот
же раунд без вызова.
Записи хранятся в `code-reviews` каталога состояния. Это наблюдение, а не
приёмка: поручения, попытки и target ref не меняются, принимает только `run`.

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

`--human` (только `init`, `status`, `explain`, `plan-request` и `gates`) печатает текст вместо успешного
конверта; отказ остаётся JSON-конвертом. Exit code одинаков в обоих режимах.

**Сводка попыток.** `status` (`works[].attemptSummary`) и `explain`
(`attempts[]`) дают строку на поручение: попыток всего, отказы по классам
отчёта, из них по времени, прерванные штатной остановкой (не отказы),
принятые и остаток попыток и восстановлений группы. Числа считаются из
хранилища теми же правилами, что `harness report`. На вопрос «сколько ещё»
ведущий агент цитирует эту строку и `result.outcome`, а не оценивает время;
«исправлено» (есть кандидат), «проверка прошла» (gate прошёл) и «принято»
(`outcome: accepted`) — разные состояния.

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

## Каталог и пределы ответа

`harness capabilities` возвращает каталог общих операций (`init`, `explain`,
`plan-request`, `plan-check`, `capabilities`): для каждой — описание,
`readOnly`, JSON Schema входа и данных ответа, а также пределы UTF-8 байт
(`maxInputBytes` 100000, `maxResultBytes` 1048576). Каталог строится из договора
CLI — второй копии описаний нет. Ответ общей операции сверх предела — отказ
`RESPONSE_TOO_LARGE` (exit 2) без усечения данных: сузьте вход (`--work`,
постановка, файлы требований).

Для хостов: `operationCatalog` строит каталог из своих операций и схем (тем
же построителем, что `capabilities`, но отдельно от каталога harness);
`jsonBytes`, `checkJsonBytes` и `utf8Bytes` — байтовые проверки транспорта
(отказ формирует хост); `pageItems` — страницы с cursor (`json-base64url` с
привязкой к ревизии и запросу или `digest-offset` по ревизии; чужой или
устаревший cursor — `REVISION_CONFLICT`, элемент, не помещающийся в страницу,
— `RESPONSE_TOO_LARGE`). `resolveProfile(ref, { includeLeafContent: true })`
дополнительно возвращает текст файла листа (`leafContent`); digest не меняется.
`resolveProfile(ref, { layerSchema })` разбирает профили схемой файла хоста
(закреплённые у хоста профили своей формы) при прежних сложении, проверках
gates и digest.
