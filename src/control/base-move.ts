import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ExecutionPolicy, ExecutionStore, ExecutionView } from '../contracts/index.ts';
import { git, hostGitArgs } from '../environment/process.ts';
import { checkoutPath, chooseCheckoutRoot } from '../environment/checkout-root.ts';
import { credentialPaths } from '../environment/isolation.ts';

/** Сдвиг ref: репозиторий, ref, новое и ожидаемое прежнее значение. */
export type RefMove = (
  repoPath: string,
  target: string,
  to: string,
  from: string,
) => void | Promise<void>;

/**
 * Сдвиг ref внутри транзакции проверки владения операцией: проверка и
 * `git update-ref` неразделимы — отмена или перехват операции либо видны
 * проверке, либо происходят уже после сдвига. Внутри транзакции не
 * исполняется чужой код: hook `reference-transaction`, ждущий ту же базу,
 * ждал бы её, а она — его; срок Git ограничен, зависший Git не держит базу.
 */
export function fencedRefMove(
  store: ExecutionStore,
  fence: (view: ExecutionView) => void,
  timeoutMs = fencedRefMove.timeoutMs,
): RefMove {
  return (repoPath, target, to, from) =>
    store.transact('base.moved', (tx) => {
      fence(tx);
      execFileSync('git', hostGitArgs(repoPath, ['update-ref', target, to, from]), {
        cwd: repoPath,
        timeout: timeoutMs,
        stdio: 'pipe',
      });
    });
}
/** Предел git update-ref внутри транзакции; конечный и короче lease. */
fencedRefMove.timeoutMs = 15000;

export interface BaseMoved {
  repositoryId: string;
  targetRef: string;
  from: string;
  to: string;
  commits: number;
  kind: 'fast-forward' | 'merge';
}

/**
 * Перенос базы: target ref каждого репозитория сводится с рабочей линией
 * (HEAD checkout или переданный точный SHA). Цель — предок рабочей линии:
 * fast-forward; обе линии несут работу — слияние без hooks в отдельном
 * worktree. Прежнее значение ref проверяется CAS. `only` — переносить только
 * эти репозитории и ровно на эти SHA: операция, проверившая одну редакцию,
 * не переносит ту, что появилась позже. Очередь при этом должна стоять —
 * это решает операция, а не перенос.
 */
export async function moveBase(input: {
  policy: ExecutionPolicy;
  baseDir: string;
  stateDir: string;
  /** Корень дерева слияния (`checkout-root.ts`); без него — выбор по каталогу состояния. */
  checkoutRoot?: string;
  only?: Record<string, string>;
  move?: RefMove;
}) {
  const move: RefMove =
    input.move ??
    ((repoPath, target, to, from) =>
      git(repoPath, 'update-ref', target, to, from).then(() => undefined));
  const path = (p: string) => (isAbsolute(p) ? p : resolve(input.baseDir, p));
  const updated: BaseMoved[] = [];
  const placement = chooseCheckoutRoot({
    stateDirs: [input.stateDir],
    repositories: input.policy.repositories.map((r) => path(r.path)),
    hidden: credentialPaths(),
    ...(input.checkoutRoot ? { configured: input.checkoutRoot } : {}),
  });
  for (const repo of input.policy.repositories.filter((r) => !input.only || r.id in input.only)) {
    const repoPath = path(repo.path);
    const head = input.only?.[repo.id] ?? (await git(repoPath, 'rev-parse', 'HEAD'));
    const tip = await git(repoPath, 'rev-parse', repo.targetRef);
    if (head === tip) continue;
    const behind = Number(await git(repoPath, 'rev-list', '--count', `${repo.targetRef}..${head}`));
    if (!behind) continue;
    const ahead = Number(await git(repoPath, 'rev-list', '--count', `${head}..${repo.targetRef}`));
    if (!ahead) {
      // Цель — предок рабочей линии: история не теряется и не переписывается.
      await move(repoPath, repo.targetRef, head, tip);
      updated.push({
        repositoryId: repo.id,
        targetRef: repo.targetRef,
        from: tip,
        to: head,
        commits: behind,
        kind: 'fast-forward',
      });
      continue;
    }
    // Обе линии несут работу: сводятся слиянием в отдельном worktree — target
    // ref checkout-веткой быть не может и продвигается только через CAS.
    const name = `base-${repo.id}-${Date.now()}`;
    const cwd = checkoutPath(
      placement,
      join(input.stateDir, 'worktrees', name),
      repo.id,
      'base',
      name,
    );
    await mkdir(dirname(cwd), { recursive: true });
    await git(repoPath, 'worktree', 'add', '--detach', cwd, tip);
    try {
      await git(
        cwd,
        '-c',
        'core.hooksPath=/dev/null',
        'merge',
        '--no-ff',
        '--no-edit',
        '--no-gpg-sign',
        head,
      );
      const merged = await git(cwd, 'rev-parse', 'HEAD');
      await move(repoPath, repo.targetRef, merged, tip);
      updated.push({
        repositoryId: repo.id,
        targetRef: repo.targetRef,
        from: tip,
        to: merged,
        commits: behind,
        kind: 'merge',
      });
    } finally {
      await git(repoPath, 'worktree', 'remove', '--force', cwd).catch(() => undefined);
    }
  }
  // Обратное направление: принятая работа, которой нет в рабочей линии.
  // Слияния не считаются: сам перенос оставляет коммит слияния без новой работы.
  const workingBehind: { repositoryId: string; commits: number }[] = [];
  for (const repo of input.policy.repositories) {
    const commits = Number(
      await git(path(repo.path), 'rev-list', '--no-merges', '--count', `HEAD..${repo.targetRef}`),
    );
    if (commits) workingBehind.push({ repositoryId: repo.id, commits });
  }
  return { updated, ...(workingBehind.length ? { workingBehind } : {}) };
}
