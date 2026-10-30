/**
 * Базовая линия коннектора: зависимость, закрытая до внедрения harness,
 * принимается только явной записью человека. Сквозные проверки — через набор
 * коннектора (подделка backend, настоящий Git и runner), `review-plan` — через
 * публичный CLI и настоящий адаптер relay-v1-http.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError, cliDataSchemas, digestOf, type WorkGraph } from '../src/contracts/index.ts';
import {
  buildSnapshot,
  connectorIdOf,
  loadConfig,
  openConnector,
  orderIdOf,
  parseConfig,
  TransportError,
  type SnapshotManifest,
} from '../src/integrations/connector/index.ts';
import { baselineRecord } from '../src/integrations/connector/config.ts';
import {
  fakeSuiteBackend,
  harnessComments,
  scenario,
  type Scenario,
} from '../src/integrations/connector/testing.ts';

const backend = fakeSuiteBackend();
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const bin = (name: string) => fileURLToPath(new URL(`./fixtures/bin/${name}`, import.meta.url));
const reason = 'Closed by hand before the harness was adopted';

const refused = (code: string, text?: RegExp) => (error: unknown) =>
  error instanceof HarnessError && error.code === code && (!text || text.test(error.message));

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();

/** Задача, которую человек закрыл руками: done есть, receipt нет. */
const closedByHand = async (s: Scenario) => {
  const task = await s.project.admin.createTask({
    title: 'Old work',
    description: 'Closed by a person before the harness was adopted',
    column: 'ready',
    criteria: [{ title: 'Manual' }],
  });
  await s.project.admin.completeCriterion(task.id, task.criteria[0]!);
  await s.project.admin.move(task.id, 'done');
  return task;
};

/** Исполняемая задача конфигурации, зависящая от `dep`. */
const dependent = async (s: Scenario, ...deps: { id: string }[]) => {
  const task = await s.project.admin.createTask({
    title: 'Use greeting',
    description: "Add greet(name) to src/greet.js returning 'Hello, <name>!'.",
    column: 'ready',
    criteria: [{ title: 'Greets by name' }],
    dependencies: deps.map((d) => d.id),
  });
  (s.config.tasks as { ref: string }[])[0]!.ref = task.id;
  return task;
};

const orderOf = (s: Scenario, id: string) => orderIdOf(s.project.provider, s.project.projectId, id);

const setBaseline = (s: Scenario, baseline: unknown) => {
  s.config.baseline = baseline as never;
};

/** Закрытая руками зависимость, задача над ней и запись базовой линии. */
const listed = async (s: Scenario) => {
  const dep = await closedByHand(s);
  const task = await dependent(s, dep);
  const sha = s.target();
  setBaseline(s, { sha, tasks: [dep.key], reason });
  return { dep, task, sha };
};

test('B01: указанная задача принимается, runtime и доставка идут, результат виден как принятый человеком', async () => {
  const s = await scenario(backend);
  try {
    const { dep, task, sha } = await listed(s);
    const before = s.calls.writer;
    const { opened, run } = await s.snapshotAndRun();
    assert.equal(run.works[0]!.status, 'done');
    assert.equal(s.calls.writer, before + 1, 'writer вызван');
    assert.deepEqual(run.baseline, { sha, reason, tasks: [dep.key] });
    cliDataSchemas.run.parse(run);

    const pinned = opened.connector.store.latestSnapshot(run.graphId)!;
    const graph = pinned.graph as WorkGraph;
    const depOrder = orderOf(s, dep.id);
    assert.deepEqual(graph.prerequisites, [
      {
        id: depOrder,
        repositoryId: 'app',
        resultSha: sha,
        receipt: {
          kind: 'trusted',
          issuer: connectorIdOf(s.project.provider, s.project.projectId),
          digest: digestOf(baselineRecord(opened.connector.config, dep.key, depOrder, 'app')),
        },
      },
    ]);
    assert.deepEqual(graph.orders[0]!.dependsOn, [depOrder]);
    const manifest = pinned.manifest as SnapshotManifest;
    assert.equal(manifest.tasks[0]!.dependencies[0]!.proof, 'baseline');
    assert.deepEqual(manifest.baseline, { sha, reason, tasks: [dep.key] });

    const comments = await harnessComments(opened.transport, task.id);
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /Зависимости без доказательства/);
    assert.ok(comments[0]!.body.includes(dep.key) && comments[0]!.body.includes(reason));

    const status = await opened.connector.status();
    assert.deepEqual(status.snapshot?.baseline, { sha, reason, tasks: [dep.key] });
    cliDataSchemas['source-status'].parse(status);
    const again = await opened.connector.snapshot(join(s.root, 'snapshot'));
    assert.equal(again.created, false);
    assert.deepEqual(again.baseline, { sha, reason, tasks: [dep.key] });
    const { snapshot, ...data } = again;
    void snapshot;
    cliDataSchemas['source-snapshot'].parse(data);
  } finally {
    await s.cleanup();
  }
});

test('B02: задача не из baseline — DEPENDENCY_UNPROVEN с указанием, как её принять; runtime не вызывается', async () => {
  const s = await scenario(backend);
  try {
    const other = await closedByHand(s);
    const dep = await closedByHand(s);
    await dependent(s, dep);
    setBaseline(s, { sha: s.target(), tasks: [other.key], reason });
    const calls = { ...s.calls };
    const o = await s.open();
    const snap = await o.connector.snapshot(join(s.root, 'snapshot'));
    assert.equal(snap.eligible, false);
    assert.equal(snap.baseline, undefined);
    const problem = snap.problems.find((p) => p.includes('DEPENDENCY_UNPROVEN'));
    assert.ok(problem, snap.problems.join('; '));
    assert.ok(problem.includes(`baseline.tasks`) && problem.includes(dep.key), problem);
    assert.deepEqual(snap.snapshot.graph.prerequisites, []);
    await assert.rejects(o.connector.run(o.h, { author: 'claude' }), refused('NOT_READY'));
    assert.deepEqual(s.calls, calls);
  } finally {
    await s.cleanup();
  }
});

test('B03: незавершённая задача в baseline остаётся DEPENDENCY_UNFINISHED', async () => {
  const s = await scenario(backend);
  try {
    const dep = await s.project.admin.createTask({
      title: 'Still open',
      description: 'Listed, but the work is not finished',
      column: 'ready',
    });
    await dependent(s, dep);
    setBaseline(s, { sha: s.target(), tasks: [dep.key], reason });
    const calls = { ...s.calls };
    const o = await s.open();
    const snap = await o.connector.snapshot(join(s.root, 'snapshot'));
    assert.equal(snap.eligible, false);
    assert.ok(
      snap.problems.some((p) => p.includes('DEPENDENCY_UNFINISHED')),
      snap.problems.join('; '),
    );
    assert.deepEqual(snap.snapshot.graph.prerequisites, []);
    await assert.rejects(o.connector.run(o.h, { author: 'claude' }), refused('NOT_READY'));
    assert.deepEqual(s.calls, calls);
  } finally {
    await s.cleanup();
  }
});

test('B04: SHA вне target ref отклоняет движок, хотя источник доверяет записи', async () => {
  const s = await scenario(backend);
  try {
    const { dep } = await listed(s);
    // Настоящий коммит репозитория, не входящий в target ref.
    const side = git(s.repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'side');
    for (const sha of [side, '1'.repeat(40)]) {
      setBaseline(s, { sha, tasks: [dep.key], reason });
      const calls = { ...s.calls };
      const o = await s.open();
      const snap = await o.connector.snapshot(join(s.root, 'snapshot'));
      assert.equal(snap.eligible, true, 'снимок SHA не проверяет: это решает движок');
      assert.equal(await o.connector.source.trusts(snap.snapshot.graph.prerequisites[0]!), true);
      await assert.rejects(
        o.connector.run(o.h, { author: 'claude' }),
        refused('NOT_READY', /Предпосылка .* не подтверждена/),
      );
      assert.deepEqual(s.calls, calls, 'до runtime');
      o.close();
    }
  } finally {
    await s.cleanup();
  }
});

test('B05: схема принимает только полный SHA, явные ключи и непустую причину', () => {
  const sha = 'a'.repeat(40);
  const config = (baseline: unknown) =>
    parseConfig(
      {
        version: 1,
        provider: 'relay-v1-http',
        projectId: 'p1',
        actor: 'harness',
        relay: { endpoint: 'http://127.0.0.1:1' },
        repository: { id: 'app' },
        tasks: [{ ref: 'APP-9', writeScope: ['src'] }],
        baseline,
      },
      '/',
    );
  assert.equal(config({ sha, tasks: ['APP-1'], reason }).config.baseline?.sha, sha);
  assert.equal(config(undefined).config.baseline, undefined);
  const refusals: [string, unknown][] = [
    ['короткий SHA', { sha: sha.slice(0, 12), tasks: ['APP-1'], reason }],
    ['39 hex', { sha: sha.slice(1), tasks: ['APP-1'], reason }],
    ['SHA-256', { sha: 'a'.repeat(64), tasks: ['APP-1'], reason }],
    ['верхний регистр', { sha: 'A'.repeat(40), tasks: ['APP-1'], reason }],
    ['не hex', { sha: 'g'.repeat(40), tasks: ['APP-1'], reason }],
    ['ветка', { sha: 'refs/heads/main', tasks: ['APP-1'], reason }],
    ['без SHA', { tasks: ['APP-1'], reason }],
    ['без задач', { sha, reason }],
    ['пустой список', { sha, tasks: [], reason }],
    ['шаблон *', { sha, tasks: ['*'], reason }],
    ['шаблон ключа', { sha, tasks: ['APP-*'], reason }],
    ['шаблон ?', { sha, tasks: ['APP-?'], reason }],
    ['пробел в ключе', { sha, tasks: ['APP 1'], reason }],
    ['пустой ключ', { sha, tasks: [''], reason }],
    ['повтор ключа', { sha, tasks: ['APP-1', 'APP-1'], reason }],
    ['без причины', { sha, tasks: ['APP-1'] }],
    ['пустая причина', { sha, tasks: ['APP-1'], reason: '' }],
    ['причина из пробелов', { sha, tasks: ['APP-1'], reason: '   ' }],
    ['строка вместо списка', { sha, tasks: 'all', reason }],
    ['дата отсечения', { sha, tasks: ['APP-1'], reason, before: '2026-01-01' }],
    ['общий переключатель', { sha, tasks: ['APP-1'], reason, all: true }],
  ];
  for (const [what, value] of refusals)
    assert.throws(() => config(value), refused('INVALID_INPUT'), what);
  assert.throws(
    () => config({ sha, tasks: ['APP-9'], reason }),
    refused('INVALID_INPUT', /исполняется этой конфигурацией/),
    'задача самой конфигурации',
  );
});

test('B06: правка baseline после закрепления — APPROVAL_STALE до runtime; прежняя предпосылка больше не доверена', async () => {
  const s = await scenario(backend);
  try {
    const { dep, sha } = await listed(s);
    const other = await closedByHand(s);
    const o = await s.open();
    const pinned = await o.connector.snapshot(join(s.root, 'snapshot'));
    const prereq = pinned.snapshot.graph.prerequisites[0]!;
    assert.equal(await o.connector.source.trusts(prereq), true);
    o.close();

    git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'next');
    git(s.repo, 'update-ref', 'refs/heads/harness/accepted', 'HEAD');
    const edits: [string, unknown][] = [
      ['причина', { sha, tasks: [dep.key], reason: reason + '!' }],
      ['SHA', { sha: s.target(), tasks: [dep.key], reason }],
      ['лишняя задача', { sha, tasks: [dep.key, other.key], reason }],
    ];
    for (const [what, baseline] of edits) {
      setBaseline(s, baseline);
      const calls = { ...s.calls };
      const e = await s.open();
      assert.equal(await e.connector.source.trusts(prereq), false, what);
      await assert.rejects(
        e.connector.run(e.h, { author: 'claude' }),
        refused('APPROVAL_STALE'),
        what,
      );
      assert.deepEqual(s.calls, calls, what);
      assert.notEqual(
        (await e.connector.source.snapshot()).revision,
        pinned.revision,
        what + ': новая ревизия',
      );
      e.close();
    }
    setBaseline(s, undefined);
    delete s.config.baseline;
    const removed = await s.open();
    assert.equal(await removed.connector.source.trusts(prereq), false, 'запись удалена');
    await assert.rejects(
      removed.connector.run(removed.h, { author: 'claude' }),
      refused('APPROVAL_STALE'),
    );
  } finally {
    await s.cleanup();
  }
});

test('B07: подделанная предпосылка не принимается: другая задача, репозиторий, издатель, SHA; ошибка backend — не «нет»', async () => {
  const s = await scenario(backend);
  try {
    const { dep } = await listed(s);
    const unlisted = await closedByHand(s);
    const o = await s.open();
    const snap = await o.connector.snapshot(join(s.root, 'snapshot'));
    const prereq = snap.snapshot.graph.prerequisites[0]!;
    const config = o.connector.config;
    const source = o.connector.source;
    assert.equal(await source.trusts(prereq), true);
    const trustedReceipt = (digest: string) => ({ ...prereq.receipt, digest }) as never;

    // Digest не секрет: вычисленный для чужой задачи с ключом из baseline.
    const otherOrder = orderOf(s, unlisted.id);
    assert.equal(
      await source.trusts({
        ...prereq,
        id: otherOrder,
        receipt: trustedReceipt(digestOf(baselineRecord(config, dep.key, otherOrder, 'app'))),
      }),
      false,
      'ключ из baseline с поручением другой задачи',
    );
    assert.equal(
      await source.trusts({
        ...prereq,
        repositoryId: 'other',
        receipt: trustedReceipt(digestOf(baselineRecord(config, dep.key, prereq.id, 'other'))),
      }),
      false,
      'репозиторий вне конфигурации',
    );
    assert.equal(
      await source.trusts({ ...prereq, resultSha: '2'.repeat(40) }),
      false,
      'другой SHA с тем же digest',
    );
    assert.equal(
      await source.trusts({
        ...prereq,
        receipt: { ...prereq.receipt, issuer: 'someone-else' } as never,
      }),
      false,
      'чужой издатель',
    );
    assert.equal(
      await source.trusts({ ...prereq, receipt: trustedReceipt('0'.repeat(64)) }),
      false,
      'другой digest',
    );
    o.close();

    // Запись называет постоянный ID, а не ключ: снимок её не применяет, trusts — тоже.
    setBaseline(s, { sha: prereq.resultSha, tasks: [dep.key, unlisted.id], reason });
    const byId = await s.open();
    assert.equal(
      await byId.connector.source.trusts({
        ...prereq,
        id: otherOrder,
        receipt: trustedReceipt(
          digestOf(baselineRecord(byId.connector.config, unlisted.id, otherOrder, 'app')),
        ),
      }),
      false,
      'ID вместо ключа',
    );
    byId.close();
    setBaseline(s, { sha: prereq.resultSha, tasks: [dep.key], reason });

    const failing = await s.open({ faults: [{ op: 'readTask', action: 'fail-before-send' }] });
    await assert.rejects(failing.connector.source.trusts(prereq), refused('DELIVERY_FAILED'));
    failing.close();
    const transport = s.project.transport();
    const missing = new Proxy(transport, {
      get: (target, name, receiver) =>
        name === 'readTask'
          ? () =>
              Promise.reject(
                new TransportError('not-found', 'task.read', 'gone', {
                  provider: target.provider,
                  mutation: false,
                }),
              )
          : (Reflect.get(target, name, receiver) as unknown),
    });
    const gone = await s.open({ transport: missing });
    assert.equal(await gone.connector.source.trusts(prereq), false, 'задача удалена');
  } finally {
    await s.cleanup();
  }
});

test('B08: настоящий receipt важнее записи baseline', async () => {
  const s = await scenario(backend);
  try {
    const firstSha = s.target();
    const { opened } = await s.snapshotAndRun();
    const resultSha = s.target();
    assert.notEqual(resultSha, firstSha);
    opened.close();
    await dependent(s, s.task);
    setBaseline(s, { sha: firstSha, tasks: [s.task.key], reason });
    const o = await s.open();
    const snap = await o.connector.snapshot(join(s.root, 'snapshot-b'));
    assert.equal(snap.eligible, true, snap.problems.join('; '));
    const prereq = snap.snapshot.graph.prerequisites[0]!;
    assert.equal(prereq.resultSha, resultSha);
    assert.equal(snap.snapshot.manifest.tasks[0]!.dependencies[0]!.proof, 'receipt');
    assert.equal(snap.baseline, undefined, 'доказанное не показано как принятое');
    assert.equal(await o.connector.source.trusts(prereq), true);
    o.close();
    // Запись не использована, но её правка — всё равно новое согласование.
    setBaseline(s, { sha: firstSha, tasks: [s.task.key], reason: reason + '!' });
    const edited = await s.open();
    assert.notEqual((await edited.connector.source.snapshot()).revision, snap.revision);
  } finally {
    await s.cleanup();
  }
});

test('B09: одна зависимость у задач разных репозиториев — отказ: baseline это один коммит', async () => {
  const s = await scenario(backend);
  try {
    const dep = await closedByHand(s);
    const first = await dependent(s, dep);
    const second = await dependent(s, dep);
    s.config.tasks = [
      { ref: first.id, writeScope: ['src'] },
      { ref: second.id, writeScope: ['src'], repositoryId: 'lib' },
    ] as never;
    setBaseline(s, { sha: s.target(), tasks: [dep.key], reason });
    const o = await s.open();
    const snap = await o.connector.source.snapshot();
    assert.ok(
      snap.problems.some(
        (p) => p.code === 'DEPENDENCY_UNPROVEN' && /разных репозиториев/.test(p.message),
      ),
      JSON.stringify(snap.problems),
    );
  } finally {
    await s.cleanup();
  }
});

test('B10: файл конфигурации с baseline вне защиты писателя — отказ; вне репозитория или в protectedPaths — допускается', async () => {
  const s = await scenario(backend);
  try {
    await listed(s);
    const handle = await s.open();
    const baseDir = handle.h.options.baseDir;
    const connectorFor = (path: string) =>
      openConnector(loadConfig(path), { stateDir: s.state, transport: s.project.transport() });
    const write = (path: string) => {
      writeFileSync(path, JSON.stringify(s.config));
      return path;
    };
    mkdirSync(join(s.repo, 'test'), { recursive: true });

    const exposed = await connectorFor(write(join(s.repo, 'connector.json')));
    assert.match(exposed.baselineIssue(s.policy, baseDir) ?? '', /вне protectedPaths/);
    await assert.rejects(exposed.prepareRun(handle.h), refused('NOT_READY', /вне protectedPaths/));
    assert.match((await exposed.check(s.policy, baseDir)).problems.join('; '), /protectedPaths/);
    exposed.close();

    // Ссылка снаружи на файл в репозитории — тот же файл.
    const link = join(s.root, 'link.json');
    symlinkSync(join(s.repo, 'connector.json'), link);
    const linked = await connectorFor(link);
    await assert.rejects(linked.prepareRun(handle.h), refused('NOT_READY', /protectedPaths/));
    linked.close();

    const guarded = await connectorFor(write(join(s.repo, 'test', 'connector.json')));
    assert.equal(guarded.baselineIssue(s.policy, baseDir), undefined);
    guarded.close();
    const outside = await connectorFor(write(join(s.root, 'connector.json')));
    assert.equal(outside.baselineIssue(s.policy, baseDir), undefined);
    await outside.snapshot(join(s.root, 'snapshot'));
    await outside.prepareRun(handle.h);
    outside.close();

    // Без baseline расположение файла не ограничено (прежнее поведение).
    delete s.config.baseline;
    const plain = await connectorFor(write(join(s.repo, 'connector.json')));
    assert.equal(plain.baselineIssue(s.policy, baseDir), undefined);
    plain.close();
  } finally {
    await s.cleanup();
  }
});

/** Минимальный Relay v1 для настоящего адаптера в процессе CLI: чтение задач подделки. */
async function relayStub(s: Scenario) {
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url!, 'http://stub');
    const page = { items: [], total: 0, nextOffset: null, version: '1' };
    const path = url.pathname.replace(/^\/api\/v1\/projects\/[^/]+/, '');
    const task = /^\/board-tasks\/([^/]+)$/.exec(path)?.[1];
    if (!task) return send(200, { ok: true, data: page });
    s.project
      .transport()
      .readTask(decodeURIComponent(task))
      .then(
        ({ task: t }) =>
          send(200, {
            ok: true,
            data: {
              id: t.id,
              key: t.key,
              title: t.title,
              description: t.description,
              column: t.column,
              revision: t.revision,
              parentId: t.parentId,
              dependencies: [],
            },
          }),
        () => send(404, { ok: false, error: { code: 'NOT_FOUND', message: 'no task' } }),
      );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('B11: CLI review-plan --source доверяет baseline; без --source, с правкой файла и с незащищённым файлом — отказ до reviewer', async () => {
  const s = await scenario(backend);
  const stub = await relayStub(s);
  try {
    await listed(s);
    const cfg = {
      ...structuredClone(s.config),
      relay: { endpoint: stub.endpoint, timeoutMs: 5000 },
    };
    const connector = await openConnector(parseConfig(cfg, s.root), {
      stateDir: s.state,
      transport: s.project.transport(),
    });
    const snap = await connector.snapshot(join(s.root, 'snapshot-b'));
    assert.equal(snap.eligible, true, snap.problems.join('; '));
    connector.close();

    const source = join(s.root, 'connector.json');
    writeFileSync(source, JSON.stringify(cfg));
    const review = join(s.root, 'review-scenario.json');
    writeFileSync(
      review,
      JSON.stringify({
        reviewer: {
          result: {
            approved: true,
            summary: 'План полон',
            findings: [],
            discoveries: [],
            execution: { commands: [], noCommandsReason: 'Проверка плана' },
            previous: [],
          },
        },
      }),
    );
    const policy = join(s.root, 'policy.json');
    writeFileSync(
      policy,
      JSON.stringify({
        ...JSON.parse(JSON.stringify(s.policy)),
        approvalMode: 'operator',
        environment: { inherit: [], values: { FIXTURE_SCENARIO: review }, secrets: {} },
      }),
    );
    // Заглушка живёт в этом процессе: синхронный запуск CLI её бы заблокировал.
    const harness = (args: string[]) =>
      new Promise<{
        status: number | null;
        stderr: string;
        json: { data?: Record<string, unknown>; error?: { code: string; message: string } };
      }>((done) => {
        const child = spawn(
          process.execPath,
          ['--import', import.meta.resolve('tsx'), cli, ...args],
          {
            cwd: s.root,
            env: {
              ...process.env,
              NODE_OPTIONS: '',
              HARNESS_CODEX_BIN: bin('fake-codex'),
              HARNESS_CLAUDE_BIN: bin('fake-claude'),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('close', (status) => done({ status, stderr, json: JSON.parse(stdout) as never }));
      });
    const reviewPlan = (sourceFile?: string) =>
      harness([
        'review-plan',
        '--state',
        s.state,
        '--policy',
        policy,
        '--graph',
        snap.files.graph,
        '--context',
        snap.files.context,
        '--author',
        'external',
        ...(sourceFile ? ['--source', sourceFile] : []),
      ]);
    const reviewerCalls = () => {
      try {
        return Number(readFileSync(`${review}.codex.reviewer.count`, 'utf8'));
      } catch {
        return 0;
      }
    };

    const noSource = await reviewPlan();
    assert.equal(noSource.json.error?.code, 'NOT_READY', noSource.stderr);

    const edited = join(s.root, 'edited.json');
    writeFileSync(
      edited,
      JSON.stringify({
        ...cfg,
        baseline: { ...(cfg.baseline as object), reason: 'Reason changed after pinning' },
      }),
    );
    const stale = await reviewPlan(edited);
    assert.equal(stale.json.error?.code, 'NOT_READY', stale.stderr);
    assert.match(stale.json.error?.message ?? '', /не подтверждена/);

    const exposed = join(s.repo, 'connector.json');
    writeFileSync(exposed, JSON.stringify(cfg));
    const unprotected = await reviewPlan(exposed);
    assert.equal(unprotected.json.error?.code, 'NOT_READY', unprotected.stderr);
    assert.match(unprotected.json.error?.message ?? '', /protectedPaths/);
    assert.equal(reviewerCalls(), 0, 'отказы — до вызова reviewer');

    const valid = await reviewPlan(source);
    assert.equal(valid.status, 0, valid.stderr + JSON.stringify(valid.json.error));
    assert.equal(valid.json.data?.approved, true);
    assert.ok(reviewerCalls() > 0);
    const approve = await harness([
      'approve',
      '--state',
      s.state,
      '--subject',
      snap.graphId,
      '--digest',
      snap.graphDigest,
    ]);
    assert.equal(approve.status, 0, approve.stderr);
  } finally {
    await stub.close();
    await s.cleanup();
  }
});

test('B12: снимок без baseline не меняется: digest прежней версии, старый manifest читается', async () => {
  // Значения получены на версии до появления baseline; вход закреплён здесь.
  const config = parseConfig(
    {
      version: 1,
      provider: 'relay-v1-http',
      projectId: 'golden',
      actor: 'harness',
      relay: { endpoint: 'http://127.0.0.1:1' },
      repository: { id: 'app' },
      tasks: [{ ref: 'APP-2', writeScope: ['src'] }],
    },
    '/',
  ).config;
  const built = buildSnapshot({
    config,
    identity: {
      provider: 'relay-v1-http',
      projectId: 'golden',
      capabilities: [],
      build: {},
    },
    reads: [
      {
        task: {
          id: 'next',
          key: 'APP-2',
          title: 'Use old',
          description: 'Use the old work in src/use.js',
          column: 'ready',
          revision: 4,
          parentId: null,
          dependencies: ['dep'],
          criteria: [],
        },
        children: [],
        dependencies: [
          { id: 'dep', key: 'APP-1', title: 'Old', column: 'done', revision: 1, finished: true },
        ],
        documents: [],
        consistency: { before: 'a', after: 'a' },
      },
    ],
    rounds: 2,
    receiptOf: () => ({
      issuer: 'relay-v1-http-x',
      orderId: 'o',
      taskId: 'dep',
      repositoryId: 'app',
      resultSha: 'a'.repeat(40),
      workId: 'w',
      runId: 'r',
      operation: 'op',
    }),
  });
  assert.equal(built.revision, 'dadbac60f4a31314307be8c5eb5ee207cee11bb000a27b022ea24aea6bb4cf24');
  assert.equal(
    built.manifest.graphDigest,
    '7b665762ba9a4e204590e296ac42f5a06b992d4a4bd1665377f8bd63ebc1aeb0',
  );
  assert.equal(
    built.manifest.contextDigest,
    '10bbe41a72c38d5b0c668546107ba45663ac9b0e6f385063da4575fc4ad7fa1d',
  );

  // Запись прежнего формата в состоянии коннектора: зависимость без `proof`.
  const s = await scenario(backend);
  try {
    const dep = await closedByHand(s);
    await dependent(s, dep);
    const o = await s.open();
    const lease = o.connector.store.acquire('fixture-old', 'test', 5000).lease!;
    o.connector.store.putReceipt(
      {
        issuer: o.connector.id,
        orderId: orderOf(s, dep.id),
        taskId: dep.id,
        repositoryId: 'app',
        resultSha: s.target(),
        workId: orderOf(s, dep.id),
        runId: 'old',
        operation: 'fixture-old',
      },
      lease.token,
    );
    const fresh = await o.connector.source.snapshot();
    const manifest = JSON.parse(JSON.stringify(fresh.manifest)) as SnapshotManifest;
    const entry = manifest.tasks[0]!.dependencies[0]!;
    assert.equal(entry.proof, 'receipt');
    delete entry.proof;
    const { record, created } = o.connector.store.putSnapshot({
      revision: fresh.revision,
      graphId: fresh.graph.id,
      graph: fresh.graph,
      context: fresh.context,
      manifest,
    });
    assert.equal(created, true);
    const prepared = await o.connector.prepareRun(o.h);
    assert.deepEqual(prepared.graph, record.graph);
    assert.equal('baseline' in prepared, false);
    const status = await o.connector.status();
    assert.deepEqual(status.snapshot, { revision: fresh.revision, graphId: fresh.graph.id });
  } finally {
    await s.cleanup();
  }
});
