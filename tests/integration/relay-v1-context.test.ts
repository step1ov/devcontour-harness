import '../temp-scope.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { operatorViewSchema } from '../../src/contracts/index.ts';
import { openConnector, parseConfig } from '../../src/integrations/connector/index.ts';
import { TASK_CONTEXT_FILE } from '../../src/integrations/connector/snapshot.ts';
import { connectorSources } from '../../src/control/operator-view.ts';
import { operatorView } from '../../src/projections/operator-view.ts';
import { baseInput } from '../operator-view-input.ts';
import { relayServerModule, type RelayFixture } from './relay-v1-backend.ts';

/*
 * Контекст задачи против НАСТОЯЩЕГО Relay 0.13 без доработок (сборка
 * DC_RELAY_V1_BUILD на d692b5b, без `relay-task-context-v1`): с 0.1.0-alpha.69
 * контекст собирает транспорт harness из обычных маршрутов (задача,
 * `entities/get`, документы по цели) — тот же relay-context.md. Нет сборки —
 * BLOCKED.
 */

type Fixture = RelayFixture & { config: string; buildDir: string };

let srv: Fixture;
let root: string;
const ids: Record<string, string> = {};

/** relay-cli этой сборки через HTTP настоящего сервера (как ведущий вне песочницы). */
function cli(...args: string[]): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('RELAY_') && v) env[k] = v;
  env.RELAY_HOME = join(srv.tmp, 'home');
  env.RELAY_ACTOR = 'lead';
  return execFileSync(
    process.execPath,
    [
      join(srv.buildDir, 'apps/cli/dist/cli/main.js'),
      '--config',
      srv.config,
      '--server-url',
      srv.url,
      ...args,
    ],
    { encoding: 'utf8', env, cwd: join(srv.tmp, 'project') },
  );
}
const refOf = (kind: string, key: string) => {
  const j = JSON.parse(cli(kind, 'get', key, '--format', 'json')) as {
    data: { ref?: { id: string }; id?: string };
  };
  return j.data.ref?.id ?? j.data.id!;
};
const relations = (kind: string, id: string) =>
  JSON.stringify([{ target: { kind, id }, type: 'references', description: '' }]);

const configFor = (endpoint: string, extra: Record<string, unknown> = {}) =>
  parseConfig(
    {
      version: 1,
      provider: 'relay-v1-http',
      relay: { endpoint, timeoutMs: 30_000 },
      projectId: srv.projectId,
      actor: 'harness-controller',
      repository: { id: 'app' },
      tasks: [{ ref: 'WEB-1', writeScope: ['src'] }],
      ...extra,
    },
    root,
  );

void describe('alpha.60: Relay с контекстом задачи (настоящий сервер)', () => {
  before(async () => {
    const mod = await relayServerModule();
    srv = (await mod.startRelayServer()) as Fixture;
    root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-relay-context-')));
    cli(
      'feature',
      'create',
      '--name',
      'Каталог',
      '--summary',
      'Каталог чая',
      '--description',
      '## Каталог\nФильтр по виду чая.',
    );
    cli(
      'scenario',
      'create',
      '--feature',
      'FEATURE-1',
      '--name',
      'Отфильтровать',
      '--description',
      '## Участник\nПокупатель выбирает вид.',
    );
    cli(
      'application',
      'create',
      '--name',
      'Сайт',
      '--slug',
      'web',
      '--prefix',
      'WEB',
      '--type',
      'frontend',
      '--description',
      '## Ответственность\nВитрина.',
    );
    cli(
      'implementation',
      'create',
      '--title',
      'Каталог на сайте',
      '--application',
      'WEB',
      '--target',
      'FEATURE-1',
      '--description',
      '## Вклад сайта\nСтраница /catalog с фильтром.',
    );
    cli(
      'implementation',
      'create',
      '--title',
      'Фильтр на сайте',
      '--application',
      'WEB',
      '--target',
      'SCENARIO-1',
      '--description',
      '## Вклад\nКнопки фильтра.',
    );
    cli(
      'task',
      'create',
      '--board',
      'BOARD-WEB',
      '--column',
      'ready',
      '--title',
      'Показать каталог',
      '--description',
      '## Цель\nКаталог с фильтром.',
      '--targets',
      'WEB-FI-1',
      'WEB-SI-1',
      '--criterion-title',
      'a=Каталог открывается',
    );
    ids.task = refOf('task', 'WEB-1');
    ids.feature = refOf('feature', 'FEATURE-1');
    cli(
      'document',
      'create',
      '--name',
      'ТЗ',
      '--body',
      '# ТЗ\nЧайная лавка.',
      '--document-kind',
      'specification',
      '--relations',
      relations('task', ids.task),
    );
    cli(
      'document',
      'create',
      '--name',
      'Правила фичи',
      '--body',
      '# Правила фичи\nТолько чай.',
      '--document-kind',
      'rules',
      '--relations',
      JSON.stringify([
        { target: { kind: 'feature', id: ids.feature }, type: 'documents', description: '' },
      ]),
    );
    cli(
      'document',
      'create',
      '--name',
      'Вопрос: Нужна ли доставка?',
      '--body',
      '## Вопрос\nНужна ли доставка?\n\n## Варианты\n- да\n- нет\n\n## Рекомендация\nнет\n\n## Временный ответ\nсамовывоз',
      '--document-kind',
      'proposal',
      '--document-status',
      'draft',
      '--relations',
      relations('task', ids.task),
    );
  });
  after(async () => {
    await srv?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('source-check: Relay рекомендуемой версии, контекст задачи читается', async () => {
    const c = await openConnector(configFor(srv.url), { stateDir: join(root, 'state-check') });
    try {
      const report = await c.check();
      assert.equal(report.compatibility?.level, 'recommended');
      assert.equal(report.compatibility?.taskContextSource, 'client');
      assert.equal(report.compatibility?.contractVersion, 1);
      assert.equal(report.mapping[0]?.taskContext, 'included');
      assert.equal(report.warnings, undefined);
    } finally {
      c.close();
    }
  });

  it('source-snapshot: полный контекст в пакете, вопросы владельцу — в наблюдении и представлении', async () => {
    const state = join(root, 'state-snap');
    const c = await openConnector(configFor(srv.url), { stateDir: state });
    let first;
    try {
      first = await c.snapshot(join(root, 'snap-1'));
    } finally {
      c.close();
    }
    const source = first.snapshot.context.sources[0]!;
    const text = source.files.find((f) => f.path === TASK_CONTEXT_FILE)!.content.data;
    for (const needle of [
      '### WEB-FI-1: Каталог на сайте',
      'Страница /catalog с фильтром.',
      '### WEB-SI-1: Фильтр на сайте',
      '### FEATURE-1: Каталог',
      'Фильтр по виду чая.',
      '### SCENARIO-1: Отфильтровать',
      '### WEB: Сайт',
      'Паспорт продукта не заполнен.',
      '# Правила фичи',
      'включена: документ цели (FEATURE-1)',
    ])
      assert.ok(text.includes(needle), needle);
    assert.match(
      text,
      /### DOC-\d+: ТЗ[\s\S]*Текст — в файле documents\//,
      'документ задачи не повторяется',
    );
    assert.equal(first.tasks[0]!.taskContext?.status, 'included');

    const sources = connectorSources(state);
    assert.equal(sources[0]!.questions?.length, 1);
    const view = operatorView(baseInput({ sources }));
    operatorViewSchema.parse(view);
    const q = view.sourceQuestions![0]!;
    assert.equal(q.title, 'Нужна ли доставка?');
    assert.deepEqual(q.options, ['да', 'нет']);
    assert.deepEqual(q.tasks, ['WEB-1']);
    assert.ok(q.url?.startsWith(srv.url + '/projects/'), q.url);
    assert.deepEqual(
      view.scope!.tasks.map((t) => [t.key, t.state]),
      [['WEB-1', 'not-handed-over']],
    );
    assert.equal(view.health.sources![0]!.level, 'recommended');

    // Правка FI — новая ревизия набора, та же постановка задачи (semantic digest).
    const fi = JSON.parse(cli('implementation', 'get', 'WEB-FI-1', '--format', 'json')) as {
      data: { revision: number };
    };
    cli(
      'implementation',
      'update',
      'WEB-FI-1',
      '--description',
      '## Вклад сайта\nСтраница /catalog с фильтром и поиском.',
      '--if-revision',
      String(fi.data.revision),
    );
    const again = await openConnector(configFor(srv.url), { stateDir: state });
    try {
      const second = await again.source.snapshot();
      assert.notEqual(second.revision, first.revision);
      assert.equal(second.manifest.tasks[0]!.semanticDigest, first.tasks[0]!.semanticDigest);
      assert.match(
        second.context.sources[0]!.files.find((f) => f.path === TASK_CONTEXT_FILE)!.content.data,
        /и поиском/,
      );
    } finally {
      again.close();
    }
  });

  it('taskContext.mode: off — контекста нет, предупреждения о версии Relay нет', async () => {
    const off = await openConnector(configFor(srv.url, { taskContext: { mode: 'off' } }), {
      stateDir: join(root, 'state-off'),
    });
    try {
      const report = await off.check();
      assert.equal(report.compatibility?.level, 'recommended');
      assert.equal(report.compatibility?.taskContextUsed, false);
      const snap = await off.source.snapshot();
      assert.ok(!snap.context.sources[0]!.files.some((f) => f.path === TASK_CONTEXT_FILE));
      assert.equal(snap.manifest.tasks[0]!.taskContext, undefined);
    } finally {
      off.close();
    }
  });
});
