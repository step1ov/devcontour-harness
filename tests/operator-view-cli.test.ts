/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call --
 * Тест читает JSON-ответ CLI как есть; его форму проверяет сам CLI схемой команды.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cliCommands,
  exitCodes,
  operatorViewSchema,
  workDetailViewSchema,
} from '../src/contracts/index.ts';
import { harnessCapabilities } from '../src/catalog/harness.ts';
import { approve, bin, implement } from './runner-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const example = fileURLToPath(new URL('../examples/single-task', import.meta.url));

/** Пример single-task в своём Git и fixture runtime (подставные исполняемые, не живые модели). */
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-cli-view-')));
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
    return { status: r.status, stderr: r.stderr, json: JSON.parse(r.stdout) };
  };
  return { root, app, harness, state: join(root, 'state') };
}

test('harness view: после run — одна работа done, resultSha = result; --work, --no-titles, --lang', () => {
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
  const result = p.harness('result', '--state', p.state, '--work', 'add-greeting');
  const files = () => readdirSync(p.state, { recursive: true }).sort().join('\n');
  const before = files();

  const r = p.harness('view', '--state', p.state);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.command, 'view');
  const view = operatorViewSchema.parse(r.json.data);
  assert.equal(view.works.length, 1);
  const [w] = view.works;
  assert.equal(w!.status, 'done');
  assert.equal(w!.stage.name, 'done');
  assert.equal(w!.title, 'Add a greeting function');
  assert.equal(w!.resultSha, result.json.data.result.shas.result);
  assert.equal(view.progress.done, 1);
  assert.equal(view.health.drift.checked, 1);
  assert.ok(view.reviews.some((x) => x.kind === 'plan' && x.subject === 'greeting'));
  assert.ok(view.history.attemptsStarted.reduce((a, b) => a + b, 0) >= 1);

  const detail = p.harness('view', '--state', p.state, '--work', 'add-greeting');
  assert.equal(detail.status, 0, detail.stderr);
  const d = workDetailViewSchema.parse(detail.json.data);
  assert.equal(d.work.id, 'add-greeting');
  assert.ok(d.attempts.length >= 1);
  assert.equal(d.attempts[0]!.status, 'succeeded');
  assert.ok(d.attempts[0]!.stages.length > 0);

  const bare = p.harness('view', '--state', p.state, '--no-titles');
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.json.data.works[0].title, undefined);
  assert.ok(!JSON.stringify(bare.json.data).includes('Add a greeting function'));

  const en = p.harness('view', '--state', p.state, '--lang', 'en', '--window', '7d');
  assert.equal(en.status, 0, en.stderr);
  assert.match(en.json.data.works[0].attempts.line, /^attempts 1/);
  assert.equal(en.json.data.history.load.length, 168);

  // Только чтение: каталог состояния тот же.
  assert.equal(files(), before);

  for (const args of [
    ['--work', 'missing'],
    ['--view-version', '2'],
    ['--lang', 'de'],
    ['--window', '30d'],
    ['--bucket', 'soon'],
  ]) {
    const bad = p.harness('view', '--state', p.state, ...args);
    assert.equal(bad.status, exitCodes.input, args.join(' '));
    assert.equal(bad.json.error.code, 'INVALID_INPUT', args.join(' '));
  }
});

test('harness view: нет состояния — с --policy пустое представление, без — POLICY_REQUIRED; каталог не создаётся', () => {
  const p = project();
  const missing = join(p.root, 'no-state');
  const empty = p.harness('view', '--state', missing, '--policy', 'policy.json');
  assert.equal(empty.status, 0, empty.stderr);
  const view = operatorViewSchema.parse(empty.json.data);
  assert.deepEqual(view.works, []);
  assert.equal(view.settings.roles[0]!.role, 'developer');
  assert.ok(view.health.warnings.some((w) => w.code === 'STATE_NOT_FOUND'));
  assert.ok(view.settings.defaulted.includes('thresholds.maxAttempts'));
  assert.equal(existsSync(missing), false);

  const refused = p.harness('view', '--state', missing);
  assert.equal(refused.status, exitCodes.input);
  assert.equal(refused.json.error.code, 'POLICY_REQUIRED');
  assert.equal(existsSync(missing), false);
});

test('harness view: другая политика — POLICY_DIGEST_MISMATCH; view в capabilities, только чтение', () => {
  const p = project();
  assert.equal(
    p.harness('run', '--graph', 'graph.json', '--policy', 'policy.json', '--state', p.state).status,
    0,
  );
  const other = JSON.parse(readFileSync(join(p.app, 'policy.json'), 'utf8'));
  other.concurrency = 1;
  writeFileSync(join(p.root, 'other.json'), JSON.stringify(other));
  const r = p.harness('view', '--state', p.state, '--policy', join(p.root, 'other.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.json.data.health.warnings.some((w: any) => w.code === 'POLICY_DIGEST_MISMATCH'));
  assert.equal(r.json.data.settings.concurrency, 1);

  const tool = harnessCapabilities().tools.find((t) => t.name === 'view')!;
  assert.equal(tool.readOnly, true);
  assert.equal(cliCommands.view.writes, false);
  assert.ok(tool.inputSchema && tool.outputSchema);
});
