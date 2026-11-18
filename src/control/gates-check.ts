import { isAbsolute, join, resolve } from 'node:path';
import {
  HarnessError,
  expandGateRefs,
  type ErrorCode,
  type EvidenceRecord,
  type ExecutionPolicy,
} from '../contracts/index.ts';
import { git } from '../environment/process.ts';
import { runGatesAt } from '../verification/gates-at.ts';

/** Исход одного gate проверки `harness gates`. */
export type GateCheckStatus = 'passed' | 'failed' | 'not-run' | 'skipped';

export interface GateCheckInput {
  policy: ExecutionPolicy;
  /** Каталог политики: от него разрешаются относительные пути репозиториев. */
  baseDir: string;
  /** Каталог состояния: здесь логи проверки (`gates-at/<id>`); попыток не пишет. */
  stateDir: string;
  /** Репозиторий политики; нет — единственный. */
  repositoryId?: string;
  /** SHA, ref или `HEAD` checkout репозитория. */
  rev: string;
  /** Gates и группы (`@имя`); нет — все gates репозитория. */
  gates?: string[];
  failFast?: boolean;
  signal?: AbortSignal;
  /** Каждое записанное evidence — до следующего gate (CLI печатает ход в stderr). */
  onEvidence?(evidence: EvidenceRecord): void;
  resourceDatabase?: string;
}

/**
 * Gates на коммите вне попытки (`harness gates`): то же исполнение, что
 * `runGatesAt` — отдельное рабочее дерево, снимки зависимостей, ресурсы,
 * lifecycle и prepare, окружение фазы `integration`, песочница. Попытка не
 * создаётся, состояние поручений и база состояния не открываются: evidence
 * возвращается вызывающему и никуда не записывается. Логи gates остаются в
 * `<stateDir>/gates-at/<id>`.
 */
export async function checkGates(input: GateCheckInput) {
  const { policy } = input;
  const repo = input.repositoryId
    ? policy.repositories.find((r) => r.id === input.repositoryId)
    : policy.repositories.length === 1
      ? policy.repositories[0]
      : undefined;
  if (!repo)
    throw new HarnessError(
      input.repositoryId ? 'NOT_FOUND' : 'INVALID_INPUT',
      input.repositoryId
        ? 'Репозиторий не объявлен в политике: ' + input.repositoryId
        : `В политике несколько репозиториев (${policy.repositories.map((r) => r.id).join(', ')}): назовите --repository`,
    );
  const repoPath = (r: { path: string }) =>
    isAbsolute(r.path) ? r.path : resolve(input.baseDir, r.path);
  let ids: string[];
  try {
    ids = expandGateRefs(repo, input.gates);
  } catch (error) {
    const code = (error as { code?: ErrorCode }).code ?? 'GATE_UNKNOWN';
    throw new HarnessError(code, (error as Error).message, [
      { path: ['--gate'], message: (error as Error).message },
    ]);
  }
  let sha: string;
  try {
    sha = await git(
      repoPath(repo),
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${input.rev}^{commit}`,
    );
  } catch {
    throw new HarnessError('NOT_FOUND', `Коммит ${input.rev} не найден в ${repo.id}`, [
      { path: ['--sha'], message: input.rev },
    ]);
  }
  const stateDir = resolve(input.stateDir);
  const repos = policy.repositories.map(repoPath);
  const started = Date.now();
  const result = await runGatesAt(
    {
      policy,
      stateDir,
      repoPath,
      // Та же граница, что у gates попытки: состояние и исходные checkout
      // закрыты, их `.git` открыт на чтение.
      boundary: () => ({
        hidden: [...new Set([stateDir, ...repos])],
        readable: repos.map((r) => join(r, '.git')),
      }),
      ...(input.resourceDatabase ? { resourceDatabase: input.resourceDatabase } : {}),
    },
    {
      repositoryId: repo.id,
      sha,
      gates: ids,
      record: (e) => input.onEvidence?.(e),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.failFast ? { failFast: true } : {}),
    },
  );
  const failures = new Map(result.failures.map((f) => [f.gate, f.message]));
  const skipped = new Set(result.skipped ?? []);
  const gates = result.gates.map((gate) => {
    const evidence = result.evidence.find((e) => e.gate === gate);
    const status: GateCheckStatus = evidence
      ? evidence.passed
        ? 'passed'
        : 'failed'
      : skipped.has(gate)
        ? 'skipped'
        : 'not-run';
    const message = failures.get(gate);
    return {
      gate,
      status,
      ...(evidence
        ? { exitCode: evidence.exitCode, summary: evidence.summary, log: evidence.log }
        : {}),
      ...(message && !evidence?.summary.includes(message) ? { message } : {}),
      ...(status === 'skipped'
        ? { message: 'не исполнен: --fail-fast после первого провала' }
        : {}),
    };
  });
  return {
    id: result.id,
    repositoryId: repo.id,
    sha,
    passed: gates.every((g) => g.status === 'passed'),
    failFast: Boolean(input.failFast),
    durationMs: Date.now() - started,
    gates,
    logs: join(stateDir, 'gates-at', result.id),
  };
}

/** Таблица исходов для человека (`harness gates --human`). */
export function gatesText(data: Awaited<ReturnType<typeof checkGates>>) {
  const width = Math.max(4, ...data.gates.map((g) => g.gate.length));
  const lines = data.gates.map(
    (g) =>
      `${g.gate.padEnd(width)}  ${g.status.padEnd(7)}  ${g.exitCode ?? '-'}`.padEnd(width + 16) +
      `  ${g.message ?? g.summary ?? ''}`.trimEnd(),
  );
  return (
    [
      `${data.repositoryId} @ ${data.sha.slice(0, 12)} — ${data.passed ? 'PASS' : 'FAIL'} (${Math.round(data.durationMs / 1000)} с)`,
      `${'gate'.padEnd(width)}  ${'status'.padEnd(7)}  exit`,
      ...lines,
      `логи: ${data.logs}`,
    ].join('\n') + '\n'
  );
}
