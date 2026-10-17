import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  HarnessError,
  recoveryActions,
  type Author,
  type ExecutionPolicy,
  type ExecutionView,
  type PropertyRecovery,
  type RuntimeAdapter,
  type WorkState,
} from '../contracts/index.ts';
import { executionEnvironment } from '../environment/lifecycle.ts';
import { redactDeep } from '../environment/redaction.ts';
import type { Engine } from '../engine/engine.ts';
import { TaskFailure } from '../engine/failure.ts';
import { measuredInvoke } from '../engine/measured.ts';
import type { Runner } from '../engine/runner.ts';
import { contractDocuments, obligationOf } from '../verification/checks.ts';

/**
 * Разбор ведущего по повторяющемуся свойству.
 *
 * Ответ — структурированное предложение с причиной и evidence, а не
 * произвольная программа или правка состояния. Controller проверяет
 * допустимость и исполняет только разрешённое: добавление подтверждённых
 * случаев под существующим эталоном и один повтор с новой гипотезой —
 * автономно; усиление checker и декомпозиция — подготовленным предложением
 * для обычного ревью; уточнение обязательства — решением человека; причина в
 * среде — остановкой с диагностикой.
 */
export const recoveryResultSchema = z.object({
  action: z.enum(recoveryActions),
  reason: z.string().min(10).max(4000),
  evidence: z.array(z.string().max(2000)).max(20),
  hypothesis: z.string().max(4000).nullable(),
  plan: z.string().max(4000).nullable(),
  cases: z
    .array(
      z.object({
        input: z
          .string()
          .min(1)
          .max(64 * 1024),
        expected: z
          .string()
          .max(64 * 1024)
          .nullable(),
      }),
    )
    .max(10)
    .nullable(),
  proposal: z.string().max(8000).nullable(),
  conflict: z.string().max(4000).nullable(),
});

const nullable = (type: string) => ({ type: [type, 'null'] });
/** JSON Schema ответа разбора для structured output runtime. */
export const recoveryOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: [...recoveryActions] },
    reason: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    hypothesis: nullable('string'),
    plan: nullable('string'),
    cases: {
      anyOf: [
        { type: 'null' },
        {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { input: { type: 'string' }, expected: nullable('string') },
            required: ['input', 'expected'],
          },
        },
      ],
    },
    proposal: nullable('string'),
    conflict: nullable('string'),
  },
  required: ['action', 'reason', 'evidence', 'hypothesis', 'plan', 'cases', 'proposal', 'conflict'],
};

/** Что ведущий получает для разбора: свойство, версии, примеры, попытки, время, действия. */
export function recoveryBrief(view: ExecutionView, work: WorkState, policy: ExecutionPolicy) {
  const r = work.recovery!;
  const found = obligationOf(contractDocuments(work.order, view), r.property);
  const runs = r.runs.map((id) => view.attempt(id)).filter((x) => !!x);
  const suite = work.checkVersion
    ? view.locals('check-suites').find((x) => x.value.id === work.checkVersion!.suite)?.value
    : undefined;
  const duration = (x: (typeof runs)[number]) =>
    x.finishedAt ? Date.parse(x.finishedAt) - Date.parse(x.startedAt) : null;
  return {
    work: { id: work.id, title: work.order.title, goal: work.order.goal, attempt: work.attempt },
    property: r.property,
    obligation: found?.obligation,
    versions: {
      spec: work.approvedDigest,
      contracts: Object.fromEntries(work.order.contracts.map((c) => [c.id, c.digest])),
      corpus: work.checkVersion ?? null,
    },
    examples: runs.flatMap((x) =>
      x.evidence
        .filter((e) => e.property?.report)
        .flatMap((e) =>
          e
            .property!.report!.properties.filter(
              (p) => p.testId === r.property && p.status !== 'passed',
            )
            .map((p) => ({
              run: x.id,
              phase: e.phase,
              seed: e.property!.seed,
              counterexample: p.counterexample ?? null,
              current: p.current ?? null,
            })),
        ),
    ),
    corpus: suite
      ? {
          suite: suite.id,
          cases: Object.values(suite.cases)
            .filter((c) => c.property === r.property)
            .slice(-20)
            .map((c) => ({ id: c.id, input: c.input, expected: c.expected })),
        }
      : null,
    attempts: runs.map((x) => ({
      run: x.id,
      attempt: x.attempt,
      failureKind: x.failureKind,
      error: x.error?.slice(0, 2000),
      findings: x.evidence.flatMap((e) => (e.passed ? [] : (e.findings ?? []))).slice(0, 20),
      durationMs: duration(x),
    })),
    spentMs: runs.reduce((n, x) => n + (duration(x) ?? 0), 0),
    budgets: {
      attemptsLeft: policy.maxAttempts - work.attempt,
      repairBudget: policy.repairBudget,
    },
    actions: {
      'add-cases':
        'Add confirmed cases under the existing pinned oracle (inputs as exact JSON); each is confirmed by the controller on the defective commit, then one retry runs within the remaining attempts.',
      'new-approach':
        'One retry with a concrete new implementation hypothesis and a verification plan; the hypothesis is handed to the executor with its source.',
      'strengthen-checker':
        'Prepare a proposal to strengthen the checker or oracle; it goes through the normal contract or plan review and is not applied automatically.',
      'split-task':
        'Prepare a proposal to split the work order; it goes through normal replanning and is not applied automatically.',
      'clarify-obligation':
        'Name the conflict in the product obligation; the work waits for the human decision.',
      environment: 'The cause is in the environment or unknown; stop with a diagnosis.',
    },
  };
}

/** Разбор ведущим (runtime автора) — под учётом вызова, без права правки. */
export async function analyzeRecovery(
  ctx: {
    engine: Engine;
    policy: ExecutionPolicy;
    adapters: Partial<Record<Author, RuntimeAdapter>>;
    stateDir: string;
    cwd: string;
    environment?: NodeJS.ProcessEnv;
  },
  work: WorkState,
  author: 'codex' | 'claude',
  signal: AbortSignal,
): Promise<NonNullable<PropertyRecovery['decision']>> {
  const adapter = ctx.adapters[author];
  if (!adapter) throw new HarnessError('RUNTIME_UNAVAILABLE', 'Runtime не подключён: ' + author);
  const brief = ctx.engine.read((v) => recoveryBrief(v, work, ctx.policy));
  const dir = join(ctx.stateDir, 'recoveries', work.recovery!.id);
  await mkdir(dir, { recursive: true });
  const prompt = [
    'You are the lead agent. A work order failed twice in a row on the same declared property and the controller stopped automatic retries until you decide.',
    'Choose exactly one action. Prefer the narrowest action that addresses the class of defect, not only the last example. A timeout or flaky case is not proof of a defect; a product obligation is never weakened by you — name the conflict instead. Return a structured decision with reason and evidence. Do not edit files.',
    JSON.stringify(brief, null, 2),
  ].join('\n\n');
  await writeFile(join(dir, 'prompt.txt'), prompt);
  const execution = executionEnvironment(
    [ctx.policy.environment],
    {},
    ctx.environment ?? process.env,
  );
  const response = await measuredInvoke(
    ctx.engine,
    adapter,
    {
      callId: randomUUID(),
      task: 'plan',
      binding: { runtime: author },
      cwd: ctx.cwd,
      prompt,
      outputSchema: recoveryOutputSchema,
      session: { kind: 'fresh' },
      sandbox: {
        mode: ctx.policy.isolation.mode,
        writable: [],
        denied: [ctx.stateDir],
        readable: [ctx.cwd],
        network: { domains: ctx.policy.isolation.domains },
      },
      timeoutMs: ctx.policy.runTimeoutMs,
      env: Object.fromEntries(
        Object.entries(execution.env).filter((e): e is [string, string] => e[1] !== undefined),
      ),
      artifactDir: dir,
      secrets: [...(execution.redact.secrets ?? [])],
    },
    signal,
    {
      runId: work.recovery!.runs.at(-1)!,
      subjectId: work.id,
      subjectKind: 'work',
      stage: 'property-recovery',
    },
  ).catch((error: unknown) => {
    if (error instanceof TaskFailure && error.kind === 'budget')
      throw new HarnessError('BUDGET_EXHAUSTED', error.message);
    throw error;
  });
  if (response.status !== 'ok')
    throw new HarnessError(
      'RUNTIME_UNAVAILABLE',
      `Разбор ведущего: ${response.status}${response.diagnostics.reason ? ': ' + response.diagnostics.reason : ''}`,
    );
  const parsed = redactDeep(recoveryResultSchema.parse(response.output), execution.redact);
  await writeFile(join(dir, 'decision.json'), JSON.stringify(parsed, null, 2));
  return {
    action: parsed.action,
    reason: parsed.reason,
    evidence: parsed.evidence,
    ...(parsed.hypothesis ? { hypothesis: parsed.hypothesis } : {}),
    ...(parsed.plan ? { plan: parsed.plan } : {}),
    ...(parsed.cases ? { cases: parsed.cases } : {}),
    ...(parsed.proposal ? { proposal: parsed.proposal } : {}),
    ...(parsed.conflict ? { conflict: parsed.conflict } : {}),
    source: {
      kind: 'lead',
      runtime: author,
      ...(response.model ? { model: response.model } : {}),
    },
    decidedAt: new Date(ctx.engine.clock()).toISOString(),
  };
}

/**
 * Исполнить разрешённое добавление случаев: каждый подтверждается эталоном
 * на дефектном SHA. Ключи выводятся из эпизода — повтор после сбоя не
 * создаёт второго подтверждения.
 */
export async function applyCases(runner: Runner, work: WorkState) {
  const r = work.recovery!;
  const cases = r.decision?.cases ?? [];
  if (!cases.length) throw new HarnessError('INVALID_INPUT', 'Решение add-cases без случаев');
  const outcomes: { outcome: string; reason: string }[] = [];
  for (const [i, c] of cases.entries()) {
    const result = await runner.submitCase({
      workId: work.id,
      property: r.property,
      input: c.input,
      expected: c.expected ?? null,
      sourceRunId: r.runs.at(-1),
      key: `${r.id}-case-${i}`,
      origin: r.decision!.source.kind === 'lead' ? 'lead' : 'operator',
      ...(r.decision!.source.runtime ? { runtime: r.decision!.source.runtime } : {}),
    });
    outcomes.push({ outcome: result.decision.outcome, reason: result.decision.reason });
  }
  return outcomes;
}
