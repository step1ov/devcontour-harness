// Выходы gates, которые исполнитель гонял сам (alpha.75, P11-5): JUnit-отчёт,
// `artifacts` gate и каталоги отчётов UI-раннера. Исполнитель тонкого и
// облегчённого режимов запускает gates в дереве работы, и их новые файлы
// (`test-results/admin.xml`, `.last-run.json`, `trace.zip`) попадали в
// кандидата — сдача отклонялась нарушением области. Harness убирает из
// индекса только НОВЫЕ файлы под объявленными путями выходов: изменение или
// удаление уже отслеживаемого файла остаётся правкой исполнителя и
// проверяется областью, как любая другая.

import { git } from '../environment/process.ts';
import type { GatePolicy } from '../contracts/index.ts';
import { uiFailureArtifacts } from './ui-gates.ts';

/** Объявленные политикой выходы gates (пути от корня дерева), без повторов. */
export function gateOutputPaths(gates: readonly GatePolicy[]): string[] {
  const paths = gates.flatMap((g) => [
    ...(g.report ? [g.report.path] : []),
    ...(g.artifacts ?? []),
    ...(g.ui ? uiFailureArtifacts(g.ui) : []),
  ]);
  return [...new Set(paths.map((p) => p.replace(/\/+$/, '')))].sort();
}

/**
 * Убрать из индекса `cwd` файлы, добавленные относительно `base` под путями
 * `outputs` (путь или префикс каталога). Файлы остаются в рабочем дереве
 * неотслеживаемыми. Возвращает убранные пути.
 */
export async function dropGateOutputs(
  cwd: string,
  outputs: readonly string[],
  base = 'HEAD',
): Promise<string[]> {
  if (!outputs.length) return [];
  const specs = outputs.map((p) => `:(literal)${p}`);
  const added = (
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
      ...specs,
    )
  )
    .split('\0')
    .filter(Boolean);
  if (!added.length) return [];
  await git(cwd, 'rm', '--cached', '-q', '--', ...added.map((p) => `:(literal)${p}`));
  return added;
}
