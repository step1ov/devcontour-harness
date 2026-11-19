/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
 * Тест читает JSON-ответ CLI как есть; его форму проверяет сам CLI схемой команды.
 */
/**
 * `harness review-code` (H10): технический обзор уже написанной ветки на
 * Git-фикстуре. Reviewer — fixture executable (HARNESS_*_BIN), не живая
 * модель. Проверяется: правило вендора, diff merge-base..head в запросе,
 * запись — не приёмка (target ref и поручения не меняются), повтор раунда с
 * прежними находками, тот же одобренный раунд без вызова, итог gates на head.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliDataSchemas, exitCodes } from '../src/contracts/index.ts';
import { bin } from './runner-fixture.ts';
import { finding, fixtureCalls, recordedPrompt, verdict } from './review-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const example = fileURLToPath(new URL('../examples/single-task', import.meta.url));

function project(policyPatch: (p: any) => void = () => {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-review-code-')));
  const app = join(root, 'greeting');
  cpSync(example, app, { recursive: true });
  const scenarioPath = join(root, 'scenario.json');
  const policy = JSON.parse(readFileSync(join(app, 'policy.json'), 'utf8'));
  policy.isolation = { mode: 'none', domains: [] };
  policy.environment = { values: { FIXTURE_SCENARIO: scenarioPath } };
  policy.maxAttempts = 3;
  policyPatch(policy);
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
  const state = join(root, 'state');
  const scenario = (s: unknown) => writeFileSync(scenarioPath, JSON.stringify(s));
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
    let json: any = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      /* нет JSON */
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  const commitOn = (branch: string, file: string, text: string) => {
    git('checkout', '-q', branch);
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, file), text);
    git('add', '-A');
    git('commit', '-qm', 'change ' + file);
    const sha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    return sha;
  };
  const reviewCode = (...extra: string[]) =>
    harness(
      'review-code',
      '--state',
      state,
      '--policy',
      'policy.json',
      '--base',
      'main',
      '--head',
      'feat',
      ...extra,
    );
  return { root, app, git, state, scenario, scenarioPath, harness, commitOn, reviewCode };
}

const record = (json: any) => {
  assert.equal(json?.ok, true, JSON.stringify(json?.error));
  return cliDataSchemas['review-code'].parse(json.data);
};

test('H10: review-code — обзор ветки: diff merge-base..head, reviewer другого вендора, запись не приёмка, рабочее дерево убрано', () => {
  const p = project();
  p.git('branch', 'feat');
  const head = p.commitOn('feat', 'src/greet.js', 'exports.greet = (n) => "Hi " + n;\n');
  // main уходит вперёд: diff обзора — от merge-base, а не от текущего main.
  p.commitOn('main', 'README.md', 'moved on\n');
  p.scenario({ reviewer: { ...verdict(true), recordPrompt: true, observe: ['src/greet.js'] } });
  const r = p.reviewCode();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = record(r.json);
  assert.equal(rec.kind, 'code');
  assert.equal(rec.acceptance, false);
  assert.equal(rec.approved, true);
  assert.equal(rec.head, head);
  assert.equal(rec.mergeBase, p.git('merge-base', 'main', 'feat'));
  assert.deepEqual(rec.files, ['src/greet.js']);
  assert.equal(rec.commits, 1);
  assert.equal(rec.role, 'developer');
  // Автор — writer роли (claude); reviewer кода — codex: другой вендор.
  assert.equal(rec.authorRuntime, 'claude');
  assert.equal(rec.reviewerRuntime, 'codex');
  assert.equal(rec.sameVendor, false);
  assert.equal(rec.gates, undefined);
  const prompt = recordedPrompt(p.scenarioPath, 'reviewer', 0);
  assert.match(prompt, /not acceptance/);
  assert.match(prompt, /\+exports\.greet/);
  assert.doesNotMatch(prompt, /moved on/, 'изменения main после merge-base не входят в diff');
  assert.match(prompt, /No controller gate results/);
  // Reviewer читал отдельное рабочее дерево на head; после обзора его нет.
  const observed = JSON.parse(readFileSync(p.scenarioPath + '.reviewer.0.observed', 'utf8'));
  assert.equal(observed['src/greet.js'], 'exports.greet = (n) => "Hi " + n;\n');
  assert.equal(p.git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1);
  // Не приёмка: target ref не создан, поручений нет.
  assert.throws(() => p.git('rev-parse', '--verify', 'refs/heads/harness/accepted'));
  const status = p.harness('status', '--state', p.state);
  assert.deepEqual(status.json.data.works, []);
  assert.ok(existsSync(rec.artifact));
});

test('H10: review-code — правило вендора: автор того же вендора без разрешения — REVIEWER_SAME_VENDOR до вызова; с разрешением — sameVendor', () => {
  const p = project();
  p.git('branch', 'feat');
  p.commitOn('feat', 'src/greet.js', 'exports.greet = () => 1;\n');
  p.scenario({ reviewer: verdict(true) });
  const refused = p.reviewCode('--author', 'codex');
  assert.equal(refused.status, exitCodes.input);
  assert.equal(refused.json.error.code, 'REVIEWER_SAME_VENDOR');
  assert.equal(fixtureCalls(p.scenarioPath, 'codex', 'reviewer'), 0);

  const q = project((policy) => {
    policy.review.code.vendor = 'same-vendor-allowed';
  });
  q.git('branch', 'feat');
  q.commitOn('feat', 'src/greet.js', 'exports.greet = () => 1;\n');
  q.scenario({ reviewer: verdict(true) });
  const allowed = q.reviewCode('--author', 'codex');
  assert.equal(allowed.status, 0, allowed.stdout);
  const rec = record(allowed.json);
  assert.equal(rec.sameVendor, true);
  assert.equal(rec.authorRuntime, 'codex');
});

test('H10: review-code — отказ: exit 3 и открытая находка; повтор по тем же ref — раунд 2 с прежней находкой; одобренный повтор — тот же раунд без вызова', () => {
  const p = project();
  p.git('branch', 'feat');
  p.commitOn('feat', 'src/greet.js', 'exports.greet = () => 1;\n');
  p.scenario({ reviewer: verdict(false, { findings: [finding('Нет обработки пустого имени')] }) });
  const first = p.reviewCode();
  assert.equal(first.status, exitCodes.refused, first.stdout);
  const r1 = record(first.json);
  assert.equal(r1.round, 1);
  assert.equal(r1.approved, false);
  assert.equal(r1.findings.length, 1);
  assert.equal(r1.findings[0]!.status, 'open');

  // Исправление на ветке; reviewer обязан назвать состояние прежней находки.
  const fixed = p.commitOn('feat', 'src/greet.js', 'exports.greet = (n) => n || "x";\n');
  const id = r1.findings[0]!.id;
  p.scenario({
    reviewer: {
      ...verdict(true, { previous: [{ id, status: 'closed', basis: 'Пустое имя обработано' }] }),
      recordPrompt: true,
    },
  });
  const second = p.reviewCode();
  assert.equal(second.status, 0, second.stdout);
  const r2 = record(second.json);
  assert.equal(r2.round, 2);
  assert.equal(r2.head, fixed);
  assert.equal(r2.subject, r1.subject);
  assert.equal(r2.findings[0]!.status, 'closed');
  assert.match(recordedPrompt(p.scenarioPath, 'reviewer', 1), new RegExp(id));

  const calls = fixtureCalls(p.scenarioPath, 'codex', 'reviewer');
  const again = p.reviewCode();
  assert.equal(again.status, 0);
  assert.equal(record(again.json).id, r2.id);
  assert.equal(fixtureCalls(p.scenarioPath, 'codex', 'reviewer'), calls, 'без нового вызова');
});

test('H10: review-code — итог `harness gates --sha` на head прикладывается к записи и запросу', () => {
  const p = project();
  p.git('branch', 'feat');
  const head = p.commitOn(
    'feat',
    'src/greet.js',
    "exports.greet = (name) => 'Hello, ' + name + '!';\n",
  );
  const gates = p.harness('gates', '--state', p.state, '--policy', 'policy.json', '--sha', 'feat');
  assert.equal(gates.json?.ok, true, gates.stdout + gates.stderr);
  p.scenario({ reviewer: { ...verdict(true), recordPrompt: true } });
  const r = p.reviewCode();
  const rec = record(r.json);
  assert.equal(rec.gates?.id, gates.json.data.id);
  assert.equal(rec.gates?.sha, head);
  assert.equal(rec.gates?.passed, gates.json.data.passed);
  assert.deepEqual(
    rec.gates?.gates.map((g) => g.gate),
    gates.json.data.gates.map((g: any) => g.gate),
  );
  assert.match(
    recordedPrompt(p.scenarioPath, 'reviewer', 0),
    /Gates run by the controller on head/,
  );
});

test('H10: review-code — нет изменений и неизвестный коммит — отказ до вызова', () => {
  const p = project();
  p.git('branch', 'feat');
  p.scenario({ reviewer: verdict(true) });
  const empty = p.reviewCode();
  assert.equal(empty.status, exitCodes.input);
  assert.equal(empty.json.error.code, 'INVALID_INPUT');
  const missing = p.harness(
    'review-code',
    '--state',
    p.state,
    '--policy',
    'policy.json',
    '--base',
    'main',
    '--head',
    'nope',
  );
  assert.equal(missing.json.error.code, 'NOT_FOUND');
  assert.equal(fixtureCalls(p.scenarioPath, 'codex', 'reviewer'), 0);
});
