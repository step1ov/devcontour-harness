import '../temp-scope.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
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
 * alpha.60 против НАСТОЯЩЕГО Relay с контекстом исполнения задачи
 * (`relay-task-context-v1`; сборка с этой capability — DC_RELAY_V1_BUILD).
 * Сервер старше (без capability) моделирует прокси, убирающий её из
 * `GET /context`: те же данные, прежняя связка. Нет сборки — BLOCKED.
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

/** Прокси «Relay старше»: те же данные, без capability контекста в `GET /context`. */
async function olderRelay(target: string) {
  const t = new URL(target);
  const server = createServer((req, res) => {
    const up = request(
      { host: t.hostname, port: t.port, method: req.method, path: req.url, headers: req.headers },
      (upRes) => {
        const chunks: Buffer[] = [];
        upRes.on('data', (c: Buffer) => chunks.push(c));
        upRes.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8');
          if (/\/context$/.test(new URL(req.url ?? '/', 'http://x').pathname)) {
            const j = JSON.parse(body) as { data: { capabilities?: string[] } };
            j.data.capabilities = j.data.capabilities?.filter((c) => c !== 'relay-task-context-v1');
            body = JSON.stringify(j);
          }
          const headers = { ...upRes.headers };
          delete headers['content-length'];
          res.writeHead(upRes.statusCode ?? 502, headers);
          res.end(body);
        });
      },
    );
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

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

  it('Relay старше (без capability): связка работает как прежде, предупреждение простыми словами', async () => {
    const proxy = await olderRelay(srv.url);
    try {
      const old = await openConnector(configFor(proxy.url), { stateDir: join(root, 'state-old') });
      const off = await openConnector(configFor(srv.url, { taskContext: { mode: 'off' } }), {
        stateDir: join(root, 'state-off'),
      });
      try {
        const report = await old.check();
        assert.equal(report.compatibility?.level, 'below-recommended');
        assert.match(
          report.warnings![0]!,
          /работаю без полного контекста задачи — исполнитель не получит описание функции и сценария/,
        );
        const a = await old.source.snapshot();
        const b = await off.source.snapshot();
        assert.ok(!a.context.sources[0]!.files.some((f) => f.path === TASK_CONTEXT_FILE));
        assert.equal(
          a.revision,
          b.revision,
          'без capability — та же ревизия, что у выключенного контекста',
        );
        assert.equal(a.manifest.contextDigest, b.manifest.contextDigest);
        assert.equal(a.manifest.tasks[0]!.taskContext, undefined);
      } finally {
        old.close();
        off.close();
      }
    } finally {
      await proxy.close();
    }
  });
});
