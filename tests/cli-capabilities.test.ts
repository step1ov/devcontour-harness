/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument --
 * Тест правит сырой JSON политики примера и читает JSON-ответ CLI как есть.
 */
/**
 * H3-01, H3-02: `harness capabilities` и транспортная граница общих операций
 * настоящим subprocess CLI. Codex и claude — fixture executables
 * (`tests/fixtures/bin/fake-*`) со scripted-ответами; живых моделей нет.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliCommands, exitCodes, operationCatalogSchema } from '../src/contracts/index.ts';
import { cliTransportLimits, harnessCapabilities, sharedOperationNames } from '../src/index.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { approve, bin, implement } from './runner-fixture.ts';
import { planningProject } from './planning-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const example = fileURLToPath(new URL('../examples/single-task', import.meta.url));
const { maxInputBytes, maxResultBytes } = cliTransportLimits;
const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');

const harness = (args: string[], cwd?: string, env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    cwd: cwd ?? mkdtempSync(join(tmpdir(), 'harness-cwd-')),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      HARNESS_CLAUDE_BIN: bin('fake-claude'),
      HARNESS_CODEX_BIN: bin('fake-codex'),
      ...env,
    },
  });
  let json: any;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
};
/** stdout — ровно один JSON-конверт одной строкой. */
const oneJson = (stdout: string) => {
  assert.ok(stdout.endsWith('\n'));
  assert.equal(stdout.slice(0, -1).split('\n').length, 1, 'ровно одна строка');
  return JSON.parse(stdout);
};

test('H3-01: capabilities — exit 0, data = harnessCapabilities(), пять операций, readOnly = !writes', () => {
  const r = harness(['capabilities']);
  assert.equal(r.status, exitCodes.ok, r.stderr);
  const envelope = oneJson(r.stdout);
  assert.deepEqual(Object.keys(envelope), ['apiVersion', 'command', 'ok', 'data']);
  assert.equal(envelope.command, 'capabilities');
  assert.equal(envelope.ok, true);
  const expected = harnessCapabilities();
  assert.deepEqual(envelope.data, expected);
  // Тот же порядок ключей, что у библиотеки: байты ответа = байты каталога.
  assert.equal(JSON.stringify(envelope.data), JSON.stringify(expected));
  operationCatalogSchema.parse(envelope.data);
  assert.equal(envelope.data.name, 'devcontour-harness');
  assert.equal(envelope.data.protocolVersion, 1);
  assert.equal(envelope.data.maxInputBytes, maxInputBytes);
  assert.equal(envelope.data.maxResultBytes, maxResultBytes);
  assert.deepEqual(
    envelope.data.tools.map((t: any) => t.name),
    [...sharedOperationNames],
  );
  for (const tool of envelope.data.tools) {
    const c = tool.name as (typeof sharedOperationNames)[number];
    assert.equal(tool.readOnly, !cliCommands[c].writes, c);
    assert.equal(tool.description, cliCommands[c].description, c);
  }
  assert.ok(utf8(r.stdout) < maxResultBytes);

  const human = harness(['capabilities', '--human']);
  assert.equal(human.status, exitCodes.input);
  const refused = oneJson(human.stdout);
  assert.equal(refused.ok, false);
  assert.equal(refused.command, 'capabilities');
  assert.equal(refused.error.code, 'INVALID_INPUT');
});

test('H3-02: ответ plan-request сверх предела — RESPONSE_TOO_LARGE, exit 2, без усечения; --human — тот же JSON', () => {
  const p = planningProject();
  // ~1.1 MB постановки: prompt содержит её целиком и не помещается в предел.
  const line = 'Implement greet(name) for the npm app; keep the brief verbatim.\n';
  const briefPath = p.write('huge.brief.md', line.repeat(Math.ceil(1_100_000 / line.length)));
  assert.ok(readFileSync(briefPath).length > maxResultBytes);
  const args = ['plan-request', '--brief', briefPath, '--policy', p.policyPath];

  const r = p.planning(...args);
  assert.equal(r.status, exitCodes.input, r.stderr);
  assert.ok(utf8(r.stdout) < maxResultBytes, 'stdout меньше предела');
  const envelope = oneJson(r.stdout);
  assert.deepEqual(Object.keys(envelope), ['apiVersion', 'command', 'ok', 'error']);
  assert.equal(envelope.command, 'plan-request');
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'RESPONSE_TOO_LARGE');
  assert.match(
    envelope.error.message,
    new RegExp(
      `^Ответ plan-request: (\\d+) байт UTF-8 больше предела транспорта ${maxResultBytes}; данные не усечены — сузьте вход$`,
    ),
  );
  const bytes = Number(/: (\d+) байт/.exec(envelope.error.message)![1]);
  assert.ok(bytes > maxResultBytes && bytes > 1_100_000, 'мера — полный ответ, не усечённый');
  assert.deepEqual(envelope.error.issues, [
    { path: ['data'], message: `${bytes} > ${maxResultBytes}` },
  ]);
  assert.match(r.stderr, /harness: RESPONSE_TOO_LARGE: Ответ plan-request/);
  assert.equal(r.stdout.includes('keep the brief verbatim'), false, 'данные не выведены частично');

  const human = p.planning(...args, '--human');
  assert.equal(human.status, r.status, 'тот же exit у --human');
  assert.equal(human.stdout, r.stdout, '--human — тот же JSON-отказ');
  assert.deepEqual(p.trapCalls(), [], 'runtime не вызывались');

  // Тот же вход с обычной постановкой проходит границу: отказ — только от размера.
  const small = p.planning(
    'plan-request',
    '--brief',
    p.write('small.brief.md', line),
    '--policy',
    p.policyPath,
  );
  assert.equal(small.status, exitCodes.ok, small.stderr);
});

test('H3-02: аргументы общей операции сверх предела — INVALID_INPUT [argv], exit 2; мера — UTF-8 байты', () => {
  const state = '/nonexistent-harness-state';
  const policy = 'p.json';
  // JSON значений parseArgs: {"state":…,"policy":…,"work":…}.
  const overhead = JSON.stringify({ state, policy, work: '' }).length;
  const explain = (work: string) =>
    harness(['explain', '--state', state, '--policy', policy, '--work', work]);

  const over = explain('w'.repeat(100001));
  assert.equal(over.status, exitCodes.input, over.stderr);
  const refused = oneJson(over.stdout);
  assert.equal(refused.command, 'explain');
  assert.equal(refused.error.code, 'INVALID_INPUT');
  const bytes = overhead + 100001;
  assert.equal(
    refused.error.message,
    `Аргументы explain: ${bytes} байт UTF-8 больше предела ${maxInputBytes}`,
  );
  assert.deepEqual(refused.error.issues, [
    { path: ['argv'], message: `${bytes} > ${maxInputBytes}` },
  ]);

  // Ровно предел — граница пропускает: дальше обычный разбор входа (политики нет).
  const at = explain('w'.repeat(maxInputBytes - overhead));
  const passed = oneJson(at.stdout);
  assert.equal(passed.ok, false);
  assert.doesNotMatch(passed.error.message, /^Аргументы explain/);
  assert.match(passed.error.message, /^policy: /);
  const above = explain('w'.repeat(maxInputBytes - overhead + 1));
  assert.deepEqual(oneJson(above.stdout).error.issues[0].path, ['argv']);

  // Кириллица: меньше 100000 знаков, но больше 100000 байт.
  const cyrillic = explain('ж'.repeat(50001));
  assert.equal(cyrillic.status, exitCodes.input);
  assert.deepEqual(oneJson(cyrillic.stdout).error.issues[0].path, ['argv']);
});

test('H3-02: команды вне каталога границей не ограничены — ни по аргументам, ни по ответу', () => {
  const big = 'g'.repeat(150_000);
  const status = harness(['status', '--state', '/nonexistent-harness-state', '--graph', big]);
  assert.equal(status.status, exitCodes.refused, status.stderr);
  const s = oneJson(status.stdout);
  assert.equal(s.error.code, 'NOT_FOUND');
  assert.notDeepEqual(s.error.issues?.[0]?.path, ['argv']);
});

/** Пример пакета с собственным Git; codex/claude — fixture executables. */
function project(scenario: unknown, patchPolicy: (p: any) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-cli-caps-')));
  const app = join(root, 'greeting');
  cpSync(example, app, { recursive: true });
  const scenarioPath = join(root, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const policyPath = join(app, 'policy.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  policy.isolation = { mode: 'none', domains: [] };
  policy.environment = { values: { FIXTURE_SCENARIO: scenarioPath } };
  patchPolicy(policy);
  writeFileSync(policyPath, JSON.stringify(policy, null, 2));
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
  return { app, state: join(root, 'state') };
}

test('H3-02: evidence диагноза explain — ссылки на события events; ответ events больше предела не отвергается', () => {
  const wrongGreet = "exports.greet = (name) => 'Hi, ' + name;\n";
  const p = project(
    { writer: implement({ 'src/greet.js': wrongGreet }), reviewer: approve() },
    (x) => {
      x.repairBudget = 0;
    },
  );
  const run = harness(
    [
      'run',
      '--graph',
      'graph.json',
      '--policy',
      'policy.json',
      '--state',
      p.state,
      '--author',
      'claude',
    ],
    p.app,
  );
  assert.equal(run.status, exitCodes.refused, run.stderr);

  const explain = harness(['explain', '--state', p.state, '--policy', 'policy.json'], p.app);
  assert.equal(explain.status, exitCodes.ok, explain.stderr);
  const [d, ...rest] = oneJson(explain.stdout).data.diagnoses;
  assert.equal(rest.length, 0);
  assert.equal(d.code, 'GATE_FAILED');
  const attempts = d.evidence.filter((e: any) => e.kind === 'attempt');
  const evidence = d.evidence.filter((e: any) => e.kind === 'evidence');
  assert.equal(attempts.length, 1);
  assert.ok(evidence.length > 0);

  const events = harness(['events', '--state', p.state, '--limit', '500'], p.app);
  assert.equal(events.status, exitCodes.ok, events.stderr);
  const list = oneJson(events.stdout).data.events as any[];
  const failed = list.filter((e) => e.type === 'attempt.failed' && e.workId === d.workId);
  assert.ok(
    failed.some((e) => e.runId === attempts[0].id),
    'attempt — runId события attempt.failed',
  );
  const gates = list.filter((e) => e.type === 'attempt.gate' && e.runId === attempts[0].id);
  for (const link of evidence) {
    const event = gates.find((e) => e.payload.evidenceId === link.id);
    assert.ok(event, `evidence ${link.id} — evidenceId события attempt.gate`);
    assert.equal(event.payload.passed, false, link.id);
    assert.equal(link.sha, event.payload.sha, link.id);
  }

  // Ответ events больше предела транспорта: команда вне каталога — отдаётся целиком.
  const store = new SqliteExecutionStore(join(p.state, 'state.sqlite'), 'h3-test');
  try {
    store.transact('task.cancelled', (tx) => {
      for (let i = 0; i < 200; i++)
        tx.emit({ type: 'attempt.cancelled', payload: { reason: 'ж'.repeat(4000) } });
    });
  } finally {
    store.close();
  }
  const after = list.at(-1).seq;
  const large = harness(
    ['events', '--state', p.state, '--after', String(after), '--limit', '500'],
    p.app,
  );
  assert.equal(large.status, exitCodes.ok, large.stderr);
  assert.ok(utf8(large.stdout) > maxResultBytes, 'ответ больше maxResultBytes');
  const all = oneJson(large.stdout);
  assert.equal(all.ok, true);
  assert.equal(all.data.events.length, 200, 'ничего не усечено');
});
