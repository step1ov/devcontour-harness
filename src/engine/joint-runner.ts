import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  digestOf,
  type ExecutionPolicy,
  type JointVerification,
  type JointVerificationState,
} from '../contracts/index.ts';
import { git } from '../environment/process.ts';
import { chooseCheckoutRoot } from '../environment/checkout-root.ts';
import { credentialPaths } from '../environment/isolation.ts';
import {
  CleanupFailure,
  availableRedactor,
  executionEnvironment,
  withEnvironment,
} from '../environment/lifecycle.ts';
import { composeRedactors, type Redactor } from '../environment/redaction.ts';
import { defaultResourceDatabase, withResources } from '../environment/resources.ts';
import { dependencyStoreRoot, materializeStore } from '../verification/dependency-store.ts';
import { junitSummary, prepareReportPath, runCheck } from '../verification/gates.ts';
import { orderedWorkspaceGates, publicJoint } from '../verification/joint.ts';
import type { Engine } from './engine.ts';

export interface JointRunnerOptions {
  engine: Engine;
  /** Каталог состояния: здесь снимки компонентов, manifest, логи и отчёты. */
  stateDir: string;
  baseDir: string;
  environment?: NodeJS.ProcessEnv;
  resourceDatabase?: string;
  /**
   * Корень снимков компонентов (`<checkoutRoot>/.joint/<id>/components`: ID репозитория с точки не начинается); без
   * него — `chooseCheckoutRoot` по каталогу состояния и каталогу проверки.
   */
  checkoutRoot?: string;
  /** Каталог проверки (по умолчанию `<stateDir>/joint/<id>`). */
  directory?: (verification: JointVerificationState) => string;
  /** Дополнительные переменные окружения gates этой проверки (у хоста — его идентификаторы). */
  env?: (verification: JointVerificationState) => Record<string, string>;
  /** Подготовка хоста перед снимками (например, резерв репозиториев). */
  prepare?: (signal: AbortSignal) => Promise<void>;
}

type Repo = ExecutionPolicy['repositories'][number];

/**
 * Исполнение совместной проверки: снимки target ref всех репозиториев
 * (результат каждого поручения набора должен в них входить), manifest,
 * gates уровня workspace в песочнице проверок, сверка целостности после
 * каждого gate. Записи — только через fencing движка; отказ сохраняется с
 * маской окружений всех репозиториев.
 */
export class JointRunner {
  readonly engine: Engine;
  private readonly policy: ExecutionPolicy;
  constructor(readonly options: JointRunnerOptions) {
    this.engine = options.engine;
    this.policy = options.engine.policy;
  }

  private repoPath(repo: Repo) {
    return isAbsolute(repo.path) ? repo.path : resolve(this.options.baseDir, repo.path);
  }

  /** Начать и провести проверку набора поручений. */
  async verify(workIds: string[], options: { baseline?: string; signal?: AbortSignal } = {}) {
    const v = this.engine.jointStart({
      workIds,
      ...(options.baseline ? { baseline: options.baseline } : {}),
    });
    return this.execute(v, options.signal);
  }

  /**
   * Провести уже начатую проверку. Хост, начинающий проверку в своей
   * транзакции (с продуктовыми условиями), передаёт её сюда.
   */
  run(v: JointVerificationState, signal?: AbortSignal) {
    return this.execute(v, signal);
  }

  private async execute(
    v: JointVerificationState,
    outer?: AbortSignal,
  ): Promise<JointVerification> {
    const controller = new AbortController();
    const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), this.policy.runTimeoutMs);
    const heartbeat = setInterval(
      () => {
        try {
          this.engine.jointHeartbeat(v.id, v.token);
        } catch {
          controller.abort();
        }
      },
      Math.max(1000, this.policy.leaseMs / 3),
    );
    const dir = this.options.directory?.(v) ?? join(this.options.stateDir, 'joint', v.id);
    // Снимки компонентов — вне дерева, если каталог проверки лежит внутри
    // репозитория: gate, ищущий конфигурацию вверх, не упирается в закрытый checkout.
    const placement = chooseCheckoutRoot({
      stateDirs: [this.options.stateDir, dir],
      repositories: this.policy.repositories.map((r) => this.repoPath(r)),
      hidden: credentialPaths(),
      ...(this.options.checkoutRoot ? { configured: this.options.checkoutRoot } : {}),
    });
    const components = placement.root
      ? join(placement.root, '.joint', v.id, 'components')
      : join(dir, 'components');
    const worktrees: { repo: string; cwd: string }[] = [];
    const source = this.options.environment ?? process.env;
    // Незавершённая очистка окружения оставляет снимки: их разбирает cleanup.
    let preserve = false;
    try {
      return await withResources(
        {
          resources: this.policy.resources,
          leaseMs: this.policy.leaseMs,
          resourceDatabase: this.options.resourceDatabase ?? defaultResourceDatabase(),
        },
        [...new Set(this.policy.workspaceGates.flatMap((g) => g.resources ?? []))],
        `${this.options.stateDir}:${v.id}`,
        signal,
        async (signal, resources) => {
          await this.options.prepare?.(signal);
          // Каталог проверки (impact, manifest, логи) — и тогда, когда
          // компоненты лежат под корнем вне дерева.
          await mkdir(dir, { recursive: true });
          await mkdir(components, { recursive: true });
          const works = this.engine.read((view) => v.workIds.map((id) => view.work(id)!));
          const manifest: NonNullable<JointVerification['manifest']> = {};
          const paths: Record<string, string> = {};
          for (const repo of this.policy.repositories) {
            const path = this.repoPath(repo);
            const sha = await git(path, 'rev-parse', repo.targetRef);
            // Результат каждого поручения набора — в проверяемой комбинации.
            for (const w of works.filter((w) => w.order.repositoryId === repo.id))
              await git(path, 'merge-base', '--is-ancestor', w.resultSha!, sha).catch(() => {
                throw new Error(`Результат ${w.id} отсутствует в ${repo.targetRef} ${repo.id}`);
              });
            const cwd = join(components, repo.id);
            await git(path, 'worktree', 'add', '--detach', cwd, sha);
            worktrees.push({ repo: path, cwd });
            manifest[repo.id] = { sha, tree: await git(cwd, 'rev-parse', 'HEAD^{tree}') };
            paths[repo.id] = await realpath(cwd);
          }
          this.engine.jointHeartbeat(v.id, v.token);
          const pinned = this.engine.jointManifest(v.id, v.token, manifest);
          const impact = pinned.impact;
          await writeFile(join(dir, 'impact.json'), JSON.stringify(impact, null, 2));
          const manifestPath = join(dir, 'manifest.json');
          const manifestContent = JSON.stringify(
            {
              verificationId: v.id,
              digest: digestOf(manifest),
              components: Object.fromEntries(
                Object.entries(manifest).map(([id, m]) => [id, { ...m, path: paths[id] }]),
              ),
            },
            null,
            2,
          );
          await writeFile(manifestPath, manifestContent);
          const captured: { path: string; digest: string }[] = [];
          // Целостность после каждого gate: manifest, уже снятые artifacts и
          // исходники всех компонентов неизменны.
          const clean = async () => {
            if ((await readFile(manifestPath, 'utf8')) !== manifestContent)
              throw new Error('Проверка изменила manifest');
            for (const artifact of captured)
              if (
                createHash('sha256')
                  .update(await readFile(artifact.path))
                  .digest('hex') !== artifact.digest
              )
                throw new Error('Изменён уже проверенный artifact: ' + artifact.path);
            for (const [id, cwd] of Object.entries(paths))
              if (
                (await git(cwd, 'rev-parse', 'HEAD')) !== manifest[id]!.sha ||
                (await git(cwd, 'status', '--porcelain', '--untracked-files=no'))
              )
                throw new Error(`Проверка изменила исходники компонента ${id}`);
          };
          const common = {
            ...this.options.env?.(v),
            DEVCONTOUR_RUN_ID: v.id,
            DEVCONTOUR_RESOURCES_JSON: JSON.stringify(resources),
            DEVCONTOUR_MANIFEST_PATH: manifestPath,
            DEVCONTOUR_COMPONENTS_JSON: JSON.stringify(paths),
          };
          const first = paths[this.policy.repositories[0]!.id]!;
          await withEnvironment(
            this.policy.workspaceLifecycle,
            first,
            join(dir, 'environment'),
            executionEnvironment([this.policy.environment], common, source),
            signal,
            async () => {
              const gates = orderedWorkspaceGates(this.policy.workspaceGates).filter((g) =>
                impact.gateIds.includes(g.id),
              );
              // У совместной проверки нет `prepare`: хранилище разворачивается
              // здесь, в компоненты, чьи gates будут исполняться.
              const stores: Record<string, NodeJS.ProcessEnv> = {};
              for (const repo of this.policy.repositories) {
                if (!repo.dependencyStore || !gates.some((g) => g.repositoryId === repo.id))
                  continue;
                const receipt = await materializeStore(
                  {
                    policy: this.policy,
                    root: (id) => dependencyStoreRoot(placement, this.options.stateDir, id),
                    repoPath: (r) => this.repoPath(r),
                    boundary: {
                      hidden: [
                        this.options.stateDir,
                        ...this.policy.repositories.map((r) => this.repoPath(r)),
                      ],
                      ...(placement.root ? { checkouts: [placement.root] } : {}),
                    },
                    resourceDatabase: this.options.resourceDatabase ?? defaultResourceDatabase(),
                  },
                  {
                    repo,
                    cwd: paths[repo.id]!,
                    execution: executionEnvironment(
                      [this.policy.environment, repo.environment],
                      common,
                      source,
                    ),
                    signal,
                    dir: join(dir, 'dependency-store', repo.id),
                  },
                );
                stores[repo.id] = receipt!.env;
              }
              for (const gate of gates) {
                if (signal.aborted) throw new Error('Совместная проверка отменена');
                const cwd = paths[gate.repositoryId];
                if (!cwd) throw new Error('Неизвестный repositoryId совместной проверки');
                const repo = this.policy.repositories.find((r) => r.id === gate.repositoryId);
                const profiles = [this.policy.environment, repo?.environment];
                const logPath = join(dir, gate.id + '.log');
                let log = '',
                  passed = false,
                  exitCode = -1,
                  summary = '';
                const artifacts: JointVerification['evidence'][number]['artifacts'] = [];
                const startedAt = Date.now();
                // Окружение и маска gate — одни на исполнение и на сохранение.
                // Незаданный секрет — отказ gate с evidence, а не исключение до
                // записи доказательства.
                let redact: Redactor = availableRedactor(profiles, source);
                try {
                  const environment = executionEnvironment(profiles, { ...common }, source);
                  redact = environment.redact;
                  const reportPath = gate.report
                    ? await prepareReportPath(cwd, gate.report.path, 'Report выходит из компонента')
                    : undefined;
                  const gateCwd = gate.cwd ? await realpath(resolve(cwd, gate.cwd)) : cwd;
                  if (gateCwd !== cwd && !gateCwd.startsWith(cwd + sep))
                    throw new Error('Gate cwd выходит из компонента');
                  // Та же песочница, что у проверок поручений: пишет только в
                  // свой компонент, читает снимки компонентов и manifest;
                  // состояние контура и рабочие каталоги закрыты.
                  const result = await runCheck(
                    { config: this.policy },
                    {
                      argv: gate.command,
                      cwd: gateCwd,
                      signal,
                      timeoutMs: gate.timeoutMs,
                      write: [cwd],
                      readable: [
                        ...Object.values(paths),
                        manifestPath,
                        ...this.policy.repositories.map((r) => join(this.repoPath(r), '.git')),
                      ],
                      controller: [
                        this.options.stateDir,
                        ...this.policy.repositories.map((r) => this.repoPath(r)),
                      ],
                      ...(placement.root ? { checkouts: [placement.root] } : {}),
                      settingsDir: join(dir, gate.id),
                      env: {
                        ...environment.env,
                        ...stores[gate.repositoryId],
                        ...(reportPath
                          ? { DEVCONTOUR_REPORT_PATH: reportPath, HARNESS_REPORT_PATH: reportPath }
                          : {}),
                      },
                      redact,
                    },
                  );
                  exitCode = result.code;
                  log = result.stdout + '\n' + result.stderr;
                  if (result.code || result.timedOut || signal.aborted)
                    throw new Error(
                      `Gate ${gate.id}: exit=${result.code}; timeout=${result.timedOut}`,
                    );
                  if (reportPath) {
                    if (!(await realpath(reportPath)).startsWith(cwd + sep))
                      throw new Error('Report выходит из компонента');
                    const xml = await readFile(reportPath, 'utf8');
                    const counts = junitSummary(xml, redact);
                    await writeFile(join(dir, gate.id + '.xml'), redact(xml));
                    summary = `${counts.tests} tests, ${counts.failures} failures, ${counts.skipped} skipped`;
                    if (!counts.tests || counts.failures || counts.skipped)
                      throw new Error(summary);
                  } else summary = 'Команда завершилась успешно';
                  for (const path of gate.artifacts) {
                    const resolved = await realpath(resolve(cwd, path));
                    if (!resolved.startsWith(cwd + sep))
                      throw new Error('Artifact выходит из компонента');
                    const hash = createHash('sha256')
                      .update(await readFile(resolved))
                      .digest('hex');
                    artifacts.push({ path: `${gate.repositoryId}/${path}`, digest: hash });
                    captured.push({ path: resolved, digest: hash });
                  }
                  await clean();
                  passed = true;
                } catch (error) {
                  summary = redact(error instanceof Error ? error.message : String(error));
                  log += '\n' + summary;
                }
                log = redact(log);
                await writeFile(logPath, log);
                const evidence = {
                  gate: gate.id,
                  command: gate.command.map(redact),
                  passed,
                  exitCode,
                  log: logPath,
                  digest: createHash('sha256').update(log).digest('hex'),
                  summary: redact(summary).slice(0, 4000),
                  artifacts,
                  durationMs: Date.now() - startedAt,
                };
                this.engine.jointEvidence(v.id, v.token, evidence);
                if (!passed) throw new Error(evidence.summary);
              }
            },
          );
          await clean();
          this.engine.jointHeartbeat(v.id, v.token);
          return this.engine.jointFinish(v.id, v.token);
        },
      );
    } catch (error) {
      preserve = error instanceof CleanupFailure;
      // Ошибка сохраняется с маской окружений всех репозиториев: секрет любого
      // из них мог в неё попасть. Незаданный секрет сам бывает причиной.
      const redact = composeRedactors(
        availableRedactor([this.policy.environment], source),
        ...this.policy.repositories.map((r) =>
          availableRedactor([this.policy.environment, r.environment], source),
        ),
      );
      const message = redact(error instanceof Error ? error.message : String(error));
      this.engine.jointFail(v.id, v.token, message);
      const failed = this.engine.read((view) => view.verification(v.id));
      if (failed?.status === 'failed') return publicJoint(failed);
      throw error instanceof Error ? Object.assign(error, { message }) : new Error(message);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (!preserve) {
        for (const w of worktrees)
          await git(w.repo, 'worktree', 'remove', '--force', w.cwd).catch(() => undefined);
        // Убирается только каталог, созданный здесь: в каталоге состояния или
        // под корнем вне дерева.
        const owned = placement.root ?? this.options.stateDir;
        if (components.startsWith(owned + sep))
          await rm(placement.root ? dirname(components) : components, {
            recursive: true,
            force: true,
          }).catch(() => undefined);
      }
    }
  }
}
