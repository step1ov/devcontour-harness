# Примеры конфигурации

Все примеры — вымышленные репозитории с gate `unit` (JUnit). Проверка без
моделей и записи, из каталога `examples/`:

```sh
npx harness validate --graph single-task/graph.json --policy two-vendors/policy.json
npx harness validate --graph single-task/graph.json --policy one-vendor/policy.json
npx harness validate --graph files-only/graph.json --policy files-only/policy.json
```

У `files-only/` свой граф с контекстом; политики `two-vendors/` и
`one-vendor/` подходят к графу `single-task/`.

| Каталог               | Что показывает                                                          |
| --------------------- | ----------------------------------------------------------------------- |
| `single-task/`        | одно поручение `add-greeting` — пример быстрого старта                  |
| `two-vendors/`        | writer claude, reviewer codex для кода, плана и контракта (умолчание)   |
| `one-vendor/`         | writer и reviewer одного вендора — только с явным `same-vendor-allowed` |
| `files-only/`         | поручение, контекст и результат только файлами, без внешних сервисов    |
| `external-connector/` | источник поручений и получатель результата через порты библиотеки       |
| `turbo-starter/`      | pnpm/Turborepo-проект с генерацией SDK и Docker lifecycle (см. README)  |

Reviewer задаётся правилом ревью явно; неявного «противоположного runtime»
нет. При `different-vendor` (умолчание) reviewer того же вендора, что автор,
отклоняется ошибкой `REVIEWER_SAME_VENDOR` до вызова модели. `alternates`
перечисляет запасных reviewer: берётся первый допустимый для этого автора.
