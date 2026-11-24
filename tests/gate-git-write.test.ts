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
