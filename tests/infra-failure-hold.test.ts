/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment --
 * Фикстура правит сырой JSON политики.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { TaskFailure } from '../src/contracts/index.ts';
import {
  classifyFailure,
  environmentCauseOf,
  registryPullFailure,
} from '../src/engine/classify.ts';
import { toolMissingFailure, toolMissingLine } from '../src/verification/gate-tooling.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';
import { nodeGate } from './git-fixture.ts';

test('toolMissing: pnpm «Command not found», sh, spawn ENOENT, браузер Playwright, pnpm state path; провал кода — нет', () => {
  for (const text of [
    '[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "playwright" not found',
    'sh: 1: vitest: not found',
    'bash: line 1: tsx: command not found',
    'zsh: command not found: maestro',
    'Error: spawn docker ENOENT',
    "browserType.launch: Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium-1/chrome\nLooks like Playwright was just installed. Please run: npx playwright install",
    'Pinned generation failed:\n[ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH] Refusing to use task run state directory',
  ])
    assert.ok(toolMissingLine(text), text);
  for (const text of [
    "Error: Cannot find module './greet.js'",
    'AssertionError: 500 !== 200',
    'error TS2304: Cannot find name "x"',
  ])
    assert.equal(toolMissingLine(text), undefined, text);
  // Упавшие testcases: все с признаком — отказ инструмента; хотя бы один без — провал кода.
  const pnpm = '[ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH] Refusing';
  assert.ok(toolMissingFailure('', { total: 1, texts: [pnpm] }));
  assert.equal(toolMissingFailure(pnpm, { total: 2, texts: [pnpm, '400 !== 201'] }), undefined);
  assert.equal(toolMissingFailure(pnpm, { total: 2, texts: [pnpm] }), undefined, 'не все тексты');
});

test('registry pull: обрыв реестра в выводе шага окружения — environment (dependency-network); прочий провал шага — прежний класс', () => {
  const pull =
    'Шаг compose-setup: exit=1; timeout=false; стадия setup ⟦вывод: rabbitmq Pulled | minio Error Head "https://registry-1.docker.io/v2/library/turbo-starter-minio/manifests/dev": EOF | minio-init Interrupted⟧';
  assert.ok(registryPullFailure(pull));
  assert.ok(
    registryPullFailure(
      'Error response from daemon: Get "https://ghcr.io/v2/": net/http: TLS handshake timeout',
    ),
  );
  assert.ok(registryPullFailure('toomanyrequests: You have reached your pull rate limit'));
  assert.equal(
    registryPullFailure('Шаг compose-setup: exit=1 ⟦вывод: port is already allocated⟧'),
    false,
  );
  const failure = new TaskFailure('unknown', pull);
  assert.equal(classifyFailure(failure, pull), 'environment');
  assert.equal(environmentCauseOf(failure, pull, 'environment'), 'dependency-network');
  assert.equal(classifyFailure(new Error(pull), pull), 'environment');
  const other = 'Шаг compose-setup: exit=1; timeout=false ⟦вывод: port is already allocated⟧';
  assert.equal(classifyFailure(new TaskFailure('unknown', other), other), 'unknown');
});

/** Gate `browser` печатает отказ pnpm «Command "playwright" not found» и падает. */
function toolSetup(writerFiles?: Record<string, string>) {
  return setup({
    files: { 'package.json': '{"name":"app","private":true}\n' },
    scenario: {
      writer: writerFiles ? implement(writerFiles) : implement(),
      reviewer: approve(),
    },
    graph: (g: any) => {
      g.orders[0].gates = ['unit', 'browser'];
      g.orders[0].writeScope = ['src', 'package.json'];
    },
    policy: (p: any) => {
      p.harnessMode = 'light';
      p.maxAttempts = 3;
      p.repositories[0].protectedPaths = p.repositories[0].protectedPaths.filter(
        (x: string) => x !== 'package.json',
      );
      p.repositories[0].gates.push({
        id: 'browser',
        kind: 'check',
        command: nodeGate(
          'console.error(\' ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "playwright" not found\'); process.exit(1)',
        ),
      });
    },
  });
}

const writerCalls = (ctx: ReturnType<typeof setup>) => {
  const path = `${ctx.scenarioPath}.claude.writer.count`;
  return existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
};

test('runner: gate не нашёл инструмент — environment gate-definition, попытка не засчитана, gate удержан, исполнителю не повторяется', async () => {
  const ctx = toolSetup();
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  const attempts = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempts.length, 1, 'автоматического повтора исполнителю нет');
  assert.equal(writerCalls(ctx), 1);
  const a = attempts[0]!;
  assert.equal(a.failureKind, 'environment');
  assert.equal(a.environmentCause, 'gate-definition');
  assert.match(a.error ?? '', /GATE_TOOL_MISSING: .*Command "playwright" not found/);
  assert.equal(work.attempt, 0, 'попытка не засчитана');
  assert.equal(work.environmentHold?.gate, 'browser', 'gate удержан до хода ведущего');
  ctx.store.close();
});

test('runner: исполнитель менял package.json — отказ инструмента засчитан как провал gate', async () => {
  const ctx = toolSetup({
    'src/greet.js': "exports.greet = (name) => 'Hello, ' + name + '!';\n",
    'package.json': '{"name":"app","private":true,"devDependencies":{}}\n',
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.failureKind, 'gate', a.error);
  assert.match(a.error ?? '', /GATE_TOOL_MISSING: .*провал засчитан/);
  ctx.store.close();
});
