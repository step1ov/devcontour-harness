// План выпуска в прогнозе (0.1.0-alpha.68): какие части плана ведущего уже
// зарегистрированы работами, а какие — ещё нет. Чистая функция без node:* и
// zod (браузерный бандл).
//
// Подбор работ к компонентам плана:
// 1. явная ссылка — работа (ID) или задача источника (ключ) названа в
//    `works` компонента или совпадает с его `id`;
// 2. остальные работы — по порядку появления в выпуске заполняют свободный
//    объём компонентов без явных ссылок: работа инфраструктуры (`kind:
//    infra`) — этапы `infra`, затем `deploy`; продуктовая — `product`,
//    `other`, затем `deploy`.
// Работа, которой места не нашлось, — сверх плана (рост плана). Свободный
// объём компонентов — незарегистрированная часть выпуска с весом 0.

import {
  OUTLINE_LIMITS,
  outlineUnits,
  type OutlineActor,
  type OutlineSize,
  type OutlineStageKind,
} from '../contracts/outline-weights.ts';

/** План выпуска из состояния (локальная запись `release-outline`). */
export interface OperatorOutlineInput {
  revision: number;
  recordedAt: string;
  firstRecordedAt: string;
  units: number;
  stages: readonly {
    id: string;
    title: string;
    kind: OutlineStageKind;
    components: readonly {
      id: string;
      title: string;
      size?: OutlineSize;
      tasks?: number;
      actor: OutlineActor;
      works?: readonly string[];
    }[];
  }[];
  changes: readonly {
    at: string;
    revision: number;
    before: number;
    after: number;
    added: readonly string[];
    removed: readonly string[];
    reason: string;
  }[];
}

/** Единица объёма прогноза для подбора: ID, ключ задачи, работа и её вес. */
export interface OutlineUnitInput {
  id: string;
  key?: string;
  workId?: string;
  infra: boolean;
  /** Появление в выпуске, epoch ms; неизвестно — раньше всех. */
  at: number;
  weight: number;
}

export type OutlineFillState = 'registered' | 'partial' | 'unregistered';

export interface OutlineComponentFit {
  id: string;
  title: string;
  size?: OutlineSize;
  tasks?: number;
  actor: OutlineActor;
  state: OutlineFillState;
  /** Объём компонента в задачах. */
  units: number;
  /** Сколько работ его реализуют. */
  registered: number;
  /** Готовность компонента: сумма весов его работ к объёму (не меньше числа работ), 0–100. */
  percent: number;
  /** Первые работы компонента (ID). */
  works?: string[];
}

export interface OutlineStageFit {
  id: string;
  title: string;
  kind: OutlineStageKind;
  state: OutlineFillState;
  units: number;
  registered: number;
  percent: number;
  components: OutlineComponentFit[];
}

export interface OutlineFit {
  stages: OutlineStageFit[];
  /** Незарегистрированный объём плана (задач). */
  unregistered: number;
  /** Из него — у исполнителей и окружения (входит во время), у владельца (не входит). */
  timedUnits: number;
  ownerUnits: number;
  /** Единицы объёма сверх плана (ID). */
  beyond: Set<string>;
}

const stateOf = (registered: number, units: number): OutlineFillState =>
  registered >= units ? 'registered' : registered > 0 ? 'partial' : 'unregistered';

/** Подобрать единицы объёма к плану выпуска. */
export function fitOutline(
  outline: OperatorOutlineInput,
  units: readonly OutlineUnitInput[],
): OutlineFit {
  type Slot = {
    stage: OperatorOutlineInput['stages'][number];
    component: OperatorOutlineInput['stages'][number]['components'][number];
    cap: number;
    filled: OutlineUnitInput[];
  };
  const slots: Slot[] = outline.stages.flatMap((stage) =>
    stage.components.map((component) => ({
      stage,
      component,
      cap: outlineUnits(component),
      filled: [],
    })),
  );
  const ordered = [...units].sort(
    (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const names = (u: OutlineUnitInput) =>
    [u.id, u.key, u.workId].filter((x): x is string => x !== undefined);
  const free: OutlineUnitInput[] = [];
  for (const u of ordered) {
    const own = names(u);
    const slot = slots.find(
      (s) => own.includes(s.component.id) || own.some((n) => s.component.works?.includes(n)),
    );
    if (slot) slot.filled.push(u);
    else free.push(u);
  }
  const beyond = new Set<string>();
  const order = (u: OutlineUnitInput): readonly OutlineStageKind[] =>
    u.infra ? ['infra', 'deploy'] : ['product', 'other', 'deploy'];
  for (const u of free) {
    let placed = false;
    for (const kind of order(u)) {
      const slot = slots.find(
        (s) => s.stage.kind === kind && !s.component.works && s.filled.length < s.cap,
      );
      if (slot) {
        slot.filled.push(u);
        placed = true;
        break;
      }
    }
    if (!placed) beyond.add(u.id);
  }
  let unregistered = 0;
  let timedUnits = 0;
  let ownerUnits = 0;
  const pct = (w: number, n: number) => Math.round((100 * w) / Math.max(1, n));
  const stages = outline.stages.map((stage): OutlineStageFit => {
    const own = slots.filter((s) => s.stage === stage);
    const components = own.map((s): OutlineComponentFit => {
      const left = Math.max(0, s.cap - s.filled.length);
      unregistered += left;
      if (s.component.actor === 'owner') ownerUnits += left;
      else timedUnits += left;
      const weight = s.filled.reduce((n, u) => n + u.weight, 0);
      const works = s.filled
        .flatMap((u) => (u.workId ? [u.workId] : []))
        .slice(0, OUTLINE_LIMITS.viewWorks);
      return {
        id: s.component.id,
        title: s.component.title,
        ...(s.component.size ? { size: s.component.size } : {}),
        ...(s.component.tasks !== undefined ? { tasks: s.component.tasks } : {}),
        actor: s.component.actor,
        state: stateOf(s.filled.length, s.cap),
        units: s.cap,
        registered: s.filled.length,
        percent: Math.min(100, pct(weight, Math.max(s.cap, s.filled.length))),
        ...(works.length ? { works } : {}),
      };
    });
    const cap = own.reduce((n, s) => n + s.cap, 0);
    const reg = own.reduce((n, s) => n + Math.min(s.cap, s.filled.length), 0);
    const weight = own.reduce((n, s) => n + s.filled.reduce((m, u) => m + u.weight, 0), 0);
    const filled = own.reduce((n, s) => n + Math.max(s.cap, s.filled.length), 0);
    return {
      id: stage.id,
      title: stage.title,
      kind: stage.kind,
      state: stateOf(reg, cap),
      units: cap,
      registered: own.reduce((n, s) => n + s.filled.length, 0),
      percent: Math.min(100, pct(weight, filled)),
      components,
    };
  });
  return { stages, unregistered, timedUnits, ownerUnits, beyond };
}
