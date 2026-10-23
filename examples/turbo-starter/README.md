# Turbo Starter (pnpm + Turborepo, Docker lifecycle)

Рецепт для копии [oim-dev/turbo-starter](https://github.com/oim-dev/turbo-starter)
на commit `78f1e76b80f76ae9d4289e0b0994df8a6f2b89cc`. Изменение контракта backend
`AccessTokenDto.issuedAt` проходит путь до OpenAPI, затем до обоих SDK и до потребителя
frontend. Работу проверяют настоящие команды starter и JUnit-проверки примера.

- `policy.json` и `graph.json`: основной сценарий (gates `backend-types`,
  `sdk-generation`, `sdk-build`, `web-types`, `acceptance`).
- `policy.lifecycle.json`: lifecycle `compose-bridge` (PostgreSQL на попытку и фазу).
- `harness/`: копируется в `.harness/` проекта. Внутри мост, compose-стек приёмки,
  шаблоны env и проверки `node --test`.
- `changes/`: подготовленные изменения для fixture writer, верное и несовместимое.

Подробности описаны в [docs/turbo-starter.md](../../docs/turbo-starter.md): как повторить,
схема генерации, мост, порядок принятия, controller mode и ограничения upstream.
