import { execFileSync } from 'node:child_process';
import { HarnessError, relativePathSchema, sha256, type WorkOrder } from '../contracts/index.ts';

/** Требование заканчивается на следующем заголовке уровня 1–2; примеры в fenced-блоках не считаются. */
export function parseRequirements(markdown: string) {
  if (Buffer.byteLength(markdown) > 1_000_000)
    throw new HarnessError('INVALID_INPUT', 'Источник требований превышает 1 MB');
  const found: { id: string; text: string; digest: string }[] = [];
  let current: { id: string; lines: string[] } | undefined;
  let fence: string | undefined;
  const finish = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (text.length > 12000)
      throw new HarnessError('INVALID_INPUT', 'Разбейте требование: ' + current.id);
    if (found.some((r) => r.id === current!.id))
      throw new HarnessError('INVALID_INPUT', 'Повтор ID: ' + current.id);
    found.push({ id: current.id, text, digest: sha256(text) });
    current = undefined;
  };
  for (const line of markdown.replaceAll('\r\n', '\n').split('\n')) {
    const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
      current?.lines.push(line);
      continue;
    }
    if (!fence && /^#{1,2}\s/.test(line)) {
      finish();
      const id = line.match(/^## (REQ-[A-Za-z0-9_-]{1,64})(?:\s|:|$)/)?.[1];
      if (id) current = { id, lines: [] };
    }
    current?.lines.push(line);
  }
  finish();
  return found;
}

/** Требования источника на коммите: файл обязан быть обычным Git-файлом. */
export function requirementSnapshot(cwd: string, source: string, ref = 'HEAD') {
  relativePathSchema.parse(source);
  if (!/^(HEAD|[a-f0-9]{40,64})$/.test(ref))
    throw new HarnessError('INVALID_INPUT', 'Нужен HEAD или точный SHA');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1_100_000 }).trimEnd();
  const sha = git('rev-parse', '--verify', ref + '^{commit}');
  if (!/^100(644|755) blob /.test(git('ls-tree', sha, '--', source)))
    throw new HarnessError(
      'NOT_READY',
      'Источник требований должен быть обычным Git-файлом: ' + source,
    );
  return { source, sha, requirements: parseRequirements(git('show', `${sha}:${source}`)) };
}

/**
 * Совпадают ли закреплённые требования поручения с источником на `ref`.
 * Изменённое или удалённое требование — отказ: исполнение по устаревшей
 * постановке не продолжается.
 */
export function assertRequirements(
  order: Pick<WorkOrder, 'requirements'>,
  cwd: string,
  ref = 'HEAD',
) {
  const snapshots = new Map<string, ReturnType<typeof requirementSnapshot>>();
  const stale = order.requirements.filter((link) => {
    if (!snapshots.has(link.source))
      snapshots.set(link.source, requirementSnapshot(cwd, link.source, ref));
    return (
      snapshots.get(link.source)!.requirements.find((r) => r.id === link.id)?.digest !== link.digest
    );
  });
  if (stale.length)
    throw new HarnessError(
      'APPROVAL_STALE',
      'Требования изменились или удалены: ' + stale.map((r) => r.id).join(', '),
    );
}

/** Псевдо-gate актуальности требований: обязателен в обеих фазах, если у поручения есть требования. */
export const REQUIREMENT_GATE = 'requirement-source';
