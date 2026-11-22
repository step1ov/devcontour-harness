import { z } from 'zod';
import { gitShaSchema, idSchema, isoTimeSchema } from './primitives.ts';

/**
 * Превью результата (docs/previews.md): receipt запущенного превью и ответы
 * команд `harness preview-start`, `preview-stop`, `preview-list`.
 *
 * Receipt лежит в каталоге состояния (`<state>/previews/<репозиторий>/<превью>/receipt.json`),
 * его пишет надзирающий процесс превью (supervisor) и команды остановки и
 * сверки. Состояния: `starting` — сборка, службы, запуск и ожидание
 * готовности; `running` — адрес отвечает; `stopping` — идёт остановка;
 * `stopped` — остановлено штатно (оператор, срок, простой, замена);
 * `failed` — не поднялось или процесс превью пропал.
 */
export const previewStates = ['starting', 'running', 'stopping', 'stopped', 'failed'] as const;
export const previewStateSchema = z.enum(previewStates);
export type PreviewState = z.infer<typeof previewStateSchema>;

/**
 * Почему превью закончилось: `operator` — `preview-stop`; `ttl` — истёк срок;
 * `idle` — нет запросов дольше `idleMs`; `replaced` — тот же превью запущен
 * на другом коммите; `exited` — приложение завершилось само; `build`,
 * `services`, `start`, `health` — не поднялось на этом шаге;
 * `supervisor-gone` — надзирающий процесс пропал (сверка `preview-list`,
 * `preview-stop`).
 */
export const previewReasons = [
  'operator',
  'ttl',
  'idle',
  'replaced',
  'exited',
  'build',
  'services',
  'start',
  'health',
  'supervisor-gone',
] as const;
export const previewReasonSchema = z.enum(previewReasons);
export type PreviewReason = z.infer<typeof previewReasonSchema>;

const pidSchema = z.number().int().positive();

export const previewReceiptSchema = z.strictObject({
  version: z.literal(1),
  /** ID превью из `previews[]` репозитория. */
  id: idSchema,
  repositoryId: idSchema,
  title: z.string().min(1).max(80).optional(),
  /** Что просили: `accepted` или ref/SHA как назван. */
  ref: z.string().min(1).max(500),
  /** Поручение, чей принятый результат показан (`--ref accepted --work`). */
  workId: idSchema.optional(),
  sha: gitShaSchema,
  /** Рабочее дерево превью (detached на `sha`) в каталоге состояния. */
  worktree: z.string().min(1),
  /** Каталог превью: receipt, логи сборки, приложения и lifecycle. */
  dir: z.string().min(1),
  /** Лог приложения. */
  log: z.string().min(1),
  /** Lifecycle репозитория вокруг превью (`services: true`). */
  services: z.boolean(),
  /** Публичный порт (loopback-прокси) и адрес для человека; нет — ещё не назначен. */
  port: z.number().int().min(1).max(65535).optional(),
  url: z.string().min(1).max(200).optional(),
  /** Порт самого приложения (`PORT`), за прокси. */
  appPort: z.number().int().min(1).max(65535).optional(),
  pids: z.strictObject({ supervisor: pidSchema, app: pidSchema.optional() }),
  /** Время старта процессов по `ps` (`lstart`): PID, доставшийся другому процессу, не останавливается. */
  starts: z.strictObject({ supervisor: z.string().optional(), app: z.string().optional() }),
  startedAt: isoTimeSchema,
  expiresAt: isoTimeSchema,
  ttlMs: z.number().int().positive(),
  /** 0 — без остановки по простою. */
  idleMs: z.number().int().min(0),
  /** Последний запрос через прокси (или готовность, если запросов не было). */
  lastActivity: isoTimeSchema.optional(),
  state: previewStateSchema,
  reason: previewReasonSchema.optional(),
  message: z.string().max(2000).optional(),
  stoppedAt: isoTimeSchema.optional(),
});
export type PreviewReceipt = z.infer<typeof previewReceiptSchema>;

/** `preview-start`: запущенное (или уже идущее на том же коммите) превью. */
export const previewStartDataSchema = z.strictObject({
  preview: previewReceiptSchema,
  /** `false` — то же превью на том же коммите уже шло: возвращено оно. */
  changed: z.boolean(),
});
/** `preview-stop`: остановленные превью; `changed: false` — живых не было. */
export const previewStopDataSchema = z.strictObject({
  previews: z.array(previewReceiptSchema),
  changed: z.boolean(),
});
/** `preview-list`: receipt каждого превью после сверки с живыми процессами. */
export const previewListDataSchema = z.strictObject({
  previews: z.array(previewReceiptSchema),
});
