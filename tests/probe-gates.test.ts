/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument --
 * Тесты читают сохранённые review.json и журналы controller как есть.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReviewProbes,
  observeReproductions,
  probeCommand,
  probeRecords,
  probeSpec,
  type ProbeGate,
  type ProbeResult,
} from '../src/agents/review-probe.ts';
import { isolationSupport } from '../src/environment/isolation.ts';
import { propertyReportEnv } from '../src/verification/gates.ts';
import { redactor } from '../src/environment/redaction.ts';
import { approve, implement, runAll, setup, target } from './runner-fixture.ts';
import {
  candidate,
  demoGates,
  digest,
  mcpClient,
  probeSpecFor,
  saveEvidence,
  staleXml,
} from './probe-fixture.ts';

/** Без песочницы ОС проверка — BLOCKED, а не PASS через mode: none. */
function requireSandbox() {
  const support = isolationSupport();
  if (!support.ok) assert.fail('BLOCKED: песочница ОС недоступна: ' + support.detail);
}
const node = (script: string) => [process.execPath, '-e', script];
const gate = (id: string, command: string[], extra: Partial<ProbeGate> = {}): ProbeGate => ({
  id,
  kind: 'test',
  command,
  timeoutMs: 60000,
  report: { type: 'junit', path: `.reports/${id}.xml` },
  ...extra,
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const evidenceOf = (r: ProbeResult) => ({
  runId: r.runId,
  status: r.status,
  failure: r.failure,
  exitCode: r.exitCode,
  gate: r.gate && {
    id: r.gate.id,
    phase: r.gate.phase,
    sha: r.gate.sha,
    cwd: r.gate.cwd,
    argv: r.gate.argv,
    controllerEnv: r.gate.controllerEnv,
    report: r.gate.report,
    scratchRemoved: r.gate.scratchRemoved,
  },
  note: r.note,
});

test('HP08/parallel: два одновременных probe одного gate — разные runId, отчёты, журналы и настройки песочницы', async () => {
  requireSandbox();
  const c = candidate();
  try {
    const probes = new ReviewProbes(probeSpecFor(c));
    const [a, b] = await Promise.all([
      probes.run({ gate: 'domain' }),
      probes.run({ gate: 'domain' }),
    ]);
    for (const r of [a, b]) {
      assert.equal(r.status, 'passed', r.stderr + r.note);
      assert.equal(r.gate?.report?.status, 'fresh');
      assert.equal(r.gate?.report?.tests, 2);
      const saved = readFileSync(r.gate.report.path!, 'utf8');
      assert.equal(digest(saved), r.gate.report.digest, 'digest — байты сохранённого отчёта');
      assert.ok(existsSync(join(c.review, 'probe-settings', r.runId, 'isolation.json')));
      assert.equal(existsSync(r.gate.scratch!), false);
    }
    assert.notEqual(a.runId, b.runId);
    assert.notEqual(a.gate!.report!.path, b.gate!.report!.path);
    assert.notEqual(a.log, b.log);
    const records = await probeRecords(join(c.review, 'probes.jsonl'));
    assert.deepEqual(new Set(records.map((r) => r.runId)), new Set([a.runId, b.runId]));
    assert.equal(readFileSync(join(c.dir, '.reports', 'domain.xml'), 'utf8'), staleXml('domain'));
    saveEvidence(
      'HP08',
      'parallel.json',
      [a, b].map((r) => evidenceOf(r)),
    );
  } finally {
    c.cleanup();
  }
});

test('HP08/input: неизвестный gate, лишние поля и чужие пути отклоняются без запуска', async () => {
  const c = candidate();
  const marker = join(c.controller, 'ran');
  try {
    const spec = probeSpecFor(c, {
      isolation: { mode: 'none', domains: [] },
      gates: [
        gate('mark', node(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)),
        { ...gate('prop', ['true']), property: true },
      ],
    });
    const probes = new ReviewProbes(spec);
    const unknown = await probes.run({ gate: 'nope' });
    assert.equal(unknown.status, 'rejected');
    assert.match(unknown.note ?? '', /Неизвестный gate nope; объявлены: mark\./);
    assert.equal(unknown.budgetLeftMs, spec.budgetMs, 'отклонённый вход не тратит бюджет');
    const property = await probes.run({ gate: 'prop' });
    assert.equal(property.status, 'rejected');
    assert.match(property.note ?? '', /генеративный/);

    const specPath = join(c.review, 'probe.json');
    await writeFile(specPath, JSON.stringify(spec));
    const { command, args } = probeCommand(specPath);
    const client = mcpClient(command, args);
    try {
      await client.handshake();
      const tools = await client.request('tools/list', {});
      assert.match(tools.result!.tools![0]!.description, /Declared gates: mark\./);
      const refused = [
        { gate: 'mark', env: { HARNESS_REPORT_PATH: '/tmp/x' } },
        { gate: 'mark', reportPath: join(c.dir, '.reports', 'x.xml') },
        { gate: 'mark', write: [c.dir] },
        { gate: 'mark', cwd: '..' },
        { gate: 'mark', argv: ['true'] },
        { gate: '../../etc/passwd' },
        { gate: 'mark', scope: ['src'] },
        {},
      ];
      for (const args of refused) {
        const reply = await client.request('tools/call', { name: 'run_check', arguments: args });
        assert.equal(reply.error?.code, -32602, JSON.stringify(args));
      }
    } finally {
      client.close();
    }
    assert.equal(existsSync(marker), false, 'ни один отклонённый вызов не запускал gate');
    // Спецификацию строит controller: путь с `..` в ней не проходит схему.
    for (const bad of [{ cwd: '../outside' }, { report: { type: 'junit', path: '../x.xml' } }])
      assert.equal(
        probeSpec.safeParse({ ...spec, gates: [{ ...gate('g', ['true']), ...bad }] }).success,
        false,
      );
    const log = await probeRecords(spec.log);
    assert.deepEqual(
      log.map((r) => r.status),
      ['rejected', 'rejected'],
    );
    saveEvidence('HP08', 'input.json', {
      unknown: evidenceOf(unknown),
      property: evidenceOf(property),
    });
  } finally {
    c.cleanup();
  }
});

test('HP08/write: gate под probe не пишет в исходники, .git, каталог controller и прежние .reports', async () => {
  requireSandbox();
  const c = candidate();
  try {
    const leak = join(c.controller, 'leak.txt');
    const attempts = {
      source: `fs.appendFileSync('README.md', 'x')`,
      git: `fs.appendFileSync('.git/config', '[x]')`,
      hook: `fs.writeFileSync('.git/hooks/pre-commit', 'exit 0')`,
      controller: `fs.writeFileSync(${JSON.stringify(leak)}, 'x')`,
      staleRemove: `fs.rmSync('.reports/domain.xml')`,
      staleOverwrite: `fs.writeFileSync('.reports/api.xml', '<testsuite/>')`,
      newReport: `fs.writeFileSync('.reports/new.xml', '<testsuite/>')`,
    };
    const script = `const fs = require('fs'); const cases = [];
${Object.entries(attempts)
  .map(
    ([name, code]) =>
      `try { ${code}; cases.push('<testcase name="${name}"><failure message="write succeeded"/></testcase>'); } catch (e) { cases.push('<testcase name="${name}"/>'); console.log('${name}: ' + e.code); }`,
  )
  .join('\n')}
fs.writeFileSync(process.env.HARNESS_REPORT_PATH, '<testsuite>' + cases.join('') + '</testsuite>');`;
    const before = {
      readme: readFileSync(join(c.dir, 'README.md'), 'utf8'),
      config: readFileSync(join(c.dir, '.git', 'config'), 'utf8'),
      domain: statSync(join(c.dir, '.reports', 'domain.xml')).mtimeMs,
      api: statSync(join(c.dir, '.reports', 'api.xml')).mtimeMs,
      head: c.head(),
    };
    const probes = new ReviewProbes(probeSpecFor(c, { gates: [gate('evil', node(script))] }));
    const r = await probes.run({ gate: 'evil' });
    assert.equal(r.status, 'passed', `${r.note}\n${r.stdout}\n${r.stderr}`);
    assert.equal(r.gate?.report?.tests, Object.keys(attempts).length);
    assert.equal(r.gate?.report?.failures, 0, 'каждая запись отклонена песочницей');
    assert.equal(readFileSync(join(c.dir, 'README.md'), 'utf8'), before.readme);
    assert.equal(readFileSync(join(c.dir, '.git', 'config'), 'utf8'), before.config);
    assert.equal(existsSync(join(c.dir, '.git', 'hooks', 'pre-commit')), false);
    assert.equal(existsSync(leak), false);
    assert.equal(readFileSync(join(c.dir, '.reports', 'domain.xml'), 'utf8'), staleXml('domain'));
    assert.equal(readFileSync(join(c.dir, '.reports', 'api.xml'), 'utf8'), staleXml('api'));
    assert.equal(statSync(join(c.dir, '.reports', 'domain.xml')).mtimeMs, before.domain);
    assert.equal(statSync(join(c.dir, '.reports', 'api.xml')).mtimeMs, before.api);
    assert.equal(existsSync(join(c.dir, '.reports', 'new.xml')), false);
    assert.equal(c.head(), before.head);
    assert.equal(c.git('status', '--porcelain', '--untracked-files=all'), '');
    saveEvidence('HP08', 'write-denied.json', { result: evidenceOf(r), stdout: r.stdout });
  } finally {
    c.cleanup();
  }
});

test('HP08/report-path: symlink и жёсткая ссылка вместо отчёта не читаются; cwd через symlink наружу отклоняется', async () => {
  const c = candidate();
  const outside = await mkdtemp(join(tmpdir(), 'harness-probe-outside-'));
  try {
    const stale = join(c.dir, '.reports', 'domain.xml');
    symlinkSync(outside, join(c.dir, 'escape'));
    await writeFile(
      join(outside, 'secret.xml'),
      '<testsuite><testcase name="outside"/></testsuite>',
    );
    const marker = join(outside, 'ran');
    const probes = new ReviewProbes(
      probeSpecFor(c, {
        isolation: { mode: 'none', domains: [] },
        gates: [
          gate(
            'symlink',
            node(
              `require('fs').symlinkSync(${JSON.stringify(stale)}, process.env.HARNESS_REPORT_PATH)`,
            ),
          ),
          gate(
            'hardlink',
            node(
              `require('fs').linkSync(${JSON.stringify(join(outside, 'secret.xml'))}, process.env.HARNESS_REPORT_PATH)`,
            ),
          ),
          gate('escape', node(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`), {
            cwd: 'escape',
          }),
        ],
      }),
    );
    for (const id of ['symlink', 'hardlink']) {
      const r = await probes.run({ gate: id });
      assert.equal(r.status, 'failed', id);
      assert.equal(r.failure, 'report');
      assert.equal(r.gate?.report?.status, 'unsafe', id);
      assert.equal(r.gate?.report?.path, undefined, 'чужой файл не копируется в evidence');
      assert.equal(existsSync(join(r.gate.artifacts!, `${id}.xml`)), false);
    }
    assert.equal(readFileSync(stale, 'utf8'), staleXml('domain'), 'прежний отчёт цел');
    const escaped = await probes.run({ gate: 'escape' });
    assert.equal(escaped.status, 'rejected');
    assert.match(escaped.note ?? '', /cwd выходит из worktree/);
    assert.equal(existsSync(marker), false);
    // Хост с песочницей: та же подмена symlink-ом под изоляцией ОС.
    if (isolationSupport().ok) {
      const os = new ReviewProbes(
        probeSpecFor(c, {
          gates: [
            gate(
              'symlink',
              node(
                `require('fs').symlinkSync(${JSON.stringify(stale)}, process.env.HARNESS_REPORT_PATH)`,
              ),
            ),
          ],
        }),
      );
      const r = await os.run({ gate: 'symlink' });
      assert.equal(r.gate?.report?.status, 'unsafe');
      assert.notEqual(r.status, 'passed');
    }
  } finally {
    c.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('HP08/failing: упавший тест — failed с именами testcases, отчёт сохранён, это не PASS', async () => {
  requireSandbox();
  const c = candidate();
  try {
    const probes = new ReviewProbes(
      probeSpecFor(c, {
        gates: [gate('broken', [process.execPath, 'test/run-tests.mjs', 'broken'])],
      }),
    );
    const r = await probes.run({ gate: 'broken' });
    assert.equal(r.status, 'failed');
    assert.equal(r.failure, undefined, 'провал теста — наблюдение о коде, а не среда');
    assert.equal(r.gate?.report?.status, 'fresh');
    assert.equal(r.gate?.report?.failures, 1);
    assert.match(r.note ?? '', /fails on purpose/);
    assert.ok(existsSync(r.gate.report.path!));
    saveEvidence('HP08', 'failing.json', evidenceOf(r));
  } finally {
    c.cleanup();
  }
});

test('HP08/report: отсутствующий, устаревший, битый и пустой JUnit — failed/report, без находки в коде', async () => {
  const c = candidate();
  try {
    const old = join(c.dir, '.reports', 'domain.xml');
    const probes = new ReviewProbes(
      probeSpecFor(c, {
        isolation: { mode: 'none', domains: [] },
        gates: [
          gate('missing', node('process.exit(0)')),
          gate(
            'stale',
            node(
              `const fs=require('fs');fs.copyFileSync(${JSON.stringify(old)},process.env.HARNESS_REPORT_PATH);const t=new Date(Date.now()-3600e3);fs.utimesSync(process.env.HARNESS_REPORT_PATH,t,t)`,
            ),
          ),
          gate(
            'corrupt',
            node(`require('fs').writeFileSync(process.env.HARNESS_REPORT_PATH,'not xml <')`),
          ),
          gate(
            'empty',
            node(`require('fs').writeFileSync(process.env.HARNESS_REPORT_PATH,'<testsuite/>')`),
          ),
        ],
      }),
    );
    const expected = { missing: 'missing', stale: 'stale', corrupt: 'corrupt', empty: 'corrupt' };
    const results: Record<string, unknown> = {};
    for (const [id, status] of Object.entries(expected)) {
      const r = await probes.run({ gate: id });
      assert.equal(r.status, 'failed', id);
      assert.equal(r.failure, 'report', id);
      assert.equal(r.gate?.report?.status, status, id);
      assert.match(r.note ?? '', /не находка в коде/);
      assert.equal(r.gate?.scratchRemoved, true);
      results[id] = evidenceOf(r);
    }
    assert.equal(readFileSync(old, 'utf8'), staleXml('domain'));
    saveEvidence('HP08', 'report-states.json', results);
  } finally {
    c.cleanup();
  }
});

test('HP08/timeout-cancel: процессы остановлены, evidence сохранено до удаления scratch', async () => {
  const c = candidate();
  const pids = join(c.controller, 'pids');
  // Потомок — node, как у настоящих test runner. Окружение системных бинарников
  // (/bin/sleep) macOS не показывает в `ps -E`, и метка их не находит.
  const hang = `const fs=require('fs');const cp=require('child_process');
fs.writeFileSync(process.env.HARNESS_REPORT_PATH,'<testsuite><testcase name="partial"/></testsuite>');
const k=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});k.unref();
fs.appendFileSync(process.env.PROBE_PID_FILE, k.pid+'\\n');console.log('hanging');setInterval(()=>{},1000)`;
  const spec = probeSpecFor(c, {
    isolation: { mode: 'none', domains: [] },
    commandTimeoutMs: 2500,
    env: ['PATH', 'HOME', 'PROBE_PID_FILE'],
    gates: [gate('hang', node(hang))],
  });
  process.env.PROBE_PID_FILE = pids;
  try {
    const timed = await new ReviewProbes(spec).run({ gate: 'hang' });
    assert.equal(timed.status, 'timeout');
    assert.equal(timed.exitCode, null);
    assert.equal(timed.gate?.report?.tests, 1, 'частичный отчёт сохранён');
    assert.ok(existsSync(timed.gate.report.path!));
    assert.ok(existsSync(join(timed.gate.artifacts!, 'run.json')));
    assert.match(readFileSync(timed.log!, 'utf8'), /hanging/);
    assert.equal(existsSync(timed.gate.scratch!), false, 'scratch убран');

    // Отмена через MCP: notifications/cancelled останавливает этот вызов.
    const specPath = join(c.review, 'probe-cancel.json');
    await writeFile(specPath, JSON.stringify({ ...spec, commandTimeoutMs: 60000 }));
    const { command, args } = probeCommand(specPath);
    const client = mcpClient(command, args);
    let cancelled: ProbeResult;
    try {
      await client.handshake();
      const call = client.start('tools/call', { name: 'run_check', arguments: { gate: 'hang' } });
      for (let i = 0; i < 100 && (await readFile(pids, 'utf8')).trim().split('\n').length < 2; i++)
        await new Promise((r) => setTimeout(r, 100));
      client.notify('notifications/cancelled', { requestId: call.id, reason: 'test' });
      cancelled = (await call.response).result!.structuredContent!;
    } finally {
      client.close();
    }
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.durationMs < 30000);
    assert.equal(existsSync(cancelled.gate!.scratch!), false);
    assert.ok(existsSync(join(cancelled.gate!.artifacts!, 'run.json')));
    const children = (await readFile(pids, 'utf8')).trim().split('\n').map(Number);
    assert.equal(children.length, 2);
    for (const pid of children) {
      for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(alive(pid), false, `потомок ${pid} не пережил проверку (${children.join(',')})`);
    }
    saveEvidence('HP08', 'timeout-cancel.json', {
      timeout: evidenceOf(timed),
      cancelled: evidenceOf(cancelled),
    });
  } finally {
    delete process.env.PROBE_PID_FILE;
    c.cleanup();
  }
});

test('HP08/environment: зашитый путь отчёта, EPERM записи в дерево и отказ scratch — ошибка среды, а не находка', async () => {
  const c = candidate();
  const marker = join(c.controller, 'ran');
  const touch = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`;
  try {
    // Рецепты основного ТЗ с путём в argv (gotestsum, pytest, mixed-python): не
    // запускаются, аргумент назван, argv не переписан.
    const fixed = new ReviewProbes(
      probeSpecFor(c, {
        isolation: { mode: 'none', domains: [] },
        gates: [
          gate('go', [...node(touch), '--junitfile', '.reports/go.xml', '--', './...'], {
            report: { type: 'junit', path: '.reports/go.xml' },
          }),
          gate('py', [...node(touch), '--junitxml=.reports/py.xml'], {
            report: { type: 'junit', path: '.reports/py.xml' },
          }),
          gate('mixed', [...node(touch), '--junitxml=../../.reports/mixed.xml'], {
            cwd: 'packages/sub',
            report: { type: 'junit', path: '.reports/mixed.xml' },
          }),
        ],
      }),
    );
    const recipes: Record<string, unknown> = {};
    for (const [id, index] of [
      ['go', 4],
      ['py', 3],
      ['mixed', 3],
    ] as const) {
      const r = await fixed.run({ gate: id });
      assert.equal(r.status, 'error', id);
      assert.equal(r.failure, 'environment', id);
      assert.match(r.note ?? '', new RegExp(`аргумент ${index}`));
      assert.match(r.note ?? '', /HARNESS_REPORT_PATH/);
      assert.match(r.note ?? '', /не находка в коде/);
      assert.deepEqual(
        r.argv,
        fixed.spec.gates!.find((g) => g.id === id)!.command,
        'argv не переписан',
      );
      recipes[id] = evidenceOf(r);
    }
    assert.equal(existsSync(marker), false, 'gate с зашитым путём не запускался');

    // Отказ подготовки scratch — ошибка среды.
    const tmp = process.env.TMPDIR;
    process.env.TMPDIR = join(c.controller, 'no-such-dir');
    let scratch: ProbeResult;
    try {
      scratch = await new ReviewProbes(
        probeSpecFor(c, {
          isolation: { mode: 'none', domains: [] },
          gates: [gate('s', node(touch))],
        }),
      ).run({ gate: 's' });
    } finally {
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
    }
    assert.equal(scratch.status, 'error');
    assert.equal(scratch.failure, 'environment');
    assert.match(scratch.note ?? '', /scratch/);
    assert.equal(existsSync(marker), false);

    if (isolationSupport().ok) {
      // Путь зашит в скрипт (как в package script npm/pnpm): запуск идёт, запись
      // в дерево получает EPERM — тоже ошибка среды с рецептом.
      const os = new ReviewProbes(
        probeSpecFor(c, {
          gates: [
            ...demoGates,
            gate(
              'script',
              node(
                `require('fs').mkdirSync('.reports',{recursive:true});require('fs').writeFileSync('.reports/script.xml','<x/>')`,
              ),
            ),
          ],
        }),
      );
      const denied = await os.run({ gate: 'script' });
      assert.equal(denied.status, 'error', denied.stderr);
      assert.equal(denied.failure, 'environment');
      assert.match(denied.note ?? '', /EPERM.*HARNESS_REPORT_PATH/s);
      // Пилот: команда объявленного gate через argv — EPERM на прежнем отчёте.
      const raw = await os.run({ argv: [process.execPath, 'test/run-tests.mjs', 'domain'] });
      assert.equal(raw.status, 'failed');
      assert.equal(raw.failure, 'environment');
      assert.match(raw.stderr, /EPERM/);
      assert.match(raw.note ?? '', /\{"gate":"domain"\}/);
      assert.equal(readFileSync(join(c.dir, '.reports', 'domain.xml'), 'utf8'), staleXml('domain'));
      // Находка, сославшаяся на отказ среды, не становится наблюдением.
      const [finding] = observeReproductions(
        [
          {
            message: 'm',
            reproduction: { command: ['x'], run: raw.runId },
          },
        ],
        await probeRecords(os.spec.log),
        redactor([]),
      ) as any[];
      assert.equal(finding.reproduction.observed, false);
      recipes.script = evidenceOf(denied);
      recipes.rawArgv = evidenceOf(raw);
    }
    recipes.scratch = evidenceOf(scratch);
    saveEvidence('HP08', 'environment.json', recipes);
  } finally {
    c.cleanup();
  }
});

test('HP08/engine: успешный probe не заменяет gates и не двигает target; reproduction.run ведёт к журналу controller', async () => {
  const ctx = setup({
    files: { FAIL_ON_INTEGRATION: '1\n' },
    scenario: {
      writer: implement(),
      reviewer: {
        ...approve(),
        recordPrompt: true,
        probes: [{ gate: 'unit' }],
        result: {
          ...approve().result,
          findings: [
            {
              severity: 'note',
              message: 'Gate unit прошёл в probe',
              path: null,
              line: null,
              rule: null,
              consequence: null,
              evidence: null,
              reproduction: {
                property: null,
                input: 'gate unit',
                expected: null,
                actual: null,
                command: ['claimed'],
                executed: true,
                run: '$probe:0',
              },
            },
          ],
        },
      },
    },
    policy: (p: any) => {
      p.maxAttempts = 1;
      p.reviewProbes = { commandTimeoutMs: 20_000, budgetMs: 40_000, reserveMs: 5_000 };
    },
  });
  const initial = target(ctx);
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.notEqual(a.status, 'succeeded');
  assert.equal(target(ctx), initial, 'target не сдвинут: integration gate упал');
  const review = a.evidence.find((e) => e.kind === 'review' && e.phase === 'candidate')!;
  const saved = JSON.parse(readFileSync(review.log, 'utf8'));
  const [probe] = saved.probes;
  assert.equal(probe.status, 'passed');
  assert.equal(probe.gate.id, 'unit');
  assert.equal(probe.gate.phase, 'candidate');
  assert.equal(probe.gate.sha, review.sha);
  assert.equal(probe.gate.report.status, 'fresh');
  // Воспроизведение — по журналу controller: runId, фактический argv и файл журнала.
  const rep = saved.findings[0].reproduction;
  assert.equal(rep.observed, true);
  assert.equal(rep.run, probe.runId);
  assert.deepEqual(rep.command, ctx.policy.repositories[0]!.gates[0]!.command);
  assert.ok(existsSync(probe.log));
  assert.match(readFileSync(probe.log, 'utf8'), new RegExp(`run=${probe.runId}`));
  const registered = ctx.engine.reproductions('add-greeting');
  assert.equal(registered[0]!.run, probe.runId);
  // Evidence gates — только от движка: probe не записывает техническое PASS.
  const tests = a.evidence.filter((e) => e.kind === 'test');
  assert.deepEqual(
    tests.map((e) => [e.phase, e.gate, e.passed]),
    [
      ['candidate', 'unit', true],
      ['integration', 'unit', false],
      // Стойкий провал интеграции повторён один раз на том же SHA и подтверждён.
      ['integration', 'unit', false],
    ],
  );
  assert.ok(tests.every((e) => !e.log.includes('probe-runs')));
  const prompt = readFileSync(`${ctx.scenarioPath}.reviewer.0.prompt`, 'utf8');
  assert.match(prompt, /call run_check with exactly \{"gate":"unit"\}/);
  saveEvidence('HP08', 'engine.json', {
    attempt: a.status,
    targetBefore: initial,
    targetAfter: target(ctx),
    probe,
    reproduction: rep,
    engineEvidence: tests.map((e) => ({
      phase: e.phase,
      gate: e.gate,
      passed: e.passed,
      sha: e.sha,
    })),
  });
});

test('HP08/property-report: путь отчёта свойств под probe — в scratch controller, а не прежний путь в дереве только для чтения', async () => {
  requireSandbox();
  const c = candidate();
  try {
    // Проверка пишет отчёт свойств по пути controller, а без него — по
    // прежнему пути в дереве, как и JUnit; в дереве probe это EPERM.
    const script = `const fs = require('fs');
const target = process.env.DEVCONTOUR_PROPERTY_REPORT ?? '.reports/property.json';
fs.writeFileSync(target, JSON.stringify({ version: 1, properties: [{ testId: 'p', status: 'passed', cases: 3 }] }));
fs.writeFileSync(process.env.HARNESS_REPORT_PATH, '<testsuite><testcase name="p"/></testsuite>');`;
    const probes = new ReviewProbes(probeSpecFor(c, { gates: [gate('props', node(script))] }));
    const r = await probes.run({ gate: 'props' });
    assert.equal(r.status, 'passed', `${r.note}\n${r.stderr}`);
    // Имя переменной — то же и только то, что выставляет gate движка.
    assert.equal(propertyReportEnv, 'DEVCONTOUR_PROPERTY_REPORT');
    assert.deepEqual(
      r.gate?.controllerEnv.filter((name) => /PROPERTY|SEED|CORPUS/.test(name)),
      [propertyReportEnv],
    );
    assert.equal(r.gate?.propertyReport?.scope, 'probe-only');
    const saved = JSON.parse(readFileSync(r.gate.propertyReport.path, 'utf8'));
    assert.equal(saved.properties[0].cases, 3);
    assert.equal(r.gate?.scratchRemoved, true);
    assert.equal(existsSync(join(c.dir, '.reports', 'property.json')), false);
  } finally {
    c.cleanup();
  }
});

test('HP08/property-report-unsafe: symlink и жёсткая ссылка вместо отчёта свойств не сохраняются', async () => {
  const c = candidate();
  const outside = await mkdtemp(join(tmpdir(), 'harness-probe-outside-'));
  try {
    const secret = join(outside, 'secret.json');
    await writeFile(secret, '{"secret":true}');
    const junit = `require('fs').writeFileSync(process.env.HARNESS_REPORT_PATH, '<testsuite><testcase name="p"/></testsuite>')`;
    const probes = new ReviewProbes(
      probeSpecFor(c, {
        isolation: { mode: 'none', domains: [] },
        gates: [
          gate(
            'symlink',
            node(
              `require('fs').symlinkSync(${JSON.stringify(secret)}, process.env.DEVCONTOUR_PROPERTY_REPORT);${junit}`,
            ),
          ),
          gate(
            'hardlink',
            node(
              `require('fs').linkSync(${JSON.stringify(secret)}, process.env.DEVCONTOUR_PROPERTY_REPORT);${junit}`,
            ),
          ),
          // Symlink на файл в самом scratch — тоже не отчёт.
          gate(
            'inner',
            node(
              `const fs=require('fs'),p=require('path');const t=p.join(p.dirname(process.env.DEVCONTOUR_PROPERTY_REPORT),'inner.json');fs.writeFileSync(t,'{}');fs.symlinkSync(t, process.env.DEVCONTOUR_PROPERTY_REPORT);${junit}`,
            ),
          ),
        ],
      }),
    );
    for (const id of ['symlink', 'hardlink', 'inner']) {
      const r = await probes.run({ gate: id });
      assert.equal(r.status, 'passed', `${id}: ${r.note}\n${r.stderr}`);
      assert.equal(r.gate?.propertyReport, undefined, id);
      assert.equal(existsSync(join(r.gate!.artifacts!, `${id}.property.json`)), false, id);
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
    c.cleanup();
  }
});
