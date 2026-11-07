/**
 * Состояния доски для диагноза многих работ (`stopInputsOf` с `workIds` и без
 * выбора): цепочки, широкие веера, отменённые корни с ждущими, эпизоды
 * восстановления, удержания, пауза, второй граф без задания. Строятся
 * публичными операциями движка; принятая работа и эпизод восстановления —
 * записью через `store.transact`, как в explain-engine.test.ts. Модели не
 * вызываются.
 */
import {
  workGraphSchema,
  type FailureKind,
  type InputOutcome,
  type WorkState,
} from '../src/contracts/index.ts';
import type { ExecutionView } from '../src/contracts/ports.ts';
import type { StopSource } from '../src/explain/state.ts';
import { digestOf } from '../src/contracts/digest.ts';
import { engineOf, graphOf, planReview, policyOf, sha, trustNone } from './engine-fixture.ts';

/** Вопрос исполнителя (и, по желанию, запрос ведущему) — как в input-request тестах. */
const question = (severity: number) => ({
  question: 'Какой формат приветствия?',
  options: [
    { id: 'hello', label: 'Hello, <name>!', consequence: null },
    { id: 'hi', label: 'Hi <name>', consequence: null },
  ],
  recommended: 'hello',
  severity,
  rationale: 'Текст виден пользователю',
  affects: [] as never[],
});
const askOutcome = (followUp: boolean): InputOutcome => ({
  question: { question: question(8), effectiveSeverity: 8, floors: [], mode: 'request' },
  assumptions: [],
  followUps: followUp
    ? [{ question: question(3), effectiveSeverity: 10, floors: ['declared' as const] }]
    : [],
  criticalHits: [],
  callId: 'call-1',
});

export const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Повторяемые классы чаще: иначе пауза (environment) и остановка (unknown)
// закрывают прогноз почти всем работам.
const KINDS: FailureKind[] = ['timeout', 'gate', 'review', 'timeout', 'gate', 'review', 'unknown'];
const EPISODES = ['awaiting-lead', 'applying', 'retry', 'retrying', 'awaiting-user'] as const;

type Shape = 'chain' | 'fan' | 'cancelled-roots' | 'random';

export interface BoardSpec {
  shape: Shape;
  /** Число работ основного графа. */
  size: number;
  seed: number;
  approvalMode?: 'agent' | 'operator';
  /** Второй граф (без задания или, у `rich`, со своим заданием). */
  second?: boolean;
  /**
   * Расширенные формы (отдельным потоком seed, базовые доски не сдвигаются):
   * вопросы исполнителя и запросы ведущему, ответ без применения, отказ до
   * начала работы (preflight), бюджеты с попытками без учёта вызовов, внешняя
   * предпосылка графа, идущая попытка, живая роль controller, задания обоих
   * графов с разным продолжением.
   */
  rich?: boolean;
}

/** Зависимости основного графа по форме. */
function depsOf(spec: BoardSpec, rnd: () => number): Record<string, string[]> {
  const deps: Record<string, string[]> = {};
  const n = spec.size;
  switch (spec.shape) {
    case 'chain': {
      // Корни (часть упадёт), затем цепочка от первого корня, затем независимые.
      const roots = Math.max(2, Math.floor(n / 10));
      for (let i = 0; i < roots; i++) deps['r' + i] = [];
      const depth = Math.floor(n / 2);
      for (let i = 0; i < depth; i++) deps['k' + i] = [i ? 'k' + (i - 1) : 'r0'];
      for (let i = roots + depth; i < n; i++) deps['w' + i] = [];
      break;
    }
    case 'fan': {
      const roots = Math.max(2, Math.floor(n / 12));
      for (let i = 0; i < roots; i++) deps['r' + i] = [];
      for (let i = roots; i < n; i++)
        deps['f' + i] = [
          'r' + Math.floor(rnd() * roots),
          ...(rnd() < 0.3 ? ['r' + Math.floor(rnd() * roots)] : []),
        ].filter((d, j, all) => all.indexOf(d) === j);
      break;
    }
    case 'cancelled-roots': {
      const roots = Math.floor(n / 2);
      for (let i = 0; i < roots; i++) deps['r' + i] = [];
      for (let i = 0; i < n - roots; i++) deps['d' + i] = ['r' + i];
      break;
    }
    case 'random': {
      for (let i = 0; i < n; i++) {
        const prior = Object.keys(deps);
        const count = prior.length && rnd() < 0.6 ? 1 + Math.floor(rnd() * 3) : 0;
        deps['n' + i] = [
          ...new Set(Array.from({ length: count }, () => prior[Math.floor(rnd() * prior.length)]!)),
        ];
      }
      break;
    }
  }
  return deps;
}

/**
 * Доска по описанию: движок standalone над SQLite, источник диагноза с
 * заданием основного графа. `view` оборачивает каждое чтение (счётчик,
 * дорогой вид хоста) — для проверок производительности.
 */
export function boardOf(
  spec: BoardSpec,
  wrapView: (view: ExecutionView) => ExecutionView = (v) => v,
) {
  const rnd = mulberry32(spec.seed);
  // Второй поток: расширенные формы не сдвигают базовую последовательность.
  const extra = mulberry32(spec.seed ^ 0x5bd1e995);
  const rich = (p: number) => Boolean(spec.rich) && extra() < p;
  const budgets = rich(0.4)
    ? {
        work: { usd: 5 },
        ...(extra() < 0.5 ? { total: { usd: 100 } } : {}),
        ...(extra() < 0.4 ? { group: { usd: 50 } } : {}),
        onUnknown: extra() < 0.5 ? ('stop' as const) : ('continue' as const),
      }
    : undefined;
  const policy = policyOf((p) => {
    p.maxAttempts = 3;
    p.repairBudget = 2 + Math.floor(rnd() * 3);
    if (spec.approvalMode) p.approvalMode = spec.approvalMode;
    if (budgets) p.budgets = budgets;
  });
  const { engine, store, dir } = engineOf(policy);
  const deps = depsOf(spec, rnd);
  const actor = spec.approvalMode === 'operator' ? 'operator' : 'agent';
  const trusted = { trusted: () => true, reachable: () => true };
  const register = (graph: ReturnType<typeof graphOf>) => {
    const { graph: state } = engine.register(graph, trusted);
    engine.recordReview(planReview(engine, state, engine.reviews('plan', state.id).length + 1));
    engine.approve(state.id, actor);
    return state;
  };
  // Внешняя предпосылка: часть работ ждёт её, claim её не проверяет.
  const external = rich(0.3);
  const mainGraph = graphOf(deps, '1', 'g');
  const main = register(
    external
      ? workGraphSchema.parse({
          ...mainGraph,
          prerequisites: [
            {
              id: 'ext',
              repositoryId: mainGraph.orders[0]!.repositoryId,
              resultSha: sha('e'),
              receipt: { kind: 'trusted', issuer: 'board', digest: digestOf('ext') },
            },
          ],
          orders: mainGraph.orders.map((o, i) =>
            i % 4 === 1 ? { ...o, dependsOn: [...o.dependsOn, 'ext'] } : o,
          ),
        })
      : mainGraph,
  );
  if (spec.second) {
    const other: Record<string, string[]> = {};
    for (let i = 0; i < 6; i++) other['x' + i] = i ? ['x' + (i - 1)] : [];
    register(graphOf(other, '1', 'h'));
  }
  engine.lead('c1');
  engine.resume();
  const ids = Object.keys(deps);
  const at = '2026-01-01T00:00:00.000Z';
  const put = (id: string, patch: (w: WorkState) => WorkState) =>
    store.transact('task.retry', (tx) => tx.putWork(patch(tx.work(id)!)));

  // Принятые корни: зависимые от них готовы к выдаче.
  if (spec.shape !== 'cancelled-roots')
    for (const id of ids)
      if (!deps[id]!.length && rnd() < 0.15) put(id, (w) => ({ ...w, status: 'done' }));

  // Отказы: всё, что выдаётся, падает случайным классом; часть — повторно
  // тем же текстом (отпечаток), часть повторяется движком.
  let live = false;
  for (let claims = 0; claims < spec.size; claims++) {
    const a = engine.claim('c1');
    if (!a) break;
    const kind = rnd() < 0.04 ? 'environment' : KINDS[Math.floor(rnd() * KINDS.length)]!;
    // Идущая попытка (отказ применения ответа в графе с попытками); вторая
    // единица concurrency остаётся очереди.
    if (!live && rich(0.1)) {
      live = true;
      continue;
    }
    if (rich(0.12)) {
      // Вопрос исполнителя (иногда с запросом ведущему); часть — с ответом.
      engine.fail(a.id, a.token, 'вопрос', {
        kind: 'needs-input',
        input: askOutcome(extra() < 0.5),
      });
      if (extra() < 0.5) {
        const request = engine
          .inputRequests({ workId: a.workId })
          .find((r) => r.kind === 'question');
        if (request)
          engine.answerInput(
            request.id,
            { text: 'Hello', actor: { kind: 'operator' } },
            request.version,
          );
      }
      continue;
    }
    if (rich(0.06)) {
      // Отказ до начала работы: не засчитан, повтора нет.
      engine.fail(a.id, a.token, `Работа ${a.workId}: снимок контекста не найден`, {
        kind: 'needs-lead',
        blocked: true,
      });
      continue;
    }
    engine.fail(a.id, a.token, `${kind} at ${a.workId}`, { kind });
    if (rnd() < 0.25) {
      try {
        engine.retry(a.workId);
      } catch {
        // Повтор не разрешён — работа остаётся упавшей.
      }
    }
  }

  // Отменённые: корни с ждущими (форма cancelled-roots) и случайные — в
  // половине прочих досок (любая отмена останавливает восстановление группы).
  const cancelRate = rnd() < 0.5 ? 0 : 0.06;
  for (const id of ids) {
    const w = engine.read((v) => v.work(id))!;
    if (w.status === 'done') continue;
    const cancel =
      spec.shape === 'cancelled-roots' ? id.startsWith('r') && rnd() < 0.8 : rnd() < cancelRate;
    if (cancel) engine.cancel(id);
  }

  // Эпизоды восстановления у части упавших и готовых.
  for (const id of ids) {
    if (rnd() >= 0.08) continue;
    const w = engine.read((v) => v.work(id))!;
    if (w.status !== 'failed' && w.status !== 'ready') continue;
    const status = EPISODES[Math.floor(rnd() * EPISODES.length)]!;
    const runs = engine.read((v) => v.attempts(id)).map((a) => a.id);
    put(id, (cur) => ({
      ...cur,
      recovery: {
        id: 'RC-' + id,
        property: 'p1',
        basis: engine.read((v) => engine.episodeOf(cur, v)),
        runs,
        openedAt: at,
        status,
        calls: rnd() < 0.5 ? 0 : 1,
        ...(status === 'awaiting-user' ? { reason: 'ждёт решения человека' } : {}),
        history: [{ at, event: 'opened' }],
        version: 1,
      },
    }));
  }

  // Удержания операцией.
  const held = ids.filter(
    (id) => engine.read((v) => v.work(id))!.status === 'ready' && rnd() < 0.05,
  );
  if (held.length) engine.hold(held, 'op-1', 'перенос базы');
  // Постановка, изменённая после согласования: устаревшее согласование
  // (operator — причина в диагнозе, agent — пересогласование заданием).
  for (const id of ids)
    if (rnd() < 0.05)
      put(id, (w) => ({ ...w, order: { ...w.order, title: w.order.title + ' (изменено)' } }));
  // Попытки без записанных вызовов: бюджет не определён (или превышен по onUnknown).
  if (budgets)
    store.transact('task.retry', (tx) => {
      for (const a of tx.attempts())
        if (a.status !== 'active' && extra() < 0.15) {
          // Попытка до учёта вызовов: без отметки `callsRecorded`, с кандидатом.
          const legacy: Partial<typeof a> = { ...a, candidateSha: sha('c') };
          delete legacy.callsRecorded;
          tx.putAttempt(legacy as typeof a);
        }
    });
  if (rnd() < 0.15) engine.pause('operator');
  // Живая роль controller — отдельный вход диагноза.
  if (!rich(0.2)) engine.release('c1');

  // Задание, которое очередь сама не продолжит (agent: только пересогласование).
  type Job = Parameters<StopSource['workflows']['continues']>[0];
  const continues = new Map([[main.id, rnd() >= 0.2]]);
  const jobs: Job[] = [
    { kind: 'graph', id: main.id, repairs: Math.floor(rnd() * 2) } as unknown as Job,
  ];
  // Задание второго графа со своим продолжением.
  if (spec.second && rich(0.6)) {
    continues.set('h', extra() < 0.5);
    jobs.push({ kind: 'graph', id: 'h', repairs: 0 } as unknown as Job);
  }
  const read0 = store.read.bind(store);
  (store as { read: typeof store.read }).read = (fn) => read0((v) => fn(wrapView(v)));
  const source: StopSource = {
    engine,
    policy,
    workflows: { list: () => jobs, continues: (j) => continues.get(j.id) ?? false },
  };
  return {
    source,
    policy,
    engine,
    store,
    dir,
    ids: () => engine.read((v) => v.works()).map((w) => w.id),
  };
}

/**
 * Доски для проверки производительности (400 работ): `failed` — 21 упавший
 * корень и независимые; `cancelled` — 200 отменённых корней, у каждого ждущая;
 * `chain` — 21 упавший корень и цепочка глубиной 100 от первого.
 */
export function perfBoardOf(
  shape: 'failed' | 'cancelled' | 'chain',
  wrapView: (view: ExecutionView) => ExecutionView = (v) => v,
  /** Бюджеты поручения и общий: статусы бюджетов — тоже раз на чтение. */
  budgets = false,
) {
  const policy = policyOf((p) => {
    p.maxAttempts = 3;
    p.repairBudget = 3;
    if (budgets) p.budgets = { work: { usd: 3 }, total: { usd: 100 }, onUnknown: 'continue' };
  });
  const { engine, store } = engineOf(policy);
  const deps: Record<string, string[]> = {};
  const failed: string[] = [];
  const cancelled: string[] = [];
  if (shape === 'cancelled') {
    for (let i = 0; i < 200; i++) {
      deps['c' + i] = [];
      cancelled.push('c' + i);
    }
    for (let i = 0; i < 200; i++) deps['d' + i] = ['c' + i];
  } else {
    for (let i = 0; i < 21; i++) {
      deps['f' + i] = [];
      failed.push('f' + i);
    }
    if (shape === 'chain') for (let i = 0; i < 100; i++) deps['k' + i] = [i ? 'k' + (i - 1) : 'f0'];
    for (let i = Object.keys(deps).length; i < 400; i++) deps['w' + i] = [];
  }
  const { graph } = engine.register(graphOf(deps), trustNone);
  engine.recordReview(planReview(engine, graph, 1));
  engine.approve(graph.id, 'agent');
  engine.lead('c1');
  engine.resume();
  for (const id of failed) {
    const a = engine.claim('c1')!;
    if (a.workId !== id) throw new Error(`выдана ${a.workId}, ожидалась ${id}`);
    engine.fail(a.id, a.token, 'timeout ' + id, { kind: 'timeout' });
  }
  for (const id of cancelled) engine.cancel(id);
  engine.release('c1');
  const job = { kind: 'graph', id: graph.id, repairs: 0 } as unknown as Parameters<
    StopSource['workflows']['continues']
  >[0];
  const read0 = store.read.bind(store);
  (store as { read: typeof store.read }).read = (fn) => read0((v) => fn(wrapView(v)));
  const source: StopSource = {
    engine,
    policy,
    workflows: { list: () => [job], continues: () => true },
  };
  return { source, policy, ids: Object.keys(deps) };
}

/**
 * Вид хоста, который строит ответ каждого чтения заново (как адаптер
 * DevContour: работа, граф и попытки собираются из документа доски на каждый
 * вызов): каждое чтение работ, графа или попыток обходит все работы. Считает
 * вызовы методов вида.
 */
export function hostLikeView(counts: Map<string, number>) {
  const costly = new Set(['work', 'works', 'graph', 'graphs', 'attempt', 'attempts']);
  return (view: ExecutionView): ExecutionView =>
    new Proxy(view, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          counts.set(String(key), (counts.get(String(key)) ?? 0) + 1);
          if (costly.has(String(key))) for (const w of target.works()) structuredClone(w.order);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
}
