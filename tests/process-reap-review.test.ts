import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskFailure, type EvidenceRecord, type GatePolicy } from '../src/contracts/index.ts';
import { classifyFailure, failureOrigin, withSuffix } from '../src/engine/classify.ts';
import { hostLoad } from '../src/environment/host-load.ts';
import { CleanupFailure } from '../src/environment/lifecycle.ts';
import { ReapFailure, command, processInventory } from '../src/environment/process.ts';
import { redactor } from '../src/environment/redaction.ts';
import {
  GateTimeout,
  ReapedGate,
  checkCleanup,
  prepareWriterDependencies,
  reapedFailure,
  runGate,
} from '../src/verification/gates.ts';
import { runGatesAt, type GatesAtContext } from '../src/verification/gates-at.ts';
import { repo } from './git-fixture.ts';
import { approve, greet, implement, runAll, setup } from './runner-fixture.ts';

// Ревью F53: неостановленные потомки не теряются за другими отказами, не
// дают пустого перечня за «живых нет», и дерево, где они, возможно, ещё
// пишут, больше не используется.

const inventory = { ...processInventory };
const read = hostLoad.read;
const down = () => Promise.reject(new Error('ps не ответил за 10 с'));
/** На время `fn` подменяет части перечня процессов. */
async function withInventory<T>(fake: Partial<typeof processInventory>, fn: () => Promise<T>) {
  Object.assign(processInventory, fake);
  hostLoad.read = () => ({ load1: 587, cpus: 8 });
  try {
    return await fn();
  } finally {
    Object.assign(processInventory, inventory);
    hostLoad.read = read;
  }
}
const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );
const quick = [process.execPath, '-e', ''];

async function gate(
  g: Partial<GatePolicy> & { command: string[] },
  options: { property?: true } = {},
) {
  const r = repo({ 'src/a.js': 'a\n' });
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  const artifactDir = mkdtempSync(join(tmpdir(), 'harness-art-'));
  try {
    const error = await caught(
      runGate({
        policy: { isolation: { mode: 'none', domains: [] } },
        record: (e) => {
          recorded.push(e);
          return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
        },
        cwd: r.dir,
        sha: r.head(),
        phase: 'integration',
        gate: { id: 'unit', kind: 'check', timeoutMs: 20000, ...g } as GatePolicy,
        artifactDir,
        signal: new AbortController().signal,
        execution: { env: process.env, redact: redactor([]) },
        boundary: { hidden: [], readable: [] },
        ...(options.property ? { property: { runId: 'run-1', contracts: {}, artifacts: [] } } : {}),
      }),
    );
    assert.equal(recorded.length, 1);
    return { error, evidence: recorded[0]! };
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
}

test('#1: неостановленные потомки и неубранный scratch — первичен отказ остановки; уборка дописана; повтора на дереве нет', async () => {
  const remove = checkCleanup.remove;
  checkCleanup.remove = async (dir) => {
    await remove(dir);
    if (dir.includes('dc-gate-')) throw new Error(`ENOTEMPTY: directory not empty, rmdir '${dir}'`);
  };
  try {
    const { error, evidence } = await withInventory({ marked: down }, () =>
      gate({ command: quick }),
    );
    assert.equal(evidence.passed, false);
    assert.ok(error instanceof ReapedGate, String(error));
    assert.equal(error.kind, 'environment');
    assert.equal(error.diagnosis, 'process-reap');
    assert.match(
      error.message,
      /^integration\/unit: Не удалось завершить процессы команды «unit».*; временные каталоги проверки не убраны: ENOTEMPTY/s,
    );
  } finally {
    checkCleanup.remove = remove;
  }
});

test('#3: неполученная таблица процессов (ps -axo) или отказ lsof — не «живых нет», а отказ перечня', async () => {
  // Отказывает настоящий запуск утилиты: `ps -axo` таблицы или `lsof`
  // каталогов; остальные вызовы — как есть.
  const failing = (match: (file: string, args: string[]) => boolean, reason: string) => ({
    tool: ((file: string, args: string[], timeout: number, partial?: number) =>
      match(file, args)
        ? Promise.resolve({ error: reason })
        : inventory.tool(file, args, timeout, partial)) as typeof processInventory.tool,
  });
  for (const fake of [
    failing((_f, args) => args.includes('pid=,ppid=,lstart='), 'ps не ответил за 10 с'),
    failing((file) => file.endsWith('lsof'), 'lsof не ответил за 15 с'),
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'harness-reap-dir-'));
    try {
      const error = await withInventory(fake, () =>
        caught(command(quick, process.cwd(), { contain: { dirs: [dir] }, timeoutMs: 30000 })),
      );
      assert.ok(error instanceof ReapFailure, String(error));
      assert.match(error.inventory ?? '', /не ответил/);
      assert.equal(error.result?.code, 0, 'исход команды сохранён');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Разовый отказ таблицы повторяется, как и отказ метки.
  let calls = 0;
  const result = await withInventory(
    failing(
      (_f, args) => args.includes('pid=,ppid=,lstart=') && calls++ === 0,
      'ps не ответил за 10 с',
    ),
    () => command(quick, process.cwd(), { contain: true, timeoutMs: 30000 }),
  );
  assert.equal(result.code, 0);
});

test('#5: провал, названный командой, при неостановленных потомках — gate (засчитан), отказ остановки дописан, повтора нет', async () => {
  const { error, evidence } = await withInventory({ marked: down }, () =>
    gate({ command: [process.execPath, '-e', 'console.error("boom"); process.exit(1)'] }),
  );
  assert.equal(evidence.passed, false);
  assert.equal(evidence.exitCode, 1, 'исход команды не потерян');
  assert.ok(error instanceof ReapedGate, String(error));
  assert.equal(error.kind, 'gate');
  assert.match(
    error.message,
    /^integration\/unit: Код выхода 1: .*boom.*; Не удалось завершить процессы команды/s,
  );
  // Контрпример свойства при коде 0 — тоже провал о коде.
  const report = { version: 1, properties: [{ testId: 'p', status: 'failed', cases: 2 }] };
  const prop = await withInventory({ marked: down }, () =>
    gate(
      {
        id: 'prop',
        property: {},
        command: [
          process.execPath,
          '-e',
          `require('fs').writeFileSync(process.env.DEVCONTOUR_PROPERTY_REPORT, ${JSON.stringify(JSON.stringify(report))})`,
        ],
      },
      { property: true },
    ),
  );
  assert.ok(prop.error instanceof ReapedGate, String(prop.error));
  assert.equal(prop.error.kind, 'gate');
  assert.deepEqual(prop.error.properties?.unbound, ['p']);
  // Таймаут без названного провала — о коде не говорит: среда, не GateTimeout.
  const slow = await withInventory({ marked: down }, () =>
    gate({ timeoutMs: 300, command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'] }),
  );
  assert.ok(slow.error instanceof ReapedGate, String(slow.error));
  assert.equal(slow.error instanceof GateTimeout, false);
  assert.equal(slow.error.kind, 'environment');
  assert.equal(slow.error.diagnosis, 'process-reap');
});

test('#2: неостановленные потомки установки до исполнителя — отказ попытки (ReapFailure), а не заметка', async () => {
  const r = repo({ 'package.json': '{}\n' });
  const error = await withInventory({ marked: down }, () =>
    caught(
      prepareWriterDependencies({
        policy: { isolation: { mode: 'none', domains: [] } },
        cwd: r.dir,
        base: r.head(),
        trusted: true,
        gates: [{ id: 'install', kind: 'check', timeoutMs: 20000, command: quick }],
        artifactDir: mkdtempSync(join(tmpdir(), 'harness-art-')),
        signal: new AbortController().signal,
        execution: { env: process.env, redact: redactor([]) },
        boundary: { hidden: [], readable: [] },
      }),
    ),
  );
  assert.ok(error instanceof ReapFailure, String(error));
  assert.equal(classifyFailure(error, error.message), 'environment');
});

test('#4: failureOrigin раскрывает вложенные CleanupFailure до исходного отказа', () => {
  const question = new TaskFailure('needs-input', 'вопрос');
  const nested = new CleanupFailure(
    'внешняя очистка',
    new CleanupFailure('внутренняя очистка', question),
  );
  assert.equal(failureOrigin(nested), question);
  assert.equal(classifyFailure(nested, nested.message), 'needs-input');
});

test('#6: gatesAt после неостановленных потомков gate не исполняет следующие gates в том же дереве', async () => {
  const ctx = setup({
    scenario: {},
    policy: (p) => {
      const repository = (p.repositories as { gates: unknown[] }[])[0]!;
      repository.gates.push({
        id: 'other',
        kind: 'check',
        command: [process.execPath, '-e', 'void 0'],
        dependsOn: [],
      });
    },
  });
  const context: GatesAtContext = {
    policy: ctx.policy,
    stateDir: ctx.state,
    repoPath: () => ctx.repo.dir,
    boundary: () => ({ hidden: [ctx.state], readable: [join(ctx.repo.dir, '.git')] }),
    resourceDatabase: join(ctx.state, 'resources.sqlite'),
  };
  const recorded: EvidenceRecord[] = [];
  const result = await withInventory({ marked: down }, () =>
    runGatesAt(context, {
      id: 'GA-reap',
      repositoryId: 'app',
      sha: ctx.repo.head(),
      gates: ['unit', 'other'],
      record: (e) => recorded.push(e),
    }),
  );
  assert.deepEqual(
    recorded.map((e) => e.gate),
    ['unit'],
    'после отказа остановки gates в этом дереве не исполняются',
  );
  assert.deepEqual(
    result.failures.map((f) => f.gate),
    ['unit', 'other'],
  );
  assert.match(result.failures[1]!.message, /не исполнен: потомки проверки unit не остановлены/);
});

/** Прогон, в котором перечень процессов отказывает, пока есть метка `flag`. */
async function runWithFlag(
  flag: string,
  options: Parameters<typeof setup>[0],
): Promise<ReturnType<typeof setup>> {
  const ctx = setup(options);
  let refused = 0;
  await withInventory(
    {
      marked: (mark) => {
        if (!existsSync(flag)) return inventory.marked(mark);
        if (++refused >= 3) rmSync(flag);
        return down();
      },
    },
    () => runAll(ctx),
  );
  return ctx;
}

test('#8: неостановленные потомки gate попытки без изменений — отказ среды, а не empty-result', async () => {
  const flags = mkdtempSync(join(tmpdir(), 'harness-reap-'));
  const flag = join(flags, 'reap');
  try {
    // Исполнитель ничего не меняет; база уже проходит gate — но его потомки
    // не пересчитаны.
    const gateJs = `require('fs').writeFileSync(${JSON.stringify(flag)}, '1'); require('./run.js');`;
    const ctx = await runWithFlag(flag, {
      scenario: { writer: implement({}), reviewer: approve() },
      files: { 'test/gate.js': gateJs, 'src/greet.js': greet },
      policy: (p) => {
        const raw = p as { repositories: { gates: { command: string[] }[] }[] };
        raw.repositories[0]!.gates[0]!.command = [process.execPath, 'test/gate.js'];
      },
    });
    const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.equal(a.status, 'failed');
    assert.equal(a.failureKind, 'environment', a.error);
  } finally {
    rmSync(flags, { recursive: true, force: true });
  }
});

test('#9: неостановленные потомки вызова исполнителя — отказ среды без снимка черновика', async () => {
  const flags = mkdtempSync(join(tmpdir(), 'harness-reap-'));
  const flag = join(flags, 'reap');
  try {
    writeFileSync(flag, '1');
    // Метка стоит до первого сдерживаемого вызова — вызова исполнителя.
    const ctx = await runWithFlag(flag, {
      scenario: { writer: implement(), reviewer: approve() },
    });
    const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.equal(a.status, 'failed');
    assert.equal(a.failureKind, 'environment', a.error);
    assert.match(a.error ?? '', /Не удалось завершить процессы команды «claude/);
    assert.equal(
      a.partial,
      undefined,
      'черновик из дерева с возможными писателями не продолжается',
    );
    // N3: изменения сохранены только файлом, путь назван в тексте отказа.
    const saved = /сохранены только файлом (\S+partial\.patch)/.exec(a.error ?? '')?.[1];
    assert.ok(saved, a.error);
    assert.match(readFileSync(saved, 'utf8'), /src\/greet\.js/);
  } finally {
    rmSync(flags, { recursive: true, force: true });
  }
});

/** Gate интеграции первой попытки падает (`fail` — тело провала) и отмечает отказ перечня. */
async function integrationReap(fail: string) {
  const flags = mkdtempSync(join(tmpdir(), 'harness-reap-'));
  const flag = join(flags, 'reap');
  const once = join(flags, 'once');
  try {
    const gateJs = `
const fs = require('fs');
if (process.env.DEVCONTOUR_PHASE === 'integration' && !fs.existsSync(${JSON.stringify(once)})) {
  fs.writeFileSync(${JSON.stringify(once)}, '1');
  fs.writeFileSync(${JSON.stringify(flag)}, '1');
  ${fail}
  process.exit(1);
}
require('./run.js');
`;
    const ctx = await runWithFlag(flag, {
      scenario: { writer: implement(), reviewer: approve() },
      files: { 'test/gate.js': gateJs },
      policy: (p) => {
        const raw = p as { repositories: { gates: { command: string[] }[] }[] };
        raw.repositories[0]!.gates[0]!.command = [process.execPath, 'test/gate.js'];
      },
    });
    const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
    const diagnosed = ctx.store
      .events()
      .flatMap((e) => (e.type === 'attempt.diagnosed' && e.runId === a.id ? [e.payload] : []));
    return { a, diagnosed };
  } finally {
    rmSync(flags, { recursive: true, force: true });
  }
}

test('N2: провал gate интеграции, названный только кодом выхода, при неостановленных потомках после прошедшего кандидата — среда, не засчитан, без повтора', async () => {
  const { a, diagnosed } = await integrationReap('');
  assert.equal(a.status, 'failed');
  assert.equal(a.failureKind, 'environment', a.error);
  assert.deepEqual(diagnosed, [
    { failureKind: 'environment', cause: 'process-reap', counted: false },
  ]);
  const integration = a.evidence.filter((e) => e.phase === 'integration' && e.kind === 'test');
  assert.equal(integration.length, 1, 'повтора на том же дереве нет');
  assert.ok(!a.evidence.some((e) => e.recheck));
});

test('N2: упавший тест интеграции при неостановленных потомках — gate (засчитан), без повтора и без интеграции', async () => {
  const report =
    '<testsuite><testcase classname="greet" name="greets"><failure message="broken"/></testcase></testsuite>';
  const { a, diagnosed } = await integrationReap(
    `fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, ${JSON.stringify(report)});`,
  );
  assert.equal(a.status, 'failed');
  assert.equal(a.failureKind, 'gate', a.error);
  assert.deepEqual(diagnosed, [{ failureKind: 'gate', cause: 'none', counted: true }]);
  const integration = a.evidence.filter((e) => e.phase === 'integration' && e.kind === 'test');
  assert.equal(integration.length, 1, 'повтора на том же дереве нет');
});

test('N5: withSuffix сохраняет ReapedGate и ReapFailure; отказ обработчика вывода не заслоняет неостановленных потомков', async () => {
  const gateFailure = new ReapedGate('gate', 'integration/unit: Код выхода 1');
  const suffixed = withSuffix(gateFailure, 'деревья сохранены');
  assert.ok(suffixed instanceof ReapedGate);
  assert.equal(reapedFailure(suffixed), true);
  assert.match(suffixed.message, /; деревья сохранены$/);
  const error = await withInventory({ marked: down }, () =>
    caught(
      command([process.execPath, '-e', 'console.log("x")'], process.cwd(), {
        contain: true,
        timeoutMs: 30000,
        onOutput: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      }),
    ),
  );
  assert.ok(error instanceof ReapFailure, String(error));
  assert.ok(withSuffix(error, 'x') instanceof ReapFailure);
});

const skippedReport =
  '<testsuite><testcase classname="greet" name="greets"><skipped/></testcase></testsuite>';
async function namedIntegrationFailure(fail: string) {
  const { a, diagnosed } = await integrationReap(fail);
  assert.equal(a.status, 'failed');
  assert.equal(a.failureKind, 'gate', a.error);
  assert.deepEqual(diagnosed, [{ failureKind: 'gate', cause: 'none', counted: true }]);
  const integration = a.evidence.filter((e) => e.phase === 'integration' && e.kind === 'test');
  assert.equal(integration.length, 1, 'повтора на том же дереве нет');
}

test('R3-1: пропущенный тест интеграции при неостановленных потомках — gate, засчитан', () =>
  namedIntegrationFailure(
    `fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, ${JSON.stringify(skippedReport)}); process.exit(0);`,
  ));

test('R3-1: gate интеграции изменил отслеживаемый файл при неостановленных потомках — gate, засчитан', () =>
  namedIntegrationFailure(
    `require('./run.js'); fs.writeFileSync('README.md', 'changed by gate\\n'); process.exit(0);`,
  ));

/** Исполнитель пишет черновик и молчит; перечень процессов недоступен. */
function sleepyWriter(extra: Partial<Parameters<typeof setup>[0]> = {}) {
  const draft = "exports.greet = (name) => 'Hello, ' + name; // черновик\n";
  return setup({
    scenario: {
      writer: { ...implement(), draftFiles: { 'src/greet.js': draft }, sleepMs: 30000 },
      reviewer: approve(),
    },
    ...extra,
  });
}
const savedPatch = (error: string | undefined) => {
  const path = /сохранены только файлом (\S+partial\.patch)/.exec(error ?? '')?.[1];
  assert.ok(path, error);
  assert.match(readFileSync(path, 'utf8'), /src\/greet\.js/);
};

test('R3-2: штатная остановка вызова исполнителя с неостановленными потомками — черновик не записан, изменения только файлом', async () => {
  const ctx = sleepyWriter();
  await withInventory({ marked: down }, async () => {
    await ctx.runner.init();
    const { trustNone, planReview } = await import('./engine-fixture.ts');
    const { graph } = ctx.engine.register(ctx.graph, trustNone);
    ctx.engine.recordReview(planReview(ctx.engine, graph, 1));
    ctx.engine.approve(graph.id, 'agent');
    ctx.engine.resume();
    await ctx.runner.tick();
    const tree = () => ctx.engine.read((v) => v.attempts()[0]?.worktree);
    for (let i = 0; i < 400 && !(tree() && existsSync(join(tree()!, 'src/greet.js'))); i++)
      await new Promise((r) => setTimeout(r, 25));
    await ctx.runner.stop();
  });
  const first = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(first.interrupted, 'shutdown');
  assert.equal(first.partial, undefined, 'черновик из дерева с возможными писателями не записан');
  savedPatch(first.error);
});

test('R3-2: зависание вызова исполнителя с неостановленными потомками — черновик не записан, изменения только файлом', async () => {
  const ctx = sleepyWriter({
    policy: (p) => {
      p.stallSweep = {
        intervalMs: 1000,
        quietMs: 1000,
        stalledMs: 3000,
        action: 'stop',
      };
      p.maxAttempts = 1;
    },
  });
  await withInventory({ marked: down }, () => runAll(ctx));
  const first = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(first.failureKind, 'stalled', first.error);
  assert.equal(first.partial, undefined, 'черновик из дерева с возможными писателями не записан');
  savedPatch(first.error);
});
