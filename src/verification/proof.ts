import type { EvidenceRecord, WorkOrder } from '../contracts/index.ts';

type Requirement = WorkOrder['requirements'][number];

/**
 * Что нужно доказательству от записи evidence: сама запись controller или её
 * переносимая форма в результате (у получателя).
 */
export type ProofRecord = Pick<EvidenceRecord, 'kind' | 'gate' | 'phase' | 'sha' | 'passed'> & {
  consumer?: string | undefined;
  checks?: string | undefined;
  tests?: EvidenceRecord['tests'];
  testsTruncated?: boolean | undefined;
};

/**
 * Уровни доказательства критерия. `testcase` — названный тест выполнился на
 * принятом SHA и прошёл; `gate` — известно лишь, что проверка зелёная;
 * `none` — подтверждения нет, причина названа.
 *
 * Доказательство — только решающая запись gate: последняя собственная
 * (не потребителя) запись вида `test` фазы интеграции на принятом SHA под
 * версией проверок попытки (`effective`, если она есть). Запись ревью под
 * именем gate, запись другой версии или более ранний прогон того же gate
 * testcase не подтверждают: приёмка решает по той же записи.
 */
export type ProofLevel = 'testcase' | 'gate' | 'none';

export function requirementProof(
  link: Pick<Requirement, 'id' | 'gate' | 'testId'>,
  evidence: readonly ProofRecord[],
  resultSha: string | undefined,
  effective?: string,
): { id: string; level: ProofLevel; reason: string; testId?: string } {
  const base = { id: link.id, ...(link.testId ? { testId: link.testId } : {}) };
  if (!resultSha) return { ...base, level: 'none', reason: 'Результат ещё не принят' };
  const check = evidence.findLast(
    (e) =>
      e.kind === 'test' &&
      !e.consumer &&
      e.gate === link.gate &&
      e.phase === 'integration' &&
      e.sha === resultSha &&
      (effective === undefined || e.checks === effective),
  );
  if (!check)
    return {
      ...base,
      level: 'none',
      reason: `Проверка ${link.gate} на принятом SHA не выполнялась`,
    };
  if (!check.passed) return { ...base, level: 'none', reason: `Проверка ${link.gate} не прошла` };
  if (!link.testId)
    return {
      ...base,
      level: 'gate',
      reason: `Проверка ${link.gate} зелёная, но сценарий не связан с конкретным тестом`,
    };
  const tests = check.tests ?? [];
  if (!tests.length)
    return {
      ...base,
      level: 'none',
      reason: `Проверка ${link.gate} не сообщила, какие тесты выполнились`,
    };
  if (check.testsTruncated)
    return {
      ...base,
      level: 'none',
      reason: 'Список выполненных тестов обрезан: отсутствие теста по нему не доказать',
    };
  const found = tests.filter((t) => !t.opaque && t.id === link.testId);
  if (!found.length) {
    const opaque = tests.some((t) => t.opaque);
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
  evidence: readonly ProofRecord[],
  resultSha: string | undefined,
  effective?: string,
) {
  const unproven = (requirements ?? [])
    .filter((link) => link.testId)
    .map((link) => requirementProof(link, evidence, resultSha, effective))
    .filter((p) => p.level !== 'testcase');
  return unproven.length
    ? 'Сценарий не подтверждён выполненным тестом: ' +
        unproven.map((p) => `${p.id} — ${p.reason}`).join('; ')
    : undefined;
}

/**
 * Gates репозиториев, которые не прошли на integration ни одно из принятых
 * поручений набора. Покрывает gate только собственная (не потребителя)
 * запись вида `test` фазы интеграции на принятом SHA поручения: запись ревью
 * одноимённый test gate не закрывает. Какие записи относятся к поручению
 * (попытки под текущим основанием, переносимый результат другого clone), —
 * решает вызывающий; правило покрытия — одно.
 */
export function uncoveredGates(
  repositories: readonly { id: string; gates: readonly { id: string }[] }[],
  works: readonly {
    repositoryId: string;
    resultSha: string | undefined;
    evidence: readonly ProofRecord[];
  }[],
) {
  const result: { repositoryId: string; gates: string[] }[] = [];
  for (const repositoryId of [...new Set(works.map((w) => w.repositoryId))]) {
    const covered = new Set(
      works
        .filter((w) => w.repositoryId === repositoryId)
        .flatMap((w) =>
          w.evidence
            .filter(
              (e) =>
                e.kind === 'test' &&
                e.phase === 'integration' &&
                e.passed &&
                !e.consumer &&
                w.resultSha !== undefined &&
                e.sha === w.resultSha,
            )
            .map((e) => e.gate),
        ),
    );
    const repository = repositories.find((r) => r.id === repositoryId);
    const missing = (repository?.gates ?? []).map((g) => g.id).filter((id) => !covered.has(id));
    if (missing.length) result.push({ repositoryId, gates: missing });
  }
  return result;
}
