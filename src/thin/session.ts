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

/**
 * Вмешательство ведущего после последней сессии: разбор, сброс попыток или
 * новая постановка. После него — новая сессия (со сводкой и заметками
 * разбора); сброс (`reset`) — ещё и работа заново от цели.
 */
export function intervention(
  kit: ThinKit,
  attempt: AttemptState,
  work: WorkState,
): { reason: string; reset: boolean } | undefined {
  const earlier = kit.history(attempt).filter((a) => a.id !== attempt.id);
  const last = earlier.filter((a) => a.writerSession).at(-1);
  if (!last) return undefined;
  const since = last.startedAt;
  const lead = work.leadRecovery;
  // `retry --start-over` — один раз: сдача, начатая после него, его уже
  // исполнила (даже если умерла до записи сессии).
  const latest = earlier.at(-1)?.startedAt ?? since;
  if (lead?.resets.some((r) => r.startOver && r.at > latest))
    return { reason: 'работа заново от цели (retry --start-over)', reset: true };
  // Обычный сброс сохраняет дерево и ветку: новая сессия со сводкой.
  if (lead?.resets.some((r) => r.at > since))
    return { reason: 'сброс попыток: новая сессия над деревом работы', reset: false };
  if (lead?.diagnoses.some((d) => d.at > since || d.addenda?.some((x) => x.at > since)))
    return { reason: 'разбор ведущего после прошлой сдачи', reset: false };
  if (last.writerSession?.spec && last.writerSession.spec !== work.approvedDigest)
    return { reason: 'постановка работы изменилась', reset: false };
  return undefined;
}

/** Последняя записанная сессия работы того же runtime и умеет ли CLI её продолжить. */
export async function planSession(
  kit: ThinKit,
  attempt: AttemptState,
  work: WorkState,
): Promise<SessionPlan> {
  const previous = kit
    .history(attempt)
    .filter((a) => a.id !== attempt.id && a.writerSession)
    .at(-1)?.writerSession;
  if (!previous) return { kind: 'fresh' };
  const lead = intervention(kit, attempt, work);
  if (lead) return { kind: 'fresh', reason: lead.reason };
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
