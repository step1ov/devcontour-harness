// Шаг документации выпуска (0.1.0-alpha.70). После корневых работ выпуска —
// работа документации (метка `docs`), до приёмки выпуска. Чистая функция над
// видом состояния: её читают `review-release`, `status` и представление.

import {
  HarnessError,
  WORKSPACE_OWNER,
  type ExecutionPolicy,
  type ExecutionView,
  type WorkState,
} from '../contracts/index.ts';

export const DOCS_LABEL = 'docs';

/**
 * Предупреждение источника задач без метки docs при `release.docs: required`
 * (alpha.72, P9-6): `source-check` и `doctor`.
 */
export const RELEASE_DOCS_UNMARKED =
  'RELEASE_DOCS_UNMARKED: release.docs: required, а ни одна задача источника не помечена docs — выпуск остановится на шаге документации: добавьте labels: ["docs"] сопоставлению задачи документации в конфигурации коннектора (tasks[].labels) или назовите её при review-release и release done явно: --docs-work <id>';

export type ReleaseDocsStatus =
  'off' | 'no-works' | 'missing' | 'not-after-roots' | 'pending' | 'done';

export interface ReleaseDocsState {
  mode: 'required' | 'advisory' | 'off';
  status: ReleaseDocsStatus;
  /** Корневые работы выпуска: продуктовые работы без зависящих от них. */
  roots: string[];
  /** Работы документации выпуска. */
  works: string[];
  /** Корневые работы, от которых работа документации не зависит. */
  missingRoots?: string[];
  /**
   * Работы, которые ведущий назвал документацией явно (`--docs-work`,
   * alpha.72, P9-6): источник задач не умеет нести метку `docs`.
   */
  declared?: string[];
}

/** Параметры шага: явные работы документации (`--docs-work`). */
export interface ReleaseDocsOptions {
  docsWorks?: readonly string[];
}

export const releaseDocsMode = (policy: Pick<ExecutionPolicy, 'release'>) =>
  policy.release?.docs ?? 'advisory';

const labelled = (w: WorkState) => w.order.labels?.includes(DOCS_LABEL) === true;

/**
 * Состояние шага: работы выпуска — неотменённые работы всех графов; корни —
 * работы не документации, от которых не зависит ни одна другая работа не
 * документации. Работа документации стоит «после корней», когда она
 * (транзитивно) зависит от каждого корня; `done` — такая работа принята.
 */
export function releaseDocsState(
  view: Pick<ExecutionView, 'works'> & Partial<Pick<ExecutionView, 'attempts' | 'local'>>,
  policy: Pick<ExecutionPolicy, 'release'>,
  options: ReleaseDocsOptions = {},
): ReleaseDocsState {
  const mode = releaseDocsMode(policy);
  const named = new Set(options.docsWorks ?? []);
  const isDocs = (w: WorkState) => labelled(w) || named.has(w.id);
  // Текущий выпуск (ревью 1): после последнего `release done` — без работ,
  // принятых до него; их связи корнями нового выпуска не считаются.
  const doneAt = view.local?.('lead', WORKSPACE_OWNER, 'log')?.release?.doneAt;
  const acceptedAt = new Map<string, string>();
  if (doneAt && view.attempts)
    for (const a of view.attempts())
      if (a.status === 'succeeded' && a.finishedAt) {
        const prev = acceptedAt.get(a.workId);
        if (!prev || a.finishedAt > prev) acceptedAt.set(a.workId, a.finishedAt);
      }
  const earlier = (w: WorkState) =>
    !!doneAt && w.status === 'done' && (acceptedAt.get(w.id) ?? '') <= doneAt;
  const works = view.works().filter((w) => w.status !== 'cancelled' && !earlier(w));
  const product = works.filter((w) => !isDocs(w));
  const docs = works.filter(isDocs);
  const dependedOn = new Set(product.flatMap((w) => w.order.dependsOn));
  const roots = product
    .filter((w) => !dependedOn.has(w.id))
    .map((w) => w.id)
    .sort();
  const declared = docs.filter((w) => !labelled(w) && named.has(w.id)).map((w) => w.id);
  const base = {
    mode,
    roots,
    works: docs.map((w) => w.id).sort(),
    ...(declared.length ? { declared: declared.sort() } : {}),
  };
  if (mode === 'off') return { ...base, status: 'off' };
  if (!product.length) return { ...base, status: 'no-works' };
  if (!docs.length) return { ...base, status: 'missing', missingRoots: roots };
  const byId = new Map(works.map((w) => [w.id, w]));
  const closure = (w: WorkState) => {
    const seen = new Set<string>();
    const stack = [...w.order.dependsOn];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(byId.get(id)?.order.dependsOn ?? []));
    }
    return seen;
  };
  const scored = docs.map((w) => {
    const deps = closure(w);
    return { w, missing: roots.filter((r) => !deps.has(r)) };
  });
  const after = scored.filter((s) => !s.missing.length);
  if (!after.length) {
    const best = scored.reduce((a, b) => (b.missing.length < a.missing.length ? b : a));
    return { ...base, status: 'not-after-roots', missingRoots: best.missing };
  }
  return { ...base, status: after.some((s) => s.w.status === 'done') ? 'done' : 'pending' };
}

/**
 * Проверить явные работы документации (`--docs-work`): каждая — работа
 * состояния, не отменённая. Иначе `INVALID_INPUT` — опечатка не должна молча
 * оставлять шаг открытым или закрывать его чужой работой.
 */
export function checkDocsWorks(
  view: Pick<ExecutionView, 'works'>,
  ids: readonly string[] | undefined,
  command: string,
) {
  if (!ids?.length) return;
  const works = new Map(view.works().map((w) => [w.id, w]));
  for (const id of ids) {
    const w = works.get(id);
    if (!w || w.status === 'cancelled')
      throw new HarnessError(
        'INVALID_INPUT',
        `${command} --docs-work ${id}: ${w ? 'работа отменена' : 'такой работы в состоянии нет'} — назовите ID принятой работы документации (harness status)`,
        [{ path: ['--docs-work'], message: w ? 'cancelled' : 'not-found' }],
      );
  }
}

/** Как закрыть открытый шаг: метка docs или явная работа (`--docs-work`). */
export const RELEASE_DOCS_HINT =
  'примите работу документации (метка docs, зависит от корневых работ выпуска); источник задач без меток (Relay) — назовите её явно: --docs-work <id>';

/**
 * Источник задач без метки docs (doctor): `release.docs: required`, работы
 * пришли из коннектора, ни одна не помечена docs.
 */
export const releaseDocsUnmarked = (
  view: Pick<ExecutionView, 'works'>,
  policy: Pick<ExecutionPolicy, 'release'>,
) => {
  if (releaseDocsMode(policy) !== 'required') return false;
  const works = view.works().filter((w) => w.status !== 'cancelled');
  return works.some((w) => w.order.source.connector !== 'files') && !works.some(labelled);
};

/** Шаг документации не выполнен: работы нет, она не после корней или не принята. */
export const releaseDocsOpen = (state: ReleaseDocsState) =>
  state.status === 'missing' || state.status === 'not-after-roots' || state.status === 'pending';

/** Строка для людей на языке представления; нет — шага нет (`off`) или работ нет. */
export function releaseDocsLine(
  state: ReleaseDocsState,
  lang: 'ru' | 'en' = 'ru',
): string | undefined {
  const en = lang === 'en';
  const list = (ids: readonly string[] | undefined) => (ids ?? []).join(', ');
  switch (state.status) {
    case 'missing':
      return en
        ? `Release documentation step: no work labelled docs after the root works (${list(state.roots)})`
        : `Шаг документации выпуска: нет работы с меткой docs после корневых работ (${list(state.roots)})`;
    case 'not-after-roots':
      return en
        ? `Release documentation step: the docs work does not depend on root works ${list(state.missingRoots)}`
        : `Шаг документации выпуска: работа документации не зависит от корневых работ ${list(state.missingRoots)}`;
    case 'pending':
      return en
        ? `Release documentation step: docs work ${list(state.works)} is not accepted yet`
        : `Шаг документации выпуска: работа документации ${list(state.works)} ещё не принята`;
    case 'done':
      return en
        ? `Release documentation step: docs work ${list(state.works)} accepted${state.declared?.length ? ` (named by the lead: ${list(state.declared)})` : ''}`
        : `Шаг документации выпуска: работа документации ${list(state.works)} принята${state.declared?.length ? ` (названа ведущим: ${list(state.declared)})` : ''}`;
    default:
      return undefined;
  }
}
