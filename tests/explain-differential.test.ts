/**
 * Дифференциальный оракул H1: диагноз `explainStop(stopInputsOf(...))` по
 * сохранённому состоянию против того, что затем делает настоящий движок
 * (`h.run` с fixture runtimes), на множестве сгенерированных состояний группы.
 *
 * Генератор детерминирован (seed). Каждое состояние строится публичными
 * операциями движка (claim/phase/fail/retry/cancel/hold/pause, решение по
 * эпизоду). Эпизод свойства открывается двумя путями:
 *  - естественно — режим `property` (propertySetup): первая работа связана со
 *    свойством `knapsack-optimal`, два отказа ревью по связанному свойству
 *    открывают эпизод в `afterFailure()`; дальше — публичные recoveryDecide
 *    (new-approach / add-cases), retry, claim и fail;
 *  - вводом через `store.transact`, как его открывает `afterFailure()` (так же,
 *    как в explain-engine.test.ts), — для остальных работ группы.
 * Модели не вызываются.
 *
 * Помимо случайного базового состояния генератор (вторым, независимым потоком
 * seed, чтобы прежние базовые состояния не сдвигались) строит шаблоны форм,
 * которых базовое распределение почти не даёт, и их соседей: отменённая
 * работа с эпизодом (cancel после открытия — recovery сохраняется), пауза
 * runtime от отказа в группе одновременно с эпизодами awaiting-lead (calls 0),
 * эпизод `applying` (add-cases) на попытке < max и == max, `retrying` с
 * работой, вновь готовой через `engine.retry`, удержание бюджетом
 * (budgetBlock: попытка отказана классом budget, затем retry), расход,
 * уже превысивший бюджет поручения до записи budgetBlock (шаблон `overspent`,
 * третьим независимым потоком seed: стоимость последней попытки сохраняется
 * публичным measuredInvoke с локальным детерминированным адаптером, работа
 * упала — с эпизодом или без, — поэтому claim ещё не поставил budgetBlock),
 * цепочки зависимых работ за каждой из этих форм.
 *
 * Смена политики (четвёртым независимым потоком seed, ~15% случаев): после
 * постройки state закрывается и открывается заново под законно изменённой
 * политикой — предел попыток ниже прежнего (часть работ на пределе или за
 * ним, H1-F022) или, для бюджетных форм, бюджет поручения поднят до $100 /
 * бюджеты отключены после записанного budgetBlock (H1-F020). Граф одобряется
 * заново, при новом входе задания начинается текущее задание; диагноз
 * (`stopInputsOf` с maxAttempts/repairBudget новой политики) и прогон — под
 * новой политикой. В описании случая — ` policy(max 5→3)` и т. п.
 *
 * Наблюдение за движком (только во время `h.run`): вызовы `engine.retry`,
 * `engine.recoveryReserve` (и его итог), `engine.recoveryApplied` (add-cases), вызовы writer/lead по поручению
 * (обёртка адаптера), новые попытки и их исход, итоговые статусы, статус и
 * ошибка задания графа. Защита от известных зацикливаний движка (FI-001/FI-002):
 * обёртка `workflows.claim` обрывает прогон после MAX_CLAIMS стадий —
 * такой случай классифицируется `engine-loop`. За MAX_CLAIMS стадий движок
 * успевает сделать всё, что сделал бы сам, поэтому R1–R3 проверяются и в нём
 * (правило помечается «in engine-loop»; R4 — нет, задание не завершилось):
 * в известных циклах диагноз обязан называть шаг человека, а не обещать
 * продолжение, которого цикл не даёт. Повтор engine.retry без последующей
 * выдачи или разбора в цикле автоматическим действием не считается (FI-001).
 *
 * Правила сравнения (на работу X; «автоматическое действие над X» = движок
 * вызвал engine.retry(X), успешно зарезервировал разбор X (`analyzing`),
 * исполнил добавление случаев X (`recoveryApplied`) или выдал X исполнителю):
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
 * `engine-loop/diag-controller` (прогон оборван защитой, FI-001/FI-002, и
 * расхождений R1–R3 до обрыва нет),
 * заметки FI-003 (резервирование разбора отказано после списания бюджета) и
 * «engine.retry threw» (afterDecision зовёт retry на исчерпанных попытках —
 * повтор не состоялся и автоматическим действием не считается).
 *
 * Все расхождения собираются за полный проход, тест падает со списком
 * (seed + компактное описание состояния) и печатает счётчики по категориям
 * и по шаблонам генератора.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import {
  executionPolicySchema,
  type ExecutionPolicy,
  type FailureKind,
  type RuntimeAdapter,
} from '../src/contracts/index.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { Harness } from '../src/control/harness.ts';
import { measuredInvoke } from '../src/engine/measured.ts';
import { stopInputsOf } from '../src/explain/state.ts';
import { explainStop } from '../src/projections/stop.ts';
import { ready } from './engine-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { knap, propertySetup } from './property-fixture.ts';
import { approve, bin, greet, implement, type Scenario, type setup } from './runner-fixture.ts';

type Ctx = ReturnType<typeof setup>;
type H = Harness;

// Размер выборки: 100 случаев в release check (`npm run check` ставит
// HARNESS_RELEASE_CHECK=1 через `scripts/test.mjs --release`), 20 — в обычных,
// быстрых и выборочных прогонах. Seed те же (SEED0…), 20 — префикс сотни.
const N = Number(process.env.DIFF_N ?? (process.env.HARNESS_RELEASE_CHECK === '1' ? 100 : 20));
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
  /** `ready` — после отказа дополнительной попытки работа снова готова (engine.retry). */
  | { status: 'retrying'; kind: Kind; ready?: boolean }
  | { status: 'awaiting-user' | 'stopped'; ready: boolean };
/** Продолжение естественного эпизода свойства (режим property, первая работа). */
const PROPERTY_THEN = [
  'awaiting-lead',
  'retry-failed',
  'retry-ready',
  'applying',
  'retrying-failed',
  'retrying-ready',
] as const;
type PropertyThen = (typeof PROPERTY_THEN)[number];
type WorkSpec =
  | { id: string; target: 'done' }
  | { id: string; target: 'ready'; hold?: boolean }
  | { id: string; target: 'cancelled' }
  /** Готова, удержана бюджетом: попытка отказана классом budget, затем retry. */
  | { id: string; target: 'budget' }
  | {
      id: string;
      target: 'failed';
      kind: Kind;
      attempts: 1 | 2;
      sameFingerprint: boolean;
      episode?: EpisodeSpec;
      hold?: boolean;
      /** Отменена после открытия эпизода (engine.cancel сохраняет recovery). */
      cancel?: boolean;
      /** Последняя попытка израсходовала $5 при бюджете поручения $3 (budgetBlock ещё нет). */
      overspend?: boolean;
    }
  | {
      id: string;
      target: 'property';
      then: PropertyThen;
      hold?: boolean;
      cancel?: boolean;
      /** Второй отказ ревью (открывающий эпизод) израсходовал $5 при бюджете $3. */
      overspend?: boolean;
    };
type Failed = Extract<WorkSpec, { target: 'failed' }>;
interface CaseSpec {
  seed: number;
  /** Шаблон генератора (`base` — случайное базовое состояние). */
  template: string;
  /** property: первая работа связана со свойством, эпизод открывается естественно. */
  mode: 'plain' | 'property';
  maxAttempts: 2 | 3 | 5;
  repairBudget: 0 | 1 | 2 | 6;
  /** [зависимая, предпосылка]. */
  deps: [string, string][];
  works: WorkSpec[];
  operatorPause: boolean;
  /** Бюджет поручения (work.usd = 3) — для удержания бюджетом. */
  budgets: boolean;
  /**
   * Смена политики после постройки: state закрывается и открывается заново
   * под законно изменённой политикой (граф одобряется заново, начинается
   * текущее задание), диагноз и прогон — под новой политикой.
   */
  policyChange?: PolicyChange;
}
type PolicyChange =
  /** Ужесточение попыток: новый предел ниже прежнего (≥ 1). */
  | { maxAttempts: number }
  /** Бюджет поручения поднят до $100 или бюджеты отключены. */
  | { budgets: 'raised' | 'disabled' };

const IDS = ['add-greeting', 'w1', 'w2', 'w3'];
const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
const shuffle = <T>(r: () => number, xs: T[]) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
};

/** Случайное базовое состояние (прежний генератор; поток seed не меняется). */
function base(seed: number): CaseSpec {
  const r = mulberry32(seed);
  const count = 2 + Math.floor(r() * 3);
  const ids = IDS.slice(0, count);
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
  return {
    seed,
    template: 'base',
    mode: 'plain',
    maxAttempts,
    repairBudget,
    deps: dependency ? [['w1', 'add-greeting']] : [],
    works,
    operatorPause: r() < 0.15,
    budgets: false,
  };
}

const plainFailed = (r: () => number, id: string, kinds: readonly Kind[] = KINDS): Failed => ({
  id,
  target: 'failed',
  kind: pick(r, kinds),
  attempts: r() < 0.5 ? 1 : 2,
  sameFingerprint: r() < 0.6,
});
const episodeFailed = (id: string, episode: EpisodeSpec, extra: Partial<Failed> = {}): Failed => ({
  id,
  target: 'failed',
  kind: 'review',
  attempts: 2,
  sameFingerprint: true,
  episode,
  ...extra,
});
const randomEpisode = (r: () => number, max: number): EpisodeSpec => {
  const e = r();
  if (e < 0.3) return { status: 'awaiting-lead', calls: r() < 0.7 ? 0 : 1 };
  if (e < 0.55) return { status: 'retry', work: r() < 0.5 ? 'failed' : 'ready' };
  if (e < 0.8 && max >= 3)
    return {
      status: 'retrying',
      kind: pick(r, KINDS),
      ...(max >= 4 && r() < 0.5 ? { ready: true } : {}),
    };
  return { status: r() < 0.5 ? 'awaiting-user' : 'stopped', ready: r() < 0.3 };
};

/**
 * Сосед формы на свободном месте: зависимая готовая (цепочка за одной из
 * уже размещённых работ), готовая, сломанная без эпизода, принятая или
 * отменённая.
 */
function neighbour(
  r: () => number,
  id: string,
  placed: WorkSpec[],
  deps: [string, string][],
): WorkSpec {
  const x = r();
  const parents = placed.filter((w) => w.target !== 'done' && w.target !== 'cancelled');
  if (x < 0.4 && parents.length) {
    // Предпочтительно за последней размещённой работой — так растут цепочки.
    const parent = r() < 0.6 ? parents.at(-1)! : pick(r, parents);
    deps.push([id, parent.id]);
    return { id, target: 'ready', ...(r() < 0.1 ? { hold: true } : {}) };
  }
  if (x < 0.55) return { id, target: 'ready' };
  if (x < 0.85) return plainFailed(r, id);
  if (x < 0.93) return { id, target: 'done' };
  return { id, target: 'cancelled' };
}

/** Раскладка ролей формы по местам: ведущие работы — в начале, соседи — после. */
function layout(
  r: () => number,
  core: ((id: string) => WorkSpec)[],
  first: WorkSpec[] = [],
): { works: WorkSpec[]; deps: [string, string][] } {
  const deps: [string, string][] = [];
  const works = [...first];
  for (const make of core) works.push(make(IDS[works.length]!));
  const total = Math.min(
    IDS.length,
    works.length + Math.floor(r() * (IDS.length - works.length + 1)),
  );
  while (works.length < total) works.push(neighbour(r, IDS[works.length]!, works, deps));
  return { works, deps };
}

const TEMPLATES = [
  'cancel-episode',
  'pause-lead',
  'applying',
  'ready-retrying',
  'natural',
  'budget',
] as const;

function template(seed: number, r: () => number, name: (typeof TEMPLATES)[number]): CaseSpec {
  const common = {
    seed,
    template: name,
    operatorPause: r() < 0.08,
    budgets: false,
    repairBudget: pick(r, [1, 2, 6, 6] as const) as CaseSpec['repairBudget'],
  };
  switch (name) {
    case 'cancel-episode': {
      // Эпизод A (повтор), отменённая B с эпизодом, сломанная C без эпизода — в любом порядке.
      const maxAttempts = pick(r, [3, 5] as const);
      const roles = shuffle(r, [
        (id: string) =>
          r() < 0.8
            ? episodeFailed(id, { status: 'retry', work: r() < 0.5 ? 'failed' : 'ready' })
            : plainFailed(r, id),
        (id: string) => episodeFailed(id, randomEpisode(r, maxAttempts), { cancel: true }),
        (id: string) => plainFailed(r, id, ['timeout', 'gate', 'unknown', 'review']),
      ]);
      return { ...common, mode: 'plain', maxAttempts, ...layout(r, roles) };
    }
    case 'pause-lead': {
      // Эпизоды awaiting-lead (calls 0) и отказ среды/доступа, ставящий паузу runtime.
      const maxAttempts = pick(r, [3, 5] as const);
      const roles = shuffle(r, [
        (id: string) => episodeFailed(id, { status: 'awaiting-lead', calls: 0 }),
        (id: string) =>
          r() < 0.6
            ? episodeFailed(id, { status: 'awaiting-lead', calls: 0 })
            : r() < 0.5
              ? episodeFailed(id, randomEpisode(r, maxAttempts))
              : plainFailed(r, id),
        (id: string) => ({
          ...plainFailed(r, id, ['environment', 'provider-auth']),
          attempts: 1 as const,
        }),
      ]);
      return { ...common, mode: 'plain', maxAttempts, ...layout(r, roles) };
    }
    case 'applying': {
      // add-cases на естественном эпизоде: попытка 2 == max (2) или < max.
      const maxAttempts = pick(r, [2, 2, 3, 5] as const);
      const first: WorkSpec[] = [
        { id: IDS[0]!, target: 'property', then: 'applying', ...(r() < 0.1 ? { hold: true } : {}) },
      ];
      return { ...common, mode: 'property', maxAttempts, ...layout(r, [], first) };
    }
    case 'ready-retrying': {
      // retrying, работа которого снова готова через engine.retry (без активной попытки).
      const maxAttempts = 5 as const;
      if (r() < 0.5) {
        const first: WorkSpec[] = [{ id: IDS[0]!, target: 'property', then: 'retrying-ready' }];
        return { ...common, mode: 'property', maxAttempts, ...layout(r, [], first) };
      }
      const roles = [
        (id: string) =>
          episodeFailed(id, { status: 'retrying', kind: pick(r, KINDS), ready: true }),
      ];
      return { ...common, mode: 'plain', maxAttempts, ...layout(r, roles) };
    }
    case 'natural': {
      let then = pick(r, PROPERTY_THEN);
      const maxAttempts = pick(r, [2, 3, 5] as const);
      // Дополнительная попытка эпизода требует свободной попытки.
      if (then.startsWith('retrying') && maxAttempts < 3) then = 'retry-failed';
      if (then === 'retrying-ready' && maxAttempts < 4) then = 'retrying-failed';
      if (then === 'retry-ready' && maxAttempts < 3) then = 'retry-failed';
      const first: WorkSpec[] = [
        {
          id: IDS[0]!,
          target: 'property',
          then,
          ...(r() < 0.12 ? { cancel: true } : r() < 0.1 ? { hold: true } : {}),
        },
      ];
      const roles =
        r() < 0.3
          ? [
              (id: string) => ({
                ...plainFailed(r, id, ['environment', 'provider-auth']),
                attempts: 1 as const,
              }),
            ]
          : r() < 0.3
            ? [(id: string) => episodeFailed(id, randomEpisode(r, maxAttempts))]
            : [];
      return { ...common, mode: 'property', maxAttempts, ...layout(r, roles, first) };
    }
    case 'budget': {
      const maxAttempts = pick(r, [3, 5] as const);
      const roles = shuffle(r, [
        (id: string): WorkSpec => ({ id, target: 'budget' }),
        (id: string) =>
          r() < 0.5 ? plainFailed(r, id) : episodeFailed(id, randomEpisode(r, maxAttempts)),
      ]);
      return { ...common, mode: 'plain', maxAttempts, budgets: true, ...layout(r, roles) };
    }
  }
}

/**
 * Расход уже превысил бюджет поручения, а budgetBlock не записан: работа упала
 * (claim ставит поле только готовым). Ведущей — естественный эпизод свойства
 * (как в H1-F018) или сломанная работа с эпизодом/без; соседи — за ней.
 */
function overspent(seed: number, r: () => number): CaseSpec {
  const common = {
    seed,
    template: 'overspent',
    operatorPause: r() < 0.05,
    budgets: true,
    repairBudget: pick(r, [1, 2, 6, 6] as const) as CaseSpec['repairBudget'],
  };
  const maxAttempts = pick(r, [3, 5] as const);
  if (r() < 0.5) {
    // Повтор эпизода (retrying) потребовал бы выдачи при превышенном бюджете.
    const then = pick(r, ['awaiting-lead', 'retry-failed', 'retry-ready', 'applying'] as const);
    const first: WorkSpec[] = [
      {
        id: IDS[0]!,
        target: 'property',
        then,
        overspend: true,
        ...(r() < 0.08 ? { cancel: true } : {}),
      },
    ];
    const roles =
      r() < 0.3 ? [(id: string) => episodeFailed(id, randomEpisode(r, maxAttempts))] : [];
    return { ...common, mode: 'property', maxAttempts, ...layout(r, roles, first) };
  }
  const roles = [
    (id: string): WorkSpec =>
      r() < 0.5
        ? { ...plainFailed(r, id), overspend: true }
        : episodeFailed(id, randomEpisode(r, maxAttempts), { overspend: true }),
    ...(r() < 0.4
      ? [
          (id: string) =>
            r() < 0.5 ? plainFailed(r, id) : episodeFailed(id, randomEpisode(r, maxAttempts)),
        ]
      : []),
  ];
  return { ...common, mode: 'plain', maxAttempts, ...layout(r, roles) };
}

const TEMPLATE_SHARE = 0.5;
const OVERSPENT_SHARE = 0.15;
const POLICY_CHANGE_SHARE = 0.15;
/** Бюджетные формы редки (~20%): смена бюджета над ними — чаще. */
const BUDGET_CHANGE_SHARE = 0.4;

/**
 * Четвёртый независимый поток seed: смена политики между постройкой и
 * диагнозом не сдвигает прежние состояния. Попытки — ниже прежнего предела
 * (часть работ оказывается на пределе или за ним, H1-F022); бюджет —
 * поднят или отключён после записанного budgetBlock (H1-F020).
 */
function policyChange(spec: CaseSpec): CaseSpec {
  const r = mulberry32((spec.seed * 0x27d4eb2f) ^ 0x165667b1);
  if (r() >= (spec.budgets ? BUDGET_CHANGE_SHARE : POLICY_CHANGE_SHARE)) return spec;
  if (spec.budgets && r() < 0.7)
    return { ...spec, policyChange: { budgets: r() < 0.5 ? 'raised' : 'disabled' } };
  if (r() < 0.4) return tightened(spec.seed, r);
  // Новый предел — текущая попытка одной из работ (она оказывается на пределе),
  // иногда на единицу ниже (за пределом); работы с эпизодом — вдвое чаще.
  const targets = spec.works.flatMap((w) => {
    const a = attemptsOf(w);
    if (a < 1 || a >= spec.maxAttempts) return [];
    return hasEpisode(w) ? [a, a] : [a];
  });
  let max = targets.length ? pick(r, targets) : 1 + Math.floor(r() * (spec.maxAttempts - 1));
  if (max > 1 && r() < 0.25) max--;
  return { ...spec, policyChange: { maxAttempts: max } };
}

/**
 * Форма H1-F022 под ужесточением: работа, снова готовая в эпизоде (повтор
 * выдан), оказывается на новом пределе попыток, а за ней — сломанная работа
 * с эпизодом retry ниже предела (её повтор движок не выдаст: группа встанет
 * на первой). Прежний предел — 5, новый — попытка готовой работы.
 */
function tightened(seed: number, r: () => number): CaseSpec {
  const common = {
    seed,
    template: 'tightened',
    operatorPause: r() < 0.05,
    budgets: false,
    repairBudget: pick(r, [1, 2, 6, 6] as const) as CaseSpec['repairBudget'],
    maxAttempts: 5 as const,
  };
  const x = r();
  const property = x < 0.35;
  const exhausted: WorkSpec = property
    ? { id: IDS[0]!, target: 'property', then: r() < 0.5 ? 'retry-ready' : 'retrying-ready' }
    : x < 0.6
      ? episodeFailed(IDS[0]!, { status: 'retry', work: 'ready' })
      : x < 0.8
        ? episodeFailed(IDS[0]!, { status: 'retrying', kind: pick(r, KINDS), ready: true })
        : episodeFailed(IDS[0]!, { status: r() < 0.5 ? 'awaiting-user' : 'stopped', ready: true });
  const max = attemptsOf(exhausted);
  // Позже по группе — эпизод retry ниже нового предела (или иная сломанная).
  const later = (id: string): WorkSpec => {
    const y = r();
    if (y < 0.6) return episodeFailed(id, { status: 'retry', work: 'failed' }, { attempts: 1 });
    if (y < 0.75 && max >= 3) return episodeFailed(id, { status: 'retry', work: 'failed' });
    if (y < 0.9) return episodeFailed(id, { status: 'awaiting-lead', calls: 0 }, { attempts: 1 });
    return { ...plainFailed(r, id), attempts: 1 };
  };
  const { works, deps } = layout(r, [later], [exhausted]);
  // Иногда готовая работа на пределе — не первая в группе (в режиме property
  // работа со свойством всегда первая). Места переименовываются по порядку.
  if (!property && works.length > 2 && r() < 0.25) {
    const ids = works.map((w) => w.id);
    const k = 1 + Math.floor(r() * (works.length - 1));
    [works[0], works[k]] = [works[k]!, works[0]!];
    works.forEach((w, n) => (w.id = ids[n]!));
    deps.length = 0;
  }
  return {
    ...common,
    mode: property ? 'property' : 'plain',
    deps,
    works,
    policyChange: { maxAttempts: max },
  };
}

/** Число попыток работы после постройки (как его оставляет constructRest). */
const attemptsOf = (w: WorkSpec): number => {
  switch (w.target) {
    case 'done':
    case 'budget':
      return 1;
    case 'ready':
    case 'cancelled':
      return 0;
    case 'property':
      return w.then.startsWith('retrying') ? 3 : 2;
    case 'failed':
      return w.attempts + (w.episode?.status === 'retrying' ? 1 : 0);
  }
};
const hasEpisode = (w: WorkSpec) =>
  w.target === 'property' || (w.target === 'failed' && !!w.episode);

function generate(seed: number): CaseSpec {
  return policyChange(generateState(seed));
}

function generateState(seed: number): CaseSpec {
  // Третий поток: шаблон overspent не сдвигает прежние случаи остальных seed.
  const r3 = mulberry32((seed * 0x85ebca6b) ^ 0xc2b2ae35);
  if (r3() < OVERSPENT_SHARE) return overspent(seed, r3);
  const spec = base(seed);
  // Второй поток: шаблоны и дополнения не сдвигают базовые состояния прежних seed.
  const r = mulberry32((seed * 0x9e3779b1) ^ 0x5bd1e995);
  if (r() < TEMPLATE_SHARE) return template(seed, r, pick(r, TEMPLATES));
  for (const w of spec.works) {
    if (w.target !== 'failed' || !w.episode) continue;
    if (r() < 0.12) w.cancel = true;
    if (w.episode.status === 'retrying' && w.attempts + 2 <= spec.maxAttempts && r() < 0.4)
      w.episode.ready = true;
  }
  return spec;
}

const policyText = (c: CaseSpec) => {
  const p = c.policyChange;
  if (!p) return '';
  if ('maxAttempts' in p) return ` policy(max ${c.maxAttempts}→${p.maxAttempts})`;
  return p.budgets === 'raised' ? ' policy(work $3→$100)' : ' policy(budgets off)';
};
/** Предел попыток, под которым идут диагноз и прогон. */
const effectiveMax = (c: CaseSpec) =>
  c.policyChange && 'maxAttempts' in c.policyChange ? c.policyChange.maxAttempts : c.maxAttempts;

const describe = (c: CaseSpec) =>
  `[${c.template}${c.mode === 'property' ? ' property' : ''}] max=${c.maxAttempts} budget=${c.repairBudget}` +
  `${c.budgets ? ' budgets(work $3)' : ''}${c.deps.map(([a, b]) => ` dep(${a}→${b})`).join('')}` +
  `${c.operatorPause ? ' PAUSE(operator)' : ''}${policyText(c)} | ` +
  c.works
    .map((w) => {
      const flags = `${'hold' in w && w.hold ? '+hold' : ''}${'cancel' in w && w.cancel ? '+cancel' : ''}${'overspend' in w && w.overspend ? '+overspent($5>$3)' : ''}`;
      if (w.target === 'property') return `${w.id}:property(natural→${w.then})${flags}`;
      if (w.target !== 'failed') return `${w.id}:${w.target}${flags}`;
      const ep = w.episode
        ? ' ep=' +
          w.episode.status +
          ('calls' in w.episode ? `(calls ${w.episode.calls})` : '') +
          ('work' in w.episode ? `(${w.episode.work})` : '') +
          ('kind' in w.episode ? `(then ${w.episode.kind})` : '') +
          ('ready' in w.episode && w.episode.ready ? '(+retry→ready)' : '')
        : '';
      return `${w.id}:failed ${w.kind}×${w.attempts}${w.attempts > 1 ? (w.sameFingerprint ? ' same-fp' : ' diff-fp') : ''}${ep}${flags}`;
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
  /** Итог engine.recoveryApplied (подтверждение добавленных случаев). */
  applied: Map<string, string[]>;
  writer: Map<string, number>;
  lead: Map<string, number>;
  claims: number;
  active: boolean;
}

const UNIT_GATE = {
  id: 'unit',
  kind: 'test',
  command: [process.execPath, 'test/run.js'],
  report: { type: 'junit', path: 'test-results/junit.xml' },
};

function build(spec: CaseSpec) {
  const ids = spec.works.map((w) => w.id);
  const dependsOn = (id: string) => spec.deps.filter(([a]) => a === id).map(([, b]) => b);
  const policy = (p: Record<string, unknown>) => {
    p.maxAttempts = spec.maxAttempts;
    p.repairBudget = spec.repairBudget;
    // Постройка выдаёт все последние попытки сразу (до 4 работ).
    p.concurrency = 4;
    if (spec.budgets) p.budgets = { work: { usd: 3 }, onUnknown: 'continue' };
  };
  const order = (first: Record<string, unknown>, id: string) => ({
    ...first,
    id,
    source: { connector: 'files', ref: id, revision: '1' },
    title: 'Independent work ' + id,
    writeScope: ['lib/' + id],
    dependsOn: dependsOn(id),
  });
  let ctx: Ctx;
  if (spec.mode === 'property') {
    // Первая работа — со свойством knapsack-optimal и gate properties; остальные — на unit.
    ctx = propertySetup({
      writer: implement({ 'src/knap.mjs': knap.correct }),
      lead: LEAD,
      files: { 'src/greet.js': greet },
      policy: (p) => {
        policy(p);
        (p.repositories as { gates: unknown[] }[])[0]!.gates.push(UNIT_GATE);
      },
    });
    const orders = ctx.graph.orders as unknown as Record<string, unknown>[];
    for (const id of ids.slice(1)) {
      const o: Record<string, unknown> = {
        ...order(orders[0]!, id),
        gates: ['unit'],
        contracts: [],
      };
      delete o.properties;
      orders.push(o);
    }
    ctx.store.close();
  } else {
    // Роль lead fixture читает из того же сценария (Scenario её не объявляет).
    const scenario: Scenario = { writer: implement(), reviewer: approve(), ...{ lead: LEAD } };
    ctx = hsetup({
      scenario,
      files: { 'src/greet.js': greet },
      policy,
      graph: (raw) => {
        const orders = raw.orders as Record<string, unknown>[];
        orders[0]!.writeScope = ['lib/add-greeting'];
        for (const id of ids.slice(1)) orders.push(order(orders[0]!, id));
      },
    });
  }
  const obs: Observed = {
    retried: new Map(),
    retryThrew: new Map(),
    reserved: new Map(),
    applied: new Map(),
    writer: new Map(),
    lead: new Map(),
    claims: 0,
    active: false,
  };
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  // Сценарий writer по поручению: каждая работа пишет в свою область.
  for (const w of spec.works) {
    const files =
      w.target === 'property'
        ? { 'src/knap.mjs': knap.correct }
        : { [`lib/${w.id}/impl.js`]: `exports.id = ${JSON.stringify(w.id)};\n` };
    writeFileSync(
      `${ctx.scenarioPath}.${w.id}.json`,
      JSON.stringify({
        // Удержание бюджетом: расход writer выше предела поручения ($3).
        writer: { ...implement(files), ...(w.target === 'budget' ? { costUsd: 5 } : {}) },
        reviewer: approve(),
        lead: LEAD,
      }),
    );
  }
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
  const open = (policy: ExecutionPolicy) =>
    Harness.open({
      stateDir: ctx.state,
      policy,
      baseDir: ctx.repo.dir,
      adapters: {
        claude: wrap(
          cliAdapter('claude', {
            executable: bin('fake-claude'),
            toolProfiles: policy.toolProfiles,
          }),
        ),
        codex: wrap(
          cliAdapter('codex', {
            executable: bin('fake-codex'),
            toolProfiles: policy.toolProfiles,
          }),
        ),
      },
    });
  return { ctx, h: open(ctx.policy), open, obs, inc };
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

const now = (h: H) => new Date(h.engine.clock()).toISOString();
const decideNewApproach = (h: H, workId: string, at: string, recoveryId = 'RC-' + workId) =>
  h.engine.recoveryDecide(workId, recoveryId, {
    action: 'new-approach',
    reason: 'operator decided a new approach',
    evidence: [],
    hypothesis: 'h',
    plan: 'p',
    source: { kind: 'operator' },
    decidedAt: at,
  });
/** Подтверждаемый контрпример рюкзака: заглушка в HEAD на нём падает. */
const decideAddCases = (h: H, workId: string, recoveryId: string) =>
  h.engine.recoveryDecide(workId, recoveryId, {
    action: 'add-cases',
    reason: 'Add a confirmed knapsack counterexample',
    evidence: [],
    cases: [
      {
        input: JSON.stringify({
          items: [
            { w: 1, v: 1 },
            { w: 1, v: 1 },
            { w: 1, v: 1 },
            { w: 1, v: 9 },
          ],
          cap: 4,
        }),
        expected: '12',
      },
    ],
    source: { kind: 'operator' },
    decidedAt: now(h),
  });

const message = (w: Failed, n: number, kind: Kind) =>
  kind === 'environment'
    ? `getaddrinfo ENOTFOUND fixture ${w.sameFingerprint ? 'same' : ['alpha', 'beta', 'gamma'][n]}`
    : `fixture ${kind} failure ${w.sameFingerprint ? 'same' : ['alpha', 'beta', 'gamma'][n]}`;

/**
 * Расход попытки $5 (бюджет поручения $3), как его сохраняет отвергающий
 * candidate review: публичный measuredInvoke с локальным детерминированным
 * адаптером (без провайдера/модели), привязка к попытке и стадии.
 */
const overspend = (ctx: Ctx, h: H, runId: string) =>
  measuredInvoke(
    h.engine,
    {
      runtime: 'codex',
      capabilities: () =>
        Promise.resolve({
          runtime: 'codex',
          structuredOutput: true,
          sandbox: ['none'],
          cancellation: true,
          usage: true,
          fixture: true,
        }),
      invoke: () =>
        Promise.resolve({
          status: 'ok',
          model: 'fixture',
          runtimeVersion: 'fixture',
          text: '',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reportedUsd: 5,
            complete: true,
            source: 'fixture',
          },
          diagnostics: { exitCode: 0 },
        }),
    },
    {
      callId: 'fixture-cost-' + runId,
      task: 'review-code',
      binding: { runtime: 'codex' },
      cwd: ctx.repo.dir,
      prompt: 'fixture',
      session: { kind: 'fresh' },
      sandbox: { mode: 'none', writable: [], denied: [], network: { domains: [] } },
      timeoutMs: 60000,
      env: {},
    },
    new AbortController().signal,
    { repositoryId: ctx.policy.repositories[0]!.id, runId, stage: 'candidate-review' },
  );

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
  // Шаг 1 — настоящий прогон: принятые работы и попытки, отказанные бюджетом.
  const live: WorkSpec[] = spec.works.filter((w) => w.target === 'done' || w.target === 'budget');
  const others = spec.works.filter((w) => !live.includes(w)).map((w) => w.id);
  if (live.length) {
    if (others.length) h.engine.hold(others, 'setup', 'differential setup');
    h.engine.release('controller');
    return { job, pending: true as const, others };
  }
  return { job, pending: false as const, others };
}

/** Естественный эпизод свойства: два отказа ревью по связанному свойству, затем решение. */
async function propertyEpisode(
  ctx: Ctx,
  h: H,
  spec: CaseSpec,
  w: Extract<WorkSpec, { target: 'property' }>,
) {
  const boundFail = async (n: number) => {
    const a = claimOf(h, w.id);
    const spent = n === 1 && w.overspend;
    h.engine.phase(a.id, a.token, spent ? 'reviewing' : 'verifying', {
      candidateSha: ctx.repo.git('rev-parse', 'HEAD'),
    });
    if (spent) await overspend(ctx, h, a.id);
    h.engine.fail(a.id, a.token, 'property failure ' + n, {
      kind: 'review',
      properties: { bound: ['knapsack-optimal'], unbound: [] },
    });
  };
  const read = () => h.engine.read((v) => v.work(w.id)!);
  await boundFail(0);
  h.engine.retry(w.id);
  await boundFail(1);
  const opened = read().recovery;
  assert.equal(opened?.status, 'awaiting-lead', 'setup: natural episode ' + w.id);
  const rid = opened.id;
  const free = () => read().attempt < spec.maxAttempts;
  switch (w.then) {
    case 'awaiting-lead':
      break;
    case 'retry-failed':
    case 'retry-ready':
      decideNewApproach(h, w.id, now(h), rid);
      if (w.then === 'retry-ready' && free()) h.engine.retry(w.id);
      break;
    case 'applying':
      decideAddCases(h, w.id, rid);
      assert.equal(read().recovery?.status, 'applying', 'setup: applying ' + w.id);
      break;
    case 'retrying-failed':
    case 'retrying-ready': {
      decideNewApproach(h, w.id, now(h), rid);
      h.engine.retry(w.id);
      const a = claimOf(h, w.id);
      // Отказ, не связанный со свойством: эпизод остаётся retrying.
      h.engine.fail(a.id, a.token, 'gate failed unrelated to property', { kind: 'gate' });
      assert.equal(read().recovery?.status, 'retrying', 'setup: retrying ' + w.id);
      if (w.then === 'retrying-ready' && free()) h.engine.retry(w.id);
      break;
    }
  }
}

async function constructRest(spec: CaseSpec, ctx: Ctx, h: H, others: string[], pending: boolean) {
  if (pending) {
    // Шаг за шагом: зависимая принятая работа выдаётся после своей предпосылки.
    const settled = () =>
      spec.works.every((w) => {
        const s = h.engine.read((v) => v.work(w.id)!.status);
        return w.target === 'done' ? s === 'done' : w.target === 'budget' ? s === 'failed' : true;
      });
    for (let i = 0; i < 4 && !settled(); i++)
      await h.run({ graph: ctx.graph, author: 'claude', once: true });
    for (const w of spec.works) {
      if (w.target === 'done')
        assert.equal(
          h.engine.read((v) => v.work(w.id)!.status),
          'done',
          'setup: done ' + w.id,
        );
      if (w.target === 'budget') {
        const s = h.engine.read((v) => v.work(w.id)!);
        assert.equal(s.status, 'failed', 'setup: budget ' + w.id);
        assert.equal(s.failureKind, 'budget', 'setup: budget kind ' + w.id);
        h.engine.retry(w.id);
      }
    }
    if (others.length) h.engine.releaseHold('setup');
    assert.ok(h.engine.lead('controller'), 'setup: lead');
  }
  const failed = spec.works.filter((w): w is Failed => w.target === 'failed');
  const idle: WorkSpec[] = spec.works.filter(
    (w) => w.target === 'ready' || w.target === 'cancelled' || w.target === 'budget',
  );
  // Не участвующие в попытках — удержаны, чтобы claim выдавал по порядку только нужные.
  const holdIdle = () =>
    idle.length &&
    h.engine.hold(
      idle.map((w) => w.id),
      'setup',
      'differential setup',
    );
  holdIdle();
  // 1a) Естественный эпизод свойства (первая работа), остальные сломанные удержаны.
  for (const w of spec.works) {
    if (w.target !== 'property') continue;
    if (failed.length)
      h.engine.hold(
        failed.map((x) => x.id),
        'setup3',
        'differential setup',
      );
    await propertyEpisode(ctx, h, spec, w);
    if (failed.length) h.engine.releaseHold('setup3');
  }
  const properties = spec.works.filter((w) => w.target === 'property').map((w) => w.id);
  // 2) Предварительные попытки (вторая попытка или эпизод retrying).
  for (const w of failed) {
    const pre = w.attempts - 1;
    const others2 = [...properties, ...failed.filter((x) => x.id !== w.id).map((x) => x.id)];
    for (let i = 0; i < pre; i++) {
      if (others2.length) h.engine.hold(others2, 'setup2', 'differential setup');
      const a = claimOf(h, w.id);
      h.engine.fail(a.id, a.token, message(w, i, w.kind), { kind: w.kind });
      h.engine.retry(w.id);
      if (others2.length) h.engine.releaseHold('setup2');
    }
    if (w.episode?.status === 'retrying') {
      if (others2.length) h.engine.hold(others2, 'setup2', 'differential setup');
      const a = claimOf(h, w.id);
      h.engine.fail(a.id, a.token, message(w, 2, 'review'), { kind: 'review' });
      decideNewApproach(h, w.id, injectEpisode(h, w.id, 'awaiting-lead', 0));
      h.engine.retry(w.id);
      if (others2.length) h.engine.releaseHold('setup2');
    }
  }
  // 3) Последние попытки: все выдаются, пока очередь не на паузе, затем отказы по порядку.
  if (properties.length) h.engine.hold(properties, 'setup3', 'differential setup');
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
    if (w.overspend) await overspend(ctx, h, a.id);
    h.engine.fail(a.id, a.token, message(w, w.attempts - 1, kind), { kind });
  }
  // Удержание бюджетом закрепляется выдачей: claim пересчитывает budgetBlock готовых.
  if (spec.works.some((w) => w.target === 'budget')) {
    const rest = spec.works
      .filter((w) => !idle.includes(w) && w.target !== 'done' && !properties.includes(w.id))
      .map((w) => w.id);
    if (rest.length) h.engine.hold(rest, 'setup4', 'differential setup');
    assert.equal(h.engine.claim('controller'), undefined, 'setup: budget claim');
    if (rest.length) h.engine.releaseHold('setup4');
  }
  if (properties.length) h.engine.releaseHold('setup3');
  if (idle.length) h.engine.releaseHold('setup');
  // 4) Эпизоды и решения человека над итоговым состоянием.
  for (const w of failed) {
    const e = w.episode;
    if (!e) continue;
    const free = () => h.engine.read((v) => v.work(w.id)!.attempt) < spec.maxAttempts;
    if (e.status === 'retrying') {
      // retrying с готовой работой: engine.retry без активной попытки.
      if (e.ready && free()) h.engine.retry(w.id);
    } else if (e.status === 'awaiting-lead') injectEpisode(h, w.id, 'awaiting-lead', e.calls);
    else if (e.status === 'retry') {
      decideNewApproach(h, w.id, injectEpisode(h, w.id, 'awaiting-lead', 0));
      // Готовым эпизод бывает только со свободной попыткой (иначе retry требует сброса).
      if (e.work === 'ready' && free()) h.engine.retry(w.id);
    } else {
      injectEpisode(h, w.id, e.status, 1);
      if (e.ready && free()) h.engine.retry(w.id);
    }
  }
  // Отмена: и без попыток, и после открытия эпизода (recovery сохраняется).
  for (const w of spec.works)
    if (w.target === 'cancelled' || ('cancel' in w && w.cancel))
      h.engine.cancel(w.id, 'differential cancel');
  const held = spec.works.filter((w) => 'hold' in w && w.hold).map((w) => w.id);
  if (held.length) h.engine.hold(held, 'probe-op', 'operation in progress');
  if (spec.operatorPause) h.engine.pause('operator');
  h.engine.release('controller');
}

/**
 * Смена политики над построенным state (как H1-F022/H1-F020): закрыть,
 * открыть тот же каталог под законно изменённой политикой, заново одобрить
 * граф и начать текущее задание (стадия 0 завершена), освободить controller.
 */
function changedPolicy(spec: CaseSpec, ctx: Ctx) {
  const change = spec.policyChange!;
  const raw = structuredClone(ctx.policy);
  if ('maxAttempts' in change) raw.maxAttempts = change.maxAttempts;
  else if (change.budgets === 'disabled') delete raw.budgets;
  else raw.budgets!.work = { usd: 100 };
  return executionPolicySchema.parse(raw);
}

function reapprove(ctx: Ctx, h: H, previous: string) {
  const graph = ready(h.engine, ctx.graph, 'controller');
  const job = h.workflows.start({ kind: 'graph', id: graph.id, authorRuntime: 'claude' });
  // Бюджеты не входят в executionDigest: прежнее задание остаётся текущим (H1-F020).
  if (job.key !== previous) {
    assert.equal(job.stage, 0, 'setup: policy change gives a fresh current job');
    h.workflows.finish(h.workflows.claim(job.key)!);
  }
  h.engine.release('controller');
  return job.key;
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
      `a${w.attempt}/${effectiveMax(spec)}`,
      w.recovery ? `ep:${w.recovery.status}` : 'noep',
      w.hold ? 'hold' : '',
      w.budgetBlock ? 'budgetBlock' : '',
      c.paused ? `paused:${c.pauseReason ?? '?'}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  });
}

async function runCase(seed: number): Promise<CaseResult> {
  const spec = generate(seed);
  const state = describe(spec);
  const built = build(spec);
  const { ctx, open, obs, inc } = built;
  let h = built.h;
  let policy = ctx.policy;
  let jobKey: string | undefined;
  const notes: string[] = [];
  try {
    try {
      const { job, pending, others } = construct(spec, ctx, h);
      jobKey = job.key;
      await constructRest(spec, ctx, h, others, pending);
      if (spec.policyChange) {
        policy = changedPolicy(spec, ctx);
        h.close();
        h = open(policy);
        jobKey = reapprove(ctx, h, jobKey);
      }
    } catch (error) {
      return {
        seed,
        category: 'setup-error',
        mismatches: [],
        notes: [`${seed}: setup ${(error as Error).message} | ${state}`],
      };
    }
    const diags: Diag[] = stopInputsOf(h, {
      maxAttempts: policy.maxAttempts,
      repairBudget: policy.repairBudget,
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
    // Исполнение add-cases (applying): движок сам подтверждает случаи эталоном —
    // автоматическое действие над X, как и резервирование разбора.
    const origApplied = engine.recoveryApplied!.bind(h.engine);
    engine.recoveryApplied = (...args: unknown[]) => {
      const r = origApplied(...args) as { recovery?: { status: string } };
      const id = args[0] as string;
      const status = h.engine.read((v) => v.work(id)?.recovery?.status ?? '-');
      obs.applied.set(id, [...(obs.applied.get(id) ?? []), status]);
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
    // Прогон оборван защитой (известные зацикливания FI-001/FI-002). До обрыва
    // движок прошёл MAX_CLAIMS стадий: всё, что он сделал бы сам, уже сделано.
    // Поэтому R1–R3 сравниваются и здесь (правило с пометкой «in engine-loop»):
    // диагноз в таких состояниях обязан называть шаг человека, а не обещать
    // продолжение, которого цикл не даёт (H1-F015/F017). R4 — нет: задание не
    // завершилось.
    const loop = runError === 'DIFF_ENGINE_LOOP';
    if (loop) {
      runError = undefined;
      notes.push(
        `${seed}: engine-loop | ${state} | diag ${diags.map((d) => `${d.workId}=${d.actor}:${d.action}`).join(' ')} | before loop: ${diags
          .map(
            (d) =>
              `${d.workId} retry×${obs.retried.get(d.workId) ?? 0} lead×${obs.lead.get(d.workId) ?? 0} writer×${obs.writer.get(d.workId) ?? 0}`,
          )
          .join(', ')}`,
      );
    }
    // Текущее задание графа (после смены политики прежнее остаётся в списке).
    const job = h.workflows.list().find((j) => j.key === jobKey)!;
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
        obs.applied.get(id) ? `applied→${obs.applied.get(id)!.join('/')}` : '',
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
      // Резерв разбора — действие, только если ведущий реально вызван: резерв,
      // за которым вызов ведущего отказал по бюджету поручения, — механизм
      // FI-003 (единица списана без разбора), а не автоматический прогресс.
      const analyzed =
        (obs.reserved.get(id) ?? []).includes('analyzing') && (obs.lead.get(id) ?? 0) > 0;
      // Только исполнение, после которого движок продолжает (эпизод → retry).
      // applied→stopped (случаи подтверждены, попытки исчерпаны) — детерминированная
      // остановка движка: шаг человека (reset-attempts) остаётся, R2 не про неё.
      const applied = (obs.applied.get(id) ?? []).some((s) => s !== 'stopped');
      const refusedReserve = (obs.reserved.get(id) ?? []).some((s) => s !== 'analyzing');
      const executed = (obs.writer.get(id) ?? 0) > 0;
      // В оборванном цикле engine.retry, за которым не последовало ни выдачи, ни
      // разбора, — это сам механизм FI-001 (afterDecision повторяет под паузой
      // runtime и «ждёт»): работа стала ready, но движок её не выдаёт, пока
      // человек не снимет причину паузы. Диагноз «fix-environment/fix-access»
      // при этом верен, поэтому такой retry действием над X не считается (иначе
      // R2 — ложное срабатывание оракула). Вне цикла правило прежнее.
      const automatic = (loop ? false : retried) || analyzed || applied || executed;
      const human = d.actor === 'user' || d.actor === 'lead';
      const controller = d.actor === 'controller';
      const add = (rule: string) =>
        mismatches.push({
          seed,
          rule: loop ? rule + ' (in engine-loop)' : rule,
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
        !loop &&
        controller &&
        !disturbed.length &&
        job.status === 'failed' &&
        jobError.startsWith(id + ':') &&
        !automatic
      )
        add('R4 job-stopped-on-promised-work');
    }
    void controlBefore;
    if (process.env.DIFF_VERBOSE)
      notes.push(
        `${seed}: ${state}\n` +
          diags
            .map(
              (d) =>
                `      ${d.workId} [${shapes.get(d.workId)}] diag ${d.actor}:${d.action}${d.retryPlanned ? ' (retryPlanned)' : ''} [${d.code}] | engine ${engineOf(d.workId)}`,
            )
            .join('\n'),
      );
    const failing = mismatches.some((m) => !m.rule.startsWith('R3h'));
    return {
      seed,
      category: failing
        ? 'mismatch'
        : loop
          ? diags.some((d) => d.actor === 'controller')
            ? 'engine-loop/diag-controller'
            : 'engine-loop/diag-human'
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
    // Категории по шаблонам генератора (template → category → count).
    const byTemplate: Record<string, Record<string, number>> = {};
    for (const r of results) {
      const c = generate(r.seed);
      const t = (byTemplate[c.template + (c.policyChange ? '+policy' : '')] ??= {});
      t[r.category] = (t[r.category] ?? 0) + 1;
    }
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
      ...Object.entries(byTemplate).map(([t, c]) => `  ${t}: ${JSON.stringify(c)}`),
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
