/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return --
 * Тесты правят сырой JSON политики до разбора схемой.
 */
/**
 * Повторное согласование после правки политики: `reapprove` с записью, кто и
 * почему; правка изоляции, сети и профилей инструментов требует нового ревью и
 * не обходится ни `reapprove`, ни библиотечным `Engine.approve`; `review-plan`
 * не возвращает раунд, проведённый под другой политикой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HarnessError,
  executionDigest,
  type ErrorCode,
  type ExecutionPolicy,
  type RuntimeAdapter,
  type RuntimeName,
  type RuntimeRequest,
} from '../src/contracts/index.ts';
import { Harness } from '../src/control/harness.ts';
import { graphOf, policyOf } from './engine-fixture.ts';

const refused = (code: ErrorCode, message?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  if (message) assert.match(e.message, message);
  return true;
};

function reviewers() {
  const requests: RuntimeRequest[] = [];
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: (request) => {
      requests.push(request);
      return Promise.resolve({
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'controlled',
        output: { approved: true, summary: 'ok', findings: [], previous: [] },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: 0,
          complete: true,
          source: 'claude-result',
        },
        diagnostics: { exitCode: 0 },
      });
    },
  });
  return { requests, adapters: { codex: adapter('codex'), claude: adapter('claude') } };
}

const graph = () => graphOf({ a: [] });
const base = (p: any) => {
  p.runTimeoutMs = 600000;
};

async function approvedUnder(policy: ExecutionPolicy) {
  const { requests, adapters } = reviewers();
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-reapprove-'));
  const h = Harness.open({ policy, stateDir, baseDir: process.cwd(), adapters });
  h.engine.register(graph(), { trusted: () => false, reachable: () => true });
  const record = await h.review({ kind: 'plan', graph: graph(), author: 'claude' });
  assert.equal(record.approved, true);
  assert.equal(record.policyDigest, executionDigest(policy));
  assert.ok(record.isolationDigest);
  h.engine.approve(record.subject, 'agent', { bindContext: true });
  h.close();
  const reopen = (next: ExecutionPolicy) =>
    Harness.open({ policy: next, stateDir, baseDir: process.cwd(), adapters });
  return { record, requests, reopen, stateDir };
}

test('RA01: правка без изоляции и сети — reapprove привязывает согласование к новой политике с записью, без вызова reviewer', async () => {
  const before = policyOf(base);
  const { record, requests, reopen } = await approvedUnder(before);
  const after = policyOf((p: any) => {
    base(p);
    p.runTimeoutMs = 900000;
  });
  const h = reopen(after);
  const calls = requests.length;
  assert.ok(
    h.engine.read((v) => v.graph(record.subject)!.policyDigest) !== executionDigest(after),
    'согласование устарело',
  );
  const data = h.reapprove(record.subject, record.digest, {
    by: 'lead (claude)',
    reason: 'runTimeoutMs 600000 → 900000: изоляция и сеть не менялись',
  });
  assert.equal(data.changed, true);
  assert.equal(data.round, record.round);
  assert.equal(data.policyDigest, executionDigest(after));
  assert.equal(data.previousPolicyDigest, executionDigest(before));
  assert.equal(requests.length, calls, 'reviewer не вызывался');
  const graphState = h.engine.read((v) => v.graph(record.subject)!);
  assert.equal(graphState.policyDigest, executionDigest(after));
  assert.deepEqual(graphState.approval!.reapproval, {
    by: 'lead (claude)',
    reason: 'runTimeoutMs 600000 → 900000: изоляция и сеть не менялись',
    round: record.round,
    previousPolicyDigest: executionDigest(before),
  });
  const event = h.store
    .events()
    .filter((e) => e.type === 'graph.approved')
    .at(-1)!;
  assert.equal((event.payload as any).reapproval.by, 'lead (claude)');
  assert.equal((event.payload as any).reapproval.policyDigest, executionDigest(after));
  // Повтор под той же политикой ничего не меняет.
  assert.equal(
    h.reapprove(record.subject, record.digest, { by: 'lead', reason: 'повтор' }).changed,
    false,
  );
  // Чужой digest — отказ.
  assert.throws(
    () => h.reapprove(record.subject, 'f'.repeat(64), { by: 'lead', reason: 'xxx' }),
    refused('APPROVAL_STALE'),
  );
  h.close();
});

test('RA02: review-plan под изменённой политикой не возвращает прежний раунд — новый раунд с новой политикой', async () => {
  const { record, requests, reopen } = await approvedUnder(policyOf(base));
  const after = policyOf((p: any) => {
    base(p);
    p.runTimeoutMs = 900000;
  });
  const h = reopen(after);
  const calls = requests.length;
  const again = await h.review({ kind: 'plan', graph: graph(), author: 'claude' });
  assert.equal(again.round, record.round + 1, 'новый раунд, а не сохранённая запись');
  assert.equal(again.policyDigest, executionDigest(after));
  assert.equal(requests.length, calls + 1);
  // Под той же политикой — прежний раунд без вызова.
  const same = await h.review({ kind: 'plan', graph: graph(), author: 'claude' });
  assert.equal(same.round, again.round);
  assert.equal(requests.length, calls + 1);
  h.close();
});

for (const [label, widen] of [
  ['домены сети изоляции', (p: any) => (p.isolation = { mode: 'os', domains: ['example.com'] })],
  ['изоляция выключена', (p: any) => (p.isolation = { mode: 'none', domains: [] })],
  [
    'сеть Codex в профиле инструментов',
    (p: any) =>
      (p.toolProfiles = {
        ...p.toolProfiles,
        net: { runtime: 'codex', codexNetwork: true },
      }),
  ],
] as const)
  test(`RA03: ${label} — нужен новый раунд: reapprove и Engine.approve отказывают, новый review-plan согласует`, async () => {
    const { record, requests, reopen } = await approvedUnder(policyOf(base));
    const after = policyOf((p: any) => {
      base(p);
      widen(p);
    });
    const h = reopen(after);
    const calls = requests.length;
    assert.throws(
      () =>
        h.reapprove(record.subject, record.digest, {
          by: 'lead',
          reason: 'расширил сеть исполнителя',
        }),
      refused('APPROVAL_REQUIRED', /Изоляция, сеть или профили инструментов .*review-plan/),
    );
    // Внутренности библиотеки ту же границу не обходят.
    assert.throws(
      () => h.engine.approve(record.subject, 'agent', { bindContext: true }),
      refused('APPROVAL_REQUIRED', /прежнее одобрение их не покрывает/),
    );
    assert.equal(requests.length, calls);
    assert.notEqual(
      h.engine.read((v) => v.graph(record.subject)!.policyDigest),
      executionDigest(after),
      'согласование не привязано к расширенной политике',
    );
    const fresh = await h.review({ kind: 'plan', graph: graph(), author: 'claude' });
    assert.equal(fresh.round, record.round + 1);
    assert.equal(requests.length, calls + 1, 'reviewer увидел новую политику');
    h.engine.approve(record.subject, 'agent', { bindContext: true });
    assert.equal(
      h.engine.read((v) => v.graph(record.subject)!.policyDigest),
      executionDigest(after),
    );
    h.close();
  });

test('RA04: reapprove несогласованного графа — отказ с указанием на review-plan', async () => {
  const { adapters } = reviewers();
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-reapprove-'));
  const h = Harness.open({ policy: policyOf(base), stateDir, baseDir: process.cwd(), adapters });
  h.engine.register(graph(), { trusted: () => false, reachable: () => true });
  const record = await h.review({ kind: 'plan', graph: graph(), author: 'claude' });
  assert.throws(
    () => h.reapprove(record.subject, record.digest, { by: 'lead', reason: 'xxx' }),
    refused('APPROVAL_REQUIRED', /review-plan/),
  );
  assert.throws(
    () => h.reapprove('missing', record.digest, { by: 'lead', reason: 'xxx' }),
    refused('NOT_FOUND'),
  );
  h.close();
});

test('RA05: CLI reapprove требует --by и --reason; --by принадлежит только reapprove', () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const harness = (args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd: mkdtempSync(join(tmpdir(), 'harness-cwd-')),
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    return JSON.parse(r.stdout) as { ok: boolean; error?: { code: string; message: string } };
  };
  const state = mkdtempSync(join(tmpdir(), 'harness-reapprove-cli-'));
  const common = [
    '--state',
    state,
    '--policy',
    'p.json',
    '--subject',
    'g',
    '--digest',
    'f'.repeat(64),
  ];
  const noBy = harness(['reapprove', ...common, '--reason', 'правка срока']);
  assert.equal(noBy.error?.code, 'INVALID_INPUT');
  assert.match(noBy.error.message, /by/);
  const short = harness(['reapprove', ...common, '--by', 'lead', '--reason', 'x']);
  assert.equal(short.error?.code, 'INVALID_INPUT');
  assert.match(short.error.message, /--reason/);
  const foreign = harness([
    'approve',
    '--state',
    state,
    '--subject',
    'g',
    '--digest',
    'f'.repeat(64),
    '--by',
    'lead',
  ]);
  assert.equal(foreign.error?.code, 'INVALID_INPUT');
  assert.match(foreign.error.message, /--by поддерживают: reapprove/);
});
