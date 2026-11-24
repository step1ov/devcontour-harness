/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тест правит сырой JSON политики до разбора схемой.
 */
/**
 * P8-1 (0.1.0-alpha.70, ревью 4): под границей записи `.git` закрыт, как в
 * alpha.69. Gate, который меняет состояние git (уборка `git checkout -- .`),
 * получает понятный совет (`GATE_GIT_WRITE`); если тот же gate так же
 * падает и на базе — это определение gate: удержание для ведущего, попытка
 * исполнителю не засчитана.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateDigest } from '../src/contracts/index.ts';
import { writeGuardSupport } from '../src/environment/write-guard.ts';
import { fixtureAdapters } from '../src/integrations/connector/testing.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';

// Исполнитель и reviewer — в процессе (без CLI): граница записи — у gate.
const adapters = () => ({ adapters: fixtureAdapters({ writer: 0, reviewer: 0, plan: 0 }) });

const supported = writeGuardSupport().ok;
const WORK = 'add-greeting';
// Gate с уборкой через git: под границей index.lock не взять.
const gate = `
const { execSync } = require('child_process');
execSync('git checkout -- .', { stdio: 'inherit' });
`;

const guarded = (p: any) => {
  p.harnessMode = 'light';
  p.isolation = { mode: 'os', domains: [] };
  // Без кешей по умолчанию: репозиторий теста — во временном каталоге,
  // который среди открытых кешей.
  p.writeGuard = { replace: ['~/.npm/_cacache'] };
  p.maxAttempts = 2;
  p.repositories[0].gates[0].command = [process.execPath, 'test/clean.js'];
};

test(
  'P8-1: gate меняет состояние git под границей — совет GATE_GIT_WRITE, засчитан исполнителю',
  { skip: !supported },
  async () => {
    const ctx = setup({
      scenario: { writer: implement(), reviewer: approve() },
      files: { 'test/clean.js': gate },
      runner: adapters(),
      policy: (p: any) => {
        guarded(p);
        p.maxAttempts = 1;
      },
    });
    await runAll(ctx);
    const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
    assert.equal(a.failureKind, 'gate', a.error);
    assert.match(a.error ?? '', /GATE_GIT_WRITE: gate меняет состояние git/);
    assert.match(a.error ?? '', /git diff --exit-code и git clean -n/);
    assert.equal(
      ctx.engine.read((v) => v.work(WORK)!.attempt),
      1,
      'засчитано',
    );
  },
);

test(
  'P8-1: тот же gate так же падает на базе — определение gate, удержание, не засчитано',
  { skip: !supported },
  async () => {
    const ctx = setup({
      scenario: { writer: implement(), reviewer: approve() },
      files: { 'test/clean.js': gate },
      runner: adapters(),
      policy: guarded,
    });
    // Итог harness gates --sha <база>: тот же gate с тем же определением упал так же.
    const base = ctx.repo.git('rev-parse', 'HEAD');
    const dir = join(ctx.state, 'gates-at', 'base-run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'result.json'),
      JSON.stringify({
        at: new Date().toISOString(),
        data: {
          repositoryId: ctx.policy.repositories[0]!.id,
          sha: base,
          gates: [
            {
              gate: 'unit',
              status: 'failed',
              message: 'GATE_GIT_WRITE: gate меняет состояние git',
              failureSummary: { gitWrite: true },
              definition: gateDigest(ctx.policy.repositories[0]!.gates[0]!),
            },
          ],
        },
      }),
    );
    await runAll(ctx);
    const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
    assert.equal(a.failureKind, 'environment', a.error);
    assert.match(a.error ?? '', /GATE_DEFINITION_NO_CAUSE: GATE_GIT_WRITE/);
    const w = ctx.engine.read((v) => v.work(WORK)!);
    assert.equal(w.attempt, 0, 'не засчитано');
    assert.equal(w.environmentHold?.cause, 'gate-definition');
  },
);

const baseRun = (ctx: ReturnType<typeof setup>, entry: Record<string, unknown>) => {
  const dir = join(ctx.state, 'gates-at', 'base-run');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify({
      at: new Date().toISOString(),
      data: {
        repositoryId: ctx.policy.repositories[0]!.id,
        sha: ctx.repo.git('rev-parse', 'HEAD'),
        gates: [
          {
            gate: 'unit',
            status: 'failed',
            definition: gateDigest(ctx.policy.repositories[0]!.gates[0]!),
            ...entry,
          },
        ],
      },
    }),
  );
};

test(
  'ревью 5: настоящий провал теста вместе с тем же отказом git — засчитанный провал исполнителя, не удержание',
  { skip: !supported },
  async () => {
    // Gate: упавший testcase в отчёте и уборка через git.
    const mixed = `
const fs = require('fs');
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase classname="greet" name="greets"><failure message="expected Hello"/></testcase></testsuite>');
require('child_process').execSync('git checkout -- .', { stdio: 'inherit' });
`;
    const ctx = setup({
      scenario: { writer: implement(), reviewer: approve() },
      files: { 'test/clean.js': mixed },
      runner: adapters(),
      policy: guarded,
    });
    baseRun(ctx, { failureSummary: { gitWrite: true } });
    await runAll(ctx);
    const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
    assert.equal(a.failureKind, 'gate', a.error);
    assert.match(a.error ?? '', /greet\.greets/);
    assert.match(a.error ?? '', /кроме того, GATE_GIT_WRITE/);
    const w = ctx.engine.read((v) => v.work(WORK)!);
    assert.equal(w.attempt, 1, 'засчитано');
    assert.equal(w.environmentHold, undefined);
  },
);

test(
  'ревью 5: на базе — только текст GATE_GIT_WRITE без структурной отметки — не удержание',
  { skip: !supported },
  async () => {
    const ctx = setup({
      scenario: { writer: implement(), reviewer: approve() },
      files: { 'test/clean.js': gate },
      runner: adapters(),
      policy: guarded,
    });
    baseRun(ctx, { message: 'упал тест «GATE_GIT_WRITE classification»' });
    await runAll(ctx);
    const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
    assert.equal(a.failureKind, 'gate', a.error);
    assert.equal(
      ctx.engine.read((v) => v.work(WORK)!.environmentHold),
      undefined,
    );
    // Своя отметка у провала с одним только отказом git.
    const evidence = a.evidence.find((e) => e.kind === 'test')!;
    assert.equal(evidence.failureSummary?.gitWrite, true);
  },
);

test(
  'ревью 6: только общий провал обёртки в отчёте («Gate execution failed») и отказ git — отметка gitWrite, на базе так же — удержание',
  { skip: !supported },
  async () => {
    const wrapper = `
const fs = require('fs');
try {
  require('child_process').execSync('git checkout -- .', { stdio: 'inherit' });
} catch (e) {
  fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase classname="gate" name="run"><failure>Gate execution failed</failure></testcase></testsuite>');
  process.exit(1);
}
`;
    const ctx = setup({
      scenario: { writer: implement(), reviewer: approve() },
      files: { 'test/clean.js': wrapper },
      runner: adapters(),
      policy: guarded,
    });
    baseRun(ctx, { failureSummary: { gitWrite: true } });
    await runAll(ctx);
    const a = ctx.engine.read((v) => v.attempts(WORK)[0]!);
    assert.equal(a.failureKind, 'environment', a.error);
    assert.match(a.error ?? '', /GATE_DEFINITION_NO_CAUSE: GATE_GIT_WRITE/);
    const w = ctx.engine.read((v) => v.work(WORK)!);
    assert.equal(w.attempt, 0, 'не засчитано');
    assert.equal(w.environmentHold?.cause, 'gate-definition');
  },
);
