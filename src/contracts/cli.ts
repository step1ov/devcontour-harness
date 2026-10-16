import { API_VERSION } from './version.ts';
import type { ErrorClass, ErrorCode, ErrorIssue } from './errors.ts';

/**
 * Договор CLI `harness`. Каждая команда получает явные пути: состояние,
 * поручение, политику. Бинарник не хранит настроек проекта и не помнит
 * «последний активный проект».
 *
 * stdout — один JSON-объект `CliEnvelope`; диагностика — stderr.
 */
export const cliCommands = {
  validate: 'Проверить поручение, политику и ссылки без вызова моделей и записи состояния',
  'review-plan': 'Техническое ревью конкретного digest графа; история находок сохраняется',
  'review-contract': 'Техническое ревью конкретного digest контракта',
  run: 'Запустить или идемпотентно продолжить работу по графу',
  status: 'Состояние, причины блокировки; без побочных эффектов',
  events: 'События после номера; без побочных эффектов',
  pause: 'Запретить новые claims; активные попытки продолжаются',
  resume: 'Снять паузу оператора; паузы операций и отказов не снимает',
  cancel: 'Отменить работу: отзывает владение, не превращается в retry',
  retry: 'Новая попытка неуспешной работы в пределах лимитов и бюджета',
  result: 'Машинный результат с SHA, evidence и состоянием доставки',
  doctor: 'Версии, runtime/capabilities, среда и совместимость без live-вызова',
} as const;
export type CliCommand = keyof typeof cliCommands;

export type CliEnvelope<T = unknown> =
  | { apiVersion: typeof API_VERSION; command: CliCommand | 'version'; ok: true; data: T }
  | {
      apiVersion: typeof API_VERSION;
      command: CliCommand | 'version' | null;
      ok: false;
      error: { code: ErrorCode; class: ErrorClass; message: string; issues: ErrorIssue[] };
    };
