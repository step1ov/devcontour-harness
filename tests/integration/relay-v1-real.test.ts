import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { TransportError, type RelayTransport } from '../../src/integrations/connector/transport.ts';
import { createTransport, type RelayV1Transport } from '../../src/integrations/relay-v1/index.ts';

/*
 * R01 против НАСТОЯЩЕГО изолированного сервера Relay v1
 * (scripts/acceptance/relay-v1-server.mjs). Если сборки нет, тест падает с
 * BLOCKED, а не пропускается: подготовка — `node scripts/acceptance/relay-v1-server.mjs prepare`.
 * DC_R01_EVIDENCE=<dir> сохраняет замаскированные HTTP-ответы и версию сервера.
 */

interface Fixture {
  url: string;
  projectId: string;
  tmp: string;
  context: { capabilities: string[]; storagePath: string };
  stop(): Promise<void>;
  createTask(i: {
    title: string;
    description?: string;
    column?: string;
    criteria?: (string | { title: string; description?: string })[];
    parentId?: string;
    dependencies?: string[];
  }): Promise<{ id: string; key: string; revision: number }>;
  createDocument(i: {
    name: string;
    body: string;
    taskId: string;
  }): Promise<{ ref: { id: string } }>;
  task(ref: string): Promise<{ id: string; revision: number; column: string }>;
  comments(ref: string): Promise<{ items: { id: string }[] }>;
  completeCriterion(ref: string, id: string, completed?: boolean): Promise<unknown>;
  moveTask(ref: string, column: string): Promise<unknown>;
  sessionCount(): Promise<number>;
  historyTotals(): Promise<Record<string, number>>;
  session(
    ref: string,
  ): Promise<{ session: { status: string; currentRunId: string | null; revision: number } }>;
  history(ref: string): Promise<{ items: { kind: string }[] }>;
}
interface ServerModule {
  startDroppingProxy(
    url: string,
    drop: (method: string, path: string) => boolean,
  ): Promise<{ url: string; dropped: { status: number }[]; close(): Promise<void> }>;
  startRelayServer(o?: Record<string, unknown>): Promise<Fixture>;
  buildInfo(): Record<string, string>;
  isBuilt(): boolean;
  relayV1Paths(): { buildDir: string };
}

const serverModulePath = new URL('../../scripts/acceptance/relay-v1-server.mjs', import.meta.url)
  .href;
const evidenceDir = process.env.DC_R01_EVIDENCE;
const recorded: unknown[] = [];

let mod: ServerModule;
let srv: Fixture;
let t: RelayV1Transport;

function sanitize(text: string): string {
  let out = text;
  if (srv?.tmp)
    out = out
      .split(srv.tmp)
      .join('<tmp>')
      .split(srv.tmp.replace(/^\/private/, ''))
      .join('<tmp>');
  return out.replace(/"(storagePath|configPath)":"[^"]*"/g, '"$1":"<masked>"');
}

/** fetch с записью пар запрос/ответ для evidence (тела замаскированы). */
const recordingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (evidenceDir) {
    const text = await res.clone().text();
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(href);
    const parse = (raw: string): unknown => JSON.parse(sanitize(raw));
    recorded.push({
      method: init?.method ?? 'GET',
      path: `${u.pathname}${u.search}`,
      status: res.status,
      request: typeof init?.body === 'string' ? parse(init.body) : undefined,
      response: (() => {
        try {
          return parse(text);
        } catch {
          return sanitize(text).slice(0, 2000);
        }
      })(),
    });
  }
  return res;
};

async function expectError(
  p: Promise<unknown>,
  kind: string,
  code?: string,
): Promise<TransportError> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  assert.ok(
    caught instanceof TransportError,
    `expected TransportError ${kind}/${code}, got ${String(caught)}`,
  );
  assert.equal(caught.kind, kind, caught.message);
  if (code) assert.equal(caught.details.code, code, caught.message);
  assert.match(caught.message, new RegExp(`project ${srv.projectId}`));
  return caught;
}

void describe('relay-v1 transport against the real isolated server', () => {
  before(async () => {
    mod = (await import(serverModulePath)) as ServerModule;
    if (!mod.isBuilt()) {
      throw new Error(
        `BLOCKED R01: Relay v1 build missing at ${mod.relayV1Paths().buildDir}; run node scripts/acceptance/relay-v1-server.mjs prepare`,
      );
    }
    srv = await mod.startRelayServer();
    t = createTransport(
      { endpoint: srv.url, projectId: srv.projectId, actor: 'dc-harness-test' },
      { fetch: recordingFetch },
    );
  });

  after(async () => {
    try {
      if (evidenceDir && srv) {
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(
          join(evidenceDir, 'real-http.json'),
          `${JSON.stringify(recorded, null, 2)}\n`,
        );
        writeFileSync(
          join(evidenceDir, 'server.json'),
          `${JSON.stringify({ ...mod.buildInfo(), capabilities: srv.context.capabilities }, null, 2)}\n`,
        );
      }
    } finally {
      await srv?.stop();
    }
  });

  it('R01/real: identity is project-scoped, declares history capability and creates no history', async () => {
    const strip = (p: string) => p.replace(/^\/private/, '');
    assert.ok(
      strip(srv.context.storagePath).startsWith(strip(srv.tmp)),
      'storage lives in the temp dir, not ~/.relay',
    );
    const before = await srv.sessionCount();
    const totals = await srv.historyTotals();
    const id = await t.identity();
    await t.identity();
    assert.equal(id.provider, 'relay-v1-http');
    assert.equal(id.projectId, srv.projectId);
    assert.ok(id.capabilities.includes('relay-work-history-v1'));
    assert.equal(id.build.contractVersion, '1');
    assert.equal(
      await srv.sessionCount(),
      before,
      'read-only identity check creates no work-history session',
    );
    assert.deepEqual(await srv.historyTotals(), totals, 'no runs/checkpoints either');
  });

  it('R01/real: another projectId is not found (no fallback to the local project)', async () => {
    const other = createTransport({ endpoint: srv.url, projectId: 'Zz000000', actor: 'x' });
    await assert.rejects(
      other.readTask('PRODUCT-1'),
      (x: unknown) =>
        x instanceof TransportError && x.kind === 'not-found' && /project Zz000000/.test(x.message),
    );
    await assert.rejects(
      other.addComment('PRODUCT-1', { title: 'x', body: 'y' }),
      (x: unknown) => x instanceof TransportError && x.kind === 'not-found',
    );
  });

  it('R01/real: readTask reads full task, criteria, children, dependencies and documents consistently', async () => {
    const dep = await srv.createTask({ title: 'Dependency', criteria: ['dep criterion'] });
    const root = await srv.createTask({
      title: 'Root task',
      description: '## Requirement\n\nExact **markdown**',
      criteria: [{ title: 'Criterion A', description: 'full description A' }, 'Criterion B'],
      dependencies: [dep.id],
    });
    const child = await srv.createTask({ title: 'Child', parentId: root.id });
    await srv.createDocument({ name: 'Spec', body: '# Spec\n\nbody', taskId: root.id });
    const read = await t.readTask(root.key);
    assert.equal(read.task.id, root.id);
    assert.equal(read.task.description, '## Requirement\n\nExact **markdown**');
    assert.deepEqual(
      read.task.criteria.map((c) => [c.title, c.description, c.completed]),
      [
        ['Criterion A', 'full description A', false],
        ['Criterion B', '', false],
      ],
    );
    assert.deepEqual(read.task.dependencies, [dep.id]);
    assert.deepEqual(
      read.dependencies.map((d) => [d.id, d.finished]),
      [[dep.id, false]],
    );
    assert.deepEqual(
      read.children.map((c) => [c.id, c.finished]),
      [[child.id, false]],
    );
    assert.deepEqual(
      read.documents.map((d) => [d.name, d.body]),
      [['Spec', '# Spec\n\nbody']],
    );
    assert.equal(read.consistency.before, read.consistency.after);
    const again = await t.readTask(root.id);
    assert.equal(
      again.consistency.after,
      read.consistency.after,
      'unchanged task gives the same token',
    );
    await srv.completeCriterion(root.id, read.task.criteria[0]!.id);
    const changed = await t.readTask(root.id);
    assert.notEqual(changed.consistency.after, read.consistency.after);
  });

  it('R01/real: comments are append-only and do not change task revision', async () => {
    const task = await srv.createTask({ title: 'Comments' });
    const a = await t.addComment(task.id, { title: 'Result', body: '<!-- dc:marker=m1 -->\nbody' });
    const b = await t.addComment(task.id, { title: 'Result', body: '<!-- dc:marker=m1 -->\nbody' });
    assert.notEqual(a.commentId, b.commentId, 'identical repeat creates a new comment (no dedup)');
    const list = await t.listComments(task.key);
    assert.deepEqual(
      list.map((c) => c.id),
      [a.commentId, b.commentId],
    );
    assert.equal(list[0]!.body, '<!-- dc:marker=m1 -->\nbody');
    assert.equal(list[0]!.actor, 'dc-harness-test');
    assert.equal((await srv.task(task.id)).revision, task.revision);
  });

  it('R01/real: criterion complete and move use CAS; stale revision is conflict with actual revision', async () => {
    const task = await srv.createTask({ title: 'CAS', criteria: ['only'] });
    const read = await t.readTask(task.id);
    const crit = read.task.criteria[0]!;
    const stale = await expectError(
      t.setCriterion(task.id, {
        criterionId: crit.id,
        completed: true,
        ifRevision: read.task.revision + 5,
      }),
      'conflict',
      'REVISION_CONFLICT',
    );
    assert.equal(stale.details.actualRevision, read.task.revision);
    const r1 = await t.setCriterion(task.id, {
      criterionId: crit.id,
      completed: true,
      ifRevision: read.task.revision,
    });
    assert.equal(r1.revision, read.task.revision + 1);
    await expectError(
      t.move(task.id, { column: 'review', ifRevision: read.task.revision }),
      'conflict',
      'REVISION_CONFLICT',
    );
    const r2 = await t.move(task.id, { column: 'review', ifRevision: r1.revision });
    assert.equal(r2.revision, r1.revision + 1);
    assert.equal((await srv.task(task.id)).column, 'review');
  });

  it('R01/real: done guards are refused, not bypassed', async () => {
    const parent = await srv.createTask({ title: 'Guarded', criteria: ['must'] });
    const child = await srv.createTask({ title: 'Guard child', parentId: parent.id });
    let read = await t.readTask(parent.id);
    await expectError(
      t.move(parent.id, { column: 'done', ifRevision: read.task.revision }),
      'refused',
      'TASK_ACCEPTANCE_INCOMPLETE',
    );
    const rev = await t.setCriterion(parent.id, {
      criterionId: read.task.criteria[0]!.id,
      completed: true,
      ifRevision: read.task.revision,
    });
    await expectError(
      t.move(parent.id, { column: 'done', ifRevision: rev.revision }),
      'refused',
      'TASK_BLOCKED',
    );
    const c = await srv.task(child.id);
    await t.move(child.id, { column: 'done', ifRevision: c.revision });
    read = await t.readTask(parent.id);
    assert.deepEqual(
      read.children.map((x) => x.finished),
      [true],
    );
    const done = await t.move(parent.id, { column: 'done', ifRevision: read.task.revision });
    await expectError(
      t.setCriterion(parent.id, {
        criterionId: read.task.criteria[0]!.id,
        completed: false,
        ifRevision: done.revision,
      }),
      'refused',
      'TASK_ACCEPTANCE_LOCKED',
    );
    assert.equal((await srv.task(parent.id)).column, 'done');
  });

  it('R01/real: full work-history cycle (start, intent, fork, attach, checkpoint, complete child, accept, complete root)', async () => {
    const marker = `dc-hist-${Date.now()}`;
    const start = await t.startSession({
      title: `Root ${marker}`,
      description: 'attempt',
      client: 'devcontour-harness',
    });
    assert.equal(start.session.status, 'open');
    assert.ok(start.runId);
    const runId = start.runId;
    const intent = await t.openIntent(start.session.key, {
      runId,
      ifRevision: start.session.revision,
      title: 'Intent',
      body: 'run child work',
      references: [],
    });
    assert.equal(intent.checkpoint?.kind, 'intent');
    const fork = await t.fork(intent.checkpoint.key, {
      runId,
      ifRevision: intent.session.revision,
      title: 'Child',
      description: 'child work',
    });
    const childPending = fork.childSession!;
    assert.equal(childPending.status, 'pending');
    assert.equal(childPending.parentSessionId, start.session.id);
    const attach = await t.attach(childPending.key, {
      ifRevision: childPending.revision,
      client: 'devcontour-harness',
    });
    assert.equal(attach.session.status, 'open');
    const childRun = attach.runId!;
    const childIntent = await t.openIntent(attach.session.key, {
      runId: childRun,
      ifRevision: attach.session.revision,
      title: 'Child intent',
      body: 'do it',
    });
    const childResult = await t.checkpoint(childIntent.checkpoint!.key, 'result', {
      runId: childRun,
      ifRevision: childIntent.session.revision,
      title: 'Child result',
      body: 'done',
      checks: 'gates ok',
    });
    assert.equal(childResult.checkpoint?.kind, 'result');
    const childDone = await t.finishSession(attach.session.key, 'complete', {
      runId: childRun,
      ifRevision: childResult.session.revision,
      result: 'child ok',
    });
    assert.equal(childDone.session.status, 'completed');
    const parentNow = await t.getSession(start.session.key);
    const accept = await t.checkpoint(intent.checkpoint.key, 'result', {
      runId,
      ifRevision: parentNow.revision,
      title: 'Parent result',
      body: 'accepted child',
      acceptedSessionIds: [childPending.id],
    });
    const rootDone = await t.finishSession(start.session.key, 'complete', {
      runId,
      ifRevision: accept.session.revision,
      result: 'all done',
    });
    assert.equal(rootDone.session.status, 'completed');
    assert.equal(rootDone.session.result, 'all done');
    const cps = await t.checkpoints(start.session.key);
    assert.deepEqual(
      cps.map((c) => c.kind),
      ['intent', 'result'],
    );
    assert.equal(cps[1]!.intentId, cps[0]!.id);
    const childCps = await t.checkpoints(childPending.id);
    assert.deepEqual(
      childCps.map((c) => [c.kind, c.runId]),
      [
        ['intent', childRun],
        ['result', childRun],
      ],
    );
    const found = await t.findSessions(marker);
    assert.deepEqual(
      found.map((s) => s.id),
      [start.session.id],
    );
    await expectError(
      t.openIntent(start.session.key, {
        runId,
        ifRevision: rootDone.session.revision,
        title: 'x',
        body: 'y',
      }),
      'conflict',
    );
  });

  it('R01/real: stale run is fenced after takeover; stale session revision is conflict', async () => {
    const start = await t.startSession({
      title: 'Fencing',
      description: 'd',
      client: 'controller-1',
    });
    const oldRun = start.runId!;
    const take = await t.takeover(start.session.key, {
      ifRevision: start.session.revision,
      reason: 'controller restart',
      client: 'controller-2',
    });
    const newRun = take.runId!;
    assert.notEqual(newRun, oldRun);
    assert.equal(take.session.currentRunId, newRun);
    await expectError(
      t.openIntent(start.session.key, {
        runId: oldRun,
        ifRevision: take.session.revision,
        title: 'stale',
        body: 'old owner',
      }),
      'conflict',
      'WORK_RUN_NOT_CURRENT',
    );
    await expectError(
      t.finishSession(start.session.key, 'complete', {
        runId: oldRun,
        ifRevision: take.session.revision,
        result: 'x',
      }),
      'conflict',
      'WORK_RUN_NOT_CURRENT',
    );
    const stale = await expectError(
      t.openIntent(start.session.key, {
        runId: newRun,
        ifRevision: start.session.revision,
        title: 'x',
        body: 'y',
      }),
      'conflict',
      'REVISION_CONFLICT',
    );
    assert.equal(stale.details.actualRevision, take.session.revision);
    const detail = await srv.session(start.session.key);
    assert.equal(detail.session.status, 'open', 'stale owner did not finish the session');
    const done = await t.finishSession(start.session.key, 'cancel', {
      runId: newRun,
      ifRevision: take.session.revision,
      result: 'cancelled by test',
    });
    assert.equal(done.session.status, 'cancelled');
  });

  it('R01/real: response lost after the real server committed the comment → uncertain, read-back finds exactly one', async () => {
    const task = await srv.createTask({ title: 'Lost response' });
    const proxy = await mod.startDroppingProxy(
      srv.url,
      (method, path) => method === 'POST' && path.endsWith('/comments'),
    );
    try {
      const viaProxy = createTransport({
        endpoint: proxy.url,
        projectId: srv.projectId,
        actor: 'dc-harness-test',
      });
      const e = await expectError(
        viaProxy.addComment(task.id, { title: 'Result', body: 'marker-lost-1' }),
        'uncertain',
      );
      assert.equal(e.details.mutation, true);
      assert.equal(proxy.dropped.length, 1);
      assert.equal(proxy.dropped[0]!.status, 200, 'server committed before the response was lost');
      const list = await t.listComments(task.id);
      assert.deepEqual(
        list.map((c) => c.body),
        ['marker-lost-1'],
        'exactly one comment; transport did not retry',
      );
    } finally {
      await proxy.close();
    }
  });

  it('R01/real: transports are independent per projectId (fresh RelayTransport for a fresh project)', async () => {
    const fresh = await mod.startRelayServer();
    try {
      const other: RelayTransport = createTransport({
        endpoint: fresh.url,
        projectId: fresh.projectId,
        actor: 'a',
      });
      const id = await other.identity();
      assert.equal(id.projectId, fresh.projectId);
      assert.notEqual(fresh.projectId, srv.projectId);
      await assert.rejects(
        other.readTask('PRODUCT-1'),
        (e: unknown) => e instanceof TransportError && e.kind === 'not-found',
      );
    } finally {
      await fresh.stop();
    }
  });
});
