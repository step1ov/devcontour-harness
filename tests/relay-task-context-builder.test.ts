/**
 * Контекст задачи на клиенте (0.1.0-alpha.69): Relay 0.13 без маршрута
 * `relay-task-context-v1` — транспорт собирает тот же состав из обычных
 * маршрутов (задача, `entities/get`, документы по цели). Поддельный HTTP-сервер
 * с формой ответов Relay 0.13.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTransport, TASK_CONTEXT_RECORD_LIMIT } from '../src/integrations/relay-v1/index.ts';
import { renderTaskContext } from '../src/integrations/connector/snapshot.ts';

const P = 'Proj1234';
const BASE = `/api/v1/projects/${P}`;

interface Entity {
  ref: { kind: string; id: string };
  key: string;
  title: string;
  summary: string;
  revision: number;
  data: Record<string, unknown>;
  archived?: boolean;
  targets?: string[];
}

/** Мир Relay 0.13: задача с целью SI, фича, сценарий, приложение, паспорт, документы. */
function world() {
  const entities: Entity[] = [
    {
      ref: { kind: 'implementation', id: 'Si000001' },
      key: 'WEB-SI-1',
      title: 'Фильтр Web',
      summary: 'SI',
      revision: 2,
      data: {
        kind: 'implementation',
        description: '## SI',
        featureId: 'Fe000001',
        scenarioId: 'Sc000001',
        applicationId: 'App00001',
      },
    },
    {
      ref: { kind: 'feature', id: 'Fe000001' },
      key: 'FEATURE-1',
      title: 'Каталог',
      summary: 'Каталог чая',
      revision: 3,
      data: { kind: 'feature', description: '## Каталог' },
    },
    {
      ref: { kind: 'scenario', id: 'Sc000001' },
      key: 'SCENARIO-1',
      title: 'Фильтр',
      summary: '',
      revision: 1,
      data: { kind: 'scenario', description: '## Фильтр', featureId: 'Fe000001' },
    },
    {
      ref: { kind: 'application', id: 'App00001' },
      key: 'WEB',
      title: 'Web',
      summary: '',
      revision: 1,
      data: { kind: 'application', description: '## Сайт' },
    },
    {
      ref: { kind: 'product', id: 'passport' },
      key: 'PRODUCT',
      title: 'Чайная',
      summary: '',
      revision: 5,
      data: { kind: 'product', description: '# Паспорт' },
    },
    {
      ref: { kind: 'document', id: 'Doc00001' },
      key: 'DOC-1',
      title: 'ТЗ',
      summary: '',
      revision: 1,
      data: { kind: 'document', body: '# ТЗ', name: 'ТЗ' },
      targets: ['Task0001'],
    },
    {
      ref: { kind: 'document', id: 'Doc00002' },
      key: 'DOC-2',
      title: 'Старое',
      summary: '',
      revision: 1,
      data: { kind: 'document', body: '# old', name: 'old' },
      targets: ['Task0001'],
      archived: true,
    },
    {
      ref: { kind: 'document', id: 'Doc00003' },
      key: 'DOC-3',
      title: 'Правила фичи',
      summary: '',
      revision: 4,
      data: { kind: 'document', body: '# Правила', name: 'Правила' },
      targets: ['Fe000001'],
    },
  ];
  const task = {
    id: 'Task0001',
    key: 'WEB-1',
    title: 'Каталог',
    column: 'ready',
    revision: 7,
    parentId: null,
    dependencies: [],
    description: '## Цель',
    productLinks: [{ kind: 'implementation', id: 'Si000001' }],
  };
  return { entities, task };
}

async function relay013(w: ReturnType<typeof world>, caps: string[] = ['relay-projects-v1']) {
  const seen: string[] = [];
  const page = (items: unknown[]) => ({
    items,
    total: items.length,
    nextOffset: null,
    version: 'v1',
  });
  const summary = (e: Entity) => ({ ref: e.ref, key: e.key, title: e.title, revision: e.revision });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    seen.push(u.pathname + u.search);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const ok = (data: unknown) => send(200, { ok: true, data });
    const notFound = (code = 'NOT_FOUND') =>
      send(404, { ok: false, error: { code, message: code, exitCode: 3 } });
    if (u.pathname === '/api/v1/health') return ok({ status: 'ok', contractVersion: 1 });
    if (u.pathname === `${BASE}/context`) return ok({ projectId: P, capabilities: caps });
    if (
      u.pathname === `${BASE}/board-tasks/${w.task.id}` ||
      u.pathname === `${BASE}/board-tasks/${w.task.key}`
    )
      return ok(w.task);
    if (u.pathname === `${BASE}/entities/get`) {
      const e = w.entities.find(
        (x) =>
          (x.ref.id === u.searchParams.get('ref') || x.key === u.searchParams.get('ref')) &&
          x.ref.kind === u.searchParams.get('kind'),
      );
      return e
        ? ok({ ...e, references: [], extra: { ignored: true } })
        : notFound('ENTITY_NOT_FOUND');
    }
    if (u.pathname === `${BASE}/entities`) {
      const refs = u.searchParams.getAll('refs');
      if (refs.length)
        return ok(page(w.entities.filter((e) => refs.includes(e.ref.id)).map(summary)));
      const target = u.searchParams.get('target');
      const archived = u.searchParams.get('archived');
      return ok(
        page(
          w.entities
            .filter(
              (e) =>
                e.ref.kind === u.searchParams.get('kind') &&
                (!target || e.targets?.includes(target)) &&
                (archived !== 'false' || !e.archived),
            )
            .map(summary),
        ),
      );
    }
    return notFound();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    seen,
    transport: createTransport({ endpoint: url, projectId: P, actor: 'dc-test', timeoutMs: 5000 }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('Relay 0.13 без маршрута контекста: цели, требования, приложение, паспорт, документы — с основаниями', async () => {
  const w = world();
  const srv = await relay013(w);
  try {
    const out = await srv.transport.readTaskContext!('WEB-1', {
      targetDocuments: true,
      maxBytes: 1 << 20,
    });
    assert.equal(out.status, 'ok');
    if (out.status !== 'ok') return;
    assert.equal(out.context.taskRevision, 7);
    assert.equal(out.context.contractVersion, 1);
    assert.match(out.context.consistency, /^client-v1:[0-9a-f]{64}$/);
    assert.deepEqual(
      out.context.records.map((r) => [r.section, r.key, r.revision, r.body, r.reasons]),
      [
        ['target', 'WEB-SI-1', 2, '## SI', [{ code: 'task-target', from: 'WEB-1' }]],
        [
          'requirement',
          'FEATURE-1',
          3,
          '## Каталог',
          [{ code: 'target-feature', from: 'WEB-SI-1' }],
        ],
        [
          'requirement',
          'SCENARIO-1',
          1,
          '## Фильтр',
          [{ code: 'target-scenario', from: 'WEB-SI-1' }],
        ],
        ['application', 'WEB', 1, '## Сайт', [{ code: 'target-application', from: 'WEB-SI-1' }]],
        ['product', 'PRODUCT', 5, '# Паспорт', [{ code: 'product-passport', from: null }]],
        ['document', 'DOC-1', 1, '# ТЗ', [{ code: 'task-document', from: 'WEB-1' }]],
        ['document', 'DOC-3', 4, '# Правила', [{ code: 'target-document', from: 'FEATURE-1' }]],
      ],
    );
    assert.ok(!out.context.records.some((r) => r.key === 'DOC-2'), 'архивный документ не входит');
    assert.ok(
      !srv.seen.some((p) => p.includes('/board-tasks/Task0001/context')),
      'маршрут сервера не вызывается',
    );
    // Тот же текст для исполнителя: пять разделов relay-context.md.
    const text = renderTaskContext('WEB-1', out.context, new Map());
    for (const heading of [/WEB-SI-1/, /FEATURE-1/, /SCENARIO-1/, /PRODUCT/, /DOC-1/])
      assert.match(text, heading);
    // Без targetDocuments — только документы задачи.
    const narrow = await srv.transport.readTaskContext!('WEB-1', {
      targetDocuments: false,
      maxBytes: 1 << 20,
    });
    assert.ok(narrow.status === 'ok' && !narrow.context.records.some((r) => r.key === 'DOC-3'));
  } finally {
    await srv.close();
  }
});

test('предел: больше maxBytes — too-large без усечения; паспорта нет — раздел пуст', async () => {
  const w = world();
  w.entities = w.entities.filter((e) => e.ref.kind !== 'product');
  const srv = await relay013(w);
  try {
    const small = await srv.transport.readTaskContext!('WEB-1', {
      targetDocuments: true,
      maxBytes: 16,
    });
    assert.equal(small.status, 'too-large');
    assert.match(small.status === 'too-large' ? small.reason : '', /taskContext\.maxBytes=16/);
    const full = await srv.transport.readTaskContext!('WEB-1', {
      targetDocuments: false,
      maxBytes: 1 << 20,
    });
    assert.ok(full.status === 'ok' && !full.context.records.some((r) => r.section === 'product'));
    assert.ok(TASK_CONTEXT_RECORD_LIMIT >= 1000);
  } finally {
    await srv.close();
  }
});

test('согласованность без токена сервера: запись изменилась во время сборки — сборка повторяется', async () => {
  const w = world();
  const srv = await relay013(w);
  // Первое чтение фичи видит ревизию 3, проверка после сборки — 4: новая сборка.
  let gets = 0;
  const feature = w.entities.find((e) => e.key === 'FEATURE-1')!;
  const original = srv.seen.push.bind(srv.seen);
  srv.seen.push = (...items: string[]) => {
    for (const p of items)
      if (p.startsWith(`${BASE}/entities/get`) && p.includes('Fe000001') && ++gets === 1)
        setImmediate(() => (feature.revision = 4));
    return original(...items);
  };
  try {
    const out = await srv.transport.readTaskContext!('WEB-1', {
      targetDocuments: false,
      maxBytes: 1 << 20,
    });
    assert.equal(out.status, 'ok');
    if (out.status !== 'ok') return;
    assert.equal(out.context.records.find((r) => r.key === 'FEATURE-1')!.revision, 4);
    assert.ok(
      srv.seen.filter((p) => p === `${BASE}/board-tasks/WEB-1`).length >= 2,
      'сборка повторена',
    );
  } finally {
    await srv.close();
  }
});

test('сервер объявил relay-task-context-v1 — читается его маршрут', async () => {
  const w = world();
  const srv = await relay013(w, ['relay-projects-v1', 'relay-task-context-v1']);
  try {
    await srv.transport.readTaskContext!('WEB-1', {
      targetDocuments: false,
      maxBytes: 1 << 20,
    }).catch(() => undefined);
    assert.ok(srv.seen.some((p) => p.startsWith(`${BASE}/board-tasks/WEB-1/context`)));
  } finally {
    await srv.close();
  }
});
