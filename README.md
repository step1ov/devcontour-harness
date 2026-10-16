# devcontour-harness

Headless-движок исполнения инженерных поручений: согласованный граф работ,
изолированные попытки в Git worktree, обязательные gates, независимое ревью,
интеграция с принятой веткой через compare-and-swap и машинный результат с SHA
и доказательствами.

> Статус: `0.1.0-alpha.0`. Файл → ревью плана → кандидат → интеграция →
> принятие → результат JSON, с ограниченным восстановлением, повторным
> использованием кандидата, бюджетами, потребителями, свойствами и корпусом,
> совместной проверкой репозиториев и явным режимом одного вендора.

Пакет включает встроенные профили стеков (`profiles/`), skill
`skills/harness/SKILL.md` и шаблоны политики, графа и инструкции агентам
(`templates/`).

## Требования

- Node.js ≥ 24.3.0, Git.
- CLI `codex` и `claude`, установленные и авторизованные (для живого запуска).
  `harness doctor` проверяет их без вызова модели.

## Быстрый старт

Пример — вымышленный репозиторий с одной задачей: добавить `greet(name)`.

```sh
cp -R node_modules/devcontour-harness/examples/single-task greeting && cd greeting
git init -q && git add -A && git commit -qm init
harness validate --graph graph.json --policy policy.json
harness run --graph graph.json --policy policy.json --state ../greeting-state \
  --author external --sink file:../greeting-results
harness result --state ../greeting-state --work add-greeting
git rev-parse refs/heads/harness/accepted   # совпадает с data.result.shas.result
```

`run` регистрирует граф, проводит ревью плана (reviewer по политике),
согласует его и ведёт очередь до простоя. Принятое поручение — коммит
интеграции в `refs/heads/harness/accepted`; ни основная ветка, ни рабочее
дерево не меняются. Результат и состояние доставки — `harness result`.

Конфигурации примера:

| Файл                      | Вендоры                                    |
| ------------------------- | ------------------------------------------ |
| `policy.json`             | writer claude, reviewer codex              |
| `policy-same-vendor.json` | reviewer того же вендора, разрешённый явно |

## Команды

| Команда                                      | Что делает                                         |
| -------------------------------------------- | -------------------------------------------------- |
| `validate --graph F --policy F`              | Проверка входов без моделей и записи               |
| `review-plan / review-contract … --author A` | Раунд технического ревью с историей находок        |
| `approve --state D --subject ID --digest H`  | Согласование оператором (`approvalMode: operator`) |
| `run --graph F --policy F --state D`         | Регистрация, согласование и работа до простоя      |
| `status / events / result --state D`         | Чтение без побочных эффектов                       |
| `pause / resume / cancel / retry --state D`  | Управление очередью и поручением                   |
| `deliver --state D --work ID --sink file:D`  | Повтор доставки без моделей и интеграции           |
| `profile --profile ID [--repository D]`      | Разрешение профиля стека без команд проекта        |
| `doctor`                                     | Версии, runtime, sandbox, совместимость состояния  |

stdout — один JSON (`devcontour-harness/v1alpha1`), диагностика — stderr. Exit
codes: 0 успех, 2 неверный вход, 3 отказ/блокировка, 4 инфраструктура.
`HARNESS_CODEX_BIN` и `HARNESS_CLAUDE_BIN` подменяют исполняемые файлы runtime
— например, fixture executable в тестах (это не живая модель).

## Библиотека

```js
import { Harness, validateInputs } from 'devcontour-harness';
```

Библиотека и CLI вызывают одни и те же операции `Harness`; операции «передать
PASS» нет. Адаптеры хоста реализуют порты `ExecutionStore`, `WorkSource`,
`ContextSource`, `ResultSink`; набор проверок договора хранилища —
`devcontour-harness/testing`.

## Документация

- [Архитектура и границы доверия](docs/architecture.md)
- [Договоры: входы, выходы, порты, ошибки, CLI](docs/contracts.md)
- [Совместимость форматов](docs/compatibility.md)

## Разработка

```sh
npm ci
npm run check         # lint, typecheck, схемы, сборка, тесты, проверка архива
npm run format:check
```

Тесты используют настоящие временные Git-репозитории, SQLite и fixture
executables CLI codex/claude; живые модели не вызываются. Результаты
fixture-тестов не являются проверкой качества моделей.

## Лицензия

MIT, см. [LICENSE](LICENSE).
