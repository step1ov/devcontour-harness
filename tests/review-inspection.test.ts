/**
 * Приёмка H (IN01–IN14): итог `inspection` вызова reviewer собирается из
 * наблюдений runtime и журнала проверок controller этого вызова, а не из
 * самоотчёта модели. Договор и матрица — задание alpha.6 follow-up,
 * разделы «Договор поведения H» и «Матрица приёмки H».
 *
 * IN05–IN08 запускают настоящие процессы через ReviewProbes (isolation: none,
 * кроме контролируемой имитации отказа песочницы); старт отличается от его
 * отсутствия по файлу-маркеру, который создала бы целевая команда.
 * IN02/IN03 читают только обезличенные fixtures `tests/fixtures/inspection`
 * (происхождение и преобразования — в manifest.json).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  inspectReview,
  inspectionLimits,
  journalFromProjection,
  reviewInspection,
  type InspectionContext,
} from '../src/agents/inspect.ts';
import {
  ReviewProbes,
  probeLedger,
  readProbeJournal,
  recoverProbeLog,
  reserveProbe,
  type ProbeGate,
  type ProbeJournal,
  type ProbeJournalRecord,
  type ProbeSpec,
} from '../src/agents/review-probe.ts';
import {
  STATE_VERSION,
  digestOf,
  evidenceRecordSchema,
  executionDocumentSchema,
  reviewInspectionSchema,
  type AttemptState,
  type EvidenceRecord,
  type ExecutionDocument,
} from '../src/contracts/index.ts';
import { redactor } from '../src/environment/redaction.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { isolationBackend } from '../src/verification/gates.ts';

type Inspection = NonNullable<EvidenceRecord['inspection']>;

const SHA = 'a'.repeat(40);
const ctx: InspectionContext = { attempt: 'attempt-h', phase: 'candidate', sha: SHA, call: 1 };
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fixture = (name: string) => new URL(`./fixtures/inspection/${name}`, import.meta.url);

/** Событие Codex о завершённой команде. */
const codexEvent = (item: {
  id?: string;
  command: string;
  exit_code: number;
  aggregated_output?: string;
  status?: 'completed' | 'failed';
}) =>
  JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      aggregated_output: '',
      status: item.exit_code === 0 ? 'completed' : 'failed',
      ...item,
    },
  });

/** Строка исхода журнала probe в форме, в какой её пишет ReviewProbes. */
const resultLine = (r: Partial<ProbeJournalRecord> & { runId: string }) =>
  JSON.stringify({
    at: '2026-10-23T00:00:00.000Z',
    argv: ['node', '-e', '0'],
    status: 'passed',
    durationMs: 10,
    limitMs: 1500,
    ...r,
  });

/** Каталог проверяемого дерева и отдельный каталог controller (журнал, evidence gate). */
async function stage(overrides: Partial<ProbeSpec> = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'harness-inspection-')));
  const tree = join(root, 'tree');
  const controller = join(root, 'controller');
  mkdirSync(tree);
  mkdirSync(controller);
  const spec: ProbeSpec = {
    cwd: tree,
    controller: [controller],
    readable: [tree],
    isolation: { mode: 'none', domains: [] },
    commandTimeoutMs: 1500,
    budgetMs: 60000,
    deadline: Date.now() + 600000,
    env: ['PATH', 'HOME'],
    secrets: [],
    settingsDir: join(controller, 'settings'),
    log: join(controller, 'probes.jsonl'),
    phase: ctx.phase,
    sha: ctx.sha,
    scope: ctx,
    ...overrides,
  };
  const unlock = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir)) chmodSync(join(dir, d), 0o755);
  };
  return {
    root,
    tree,
    controller,
    spec,
    probes: new ReviewProbes(spec),
    /** Итог этого вызова: события runtime и журнал controller. */
    inspect: async (runtime = '', context = ctx) =>
      reviewInspection({
        runtime: inspectReview('codex', runtime),
        journal: await readProbeJournal(spec.log),
        context,
      }),
    cleanup: async () => {
      unlock(join(controller, 'probe-runs'));
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** argv, который создаёт маркер: его наличие — признак исполнения целевого кода. */
const touch = (marker: string, then = '') => [
  process.execPath,
  '-e',
  `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');${then}`,
];

const controllerOrigins = (i: Inspection) =>
  i.commands.flatMap((c) =>
    (c.origins ?? []).flatMap((o) => (o.type === 'controller' ? [o.runId] : [])),
  );

/* ------------------------------------------------------------------ */
/* IN01 — событие Codex о завершённой команде                          */
/* ------------------------------------------------------------------ */

test('IN01: завершённая команда Codex с кодом 0 — одна команда, mode commands, reason null', () => {
  const i = inspectReview(
    'codex',
    codexEvent({ id: 'item_0', command: 'node --test', exit_code: 0, aggregated_output: 'ok 1' }),
  );
  assert.equal(i.mode, 'commands');
  assert.equal(i.reason, null);
  assert.equal(i.commands.length, 1);
  assert.equal(i.commands[0]!.exitCode, 0);
  assert.equal(i.commands[0]!.command, 'node --test');
  assert.deepEqual(i.commands[0]!.origins, [{ type: 'runtime', runtime: 'codex', item: 'item_0' }]);
  reviewInspectionSchema.parse(i);
});

test('IN01: завершённая команда Codex с кодом 1 и AssertionError — выполнение, код и текст ошибки сохранены', () => {
  const output = 'AssertionError: expected 400, received 413';
  const i = inspectReview(
    'codex',
    [
      JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution' } }),
      codexEvent({
        id: 'item_1',
        command: 'node --test',
        exit_code: 1,
        aggregated_output: output,
        status: 'failed',
      }),
    ].join('\n'),
  );
  assert.equal(i.mode, 'commands', 'ненулевой код — исход проверки, а не отсутствие выполнения');
  assert.equal(i.reason, null);
  assert.equal(i.commands.length, 1);
  assert.equal(i.commands[0]!.exitCode, 1);
  assert.equal(i.commands[0]!.status, 'failed');
  assert.equal(i.commands[0]!.output, output);
  // Тот же итог после агрегатора вызова (пустой журнал controller).
  const total = reviewInspection({ runtime: i, journal: emptyJournal(), context: ctx });
  assert.equal(total.mode, 'commands');
  assert.equal(total.source, 'codex-events');
  assert.equal(total.commands[0]!.exitCode, 1);
  assert.equal(total.commands[0]!.output, output);
  assert.equal(total.reason, null);
});

/* ------------------------------------------------------------------ */
/* IN02/IN03 — исторические проекции L2                                */
/* ------------------------------------------------------------------ */

interface ManifestEntry {
  id: string;
  file: string;
  sha256: string;
  count: number;
  context: InspectionContext;
}
const manifest = JSON.parse(readFileSync(fixture('manifest.json'), 'utf8')) as {
  fixtures: ManifestEntry[];
  transformations: string[];
};
const historical = (id: string) => {
  const entry = manifest.fixtures.find((f) => f.id === id)!;
  const bytes = readFileSync(fixture(entry.file));
  assert.equal(sha256(bytes), entry.sha256, `fixture ${entry.file} совпадает с manifest`);
  const probes = JSON.parse(bytes.toString('utf8')) as { runId: string; gate?: { id: string } }[];
  const inspection = reviewInspection({
    runtime: inspectReview('codex', ''),
    journal: journalFromProjection(probes),
    context: entry.context,
  });
  reviewInspectionSchema.parse(inspection);
  return { entry, probes, inspection };
};

test('IN02: UI L2 — 8 исторических probes при пустых событиях runtime дают 8 разных операций с gates browser/domain/api', () => {
  const { entry, probes, inspection } = historical('IN02');
  assert.equal(probes.length, 8);
  assert.equal(inspection.mode, 'commands');
  assert.equal(inspection.reason, null);
  assert.equal(inspection.source, 'controller-probes');
  assert.equal(inspection.commands.length, 8);
  assert.equal(inspection.total, 8);
  const runIds = controllerOrigins(inspection);
  assert.equal(new Set(runIds).size, 8, '8 разных операций');
  assert.deepEqual(
    runIds,
    probes.map((p) => p.runId),
  );
  const gates = new Set(inspection.commands.flatMap((c) => (c.gate ? [c.gate] : [])));
  for (const id of ['browser', 'domain', 'api']) assert.ok(gates.has(id), `gate ${id}`);
  assert.deepEqual(inspection.context, entry.context);
  assert.equal(inspection.context?.phase, 'candidate');
  assert.equal(inspection.context?.sha, '67bc83c1d6047e9d27ea1207b48f92ef95a15dcb');
  for (const c of inspection.commands) {
    assert.equal(c.exitCode, null, 'код не сохранён в проекции — не выводится из passed');
    assert.equal(c.output, '', 'вывод не сохранён в проекции — не выдумывается');
    assert.equal(c.status, 'passed');
  }
  assert.equal(inspection.excluded, undefined);
});

test('IN03: Domain L2 — проекция 7 probes integration: 7 операций, gate domain, фаза и SHA, коды и вывод не выдуманы', () => {
  const { entry, probes, inspection } = historical('IN03');
  assert.equal(probes.length, 7);
  assert.equal(inspection.mode, 'commands');
  assert.equal(inspection.commands.length, 7);
  assert.equal(inspection.total, 7);
  assert.deepEqual(
    controllerOrigins(inspection),
    probes.map((p) => p.runId),
  );
  assert.equal(new Set(controllerOrigins(inspection)).size, 7);
  assert.ok(inspection.commands.some((c) => c.gate === 'domain'));
  assert.deepEqual(
    [...new Set(inspection.commands.flatMap((c) => (c.gate ? [c.gate] : [])))],
    ['domain'],
  );
  assert.deepEqual(inspection.context, entry.context);
  assert.equal(inspection.context?.phase, 'integration');
  assert.equal(inspection.context?.sha, '0b85200e55c9ffcd1b67df189d65e6b0856cb99d');
  for (const c of inspection.commands) {
    assert.equal(c.exitCode, null);
    assert.equal(c.output, '');
  }
  // Та же проекция с чужой фазой: записи gate с phase/sha integration не присваиваются.
  const foreign = reviewInspection({
    journal: journalFromProjection(probes),
    context: { ...entry.context, phase: 'candidate' },
  });
  assert.equal(foreign.commands.length, 6, 'gate domain integration — чужая фаза');
  assert.deepEqual(
    foreign.excluded?.map((e) => e.reason),
    ['foreign-scope'],
  );
});

/* ------------------------------------------------------------------ */
/* IN04 — нет подтверждения; самоотчёт модели                          */
/* ------------------------------------------------------------------ */

function emptyJournal(): ProbeJournal {
  return { records: [], invalid: 0, reservations: [] };
}

test('IN04: пустой runtime и пустой журнал — diff-only, commands [], непустая причина', async () => {
  const s = await stage();
  try {
    const i = await s.inspect('');
    assert.equal(i.mode, 'diff-only');
    assert.deepEqual(i.commands, []);
    assert.equal(typeof i.reason, 'string');
    assert.ok(i.reason!.trim().length > 0);
    assert.doesNotMatch(i.reason!, /успешн/i, 'причина — нет выполнения, а не нет успешных');
    assert.equal(i.total, 0);
    reviewInspectionSchema.parse(i);
  } finally {
    await s.cleanup();
  }
});

test('IN04: самоотчёт модели execution.commands / reproduction.executed не превращается в наблюдение', async () => {
  const s = await stage();
  try {
    // Ответ reviewer: модель утверждает, что запускала команды и воспроизвела находку,
    // и ссылается на runId, которого нет в журнале controller.
    const answer = {
      approved: false,
      summary: 'Ran the suite',
      execution: { commands: [{ command: 'npm test', exitCode: 0, output: 'all green' }] },
      findings: [
        {
          severity: 'major',
          message: 'overlap',
          reproduction: { executed: true, run: '00000000-0000-4000-8000-000000000000' },
        },
      ],
    };
    // Так ответ приходит в потоке Codex: сообщение агента, а не command_execution.
    const stream = [
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'msg_1', type: 'agent_message', text: JSON.stringify(answer) },
      }),
      JSON.stringify(answer),
    ].join('\n');
    // Журнал вызова существует, но без единого исхода (только резерв, без запуска).
    reserveProbe(s.spec.log, 'reserved-only', 1500, ['npm', 'test']);
    const i = await s.inspect(stream);
    assert.equal(i.mode, 'diff-only');
    assert.deepEqual(i.commands, []);
    assert.ok(i.reason);
    assert.equal(JSON.stringify(i).includes('all green'), false);
    assert.equal(JSON.stringify(i).includes('npm test'), false);
    assert.deepEqual(i.excluded, [{ runId: 'reserved-only', status: null, reason: 'unfinished' }]);
    // Сохранённая проекция с формой самоотчёта (без runId/argv) — не запуски.
    const projected = journalFromProjection(answer.execution.commands);
    assert.equal(projected.records.length, 0);
    assert.equal(projected.invalid, 1);
    const fromProjection = reviewInspection({ journal: projected, context: ctx });
    assert.equal(fromProjection.mode, 'diff-only');
    assert.deepEqual(fromProjection.commands, []);
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* IN05 — настоящий argv probe                                         */
/* ------------------------------------------------------------------ */

test('IN05: настоящие argv probes (0 и 3 с узнаваемым stderr) попадают в inspection через журнал', async () => {
  const s = await stage({ commandTimeoutMs: 15000 });
  try {
    const ok = await s.probes.run({ argv: [process.execPath, '-e', "console.log('ok')"] });
    const bad = await s.probes.run({
      argv: [process.execPath, '-e', "console.error('recognizable-stderr-XYZ'); process.exit(3)"],
    });
    assert.equal(ok.started, true);
    assert.equal(bad.started, true);
    assert.deepEqual(ok.scope, ctx);
    const i = await s.inspect();
    assert.equal(i.mode, 'commands');
    assert.equal(i.source, 'controller-probes');
    assert.deepEqual(controllerOrigins(i), [ok.runId, bad.runId]);
    const [a, b] = i.commands;
    assert.equal(a!.exitCode, 0);
    assert.equal(a!.status, 'passed');
    assert.match(a!.output, /ok/);
    assert.equal(b!.exitCode, 3);
    assert.equal(b!.status, 'failed');
    assert.match(b!.output, /recognizable-stderr-XYZ/);
    assert.match(b!.command, /process\.exit\(3\)/);
    reviewInspectionSchema.parse(i);
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* IN06 — timeout и cancel после старта                                */
/* ------------------------------------------------------------------ */

const waitFor = async (path: string, ms = 15000) => {
  const until = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > until) throw new Error(`маркер ${path} не появился за ${ms} мс`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('IN06: timeout после подтверждённого старта — команда учтена, код null, частичный вывод, не PASS', async () => {
  const s = await stage({ commandTimeoutMs: 1500 });
  try {
    const marker = join(s.root, 'ready-timeout');
    const r = await s.probes.run({
      argv: touch(
        marker,
        "require('fs').writeSync(1, 'READY-TIMEOUT\\n'); setInterval(() => {}, 1000)",
      ),
    });
    assert.ok(existsSync(marker), 'команда действительно стартовала');
    assert.equal(r.status, 'timeout');
    assert.equal(r.started, true);
    const i = await s.inspect();
    assert.equal(i.mode, 'commands');
    assert.equal(i.commands.length, 1);
    const c = i.commands[0]!;
    assert.equal(c.status, 'timeout');
    assert.equal(c.exitCode, null);
    assert.match(c.output, /READY-TIMEOUT/);
    assert.ok(c.note, 'пояснение controller о таймауте');
    assert.equal(
      i.commands.some((x) => x.status === 'passed'),
      false,
    );
  } finally {
    await s.cleanup();
  }
});

test('IN06: cancel после маркера готовности — команда учтена как cancelled, код null, частичный вывод', async () => {
  const s = await stage({ commandTimeoutMs: 60000 });
  try {
    const marker = join(s.root, 'ready-cancel');
    const controller = new AbortController();
    const running = s.probes.run(
      {
        argv: [
          process.execPath,
          '-e',
          `require('fs').writeSync(1, 'READY-CANCEL\\n'); require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); setInterval(() => {}, 1000)`,
        ],
      },
      controller.signal,
    );
    // Отмена — только после маркера готовности, не по случайному sleep.
    await waitFor(marker);
    controller.abort();
    const r = await running;
    assert.equal(r.status, 'cancelled');
    assert.equal(r.started, true);
    const i = await s.inspect();
    assert.equal(i.mode, 'commands');
    assert.equal(i.commands.length, 1);
    const c = i.commands[0]!;
    assert.equal(c.status, 'cancelled');
    assert.equal(c.exitCode, null);
    assert.match(c.output, /READY-CANCEL/);
    assert.notEqual(c.status, 'passed');
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* IN07 — отказы до старта                                             */
/* ------------------------------------------------------------------ */

/** Отказ до старта: started false, маркера нет, диагностика есть, команды в итоге нет. */
async function refusedBeforeStart(
  s: Awaited<ReturnType<typeof stage>>,
  r: Awaited<ReturnType<ReviewProbes['run']>>,
  marker: string | undefined,
  status: string,
) {
  assert.equal(r.status, status);
  assert.equal(r.started, false);
  assert.ok(r.note && r.note.trim().length > 0, `диагностика отказа ${status}`);
  if (marker) assert.equal(existsSync(marker), false, 'целевой код не исполнялся');
  const journal = await readProbeJournal(s.spec.log);
  const record = journal.records.find((x) => x.runId === r.runId);
  assert.equal(record?.started, false, 'журнал хранит факт отсутствия запуска');
  assert.ok(record?.note, 'диагностика сохранена в журнале');
  const i = await s.inspect();
  assert.equal(i.mode, 'diff-only');
  assert.deepEqual(i.commands, []);
  assert.deepEqual(i.excluded, [{ runId: r.runId, status, reason: 'not-started' }]);
}

const markerGate = (marker: string): ProbeGate => ({
  id: 'real',
  kind: 'check',
  command: touch(marker),
  timeoutMs: 10000,
});

test('IN07: неизвестный gate — не запускается, только диагностика', async () => {
  const s = await stage();
  const marker = join(s.root, 'gate-ran');
  s.spec.gates = [markerGate(marker)];
  try {
    const r = await s.probes.run({ gate: 'nope' });
    assert.match(r.note ?? '', /nope/);
    await refusedBeforeStart(s, r, marker, 'rejected');
  } finally {
    await s.cleanup();
  }
});

test('IN07: бюджет исчерпан (срок заключения прошёл) — команда не запускается', async () => {
  const s = await stage({ deadline: Date.now() - 1000 });
  try {
    const marker = join(s.root, 'budget-ran');
    const r = await s.probes.run({ argv: touch(marker) });
    await refusedBeforeStart(s, r, marker, 'budget-exhausted');
  } finally {
    await s.cleanup();
  }
});

test('IN07: отсутствующий executable (ENOENT) — error/environment без старта', async () => {
  const s = await stage();
  try {
    const r = await s.probes.run({ argv: ['definitely-missing-bin-xyz'] });
    assert.equal(r.failure, 'environment');
    assert.match(r.note ?? '', /ENOENT|definitely-missing-bin-xyz/);
    await refusedBeforeStart(s, r, undefined, 'error');
  } finally {
    await s.cleanup();
  }
});

test('IN07: отказ песочницы до старта (контролируемая имитация) — команда не исполнялась', async () => {
  const s = await stage({ isolation: { mode: 'os', domains: [] } });
  const original = isolationBackend.check;
  isolationBackend.check = () => ({ ok: false, detail: 'имитация: механизм песочницы недоступен' });
  try {
    const marker = join(s.root, 'sandbox-ran');
    const r = await s.probes.run({ argv: touch(marker) });
    assert.equal(r.failure, 'environment');
    assert.match(r.note ?? '', /имитация/);
    await refusedBeforeStart(s, r, marker, 'error');
  } finally {
    isolationBackend.check = original;
    await s.cleanup();
  }
});

test('IN07: уже отменённый запрос — cancelled без запуска целевой команды', async () => {
  const s = await stage();
  try {
    const marker = join(s.root, 'aborted-ran');
    const controller = new AbortController();
    controller.abort();
    const r = await s.probes.run({ argv: touch(marker) }, controller.signal);
    assert.equal(r.exitCode, null);
    await refusedBeforeStart(s, r, marker, 'cancelled');
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* IN08 — error/environment до и после старта; failed/report           */
/* ------------------------------------------------------------------ */

test('IN08: error/environment до старта не засчитан; после старта и failed/report после кода 0 — засчитаны', async () => {
  const s = await stage({ commandTimeoutMs: 15000 });
  const artifacts = join(s.controller, 'probe-runs');
  const marker = join(s.root, 'after-start-ran');
  s.spec.gates = [
    // Каталог gate отсутствует: отказ среды до запуска.
    {
      id: 'nocwd',
      kind: 'check',
      cwd: 'missing-dir',
      command: touch(join(s.root, 'nocwd-ran')),
      timeoutMs: 10000,
    },
    // Gate стартует, а затем у controller отнимается запись evidence запуска:
    // сбой среды после старта (сохранение журнала gate получает EACCES).
    {
      id: 'evidence',
      kind: 'check',
      command: touch(
        marker,
        `const fs = require('fs'), p = require('path'); for (const d of fs.readdirSync(${JSON.stringify(artifacts)})) fs.chmodSync(p.join(${JSON.stringify(artifacts)}, d), 0o500); console.log('gate ran');`,
      ),
      timeoutMs: 10000,
    },
    // Код 0, но JUnit не записан.
    {
      id: 'junit',
      kind: 'test',
      command: [process.execPath, '-e', "console.log('no report written')"],
      timeoutMs: 10000,
      report: { type: 'junit', path: '.reports/junit.xml' },
    },
  ];
  try {
    const before = await s.probes.run({ gate: 'nocwd' });
    assert.equal(before.status, 'error');
    assert.equal(before.failure, 'environment');
    assert.equal(before.started, false);
    assert.equal(existsSync(join(s.root, 'nocwd-ran')), false);

    const after = await s.probes.run({ gate: 'evidence' });
    assert.ok(existsSync(marker), 'gate действительно стартовал');
    assert.equal(after.status, 'error');
    assert.equal(after.failure, 'environment');
    assert.equal(after.started, true);
    assert.equal(after.exitCode, 0, 'код завершившегося процесса не потерян');

    const report = await s.probes.run({ gate: 'junit' });
    assert.equal(report.status, 'failed');
    assert.equal(report.failure, 'report');
    assert.equal(report.exitCode, 0);
    assert.equal(report.started, true);

    const i = await s.inspect();
    assert.equal(i.mode, 'commands');
    assert.deepEqual(i.excluded, [{ runId: before.runId, status: 'error', reason: 'not-started' }]);
    assert.deepEqual(controllerOrigins(i), [after.runId, report.runId]);
    const [e, j] = i.commands;
    assert.deepEqual(
      { status: e!.status, failure: e!.failure, exitCode: e!.exitCode, gate: e!.gate },
      { status: 'error', failure: 'environment', exitCode: 0, gate: 'evidence' },
    );
    assert.match(e!.output, /gate ran/);
    assert.deepEqual(
      { status: j!.status, failure: j!.failure, exitCode: j!.exitCode, gate: j!.gate },
      { status: 'failed', failure: 'report', exitCode: 0, gate: 'junit' },
    );
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* IN09 — runtime + controller                                         */
/* ------------------------------------------------------------------ */

test('IN09: одна runtime команда и два probe controller — 3 операции, индивидуальное происхождение, общий source и контекст', async () => {
  const s = await stage({ commandTimeoutMs: 15000 });
  try {
    const p1 = await s.probes.run({ argv: [process.execPath, '-e', "console.log('p1')"] });
    const p2 = await s.probes.run({ argv: [process.execPath, '-e', "console.log('p2')"] });
    const i = await s.inspect(codexEvent({ id: 'item_9', command: 'rg TODO', exit_code: 0 }));
    assert.equal(i.mode, 'commands');
    assert.equal(i.commands.length, 3);
    assert.equal(i.total, 3);
    assert.equal(i.source, 'runtime-and-controller');
    assert.deepEqual(
      i.commands.map((c) => c.origins),
      [
        [{ type: 'runtime', runtime: 'codex', item: 'item_9' }],
        [{ type: 'controller', runId: p1.runId }],
        [{ type: 'controller', runId: p2.runId }],
      ],
    );
    assert.deepEqual(i.context, ctx);
    assert.notEqual(p1.runId, ctx.attempt, 'runId probe и attempt — разные идентификаторы');
    reviewInspectionSchema.parse(i);
  } finally {
    await s.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* IN10 — идентичность операций                                        */
/* ------------------------------------------------------------------ */

/** Журнал из строк, прочитанный штатным читателем. */
async function journalOf(lines: string[]) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'harness-journal-')));
  const log = join(dir, 'probes.jsonl');
  writeFileSync(log, lines.join('\n') + '\n');
  try {
    return await readProbeJournal(log);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('IN10: дубликат строки одного runId — одна операция', async () => {
  const line = resultLine({ runId: 'run-dup', started: true, exitCode: 0, scope: ctx });
  const i = reviewInspection({ journal: await journalOf([line, line]), context: ctx });
  assert.equal(i.commands.length, 1);
  assert.equal(i.total, 1);
});

test('IN10: дубликат события runtime с тем же item ID — одна операция', () => {
  const e = codexEvent({ id: 'item_dup', command: 'npm test', exit_code: 0 });
  const runtime = inspectReview('codex', [e, e].join('\n'));
  assert.equal(runtime.commands.length, 1);
  const i = reviewInspection({ runtime, journal: emptyJournal(), context: ctx });
  assert.equal(i.commands.length, 1);
  // Повтор того же item в уже собранном наблюдении runtime — тоже одна операция.
  const twice = reviewInspection({
    runtime: { ...runtime, commands: [...runtime.commands, ...runtime.commands] },
    context: ctx,
  });
  assert.equal(twice.commands.length, 1);
});

test('IN10: явно связанная операция runtime/controller — одна, с обоими происхождениями', async () => {
  const runtime: Inspection = {
    mode: 'commands',
    source: 'codex-events',
    reason: null,
    commands: [
      {
        command: 'node -e 0',
        exitCode: 0,
        output: '',
        origins: [
          { type: 'runtime', runtime: 'claude', item: 'toolu_1' },
          { type: 'controller', runId: 'run-linked' },
        ],
      },
    ],
  };
  const journal = await journalOf([
    resultLine({ runId: 'run-linked', started: true, exitCode: 0, stdout: 'linked', scope: ctx }),
  ]);
  const i = reviewInspection({ runtime, journal, context: ctx });
  assert.equal(i.commands.length, 1);
  assert.equal(i.total, 1);
  assert.deepEqual(i.commands[0]!.origins, [
    { type: 'runtime', runtime: 'claude', item: 'toolu_1' },
    { type: 'controller', runId: 'run-linked' },
  ]);
  assert.equal(i.source, 'runtime-and-controller');
});

test('IN10: одинаковый argv с разными runId — две операции; совпадение текста без ID не склеивается', async () => {
  const argv = [process.execPath, '-e', "console.log('same')"];
  const journal = await journalOf([
    resultLine({ runId: 'run-a', argv, started: true, exitCode: 0, stdout: 'same', scope: ctx }),
    resultLine({ runId: 'run-b', argv, started: true, exitCode: 0, stdout: 'same', scope: ctx }),
  ]);
  const i = reviewInspection({ journal, context: ctx });
  assert.equal(i.commands.length, 2);
  assert.equal(i.commands[0]!.command, i.commands[1]!.command);
  // События runtime без item ID с тем же текстом и выводом — тоже две.
  const event = codexEvent({ command: 'npm test', exit_code: 0, aggregated_output: 'same' });
  const runtime = inspectReview('codex', [event, event].join('\n'));
  assert.equal(runtime.commands.length, 2);
  // Команда runtime с тем же текстом, что argv probe, без структурной связи — отдельная операция.
  const mixed = reviewInspection({
    runtime: inspectReview(
      'codex',
      codexEvent({
        id: 'item_x',
        command: i.commands[0]!.command,
        exit_code: 0,
        aggregated_output: 'same',
      }),
    ),
    journal,
    context: ctx,
  });
  assert.equal(mixed.commands.length, 3);
});

test('IN10: разные секреты, замаскированные в одинаковый argv, — две операции', async () => {
  const redact = redactor(['SECRET-ALPHA-111', 'SECRET-BETA-222']);
  const journal = await journalOf([
    resultLine({
      runId: 'run-s1',
      argv: ['curl', '-H', 'SECRET-ALPHA-111'],
      started: true,
      exitCode: 0,
      scope: ctx,
    }),
    resultLine({
      runId: 'run-s2',
      argv: ['curl', '-H', 'SECRET-BETA-222'],
      started: true,
      exitCode: 0,
      scope: ctx,
    }),
  ]);
  const i = reviewInspection({ journal, context: ctx, redact });
  assert.equal(i.commands.length, 2);
  assert.equal(i.commands[0]!.command, i.commands[1]!.command, 'тексты после маскирования совпали');
  assert.equal(JSON.stringify(i).includes('SECRET-'), false);
  assert.deepEqual(controllerOrigins(i), ['run-s1', 'run-s2']);
});

/* ------------------------------------------------------------------ */
/* IN11 — повреждённые и служебные строки журнала                      */
/* ------------------------------------------------------------------ */

test('IN11: битая строка, {}, резерв, abandoned, неизвестный статус рядом с валидным исходом — учтён только исход', async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'harness-journal-')));
  const log = join(dir, 'probes.jsonl');
  try {
    reserveProbe(log, 'run-reserved', 1500, ['sleep', '9']);
    reserveProbe(log, 'run-abandoned', 1500, ['sleep', '9']);
    await appendFile(
      log,
      [
        '{"runId":"run-broken","argv":["node"],"status":"pas',
        '{}',
        '[1,2]',
        JSON.stringify({ type: 'abandoned', runId: 'run-abandoned', chargedMs: 1500 }),
        resultLine({ runId: 'run-weird', status: 'exploded' as never, started: true, exitCode: 0 }),
        resultLine({ runId: 'run-valid', started: true, exitCode: 0, stdout: 'valid', scope: ctx }),
        JSON.stringify({ hello: 'world' }),
      ].join('\n') + '\n',
    );
    const journal = await readProbeJournal(log);
    const i = reviewInspection({ journal, context: ctx });
    assert.equal(i.mode, 'commands');
    assert.deepEqual(controllerOrigins(i), ['run-valid']);
    assert.match(i.commands[0]!.output, /valid/);
    assert.equal(i.invalid, 4, 'битая строка, {}, массив и объект без формы исхода');
    assert.deepEqual(
      [...(i.excluded ?? [])].sort((a, b) => a.runId.localeCompare(b.runId)),
      [
        { runId: 'run-abandoned', status: null, reason: 'abandoned' },
        { runId: 'run-reserved', status: null, reason: 'unfinished' },
        { runId: 'run-weird', status: 'exploded', reason: 'unknown-status' },
      ],
    );
    reviewInspectionSchema.parse(i);
    // Учёт бюджета по тому же журналу не сломан служебными строками.
    const ledger = await probeLedger(log);
    assert.ok(ledger.spentMs >= 3000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('IN11: legacy timeout без признака старта — только диагностика; явный started:false главнее legacy', async () => {
  const legacy = await journalOf([resultLine({ runId: 'run-legacy-timeout', status: 'timeout' })]);
  const i = reviewInspection({ journal: legacy, context: ctx });
  assert.equal(i.mode, 'diff-only');
  assert.deepEqual(i.commands, []);
  assert.deepEqual(i.excluded, [
    { runId: 'run-legacy-timeout', status: 'timeout', reason: 'legacy-unconfirmed' },
  ]);
  // Legacy passed/failed без признака старта — выполнение; явный false — нет.
  const mixed = reviewInspection({
    journal: await journalOf([
      resultLine({ runId: 'run-legacy-failed', status: 'failed' }),
      resultLine({ runId: 'run-explicit-false', status: 'failed', started: false }),
    ]),
    context: ctx,
  });
  assert.deepEqual(controllerOrigins(mixed), ['run-legacy-failed']);
  assert.equal(mixed.commands[0]!.exitCode, null, 'код не выводится из failed');
  assert.deepEqual(mixed.excluded, [
    { runId: 'run-explicit-false', status: 'failed', reason: 'not-started' },
  ]);
});

/* ------------------------------------------------------------------ */
/* IN12 — старые записи и расширенный контракт                         */
/* ------------------------------------------------------------------ */

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const publishedDocument = ajv.compile(
  JSON.parse(
    readFileSync(new URL('../schemas/execution-document.schema.json', import.meta.url), 'utf8'),
  ) as object,
);

const oldInspection = {
  mode: 'diff-only',
  source: 'codex-events',
  commands: [],
  reason: 'Нет подтверждённой успешной команды в событиях Codex.',
} as const;
/** Прежняя противоречивая запись alpha.6: diff-only при выполненной команде с кодом 1. */
const contradictory = {
  mode: 'diff-only',
  source: 'codex-events',
  commands: [
    { command: 'node --test', exitCode: 1, output: 'AssertionError: expected 400, received 413' },
  ],
  reason: 'Нет подтверждённой успешной команды в событиях Codex.',
} as const;
const evidence = (extra: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: 'review-1',
  runId: 'attempt-h',
  kind: 'review',
  phase: 'candidate',
  sha: SHA,
  gate: 'independent-review',
  passed: true,
  createdAt: '2026-10-23T07:20:16.000Z',
  command: [],
  exitCode: 0,
  log: 'artifacts/attempt-h/candidate/review/review.json',
  digest: digestOf('review'),
  summary: 'approved',
  ...extra,
});
const attemptWith = (records: EvidenceRecord[]): AttemptState => ({
  id: 'attempt-h',
  workId: 'add-greeting',
  repositoryId: 'app',
  attempt: 1,
  token: 'token-0123456789abcdef',
  owner: 'controller-1',
  runtime: 'codex',
  reviewer: 'codex',
  policyDigest: digestOf('policy'),
  status: 'succeeded',
  phase: 'done',
  startedAt: '2026-10-23T07:20:16.000Z',
  finishedAt: '2026-10-23T07:40:16.000Z',
  leaseUntil: 0,
  candidateSha: SHA,
  evidence: records,
});
const documentWith = (attempt: AttemptState): ExecutionDocument => ({
  stateVersion: STATE_VERSION,
  graphs: [],
  works: [],
  attempts: [attempt],
  verifications: [],
  control: { paused: true },
  sequence: 7,
});
/** Чтение схемой сохраняет значения; у старых записей — и байты сериализации. */
const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: unknown, bytes = true) => {
  const json = JSON.stringify(value);
  const parsed = schema.parse(JSON.parse(json));
  assert.deepEqual(parsed, value, 'чтение сохраняет прежние значения');
  if (bytes) assert.equal(JSON.stringify(parsed), json, 'повторная сериализация байт в байт');
  return parsed;
};

test('IN12: старый inspection без новых полей и старый противоречивый diff-only с кодом 1 читаются как есть', () => {
  roundTrip(reviewInspectionSchema, oldInspection);
  const parsed = roundTrip(reviewInspectionSchema, contradictory);
  assert.equal(parsed.mode, 'diff-only', 'читатель не пересчитывает старый mode');
  assert.equal(parsed.commands[0]!.exitCode, 1);
});

test('IN12: старое evidence без inspection и с прежним inspection читается без изменений', () => {
  roundTrip(evidenceRecordSchema, evidence());
  roundTrip(evidenceRecordSchema, evidence({ inspection: contradictory as unknown as Inspection }));
  roundTrip(evidenceRecordSchema, { ...evidence({ kind: 'test', gate: 'domain' }) });
});

test('IN12: старый документ состояния читается хранилищем без переписывания файла', async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'harness-old-state-')));
  try {
    const old = documentWith(
      attemptWith([
        evidence({ kind: 'test', gate: 'domain', id: 'test-1' }),
        evidence({ inspection: contradictory as unknown as Inspection }),
        evidence({ id: 'review-2', inspection: oldInspection as unknown as Inspection }),
      ]),
    );
    const json = JSON.stringify(old);
    roundTrip(executionDocumentSchema, old);
    assert.ok(publishedDocument(old), JSON.stringify(publishedDocument.errors));
    // Файл состояния в формате прежней версии: таблицы и документ записаны напрямую,
    // без текущего писателя.
    const file = join(dir, 'state.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      CREATE TABLE local (namespace TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(namespace, owner, key));`);
    db.prepare("INSERT INTO meta VALUES('stateVersion', ?)").run(String(STATE_VERSION));
    db.prepare("INSERT INTO meta VALUES('writer', '0.1.0-alpha.6')").run();
    db.prepare('INSERT INTO state VALUES(1, ?)').run(json);
    db.close();
    const snapshot = () =>
      readdirSync(dir)
        .sort()
        .map((name) => `${name}:${sha256(readFileSync(join(dir, name)))}`);
    const before = snapshot();
    const store = new SqliteExecutionStore(file, 'reader', { readOnly: true });
    try {
      const attempt = store.read((v) => v.attempt('attempt-h'));
      assert.deepEqual(attempt, old.attempts[0]);
      assert.deepEqual(attempt?.evidence[1]?.inspection, contradictory);
    } finally {
      store.close();
    }
    assert.deepEqual(snapshot(), before, 'чтение не переписало файл состояния');
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      const row = raw.prepare('SELECT data FROM state WHERE id=1').get() as { data: string };
      assert.equal(row.data, json, 'документ и digest-основа не пересчитаны');
    } finally {
      raw.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('IN12: новая запись с кодом null и новыми источниками проходит Zod и опубликованную JSON Schema', () => {
  const fresh = reviewInspection({
    runtime: inspectReview('codex', codexEvent({ id: 'item_1', command: 'rg x', exit_code: 1 })),
    journal: {
      records: [
        {
          runId: 'run-t',
          argv: ['node'],
          status: 'timeout',
          durationMs: 1,
          limitMs: 1,
          started: true,
          exitCode: null,
          scope: ctx,
        },
        {
          runId: 'run-x',
          argv: ['node'],
          status: 'error',
          durationMs: 0,
          limitMs: 1,
          started: false,
          failure: 'environment',
          note: 'ENOENT',
        },
      ],
      invalid: 2,
      reservations: [{ runId: 'run-r', abandoned: true }],
    },
    context: ctx,
  });
  assert.equal(fresh.source, 'runtime-and-controller');
  assert.equal(fresh.commands[1]!.exitCode, null);
  const controllerOnly = reviewInspection({
    journal: {
      records: [
        {
          runId: 'run-c',
          argv: ['node'],
          status: 'cancelled',
          durationMs: 1,
          limitMs: 1,
          started: true,
          exitCode: null,
        },
      ],
      invalid: 0,
      reservations: [],
    },
    context: ctx,
  });
  assert.equal(controllerOnly.source, 'controller-probes');
  for (const inspection of [fresh, controllerOnly]) {
    // Порядок ключей новой записи задаёт схема; сравниваются значения.
    roundTrip(reviewInspectionSchema, inspection, false);
    const record = evidence({ inspection });
    roundTrip(evidenceRecordSchema, record, false);
    const doc = documentWith(attemptWith([record]));
    roundTrip(executionDocumentSchema, doc, false);
    assert.ok(publishedDocument(doc), JSON.stringify(publishedDocument.errors));
  }
});

/* ------------------------------------------------------------------ */
/* IN13 — пределы, маскирование, детерминированный отбор               */
/* ------------------------------------------------------------------ */

test('IN13: >100 смешанных операций, длинные вывод/argv, секреты и короткий секрет из enum — пределы, маска, детерминизм', async () => {
  const SECRET = 'QZ7-secret-31337';
  // Короткие секреты совпадают с частями служебных значений: passed, completed,
  // cancelled, controller, runtime-and-controller.
  const redact = redactor([SECRET, 'ed', 'on']);
  const events = Array.from({ length: 60 }, (_, n) =>
    codexEvent({
      id: `item_${n}`,
      command: `npm test --token=${SECRET} #${n}`,
      exit_code: n % 2,
      aggregated_output: 'r'.repeat(10000) + ` leaked ${SECRET}`,
    }),
  ).join('\n');
  const longArg = 'x'.repeat(11990) + SECRET + 'y'.repeat(1000);
  const lines = Array.from({ length: 60 }, (_, n) =>
    resultLine({
      runId: `run-ed-${n}`,
      argv: n === 59 ? ['node', longArg] : ['node', '-e', `console.log(${n})`, SECRET],
      status: n % 3 === 0 ? 'failed' : 'passed',
      started: true,
      exitCode: n % 3 === 0 ? 1 : 0,
      stdout: 's'.repeat(12000) + SECRET,
      stderr: `${SECRET} ` + 'e'.repeat(6000) + ` stderr ${SECRET}`,
      note: `note ${SECRET} ` + 'n'.repeat(3000),
      scope: ctx,
      gate: {
        id: 'connector-gate',
        phase: 'candidate',
        sha: SHA,
        cwd: '.',
        argv: ['node'],
        controllerEnv: [],
      },
    }),
  );
  const journal = await journalOf(lines);
  const build = () =>
    reviewInspection({ runtime: inspectReview('codex', events), journal, context: ctx, redact });
  const i = build();
  assert.deepEqual(build(), i, 'отбор детерминирован');
  assert.equal(i.mode, 'commands');
  assert.equal(i.total, 120);
  assert.equal(i.commands.length, inspectionLimits.commands);
  // Сохраняются последние 100 в порядке: runtime по потоку, затем controller по журналу.
  const first = i.commands[0]!.origins![0]!;
  assert.deepEqual(first, { type: 'runtime', runtime: 'codex', item: 'item_20' });
  assert.deepEqual(
    controllerOrigins(i),
    lines.map((_, n) => `run-ed-${n}`),
  );
  for (const c of i.commands) {
    assert.ok(c.command.length <= 12000, `command ${c.command.length}`);
    assert.ok(c.output.length <= 4000, `output ${c.output.length}`);
    if (c.note) assert.ok(c.note.length <= 2000, `note ${c.note.length}`);
  }
  assert.ok(i.commands.at(-1)!.command.length > 11000, 'длинный argv обрезан, а не потерян');
  const userText = JSON.stringify(i.commands.map((c) => [c.command, c.output, c.note ?? '']));
  for (const leak of [SECRET, 'QZ7', '31337', 'ed', 'on'])
    assert.equal(userText.includes(leak), false, `в пользовательском тексте нет «${leak}»`);
  // Служебные значения и идентификаторы controller не тронуты маской.
  const parsed = reviewInspectionSchema.parse(i);
  assert.equal(parsed.source, 'runtime-and-controller');
  assert.deepEqual(parsed.context, ctx);
  assert.ok(i.commands.some((c) => c.status === 'passed'));
  assert.ok(i.commands.some((c) => c.status === 'completed'));
  assert.ok(
    i.commands.every((c) =>
      c.origins?.every((o) => o.type === 'runtime' || o.type === 'controller'),
    ),
  );
  assert.ok(i.commands.filter((c) => c.gate).every((c) => c.gate === 'connector-gate'));
  // Mode — по всему набору, а не по успешности хвоста.
  const failingTail = reviewInspection({
    runtime: inspectReview('codex', events),
    journal: await journalOf(lines.map((l) => l.replace('"status":"passed"', '"status":"failed"'))),
    context: ctx,
  });
  assert.equal(failingTail.mode, 'commands');
});

/* ------------------------------------------------------------------ */
/* IN14 — область итога: вызов, фаза, SHA; учёт бюджета                */
/* ------------------------------------------------------------------ */

test('IN14: два вызова одного SHA и integration — каждому итогу только свои записи, чужие исключены с объяснением', async () => {
  const call2: InspectionContext = { ...ctx, call: 2 };
  const integration: InspectionContext = { ...ctx, phase: 'integration', sha: 'b'.repeat(40) };
  const journal = await journalOf([
    resultLine({ runId: 'run-call1', started: true, exitCode: 0, scope: ctx }),
    resultLine({ runId: 'run-call2', started: true, exitCode: 0, scope: call2 }),
    resultLine({ runId: 'run-integration', started: true, exitCode: 0, scope: integration }),
    // Без scope, но gate явно другой фазы/SHA.
    resultLine({
      runId: 'run-gate-foreign',
      started: true,
      exitCode: 0,
      gate: {
        id: 'domain',
        phase: 'integration',
        sha: 'c'.repeat(40),
        cwd: '.',
        argv: ['node'],
        controllerEnv: [],
      },
    }),
  ]);
  const own = (context: InspectionContext) => reviewInspection({ journal, context });
  const a = own(ctx);
  assert.deepEqual(controllerOrigins(a), ['run-call1']);
  assert.deepEqual(a.context, ctx);
  assert.deepEqual(
    a.excluded?.map((e) => [e.runId, e.reason]),
    [
      ['run-call2', 'foreign-scope'],
      ['run-integration', 'foreign-scope'],
      ['run-gate-foreign', 'foreign-scope'],
    ],
  );
  assert.deepEqual(controllerOrigins(own(call2)), ['run-call2']);
  assert.deepEqual(controllerOrigins(own(integration)), ['run-integration']);
  // Gate без scope: sha совпадает, фаза — нет.
  const gateMismatch = reviewInspection({
    journal: await journalOf([
      resultLine({
        runId: 'run-gate-phase',
        started: true,
        exitCode: 0,
        gate: {
          id: 'domain',
          phase: 'integration',
          sha: SHA,
          cwd: '.',
          argv: ['node'],
          controllerEnv: [],
        },
      }),
    ]),
    context: ctx,
  });
  assert.deepEqual(gateMismatch.commands, []);
  assert.deepEqual(gateMismatch.excluded, [
    { runId: 'run-gate-phase', status: 'passed', reason: 'foreign-scope' },
  ]);
});

test('IN14: retry не теряет учёт бюджета probes прежнего вызова при новом формате журнала', async () => {
  const s = await stage({ commandTimeoutMs: 15000 });
  try {
    const r1 = await s.probes.run({ argv: [process.execPath, '-e', '0'] });
    const r2 = await s.probes.run({ argv: [process.execPath, '-e', 'process.exit(2)'] });
    // Строки исхода нового формата: признак старта и область вызова.
    const journal = await readProbeJournal(s.spec.log);
    assert.deepEqual(
      journal.records.map((r) => [r.started, r.scope]),
      [
        [true, ctx],
        [true, ctx],
      ],
    );
    const ledger = await probeLedger(s.spec.log);
    assert.equal(ledger.spentMs, r1.durationMs + r2.durationMs);
    assert.deepEqual(ledger.unfinished, []);
    // Controller погиб посреди третьей команды: резерв засчитывается целиком при recovery.
    reserveProbe(s.spec.log, 'run-crashed', 7000, ['node', '-e', 'hang']);
    const recovered = await recoverProbeLog(s.spec.log);
    assert.equal(recovered.spentMs, r1.durationMs + r2.durationMs + 7000);
    // Повтор ревью (call 2) получает остаток бюджета; его итог не содержит записей call 1.
    const log2 = join(s.controller, 'call-2', 'probes.jsonl');
    const call2: InspectionContext = { ...ctx, call: 2 };
    const retry = new ReviewProbes({
      ...s.spec,
      log: log2,
      scope: call2,
      budgetMs: s.spec.budgetMs - recovered.spentMs,
    });
    const r3 = await retry.run({ argv: [process.execPath, '-e', '0'] });
    assert.ok(r3.budgetLeftMs <= s.spec.budgetMs - recovered.spentMs);
    const second = reviewInspection({ journal: await readProbeJournal(log2), context: call2 });
    assert.deepEqual(controllerOrigins(second), [r3.runId]);
    const first = reviewInspection({ journal: await readProbeJournal(s.spec.log), context: ctx });
    assert.deepEqual(controllerOrigins(first), [r1.runId, r2.runId]);
    assert.deepEqual(first.excluded, [{ runId: 'run-crashed', status: null, reason: 'abandoned' }]);
    // Общий расход логического ревью — по всем вызовам.
    const total = (await probeLedger(s.spec.log)).spentMs + (await probeLedger(log2)).spentMs;
    assert.equal(total, recovered.spentMs + r3.durationMs);
  } finally {
    await s.cleanup();
  }
});
