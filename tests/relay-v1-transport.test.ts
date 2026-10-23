import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { HarnessError } from '../src/contracts/index.ts';
import { TransportError } from '../src/integrations/connector/transport.ts';
import {
  classifyCode,
  createTransport,
  WORK_HISTORY_CAPABILITY,
} from '../src/integrations/relay-v1/index.ts';

/*
 * R01 transport tests: поддельный HTTP-сервер (node:http) для точных отказов.
 * Настоящий сервер Relay v1 проверяется в tests/relay-v1-real.test.ts.
 */

const P = 'Proj1234';
const BASE = `/api/v1/projects/${P}`;

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}
type Reply =
  | { status?: number; json: unknown }
  | { status?: number; raw: string; headers?: Record<string, string> }
  | 'hang'
  | 'destroy';
type Handler = (req: Seen) => Reply | undefined;

const ok = (data: unknown): Reply => ({ json: { ok: true, data } });
const err = (status: number, code: string, details?: unknown): Reply => ({
  status,
  json: { ok: false, error: { code, message: `server says ${code}`, exitCode: 4, details } },
});

const CAPS = ['relay-projects-v1', WORK_HISTORY_CAPABILITY];
const baseRoutes: Handler = (r) => {
  if (r.path === '/api/v1/health') return ok({ status: 'ok', stage: 'ready', contractVersion: 1 });
  if (r.path === `${BASE}/context`) return ok({ projectId: P, capabilities: CAPS, project: 'x' });
  return undefined;
};

async function fake(handler: Handler) {
  const seen: Seen[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const text = Buffer.concat(chunks).toString('utf8');
      const entry: Seen = {
        method: req.method ?? '',
        path: u.pathname,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
      };
      (entry as Seen & { query: URLSearchParams }).query = u.searchParams;
      seen.push(entry);
      const reply = handler(entry) ?? baseRoutes(entry) ?? err(404, 'NOT_FOUND');
      if (reply === 'hang') return;
      if (reply === 'destroy') {
        req.socket.destroy();
        return;
      }
      if ('json' in reply) {
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.json));
      } else {
        res.writeHead(reply.status ?? 200, reply.headers ?? { 'content-type': 'application/json' });
        res.end(reply.raw);
      }
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    seen,
    posts: () => seen.filter((s) => s.method === 'POST'),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const transportFor = (url: string, extra: Record<string, unknown> = {}) =>
  createTransport({ endpoint: url, projectId: P, actor: 'dc-test', timeoutMs: 2000, ...extra });

async function rejects(p: Promise<unknown>, kind: string, match?: (e: TransportError) => void) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof TransportError, `expected TransportError, got ${String(e)}`);
    assert.equal(e.kind, kind, e.message);
    assert.equal(e.details.provider, 'relay-v1-http');
    assert.equal(e.details.projectId, P);
    assert.match(e.message, new RegExp(`project ${P}`));
    assert.match(e.message, new RegExp(e.operation.replace(/\./g, '\\.')));
    match?.(e);
    return true;
  });
}

const taskView = (over: Record<string, unknown> = {}) => ({
  id: 'Task0001',
  key: 'PRODUCT-1',
  boardId: 'B',
  title: 'T',
  description: 'D',
  column: 'ready',
  rank: 1024,
  revision: 3,
  dependencies: [],
  related: [],
  parentId: null,
  canComplete: false,
  ...over,
});

void describe('relay-v1 transport (fake HTTP)', () => {
  it('R01: settings are validated (zod) and invalid settings are INVALID_INPUT', () => {
    assert.throws(
      () => createTransport({ endpoint: 'not a url', projectId: P, actor: 'a' }),
      (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
    );
    assert.throws(
      () => createTransport({ endpoint: 'http://127.0.0.1:1', projectId: '', actor: 'a' }),
      (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
    );
    assert.throws(
      () => createTransport({ endpoint: 'http://127.0.0.1:1', projectId: P, actor: 'a', extra: 1 }),
      (e: unknown) => e instanceof HarnessError,
    );
    const t = createTransport({ endpoint: 'http://127.0.0.1:1/api/v1/', projectId: P, actor: 'a' });
    assert.equal(t.provider, 'relay-v1-http');
  });

  it('R01: identity is read-only, project-scoped and returns declared capabilities', async () => {
    const srv = await fake(() => undefined);
    try {
      const id = await transportFor(srv.url).identity();
      assert.equal(id.provider, 'relay-v1-http');
      assert.equal(id.projectId, P);
      assert.deepEqual(id.capabilities, [...CAPS].sort());
      assert.equal(id.build.contractVersion, '1');
      assert.deepEqual(
        srv.seen.map((s) => `${s.method} ${s.path}`),
        ['GET /api/v1/health', `GET ${BASE}/context`],
      );
      assert.equal(srv.posts().length, 0);
    } finally {
      await srv.close();
    }
  });

  it('R01: invalid JSON is protocol, never empty success (GET and POST)', async () => {
    const srv = await fake((r) =>
      r.path.startsWith(`${BASE}/board-tasks`) ? { raw: '<html>oops' } : undefined,
    );
    try {
      const t = transportFor(srv.url);
      await rejects(t.readTask('PRODUCT-1'), 'protocol', (e) =>
        assert.equal(e.details.mutation, false),
      );
      await rejects(t.move('PRODUCT-1', { column: 'review', ifRevision: 3 }), 'protocol', (e) => {
        assert.equal(e.details.mutation, true);
        assert.doesNotMatch(e.message, /oops/);
      });
      assert.equal(srv.posts().length, 1, 'mutation sent exactly once, no retry');
    } finally {
      await srv.close();
    }
  });

  it('R01: invalid envelope and incompatible data are protocol, not an empty list', async () => {
    const replies: Reply[] = [
      { json: { items: [] } },
      { json: { ok: 'yes', data: {} } },
      { json: { ok: true } },
      { json: { ok: false, error: { message: 'no code' } } },
      { json: { ok: true, data: { items: 'x', total: 0, nextOffset: null, version: '1' } } },
      { json: { ok: false, error: { code: 'NOT_FOUND', message: 'x' } }, status: 200 },
      { json: { ok: true, data: taskView() }, status: 500 },
    ];
    for (const reply of replies) {
      const srv = await fake((r) =>
        r.path === `${BASE}/board-tasks/PRODUCT-1/comments` ? reply : undefined,
      );
      try {
        await rejects(transportFor(srv.url).listComments('PRODUCT-1'), 'protocol');
      } finally {
        await srv.close();
      }
    }
  });

  it('R01: structured errors are classified by error.code, with actual revision and safe reason', async () => {
    const cases: [Reply, string, number | undefined][] = [
      [err(409, 'REVISION_CONFLICT', { actual: 7, secret: 'TOPSECRET-BODY' }), 'conflict', 7],
      [err(409, 'WORK_RUN_NOT_CURRENT'), 'conflict', undefined],
      [err(409, 'WORK_INTENTS_OPEN'), 'conflict', undefined],
      [err(409, 'TASK_ACCEPTANCE_INCOMPLETE', { criterionIds: ['c1'] }), 'refused', undefined],
      [err(409, 'TASK_BLOCKED'), 'refused', undefined],
      [err(409, 'TASK_ACCEPTANCE_LOCKED'), 'refused', undefined],
      [err(400, 'VALIDATION_ERROR', [{ path: 'a', message: 'b' }]), 'refused', undefined],
      [err(404, 'NOT_FOUND'), 'not-found', undefined],
      [err(404, 'PROJECT_NOT_FOUND'), 'not-found', undefined],
      /* INVALID_ARGUMENT с exitCode 4 сервер отдаёт как 500: классификация по коду. */
      [err(500, 'INVALID_ARGUMENT'), 'refused', undefined],
      [err(500, 'INTERNAL'), 'uncertain', undefined],
    ];
    for (const [reply, kind, actual] of cases) {
      const srv = await fake((r) => (r.method === 'POST' ? reply : undefined));
      try {
        await rejects(
          transportFor(srv.url).move('PRODUCT-1', { column: 'done', ifRevision: 3 }),
          kind,
          (e) => {
            assert.equal(e.operation, 'task.move');
            assert.equal(e.details.actualRevision, actual);
            assert.equal(e.details.mutation, true);
            assert.doesNotMatch(e.message, /TOPSECRET/);
          },
        );
        assert.equal(srv.posts().length, 1);
      } finally {
        await srv.close();
      }
    }
    assert.equal(classifyCode('NOT_FOUND', 404, false), 'not-found');
    assert.equal(classifyCode('SOMETHING', 503, false), 'unavailable');
  });

  it('R01: unavailable server is unavailable before send (not uncertain, not empty)', async () => {
    const srv = await fake(() => undefined);
    const url = srv.url;
    await srv.close();
    const t = transportFor(url);
    await rejects(t.identity(), 'unavailable', (e) => assert.match(e.message, /ECONNREFUSED/));
    await rejects(t.readTask('PRODUCT-1'), 'unavailable');
    await rejects(t.addComment('PRODUCT-1', { title: 'x', body: 'y' }), 'unavailable', (e) =>
      assert.equal(e.details.mutation, false),
    );
  });

  it('R01: missing history capability → unsupported without calling any work-history route', async () => {
    const srv = await fake((r) =>
      r.path === `${BASE}/context`
        ? ok({ projectId: P, capabilities: ['relay-projects-v1'] })
        : undefined,
    );
    try {
      const t = transportFor(srv.url);
      await rejects(t.startSession({ title: 't', description: 'd', client: 'c' }), 'unsupported');
      await rejects(t.getSession('S-x'), 'unsupported');
      await rejects(t.findSessions('m'), 'unsupported');
      await rejects(t.checkpoints('S-x'), 'unsupported');
      await rejects(t.takeover('S-x', { ifRevision: 1, reason: 'r', client: 'c' }), 'unsupported');
      assert.equal(srv.seen.filter((s) => s.path.includes('work-history')).length, 0);
      assert.equal(srv.posts().length, 0);
      assert.equal(
        srv.seen.filter((s) => s.path === `${BASE}/context`).length,
        1,
        'capability cached per transport',
      );
    } finally {
      await srv.close();
    }
  });

  it('R01: timeout on GET is unavailable; timeout on POST is uncertain (mutation may have applied)', async () => {
    const srv = await fake((r) => (r.path.includes('/board-tasks') ? 'hang' : undefined));
    try {
      const t = transportFor(srv.url, { timeoutMs: 150 });
      await rejects(t.readTask('PRODUCT-1'), 'unavailable', (e) =>
        assert.match(e.message, /timeout/),
      );
      await rejects(t.move('PRODUCT-1', { column: 'review', ifRevision: 3 }), 'uncertain', (e) => {
        assert.equal(e.details.mutation, true);
        assert.match(e.message, /timeout/);
      });
      assert.equal(srv.posts().length, 1, 'POST reached the server once; no automatic retry');
      const ac = new AbortController();
      const p = t.setCriterion(
        'PRODUCT-1',
        { criterionId: 'c', completed: true, ifRevision: 3 },
        ac.signal,
      );
      setTimeout(() => ac.abort(), 30);
      await rejects(p, 'uncertain');
      const pre = new AbortController();
      pre.abort();
      await rejects(
        t.move('PRODUCT-1', { column: 'review', ifRevision: 3 }, pre.signal),
        'unavailable',
      );
      assert.equal(srv.posts().length, 2, 'pre-aborted mutation is never sent');
    } finally {
      await srv.close();
    }
  });

  it('R01: socket hang up after a POST is uncertain', async () => {
    const srv = await fake((r) => (r.method === 'POST' ? 'destroy' : undefined));
    try {
      await rejects(
        transportFor(srv.url).addComment('PRODUCT-1', { title: 't', body: 'b' }),
        'uncertain',
      );
      assert.equal(srv.posts().length, 1);
    } finally {
      await srv.close();
    }
  });

  it('R01: oversized response is protocol (declared and streamed)', async () => {
    const big = JSON.stringify({ ok: true, data: taskView({ description: 'x'.repeat(5000) }) });
    for (const chunked of [false, true]) {
      const headers: Record<string, string> = chunked
        ? { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
        : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(big)) };
      const srv = await fake((r) =>
        r.path.startsWith(`${BASE}/board-tasks/`) ? { raw: big, headers } : undefined,
      );
      try {
        const t = transportFor(srv.url, { maxResponseBytes: 1024 });
        await rejects(t.readTask('PRODUCT-1'), 'protocol', (e) =>
          assert.match(e.message, /exceeds 1024 bytes/),
        );
        await rejects(t.move('PRODUCT-1', { column: 'review', ifRevision: 3 }), 'protocol', (e) =>
          assert.equal(e.details.mutation, true),
        );
      } finally {
        await srv.close();
      }
    }
  });

  it('R01: incompatible read response causes no side-effect mutation', async () => {
    const srv = await fake((r) =>
      r.path === `${BASE}/board-tasks/PRODUCT-1` ? ok(taskView({ column: 'archived' })) : undefined,
    );
    try {
      await rejects(transportFor(srv.url).readTask('PRODUCT-1'), 'protocol', (e) =>
        assert.match(e.message, /column/),
      );
      assert.equal(srv.posts().length, 0);
    } finally {
      await srv.close();
    }
  });

  it('R01: pagination restarts on version change, never returns a partial list, then fails closed', async () => {
    let flips = 0;
    const children = (offset: number, version: string) =>
      ok({
        items: [
          taskView({ id: `Child00${offset}`, key: `PRODUCT-${offset + 5}`, parentId: 'Task0001' }),
        ],
        total: 2,
        nextOffset: offset === 0 ? 1 : null,
        version,
      });
    const handler =
      (mode: 'once' | 'always' | 'code'): Handler =>
      (r) => {
        const q = (r as Seen & { query: URLSearchParams }).query;
        if (r.path === `${BASE}/board-tasks/PRODUCT-1` || r.path === `${BASE}/board-tasks/Task0001`)
          return ok(taskView());
        if (r.path === `${BASE}/board-tasks/Task0001/criteria`)
          return ok({ items: [], total: 0, nextOffset: null, version: '3', revision: 3 });
        if (r.path === `${BASE}/entities`)
          return ok({ items: [], total: 0, nextOffset: null, version: 'd1' });
        if (r.path === `${BASE}/board-tasks` && q.get('parentId') === 'Task0001') {
          const offset = Number(q.get('offset'));
          if (offset === 1) {
            if (mode === 'code' && flips++ < 1) return err(409, 'BOARD_CHANGED');
            if (mode === 'once' && flips++ < 1) return children(1, 'v2');
            if (mode === 'always') return children(1, `v${++flips}`);
          }
          return children(offset, 'v1');
        }
        return undefined;
      };
    for (const mode of ['once', 'code'] as const) {
      flips = 0;
      const srv = await fake(handler(mode));
      try {
        const read = await transportFor(srv.url).readTask('PRODUCT-1');
        assert.equal(read.children.length, 2, mode);
        assert.equal(read.consistency.before, read.consistency.after);
        assert.equal(read.task.criteria.length, 0);
      } finally {
        await srv.close();
      }
    }
    flips = 0;
    const srv = await fake(handler('always'));
    try {
      await rejects(transportFor(srv.url, {}).readTask('PRODUCT-1'), 'conflict', (e) =>
        assert.match(e.message, /kept changing/),
      );
    } finally {
      await srv.close();
    }
  });

  it('R01: readTask returns full criteria, deps, children, documents and finished = done && canComplete', async () => {
    const srv = await fake((r) => {
      const q = (r as Seen & { query: URLSearchParams }).query;
      if (r.path === `${BASE}/board-tasks/PRODUCT-1` || r.path === `${BASE}/board-tasks/Task0001`)
        return ok(taskView({ dependencies: ['Dep00001'] }));
      if (r.path === `${BASE}/board-tasks/Dep00001`)
        return ok(
          taskView({
            id: 'Dep00001',
            key: 'PRODUCT-9',
            column: 'done',
            canComplete: true,
            revision: 4,
          }),
        );
      if (r.path === `${BASE}/board-tasks/Task0001/criteria`)
        return ok({
          items: [{ id: 'Crit0001', title: 'C', summary: '', completed: false }],
          total: 1,
          nextOffset: null,
          version: '3',
          revision: 3,
        });
      if (r.path === `${BASE}/board-tasks/Task0001/criteria/Crit0001`)
        return ok({
          criterion: {
            id: 'Crit0001',
            title: 'C',
            summary: 's',
            description: 'FULL',
            completed: false,
          },
          revision: 3,
        });
      if (r.path === `${BASE}/board-tasks` && q.get('parentId'))
        return ok({
          items: [
            taskView({ id: 'Kid00001', column: 'done', canComplete: false, parentId: 'Task0001' }),
          ],
          total: 1,
          nextOffset: null,
          version: 'b1',
        });
      if (r.path === `${BASE}/entities`)
        return ok({
          items: [
            {
              ref: { kind: 'document', id: 'Doc00001' },
              key: 'DOC-1',
              title: 'Spec',
              summary: '',
              revision: 2,
            },
          ],
          total: 1,
          nextOffset: null,
          version: 'd1',
        });
      if (r.path === `${BASE}/entities/get`)
        return ok({
          ref: { kind: 'document', id: 'Doc00001' },
          key: 'DOC-1',
          revision: 2,
          data: { kind: 'document', name: 'Spec', body: '# Body' },
        });
      return undefined;
    });
    try {
      const read = await transportFor(srv.url).readTask('PRODUCT-1');
      assert.equal(read.task.criteria[0]?.description, 'FULL');
      assert.deepEqual(
        read.dependencies.map((d) => [d.id, d.finished]),
        [['Dep00001', true]],
      );
      assert.deepEqual(
        read.children.map((d) => [d.id, d.finished]),
        [['Kid00001', false]],
      );
      assert.deepEqual(read.documents, [
        { id: 'Doc00001', key: 'DOC-1', name: 'Spec', body: '# Body', revision: 2 },
      ]);
      assert.equal(read.consistency.before, read.consistency.after);
      assert.ok(
        srv.seen.every((s) => s.path === '/api/v1/health' || s.path.startsWith(`${BASE}/`)),
      );
    } finally {
      await srv.close();
    }
  });

  it('R01: comments are read in full and in chronological order across cursor pages', async () => {
    const summary = (n: number) => ({
      id: String(n),
      taskId: 'Task0001',
      sequence: n,
      at: `2026-10-22T00:00:0${n}.000Z`,
      actor: 'a',
      action: 'comment-publish',
      title: `t${n}`,
      operationId: 'x',
      revision: 1,
      legacy: false,
      fields: [],
    });
    const srv = await fake((r) => {
      const q = (r as Seen & { query: URLSearchParams }).query;
      if (r.path === `${BASE}/board-tasks/PRODUCT-1/comments`)
        return q.get('cursor') === 'c2'
          ? ok({ items: [summary(1)], nextCursor: null, snapshot: 3 })
          : ok({ items: [summary(3), summary(2)], nextCursor: 'c2', snapshot: 3 });
      const m = /comments\/(\d+)$/.exec(r.path);
      if (m) return ok({ ...summary(Number(m[1])), changes: [], description: `body ${m[1]}` });
      return undefined;
    });
    try {
      const list = await transportFor(srv.url).listComments('PRODUCT-1');
      assert.deepEqual(
        list.map((c) => [c.id, c.body]),
        [
          ['1', 'body 1'],
          ['2', 'body 2'],
          ['3', 'body 3'],
        ],
      );
    } finally {
      await srv.close();
    }
  });

  it('R01: every mutation carries a unique requestId and the configured actor', async () => {
    const srv = await fake((r) =>
      r.method === 'POST'
        ? ok({ id: 'Task0001', commentId: '1', action: 'comment-publish', revision: 1 })
        : undefined,
    );
    try {
      const t = transportFor(srv.url);
      await t.addComment('PRODUCT-1', { title: 't', body: 'b' });
      await t.addComment('PRODUCT-1', { title: 't', body: 'b' });
      const [a, b] = srv.posts();
      assert.notEqual(a?.body?.requestId, b?.body?.requestId);
      assert.match(String(a?.body?.requestId), /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
      assert.equal(a?.body?.actor, 'dc-test');
      assert.equal(a?.body?.description, 'b');
      assert.equal(a?.path, `${BASE}/board-tasks/PRODUCT-1/comments`);
    } finally {
      await srv.close();
    }
  });
});
