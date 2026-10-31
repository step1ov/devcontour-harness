import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  HarnessError,
  idSchema,
  type ContractArtifact,
  type ExecutionPolicy,
  type WorkState,
} from '../contracts/index.ts';
import { OversizedFile, readBounded } from '../environment/bounded-read.ts';
import { executionEnvironment, runSteps, withEnvironment } from '../environment/lifecycle.ts';
import { git, hostGitArgs } from '../environment/process.ts';
import { defaultResourceDatabase } from '../environment/resources.ts';
import { contractDocuments, obligationOf } from './checks.ts';
import {
  MAX_CASE_BYTES,
  canonicalJson,
  scrubLocalPaths,
  sha256,
  type CaseDecision,
  type CorpusStore,
} from './corpus.ts';
import { materializeStore } from './dependency-store.ts';
import { runCheck, type Boundary } from './gates.ts';

/**
 * Быстрый маршрут: подтверждённый пример становится обязательным случаем.
 *
 * Пример reviewer или ведущего — гипотеза. Controller сам запускает
 * закреплённый эталон на этом входе (режим одного случая того же checker,
 * что исполняет gate), повторяет проверку реализации на исходном дефектном
 * SHA и требует воспроизводимого расхождения. Ответ эталона, а не слова
 * reviewer, становится ожиданием. Команда из воспроизведения не исполняется
 * никогда; данные входа не интерпретируются как shell.
 *
 * Маршрут только добавляет данные под тем же checker/oracle, той же областью
 * и правилами ответа. Удаление случая, замена ожидания, допуск, покрытие,
 * новый checker или команда — обычное изменение договора проверки.
 */
export const fastPathChanges = [
  'add',
  'remove',
  'replace-expected',
  'tolerance',
  'coverage',
  'checker',
  'command',
] as const;
export const caseInputSchema = z.strictObject({
  workId: idSchema,
  property: z.string().min(1).max(200),
  /** Точный вход как JSON-текст. */
  input: z.string().min(1).max(MAX_CASE_BYTES),
  /** Утверждение источника; эталон его проверяет, но не наследует. */
  expected: z.string().max(MAX_CASE_BYTES).nullable().optional(),
  actual: z.string().max(MAX_CASE_BYTES).nullable().optional(),
  reproductionId: z.string().max(80).optional(),
  /** Дефектный SHA; по умолчанию — кандидат последней неуспешной попытки. */
  sourceSha: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  sourceRunId: z.string().max(200).optional(),
  /** Какие незавершённые поручения принимают новую версию; по умолчанию — это. */
  adopt: z.array(idSchema).max(30).optional(),
  /** Ключ идемпотентности: повтор с тем же ключом возвращает прежний исход. */
  key: z.string().regex(/^[A-Za-z0-9_.:-]{8,120}$/),
  change: z.enum(fastPathChanges).default('add'),
  origin: z.enum(['review', 'lead', 'agent', 'operator']).default('agent'),
  runtime: z.string().max(40).optional(),
});
export type CaseRequest = z.input<typeof caseInputSchema>;

/** Точка после записи версии и до принятия: тест моделирует в ней сбой. */
export const caseHooks = { afterRecord: (): void => undefined };

/** Файл результата пишет проверяемый код; случай корпуса — не больше 64 КиБ. */
const CASE_RESULT_LIMIT = 1024 * 1024;
const caseResult = z.object({
  property: z.string(),
  valid: z.boolean().optional(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  equal: z.boolean().optional(),
  oracleError: z.string().optional(),
  error: z.string().optional(),
});

/** Что нужно подтверждению от controller. */
export interface ConfirmContext {
  corpus: CorpusStore;
  policy: ExecutionPolicy;
  stateDir: string;
  repoPath(repo: ExecutionPolicy['repositories'][number]): string;
  /** Закрытое проверке и открытое внутри него. */
  boundary(): Boundary;
  /**
   * Каталог рабочего дерева вида `kind` (корень вне дерева, `checkout-root.ts`);
   * без него — прежнее место в каталоге состояния.
   */
  checkout?(repositoryId: string, kind: string, id: string): string;
  /** Источник переменных окружения (по умолчанию — процесс). */
  environment?: NodeJS.ProcessEnv;
  /** База закреплений и аренд хранилища зависимостей. */
  resourceDatabase?: string;
}

type Verdict = {
  input: string;
  outcome: CaseDecision['outcome'];
  reason: string;
  observed?: NonNullable<CaseDecision['observed']>;
  method?: NonNullable<CaseDecision['method']>;
};

/** Изменённые закреплённые файлы на SHA: checker должен быть утверждённой редакцией. */
export async function staleArtifacts(repoPath: string, sha: string, artifacts: ContractArtifact[]) {
  const stale: string[] = [];
  for (const a of artifacts) {
    const blob = await git(repoPath, 'rev-parse', `${sha}:${a.path}`).catch(() => '');
    if (blob !== a.blob) stale.push(a.path);
  }
  return stale;
}

export async function submitCase(ctx: ConfirmContext, raw: unknown) {
  const input = caseInputSchema.parse(raw);
  if (input.change !== 'add')
    throw new HarnessError(
      'INVALID_INPUT',
      `Быстрый маршрут только добавляет подтверждённые случаи. Изменение «${input.change}» — обычное изменение договора проверки с независимым ревью контракта. Принятые версии корпуса не переписываются.`,
    );
  const corpus = ctx.corpus;
  const store = corpus.engine.host.store;
  const { work, ref, source } = store.read((v) => {
    const work = v.work(input.workId);
    if (!work) throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + input.workId);
    const contracts = contractDocuments(work.order, v);
    // Неизвестное свойство не подбирается по тексту: решение «отклонено»
    // записывается в корпус первого договора проверки поручения.
    const property = obligationOf(contracts, input.property)
      ? input.property
      : contracts.flatMap((c) => c.checks?.obligations.map((o) => o.property) ?? [])[0];
    if (!property)
      throw new HarnessError('NOT_READY', 'У поручения нет договора проверки с корпусом');
    return {
      work: structuredClone(work),
      ref: corpus.suiteFor(v, work, property),
      source: sourceOf(v.attempts(work.id), work, input),
    };
  });
  const origin = { kind: input.origin, ...(input.runtime ? { runtime: input.runtime } : {}) };
  const started = corpus.begin(ref.suite, input.key);
  if (started.done) {
    const done = started.done;
    const suite = corpus.read(ref.suite.id);
    for (const p of suite.pending.filter(
      (x) => x.status === 'waiting' && !x.awaitingOperator && x.version === done.version,
    ))
      corpus.adopt(suite.id, p.id);
    return view(corpus.read(suite.id), done.id, true);
  }
  const token = started.token;
  if (!source) {
    corpus.end(ref.suite.id, input.key, token);
    throw new HarnessError(
      'NOT_READY',
      'Не указан дефектный SHA и у поручения нет завершённого кандидата',
    );
  }
  const heartbeat = setInterval(
    () => {
      try {
        corpus.heartbeat(ref.suite.id, input.key, token);
      } catch {
        /* Утраченное владение увидит запись решения. */
      }
    },
    Math.max(1000, ctx.policy.leaseMs / 2),
  );
  heartbeat.unref();
  try {
    const decided = await decide(ctx, work, ref, input, source);
    // Диагностика решения переносима: локальные каталоги из исключений
    // реализации заменяются меткой до записи.
    const verdict: Verdict = {
      ...decided,
      reason: scrubLocalPaths(decided.reason, corpus.roots),
      ...(decided.observed
        ? {
            observed: {
              ...decided.observed,
              ...(decided.observed.actual !== undefined
                ? { actual: scrubLocalPaths(decided.observed.actual, corpus.roots) }
                : {}),
            },
          }
        : {}),
    };
    const repo = ctx.policy.repositories.find((r) => r.id === work.order.repositoryId)!;
    const recorded = corpus.record(
      corpus.read(ref.suite.id) ?? ref.suite,
      input.key,
      token,
      {
        key: input.key,
        property: input.property,
        input: verdict.input,
        inputHash: sha256(verdict.input),
        outcome: verdict.outcome,
        reason: verdict.reason,
        claimed: {
          expected: input.expected ?? null,
          actual: input.actual ?? null,
          ...(input.reproductionId ? { reproduction: input.reproductionId } : {}),
        },
        source,
        ...(verdict.observed ? { observed: verdict.observed } : {}),
        ...(verdict.method ? { method: verdict.method } : {}),
        origin,
      },
      (content) =>
        execFileSync('git', hostGitArgs(ctx.repoPath(repo), ['hash-object', '-w', '--stdin']), {
          cwd: ctx.repoPath(repo),
          input: content,
        })
          .toString()
          .trim(),
      {
        works: input.adopt ?? [work.id],
        actor: `${origin.kind}${origin.runtime ? ':' + origin.runtime : ''}`,
        // operator mode: данные корпуса записываются, принятие поручением ждёт
        // ручного технического подтверждения.
        manual: ctx.policy.approvalMode === 'operator',
      },
    );
    caseHooks.afterRecord();
    if (recorded.pending && !recorded.pending.awaitingOperator)
      corpus.adopt(ref.suite.id, recorded.pending.id);
    return view(corpus.read(ref.suite.id), recorded.decision.id, false);
  } catch (error) {
    corpus.end(ref.suite.id, input.key, token);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

function sourceOf(
  attempts: { id: string; candidateSha?: string; status: string }[],
  work: WorkState,
  input: z.infer<typeof caseInputSchema>,
) {
  if (input.sourceSha)
    return {
      sha: input.sourceSha,
      ...(input.sourceRunId ? { runId: input.sourceRunId } : {}),
      taskId: work.id,
    };
  const run = input.sourceRunId
    ? attempts.find((a) => a.id === input.sourceRunId)
    : attempts.findLast((a) => a.candidateSha && a.status !== 'active');
  if (!run?.candidateSha) return undefined;
  return { sha: run.candidateSha, runId: run.id, taskId: work.id };
}

function view(suite: ReturnType<CorpusStore['read']>, decisionId: string, repeated: boolean) {
  const decision = suite.decisions.find((d) => d.id === decisionId)!;
  const head = suite.versions.at(-1);
  return {
    suite: suite.id,
    repeated,
    decision,
    version: head ? { number: head.number, digest: head.digest, cases: head.cases.length } : null,
    adoption: suite.pending
      .filter((p) => p.version === decision.version)
      .map(({ id, status, results, awaitingOperator }) => ({
        id,
        status,
        results,
        ...(awaitingOperator ? { awaitingOperator } : {}),
      })),
  };
}

async function decide(
  ctx: ConfirmContext,
  work: WorkState,
  ref: ReturnType<CorpusStore['suiteFor']>,
  input: z.infer<typeof caseInputSchema>,
  source: { sha: string },
): Promise<Verdict> {
  const reject = (reason: string, text = input.input): Verdict => ({
    input: text,
    outcome: 'rejected',
    reason,
  });
  let text: string;
  try {
    text = canonicalJson(JSON.parse(input.input));
  } catch {
    return reject('вход не JSON');
  }
  // Замаскированный вход непригоден: настоящего значения уже нет.
  if (text.includes('[REDACTED]')) return reject('вход замаскирован redaction и непригоден', text);
  if (Buffer.byteLength(text) + Buffer.byteLength(input.expected ?? '') > MAX_CASE_BYTES)
    return reject(`случай больше ${MAX_CASE_BYTES} байт`, text);
  const store = ctx.corpus.engine.host.store;
  const found = store.read((v) => obligationOf(contractDocuments(work.order, v), input.property));
  if (!found) return reject(`свойство ${input.property} не объявлено в договорах поручения`, text);
  const declaration = found.contract.checks!;
  if (!declaration.corpus?.extensible || !found.obligation.coverage.corpus)
    return reject('договор проверки не разрешает пополнять корпус этого свойства', text);
  if (!work.order.properties?.includes(input.property))
    return reject(
      'механизм договора проверки для поручения не включён или свойство вне его области: включение проходит ревью плана',
      text,
    );
  const repo = ctx.policy.repositories.find(
    (r) => r.id === (found.contract.repositoryId ?? work.order.repositoryId),
  );
  const gate = repo?.gates.find((g) => g.id === declaration.gate);
  if (!repo || !gate?.property)
    return reject(`gate ${declaration.gate} не настроен как генеративный`, text);
  const artifacts = found.contract.artifacts ?? [];
  const method = {
    gate: gate.id,
    command: gate.command,
    artifacts: artifacts.map((a) => ({ path: a.path, blob: a.blob })),
    contract: found.contract.id,
    basis: ref.suite.basis,
  };
  const repoPath = ctx.repoPath(repo);
  try {
    await git(repoPath, 'cat-file', '-e', `${source.sha}^{commit}`);
  } catch {
    return {
      input: text,
      outcome: 'inconclusive',
      reason: `исходный SHA ${source.sha} недоступен`,
      method,
    };
  }
  // Checker на исходном SHA — закреплённая редакция: иначе ответ дал бы
  // другой эталон, чем утверждён договором.
  const stale = await staleArtifacts(repoPath, source.sha, artifacts);
  if (stale.length)
    return {
      input: text,
      outcome: 'inconclusive',
      reason: `на исходном SHA checker не совпадает с закреплённым: ${stale.join(', ')}`,
      method,
    };
  const runs: z.infer<typeof caseResult>[] = [];
  const durations: number[] = [];
  const cases = ctx.checkout?.(repo.id, 'case-checks', '') ?? join(ctx.stateDir, 'case-checks');
  await mkdir(cases, { recursive: true });
  const dir = await realpath(await mkdtemp(join(cases, 'case-')));
  await rm(dir, { recursive: true, force: true });
  await git(repoPath, 'worktree', 'add', '--detach', dir, source.sha);
  const io = await realpath(await mkdtemp(join(tmpdir(), 'harness-case-')));
  try {
    const execution = executionEnvironment(
      [ctx.policy.environment, repo.environment],
      {
        DEVCONTOUR_REPOSITORY_ID: repo.id,
        DEVCONTOUR_TASK_ID: work.id,
        DEVCONTOUR_PHASE: 'case',
      },
      ctx.environment ?? process.env,
    );
    const limitMs = gate.timeoutMs * 3 + 120000;
    const deadline = Date.now() + limitMs;
    const signal = AbortSignal.timeout(limitMs);
    await withEnvironment(
      repo.lifecycle ?? ctx.policy.lifecycle,
      dir,
      join(io, 'environment'),
      execution,
      signal,
      async () => {
        const boundary = ctx.boundary();
        await materializeStore(
          {
            policy: ctx.policy,
            root: (id) =>
              ctx.checkout?.(id, 'dependency-store', '') ??
              join(ctx.stateDir, 'dependency-store', id),
            repoPath: (r) => ctx.repoPath(r),
            boundary,
            resourceDatabase: ctx.resourceDatabase ?? defaultResourceDatabase(),
            deadline,
            phaseMs: limitMs,
          },
          { repo, cwd: dir, execution, signal, dir: io },
        );
        await runSteps(repo.prepare, dir, join(io, 'prepare'), execution, signal);
        const request = join(io, 'case.json');
        await writeFile(
          request,
          JSON.stringify({ property: input.property, input: JSON.parse(text) as unknown }),
        );
        for (let i = 0; i < 2; i++) {
          const out = join(io, `result-${i}.json`);
          const started = Date.now();
          const env = { DEVCONTOUR_CASE: request, DEVCONTOUR_CASE_RESULT: out };
          const result = await runCheck(
            { config: ctx.policy },
            {
              argv: gate.command,
              cwd: gate.cwd ? join(dir, gate.cwd) : dir,
              env: {
                ...execution.env,
                ...env,
                HARNESS_CASE: request,
                HARNESS_CASE_RESULT: out,
              },
              redact: execution.redact,
              timeoutMs: gate.timeoutMs,
              signal,
              write: [dir, io],
              readable: boundary.readable,
              controller: boundary.hidden,
              ...(boundary.checkouts?.length ? { checkouts: boundary.checkouts } : {}),
              settingsDir: join(io, `settings-${i}`),
            },
          );
          durations.push(Date.now() - started);
          if (result.timedOut) {
            runs.push({ property: input.property, error: 'timeout' });
            break;
          }
          const raw = await readBounded(out, CASE_RESULT_LIMIT).catch((error: unknown) => {
            if (error instanceof OversizedFile) throw error;
            return 'null';
          });
          const parsed = caseResult.safeParse(JSON.parse(raw));
          runs.push(
            parsed.success ? parsed.data : { property: input.property, error: 'нет результата' },
          );
        }
      },
    );
  } catch (error) {
    return {
      input: text,
      outcome: 'inconclusive',
      reason:
        'проверка не выполнилась: ' +
        (error instanceof Error ? error.message : String(error)).slice(0, 300),
      method,
    };
  } finally {
    await git(repoPath, 'worktree', 'remove', '--force', dir).catch(() => undefined);
    await rm(io, { recursive: true, force: true }).catch(() => undefined);
  }
  const observed = (r: z.infer<typeof caseResult>) => ({
    ...(r.expected !== undefined ? { expected: canonicalJson(r.expected) } : {}),
    ...(r.actual !== undefined ? { actual: canonicalJson(r.actual) } : {}),
    ...(r.equal !== undefined ? { equal: r.equal } : {}),
    repeats: runs.length,
    durationsMs: durations,
  });
  const first = runs[0];
  if (!first || first.error)
    return {
      input: text,
      outcome: 'inconclusive',
      reason:
        first?.error === 'timeout'
          ? 'эталон или реализация не уложились в предел gate'
          : `проверка не дала ответа: ${first?.error ?? 'нет результата'}`,
      method,
      observed: { repeats: runs.length, durationsMs: durations },
    };
  if (first.valid === false)
    return { ...reject('вход вне объявленной области свойства', text), method };
  if (first.oracleError)
    return {
      input: text,
      outcome: 'inconclusive',
      reason: `ошибка эталона: ${first.oracleError.slice(0, 300)}`,
      method,
      observed: observed(first),
    };
  if (runs.length < 2 || runs[1]!.error || canonicalJson(runs[1]) !== canonicalJson(first))
    return {
      input: text,
      outcome: 'inconclusive',
      reason: 'результат не воспроизвёлся при повторе',
      method,
      observed: observed(first),
    };
  const expected = canonicalJson(first.expected);
  if (input.expected != null) {
    let claimed: string | undefined;
    try {
      claimed = canonicalJson(JSON.parse(input.expected));
    } catch {
      claimed = undefined;
    }
    if (claimed !== expected)
      return {
        input: text,
        outcome: 'refuted',
        reason: `ожидание источника ${input.expected.slice(0, 200)} опровергнуто эталоном: ${expected.slice(0, 200)}`,
        method,
        observed: observed(first),
      };
  }
  if (first.equal)
    return {
      input: text,
      outcome: 'refuted',
      reason: 'на исходном SHA реализация совпадает с эталоном: расхождения нет',
      method,
      observed: observed(first),
    };
  return {
    input: text,
    outcome: 'confirmed',
    reason: `эталон дал ${expected.slice(0, 200)}, реализация на ${source.sha.slice(0, 12)} — ${canonicalJson(first.actual).slice(0, 200)}; расхождение воспроизведено дважды`,
    method,
    observed: observed(first),
  };
}
