# devcontour-harness

Headless-движок исполнения инженерных поручений: согласованный граф работ,
изолированные попытки в Git worktree, обязательные gates, независимое ревью,
интеграция с принятой веткой через compare-and-swap и машинный результат с SHA
и доказательствами.

> Статус: `0.1.0-alpha.0`, этап договоров. Пакет экспортирует версионируемые
> схемы, типы портов и CLI `harness validate`. Движок, хранилище и коннекторы
> добавляются следующими версиями под этими же договорами.

## Требования

Node.js ≥ 24.3.0.

## Проверить поручение

```sh
harness validate --graph examples/single-task/graph.json --policy examples/single-task/policy.json
```

stdout — JSON с digests графа и политики; exit codes: 0 успех, 2 неверный вход,
3 отказ/блокировка, 4 инфраструктура.

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

## Лицензия

MIT, см. [LICENSE](LICENSE).
