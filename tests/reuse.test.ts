import { close, verdict } from './review-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { continuableDraft } from '../src/engine/reuse.ts';
import { approve, greet, implement, runAll, setup, target } from './runner-fixture.ts';

// Сбой канала reviewer после готового кандидата: отказ окружения, не кода.
const crash = {
  exit: 1,
  stderr: 'ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed',
};
// Runtime сам оборвал работу по своему пределу времени, успев изменить файлы.
const outOfTime = { exit: 143, stderr: 'исчерпан лимит времени прогона: 900 с', started: false };
/** Ревью исправленного кандидата закрывает выданную находку (ID — из запроса). */
const closing = verdict(true, { previous: [close(0, 'Поведение добавлено')] });
const reject = {
  result: {
    ...approve().result,
    approved: false,
    summary: 'Нет поведения',
    findings: [
      {
        severity: 'blocking',
        message: 'Нет поведения',
        path: null,
        line: null,
        rule: null,
        consequence: null,
        evidence: null,
      },
    ],
  },
};

function fixture(reviewer: unknown[], patch?: (p: Record<string, unknown>) => void) {
  const ctx = setup({
    scenario: { writer: implement(), reviewer },
    policy: (p) => {
      (p as { maxAttempts: number }).maxAttempts = 10;
      patch?.(p);
    },
  });
  const attempts = () => ctx.engine.read((v) => v.attempts('add-greeting'));
  const writes = () => {
    const file = `${ctx.scenarioPath}.claude.writer.count`;
    return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  };
  const reviews = () => {
    const file = `${ctx.scenarioPath}.codex.reviewer.count`;
    return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  };
  // Повтор — решение вне раннера; отказ окружения снимается вместе со своей паузой.
  const retry = (reason?: string) => {
    ctx.engine.retry('add-greeting', reason ? { reason } : undefined);
    ctx.engine.resume();
  };
  return { ctx, attempts, writes, reviews, retry };
}

test('T19: после обрыва reviewer повтор берёт готового кандидата и заново проходит gates и ревью', async () => {
  const f = fixture([crash, approve()]);
  await runAll(f.ctx);
  const [first] = f.attempts();
  assert.equal(first!.status, 'failed');
  assert.equal(first!.failureKind, 'environment', 'обрыв канала — отказ окружения');
  assert.ok(first!.candidateSha && first!.implementationBasis);
  assert.equal(f.writes(), 1);

  f.retry();
  await f.ctx.runner.drain();
  const second = f.attempts()[1]!;
  assert.equal(second.status, 'succeeded', second.error);
  assert.equal(f.writes(), 1, 'код не пишется заново');
  assert.deepEqual(second.reusedFrom, { runId: first!.id, candidateSha: first!.candidateSha });
  assert.equal(second.candidateSha, first!.candidateSha);
  assert.notEqual(second.token, first!.token, 'новая попытка — новое владение');
  // Проверки и ревью кандидата исполнены новой попыткой, а не взяты у старой.
  for (const kind of ['test', 'review'])
    assert.ok(
      second.evidence.some((e) => e.kind === kind && e.phase === 'candidate' && e.passed),
      kind + ' кандидата исполнены заново',
    );
  assert.equal(f.reviews(), 3, 'ревью кандидата повторено, плюс ревью интеграции');
  assert.ok(second.timings!.some((t) => t.stage === 'implementation-reuse' && t.finishedAt));
  assert.ok(!second.timings!.some((t) => t.stage === 'implementation'));
  assert.equal(f.attempts()[0]!.status, 'failed', 'прежняя попытка не переписана');
});

test('T19: кандидат не берётся при сдвинутой базе, после отказа ревью по существу и при другой версии движка', async () => {
  // После отказа по существу ревью кандидата называет выданную находку
  // (протокол переходов, docs/review-protocol.md): закрыта на исправленном коде.
  const f = fixture([crash, crash, reject, crash, closing, approve()]);
  // Сдвинутая база: основания разошлись — код пишется с нуля.
  await runAll(f.ctx);
  const ref = f.ctx.policy.repositories[0]!.targetRef;
  const tip = target(f.ctx);
  const moved = f.ctx.repo.git('commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'another change');
  f.ctx.repo.git('update-ref', ref, moved, tip);
  f.retry();
  await f.ctx.runner.drain();
  assert.equal(f.writes(), 2, 'новая база — новая реализация');
  assert.equal(f.attempts()[1]!.reusedFrom, undefined);

  // Отказ ревью по существу: кандидат плох, следующий повтор пишет код заново.
  f.retry();
  await f.ctx.runner.drain();
  assert.equal(f.attempts()[2]!.reusedFrom?.runId, f.attempts()[1]!.id, 'после обрыва — взят');
  assert.equal(f.writes(), 2);
  assert.equal(f.attempts()[2]!.failureKind, 'review');
  f.retry();
  await f.ctx.runner.drain();
  assert.equal(f.writes(), 3, 'отклонённый ревью кандидат не переиспользуется');
  assert.equal(f.attempts()[3]!.reusedFrom, undefined);
  assert.equal(f.attempts()[3]!.failureKind, 'environment');

  // Другая версия движка — другое основание: правила области и сборки запроса могли измениться.
  const { Engine } = await import('../src/engine/engine.ts');
  const { Runner } = await import('../src/engine/runner.ts');
  const { standaloneHost } = await import('../src/engine/standalone.ts');
  const { cliAdapter } = await import('../src/agents/cli-adapter.ts');
  const { bin } = await import('./runner-fixture.ts');
  const engine = new Engine({
    host: standaloneHost(f.ctx.store, f.ctx.policy),
    policy: f.ctx.policy,
    version: '9.9.9-other',
  });
  const runner = new Runner({
    engine,
    stateDir: f.ctx.state,
    baseDir: f.ctx.repo.dir,
    adapters: {
      claude: cliAdapter('claude', { executable: bin('fake-claude') }),
      codex: cliAdapter('codex', { executable: bin('fake-codex') }),
    },
    owner: 'runner-2',
    resourceDatabase: join(f.ctx.state, 'resources.sqlite'),
  });
  f.ctx.runner.release();
  // Три обрыва окружения после кандидата — предел незасчитанных отказов:
  // дальше повтор — только со сбросом человека.
  assert.throws(() => engine.retry('add-greeting'), /сбросом/);
  engine.retry('add-greeting', { reason: 'среда исправлена' });
  engine.resume();
  await runner.drain();
  assert.equal(f.writes(), 4, 'другая версия движка — новая реализация');
  assert.equal(f.attempts()[4]!.reusedFrom, undefined);
  assert.equal(f.attempts()[4]!.engineVersion, '9.9.9-other');
  assert.equal(
    engine.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  runner.release();
});

test('T19: при выключенном reuseImplementation кандидат после обрыва пишется заново', async () => {
  const f = fixture([crash, approve()], (p) => {
    (p as { reuseImplementation: boolean }).reuseImplementation = false;
  });
  await runAll(f.ctx);
  f.retry();
  await f.ctx.runner.drain();
  assert.equal(f.writes(), 2);
  assert.equal(f.attempts()[1]!.reusedFrom, undefined);
  assert.equal(f.attempts()[1]!.status, 'succeeded', f.attempts()[1]!.error);
});

test('T19: взятый кандидат проходит ту же проверку области, что и новый; ревью на недопустимого не тратится', async () => {
  const f = fixture([crash, approve()]);
  await runAll(f.ctx);
  const [first] = f.attempts();
  // Запись о кандидате подменена: коммит поверх той же базы меняет защищённый
  // тест-раннер. Совпавшие основания не делают такой код допустимым.
  const tree = mkdtempSync(join(tmpdir(), 'harness-tamper-'));
  f.ctx.repo.git('worktree', 'add', '--detach', tree, first!.baseSha!);
  writeFileSync(join(tree, 'test', 'run.js'), 'process.exit(0);\n');
  const git = (...args: string[]) =>
    f.ctx.repo.git('-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args);
  git('add', '-A');
  git('commit', '-qm', 'tamper');
  const tampered = git('rev-parse', 'HEAD');
  f.ctx.store.transact('run.failed', (tx) =>
    tx.putAttempt({ ...tx.attempt(first!.id)!, candidateSha: tampered }),
  );
  const before = target(f.ctx);
  const reviews = f.reviews();
  f.retry();
  await f.ctx.runner.drain();
  const second = f.attempts()[1]!;
  assert.equal(second.reusedFrom?.candidateSha, tampered);
  assert.equal(second.failureKind, 'scope-violation', second.error);
  assert.equal(f.reviews(), reviews, 'ревью на недопустимого кандидата не тратится');
  assert.equal(target(f.ctx), before);
});

test('Попытка, оборванная по времени, оставляет черновик; повтор начинает с него и знает об этом', async () => {
  const half = "exports.greet = (name) => 'Hel'; // половина работы\n";
  const ctx = setup({
    scenario: {
      writer: [
        { draftFiles: { 'src/greet.js': half }, ...outOfTime },
        { observe: ['src/greet.js'], recordPrompt: true, ...implement() },
      ],
      reviewer: approve(),
    },
  });
  await runAll(ctx);
  const attempts = () => ctx.engine.read((v) => v.attempts('add-greeting'));
  const [first] = attempts();
  assert.equal(first!.failureKind, 'timeout', first!.error);
  assert.deepEqual(first!.partial?.files, ['src/greet.js']);
  assert.equal(first!.candidateSha, undefined, 'черновик — не кандидат');

  ctx.engine.retry('add-greeting');
  await ctx.runner.drain();
  const second = attempts()[1]!;
  assert.equal(second.status, 'succeeded', second.error);
  const observed = JSON.parse(readFileSync(`${ctx.scenarioPath}.writer.1.observed`, 'utf8')) as {
    'src/greet.js': string | null;
  };
  assert.equal(observed['src/greet.js'], half, 'черновик наложен до работы исполнителя');
  assert.match(readFileSync(`${ctx.scenarioPath}.writer.1.prompt`, 'utf8'), /ran out of time/);
  assert.deepEqual(second.continuedFrom, {
    runId: first!.id,
    kind: 'unfinished',
    reason: 'timeout',
    applied: true,
    files: ['src/greet.js'],
  });
  assert.equal(ctx.repo.git('show', `${second.integrationSha}:src/greet.js`), greet.trimEnd());
  // Черновик под прежнюю постановку не выбрасывается, но помечается: его сверяют с новой.
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  const draft = ctx.engine.read((v) =>
    continuableDraft(v, { ...work, approvedDigest: 'f'.repeat(64) }, 'next'),
  );
  assert.equal(draft, undefined, 'после успешной попытки черновика нет');
  const respecified = ctx.engine.read((v) =>
    continuableDraft(
      { ...v, attempts: (id?: string) => v.attempts(id).slice(0, 1) },
      { ...work, approvedDigest: 'f'.repeat(64) },
      second.id,
    ),
  );
  assert.equal(respecified?.respecified, true);
});

test('Подменённый черновик не накладывается: попытка начинается с чистого дерева', async () => {
  const half = "exports.greet = () => 'x';\n";
  const ctx = setup({
    scenario: {
      writer: [
        { draftFiles: { 'src/greet.js': half }, ...outOfTime },
        { observe: ['src/greet.js'], ...implement() },
      ],
      reviewer: approve(),
    },
  });
  await runAll(ctx);
  const [first] = ctx.engine.read((v) => v.attempts('add-greeting'));
  writeFileSync(
    first!.partial!.patch,
    readFileSync(first!.partial!.patch, 'utf8') + '\n# tamper\n',
  );
  ctx.engine.retry('add-greeting');
  await ctx.runner.drain();
  const second = ctx.engine.read((v) => v.attempts('add-greeting')[1]!);
  const observed = JSON.parse(readFileSync(`${ctx.scenarioPath}.writer.1.observed`, 'utf8')) as {
    'src/greet.js': string | null;
  };
  assert.equal(observed['src/greet.js'], null, 'подменённый черновик не наложен');
  assert.equal(second.continuedFrom?.applied, false);
  assert.equal(second.status, 'succeeded', second.error);
});

test('Кандидат, отклонённый ревью, — отправная точка повтора, а не выброшенная работа', async () => {
  const ctx = setup({
    scenario: {
      writer: [implement(), { observe: ['src/greet.js'], recordPrompt: true, ...implement() }],
      reviewer: [reject, closing, approve()],
    },
  });
  await runAll(ctx);
  const [first] = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(first!.failureKind, 'review');
  ctx.engine.retry('add-greeting');
  await ctx.runner.drain();
  const second = ctx.engine.read((v) => v.attempts('add-greeting')[1]!);
  assert.equal(second.status, 'succeeded', second.error);
  const observed = JSON.parse(readFileSync(`${ctx.scenarioPath}.writer.1.observed`, 'utf8')) as {
    'src/greet.js': string | null;
  };
  assert.equal(observed['src/greet.js'], greet, 'изменения отклонённого кандидата наложены');
  assert.match(readFileSync(`${ctx.scenarioPath}.writer.1.prompt`, 'utf8'), /rejected by review/);
  assert.deepEqual(second.continuedFrom, {
    runId: first!.id,
    kind: 'candidate',
    reason: 'review',
    applied: true,
    files: ['src/greet.js'],
  });
  assert.equal(second.reusedFrom, undefined, 'отклонённый кандидат — черновик, не reuse');
});

test('Настоящий обрыв по лимиту времени: процесс исполнителя прерван, его изменения сохранены черновиком', async () => {
  const half = "exports.greet = (name) => 'Hel';\n";
  const ctx = setup({
    scenario: {
      writer: { draftFiles: { 'src/greet.js': half }, sleepMs: 30000, ...implement() },
      reviewer: approve(),
    },
    policy: (p) => {
      // Запас на загруженной машине: черновик пишется до обрыва, сон writer — 30 с.
      (p as { runTimeoutMs: number }).runTimeoutMs = 8000;
      (p as { maxAttempts: number }).maxAttempts = 1;
    },
  });
  await runAll(ctx);
  const [first] = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(first!.failureKind, 'timeout', first!.error);
  assert.deepEqual(first!.partial?.files, ['src/greet.js']);
  assert.match(readFileSync(first!.partial.patch, 'utf8'), /Hel/);
});

test('Черновик берётся у последней содержательной попытки; прерванная окружением и пустая пропускаются; переутверждение помечает', () => {
  const work = {
    id: 'w',
    approvedDigest: 'a'.repeat(64),
    approvedAt: '2026-01-01T00:00:00.000Z',
    order: { contracts: [] },
  } as unknown as Parameters<typeof continuableDraft>[1];
  const attempt = (id: string, over: Record<string, unknown>) =>
    ({
      id,
      workId: 'w',
      status: 'failed',
      startedAt: '2026-01-02T00:00:00.000Z',
      ...over,
    }) as never;
  const viewOf = (attempts: unknown[]) =>
    ({ attempts: () => attempts }) as unknown as Parameters<typeof continuableDraft>[0];
  const rejected = attempt('R1', {
    failureKind: 'review',
    candidateSha: 'c'.repeat(40),
    baseSha: 'b'.repeat(40),
  });
  const interrupted = attempt('R2', { failureKind: 'environment' });
  assert.equal(continuableDraft(viewOf([rejected, interrupted]), work, 'R3')?.runId, 'R1');
  assert.equal(continuableDraft(viewOf([rejected, interrupted]), work, 'R3')?.respecified, false);
  const reapproved = { ...work, approvedAt: '2026-01-03T00:00:00.000Z' };
  assert.equal(continuableDraft(viewOf([rejected]), reapproved, 'R3')?.respecified, true);
  const empty = attempt('R2b', { failureKind: 'unknown' });
  assert.equal(continuableDraft(viewOf([rejected, empty]), work, 'R3')?.runId, 'R1');
  const drafted = attempt('R2c', {
    failureKind: 'unknown',
    partial: {
      patch: '/p',
      digest: 'd'.repeat(64),
      files: ['a.ts'],
      spec: work.approvedDigest,
      contracts: {},
    },
  });
  const draft = continuableDraft(viewOf([rejected, drafted]), work, 'R3');
  assert.equal(draft?.runId, 'R2c');
  assert.equal(draft?.kind, 'unfinished');
  assert.equal(draft?.reason, 'unknown');
});
