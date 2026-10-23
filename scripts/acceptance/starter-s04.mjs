#!/usr/bin/env node
/**
 * S04 — ошибки среды и восстановление очистки на копии Turbo Starter с
 * lifecycle compose-bridge. Варианты (у каждого своё состояние и target ref):
 *
 *   S04-control         всё штатно: принято, обе среды очищены (позитивный контроль)
 *   S04-setup-partial   setup создал ресурсы и упал → gates не стартуют, ресурсы удалены
 *   S04-ready-timeout   healthcheck не проходит, ready истёк → gates не стартуют
 *   S04-gate-fail       gate упал после ready → не принято, среда очищена
 *   S04-teardown-fail   teardown integration упал → не принято (приёмка после teardown),
 *                       cleanup pending; очистка в НОВОМ процессе по тому же state
 *   S04-interrupted     harness убит SIGKILL при активной среде → новый процесс
 *                       истекает попытку и очищает среду по receipt
 *
 * Сбои вносятся файлом HX_BRIDGE_FAULTS (вне политики: digest lifecycle при
 * повторной очистке тот же), режим gate — файлом S04_GATE.
 *
 *   node scripts/acceptance/starter-s04.mjs --evidence <dir> --logs <dir> [--work <dir>] [--source <url|path>] [--only ...]
 * Код выхода: 0 PASS, 1 FAIL, 3 BLOCKED (нет Docker).
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  approve,
  git,
  implement,
  prepareStarterFixture,
  starterGraph,
  starterPolicy,
} from './starter-fixture.mjs';
import {
  docker,
  dockerInventory,
  finish,
  foreign,
  foreignPreserved,
  harness,
  harnessSpawn,
  recorder,
  requireDocker,
  waitFor,
  walk,
} from './starter-lib.mjs';

const { values } = parseArgs({
  options: {
    work: { type: 'string' },
    source: { type: 'string' },
    evidence: { type: 'string' },
    logs: { type: 'string' },
    only: { type: 'string' },
  },
});
// Канонический путь: Git сообщает worktree через realpath (/private/var… на macOS).
const W = (() => {
  const dir = resolve(values.work ?? mkdtempSync(join(tmpdir(), 'starter-s04-')));
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
})();
const rec = recorder(
  join(resolve(values.evidence ?? join(W, 'evidence')), 'S04'),
  join(resolve(values.logs ?? join(W, 'logs')), 'S04'),
);
const only = values.only ? new Set(values.only.split(',')) : undefined;
const CLEANUP = join(dirname(fileURLToPath(import.meta.url)), 'starter-cleanup.mjs');
const TSX = import.meta.resolve('tsx');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const WORK = 's04';
let fixture;
const runIds = new Set();

/** Ресурсы Docker попытки по метке run. */
function ownedBy(runId) {
  const list = (args) => docker(args).split('\n').filter(Boolean);
  const f = ['--filter', `label=devcontour.harness.run=${runId}`];
  return {
    containers: list(['ps', '-a', '--format', '{{.Names}} {{.State}}', ...f]),
    volumes: list(['volume', 'ls', '-q', ...f]),
    networks: list(['network', 'ls', '--format', '{{.Name}}', ...f]),
  };
}
const empty = (o) => !o.containers.length && !o.volumes.length && !o.networks.length;

/** Среды попытки: receipt harness (environment.json) и bridge рядом. */
function environments(artifacts) {
  return walk(artifacts)
    .filter((f) => f.endsWith('/environment/environment.json'))
    .map((file) => {
      const dir = dirname(file);
      const bridge = join(dir, 'bridge', 'receipt.json');
      const started = join(dir, 'gate-started.json');
      return {
        phase: file.includes('/integration/') ? 'integration' : 'candidate',
        dir,
        harness: json(file),
        bridge: existsSync(bridge) ? json(bridge) : null,
        gateStarted: existsSync(started) ? json(started) : null,
        logs: walk(dir)
          .filter((f) => f.endsWith('.log'))
          .map((f) => f.slice(dir.length + 1)),
        diagnostics: walk(join(dir, 'bridge', 'diagnostics')).map((f) => f.slice(dir.length + 1)),
      };
    });
}

/** Каталог варианта: политика с lifecycle, граф из одного поручения, сценарий fixture. */
function prepare(label, { faults, gate = 'pass', readyTimeoutMs, maxAttempts = 1 }) {
  const dir = join(W, 'runs', label);
  mkdirSync(dir, { recursive: true });
  const faultFile = join(dir, 'faults.json');
  if (faults) writeFileSync(faultFile, JSON.stringify(faults));
  const gateFile = join(dir, 'gate.json');
  writeFileSync(gateFile, JSON.stringify({ mode: gate }));
  const scenario = join(dir, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({ writer: implement({ 's04/marker.txt': label + '\n' }), reviewer: approve() }),
  );
  const targetRef = `refs/heads/harness/${label.toLowerCase()}`;
  const policy = starterPolicy(fixture, {
    template: 'policy.lifecycle.json',
    scenario,
    targetRef,
    edit: (p) => {
      const repo = p.repositories[0];
      repo.environment.values.HX_DB_PASSWORD = 'harness-s04';
      repo.environment.values.HX_BRIDGE_FAULTS = faultFile;
      repo.environment.values.S04_GATE = gateFile;
      repo.environment.secrets = {};
      if (readyTimeoutMs)
        repo.lifecycle.ready[0].command = [
          'node',
          '.harness/compose-bridge.mjs',
          'ready',
          '--timeout-ms',
          String(readyTimeoutMs),
        ];
      repo.gates = [
        {
          id: 'lifecycle-probe',
          kind: 'test',
          command: [
            'node',
            '--test',
            '--test-reporter=junit',
            '--test-reporter-destination=.artifacts/junit/lifecycle.xml',
            '.harness/acceptance/lifecycle-probe.test.mjs',
          ],
          report: { type: 'junit', path: '.artifacts/junit/lifecycle.xml' },
          timeoutMs: 600000,
        },
      ];
      p.concurrency = 1;
      p.maxAttempts = maxAttempts;
      p.leaseMs = 5000;
    },
  });
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy, null, 2));
  writeFileSync(
    join(dir, 'graph.json'),
    JSON.stringify(
      starterGraph({
        edit: (g) => {
          g.id = 'turbo-starter-' + label.toLowerCase();
          g.orders = [
            {
              ...g.orders[0],
              id: WORK,
              source: { connector: 'files', ref: WORK, revision: '1' },
              title: 'S04 lifecycle probe',
              goal: 'Add s04/marker.txt; the lifecycle-probe gate runs in the ready environment.',
              acceptance: ['lifecycle-probe passes in a ready environment'],
              writeScope: ['s04'],
              gates: ['lifecycle-probe'],
              context: [],
            },
          ];
        },
      }),
      null,
      2,
    ),
  );
  git(fixture.repo, ['update-ref', targetRef, fixture.baselineSha]);
  return { dir, state: join(dir, 'state'), targetRef, faultFile, gateFile, policy };
}

const runArgs = (v) => [
  'run',
  '--graph',
  'graph.json',
  '--policy',
  'policy.json',
  '--state',
  v.state,
  '--author',
  'external',
];
function outcome(label, v, run) {
  const result = harness(rec, `${label}.result`, ['result', '--state', v.state, '--work', WORK], {
    cwd: v.dir,
  });
  const r = result.json?.data?.result;
  const runId = r?.runId;
  if (runId) runIds.add(runId);
  const artifacts = runId ? join(v.state, 'artifacts', runId) : undefined;
  const envs = artifacts ? environments(artifacts) : [];
  const out = {
    label,
    runExit: run?.status ?? run?.code ?? null,
    runId,
    outcome: r?.outcome,
    stopReason: r?.stopReason,
    evidence: (r?.evidence ?? []).map((e) => ({
      phase: e.phase,
      gate: e.gate,
      passed: e.passed,
      summary: e.summary,
    })),
    target: { before: fixture.baselineSha, after: git(fixture.repo, ['rev-parse', v.targetRef]) },
    environments: envs.map((e) => ({
      phase: e.phase,
      dir: e.dir,
      harnessStatus: e.harness.status,
      bridgeStatus: e.bridge?.status,
      project: e.bridge?.project,
      ports: e.bridge?.ports,
      events: e.bridge?.events,
      cleanup: e.bridge?.cleanup,
      gateStarted: e.gateStarted,
      logs: e.logs,
      diagnostics: e.diagnostics,
    })),
    cleanupPending:
      artifacts && existsSync(join(artifacts, 'cleanup-pending.json'))
        ? json(join(artifacts, 'cleanup-pending.json'))
        : null,
    live: runId ? ownedBy(runId) : null,
  };
  rec.json(`${label}/outcome.json`, out);
  if (artifacts)
    for (const e of envs) {
      if (e.bridge) rec.json(`${label}/${e.phase}-bridge-receipt.json`, e.bridge);
      rec.json(`${label}/${e.phase}-environment.json`, e.harness);
    }
  return { ...out, artifacts };
}
/** Порядок lifecycle по событиям bridge и старту gate. */
function order(env) {
  const at = (stage, outcome) =>
    env.events?.find((e) => e.stage === stage && (!outcome || e.outcome === outcome))?.at;
  return {
    created: at('create'),
    ready: at('ready', 'healthy'),
    gate: env.gateStarted?.at,
    teardown: at('teardown'),
  };
}
const cleanupInNewProcess = (label, v, runId) => {
  // Финальный прогон: поставляемая команда `harness cleanup` установленного пакета.
  const cli = Boolean(process.env.HARNESS_CLI_BIN);
  const argv = cli
    ? [process.env.HARNESS_CLI_BIN, 'cleanup', '--state', v.state, '--run', runId]
    : ['--import', TSX, CLEANUP, '--state', v.state, '--run', runId];
  const r = spawnSync(process.execPath, argv, {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  rec.text(`cli/${label}.stdout.json`, r.stdout, 'logs');
  rec.text(`cli/${label}.stderr.txt`, r.stderr, 'logs');
  const json = JSON.parse(r.stdout || '{}');
  if (cli) {
    // Состояние попытки — отдельным чтением status (read-only).
    const status = spawnSync(
      process.execPath,
      [process.env.HARNESS_CLI_BIN, 'status', '--state', v.state],
      {
        encoding: 'utf8',
      },
    );
    const work = JSON.parse(status.stdout || '{}').data?.works?.[0];
    json.pid = r.pid;
    json.attempt = { status: work?.status };
    json.workStatus = work?.status;
  }
  return { status: r.status, json };
};

const variants = {
  async 'S04-control'() {
    const v = prepare('S04-control', {});
    const run = harness(rec, 'S04-control.run', runArgs(v), { cwd: v.dir });
    const o = outcome('S04-control', v, run);
    rec.check(
      'S04-control: принято',
      o.outcome === 'accepted' && o.target.after !== o.target.before,
      o,
    );
    rec.check(
      'S04-control: обе среды очищены, ресурсов нет',
      o.environments.length === 2 &&
        o.environments.every(
          (e) => e.harnessStatus === 'cleaned' && e.bridgeStatus === 'cleaned',
        ) &&
        empty(o.live),
      o.environments,
    );
    for (const e of o.environments) {
      const t = order(e);
      rec.check(
        `S04-control: ${e.phase} порядок setup → ready → gate → teardown`,
        t.created < t.ready && t.ready < t.gate && t.gate < t.teardown,
        t,
      );
    }
  },
  async 'S04-setup-partial'() {
    const v = prepare('S04-setup-partial', { faults: { '*': { setup: 'after-create' } } });
    const run = harness(rec, 'S04-setup-partial.run', runArgs(v), { cwd: v.dir });
    const o = outcome('S04-setup-partial', v, run);
    const e = o.environments[0];
    rec.check(
      'S04-setup-partial: не принято, target не сдвинут',
      o.outcome !== 'accepted' && o.target.after === o.target.before,
      o,
    );
    rec.check(
      'S04-setup-partial: причина — шаг setup',
      /compose-setup/.test(o.stopReason?.message ?? ''),
      o.stopReason,
    );
    rec.check(
      'S04-setup-partial: ресурсы были созданы, затем удалены teardown',
      e &&
        e.events.some(
          (x) => x.stage === 'create' && x.outcome === 'created' && x.detail.containers.length,
        ) &&
        e.bridgeStatus === 'cleaned' &&
        e.harnessStatus === 'cleaned' &&
        empty(o.live),
      e,
    );
    rec.check(
      'S04-setup-partial: gate не стартовал, evidence gates нет',
      !e.gateStarted && !o.evidence.some((x) => x.gate === 'lifecycle-probe'),
      o,
    );
    rec.check(
      'S04-setup-partial: лог setup сохранён',
      e.logs.includes('setup/compose-setup.log'),
      e.logs,
    );
  },
  async 'S04-ready-timeout'() {
    const v = prepare('S04-ready-timeout', {
      faults: { '*': { ready: 'unhealthy' } },
      readyTimeoutMs: 6000,
    });
    const run = harness(rec, 'S04-ready-timeout.run', runArgs(v), { cwd: v.dir });
    const o = outcome('S04-ready-timeout', v, run);
    const e = o.environments[0];
    rec.check(
      'S04-ready-timeout: не принято, target не сдвинут',
      o.outcome !== 'accepted' && o.target.after === o.target.before,
      o,
    );
    rec.check(
      'S04-ready-timeout: причина — шаг ready',
      /compose-ready/.test(o.stopReason?.message ?? ''),
      o.stopReason,
    );
    const failed = e?.events.find((x) => x.stage === 'ready' && x.outcome === 'failed');
    rec.check(
      'S04-ready-timeout: ready истёк по сроку, диагностика сохранена',
      failed && failed.detail.timeoutMs === 6000 && e.diagnostics.length === 2,
      e,
    );
    rec.check(
      'S04-ready-timeout: gate не стартовал',
      !e.gateStarted && !o.evidence.some((x) => x.gate === 'lifecycle-probe'),
      o,
    );
    rec.check('S04-ready-timeout: среда очищена', e.bridgeStatus === 'cleaned' && empty(o.live), e);
  },
  async 'S04-gate-fail'() {
    const v = prepare('S04-gate-fail', { gate: 'fail' });
    const run = harness(rec, 'S04-gate-fail.run', runArgs(v), { cwd: v.dir });
    const o = outcome('S04-gate-fail', v, run);
    const e = o.environments[0];
    rec.check(
      'S04-gate-fail: не принято, target не сдвинут',
      o.outcome !== 'accepted' && o.target.after === o.target.before,
      o,
    );
    rec.check(
      'S04-gate-fail: отказ gate lifecycle-probe',
      o.evidence.some((x) => x.gate === 'lifecycle-probe' && !x.passed),
      o.evidence,
    );
    const t = order(e);
    rec.check(
      'S04-gate-fail: gate стартовал только после ready',
      t.ready && t.gate && t.ready < t.gate && e.gateStarted.bridge === 'ready',
      t,
    );
    rec.check(
      'S04-gate-fail: среда очищена',
      e.bridgeStatus === 'cleaned' && e.harnessStatus === 'cleaned' && empty(o.live),
      e,
    );
  },
  async 'S04-teardown-fail'() {
    const v = prepare('S04-teardown-fail', { faults: { integration: { teardown: 'fail' } } });
    const run = harness(rec, 'S04-teardown-fail.run', runArgs(v), { cwd: v.dir });
    const o = outcome('S04-teardown-fail', v, run);
    const integration = o.environments.find((e) => e.phase === 'integration');
    rec.check(
      'S04-teardown-fail: candidate и integration gates и ревью прошли (контроль достижимости)',
      ['candidate', 'integration'].every((p) =>
        ['lifecycle-probe', 'independent-review'].every((g) =>
          o.evidence.some((x) => x.phase === p && x.gate === g && x.passed),
        ),
      ),
      o.evidence,
    );
    rec.check(
      'S04-teardown-fail: приёмка после teardown — не принято, target не сдвинут, история Git не переписана',
      o.outcome !== 'accepted' && o.target.after === o.target.before,
      o,
    );
    rec.check(
      'S04-teardown-fail: незавершённая очистка видна отдельно (receipt, cleanup-pending, живые ресурсы)',
      integration?.harnessStatus === 'cleanup-failed' &&
        o.cleanupPending?.reason === 'cleanup-failed' &&
        o.live.containers.length > 0 &&
        /Очистка окружения не завершена/.test(o.stopReason?.message ?? ''),
      { integration, cleanupPending: o.cleanupPending, live: o.live, stopReason: o.stopReason },
    );
    rec.check(
      'S04-teardown-fail: временные env-файлы удалены уже при сбое очистки',
      !existsSync(join(integration.dir, 'bridge', 'env')),
      integration.dir,
    );
    // Причина сбоя устранена оператором; очистка — в новом процессе по тому же state.
    rmSync(v.faultFile);
    const first = cleanupInNewProcess('S04-teardown-fail.cleanup-1', v, o.runId);
    rec.json('S04-teardown-fail/cleanup-1.json', first.json);
    const after = outcome('S04-teardown-fail.after-cleanup', v, null);
    rec.check(
      'S04-teardown-fail: новый процесс очистил среду, receipt cleaned, evidence сохранены',
      first.status === 0 &&
        first.json.data.status === 'cleaned' &&
        first.json.pid !== process.pid &&
        after.environments.every(
          (e) => e.harnessStatus === 'cleaned' && e.bridgeStatus === 'cleaned',
        ) &&
        empty(after.live) &&
        after.environments.every((e) => e.logs.length > 0) &&
        !after.cleanupPending,
      { first: first.json, after },
    );
    const second = cleanupInNewProcess('S04-teardown-fail.cleanup-2', v, o.runId);
    rec.check(
      'S04-teardown-fail: повторная очистка безопасна (nothing-pending)',
      second.json.data?.status === 'nothing-pending',
      second.json,
    );
    rec.check(
      'S04-teardown-fail: target по-прежнему не сдвинут',
      git(fixture.repo, ['rev-parse', v.targetRef]) === fixture.baselineSha,
      'target',
    );
    const trees = git(fixture.repo, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((l) => l.startsWith('worktree '));
    rec.check('S04-teardown-fail: рабочие деревья попытки убраны', trees.length === 1, trees);
  },
  async 'S04-interrupted'() {
    const v = prepare('S04-interrupted', { gate: 'block' });
    const child = harnessSpawn(rec, 'S04-interrupted.run', runArgs(v), { cwd: v.dir });
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    const started = await waitFor(
      'gate в активной среде',
      () =>
        walk(join(v.state, 'artifacts')).find((f) => f.endsWith('/environment/gate-started.json')),
      600000,
    );
    const envDir = dirname(started);
    const runId = started.slice(join(v.state, 'artifacts').length + 1).split('/')[0];
    runIds.add(runId);
    child.kill('SIGKILL');
    const exit = await exited;
    const receiptAfterKill = json(join(envDir, 'environment.json'));
    const liveAfterKill = ownedBy(runId);
    rec.json('S04-interrupted/after-kill.json', {
      exit,
      receipt: receiptAfterKill,
      live: liveAfterKill,
    });
    rec.check(
      'S04-interrupted: процесс убит при активной среде (receipt active, ресурсы живы)',
      exit.signal === 'SIGKILL' &&
        receiptAfterKill.status === 'active' &&
        liveAfterKill.containers.length > 0,
      { exit, status: receiptAfterKill.status, liveAfterKill },
    );
    // Gate завершается сам, увидев исчезновение владельца; срок владения истекает.
    // Срок владения (leaseMs 5000) после остановки heartbeat — конечное время, не барьер гонки.
    await new Promise((r) => setTimeout(r, 6000));
    const first = cleanupInNewProcess('S04-interrupted.cleanup-1', v, runId);
    rec.json('S04-interrupted/cleanup-1.json', first.json);
    const after = outcome('S04-interrupted.after-cleanup', v, null);
    rec.check(
      'S04-interrupted: новый процесс истёк попытку и очистил среду по receipt',
      first.status === 0 &&
        first.json.data.status === 'cleaned' &&
        first.json.pid !== child.pid &&
        ['expired', 'failed'].includes(first.json.attempt.status) &&
        empty(ownedBy(runId)) &&
        json(join(envDir, 'environment.json')).status === 'cleaned' &&
        json(join(envDir, 'bridge', 'receipt.json')).status === 'cleaned',
      { first: first.json, after },
    );
    const second = cleanupInNewProcess('S04-interrupted.cleanup-2', v, runId);
    rec.check(
      'S04-interrupted: повторная очистка безопасна',
      second.status === 0 && second.json.data?.status === 'nothing-pending',
      second.json,
    );
    rec.check(
      'S04-interrupted: не принято, target не сдвинут',
      after.outcome !== 'accepted' &&
        git(fixture.repo, ['rev-parse', v.targetRef]) === fixture.baselineSha,
      after,
    );
    const trees = git(fixture.repo, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((l) => l.startsWith('worktree '));
    rec.check(
      'S04-interrupted: рабочее дерево прерванной попытки убрано',
      trees.length === 1,
      trees,
    );
  },
};

async function main() {
  rec.json('docker.json', requireDocker());
  const before = dockerInventory();
  fixture = prepareStarterFixture({
    workDir: W,
    installPnpm: false,
    ...(values.source ? { source: values.source } : {}),
    log: rec.log,
  });
  rec.json('fixture.json', fixture.manifest);
  const failures = [];
  for (const [label, run] of Object.entries(variants)) {
    if (only && !only.has(label)) continue;
    rec.log('--- ' + label);
    try {
      await run();
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
      rec.log(`${label}: FAIL ${error.message}`);
    }
  }
  const after = dockerInventory();
  rec.json('docker-foreign.json', { before: foreign(before), after: foreign(after) });
  const preserved = foreignPreserved(foreign(before), foreign(after));
  rec.json('docker-foreign-preserved.json', preserved);
  rec.check('S04: чужие ресурсы сохранены, Docker context не изменён', preserved.ok, preserved);
  if (failures.length) throw new Error(failures.join('\n'));
}

let error;
try {
  await main();
} catch (e) {
  error = e;
} finally {
  // Уборка теста при отказе: только ресурсы своих попыток (метка run).
  for (const run of runIds) {
    const left = ownedBy(run);
    if (!empty(left)) {
      rec.log(`уборка теста: ресурсы попытки ${run}: ${JSON.stringify(left)}`);
      const c = docker(['ps', '-aq', '--filter', `label=devcontour.harness.run=${run}`])
        .split('\n')
        .filter(Boolean);
      if (c.length) docker(['rm', '-f', '-v', ...c]);
      const vol = docker(['volume', 'ls', '-q', '--filter', `label=devcontour.harness.run=${run}`])
        .split('\n')
        .filter(Boolean);
      if (vol.length) docker(['volume', 'rm', '-f', ...vol]);
      const n = docker(['network', 'ls', '-q', '--filter', `label=devcontour.harness.run=${run}`])
        .split('\n')
        .filter(Boolean);
      if (n.length) docker(['network', 'rm', ...n]);
    }
  }
}
finish(rec, 'S04', error, { work: W });
