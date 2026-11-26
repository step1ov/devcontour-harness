// Тонкий режим (alpha.73): шов между прогоном попытки и потоком сдачи.
//
// Поток тонкого режима живёт в `src/thin/` и не протаскивает флаги через
// runner.ts: он получает возможности прогона (вызов runtime, gate, ревью,
// окружение, CAS продвижения) готовыми привязанными функциями. Типы — те же,
// что у методов прогона, поэтому шов не расходится с ними.

import type {
  AttemptState,
  ContextSnapshot,
  ExecutionPolicy,
  WorkState,
} from '../contracts/index.ts';
import type { Engine } from '../engine/engine.ts';
import type { Runner } from '../engine/runner.ts';

type Repo = ExecutionPolicy['repositories'][number];

/** Возможности прогона для потока сдачи — привязанные методы `Runner`. */
export interface ThinKit {
  engine: Engine;
  policy: ExecutionPolicy;
  /** Вызов runtime: writer — с сессией `fresh`/`continue`/`fork`, ответ несёт `sessionId`. */
  call: Runner['call'];
  gate: Runner['gate'];
  review: Runner['review'];
  environment: Runner['environment'];
  dependencyStore: Runner['dependencyStore'];
  prepareSteps: Runner['prepareSteps'];
  timed: Runner['timed'];
  consumers: Runner['consumers'];
  requirements: Runner['requirements'];
  notes: Runner['notes'];
  history: Runner['history'];
  adapter: Runner['adapter'];
  /** Каталог checkout репозитория: `kind` — `worktrees`, `sessions` и т.п. */
  checkout: Runner['checkout'];
  /** CAS продвижения target и приёмка одной транзакцией. */
  promote: Runner['promote'];
  hostNotes: Runner['hostNotes'];
  reviewProtocol: Runner['reviewProtocol'];
  assertScope: Runner['assertScope'];
  decideInput: Runner['decideInput'];
  applicableGates: Runner['applicableGates'];
  prepareSelfCheck: Runner['prepareSelfCheck'];
  writerDependencies: Runner['writerDependencies'];
  generate: Runner['generate'];
  verifyGenerated: Runner['verifyGenerated'];
  /** Интеграция репозитория по одной (`mergeTails`, как в облегчённом режиме). */
  serialize: <T>(attempt: AttemptState, fn: () => Promise<T>) => Promise<T>;
  /** Убрать дерево, ветку и сессии работы. */
  discard: (repositoryId: string, workId: string) => Promise<void>;
  /** Заметки о предложениях исполнителей (отклонённое разделение). */
  proposalNotes: (work: WorkState) => string[];
  /** Имена тестовых секретов попытки (`attemptEnv.secrets`). */
  secretNames: (attempt: AttemptState) => string[];
  /** Хук хоста `implemented` (договор хоста): кандидат записан. */
  implemented: (
    event: Parameters<NonNullable<NonNullable<Runner['options']['hooks']>['implemented']>>[0],
  ) => unknown;
}

/** Сдача работы: попытка после общей подготовки прогона (порты, контекст, зависимости, база). */
export interface ThinHandover {
  attempt: AttemptState;
  work: WorkState;
  repo: Repo;
  repoPath: string;
  base: string;
  artifacts: string;
  /** Рабочие деревья, которые прогон уберёт после попытки (общий список `execute`). */
  worktrees: string[];
  signal: AbortSignal;
  context?: ContextSnapshot;
  /** Новый предел фазы. */
  rearm: () => void;
}
