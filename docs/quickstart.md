# Quickstart

Пять минут от пустого каталога до принятого поручения. Пример — вымышленный
репозиторий `greeting` с одной задачей: добавить функцию `greet(name)`.

## 1. Что понадобится

- Node.js ≥ 24.3.0 и Git.
- Установленные и авторизованные CLI `claude` и `codex` — writer и reviewer
  примера. `harness doctor` проверяет их без вызова модели.
- npm (идёт с Node.js) — для установки из registry или из локального архива.

```sh
mkdir harness-demo && cd harness-demo
npm init -y >/dev/null
npm install --save-exact devcontour-harness@0.1.0-alpha.15
npx harness --version
npx harness doctor
```

Вместо точной версии можно взять текущую alpha: `devcontour-harness@alpha`.
Без registry пакет ставится из архива:
`npm install --omit=dev --ignore-scripts ./devcontour-harness-<version>.tgz`.

CLI установлен локально, в `node_modules/.bin` каталога `harness-demo`.
`npx harness` находит его из этого каталога и его подкаталогов (дальше
работа идёт в `harness-demo/greeting`); глобальная команда `harness` не
нужна.

## 2. Репозиторий и входы

```sh
cp -R node_modules/devcontour-harness/examples/single-task greeting
cd greeting
git init -q -b main && git add -A && git commit -qm init
```

В каталоге:

| Файл                      | Что это                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `graph.json`              | `WorkGraph`: одно поручение `add-greeting` с критериями приёмки  |
| `policy.json`             | `ExecutionPolicy`: репозиторий, gate `unit` с JUnit, роли, ревью |
| `policy-same-vendor.json` | Та же политика, но reviewer того же вендора, разрешённый явно    |
| `test/run.js`             | Проверка: пишет JUnit-отчёт в путь из `DEVCONTOUR_REPORT_PATH`   |

Поручение в `graph.json`:

```json
{
  "id": "add-greeting",
  "title": "Add a greeting function",
  "goal": "Add greet(name) to src/greet.js returning 'Hello, <name>!'.",
  "acceptance": ["greet('Ada') returns 'Hello, Ada!'", "npm test passes with a JUnit report"],
  "role": "developer",
  "repositoryId": "app",
  "writeScope": ["src"],
  "gates": ["unit"]
}
```

## 3. Проверить входы

```sh
npx harness validate --graph graph.json --policy policy.json
```

Команда не вызывает моделей и ничего не пишет. В ответе — digests графа и
политики и число поручений. Любая ошибка — exit 2 и список `issues` с путями.

## 4. Запустить

```sh
npx harness run --graph graph.json --policy policy.json \
  --state ../greeting-state --author external --sink file:../greeting-results
```

`run`:

1. регистрирует граф и проводит техническое ревью плана reviewer-ом из
   политики (здесь — codex);
2. согласует граф (`approvalMode: agent`; при `operator` нужен `harness approve`);
3. выдаёт попытку writer-у (claude) в отдельном Git worktree;
4. прогоняет gate `unit` и независимое ревью на candidate SHA;
5. интегрирует кандидата с текущей принятой веткой, снова прогоняет gate и
   ревью — уже на integration SHA;
6. продвигает `refs/heads/harness/accepted` compare-and-swap и записывает
   результат; `--sink` доставляет его в каталог `../greeting-results`.

Основная ветка и рабочее дерево не меняются. Повторный `run` той же редакции
графа продолжает работу и не создаёт второй попытки.

## 5. Прочитать результат

```sh
npx harness result --state ../greeting-state --work add-greeting
```

Сокращённый ответ (SHA и digests здесь условные):

```json
{
  "apiVersion": "devcontour-harness/v1alpha1",
  "command": "result",
  "ok": true,
  "data": {
    "apiVersion": "devcontour-harness/v1alpha1",
    "result": {
      "outcome": "accepted",
      "workOrderId": "add-greeting",
      "graphId": "greeting",
      "runId": "…",
      "attempt": 1,
      "repositoryId": "app",
      "targetRef": "refs/heads/harness/accepted",
      "shas": {
        "base": "1111…",
        "candidate": "2222…",
        "integration": "3333…",
        "result": "3333…"
      },
      "inputs": {
        "harnessVersion": "<version>",
        "stateVersion": 1,
        "workOrderDigest": "…",
        "graphDigest": "…",
        "policyDigest": "…",
        "writer": "claude"
      },
      "evidence": [
        { "kind": "test", "phase": "candidate", "gate": "unit", "sha": "2222…", "passed": true },
        {
          "kind": "review",
          "phase": "candidate",
          "gate": "independent-review",
          "sha": "2222…",
          "passed": true
        },
        { "kind": "test", "phase": "integration", "gate": "unit", "sha": "3333…", "passed": true },
        {
          "kind": "review",
          "phase": "integration",
          "gate": "independent-review",
          "sha": "3333…",
          "passed": true
        }
      ],
      "findings": [],
      "limitations": [],
      "finishedAt": "…"
    },
    "delivery": [{ "sink": "files", "status": "delivered", "attempts": 1 }]
  }
}
```

## 6. Проверить result SHA

```sh
git rev-parse refs/heads/harness/accepted      # = data.result.shas.result
git merge-base --is-ancestor <shas.base> refs/heads/harness/accepted && echo ok
git show --stat refs/heads/harness/accepted    # изменения только в src/
```

`result` должен совпасть с вершиной target ref; каждый PASS в `evidence`
относится ровно к `candidate` или `integration` SHA своей фазы.

## 7. Что дальше

- Пауза и продолжение: `harness pause --state D`, `harness resume --state D`.
- Отмена и повтор: `harness cancel --work ID`, `harness retry --work ID`.
- События: `harness events --state D --after N`.
- Один вендор: запустите с `--policy policy-same-vendor.json` — reviewer того
  же вендора допускается только потому, что политика это явно разрешает.
- Другие конфигурации — в `examples/` этого руководства.
- Свой существующий npm/pnpm-репозиторий: `harness init` готовит `.harness/`
  (политика из профиля, state вне репозитория), `harness explain` объясняет
  остановки — [standalone](standalone.md).

Исход без принятия (`rejected`, `blocked`, `stopped`, `cancelled`) несёт
`stopReason{code, message}`; result SHA у него нет. Exit codes: 0 успех,
2 неверный вход, 3 отказ или блокировка, 4 инфраструктура.

Тесты пакета используют fixture executables вместо живых CLI; их
результаты проверяют механику, а не качество моделей.
