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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
import { executionPolicySchema, exitCodes } from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
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
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    HARNESS_CLAUDE_BIN: bin('fake-claude'),
    HARNESS_CODEX_BIN: bin('fake-codex'),
  };
  const argvOf = (args: string[]) => ['--import', import.meta.resolve('tsx'), cli, ...args];
  /** Ответ CLI как есть (для --human): exit, stdout, stderr. */
  const raw = (...args: string[]) =>
    spawnSync(process.execPath, argvOf(args), { cwd: app, encoding: 'utf8', env });
  /** Процесс CLI без ожидания (для --watch). */
  const spawnCli = (...args: string[]) =>
    spawn(process.execPath, argvOf(args), { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const harness = (...args: string[]) => {
    const r = raw(...args);
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
  return {
    root,
    app,
    harness,
    raw,
    spawnCli,
    scenario,
    reviews,
    state: join(root, 'state'),
  };
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

test('H12/H15 CLI: ответ ведущего на вопрос к человеку — OPERATOR_ANSWER_REQUIRED; status --human — этап и кто ответил', () => {
  const p = project();
  const base = ['--graph', 'graph.json', '--policy', 'policy.json', '--state', p.state];
  assert.equal(p.harness('run', ...base).status, exitCodes.refused);
  const id: string = p.harness('input-list', '--state', p.state).json.data.requests[0].id;
  const answer = (actor: string, text: string) =>
    p.harness(
      'input-answer',
      '--state',
      p.state,
      '--request',
      id,
      '--text',
      text,
      '--actor',
      actor,
      '--request-version',
      '1',
    );
  const eventsBefore = p.harness('events', '--state', p.state, '--limit', '500').json.data;
  const lead = answer('lead', 'Hi <name>');
  assert.equal(lead.status, exitCodes.refused, lead.stderr);
  assert.deepEqual(
    p.harness('events', '--state', p.state, '--limit', '500').json.data,
    eventsBefore,
    'отказ не записал событий',
  );
  assert.deepEqual(
    p.harness('input-show', '--state', p.state, '--request', id).json.data.answers,
    [],
  );
  assert.equal(lead.json.error?.code, 'OPERATOR_ANSWER_REQUIRED');
  assert.match(lead.stderr, /OPERATOR_ANSWER_REQUIRED/);
  const still = p.harness('status', '--state', p.state);
  assert.deepEqual(
    [still.json.data.works[0].input.state, still.json.data.works[0].input.version],
    ['awaiting-answer', 1],
    'отказ ничего не записал',
  );
  const stage = still.json.data.works[0].stage;
  assert.equal(stage.name, 'input');
  assert.deepEqual(stage.needs, { actor: 'user', action: 'answer-input' });
  const human = p.raw('status', '--state', p.state, '--human');
  assert.equal(human.status, 0, human.stderr);
  assert.match(
    human.stdout,
    /\n {2}сейчас: ждёт ответа на вопрос исполнителя — \d+ с; дальше: код, проверки, ревью, интеграция; от вас: ответить на вопрос исполнителя; потрачено: /,
  );
  assert.match(human.stdout, /ждёт ответа человека \(input-show, input-answer --actor operator\)/);

  const operator = answer('operator', 'Use exactly Hello, <name>!');
  assert.equal(operator.status, 0, operator.stderr);
  const after = p.harness('status', '--state', p.state);
  assert.equal(after.json.data.works[0].input.answeredBy, 'operator');
  assert.match(p.raw('status', '--state', p.state, '--human').stdout, /: ответил оператор\n/);
  const explain = p.harness('explain', '--state', p.state, '--policy', 'policy.json');
  assert.match(
    JSON.stringify(explain.json.data.diagnoses),
    /\(ответил: оператор\) записан, но не применён/,
  );

  // --watch: только со --human; --interval — только с --watch и в пределах.
  const refused = (...args: string[]) => {
    const r = p.raw('status', '--state', p.state, ...args);
    assert.equal(r.status, exitCodes.input, `${args.join(' ')}: ${r.stderr}`);
    return r.stderr;
  };
  assert.match(refused('--watch'), /--watch — только вместе с --human/);
  assert.match(refused('--human', '--interval', '2'), /--interval — только вместе с --watch/);
  assert.match(refused('--human', '--watch', '--interval', '0'), /--interval: целое/);
  assert.match(refused('--human', '--watch', '--interval', '1.5'), /--interval: целое/);
  assert.equal(p.raw('events', '--state', p.state, '--watch').status, exitCodes.input);
  // Доска успокоилась (попыток нет, controller не жив): один кадр и выход 0.
  const settled = p.raw('status', '--state', p.state, '--human', '--watch', '--interval', '1');
  assert.equal(settled.status, 0, settled.stderr);
  assert.equal(settled.stdout.split('harness status — ').length - 1, 1, settled.stdout);
  assert.match(settled.stdout, /обновление каждые 1 с; Ctrl-C — выход\)\n/);
  assert.match(settled.stdout, /сейчас: ждёт ответа на вопрос исполнителя/);
});

test('H15 CLI: status --human --watch обновляет кадр, пока живой controller сдвинет работу; сам выходит, когда доска успокоилась; Ctrl-C прерывает сразу', async () => {
  const p = project();
  const base = ['--graph', 'graph.json', '--policy', 'policy.json', '--state', p.state];
  const review = p.harness('review-plan', ...base, '--author', 'external');
  assert.equal(review.status, 0, review.stderr);
  const policy = executionPolicySchema.parse(
    JSON.parse(readFileSync(join(p.app, 'policy.json'), 'utf8')),
  );
  // Роль controller держит другой процесс: готовое поручение он выдаст.
  const other = new Engine({
    host: standaloneHost(new SqliteExecutionStore(join(p.state, 'state.sqlite'), 'other'), policy),
    policy,
  });
  const watch = (interval: string) => {
    const child = p.spawnCli(
      'status',
      '--state',
      p.state,
      '--human',
      '--watch',
      '--interval',
      interval,
    );
    const io = { out: '', err: '' };
    child.stdout.on('data', (b: Buffer) => (io.out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (io.err += b.toString()));
    const closed = new Promise<number | null>((done) => child.on('close', (c) => done(c)));
    // Выход процесса с пределом: зависший watch роняет тест, а не вешает его.
    const exited = (ms = 20_000) =>
      Promise.race([
        closed,
        new Promise<never>((_, fail) =>
          setTimeout(() => fail(new Error(`watch не вышел за ${ms} мс: ${io.err}`)), ms).unref(),
        ),
      ]);
    const frames = () => io.out.split('harness status — ').length - 1;
    const until = async (cond: () => boolean, ms: number) => {
      const deadline = Date.now() + ms;
      while (!cond() && Date.now() < deadline && child.exitCode === null)
        await new Promise((r) => setTimeout(r, 50));
    };
    return { child, io, exited, frames, until };
  };
  let released = false;
  try {
    assert.equal(other.lead('occupied-controller'), true);
    // План согласован и выдача идёт: поручение готово, его выдаст controller.
    const graphId = other.read((v) => v.graphs()[0]!.id);
    other.approve(graphId, policy.approvalMode);
    other.resume();

    // 1. Каждую секунду новый кадр; controller отпустил роль — выход сам, exit 0.
    const a = watch('1');
    try {
      await a.until(() => a.frames() >= 2, 60_000);
      assert.ok(a.frames() >= 2, `два кадра: ${a.io.out}\n${a.io.err}`);
      assert.equal(a.child.exitCode, null, 'пока controller жив, доска не успокоилась');
      assert.match(
        a.io.out,
        /сейчас: просто ждёт очереди — ничего не нужно; дальше: код, проверки, ревью, интеграция; от вас: ничего;/,
      );
      other.release('occupied-controller');
      released = true;
      assert.equal(await a.exited(), 0, a.io.err);
    } finally {
      a.child.kill('SIGKILL');
    }

    // 2. Длинный период: Ctrl-C будит ожидание сразу, а не по таймеру.
    assert.equal(other.lead('occupied-controller'), true);
    released = false;
    const b = watch('3600');
    try {
      await b.until(() => b.frames() >= 1, 60_000);
      assert.equal(b.frames(), 1, b.io.err);
      const sent = Date.now();
      b.child.kill('SIGINT');
      assert.equal(await b.exited(10_000), 0, b.io.err);
      assert.ok(Date.now() - sent < 10_000, 'выход по Ctrl-C без ожидания периода');
      assert.equal(b.frames(), 2, 'последний кадр — при выходе');
    } finally {
      b.child.kill('SIGKILL');
    }
  } finally {
    if (!released) other.release('occupied-controller');
    other.host.store.close();
  }
});
