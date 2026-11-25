/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тест правит сырой JSON политики до разбора схемой.
 */
/**
 * P8-4 (0.1.0-alpha.70): отказ до вызова исполнителя — подготовка окружения
 * (lifecycle setup, docker/compose) — это отказ окружения, а не
 * «неизвестно»: попытка не засчитана, исполнитель не вызывался, выдача
 * держится как остановка окружения.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hsetup } from './harness-fixture.ts';
import { approve, implement } from './runner-fixture.ts';
import { fixtureCalls } from './review-fixture.ts';

const WORK = 'add-greeting';
const node = (code: string) => [process.execPath, '-e', code];

test('P8-4: отказ docker в setup до вызова исполнителя — environment, попытка не засчитана', async () => {
  const ctx = hsetup({
    scenario: { writer: [implement()], reviewer: approve() },
    policy: (p: any) => {
      p.maxAttempts = 3;
      p.repositories[0].lifecycle = {
        setup: [
          {
            id: 'services',
            command: node(
              "console.error('Error response from daemon: driver failed programming external connectivity'); process.exit(1)",
            ),
            timeoutMs: 30_000,
          },
        ],
        ready: [],
        teardown: [{ id: 'down', command: node('process.exit(0)'), timeoutMs: 30_000 }],
      };
    },
  });
  const h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' }).catch(() => undefined);
  const attempts = h.engine.read((v) => v.attempts(WORK));
  const first = attempts[0]!;
  assert.equal(first.failureKind, 'environment', first.error);
  assert.equal(first.blocked, true, 'отказ до работы');
  const work = h.engine.read((v) => v.work(WORK)!);
  assert.equal(work.attempt, 0, 'попытка не засчитана');
  assert.equal(fixtureCalls(ctx.scenarioPath, 'claude', 'writer'), 0, 'исполнитель не вызывался');
  const diagnosed = h
    .events(0, 500)
    .events.find((e) => e.type === 'attempt.diagnosed') as unknown as {
    payload: { cause: string; counted: boolean };
  };
  assert.equal(diagnosed.payload.counted, false);
  assert.equal(diagnosed.payload.cause, 'preflight');
  h.close();
});

test('ревью 1: отказ setup на взятом кандидате (код прежнего исполнителя) остаётся засчитанным, не окружение', async () => {
  const { setup, runAll } = await import('./runner-fixture.ts');
  const { verdict } = await import('./review-fixture.ts');
  const crash = {
    exit: 1,
    stderr: 'ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed',
  };
  const ctx = setup({
    scenario: { writer: implement(), reviewer: [crash, verdict(true)] },
    policy: (p: any) => {
      p.maxAttempts = 5;
      // setup падает на дереве с кодом исполнителя (src/greet.js кандидата).
      p.repositories[0].lifecycle = {
        setup: [
          {
            id: 'services',
            command: node(
              "process.exit(require('fs').existsSync('src/greet.js') ? (console.error('broken setup in candidate'), 1) : 0)",
            ),
            timeoutMs: 30_000,
          },
        ],
        ready: [],
        teardown: [{ id: 'down', command: node('process.exit(0)'), timeoutMs: 30_000 }],
      };
    },
  });
  await runAll(ctx);
  const first = ctx.engine.read((v) => v.attempts(WORK)[0]!);
  assert.equal(first.failureKind, 'environment', first.error);
  assert.ok(first.candidateSha);
  ctx.engine.retry(WORK);
  ctx.engine.resume();
  await ctx.runner.drain();
  const second = ctx.engine.read((v) => v.attempts(WORK)[1]!);
  assert.ok(second.reusedFrom, 'кандидат взят');
  assert.equal(second.failureKind, 'unknown', second.error);
  assert.notEqual(second.blocked, true, 'засчитано: код исполнителя исполнялся');
});
