import type { GatePolicy, ReusedEvidence } from '../contracts/index.ts';

/**
 * Перенос evidence кандидата на интеграцию (`integrationReuse:
 * 'identical-tree'`). Одно правило для записи (движок), приёмки (`finish`, в
 * том числе после recovery) и получателя результата: запись интеграции,
 * взятая из кандидата, — PASS интеграции, только если она ссылается на
 * решающую PASS-запись того же gate на кандидате этой попытки, gate — не
 * доказательство (требование, свойство, договор: им нужен свой манифест на
 * каждой фазе) и без `artifacts` (копии — свои у каждой фазы), а деревья
 * обоих коммитов совпадают. Деревья сверяет тот, кто владеет Git: controller
 * при записи и recovery, получатель — своим `git rev-parse <sha>^{tree}`.
 */
export interface ReuseRecord {
  id: string;
  kind: string;
  phase: 'candidate' | 'integration';
  gate: string;
  sha: string;
  passed: boolean;
  consumer?: string | undefined;
  checks?: string | undefined;
  reusedEvidence?: ReusedEvidence | undefined;
  property?: unknown;
  artifactFiles?: unknown;
}

export interface ReuseCheck {
  record: ReuseRecord;
  /** Все записи попытки (или результата), среди которых ищется запись кандидата. */
  evidence: readonly ReuseRecord[];
  candidateSha: string;
  resultSha: string;
  /** Gates доказательств поручения (`proofGates`). */
  proof: ReadonlySet<string>;
  /** Определения gates репозитория (у получателя — его политики). */
  gates: readonly Pick<GatePolicy, 'id' | 'artifacts'>[];
  /**
   * Деревья кандидата и результата по Git проверяющего; `null` — их уже
   * сверил вызывающий (controller при записи), здесь не сверяются.
   */
  trees: { candidate: string; result: string } | null;
}

/** Почему запись, взятая из кандидата, не PASS интеграции, или undefined. */
export function reusedEvidenceProblem(input: ReuseCheck): string | undefined {
  const { record, candidateSha, resultSha } = input;
  const from = record.reusedEvidence;
  const label = `запись ${record.id} (${record.gate}), взятая из кандидата`;
  if (!from) return `${label}: нет ссылки на запись кандидата`;
  if (
    record.kind !== 'test' ||
    record.phase !== 'integration' ||
    record.sha !== resultSha ||
    !record.passed ||
    record.consumer !== undefined
  )
    return `${label}: переносится только PASS собственного gate интеграции на result SHA`;
  if (record.property !== undefined || record.artifactFiles !== undefined)
    return `${label}: сведения о свойствах и копии artifacts бывают только у исполненной записи`;
  if (from.phase !== 'candidate' || from.sha !== candidateSha)
    return `${label}: ссылка не на SHA кандидата ${candidateSha}`;
  if (input.proof.has(record.gate))
    return `${label}: gate ${record.gate} — доказательство поручения и исполняется на каждой фазе`;
  const gate = input.gates.find((g) => g.id === record.gate);
  if (!gate) return `${label}: gate ${record.gate} не объявлен`;
  if (gate.artifacts?.length)
    return `${label}: gate ${record.gate} сохраняет artifacts и исполняется на каждой фазе`;
  const source = input.evidence.find((e) => e.id === from.evidenceId);
  if (!source) return `${label}: запись кандидата ${from.evidenceId} не найдена`;
  if (
    source.kind !== 'test' ||
    source.phase !== 'candidate' ||
    source.sha !== candidateSha ||
    source.gate !== record.gate ||
    source.consumer !== undefined ||
    source.reusedEvidence !== undefined
  )
    return `${label}: запись ${from.evidenceId} — не собственная проверка ${record.gate} на кандидате`;
  if (!source.passed) return `${label}: запись кандидата ${from.evidenceId} не PASS`;
  if (source.checks !== record.checks)
    return `${label}: запись кандидата получена под другой версией проверок`;
  // Ссылка — на решающую запись кандидата: более ранний PASS, за которым
  // последовал провал, интеграцию не закрывает.
  const decisive = input.evidence.findLast(
    (e) =>
      e.kind === 'test' &&
      e.phase === 'candidate' &&
      e.sha === candidateSha &&
      e.gate === record.gate &&
      e.consumer === undefined &&
      e.checks === record.checks,
  );
  if (decisive?.id !== source.id)
    return `${label}: запись ${from.evidenceId} — не решающая запись кандидата`;
  if (input.trees) {
    if (input.trees.candidate !== input.trees.result)
      return `${label}: дерево результата ${input.trees.result} не совпадает с деревом кандидата ${input.trees.candidate}`;
    if (from.tree !== input.trees.candidate)
      return `${label}: записанное дерево ${from.tree} не совпадает с деревом кандидата ${input.trees.candidate}`;
  }
  return undefined;
}

/** Подпись записи, взятой из кандидата, для отчётов и сводок. */
export const REUSED_LABEL = 'взято из кандидата';
