import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AcceptedTarget, ExecutionPolicy } from '../contracts/index.ts';
import { RU, ruCount } from '../contracts/plural.ts';
import { hostGitArgs } from '../environment/process.ts';

/** Принятая работа: репозиторий и принятый SHA (`work.resultSha`, `result.shas.result`). */
export interface AcceptedWork {
  id: string;
  repositoryId: string;
  acceptedSha: string;
}

/** Предел одного вызова git сверки и всей сверки одного ответа. */
const TARGET_GIT_TIMEOUT_MS = 10_000;
const TARGET_TOTAL_MS = 30_000;
/** Предел строк `line` / `lineEn` (`acceptedTargetSchema`). */
const LINE_LIMIT = 500;
const clip = (text: string) =>
  text.length > LINE_LIMIT ? text.slice(0, LINE_LIMIT - 1) + '…' : text;

const en = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Строки «принято на X; после приёмки …» (RU и EN) по вычисленным полям. */
export function targetLines(
  t: Omit<AcceptedTarget, 'line' | 'lineEn'>,
): Pick<AcceptedTarget, 'line' | 'lineEn'> {
  const lines = rawLines(t);
  return { line: clip(lines.line), lineEn: clip(lines.lineEn) };
}

function rawLines(t: Omit<AcceptedTarget, 'line' | 'lineEn'>) {
  const sha = t.acceptedSha.slice(0, 12);
  if (t.unavailable !== undefined)
    return {
      line: `принято на ${sha}; состояние ${t.ref} не определено (${t.unavailable}) — после приёмки не проверено`,
      lineEn: `accepted at ${sha}; ${t.ref} could not be read (${t.unavailable}): not verified since acceptance`,
    };
  if (t.diverged)
    return {
      line: `принято на ${sha}; ${t.ref} переписан: принятый коммит не в его истории, текущее состояние (${t.head!.slice(0, 12)}) не проверено`,
      lineEn: `accepted at ${sha}; ${t.ref} was rewritten: the accepted commit is not in its history, the current state (${t.head!.slice(0, 12)}) is not verified`,
    };
  const n = t.commitsSinceAccepted ?? 0;
  const f = t.filesSinceAccepted ?? 0;
  if (!n)
    return {
      line: `принято на ${sha}; после приёмки коммитов нет`,
      lineEn: `accepted at ${sha}; no commits since acceptance`,
    };
  return {
    line: `принято на ${sha}; после приёмки ${ruCount(n, RU.commit)} (${ruCount(f, RU.file)}) — не проверены`,
    lineEn: `accepted at ${sha}; ${en(n, 'commit')} (${en(f, 'file')}) since acceptance are not verified`,
  };
}

type Remote = NonNullable<AcceptedTarget['remote']>;
/** Удалённая ветка репозитория: её имя, вершина и последнее обновление на этой машине. */
interface RemoteBranch {
  full?: string;
  short?: string;
  sha?: string;
  checkedAt?: string;
  reason?: { ru: string; en: string };
}

const NO_REMOTE = { ru: 'нет удалённой ветки', en: 'no remote branch' };
const NOT_FETCHED = {
  ru: 'удалённая ветка ещё не получена на этой машине',
  en: 'the remote branch is not fetched on this machine',
};
const REMOTE_UNREADABLE = {
  ru: 'удалённая ветка не прочитана',
  en: 'the remote branch could not be read',
};

/** Состояние удалённой ветки простыми словами (RU и EN). */
export function remoteOf(
  state: Remote['state'],
  branch: Pick<RemoteBranch, 'short' | 'checkedAt' | 'reason'>,
): Remote {
  const name = branch.short ?? '';
  const base = {
    state,
    ...(branch.short ? { trackingRef: branch.short } : {}),
    ...(branch.checkedAt ? { checkedAt: branch.checkedAt } : {}),
  };
  if (state === 'pushed')
    return {
      ...base,
      line: clip(`уже в удалённой ветке ${name}`),
      lineEn: clip(`already on the remote branch ${name}`),
    };
  if (state === 'not-pushed')
    return {
      ...base,
      line: clip(`принято локально; в удалённой ветке ${name} ещё нет`),
      lineEn: clip(`accepted locally; not yet on the remote branch ${name}`),
    };
  const reason = branch.reason ?? NO_REMOTE;
  return {
    ...base,
    reason: reason.ru,
    reasonEn: reason.en,
    line: clip(`неизвестно (${reason.ru})`),
    lineEn: clip(`unknown (${reason.en})`),
  };
}

const reasonEnOf: Record<string, string> = {
  'репозиторий не объявлен в политике': 'the repository is not declared in the policy',
  'checkout репозитория не найден': 'the repository checkout is not found',
  'checkout репозитория не доверен': 'the repository checkout is not trusted',
  'git не ответил вовремя': 'git did not answer in time',
  'git не найден': 'git is not found',
};

/**
 * Принятые версии против текущих target ref (`status`, `result`, `report`):
 * один `rev-parse` на репозиторий и по три вызова git на различный принятый
 * SHA. Только чтение Git; ошибка git — `unavailable`, а не отказ команды.
 */
export function acceptedTargets(
  policy: Pick<ExecutionPolicy, 'repositories'>,
  repoPath: (path: string) => string,
  works: readonly AcceptedWork[],
): Map<string, AcceptedTarget> {
  const out = new Map<string, AcceptedTarget>();
  const heads = new Map<string, { head?: string; error?: string }>();
  const branches = new Map<string, RemoteBranch>();
  const cache = new Map<string, Omit<AcceptedTarget, 'line' | 'lineEn'>>();
  const deadline = Date.now() + TARGET_TOTAL_MS;
  // Каждый вызов — не дольше остатка общей сверки; исчерпанный остаток —
  // без вызова. `raw` — вывод без обрезки (имена `-z`).
  const run = (cwd: string, args: string[], raw = false) => {
    const left = deadline - Date.now();
    if (left <= 0) throw Object.assign(new Error('deadline'), { code: 'DEADLINE' });
    const out = execFileSync('git', hostGitArgs(cwd, args), {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: Math.min(TARGET_GIT_TIMEOUT_MS, left),
    });
    return raw ? out : out.trim();
  };
  // Причина — класс, а не сырой stderr: текст git несёт пути машины, а сверка
  // попадает в отчёт.
  const reason = (error: unknown, what: string) => {
    const e = error as { code?: string; signal?: string; stderr?: string; message?: string };
    if (e.code === 'DEADLINE') return `сверка прервана: предел ${TARGET_TOTAL_MS / 1000} с`;
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') return 'git не ответил вовремя';
    if (e.code === 'ENOENT') return 'git не найден';
    if (
      /trusted|доверен|safe\.directory|symlink|ссылк/i.test(`${e.message ?? ''} ${e.stderr ?? ''}`)
    )
      return 'checkout репозитория не доверен';
    return what;
  };
  const asReason = (ru: string) => ({
    ru,
    en:
      reasonEnOf[ru] ??
      ru.replace(/^сверка прервана: предел (\d+) с$/, 'the check was cut off: the $1 s limit'),
  });
  // Удалённая ветка — только локальные ref и config: upstream ветки, иначе
  // `origin/<имя>`. Ни fetch, ни обращения к сети.
  const branchOf = (path: string, ref: string): RemoteBranch => {
    let full = '';
    try {
      full = run(path, ['for-each-ref', '--format=%(upstream)', '--end-of-options', ref]);
    } catch (error) {
      return { reason: asReason(reason(error, REMOTE_UNREADABLE.ru)) };
    }
    if (!full) {
      const origin = 'refs/remotes/origin/' + ref.replace(/^refs\/heads\//, '');
      try {
        run(path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${origin}^{commit}`]);
        full = origin;
      } catch (error) {
        const e = error as { status?: number; code?: string };
        return e.status === 1
          ? { reason: NO_REMOTE }
          : { reason: asReason(reason(error, REMOTE_UNREADABLE.ru)) };
      }
    }
    if (!full.startsWith('refs/remotes/')) return { reason: NO_REMOTE };
    const short = full.slice('refs/remotes/'.length);
    let sha: string;
    try {
      sha = run(path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${full}^{commit}`]);
    } catch (error) {
      const e = error as { status?: number };
      return {
        full,
        short,
        reason: e.status === 1 ? NOT_FETCHED : asReason(reason(error, REMOTE_UNREADABLE.ru)),
      };
    }
    let checkedAt: string | undefined;
    try {
      const gd = run(path, [
        'reflog',
        'show',
        '-n',
        '1',
        '--date=iso-strict',
        '--format=%gd',
        '--end-of-options',
        full,
      ]);
      const m = /@\{([^}]+)\}$/.exec(gd);
      const t = m ? Date.parse(m[1]!) : NaN;
      if (Number.isFinite(t)) checkedAt = new Date(t).toISOString();
    } catch {
      // Нет reflog — время обновления неизвестно, состояние читается.
    }
    return { full, short, sha, ...(checkedAt ? { checkedAt } : {}) };
  };
  const remoteFor = (
    work: AcceptedWork,
    path: string | undefined,
    ref: string,
    unreachable?: string,
  ): Remote => {
    if (path === undefined)
      return remoteOf('unknown', { reason: asReason(unreachable ?? REMOTE_UNREADABLE.ru) });
    const repoKey = work.repositoryId;
    let branch = branches.get(repoKey);
    if (!branch) {
      try {
        branch = branchOf(path, ref);
      } catch (error) {
        branch = { reason: asReason(reason(error, REMOTE_UNREADABLE.ru)) };
      }
      branches.set(repoKey, branch);
    }
    if (!branch.sha) return remoteOf('unknown', branch);
    if (branch.sha === work.acceptedSha) return remoteOf('pushed', branch);
    try {
      run(path, ['merge-base', '--is-ancestor', work.acceptedSha, branch.sha]);
      return remoteOf('pushed', branch);
    } catch (error) {
      if ((error as { status?: number }).status === 1) return remoteOf('not-pushed', branch);
      return remoteOf('unknown', {
        ...branch,
        reason: asReason(reason(error, REMOTE_UNREADABLE.ru)),
      });
    }
  };
  for (const work of works) {
    const repo = policy.repositories.find((r) => r.id === work.repositoryId);
    const ref = repo?.targetRef ?? '(нет репозитория)';
    const key = `${work.repositoryId}\0${work.acceptedSha}`;
    let base = cache.get(key);
    if (!base) {
      const common = { repositoryId: work.repositoryId, ref, acceptedSha: work.acceptedSha };
      if (!repo) base = { ...common, unavailable: 'репозиторий не объявлен в политике' };
      else {
        const path = repoPath(repo.path);
        let head = heads.get(repo.id);
        if (!head && !existsSync(path)) head = { error: 'checkout репозитория не найден' };
        if (!head) {
          try {
            head = {
              head: run(path, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]),
            };
          } catch (error) {
            head = { error: reason(error, 'ref не прочитан') };
          }
          heads.set(repo.id, head);
        }
        if (!head.head) base = { ...common, unavailable: head.error ?? 'ref не прочитан' };
        else if (Date.now() > deadline)
          base = {
            ...common,
            head: head.head,
            unavailable: `сверка прервана: предел ${TARGET_TOTAL_MS / 1000} с`,
          };
        else if (head.head === work.acceptedSha)
          base = { ...common, head: head.head, commitsSinceAccepted: 0, filesSinceAccepted: 0 };
        else
          try {
            let ancestor = true;
            try {
              run(path, ['merge-base', '--is-ancestor', work.acceptedSha, head.head]);
            } catch (error) {
              // Код 1 — не предок; иное (нет коммита) — ошибка чтения.
              if ((error as { status?: number }).status !== 1) throw error;
              ancestor = false;
            }
            const commits = Number(
              run(path, ['rev-list', '--count', `${work.acceptedSha}..${head.head}`]),
            );
            const files = run(
              path,
              ['diff', '--name-only', '-z', '--no-renames', work.acceptedSha, head.head],
              true,
            )
              .split('\0')
              .filter((n) => n.length > 0).length;
            base = {
              ...common,
              head: head.head,
              commitsSinceAccepted: commits,
              filesSinceAccepted: files,
              ...(ancestor ? {} : { diverged: true as const }),
            };
          } catch (error) {
            base = {
              ...common,
              head: head.head,
              unavailable: reason(error, 'принятый коммит не прочитан'),
            };
          }
      }
      const path = repo ? repoPath(repo.path) : undefined;
      base = {
        ...base,
        remote: remoteFor(
          work,
          path !== undefined && existsSync(path) ? path : undefined,
          ref,
          repo ? 'checkout репозитория не найден' : 'репозиторий не объявлен в политике',
        ),
      };
      cache.set(key, base);
    }
    out.set(work.id, { ...base, ...targetLines(base) });
  }
  return out;
}

/** Предел строк сверки в отчёте (как строк поручений). */
const REPORT_TARGET_ROWS = 50;

/**
 * Раздел отчёта «после приёмки»: принятые поручения, у которых target ref
 * ушёл вперёд, переписан или не прочитан. Совпавшие с ref только считаются.
 */
export function reportTargets(
  policy: Pick<ExecutionPolicy, 'repositories'>,
  repoPath: (path: string) => string,
  works: readonly {
    id: string;
    status: string;
    resultSha?: string | undefined;
    order: { repositoryId: string };
  }[],
) {
  const accepted = works
    .filter((w) => w.status === 'done' && w.resultSha)
    .map((w) => ({ id: w.id, repositoryId: w.order.repositoryId, acceptedSha: w.resultSha! }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const targets = acceptedTargets(policy, repoPath, accepted);
  const drifted = accepted
    .map((w) => ({ workId: w.id, ...targets.get(w.id)! }))
    .filter((t) => t.unavailable !== undefined || t.diverged || (t.commitsSinceAccepted ?? 0) > 0);
  return {
    checked: accepted.length,
    rows: drifted.slice(0, REPORT_TARGET_ROWS),
    total: drifted.length,
    truncated: drifted.length > REPORT_TARGET_ROWS,
  };
}
