// Выходы gates, которые исполнитель гонял сам (alpha.75, P11-5): JUnit-отчёт,
// `artifacts` gate и каталоги отчётов браузерного UI-раннера. Исполнитель
// тонкого и облегчённого режимов запускает gates в дереве работы, и их новые
// файлы (`test-results/admin.xml`, `.last-run.json`, `trace.zip`) попадали в
// кандидата — сдача отклонялась нарушением области. Harness убирает из
// индекса только НОВЫЕ файлы под объявленными путями выходов: изменение или
// удаление уже отслеживаемого файла остаётся правкой исполнителя и
// проверяется областью, как любая другая.
//
// Путь выхода убирается, только если это чистый каталог выходов: на базе под
// ним нет отслеживаемых файлов, он не пересекается с `ui.flows` и с
// `when.paths` gates (там исходники), а файл, который задевает `when.paths`,
// остаётся в кандидате. Каталог `.maestro/` проекта — исходники потоков
// Maestro (журналы прогонов он пишет в `~/.maestro`), поэтому умолчанием
// выхода он не служит.

import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { git, gitWithInput } from '../environment/process.ts';
import { DEFAULT_BROWSER_ARTIFACTS, whenPaths, type GatePolicy } from '../contracts/index.ts';
import { matchingPaths } from './applicability.ts';

/** Объявленные выходы gates и шаблоны исходников, которые их не убирают. */
export interface GateOutputs {
  /** Пути выходов от корня дерева, без повторов. */
  paths: string[];
  /** `when.paths` gates: файл, который они задевают, — исходник, а не выход. */
  sources: string[];
}

export const NO_GATE_OUTPUTS: GateOutputs = { paths: [], sources: [] };

const trim = (p: string) => p.replace(/\/+$/, '');
const within = (cwd: string | undefined, p: string) => trim(cwd ? posix.join(cwd, p) : p);
/** Один путь — тот же, предок или потомок другого (по целым сегментам). */
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

/**
 * Выходы gates политики. Умолчания UI — только браузерные каталоги отчётов
 * Playwright (`test-results/`, `playwright-report/`), от `cwd` gate. Путь,
 * пересекающийся с `ui.flows` или `when.paths` любого gate, выходом не
 * считается.
 */
export function gateOutputPaths(gates: readonly GatePolicy[]): GateOutputs {
  const flows = gates.flatMap((g) =>
    g.ui?.type === 'mobile' ? g.ui.flows.map((f) => within(g.cwd, f)) : [],
  );
  const sources = [...new Set(gates.flatMap((g) => whenPaths(g) ?? []))].sort();
  const declared = gates.flatMap((g) => [
    ...(g.report ? [g.report.path] : []),
    ...(g.artifacts ?? []),
    ...(g.ui?.artifacts ?? []),
    ...(g.ui?.type === 'browser' && !g.ui.artifacts?.length
      ? DEFAULT_BROWSER_ARTIFACTS.map((p) => within(g.cwd, p))
      : []),
  ]);
  const paths = [...new Set(declared.map(trim))]
    .filter(
      (p) =>
        p &&
        !flows.some((f) => overlaps(f, p)) &&
        !(sources.length && matchingPaths(sources, [p]).length),
    )
    .sort();
  return { paths, sources };
}

/**
 * Убрать из индекса `cwd` файлы, добавленные относительно `base` под чистыми
 * путями выходов (`outputs.paths`): путь с отслеживаемым на `base` файлом не
 * трогается, файл под `outputs.sources` остаётся. Файлы остаются в рабочем
 * дереве неотслеживаемыми. Возвращает убранные пути.
 */
export async function dropGateOutputs(
  cwd: string,
  outputs: GateOutputs,
  base = 'HEAD',
): Promise<string[]> {
  if (!outputs.paths.length) return [];
  const literal = (p: string) => `:(literal)${p}`;
  const tracked = (
    await git(cwd, 'ls-tree', '-r', '--name-only', '-z', base, '--', ...outputs.paths.map(literal))
  )
    .split('\0')
    .filter(Boolean);
  const pure = outputs.paths.filter((p) => !tracked.some((t) => overlaps(t, p)));
  if (!pure.length) return [];
  const candidates = (
    await git(
      cwd,
      'diff',
      '--cached',
      '--no-renames',
      '--diff-filter=A',
      '--name-only',
      '-z',
      base,
      '--',
      ...pure.map(literal),
    )
  )
    .split('\0')
    .filter(Boolean);
  const kept = new Set(outputs.sources.length ? matchingPaths(outputs.sources, candidates) : []);
  const added = candidates.filter((p) => !kept.has(p));
  if (!added.length) return [];
  // Список путей — на stdin: длинный список не упирается в предел командной строки.
  await gitWithInput(
    cwd,
    added.map(literal).join('\0') + '\0',
    'rm',
    '--cached',
    '-q',
    '--pathspec-from-file=-',
    '--pathspec-file-nul',
  );
  return added;
}

/** Убранные выходы попытки (`implementation/gate-outputs.json` её артефактов). */
export async function droppedGateOutputs(artifacts: string): Promise<string[]> {
  try {
    const log = JSON.parse(
      await readFile(join(artifacts, 'implementation', 'gate-outputs.json'), 'utf8'),
    ) as { dropped?: unknown };
    return Array.isArray(log.dropped)
      ? log.dropped.filter((p): p is string => typeof p === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Сколько убранных путей называет запрос; остальные — числом. */
export const DROPPED_SHOWN = 20;
const listed = (paths: readonly string[]) =>
  paths
    .slice(0, DROPPED_SHOWN)
    .map((p) => JSON.stringify(p))
    .join(', ') + (paths.length > DROPPED_SHOWN ? ` and ${paths.length - DROPPED_SHOWN} more` : '');

/** Исполнителю: какие новые файлы harness не взял в его сдачу как выходы gates. */
export const droppedOutputsWriterText = (paths: readonly string[]) =>
  `The harness kept these new files out of your previous handover as outputs of gate runs (they stay untracked in the worktree and are not part of the candidate): ${listed(paths)}. If any of them is a source the work needs (a test, a flow, a fixture), move it outside the gate output paths.`;

/** Reviewer: каких файлов нет в diff, хотя исполнитель их создал. */
export const droppedOutputsReviewText = (paths: readonly string[]) =>
  `The harness kept these new files out of the candidate as outputs of the writer's own gate runs, so they are not in the diff: ${listed(paths)}. If the change needs one of them as a source, report it.`;
