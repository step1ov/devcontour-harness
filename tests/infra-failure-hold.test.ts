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
  registryPullStep,
} from '../src/engine/classify.ts';
import {
  gateBinaries,
  toolMissingFailure,
  toolMissingLine,
} from '../src/verification/gate-tooling.ts';
import { approve, implement, runAll, setup } from './runner-fixture.ts';
import { gateHoldLine } from '../src/projections/gate-hold.ts';
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

test('registry pull (ревью C MEDIUM-3): обрыв с контекстом загрузки в той же строке; health check без него — не окружение; класс решает runner', () => {
  const pull =
    'Шаг compose-setup: exit=1; timeout=false; стадия setup ⟦вывод: rabbitmq Pulled | minio Error Head "https://registry-1.docker.io/v2/library/turbo-starter-minio/manifests/dev": EOF | minio-init Interrupted⟧';
  assert.ok(registryPullFailure(pull));
  assert.ok(
    registryPullFailure(
      'Error response from daemon: Get "https://ghcr.io/v2/": net/http: TLS handshake timeout',
    ),
  );
  assert.ok(registryPullFailure('docker pull postgres:16: toomanyrequests: rate limit'));
  assert.ok(
    registryPullFailure(' ERR_PNPM_FETCH_502  GET https://registry.npmjs.org/x: ECONNRESET'),
  );
  // Без контекста загрузки в той же строке — не обрыв реестра.
  for (const text of [
    'Шаг ready: exit=1 ⟦вывод: Get "http://localhost:8080/health": net/http: request canceled (Client.Timeout exceeded)⟧',
    'toomanyrequests from our own API under test',
    'Шаг compose-setup: exit=1 ⟦вывод: port is already allocated⟧',
    'registry ready | health: request canceled',
  ])
    assert.equal(registryPullFailure(text), false, text);
  assert.equal(registryPullStep('Шаг compose-pull: exit=1'), true);
  assert.equal(registryPullStep('Шаг compose-setup: exit=1 ⟦вывод: docker compose pull …⟧'), true);
  assert.equal(registryPullStep('Шаг compose-setup: exit=1 ⟦вывод: x Pulling⟧'), false);
  // Классификатор сам обрыв реестра окружением не делает: решает runner
  // (до кода исполнителя или на шаге загрузки).
  assert.equal(classifyFailure(new TaskFailure('unknown', pull), pull), 'unknown');
  assert.equal(classifyFailure(new Error(pull), pull), 'unknown');
  assert.notEqual(environmentCauseOf(new Error(pull), pull, 'environment'), 'dependency-network');
});

/** Инструмент, которого точно нет на машине теста (проба `command -v` его не найдёт). */
const MISSING = 'pw-harness-missing-tool';

/**
 * Gate `browser` печатает `output` в stderr и падает; исполнитель пишет
 * `files` и удаляет `remove`. Без `output` — отказ pnpm «Command not found».
 */
function toolSetup(
  options: {
    files?: Record<string, string>;
    remove?: string[];
    output?: string;
    base?: Record<string, string>;
  } = {},
) {
  const output =
    options.output ?? ` ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "${MISSING}" not found`;
  return setup({
    files: { 'package.json': '{"name":"app","private":true}\n', ...options.base },
    scenario: {
      writer: {
        ...(options.files ? implement(options.files) : implement()),
        ...(options.remove ? { remove: options.remove } : {}),
      },
      reviewer: approve(),
    },
    graph: (g: any) => {
      g.orders[0].gates = ['unit', 'browser'];
      g.orders[0].writeScope = ['src', 'package.json', 'scripts'];
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
        command: nodeGate(`console.error(${JSON.stringify(output)}); process.exit(1)`),
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
  assert.match(a.error ?? '', /GATE_TOOL_MISSING: .*Command "pw-harness-missing-tool" not found/);
  assert.equal(work.attempt, 0, 'попытка не засчитана');
  assert.equal(work.environmentHold?.gate, 'browser', 'gate удержан до хода ведущего');
  // Строка удержания называет инструмент, а не «печатать выжимку».
  assert.equal(work.environmentHold?.tool, true);
  const line = gateHoldLine({ ...work.environmentHold, workId: work.id }, work.id);
  assert.match(line.ru, /не нашла свой инструмент или браузер/);
  assert.match(line.ru, /установить инструмент или браузер либо поправить команду gate/);
  assert.doesNotMatch(line.ru, /печатала/);
  ctx.store.close();
});

test('runner: исполнитель менял package.json — отказ инструмента засчитан как провал gate', async () => {
  const ctx = toolSetup({
    files: {
      'src/greet.js': "exports.greet = (name) => 'Hello, ' + name + '!';\n",
      'package.json': '{"name":"app","private":true,"devDependencies":{}}\n',
    },
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.failureKind, 'gate', a.error);
  assert.match(a.error ?? '', /GATE_TOOL_MISSING: .*провал засчитан/);
  ctx.store.close();
});

/** Первая попытка засчитана как провал gate с пометкой GATE_TOOL_MISSING и причиной. */
async function counted(ctx: ReturnType<typeof setup>, why: RegExp) {
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.failureKind, 'gate', a.error);
  assert.equal(a.environmentCause, undefined);
  assert.match(a.error ?? '', why);
  ctx.store.close();
}

test('ревью C HIGH-1: смешанный вывод без отчёта — ENOENT и упавшее утверждение — провал засчитан', async () => {
  await counted(
    toolSetup({
      output: `ok 1 - handles missing binary # Error: spawn ${MISSING} ENOENT\nnot ok 2 - greet\nAssertionError [ERR_ASSERTION]: 'Hi' !== 'Hello'`,
    }),
    /Код выхода 1/,
  );
});

test('ревью C HIGH-1: исполнитель добавил spawn недостающей программы — провал засчитан', async () => {
  await counted(
    toolSetup({
      output: `Error: spawn ${MISSING} ENOENT`,
      files: {
        'src/greet.js': "exports.greet = (name) => 'Hello, ' + name + '!';\n",
        'src/run.js': `require('child_process').spawn('${MISSING}', ['status']);\n`,
      },
    }),
    /не программа gate|добавило вызов pw-harness-missing-tool/,
  );
});

test('ревью C HIGH-1: исполнитель удалил обёртку gate — провал засчитан', async () => {
  await counted(
    toolSetup({
      base: { 'scripts/e2e.sh': '#!/bin/sh\nexit 0\n' },
      output: 'sh: 1: scripts/e2e.sh: not found',
      remove: ['scripts/e2e.sh'],
    }),
    /трогает scripts\/e2e\.sh/,
  );
});

test('ревью C HIGH-1: строку напечатал код, а инструмент есть — проба его находит, провал засчитан', async () => {
  await counted(
    toolSetup({ output: ' ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "node" not found' }),
    /проба harness нашла инструмент/,
  );
});

test('ревью B2 M3: spawn вычисленного неверного пути — не программа gate, провал засчитан', async () => {
  await counted(
    toolSetup({ output: `Error: spawn /wrong/dir/${MISSING} ENOENT` }),
    /spawn \/wrong\/dir\/pw-harness-missing-tool — не программа gate/,
  );
});

test('ревью B2 M3: программы gate — argv[0], цель exec и первая программа script пакета', () => {
  const scripts = () => ({ e2e: 'PW=1 playwright test --reporter=junit', build: 'tsc -p .' });
  assert.deepEqual(gateBinaries({ command: ['pnpm', 'run', 'e2e'] }, scripts), [
    'pnpm',
    'playwright',
  ]);
  assert.deepEqual(gateBinaries({ command: ['npm', 'build'] }, scripts), ['npm', 'tsc']);
  assert.deepEqual(gateBinaries({ command: ['pnpm', 'exec', 'vitest', 'run'] }, scripts), [
    'pnpm',
    'vitest',
  ]);
  assert.deepEqual(gateBinaries({ command: ['env', 'A=1', 'npx', 'maestro', 'test'] }, scripts), [
    'npx',
    'maestro',
  ]);
  assert.deepEqual(gateBinaries({ command: ['node', 'x.js'] }, scripts), ['node']);
});
