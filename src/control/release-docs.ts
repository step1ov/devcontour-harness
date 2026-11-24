// Шаг документации выпуска (0.1.0-alpha.70). После корневых работ выпуска —
// работа документации (метка `docs`), до приёмки выпуска. Чистая функция над
// видом состояния: её читают `review-release`, `status` и представление.

import type { ExecutionPolicy, ExecutionView, WorkState } from '../contracts/index.ts';

export const DOCS_LABEL = 'docs';

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
}

export const releaseDocsMode = (policy: Pick<ExecutionPolicy, 'release'>) =>
  policy.release?.docs ?? 'advisory';

const isDocs = (w: WorkState) => w.order.labels?.includes(DOCS_LABEL) === true;

/**
 * Состояние шага: работы выпуска — неотменённые работы всех графов; корни —
 * работы не документации, от которых не зависит ни одна другая работа не
 * документации. Работа документации стоит «после корней», когда она
 * (транзитивно) зависит от каждого корня; `done` — такая работа принята.
 */
export function releaseDocsState(
  view: Pick<ExecutionView, 'works'>,
  policy: Pick<ExecutionPolicy, 'release'>,
): ReleaseDocsState {
  const mode = releaseDocsMode(policy);
  const works = view.works().filter((w) => w.status !== 'cancelled');
  const product = works.filter((w) => !isDocs(w));
  const docs = works.filter(isDocs);
  const dependedOn = new Set(product.flatMap((w) => w.order.dependsOn));
  const roots = product
    .filter((w) => !dependedOn.has(w.id))
    .map((w) => w.id)
    .sort();
  const base = { mode, roots, works: docs.map((w) => w.id).sort() };
  if (mode === 'off') return { ...base, status: 'off' };
  if (!product.length) return { ...base, status: 'no-works' };
  if (!docs.length) return { ...base, status: 'missing' };
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

/** Строка для людей: чего не хватает шагу документации. */
export function releaseDocsLine(state: ReleaseDocsState): string | undefined {
  switch (state.status) {
    case 'missing':
      return `Шаг документации выпуска: нет работы с меткой docs после корневых работ (${state.roots.join(', ')})`;
    case 'not-after-roots':
      return `Шаг документации выпуска: работа документации не зависит от корневых работ ${state.missingRoots?.join(', ') ?? ''}`;
    case 'pending':
      return `Шаг документации выпуска: работа документации ${state.works.join(', ')} ещё не принята`;
    default:
      return undefined;
  }
}
