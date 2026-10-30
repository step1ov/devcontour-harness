/* eslint-disable @typescript-eslint/no-floating-promises --
 * `test()` из node:test регистрирует тест; его Promise ждёт сам runner.
 */
/**
 * Набор проверки коннектора — **fixture и контрактные тесты, не рабочий
 * путь**. Содержит:
 *
 * - `fakeSuiteBackend()` — подделку backend задач (`FakeRelayTransport`) с
 *   общим файлом состояния (несколько процессов);
 * - `faultyTransport()` — точки отказа вокруг любого транспорта;
 * - `connectorSuite(backend)` — общий набор W02–W05, D01–D06, R04, который
 *   запускается и на подделке, и на настоящих Relay v1/Relay-2 (`SuiteBackend`
 *   адаптера). Crash/restart и гонки владельцев — в **новых процессах**
 *   (`testing-worker.ts`) над тем же каталогом состояния; синхронизация —
 *   явными барьерами с конечными сроками, уборка — в `finally`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HarnessError,
  executionPolicySchema,
  type AttemptState,
  type ExecutionPolicy,
  type RuntimeAdapter,
  type RuntimeName,
  type RuntimeRequest,
  type RuntimeResponse,
  type WorkState,
} from '../../contracts/index.ts';
import { Harness } from '../../control/harness.ts';
import {
  orderIdOf,
  parseConfig,
  connectorIdOf,
  type ConnectorConfigInput,
  type CriterionMapping,
  type LoadedConfig,
} from './config.ts';
import { Connector, openConnector } from './commands.ts';
import { markerOf } from './steps.ts';
import {
  FakeAdmin,
  FakeRelayTransport,
  FileBarrier,
  emptyFakeState,
  faultyTransport,
  fileBackend,
  type FaultRule,
} from './fake.ts';
import type { ProviderId, RelayTransport, TaskColumn } from './transport.ts';

export {
  FakeAdmin,
  FakeRelayTransport,
  FileBarrier,
  LocalBarrier,
  emptyFakeState,
  faultyTransport,
  fileBackend,
  memoryBackend,
  type Barrier,
  type FakeBackend,
  type FakeState,
  type FaultAction,
  type FaultRule,
} from './fake.ts';

/* ------------------------------------------------------------------ */
/* Договор backend набора                                              */
/* ------------------------------------------------------------------ */

/** Действия другого участника прямо в backend (постановка задач, правки, перехват). */
export interface SuiteAdmin {
  createTask(input: {
    title: string;
    description: string;
    column?: TaskColumn;
    criteria?: { title: string; summary?: string }[];
    dependencies?: string[];
    parentId?: string;
  }): Promise<{ id: string; key: string; criteria: string[] }>;
  updateTask(id: string, patch: { title?: string; description?: string }): Promise<void>;
  updateCriterion(id: string, criterionId: string, title: string): Promise<void>;
  completeCriterion(id: string, criterionId: string, completed?: boolean): Promise<void>;
  addDocument(taskId: string, doc: { name: string; body: string }): Promise<{ id: string }>;
  updateDocument(id: string, body: string): Promise<void>;
  addDependency(id: string, dependsOn: string): Promise<void>;
  /** Перемещение с done guards backend (как у человека). */
  move(id: string, column: TaskColumn): Promise<void>;
  /** Комментарий другого участника (может содержать любой текст, включая маркер). */
  comment(id: string, body: string): Promise<void>;
  /** Перехват открытой сессии истории другим владельцем. */
  takeover(sessionId: string): Promise<void>;
}

/** Как воссоздать транспорт в другом процессе (`testing-worker.ts`). */
export type WorkerTransport =
  /** Подделка над общим файлом состояния. */
  | { kind: 'fake'; file: string; provider: ProviderId; actor: string }
  /** Настоящий адаптер по конфигурации коннектора (`createTransportFor`). */
  | { kind: 'config' };

export interface SuiteProject {
  provider: ProviderId;
  projectId: string;
  actor: string;
  /** Поле `relay` конфигурации коннектора (без projectId/actor). */
  relay: Record<string, unknown>;
  /** Новый экземпляр транспорта этого проекта. */
  transport(): RelayTransport;
  worker: WorkerTransport;
  admin: SuiteAdmin;
  cleanup(): Promise<void>;
}

/** Backend набора: каждый вызов `project()` — новый изолированный проект. */
export interface SuiteBackend {
  name: string;
  project(): Promise<SuiteProject>;
}

/* ------------------------------------------------------------------ */
/* Подделка как backend набора                                         */
/* ------------------------------------------------------------------ */

let fakeProjects = 0;

/** Backend набора на подделке; состояние каждого проекта — в своём файле SQLite. */
export function fakeSuiteBackend(provider: ProviderId = 'relay-v1-http'): SuiteBackend {
  return {
    name: 'fake-' + provider,
    project: () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-fake-relay-')));
      const projectId = `fake-${process.pid}-${++fakeProjects}`;
      const file = join(dir, 'relay.sqlite');
      const actor = 'harness-controller';
      const backends = [fileBackend(file, emptyFakeState(provider, projectId))];
      const admin = new FakeAdmin(backends[0]!);
      const asAsync =
        <A extends unknown[], R>(fn: (...a: A) => R) =>
        (...a: A) =>
          Promise.resolve().then(() => fn(...a));
      return Promise.resolve({
        provider,
        projectId,
        actor,
        relay:
          provider === 'relay-v1-http'
            ? { endpoint: 'http://fake.invalid' }
            : { binary: '/fake/relay', config: '/fake/relay.config.json' },
        transport: () => {
          const backend = fileBackend(file);
          backends.push(backend);
          return new FakeRelayTransport(backend, { provider, actor });
        },
        worker: { kind: 'fake', file, provider, actor },
        admin: {
          createTask: asAsync((i: Parameters<FakeAdmin['createTask']>[0]) => admin.createTask(i)),
          updateTask: asAsync((id: string, p: { title?: string; description?: string }) =>
            admin.updateTask(id, p),
          ),
          updateCriterion: asAsync((id: string, c: string, t: string) =>
            admin.updateCriterion(id, c, t),
          ),
          completeCriterion: asAsync((id: string, c: string, v?: boolean) =>
            admin.completeCriterion(id, c, v),
          ),
          addDocument: asAsync((id: string, d: { name: string; body: string }) =>
            admin.addDocument(id, d),
          ),
          updateDocument: asAsync((id: string, body: string) => admin.updateDocument(id, body)),
          addDependency: asAsync((id: string, dep: string) => admin.addDependency(id, dep)),
          move: asAsync((id: string, column: TaskColumn) => admin.move(id, column)),
          comment: asAsync((id: string, body: string) => admin.comment(id, body)),
          takeover: asAsync((id: string) => admin.takeover(id)),
        },
        cleanup: () => {
          for (const b of backends) b.close();
          rmSync(dir, { recursive: true, force: true });
          return Promise.resolve();
        },
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Проект, runtime fixture и сценарий                                  */
/* ------------------------------------------------------------------ */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();

/** Тест проекта: greet и JUnit по пути, который задаёт harness. */
const testRunner = `
const fs = require('fs');
let ok = false, message = '';
try {
  const { greet } = require(process.cwd() + '/src/greet.js');
  ok = greet('Ada') === 'Hello, Ada!';
  message = 'got ' + greet('Ada');
} catch (e) { message = String(e.message); }
const esc = (s) => s.replace(/[<&"]/g, '');
const report = process.env.DEVCONTOUR_REPORT_PATH || 'test-results/junit.xml';
fs.mkdirSync(require('path').dirname(report), { recursive: true });
fs.writeFileSync(report, '<testsuite><testcase classname="greet" name="greets">' + (ok ? '' : '<failure message="' + esc(message) + '"/>') + '</testcase>' +
  // Имя с кавычками и спецсимволами XML (экранировано по правилам XML): testId критерия совпадает с исходным именем.
  '<testcase classname="greet" name="quotes &quot;a&quot; &amp; &lt;b&gt; &apos;c&apos;"/></testsuite>');
`;

export const fixtureGreet = "exports.greet = (name) => 'Hello, ' + name + '!';\n";

export interface RuntimeCalls {
  writer: number;
  reviewer: number;
  plan: number;
}

export interface FixtureBehaviour {
  writer?: 'implement' | 'incomplete';
  reviewer?: 'approve' | 'reject';
  /** Вызывается при каждом вызове writer до ответа (проверка порядка, отмена). */
  onWriter?: (request: RuntimeRequest) => void | Promise<void>;
}

/** Runtime fixture в процессе: writer пишет greet, reviewer одобряет или отклоняет. */
export function fixtureAdapters(
  calls: RuntimeCalls,
  behaviour: FixtureBehaviour = {},
): Partial<Record<RuntimeName, RuntimeAdapter>> {
  const respond = (output: unknown): RuntimeResponse => ({
    status: 'ok',
    output,
    model: null,
    runtimeVersion: 'fixture',
    text: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedUsd: 0,
      complete: true,
      source: 'fixture',
    },
    diagnostics: { exitCode: 0 },
  });
  const capabilities = (runtime: RuntimeName) => () =>
    Promise.resolve({
      runtime,
      structuredOutput: true,
      sandbox: ['none' as const],
      cancellation: true,
      usage: true,
      fixture: true,
    });
  return {
    claude: {
      runtime: 'claude',
      capabilities: capabilities('claude'),
      invoke: async (request) => {
        calls.writer++;
        await behaviour.onWriter?.(request);
        if (behaviour.writer === 'incomplete')
          return respond({ completed: false, summary: 'Не закончено', discoveries: [] });
        mkdirSync(join(request.cwd, 'src'), { recursive: true });
        writeFileSync(
          join(request.cwd, 'src', 'greet.js'),
          fixtureGreet + `// ${request.subject?.workId ?? 'work'}\n`,
        );
        return respond({ completed: true, summary: 'Добавлена greet', discoveries: [] });
      },
    },
    codex: {
      runtime: 'codex',
      capabilities: capabilities('codex'),
      invoke: (request) => {
        calls.reviewer++;
        if (request.task === 'review-plan') calls.plan++;
        const reject = behaviour.reviewer === 'reject' && request.task === 'review-code';
        return Promise.resolve(
          respond({
            approved: !reject,
            summary: reject ? 'Отклонено fixture' : 'Критерии выполнены',
            findings: reject
              ? [{ severity: 'blocking', message: 'Отклонено fixture reviewer' }]
              : [],
            discoveries: [],
            execution: { commands: [], noCommandsReason: 'Проверка по diff и evidence' },
            previous: [],
          }),
        );
      },
    },
  };
}

/** Runtime, который не должен вызываться (доставка, reconcile): вызов — отказ и запись. */
export function forbiddenAdapters(file: string): Partial<Record<RuntimeName, RuntimeAdapter>> {
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () =>
      Promise.resolve({
        runtime,
        structuredOutput: true,
        sandbox: ['none'],
        cancellation: true,
        usage: true,
        fixture: true,
      }),
    invoke: () => {
      writeFileSync(file, 'runtime called\n', { flag: 'a' });
      return Promise.reject(new Error('runtime не должен вызываться'));
    },
  });
  return { claude: adapter('claude'), codex: adapter('codex') };
}

export function suitePolicy(
  repo: string,
  patch: Partial<Record<string, unknown>> = {},
): ExecutionPolicy {
  return executionPolicySchema.parse({
    policyVersion: 1,
    repositories: [
      {
        id: 'app',
        path: repo,
        targetRef: 'refs/heads/harness/accepted',
        gates: [
          {
            id: 'unit',
            kind: 'test',
            command: [process.execPath, 'test/run.js'],
            report: { type: 'junit', path: 'test-results/junit.xml' },
          },
        ],
        protectedPaths: ['test/'],
      },
    ],
    roles: { developer: { writer: { runtime: 'claude' } } },
    review: {
      code: { reviewer: { runtime: 'codex' } },
      plan: { reviewer: { runtime: 'codex' } },
      contract: { reviewer: { runtime: 'codex' } },
    },
    isolation: { mode: 'none', domains: [] },
    leaseMs: 30000,
    runTimeoutMs: 60000,
    ...patch,
  });
}

export interface ScenarioOptions extends FixtureBehaviour {
  criteria?: { title: string }[];
  mapping?: (Partial<CriterionMapping> & { gate: string })[];
  config?: (config: ConnectorConfigInput & Record<string, unknown>) => void;
  maxAttempts?: number;
  approvalMode?: 'agent' | 'operator';
  description?: string;
}

export interface Opened {
  connector: Connector;
  h: Harness;
  transport: RelayTransport & { calls: Record<string, number> };
  close(): void;
}

export interface WorkerSpec {
  action: 'deliver' | 'reconcile' | 'begin-attempt';
  workId?: string;
  operation?: string;
  decision?: string;
  faults?: (Omit<FaultRule, 'barrier' | 'after'> & { barrier?: { dir: string; name: string } })[];
  crashOnStoreWrite?: { what: string; nth: number };
  owner?: string;
  attempt?: { work: unknown; attempt: unknown; baseSha: string };
}

export interface WorkerResult {
  code: number | null;
  output?: { ok: boolean; result?: unknown; error?: { code?: string; message: string } };
  stderr: string;
}

export interface Scenario {
  project: SuiteProject;
  task: { id: string; key: string; criteria: string[] };
  root: string;
  repo: string;
  state: string;
  policy: ExecutionPolicy;
  calls: RuntimeCalls;
  config: ConnectorConfigInput & Record<string, unknown>;
  loaded(): LoadedConfig;
  workId: string;
  open(o?: {
    faults?: FaultRule[];
    onStoreWrite?: (what: string) => void;
    transport?: RelayTransport;
    behaviour?: FixtureBehaviour;
    secrets?: string[];
  }): Promise<Opened>;
  /** Снимок и `run --source` (ревью плана, исполнение, доставка). */
  snapshotAndRun(
    o?: Parameters<Scenario['open']>[0],
  ): Promise<{ opened: Opened; run: Awaited<ReturnType<Connector['run']>> }>;
  /** Снимок и исполнение без доставки (результат принят локально). */
  runOnly(o?: Parameters<Scenario['open']>[0]): Promise<Opened>;
  target(): string;
  worker(spec: WorkerSpec, timeoutMs?: number): Promise<WorkerResult>;
  /** Дождаться истечения lease упавшего владельца (перехват — только после срока). */
  waitLeases(): Promise<void>;
  cleanup(): Promise<void>;
}

const workerFile = fileURLToPath(
  new URL(
    import.meta.url.endsWith('.ts') ? './testing-worker.ts' : './testing-worker.js',
    import.meta.url,
  ),
);

export async function scenario(backend: SuiteBackend, o: ScenarioOptions = {}): Promise<Scenario> {
  const project = await backend.project();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-connector-')));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'app\n');
  writeFileSync(join(repo, 'test', 'run.js'), testRunner);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'update-ref', 'refs/heads/harness/accepted', 'HEAD');
  const policy = suitePolicy(repo, {
    maxAttempts: o.maxAttempts ?? 1,
    approvalMode: o.approvalMode ?? 'agent',
  });
  const task = await project.admin.createTask({
    title: 'Add greeting',
    description: o.description ?? "Add greet(name) to src/greet.js returning 'Hello, <name>!'.",
    column: 'ready',
    criteria: o.criteria ?? [{ title: 'Greets by name' }],
  });
  const state = join(root, 'state');
  const config: ConnectorConfigInput & Record<string, unknown> = {
    version: 1,
    provider: project.provider,
    projectId: project.projectId,
    actor: project.actor,
    relay: project.relay,
    repository: { id: 'app' },
    tasks: [
      {
        ref: task.id,
        writeScope: ['src'],
        gates: ['unit'],
        criteria: (o.mapping ?? [
          { title: 'Greets by name', gate: 'unit', testId: 'greet.greets' },
        ]) as CriterionMapping[],
      },
    ],
    limits: { leaseMs: 2000 } as never,
  } as never;
  o.config?.(config);
  const calls: RuntimeCalls = { writer: 0, reviewer: 0, plan: 0 };
  const opened: Opened[] = [];
  const loaded = () => parseConfig(structuredClone(config), root);
  const open = async (x: Parameters<Scenario['open']>[0] = {}) => {
    const transport = faultyTransport(x.transport ?? project.transport(), x.faults ?? []);
    const connector = await openConnector(loaded(), {
      stateDir: state,
      transport,
      ...(x.onStoreWrite ? { onStoreWrite: x.onStoreWrite } : {}),
      ...(x.secrets ? { secrets: x.secrets } : {}),
    });
    const h = Harness.open({
      stateDir: state,
      policy,
      baseDir: repo,
      adapters: fixtureAdapters(calls, { ...o, ...x.behaviour }),
      hooks: connector.hooks(),
      resourceDatabase: join(root, 'resources.sqlite'),
    });
    const handle: Opened = {
      connector,
      h,
      transport,
      close: () => {
        h.close();
        connector.close();
      },
    };
    opened.push(handle);
    return handle;
  };
  const s: Scenario = {
    project,
    task,
    root,
    repo,
    state,
    policy,
    calls,
    config,
    loaded,
    workId: orderIdOf(project.provider, project.projectId, task.id),
    open,
    async snapshotAndRun(x) {
      const handle = await open(x);
      await handle.connector.snapshot(join(root, 'snapshot'));
      const run = await handle.connector.run(handle.h, { author: 'claude' });
      return { opened: handle, run };
    },
    async runOnly(x) {
      const handle = await open(x);
      await handle.connector.snapshot(join(root, 'snapshot'));
      const { graph, context } = await handle.connector.prepareRun(handle.h);
      await handle.h.run({ graph, context, author: 'claude', source: handle.connector.source });
      return handle;
    },
    target: () => git(repo, 'rev-parse', 'refs/heads/harness/accepted'),
    async worker(spec, timeoutMs = 60_000) {
      const file = join(root, `worker-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(
        file,
        JSON.stringify({
          ...spec,
          transport: project.worker,
          config,
          baseDir: root,
          state,
          repo,
          policy,
          forbidden: join(root, 'forbidden-runtime-calls.txt'),
          resources: join(root, 'resources.sqlite'),
        }),
      );
      return new Promise<WorkerResult>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', import.meta.resolve('tsx'), workerFile, file],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NODE_OPTIONS: '' },
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`worker ${spec.action}: нет итога за ${timeoutMs} мс\n${stderr}`));
        }, timeoutMs);
        child.on('close', (code) => {
          clearTimeout(timer);
          const line = stdout.trim().split('\n').filter(Boolean).at(-1);
          let output: WorkerResult['output'];
          try {
            output = line ? (JSON.parse(line) as WorkerResult['output']) : undefined;
          } catch {
            output = undefined;
          }
          resolve({ code, ...(output ? { output } : {}), stderr });
        });
      });
    },
    async waitLeases() {
      const handle = opened[0] ?? (await open());
      for (const op of handle.connector.store.operations()) {
        const lease = handle.connector.store.lease(op.key);
        const wait = lease ? lease.expiresAt - Date.now() + 50 : 0;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    },
    async cleanup() {
      for (const handle of opened)
        try {
          handle.close();
        } catch {
          /* уже закрыт */
        }
      await project.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return s;
}

/* ------------------------------------------------------------------ */
/* Чтение получателя для проверок                                      */
/* ------------------------------------------------------------------ */

const OP = 'devcontour-harness:op=';

/** Комментарии harness у задачи (по маркеру) — счёт у получателя, не локальных вызовов. */
export async function harnessComments(t: RelayTransport, taskId: string) {
  return (await t.listComments(taskId)).filter((c) => c.body.includes(OP));
}

export async function markerCount(t: RelayTransport, taskId: string, marker: string) {
  return (await t.listComments(taskId)).filter((c) => c.body.includes(marker)).length;
}

const historyLinks = (opened: Opened, workId: string) => opened.connector.history.links(workId);

/** Все чекпоинты сессий истории поручения у получателя. */
export async function historyCheckpoints(opened: Opened, workId: string) {
  const out: { session: string; kind: string; title: string; body: string }[] = [];
  for (const link of historyLinks(opened, workId))
    if (link.sessionId)
      for (const c of await opened.transport.checkpoints(link.sessionId))
        out.push({ session: link.kind, kind: c.kind, title: c.title, body: c.body });
  return out;
}

const refusedWith =
  (...codes: string[]) =>
  (e: unknown) => {
    assert.ok(e instanceof HarnessError, String(e));
    assert.ok(codes.includes(e.code), `${e.code}: ${e.message}`);
    return true;
  };

const deliveryOf = (opened: Opened, workId: string) => {
  try {
    return opened.h.result(workId).delivery.at(-1);
  } catch {
    return undefined;
  }
};

/* ------------------------------------------------------------------ */
/* Общий набор                                                         */
/* ------------------------------------------------------------------ */

export interface SuiteOptions {
  /** Предел одного теста, мс. */
  timeoutMs?: number;
  /** Выполнить только тесты с этими ID (`W02`, `D03`…). */
  only?: string[];
}

/**
 * Общий контрактный набор коннектора для backend. Имена тестов содержат ID
 * условий приёмки и имя backend.
 */
export function connectorSuite(backend: SuiteBackend, options: SuiteOptions = {}) {
  const t = (id: string, name: string, fn: () => Promise<void>) => {
    if (options.only && !options.only.includes(id)) return;
    test(`${id}/${backend.name}: ${name}`, { timeout: options.timeoutMs ?? 180_000 }, fn);
  };

  t(
    'W02',
    'идентичность provider+project+task разделена; неизменный снимок не создаёт run, approval и записей; cwd не влияет',
    async () => {
      const a = await scenario(backend);
      const b = await scenario(backend);
      try {
        const ida = orderIdOf(a.project.provider, a.project.projectId, a.task.id);
        const idb = orderIdOf(b.project.provider, b.project.projectId, b.task.id);
        assert.notEqual(ida, idb, 'одинаковый номер задачи в разных проектах — разные поручения');
        const other: ProviderId =
          a.project.provider === 'relay-v1-http' ? 'relay-v2-cli' : 'relay-v1-http';
        assert.notEqual(orderIdOf(other, a.project.projectId, a.task.id), ida, 'разные provider');
        assert.notEqual(
          connectorIdOf(a.project.provider, a.project.projectId),
          connectorIdOf(b.project.provider, b.project.projectId),
        );
        // Конфигурация проекта A с транспортом проекта B: отказ до любой записи.
        const cross = await a.open({ transport: b.project.transport() });
        await assert.rejects(
          cross.connector.snapshot(join(a.root, 'cross')),
          refusedWith('NOT_READY'),
        );
        assert.equal((await harnessComments(b.project.transport(), b.task.id)).length, 0);
        cross.close();

        const { opened, run } = await a.snapshotAndRun();
        assert.equal(run.works[0]!.status, 'done');
        const before = {
          calls: { ...a.calls },
          comments: (await harnessComments(opened.transport, a.task.id)).length,
          attempts: opened.h.engine.read((v) => v.attempts().length),
          approvedAt: opened.h.engine.read((v) => v.graph(run.graphId)!.approval!.at),
          target: a.target(),
          checkpoints: (await historyCheckpoints(opened, a.workId)).length,
        };
        assert.equal(before.comments, 1);
        // Повтор из другого cwd: тот же semantic snapshot, без нового run/approval/записей.
        const cwd = process.cwd();
        const elsewhere = mkdtempSync(join(tmpdir(), 'harness-cwd-'));
        let again;
        try {
          process.chdir(elsewhere);
          again = await opened.connector.snapshot(join(a.root, 'snapshot'));
        } finally {
          process.chdir(cwd);
          rmSync(elsewhere, { recursive: true, force: true });
        }
        assert.equal(again.created, false, 'снимок не создан заново');
        assert.equal(again.graphDigest, run.digest, 'тот же semantic snapshot и граф');
        const second = await opened.connector.run(opened.h, { author: 'claude' });
        assert.equal(second.resumed, true);
        assert.deepEqual(a.calls, before.calls, 'runtime не вызывался');
        assert.equal(
          opened.h.engine.read((v) => v.attempts().length),
          before.attempts,
        );
        assert.equal(
          opened.h.engine.read((v) => v.graph(run.graphId)!.approval!.at),
          before.approvedAt,
        );
        assert.equal((await harnessComments(opened.transport, a.task.id)).length, before.comments);
        assert.equal((await historyCheckpoints(opened, a.workId)).length, before.checkpoints);
        assert.equal(a.target(), before.target);
      } finally {
        await a.cleanup();
        await b.cleanup();
      }
    },
  );

  t(
    'W03',
    'значимое изменение требует нового согласования; свои status/comment не меняют постановку; cancel/reopen/блокер — по eligibility',
    async () => {
      const s = await scenario(backend, {
        criteria: [{ title: 'Greets by name' }],
      });
      try {
        // Критерий сопоставлен по ID: смена его текста меняет постановку, а не mapping.
        (s.config.tasks as { criteria: unknown[] }[])[0]!.criteria = [
          { id: s.task.criteria[0], gate: 'unit', testId: 'greet.greets' },
        ];
        const doc = await s.project.admin.addDocument(s.task.id, {
          name: 'Spec',
          body: '# Spec\n\nGreeting format.\n',
        });
        const o = await s.open();
        const baseline = await o.connector.snapshot(join(s.root, 'snapshot'));
        const stale = async (what: string, change: () => Promise<void>) => {
          await change();
          const calls = { ...s.calls };
          await assert.rejects(
            o.connector.run(o.h, { author: 'claude' }),
            refusedWith('APPROVAL_STALE'),
            what,
          );
          assert.deepEqual(s.calls, calls, what + ': runtime не вызывался');
          const next = await o.connector.snapshot(join(s.root, 'snapshot'));
          assert.notEqual(next.revision, baseline.revision, what + ': новый semantic digest');
          return next;
        };
        let current = baseline;
        current = await stale('текст', () =>
          s.project.admin.updateTask(s.task.id, {
            description: "Add greet(name) returning 'Hello, <name>!' — v2.",
          }),
        );
        current = await stale('критерий', () =>
          s.project.admin.updateCriterion(
            s.task.id,
            s.task.criteria[0]!,
            'Greets by name politely',
          ),
        );
        const changedCriterion = current;
        void changedCriterion;
        current = await stale('документ', () =>
          s.project.admin.updateDocument(doc.id, '# Spec\n\nChanged format.\n'),
        );
        // Mapping: другая конфигурация — другой digest.
        const mapped = structuredClone(s.config);
        (mapped.tasks as { criteria: { testId?: string }[] }[])[0]!.criteria[0]!.testId =
          'greet.other';
        const m = await openConnector(parseConfig(mapped, s.root), {
          stateDir: s.state,
          transport: s.project.transport(),
        });
        const remapped = await m.source.snapshot();
        assert.notEqual(remapped.revision, current.revision, 'mapping меняет semantic digest');
        m.close();

        // Свой in-progress и технический комментарий: та же постановка.
        const read = await o.transport.readTask(s.task.id);
        await o.transport.move(s.task.id, {
          column: 'in-progress',
          ifRevision: read.task.revision,
        });
        await o.transport.addComment(s.task.id, {
          title: 'note',
          body: 'Технический комментарий controller',
        });
        const own = await o.connector.snapshot(join(s.root, 'snapshot'));
        assert.equal(
          own.revision,
          current.revision,
          'свои статус и комментарий не меняют постановку',
        );
        assert.notEqual(
          own.tasks[0]!.casRevision,
          current.tasks[0]!.casRevision,
          'CAS-ревизия учтена отдельно',
        );
        const run = await o.connector.run(o.h, { author: 'claude' });
        assert.equal(run.works[0]!.status, 'done');
        assert.equal(
          deliveryOf(o, s.workId)?.status,
          'delivered',
          'новая CAS-ревизия без ложного конфликта',
        );

        // Зависимость (блокер), cancel, reopen — на новой задаче.
        const s2 = await scenario(backend);
        try {
          const o2 = await s2.open();
          await o2.connector.snapshot(join(s2.root, 'snapshot'));
          const dep = await s2.project.admin.createTask({
            title: 'Blocker',
            description: 'Blocking task for the test',
            column: 'ready',
          });
          await s2.project.admin.addDependency(s2.task.id, dep.id);
          await assert.rejects(
            o2.connector.run(o2.h, { author: 'claude' }),
            refusedWith('APPROVAL_STALE', 'NOT_READY'),
          );
          const blocked = await o2.connector.snapshot(join(s2.root, 'snapshot'));
          assert.equal(blocked.eligible, false);
          assert.ok(
            blocked.problems.some((p) => p.includes('DEPENDENCY_UNFINISHED')),
            blocked.problems.join('; '),
          );
          await assert.rejects(
            o2.connector.run(o2.h, { author: 'claude' }),
            refusedWith('NOT_READY'),
          );
          assert.equal(s2.calls.writer + s2.calls.reviewer, 0);
        } finally {
          await s2.cleanup();
        }
        for (const column of ['cancelled', 'inbox'] as TaskColumn[]) {
          const s3 = await scenario(backend);
          try {
            const o3 = await s3.open();
            await o3.connector.snapshot(join(s3.root, 'snapshot'));
            await s3.project.admin.move(s3.task.id, column);
            await assert.rejects(
              o3.connector.run(o3.h, { author: 'claude' }),
              refusedWith('NOT_READY'),
              column,
            );
            assert.equal(s3.calls.writer + s3.calls.reviewer, 0, column + ': runtime не вызывался');
          } finally {
            await s3.cleanup();
          }
        }
      } finally {
        await s.cleanup();
      }
    },
  );

  t(
    'W04',
    'полный согласованный снимок: изменение между чтениями — ограниченный reread, непрерывные изменения и ошибка — отказ, лимиты обязательного содержимого',
    async () => {
      const s = await scenario(backend, {
        config: (c) => {
          (c.limits as Record<string, unknown>) = {
            leaseMs: 2000,
            documentBytes: 2000,
            rereads: 3,
          };
        },
      });
      try {
        await s.project.admin.addDocument(s.task.id, {
          name: 'Spec',
          body: '# Spec\n\nGreeting format.\n',
        });
        await s.project.admin.addDocument(s.task.id, {
          name: 'Notes',
          body: '# Notes\n\n' + 'x'.repeat(5000),
        });
        const o = await s.open();
        const stable = await o.connector.snapshot(join(s.root, 'snapshot'));
        const manifest = stable.snapshot.manifest;
        assert.ok(manifest.rounds >= 2, 'прочитано минимум дважды');
        assert.equal(stable.snapshot.graph.source.revision, manifest.revision);
        assert.match(manifest.revision, /^[a-f0-9]{64}$/);
        assert.equal(typeof manifest.tasks[0]!.casRevision, 'number', 'CAS-ревизия — в manifest');
        assert.ok(manifest.tasks[0]!.consistency.before, 'токены согласованности сохранены');
        assert.ok(
          manifest.truncated.some((x) => x.endsWith('/Notes')),
          'дополнительный документ усечён явно',
        );
        const files = stable.snapshot.context.sources[0]!.files;
        const notes = files.find(
          (f) => f.content.encoding === 'utf8' && f.content.data.includes('# Notes'),
        );
        assert.ok(
          notes &&
            notes.content.encoding === 'utf8' &&
            notes.content.data.startsWith('[devcontour-harness: документ усечён'),
        );
        assert.ok(
          files.some(
            (f) => f.content.encoding === 'utf8' && f.content.data.includes('Greeting format'),
          ),
        );
        assert.ok(
          stable.snapshot.context.sources[0]!.references.some(
            (r) => r.path === 'references/provenance.json',
          ),
        );
        // Не-Git ревизия — только в manifest: в графе ревизия источника — semantic digest, Git SHA нет.
        for (const order of stable.snapshot.graph.orders)
          assert.match(order.source.revision, /^[a-f0-9]{64}$/);
        assert.equal(stable.snapshot.graph.prerequisites.length, 0);
        o.close();

        // Чужая запись между чтениями: ограниченный полный reread, тот же semantic snapshot.
        const changed = await s.open({
          faults: [
            {
              op: 'readTask',
              nth: 1,
              action: 'after',
              after: () => s.project.admin.comment(s.task.id, 'посторонний комментарий'),
            },
          ],
        });
        const reread = await changed.connector.source.snapshot();
        assert.equal(reread.revision, stable.revision);
        changed.close();

        // Непрерывные изменения: отказ после rereads, без смешанного графа и без runtime.
        let n = 0;
        const churn = await s.open({
          faults: [
            {
              op: 'readTask',
              nth: 1,
              times: 100,
              action: 'after',
              after: () =>
                s.project.admin.updateTask(s.task.id, {
                  description: `Add greet(name) — правка ${++n}`,
                }),
            },
          ],
        });
        await assert.rejects(churn.connector.source.snapshot(), (e: unknown) => {
          assert.ok(e instanceof HarnessError && e.code === 'NOT_READY', String(e));
          assert.match(e.message, /rereads=3/);
          return true;
        });
        assert.equal(s.calls.writer + s.calls.reviewer, 0);
        churn.close();

        // Ошибка чтения страницы — отказ, а не пустой результат.
        const broken = await s.open({
          faults: [{ op: 'readTask', nth: 2, action: 'fail-before-send' }],
        });
        await assert.rejects(broken.connector.source.snapshot(), refusedWith('DELIVERY_FAILED'));
        broken.close();

        // Обязательный документ больше предела: блок с причиной и пределом, без runtime.
        const big = await scenario(backend, {
          config: (c) => {
            (c.limits as Record<string, unknown>) = { leaseMs: 2000, documentBytes: 1000 };
            (c.tasks as Record<string, unknown>[])[0]!.requiredDocuments = ['Big'];
          },
        });
        try {
          await big.project.admin.addDocument(big.task.id, { name: 'Big', body: 'y'.repeat(3000) });
          const ob = await big.open();
          const snap = await ob.connector.snapshot(join(big.root, 'snapshot'));
          assert.equal(snap.eligible, false);
          assert.ok(
            snap.problems.some(
              (p) => p.includes('LIMIT_EXCEEDED') && p.includes('documentBytes=1000'),
            ),
            snap.problems.join('; '),
          );
          await assert.rejects(
            ob.connector.run(ob.h, { author: 'claude' }),
            refusedWith('NOT_READY'),
          );
          assert.equal(big.calls.writer + big.calls.reviewer, 0);
        } finally {
          await big.cleanup();
        }
      } finally {
        await s.cleanup();
      }
    },
  );

  t(
    'W05',
    'done без receipt, недоверенный receipt и недостижимый SHA не разрешают зависимый запуск; доверенный receipt с SHA в target — разрешает',
    async () => {
      const s = await scenario(backend);
      try {
        const { opened } = await s.snapshotAndRun();
        assert.equal(deliveryOf(opened, s.workId)?.status, 'delivered');
        const depRead = await opened.transport.readTask(s.task.id);
        assert.equal(depRead.task.column, 'done');
        // Зависимая задача B от выполненной через harness задачи A.
        const b = await s.project.admin.createTask({
          title: 'Use greeting',
          description: 'Use greet(name) from the dependency in src/greet.js',
          column: 'ready',
          criteria: [{ title: 'Greets by name' }],
          dependencies: [s.task.id],
        });
        const cfgB = structuredClone(s.config);
        (cfgB.tasks as { ref: string }[])[0]!.ref = b.id;
        const connB = await openConnector(parseConfig(cfgB, s.root), {
          stateDir: s.state,
          transport: s.project.transport(),
        });
        const snapB = await connB.snapshot(join(s.root, 'snapshot-b'));
        assert.equal(snapB.eligible, true, snapB.problems.join('; '));
        const prereq = snapB.snapshot.graph.prerequisites[0]!;
        assert.equal(prereq.receipt.kind, 'trusted');
        assert.equal(await connB.source.trusts(prereq), true, 'receipt этого коннектора');
        // Валидный доверенный receipt: зависимая задача исполняется обычным путём.
        const hB = Harness.open({
          stateDir: s.state,
          policy: s.policy,
          baseDir: s.repo,
          adapters: fixtureAdapters(s.calls),
          hooks: connB.hooks(),
          resourceDatabase: join(s.root, 'resources.sqlite'),
        });
        try {
          const runB = await connB.run(hB, { author: 'claude' });
          assert.equal(
            runB.works.find(
              (w) => w.id === orderIdOf(s.project.provider, s.project.projectId, b.id),
            )!.status,
            'done',
          );
        } finally {
          hB.close();
        }

        const forged = {
          ...prereq,
          receipt: { ...prereq.receipt, issuer: 'someone-else' },
        } as typeof prereq;
        assert.equal(await connB.source.trusts(forged), false, 'чужой издатель');
        const graph = snapB.snapshot.graph;
        const calls = { ...s.calls };
        // Недоверенный издатель — отказ регистрации до runtime.
        await assert.rejects(
          opened.h.run({
            graph: {
              ...graph,
              id: graph.id + 'f',
              source: { ...graph.source, revision: 'forged' },
              prerequisites: [forged],
            },
            context: snapB.snapshot.context,
            author: 'claude',
            source: connB.source,
          }),
          refusedWith('NOT_READY'),
        );
        // Доверенный receipt с недостижимым SHA: запись состояния-fixture с тем же издателем.
        const ghost = '1'.repeat(40);
        const store = connB.store;
        const lease = store.acquire('fixture-ghost', 'test', 5000).lease!;
        const record = {
          issuer: connB.id,
          orderId: prereq.id,
          taskId: s.task.id,
          repositoryId: 'app',
          resultSha: ghost,
          workId: s.workId,
          runId: 'ghost',
          operation: 'fixture-ghost',
        };
        store.putReceipt(record, lease.token);
        const { digestOf } = await import('../../contracts/digest.ts');
        const unreachable = {
          ...prereq,
          resultSha: ghost,
          receipt: { kind: 'trusted' as const, issuer: connB.id, digest: digestOf(record) },
        };
        assert.equal(await connB.source.trusts(unreachable), true);
        await assert.rejects(
          opened.h.run({
            graph: {
              ...graph,
              id: graph.id + 'x',
              source: { ...graph.source, revision: 'unreachable' },
              prerequisites: [unreachable],
            },
            context: snapB.snapshot.context,
            author: 'claude',
            source: connB.source,
          }),
          refusedWith('NOT_READY'),
        );
        assert.deepEqual(s.calls, calls, 'отказы — без runtime');
        connB.close();
        // Задача в done без receipt этого коннектора — не основание.
        const c = await s.project.admin.createTask({
          title: 'Done elsewhere',
          description: 'Closed by a human without harness',
          column: 'ready',
          criteria: [{ title: 'Manual' }],
        });
        const cr = (await s.project.transport().readTask(c.id)).task.criteria[0]!;
        await s.project.admin.completeCriterion(c.id, cr.id);
        await s.project.admin.move(c.id, 'done');
        const d = await s.project.admin.createTask({
          title: 'Depends on done',
          description: 'Depends on a task closed without receipt',
          column: 'ready',
          criteria: [{ title: 'Greets by name' }],
          dependencies: [c.id],
        });
        const cfgD = structuredClone(s.config);
        (cfgD.tasks as { ref: string }[])[0]!.ref = d.id;
        const connD = await openConnector(parseConfig(cfgD, s.root), {
          stateDir: s.state,
          transport: s.project.transport(),
        });
        try {
          const snapD = await connD.snapshot(join(s.root, 'snapshot-d'));
          assert.equal(snapD.eligible, false);
          assert.ok(
            snapD.problems.some((p) => p.includes('DEPENDENCY_UNPROVEN')),
            snapD.problems.join('; '),
          );
          assert.ok(
            snapD.problems.some((p) => p.includes('baseline.tasks')),
            'отказ называет выход: явное решение человека',
          );
          const writer = s.calls.writer;
          await assert.rejects(connD.run(opened.h, { author: 'claude' }), refusedWith('NOT_READY'));
          assert.equal(s.calls.writer, writer);
        } finally {
          connD.close();
        }
        // Человек принимает задачу явно: ключ backend, полный SHA, причина.
        const sha = s.target();
        cfgD.baseline = { sha, tasks: [c.key], reason: 'Closed before adoption' };
        const connE = await openConnector(parseConfig(cfgD, s.root), {
          stateDir: s.state,
          transport: s.project.transport(),
        });
        try {
          const snapE = await connE.snapshot(join(s.root, 'snapshot-e'));
          assert.equal(snapE.eligible, true, snapE.problems.join('; '));
          const accepted = snapE.snapshot.graph.prerequisites[0]!;
          assert.equal(accepted.resultSha, sha);
          assert.equal(await connE.source.trusts(accepted), true, 'ключ разрешён backend');
        } finally {
          connE.close();
        }
      } finally {
        await s.cleanup();
      }
    },
  );

  t(
    'D01',
    'повтор подтверждённой доставки (в том же и в новом процессе) не создаёт записей; receipt тот же; runtime и Git не меняются',
    async () => {
      const s = await scenario(backend);
      try {
        const { opened } = await s.snapshotAndRun();
        const first = deliveryOf(opened, s.workId)!;
        assert.equal(first.status, 'delivered');
        const snapshot = async () => ({
          comments: (await harnessComments(opened.transport, s.task.id)).length,
          checkpoints: (await historyCheckpoints(opened, s.workId)).length,
          read: (await opened.transport.readTask(s.task.id)).task,
        });
        const before = await snapshot();
        assert.equal(before.comments, 1);
        assert.equal(before.read.column, 'done');
        const calls = { ...s.calls };
        const target = s.target();
        await opened.connector.deliver(opened.h, s.workId);
        const child = await s.worker({ action: 'deliver', workId: s.workId });
        assert.equal(child.code, 0, child.stderr);
        assert.equal(child.output?.ok, true, child.stderr);
        const after = await snapshot();
        assert.deepEqual(after, before, 'у получателя нет новых записей');
        assert.deepEqual(s.calls, calls);
        assert.equal(s.target(), target);
        const again = deliveryOf(opened, s.workId)!;
        assert.equal(again.receipt, first.receipt, 'тот же подтверждённый receipt');
        const op = opened.connector.store.operations({ workId: s.workId })[0]!;
        assert.equal(op.status, 'delivered');
        assert.ok(
          op.steps.every((x) => x.sends <= 1),
          'каждый шаг отправлен не больше одного раза',
        );
      } finally {
        await s.cleanup();
      }
    },
  );

  t(
    'D02',
    'обрыв процесса вокруг записи: до отправки — безопасный повтор; после записи получателем — read-back без повтора; после ответа до receipt — без новых мутаций; отказ записи intent — без мутации',
    async () => {
      // (a) intent сохранён, отправки не было.
      const a = await scenario(backend);
      try {
        const oa = await a.runOnly();
        const crashed = await a.worker({
          action: 'deliver',
          workId: a.workId,
          crashOnStoreWrite: { what: 'step', nth: 1 },
        });
        assert.equal(crashed.code, 75, crashed.stderr);
        assert.equal(
          (await harnessComments(oa.transport, a.task.id)).length,
          0,
          'отправки не было',
        );
        const op = oa.connector.store.operations({ workId: a.workId })[0]!;
        assert.equal(op.steps[0]!.status, 'planned', 'intent записан, шаг не отправлялся');
        await a.waitLeases();
        const resumed = await a.worker({ action: 'deliver', workId: a.workId });
        assert.equal(resumed.output?.ok, true, resumed.stderr);
        assert.equal((await harnessComments(oa.transport, a.task.id)).length, 1);
        assert.equal(oa.connector.store.operation(op.key)!.status, 'delivered');
      } finally {
        await a.cleanup();
      }
      // (b) получатель записал, ответ не дошёл, процесс упал.
      const b = await scenario(backend);
      try {
        const ob = await b.runOnly();
        const target = b.target();
        const crashed = await b.worker({
          action: 'deliver',
          workId: b.workId,
          faults: [{ op: 'addComment', nth: 1, action: 'exit-after' }],
        });
        assert.equal(crashed.code, 75, crashed.stderr);
        assert.equal(
          (await harnessComments(ob.transport, b.task.id)).length,
          1,
          'запись у получателя есть',
        );
        await b.waitLeases();
        const resumed = await b.worker({ action: 'deliver', workId: b.workId });
        assert.equal(resumed.output?.ok, true, resumed.stderr);
        assert.equal(
          (await harnessComments(ob.transport, b.task.id)).length,
          1,
          'read-back нашёл маркер, повтора нет',
        );
        const op = ob.connector.store.operations({ workId: b.workId })[0]!;
        assert.equal(op.status, 'delivered');
        assert.equal(op.steps[0]!.sends, 1);
        assert.equal(b.target(), target, 'Git не меняется');
      } finally {
        await b.cleanup();
      }
      // (c) все шаги подтверждены, receipt не сохранён.
      const c = await scenario(backend);
      try {
        const oc = await c.runOnly();
        const crashed = await c.worker({
          action: 'deliver',
          workId: c.workId,
          crashOnStoreWrite: { what: 'receipt', nth: 1 },
        });
        assert.equal(crashed.code, 75, crashed.stderr);
        const mid = {
          comments: (await harnessComments(oc.transport, c.task.id)).length,
          column: (await oc.transport.readTask(c.task.id)).task.column,
          checkpoints: (await historyCheckpoints(oc, c.workId)).length,
        };
        await c.waitLeases();
        const resumed = await c.worker({ action: 'deliver', workId: c.workId });
        assert.equal(resumed.output?.ok, true, resumed.stderr);
        assert.deepEqual(
          {
            comments: (await harnessComments(oc.transport, c.task.id)).length,
            column: (await oc.transport.readTask(c.task.id)).task.column,
            checkpoints: (await historyCheckpoints(oc, c.workId)).length,
          },
          mid,
          'восстановление receipt без новых мутаций',
        );
        assert.equal(oc.connector.store.operations({ workId: c.workId })[0]!.status, 'delivered');
      } finally {
        await c.cleanup();
      }
      // (d) запись intent не удалась.
      const d = await scenario(backend);
      try {
        const od = await d.runOnly({
          onStoreWrite: (what) => {
            if (what === 'intent') throw new Error('диск полон');
          },
        });
        const envelope = await od.h.deliver(d.workId, od.connector.sink);
        assert.equal(envelope.delivery.at(-1)!.status, 'failed');
        assert.equal(
          (await harnessComments(od.transport, d.task.id)).length,
          0,
          'мутация не отправлена',
        );
        assert.equal(od.connector.store.operations({ workId: d.workId }).length, 0);
      } finally {
        await d.cleanup();
      }
    },
  );

  t(
    'D03',
    'неизвестный исход — uncertain без повтора; reconcile по фактам; неоднозначный маркер — только явным решением',
    async () => {
      // (a) таймаут без применения.
      const a = await scenario(backend);
      try {
        const oa = await a.runOnly({ faults: [{ op: 'addComment', nth: 1, action: 'timeout' }] });
        await oa.h.deliver(a.workId, oa.connector.sink);
        const state = deliveryOf(oa, a.workId)!;
        assert.equal(state.status, 'uncertain');
        assert.ok(state.operation);
        assert.ok(
          oa.h
            .events(0, 500)
            .events.some(
              (e) => e.type === 'delivery.uncertain' && e.payload.operation === state.operation,
            ),
          'отдельное событие delivery.uncertain с ключом операции',
        );
        await oa.h.deliver(a.workId, oa.connector.sink);
        assert.equal(deliveryOf(oa, a.workId)!.status, 'uncertain', 'повтор не отправляет мутацию');
        assert.equal((await harnessComments(oa.transport, a.task.id)).length, 0);
        assert.notEqual((await oa.transport.readTask(a.task.id)).task.column, 'done');
        const unresolved = await oa.connector.reconcile(oa.h, state.operation);
        assert.equal(unresolved.resolved, false);
        assert.ok(
          unresolved.facts.some((f) => f.includes('resend')),
          unresolved.facts.join('; '),
        );
        const resolved = await oa.connector.reconcile(oa.h, state.operation, { kind: 'resend' });
        assert.equal(resolved.resolved, true);
        assert.equal(deliveryOf(oa, a.workId)!.status, 'delivered');
        assert.equal((await harnessComments(oa.transport, a.task.id)).length, 1);
      } finally {
        await a.cleanup();
      }
      // (b) запись прошла, read-back недоступен; после восстановления — по фактам.
      const b = await scenario(backend);
      try {
        const ob = await b.runOnly({
          faults: [
            { op: 'addComment', nth: 1, action: 'drop-response' },
            { op: 'listComments', nth: 1, action: 'fail-before-send' },
          ],
        });
        await ob.h.deliver(b.workId, ob.connector.sink);
        const state = deliveryOf(ob, b.workId)!;
        assert.equal(state.status, 'uncertain');
        const resolved = await ob.connector.reconcile(ob.h, state.operation!);
        assert.equal(resolved.resolved, true, resolved.facts.join('; '));
        assert.equal(deliveryOf(ob, b.workId)!.status, 'delivered');
        assert.equal((await harnessComments(ob.transport, b.task.id)).length, 1, 'дубликата нет');
      } finally {
        await b.cleanup();
      }
      // (c) неоднозначный маркер.
      const c = await scenario(backend);
      try {
        const oc = await c.runOnly({
          faults: [{ op: 'addComment', nth: 1, action: 'drop-response' }],
        });
        const result = oc.h.result(c.workId).result;
        const key = oc.connector.sink.keyOf(result);
        await c.project.admin.comment(c.task.id, 'Скопировано: ' + markerOf(key, 1));
        await oc.h.deliver(c.workId, oc.connector.sink);
        assert.equal(deliveryOf(oc, c.workId)!.status, 'uncertain');
        const unresolved = await oc.connector.reconcile(oc.h, key);
        assert.equal(unresolved.resolved, false, 'первая найденная запись не выбирается');
        const mine = (await harnessComments(oc.transport, c.task.id)).find((x) =>
          x.body.startsWith(markerOf(key, 1)),
        )!;
        const resolved = await oc.connector.reconcile(oc.h, key, { kind: 'adopt', id: mine.id });
        assert.equal(resolved.resolved, true);
        assert.equal(deliveryOf(oc, c.workId)!.status, 'delivered');
        assert.equal(
          await markerCount(oc.transport, c.task.id, markerOf(key, 1)),
          2,
          'новых записей нет',
        );
      } finally {
        await c.cleanup();
      }
    },
  );

  t(
    'D03',
    'B-1: подтверждённый отказ получателя (refused / conflict без CAS) — не неизвестный исход: failed без мутации и безопасный повтор',
    async () => {
      const variants: { name: string; fault: FaultRule; comments: number }[] = [
        {
          name: 'комментарий: refused',
          fault: {
            op: 'addComment',
            nth: 1,
            action: 'refuse',
            refusal: { kind: 'refused', code: 'VALIDATION_ERROR' },
          },
          comments: 0,
        },
        {
          name: 'комментарий: conflict',
          fault: {
            op: 'addComment',
            nth: 1,
            action: 'refuse',
            refusal: { kind: 'conflict', code: 'STORAGE_BUSY' },
          },
          comments: 0,
        },
        {
          name: 'критерий: refused',
          fault: {
            op: 'setCriterion',
            nth: 1,
            action: 'refuse',
            refusal: { kind: 'refused', code: 'UNAVAILABLE' },
          },
          comments: 1,
        },
      ];
      for (const v of variants) {
        const s = await scenario(backend);
        try {
          const o = await s.runOnly({ faults: [v.fault] });
          await o.h.deliver(s.workId, o.connector.sink);
          const state = deliveryOf(o, s.workId)!;
          assert.equal(state.status, 'failed', `${v.name}: ${JSON.stringify(state)}`);
          assert.match(state.lastError ?? '', /подтверждённый отказ получателя/, v.name);
          assert.equal((await harnessComments(o.transport, s.task.id)).length, v.comments, v.name);
          assert.ok(
            !o.h.events(0, 500).events.some((e) => e.type === 'delivery.uncertain'),
            v.name + ': не uncertain',
          );
          const op = o.connector.store.operations({ workId: s.workId })[0]!;
          assert.equal(op.status, 'failed', v.name);
          assert.ok(
            op.steps.every((x) => x.status === 'done' || x.status === 'planned'),
            v.name,
          );
          // Повтор без оператора: та же операция, без дубликатов.
          await o.h.deliver(s.workId, o.connector.sink);
          assert.equal(deliveryOf(o, s.workId)!.status, 'delivered', v.name);
          assert.equal((await harnessComments(o.transport, s.task.id)).length, 1, v.name);
          assert.equal((await o.transport.readTask(s.task.id)).task.column, 'done', v.name);
        } finally {
          await s.cleanup();
        }
      }
    },
  );

  t(
    'D04',
    'старая постановка не закрывает новую: изменение после приёмки — conflict и исторический комментарий; чужое изменение между precheck и CAS — conflict без повтора',
    async () => {
      const s = await scenario(backend, {
        config: (c) =>
          ((c as Record<string, unknown>).completion = {
            mode: 'complete',
            historicalComment: true,
          }),
      });
      try {
        const o = await s.runOnly();
        const accepted = o.h.result(s.workId).result;
        assert.ok(accepted.outcome === 'accepted');
        const target = s.target();
        await s.project.admin.updateTask(s.task.id, {
          description: "Add greet(name) returning 'Hi, <name>!' — changed after acceptance.",
        });
        await o.h.deliver(s.workId, o.connector.sink);
        assert.equal(deliveryOf(o, s.workId)!.status, 'conflict');
        const read = await o.transport.readTask(s.task.id);
        assert.notEqual(read.task.column, 'done', 'текущая задача не закрыта старым результатом');
        assert.ok(
          read.task.criteria.every((c) => !c.completed),
          'критерии не отмечены',
        );
        const comments = await harnessComments(o.transport, s.task.id);
        assert.equal(comments.length, 1);
        assert.match(comments[0]!.body, /исторический результат/);
        const kept = o.h.result(s.workId).result;
        assert.ok(
          kept.outcome === 'accepted' && kept.shas.result === accepted.shas.result,
          'результат связан со своим снимком',
        );
        assert.equal(s.target(), target);
        const status = await o.connector.status(o.h);
        const remote = status.tasks[0]!.remote as { matchesSnapshot?: boolean };
        assert.equal(remote.matchesSnapshot, false);
      } finally {
        await s.cleanup();
      }
      const r = await scenario(backend);
      try {
        const barrier = new (await import('./fake.ts')).LocalBarrier();
        const o = await r.runOnly({
          faults: [{ op: 'setCriterion', nth: 1, action: 'barrier', barrier }],
        });
        const pending = o.h.deliver(r.workId, o.connector.sink);
        await Promise.race([
          barrier.reached,
          new Promise((_, no) => setTimeout(() => no(new Error('барьер не достигнут')), 30_000)),
        ]);
        await r.project.admin.move(r.task.id, 'review');
        barrier.release();
        await pending;
        assert.equal(deliveryOf(o, r.workId)!.status, 'conflict');
        const read = await o.transport.readTask(r.task.id);
        assert.equal(read.task.column, 'review', 'чужое изменение сохранено');
        assert.ok(
          read.task.criteria.every((c) => !c.completed),
          'старая команда не применена к новой ревизии',
        );
      } finally {
        await r.cleanup();
      }
    },
  );

  t(
    'D04',
    'F02: ответ на CAS-шаг потерян, затем чужая семантическая правка (в процессе и после restart) — conflict; изменённая задача не закрывается старым результатом',
    async () => {
      const variants: {
        name: string;
        mapping?: ScenarioOptions['mapping'];
        criteria?: { title: string }[];
        run: (s: Scenario, o: Opened) => Promise<void>;
      }[] = [
        {
          name: 'criterion: потеря ответа + правка до read-back',
          run: async (s, o) => {
            const sink = (
              await s.open({
                faults: [
                  {
                    op: 'setCriterion',
                    nth: 1,
                    action: 'drop-response',
                    after: () =>
                      s.project.admin.updateTask(s.task.id, {
                        description: 'NEW requirement added after approval (F02)',
                      }),
                  },
                ],
              })
            ).connector.sink;
            await o.h.deliver(s.workId, sink);
          },
        },
        {
          name: 'criterion: restart после фиксации, правка до продолжения',
          run: async (s) => {
            const crashed = await s.worker({
              action: 'deliver',
              workId: s.workId,
              faults: [{ op: 'setCriterion', nth: 1, action: 'exit-after' }],
            });
            assert.equal(crashed.code, 75, crashed.stderr);
            await s.project.admin.updateTask(s.task.id, {
              description: 'NEW requirement added after approval (F02 restart)',
            });
            await s.waitLeases();
            const resumed = await s.worker({ action: 'deliver', workId: s.workId });
            assert.equal(resumed.output?.ok, true, resumed.stderr);
          },
        },
        {
          name: 'criterion 1 подтверждён, правка до criterion 2 (restart)',
          criteria: [{ title: 'Greets by name' }, { title: 'Exports greet' }],
          mapping: [
            { title: 'Greets by name', gate: 'unit', testId: 'greet.greets' },
            { title: 'Exports greet', gate: 'unit', evidence: 'gate' },
          ],
          run: async (s) => {
            const crashed = await s.worker({
              action: 'deliver',
              workId: s.workId,
              faults: [{ op: 'setCriterion', nth: 2, action: 'exit-before' }],
            });
            assert.equal(crashed.code, 75, crashed.stderr);
            await s.project.admin.updateTask(s.task.id, {
              description: 'NEW requirement between criteria (F02)',
            });
            await s.waitLeases();
            const resumed = await s.worker({ action: 'deliver', workId: s.workId });
            assert.equal(resumed.output?.ok, true, resumed.stderr);
          },
        },
        {
          name: 'move: потеря ответа + правка до read-back',
          run: async (s, o) => {
            const sink = (
              await s.open({
                faults: [
                  {
                    op: 'move',
                    nth: 1,
                    action: 'drop-response',
                    after: () =>
                      s.project.admin.updateTask(s.task.id, {
                        description: 'NEW requirement after move (F02)',
                      }),
                  },
                ],
              })
            ).connector.sink;
            await o.h.deliver(s.workId, sink);
          },
        },
      ];
      for (const v of variants) {
        const s = await scenario(backend, {
          ...(v.criteria ? { criteria: v.criteria } : {}),
          ...(v.mapping ? { mapping: v.mapping } : {}),
        });
        try {
          const o = await s.runOnly();
          const accepted = o.h.result(s.workId).result;
          assert.ok(accepted.outcome === 'accepted', v.name);
          const target = s.target();
          await v.run(s, o);
          const state = deliveryOf(o, s.workId);
          assert.equal(state?.status, 'conflict', `${v.name}: ${JSON.stringify(state)}`);
          const op = o.connector.store.operations({ workId: s.workId })[0]!;
          assert.equal(op.status, 'conflict', v.name);
          assert.equal(
            o.connector.store.receipts().length,
            0,
            v.name + ': доверенного receipt нет',
          );
          const read = await o.transport.readTask(s.task.id);
          if (!v.name.startsWith('move'))
            assert.notEqual(read.task.column, 'done', v.name + ': изменённая задача не закрыта');
          assert.equal((await harnessComments(o.transport, s.task.id)).length, 1, v.name);
          const kept = o.h.result(s.workId).result;
          assert.ok(
            kept.outcome === 'accepted' &&
              accepted.outcome === 'accepted' &&
              kept.shas.result === accepted.shas.result,
            v.name,
          );
          assert.equal(s.target(), target, v.name + ': Git не меняется');
          // Повторная доставка ничего не отправляет.
          const before = JSON.stringify(await o.transport.readTask(s.task.id));
          await o.h.deliver(s.workId, o.connector.sink);
          assert.equal(JSON.stringify(await o.transport.readTask(s.task.id)), before, v.name);
        } finally {
          await s.cleanup();
        }
      }
    },
  );

  t(
    'D05',
    'критерии только по mapping: ручной, непрошедший testcase и подзадача блокируют done; review-only; частичная доставка продолжается без дублей',
    async () => {
      const cases: {
        name: string;
        options: ScenarioOptions;
        setup?: (s: Scenario) => Promise<void>;
        expect: (o: Opened, s: Scenario) => Promise<void>;
      }[] = [
        {
          name: 'полный',
          options: {},
          expect: async (o, s) => {
            const read = await o.transport.readTask(s.task.id);
            assert.equal(read.task.column, 'done');
            assert.ok(read.task.criteria.every((c) => c.completed));
            const receipt = o.connector.store.operations({ workId: s.workId })[0]!.receipt as {
              criteria: { outcome: string; testId?: string }[];
            };
            assert.deepEqual(
              receipt.criteria.map((c) => [c.outcome, c.testId]),
              [['closed', 'greet.greets']],
            );
          },
        },
        {
          name: 'ручной критерий',
          options: {
            criteria: [{ title: 'Greets by name' }, { title: 'Docs reviewed by a human' }],
          },
          expect: async (o, s) => {
            const read = await o.transport.readTask(s.task.id);
            assert.notEqual(read.task.column, 'done');
            assert.deepEqual(
              read.task.criteria.map((c) => c.completed),
              [true, false],
            );
          },
        },
        {
          name: 'непрошедший testcase',
          options: {
            criteria: [{ title: 'Greets by name' }, { title: 'Polite' }],
            mapping: [
              { title: 'Greets by name', gate: 'unit', testId: 'greet.greets' },
              { title: 'Polite', gate: 'unit', testId: 'greet.polite' },
            ],
          },
          expect: async (o, s) => {
            const read = await o.transport.readTask(s.task.id);
            assert.notEqual(read.task.column, 'done');
            assert.deepEqual(
              read.task.criteria.map((c) => c.completed),
              [true, false],
            );
          },
        },
        {
          name: 'незакрытая подзадача',
          options: {},
          setup: async (s) =>
            void (await s.project.admin.createTask({
              title: 'Subtask',
              description: 'Unfinished child task',
              column: 'ready',
              parentId: s.task.id,
            })),
          expect: async (o, s) => {
            const read = await o.transport.readTask(s.task.id);
            assert.notEqual(read.task.column, 'done');
            assert.ok(read.task.criteria.every((c) => c.completed));
          },
        },
        {
          name: 'review-only',
          options: {
            config: (c) => ((c as Record<string, unknown>).completion = { mode: 'review-only' }),
          },
          expect: async (o, s) => {
            const read = await o.transport.readTask(s.task.id);
            assert.equal(read.task.column, 'review');
            assert.ok(read.task.criteria.every((c) => c.completed));
          },
        },
      ];
      for (const c of cases) {
        const s = await scenario(backend, c.options);
        try {
          await c.setup?.(s);
          const { opened } = await s.snapshotAndRun();
          assert.equal(deliveryOf(opened, s.workId)?.status, 'delivered', c.name);
          assert.equal((await harnessComments(opened.transport, s.task.id)).length, 1, c.name);
          await c.expect(opened, s);
        } finally {
          await s.cleanup();
        }
      }
      // Обрыв после части отметок критериев: продолжение без дублей и без нового writer.
      const p = await scenario(backend, {
        criteria: [{ title: 'Greets by name' }, { title: 'Exports greet' }],
        mapping: [
          { title: 'Greets by name', gate: 'unit', testId: 'greet.greets' },
          { title: 'Exports greet', gate: 'unit', evidence: 'gate' },
        ],
      });
      try {
        const o = await p.runOnly();
        const writer = p.calls.writer;
        const crashed = await p.worker({
          action: 'deliver',
          workId: p.workId,
          faults: [{ op: 'setCriterion', nth: 1, action: 'exit-after' }],
        });
        assert.equal(crashed.code, 75, crashed.stderr);
        const mid = await o.transport.readTask(p.task.id);
        assert.deepEqual(
          mid.task.criteria.map((c) => c.completed),
          [true, false],
          'частичная запись',
        );
        await p.waitLeases();
        const resumed = await p.worker({ action: 'deliver', workId: p.workId });
        assert.equal(resumed.output?.ok, true, resumed.stderr);
        const read = await o.transport.readTask(p.task.id);
        assert.equal(read.task.column, 'done');
        assert.ok(read.task.criteria.every((c) => c.completed));
        assert.equal(
          (await harnessComments(o.transport, p.task.id)).length,
          1,
          'append-only запись не повторена',
        );
        const op = o.connector.store.operations({ workId: p.workId })[0]!;
        assert.ok(
          op.steps.every((x) => x.sends === 1),
          JSON.stringify(op.steps.map((x) => [x.kind, x.sends])),
        );
        assert.equal(p.calls.writer, writer, 'нового writer нет');
      } finally {
        await p.cleanup();
      }
    },
  );

  t(
    'D06',
    'один владелец доставки: параллельный процесс не отправляет ту же операцию; после падения владельца — перехват только после истечения lease',
    async () => {
      const s = await scenario(backend);
      try {
        const o = await s.runOnly();
        const barrier = new FileBarrier(join(s.root, 'barriers'), 'owner-a', 60_000);
        const ownerA = s.worker({
          action: 'deliver',
          workId: s.workId,
          owner: 'A',
          faults: [
            {
              op: 'addComment',
              nth: 1,
              action: 'barrier',
              barrier: { dir: barrier.dir, name: barrier.name },
            },
          ],
        });
        try {
          await barrier.reached(60_000);
          const ownerB = await s.worker({ action: 'deliver', workId: s.workId, owner: 'B' });
          assert.equal(ownerB.code, 0, ownerB.stderr);
          const stateB = (
            ownerB.output?.result as { delivery: { status: string; lastError?: string }[] }
          ).delivery.at(-1)!;
          assert.equal(stateB.status, 'failed');
          assert.match(stateB.lastError ?? '', /другой владелец/);
          assert.equal((await harnessComments(o.transport, s.task.id)).length, 0, 'B не отправлял');
        } finally {
          barrier.release();
        }
        const a = await ownerA;
        assert.equal(a.output?.ok, true, a.stderr);
        assert.equal((await harnessComments(o.transport, s.task.id)).length, 1);
        assert.equal(
          deliveryOf(o, s.workId)!.status,
          'delivered',
          'поздний отказ B не перезаписал delivered',
        );
      } finally {
        await s.cleanup();
      }
      const c = await scenario(backend, {
        config: (cfg) => ((cfg.limits as Record<string, unknown>) = { leaseMs: 8000 }),
      });
      try {
        const o = await c.runOnly();
        const crashed = await c.worker({
          action: 'deliver',
          workId: c.workId,
          owner: 'A',
          faults: [{ op: 'addComment', nth: 1, action: 'exit-after' }],
        });
        assert.equal(crashed.code, 75, crashed.stderr);
        const key = o.connector.store.operations({ workId: c.workId })[0]!.key;
        const held = o.connector.store.lease(key)!;
        const startedB = Date.now();
        const early = await c.worker({ action: 'deliver', workId: c.workId, owner: 'B' });
        // B стартовал задолго до истечения lease упавшего A: перехвата нет.
        if (startedB + 3000 < held.expiresAt) {
          const st = (early.output?.result as { delivery: { status: string }[] }).delivery.at(-1)!;
          assert.equal(
            st.status,
            'failed',
            'действующий lease не перехватывается: ' + JSON.stringify(early.output),
          );
          assert.equal(
            (await harnessComments(o.transport, c.task.id)).length,
            1,
            'B ничего не отправил',
          );
        }
        const wait = held.expiresAt - Date.now() + 200;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const late = await c.worker({ action: 'deliver', workId: c.workId, owner: 'C' });
        assert.equal(late.output?.ok, true, late.stderr);
        assert.equal(
          (await harnessComments(o.transport, c.task.id)).length,
          1,
          'intent не потерян, дубликата нет',
        );
        const op = o.connector.store.operation(key)!;
        assert.equal(op.status, 'delivered');
        assert.ok(o.connector.store.lease(key)!.fence > held.fence, 'fencing увеличен');
      } finally {
        await c.cleanup();
      }
    },
  );

  t(
    'R04',
    'история: intent до writer, отказ записи intent блокирует старт, отказ/отмена/успех по правилам, restart без дублей, устаревший владелец не завершает сессию, без токенов и логов',
    async () => {
      // Успех и порядок.
      {
        let seen: { childIntent: boolean } | undefined;
        let opened: Opened | undefined;
        const s = await scenario(backend, {
          onWriter: async (request) => {
            const links = opened!.connector.history.links(request.subject!.workId);
            const child = links.find(
              (l) => l.kind === 'child' && l.attemptId === request.subject!.attemptId,
            );
            const cps = child?.sessionId
              ? await opened!.transport.checkpoints(child.sessionId)
              : [];
            seen = { childIntent: cps.some((c) => c.kind === 'intent') };
          },
        });
        try {
          opened = await s.open();
          await opened.connector.snapshot(join(s.root, 'snapshot'));
          await opened.connector.run(opened.h, { author: 'claude' });
          assert.equal(seen?.childIntent, true, 'intent дочерней сессии записан до writer');
          const links = opened.connector.history.links(s.workId);
          const root = links.find((l) => l.kind === 'root')!;
          const child = links.find((l) => l.kind === 'child')!;
          assert.equal((await opened.transport.getSession(root.sessionId!)).status, 'completed');
          assert.equal((await opened.transport.getSession(child.sessionId!)).status, 'completed');
          const rootCps = await opened.transport.checkpoints(root.sessionId!);
          const childCps = await opened.transport.checkpoints(child.sessionId!);
          assert.deepEqual(
            rootCps.map((c) => c.kind),
            ['intent', 'result'],
          );
          assert.deepEqual(
            childCps.map((c) => c.kind),
            ['intent', 'result'],
          );
          const result = opened.h.result(s.workId).result;
          assert.ok(
            result.outcome === 'accepted' && childCps[1]!.body.includes(result.shas.result),
          );
          const attempt = opened.h.engine.read((v) => v.attempts(s.workId)[0]!);
          const all = JSON.stringify([
            rootCps,
            childCps,
            await opened.transport.getSession(root.sessionId!),
            await opened.transport.getSession(child.sessionId!),
          ]);
          assert.ok(!all.includes(attempt.token), 'lease token не в истории');
          assert.ok(
            !all.includes(s.state) && !all.includes(s.repo),
            'нет локальных путей/журналов',
          );
          assert.notEqual(root.runId, attempt.token);
        } finally {
          await s.cleanup();
        }
      }
      // Отказ записи intent — дочерняя работа не начинается.
      {
        const s = await scenario(backend);
        try {
          const o = await s.open({ faults: [{ op: 'startSession', action: 'fail-before-send' }] });
          await o.connector.snapshot(join(s.root, 'snapshot'));
          const run = await o.connector.run(o.h, { author: 'claude' });
          assert.notEqual(run.works[0]!.status, 'done');
          assert.equal(s.calls.writer, 0, 'writer не вызывался');
        } finally {
          await s.cleanup();
        }
      }
      // Отказ writer и reviewer, отмена.
      for (const variant of ['writer', 'reviewer', 'cancel'] as const) {
        let opened: Opened | undefined;
        const s = await scenario(backend, {
          ...(variant === 'writer' ? { writer: 'incomplete' as const } : {}),
          ...(variant === 'reviewer' ? { reviewer: 'reject' as const } : {}),
          ...(variant === 'cancel'
            ? {
                onWriter: (request: RuntimeRequest) =>
                  void opened!.h.engine.cancel(request.subject!.workId, 'отмена человеком'),
              }
            : {}),
        });
        try {
          opened = await s.open();
          await opened.connector.snapshot(join(s.root, 'snapshot'));
          await opened.connector.run(opened.h, { author: 'claude' }).catch(() => undefined);
          await opened.connector.deliver(opened.h, s.workId).catch(() => undefined);
          const links = opened.connector.history.links(s.workId);
          const root = links.find((l) => l.kind === 'root')!;
          const child = links.find((l) => l.kind === 'child')!;
          assert.equal(
            (await opened.transport.getSession(child.sessionId!)).status,
            'cancelled',
            variant + ': дочерняя отменена',
          );
          assert.equal(
            (await opened.transport.getSession(root.sessionId!)).status,
            'cancelled',
            variant + ': корень отменён',
          );
          const read = await opened.transport.readTask(s.task.id);
          assert.notEqual(read.task.column, 'done', variant);
        } finally {
          await s.cleanup();
        }
      }
      // Restart controller: обрыв после fork у получателя, новая попытка в новом процессе.
      {
        const s = await scenario(backend);
        try {
          const o = await s.open();
          const snap = await o.connector.snapshot(join(s.root, 'snapshot'));
          const order = snap.snapshot.graph.orders[0]!;
          const work = {
            id: order.id,
            graphId: snap.graphId,
            order,
            status: 'running',
            attempt: 1,
          } as unknown as WorkState;
          const attempt = (id: string, n: number) =>
            ({
              id,
              workId: order.id,
              attempt: n,
              runtime: 'claude',
              token: 'secret-lease-' + id,
            }) as unknown as AttemptState;
          const crashed = await s.worker({
            action: 'begin-attempt',
            attempt: { work, attempt: attempt('run-a', 1), baseSha: s.target() },
            faults: [{ op: 'fork', nth: 1, action: 'exit-after' }],
          });
          assert.equal(crashed.code, 75, crashed.stderr);
          const next = await s.worker({
            action: 'begin-attempt',
            attempt: { work, attempt: attempt('run-b', 2), baseSha: s.target() },
          });
          assert.equal(next.output?.ok, true, JSON.stringify(next.output) + next.stderr);
          const links = o.connector.history.links(order.id);
          const root = links.find((l) => l.kind === 'root')!;
          const a = links.find((l) => l.attemptId === 'run-a')!;
          const b = links.find((l) => l.attemptId === 'run-b')!;
          assert.equal(
            (await o.transport.getSession(a.sessionId!)).status,
            'cancelled',
            'осиротевший fork отменён по фактам',
          );
          assert.equal((await o.transport.getSession(b.sessionId!)).status, 'open');
          const rootCps = await o.transport.checkpoints(root.sessionId!);
          assert.equal(
            rootCps.filter((c) => c.kind === 'intent').length,
            1,
            'intent корня не продублирован',
          );
          assert.equal(
            (await o.transport.findSessions(root.steps[0]!.marker)).length,
            1,
            'корень не продублирован',
          );
          const all = JSON.stringify(await o.transport.checkpoints(b.sessionId!));
          assert.ok(!all.includes('secret-lease-'), 'lease token не в истории');
        } finally {
          await s.cleanup();
        }
      }
      // Restart во время закрытия истории при доставке: без дубля checkpoint.
      {
        const s = await scenario(backend);
        try {
          const o = await s.runOnly();
          const crashed = await s.worker({
            action: 'deliver',
            workId: s.workId,
            faults: [{ op: 'checkpoint', nth: 1, action: 'exit-after' }],
          });
          assert.equal(crashed.code, 75, crashed.stderr);
          await s.waitLeases();
          const resumed = await s.worker({ action: 'deliver', workId: s.workId });
          assert.equal(resumed.output?.ok, true, resumed.stderr);
          const cps = await historyCheckpoints(o, s.workId);
          assert.equal(
            cps.filter((c) => c.session === 'child' && c.kind === 'result').length,
            1,
            'checkpoint результата один',
          );
          assert.equal(cps.filter((c) => c.session === 'root' && c.kind === 'result').length, 1);
        } finally {
          await s.cleanup();
        }
      }
      // Устаревший владелец: сессию перехватили — наш run её не завершает.
      {
        const s = await scenario(backend);
        try {
          const o = await s.runOnly();
          const child = o.connector.history.links(s.workId).find((l) => l.kind === 'child')!;
          await s.project.admin.takeover(child.sessionId!);
          await o.h.deliver(s.workId, o.connector.sink);
          assert.equal(deliveryOf(o, s.workId)!.status, 'conflict');
          const session = await o.transport.getSession(child.sessionId!);
          assert.equal(session.status, 'open', 'сессия осталась у нового владельца');
          assert.notEqual(session.currentRunId, child.runId);
          const cps = await o.transport.checkpoints(child.sessionId!);
          assert.equal(
            cps.filter((c) => c.kind === 'result').length,
            0,
            'устаревший run не записал итог',
          );
        } finally {
          await s.cleanup();
        }
      }
    },
  );
}
