import { gateTimeoutMs, type ExecutionPolicy, type GatePolicy } from '../contracts/index.ts';
import { gatePrerequisites, orderedScope } from './gate-scope.ts';
import { writerDependencyGates } from './gates.ts';

type Repo = ExecutionPolicy['repositories'][number];
type Step = { id: string; timeoutMs: number };

/**
 * Фаза попытки или проверки, которой отведён один срок `runTimeoutMs`
 * (controller заново взводит его на границе фаз):
 *
 * - `implementation` — окружение дерева исполнителя (lifecycle setup/ready),
 *   prepare, gates установки зависимостей исполнителя и сам исполнитель;
 * - `generation` — генераторы после исполнителя (режим записи);
 * - `verification` — gates кандидата и проверка генераторов;
 * - `integration` — окружение и prepare дерева слияния, его gates и проверка
 *   генераторов; той же суммой ограничена проверка на SHA вне попытки
 *   (`runGatesAt`, CLI `gates`);
 * - `joint` — совместная проверка: `workspaceLifecycle` и `workspaceGates`.
 */
export type BudgetPhase =
  'implementation' | 'generation' | 'verification' | 'integration' | 'joint';

/** Цепочка gates: ids в порядке исполнения и сумма их действующих пределов. */
export interface GateChain {
  gates: string[];
  ms: number;
}

/** Превышение срока фазы суммой объявленных пределов. */
export interface TimeBudgetWarning {
  path: (string | number)[];
  phase: BudgetPhase;
  repositoryId?: string;
  /** Сумма пределов фазы и срок фазы (`runTimeoutMs`), мс. */
  totalMs: number;
  limitMs: number;
  /** Слагаемые суммы, мс. */
  parts: { what: string; ms: number }[];
  /** Самая длинная цепочка gates фазы (gate с предпосылками), если в фазе есть gates. */
  longestChain?: GateChain;
  message: string;
}

const sum = (steps: readonly Step[]) => steps.reduce((t, s) => t + s.timeoutMs, 0);
const minutes = (ms: number) => {
  const m = Math.round(ms / 6000) / 10;
  return `${m} мин`;
};

/**
 * Цепочка gate вне области задачи: сам gate и его предпосылки
 * (`gatePrerequisites`: замыкание `dependsOn`, а у gate без поля — более
 * ранние check gates) в порядке исполнения (`orderedScope`), с действующими
 * пределами (`gateTimeoutMs`). Gates одной области исполняются по одному, и
 * сумма цепочки — наименьшее время, которое требует область из этого gate.
 */
export function gateChain(
  gates: readonly GatePolicy[],
  id: string,
  policy: Pick<ExecutionPolicy, 'gateTimeoutFloorMs'>,
): GateChain {
  const scope = orderedScope([...gates], [...gatePrerequisites([...gates], id), id]);
  return {
    gates: scope.map((g) => g.id),
    ms: scope.reduce((t, g) => t + gateTimeoutMs(g, policy), 0),
  };
}

/** Самая длинная цепочка gates репозитория (`gateChain` по каждому gate). */
export function longestGateChain(
  gates: readonly GatePolicy[],
  policy: Pick<ExecutionPolicy, 'gateTimeoutFloorMs'>,
): GateChain | undefined {
  let best: GateChain | undefined;
  for (const g of gates) {
    const chain = gateChain(gates, g.id, policy);
    if (!best || chain.ms > best.ms) best = chain;
  }
  return best;
}

/** Сумма пределов шагов одной фазы. */
export interface PhaseBudget {
  path: (string | number)[];
  phase: BudgetPhase;
  repositoryId?: string;
  /** Чем грозит превышение (для текста предупреждения). */
  risk: string;
  totalMs: number;
  /** Слагаемые суммы (ненулевые), мс. */
  parts: { what: string; ms: number }[];
  longestChain?: GateChain;
}

/**
 * Суммы объявленных пределов шагов, которые исполняются в одной фазе
 * последовательно (см. `BudgetPhase`): lifecycle setup/ready, prepare, gates,
 * генераторы, повтор gate.
 *
 * Полная область gates — все gates репозитория (область попытки по
 * умолчанию; условные `when` — тоже, худший случай); gates одной области
 * исполняются по одному, поэтому их пределы складываются (действующие, с
 * `gateTimeoutFloorMs`). Кандидат и интеграция допускают по одному повтору
 * непрошедшего gate (`recheck`): в сумму входит один раз самый долгий gate.
 * Самая длинная цепочка `dependsOn` — наименьшая область, которой нужен самый
 * дорогой gate. Не учтены: teardown (идёт в сроке ревью), хранилище
 * зависимостей (оно само ограничено долей остатка фазы), `dependencyBuild`
 * зависимостей (снимки переиспользуются), исполнитель и reviewer (их предел —
 * сам `runTimeoutMs`), gates потребителей на integration. Проверка на SHA вне
 * попытки (`runGatesAt`) исполняет окружение, prepare и gates без генераторов
 * и повторов: её сумма не больше суммы integration.
 */
export function phaseBudgets(policy: ExecutionPolicy): PhaseBudget[] {
  const out: PhaseBudget[] = [];
  const push = (
    phase: BudgetPhase,
    path: (string | number)[],
    parts: { what: string; ms: number }[],
    risk: string,
    repo?: Repo,
    chain?: GateChain,
  ) => {
    const present = parts.filter((p) => p.ms > 0);
    out.push({
      path,
      phase,
      ...(repo ? { repositoryId: repo.id } : {}),
      risk,
      totalMs: present.reduce((t, p) => t + p.ms, 0),
      parts: present,
      ...(chain ? { longestChain: chain } : {}),
    });
  };
  policy.repositories.forEach((repo, r) => {
    const path = ['repositories', r];
    const lifecycle = repo.lifecycle ?? policy.lifecycle;
    const environment = lifecycle ? sum(lifecycle.setup) + sum(lifecycle.ready) : 0;
    const prepare = sum(repo.prepare);
    const timeouts = repo.gates.map((g) => gateTimeoutMs(g, policy));
    const gates = timeouts.reduce((t, ms) => t + ms, 0);
    const recheck = Math.max(0, ...timeouts);
    const generators = sum(repo.generators ?? []);
    const installs =
      repo.writerDependencies === false
        ? 0
        : writerDependencyGates(repo.gates).reduce((t, g) => t + gateTimeoutMs(g, policy), 0);
    const chain = longestGateChain(repo.gates, policy);
    push(
      'implementation',
      path,
      [
        { what: 'lifecycle setup/ready', ms: environment },
        { what: 'prepare', ms: prepare },
        { what: 'установка зависимостей исполнителя', ms: installs },
      ],
      'исполнителю может не остаться времени',
      repo,
    );
    push(
      'generation',
      [...path, 'generators'],
      [{ what: 'генераторы', ms: generators }],
      'генерация может истечь до конца',
      repo,
    );
    const checks = [
      { what: 'gates', ms: gates },
      { what: 'повтор gate', ms: recheck },
      { what: 'генераторы', ms: generators },
    ];
    // Без окружения и prepare сумма интеграции та же: одна запись на обе фазы.
    push(
      'verification',
      [...path, 'gates'],
      checks,
      environment + prepare
        ? 'попытка может истечь до конца проверок'
        : 'попытка может истечь до конца проверок кандидата и интеграции',
      repo,
      chain,
    );
    if (environment + prepare)
      push(
        'integration',
        [...path, 'gates'],
        [
          { what: 'lifecycle setup/ready', ms: environment },
          { what: 'prepare', ms: prepare },
          ...checks,
        ],
        'интеграция может истечь до конца проверок',
        repo,
        chain,
      );
  });
  const joint = policy.workspaceLifecycle;
  push(
    'joint',
    ['workspaceGates'],
    [
      {
        what: 'workspaceLifecycle setup/ready',
        ms: joint ? sum(joint.setup) + sum(joint.ready) : 0,
      },
      {
        what: 'gates',
        ms: policy.workspaceGates.reduce((t, g) => t + gateTimeoutMs(g, policy), 0),
      },
    ],
    'совместная проверка может истечь до конца проверок',
  );
  return out;
}

/**
 * Предупреждения о сроке фаз: сумма пределов фазы (`phaseBudgets`) больше
 * `runTimeoutMs` — попытка может истечь до конца проверок, хотя каждый шаг
 * укладывается в свой предел. Это предупреждение, не ошибка: пределы —
 * худший случай, обычно шаги быстрее. Если укладывается самая длинная
 * цепочка `dependsOn`, можно сузить области задач; иначе нужен больший
 * `runTimeoutMs` или меньшие пределы.
 */
export function timeBudgetWarnings(policy: ExecutionPolicy): TimeBudgetWarning[] {
  const limit = policy.runTimeoutMs;
  return phaseBudgets(policy)
    .filter((b) => b.totalMs > limit)
    .map(({ risk, ...b }) => {
      const where = b.repositoryId ? `${b.repositoryId}, фаза ${b.phase}` : `фаза ${b.phase}`;
      const chain = b.longestChain;
      const gates = b.parts.find((p) => p.what === 'gates')?.ms;
      let advice = '';
      if (chain?.gates.length && gates !== undefined)
        advice =
          chain.ms + (b.totalMs - gates) <= limit
            ? `; самая длинная цепочка gates (${chain.gates.join(' → ')}, ${minutes(chain.ms)}) укладывается — сузьте области задач, поднимите runTimeoutMs или уменьшите пределы`
            : `; даже самая длинная цепочка gates (${chain.gates.join(' → ')}, ${minutes(chain.ms)}) не укладывается — поднимите runTimeoutMs или уменьшите пределы`;
      const sum =
        b.parts.length === 1
          ? `предел ${b.parts[0]!.what} ${minutes(b.totalMs)}`
          : `сумма пределов ${b.parts.map((p) => `${p.what} ${minutes(p.ms)}`).join(' + ')} (${minutes(b.totalMs)})`;
      return {
        ...b,
        limitMs: limit,
        message: `${where}: ${sum} больше runTimeoutMs (${minutes(limit)}): ${risk}${advice}`,
      };
    });
}

/**
 * `runTimeoutMs`, при котором ни одна фаза политики не превышает срок:
 * наибольшая сумма фазы (`phaseBudgets`) с запасом `margin`, округлённая
 * вверх до 5 минут.
 */
export function requiredRunTimeoutMs(policy: ExecutionPolicy, margin = 1.25): number {
  const step = 5 * 60_000;
  const need = Math.max(0, ...phaseBudgets(policy).map((b) => b.totalMs)) * margin;
  return Math.max(step, Math.ceil(need / step) * step);
}
