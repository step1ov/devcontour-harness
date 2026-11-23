// План выпуска ведущего (0.1.0-alpha.68): `harness lead outline --file F`.
// До первого графа ведущий записывает этапы выпуска × компоненты с грубым
// размером (S/M/L или число задач) и тем, кто их делает (исполнители,
// окружение, владелец). Прогноз считает незарегистрированные части плана
// объёмом выпуска. Повторная запись — новая редакция с причиной
// («план вырос: +…»), строкой в журнале ведущего. План — подсказка, а не
// условие: `run` без него не блокируется.

import {
  HarnessError,
  OUTLINE_LIMITS,
  WORKSPACE_OWNER,
  outlineUnits,
  releaseOutlineInputSchema,
  type OutlineData,
  type OutlineStage,
  type ReleaseOutline,
  type ReleaseOutlineChange,
} from '../contracts/index.ts';
import type { Engine } from '../engine/engine.ts';
import { ruCount } from '../contracts/plural.ts';
import { cleanLeadText, recordLeadCommand } from './lead.ts';

const iso = (ms: number) => new Date(ms).toISOString();

/** Объём плана в задачах. */
export const outlineVolume = (stages: readonly OutlineStage[]) =>
  stages.reduce((n, s) => n + s.components.reduce((m, c) => m + outlineUnits(c), 0), 0);

const tasksRu = (n: number) => ruCount(n, ['задача', 'задачи', 'задач']);
const stagesRu = (n: number) => ruCount(n, ['этап', 'этапа', 'этапов']);
const componentsRu = (n: number) => ruCount(n, ['компонент', 'компонента', 'компонентов']);

/** Канонический вид плана для сравнения редакций (без причины). */
const canonicalStages = (stages: readonly OutlineStage[]) => JSON.stringify(stages);

/** Файл плана: JSON по `releaseOutlineInputSchema`; заголовки и причина очищаются. */
export function parseOutlineInput(raw: unknown): { stages: OutlineStage[]; reason?: string } {
  const parsed = releaseOutlineInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new HarnessError(
      'INVALID_INPUT',
      'План выпуска не по договору: {stages:[{id, title, kind, components:[{id, title, size|tasks, actor}]}], reason?}',
      parsed.error.issues.map((i) => ({
        path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
        message: i.message,
      })),
    );
  const stages = parsed.data.stages.map((s) => ({
    ...s,
    title: cleanLeadText(s.title, OUTLINE_LIMITS.title, `stage ${s.id} title`),
    components: s.components.map((c) => ({
      ...c,
      title: cleanLeadText(c.title, OUTLINE_LIMITS.title, `component ${c.id} title`),
    })),
  }));
  return {
    stages,
    ...(parsed.data.reason
      ? { reason: cleanLeadText(parsed.data.reason, OUTLINE_LIMITS.reason, 'reason') }
      : {}),
  };
}

/** Что изменилось между редакциями: добавленные и выросшие, убранные и уменьшенные компоненты. */
function diffOf(prev: readonly OutlineStage[], next: readonly OutlineStage[]) {
  const units = (stages: readonly OutlineStage[]) =>
    new Map(stages.flatMap((s) => s.components.map((c) => [c.id, c] as const)));
  const a = units(prev);
  const b = units(next);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [id, c] of b) {
    const old = a.get(id);
    if (!old) added.push(c.title);
    else if (outlineUnits(c) > outlineUnits(old))
      added.push(`${c.title} (${outlineUnits(old)} → ${outlineUnits(c)})`);
    else if (outlineUnits(c) < outlineUnits(old))
      removed.push(`${c.title} (${outlineUnits(old)} → ${outlineUnits(c)})`);
  }
  for (const [id, c] of a) if (!b.has(id)) removed.push(c.title);
  const cut = (xs: string[]) =>
    xs.slice(0, OUTLINE_LIMITS.changeItems).map((x) => x.slice(0, OUTLINE_LIMITS.title));
  return { added: cut(added), removed: cut(removed) };
}

/** Причина изменения по умолчанию: «план вырос: +A, +B (было ~N задач → стало ~M)». */
function defaultReason(before: number, after: number, added: string[], removed: string[]) {
  const items = [...added.map((x) => `+${x}`), ...removed.map((x) => `−${x}`)].join(', ');
  const head = after > before ? 'план вырос' : after < before ? 'план уменьшился' : 'план уточнён';
  return `${head}${items ? `: ${items}` : ''} (было ~${tasksRu(before)} → стало ~${tasksRu(after)})`.slice(
    0,
    OUTLINE_LIMITS.reason,
  );
}

/**
 * `lead outline`: записать (или обновить) план выпуска. Та же редакция — без
 * изменений (`changed: false`); иначе новая редакция с причиной (из файла,
 * `--reason` или «план вырос: +…»), строка в журнале ведущего.
 */
export function leadOutline(
  engine: Engine,
  input: unknown,
  options: { reason?: string } = {},
): OutlineData {
  const parsed = parseOutlineInput(input);
  const reason = options.reason
    ? cleanLeadText(options.reason, OUTLINE_LIMITS.reason, 'lead outline --reason')
    : parsed.reason;
  const units = outlineVolume(parsed.stages);
  const components = parsed.stages.reduce((n, s) => n + s.components.length, 0);
  const data = engine.recordReleaseOutline<OutlineData>((prev, now) => {
    if (prev && canonicalStages(prev.stages) === canonicalStages(parsed.stages))
      return {
        result: {
          outline: prev,
          changed: false,
          line: `План выпуска не изменился (редакция ${prev.revision}).`,
        } satisfies OutlineData,
      };
    if (!prev) {
      const outline: ReleaseOutline = {
        revision: 1,
        recordedAt: iso(now),
        firstRecordedAt: iso(now),
        stages: parsed.stages,
        ...(reason ? { reason } : {}),
        units,
        changes: [],
      };
      return {
        outline,
        result: {
          outline,
          changed: true,
          line: `План выпуска записан: ${stagesRu(parsed.stages.length)}, ${componentsRu(components)}, ~${tasksRu(units)}. Прогноз считает незарегистрированные части по плану.`,
        } satisfies OutlineData,
      };
    }
    const { added, removed } = diffOf(prev.stages, parsed.stages);
    const change: ReleaseOutlineChange = {
      at: iso(now),
      revision: prev.revision + 1,
      before: prev.units,
      after: units,
      added,
      removed,
      reason: reason ?? defaultReason(prev.units, units, added, removed),
    };
    const outline: ReleaseOutline = {
      revision: change.revision,
      recordedAt: change.at,
      firstRecordedAt: prev.firstRecordedAt,
      stages: parsed.stages,
      ...(reason ? { reason } : {}),
      units,
      changes: [...prev.changes, change].slice(-OUTLINE_LIMITS.changes),
    };
    return {
      outline,
      result: {
        outline,
        changed: true,
        change,
        line: `План выпуска обновлён (редакция ${change.revision}): ${change.reason}.`.slice(
          0,
          500,
        ),
      } satisfies OutlineData,
    };
  });
  if (data.changed) {
    const change = data.change;
    const plain = change
      ? `ведущий обновил план выпуска: ${change.reason}`
      : `ведущий записал план выпуска: ${stagesRu(parsed.stages.length)}, ~${tasksRu(units)}`;
    const plainEn = change
      ? `the lead updated the release outline: ~${change.before} → ~${change.after} task(s)${change.added.length ? `, added ${change.added.join(', ')}` : ''}`
      : `the lead recorded the release outline: ${parsed.stages.length} stage(s), ~${units} task(s)`;
    try {
      recordLeadCommand(
        engine,
        {
          kind: 'command',
          action: 'lead.outline',
          plain: cleanLeadText(plain, 200, 'journal'),
          plainEn: cleanLeadText(plainEn, 200, 'journal'),
        },
        'lead',
      );
    } catch (error) {
      process.stderr.write(
        `harness: журнал ведущего не записан: ${(error as Error)?.message ?? String(error)}\n`,
      );
    }
  }
  return data;
}

/** План выпуска состояния; нет — `undefined`. */
export function releaseOutlineOf(engine: Engine): ReleaseOutline | undefined {
  return engine.read((v) => v.local('release-outline', WORKSPACE_OWNER, 'outline'));
}
