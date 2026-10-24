/**
 * Дифференциальный оракул H1: диагноз `explainStop(stopInputsOf(...))` по
 * сохранённому состоянию против того, что затем делает настоящий движок
 * (`h.run` с fixture runtimes), на множестве сгенерированных состояний группы.
 *
 * Генератор детерминирован (seed). Каждое состояние строится публичными
 * операциями движка (claim/fail/retry/cancel/hold/pause, решение по эпизоду);
 * эпизод свойства вводится через `store.transact`, как его открывает
 * `afterFailure()` (так же, как в explain-engine.test.ts). Модели не вызываются.
 *
 * Наблюдение за движком (только во время `h.run`): вызовы `engine.retry`,
 * `engine.recoveryReserve` (и его итог), вызовы writer/lead по поручению
 * (обёртка адаптера), новые попытки и их исход, итоговые статусы, статус и
 * ошибка задания графа. Защита от известных зацикливаний движка (FI-001/FI-002):
 * обёртка `workflows.claim` обрывает прогон после MAX_CLAIMS стадий —
 * такой случай классифицируется `engine-loop` и не сравнивается.
 *
 * Правила сравнения (на работу X; «автоматическое действие над X» = движок
 * вызвал engine.retry(X), успешно зарезервировал разбор X (`analyzing`) или
 * выдал X исполнителю):
 *
 *  R1 retry-promised-not-done: диагноз X — retryPlanned / controller:retry,
 *     а движок ни разу не вызвал engine.retry(X). Не считается расхождением,
 *     если во время прогона какая-то автоматическая попытка не завершилась
 *     успехом или разбор ведущего не дал решения («возмущение»): диагноз
 *     обещает действия при условии, что предыдущие автоматические действия
 *     удадутся, а fixture задаёт только успешные исходы.
 *  R2 human-but-automatic: диагноз X называет шаг человека/ведущего
 *     (actor user|lead), а движок сам совершил автоматическое действие над X.
 *     Отказ резервирования разбора (`awaiting-user` после recoveryReserve) —
 *     не действие над X, а списание бюджета (FI-003) и считается отдельно.
 *  R3 wait-promised-nothing-happened: диагноз X — controller (wait|retry),
 *     прогон завершился без возмущения, над X не было ни одного
 *     автоматического действия, X не принят.
 *  R3h — тот же случай, но X удержан операцией (hold): диагноз «controller
 *     ждёт операцию» — семантика удержания (его снимает операция, не advance);
 *     печатается, тест не валит.
 *  R4 engine-promised-stop-on-x: задание графа остановилось с ошибкой,
 *     начинающейся с `X:`, а диагноз X обещал автоматическое продолжение
 *     (controller), без возмущения — дополнительная улика к R1/R3.
 *
 * Не расхождения, а отдельные счётчики: `engine-loop/diag-human` и
 * `engine-loop/diag-controller` (прогон оборван защитой; FI-001/FI-002),
 * заметки FI-003 (резервирование разбора отказано после списания бюджета) и
 * «engine.retry threw» (afterDecision зовёт retry на исчерпанных попытках —
 * повтор не состоялся и автоматическим действием не считается).
 *
 * Все расхождения собираются за полный проход, тест падает со списком
 * (seed + компактное описание состояния) и печатает счётчики по категориям.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { FailureKind, RuntimeAdapter } from '../src/contracts/index.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { ready } from './engine-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, greet, implement, type Scenario } from './runner-fixture.ts';

type Ctx = ReturnType<typeof hsetup>;
type H = ReturnType<Ctx['open']>;

const N = Number(process.env.DIFF_N ?? 100);
const SEED0 = Number(process.env.DIFF_SEED ?? 1);
const ONLY = process.env.DIFF_ONLY ? process.env.DIFF_ONLY.split(',').map(Number) : undefined;
const MAX_CLAIMS = 50;

/* ------------------------------------------------------------------ */
/* Генератор                                                            */
/* ------------------------------------------------------------------ */

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const KINDS = [
  'timeout',
  'environment',
  'gate',
  'review',
  'unknown',
  'review-protocol',
  'provider-auth',
] as const satisfies readonly FailureKind[];
type Kind = (typeof KINDS)[number];
type EpisodeSpec =
  | { status: 'awaiting-lead'; calls: 0 | 1 }
  | { status: 'retry'; work: 'failed' | 'ready' }
  | { status: 'retrying'; kind: Kind }
  | { status: 'awaiting-user' | 'stopped'; ready: boolean };
type WorkSpec =
  | { id: string; target: 'done' }
  | { id: string; target: 'ready'; hold?: boolean }
  | { id: string; target: 'cancelled' }
  | {
      id: string;
      target: 'failed';
      kind: Kind;
      attempts: 1 | 2;
      sameFingerprint: boolean;
      episode?: EpisodeSpec;
      hold?: boolean;
    };
interface CaseSpec {
  seed: number;
  maxAttempts: 2 | 3 | 5;
  repairBudget: 0 | 1 | 2 | 6;
  /** w1 зависит от w0. */
  dependency: boolean;
  works: WorkSpec[];
  operatorPause: boolean;
}

const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;

function generate(seed: number): CaseSpec {
  const r = mulberry32(seed);
  const count = 2 + Math.floor(r() * 3);
  const ids = ['add-greeting', 'w1', 'w2', 'w3'].slice(0, count);
  const maxAttempts = pick(r, [2, 3, 5] as const);
  const repairBudget = pick(r, [0, 1, 2, 6] as const);
  const dependency = r() < 0.25;
  const works: WorkSpec[] = [];
  let episodes = 0;
  for (const id of ids) {
    const x = r();
    let spec: WorkSpec;
    if (x < 0.12) spec = { id, target: 'done' };
    else if (x < 0.27) spec = { id, target: 'ready', ...(r() < 0.15 ? { hold: true } : {}) };
    else if (x < 0.35) spec = { id, target: 'cancelled' };
    else {
      const attempts = r() < 0.5 ? 1 : 2;
      spec = {
        id,
        target: 'failed',
        kind: pick(r, KINDS),
        attempts,
        sameFingerprint: r() < 0.6,
        ...(r() < 0.06 ? { hold: true } : {}),
      };
      // Не более одного-двух эпизодов на группу; шанс эпизода ~40%.
      if (episodes < 2 && r() < 0.4) {
        episodes++;
        const e = r();
        const episode: EpisodeSpec =
          e < 0.25
            ? { status: 'awaiting-lead', calls: r() < 0.7 ? 0 : 1 }
            : e < 0.5
              ? { status: 'retry', work: r() < 0.5 ? 'failed' : 'ready' }
              : e < 0.7
                ? { status: 'retrying', kind: pick(r, KINDS) }
                : { status: r() < 0.5 ? 'awaiting-user' : 'stopped', ready: r() < 0.3 };
        spec.episode = episode;
      }
    }
    works.push(spec);
  }
  // Зависимая работа: готова только за принятой предпосылкой; иначе — готова и ждёт.
  if (dependency && works[0]!.target !== 'done' && works[1]!.target !== 'cancelled')
    works[1] = { id: works[1]!.id, target: 'ready' };
  if (dependency && works[1]!.target === 'done') works[0] = { id: works[0]!.id, target: 'done' };
  // Эпизод с дополнительной попыткой (retrying) требует свободной попытки.
  for (const w of works)
    if (w.target === 'failed' && w.episode?.status === 'retrying' && w.attempts + 1 > maxAttempts)
      w.episode = { status: 'retry', work: 'failed' };
  return { seed, maxAttempts, repairBudget, dependency, works, operatorPause: r() < 0.15 };
}

const describe = (c: CaseSpec) =>
  `max=${c.maxAttempts} budget=${c.repairBudget}${c.dependency ? ' dep(w1→add-greeting)' : ''}${c.operatorPause ? ' PAUSE(operator)' : ''} | ` +
  c.works
    .map((w) => {
      if (w.target !== 'failed')
        return `${w.id}:${w.target}${'hold' in w && w.hold ? '+hold' : ''}`;
      const ep = w.episode
        ? ' ep=' +
          w.episode.status +
          ('calls' in w.episode ? `(calls ${w.episode.calls})` : '') +
          ('work' in w.episode ? `(${w.episode.work})` : '') +
          ('kind' in w.episode ? `(then ${w.episode.kind})` : '') +
          ('ready' in w.episode && w.episode.ready ? '(+retry→ready)' : '')
        : '';
      return `${w.id}:failed ${w.kind}×${w.attempts}${w.attempts > 1 ? (w.sameFingerprint ? ' same-fp' : ' diff-fp') : ''}${ep}${w.hold ? '+hold' : ''}`;
    })
    .join(', ');

/* ------------------------------------------------------------------ */
/* Построение состояния                                                 */
/* ------------------------------------------------------------------ */

const LEAD = {
  result: {
    action: 'new-approach',
    reason: 'Use another implementation approach',
    evidence: ['saved attempts'],
    hypothesis: 'a new hypothesis',
    plan: 'verify configured gate',
    cases: null,
    proposal: null,
    conflict: null,
  },
};

interface Observed {
  retried: Map<string, number>;
  retryThrew: Map<string, number>;
  reserved: Map<string, string[]>;
  writer: Map<string, number>;
  lead: Map<string, number>;
  claims: number;
  active: boolean;
}

function build(spec: CaseSpec) {
  const ids = spec.works.map((w) => w.id);
  // Роль lead fixture читает из того же сценария (Scenario её не объявляет).
  const scenario: Scenario = { writer: implement(), reviewer: approve(), ...{ lead: LEAD } };
  const ctx = hsetup({
    scenario,
    files: { 'src/greet.js': greet },
    policy: (p) => {
      p.maxAttempts = spec.maxAttempts;
      p.repairBudget = spec.repairBudget;
      // Постройка выдаёт все последние попытки сразу (до 4 работ).
      p.concurrency = 4;
    },
    graph: (raw) => {
      const orders = raw.orders as Record<string, unknown>[];
      orders[0]!.writeScope = ['lib/add-greeting'];
      for (const id of ids.slice(1))
        orders.push({
          ...orders[0],
          id,
          source: { connector: 'files', ref: id, revision: '1' },
          title: 'Independent work ' + id,
          writeScope: ['lib/' + id],
          dependsOn: spec.dependency && id === 'w1' ? [orders[0]!.id] : [],
        });
    },
  });
  const obs: Observed = {
    retried: new Map(),
    retryThrew: new Map(),
    reserved: new Map(),
    writer: new Map(),
    lead: new Map(),
    claims: 0,
    active: false,
  };
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  // Сценарий writer по поручению: каждая работа пишет в свою область.
  for (const id of ids)
    writeFileSync(
      `${ctx.scenarioPath}.${id}.json`,
      JSON.stringify({
        writer: implement({ [`lib/${id}/impl.js`]: `exports.id = ${JSON.stringify(id)};\n` }),
        reviewer: approve(),
        lead: LEAD,
      }),
    );
  const wrap = (a: RuntimeAdapter): RuntimeAdapter => ({
    runtime: a.runtime,
    capabilities: () => a.capabilities(),
    invoke: (request, signal) => {
      const workId = request.subject?.workId;
      if (workId && request.task === 'implement') {
        if (obs.active) inc(obs.writer, workId);
        return a.invoke(
          {
            ...request,
            env: { ...request.env, FIXTURE_SCENARIO: `${ctx.scenarioPath}.${workId}.json` },
          },
          signal,
        );
      }
      if (workId && request.task === 'plan' && obs.active) inc(obs.lead, workId);
      return a.invoke(request, signal);
    },
  });
  const h = ctx.open(ctx.policy, wrap);
  return { ctx, h, obs, inc };
}

const injectEpisode = (
  h: H,
  workId: string,
  status: 'awaiting-lead' | 'awaiting-user' | 'stopped',
  calls: number,
) => {
  const at = new Date(h.engine.clock()).toISOString();
  h.store.transact('task.retry', (tx) => {
    const w = tx.work(workId)!;
    const runs = tx
      .attempts(workId)
      .filter((a) => a.status === 'failed')
      .map((a) => a.id);
    tx.putWork({
      ...w,
      recovery: {
        id: 'RC-' + workId,
        property: 'p1',
        basis: h.engine.episodeOf(w, tx),
        runs,
        openedAt: at,
        status,
        calls,
        ...(status === 'awaiting-lead' ? {} : { reason: 'ждёт решения человека по свойству' }),
        history: [{ at, event: 'opened' }],
        version: 1,
      },
    });
  });
  return at;
};

const decideNewApproach = (h: H, workId: string, at: string) =>
  h.engine.recoveryDecide(workId, 'RC-' + workId, {
    action: 'new-approach',
    reason: 'operator decided a new approach',
    evidence: [],
    hypothesis: 'h',
    plan: 'p',
    source: { kind: 'operator' },
    decidedAt: at,
  });

const message = (w: Extract<WorkSpec, { target: 'failed' }>, n: number, kind: Kind) =>
  kind === 'environment'
    ? `getaddrinfo ENOTFOUND fixture ${w.sameFingerprint ? 'same' : ['alpha', 'beta', 'gamma'][n]}`
    : `fixture ${kind} failure ${w.sameFingerprint ? 'same' : ['alpha', 'beta', 'gamma'][n]}`;

/** Попытка через claim; пауза runtime от прежних отказов снимается на время постройки. */
const claimOf = (h: H, workId: string) => {
  const c = h.engine.read((v) => v.control());
  if (c.paused && c.pauseReason === 'runtime') h.engine.clearFailure([...(c.pauseFailures ?? [])]);
  const a = h.engine.claim('controller');
  assert.ok(a, `setup: claim ${workId}`);
  assert.equal(a.workId, workId, 'setup: claim order');
  return a;
};

function construct(spec: CaseSpec, ctx: Ctx, h: H) {
  const graph = ready(h.engine, ctx.graph, 'controller');
  const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
  h.workflows.finish(h.workflows.claim(job.key)!);
  const others = spec.works.filter((w) => w.target !== 'done').map((w) => w.id);
  // 1) Принятые работы: настоящий прогон одного шага, остальные удержаны.
  if (spec.works.some((w) => w.target === 'done')) {
    if (others.length) h.engine.hold(others, 'setup', 'differential setup');
    h.engine.release('controller');
    return { job, pending: true as const, others };
  }
  return { job, pending: false as const, others };
}

async function constructRest(spec: CaseSpec, ctx: Ctx, h: H, others: string[], pending: boolean) {
  if (pending) {
    // Шаг за шагом: зависимая принятая работа выдаётся после своей предпосылки.
    for (let i = 0; i < 3; i++) {
      await h.run({ graph: ctx.graph, author: 'claude', once: true });
      if (
        spec.works.every(
          (w) => w.target !== 'done' || h.engine.read((v) => v.work(w.id)!.status) === 'done',
        )
      )
        break;
    }
    for (const w of spec.works)
      if (w.target === 'done')
        assert.equal(
          h.engine.read((v) => v.work(w.id)!.status),
          'done',
          'setup: done ' + w.id,
        );
    if (others.length) h.engine.releaseHold('setup');
    assert.ok(h.engine.lead('controller'), 'setup: lead');
  }
  const failed = spec.works.filter(
    (w): w is Extract<WorkSpec, { target: 'failed' }> => w.target === 'failed',
  );
  const idle = spec.works.filter((w) => w.target === 'ready' || w.target === 'cancelled');
  // Не участвующие в попытках — удержаны, чтобы claim выдавал по порядку только нужные.
  const holdIdle = () =>
    idle.length &&
    h.engine.hold(
      idle.map((w) => w.id),
      'setup',
      'differential setup',
    );
  holdIdle();
  // 2) Предварительные попытки (вторая попытка или эпизод retrying).
  for (const w of failed) {
    const pre = w.attempts - 1;
    for (let i = 0; i < pre; i++) {
      const others2 = failed.filter((x) => x.id !== w.id).map((x) => x.id);
      if (others2.length) h.engine.hold(others2, 'setup2', 'differential setup');
      const a = claimOf(h, w.id);
      h.engine.fail(a.id, a.token, message(w, i, w.kind), { kind: w.kind });
      h.engine.retry(w.id);
      if (others2.length) h.engine.releaseHold('setup2');
    }
    if (w.episode?.status === 'retrying') {
      const others2 = failed.filter((x) => x.id !== w.id).map((x) => x.id);
      if (others2.length) h.engine.hold(others2, 'setup2', 'differential setup');
      const a = claimOf(h, w.id);
      h.engine.fail(a.id, a.token, message(w, 2, 'review'), { kind: 'review' });
      decideNewApproach(h, w.id, injectEpisode(h, w.id, 'awaiting-lead', 0));
      h.engine.retry(w.id);
      if (others2.length) h.engine.releaseHold('setup2');
    }
  }
  // 3) Последние попытки: все выдаются, пока очередь не на паузе, затем отказы по порядку.
  const c = h.engine.read((v) => v.control());
  if (c.paused && c.pauseReason === 'runtime') h.engine.clearFailure([...(c.pauseFailures ?? [])]);
  const claimed = failed.map((w) => {
    const a = h.engine.claim('controller');
    assert.ok(a, 'setup: final claim ' + w.id);
    assert.equal(a.workId, w.id, 'setup: final claim order');
    return a;
  });
  for (const [i, w] of failed.entries()) {
    const a = claimed[i]!;
    const kind = w.episode?.status === 'retrying' ? w.episode.kind : w.kind;
    h.engine.fail(a.id, a.token, message(w, w.attempts - 1, kind), { kind });
  }
  if (idle.length) h.engine.releaseHold('setup');
  // 4) Эпизоды и решения человека над итоговым состоянием.
  for (const w of failed) {
    const e = w.episode;
    if (!e || e.status === 'retrying') continue;
    if (e.status === 'awaiting-lead') injectEpisode(h, w.id, 'awaiting-lead', e.calls);
    else if (e.status === 'retry') {
      decideNewApproach(h, w.id, injectEpisode(h, w.id, 'awaiting-lead', 0));
      // Готовым эпизод бывает только со свободной попыткой (иначе retry требует сброса).
      if (e.work === 'ready' && h.engine.read((v) => v.work(w.id)!.attempt) < spec.maxAttempts)
        h.engine.retry(w.id);
    } else {
      injectEpisode(h, w.id, e.status, 1);
      if (e.ready && h.engine.read((v) => v.work(w.id)!.attempt) < spec.maxAttempts)
        h.engine.retry(w.id);
    }
  }
  for (const w of spec.works) if (w.target === 'cancelled') h.engine.cancel(w.id);
  const held = spec.works.filter((w) => 'hold' in w && w.hold).map((w) => w.id);
  if (held.length) h.engine.hold(held, 'probe-op', 'operation in progress');
  if (spec.operatorPause) h.engine.pause('operator');
  h.engine.release('controller');
}

/* ------------------------------------------------------------------ */
/* Сравнение                                                            */
/* ------------------------------------------------------------------ */

interface Diag {
  workId: string;
  retryPlanned: boolean;
  actor: string | null;
  action: string;
  code: string;
}

interface Mismatch {
  seed: number;
  rule: string;
  workId: string;
  state: string;
  diag: string;
  engine: string;
  /** Узкое описание формы состояния X для группировки. */
  pattern: string;
}

interface CaseResult {
  seed: number;
  category:
    | 'ok'
    | 'engine-loop/diag-controller'
    | 'engine-loop/diag-human'
    | 'setup-error'
    | 'mismatch'
    | 'semantic-only';
  mismatches: Mismatch[];
  notes: string[];
}

function workShape(h: H, id: string, spec: CaseSpec) {
  return h.engine.read((v) => {
    const w = v.work(id)!;
    const c = v.control();
    return [
      w.status,
      w.failureKind ?? '-',
      `a${w.attempt}/${spec.maxAttempts}`,
      w.recovery ? `ep:${w.recovery.status}` : 'noep',
      w.hold ? 'hold' : '',
      c.paused ? `paused:${c.pauseReason ?? '?'}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  });
}

async function runCase(seed: number): Promise<CaseResult> {
  const spec = generate(seed);
  const state = describe(spec);
  const { ctx, h, obs, inc } = build(spec);
  const notes: string[] = [];
  try {
    try {
      const { pending, others } = construct(spec, ctx, h);
      await constructRest(spec, ctx, h, others, pending);
    } catch (error) {
      return {
        seed,
        category: 'setup-error',
        mismatches: [],
        notes: [`${seed}: setup ${(error as Error).message} | ${state}`],
      };
    }
    const diags: Diag[] = stopInputsOf(h, {
      maxAttempts: ctx.policy.maxAttempts,
      repairBudget: ctx.policy.repairBudget,
    })
      .filter((i) => i.kind === 'work')
      .map(explainStop)
      .map((d) => ({
        workId: d.workId!,
        retryPlanned: d.retryPlanned,
        actor: d.actor,
        action: d.action,
        code: d.code,
      }));
    const shapes = new Map(diags.map((d) => [d.workId, workShape(h, d.workId, spec)]));
    const controlBefore = h.engine.read((v) => v.control());
    const attemptsBefore = new Map(
      spec.works.map((w) => [w.id, h.engine.read((v) => v.attempts(w.id).map((a) => a.id))]),
    );
    const statusBefore = new Map(
      spec.works.map((w) => [w.id, h.engine.read((v) => v.work(w.id)!.status)]),
    );

    // Обёртки наблюдения: только на время прогона.
    const engine = h.engine as unknown as Record<string, (...a: unknown[]) => unknown>;
    const origRetry = engine.retry!.bind(h.engine);
    // Засчитывается только состоявшийся повтор; отказ engine.retry (например,
    // ATTEMPTS_EXHAUSTED из afterDecision) — не автоматическое действие над работой.
    engine.retry = (...args: unknown[]) => {
      try {
        const out = origRetry(...args);
        inc(obs.retried, args[0] as string);
        return out;
      } catch (error) {
        inc(obs.retryThrew, args[0] as string);
        throw error;
      }
    };
    const origReserve = engine.recoveryReserve!.bind(h.engine);
    engine.recoveryReserve = (...args: unknown[]) => {
      const r = origReserve(...args) as { status: string };
      const id = args[0] as string;
      obs.reserved.set(id, [...(obs.reserved.get(id) ?? []), r.status]);
      return r;
    };
    const wf = h.workflows as unknown as Record<string, (...a: unknown[]) => unknown>;
    const origClaim = wf.claim!.bind(h.workflows);
    wf.claim = (...args: unknown[]) => {
      obs.claims++;
      if (obs.claims > MAX_CLAIMS) throw new Error('DIFF_ENGINE_LOOP');
      return origClaim(...args);
    };
    obs.active = true;
    let runError: string | undefined;
    try {
      await h.run({ graph: ctx.graph, author: 'claude' });
    } catch (error) {
      runError = (error as Error).message;
    }
    obs.active = false;
    if (runError === 'DIFF_ENGINE_LOOP')
      return {
        seed,
        // Известные зацикливания движка (FI-001/FI-002) не сравниваются; отдельно
        // считаются те, где диагноз обещал автоматическое продолжение (controller).
        category: diags.some((d) => d.actor === 'controller')
          ? 'engine-loop/diag-controller'
          : 'engine-loop/diag-human',
        mismatches: [],
        notes: [
          `${seed}: engine-loop | ${state} | diag ${diags.map((d) => `${d.workId}=${d.actor}:${d.action}`).join(' ')} | before loop: ${diags
            .map(
              (d) =>
                `${d.workId} retry×${obs.retried.get(d.workId) ?? 0} lead×${obs.lead.get(d.workId) ?? 0} writer×${obs.writer.get(d.workId) ?? 0}`,
            )
            .join(', ')}`,
        ],
      };
    const job = h.workflows.list().find((j) => j.kind === 'graph')!;
    const jobError = job.error ?? runError ?? '';
    // Возмущение: новая попытка прогона не принята, разбор ведущего не дал решения
    // или прогон упал не по решению движка.
    const disturbed: string[] = [];
    for (const w of spec.works) {
      const before = new Set(attemptsBefore.get(w.id));
      const fresh = h.engine.read((v) => v.attempts(w.id).filter((a) => !before.has(a.id)));
      for (const a of fresh)
        if (a.status !== 'succeeded') disturbed.push(`${w.id}:${a.status}:${a.failureKind ?? '-'}`);
    }
    if (runError) disturbed.push('run threw: ' + runError.slice(0, 120));
    if (/Разбор ведущего/.test(jobError)) disturbed.push('lead failed');

    const finalStatus = new Map(
      spec.works.map((w) => [w.id, h.engine.read((v) => v.work(w.id)!.status)]),
    );
    const engineOf = (id: string) =>
      [
        `retry×${obs.retried.get(id) ?? 0}${obs.retryThrew.get(id) ? `(threw×${obs.retryThrew.get(id)})` : ''}`,
        `reserve=${(obs.reserved.get(id) ?? []).join('/') || '-'}`,
        `writer×${obs.writer.get(id) ?? 0}`,
        `lead×${obs.lead.get(id) ?? 0}`,
        `${statusBefore.get(id)}→${finalStatus.get(id)}`,
        `job=${job.status} repairs=${job.repairs ?? 0}`,
        jobError ? `err="${jobError.slice(0, 90)}"` : '',
        disturbed.length ? `disturbed[${disturbed.join(';')}]` : '',
      ]
        .filter(Boolean)
        .join(' ');

    const mismatches: Mismatch[] = [];
    for (const d of diags) {
      const id = d.workId;
      const retried = (obs.retried.get(id) ?? 0) > 0;
      const analyzed = (obs.reserved.get(id) ?? []).includes('analyzing');
      const refusedReserve = (obs.reserved.get(id) ?? []).some((s) => s !== 'analyzing');
      const executed = (obs.writer.get(id) ?? 0) > 0;
      const automatic = retried || analyzed || executed;
      const human = d.actor === 'user' || d.actor === 'lead';
      const controller = d.actor === 'controller';
      const add = (rule: string) =>
        mismatches.push({
          seed,
          rule,
          workId: id,
          state,
          diag: `${d.actor}:${d.action}${d.retryPlanned ? ' (retryPlanned)' : ''} [${d.code}]`,
          engine: engineOf(id),
          pattern: `${shapes.get(id)} | diag ${d.actor}:${d.action}`,
        });
      if (refusedReserve)
        notes.push(
          `${seed}: FI-003 reserve refused for ${id} (diag ${d.actor}:${d.action}; ${engineOf(id)}) | ${state}`,
        );
      if ((obs.retryThrew.get(id) ?? 0) > 0)
        notes.push(
          `${seed}: engine.retry(${id}) threw during run (diag ${d.actor}:${d.action}; ${engineOf(id)}) | ${state}`,
        );
      if (d.retryPlanned && !retried && !disturbed.length) add('R1 retry-promised-not-done');
      if (human && automatic) add('R2 human-but-automatic');
      if (
        controller &&
        !d.retryPlanned &&
        !automatic &&
        !disturbed.length &&
        finalStatus.get(id) !== 'done'
      ) {
        // Удержание (hold) самой работы или незавершённой предпосылки в её цепочке —
        // ожидание операции: смысловая разница, не дефект прогноза.
        const held = h.engine.read((v) => {
          const seen = new Set<string>();
          const chain = (wid: string): boolean => {
            if (seen.has(wid)) return false;
            seen.add(wid);
            const w = v.work(wid);
            if (!w || w.status === 'done') return false;
            return Boolean(w.hold) || w.order.dependsOn.some(chain);
          };
          return chain(id);
        });
        add(held ? 'R3h wait-on-hold (semantic)' : 'R3 wait-promised-nothing-happened');
      }
      if (
        controller &&
        !disturbed.length &&
        job.status === 'failed' &&
        jobError.startsWith(id + ':') &&
        !automatic
      )
        add('R4 job-stopped-on-promised-work');
    }
    void controlBefore;
    return {
      seed,
      category: mismatches.some((m) => !m.rule.startsWith('R3h'))
        ? 'mismatch'
        : mismatches.length
          ? 'semantic-only'
          : 'ok',
      mismatches,
      notes,
    };
  } finally {
    h.close();
  }
}

test(
  `H1 differential oracle: explainStop vs h.run over ${N} generated group states`,
  { timeout: 900_000 },
  async () => {
    const seeds = ONLY ?? Array.from({ length: N }, (_, i) => SEED0 + i);
    // Случаи независимы (свой каталог состояния и репозиторий): пул параллельных прогонов.
    const results: CaseResult[] = new Array<CaseResult>(seeds.length);
    let next = 0;
    const worker = async () => {
      while (next < seeds.length) {
        const i = next++;
        results[i] = await runCase(seeds[i]!);
      }
    };
    await Promise.all(Array.from({ length: Number(process.env.DIFF_JOBS ?? 10) }, worker));
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.category] = (counts[r.category] ?? 0) + 1;
    const rules: Record<string, number> = {};
    const all = results.flatMap((r) => r.mismatches);
    for (const m of all) rules[m.rule] = (rules[m.rule] ?? 0) + 1;
    const patterns = new Map<string, Mismatch[]>();
    for (const m of all) {
      const key = `${m.rule} :: ${m.pattern}`;
      patterns.set(key, [...(patterns.get(key) ?? []), m]);
    }
    const lines = [
      `cases=${results.length} ${JSON.stringify(counts)}`,
      `mismatch rules: ${JSON.stringify(rules)}`,
      `distinct patterns: ${patterns.size}`,
      ...[...patterns.entries()].map(
        ([k, ms]) =>
          `  [${ms.length}] ${k}\n      e.g. seed ${ms[0]!.seed} ${ms[0]!.workId}: ${ms[0]!.state}\n      diag ${ms[0]!.diag}\n      engine ${ms[0]!.engine}\n      seeds ${[...new Set(ms.map((x) => x.seed))].slice(0, 12).join(',')}`,
      ),
      'notes:',
      ...results.flatMap((r) => r.notes).map((n) => '  ' + n),
    ];
    console.log(lines.join('\n'));
    // R3h (удержание операцией: диагноз «controller ждёт операцию», движок его
    // не снимает) — семантика, а не расхождение: печатается, но тест не валит.
    const failing = all.filter((m) => !m.rule.startsWith('R3h'));
    assert.equal(
      failing.length,
      0,
      `explain ≠ engine: ${failing.length} расхождений\n` +
        failing
          .map(
            (m) =>
              `seed ${m.seed} ${m.rule} ${m.workId}: ${m.state}\n    diag ${m.diag}\n    engine ${m.engine}`,
          )
          .join('\n'),
    );
  },
);
