import type { EvidenceRecord, WorkOrder } from '../contracts/index.ts';

type Requirement = WorkOrder['requirements'][number];

/**
 * Уровни доказательства критерия. `testcase` — названный тест выполнился на
 * принятом SHA и прошёл; `gate` — известно лишь, что проверка зелёная;
 * `none` — подтверждения нет, причина названа. Доказательство — только
 * evidence фазы интеграции на принятом SHA, не потребителя.
 */
export type ProofLevel = 'testcase' | 'gate' | 'none';

export function requirementProof(
  link: Pick<Requirement, 'id' | 'gate' | 'testId'>,
  evidence: readonly EvidenceRecord[],
  resultSha: string | undefined,
): { id: string; level: ProofLevel; reason: string; testId?: string } {
  const base = { id: link.id, ...(link.testId ? { testId: link.testId } : {}) };
  if (!resultSha) return { ...base, level: 'none', reason: 'Результат ещё не принят' };
  const relevant = evidence.filter(
    (e) => !e.consumer && e.gate === link.gate && e.phase === 'integration' && e.sha === resultSha,
  );
  if (!relevant.length)
    return {
      ...base,
      level: 'none',
      reason: `Проверка ${link.gate} на принятом SHA не выполнялась`,
    };
  if (!relevant.some((e) => e.passed))
    return { ...base, level: 'none', reason: `Проверка ${link.gate} не прошла` };
  if (!link.testId)
    return {
      ...base,
      level: 'gate',
      reason: `Проверка ${link.gate} зелёная, но сценарий не связан с конкретным тестом`,
    };
  const withManifest = relevant.filter((e) => e.passed && e.tests?.length);
  if (!withManifest.length)
    return {
      ...base,
      level: 'none',
      reason: `Проверка ${link.gate} не сообщила, какие тесты выполнились`,
    };
  if (withManifest.some((e) => e.testsTruncated))
    return {
      ...base,
      level: 'none',
      reason: 'Список выполненных тестов обрезан: отсутствие теста по нему не доказать',
    };
  const found = withManifest.flatMap((e) =>
    e.tests!.filter((t) => !t.opaque && t.id === link.testId),
  );
  if (!found.length) {
    const opaque = withManifest.some((e) => e.tests!.some((t) => t.opaque));
    return {
      ...base,
      level: 'none',
      reason:
        `Тест ${link.testId} не выполнялся` +
        (opaque ? ' (имена части тестов скрыты redaction или хешем)' : ''),
    };
  }
  if (found.length > 1)
    return {
      ...base,
      level: 'none',
      reason: `Тест ${link.testId} встречается ${found.length} раза: неясно, какой проверяет сценарий`,
    };
  if (found[0]!.status !== 'passed')
    return { ...base, level: 'none', reason: `Тест ${link.testId}: ${found[0]!.status}` };
  return { ...base, level: 'testcase', reason: `Тест ${link.testId} выполнился и прошёл` };
}

/** Причина, по которой названные сценарии не подтверждены, или undefined. */
export function unprovenReason(
  requirements: readonly Requirement[] | undefined,
  evidence: readonly EvidenceRecord[],
  resultSha: string | undefined,
) {
  const unproven = (requirements ?? [])
    .filter((link) => link.testId)
    .map((link) => requirementProof(link, evidence, resultSha))
    .filter((p) => p.level !== 'testcase');
  return unproven.length
    ? 'Сценарий не подтверждён выполненным тестом: ' +
        unproven.map((p) => `${p.id} — ${p.reason}`).join('; ')
    : undefined;
}
