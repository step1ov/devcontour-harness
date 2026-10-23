/**
 * Регрессии приёмки H, раунд 1 (замечания Codex): отказ уборки после исхода
 * probe, связь в повторе item runtime, неизвестный статус перед валидным
 * исходом того же runId, короткий секрет в потоке событий runtime, total с
 * отброшенными командами runtime, маскирование inspection ревью плана.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectReview,
  journalFromProjection,
  reviewInspection,
  type InspectionContext,
} from '../src/agents/inspect.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { ReviewProbes, readProbeJournal, type ProbeSpec } from '../src/agents/review-probe.ts';
import { reviewOutputSchema } from '../src/agents/schemas.ts';
import { reviewInspectionSchema, type RuntimeAdapter } from '../src/contracts/index.ts';
import { technicalReview } from '../src/control/review.ts';
import { checkCleanup } from '../src/verification/gates.ts';
import { approve, bin, setup } from './runner-fixture.ts';
import { engineOf, policyOf } from './engine-fixture.ts';

const SHA = 'b'.repeat(40);
const ctx: InspectionContext = { attempt: 'attempt-r', phase: 'candidate', sha: SHA, call: 1 };

const completion = (item: Record<string, unknown>) =>
  JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', aggregated_output: '', status: 'completed', ...item },
  });

test('IN08: отказ уборки после завершения probe сохраняет код 3, stdout и stderr; запуск засчитан как error/environment', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'harness-cleanup-')));
  const tree = join(root, 'tree');
  const controller = join(root, 'controller');
  mkdirSync(tree);
  mkdirSync(controller);
  const spec: ProbeSpec = {
    cwd: tree,
    controller: [controller],
    readable: [tree],
    isolation: { mode: 'none', domains: [] },
    commandTimeoutMs: 10000,
    budgetMs: 60000,
    deadline: Date.now() + 600000,
    env: ['PATH', 'HOME'],
    secrets: [],
    settingsDir: join(controller, 'settings'),
    log: join(controller, 'probes.jsonl'),
    scope: ctx,
  };
  const original = checkCleanup.remove;
  // Контролируемый отказ уборки каталога проверки после её исхода.
  checkCleanup.remove = async (dir) => {
    await original(dir);
    throw Object.assign(new Error(`EACCES: permission denied, rmdir '${dir}'`), {
      code: 'EACCES',
    });
  };
  try {
    const result = await new ReviewProbes(spec).run({
      argv: [
        process.execPath,
        '-e',
        "console.log('KNOWN-STDOUT'); console.error('KNOWN-STDERR'); process.exit(3)",
      ],
    });
    assert.equal(result.started, true);
    assert.equal(result.status, 'error');
    assert.equal(result.failure, 'environment');
    assert.equal(result.exitCode, 3);
    assert.match(result.stdout, /KNOWN-STDOUT/);
    assert.match(result.stderr, /KNOWN-STDERR/);
    assert.match(result.note ?? '', /EACCES/);
    const journal = await readProbeJournal(spec.log);
    assert.equal(journal.records[0]?.exitCode, 3);
    const inspection = reviewInspection({ journal, context: ctx });
    assert.equal(inspection.mode, 'commands');
    assert.equal(inspection.commands.length, 1);
    const [c] = inspection.commands;
    assert.equal(c?.exitCode, 3);
    assert.equal(c?.status, 'error');
    assert.equal(c?.failure, 'environment');
    assert.match(c?.output ?? '', /KNOWN-STDOUT[\s\S]*KNOWN-STDERR/);
  } finally {
    checkCleanup.remove = original;
    await rm(root, { recursive: true, force: true });
  }
});

test('IN10: повтор item runtime, добавивший явную связь с probe, и исход этого probe — одна операция с обоими происхождениями', () => {
  const runtime = {
    mode: 'commands' as const,
    source: 'codex-events' as const,
    reason: null,
    commands: [
      {
        command: 'run_check',
        exitCode: 0,
        output: '',
        origins: [{ type: 'runtime' as const, runtime: 'codex', item: 'item-linked' }],
      },
      {
        command: 'run_check',
        exitCode: 0,
        output: '',
        origins: [
          { type: 'runtime' as const, runtime: 'codex', item: 'item-linked' },
          { type: 'controller' as const, runId: 'probe-linked' },
        ],
      },
    ],
  };
  const journal = journalFromProjection([
    {
      runId: 'probe-linked',
      argv: ['node', '-e', '0'],
      status: 'passed',
      durationMs: 1,
      limitMs: 1000,
      started: true,
      exitCode: 0,
      scope: ctx,
    },
  ]);
  const inspection = reviewInspection({ runtime, journal, context: ctx });
  assert.equal(inspection.commands.length, 1);
  assert.equal(inspection.total, 1);
  assert.deepEqual(inspection.commands[0]?.origins, [
    { type: 'runtime', runtime: 'codex', item: 'item-linked' },
    { type: 'controller', runId: 'probe-linked' },
  ]);
  assert.equal(inspection.source, 'runtime-and-controller');
});

test('IN11: неизвестный статус перед валидным исходом того же runId не поглощает исход — в журнале и в проекции', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-journal-'));
  try {
    const line = (r: Record<string, unknown>) =>
      JSON.stringify({ runId: 'one-run', argv: ['node'], durationMs: 1, limitMs: 1000, ...r });
    const log = join(dir, 'probes.jsonl');
    const lines = [
      line({ status: 'exploded', started: true, scope: ctx }),
      line({ status: 'passed', started: true, exitCode: 0, stdout: 'VALID-RESULT', scope: ctx }),
      line({ status: 'failed', started: true, exitCode: 1, scope: ctx }),
    ];
    await writeFile(log, lines.join('\n') + '\n');
    const journal = await readProbeJournal(log);
    const inspection = reviewInspection({ journal, context: ctx });
    assert.equal(inspection.mode, 'commands');
    assert.equal(
      inspection.commands.length,
      1,
      'два валидных повтора одного runId — одна операция',
    );
    assert.equal(inspection.commands[0]?.exitCode, 0);
    assert.match(inspection.commands[0]?.output ?? '', /VALID-RESULT/);
    assert.deepEqual(
      inspection.excluded?.map((e) => e.reason),
      ['unknown-status'],
    );
    const projected = reviewInspection({
      journal: journalFromProjection(lines.map((l): unknown => JSON.parse(l))),
      context: ctx,
    });
    assert.equal(projected.commands.length, 1);
    assert.equal(projected.commands[0]?.status, 'passed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('IN13: больше 100 команд runtime и probe — total считает и отброшенные промежуточным пределом', () => {
  const events = Array.from({ length: 120 }, (_, i) =>
    completion({ id: `item_${i}`, command: `echo ${i}`, exit_code: 0 }),
  ).join('\n');
  const runtime = inspectReview('codex', events);
  assert.equal(runtime.commands.length, 100);
  assert.equal(runtime.total, 120);
  const journal = journalFromProjection([
    { runId: 'p1', argv: ['node'], status: 'passed', durationMs: 1, limitMs: 1, started: true },
  ]);
  const inspection = reviewInspection({ runtime, journal, context: ctx });
  assert.equal(inspection.total, 121);
  assert.equal(inspection.commands.length, 100);
  assert.deepEqual(inspection.commands.at(-1)?.origins, [{ type: 'controller', runId: 'p1' }]);
  assert.equal(inspection.commands[0]?.command, 'echo 21');
});

test('IN13: короткий секрет, совпавший со служебными строками событий Codex, не портит подтверждение через cliAdapter', async () => {
  for (const secret of ['', 'plet', 'time']) {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), 'harness-cli-secret-')));
    try {
      const scenario = join(dir, 'scenario.json');
      writeFileSync(
        scenario,
        JSON.stringify({
          reviewer: {
            ...approve('ok'),
            observedCommand: `printf hello${secret}`,
            observedOutput: `hello${secret}`,
          },
        }),
      );
      const response = await cliAdapter('codex', { executable: bin('fake-codex') }).invoke(
        {
          callId: 'in13-cli',
          task: 'review-plan',
          binding: { runtime: 'codex' },
          cwd: dir,
          prompt: 'Review.',
          outputSchema: reviewOutputSchema,
          session: { kind: 'fresh' },
          sandbox: {
            mode: 'none',
            writable: [],
            denied: [],
            readable: [dir],
            network: { domains: [] },
          },
          timeoutMs: 20000,
          env: { PATH: process.env.PATH!, HOME: process.env.HOME!, FIXTURE_SCENARIO: scenario },
          artifactDir: join(dir, 'artifacts'),
          secrets: secret ? [secret] : [],
        },
        new AbortController().signal,
      );
      const inspection = reviewInspectionSchema.parse(response.inspection);
      assert.equal(inspection.mode, 'commands', `secret=${secret}`);
      assert.equal(inspection.commands.length, 1);
      const [c] = inspection.commands;
      assert.equal(c?.status, 'completed');
      assert.equal(c?.origins?.[0]?.type, 'runtime');
      if (secret) {
        assert.equal(c?.command.includes(secret), false, 'секрет в команде замаскирован');
        assert.equal(c?.output.includes(secret), false, 'секрет в выводе замаскирован');
      }
      // Сохраняемый журнал вызова — замаскированный поток, без секрета.
      if (secret) {
        const logged = readFileSync(join(dir, 'artifacts', 'runtime.log'), 'utf8');
        assert.equal(logged.includes(`hello${secret}`), false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('IN19: ревью плана с коротким секретом, совпавшим с enum, сохраняет валидный inspection с маскированным текстом', async () => {
  for (const [index, secret] of ['time', 'plet'].entries()) {
    const ctx = setup({
      scenario: {
        reviewer: {
          ...approve('План полон'),
          observedCommand: `printf hello${secret}`,
          observedOutput: `hello ${secret}`,
        },
      },
      policy: (p) => {
        (p.environment as Record<string, unknown>).secrets = { SHORT: 'SHORT_SECRET' };
      },
    });
    const record = await technicalReview(
      ctx.engine,
      ctx.policy,
      {
        codex: cliAdapter('codex', {
          executable: bin('fake-codex'),
          toolProfiles: ctx.policy.toolProfiles,
        }),
      },
      {
        kind: 'plan',
        subject: 'g',
        digest: 'a'.repeat(64),
        author: 'claude',
        instructions: ['Review.'],
        cwd: ctx.repo.dir,
        artifactDir: join(ctx.state, 'reviews', `plan-${index}`),
        denied: [ctx.state],
        meta: { subjectId: 'g', subjectKind: 'other' },
        environment: { ...process.env, SHORT_SECRET: secret },
      },
    );
    const saved = JSON.parse(readFileSync(record.artifact, 'utf8')) as { inspection: unknown };
    const inspection = reviewInspectionSchema.parse(saved.inspection);
    assert.equal(inspection.mode, 'commands', `secret=${secret}`);
    assert.equal(inspection.source, 'codex-events');
    const [c] = inspection.commands;
    assert.deepEqual(c?.origins, [{ type: 'runtime', runtime: 'codex', item: null }]);
    assert.equal(c?.status, 'completed');
    assert.equal(c?.command.includes(secret), false);
    assert.equal(c?.output.includes(secret), false);
  }
});

/** Адаптер с готовым ответом: inspection задан тестом, CLI не запускается. */
const fixedAdapter = (inspection: unknown) =>
  ({
    runtime: 'codex',
    capabilities: () => Promise.resolve({ runtime: 'codex', available: true }),
    invoke: () =>
      Promise.resolve({
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'fixture',
        output: { approved: true, summary: 'ok', findings: [], previous: [] },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: 0,
          complete: true,
          source: 'fixture',
        },
        diagnostics: { exitCode: 0 },
        inspection,
      }),
  }) as unknown as RuntimeAdapter;

async function savedTechnical(kind: 'plan' | 'contract', inspection: unknown, secret: string) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'harness-technical-')));
  const policy = policyOf((p) => {
    p.environment = { secrets: { X: 'TECH_SECRET' } };
  });
  const { engine, store } = engineOf(policy, dir);
  try {
    await technicalReview(
      engine,
      policy,
      { codex: fixedAdapter(inspection) },
      {
        kind,
        subject: 'subject',
        digest: 'c'.repeat(64),
        author: 'claude',
        instructions: ['Review.'],
        cwd: dir,
        artifactDir: join(dir, 'artifacts'),
        denied: [],
        meta: { subjectId: 'subject', subjectKind: 'other' },
        environment: { ...process.env, TECH_SECRET: secret },
      },
    );
    return (
      JSON.parse(readFileSync(join(dir, 'artifacts', 'review.json'), 'utf8')) as {
        inspection: unknown;
      }
    ).inspection;
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('IN19: ревью плана и контракта маскирует свободный текст reason inspection', async () => {
  const secret = 'DIAGNOSTIC-SECRET-713';
  for (const kind of ['plan', 'contract'] as const) {
    const saved = reviewInspectionSchema.parse(
      await savedTechnical(
        kind,
        {
          mode: 'diff-only',
          source: 'unavailable',
          commands: [],
          reason: `No execution in ${secret}.`,
        },
        secret,
      ),
    );
    assert.equal(saved.reason?.includes(secret), false, kind);
    assert.match(saved.reason ?? '', /No execution in/);
  }
});

test('IN13: расширяющая маска в ревью плана и контракта не выводит command/output/note за пределы', async () => {
  const inspection = reviewInspectionSchema.parse({
    mode: 'commands',
    source: 'codex-events',
    commands: [
      {
        command: 'time'.repeat(3000),
        exitCode: 0,
        output: 'time'.repeat(1000),
        note: 'time'.repeat(500),
        origins: [{ type: 'runtime', runtime: 'codex', item: 'fixture-item' }],
        status: 'completed',
      },
    ],
    reason: null,
  });
  for (const kind of ['plan', 'contract'] as const) {
    const saved = reviewInspectionSchema.parse(await savedTechnical(kind, inspection, 'time'));
    const [c] = saved.commands;
    assert.ok(c!.command.length <= 12000 && c!.output.length <= 4000 && c!.note!.length <= 2000);
    assert.equal(c!.command.includes('time'), false);
    assert.equal(c!.output.includes('time'), false);
    assert.deepEqual(c!.origins, [{ type: 'runtime', runtime: 'codex', item: 'fixture-item' }]);
    assert.equal(c!.status, 'completed');
  }
});
