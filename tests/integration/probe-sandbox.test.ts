/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call --
 * Тест читает сохранённые review.json и журналы fake CLI как есть.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isolationSupport } from '../../src/environment/isolation.ts';
import { approve, implement, runAll, setup, target } from '../runner-fixture.ts';
import { candidateFiles, demoGates, digest, saveEvidence } from '../probe-fixture.ts';

/**
 * Снимок проверяемого дерева исследовательской командой reviewer (только
 * чтение): прежние отчёты, HEAD и состояние Git.
 */
const snapshot = `const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');
const f=(p)=>{try{const b=fs.readFileSync(p);return {sha:crypto.createHash('sha256').update(b).digest('hex'),mtime:fs.statSync(p).mtimeMs}}catch(e){return e.code}};
const g=(...a)=>cp.execFileSync('git',a,{encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim();
console.log(JSON.stringify({domain:f('.reports/domain.xml'),api:f('.reports/api.xml'),sub:f('packages/sub/.reports/sub.xml'),
head:g('rev-parse','HEAD'),status:g('status','--porcelain','--untracked-files=all'),tracked:g('ls-files','-s')}));`;

test('HP07: объявленные gates domain/api/sub и integration probe под настоящей песочницей ОС — без EPERM, свежий JUnit вне дерева, прежние .reports целы', async () => {
  const support = isolationSupport();
  // Без песочницы — BLOCKED, а не PASS через isolation.mode: none.
  if (!support.ok) assert.fail('BLOCKED: песочница ОС недоступна: ' + support.detail);
  const probes = [
    [process.execPath, '-e', snapshot],
    { gate: 'domain' },
    { gate: 'api' },
    { gate: 'sub' },
    [process.execPath, '-e', snapshot],
    // Так reviewer запускал gate на пилоте: команда через argv пишет в дерево.
    [process.execPath, 'test/run-tests.mjs', 'domain'],
  ];
  const ctx = setup({
    files: candidateFiles,
    scenario: {
      writer: implement(),
      reviewer: { ...approve(), recordPrompt: true, probes },
    },
    graph: (g: any) => (g.orders[0].gates = demoGates.map((x) => x.id)),
    policy: (p: any) => {
      p.isolation = { mode: 'os', domains: [] };
      p.runTimeoutMs = 600_000;
      p.reviewProbes = { commandTimeoutMs: 180_000, budgetMs: 450_000, reserveMs: 60_000 };
      p.repositories[0].gates = demoGates.map((g) => ({
        id: g.id,
        kind: g.kind,
        command: g.command,
        timeoutMs: 180_000,
        report: g.report,
        ...(g.cwd ? { cwd: g.cwd } : {}),
      }));
    },
  });
  const initial = target(ctx);
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  assert.notEqual(target(ctx), initial, 'target двигает движок по своим gates');
  const reviews = a.evidence.filter((e) => e.kind === 'review');
  assert.deepEqual(
    reviews.map((e) => e.phase),
    ['candidate', 'integration'],
  );
  const evidence: unknown[] = [];
  for (const [i, review] of reviews.entries()) {
    const prompt = readFileSync(`${ctx.scenarioPath}.reviewer.${i}.prompt`, 'utf8');
    for (const id of ['domain', 'api', 'sub'])
      assert.ok(prompt.includes(JSON.stringify({ gate: id })));
    assert.match(prompt, /call run_check with exactly/);
    const saved = JSON.parse(readFileSync(review.log, 'utf8'));
    const runs = saved.probes as any[];
    assert.equal(runs.length, probes.length);
    const [before, ...rest] = runs;
    const after = rest[3];
    const raw = rest[4];
    assert.equal(before.status, 'passed');
    assert.equal(after.status, 'passed');
    const fake = JSON.parse(readFileSync(`${ctx.scenarioPath}.reviewer.${i}.probes`, 'utf8'));
    const was = JSON.parse(fake[0].stdout);
    const now = JSON.parse(fake[4].stdout);
    assert.deepEqual(now, was, 'прежние .reports, tracked files, HEAD и status не изменились');
    assert.equal(was.head, review.sha);
    assert.equal(was.status, '');
    assert.equal(
      typeof was.domain,
      'object',
      'прежний .reports/domain.xml от gate движка на месте',
    );
    assert.equal(typeof was.api, 'object');
    for (const [k, id] of ['domain', 'api', 'sub'].entries()) {
      const r = rest[k];
      const g = demoGates.find((x) => x.id === id)!;
      assert.equal(r.status, 'passed', `${review.phase}/${id}: ${JSON.stringify(fake[k + 1])}`);
      assert.equal(r.failure, undefined);
      assert.equal(r.gate.id, id);
      assert.equal(r.gate.phase, review.phase);
      assert.equal(r.gate.sha, review.sha);
      assert.equal(r.gate.cwd, g.cwd ?? '.');
      assert.deepEqual(r.gate.argv, g.command);
      assert.deepEqual(r.argv, g.command);
      assert.ok(r.gate.controllerEnv.includes('HARNESS_REPORT_PATH'));
      assert.equal(r.gate.report.status, 'fresh');
      assert.ok(r.gate.report.tests >= 1);
      assert.equal(r.gate.report.failures, 0);
      const xml = readFileSync(r.gate.report.path, 'utf8');
      assert.equal(digest(xml), r.gate.report.digest);
      assert.ok(!r.gate.report.path.startsWith(ctx.repo.dir), 'отчёт сохранён вне source tree');
      assert.ok(r.gate.report.path.startsWith(ctx.state), 'отчёт — в каталоге controller');
      // У sub отчёт детерминирован; у node --test в нём длительности.
      if (id !== 'sub' && was[id] && typeof was[id] === 'object')
        assert.notEqual(r.gate.report.digest, was[id].sha, 'свежий отчёт, не прежний файл');
      assert.equal(r.gate.scratchRemoved, true);
      assert.equal(existsSync(r.gate.scratch), false);
      assert.match(readFileSync(r.log, 'utf8'), new RegExp(`run=${r.runId} phase=${review.phase}`));
      assert.doesNotMatch(fake[k + 1].stderr ?? '', /EPERM/);
    }
    if (rest[2].gate.cwd === 'packages/sub')
      assert.match(readFileSync(rest[2].gate.report.path, 'utf8'), /cwd is sub/);
    assert.equal(raw.status, 'failed');
    assert.equal(raw.failure, 'environment');
    assert.match(fake[5].stderr, /EPERM/);
    evidence.push({
      phase: review.phase,
      sha: review.sha,
      reviewLog: review.log,
      treeBefore: was,
      treeAfter: now,
      gates: rest.slice(0, 3).map((r: any) => ({
        runId: r.runId,
        status: r.status,
        gate: r.gate.id,
        phase: r.gate.phase,
        sha: r.gate.sha,
        cwd: r.gate.cwd,
        argv: r.gate.argv,
        controllerEnv: r.gate.controllerEnv,
        report: r.gate.report,
        scratchRemoved: r.gate.scratchRemoved,
        log: r.log,
        durationMs: r.durationMs,
      })),
      rawArgvPilotRepro: {
        runId: raw.runId,
        status: raw.status,
        failure: raw.failure,
        argv: raw.argv,
      },
    });
  }
  // Probe не записывает evidence gates: оно только от движка.
  assert.deepEqual(
    a.evidence
      .filter((e) => e.kind === 'test')
      .map((e) => `${e.phase}/${e.gate}/${e.passed}`)
      .sort(),
    ['candidate', 'integration']
      .flatMap((p) => ['api', 'domain', 'sub'].map((g) => `${p}/${g}/true`))
      .sort(),
  );
  saveEvidence('HP07', 'probes.json', {
    sandbox: support,
    attempt: a.status,
    target: { before: initial, after: target(ctx) },
    reviews: evidence,
  });
});
