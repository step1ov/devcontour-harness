import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  contextDigest,
  implementationResultSchema,
  reviewIssues,
  reviewResultSchema,
  sha256,
  type AttemptState,
  type ContextSnapshot,
  type EvidenceRecord,
  type ExecutionPolicy,
  type GatePolicy,
  type RuntimeAdapter,
  type RuntimeName,
  type RuntimeResponse,
  type WorkState,
} from '../contracts/index.ts';
import { git } from '../environment/process.ts';
import { executionEnvironment, runSteps, withEnvironment } from '../environment/lifecycle.ts';
import { redactDeep } from '../environment/redaction.ts';
import { implementationOutputSchema, reviewOutputSchema } from '../agents/schemas.ts';
import { unobservedReview } from '../agents/inspect.ts';
import { runGate } from '../verification/gates.ts';
import { BlockedError, classifyFailure } from './classify.ts';
import { TaskFailure } from './failure.ts';
import type { Engine } from './engine.ts';
import { prompt } from './prompt.ts';

type Repo = ExecutionPolicy['repositories'][number];

export interface RunnerOptions {
  engine: Engine;
  /** Каталог состояния: worktrees, артефакты попыток. Закрыт исполнителю, reviewer и gates. */
  stateDir: string;
  /** Каталог, от которого разрешаются относительные пути репозиториев политики. */
  baseDir: string;
  adapters: Partial<Record<RuntimeName, RuntimeAdapter>>;
  /** Закреплённый контекст поручения; без него — пустой снимок. */
  context?: (work: WorkState) => ContextSnapshot | undefined;
  owner?: string;
  /** Префикс веток попыток; DevContour передаёт свой прежний `devcontour/run-`. */
  branchPrefix?: string;
  /** Внешние значения окружения (секреты политики); по умолчанию — окружение процесса. */
  environment?: NodeJS.ProcessEnv;
}

const ordered = (gates: GatePolicy[], ids: string[]) => {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const out: GatePolicy[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (ids.includes(dep)) visit(dep);
    out.push(byId.get(id)!);
  };
  ids.forEach(visit);
  return out;
};

const within = (path: string, prefixes: string[]) =>
  prefixes.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : p + '/'));

/**
 * Исполнитель очереди. Один действующий controller; попытка проходит
 * реализацию, проверку области, gates и независимое ревью кандидата, затем
 * интеграцию с текущей принятой веткой, gates и ревью integration SHA и
 * приёмку с CAS продвижения target ref внутри транзакции приёмки.
 */
export class Runner {
  readonly owner: string;
  private readonly engine: Engine;
  private readonly policy: ExecutionPolicy;
  private jobs = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private mergeTails = new Map<string, Promise<void>>();

  constructor(readonly options: RunnerOptions) {
    this.engine = options.engine;
    this.policy = options.engine.policy;
    this.owner = options.owner ?? 'harness-' + randomUUID();
  }

  repoPath(repo: Repo) {
    return isAbsolute(repo.path) ? repo.path : resolve(this.options.baseDir, repo.path);
  }
  private repo(id: string) {
    const repo = this.policy.repositories.find((r) => r.id === id);
    if (!repo) throw new Error('Репозиторий не объявлен: ' + id);
    return repo;
  }
  /** Закрыто процессам попытки: состояние controller и исходные checkout; открыт только их `.git`. */
  private boundary() {
    const repos = this.policy.repositories.map((r) => this.repoPath(r));
    return {
      hidden: [this.options.stateDir, ...repos],
      readable: repos.map((r) => join(r, '.git')),
    };
  }

  /** Подготовка репозиториев: целевая ветка существует и не открыта ни в одном worktree. */
  async init() {
    for (const repo of this.policy.repositories) {
      const path = this.repoPath(repo);
      try {
        await git(path, 'rev-parse', '--verify', repo.targetRef);
      } catch {
        await git(path, 'update-ref', repo.targetRef, 'HEAD');
      }
      await this.assertTargetDetached(repo);
    }
  }
  private async assertTargetDetached(repo: Repo) {
    const list = await git(this.repoPath(repo), 'worktree', 'list', '--porcelain');
    if (list.split('\n').includes(`branch ${repo.targetRef}`))
      throw new Error(`Целевая ветка ${repo.targetRef} открыта в worktree; переключите его`);
  }

  get active() {
    return this.jobs.size;
  }

  /** Один шаг: роль controller, recovery, выдача свободных слотов. */
  async tick() {
    if (!this.engine.lead(this.owner)) {
      for (const job of this.jobs.values()) job.controller.abort();
      return;
    }
    await this.recover();
    for (const [id, job] of this.jobs)
      if (this.engine.read((v) => v.attempt(id)?.status) !== 'active') job.controller.abort();
    while (this.jobs.size < this.policy.concurrency) {
      const attempt = this.engine.claim(this.owner);
      if (!attempt) break;
      const controller = new AbortController();
      const promise = this.execute(attempt, controller).finally(() => this.jobs.delete(attempt.id));
      this.jobs.set(attempt.id, { promise, controller });
    }
  }

  /** Вести очередь, пока есть работа, которую можно выдать или довести. */
  async drain() {
    while (true) {
      await this.tick();
      if (!this.jobs.size) break;
      await Promise.all([...this.jobs.values()].map((j) => j.promise));
    }
  }

  /** Штатная остановка: пауза `shutdown`, прерывание попыток, освобождение роли controller. */
  async stop() {
    this.engine.pause('shutdown');
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.jobs.values()].map((j) => j.promise));
    this.engine.release(this.owner);
  }

  /**
   * Recovery после падения: истёкшая попытка с сохранённым integration SHA,
   * который уже в target ref, принимается заново проверкой всех evidence;
   * иначе она истекает с отказом окружения. Повторный recovery ничего не
   * дублирует: принятая попытка уже не активна.
   */
  async recover() {
    const now = this.engine.clock();
    const stale = this.engine.read((v) =>
      v.attempts().filter((a) => a.status === 'active' && a.leaseUntil <= now),
    );
    for (const a of stale) {
      if (!a.integrationSha) continue;
      const repo = this.repo(a.repositoryId);
      try {
        await git(
          this.repoPath(repo),
          'merge-base',
          '--is-ancestor',
          a.integrationSha,
          repo.targetRef,
        );
        const adopted = this.engine.adopt(a.id, this.owner);
        this.engine.finish(a.id, adopted.token, a.integrationSha);
      } catch (error) {
        this.engine.rejectRecovery(a.id, error instanceof Error ? error.message : String(error));
      }
    }
    this.engine.expire();
  }

  private environment(attempt: AttemptState, phase: string, cwd: string) {
    const repo = this.repo(attempt.repositoryId);
    return executionEnvironment(
      [this.policy.environment, repo.environment],
      {
        DEVCONTOUR_REPOSITORY_ID: repo.id,
        DEVCONTOUR_RUN_ID: attempt.id,
        DEVCONTOUR_TASK_ID: attempt.workId,
        DEVCONTOUR_PHASE: phase,
        DEVCONTOUR_RESOURCES_JSON: JSON.stringify(attempt.resources ?? []),
        DEVCONTOUR_DEPENDENCIES_JSON: JSON.stringify(attempt.dependencies ?? []),
        DEVCONTOUR_COMPONENTS_JSON: JSON.stringify({ [repo.id]: cwd }),
      },
      this.options.environment ?? process.env,
    );
  }

  private async call(
    adapter: RuntimeAdapter,
    input: {
      task: 'implement' | 'review-code';
      attempt: AttemptState;
      cwd: string;
      prompt: string;
      dir: string;
      env: NodeJS.ProcessEnv;
      secrets: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<RuntimeResponse> {
    const review = input.task !== 'implement';
    const role = this.policy.roles[(await this.workOf(input.attempt)).order.role]!;
    const binding = review
      ? {
          runtime: input.attempt.reviewer,
          ...(input.attempt.reviewerModel ? { model: input.attempt.reviewerModel } : {}),
          ...(input.attempt.reviewerEffort
            ? { effort: input.attempt.reviewerEffort as 'high' }
            : {}),
          ...((role.review ?? this.policy.review.code).reviewer.toolProfile
            ? { toolProfile: (role.review ?? this.policy.review.code).reviewer.toolProfile }
            : {}),
        }
      : role.writer;
    const boundary = this.boundary();
    const response = await adapter.invoke(
      {
        callId: randomUUID(),
        task: input.task,
        binding,
        cwd: input.cwd,
        prompt: input.prompt,
        outputSchema: review ? reviewOutputSchema : implementationOutputSchema,
        session: { kind: 'fresh' },
        sandbox: {
          mode: this.policy.isolation.mode,
          writable: review ? [] : [input.cwd],
          denied: boundary.hidden,
          readable: [input.cwd, ...boundary.readable],
          network: { domains: this.policy.isolation.domains },
        },
        timeoutMs: this.policy.runTimeoutMs,
        env: Object.fromEntries(
          Object.entries(input.env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        artifactDir: input.dir,
        secrets: [...input.secrets],
      },
      signal,
    );
    if (response.model && !review && response.model !== input.attempt.model)
      this.engine.update(input.attempt.id, input.attempt.token, 'run.model', {
        model: response.model,
      });
    if (response.status === 'unavailable')
      throw new BlockedError(
        `${adapter.runtime}: runtime недоступен${response.diagnostics.reason ? ': ' + response.diagnostics.reason : ''}`,
      );
    if (response.status === 'timeout')
      throw new TaskFailure('timeout', `${adapter.runtime}: исчерпан лимит времени прогона`);
    if (response.status === 'cancelled') throw new Error(`${adapter.runtime}: прогон прерван`);
    if (response.status === 'failed') {
      const message = `${adapter.runtime}: runtime завершился отказом${response.diagnostics.reason ? ': ' + response.diagnostics.reason : ''}`;
      throw new TaskFailure(
        classifyFailure(undefined, message) === 'unknown'
          ? review
            ? 'review'
            : 'unknown'
          : classifyFailure(undefined, message),
        message,
      );
    }
    return response;
  }

  private workOf(attempt: AttemptState) {
    return Promise.resolve(this.engine.read((v) => v.work(attempt.workId)!));
  }
  private history(attempt: AttemptState) {
    return this.engine.read((v) => v.attempts(attempt.workId));
  }
  private adapter(runtime: RuntimeName) {
    const adapter = this.options.adapters[runtime];
    if (!adapter) throw new BlockedError(`Runtime ${runtime} не подключён`);
    return adapter;
  }

  /** Область записи кандидата: защищённые пути, пустой результат, выход за область поручения и роли. */
  private async assertScope(work: WorkState, repo: Repo, cwd: string) {
    const changed = (await git(cwd, 'diff', '--cached', '--no-renames', '--name-only', '-z'))
      .split('\0')
      .filter(Boolean);
    const protectedList = [...repo.protectedPaths, ...repo.generatedPaths];
    const forbidden = changed.filter((p) => within(p, protectedList));
    if (forbidden.length)
      throw new TaskFailure(
        'scope-violation',
        `Изменены защищённые файлы: ${forbidden.join(', ')}`,
      );
    if (!changed.length)
      throw new TaskFailure(
        'empty-result',
        'Изменений нет: поручение отчиталось о выполнении пустым коммитом',
      );
    const role = this.policy.roles[work.order.role]?.writePaths;
    const outside = changed.filter(
      (p) => !within(p, work.order.writeScope) || (role && !within(p, role)),
    );
    if (outside.length)
      throw new TaskFailure(
        'scope-violation',
        'Изменены файлы вне области поручения/роли: ' + outside.join(', '),
      );
  }

  private async execute(claimed: AttemptState, controller: AbortController) {
    const signal = controller.signal;
    let attempt = claimed;
    const repo = this.repo(attempt.repositoryId);
    const repoPath = this.repoPath(repo);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const rearm = () => {
      clearTimeout(timeout);
      timeout = setTimeout(
        () => controller.abort(new DOMException('Исчерпан лимит времени прогона', 'TimeoutError')),
        this.policy.runTimeoutMs,
      );
    };
    rearm();
    let heartbeatCause: string | undefined;
    const heartbeat = setInterval(
      () => {
        try {
          this.engine.heartbeat(attempt.id, attempt.token);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          heartbeatCause ??= reason;
          try {
            this.engine.heartbeatFailed(attempt.id, attempt.token, reason);
          } catch {
            /* Хранилище недоступно: причина останется в отказе. */
          }
          controller.abort();
        }
      },
      Math.max(1000, this.policy.leaseMs / 3),
    );
    const cwd = join(this.options.stateDir, 'worktrees', attempt.id);
    const integrationCwd = cwd + '-integration';
    const artifacts = join(this.options.stateDir, 'artifacts', attempt.id);
    const worktrees: string[] = [];
    try {
      const work = await this.workOf(attempt);
      const context = this.options.context?.(work);
      if (context)
        // Попытка закрепляет снимок контекста: writer и оба reviewer видят одни и те же байты.
        this.engine.update(attempt.id, attempt.token, 'run.context', {
          contextSnapshot: contextDigest(context),
          context: context.sources.map((s) => ({
            id: s.id,
            version: s.version,
            repositoryId: s.repositoryId ?? work.order.repositoryId,
            revision: s.revision ?? s.digest,
            digest: s.hostDigest ?? s.digest,
          })),
        });
      const base = await git(repoPath, 'rev-parse', repo.targetRef);
      await mkdir(join(this.options.stateDir, 'worktrees'), { recursive: true });
      await git(
        repoPath,
        'worktree',
        'add',
        '-b',
        `${this.options.branchPrefix ?? 'harness/run-'}${attempt.id}`,
        cwd,
        base,
      );
      worktrees.push(cwd);
      this.engine.phase(attempt.id, attempt.token, 'running', { baseSha: base, worktree: cwd });
      attempt = { ...attempt, baseSha: base, worktree: cwd };
      const gates = ordered(repo.gates, attempt.requiredGates ?? repo.gates.map((g) => g.id));
      const execution = this.environment(attempt, 'candidate', cwd);
      const candidate = await withEnvironment(
        repo.lifecycle,
        cwd,
        join(artifacts, 'candidate', 'environment'),
        execution,
        signal,
        async () => {
          await runSteps(
            repo.prepare,
            cwd,
            join(artifacts, 'candidate', 'prepare'),
            execution,
            signal,
          );
          const dir = join(artifacts, 'implementation');
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, 'work.json'), JSON.stringify(work.order, null, 2));
          const response = await this.call(
            this.adapter(attempt.runtime),
            {
              task: 'implement',
              attempt,
              cwd,
              dir,
              env: execution.env,
              secrets: execution.redact.secrets ?? [],
              prompt: prompt({
                work,
                attempt,
                history: this.history(attempt),
                context,
                gates: gates.map((g) => ({ id: g.id, command: g.command })),
              }),
            },
            signal,
          );
          const result = implementationResultSchema.safeParse(response.output);
          if (!result.success)
            throw new Error('Ответ исполнителя вне схемы: ' + result.error.issues[0]?.message);
          if (!result.data.completed) throw new Error('Исполнитель сообщил о незавершённой работе');
          this.engine.heartbeat(attempt.id, attempt.token);
          signal.throwIfAborted();
          if ((await git(cwd, 'rev-parse', 'HEAD')) !== base)
            throw new TaskFailure(
              'scope-violation',
              'Исполнитель изменил HEAD; интеграцией владеет harness',
            );
          await git(cwd, 'add', '-A');
          await this.assertScope(work, repo, cwd);
          await git(
            cwd,
            '-c',
            'core.hooksPath=/dev/null',
            'commit',
            '--no-gpg-sign',
            '-q',
            '-m',
            `${work.id}: ${work.order.title}`,
          );
          const sha = await git(cwd, 'rev-parse', 'HEAD');
          rearm();
          this.engine.phase(attempt.id, attempt.token, 'verifying', { candidateSha: sha });
          for (const gate of gates)
            await this.gate(attempt, cwd, sha, 'candidate', gate, artifacts, signal, execution);
          rearm();
          this.engine.phase(attempt.id, attempt.token, 'reviewing');
          await this.review(attempt, work, cwd, base, sha, 'candidate', artifacts, signal, context);
          return sha;
        },
      );
      attempt = { ...attempt, candidateSha: candidate };
      const previous = this.mergeTails.get(repo.id) ?? Promise.resolve();
      let unlock!: () => void;
      this.mergeTails.set(repo.id, new Promise<void>((r) => (unlock = r)));
      await previous;
      try {
        rearm();
        await this.integrate(
          attempt,
          work,
          repo,
          integrationCwd,
          worktrees,
          artifacts,
          signal,
          context,
        );
      } finally {
        unlock();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const kind = classifyFailure(error, message);
        this.engine.fail(attempt.id, attempt.token, message, {
          kind,
          blocked:
            (error instanceof BlockedError || kind === 'provider-auth') && !attempt.candidateSha,
          ...(heartbeatCause ? { heartbeatCause } : {}),
        });
      } catch {
        // Отменённая или потерявшая владение попытка не публикует поздний отказ.
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      // Рабочие деревья попытки убираются; ветка попытки и объекты остаются —
      // по ним recovery и следующая попытка видят кандидата.
      for (const dir of worktrees)
        await git(repoPath, 'worktree', 'remove', '--force', dir).catch(() => undefined);
    }
  }

  private async gate(
    attempt: AttemptState,
    cwd: string,
    sha: string,
    phase: EvidenceRecord['phase'],
    gate: GatePolicy,
    artifacts: string,
    signal: AbortSignal,
    execution: ReturnType<typeof executionEnvironment>,
  ) {
    await runGate({
      policy: this.policy,
      record: (e) => this.engine.evidence(attempt.id, attempt.token, e),
      cwd,
      sha,
      phase,
      gate,
      artifactDir: join(artifacts, phase),
      signal,
      execution,
      boundary: this.boundary(),
    });
  }

  /**
   * Независимое ревью точного SHA. Отказ — отсутствие одобрения, блокирующая
   * находка, ответ вне схемы, изменение дерева или HEAD reviewer-ом. Ответ
   * reviewer маскируется целиком перед записью.
   */
  private async review(
    attempt: AttemptState,
    work: WorkState,
    cwd: string,
    base: string,
    sha: string,
    phase: EvidenceRecord['phase'],
    artifacts: string,
    signal: AbortSignal,
    context?: ContextSnapshot,
  ) {
    const dir = join(artifacts, phase, 'review');
    await mkdir(dir, { recursive: true });
    const diff = await git(cwd, 'diff', '--no-ext-diff', '--no-textconv', base, sha);
    if (diff.length > 1_000_000)
      throw new TaskFailure(
        'review',
        'Diff превышает лимит независимого ревью; разделите поручение',
      );
    const status = await git(cwd, 'status', '--porcelain', '--untracked-files=all');
    const execution = this.environment(attempt, phase, cwd);
    const repo = this.repo(attempt.repositoryId);
    const gates = ordered(repo.gates, attempt.requiredGates ?? repo.gates.map((g) => g.id));
    const response = await this.call(
      this.adapter(attempt.reviewer),
      {
        task: 'review-code',
        attempt,
        cwd,
        dir,
        env: execution.env,
        secrets: execution.redact.secrets ?? [],
        prompt: prompt({
          work,
          attempt: { ...attempt, baseSha: base },
          history: this.history(attempt),
          context,
          gates: gates.map((g) => ({ id: g.id, command: g.command })),
          review: { sha, phase, diff },
        }),
      },
      signal,
    );
    const redact = execution.redact;
    const parsed = reviewResultSchema.safeParse(response.output);
    const clean =
      (await git(cwd, 'status', '--porcelain', '--untracked-files=all')) === status &&
      !(await git(cwd, 'status', '--porcelain', '--untracked-files=no')) &&
      (await git(cwd, 'rev-parse', 'HEAD')) === sha;
    const issues = parsed.success
      ? reviewIssues(parsed.data, [])
      : ['Ответ ревью вне схемы: ' + (parsed.error.issues[0]?.message ?? '')];
    const passed = clean && parsed.success && parsed.data.approved && !issues.length;
    const inspection = response.inspection ?? unobservedReview();
    const record = redactDeep(
      {
        ...(parsed.success
          ? parsed.data
          : { approved: false, summary: 'ответ вне схемы', findings: [] }),
        inspection,
        issues,
      },
      redact,
    );
    const log = join(dir, 'review.json');
    await writeFile(log, JSON.stringify(record, null, 2));
    const reason = !clean
      ? 'reviewer изменил дерево или HEAD'
      : issues.join('; ') || record.summary;
    this.engine.evidence(attempt.id, attempt.token, {
      kind: 'review',
      inspection: record.inspection,
      phase,
      sha,
      gate: 'independent-review',
      passed,
      command: [attempt.reviewer, 'review-code'],
      exitCode: passed ? 0 : 1,
      log,
      digest: sha256(JSON.stringify(record)),
      summary: redact(`[${inspection.mode}] ${passed ? record.summary : reason}`).slice(0, 4000),
      findings: (record.findings ?? []).map((f) => ({
        severity: f.severity,
        message: f.message,
        path: f.path ?? null,
        line: f.line ?? null,
      })),
    });
    if (!passed)
      throw new TaskFailure('review', 'Независимое ревью отклонило результат: ' + redact(reason));
  }

  private async integrate(
    attempt: AttemptState,
    work: WorkState,
    repo: Repo,
    cwd: string,
    worktrees: string[],
    artifacts: string,
    signal: AbortSignal,
    context?: ContextSnapshot,
  ) {
    this.engine.heartbeat(attempt.id, attempt.token);
    signal.throwIfAborted();
    const repoPath = this.repoPath(repo);
    await this.assertTargetDetached(repo);
    const base = await git(repoPath, 'rev-parse', repo.targetRef);
    await git(repoPath, 'worktree', 'add', '--detach', cwd, base);
    worktrees.push(cwd);
    try {
      await git(
        cwd,
        '-c',
        'core.hooksPath=/dev/null',
        'merge',
        '--no-ff',
        '--no-edit',
        '--no-gpg-sign',
        attempt.candidateSha!,
      );
    } catch (error) {
      throw new TaskFailure('merge', error instanceof Error ? error.message : String(error));
    }
    const sha = await git(cwd, 'rev-parse', 'HEAD');
    this.engine.phase(attempt.id, attempt.token, 'integrating', { integrationSha: sha });
    const gates = ordered(repo.gates, attempt.requiredGates ?? repo.gates.map((g) => g.id));
    const execution = this.environment(attempt, 'integration', cwd);
    await withEnvironment(
      repo.lifecycle,
      cwd,
      join(artifacts, 'integration', 'environment'),
      execution,
      signal,
      async () => {
        await runSteps(
          repo.prepare,
          cwd,
          join(artifacts, 'integration', 'prepare'),
          execution,
          signal,
        );
        for (const gate of gates)
          await this.gate(attempt, cwd, sha, 'integration', gate, artifacts, signal, execution);
        await this.review(
          attempt,
          work,
          cwd,
          attempt.baseSha!,
          sha,
          'integration',
          artifacts,
          signal,
          context,
        );
      },
    );
    if (
      (await git(cwd, 'rev-parse', 'HEAD')) !== sha ||
      (await git(cwd, 'status', '--porcelain', '--untracked-files=no'))
    )
      throw new Error('Очистка окружения изменила проверенный код');
    signal.throwIfAborted();
    await this.assertTargetDetached(repo);
    // Fencing, CAS продвижения и приёмка — одна транзакция. Если процесс упадёт
    // после update-ref, recovery сверит сохранённые evidence до приёмки.
    try {
      this.engine.finish(attempt.id, attempt.token, sha, () => {
        execFileSync('git', ['update-ref', repo.targetRef, sha, base], {
          cwd: repoPath,
          stdio: 'pipe',
        });
      });
    } catch (error) {
      const text =
        error instanceof Error
          ? error.message + String((error as { stderr?: Buffer | string }).stderr ?? '')
          : String(error);
      if (/cannot lock ref|is at .* but expected|reference already exists/i.test(text))
        throw new TaskFailure(
          'stale-base',
          `Целевая ветка ${repo.targetRef} продвинулась после интеграции; повтор начнётся от актуальной базы`,
        );
      throw error;
    }
  }
}
