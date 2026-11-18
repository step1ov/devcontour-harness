/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тест читает сгенерированную политику как сырой JSON (input-форма файла).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HarnessError,
  executionPolicySchema,
  initDataSchema,
  selectReviewer,
  workGraphSchema,
  type ExecutionPolicy,
  type RuntimeAdapter,
  type RuntimeName,
} from '../src/contracts/index.ts';
import { doctor } from '../src/control/doctor.ts';
import { Harness } from '../src/control/harness.ts';
import { initProject, planProject, type InitOptions } from '../src/init/project.ts';
import type { ToolProbe } from '../src/toolchains/probe.ts';

type Runtime = 'claude' | 'codex';
const other = (r: Runtime): Runtime => (r === 'claude' ? 'codex' : 'claude');
const fixture = fileURLToPath(new URL('./fixtures/standalone/npm-app', import.meta.url));
const NPM = '11.4.2';

/**
 * Проба без живых CLI: `--version` отвечает версией, проверка входа —
 * кодом из `auth` (по умолчанию 0 — вход выполнен).
 */
const probeOf =
  (auth: Partial<Record<Runtime, number>> = {}): ToolProbe =>
  (argv) => {
    const name = basename(argv[0]!);
    const status = argv.includes('status');
    const code = status && (name === 'claude' || name === 'codex') ? (auth[name] ?? 0) : 0;
    const stdout = status
      ? ''
      : /(^|\/)npm(-cli\.js)?$/.test(argv[0]!) || argv.some((a) => /(^|\/)npm(-cli\.js)?$/.test(a))
        ? NPM + '\n'
        : name === 'claude' || name === 'codex'
          ? '1.2.3\n'
          : 'v24.3.0\n';
    return Promise.resolve({ code, stdout, stderr: '', timedOut: false });
  };

/**
 * Копия fixture в своём Git. CLI runtime — исполняемые заглушки по
 * `HARNESS_<RUNTIME>_BIN`, отсутствующий — путь без файла. Маркеры сессии
 * (CLAUDECODE, CODEX_THREAD_ID) сняты: окружение задаёт тест.
 */
function project(
  options: {
    available?: Runtime[];
    env?: Record<string, string>;
    auth?: Partial<Record<Runtime, number>>;
  } = {},
) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-init-lead-')));
  const root = join(scratch, 'app');
  cpSync(fixture, root, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
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
  const bin = join(scratch, 'bin');
  mkdirSync(bin);
  const available = options.available ?? ['claude', 'codex'];
  for (const r of available) {
    writeFileSync(join(bin, r), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, r), 0o755);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_STATE_HOME: join(scratch, 'state-home'),
    HARNESS_CLAUDE_BIN: join(bin, 'claude'),
    HARNESS_CODEX_BIN: join(bin, 'codex'),
  };
  delete env.CLAUDECODE;
  delete env.CODEX_THREAD_ID;
  Object.assign(env, options.env);
  const probe = probeOf(options.auth);
  const opts = (extra: Partial<InitOptions> = {}): InitOptions => ({
    repository: root,
    env,
    probe,
    ...extra,
  });
  return { scratch, root, env, opts, probe };
}

const generatedPolicy = async (p: ReturnType<typeof project>, extra: Partial<InitOptions>) => {
  const planned = await planProject(p.opts(extra));
  return { planned, raw: JSON.parse(planned.intents[3]!.content) };
};

const refusal = async (promise: Promise<unknown>, code: string) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HarnessError, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail('ожидался отказ ' + code);
};

const matrix: Record<string, Runtime[]> = {
  both: ['claude', 'codex'],
  'only codex': ['codex'],
  'only claude': ['claude'],
  none: [],
};

test('init --lead × наличие CLI: auto — ревью другим вендором, если он есть, иначе тот же runtime с явным same-vendor-allowed', async () => {
  for (const lead of ['claude', 'codex'] as const)
    for (const [name, available] of Object.entries(matrix)) {
      const label = `${lead}, ${name}`;
      const p = project({ available });
      const { planned, raw } = await generatedPolicy(p, { lead });
      const cross = available.includes(other(lead));
      const rule = cross
        ? { reviewer: { runtime: other(lead) } }
        : { reviewer: { runtime: lead }, vendor: 'same-vendor-allowed' };
      // Снимок решений политики: роли и все три правила ревью.
      assert.deepEqual(
        { roles: raw.roles, review: raw.review },
        {
          roles: { developer: { writer: { runtime: lead } } },
          review: { code: rule, plan: rule, contract: rule },
        },
        label,
      );
      const data = await initProject(p.opts({ lead, plan: true }));
      initDataSchema.parse(data);
      assert.deepEqual(data.lead, { runtime: lead, source: 'option' }, label);
      assert.deepEqual(data.review, { mode: cross ? 'cross' : 'same', source: 'auto' }, label);
      assert.equal(data.manifest.lead, lead, label);
      assert.equal(data.manifest.review, cross ? 'cross' : 'same', label);
      assert.deepEqual(
        data.manifest.runtimes,
        { writer: lead, reviewer: cross ? other(lead) : lead },
        label,
      );
      // Предупреждения: ревью тем же вендором и каждый назначенный, но отсутствующий CLI.
      const missing = [lead, ...(cross ? [other(lead)] : [])].filter((r) => !available.includes(r));
      assert.deepEqual(
        data.warnings.map((w) => w.code),
        [...(cross ? [] : ['review-same-vendor']), ...missing.map(() => 'runtime-missing')],
        label,
      );
      for (const r of missing)
        assert.ok(
          data.warnings.some(
            (w) => w.code === 'runtime-missing' && w.message.includes(`CLI ${r} `),
          ),
          label,
        );
      // Политика ведущего проходит выбор reviewer для его плана и кода.
      const policy = planned.policy;
      for (const kind of ['plan', 'contract', 'code'] as const) {
        const choice = selectReviewer(policy, kind, { runtime: lead });
        assert.ok(choice.ok, `${label}: ${kind}`);
        assert.equal(choice.sameVendor, !cross, `${label}: ${kind}`);
      }
    }
});

test('init auto: CLI другого вендора без входа — ревью тем же runtime; неизвестный вход — другим вендором', async () => {
  const noLogin = project({ auth: { codex: 1 } });
  const same = await initProject(noLogin.opts({ lead: 'claude', plan: true }));
  assert.deepEqual(same.review, { mode: 'same', source: 'auto' });
  assert.deepEqual(
    same.runtimes.map((r) => [r.runtime, r.status, r.auth]),
    [
      ['claude', 'available', 'ok'],
      ['codex', 'available', 'missing'],
    ],
  );
  const unknown = project({ auth: { codex: 7 } });
  const cross = await initProject(unknown.opts({ lead: 'claude', plan: true }));
  assert.deepEqual(cross.review, { mode: 'cross', source: 'auto' });
});

test('init --review cross без второго CLI: политика cross, init предупреждает, doctor называет проблему до первой попытки с назначениями CLI', async () => {
  const p = project({ available: ['codex'] });
  const data = await initProject(p.opts({ lead: 'codex', review: 'cross' }));
  assert.deepEqual(data.review, { mode: 'cross', source: 'option' });
  const policy = executionPolicySchema.parse(
    JSON.parse(readFileSync(join(p.root, '.harness/policy.json'), 'utf8')),
  );
  assert.equal(policy.review.plan.reviewer.runtime, 'claude');
  const warning = data.warnings.find((w) => w.code === 'runtime-missing');
  assert.ok(warning && /CLI claude не найден/.test(warning.message), JSON.stringify(data.warnings));
  const codex: RuntimeAdapter = {
    runtime: 'codex',
    capabilities: () => Promise.resolve({ runtime: 'codex', version: '1.2.3' } as any),
    invoke: () => Promise.reject(new Error('не вызывается')),
  };
  const report = await doctor(policy, { codex });
  const problem = report.problems.find((x) => x.startsWith('claude:'));
  assert.ok(problem, report.problems.join('\n'));
  assert.match(problem, /не найден/);
  assert.match(problem, /reviewer plan/);
  assert.match(problem, /init --review same/);
  // --review same без второго CLI — без проблемы doctor, с предупреждением.
  const q = project({ available: ['codex'] });
  await initProject(q.opts({ lead: 'codex', review: 'same' }));
  const samePolicy = executionPolicySchema.parse(
    JSON.parse(readFileSync(join(q.root, '.harness/policy.json'), 'utf8')),
  );
  const sameReport = await doctor(samePolicy, { codex });
  assert.deepEqual(sameReport.problems, []);
  assert.deepEqual(
    sameReport.warnings?.map((w) => w.code),
    ['review-same-vendor'],
  );
});

/** Управляемый reviewer: одобряет; вызовы записываются. Это механика harness, не модель. */
function controlled() {
  const calls: { runtime: RuntimeName; task: string }[] = [];
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: (request) => {
      calls.push({ runtime, task: request.task });
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
  return { calls, adapters: { codex: adapter('codex'), claude: adapter('claude') } };
}

const graphFor = (policy: ExecutionPolicy) => {
  const raw = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../examples/single-task/graph.json', import.meta.url)),
      'utf8',
    ),
  );
  raw.orders[0].gates = [policy.repositories[0]!.gates[0]!.id];
  return workGraphSchema.parse(raw);
};

test('регрессия: Codex-ведущий с политикой по умолчанию проходит review-plan (reviewer claude), а не REVIEWER_SAME_VENDOR', async () => {
  // Сессия Codex: признак окружения, без --lead и без --writer.
  const p = project({ env: { CODEX_THREAD_ID: 'thread-1' } });
  const data = await initProject(p.opts());
  assert.deepEqual(data.lead, { runtime: 'codex', source: 'env' });
  assert.equal(data.manifest.runtimes.writer, 'codex');
  const policy = executionPolicySchema.parse(
    JSON.parse(readFileSync(join(p.root, '.harness/policy.json'), 'utf8')),
  );
  const { calls, adapters } = controlled();
  const h = Harness.open({
    policy,
    stateDir: join(p.scratch, 'state'),
    baseDir: join(p.root, '.harness'),
    adapters,
  });
  try {
    const record = await h.review({ kind: 'plan', graph: graphFor(policy), author: 'codex' });
    assert.equal(record.reviewerRuntime, 'claude');
    assert.equal(record.sameVendor, false);
    assert.deepEqual(
      calls.map((c) => c.runtime),
      ['claude'],
    );
  } finally {
    h.close();
  }
});

test('ведущий: --lead > manifest > окружение > --writer; неизвестный — NOT_READY lead-unknown с вопросом, ничего не пишется', async () => {
  // --lead сильнее окружения.
  const a = project({ env: { CLAUDECODE: '1' } });
  const explicit = await initProject(a.opts({ lead: 'codex' }));
  assert.deepEqual(explicit.lead, { runtime: 'codex', source: 'option' });
  assert.deepEqual(explicit.manifest.runtimes, { writer: 'codex', reviewer: 'claude' });
  // Manifest сильнее окружения: новая сессия Claude Code продолжает решение.
  const resumed = await initProject(a.opts({ plan: true }));
  assert.deepEqual(resumed.lead, { runtime: 'codex', source: 'manifest' });
  assert.equal(resumed.conflicts, 0);
  assert.deepEqual(resumed.review, { mode: 'cross', source: 'manifest' });
  // Окружение: Claude Code и Codex.
  for (const [env, runtime] of [
    [{ CLAUDECODE: '1' }, 'claude'],
    [{ CODEX_THREAD_ID: 't-1' }, 'codex'],
  ] as const) {
    const q = project({ env });
    const data = await initProject(q.opts({ plan: true }));
    assert.deepEqual(data.lead, { runtime, source: 'env' });
    assert.equal(data.manifest.runtimes.writer, runtime, 'writer по умолчанию — ведущий');
  }
  // --writer без признака сессии — ведущий тот же; с признаком — writer отдельно.
  const w = project();
  const writerOnly = await initProject(w.opts({ writer: 'codex', plan: true }));
  assert.deepEqual(writerOnly.lead, { runtime: 'codex', source: 'writer' });
  const split = project({ env: { CLAUDECODE: '1' } });
  const { raw } = await generatedPolicy(split, { writer: 'codex' });
  assert.deepEqual(raw.roles, { developer: { writer: { runtime: 'codex' } } });
  assert.deepEqual(raw.review.plan, { reviewer: { runtime: 'codex' } }, 'план ведущего claude');
  assert.deepEqual(raw.review.code, { reviewer: { runtime: 'claude' } }, 'код writer codex');
  // Ни признака, ни решения — и оба признака сразу — вопрос, а не claude по умолчанию.
  for (const env of [{}, { CLAUDECODE: '1', CODEX_THREAD_ID: 't-1' }] as Record<string, string>[]) {
    const n = project({ env });
    const error = await refusal(initProject(n.opts({ plan: true })), 'NOT_READY');
    assert.deepEqual(error.issues, [{ path: ['--lead'], message: 'lead-unknown' }]);
    assert.match(error.message, /--lead claude или --lead codex/);
    await refusal(initProject(n.opts()), 'NOT_READY');
    assert.equal(existsSync(join(n.root, '.harness')), false);
  }
});

test('init --model: одна модель на writer и всех reviewers; с ревью двух вендоров — отказ', async () => {
  const p = project();
  const { planned, raw } = await generatedPolicy(p, {
    lead: 'claude',
    review: 'same',
    model: 'm-1',
  });
  const binding = { runtime: 'claude', model: 'm-1' };
  assert.deepEqual(raw.roles, { developer: { writer: binding } });
  for (const k of ['code', 'plan', 'contract'])
    assert.deepEqual(raw.review[k], { reviewer: binding, vendor: 'same-vendor-allowed' }, k);
  assert.equal(planned.manifest.model, 'm-1');
  const error = await refusal(
    initProject(p.opts({ lead: 'claude', review: 'cross', model: 'm-1', plan: true })),
    'INVALID_INPUT',
  );
  assert.deepEqual(error.issues, [{ path: ['--model'], message: 'model-cross-vendor' }]);
});

test('миграция: manifest прежнего формата без lead — ведущий из writer, без content-differs и без перезаписи', async () => {
  for (const writer of ['claude', 'codex'] as const) {
    const p = project({ env: { CLAUDECODE: '1' } });
    await initProject(p.opts({ lead: writer }));
    const manifestPath = join(p.root, '.harness/project.json');
    // Manifest прежней версии: те же поля без lead и review.
    const legacy = JSON.parse(readFileSync(manifestPath, 'utf8'));
    delete legacy.lead;
    delete legacy.review;
    const bytes = JSON.stringify(legacy, null, 2) + '\n';
    writeFileSync(manifestPath, bytes);
    const policyBytes = readFileSync(join(p.root, '.harness/policy.json'), 'utf8');
    for (const extra of [{}, { lead: writer }] as Partial<InitOptions>[]) {
      const data = await initProject(p.opts({ ...extra, plan: true }));
      assert.equal(data.status, 'complete', writer);
      assert.equal(data.conflicts, 0, `${writer}: ${JSON.stringify(data.files)}`);
      assert.deepEqual(
        data.lead,
        { runtime: writer, source: extra.lead ? 'option' : 'legacy-writer' },
        writer,
      );
      assert.deepEqual(data.review, { mode: 'cross', source: 'legacy' }, writer);
      assert.equal(data.manifest.lead, undefined, 'прежний manifest не переписывается');
    }
    const applied = await initProject(p.opts());
    assert.deepEqual(applied.created, []);
    assert.equal(readFileSync(manifestPath, 'utf8'), bytes);
    assert.equal(readFileSync(join(p.root, '.harness/policy.json'), 'utf8'), policyBytes);
  }
});

test('init --model: модель политики доходит до argv writer и reviewer', async () => {
  const { generatePolicy } = await import('../src/init/policy.ts');
  const { resolveProfile } = await import('../src/profiles/resolve.ts');
  const { setup, runAll, implement, approve } = await import('./runner-fixture.ts');
  const generated = generatePolicy({
    profile: resolveProfile('npm-ci'),
    lead: 'claude',
    writer: 'claude',
    review: 'same',
    model: 'm-1',
  }).input as any;
  const ctx = setup({
    scenario: {
      writer: { ...implement(), recordPrompt: true },
      reviewer: { ...approve(), recordPrompt: true },
    },
    policy: (p: any) => {
      p.roles.developer.writer = generated.roles.developer.writer;
      p.review = generated.review;
    },
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  const args = (role: string) =>
    JSON.parse(
      readFileSync(`${ctx.scenarioPath}.${role}.0.prompt`, 'utf8').split('\n---ARGS---\n')[1]!,
    ) as string[];
  for (const role of ['writer', 'reviewer']) {
    const argv = args(role);
    assert.equal(argv[argv.indexOf('--model') + 1], 'm-1', role);
  }
  ctx.store.close();
});
