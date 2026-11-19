/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Управляемый адаптер собирается из частичного объекта возможностей.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TaskFailure,
  checkCodeReview,
  findingId,
  type CodeReviewHistory,
  type RuntimeAdapter,
  type RuntimeName,
} from '../src/contracts/index.ts';
import { GitOutputLimit, git, gitWithLimit } from '../src/environment/process.ts';
import { redactThenClip } from '../src/environment/redaction.ts';
import { codeReviewDiff } from '../src/engine/review-diff.ts';
import { Harness } from '../src/control/harness.ts';
import { policyOf, graphOf } from './engine-fixture.ts';
import { repo, write } from './git-fixture.ts';

// Надёжность ядра: вывод git без молчаливого усечения, отказ запуска утилиты
// перечня процессов не роняет хост, маска до обрезки в ревью плана/контракта.

/** Удаляет только временный репозиторий фикстуры. */
const drop = (dir: string) => {
  if (/\/harness-repo-[^/]+$/.test(dir)) rmSync(dir, { recursive: true, force: true });
};

/** Репозиторий с коммитом, diff которого больше 2 МБ (прежний хвост `command`). */
function bigDiff() {
  const r = repo({ 'README.md': 'app\n' });
  const base = r.head();
  const line = (i: number) => `line ${String(i).padStart(7, '0')} ${'x'.repeat(40)}\n`;
  const body = Array.from({ length: 60_000 }, (_, i) => line(i)).join('');
  write(r.dir, { 'src/big.txt': body, 'src/small.txt': 'small\n' });
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'big');
  return { ...r, base, sha: r.head(), body };
}

test('CR-1: git() возвращает вывод больше 2 МБ целиком', async () => {
  const r = bigDiff();
  try {
    const diff = await git(r.dir, 'diff', '--no-ext-diff', '--no-textconv', r.base, r.sha);
    assert.ok(diff.length > 3_000_000, `diff ${diff.length}`);
    assert.ok(diff.startsWith('diff --git a/src/big.txt'), 'начало diff на месте');
    assert.match(diff, /\+line 0000000 /, 'первая строка файла на месте');
    assert.match(diff, /\+line 0059999 /, 'последняя строка файла на месте');
    assert.match(diff, /src\/small\.txt/);
    const shown = await git(r.dir, 'show', `${r.sha}:src/big.txt`);
    assert.equal(shown, r.body.trim(), 'содержимое файла целиком');
  } finally {
    drop(r.dir);
  }
});

test('CR-1: вывод больше явного предела — GitOutputLimit, а не хвост', async () => {
  const r = bigDiff();
  try {
    const error = await gitWithLimit(r.dir, 2_500_000, 'show', `${r.sha}:src/big.txt`).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof GitOutputLimit, String(error));
    assert.equal(error.limit, 2_500_000);
    assert.match(error.message, /больше 2500000 символов/);
    // Тот же вывод в пределе — целиком.
    assert.equal(
      await gitWithLimit(r.dir, 4_000_000, 'show', `${r.sha}:src/big.txt`),
      r.body.trim(),
    );
  } finally {
    drop(r.dir);
  }
});

test('CR-1: diff ревью кода больше предела — явный отказ с путями, не усечённый diff', async () => {
  const r = bigDiff();
  try {
    const error = await codeReviewDiff(r.dir, r.base, r.sha).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof TaskFailure, String(error));
    assert.equal(error.kind, 'review');
    assert.match(error.message, /больше предела независимого ревью \(1000000 символов\)/);
    assert.match(error.message, /ни части diff/);
    assert.match(
      error.message,
      /Изменённые пути \(2, имена как JSON\): \["src\/big\.txt","src\/small\.txt"\]/,
    );
    // С пределом больше diff reviewer получает его целиком.
    const full = await codeReviewDiff(r.dir, r.base, r.sha, 8_000_000);
    assert.match(full, /\+line 0000000 /);
    assert.match(full, /\+line 0059999 /);
    assert.match(full, /src\/small\.txt/);
  } finally {
    drop(r.dir);
  }
});

test('CR-1: -z-вывод git не теряет пробел в начале первого пути', async () => {
  const r = repo({ 'README.md': 'app\n' });
  try {
    const base = r.head();
    write(r.dir, { ' src/x.txt': 'x\n' });
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'space');
    const out = await git(r.dir, 'diff', '--no-renames', '--name-only', '-z', base, r.head());
    assert.deepEqual(out.split('\0').filter(Boolean), [' src/x.txt']);
  } finally {
    drop(r.dir);
  }
});

test('CR-2: синхронный отказ запуска ps/lsof в опросе не роняет процесс', () => {
  const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  // execFile и spawnSync бросают синхронно, как EPERM под sandbox. Команда со
  // сдерживанием опрашивает дерево таймером каждые 250 мс.
  const script = `
    import { mock } from 'node:test';
    const real = await import('node:child_process');
    let thrown = 0;
    const eperm = () => {
      thrown++;
      throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM', errno: -1, syscall: 'spawn' });
    };
    const execFile = (file, ...rest) => (/(^|\\/)(ps|lsof)$/.test(file) ? eperm() : real.execFile(file, ...rest));
    const spawnSync = (file, ...rest) => (/(^|\\/)ps$/.test(file) ? eperm() : real.spawnSync(file, ...rest));
    mock.module('node:child_process', { namedExports: { ...real, execFile, spawnSync }, defaultExport: { ...real.default, execFile, spawnSync } });
    const unhandled = [];
    process.on('unhandledRejection', (e) => unhandled.push(String(e)));
    process.on('uncaughtException', (e) => unhandled.push(String(e)));
    const warnings = [];
    process.on('warning', (w) => { if (w.code) warnings.push(w.code); });
    const { command, inventoryStatus, processTable } = await import(${JSON.stringify(source('../src/environment/process.ts'))});
    const { sampleProcesses } = await import(${JSON.stringify(source('../src/engine/stall-sweep.ts'))});
    const outcome = await command([process.execPath, '-e', 'setTimeout(() => {}, 1200)'], process.cwd(), { contain: true, timeoutMs: 30000 })
      .then(() => 'resolved', (e) => e.name + ': ' + (e.inventory ?? e.message));
    // Таймаут — снимок дерева синхронным ps при остановке.
    const timed = await command([process.execPath, '-e', 'setTimeout(() => {}, 5000)'], process.cwd(), { timeoutMs: 300 });
    const table = await processTable();
    const sample = await sampleProcesses();
    await new Promise((done) => setTimeout(done, 300));
    console.log(JSON.stringify({ outcome, thrown, unhandled, warnings, status: inventoryStatus, table: table.length, sample, tree: timed.diagnostics.processTree, timedOut: timed.timedOut }));
  `;
  const r = spawnSync(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--no-warnings',
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      script,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as {
    outcome: string;
    thrown: number;
    unhandled: string[];
    warnings: string[];
    status: { failures: number; last?: { tool: string; reason: string } };
    table: number;
    sample: unknown;
    tree?: { available: boolean; reason?: string };
    timedOut: boolean;
  };
  assert.ok(out.thrown >= 3, `запуск отказал синхронно ${out.thrown} раз`);
  assert.deepEqual(out.unhandled, [], 'необработанных отказов нет');
  // Без перечня потомки не пересчитаны: команда не считается завершённой
  // (отказ process-reap), но процесс-хост жив.
  assert.match(out.outcome, /^ReapFailure: .*EPERM.*перечень процессов недоступен/);
  assert.ok(out.status.failures >= 3);
  assert.match(out.status.last?.reason ?? '', /^(ps|lsof): запуск не удался \(EPERM\)/);
  assert.deepEqual(out.warnings, ['HARNESS_PROCESS_INVENTORY'], 'одно предупреждение на процесс');
  assert.equal(out.table, 0, 'нестрогая таблица — пустая, без исключения');
  assert.equal(out.sample, null, 'снимок обхода зависаний — null');
  assert.equal(out.timedOut, true);
  assert.equal(out.tree?.available, false);
  assert.match(out.tree?.reason ?? '', /EPERM/);
});

test('CR-3: redactThenClip маскирует до обрезки, хвост сохраняется', () => {
  const secret = 'SECRET-VALUE-0123456789';
  const redact = (t: string) => t.split(secret).join('[REDACTED]');
  const text = 'a'.repeat(95) + secret;
  // Обрезка до маски оставила бы «SECRE».
  assert.equal(redact(text.slice(0, 100)).includes('SECRE'), true);
  const clipped = redactThenClip(text, 100, redact);
  assert.equal(clipped, 'a'.repeat(95) + '[REDA');
  assert.ok(!clipped.includes('SECRE'));
  assert.equal(redactThenClip(text, 100, redact, ' / x'), 'a'.repeat(95) + '[' + ' / x');
  assert.equal(redactThenClip('abc', 2, undefined, 'xyz'), 'xy');
});

test('CR-3: ревью плана не сохраняет префикс секрета на границе обрезки', async () => {
  const { technicalReview } = await import('../src/control/review.ts');
  const { workGraphDigest } = await import('../src/contracts/work.ts');
  const secret = 'boundary-secret-value-7f3a9c';
  const prefix = secret.slice(0, 12);
  // Секрет начинается за 14 символов до предела поля.
  const straddle = (limit: number, fill = 'm') => fill.repeat(limit - 14) + secret + ' tail';
  const graph = graphOf({ a: [] });
  // Находка прежнего хоста приходит без маски; reviewer называет её состояние.
  const hosted = { severity: 'note' as const, message: straddle(12000), rule: straddle(200) };
  const hostedId = findingId(graph.id, hosted);
  const adapter = (runtime: RuntimeName): RuntimeAdapter => ({
    runtime,
    capabilities: () => Promise.resolve({ runtime, available: true } as any),
    invoke: () =>
      Promise.resolve({
        status: 'ok',
        text: '',
        model: null,
        runtimeVersion: 'controlled',
        output: {
          approved: false,
          summary: straddle(12000),
          findings: [
            { severity: 'blocking', message: straddle(12000, 'n'), rule: straddle(200, 'n') },
          ],
          previous: [{ id: hostedId, status: 'open', basis: straddle(4000) }],
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: 0,
          complete: true,
          source: 'claude-result',
        },
        diagnostics: { exitCode: 0 },
      }),
  });
  const adapters = { codex: adapter('codex'), claude: adapter('claude') };
  const policy = policyOf((p: any) => {
    p.environment = { inherit: [], values: {}, secrets: { REVIEW_TOKEN: 'CR3_REVIEW_TOKEN' } };
  });
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-cr3-'));
  const h = Harness.open({ policy, stateDir, baseDir: process.cwd(), adapters });
  try {
    const record = await technicalReview(h.engine, policy, adapters, {
      kind: 'plan',
      subject: graph.id,
      digest: workGraphDigest(graph),
      author: 'claude',
      instructions: ['Review the plan.'],
      cwd: process.cwd(),
      artifactDir: join(stateDir, 'reviews', `plan-${graph.id}-2`),
      denied: [stateDir],
      meta: { subjectId: graph.id, subjectKind: 'group' },
      environment: { ...process.env, CR3_REVIEW_TOKEN: secret },
      history: { rounds: 1, findings: [hosted] },
    });
    assert.equal(record.findings.length, 2, JSON.stringify(record.findings.map((f) => f.id)));
    const stored = JSON.stringify(h.engine.reviews('plan', graph.id));
    const artifact = readFileSync(record.artifact, 'utf8');
    const prompt = readFileSync(join(dirname(record.artifact), 'prompt.txt'), 'utf8');
    assert.ok(!prompt.includes(prefix), 'сохранённый запрос: находка хоста замаскирована');
    for (const [what, text] of [
      ['запись раунда', stored],
      ['артефакт', artifact],
    ] as const) {
      assert.ok(!text.includes(prefix), `${what}: префикс секрета не сохранён`);
      assert.ok(text.includes('mmmmmm['), `${what}: маска на месте`);
    }
    for (const f of record.findings) {
      assert.equal(f.message.length, 12000);
      assert.equal(f.rule?.length, 200);
    }
    assert.equal(record.summary.length, 12000);
    assert.equal(
      record.findings.find((f) => f.id === hostedId)?.basis?.length,
      4000,
      'основание перехода обрезано после маски',
    );
  } finally {
    h.close();
    if (stateDir.startsWith(join(tmpdir(), 'harness-cr3-')))
      rmSync(stateDir, { recursive: true, force: true });
  }
});

test('CR-3: основание перехода ревью кода маскируется до обрезки', () => {
  const secret = 'code-review-secret-91b2';
  const redact = (t: string) => t.split(secret).join('[REDACTED]');
  const id = 'c'.repeat(64);
  const history: CodeReviewHistory = {
    scope: 'd'.repeat(64),
    round: 1,
    findings: [
      {
        id,
        severity: 'blocking',
        message: 'm',
        path: null,
        line: null,
        status: 'open',
        origin: { runId: 'r', phase: 'candidate', sha: 'a'.repeat(40), round: 1, evidence: 'e' },
        openedIn: 1,
        changedIn: 1,
        transitions: [],
      },
    ],
  };
  const output = {
    approved: false,
    summary: 's',
    findings: [],
    previous: [{ id, status: 'closed', basis: 'b'.repeat(3990) + secret }],
  };
  const origin = { runId: 'r2', phase: 'candidate' as const, sha: 'a'.repeat(40) };
  const verdict = checkCodeReview(output, history, origin, { redact });
  assert.ok(verdict.valid, JSON.stringify(!verdict.valid && verdict.issues));
  const basis = verdict.transitions[0]!.basis;
  assert.equal(basis.length, 4000);
  assert.ok(!basis.includes(secret.slice(0, 8)), basis.slice(-20));
  assert.ok(basis.endsWith('[REDACTED]'.slice(0, 10)));
});
