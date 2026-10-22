# Только файлы

Поручение — `graph.json`, контекст — каталог `context/<id>/`, результат —
каталог получателя. Ни сервисов, ни базы задач.

```text
notes-app/
  graph.json            поручение add-tags ссылается на контекст "norms"
  policy.json
  context/norms/rules.md закрепляется за попыткой целиком
```

```sh
npx harness validate --graph graph.json --policy policy.json
npx harness run --graph graph.json --policy policy.json --state ../notes-state \
  --sink file:../notes-results
npx harness result --state ../notes-state --work add-tags
```

Без `--context` CLI собирает снимок из `context/` рядом с графом: каждый
источник — подкаталог, файлы закрепляются с digest и содержимым; файлы
`references/` — справочные. Снимок передаётся writer и reviewer одними и теми
же байтами, его digest попадает в `result.inputs.contextDigest`. Файлы
контекста из этого репозитория — защищённые пути попытки.

Получатель `file:D` пишет `D/<workId>.json`. Повтор `harness deliver`
идемпотентен по ключу и не вызывает моделей или интеграции; если граф
уже в новой редакции, доставка старого результата — `conflict`.
