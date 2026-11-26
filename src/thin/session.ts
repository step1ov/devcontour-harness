// Сессия writer тонкого режима (alpha.73): одна на работу. Первая сдача —
// новая сессия в постоянном домашнем каталоге CLI работы; следующие —
// продолжение последней записанной сессии того же runtime. Переполнение
// контекста или потерянная сессия — один новый вызов в той же попытке со
// сводкой сдачи (`fallback`), не больше раза на попытку.

import { mkdir } from 'node:fs/promises';
import {
  TaskFailure,
  type AttemptState,
  type RuntimeName,
  type WorkState,
} from '../contracts/index.ts';
import type { ThinKit } from './kit.ts';

/** Продолжение сессии не началось: у CLI её нет (`diagnostics.sessionLost`). */
export class SessionLost extends TaskFailure {
  constructor(message: string) {
    super('unknown', message);
    this.name = 'SessionLost';
  }
}

type Repo = ThinKit['policy']['repositories'][number];

/** Постоянный домашний каталог CLI работы: `<checkoutRoot>/<repo>/sessions/<work>/<runtime>`, 0700. */
export async function sessionHome(kit: ThinKit, repo: Repo, work: WorkState, runtime: RuntimeName) {
  const dir = kit.checkout(repo.id, 'sessions', work.id, runtime);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Каталог сессий работы (убирается после приёмки). */
export const sessionsDir = (kit: ThinKit, repo: Repo, work: WorkState) =>
  kit.checkout(repo.id, 'sessions', work.id);

/** Как начать вызов writer этой сдачи. */
export type SessionPlan = { kind: 'resume'; id: string } | { kind: 'fresh'; reason?: string };

/** Последняя записанная сессия работы того же runtime и умеет ли CLI её продолжить. */
export async function planSession(kit: ThinKit, attempt: AttemptState): Promise<SessionPlan> {
  const previous = kit
    .history(attempt)
    .filter((a) => a.id !== attempt.id && a.writerSession)
    .at(-1)?.writerSession;
  if (!previous) return { kind: 'fresh' };
  if (previous.runtime !== attempt.runtime)
    return { kind: 'fresh', reason: `runtime сменился: ${previous.runtime} → ${attempt.runtime}` };
  const caps = await kit
    .adapter(attempt.runtime)
    .capabilities()
    .catch(() => undefined);
  if (!caps?.sessionContinue)
    return { kind: 'fresh', reason: `${attempt.runtime} не умеет продолжить сессию` };
  return { kind: 'resume', id: previous.id };
}

/** Отказ, после которого сдачу продолжает новая сессия: переполнение контекста или потерянная сессия. */
export const lostSession = (error: unknown) =>
  error instanceof SessionLost ||
  (error instanceof TaskFailure && error.kind === 'context-exhausted');
