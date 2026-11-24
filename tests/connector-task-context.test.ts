/**
 * alpha.60: связка с Relay. Контекст исполнения задачи (`relay-task-context-v1`)
 * в пакете исполнителя, совместимость с Relay, вопросы владельцу в
 * представлении оператора, весь срез прогона, комментарии только об итоге,
 * связка до появления задач. Backend — подделка коннектора с добавленными
 * capability и методами; настоящий Relay — tests/integration/relay-v1-context.test.ts.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HarnessError,
  cliDataSchemas,
  digestOf,
  operatorViewSchema,
} from '../src/contracts/index.ts';
import { openConnector, parseConfig } from '../src/integrations/connector/index.ts';
import {
  RELAY_TASK_CONTEXT_CAPABILITY,
  RELAY_TASK_CONTEXT_VERSION,
  relayCompatibility,
} from '../src/integrations/connector/compat.ts';
import { relayCompatibilityCheck } from '../src/integrations/connector/commands.ts';
import { parseQuestion } from '../src/integrations/connector/questions.ts';
import {
  TASK_CONTEXT_FILE,
  optionalDocumentsDigest,
} from '../src/integrations/connector/snapshot.ts';
import { fakeSuiteBackend, scenario } from '../src/integrations/connector/testing.ts';
import {
  TransportError,
  type RelayTransport,
  type SourceQuestionRecord,
  type TaskContextOutcome,
  type TaskContextRecord,
} from '../src/integrations/connector/transport.ts';
import { connectorSources, harnessView } from '../src/control/operator-view.ts';
import { operatorView, viewToken } from '../src/projections/operator-view.ts';
import { at, attempt, baseInput, NOW, work } from './operator-view-input.ts';

const fi = (
  body = '## Вклад сайта\nСтраница каталога с фильтром.',
  revision = 1,
): TaskContextRecord => ({
  section: 'target',
  kind: 'implementation',
  id: 'Fi000001',
  key: 'WEB-FI-1',
  title: 'Каталог на сайте',
  revision,
  summary: '',
  body,
  implementation: { type: 'FI', application: 'WEB', target: 'FEATURE-1' },
  reasons: [{ code: 'task-target', from: 'PRODUCT-1' }],
});
const feature: TaskContextRecord = {
  section: 'requirement',
  kind: 'feature',
  id: 'Fe000001',
  key: 'FEATURE-1',
  title: 'Каталог',
  revision: 1,
  summary: 'Каталог чая',
  body: '## Каталог\nФильтр по виду.',
  reasons: [{ code: 'target-feature', from: 'WEB-FI-1' }],
};

interface Stub {
  caps?: string[];
  outcome?: (revision: number, call: number) => TaskContextOutcome;
  records?: () => TaskContextRecord[];
  questions?: SourceQuestionRecord[];
  /** Без метода `readTaskContext` (транспорт, который контекст не умеет). */
  noMethod?: boolean;
}

/** Транспорт подделки с capability контекста и его чтением. */
function contextual(inner: RelayTransport, stub: Stub = {}) {
  const seen: { targetDocuments: boolean; maxBytes: number }[] = [];
  const caps = stub.caps ?? [RELAY_TASK_CONTEXT_CAPABILITY];
  const proxy = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'identity')
        return async (signal?: AbortSignal) => {
          const id = await target.identity(signal);
          return {
            ...id,
            provider: 'relay-v1-http',
            capabilities: [...id.capabilities, ...caps].sort(),
            build: { ...id.build, contractVersion: '1' },
          };
        };
      if (prop === 'readTaskContext' && !stub.noMethod)
        return async (ref: string, options: { targetDocuments: boolean; maxBytes: number }) => {
          seen.push(options);
          const revision = (await target.readTask(ref)).task.revision;
          if (stub.outcome) return stub.outcome(revision, seen.length);
          return {
            status: 'ok',
            context: {
              contractVersion: 1,
              consistency: 'c-stable',
              taskRevision: revision,
              records: stub.records?.() ?? [fi(), feature],
            },
          } satisfies TaskContextOutcome;
        };
      if (prop === 'listOpenQuestions' && stub.questions)
        return () => Promise.resolve({ questions: stub.questions!, total: stub.questions!.length });
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { transport: proxy, seen };
}

const question: SourceQuestionRecord = {
  id: 'Doc00003',
  key: 'DOC-3',
  title: 'Вопрос: Нужна ли доставка?',
  revision: 1,
  body: '## Вопрос\nНужна ли доставка?\n\n## Варианты\n- да\n- нет\n\n## Рекомендация\nнет\n\n## Временный ответ\nнет, только самовывоз',
  targets: ['PRODUCT-1'],
  updatedAt: '2026-11-20T10:00:00.000Z',
};

test('alpha.60: без capability контекста снимок прежний и контекст не читается', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const plain = await openConnector(s.loaded(), {
      stateDir: s.state,
      transport: s.project.transport(),
    });
    const before = await plain.source.snapshot();
    plain.close();
    const noCap = contextual(s.project.transport(), { caps: [] });
    const a = await openConnector(s.loaded(), { stateDir: s.state, transport: noCap.transport });
    const same = await a.source.snapshot();
    a.close();
    assert.equal(noCap.seen.length, 0, 'без capability route контекста не вызывается');
    assert.equal(same.revision, before.revision);
    assert.equal(same.manifest.graphDigest, before.manifest.graphDigest);
    assert.equal(same.manifest.contextDigest, before.manifest.contextDigest);
    assert.equal(same.manifest.tasks[0]!.taskContext, undefined);
    assert.equal(same.manifest.compatibility?.level, 'below-recommended');

    // Выключено в конфигурации: capability есть, но контекст не читается.
    const cfg = structuredClone(s.config) as Record<string, unknown>;
    cfg.taskContext = { mode: 'off' };
    const off = contextual(s.project.transport());
    const b = await openConnector(parseConfig(cfg, s.root), {
      stateDir: s.state,
      transport: off.transport,
    });
    const offSnap = await b.source.snapshot();
    b.close();
    assert.equal(off.seen.length, 0);
    assert.equal(offSnap.revision, before.revision, 'выключенный контекст — прежняя ревизия');
    assert.equal(offSnap.manifest.compatibility?.taskContextUsed, false);
  } finally {
    await s.cleanup();
  }
});

test('alpha.60: с capability — relay-context.md в пакете, task.md указывает на него; semantic digest прежний', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const plain = await openConnector(s.loaded(), {
      stateDir: s.state,
      transport: s.project.transport(),
    });
    const before = await plain.source.snapshot();
    plain.close();
    const ctx = contextual(s.project.transport());
    const c = await openConnector(s.loaded(), { stateDir: s.state, transport: ctx.transport });
    const snap = await c.snapshot(join(s.root, 'snap'));
    c.close();
    assert.deepEqual(ctx.seen[0], { targetDocuments: true, maxBytes: 1024 * 1024 });
    const built = snap.snapshot;
    const source = built.context.sources[0]!;
    const file = source.files.find((f) => f.path === TASK_CONTEXT_FILE)!;
    assert.ok(file, 'файл контекста в пакете задачи');
    assert.match(file.content.data, /### WEB-FI-1: Каталог на сайте/);
    assert.match(file.content.data, /Страница каталога с фильтром/);
    assert.match(file.content.data, /включена: цель задачи \(PRODUCT-1\)/);
    assert.match(file.content.data, /> Каталог чая/);
    assert.doesNotMatch(file.content.data, /c-stable/, 'токен согласованности не в файле');
    const task = source.files.find((f) => f.path === 'task.md')!;
    assert.match(task.content.data, /relay-context\.md/);
    assert.equal(
      built.manifest.tasks[0]!.semanticDigest,
      before.manifest.tasks[0]!.semanticDigest,
      'semantic digest от контекста не зависит: доставка не конфликтует',
    );
    assert.notEqual(built.revision, before.revision, 'контекст закреплён в ревизии набора');
    assert.deepEqual(built.manifest.tasks[0]!.taskContext, {
      status: 'included',
      records: 2,
      bytes: file.bytes,
      digest: file.digest,
    });
    assert.equal(built.manifest.compatibility?.level, 'recommended');
    // Ответ CLI проходит схему данных.
    const { snapshot, ...data } = snap;
    void snapshot;
    cliDataSchemas['source-snapshot'].parse(data);
  } finally {
    await s.cleanup();
  }
});

test('alpha.60: правка FI меняет ревизию набора (новое согласование), не semantic digest; run — APPROVAL_STALE', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    let body = '## Вклад\nВерсия 1';
    let revision = 1;
    const transport = () =>
      contextual(s.project.transport(), { records: () => [fi(body, revision)] }).transport;
    const opened = await s.open({ transport: transport() });
    const first = await opened.connector.snapshot(join(s.root, 'a'));
    body = '## Вклад\nВерсия 2';
    revision = 2;
    opened.close();
    const again = await s.open({ transport: transport() });
    const fresh = await again.connector.source.snapshot();
    assert.notEqual(fresh.revision, first.revision);
    assert.equal(fresh.manifest.tasks[0]!.semanticDigest, first.tasks[0]!.semanticDigest);
    await assert.rejects(
      again.connector.prepareRun(again.h),
      (e: unknown) => e instanceof HarnessError && e.code === 'APPROVAL_STALE',
    );
    again.close();
  } finally {
    await s.cleanup();
  }
});

test('alpha.60: контекст не помещается — задача без него, с отметкой; запуск допускается', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const server = contextual(s.project.transport(), {
      outcome: () => ({ status: 'too-large', reason: 'Relay: CONTEXT_TOO_LARGE' }),
    });
    const a = await openConnector(s.loaded(), { stateDir: s.state, transport: server.transport });
    const snap = await a.source.snapshot();
    a.close();
    assert.equal(snap.problems.length, 0, 'запуск не блокируется');
    assert.equal(snap.manifest.tasks[0]!.taskContext?.status, 'too-large');
    assert.ok(!snap.context.sources[0]!.files.some((f) => f.path === TASK_CONTEXT_FILE));
    assert.match(
      snap.context.missing.map((m) => m.reason).join('\n'),
      /не включён: Relay: CONTEXT_TOO_LARGE/,
    );
    assert.match(
      snap.context.sources[0]!.files.find((f) => f.path === 'task.md')!.content.data,
      /не поместился/,
    );

    // Локальный предел файла: тело больше taskContext.maxBytes.
    const cfg = structuredClone(s.config) as Record<string, unknown>;
    cfg.taskContext = { maxBytes: 1024 };
    const big = contextual(s.project.transport(), { records: () => [fi('x'.repeat(4000))] });
    const b = await openConnector(parseConfig(cfg, s.root), {
      stateDir: s.state,
      transport: big.transport,
    });
    const local = await b.source.snapshot();
    b.close();
    assert.equal(local.manifest.tasks[0]!.taskContext?.status, 'too-large');
    assert.match(local.manifest.tasks[0]!.taskContext?.reason ?? '', /taskContext\.maxBytes=1024/);
  } finally {
    await s.cleanup();
  }
});

test('alpha.60: контекст другой ревизии задачи — раунд перечитывается, граф не из разных редакций', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const ctx = contextual(s.project.transport(), {
      outcome: (revision, call) => ({
        status: 'ok',
        context: {
          contractVersion: 1,
          consistency: 'same',
          taskRevision: call === 1 ? revision + 5 : revision,
          records: [fi()],
        },
      }),
    });
    const a = await openConnector(s.loaded(), { stateDir: s.state, transport: ctx.transport });
    const snap = await a.source.snapshot();
    a.close();
    assert.equal(snap.manifest.tasks[0]!.taskContext?.status, 'included');
    assert.ok(snap.manifest.rounds >= 3, 'несогласованный раунд отброшен');
  } finally {
    await s.cleanup();
  }
});

test('alpha.60: отклонённая попытка не пишет комментарий в задачу; comments.attempts=all — пишет', async () => {
  for (const mode of ['final', 'all'] as const) {
    const s = await scenario(fakeSuiteBackend(), {
      reviewer: 'reject',
      ...(mode === 'all'
        ? { config: (c) => void ((c as Record<string, unknown>).comments = { attempts: 'all' }) }
        : {}),
    });
    try {
      const { opened } = await s.snapshotAndRun();
      const result = opened.h.result(s.workId);
      assert.notEqual(result.result?.outcome, 'accepted');
      assert.equal(result.delivery.at(-1)?.status, 'delivered', mode);
      const comments = await s.project.transport().listComments(s.task.id);
      assert.equal(comments.length, mode === 'all' ? 1 : 0, mode);
      opened.close();
    } finally {
      await s.cleanup();
    }
  }
});

test('alpha.60: связка без задач — source-check проходит с предупреждением, снимок — NOT_READY', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const cfg = structuredClone(s.config) as Record<string, unknown>;
    delete cfg.tasks;
    const c = await openConnector(parseConfig(cfg, s.root), {
      stateDir: s.state,
      transport: contextual(s.project.transport(), { caps: [] }).transport,
    });
    const report = await c.check();
    cliDataSchemas['source-check'].parse(report);
    assert.equal(report.connected, true);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.mapping, []);
    assert.equal(report.warnings?.length, 2, 'Relay без контекста и нет задач');
    const warnings = (report.warnings ?? []).join('\n');
    assert.match(warnings, /нет задач/);
    assert.match(
      warnings,
      new RegExp(`Relay ≥ ${RELAY_TASK_CONTEXT_VERSION.replace(/\./g, '\\.')}`),
    );
    await assert.rejects(
      c.snapshot(join(s.root, 'x')),
      (e: unknown) =>
        e instanceof HarnessError && e.code === 'NOT_READY' && /нет задач/.test(e.message),
    );
    c.close();
  } finally {
    await s.cleanup();
  }
});

test('alpha.60: совместимость Relay — уровни и строки; несовместимый договор — именованная причина для doctor', async () => {
  const base = { provider: 'relay-v1-http' as const, build: { contractVersion: '1' } };
  const none = relayCompatibility({ ...base, capabilities: [] })!;
  assert.equal(none.level, 'below-recommended');
  assert.match(
    none.line,
    /работаю без полного контекста задачи — исполнитель не получит описание функции и сценария/,
  );
  assert.match(none.line, /0\.13\.1-harness\.1/);
  const full = relayCompatibility({ ...base, capabilities: [RELAY_TASK_CONTEXT_CAPABILITY] })!;
  assert.equal(full.level, 'recommended');
  assert.equal(full.taskContextUsed, true);
  assert.equal(full.contractVersion, 1);
  assert.equal(
    relayCompatibility({ provider: 'relay-v2-cli', build: {}, capabilities: [] }),
    undefined,
  );

  const s = await scenario(fakeSuiteBackend());
  try {
    const file = join(s.root, 'connector.json');
    writeFileSync(file, JSON.stringify(s.config));
    const ok = await relayCompatibilityCheck(file, {
      stateDir: s.state,
      transport: contextual(s.project.transport(), { caps: [] }).transport,
    });
    assert.equal(ok.compatibility?.level, 'below-recommended');
    assert.match(ok.warning!, /нужна Relay|Нужна Relay/);
    const mismatch = new Proxy(s.project.transport(), {
      get(target, prop) {
        if (prop === 'identity')
          return () =>
            Promise.reject(
              new TransportError(
                'unsupported',
                'identity.health',
                'Relay сообщает версию договора REST 2',
                {
                  provider: 'relay-v1-http',
                  code: 'CONNECTOR_VERSION_MISMATCH',
                },
              ),
            );
        const v: unknown = Reflect.get(target, prop, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const bad = await relayCompatibilityCheck(file, { stateDir: s.state, transport: mismatch });
    assert.equal(bad.code, 'CONNECTOR_VERSION_MISMATCH');
    assert.match(bad.warning!, /^Relay несовместим с этим harness: .*версию договора REST 2/);
  } finally {
    await s.cleanup();
  }
});

test('alpha.60: вопросы владельцу из Relay и весь срез прогона — в представлении оператора', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const ctx = contextual(s.project.transport(), { questions: [question] });
    const { opened } = await s.snapshotAndRun({ transport: ctx.transport });
    opened.close();
    const sources = connectorSources(s.state);
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.questions?.[0]?.key, 'DOC-3');
    const policyFile = join(s.root, 'policy.json');
    writeFileSync(policyFile, JSON.stringify(s.policy));
    const view = harnessView({ stateDir: s.state, policyPath: policyFile }) as ReturnType<
      typeof operatorView
    >;
    operatorViewSchema.parse(view);
    assert.equal(view.viewRevision, 9);
    assert.deepEqual(
      view.scope?.tasks.map((t) => [t.key, t.state, t.workId]),
      [[s.task.key, 'in-harness', s.workId]],
    );
    const q = view.sourceQuestions![0]!;
    assert.equal(q.ref, 'DOC-3');
    assert.equal(q.title, 'Нужна ли доставка?');
    assert.deepEqual(q.options, ['да', 'нет']);
    assert.equal(q.recommendation, 'нет');
    assert.equal(q.provisional, 'нет, только самовывоз');
    assert.deepEqual(q.tasks, ['PRODUCT-1']);
    assert.match(q.url!, /\/projects\/.+\/documents\/Doc00003$/);
    const health = view.health.sources![0]!;
    assert.equal(health.level, 'recommended');
    assert.equal(health.taskContext, true);
    assert.match(health.line!, /с контекстом задачи/);
    // Без заголовков — без текста вопросов и названий задач.
    const bare = harnessView({
      stateDir: s.state,
      policyPath: policyFile,
      titles: false,
    }) as typeof view;
    assert.equal(bare.sourceQuestions![0]!.title, undefined);
    assert.equal(bare.sourceQuestions![0]!.options, undefined);
    assert.equal(bare.scope!.tasks[0]!.title, undefined);
  } finally {
    await s.cleanup();
  }
});

test('alpha.60: срез прогона — не готовая и не переданная задачи; без связок полей нет', () => {
  const input = baseInput({
    sources: [
      {
        connector: 'relay-v1-http-abc',
        provider: 'relay-v1-http',
        tasks: [
          { id: 'T1', key: 'WEB-1', title: 'Готова', orderId: 'tw1', problems: [] },
          {
            id: 'T2',
            key: 'WEB-2',
            title: 'Ждёт',
            orderId: 'tw2',
            problems: [
              { code: 'DEPENDENCY_UNFINISHED', message: 'Зависимость WEB-1 не завершена' },
            ],
          },
        ],
        compatibility: {
          level: 'below-recommended',
          taskContext: false,
          taskContextUsed: false,
          contractVersion: 1,
          recommended: '0.14.0',
        },
        observedAt: '2026-11-19T11:00:00.000Z',
      },
    ],
  });
  const view = operatorView(input);
  operatorViewSchema.parse(view);
  assert.deepEqual(
    view.scope!.tasks.map((t) => [t.key, t.state, t.plain]),
    [
      ['WEB-1', 'not-handed-over', 'ещё не передана в harness'],
      ['WEB-2', 'not-ready', 'Зависимость WEB-1 не завершена'],
    ],
  );
  assert.equal(view.progress.total, 0, 'прогресс считает только работы harness');
  assert.match(view.health.sources![0]!.line!, /нужна Relay ≥ 0\.14\.0/);
  const en = operatorView(input, { lang: 'en' });
  assert.equal(en.scope!.tasks[1]!.plain, 'a dependency is not finished');
  const none = operatorView(baseInput());
  assert.equal(none.scope, undefined);
  assert.equal(none.scopeReason, 'no-snapshot', 'нет снимка — причина названа');
  assert.equal(operatorView(baseInput({ sourcesUnread: 1 })).scopeReason, 'unreadable');
  assert.equal(view.scopeReason, undefined);
  assert.equal(none.sourceQuestions, undefined);
  assert.equal(none.health.sources, undefined);
});

test('alpha.60 (P12): вопрос исполнителя — варианты с рекомендуемым и обоснование', () => {
  const input = baseInput({
    questions: [
      {
        requestId: 'IR-1',
        workId: 'w',
        state: 'awaiting-answer',
        version: 1,
        severity: 5,
        createdAt: '2026-11-19T11:00:00.000Z',
        text: 'Какой фильтр?',
        options: [
          { id: 'a', label: 'По виду' },
          { id: 'b', label: 'По цене' },
        ],
        recommended: 'a',
        rationale: 'Так в ТЗ',
        leadMay: false,
      },
    ],
  });
  const view = operatorView(input);
  operatorViewSchema.parse(view);
  assert.deepEqual(view.questions[0]!.options, [
    { id: 'a', label: 'По виду', recommended: true },
    { id: 'b', label: 'По цене' },
  ]);
  assert.equal(view.questions[0]!.rationale, 'Так в ТЗ');
  // Применённый ответ у идущей попытки (P1): строка «где ответ» рядом с вариантами.
  const carried = operatorView({
    ...input,
    questions: [
      { ...input.questions[0]!, state: 'delivered', carrier: { attempt: 2, running: true } },
    ],
  });
  operatorViewSchema.parse(carried);
  assert.equal(carried.questions[0]!.line, 'ответ у идущей попытки 2 — ждать нечего');
  assert.equal(carried.questions[0]!.options?.length, 2);
  assert.equal(carried.questions[0]!.rationale, 'Так в ТЗ');
  const bare = operatorView(input, { titles: false });
  assert.equal(bare.questions[0]!.options, undefined, 'без заголовков — без вариантов');
  assert.equal(bare.questions[0]!.rationale, undefined);
});

test('alpha.60: разбор документа-вопроса по разделам соглашения Relay', () => {
  const q = parseQuestion(question, 'http://127.0.0.1:4700/projects/P1');
  assert.equal(q.title, 'Нужна ли доставка?');
  assert.equal(q.question, 'Нужна ли доставка?');
  assert.deepEqual(q.options, ['да', 'нет']);
  assert.equal(q.recommendation, 'нет');
  assert.equal(q.provisional, 'нет, только самовывоз');
  assert.equal(q.url, 'http://127.0.0.1:4700/projects/P1/documents/Doc00003');
  const bare = parseQuestion({ ...question, body: 'просто текст' });
  assert.deepEqual(bare.options, []);
  assert.equal(bare.question, undefined);
});

test('alpha.60: усечённый документ задачи — в контексте полный текст, а не ссылка на усечённый файл', async () => {
  const s = await scenario(fakeSuiteBackend(), {
    config: (c) =>
      void ((c as Record<string, unknown>).limits = { documentBytes: 1024, leaseMs: 2000 }),
  });
  try {
    const doc = await s.project.admin.addDocument(s.task.id, {
      name: 'Big',
      body: 'y'.repeat(3000),
    });
    const ctx = contextual(s.project.transport(), {
      records: () => [
        fi(),
        {
          section: 'document',
          kind: 'document',
          id: doc.id,
          key: 'DOC-9',
          title: 'Big',
          revision: 1,
          summary: '',
          body: 'y'.repeat(3000),
          reasons: [{ code: 'task-document', from: 'PRODUCT-1' }],
        },
      ],
    });
    const a = await openConnector(s.loaded(), { stateDir: s.state, transport: ctx.transport });
    const snap = await a.source.snapshot();
    a.close();
    assert.equal(snap.manifest.tasks[0]!.documents[0]!.included, 'truncated');
    const text = snap.context.sources[0]!.files.find((f) => f.path === TASK_CONTEXT_FILE)!.content
      .data;
    assert.ok(text.includes('y'.repeat(3000)), 'полный текст документа в контексте');
    assert.doesNotMatch(text, /Текст — в файле/);
  } finally {
    await s.cleanup();
  }
});

test('alpha.60: предел контекста всех задач и меняющийся токен согласованности', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const cfg = structuredClone(s.config) as Record<string, unknown>;
    cfg.taskContext = { totalBytes: 1024 };
    const big = contextual(s.project.transport(), { records: () => [fi('z'.repeat(2000))] });
    const a = await openConnector(parseConfig(cfg, s.root), {
      stateDir: s.state,
      transport: big.transport,
    });
    const snap = await a.source.snapshot();
    a.close();
    assert.equal(snap.manifest.tasks[0]!.taskContext?.status, 'too-large');
    assert.match(snap.manifest.tasks[0]!.taskContext?.reason ?? '', /totalBytes=1024/);

    // Токен меняется с вычисляемыми полями при каждом чтении — снимок всё равно согласован.
    const moving = contextual(s.project.transport(), {
      outcome: (revision, call) => ({
        status: 'ok',
        context: {
          contractVersion: 1,
          consistency: 'tick-' + call,
          taskRevision: revision,
          records: [fi()],
        },
      }),
    });
    const b = await openConnector(s.loaded(), { stateDir: s.state, transport: moving.transport });
    const one = await b.source.snapshot();
    const two = await b.source.snapshot();
    b.close();
    assert.equal(one.revision, two.revision, 'токен не входит в ревизию');
    // Запись изменилась между раундами — снимок не из разных редакций.
    let n = 0;
    const changing = contextual(s.project.transport(), { records: () => [fi('body ' + n++)] });
    const c = await openConnector(s.loaded(), { stateDir: s.state, transport: changing.transport });
    await assert.rejects(
      c.source.snapshot(),
      (e: unknown) =>
        e instanceof HarnessError && e.code === 'NOT_READY' && /не согласован/.test(e.message),
    );
    c.close();
  } finally {
    await s.cleanup();
  }
});

test('alpha.60: срез в представлении — по последнему чтению, а не по записи снимка той же ревизии', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    await s.project.admin.move(s.task.id, 'inbox');
    const open = () =>
      openConnector(s.loaded(), {
        stateDir: s.state,
        transport: contextual(s.project.transport()).transport,
      });
    const a = await open();
    await a.snapshot(join(s.root, 'a'));
    a.close();
    assert.equal(connectorSources(s.state)[0]!.tasks[0]!.problems[0]?.code, 'COLUMN_NOT_ELIGIBLE');
    await s.project.admin.move(s.task.id, 'ready');
    const b = await open();
    const again = await b.snapshot(join(s.root, 'b'));
    b.close();
    assert.equal(again.created, false, 'та же ревизия — запись снимка прежняя');
    const view = operatorView(baseInput({ sources: connectorSources(s.state) }));
    assert.deepEqual(
      view.scope!.tasks.map((t) => t.state),
      ['not-handed-over'],
      'колонка изменилась без новой ревизии — срез свежий',
    );
  } finally {
    await s.cleanup();
  }
});

test('alpha.60: принятый результат по умолчанию пишет ровно один комментарий', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const { opened } = await s.snapshotAndRun();
    assert.equal(opened.h.result(s.workId).result?.outcome, 'accepted');
    assert.equal((await s.project.transport().listComments(s.task.id)).length, 1);
    opened.close();
  } finally {
    await s.cleanup();
  }
});

test('alpha.60: вид сверх предела — без среза и вопросов источника, а не отказ', () => {
  const big = 'ж'.repeat(300);
  const input = baseInput({
    sources: [
      {
        connector: 'relay-v1-http-abc',
        provider: 'relay-v1-http',
        tasks: Array.from({ length: 230 }, (_, k) => ({
          id: 'T' + k,
          key: 'WEB-' + k,
          title: big,
          orderId: 'o' + k,
          problems: [{ code: 'DEPENDENCY_UNFINISHED', message: big }],
        })),
        observedAt: '2026-11-19T11:00:00.000Z',
        questions: Array.from({ length: 50 }, (_, k) => ({
          id: 'Q' + k,
          key: 'DOC-' + k,
          title: big,
          question: big,
          options: Array.from({ length: 10 }, () => big),
          recommendation: big,
          provisional: big,
          targets: ['WEB-1'],
        })),
      },
    ],
  });
  const view = operatorView(input, { maxBytes: 120_000 });
  operatorViewSchema.parse(view);
  assert.equal(view.scope, undefined);
  assert.equal(view.scopeReason, undefined, 'опущенный по размеру срез — не «снимка нет»');
  assert.equal(view.sourceQuestions, undefined);
  assert.equal(view.truncated?.scope, 230, 'усечённые и опущенные — без двойного счёта');
  assert.equal(view.truncated?.sourceQuestions, 50);
  assert.ok(view.health.warnings.some((w) => w.code === 'VIEW_SECTIONS_DROPPED'));
});

test('alpha.61: обновления переживают VIEW_SECTIONS_DROPPED; whatsNew сверх предела — число в truncated', () => {
  const big = 'ж'.repeat(300);
  const input = baseInput({
    sources: [
      {
        connector: 'relay-v1-http-abc',
        provider: 'relay-v1-http',
        tasks: Array.from({ length: 230 }, (_, k) => ({
          id: 'T' + k,
          key: 'WEB-' + k,
          title: big,
          orderId: 'o' + k,
          problems: [{ code: 'DEPENDENCY_UNFINISHED', message: big }],
        })),
        observedAt: '2026-11-19T11:00:00.000Z',
        questions: [],
      },
    ],
    updates: {
      state: 'available',
      mode: 'notify',
      current: { harness: '0.1.0-alpha.60', ui: '0.1.0-alpha.4' },
      available: { harness: '0.1.0-alpha.61', ui: '0.1.0-alpha.5' },
      checkedAt: '2026-11-19T10:00:00.000Z',
      line: 'Доступна harness 0.1.0-alpha.61 и панель 0.1.0-alpha.5',
      whatsNew: Array.from({ length: 13 }, (_, k) => `пункт ${k + 1}`),
      command: 'harness update --apply --state .harness/state',
    },
  });
  const view = operatorView(input, { maxBytes: 120_000 });
  operatorViewSchema.parse(view);
  assert.equal(view.scope, undefined);
  assert.ok(view.health.warnings.some((w) => w.code === 'VIEW_SECTIONS_DROPPED'));
  assert.equal(view.updates?.state, 'available');
  assert.deepEqual(view.updates?.available, { harness: '0.1.0-alpha.61', ui: '0.1.0-alpha.5' });
  assert.equal(view.updates?.whatsNew?.length, 10);
  assert.equal(view.updates?.whatsNew?.[9], 'пункт 10');
  assert.equal(view.truncated?.whatsNew, 3);
  assert.match(view.updates?.command ?? '', /harness update --apply/);
});

test('alpha.61: ожидание людей короче минуты — «меньше минуты», без «до»', () => {
  const input = (minutesAgo: number) =>
    baseInput({
      works: [work('w1', { status: 'failed' })],
      attempts: [attempt('w1', 1, { startedAt: at(30), finishedAt: at(20), status: 'failed' })],
      stops: [
        {
          workId: 'w1',
          code: 'ATTEMPTS_EXHAUSTED',
          actor: 'user',
          action: 'reset-attempts',
          since: at(minutesAgo),
        },
      ],
    });
  const short = operatorView(input(0.2)).forecast!.time.line;
  assert.match(short, /ждут людей сейчас: 1, меньше минуты — в прогноз не входит/);
  assert.doesNotMatch(short, /до меньше/);
  const long = operatorView(input(10)).forecast!.time.line;
  assert.match(long, /ждут людей сейчас: 1, до 10 мин — в прогноз не входит/);
  const en = operatorView(input(0.2), { lang: 'en' }).forecast!.time.line;
  assert.match(en, /waiting for people now: 1 work\(s\), under a minute — not in the estimate/);
});

test('alpha.60: срез, прогноз и строка очереди, шаги блокировок вместе — в пределе; сверх предела уходят только разделы связки', () => {
  const big = 'ж'.repeat(300);
  const line = 'Очередь стоит — никто не запущен: нужен новый запуск (ведущий: harness run).';
  const blocked = work('w1', {
    status: 'failed',
    blockers: [
      {
        code: 'ATTEMPTS_EXHAUSTED',
        message: 'm',
        plain: 'нужен ваш сброс',
        actor: 'user',
        step: 2,
      },
      { code: 'APPROVAL_STALE', message: 'm', plain: 'согласовать заново', actor: 'lead', step: 1 },
    ],
  });
  const source = (tasks: number) => ({
    connector: 'relay-v1-http-abc',
    provider: 'relay-v1-http',
    tasks: [
      { id: 'T-w1', key: 'WEB-W1', orderId: 'w1', workId: 'w1', problems: [] },
      ...Array.from({ length: tasks }, (_, k) => ({
        id: 'T' + k,
        key: 'WEB-' + k,
        title: big,
        orderId: 'o' + k,
        problems: [{ code: 'DEPENDENCY_UNFINISHED', message: big }],
      })),
    ],
    observedAt: '2026-11-19T11:00:00.000Z',
    questions: [],
  });
  const input = (tasks: number) =>
    baseInput({
      works: [blocked],
      // Прошедшее время и ожидание людей идут с часами (а токен — нет).
      attempts: [attempt('w1', 1, { startedAt: at(30), finishedAt: at(20), status: 'failed' })],
      stops: [
        {
          workId: 'w1',
          code: 'ATTEMPTS_EXHAUSTED',
          actor: 'user',
          action: 'reset-attempts',
          since: at(10),
        },
      ],
      queue: { paused: false, runner: 'not-running', restartBy: 'lead', line, lineEn: 'idle' },
      sources: [source(tasks)],
    });
  const check = (view: ReturnType<typeof operatorView>) => {
    operatorViewSchema.parse(view);
    assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 120_000);
    assert.deepEqual(
      [view.progress.queue.runner, view.progress.queue.restartBy, view.progress.queue.line],
      ['not-running', 'lead', line],
    );
    assert.deepEqual(
      view.works[0]!.blockers.map((b) => [b.code, b.step]),
      [
        ['ATTEMPTS_EXHAUSTED', 2],
        ['APPROVAL_STALE', 1],
      ],
    );
    assert.ok(view.forecast, 'прогноз остаётся при любом размере');
  };
  // Помещается: всё вместе, прогноз — по срезу, токен не зависит от часов.
  const fits = operatorView(input(5), { maxBytes: 120_000 });
  check(fits);
  assert.equal(fits.scope?.tasks.length, 6);
  assert.equal(fits.forecast!.progress.basis, 'scope');
  assert.equal(fits.forecast!.progress.total, 6);
  const later = operatorView({ ...input(5), now: input(5).now + 60_000 }, { maxBytes: 120_000 });
  assert.equal(later.forecast!.time.elapsedMs, fits.forecast!.time.elapsedMs! + 60_000);
  assert.equal(later.forecast!.time.humanWait.ms, fits.forecast!.time.humanWait.ms + 60_000);
  // Ряды истории сдвигаются с окном честно; часы прогноза в токен не входят.
  const moved = structuredClone(fits);
  moved.forecast!.time = { ...later.forecast!.time };
  assert.equal(viewToken(moved), fits.source.token);
  // Не помещается: опущены срез и вопросы источника, а очередь, шаги и прогноз — нет.
  const over = operatorView(input(230), { maxBytes: 120_000 });
  check(over);
  assert.equal(over.scope, undefined);
  assert.equal(over.truncated?.scope, 231, 'опущен весь срез, без двойного счёта');
  assert.ok(over.health.warnings.some((w) => w.code === 'VIEW_SECTIONS_DROPPED'));
  assert.equal(over.forecast!.progress.total, 231, 'прогноз — по всему срезу, даже опущенному');
});

test('alpha.60: ссылка на вопрос — без учётных данных, query и fragment endpoint', async () => {
  const { webBaseOf } = await import('../src/integrations/connector/questions.ts');
  const config = parseConfig(
    {
      version: 1,
      provider: 'relay-v1-http',
      relay: { endpoint: 'http://user:secret@127.0.0.1:4700/api/v1?token=x#y' },
      projectId: 'P1',
      actor: 'a',
      repository: { id: 'app' },
    },
    '/',
  ).config;
  assert.equal(webBaseOf(config), 'http://127.0.0.1:4700/projects/P1');
});

test('alpha.60 (P11): прогноз выпуска — готовность всего среза, время по попыткам, ожидание людей отдельно', () => {
  const stage = (name: string) => ({
    name,
    next: [],
    spend: { calls: 0, knownUsd: 0, unknownCalls: 0, durationMs: 0 },
  });
  const done = work('w1', { status: 'done', stage: stage('done') });
  const writing = work('w2', { status: 'running', stage: stage('writer') });
  // Пять закончившихся попыток по 10 мин; принятая задача заняла две попытки.
  const attempts = [
    attempt('w1', 1, { startedAt: at(100), finishedAt: at(90), status: 'failed' }),
    attempt('w1', 2, { startedAt: at(90), finishedAt: at(80) }),
    attempt('w2', 1, { startedAt: at(80), finishedAt: at(70), status: 'failed' }),
    attempt('w2', 2, { startedAt: at(70), finishedAt: at(60), status: 'failed' }),
    attempt('w2', 3, { startedAt: at(60), finishedAt: at(50), status: 'failed' }),
  ];
  const input = baseInput({
    works: [done, writing],
    attempts,
    stops: [
      {
        workId: 'w2',
        code: 'INPUT_REQUIRED',
        actor: 'user',
        action: 'answer-input',
        since: at(15),
      },
    ],
    sources: [
      {
        connector: 'c',
        provider: 'relay-v1-http',
        tasks: [
          { id: 'T1', key: 'WEB-1', orderId: 'w1', workId: 'w1', problems: [] },
          { id: 'T2', key: 'WEB-2', orderId: 'w2', workId: 'w2', problems: [] },
          { id: 'T3', key: 'WEB-3', orderId: 'w3', problems: [] },
        ],
        observedAt: at(5),
      },
    ],
  });
  const view = operatorView(input);
  operatorViewSchema.parse(view);
  const f = view.forecast!;
  // Код (1 + 1/5 + 0) / 3 — 90 % выпуска: 36 %; шаги ведущего (ревизия 6):
  // план не согласован — WEB-3 ещё планируемая, доставки и отчёта нет.
  assert.deepEqual(
    [f.progress.percent, f.progress.done, f.progress.left, f.progress.total, f.progress.basis],
    [36, 1, 2, 3, 'scope'],
  );
  assert.equal(
    f.progress.line,
    'готово ~36 %, осталось задач: 2 из 3, в работе: 1, планируемых (не утверждены): 1',
  );
  // Две цифры: по утверждённому плану (WEB-1, WEB-2) и с планируемой WEB-3.
  assert.equal(f.progress.planned?.count, 1);
  assert.deepEqual(f.progress.planned?.keys, ['WEB-3']);
  assert.equal(f.progress.approved?.percent, 54);
  assert.match(
    f.progress.planned.line,
    /^по утверждённому плану ~54 %, осталось ~.+; с планируемыми \(1 задача, не утверждены: WEB-3\) ~36 %, осталось ~/,
  );
  assert.equal(f.time.elapsedMs, 100 * 60_000);
  // Осталось 1,8 задачи × 10 мин × 2 попытки: последовательно 36 мин; параллельно —
  // не быстрее одной задачи.
  const concurrency = input.policy.concurrency;
  assert.deepEqual(f.time.remaining, {
    loMs: Math.round(Math.max(1.8 / concurrency, 1) * 600_000 * 2),
    hiMs: 1.8 * 600_000 * 2,
    samples: 5,
    attemptsPerTask: 2,
  });
  assert.deepEqual(f.time.humanWait, { works: 1, ms: 15 * 60_000, since: at(15) });
  assert.equal(f.time.startedAt, at(100));
  // Ход часов меняет «прошло» и ожидание, но не токен содержимого; точки отсчёта — меняют.
  const later = operatorView({ ...input, now: input.now + 60_000 }).forecast!;
  assert.equal(later.time.elapsedMs, f.time.elapsedMs + 60_000);
  const moved = structuredClone(view);
  moved.forecast!.time = { ...later.time };
  assert.equal(viewToken(moved), view.source.token);
  moved.forecast!.time.startedAt = at(101);
  assert.notEqual(viewToken(moved), view.source.token);
  assert.match(f.time.line, /^прошло 1 ч 40 мин · осталось ~/);
  assert.match(f.time.line, /ждут людей сейчас: 1, до 15 мин — в прогноз не входит/);
  assert.ok(f.assumptions.length >= 3);
  const en = operatorView(input, { lang: 'en' }).forecast!;
  assert.equal(
    en.progress.line,
    'done ~36 %, 2 of 3 task(s) left, 1 in work, planned (not approved): 1',
  );

  // Мало образцов (ревизия 5) — грубый разброс «по N попыткам», а не «неизвестно».
  const few = operatorView({ ...input, attempts: attempts.slice(0, 2) }).forecast!;
  assert.equal(few.time.remaining, undefined);
  assert.equal(few.time.estimate, 'rough');
  assert.equal(few.time.rough?.samples, 2);
  assert.match(few.time.line, /осталось ~[^(]+\(грубо, по 2 попыткам\)/);
  // Ни одной закончившейся попытки — неизвестно, а не ноль.
  const none = operatorView({
    ...input,
    attempts: attempts.filter((a) => a.status === 'active'),
  }).forecast!;
  assert.equal(none.time.rough, undefined);
  assert.equal(none.time.estimate, 'unknown');
  assert.match(none.time.line, /неизвестно/);
  // Нет работ и среза — прогноза нет.
  assert.equal(operatorView(baseInput()).forecast, undefined);
  void NOW;
});

test('alpha.60 (P11): прогноз — p50/p90 разных попыток, закрытая и отменённая в источнике, прерванная попытка, ~99 %', () => {
  const stage = (name: string) => ({
    name,
    next: [],
    spend: { calls: 0, knownUsd: 0, unknownCalls: 0, durationMs: 0 },
  });
  const minutes = [5, 10, 15, 20, 60];
  const attempts = [
    ...minutes.map((m, k) =>
      attempt('w1', k + 1, {
        startedAt: at(200),
        finishedAt: at(200 - m),
        status: k < 4 ? 'failed' : 'succeeded',
      }),
    ),
    // Прерванная остановкой — ни образец, ни попытка задачи.
    attempt('w1', 6, { startedAt: at(100), finishedAt: at(99), interrupted: true }),
  ];
  const input = baseInput({
    works: [work('w1', { status: 'done', stage: stage('done') })],
    attempts,
    sources: [
      {
        connector: 'c',
        provider: 'relay-v1-http',
        tasks: [
          { id: 'T1', key: 'WEB-1', orderId: 'w1', workId: 'w1', problems: [] },
          {
            id: 'T2',
            key: 'WEB-2',
            orderId: 'o2',
            problems: [{ code: 'TASK_DONE', message: 'done' }],
          },
          {
            id: 'T3',
            key: 'WEB-3',
            orderId: 'o3',
            problems: [{ code: 'TASK_CANCELLED', message: 'x' }],
          },
          { id: 'T4', key: 'WEB-4', orderId: 'o4', problems: [] },
        ],
        observedAt: at(5),
      },
    ],
  });
  const f = operatorView(input).forecast!;
  // Объём 3 (отменённая вне объёма): код (1 + 1 + 0) / 3 — 90 % выпуска: 60 %;
  // шаги ведущего (ревизия 6) не сделаны: WEB-4 планируемая, доставки и отчёта нет.
  assert.deepEqual(
    [f.progress.total, f.progress.done, f.progress.left, f.progress.percent],
    [3, 2, 1, 60],
  );
  // p50 = 15 мин, p90 = 60 мин; попыток на принятую задачу 5 (прерванная не считается).
  assert.deepEqual(f.time.remaining, {
    loMs: 15 * 60_000 * 5,
    hiMs: 60 * 60_000 * 5,
    samples: 5,
    attemptsPerTask: 5,
  });
  // 199 готовых из 200 с одной в интеграции — не «100 %».
  const many = baseInput({
    works: [
      ...Array.from({ length: 199 }, (_, k) =>
        work('d' + k, { status: 'done', stage: stage('done') }),
      ),
      work('x', { status: 'running', stage: stage('integration') }),
    ],
  });
  const m = operatorView(many).forecast!;
  assert.equal(m.progress.basis, 'works');
  // Код 199/200 — 90 % выпуска, план согласован (половина доли ведущего).
  assert.equal(m.progress.percent, 95);
  assert.equal(m.progress.left, 1);
});

test('alpha.68 (r1): документ требований, который контекст задачи заменил ссылкой на документ задачи, — постановка: правка его текста — APPROVAL_STALE, а не documentsDrift', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    const doc = await s.project.admin.addDocument(s.task.id, {
      name: 'Goal spec',
      body: '# Goal\n\nVersion 1.\n',
    });
    let body = '# Goal\n\nVersion 1.\n';
    const transport = () =>
      contextual(s.project.transport(), {
        records: () => [
          fi(),
          {
            section: 'document',
            kind: 'document',
            id: doc.id,
            key: 'DOC-9',
            title: 'Goal spec',
            revision: 1,
            summary: '',
            body,
            reasons: [{ code: 'target-document', from: 'PRODUCT-1' }],
          },
        ],
      }).transport;
    const opened = await s.open({ transport: transport() });
    await opened.connector.snapshot(join(s.root, 'a'));
    const built = await opened.connector.source.snapshot();
    // Ревизия набора — формула alpha.67 (тело документа требований в неё
    // отдельно не входит): закреплённые прежней версией снимки остаются
    // согласованными после обновления (ревью r2).
    const m = built.manifest.tasks[0]!;
    const read = await s.project.transport().readTask(m.id);
    const mapping = s.loaded().config.tasks[0]!;
    assert.equal(
      built.manifest.revision,
      digestOf({
        v: 2,
        connector: built.manifest.connector,
        tasks: [[m.identity, m.semanticDigest]],
        documents: [[m.identity, optionalDocumentsDigest(mapping, read)]],
        prerequisites: built.graph.prerequisites,
        taskContext: [
          [m.identity, m.taskContext!.status === 'included' ? m.taskContext!.digest : ''],
        ],
      }),
      'ревизия набора — прежняя формула',
    );
    assert.ok(built.manifest.ordersRevision);
    const text = built.context.sources
      .flatMap((x) => x.files)
      .find((f) => f.path === TASK_CONTEXT_FILE)!.content.data;
    assert.match(text, /documents\//, 'контекст ссылается на закреплённый документ задачи');
    opened.close();
    body = '# Goal\n\nVersion 2: a different requirement.\n';
    await s.project.admin.updateDocument(doc.id, body);
    const again = await s.open({ transport: transport() });
    await assert.rejects(
      again.connector.prepareRun(again.h),
      (e: unknown) => e instanceof HarnessError && e.code === 'APPROVAL_STALE',
    );
    again.close();
  } finally {
    await s.cleanup();
  }
});
