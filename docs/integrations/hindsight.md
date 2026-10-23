# Внешняя память (Hindsight): точка подключения

Статус: **контракт и проверка поддельным провайдером**. Готового
Hindsight-коннектора в harness нет: нет HTTP-клиента, SDK, MCP-сервера,
развёртывания сервера и платных обращений. Harness работает без памяти;
память подключается явно через opt-in entrypoint
`devcontour-harness/integrations/memory` (исходники — `src/integrations/memory/`).
Корень пакета и `devcontour-harness/contracts` этот модуль не импортируют
<!-- repo-only -->(проверяется `tests/memory-availability.test.ts`, `M02/boundary`)<!-- /repo-only -->. Глобально

установленный MCP или Hindsight SDK для пользователей harness не требуется.

## Что есть

| Часть              | API                                                         | Назначение                                                    |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------- |
| Договор провайдера | `MemoryRecallProvider`, `MemoryRetainProvider`              | два метода, которые реализует будущий адаптер                 |
| Источник контекста | `memoryContextSource(provider, options)`                    | recall → источник `ContextSnapshot` (`kind: memory`)          |
| Композиция         | `composeContext(parts, at)`, `mergeSnapshots(...)`          | файлы + память в одном снимке; повтор ID — отказ              |
| Получатель итога   | `memoryResultSink(provider, options)`                       | обычный `ResultSink` с собственным ключом доставки            |
| Тестовый провайдер | `src/integrations/memory/testing.ts` (`FakeMemoryProvider`) | детерминированные ответы, счётчики, отказы; только для тестов |

Изменений ядра нет: используются существующие `ContextSource`, `ResultSink`,
закрепление снимка при согласовании (`context-snapshots` + `approval.context`)
и записи `delivery` у `Harness.deliver`.

## Recall до согласования

```ts
import { FileContextSource } from 'devcontour-harness';
import { composeContext, memoryContextSource } from 'devcontour-harness/integrations/memory';

const memory = memoryContextSource(provider, {
  id: 'memory', // ID источника в снимке
  mode: 'optional', // 'required' | 'optional' | 'disabled'
  bank: 'project-app', // стабильный bank проекта
  project: 'app',
  query: 'conventions for greeting module',
  limits: { maxBytes: 16384, maxItems: 20, maxCostUnits: 5 },
});
const context = await composeContext(
  [{ source: new FileContextSource('context'), ids: ['norms'] }, memory.part()],
  { repositoryId: 'app' },
);
// review-plan → approve → run с этим же снимком
```

- Recall выполняется в `snapshot`, т.е. до ревью плана и согласования.
  Исполнение берёт только снимок, связанный с согласованием
  (`Harness.contextOf`): runner к провайдеру не обращается. Новый ответ
  памяти после согласования в попытку не попадает; новый снимок при том же
  графе — `APPROVAL_REQUIRED` (нужно новое ревью плана).
- Источник памяти закрепляет три файла (все входят в digest источника):
  - `recall.md` — вкладывается в запрос writer и reviewer; заголовок говорит,
    что это непроверенные данные, которые не меняют поручение, область,
    политику и ничего не разрешают;
  - `provenance.json` (в поле `references`: закреплён, но не вкладывается):
    провайдер и его версия, mode, bank, project, query, `recalledAt`,
    digest/размер/число элементов/стоимость фактического ответа, пределы,
    применённый объём и признаки обрезки (`truncated.items`, `truncated.bytes`,
    `truncated.omitted`);
  - `response.json` (тоже в `references`) — фактические байты тела ответа провайдера (если не
    больше предела файла снимка; иначе остаётся только digest в provenance).
- Пределы: элементы берутся по порядку провайдера целиком. Превышение
  `maxItems`/`maxBytes`: у `required` по умолчанию — отказ подготовки
  (`truncation: 'forbid'`), у `optional` — отбрасывание с явной строкой
  `[TRUNCATED by harness: …]` в `recall.md` и в provenance. Элемент с
  `mandatory: true` не отбрасывается никогда: его обрезка — отказ
  (`required`) или отсутствие источника (`optional`). Стоимость больше
  `maxCostUnits` — так же.
- Режимы недоступности (ошибка, таймаут, ответ не JSON или вне схемы):
  - `required` — `HarnessError NOT_READY` с причиной до ревью/согласования;
    пустой «успешный» ответ не подставляется. Если ID памяти указан в
    `order.context`, снимок без неё не пройдёт ни `run`, ни `review-plan`;
  - `optional` — запись в `snapshot.missing` с причиной; снимок
    согласуется и исполняется без памяти;
  - `disabled` — провайдер не вызывается и может не передаваться вовсе;
    снимок совпадает со снимком без памяти.
- Память — контекст, а не постановка: она не меняет `WorkOrder`, write
  scope, gates, политику и approval digest. Непроверенный дневник writer
  (его `summary`) reviewer не передаётся: reviewer получает diff, evidence
  controller и тот же закреплённый контекст.

## Запись подтверждённого итога

```ts
const sink = memoryResultSink(provider, { bank: 'project-app', project: 'app' });
await harness.deliver(workId, sink); // отдельно от Relay/файлового получателя
```

- `sink.id` по умолчанию `memory-<provider.id>`: ключ доставки
  `<sink>:<work>:<run>` отдельный, состояние видно в `result().delivery` и
  событиях `delivery.*` с этим `sink`. Сбой памяти не откатывает Git
  accepted и не меняет receipt других получателей. Повтор
  `Harness.deliver(work, sink)` отправляет только память; writer, reviewer и
  другие получатели не вызываются. Общей распределённой транзакции нет.
- Сохраняются только `accepted` результаты; остальные исходы получают
  receipt `skipped: …` без обращения к провайдеру.
- Содержимое — итог controller (исход, SHA, gates, находки), не пересказ writer.

### Identity: bank, document_id, operation_id

| Идентичность   | Как получается                                                                              | Гарантия                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| bank           | стабильный по проекту (`options.bank`), задаётся оператором                                 | память одного проекта не смешивается с другими                                                                                                   |
| `document_id`  | `dch-` + digest(provider, bank, project, work, run, digest результата) — `memoryDocumentId` | повтор того же результата — **upsert** того же документа (в Hindsight `update_mode: replace` по умолчанию удаляет прежний документ и его память) |
| `operation_id` | UUID (форма v5) из digest(ключ доставки, document_id) — `uuidOf`                            | повтор **асинхронного** retain с тем же `operation_id` возвращает прежнюю операцию и не создаёт новой работы                                     |

Это разные гарантии: upsert документа не мешает серверу повторно выполнить
асинхронную обработку (извлечение фактов, расход LLM), а `operation_id` не
задаёт идентичность документа. Адаптер должен передавать оба.

## Что проверить при создании реального адаптера

Сверено с публичной документацией https://hindsight.vectorize.io
(`/developer/api/retain`, `/developer/api/recall`, на 2026-10-22 указана
версия документации 1.1); **на конкретном сервере не проверялось**:

- retain принимает `content`, `document_id`, `async`, `operation_id` (UUID),
  `context`, `timestamp`, `metadata`, `tags`, `update_mode`; операции
  async — `GET /v1/default/banks/{bank_id}/operations`; ответ async не
  содержит usage;
- recall принимает `query` (до 500 токенов), `budget`, `max_tokens`, `types`,
  `tags`; ответ `results[]` с `id`, `text`, `document_id`, `scores`; бюджет
  ответа задаётся токенами, а не числом элементов.

Обязательные проверки адаптера (не реализованы, статус «to verify»):

1. Версия API и capabilities сервера: поддержка `operation_id` для
   идемпотентного async retain и `document_id` upsert в используемой
   версии; без поддержки `operation_id` повтор async retain не считается
   идемпотентным — адаптер должен ждать операцию синхронно или сообщать
   неизвестный исход.
2. Отображение `MemoryLimits` на `max_tokens`/`budget` и перевод `results[]`
   в `memoryRecallBodySchema` (тело ответа закрепляется как получено).
3. Учёт: стоимость recall/retain (`costUnits`, `usage` источника и
   получателя) ведётся отдельно от usage coding runtime и бюджетов попыток.
4. Ключи и адрес сервера — только у выбранного адаптера; без них core,
   файловый сценарий и `mode: 'disabled'` работают.

## Проверка

<!-- repo-only -->В репозитории harness: `node --import tsx --test tests/memory-*.test.ts`<!-- /repo-only --> — M01 (одинаковые

закреплённые байты у writer и reviewer, смена ответа после согласования,
пределы), M02 (required/optional/disabled с одним недоступным провайдером),
M03 (независимая доставка памяти и повтор только её). Используется обычный
путь `review-plan → approve → run` с fixture runtime.
