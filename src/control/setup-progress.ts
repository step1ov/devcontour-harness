// Ход настройки harness (alpha.67, P5-1): шаги профиль → init → doctor →
// smoke → проба исполнителя → gates на HEAD → связка, с состоянием и временем
// каждого, и мягкий бюджет настройки. Только чтение файлов, которые harness
// уже пишет: `.harness/` проекта, итоги `harness smoke` и `harness gates`
// (`<state>/gates-at/<id>/result.json`) и базы коннектора. Состояние
// исполнения не открывается; doctor своего итога не записывает (он только
// читает), поэтому его шаг — `unknown`.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SETUP_BUDGET_MS,
  type SetupProgress,
  type SetupStep,
  type SetupStepId,
} from '../contracts/index.ts';
import { ruCount } from '../contracts/plural.ts';

export { SETUP_BUDGET_MS };

/** Итог `harness smoke` рядом с его логами (`gates-at/<id>/result.json`, alpha.67). */
export const SMOKE_RESULT_FILE = 'result.json';
/** Итог `harness gates` (`GATES_RESULT_FILE` в `gates-check.ts`): то же имя. */
const GATES_RESULT_FILE = 'result.json';

/**
 * Самое раннее известное время файла: создания (birthtime, где ФС его
 * знает) или изменения; нет файла — undefined.
 */
function bornAt(path: string): number | undefined {
  try {
    const s = statSync(path);
    return s.birthtimeMs > 0 ? Math.min(s.birthtimeMs, s.mtimeMs) : s.mtimeMs;
  } catch {
    return undefined;
  }
}
function changedAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}
const obj = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

interface RunRecord {
  at: number;
  passed?: boolean;
  durationMs?: number;
  /** Smoke с пробой исполнителя и её исход (`writerProbe.ok`), если записан. */
  probe?: boolean;
  probeOk?: boolean;
}

/**
 * Записи `gates-at` вида `prefix` (`LS-` smoke, `GA-` gates): у каждой —
 * время итога (или каталога), исход и длительность, если итог записан.
 * Каталоги проходов пробы (`LS-…-loopback-1`) — не отдельные записи.
 */
function runRecords(stateDir: string, prefix: 'LS-' | 'GA-'): RunRecord[] {
  const root = join(stateDir, 'gates-at');
  let names: string[];
  try {
    names = readdirSync(root).filter((n) =>
      new RegExp(`^${prefix}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).test(n),
    );
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const name of names.slice(-500)) {
    const file = join(root, name, prefix === 'LS-' ? SMOKE_RESULT_FILE : GATES_RESULT_FILE);
    const result = obj(readJson(file));
    const data = obj(result?.data) ?? result;
    const at =
      (typeof result?.at === 'string' ? Date.parse(result.at) : NaN) ||
      changedAt(file) ||
      changedAt(join(root, name));
    if (!at || Number.isNaN(at)) continue;
    out.push({
      at,
      ...(typeof data?.passed === 'boolean' ? { passed: data.passed } : {}),
      ...(typeof data?.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
      ...(prefix === 'LS-'
        ? {
            probe:
              obj(data?.writerProbe) !== undefined || existsSync(join(root, name, 'writer-probe')),
          }
        : {}),
      ...(prefix === 'LS-' && obj(data?.writerProbe)
        ? { probeOk: obj(data?.writerProbe)!.ok === true }
        : {}),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

const words = {
  ru: {
    profile: 'профиль стека',
    init: 'harness init',
    doctor: 'doctor',
    smoke: 'smoke окружения',
    probe: 'проба исполнителя',
    gates: 'gates на HEAD',
    connector: 'связка с источником задач',
  },
  en: {
    profile: 'stack profile',
    init: 'harness init',
    doctor: 'doctor',
    smoke: 'environment smoke',
    probe: 'writer probe',
    gates: 'gates on HEAD',
    connector: 'task source connector',
  },
} as const;
const stateWord = {
  ru: {
    done: 'готово',
    failed: 'не прошло',
    pending: 'ещё нет',
    skipped: 'не нужно',
    unknown: 'итог не записывается',
  },
  en: {
    done: 'done',
    failed: 'failed',
    pending: 'not yet',
    skipped: 'not needed',
    unknown: 'outcome not recorded',
  },
} as const;
const iso = (ms: number) => new Date(ms).toISOString();
/** «42 мин», «1 ч 5 мин», «40 с». */
export function durationText(ms: number, lang: 'ru' | 'en' = 'ru'): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return lang === 'en' ? `${s} s` : `${s} с`;
  const m = Math.round(s / 60);
  if (m < 60) return lang === 'en' ? `${m} min` : `${m} мин`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return lang === 'en' ? `${h} h${r ? ` ${r} min` : ''}` : `${h} ч${r ? ` ${r} мин` : ''}`;
}

export interface SetupProgressInput {
  /** Каталог `.harness` проекта (каталог политики). */
  harnessDir: string;
  /** Каталог состояния проекта; может ещё не существовать. */
  stateDir?: string;
  now: number;
  /** Мягкий бюджет настройки; нет — `SETUP_BUDGET_MS`. */
  budgetMs?: number;
}

/**
 * Ход настройки по записям на диске. Время настройки — от самой ранней
 * записи (файлы `.harness/`, первый smoke или gates) до `now`: настройка
 * кончается регистрацией первого графа (тогда этап — `work`, и вызывающий
 * ход настройки не показывает).
 */
export function setupProgress(input: SetupProgressInput): SetupProgress {
  const { harnessDir, now } = input;
  const budgetMs = input.budgetMs ?? SETUP_BUDGET_MS;
  const profileFile = join(harnessDir, 'profile.json');
  const projectFile = join(harnessDir, 'project.json');
  const policyFile = join(harnessDir, 'policy.json');
  const connectorFile = join(harnessDir, 'connector.json');
  const smokes = input.stateDir ? runRecords(input.stateDir, 'LS-') : [];
  const gates = input.stateDir ? runRecords(input.stateDir, 'GA-') : [];
  const steps: SetupStep[] = [];
  const step = (
    id: SetupStepId,
    state: SetupStep['state'],
    extra: { at?: number; elapsedMs?: number; note?: { ru: string; en: string } } = {},
  ) => {
    const tail = (lang: 'ru' | 'en') =>
      [
        stateWord[lang][state],
        extra.elapsedMs !== undefined ? durationText(extra.elapsedMs, lang) : '',
        extra.note?.[lang] ?? '',
      ]
        .filter(Boolean)
        .join(', ');
    steps.push({
      id,
      state,
      ...(extra.at !== undefined ? { at: iso(extra.at) } : {}),
      ...(extra.elapsedMs !== undefined ? { elapsedMs: Math.round(extra.elapsedMs) } : {}),
      line: `${words.ru[id]}: ${tail('ru')}`,
      lineEn: `${words.en[id]}: ${tail('en')}`,
    });
  };
  // Профиль: свой (`.harness/profile.json`) или встроенный, закреплённый manifest.
  const manifest = obj(readJson(projectFile));
  const pinned = obj(manifest?.profile)?.ref;
  if (existsSync(profileFile))
    step('profile', 'done', {
      at: changedAt(profileFile)!,
      note: { ru: 'свой профиль', en: 'local profile' },
    });
  else if (typeof pinned === 'string')
    step('profile', 'done', {
      at: bornAt(projectFile)!,
      note: { ru: `встроенный ${pinned}`, en: `built-in ${pinned}` },
    });
  else step('profile', 'pending');
  if (existsSync(projectFile) && existsSync(policyFile))
    step('init', 'done', { at: bornAt(policyFile)! });
  else step('init', 'pending');
  step('doctor', 'unknown');
  const smoke = smokes.at(-1);
  if (smoke)
    step('smoke', smoke.passed === undefined ? 'unknown' : smoke.passed ? 'done' : 'failed', {
      at: smoke.at,
      ...(smoke.durationMs !== undefined ? { elapsedMs: smoke.durationMs } : {}),
    });
  else step('smoke', 'pending');
  const probe = [...smokes].reverse().find((s) => s.probe);
  if (probe)
    step('probe', probe.probeOk === undefined ? 'unknown' : probe.probeOk ? 'done' : 'failed', {
      at: probe.at,
      ...(probe.durationMs !== undefined ? { elapsedMs: probe.durationMs } : {}),
    });
  else step('probe', 'pending');
  const gate = gates.at(-1);
  if (gate)
    step('gates', gate.passed === undefined ? 'unknown' : gate.passed ? 'done' : 'failed', {
      at: gate.at,
      ...(gate.durationMs !== undefined ? { elapsedMs: gate.durationMs } : {}),
    });
  else step('gates', 'pending');
  if (!existsSync(connectorFile))
    step('connector', 'skipped', { note: { ru: 'задачи — файлы графа', en: 'graph files' } });
  else {
    const dir = input.stateDir ? join(input.stateDir, 'connectors') : undefined;
    let snapshot: number | undefined;
    try {
      for (const f of dir ? readdirSync(dir) : [])
        if (f.endsWith('.sqlite'))
          snapshot = Math.max(snapshot ?? 0, changedAt(join(dir!, f)) ?? 0);
    } catch {
      /* связки ещё нет */
    }
    if (snapshot) step('connector', 'done', { at: snapshot });
    else step('connector', 'pending', { at: changedAt(connectorFile)! });
  }
  const starts = [
    bornAt(profileFile),
    bornAt(projectFile),
    bornAt(policyFile),
    smokes[0]?.at !== undefined ? smokes[0].at - (smokes[0].durationMs ?? 0) : undefined,
    gates[0]?.at !== undefined ? gates[0].at - (gates[0].durationMs ?? 0) : undefined,
  ].filter((t): t is number => t !== undefined && t > 0 && t <= now);
  const since = starts.length ? Math.min(...starts) : undefined;
  const elapsedMs = since !== undefined ? now - since : undefined;
  const overBudget = elapsedMs !== undefined && elapsedMs > budgetMs;
  const counted = steps.filter((s) => s.state !== 'skipped' && s.id !== 'doctor');
  const done = counted.filter((s) => s.state === 'done').length;
  const failed = steps.filter((s) => s.state === 'failed').map((s) => words.ru[s.id]);
  const failedEn = steps.filter((s) => s.state === 'failed').map((s) => words.en[s.id]);
  const time = (lang: 'ru' | 'en') =>
    elapsedMs === undefined
      ? ''
      : lang === 'en'
        ? ` · running ${durationText(elapsedMs, 'en')} (budget ${durationText(budgetMs, 'en')}${overBudget ? ' — exceeded' : ''})`
        : ` · идёт ${durationText(elapsedMs)} (бюджет ${durationText(budgetMs)}${overBudget ? ' — превышен' : ''})`;
  const line =
    `Настройка: готово ${done} из ${ruCount(counted.length, ['шага', 'шагов', 'шагов'])}` +
    time('ru') +
    (failed.length ? `; не прошло: ${failed.join(', ')}` : '') +
    (overBudget ? '; новый код инфраструктуры — работами infra в плане, а не в настройке' : '');
  const lineEn =
    `Setup: ${done} of ${counted.length} steps done` +
    time('en') +
    (failedEn.length ? `; failed: ${failedEn.join(', ')}` : '') +
    (overBudget
      ? '; new infrastructure code goes into the plan as infra works, not into setup'
      : '');
  return {
    ...(since !== undefined ? { since: iso(since) } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs: Math.round(elapsedMs) } : {}),
    budgetMs,
    overBudget,
    steps,
    line,
    lineEn,
  };
}
