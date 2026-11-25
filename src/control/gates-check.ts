import { writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  HarnessError,
  expandGateRefs,
  type ErrorCode,
  type EvidenceRecord,
  type ExecutionPolicy,
  gateDigest,
} from '../contracts/index.ts';
import { git } from '../environment/process.ts';
import { runGatesAt } from '../verification/gates-at.ts';
import { sandboxLimitBackend } from '../verification/gates.ts';
import { sandboxLimitLine } from '../verification/sandbox-signatures.ts';
import { failureSummaryLine } from '../verification/failure-summary.ts';

/** Исход одного gate проверки `harness gates`. */
export type GateCheckStatus = 'passed' | 'failed' | 'cancelled' | 'not-run' | 'skipped';

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
  /** Явная команда (`harness gates`): сетевой отказ сборки seed повторяется сразу. */
  retryStoreNetworkFailure?: boolean;
  /** Путь checkout репозитория вместо `baseDir` (хост, который знает пути сам). */
  repoPath?: (r: { path: string }) => string;
}

type Repo = ExecutionPolicy['repositories'][number];

/** Репозиторий проверки: названный или единственный в политике. */
export function repositoryOf(policy: ExecutionPolicy, repositoryId?: string): Repo {
  const repo = repositoryId
    ? policy.repositories.find((r) => r.id === repositoryId)
    : policy.repositories.length === 1
      ? policy.repositories[0]
      : undefined;
  if (!repo)
    throw new HarnessError(
      repositoryId ? 'NOT_FOUND' : 'INVALID_INPUT',
      repositoryId
        ? 'Репозиторий не объявлен в политике: ' + repositoryId
        : `В политике несколько репозиториев (${policy.repositories.map((r) => r.id).join(', ')}): назовите --repository`,
    );
  return repo;
}

/** Путь checkout репозитория политики: относительный — от каталога политики. */
export const repositoryPath =
  (baseDir: string) =>
  (r: { path: string }): string =>
    isAbsolute(r.path) ? r.path : resolve(baseDir, r.path);

/** SHA коммита по SHA, ref или `HEAD` checkout; нет — `NOT_FOUND`. */
export async function commitOf(path: string, rev: string, repositoryId: string) {
  try {
    return await git(path, 'rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`);
  } catch {
    throw new HarnessError('NOT_FOUND', `Коммит ${rev} не найден в ${repositoryId}`, [
      { path: ['--sha'], message: rev },
    ]);
  }
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
  const repo = repositoryOf(policy, input.repositoryId);
  const repoPath = input.repoPath ?? repositoryPath(input.baseDir);
  let ids: string[];
  try {
    ids = expandGateRefs(repo, input.gates);
  } catch (error) {
    const code = (error as { code?: ErrorCode }).code ?? 'GATE_UNKNOWN';
    throw new HarnessError(code, (error as Error).message, [
      { path: ['--gate'], message: (error as Error).message },
    ]);
  }
  const sha = await commitOf(repoPath(repo), input.rev, repo.id);
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
      ...(input.retryStoreNetworkFailure ? { retryStoreNetworkFailure: true } : {}),
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
  const causes = new Map(
    result.failures.flatMap((f) => (f.environment ? [[f.gate, f.environment] as const] : [])),
  );
  const skipped = new Set(result.skipped ?? []);
  const interrupted = result.interrupted;
  const gates = result.gates.map((gate) => {
    const evidence = result.evidence.find((e) => e.gate === gate);
    // Прерванный gate — отмена, не провал; после прерывания gates не исполнены.
    const status: GateCheckStatus =
      interrupted?.gate === gate
        ? 'cancelled'
        : evidence
          ? evidence.passed
            ? 'passed'
            : 'failed'
          : skipped.has(gate)
            ? interrupted
              ? 'not-run'
              : 'skipped'
            : 'not-run';
    const failure = failures.get(gate);
    // Причина отказа без повтора того, что уже сказано в summary (в любую сторону).
    const duplicate =
      failure !== undefined &&
      evidence !== undefined &&
      (evidence.summary.includes(failure) || failure.includes(evidence.summary));
    const message =
      status === 'cancelled'
        ? 'прерван: ' + interrupted!.reason
        : status === 'skipped'
          ? 'не исполнен: --fail-fast после первого провала'
          : skipped.has(gate) && interrupted
            ? 'не исполнен: проверка прервана'
            : failure !== undefined && !duplicate
              ? failure
              : undefined;
    const definition = repo.gates.find((g) => g.id === gate);
    return {
      gate,
      status,
      // Определение gate (alpha.69): итог на базе освобождает от засчитанного
      // молчаливого провала только при том же определении.
      ...(definition ? { definition: gateDigest(definition) } : {}),
      ...(evidence
        ? { exitCode: evidence.exitCode, summary: evidence.summary, log: evidence.log }
        : {}),
      ...(evidence?.toolchain ? { toolchain: evidence.toolchain } : {}),
      ...(status === 'failed' && evidence?.failureSummary
        ? { failureSummary: evidence.failureSummary }
        : {}),
      ...(message ? { message } : {}),
      // Отказ среды, названный gate (`sandbox-process-list`, `sandbox-filesystem`…):
      // правка кода его не снимет.
      ...(status === 'failed' && causes.get(gate) ? { environment: causes.get(gate)! } : {}),
    };
  });
  const data = {
    id: result.id,
    repositoryId: repo.id,
    sha,
    passed: gates.every((g) => g.status === 'passed'),
    failFast: Boolean(input.failFast),
    ...(interrupted ? { interrupted: interrupted.reason } : {}),
    durationMs: Date.now() - started,
    gates,
    logs: join(stateDir, 'gates-at', result.id),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    ...sandboxProbes(),
  };
  // Итог рядом с логами: `review-code` прикладывает его к обзору того же SHA.
  // Неудачная запись итога не отменяет проверку.
  await writeFile(
    join(data.logs, GATES_RESULT_FILE),
    JSON.stringify({ at: new Date().toISOString(), data }, null, 2),
  ).catch(() => undefined);
  return data;
}

/**
 * Ответы проб ограничений песочницы проверок этого процесса (сигнал,
 * браузер) со строкой для человека: на них опирается класс отказа среды.
 */
function sandboxProbes() {
  const seen = sandboxLimitBackend.seen();
  const signal = seen['sandbox-signal'];
  const browser = seen['sandbox-browser'];
  if (!signal && !browser) return {};
  return {
    sandbox: {
      ...(signal
        ? { signal: { ...signal, line: sandboxLimitLine('sandbox-signal', signal) } }
        : {}),
      ...(browser
        ? { browser: { ...browser, line: sandboxLimitLine('sandbox-browser', browser) } }
        : {}),
    },
  };
}

/** Файл итога проверки `harness gates` в её каталоге `gates-at/<id>`. */
export const GATES_RESULT_FILE = 'result.json';

/** Таблица исходов для человека (`harness gates --human`). */
export function gatesText(data: Awaited<ReturnType<typeof checkGates>>) {
  const width = Math.max(4, ...data.gates.map((g) => g.gate.length));
  const lines = data.gates.flatMap((g) => [
    `${g.gate.padEnd(width)}  ${g.status.padEnd(9)}  ${g.exitCode ?? '-'}`.padEnd(width + 18) +
      `  ${g.environment ? `[среда: ${g.environment}] ` : ''}${g.message ?? g.summary ?? ''}`.trimEnd(),
    // Выжимка провала (0.1.0-alpha.68): скрытый вывод или строка ошибки.
    ...(g.failureSummary && (g.failureSummary.withheld || g.failureSummary.assertion)
      ? [`${' '.repeat(width + 2)}причина: ${failureSummaryLine(g.failureSummary)}`]
      : []),
  ]);
  return (
    [
      `${data.repositoryId} @ ${data.sha.slice(0, 12)} — ${data.passed ? 'PASS' : 'FAIL'} (${Math.round(data.durationMs / 1000)} с)`,
      `${'gate'.padEnd(width)}  ${'status'.padEnd(9)}  exit`,
      ...lines,
      `логи: ${data.logs}`,
      ...[data.sandbox?.signal, data.sandbox?.browser].flatMap((c) =>
        c ? [`возможность: ${c.line}`] : [],
      ),
      ...(data.warnings ?? []).map((w) => `предупреждение: ${w}`),
    ].join('\n') + '\n'
  );
}
