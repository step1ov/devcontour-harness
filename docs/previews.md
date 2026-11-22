# Превью результата

Превью — запущенное на этой машине приложение проекта на принятом коммите,
чтобы человек открыл результат в браузере и посмотрел его, а не читал diff.
Harness собирает и запускает приложение в отдельном рабочем дереве, держит его
на loopback-адресе и сам останавливает: по сроку, по простою и по команде
оператора. Мёртвых временных ссылок нет — жизнью превью владеет harness.

Превью — **opt-in** и **только по просьбе человека**:

- запускает оператор или ведущий по его просьбе (`harness preview-start`);
- `harness run`, попытки и gates превью не запускают никогда; команда,
  вызванная внутри попытки или gate (в окружении есть `DEVCONTOUR_RUN_ID`,
  `HARNESS_RUN_ID`, `DEVCONTOUR_PHASE` или `HARNESS_PHASE`), отказывает
  `NOT_READY` и ничего не создаёт;
- посмотрели — остановите (`harness preview-stop`); забыли — превью
  остановится само по `ttlMs` или `idleMs`.

## Описание в профиле и политике

`previews[]` — необязательный список (до 10, ID без повторов) у профиля стека
(`StackProfile.previews`) и у репозитория политики
(`repositories[].previews`). `repositoryFromProfile` и `harness init`
переносят превью профиля в политику; слои профиля объединяются по ID, один ID
в двух слоях — конфликт. Нет поля — профиль, политика и их digest прежние.
Превью не входят в `executionDigest` и `isolationDigest`: правка превью не
требует нового ревью плана и не трогает попытки.

```json
{
  "previews": [
    {
      "id": "web",
      "title": "Сайт",
      "build": [
        { "id": "install", "command": ["npm", "ci"], "timeoutMs": 600000 },
        { "id": "build", "command": ["npm", "run", "build"], "timeoutMs": 600000 }
      ],
      "start": ["npm", "run", "start", "--", "--port", "{port}", "--host", "{host}"],
      "env": { "NODE_ENV": "production", "PUBLIC_URL": "http://127.0.0.1:{port}" },
      "services": true,
      "health": "/health",
      "readyTimeoutMs": 60000,
      "ttlMs": 7200000,
      "idleMs": 1800000
    }
  ]
}
```

| Поле             | Смысл                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`             | ID превью (`[A-Za-z0-9_-]`)                                                                                    |
| `title`          | Подпись для панели                                                                                             |
| `build`          | Шаги до запуска (`{id, command[], timeoutMs?}`, до 20) в рабочем дереве превью                                 |
| `start`          | Команда долгоживущего процесса приложения                                                                      |
| `cwd`            | Каталог `build` и `start` относительно корня дерева                                                            |
| `env`            | Значения окружения поверх окружения политики и репозитория                                                     |
| `services`       | `true` — вокруг превью идут lifecycle `setup`/`ready`/`teardown` репозитория (БД и прочие службы)              |
| `health`         | Путь готовности от корня (`/` по умолчанию): ответ меньше 400 на `http://127.0.0.1:{port}{health}`             |
| `readyTimeoutMs` | Сколько ждать готовности после запуска (по умолчанию 60 с)                                                     |
| `ttlMs`          | Срок жизни (по умолчанию 2 ч, до 24 ч); `--ttl` команды сильнее                                                |
| `idleMs`         | Остановить после стольких мс без запросов (по умолчанию 30 мин; `0` — не по простою); `--idle` команды сильнее |

**Порт.** Harness выбирает свободный loopback-порт приложения (выдан ОС и
свободен на всех адресах пробы портов) и передаёт его в переменной `PORT` и
подстановке `{port}` — в `start` и значениях `env`. Адрес — `HOST=127.0.0.1`
и `{host}`: приложение должно слушать только loopback. Человек открывает
не порт приложения, а публичный адрес `http://127.0.0.1:<порт>/` —
loopback-прокси harness перед приложением.

## Команды

```sh
harness preview-start --state D [--policy F] [--preview ID] [--ref accepted|SHA|REF] [--work ID] [--repository ID] [--ttl 90s|30m|2h] [--idle 90s|30m|0]
harness preview-list  --state D [--policy F]
harness preview-stop  --state D [--policy F] [--preview ID] [--repository ID] [--all]
```

- `--ref accepted` (по умолчанию) — принятый результат: с `--work` —
  принятый SHA поручения (`resultSha`; поручение не принято — `NOT_READY`),
  без него — вершина `targetRef` репозитория. Иначе — SHA или ref checkout
  (нет такого — `NOT_FOUND`).
- `--preview` и `--repository` нужны, только когда превью несколько.
- Повтор `preview-start` того же превью на том же коммите возвращает идущее
  (`changed: false`); на другом коммите прежнее останавливается (`replaced`)
  и запускается новое. Одно превью (`repositoryId`/`id`) идёт в одном
  экземпляре.
- Превью не поднялось (сборка, службы, запуск, готовность) — `LIFECYCLE_FAILED`
  (exit 4) с причиной и путём лога; рабочее дерево убрано, receipt — `failed`.
- `preview-stop` без `--preview` останавливает все живые превью. Тот же ID
  превью в нескольких репозиториях без `--repository` — отказ `INVALID_INPUT`
  со списком репозиториев; `--all` останавливает его во всех.

Ответы: `preview-start` — `{preview, changed}`, `preview-stop` —
`{previews[], changed}`, `preview-list` — `{previews[]}`; элемент — receipt
превью.

## Как harness владеет жизнью превью

1. `preview-start` создаёт рабочее дерево превью — `git worktree add
--detach` на коммите — в `<state>/previews/<репозиторий>/<превью>/tree`
   (не в деревьях исполнителей) и запускает **надзирающий процесс**
   (supervisor) отдельной группой процессов, отсоединённым от вызывающего.
   Команда ждёт, пока превью ответит, и возвращает адрес.
2. Supervisor поднимает lifecycle репозитория (`services: true`), исполняет
   `build`, запускает `start` в своей группе процессов, ждёт `health`, затем
   поднимает loopback-прокси на публичном порту (`127.0.0.1`, порт выдаёт
   ОС) и пишет receipt `running` с адресом.
3. Прокси передаёт байты в обе стороны (HTTP, WebSocket) и отмечает каждую
   порцию запроса — это `lastActivity`. Простой — нет запросов дольше
   `idleMs`: открытое соединение без запросов простой не прерывает.
4. По сроку, простою или SIGTERM (`preview-stop`) supervisor останавливает
   группу приложения (TERM, затем KILL), закрывает прокси, исполняет
   lifecycle `teardown`, убирает рабочее дерево и пишет итоговый receipt.
5. `preview-list` и `preview-stop` сверяют receipt с процессами (PID и время
   старта по `ps`): если supervisor пропал (машина перезагружена, процесс
   убит), приложение останавливается по receipt, `teardown` — по receipt
   окружения, рабочее дерево убирается, receipt — `failed`
   (`supervisor-gone`).

Receipt — `<state>/previews/<репозиторий>/<превью>/receipt.json`
(`previewReceiptSchema`): `id`, `repositoryId`, `title`, `ref`, `workId`,
`sha`, `worktree`, `dir`, `log` (вывод приложения; там же логи `build/`,
`environment/` и `supervisor.log`), `services`, `port`, `url`, `appPort`,
`pids {supervisor, app}`, `starts` (время старта процессов), `startedAt`,
`expiresAt`, `ttlMs`, `idleMs`, `lastActivity`, `state`
(`starting`, `running`, `stopping`, `stopped`, `failed`), `reason`
(`operator`, `ttl`, `idle`, `replaced`, `exited`, `build`, `services`,
`start`, `health`, `supervisor-gone`), `message`, `stoppedAt`. Каталог
превью переиспользуется следующим запуском того же превью.

Ограничения: превью — для этой машины (loopback), не для публикации;
одновременные `preview-start` одного превью не согласуются между собой
(запускайте по одному); приложение, которое игнорирует `HOST` и слушает все
адреса, harness не останавливает — опишите `start` так, чтобы он слушал
`{host}`.

## Панель

Представление оператора (`harness view`) показывает живые превью полем
`previews[]` — `{id, repositoryId, title?, url, ref, sha, workId?, startedAt,
expiresAt, state: "running"}`; нет живых — поля нет. Панель рисует
«Посмотреть результат» со ссылкой `url` и «остановить»
(`harness preview-stop --state D --preview <id>`); у принятой работы, для
которой превью не идёт, ведущий по просьбе запускает
`harness preview-start --state D --ref accepted --work <id>`.

Библиотека: `startPreview`, `stopPreviews`, `listPreviews`, `livePreviews`.
