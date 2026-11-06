/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument --
 * Тест читает JSON-ответ CLI как есть; его форму проверяет сам CLI схемой команды.
 */
/**
 * H02 через CLI standalone: вопрос исполнителя → input-list/show → ответ →
 * снимок с ответом → review-plan с ним → input-target → input-apply →
 * обычный run. Runtime — fixture (`fake-claude` пишет, `fake-codex`
 * рецензирует), живых моделей нет.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitCodes } from '../src/contracts/index.ts';
import { approve, bin, greet } from './runner-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const example = fileURLToPath(new URL('../examples/single-task', import.meta.url));

const ask = {
  files: { 'src/greet.js': "exports.greet = () => 'draft';\n" },
  result: {
    completed: false,
    summary: 'Нужен ответ',
    discoveries: [],
    inputRequest: {
      question: 'Which greeting text?',
      options: [
        { id: 'hello', label: 'Hello, <name>!', consequence: null },
        { id: 'hi', label: 'Hi <name>', consequence: 'shorter' },
      ],
      recommended: 'hello',
      severity: 9,
      rationale: 'User-visible text',
      affects: [],
    },
    assumptions: [],
  },
};

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-cli-input-')));
  const app = join(root, 'greeting');
  cpSync(example, app, { recursive: true });
  const scenario = join(root, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      writer: [
        ask,
        {
          recordPrompt: true,
          files: { 'src/greet.js': greet },
          result: { completed: true, summary: 'greet', discoveries: [] },
        },
      ],
      reviewer: approve(),
    }),
  );
  const policy = JSON.parse(readFileSync(join(app, 'policy.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  policy.isolation = { mode: 'none', domains: [] };
  policy.environment = { values: { FIXTURE_SCENARIO: scenario } };
  policy.inputPolicy = { threshold: 7, criticalPaths: [] };
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
  const reviews = () => {
    const file = `${scenario}.codex.reviewer.count`;
    return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  };
  return { root, app, harness, scenario, reviews, state: join(root, 'state') };
}

test('H02 CLI: вопрос → ответ → снимок → review-plan → input-target → input-apply → run; обход до apply — INPUT_REQUIRED без платного ревью', () => {
  const p = project();
  const base = ['--graph', 'graph.json', '--policy', 'policy.json', '--state', p.state];
  const first = p.harness('run', ...base);
  assert.equal(first.status, exitCodes.refused, first.stderr);
  assert.equal(first.json.data.works[0].status, 'failed');
  assert.ok(
    first.json.data.works[0].blockers.some((b: { code: string }) => b.code === 'INPUT_REQUIRED'),
  );

  const list = p.harness('input-list', '--state', p.state);
  assert.equal(list.status, 0, list.stderr);
  const [summary] = list.json.data.requests;
  assert.equal(summary.state, 'awaiting-answer');
  assert.equal(summary.severity, 9);
  assert.doesNotMatch(JSON.stringify(list.json.data), /Which greeting/, 'список без текста');
  const id: string = summary.id;
  const show = p.harness('input-show', '--state', p.state, '--request', id);
  assert.equal(show.json.data.question.question, 'Which greeting text?');

  const status = p.harness('status', '--state', p.state);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.json.data.works[0].input.state, 'awaiting-answer');

  const retry = p.harness('retry', '--state', p.state, '--work', 'add-greeting');
  assert.equal(retry.json.error?.code, 'INPUT_REQUIRED');

  const answered = p.harness(
    'input-answer',
    '--state',
    p.state,
    '--request',
    id,
    '--text',
    'Use exactly Hello, <name>!',
    '--option',
    'hello',
    '--request-version',
    '1',
  );
  assert.equal(answered.status, 0, answered.stderr);
  const answerDigest: string = answered.json.data.answer.digest;
  const stale = p.harness(
    'input-answer',
    '--state',
    p.state,
    '--request',
    id,
    '--text',
    'другое',
    '--request-version',
    '1',
  );
  assert.equal(stale.json.error?.code, 'REVISION_CONFLICT');

  const out = join(p.root, 'input-context.json');
  const context = p.harness('input-context', '--state', p.state, '--request', id, '--out', out);
  assert.equal(context.status, 0, context.stderr);
  const digest: string = context.json.data.digest;
  assert.ok(existsSync(out));

  // Обходной запуск со снимком ответа до apply — отказ до платного ревью.
  const reviewsBefore = p.reviews();
  const bypass = p.harness('run', ...base, '--context', out);
  assert.equal(bypass.json.error?.code, 'INPUT_REQUIRED');
  assert.equal(p.reviews(), reviewsBefore, 'ревью не вызывалось');

  const review = p.harness('review-plan', ...base, '--context', out, '--author', 'external');
  assert.equal(review.status, 0, review.stderr);
  assert.equal(review.json.data.contextDigest, digest);

  const target = p.harness(
    'input-target',
    '--state',
    p.state,
    '--request',
    id,
    '--context-digest',
    digest,
  );
  assert.equal(target.status, 0, target.stderr);
  assert.deepEqual(target.json.data.problems, []);
  const apply = p.harness(
    'input-apply',
    '--state',
    p.state,
    '--request',
    id,
    '--answer',
    answerDigest,
    '--request-version',
    '2',
    '--context-digest',
    digest,
    '--target',
    target.json.data.target.digest,
  );
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(apply.json.data.applied, true);
  assert.equal(apply.json.data.work.status, 'ready');

  const second = p.harness('run', ...base, '--context', out);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.data.works[0].status, 'done');
  assert.equal(
    p.reviews() - reviewsBefore,
    3,
    'ревью плана и два ревью кода, без повторного ревью плана',
  );
  const prompt = readFileSync(`${p.scenario}.writer.1.prompt`, 'utf8');
  assert.match(prompt, /Use exactly Hello, <name>!/);
  const shown = p.harness('input-show', '--state', p.state, '--request', id);
  assert.equal(shown.json.data.lifecycle, 'applied');
  assert.ok(shown.json.data.delivered?.callId, 'доставка подтверждена вызовом');
});
