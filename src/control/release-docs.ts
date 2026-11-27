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
 * Работы текущего выпуска (ревью 1): неотменённые, без принятых до последнего
 * `release done` — их связи корнями нового выпуска не считаются.
 */
function currentReleaseWorks(
  view: Pick<ExecutionView, 'works'> & Partial<Pick<ExecutionView, 'attempts' | 'local'>>,
): WorkState[] {
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
  return view.works().filter((w) => w.status !== 'cancelled' && !earlier(w));
}

/**
 * Состояние шага: работы выпуска — неотменённые работы всех графов; корни —
 * работы не документации, от которых не зависит ни одна другая работа не
 * документации. Работа документации стоит «после корня», когда она
 * (транзитивно) зависит от него или (alpha.74) её принятая попытка началась
 * после приёмки корня; `done` — работа после всех корней принята.
 */
export function releaseDocsState(
  view: Pick<ExecutionView, 'works'> & Partial<Pick<ExecutionView, 'attempts' | 'local'>>,
  policy: Pick<ExecutionPolicy, 'release'>,
  options: ReleaseDocsOptions = {},
): ReleaseDocsState {
  const mode = releaseDocsMode(policy);
  const named = new Set(options.docsWorks ?? []);
  const isDocs = (w: WorkState) => labelled(w) || named.has(w.id);
  const works = currentReleaseWorks(view);
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
  // Принятая попытка работы: последняя успешная (её начало и конец).
  const accepted = new Map<string, { startedAt: string; finishedAt: string }>();
  for (const a of view.attempts?.() ?? [])
    if (a.status === 'succeeded' && a.finishedAt) {
      const prev = accepted.get(a.workId);
      if (!prev || a.finishedAt > prev.finishedAt)
        accepted.set(a.workId, { startedAt: a.startedAt, finishedAt: a.finishedAt });
    }
  // После корня (alpha.74, P10-7) — и без связи: принятая попытка работы
  // документации началась позже приёмки корня, то есть её база уже
  // содержала корень. Так шаг закрывает поздняя работа (исправления по
  // ревью выпуска), помеченная docs или названная --docs-work, когда она
  // сама правит документацию, — без отдельной работы документации.
  const acceptedAfter = (w: WorkState, root: string) => {
    const mine = w.status === 'done' ? accepted.get(w.id) : undefined;
    const theirs = accepted.get(root);
    return !!mine && !!theirs && mine.startedAt > theirs.finishedAt;
  };
  const scored = docs.map((w) => {
    const deps = closure(w);
    return { w, missing: roots.filter((r) => !deps.has(r) && !acceptedAfter(w, r)) };
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
  view: Pick<ExecutionView, 'works'> & Partial<Pick<ExecutionView, 'attempts' | 'local'>>,
  ids: readonly string[] | undefined,
  command: string,
) {
  if (!ids?.length) return;
  const works = new Map(view.works().map((w) => [w.id, w]));
  const current = new Set(currentReleaseWorks(view).map((w) => w.id));
  for (const id of ids) {
    const w = works.get(id);
    // Работа прежнего выпуска (принята до последнего release done) шаг
    // нынешнего не закрывает (ревью LOW).
    const why = !w
      ? (['not-found', 'такой работы в состоянии нет'] as const)
      : w.status === 'cancelled'
        ? (['cancelled', 'работа отменена'] as const)
        : !current.has(id)
          ? ([
              'earlier-release',
              'работа принята в прежнем выпуске (до последнего release done) — она не документация нынешнего',
            ] as const)
          : undefined;
    if (why)
      throw new HarnessError(
        'INVALID_INPUT',
        `${command} --docs-work ${id}: ${why[1]} — назовите ID работы документации текущего выпуска (harness status)`,
        [{ path: ['--docs-work'], message: why[0] }],
      );
  }
}

/** Строка журнала ведущего о явно названных работах документации (ревью LOW). */
export const docsWorksNote = (ids: readonly string[], command: string) => ({
  ru: `работа документации выпуска названа явно (${command} --docs-work): ${ids.join(', ')}`,
  en: `release docs work named explicitly (${command} --docs-work): ${ids.join(', ')}`,
});

/** Как закрыть открытый шаг: метка docs или явная работа (`--docs-work`). */
export const RELEASE_DOCS_HINT =
  'примите работу документации (метка docs, зависит от корневых работ выпуска или начата после их приёмки); источник задач без меток — назовите её явно: --docs-work <id>; поздняя работа (исправления по ревью выпуска), которая сама правит документацию, закрывает шаг тем же --docs-work <id>';

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
