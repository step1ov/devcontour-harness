// Состояние ревью выпуска (0.1.0-alpha.69, P7-6): последнее ревью выпуска
// (`harness review-release`, запись `code-reviews` с `kind: release`) против
// текущей принятой цели каждого репозитория с принятыми работами. Чистая
// функция над видом состояния: её читают `release done` (отказ или
// предупреждение) и представление оператора.

import {
  WORKSPACE_OWNER,
  type CodeReviewRecord,
  type ExecutionPolicy,
  type ExecutionView,
} from '../contracts/index.ts';

/** `not-run` — ревью не было; `stale` — оно на прежней цели; `findings` — не одобрено. */
export type ReleaseReviewStatus = 'not-run' | 'stale' | 'findings' | 'approved';

export interface ReleaseReviewRepositoryState {
  repositoryId: string;
  status: ReleaseReviewStatus;
  /**
   * База выпуска (alpha.69): записанная при регистрации графа или `lead
   * outline` (`register`, `outline`), иначе база самой ранней попытки
   * (`attempt`, прежние состояния).
   */
  base?: string;
  baseSource?: 'register' | 'outline' | 'attempt';
  /**
   * Почему раунд не принимает выпуск (`stale`): цель сдвинулась, раунд на
   * другой базе, договор выпуска изменился, цель не определена (alpha.69).
   */
  staleReason?: 'target-moved' | 'base-mismatch' | 'contract-changed' | 'target-unresolved';
  /** Текущая принятая цель (SHA target ref), если известна. */
  target?: string;
  /** Head последнего раунда ревью выпуска. */
  head?: string;
  round?: number;
  /** Открытые находки последнего раунда: всего и блокирующих. */
  open?: number;
  blocking?: number;
  at?: string;
  /** Открытые неблокирующие находки одобренного раунда (не держат выпуск). */
  notes?: string[];
}

export interface ReleaseReviewState {
  /** Действующее требование: `release.review` или умолчание режима. */
  required: boolean;
  /** Худшее состояние по репозиториям (порядок: not-run, stale, findings, approved). */
  status: ReleaseReviewStatus;
  base?: string;
  baseSource?: 'register' | 'outline' | 'attempt';
  head?: string;
  target?: string;
  round?: number;
  open?: number;
  blocking?: number;
  at?: string;
  repositories: ReleaseReviewRepositoryState[];
}

/** Требование ревью выпуска: `release.review`, иначе `required` (в обоих режимах, alpha.69). */
export const releaseReviewRequired = (
  policy: Pick<ExecutionPolicy, 'release' | 'harnessMode'>,
): boolean =>
  // Обязательна в обоих режимах (решение владельца: P7-6 прошёл и в строгом);
  // совет — только явным `release.review: advisory`.
  (policy.release?.review ?? 'required') === 'required';

const rank: Record<ReleaseReviewStatus, number> = {
  'not-run': 0,
  stale: 1,
  findings: 2,
  approved: 3,
};

/**
 * Текущая принятая цель репозитория по состоянию: результат работы, чья
 * успешная попытка закончилась последней. Хост с доступом к git передаёт
 * SHA target ref сам (`heads`): коммиты в target ref вне harness видны только так.
 */
function acceptedHead(view: ExecutionView, repositoryId: string): string | undefined {
  const done = new Map(
    view
      .works()
      .filter((w) => w.status === 'done' && w.order.repositoryId === repositoryId && w.resultSha)
      .map((w) => [w.id, w.resultSha!]),
  );
  let best: { at: string; sha: string } | undefined;
  for (const a of view.attempts()) {
    const sha = done.get(a.workId);
    if (a.status !== 'succeeded' || !sha || !a.finishedAt) continue;
    if (!best || a.finishedAt > best.at) best = { at: a.finishedAt, sha };
  }
  return best?.sha ?? [...done.values()].at(-1);
}

/**
 * Состояние ревью выпуска для `release done` и представления: по каждому
 * репозиторию с принятыми работами — последний раунд ревью выпуска (по
 * времени) против текущей цели. `heads` — SHA target ref по ID репозитория;
 * нет записи — цель по состоянию (`acceptedHead`).
 */
export function releaseReviewState(
  view: ExecutionView,
  policy: Pick<ExecutionPolicy, 'release' | 'harnessMode'>,
  heads: Readonly<Record<string, string | undefined>> = {},
  /**
   * Сверка для `release done` (alpha.69, ревью): `strict` — цель только из
   * `heads` (не определена — раунд не принимает выпуск), `contracts` —
   * digest нынешнего договора выпуска по репозиторию: раунд по прежнему
   * договору выпуск не принимает.
   */
  check: { strict?: boolean; contracts?: Readonly<Record<string, string | undefined>> } = {},
): ReleaseReviewState {
  const repositories = [
    ...new Set(
      view
        .works()
        .filter((w) => w.status === 'done')
        .map((w) => w.order.repositoryId),
    ),
  ].sort();
  const reviews = view
    .locals('code-reviews', WORKSPACE_OWNER)
    .map((r) => r.value)
    .filter((r) => r.kind === 'release');
  const states = repositories.map((repositoryId): ReleaseReviewRepositoryState => {
    const target = check.strict
      ? heads[repositoryId]
      : (heads[repositoryId] ?? acceptedHead(view, repositoryId));
    const done = view.local('lead', WORKSPACE_OWNER, 'log')?.release?.doneAt;
    const record = view.local('release-base', WORKSPACE_OWNER, repositoryId);
    const recorded = record && !(done && record.at < done) ? record : undefined;
    const early = recorded
      ? undefined
      : view
          .attempts()
          .filter(
            (a) => a.repositoryId === repositoryId && a.baseSha && (!done || a.startedAt > done),
          )
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))[0]
          ?.baseSha;
    const baseOf = recorded
      ? { base: recorded.sha, baseSource: recorded.source }
      : early
        ? { base: early, baseSource: 'attempt' as const }
        : {};
    const last = reviews
      .filter((r) => r.repositoryId === repositoryId)
      .reduce<CodeReviewRecord | undefined>(
        (best, r) =>
          !best || r.at > best.at || (r.at === best.at && r.round > best.round) ? r : best,
        undefined,
      );
    if (!last) return { repositoryId, status: 'not-run', ...baseOf, ...(target ? { target } : {}) };
    const open = last.findings.filter((f) => f.status === 'open');
    const blocking = open.filter((f) => f.severity === 'blocking').length;
    const contract = check.contracts?.[repositoryId];
    const staleReason: ReleaseReviewRepositoryState['staleReason'] = !target
      ? 'target-unresolved'
      : last.head !== target
        ? 'target-moved'
        : baseOf.base && last.base !== baseOf.base
          ? 'base-mismatch'
          : check.contracts && last.contextDigest !== contract
            ? 'contract-changed'
            : undefined;
    const status: ReleaseReviewStatus = staleReason
      ? 'stale'
      : last.approved && !blocking
        ? 'approved'
        : 'findings';
    const notes = open.filter((f) => f.severity !== 'blocking').map((f) => f.message.slice(0, 300));
    return {
      repositoryId,
      status,
      ...(staleReason ? { staleReason } : {}),
      ...baseOf,
      ...(target ? { target } : {}),
      head: last.head,
      round: last.round,
      open: open.length,
      blocking,
      at: last.at,
      ...(status === 'approved' && notes.length ? { notes: notes.slice(0, 20) } : {}),
    };
  });
  const worst = states.reduce<ReleaseReviewRepositoryState | undefined>(
    (w, s) => (!w || rank[s.status] < rank[w.status] ? s : w),
    undefined,
  );
  const top: Omit<ReleaseReviewState, 'required' | 'repositories'> = worst
    ? {
        status: worst.status,
        ...(worst.base ? { base: worst.base, baseSource: worst.baseSource! } : {}),
        ...(worst.head ? { head: worst.head } : {}),
        ...(worst.target ? { target: worst.target } : {}),
        ...(worst.round !== undefined ? { round: worst.round } : {}),
        ...(worst.open !== undefined ? { open: worst.open } : {}),
        ...(worst.blocking !== undefined ? { blocking: worst.blocking } : {}),
        ...(worst.at ? { at: worst.at } : {}),
      }
    : { status: 'not-run' };
  return { required: releaseReviewRequired(policy), ...top, repositories: states };
}

const short = (sha: string | undefined) => (sha ? sha.slice(0, 12) : 'неизвестна');

/** Почему ревью выпуска не годится (по-русски); одобрено — `undefined`. */
export function releaseReviewProblem(state: ReleaseReviewState): string | undefined {
  const bad = state.repositories.filter((r) => r.status !== 'approved');
  if (!state.repositories.length) return 'ревью выпуска не проводилось';
  if (!bad.length) return undefined;
  const many = state.repositories.length > 1;
  return bad
    .map((r) => {
      const where = many ? `${r.repositoryId}: ` : '';
      if (r.status === 'not-run') return where + 'ревью выпуска не проводилось';
      if (r.status === 'stale')
        return r.staleReason === 'base-mismatch'
          ? `${where}ревью выпуска (раунд ${r.round}) сделано не от базы выпуска ${short(r.base)}: повторите harness review-release без --base`
          : r.staleReason === 'contract-changed'
            ? `${where}договор выпуска изменился после ревью (раунд ${r.round}): постановки, ответы владельца или топология — повторите harness review-release`
            : r.staleReason === 'target-unresolved'
              ? `${where}принятая цель не определена (target ref не читается): выпуск не закрывается`
              : `${where}ревью выпуска (раунд ${r.round}) на ${short(r.head)}, а принятая цель — ${short(r.target)}`;
      return `${where}ревью выпуска (раунд ${r.round}) не одобрено: открытых находок ${r.open ?? 0}, блокирующих ${r.blocking ?? 0}`;
    })
    .join('; ');
}
