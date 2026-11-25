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
  INPUT_SOURCE_KIND,
  digestOf,
} from '../contracts/index.ts';
import { requestsOf } from '../engine/input-requests.ts';
import { checkGates, commitOf } from './gates-check.ts';
import { fullGatesProblem, recordGatesRun } from './release-gates.ts';
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
/** Пределы разделов договора (ревью A1 M2): постановки и документы-ответы. */
export const RELEASE_BRIEFS_LIMIT = 128 * 1024;
export const RELEASE_ANSWERS_LIMIT = 96 * 1024;

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

/** Путь закреплённого документа Relay по его ID (`documents/<id>.md`, как в снимке коннектора). */
const docPath = (id: string) => `documents/${id.replace(/[^A-Za-z0-9_-]/g, '_')}.md`;

/**
 * Документы-постановки источника Relay по его `references/provenance.json`:
 * обязательные документы задачи (требования) и документы, чьё имя называет
 * постановку, бриф или требования.
 */
function provenanceBriefs(source: {
  references: { path: string; content: { encoding: string; data: string } }[];
}): string[] {
  const ref = source.references.find((r) => r.path === 'references/provenance.json');
  if (!ref || ref.content.encoding !== 'utf8') return [];
  try {
    const value = JSON.parse(ref.content.data) as {
      documents?: { id?: unknown; name?: unknown; key?: unknown; required?: unknown }[];
    };
    return (value.documents ?? [])
      .filter(
        (d) =>
          typeof d.id === 'string' &&
          (d.required === true ||
            /бриф|brief|постановк|требован|requirement/i.test(
              `${String(d.name)} ${String(d.key)}`,
            )),
      )
      .map((d) => docPath(d.id as string));
  } catch {
    return [];
  }
}

/** Постановок выпуска нет (`BRIEF_MISSING`): ни `.brief.md`, ни документа-постановки в контексте. */
export const BRIEF_MISSING = 'BRIEF_MISSING';
export const briefMissingLine = (view: ExecutionView) =>
  releaseBriefsAndAnswers(view).briefs.length
    ? undefined
    : `${BRIEF_MISSING}: у выпуска нет постановки — ни .harness/work/<граф>.brief.md рядом с графом при run --graph, ни документа-постановки в закреплённом контексте; ревью выпуска сверяет только критерии работ. Закрепите бриф (документ Relay задачи или .brief.md) и повторите review-release`;

/** Раздел `## Ответ`/`## Answer` документа Relay с непустым текстом (вопрос владельцу с ответом). */
const answered = (text: string) => /^##\s+(?:ответ|answer)\s*#*\s*$\n+(?!\s*(?:##|$))/im.test(text);

/**
 * Постановки графов выпуска (`release-brief`, alpha.71 A1) и документы-ответы
 * владельца из закреплённых контекстов графов и попыток: источники
 * `input-answer` целиком и документы Relay с разделом «Ответ». Только записи
 * нынешнего выпуска — после итога прежнего (`release done`): постановки,
 * попытки и согласования графов. У документа — только последняя редакция
 * (по источнику и пути; у `input-answer` источник — запрос): решает время
 * снимка (начало попытки, согласование графа). С `repositoryId` — только
 * материалы этого репозитория (граф с его работами, попытка в нём); граф
 * без работ — общий. Порядок вывода — по источнику и пути.
 */
export function releaseBriefsAndAnswers(view: ExecutionView, repositoryId?: string) {
  const done = view.local('lead', WORKSPACE_OWNER, 'log')?.release?.doneAt;
  const current = (at: string) => !done || at > done;
  const graphRepos = (graphId: string) =>
    new Set(view.works(graphId).map((w) => w.order.repositoryId));
  const forRepo = (repos: Set<string>) => !repositoryId || !repos.size || repos.has(repositoryId);
  const briefs = (view.local('release-brief', WORKSPACE_OWNER, 'briefs')?.items ?? [])
    .filter((b) => (!done || b.at >= done) && forRepo(graphRepos(b.graphId)))
    .map((b) => ({ graph: b.graphId, digest: b.digest, text: b.text }));
  // Снимок → время, когда его закрепили впервые в этом выпуске: прежний
  // снимок, закреплённый позже ещё раз, новее новой редакции не становится.
  const snapshots = new Map<string, string>();
  const pinned = (digest: string, at: string) => {
    const prev = snapshots.get(digest);
    if (!prev || at < prev) snapshots.set(digest, at);
  };
  for (const g of view.graphs())
    if (g.approval?.context?.digest && current(g.approval.at) && forRepo(graphRepos(g.id)))
      pinned(g.approval.context.digest, g.approval.at);
  for (const a of view.attempts())
    if (a.contextSnapshot && current(a.startedAt) && forRepo(new Set([a.repositoryId])))
      pinned(a.contextSnapshot, a.startedAt);
  // Ссылки критериев на постановку (`criteriaSources` kind brief, alpha.70).
  const briefRefs = new Set(
    view
      .works()
      .flatMap((w) => w.order.criteriaSources ?? [])
      .filter((c) => c.kind === 'brief')
      .map((c) => docPath(c.ref)),
  );
  type Doc = { source: string; path: string; digest: string; text: string };
  // От раннего снимка к позднему: поздняя редакция документа (тот же
  // источник и путь) заменяет раннюю, даже если в ней ответа уже нет.
  const latest = new Map<string, Doc & { kind: 'answer' | 'brief' | 'other' }>();
  const ordered = [...snapshots].sort(
    (x, y) => x[1].localeCompare(y[1]) || x[0].localeCompare(y[0]),
  );
  for (const [digest] of ordered) {
    const snapshot = view.local('context-snapshots', WORKSPACE_OWNER, digest);
    for (const source of snapshot?.sources ?? []) {
      const briefPaths = new Set([...briefRefs, ...provenanceBriefs(source)]);
      for (const file of source.files) {
        if (file.content.encoding !== 'utf8') continue;
        const text = file.content.data;
        latest.set(`${source.id}\0${file.path}`, {
          source: source.id,
          path: file.path,
          digest: file.digest,
          text,
          kind:
            source.kind === INPUT_SOURCE_KIND || (/\.md$/i.test(file.path) && answered(text))
              ? 'answer'
              : // Постановка в документе Relay (alpha.71, A1): документ, на
                // который ссылаются критерии как на постановку, обязательный
                // документ задачи или документ с именем постановки/брифа.
                briefPaths.has(file.path)
                ? 'brief'
                : 'other',
        });
      }
    }
  }
  const answers = new Map<string, Doc>();
  const docs = new Map<string, Doc>();
  for (const [key, { kind, ...doc }] of latest)
    if (kind === 'answer') answers.set(key, doc);
    else if (kind === 'brief') docs.set(key, doc);
  const sorted = (m: Map<string, Doc>) =>
    [...m].sort(([a], [b]) => a.localeCompare(b)).map(([, d]) => d);
  return {
    briefs: [
      ...briefs,
      ...sorted(docs).map((d) => ({
        graph: `${d.source}/${d.path}`,
        digest: d.digest,
        text: d.text,
      })),
    ],
    answers: sorted(answers),
  };
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
  // Полный прогон gates на цели выпуска (alpha.71, ревью B): нет годного —
  // review-release исполняет его сам; не прошёл — отказ до ревью.
  const path = ctx.repoPath(repo.path);
  const sha = await commitOf(path, head, repo.id);
  const problem = () =>
    ctx.engine.read((v) =>
      fullGatesProblem(v, ctx.stateDir, ctx.policy, repo, sha, ctx.engine.version),
    );
  if (problem())
    recordGatesRun(
      ctx.engine,
      ctx.policy,
      await checkGates({
        policy: ctx.policy,
        baseDir: '',
        repoPath: (r) => ctx.repoPath(r.path),
        stateDir: ctx.stateDir,
        repositoryId: repo.id,
        rev: sha,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
  const gates = problem();
  if (gates)
    throw new HarnessError(
      'NOT_READY',
      `review-release: ${gates}. Приёмка выпуска опирается на полный прогон всех gates на цели (без неприменимости и переноса): исправьте провал обычной работой и повторите review-release`,
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
  const owner = ctx.engine.read((v) => releaseBriefsAndAnswers(v, repositoryId));
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
  // Постановки и ответы — в своих пределах (ревью A1 M2); заголовок каждой
  // постановки несёт digest её полного текста (L2): правка за обрезкой
  // меняет digest договора.
  const briefsText = owner.briefs
    .map((b) => `\n--- brief of graph ${b.graph} (sha256 ${b.digest})\n${b.text}`)
    .join('');
  const answersText = owner.answers
    .map((a) => `\n--- ${a.source}/${a.path} (sha256 ${a.digest})\n${a.text}`)
    .join('');
  const head = (limit: (text: string, max: number) => string) =>
    [
      'RELEASE CONTRACT.',
      '(a) Orders of all registered graphs (engine state): every acceptance criterion must hold in the accepted target as deployed, not only in tests. ' +
        JSON.stringify(state.orders),
      state.answers.length
        ? '(b) Owner answers to input requests: the release must follow them. ' +
          JSON.stringify(state.answers)
        : '(b) Owner answers: none recorded.',
      owner.briefs.length
        ? "(c) Briefs of the release (the user's own words; every scenario they describe must work in the accepted target, including its failure paths): " +
          limit(briefsText, RELEASE_BRIEFS_LIMIT)
        : `(c) Briefs: none recorded (${BRIEF_MISSING}: no .brief.md and no brief document in the pinned context). Review the release against the orders, and report every user scenario the orders imply but do not state as a note.`,
      owner.answers.length
        ? '(d) Owner answer documents from the pinned context (the release must follow them): ' +
          limit(answersText, RELEASE_ANSWERS_LIMIT)
        : '(d) Owner answer documents: none pinned.',
    ].join('\n\n');
  // Топология, её проверка и (f) не обрезаются никогда: предел договора
  // режет только начало (a)–(d).
  const tail = (list: string[]) =>
    [
      topology.length
        ? '(e) Deploy topology (policy release.topology, read from head):\n' + list.join('\n')
        : '(e) Deploy topology: the policy names no topology files (release.topology). Find the production gateway/proxy configs and production env files in the checkout yourself; their absence for a deployed app is a finding.',
      'Topology check: compare the production routing and env (gateway/proxy routes, production env files, public base URLs for media, uploads and API) with what the gates and tests exercised (often the API port directly). Every user-visible URL the works produce must be routed by the production gateway; report mismatches as blocking.',
      '(f) The diff base..head follows.',
    ].join('\n\n');
  const end = tail(files.map((f) => f.clipped));
  return {
    prompt:
      clip(head(clip), Math.max(4096, RELEASE_CONTRACT_LIMIT - end.length - 2)) + '\n\n' + end,
    digest: digestOf(head((t) => t) + '\n\n' + tail(files.map((f) => f.full))),
  };
}
