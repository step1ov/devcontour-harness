# Пример: одна задача

Вымышленный репозиторий с одним поручением: добавить `greet(name)` в
`src/greet.js`. Проверка — `node test/run.js`, она пишет JUnit-отчёт в путь из
`DEVCONTOUR_REPORT_PATH`.

```sh
cp -R node_modules/devcontour-harness/examples/single-task greeting && cd greeting
git init -q && git add -A && git commit -qm init
npx harness validate --graph graph.json --policy policy.json
npx harness run --graph graph.json --policy policy.json --state ../greeting-state --author external --sink file:../greeting-results
npx harness result --state ../greeting-state --work add-greeting
git rev-parse refs/heads/harness/accepted   # совпадает с result.shas.result
```

`policy.json` — writer claude, reviewer codex (разные вендоры).
`policy-same-vendor.json` — reviewer того же вендора, разрешённый явно.
Для запуска нужны установленные и авторизованные CLI `codex` и `claude`.
