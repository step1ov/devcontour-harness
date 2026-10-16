/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тест читает JSON-ответ CLI как есть; его форму проверяет сам CLI схемой команды.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approve, bin, implement } from './runner-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const example = fileURLToPath(new URL('../examples/single-task', import.meta.url));

/**
 * Пример из пакета в отдельном каталоге с собственным Git и fixture
 * executables вместо codex/claude (явно подставные, не живые модели).
 */
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-cli-run-')));
  const app = join(root, 'greeting');
  cpSync(example, app, { recursive: true });
  const scenario = join(root, 'scenario.json');
  writeFileSync(scenario, JSON.stringify({ writer: implement(), reviewer: approve() }));
  const policy = JSON.parse(readFileSync(join(app, 'policy.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  policy.isolation = { mode: 'none', domains: [] };
  policy.environment = { values: { FIXTURE_SCENARIO: scenario } };
  writeFileSync(join(app, 'policy.json'), JSON.stringify(policy, null, 2));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: app,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const harness = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd: app,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        HARNESS_CLAUDE_BIN: bin('fake-claude'),
        HARNESS_CODEX_BIN: bin('fake-codex'),
      },
    });
    return {
      status: r.status,
      stderr: r.stderr,
      json: JSON.parse(r.stdout) as { ok: boolean; data: any; error?: { code: string } },
    };
  };
  return { root, app, git, harness, state: join(root, 'state'), results: join(root, 'results') };
}

test('S1.1/T33: файл → ревью плана → кандидат → интеграция → принято → результат JSON; повтор, пауза и доставка', () => {
  const p = project();
  assert.equal(p.harness('validate', '--graph', 'graph.json', '--policy', 'policy.json').status, 0);
  const run = p.harness(
    'run',
    '--graph',
    'graph.json',
    '--policy',
    'policy.json',
    '--state',
    p.state,
    '--sink',
    'file:' + p.results,
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.json.data.resumed, false);
  assert.equal(run.json.data.works[0].status, 'done');
  const target = p.git('rev-parse', 'refs/heads/harness/accepted');
  assert.equal(run.json.data.works[0].resultSha, target);

  const result = p.harness('result', '--state', p.state, '--work', 'add-greeting');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.data.result.outcome, 'accepted');
  assert.equal(result.json.data.result.shas.result, target, 'result SHA проверяется по target ref');
  assert.equal(result.json.data.delivery[0].status, 'delivered');
  assert.equal(
    p.git('show', `${target}:src/greet.js`).trim(),
    implement().files['src/greet.js']!.trim(),
  );

  const delivered = join(p.results, 'add-greeting.json');
  const mtime = statSync(delivered).mtimeMs;
  assert.equal(
    p.harness(
      'deliver',
      '--state',
      p.state,
      '--work',
      'add-greeting',
      '--sink',
      'file:' + p.results,
    ).status,
    0,
  );
  assert.equal(statSync(delivered).mtimeMs, mtime, 'повтор доставки не пишет второй записи');

  const again = p.harness(
    'run',
    '--graph',
    'graph.json',
    '--policy',
    'policy.json',
    '--state',
    p.state,
  );
  assert.equal(again.status, 0);
  assert.equal(again.json.data.resumed, true, 'та же редакция продолжает прежнюю работу');
  const events = p.harness('events', '--state', p.state, '--limit', '500');
  const types = (events.json.data.events as { type: string }[]).map((e) => e.type);
  assert.equal(types.filter((t) => t === 'work.accepted').length, 1);
  assert.equal(
    types.filter((t) => t === 'attempt.claimed').length,
    1,
    'повторный run не выдал новых попыток',
  );
  assert.ok(!JSON.stringify(events.json).match(/"token"/), 'нет токенов');

  assert.equal(p.harness('pause', '--state', p.state).json.data.control.paused, true);
  const status = p.harness('status', '--state', p.state);
  assert.equal(status.json.data.control.pauseReason, 'operator');
  assert.equal(status.json.data.works[0].status, 'done');
  assert.equal(p.harness('resume', '--state', p.state).json.data.control.paused, false);
});

test('T33/T34: старый результат не закрывает новую редакцию источника — конфликт, без моделей и интеграции', () => {
  const p = project();
  const run = p.harness(
    'run',
    '--graph',
    'graph.json',
    '--policy',
    'policy.json',
    '--state',
    p.state,
  );
  assert.equal(run.status, 0, run.stderr);
  const graph = JSON.parse(readFileSync(join(p.app, 'graph.json'), 'utf8')) as {
    source: { revision: string };
  };
  graph.source.revision = '2';
  (graph as unknown as { orders: { source: { revision: string } }[] }).orders[0]!.source.revision =
    '2';
  writeFileSync(join(p.app, 'graph.json'), JSON.stringify(graph));
  const before = p.harness('events', '--state', p.state, '--limit', '500').json.data.events
    .length as number;
  const deliver = p.harness(
    'deliver',
    '--state',
    p.state,
    '--work',
    'add-greeting',
    '--sink',
    'file:' + p.results,
  );
  assert.equal(deliver.status, 0);
  assert.equal(deliver.json.data.delivery[0].status, 'conflict');
  assert.equal(deliver.json.data.delivery[0].currentRevision, '2');
  assert.ok(
    !existsSync(join(p.results, 'add-greeting.json')),
    'новая редакция не закрыта старым результатом',
  );
  const after = p.harness('events', '--state', p.state, '--limit', '500').json.data.events as {
    type: string;
  }[];
  assert.deepEqual(
    after.slice(before).map((e) => e.type),
    ['delivery.pending', 'delivery.conflict'],
    'никаких попыток и интеграции',
  );
});

test('S1-R1-08: run --once доводит выданный шаг до конца и не оставляет активной попытки', () => {
  const p = project();
  const once = p.harness(
    'run',
    '--graph',
    'graph.json',
    '--policy',
    'policy.json',
    '--state',
    p.state,
    '--once',
  );
  assert.equal(once.status, 0, once.stderr);
  const status = p.harness('status', '--state', p.state);
  assert.equal(status.json.data.works[0].status, 'done');
  assert.equal(status.json.data.works[0].activeRunId, undefined);
  assert.equal(status.json.data.controller, undefined, 'роль controller освобождена');
});

test('T33: файловый контекст каталога графа закрепляется за попыткой и попадает в запрос исполнителю', () => {
  const p = project();
  const graph = JSON.parse(readFileSync(join(p.app, 'graph.json'), 'utf8')) as {
    orders: { context: string[] }[];
  };
  graph.orders[0]!.context = ['norms'];
  writeFileSync(join(p.app, 'graph.json'), JSON.stringify(graph));
  mkdirSync(join(p.app, 'context', 'norms'), { recursive: true });
  writeFileSync(join(p.app, 'context', 'norms', 'rules.md'), 'Правило: экспорт через exports.\n');
  const scenarioPath = join(p.root, 'scenario.json');
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as {
    writer: Record<string, unknown>;
  };
  scenario.writer.recordPrompt = true;
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  p.git('add', '-A');
  p.git('commit', '-qm', 'context');
  const run = p.harness(
    'run',
    '--graph',
    'graph.json',
    '--policy',
    'policy.json',
    '--state',
    p.state,
  );
  assert.equal(run.status, 0, run.stderr);
  const prompt = readFileSync(scenarioPath + '.writer.0.prompt', 'utf8');
  assert.match(
    prompt,
    /Правило: экспорт через exports\./,
    'содержимое закреплённого файла в запросе',
  );
  const result = p.harness('result', '--state', p.state, '--work', 'add-greeting');
  assert.match(String(result.json.data.result.inputs.contextDigest), /^[a-f0-9]{64}$/);
});
