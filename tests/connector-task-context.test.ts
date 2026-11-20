/**
 * alpha.60: связка с Relay. Контекст исполнения задачи (`relay-task-context-v1`)
 * в пакете исполнителя, совместимость с Relay, вопросы владельцу в
 * представлении оператора, весь срез прогона, комментарии только об итоге,
 * связка до появления задач. Backend — подделка коннектора с добавленными
 * capability и методами; настоящий Relay — tests/integration/relay-v1-context.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, cliDataSchemas, operatorViewSchema } from '../src/contracts/index.ts';
import { openConnector, parseConfig } from '../src/integrations/connector/index.ts';
import {
  RELAY_TASK_CONTEXT_CAPABILITY,
  RELAY_TASK_CONTEXT_VERSION,
  relayCompatibility,
} from '../src/integrations/connector/compat.ts';
import { relayCompatibilityCheck } from '../src/integrations/connector/commands.ts';
import { parseQuestion } from '../src/integrations/connector/questions.ts';
import { TASK_CONTEXT_FILE } from '../src/integrations/connector/snapshot.ts';
import { fakeSuiteBackend, scenario } from '../src/integrations/connector/testing.ts';
import {
  TransportError,
  type RelayTransport,
  type SourceQuestionRecord,
  type TaskContextOutcome,
  type TaskContextRecord,
} from '../src/integrations/connector/transport.ts';
import { connectorSources, harnessView } from '../src/control/operator-view.ts';
import { operatorView } from '../src/projections/operator-view.ts';
import { baseInput } from './operator-view-input.ts';

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
    assert.equal(view.viewRevision, 4);
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
