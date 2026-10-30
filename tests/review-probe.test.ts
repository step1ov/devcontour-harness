/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument --
 * Тесты читают сырые JSON-ответы MCP и сохранённые review.json как есть.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReviewProbes,
  observeReproductions,
  probeCommand,
  probeLimits,
  type ProbeSpec,
} from '../src/agents/review-probe.ts';
import { isolationSupport } from '../src/environment/isolation.ts';
import { redactor } from '../src/environment/redaction.ts';
import { approve, implement, runAll, setup, widening } from './runner-fixture.ts';

async function stage(overrides: Partial<ProbeSpec> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harness-probe-'));
  const spec: ProbeSpec = {
    cwd: root,
    controller: [],
    readable: [root],
    isolation: { mode: 'none', domains: [] },
    commandTimeoutMs: 1500,
    budgetMs: 60000,
    deadline: Date.now() + 600000,
    env: ['PATH', 'HOME', 'HARNESS_TEST_PROBE_SECRET'],
    secrets: ['HARNESS_TEST_PROBE_SECRET'],
    settingsDir: join(root, 'settings'),
    log: join(root, 'probes.jsonl'),
    ...overrides,
  };
  return { root, spec, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('Зависшая проверка reviewer останавливается вместе с отсоединёнными потомками и возвращается типизированным результатом', async () => {
  // Предел должен сработать, когда потомок уже запущен: сработавший раньше
  // (node стартует дольше предела) ничего не доказывает.
  const { s, hung, limitMs, pidFile, elapsedMs } = await widening(
    1500,
    async (limitMs) => {
      const s = await stage({ commandTimeoutMs: limitMs });
      const probes = new ReviewProbes(s.spec);
      const pidFile = join(s.root, 'child.pid');
      const started = Date.now();
      // Команда печатает, оставляет потомка в собственной группе процессов и зависает.
      const detach = `const c=require('child_process').spawn('sleep',['60'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();console.log('started');setInterval(()=>{},1000)`;
      const hung = await probes.run({
        argv: [process.execPath, '-e', detach],
        // Просьба модели не расширяет предел controller.
        timeoutMs: 3600000,
      });
      return { s, hung, limitMs, pidFile, elapsedMs: Date.now() - started };
    },
    ({ hung, s }) => {
      const started = /started/.test(hung.stdout);
      if (!started) void s.cleanup();
      return started;
    },
  );
  try {
    assert.equal(hung.status, 'timeout');
    assert.equal(hung.limitMs, limitMs);
    assert.equal(hung.exitCode, null);
    assert.ok(elapsedMs < limitMs + 60000, 'остановлено за конечное время');
    assert.match(hung.stdout, /started/, 'частичный вывод сохранён');
    assert.match(hung.note ?? '', /не доказанный дефект/);
    const child = Number((await readFile(pidFile, 'utf8')).trim());
    for (let i = 0; i < 300 && alive(child); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(child), false, 'потомок не пережил проверку');

    // Остальные проверки завершаются сами: предел здесь не предмет теста.
    const probes = new ReviewProbes({ ...s.spec, commandTimeoutMs: 60000 });
    process.env.HARNESS_TEST_PROBE_SECRET = 'probe-secret-7731';
    const ok = await probes.run({
      argv: [process.execPath, '-e', 'console.log(process.env.HARNESS_TEST_PROBE_SECRET)'],
    });
    assert.equal(ok.status, 'passed');
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.stdout.includes('probe-secret-7731'), false);
    const failed = await probes.run({ argv: [process.execPath, '-e', 'process.exit(3)'] });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.exitCode, 3);
    const missing = await probes.run({ argv: ['harness-no-such-command'] });
    assert.notEqual(missing.status, 'passed');

    // Журнал controller — по записи на каждую команду, без значения секрета;
    // до каждой команды — строка её резерва (R3-F01).
    const log = await readFile(s.spec.log, 'utf8');
    const lines = log
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type?: string });
    assert.equal(lines.filter((l) => !l.type).length, 4);
    assert.equal(lines.filter((l) => l.type === 'start').length, 4);
    assert.equal(log.includes('probe-secret-7731'), false);
  } finally {
    delete process.env.HARNESS_TEST_PROBE_SECRET;
    await s.cleanup();
  }
});

test('Проверки reviewer делят общий бюджет и оставляют резерв на заключение', async () => {
  const s = await stage({ commandTimeoutMs: 1500, budgetMs: 4000 });
  try {
    const probes = new ReviewProbes(s.spec);
    const marker = join(s.root, 'ran');
    const hang = ['sh', '-c', `touch ${marker}; sleep 30`];
    let left = s.spec.budgetMs;
    let last;
    for (let i = 0; i < 6; i++) {
      await rm(marker, { force: true });
      last = await probes.run({ argv: hang });
      if (last.status === 'budget-exhausted') break;
      assert.equal(last.status, 'timeout');
      assert.ok(last.limitMs <= Math.min(1500, left), `предел ${last.limitMs} ≤ остатка ${left}`);
      left = last.budgetLeftMs;
    }
    assert.equal(last?.status, 'budget-exhausted');
    assert.equal(last.durationMs, 0);
    assert.ok(last.budgetLeftMs < 1000);
    assert.equal(existsSync(marker), false, 'после исчерпания бюджета команда не запускалась');

    // Время до заключения кончилось раньше бюджета — команда тоже не идёт.
    const late = new ReviewProbes({ ...s.spec, deadline: Date.now() + 500 });
    const refused = await late.run({ argv: hang });
    assert.equal(refused.status, 'budget-exhausted');
    assert.equal(existsSync(marker), false);
  } finally {
    await s.cleanup();
  }
});

test('Пределы проверок выводятся из срока фазы: резерв на заключение не меньше пятой части', () => {
  const policy = {
    runTimeoutMs: 100_000,
    reviewProbes: { commandTimeoutMs: 120_000, budgetMs: 600_000, reserveMs: 10_000 },
  };
  assert.deepEqual(probeLimits(policy), {
    commandTimeoutMs: 100_000,
    budgetMs: 80_000,
    reserveMs: 20_000,
  });
});

test('Проверки reviewer не пишут проверяемые исходники под изоляцией ОС', async (t) => {
  const support = isolationSupport();
  if (!support.ok) {
    t.skip('песочница ОС недоступна: ' + support.detail);
    return;
  }
  const s = await stage({ isolation: { mode: 'os', domains: [] }, commandTimeoutMs: 30000 });
  try {
    const probes = new ReviewProbes(s.spec);
    await writeFile(join(s.root, 'source.txt'), 'original');
    const read = await probes.run({ argv: ['cat', join(s.root, 'source.txt')] });
    assert.equal(read.status, 'passed', read.stderr);
    assert.match(read.stdout, /original/);
    const write = await probes.run({
      argv: ['sh', '-c', `echo changed > ${join(s.root, 'source.txt')}`],
    });
    assert.equal(write.status, 'failed');
    assert.equal(await readFile(join(s.root, 'source.txt'), 'utf8'), 'original');
    const scratch = await probes.run({ argv: ['sh', '-c', 'echo x > "$TMPDIR/cache"'] });
    assert.equal(scratch.status, 'passed', scratch.stderr);
  } finally {
    await s.cleanup();
  }
});

/**
 * Минимальный клиент MCP по stdio: запрос — ответ с тем же id. У каждого
 * запроса свой срок, а завершение сервера отклоняет ожидающие.
 */
function client(command: string, args: string[], timeoutMs = 60000) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let buffer = '';
  let stderr = '';
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  const settle = (id: number) => {
    const entry = waiting.get(id);
    if (entry) clearTimeout(entry.timer);
    waiting.delete(id);
    return entry;
  };
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number };
      if (message.id !== undefined) settle(message.id)?.resolve(message);
    }
  });
  child.on('exit', (code, signal) => {
    for (const id of [...waiting.keys()])
      settle(id)?.reject(
        new Error(`MCP-сервер завершился (${code ?? signal}) до ответа: ${stderr.trim()}`),
      );
  });
  let next = 1;
  return {
    request(method: string, params: unknown) {
      const id = next++;
      return new Promise<Record<string, any>>((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(id);
          reject(new Error(`MCP ${method}: нет ответа за ${timeoutMs} мс; ${stderr.trim()}`));
        }, timeoutMs);
        waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method: string) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
    close() {
      child.kill();
    },
  };
}
const handshake = async (c: ReturnType<typeof client>) => {
  await c.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  c.notify('notifications/initialized');
};

test('CLI reviewer достигает инструмента проверок той командой, которую даёт harness', async () => {
  const s = await stage();
  try {
    const specPath = join(s.root, 'probe.json');
    await writeFile(specPath, JSON.stringify(s.spec));
    const { command, args } = probeCommand(specPath);
    const c = client(command, args);
    try {
      await handshake(c);
      const tools = await c.request('tools/list', {});
      assert.deepEqual(
        tools.result.tools.map((x: { name: string }) => x.name),
        ['run_check'],
      );
      assert.equal(tools.result.tools[0].inputSchema.type, 'object');
      const call = await c.request('tools/call', {
        name: 'run_check',
        arguments: { argv: ['sh', '-c', 'echo probe-ok; sleep 30'] },
      });
      assert.equal(call.result.structuredContent.status, 'timeout');
      assert.match(call.result.structuredContent.stdout, /probe-ok/);
      const wrong = await c.request('tools/call', { name: 'run_check', arguments: { argv: [] } });
      assert.ok(wrong.error, 'неверные аргументы — ошибка протокола, а не запуск');
      const unknown = await c.request('resources/list', {});
      assert.equal(unknown.error?.code, -32601);
    } finally {
      c.close();
    }
  } finally {
    await s.cleanup();
  }
});

test('Аргументы проверки reviewer маскируются в результате и журнале controller', async () => {
  const s = await stage({ deadline: Date.now() });
  process.env.HARNESS_TEST_PROBE_SECRET = 'argv-secret-5521';
  try {
    const r = await new ReviewProbes(s.spec).run({
      argv: ['curl', '-H', 'Authorization: argv-secret-5521', 'http://127.0.0.1'],
    });
    assert.equal(r.status, 'budget-exhausted');
    assert.equal(JSON.stringify(r).includes('argv-secret-5521'), false);
    assert.equal((await readFile(s.spec.log, 'utf8')).includes('argv-secret-5521'), false);
  } finally {
    delete process.env.HARNESS_TEST_PROBE_SECRET;
    await s.cleanup();
  }
});

test('Одновременные проверки reviewer не превышают общий бюджет — напрямую и через MCP', async () => {
  const s = await stage({ commandTimeoutMs: 1800, budgetMs: 2000 });
  try {
    const marker = (i: number) => join(s.root, `ran-${i}`);
    const hang = (i: number) => ['sh', '-c', `touch ${marker(i)}; sleep 30`];
    const probes = new ReviewProbes(s.spec);
    const shared = await Promise.all([3, 4, 5].map((i) => probes.run({ argv: hang(i) })));
    const ran = shared.filter((r) => r.status !== 'budget-exhausted');
    assert.equal(ran.length, 1, JSON.stringify(shared.map((r) => [r.status, r.limitMs])));
    assert.equal([3, 4, 5].filter((i) => existsSync(marker(i))).length, 1, 'запущена одна');

    const specPath = join(s.root, 'probe.json');
    await writeFile(specPath, JSON.stringify(s.spec));
    const { command, args } = probeCommand(specPath);
    const c = client(command, args);
    try {
      await handshake(c);
      const calls = await Promise.all(
        [6, 7, 8].map((i) =>
          c.request('tools/call', { name: 'run_check', arguments: { argv: hang(i) } }),
        ),
      );
      const statuses = calls.map((x) => x.result.structuredContent.status as string);
      assert.equal(statuses.filter((x) => x !== 'budget-exhausted').length, 1, statuses.join());
      assert.equal([6, 7, 8].filter((i) => existsSync(marker(i))).length, 1);
    } finally {
      c.close();
    }
  } finally {
    await s.cleanup();
  }
});

test('Тестовый stdio-клиент отклоняет ожидающие запросы, когда сервер умирает', async () => {
  const c = client(process.execPath, ['-e', 'setTimeout(() => process.exit(3), 100)'], 5000);
  await assert.rejects(c.request('initialize', {}), /завершился \(3\)/);
});

test('Наблюдено — только по единственному состоявшемуся запуску из журнала; команды, различающиеся секретом, не путаются', () => {
  const redact = redactor(['k3']);
  const probes = [
    {
      runId: 'run-a',
      argv: ['t', '--key=[REDACTED]'],
      status: 'failed' as const,
      durationMs: 5,
      limitMs: 9,
    },
    {
      runId: 'run-b',
      argv: ['t', '--key=[REDACTED]'],
      status: 'passed' as const,
      durationMs: 5,
      limitMs: 9,
    },
    { runId: 'run-c', argv: ['t'], status: 'budget-exhausted' as const, durationMs: 0, limitMs: 0 },
  ];
  const finding = (run: string | null, command: string[] | null = ['claimed']) => ({
    severity: 'blocking' as const,
    message: 'm',
    reproduction: {
      property: null,
      input: 'x',
      expected: null,
      actual: null,
      command,
      executed: true,
      run,
    },
  });
  const [cited, hypothesis, exhausted, unknown] = observeReproductions(
    [finding('run-b'), finding(null), finding('run-c'), finding('run-z')],
    probes,
    redact,
  ) as any[];
  assert.equal(cited.reproduction.observed, true);
  assert.equal(cited.reproduction.run, 'run-b', 'именно тот запуск, а не первый с той же командой');
  assert.deepEqual(cited.reproduction.command, ['t', '--key=[REDACTED]'], 'команда — из журнала');
  for (const f of [hypothesis, exhausted, unknown]) {
    assert.equal(f.reproduction.observed, false);
    assert.equal(f.reproduction.run, null);
    assert.deepEqual(f.reproduction.command, ['claimed'], 'гипотеза не становится наблюдением');
  }
  // Ответ reviewer пришёл замаскированным: короткий секрет задел id запуска.
  const masked = observeReproductions(
    [finding('run-[REDACTED]')],
    [{ runId: 'run-k3', argv: ['x'], status: 'timeout' as const, durationMs: 1, limitMs: 1 }],
    redact,
  ) as any[];
  assert.equal(masked[0].reproduction.observed, true);
  assert.equal(masked[0].reproduction.run, 'run-k3');
});

/** Тот же шаг reviewer, называющий открытую находку прошлой фазы (`$open:0` — ID из запроса). */
const notedAgain = <T extends { result: Record<string, unknown> }>(step: T): T => ({
  ...step,
  result: {
    ...step.result,
    previous: [{ id: '$open:0', status: 'open', basis: 'Заметка остаётся, не блокирует' }],
  },
});

/** Политика сценария с пределами проверок, укладывающимися в срок теста. */
const probePolicy = (p: any) => {
  p.runTimeoutMs = 60_000;
  p.reviewProbes = { commandTimeoutMs: 10_000, budgetMs: 30_000, reserveMs: 5_000 };
};
const probing = (secret: string) => ({
  ...approve(),
  recordPrompt: true,
  probes: [
    [process.execPath, '-e', 'process.exit(0)'],
    [process.execPath, '-e', `console.log(${JSON.stringify(secret)}); process.exit(4)`],
  ],
  result: {
    ...approve().result,
    findings: [
      {
        severity: 'note',
        message: 'Воспроизведено запуском',
        path: null,
        line: null,
        rule: null,
        consequence: null,
        evidence: null,
        reproduction: {
          property: null,
          input: 'greet("")',
          expected: null,
          actual: null,
          command: ['claimed', secret],
          executed: true,
          run: '$probe:1',
        },
      },
    ],
  },
});

for (const reviewer of ['codex', 'claude'] as const)
  test(`T08/T30: ревью ${reviewer} получает инструмент проверок с пределами; запуски записаны по журналу controller и замаскированы`, async () => {
    const secret = 'probe-run-secret-4410';
    process.env.HARNESS_PROBE_RUN_SECRET = secret;
    try {
      const writer = reviewer === 'codex' ? 'claude' : 'codex';
      const ctx = setup({
        writer,
        reviewer,
        scenario: {
          writer: { ...implement(), recordPrompt: true },
          // Integration называет открытую заметку кандидата явным переходом
          // (протокол находок, docs/review-protocol.md); прочее — как у кандидата.
          reviewer: [probing(secret), notedAgain(probing(secret))],
        },
        policy: (p: any) => {
          probePolicy(p);
          p.environment.secrets = { RUN_TOKEN: 'HARNESS_PROBE_RUN_SECRET' };
          if (reviewer === 'claude') {
            // Claude запускает команды, только если профиль дал ему Bash.
            p.toolProfiles = { rev: { runtime: 'claude', claudeTools: ['Read', 'Bash'] } };
            p.review.code.reviewer.toolProfile = 'rev';
          }
        },
      });
      await runAll(ctx);
      const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
      assert.equal(a.status, 'succeeded', a.error);
      const reviews = a.evidence.filter((e) => e.kind === 'review');
      assert.equal(reviews.length, 2);
      for (const [i, e] of reviews.entries()) {
        const server = JSON.parse(
          readFileSync(`${ctx.scenarioPath}.reviewer.${i}.probe-server`, 'utf8'),
        );
        assert.ok(server?.command, 'CLI reviewer получил сервер проверок');
        const runs = JSON.parse(readFileSync(`${ctx.scenarioPath}.reviewer.${i}.probes`, 'utf8'));
        assert.deepEqual(
          runs.map((r: { status: string }) => r.status),
          ['passed', 'failed'],
        );
        const prompt = readFileSync(`${ctx.scenarioPath}.reviewer.${i}.prompt`, 'utf8');
        assert.match(prompt, /run_check tool/);
        assert.match(prompt, /stops each command after 10 s and all checks share 30 s/);
        const argv = JSON.parse(prompt.split('\n---ARGS---\n')[1]!) as string[];
        if (reviewer === 'codex') {
          const servers = argv.find((x) => x.startsWith('mcp_servers='))!;
          assert.match(
            servers,
            /"tool_timeout_sec" = 40/,
            'codex не обрывает вызов раньше controller',
          );
          assert.match(servers, /"enabled_tools" = \["run_check"\]/);
        } else {
          const allowed = argv[argv.indexOf('--allowedTools') + 1]!.split(',');
          assert.ok(allowed.includes('mcp__devcontour_probe__run_check'));
          const env = JSON.parse(argv[argv.indexOf('--settings') + 1]!).env;
          assert.equal(env.MCP_TOOL_TIMEOUT, '40000');
          assert.equal(env.BASH_MAX_TIMEOUT_MS, '10000', 'свой Bash reviewer под тем же пределом');
        }
        const text = readFileSync(e.log, 'utf8');
        const saved = JSON.parse(text);
        assert.deepEqual(
          saved.probes.map((p: { status: string }) => p.status),
          ['passed', 'failed'],
          'запуски — по журналу controller',
        );
        const rep = saved.findings[0].reproduction;
        assert.equal(rep.observed, true);
        assert.equal(rep.run, runs[1].runId);
        assert.equal(rep.command[0], process.execPath, 'команда — та, что запускалась');
        assert.ok(!text.includes(secret), 'секрет не сохранён в review.json');
        assert.ok(
          !readFileSync(join(e.log, '..', 'probes.jsonl'), 'utf8').includes(secret),
          'и в журнале проверок',
        );
        const spec = readFileSync(join(e.log, '..', 'probe.json'), 'utf8');
        assert.ok(spec.includes('"RUN_TOKEN"') && !spec.includes(secret), 'значения не на диске');
      }
      // Реестр поручения: воспроизведение наблюдено по журналу controller, с
      // командой, которая действительно запускалась, без секрета.
      const registered = ctx.engine.reproductions('add-greeting');
      assert.ok(registered.length >= 1);
      assert.equal(registered[0]!.observed, true);
      assert.equal(registered[0]!.command![0], process.execPath);
      assert.ok(!JSON.stringify(registered).includes(secret));
      // Writer инструмента проверок не получает.
      const writerPrompt = readFileSync(`${ctx.scenarioPath}.writer.0.prompt`, 'utf8');
      assert.doesNotMatch(writerPrompt, /devcontour_probe|run_check/);
    } finally {
      delete process.env.HARNESS_PROBE_RUN_SECRET;
    }
  });

test('Reviewer только для чтения инструмента проверок не получает: его права probe не расширяет', async () => {
  const ctx = setup({
    writer: 'codex',
    reviewer: 'claude',
    scenario: {
      writer: implement(),
      reviewer: { ...approve(), recordPrompt: true, probes: [['true']] },
    },
    policy: probePolicy,
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  const prompt = readFileSync(`${ctx.scenarioPath}.reviewer.0.prompt`, 'utf8');
  assert.doesNotMatch(prompt, /run_check/);
  assert.equal(
    JSON.parse(readFileSync(`${ctx.scenarioPath}.reviewer.0.probe-server`, 'utf8')),
    null,
  );
  const saved = JSON.parse(readFileSync(a.evidence.find((e) => e.kind === 'review')!.log, 'utf8'));
  assert.equal(saved.probes, undefined);
});

test('Профиль codex без shell — reviewer без инструмента проверок', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: { ...approve(), recordPrompt: true } },
    policy: (p: any) => {
      probePolicy(p);
      p.toolProfiles = { rev: { runtime: 'codex', codexShell: false } };
      p.review.code.reviewer.toolProfile = 'rev';
    },
  });
  await runAll(ctx);
  const prompt = readFileSync(`${ctx.scenarioPath}.reviewer.0.prompt`, 'utf8');
  assert.doesNotMatch(prompt, /devcontour_probe|run_check/);
  const argv = JSON.parse(prompt.split('\n---ARGS---\n')[1]!) as string[];
  assert.ok(argv.includes('mcp_servers={}'));
});

test('T29: без механизма песочницы проверка reviewer не запускается без изоляции — отказ среды', async () => {
  const { isolationBackend } = await import('../src/verification/gates.ts');
  const s = await stage({ isolation: { mode: 'os', domains: [] }, commandTimeoutMs: 5000 });
  const original = isolationBackend.check;
  isolationBackend.check = () => ({ ok: false, detail: 'нет sandbox (тест)' });
  try {
    const marker = join(s.root, 'ran');
    const r = await new ReviewProbes(s.spec).run({ argv: ['sh', '-c', `touch ${marker}`] });
    assert.equal(r.status, 'error');
    assert.match(r.note ?? '', /отказ среды.*Изоляция проверок недоступна/s);
    assert.equal(existsSync(marker), false, 'команда не запускалась');
  } finally {
    isolationBackend.check = original;
    await s.cleanup();
  }
});
