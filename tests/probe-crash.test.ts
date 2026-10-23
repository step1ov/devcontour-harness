/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return --
 * Тест читает журналы проверок, спецификации probe и JSON CLI как есть.
 */
/**
 * R3-F01 (HP06): бюджет проверок reviewer не возобновляется после гибели
 * controller посреди выполняющейся проверки. Резерв записывается в журнал до
 * запуска; новый controller засчитывает незавершённый запуск целиком и
 * останавливает его пережившие процессы.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ReviewProbes,
  probeCommand,
  probeLedger,
  probeRecords,
  recoverProbeLog,
  type ProbeSpec,
} from '../src/agents/review-probe.ts';
import { bin, implement } from './runner-fixture.ts';
import { fixtureCalls, verdict } from './review-fixture.ts';
import { saveEvidence } from './probe-fixture.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check: () => boolean, ms = 20000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return check();
};
/** Зависающая проверка: отсоединённый node-потомок и сама команда; PID — в файл. */
const hang = (pids: string) => [
  process.execPath,
  '-e',
  `const cp=require('child_process'),fs=require('fs');const k=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});k.unref();fs.appendFileSync(${JSON.stringify(pids)},process.pid+' '+k.pid+'\\n');setInterval(()=>{},1000)`,
];
const pidsOf = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)
    : [];

function stage(budgetMs: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-probe-crash-')));
  const spec: ProbeSpec = {
    cwd: root,
    controller: [],
    readable: [root],
    isolation: { mode: 'none', domains: [] },
    commandTimeoutMs: 5000,
    budgetMs,
    deadline: Date.now() + 600000,
    env: ['PATH', 'HOME'],
    secrets: [],
    settingsDir: join(root, 'settings'),
    log: join(root, 'review', 'probes.jsonl'),
  };
  const specPath = join(root, 'probe.json');
  writeFileSync(specPath, JSON.stringify(spec));
  return { root, spec, specPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Сервер проверок отдельным процессом, как его запускает CLI reviewer. */
function server(specPath: string) {
  const { command, args } = probeCommand(specPath);
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let next = 1;
  const replies = new Map<number, (m: any) => void>();
  let buffer = '';
  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString();
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.trim()) {
        const m = JSON.parse(line);
        replies.get(m.id)?.(m);
      }
    }
  });
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      const id = next++;
      replies.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { child, request };
}

test('HP06/R3-F01: control — завершённая проверка списывает фактическое время, а не резерв', async () => {
  const s = stage(6000);
  try {
    const srv = server(s.specPath);
    await srv.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const reply = await srv.request('tools/call', {
      name: 'run_check',
      arguments: { argv: [process.execPath, '-e', 'setTimeout(()=>{},1200)'] },
    });
    srv.child.kill('SIGKILL');
    await once(srv.child, 'close');
    const r = reply.result.structuredContent;
    assert.equal(r.status, 'passed');
    const ledger = await recoverProbeLog(s.spec.log);
    assert.equal(ledger.unfinished.length, 0);
    assert.equal(ledger.spentMs, r.durationMs);
    assert.ok(ledger.spentMs >= 1200 && ledger.spentMs < 5000, String(ledger.spentMs));
    // Строки резерва не попадают в запуски review.json.
    const records = await probeRecords(s.spec.log);
    assert.deepEqual(
      records.map((x) => x.runId),
      [r.runId],
    );
    const lines = readFileSync(s.spec.log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'start', 'резерв записан до исхода');
    assert.equal(lines[0].reservedMs, 5000);
    saveEvidence('HP06/round4', 'control.json', { result: r, ledger, lines });
  } finally {
    s.cleanup();
  }
});

test('HP06/R3-F01: SIGKILL сервера проверок посреди команды — новый controller засчитывает весь резерв, процессы остановлены, бюджет не возобновляется (в том числе параллельные вызовы)', async () => {
  for (const parallel of [false, true]) {
    const s = stage(parallel ? 12000 : 6000);
    const pids = join(s.root, 'pids');
    try {
      const srv = server(s.specPath);
      await srv.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
      const calls = parallel ? 2 : 1;
      for (let i = 0; i < calls; i++)
        void srv.request('tools/call', { name: 'run_check', arguments: { argv: hang(pids) } });
      assert.ok(await waitFor(() => pidsOf(pids).length === 2 * calls), 'команды запущены');
      await new Promise((r) => setTimeout(r, 1200));
      const startedAt = Date.now();
      srv.child.kill('SIGKILL');
      await once(srv.child, 'close');
      const processes = pidsOf(pids);
      assert.ok(processes.every(alive), 'без recovery процессы проверки пережили сервер');
      // Новый controller: тот же журнал (тот же scope/phase/SHA).
      const before = await probeLedger(s.spec.log);
      assert.equal(before.unfinished.length, calls);
      const recovered = await recoverProbeLog(s.spec.log);
      assert.equal(recovered.spentMs, 5000 * calls, 'засчитан весь резерв каждого запуска');
      for (const pid of processes) {
        assert.ok(await waitFor(() => !alive(pid), 5000), `процесс ${pid} остановлен`);
      }
      const again = await recoverProbeLog(s.spec.log);
      assert.equal(again.spentMs, recovered.spentMs, 'повторное восстановление не меняет расход');
      assert.equal(again.unfinished.length, 0);
      const resumed = new ReviewProbes({
        ...s.spec,
        budgetMs: s.spec.budgetMs - recovered.spentMs,
      });
      const left = resumed.limit();
      assert.ok(left <= s.spec.budgetMs - 5000 * calls, `остаток ${left}`);
      const next = await resumed.run({ argv: [process.execPath, '-e', '0'] });
      if (left < 1000) assert.equal(next.status, 'budget-exhausted');
      assert.ok(Date.now() - startedAt < 15000);
      saveEvidence('HP06/round4', `crash-${parallel ? 'parallel' : 'single'}.json`, {
        budgetMs: s.spec.budgetMs,
        reservedPerRunMs: 5000,
        spentAfterRecoveryMs: recovered.spentMs,
        remainingLimitMs: left,
        nextProbe: next.status,
        killed: recovered.killed,
        processes,
        journal: readFileSync(s.spec.log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l)),
      });
    } finally {
      for (const pid of pidsOf(pids))
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* остановлен */
        }
      s.cleanup();
    }
  }
});

test('HP06/R3-F01: журнал резерва не записан — проверка не запускается', async () => {
  const s = stage(6000);
  try {
    const marker = join(s.root, 'ran');
    // Каталог журнала — файл: открыть журнал нельзя.
    writeFileSync(join(s.root, 'review'), 'not a dir');
    const r = await new ReviewProbes(s.spec).run({
      argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`],
    });
    assert.equal(r.status, 'error');
    assert.equal(r.failure, 'environment');
    assert.match(r.note ?? '', /резерв проверки не записан/);
    assert.equal(existsSync(marker), false);
  } finally {
    s.cleanup();
  }
});

// ---- Полный рестарт controller через CLI (отдельные процессы) ----

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const example = fileURLToPath(new URL('../examples/single-task', import.meta.url));

function project(scenario: unknown, policyPatch: (p: any) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-probe-restart-')));
  const app = join(root, 'greeting');
  cpSync(example, app, { recursive: true });
  const scenarioPath = join(root, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const policy = JSON.parse(readFileSync(join(app, 'policy.json'), 'utf8'));
  policy.isolation = { mode: 'none', domains: [] };
  policy.environment = { values: { FIXTURE_SCENARIO: scenarioPath } };
  policy.leaseMs = 5000;
  policy.maxAttempts = 3;
  policyPatch(policy);
  writeFileSync(join(app, 'policy.json'), JSON.stringify(policy, null, 2));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: app,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
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
  const run = () =>
    spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        cli,
        'run',
        '--graph',
        'graph.json',
        '--policy',
        'policy.json',
        '--state',
        state,
        '--author',
        'claude',
      ],
      {
        cwd: app,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          HARNESS_CLAUDE_BIN: bin('fake-claude'),
          HARNESS_CODEX_BIN: bin('fake-codex'),
        },
      },
    );
  const ref = () => {
    try {
      return git('rev-parse', 'refs/heads/harness/accepted');
    } catch {
      return null;
    }
  };
  return { root, scenarioPath, state, run, ref };
}

/** Файлы ревью кандидата во всех попытках: probe.json и probes.jsonl по вызовам. */
function reviewFiles(state: string) {
  const found: { call: number; spec?: any; log?: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (
        name === 'probe.json' &&
        /\/candidate\/review(\/call-\d+)?\/probe\.json$/.test(path)
      ) {
        const call = Number(/call-(\d+)/.exec(path)?.[1] ?? 1);
        found.push({
          call,
          spec: JSON.parse(readFileSync(path, 'utf8')),
          log: join(dir, 'probes.jsonl'),
        });
      }
    }
  };
  walk(state);
  return found.sort((a, b) => a.call - b.call);
}

const restartCases = [
  { name: 'control: проверка завершилась, затем авария', budgetMs: 25000, crashDuringProbe: false },
  {
    name: 'авария посреди проверки: остаток ≤ бюджет − резерв',
    budgetMs: 25000,
    crashDuringProbe: true,
  },
  {
    name: 'авария посреди проверки: остаток < 1 с — проверок больше нет',
    budgetMs: 10500,
    crashDuringProbe: true,
  },
];

for (const c of restartCases)
  test(`HP06/R3-F01: рестарт controller на том же scope/phase/SHA — ${c.name}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-probe-pids-')));
    const pids = join(root, 'pids');
    const p = project(
      {
        writer: implement(),
        reviewer: [
          verdict(true), // ревью плана
          c.crashDuringProbe
            ? { ...verdict(true), probes: [hang(pids)], crashDuringProbe: 2500 }
            : {
                ...verdict(true),
                probes: [[process.execPath, '-e', 'setTimeout(()=>{},1500)']],
                crashHarness: true,
              },
          { ...verdict(true), recordPrompt: true }, // вызов 2 кандидата после рестарта
          verdict(true), // integration
          verdict(true),
        ],
      },
      (policy) => {
        policy.reviewProbes = { commandTimeoutMs: 10000, budgetMs: c.budgetMs, reserveMs: 2000 };
      },
    );
    try {
      const initial = p.ref();
      const crashed = p.run();
      assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
      const survivors = pidsOf(pids);
      if (c.crashDuringProbe) {
        assert.equal(survivors.length, 2);
        assert.ok(survivors.every(alive), 'процессы проверки пережили controller до recovery');
      }
      await new Promise((r) => setTimeout(r, 6500)); // аренда истекает
      const again = p.run();
      const files = reviewFiles(p.state);
      const first = files.find((f) => f.call === 1)!;
      const second = files.find((f) => f.call === 2);
      const journal = readFileSync(first.log!, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const ledger = await probeLedger(first.log!);
      const reviewerCalls = fixtureCalls(p.scenarioPath, 'codex', 'reviewer') - 1;
      // Лимит вызовов reviewer: вызов 1 (убит) + вызов 2 + integration.
      assert.ok(reviewerCalls <= 3, String(reviewerCalls));
      assert.equal(again.status, 0, again.stderr + again.stdout);
      assert.notEqual(p.ref(), initial);
      const budget = first.spec.budgetMs as number;
      if (!c.crashDuringProbe) {
        const done = journal.find((l) => !l.type);
        assert.equal(ledger.spentMs, done.durationMs);
        assert.ok(second, 'проверки после рестарта доступны');
        assert.equal(second.spec.budgetMs, budget - ledger.spentMs);
        assert.ok(second.spec.budgetMs > budget - 10000, 'control: списан факт, а не резерв');
      } else {
        assert.ok(journal.some((l) => l.type === 'start' && l.reservedMs === 10000));
        assert.ok(journal.some((l) => l.type === 'abandoned' && l.chargedMs === 10000));
        assert.equal(ledger.spentMs, 10000, 'незавершённый запуск засчитан всем резервом');
        for (const pid of survivors)
          assert.ok(await waitFor(() => !alive(pid), 5000), `процесс ${pid} остановлен recovery`);
        const prompt = readFileSync(`${p.scenarioPath}.reviewer.2.prompt`, 'utf8');
        if (budget - 10000 < 1000) {
          assert.equal(second, undefined, 'остаток < 1 с: инструмента проверок нет');
          assert.doesNotMatch(prompt, /run_check/);
        } else {
          assert.ok(second);
          assert.ok(second.spec.budgetMs <= budget - 10000, String(second.spec.budgetMs));
          assert.match(prompt, /all checks share 15 s/);
        }
      }
      // Срок логического ревью не продлён рестартом.
      if (second) assert.ok(second.spec.deadline <= first.spec.deadline + 1000);
      saveEvidence(
        'HP06/round4',
        `restart-${c.crashDuringProbe ? `crash-${c.budgetMs}` : 'control'}.json`,
        {
          case: c,
          crashedSignal: crashed.signal,
          exit: again.status,
          reviewerCalls,
          call1: { budgetMs: budget, deadline: first.spec.deadline },
          call2: second ? { budgetMs: second.spec.budgetMs, deadline: second.spec.deadline } : null,
          spentMs: ledger.spentMs,
          journal,
          survivors,
          survivorsAlive: survivors.filter(alive),
        },
      );
    } finally {
      for (const pid of pidsOf(pids))
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* остановлен */
        }
      rmSync(p.root, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
