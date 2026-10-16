import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { policyIssues } from '../src/contracts/index.ts';
import { approve, greet, implement, runAll, setup, target } from './runner-fixture.ts';

test('T01: поручение с тестами и двумя ревью принимается ровно один раз; result SHA в target ref; evidence обеих фаз', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  const before = target(ctx);
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'done', work.failure);
  const attempts = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempts.filter((a) => a.status === 'succeeded').length, 1, 'ровно одно принятие');
  const a = attempts[0]!;
  assert.equal(target(ctx), work.resultSha, 'target ref продвинут на result SHA');
  assert.equal(a.integrationSha, work.resultSha);
  assert.equal(
    ctx.repo.git('rev-parse', `${a.integrationSha}^1`),
    before,
    'интеграция поверх прежней принятой ветки',
  );
  assert.equal(ctx.repo.git('show', `${work.resultSha}:src/greet.js`), greet.trimEnd());
  const by = (kind: string, phase: string) =>
    a.evidence.filter((e) => e.kind === kind && e.phase === phase);
  assert.equal(by('test', 'candidate')[0]?.sha, a.candidateSha);
  assert.equal(by('test', 'integration')[0]?.sha, a.integrationSha);
  assert.equal(by('review', 'candidate')[0]?.sha, a.candidateSha);
  assert.equal(by('review', 'integration')[0]?.sha, a.integrationSha);
  assert.ok(a.evidence.every((e) => e.passed));
  assert.equal(a.runtime, 'claude');
  assert.equal(a.reviewer, 'codex');
  assert.ok(!existsSync(a.worktree!), 'рабочие деревья попытки убраны (G1)');
  assert.equal(
    ctx.repo.git('rev-parse', `harness/run-${a.id}`),
    a.candidateSha,
    'ветка кандидата сохранена для recovery и reuse',
  );
  const events = ctx.store.events().map((e) => e.type);
  assert.equal(events.filter((t) => t === 'work.accepted').length, 1);
  assert.ok(!JSON.stringify(ctx.store.events()).includes(a.token), 'токен не в событиях');
});

test('T31: cross-vendor пары claude → codex и codex → claude проходят; same-vendor по умолчанию отклонён до запуска', async () => {
  for (const [writer, reviewer] of [
    ['claude', 'codex'],
    ['codex', 'claude'],
  ] as const) {
    const ctx = setup({ writer, reviewer, scenario: { writer: implement(), reviewer: approve() } });
    await runAll(ctx);
    const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.equal(
      ctx.engine.read((v) => v.work('add-greeting')!.status),
      'done',
      `${writer}→${reviewer}`,
    );
    assert.equal(a.runtime, writer);
    assert.equal(a.reviewer, reviewer);
  }
  // Один вендор без явного разрешения: отказ политики и отказ выдачи, а не тихий запуск.
  const same = setup({
    writer: 'claude',
    reviewer: 'claude',
    scenario: { writer: implement(), reviewer: approve() },
  });
  assert.deepEqual(
    policyIssues(same.policy).map((i) => i.code),
    ['REVIEWER_SAME_VENDOR'],
  );
  await assert.rejects(runAll(same), /вендора/);
  assert.equal(
    same.engine.read((v) => v.attempts().length),
    0,
    'попытка не выдана',
  );
});

test('T05: выход за область записи и правка защищённого файла отклоняют попытку; target не двигается', async () => {
  for (const [files, reason] of [
    [
      { 'src/greet.js': greet, 'README.md': 'changed\n' },
      /вне области поручения\/роли: README\.md/,
    ],
    [
      { 'src/greet.js': greet, '.github/workflows/x.yml': 'x' },
      /защищённые файлы: \.github\/workflows\/x\.yml/,
    ],
    [{}, /Изменений нет/],
  ] as const) {
    const ctx = setup({
      scenario: { writer: implement(files), reviewer: approve() },
      policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 1),
    });
    const before = target(ctx);
    await runAll(ctx);
    const work = ctx.engine.read((v) => v.work('add-greeting')!);
    assert.equal(work.status, 'failed');
    assert.match(work.failure!, reason);
    assert.ok(['scope-violation', 'empty-result'].includes(work.failureKind!));
    assert.equal(target(ctx), before, 'target ref не продвинут');
  }
});

test('T08: невалидный ответ ревью, approved с блокирующей находкой и таймаут ревьюера — не принято, без самооценки writer', async () => {
  const blocking = approve();
  (blocking.result as { findings: unknown[] }).findings = [
    {
      severity: 'blocking',
      message: 'Нет обработки пустого имени',
      path: 'src/greet.js',
      line: 1,
      rule: null,
      consequence: null,
      evidence: null,
      reproduction: null,
    },
  ];
  const cases: [string, unknown, RegExp, string][] = [
    ['невалидный JSON', { raw: '{"approved": tru' }, /вне схемы|не прочитан/, 'review'],
    ['approved + blocking', blocking, /approved при блокирующей находке/, 'review'],
    ['таймаут', { ...approve(), sleepMs: 8000 }, /лимит времени/, 'timeout'],
  ];
  for (const [name, reviewer, reason, kind] of cases) {
    const ctx = setup({
      scenario: { writer: implement(), reviewer },
      policy: (p) => {
        (p as { maxAttempts: number }).maxAttempts = 1;
        if (name === 'таймаут') (p as { runTimeoutMs: number }).runTimeoutMs = 3000;
      },
    });
    const before = target(ctx);
    await runAll(ctx);
    const work = ctx.engine.read((v) => v.work('add-greeting')!);
    assert.equal(work.status, 'failed', name);
    assert.match(work.failure!, reason, name);
    assert.equal(work.failureKind, kind, name);
    assert.equal(target(ctx), before, name + ': target не двигается');
    const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.ok(!a.evidence.some((e) => e.kind === 'review' && e.passed), name + ': нет одобрения');
  }
});

test('T09: кандидат зелёный, интеграция красная — не принято, target не двигается', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 1),
  });
  ctx.repo.git('checkout', '-q', '-b', 'side');
  // Принятая ветка получает маркер, которого нет в базе кандидата: падает только integration.
  (await import('node:fs')).writeFileSync(ctx.repo.dir + '/FAIL_ON_INTEGRATION', 'x');
  ctx.repo.git('add', '-A');
  ctx.repo.git('commit', '-qm', 'marker');
  await ctx.runner.init();
  const marker = ctx.repo.git('rev-parse', 'HEAD');
  ctx.repo.git('checkout', '-q', 'main');
  const { trustNone, review } = await import('./engine-fixture.ts');
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(review(graph, 1));
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  // Между выдачей и интеграцией принятая ветка продвигается маркером (кандидат его не видит).
  ctx.engine.lead('runner-1');
  const tick = ctx.runner.tick();
  ctx.repo.git('update-ref', ctx.policy.repositories[0]!.targetRef, marker);
  await tick;
  await ctx.runner.drain();
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed');
  assert.ok(
    a.evidence.some((e) => e.phase === 'candidate' && e.kind === 'test' && e.passed),
    'кандидат зелёный',
  );
  assert.ok(
    a.evidence.some((e) => e.phase === 'integration' && e.kind === 'test' && !e.passed),
    'интеграция красная',
  );
  assert.equal(target(ctx), marker, 'target остался на чужом коммите');
});

test('T10: чужое продвижение target ref перед CAS — нет потери чужого коммита и ложного done; повтор от актуальной базы', async () => {
  // Ревьюер интеграции первой попытки продвигает принятую ветку чужим коммитом.
  const ctx = setup({
    scenario: {
      writer: implement(),
      reviewer: [approve(), { ...approve(), advance: true }, approve(), approve()],
    },
  });
  const fs = await import('node:fs');
  const path = ctx.scenarioPath;
  const scenario = JSON.parse(fs.readFileSync(path, 'utf8')) as {
    reviewer: Record<string, unknown>[];
  };
  scenario.reviewer[1] = { ...approve(), files: {} };
  fs.writeFileSync(path, JSON.stringify(scenario));
  await ctx.runner.init();
  const { trustNone, review } = await import('./engine-fixture.ts');
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(review(graph, 1));
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  ctx.engine.lead('runner-1');
  const ref = ctx.policy.repositories[0]!.targetRef;
  // Ждём фазу integrating и двигаем ref чужим коммитом, пока идёт integration review.
  const tick = ctx.runner.tick();
  let foreign = '';
  for (let i = 0; i < 400 && !foreign; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]);
    if (a?.phase === 'integrating') {
      const tree = ctx.repo.git('rev-parse', `${ref}^{tree}`);
      foreign = ctx.repo.git(
        'commit-tree',
        tree,
        '-p',
        ctx.repo.git('rev-parse', ref),
        '-m',
        'foreign',
      );
      ctx.repo.git('update-ref', ref, foreign);
    }
  }
  assert.ok(foreign, 'попытка дошла до интеграции');
  await tick;
  await ctx.runner.drain();
  const attempts = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempts[0]!.status, 'failed');
  assert.equal(attempts[0]!.failureKind, 'stale-base', attempts[0]!.error);
  ctx.engine.retry('add-greeting');
  await ctx.runner.drain();
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'done', work.failure);
  // merge-base --is-ancestor завершается ошибкой, если коммит не предок.
  ctx.repo.git('merge-base', '--is-ancestor', foreign, ref);
  assert.notEqual(target(ctx), foreign, 'принятая ветка продвинута поверх чужого коммита');
  assert.ok(readFileSync(path, 'utf8'));
});

test('T11: отказ setup и обязательной очистки — принятия нет, причина названа', async () => {
  const step = (id: string, code: number) => ({
    id,
    command: [process.execPath, '-e', `process.exit(${code})`],
  });
  for (const [lifecycle, reason] of [
    [{ setup: [step('boot', 3)], ready: [], teardown: [step('down', 0)] }, /Шаг boot: exit=3/],
    [{ setup: [], ready: [], teardown: [step('down', 4)] }, /Очистка окружения не завершена/],
  ] as const) {
    const ctx = setup({
      scenario: { writer: implement(), reviewer: approve() },
      policy: (p) => {
        (p as { repositories: Record<string, unknown>[] }).repositories[0]!.lifecycle = lifecycle;
        (p as { maxAttempts: number }).maxAttempts = 1;
      },
    });
    const before = target(ctx);
    await runAll(ctx);
    const work = ctx.engine.read((v) => v.work('add-greeting')!);
    assert.equal(work.status, 'failed');
    assert.match(work.failure!, reason);
    assert.equal(target(ctx), before);
  }
});

test('T14: штатная остановка посреди попытки — пауза shutdown, отказ окружения, не отмена; после рестарта работа доходит до конца', async () => {
  const ctx = setup({
    scenario: { writer: [{ ...implement(), sleepMs: 4000 }, implement()], reviewer: approve() },
  });
  await ctx.runner.init();
  const { trustNone, review } = await import('./engine-fixture.ts');
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(review(graph, 1));
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  await ctx.runner.tick();
  for (let i = 0; i < 100 && ctx.engine.read((v) => v.attempts()[0]?.phase) !== 'running'; i++)
    await new Promise((r) => setTimeout(r, 20));
  await ctx.runner.stop();
  const control = ctx.engine.read((v) => v.control());
  assert.equal(control.pauseReason, 'shutdown', 'остановка — не отмена и не пауза человека');
  const first = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(first.status, 'failed');
  // Работа runtime уже началась: как в DevContour, это засчитанная попытка с отказом окружения.
  assert.equal(first.failureKind, 'environment');
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'failed',
    'не cancelled: остановка — не отмена',
  );
  // Рестарт: новый процесс снимает паузу остановки, повторяет поручение явно и доводит его.
  ctx.engine.resume();
  ctx.engine.retry('add-greeting');
  await ctx.runner.drain();
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
  );
});

test('T10: merge conflict с продвинутой принятой веткой — класс merge, target с чужим коммитом не теряется', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 1),
  });
  await ctx.runner.init();
  const { trustNone, review } = await import('./engine-fixture.ts');
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(review(graph, 1));
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  ctx.engine.lead('runner-1');
  const ref = ctx.policy.repositories[0]!.targetRef;
  const tick = ctx.runner.tick();
  let foreign = '';
  for (let i = 0; i < 400 && !foreign; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (ctx.engine.read((v) => v.attempts()[0]?.phase) === 'reviewing') {
      // Чужая работа создаёт тот же файл с другим содержимым.
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: ctx.repo.dir,
        input: 'exports.greet = () => 1;\n',
        encoding: 'utf8',
      }).trim();
      const index = join(ctx.state, 'foreign-index');
      const env = { ...process.env, GIT_INDEX_FILE: index };
      execFileSync('git', ['read-tree', ref], { cwd: ctx.repo.dir, env });
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},src/greet.js`], {
        cwd: ctx.repo.dir,
        env,
      });
      const tree = execFileSync('git', ['write-tree'], {
        cwd: ctx.repo.dir,
        env,
        encoding: 'utf8',
      }).trim();
      foreign = ctx.repo.git(
        'commit-tree',
        tree,
        '-p',
        ctx.repo.git('rev-parse', ref),
        '-m',
        'foreign',
      );
      ctx.repo.git('update-ref', ref, foreign);
    }
  }
  assert.ok(foreign);
  await tick;
  await ctx.runner.drain();
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'merge', work.failure);
  assert.equal(target(ctx), foreign, 'чужой коммит остался вершиной принятой ветки');
});

test('T11: занятый ресурс — попытка ждёт и не отнимает его по сроку; после освобождения ресурс снова свободен', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      (p as { resources: unknown[] }).resources = [
        { id: 'device', kind: 'device', value: 'phone-1' },
      ];
      (p as { runTimeoutMs: number }).runTimeoutMs = 6000;
      (p as { maxAttempts: number }).maxAttempts = 1;
    },
    graph: (g) => ((g as { orders: { resources?: string[] }[] }).orders[0]!.resources = ['device']),
  });
  const { ResourcePool } = await import('../src/environment/resources.ts');
  const pool = new ResourcePool(join(ctx.state, 'resources.sqlite'));
  assert.equal(
    pool.tryAcquire(
      [{ id: 'device', kind: 'device', value: 'phone-1' }],
      'other',
      'other-token',
      5000,
    ),
    true,
  );
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'timeout', work.failure);
  assert.equal(pool.list().length, 1, 'чужая аренда не отнята');
  assert.equal(pool.list()[0]!.owner, 'other');
  pool.release('other-token');
  ctx.engine.retry('add-greeting', { reason: 'ресурс освобождён' });
  await ctx.runner.drain();
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  assert.deepEqual(pool.list(), [], 'ресурс освобождён после попытки');
  assert.deepEqual(
    ctx.engine.read((v) => v.attempts('add-greeting').at(-1)!.resources)?.map((r) => r.id),
    ['device'],
  );
  pool.close();
});

test('T07: reviewer, изменивший дерево, не одобряет — даже при approved', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: { ...approve(), files: { 'src/extra.js': 'x' } } },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 1),
  });
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed');
  assert.match(work.failure!, /reviewer изменил дерево или HEAD/);
  assert.equal(work.failureKind, 'review');
});
