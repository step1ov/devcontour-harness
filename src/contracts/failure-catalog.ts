// Справочник причин отказов для оператора (0.1.0-alpha.70,
// docs/failure-causes.md). Каждый класс отказа (`failureKinds`) и каждая
// причина окружения (`environmentCauses`): что это значит, кто действует и
// типичные исправления. Чистые данные без node:* — их читают status, explain
// и представление (ссылка `docs/failure-causes.md#<id>`), документ сверяет
// контрактный тест. Кто действует — то же, что в принципе «Кто принимает
// решения»; справочник ничего не решает.

import type { FailureKind } from './execution.ts';
import type { EnvironmentCause } from './events.ts';

/** Кто действует: harness сам (повтор), ведущий, человек, исполнитель следующей попытки. */
export type CatalogActor = 'harness' | 'lead' | 'user' | 'writer';

export interface FailureCatalogEntry {
  id: string;
  meaning: string;
  actor: CatalogActor;
  fixes: string[];
}

export const FAILURE_CAUSES_DOC = 'docs/failure-causes.md';

/** Классы отказа попытки. */
export const failureKindCatalog: Record<FailureKind, Omit<FailureCatalogEntry, 'id'>> = {
  'provider-auth': {
    meaning: 'Провайдер модели отказал: нет кредитов, лимит сессии или частоты, вход не выполнен.',
    actor: 'user',
    fixes: [
      'пополнить счёт или дождаться сброса лимита',
      'выполнить вход runtime (codex login, claude setup-token)',
    ],
  },
  environment: {
    meaning: 'Окружение не дало исполнителю или проверке работать; попытка не засчитана.',
    actor: 'harness',
    fixes: [
      'один автоматический повтор',
      'второй такой же — чинить окружение по причине (см. причины ниже)',
    ],
  },
  timeout: {
    meaning: 'Попытка исчерпала время.',
    actor: 'harness',
    fixes: ['один повтор', 'затем разделить задачу или осознанно поднять runTimeoutMs'],
  },
  stalled: {
    meaning: 'Процесс жив, но дольше порога не двигался; обход controller его остановил.',
    actor: 'harness',
    fixes: [
      'один повтор',
      'чинить зависшую среду (сеть, сервис, блокировку) или поднять stallSweep',
    ],
  },
  'context-exhausted': {
    meaning: 'Исполнителю не хватило окна контекста модели.',
    actor: 'lead',
    fixes: ['разделить задачу', 'сузить контекст: меньше файлов и вывода в подсказке'],
  },
  'stale-base': {
    meaning: 'База прогонов отстала от рабочей ветки.',
    actor: 'lead',
    fixes: ['harness base-update при остановленной очереди'],
  },
  'empty-result': {
    meaning: 'Исполнитель отчитался о выполнении, не изменив ни файла.',
    actor: 'writer',
    fixes: ['повтор с этим отказом в подсказке', 'второй такой же — ведущий переставит задачу'],
  },
  unfinished: {
    meaning: 'Исполнитель сообщил, что не доделал; черновик сохранён.',
    actor: 'writer',
    fixes: [
      'повтор продолжает с черновика',
      'та же незавершённость сверх предела — разделить задачу',
    ],
  },
  'scope-violation': {
    meaning: 'Изменения вышли за область записи задачи или роли.',
    actor: 'writer',
    fixes: [
      'повтор получает точный список путей',
      'второй такой же — ведущий поправит область задачи',
    ],
  },
  gate: {
    meaning: 'Настроенная проверка не прошла.',
    actor: 'writer',
    fixes: [
      'повторы получают вывод проверки',
      'тот же провал держится — разбор ведущего (harness diagnose)',
      'тот же провал в несвязанных попытках — проверить gate на базе (harness gates --sha <база>)',
    ],
  },
  review: {
    meaning: 'Независимое ревью отклонило результат (после второго прохода, если он включён).',
    actor: 'writer',
    fixes: [
      'повторы получают находки адресно',
      'одна и та же находка трижды — разбор ведущего',
      'ложная находка — review-accept ведущего или второй проход (review.passes)',
    ],
  },
  'review-protocol': {
    meaning: 'Ответ reviewer нарушил протокол ревью, повторы reviewer исчерпаны.',
    actor: 'user',
    fixes: ['проверить reviewer и его модель', 'повторить работу (harness retry)'],
  },
  merge: {
    meaning: 'Слияние с веткой интеграции не сошлось.',
    actor: 'harness',
    fixes: ['повтор от нового состояния базы', 'второй такой же конфликт разбирает человек'],
  },
  cancelled: {
    meaning: 'Работа остановлена человеком.',
    actor: 'user',
    fixes: ['повторить работу явно, если нужно (harness retry)'],
  },
  budget: {
    meaning: 'Бюджет расходов или времени исчерпан либо не определён.',
    actor: 'user',
    fixes: [
      'поднять предел budgets осознанно',
      'задать цену модели (prices) или budgets.onUnknown',
    ],
  },
  'needs-lead': {
    meaning:
      'Нужно решение ведущего: результат без изменений без основания, неполные входы, остановка исполнителя из-за окружения или предложение разделить работу.',
    actor: 'lead',
    fixes: [
      'принять задачу без изменений или поставить заново',
      'восстановить входы и повторить',
      'решить предложение (harness proposal) и повторить (retry --by lead)',
    ],
  },
  'needs-input': {
    meaning: 'Исполнитель остановился с вопросом не ниже порога политики вопросов.',
    actor: 'lead',
    fixes: ['ответить (harness input-answer; продуктовый вопрос — владелец) и применить ответ'],
  },
  unknown: {
    meaning: 'Класс отказа не определён.',
    actor: 'user',
    fixes: ['разобрать журнал попытки', 'повторить явно'],
  },
};

/** Причины отказа окружения (`attempt.diagnosed`). */
export const environmentCauseCatalog: Record<EnvironmentCause, Omit<FailureCatalogEntry, 'id'>> = {
  'sandbox-launch': {
    meaning: 'Песочница ОС не запустила процесс.',
    actor: 'lead',
    fixes: [
      'harness doctor --probe-sandbox',
      'облегчённый режим (граница записи вместо песочницы)',
    ],
  },
  'sandbox-network': {
    meaning: 'Песочница закрыла сеть, нужную шагу.',
    actor: 'lead',
    fixes: ['добавить домен в isolation.domains', 'вынести шаг в gate или подготовку'],
  },
  'sandbox-filesystem': {
    meaning: 'Песочница или граница записи закрыла путь, куда шаг пишет.',
    actor: 'lead',
    fixes: ['добавить кеш в writeGuard.add', 'направить инструмент в TMPDIR попытки'],
  },
  'sandbox-policy': {
    meaning: 'Правило песочницы не применилось к пути (непрочитанный путь).',
    actor: 'lead',
    fixes: ['проверить защищённые пути и права', 'harness doctor'],
  },
  'sandbox-process-list': {
    meaning: 'Gate запускает ps, а песочница ОС его не даёт; gate удержан.',
    actor: 'lead',
    fixes: ['убрать ps из gate', 'облегчённый режим', 'retry --by lead после правки'],
  },
  'sandbox-signal': {
    meaning: 'Gate посылает сигнал процессу вне песочницы (kill EPERM); gate удержан.',
    actor: 'lead',
    fixes: ['убрать сигнал из gate', 'облегчённый режим'],
  },
  'sandbox-browser': {
    meaning: 'Браузер не стартует в песочнице ОС проверок; gate удержан.',
    actor: 'lead',
    fixes: [
      'облегчённый режим и UI gate (Playwright)',
      'Chrome с --no-sandbox и профилем в TMPDIR',
    ],
  },
  'gate-definition': {
    meaning:
      'Gate молча падает и на базе или его команда не нашла инструмент или браузер (GATE_TOOL_MISSING): правка команды gate или окружения, а не кода задачи; gate удержан.',
    actor: 'lead',
    fixes: [
      'поменять команду gate, чтобы при провале она печатала выжимку',
      'установить инструмент или браузер, поправить команду gate',
      'retry --by lead',
    ],
  },
  'dependency-network': {
    meaning: 'Установка зависимостей не достала реестр.',
    actor: 'harness',
    fixes: ['повтор', 'хранилище зависимостей или зеркало реестра'],
  },
  'provider-auth': {
    meaning: 'Провайдер модели отказал во входе.',
    actor: 'user',
    fixes: ['выполнить вход runtime'],
  },
  'provider-limit': {
    meaning: 'Лимит провайдера (частота, сессия, кредиты).',
    actor: 'user',
    fixes: ['дождаться сброса лимита или пополнить счёт'],
  },
  transport: {
    meaning: 'Обрыв соединения или потока runtime.',
    actor: 'harness',
    fixes: ['повтор'],
  },
  preflight: {
    meaning: 'Отказ до начала работы: исполнитель не вызывался.',
    actor: 'lead',
    fixes: ['восстановить входы работы (снимок контекста) и повторить'],
  },
  'lease-expired': {
    meaning: 'Владение попыткой истекло (controller не продлевал аренду).',
    actor: 'harness',
    fixes: ['повтор', 'проверить, не перегружена ли машина'],
  },
  stalled: {
    meaning: 'Попытка зависла (нет вывода, процессора, стадий).',
    actor: 'harness',
    fixes: ['повтор', 'чинить зависшую среду или поднять stallSweep'],
  },
  shutdown: {
    meaning: 'Штатная остановка controller прервала попытку; работа вернулась в очередь.',
    actor: 'harness',
    fixes: ['ничего: выдача продолжится после запуска'],
  },
  'process-reap': {
    meaning: 'Потомки проверки не остановлены или не пересчитаны.',
    actor: 'lead',
    fixes: ['убрать оставшиеся процессы', 'проверить gate на фоновые процессы'],
  },
  cleanup: {
    meaning: 'Уборка окружения после попытки не прошла.',
    actor: 'lead',
    fixes: ['harness worktree-cleanup', 'проверить teardown lifecycle'],
  },
  'resource-busy': {
    meaning: 'Ресурс попытки (порт, устройство) занят.',
    actor: 'harness',
    fixes: ['повтор', 'освободить ресурс или добавить его в пул'],
  },
  'writer-environment': {
    meaning: 'Исполнитель остановился: окружение закрыло обязательный шаг; не засчитана.',
    actor: 'lead',
    fixes: [
      'harness smoke --writer-probe',
      'разрешить шаг в политике или вынести в gate',
      'retry --by lead',
    ],
  },
  'writer-split': {
    meaning: 'Исполнитель в начале попытки предложил разделить работу; кода нет, не засчитана.',
    actor: 'lead',
    fixes: [
      'harness proposal --decision accept и внести части в план (review-plan)',
      'или reject с основанием и retry --by lead',
    ],
  },
  'gate-environment': {
    meaning:
      'Тонкий режим: проверка сдачи упала до кода (нет инструмента, таймаут без упавшего теста) и после автоповтора; не засчитана.',
    actor: 'lead',
    fixes: [
      'разобрать вывод проверки в причине отказа',
      'починить окружение или команду gate',
      'retry --by lead',
    ],
  },
  'merge-conflict': {
    meaning: 'Тонкий режим: дерево работы не сливается с текущей целью; не засчитана.',
    actor: 'lead',
    fixes: [
      'retry --by lead: исполнитель сольёт цель в дерево работы и разрешит конфликт',
      'или переставить порядок работ',
    ],
  },
  toolchain: {
    meaning: 'Закреплённый toolchain не разрешился или его версия не та.',
    actor: 'lead',
    fixes: ['harness doctor', 'установить закреплённую версию Node.js'],
  },
  other: {
    meaning: 'Другая причина окружения.',
    actor: 'lead',
    fixes: ['разобрать журнал попытки'],
  },
  none: {
    meaning: 'Причина не окружения: смотрите класс отказа.',
    actor: 'writer',
    fixes: ['см. класс отказа'],
  },
};

/** Якорь справочника: классы — `kind-<id>`, причины окружения — `cause-<id>`. */
export const failureKindRef = (kind: FailureKind) => `${FAILURE_CAUSES_DOC}#kind-${kind}`;
export const environmentCauseRef = (cause: EnvironmentCause) =>
  `${FAILURE_CAUSES_DOC}#cause-${cause}`;

/** Ссылка для отказа: названная причина окружения важнее класса; `none` — класс. */
export function failureRefOf(kind: FailureKind | undefined, cause?: string): string | undefined {
  if (cause && cause !== 'none' && Object.hasOwn(environmentCauseCatalog, cause))
    return environmentCauseRef(cause as EnvironmentCause);
  return kind ? failureKindRef(kind) : undefined;
}

const actorRu: Record<CatalogActor, string> = {
  harness: 'harness сам (повтор)',
  lead: 'ведущий',
  user: 'человек (владелец)',
  writer: 'исполнитель следующей попытки',
};

/** Текст docs/failure-causes.md: документ сверяет контрактный тест. */
export function failureCausesMarkdown(): string {
  const section = (prefix: string, entries: [string, Omit<FailureCatalogEntry, 'id'>][]) =>
    entries.flatMap(([id, e]) => [
      `<a id="${prefix}-${id}"></a>`,
      '',
      `### \`${id}\``,
      '',
      e.meaning,
      '',
      `Кто действует: ${actorRu[e.actor]}.`,
      '',
      ...e.fixes.map((f) => `- ${f}`),
      '',
    ]);
  return [
    '# Справочник причин отказов',
    '',
    '<!-- Генерируется из src/contracts/failure-catalog.ts (failureCausesMarkdown); правьте там. -->',
    '',
    'Что значит каждый класс отказа попытки и каждая причина окружения, кто действует и что обычно помогает. `status`, `explain` и представление ссылаются сюда (`docs/failure-causes.md#kind-<класс>`, `#cause-<причина>`). Кто решает — по [принципу](principles.md#кто-принимает-решения); справочник ничего не решает.',
    '',
    '## Классы отказа',
    '',
    ...section('kind', Object.entries(failureKindCatalog)),
    '## Причины окружения',
    '',
    ...section('cause', Object.entries(environmentCauseCatalog)),
  ].join('\n');
}
