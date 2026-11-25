// Ревью выпуска (0.1.0-alpha.69, P7-6): перед `release done` независимый
// reviewer проверяет принятую цель против договора выпуска — постановки и
// критериев приёмки всех работ зарегистрированных графов, ответов владельца и
// топологии развёртывания (`release.topology`: конфигурации шлюза/прокси и
// файлы окружения production). Ход обзора — общий с `review-code`
// (`reviewBranch`): reviewer по правилу ревью кода роли, diff base..head,
// раунды предмета с переходами прежних находок; запись — `code-reviews` с
// `kind: release`. Приёмки и поручений нет: находки исправляют обычные работы.

import { releaseDocsLine, releaseDocsOpen, releaseDocsState } from './release-docs.ts';
import {
  HarnessError,
  type CodeReviewRecord,
  type ExecutionView,
  type GraphState,
  type WorkState,
  WORKSPACE_OWNER,
  digestOf,
} from '../contracts/index.ts';
import { requestsOf } from '../engine/input-requests.ts';
import {
  rawGit,
  reviewBranch,
  reviewRepository,
  type CodeReviewContext,
  type CodeReviewInput,
} from './review-code.ts';

export interface ReleaseReviewInput {
  /** Репозиторий политики; нет — единственный. */
  repositoryId?: string;
  /** Роль, правило ревью кода которой выбирает reviewer; нет — единственная роль. */
  role?: string;
  author?: CodeReviewInput['author'];
  /** База выпуска; нет — база первой попытки репозитория в состоянии. */
  base?: string;
  /** Принятая цель; нет — target ref репозитория. */
  head?: string;
  signal?: AbortSignal;
}

/** Предел одного файла топологии в запросе. */
export const RELEASE_TOPOLOGY_FILE_LIMIT = 64 * 1024;
/** Предел договора выпуска в запросе: больший обрезается с пометкой. */
export const RELEASE_CONTRACT_LIMIT = 512 * 1024;

const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max) + `\n[обрезано: ${text.length - max} символов]` : text;

/**
 * База выпуска по состоянию: база самой ранней попытки репозитория — target
 * ref до первой работы выпуска. Нет попыток — `undefined` (нужен `--base`).
 */
export function releaseBaseOf(view: ExecutionView, repositoryId: string): string | undefined {
  // Записанная база выпуска (alpha.69); база ранней попытки — для прежних состояний.
  const recorded = view.local('release-base', WORKSPACE_OWNER, repositoryId);
  const done = view.local('lead', WORKSPACE_OWNER, 'log')?.release?.doneAt;
  if (recorded && !(done && recorded.at < done)) return recorded.sha;
  // Без записи (выпуск, начатый до alpha.69): база самой ранней попытки
  // после итога прежнего выпуска, а не нынешняя цель.
  return view
    .attempts()
    .filter((a) => a.repositoryId === repositoryId && a.baseSha && (!done || a.startedAt > done))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))[0]?.baseSha;
}

/** Постановки и ответы владельца — разделы договора выпуска из состояния. */
function contractFromState(view: ExecutionView, repositoryId: string) {
  const graphs: GraphState[] = view.graphs();
  const orders = graphs.map((g) => ({
    graph: g.id,
    works: view
      .works(g.id)
      .filter((w: WorkState) => w.status !== 'cancelled')
      .map((w) => ({
        id: w.id,
        repository: w.order.repositoryId,
        status: w.status,
        title: w.order.title,
        goal: w.order.goal,
        acceptance: w.order.acceptance,
      })),
  }));
  const answers = requestsOf(view)
    .filter((r) => r.answers.length > 0)
    .map((r) => ({
      request: r.id,
      work: r.workId,
      question: r.question.question,
      options: r.question.options.map((o) => ({ id: o.id, label: o.label })),
      answers: r.answers.map((a) => ({
        text: a.text,
        option: a.optionId,
        kind: a.kind,
        actor: a.actor,
      })),
    }));
  return { orders, answers, repositoryId };
}

/**
 * `harness review-release`: ревью принятой цели против договора выпуска.
 * Отказы — как у `review-code`; нет базы и попыток в состоянии — `INVALID_INPUT`.
 */
export async function reviewRelease(
  ctx: CodeReviewContext,
  input: ReleaseReviewInput,
): Promise<CodeReviewRecord> {
  const repo = reviewRepository(ctx.policy, input.repositoryId);
  const base = input.base ?? ctx.engine.read((v) => releaseBaseOf(v, repo.id));
  if (!base)
    throw new HarnessError(
      'INVALID_INPUT',
      `review-release: в состоянии нет попыток ${repo.id}, базу выпуска не вывести: назовите --base`,
      [{ path: ['--base'], message: 'required' }],
    );
  const head = input.head ?? repo.targetRef;
  // Шаг документации (alpha.70): до приёмки выпуска принята работа docs
  // после корневых работ; `required` — отказ без неё.
  const docs = ctx.engine.read((v) => releaseDocsState(v, ctx.policy));
  const docsLine = releaseDocsLine(docs);
  if (docs.mode === 'required' && releaseDocsOpen(docs) && docsLine)
    throw new HarnessError(
      'NOT_READY',
      `review-release: ${docsLine}; release.docs: required — сначала примите работу документации (метка docs, зависит от корневых работ)`,
    );
  return reviewBranch(
    ctx,
    {
      base,
      head,
      ...(input.role ? { role: input.role } : {}),
      ...(input.author ? { author: input.author } : {}),
      repositoryId: repo.id,
      ...(input.signal ? { signal: input.signal } : {}),
    },
    {
      contract: async ({ path, head: sha }) => {
        const c = await releaseContract(ctx, repo.id, path, sha);
        return { prompt: c.prompt, digest: c.digest };
      },
    },
  );
}

/**
 * Договор выпуска для репозитория на `head`: постановки и критерии, ответы
 * владельца, файлы топологии на head. `digest` — по ПОЛНОМУ тексту (без
 * обрезки): основание раунда ревью выпуска, его же пересчитывает
 * `release done` — правка за пределом обрезки запроса тоже делает раунд
 * устаревшим. `prompt` — тот же текст в пределах запроса reviewer.
 */
export async function releaseContract(
  ctx: Pick<CodeReviewContext, 'engine' | 'policy'>,
  repositoryId: string,
  path: string,
  sha: string,
): Promise<{ prompt: string; digest: string }> {
  const state = ctx.engine.read((v) => contractFromState(v, repositoryId));
  const topology = ctx.policy.release?.topology ?? [];
  const files: { full: string; clipped: string }[] = [];
  for (const file of topology) {
    let text: string;
    try {
      text = (await rawGit(path, ['show', `${sha}:${file}`])).toString('utf8');
    } catch {
      const missing = `--- ${file}: MISSING at head (the file does not exist in the accepted target)`;
      files.push({ full: missing, clipped: missing });
      continue;
    }
    files.push({
      full: `--- ${file}\n${text}`,
      clipped: `--- ${file}\n${clip(text, RELEASE_TOPOLOGY_FILE_LIMIT)}`,
    });
  }
  const compose = (list: string[]) =>
    [
      'RELEASE CONTRACT.',
      '(a) Orders of all registered graphs (engine state): every acceptance criterion must hold in the accepted target as deployed, not only in tests. ' +
        JSON.stringify(state.orders),
      state.answers.length
        ? '(b) Owner answers to input requests: the release must follow them. ' +
          JSON.stringify(state.answers)
        : '(b) Owner answers: none recorded.',
      topology.length
        ? '(c) Deploy topology (policy release.topology, read from head):\n' + list.join('\n')
        : '(c) Deploy topology: the policy names no topology files (release.topology). Find the production gateway/proxy configs and production env files in the checkout yourself; their absence for a deployed app is a finding.',
      'Topology check: compare the production routing and env (gateway/proxy routes, production env files, public base URLs for media, uploads and API) with what the gates and tests exercised (often the API port directly). Every user-visible URL the works produce must be routed by the production gateway; report mismatches as blocking.',
      '(d) The diff base..head follows.',
    ].join('\n\n');
  return {
    prompt: clip(compose(files.map((f) => f.clipped)), RELEASE_CONTRACT_LIMIT),
    digest: digestOf(compose(files.map((f) => f.full))),
  };
}
