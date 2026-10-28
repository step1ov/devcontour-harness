import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runner } from '../src/engine/runner.ts';
import { BlockedError } from '../src/engine/classify.ts';
import {
  TaskFailure,
  policyIssues,
  type AttemptState,
  type EvidenceRecord,
} from '../src/contracts/index.ts';
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
  // Один вендор без явного разрешения: отказ политики и блокер выдачи, а не тихий запуск.
  const same = setup({
    writer: 'claude',
    reviewer: 'claude',
    scenario: { writer: implement(), reviewer: approve() },
  });
  assert.deepEqual(
    policyIssues(same.policy).map((i) => i.code),
    ['REVIEWER_SAME_VENDOR'],
  );
  await runAll(same);
  assert.deepEqual(
    same.engine.read((v) => same.engine.blockers(v.work('add-greeting')!, v).map((b) => b.code)),
    ['REVIEWER_SAME_VENDOR'],
  );
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
    // Ошибка протокола (docs/review-protocol.md): повтор reviewer, затем
    // остановка REVIEW_PROTOCOL_INVALID — не содержательный отказ и не accepted.
    [
      'невалидный JSON',
      { raw: '{"approved": tru' },
      /REVIEW_PROTOCOL_INVALID.*(schema|не прочитан)/,
      'review-protocol',
    ],
    [
      'approved + blocking',
      blocking,
      /REVIEW_PROTOCOL_INVALID.*approved-with-blocking/,
      'review-protocol',
    ],
    ['таймаут', { ...approve(), sleepMs: 15000 }, /лимит времени/, 'timeout'],
  ];
  for (const [name, reviewer, reason, kind] of cases) {
    const ctx = setup({
      scenario: { writer: implement(), reviewer },
      policy: (p) => {
        (p as { maxAttempts: number }).maxAttempts = 1;
        if (name === 'таймаут') (p as { runTimeoutMs: number }).runTimeoutMs = 8000;
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
  const { trustNone, planReview } = await import('./engine-fixture.ts');
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(planReview(ctx.engine, graph, 1));
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
  // Стойкий провал повторён один раз на том же SHA и подтверждён: обе записи
  // остаются, класс отказа прежний.
  const integration = a.evidence.filter((e) => e.phase === 'integration' && e.kind === 'test');
  assert.equal(integration.length, 2, 'один повтор, не больше');
  assert.equal(integration[1]!.sha, integration[0]!.sha);
  assert.deepEqual(integration[1]!.recheck, { of: integration[0]!.id, outcome: 'confirmed' });
  assert.equal(a.failureKind, 'gate');
});

test('Провал gate интеграции из-за среды повторяется на том же кандидате: повтор прошёл — принятие без новой реализации, повтор помечен flaky со ссылкой на первую запись', async () => {
  const state = mkdtempSync(join(tmpdir(), 'harness-flaky-'));
  const counter = join(state, 'integration-runs');
  // Gate падает на первом запуске интеграции (счётчик вне worktree), дальше — обычный тест.
  const flaky = `
const fs = require('fs');
const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0;
if (process.env.DEVCONTOUR_PHASE === 'integration') fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
if (process.env.DEVCONTOUR_PHASE === 'integration' && n === 0) {
  fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase classname="greet" name="greets"><failure message="budget exceeded"/></testcase></testsuite>');
  process.exit(1);
}
require('./run.js');
`;
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    files: { 'test/flaky.js': flaky },
    policy: (p) => {
      const raw = p as { maxAttempts: number; repositories: { gates: { command: string[] }[] }[] };
      raw.maxAttempts = 1;
      raw.repositories[0]!.gates[0]!.command = [process.execPath, 'test/flaky.js'];
    },
  });
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'done', work.failure);
  const attempts = ctx.engine.read((v) => v.attempts('add-greeting'));
  assert.equal(attempts.length, 1, 'повтор не стоил новой попытки и реализации');
  const a = attempts[0]!;
  const integration = a.evidence.filter((e) => e.phase === 'integration' && e.kind === 'test');
  assert.equal(integration.length, 2);
  assert.equal(integration[0]!.passed, false);
  assert.equal(integration[1]!.passed, true);
  assert.equal(integration[1]!.sha, a.integrationSha);
  assert.deepEqual(integration[1]!.recheck, { of: integration[0]!.id, outcome: 'flaky' });
  assert.notEqual(integration[0]!.log, integration[1]!.log, 'лог первого запуска сохранён');
  assert.match(readFileSync(integration[0]!.log, 'utf8'), /budget exceeded|1 failures/);
  assert.equal(readFileSync(counter, 'utf8'), '2');
  type GatePayload = { phase: string; recheck?: { outcome: string } };
  const gateEvents = ctx.store
    .events()
    .filter((e) => e.type === 'attempt.gate')
    .map((e) => e.payload as GatePayload)
    .filter((p) => p.phase === 'integration');
  assert.deepEqual(
    gateEvents.map((p) => p.recheck?.outcome ?? null),
    [null, 'flaky'],
  );
  assert.ok(
    a.timings?.some((t) => t.stage.startsWith('integration-recheck:')),
    'повтор — отдельная стадия замеров',
  );
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
  const { trustNone, planReview } = await import('./engine-fixture.ts');
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(planReview(ctx.engine, graph, 1));
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  ctx.engine.lead('runner-1');
  const ref = ctx.policy.repositories[0]!.targetRef;
  // Ждём фазу integrating и двигаем ref чужим коммитом, пока идёт integration review.
  const tick = ctx.runner.tick();
  let foreign = '';
  // Запас под нагрузкой полного check: до integrating может пройти больше 10 с.
  for (let i = 0; i < 2400 && !foreign; i++) {
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

test('T14: штатная остановка посреди попытки — пауза shutdown, работа снова в очереди без траты попытки; после рестарта продолжается с черновика', async () => {
  const draft = "exports.greet = (name) => 'Hello, ' + name; // черновик\n";
  const ctx = setup({
    scenario: {
      writer: [
        { ...implement(), draftFiles: { 'src/greet.js': draft }, sleepMs: 15000 },
        { ...implement(), observe: ['src/greet.js'] },
      ],
      reviewer: approve(),
    },
  });
  await ctx.runner.init();
  const { trustNone, planReview } = await import('./engine-fixture.ts');
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(planReview(ctx.engine, graph, 1));
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  await ctx.runner.tick();
  for (let i = 0; i < 100 && ctx.engine.read((v) => v.attempts()[0]?.phase) !== 'running'; i++)
    await new Promise((r) => setTimeout(r, 20));
  // Черновик исполнителя уже в дереве, когда приходит остановка.
  const tree = () => ctx.engine.read((v) => v.attempts()[0]?.worktree);
  for (let i = 0; i < 200 && !(tree() && existsSync(join(tree()!, 'src/greet.js'))); i++)
    await new Promise((r) => setTimeout(r, 25));
  await ctx.runner.stop();
  const control = ctx.engine.read((v) => v.control());
  assert.equal(control.pauseReason, 'shutdown', 'остановка — не отмена и не пауза человека');
  assert.equal(control.pauseFailures, undefined, 'остановка — не неисправность окружения');
  const first = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(first.status, 'failed');
  assert.equal(first.failureKind, 'environment');
  assert.equal(first.interrupted, 'shutdown');
  assert.ok(first.partial, 'черновик прерванной попытки сохранён');
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'ready', 'не failed и не cancelled: работа снова в очереди');
  assert.equal(work.attempt, 0, 'прерванная попытка не засчитана');
  assert.equal(work.failure, undefined);
  // Рестарт: снятая пауза остановки сразу выдаёт работу — без retry и сброса.
  ctx.engine.resume();
  await ctx.runner.drain();
  const done = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(done.status, 'done');
  assert.equal(done.attempt, 1);
  const second = ctx.engine.read((v) => v.attempts('add-greeting')[1]!);
  assert.equal(second.continuedFrom?.runId, first.id, 'продолжение прерванной попытки');
  const observed = JSON.parse(
    readFileSync(`${ctx.scenarioPath}.writer.1.observed`, 'utf8'),
  ) as Record<string, string | null>;
  assert.equal(observed['src/greet.js'], draft, 'следующий исполнитель застал черновик');
});

test('T10: merge conflict с продвинутой принятой веткой — класс merge, target с чужим коммитом не теряется', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 1),
  });
  await ctx.runner.init();
  const { trustNone, planReview } = await import('./engine-fixture.ts');
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(planReview(ctx.engine, graph, 1));
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  ctx.engine.lead('runner-1');
  const ref = ctx.policy.repositories[0]!.targetRef;
  const tick = ctx.runner.tick();
  let foreign = '';
  // Запас под нагрузкой полного check: до integrating может пройти больше 10 с.
  for (let i = 0; i < 2400 && !foreign; i++) {
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

test('T11: занятый ресурс — попытка ждёт и не отнимает его по сроку; отказ по лимиту времени', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      (p as { resources: unknown[] }).resources = [
        { id: 'device', kind: 'device', value: 'phone-1' },
      ];
      (p as { runTimeoutMs: number }).runTimeoutMs = 3000;
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
  assert.equal(
    ctx.engine.read((v) => v.attempts('add-greeting')[0]!.worktree),
    undefined,
    'до ресурса работа не начиналась',
  );
  assert.equal(pool.list().length, 1, 'чужая аренда не отнята, хотя её срок истёк');
  assert.equal(pool.list()[0]!.owner, 'other');
  pool.close();
});

test('T11: ресурс резервируется на всю попытку и освобождается после неё', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) =>
      ((p as { resources: unknown[] }).resources = [
        { id: 'device', kind: 'device', value: 'phone-1' },
      ]),
    graph: (g) => ((g as { orders: { resources?: string[] }[] }).orders[0]!.resources = ['device']),
  });
  await runAll(ctx);
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  const { ResourcePool } = await import('../src/environment/resources.ts');
  const pool = new ResourcePool(join(ctx.state, 'resources.sqlite'));
  assert.deepEqual(pool.list(), [], 'аренда освобождена после попытки');
  pool.close();
  assert.deepEqual(
    ctx.engine.read((v) => v.attempts('add-greeting')[0]!.resources)?.map((r) => r.id),
    ['device'],
  );
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

test('CAS приёмки не исполняет hooks репозитория: hook reference-transaction на target ref не запускается и не может сорвать приёмку', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  const marker = join(ctx.state, 'hook-ran');
  const ref = ctx.policy.repositories[0]!.targetRef;
  // Hook реагирует только на target ref: ветки кандидата и worktree его не трогают.
  const hook = join(ctx.repo.dir, '.git', 'hooks', 'reference-transaction');
  writeFileSync(
    hook,
    `#!/bin/sh\nif grep -q ' ${ref}$'; then touch ${JSON.stringify(marker)}; exit 1; fi\nexit 0\n`,
  );
  chmodSync(hook, 0o755);
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'done', work.failure);
  assert.equal(target(ctx), work.resultSha);
  assert.equal(existsSync(marker), false, 'hook внутри транзакции приёмки не запускался');
});

test('Зависший git update-ref приёмки останавливается своим пределом: принятия нет, target неподвижен', async () => {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 1),
  });
  const shim = mkdtempSync(join(tmpdir(), 'harness-git-shim-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  const ref = ctx.policy.repositories[0]!.targetRef;
  // Зависает только продвижение target ref приёмкой.
  writeFileSync(
    join(shim, 'git'),
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = ${JSON.stringify(ref)} ] && [ "$3" = update-ref ] && exec sleep 60; done\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(join(shim, 'git'), 0o755);
  const before = target(ctx);
  const path = process.env.PATH;
  const limit = Runner.refTimeoutMs;
  Runner.refTimeoutMs = 2000;
  process.env.PATH = `${shim}:${path}`;
  const started = Date.now();
  try {
    await runAll(ctx);
  } finally {
    process.env.PATH = path;
    Runner.refTimeoutMs = limit;
  }
  assert.ok(Date.now() - started < 50_000, 'приёмка не ждала зависший git');
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.notEqual(work.status, 'done');
  assert.equal(target(ctx), before, 'target неподвижен');
});

test('S2.3: хост без проверки политики — недопустимое назначение reviewer одной роли держит только её поручение', async () => {
  // Engine используется хостом напрямую (без validateInputs): блокер поручения
  // вместо отказа всей выдачи.
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => {
      (p as { roles: Record<string, unknown> }).roles.ops = {
        writer: { runtime: 'codex' },
        review: { reviewer: { runtime: 'codex' } },
      };
    },
    graph: (g) => {
      const orders = (g as { orders: Record<string, unknown>[] }).orders;
      orders.unshift({
        ...structuredClone(orders[0]!),
        id: 'ops-first',
        source: { connector: 'files', ref: 'ops-first', revision: '1' },
        title: 'Ops order',
        role: 'ops',
      });
    },
  });
  await runAll(ctx);
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
    'допустимая пара выдана',
  );
  const blockers = ctx.engine.read((v) => ctx.engine.blockers(v.work('ops-first')!, v));
  const blocker = blockers.find((b) => b.code === 'REVIEWER_SAME_VENDOR');
  assert.ok(blocker, 'блокер назначения reviewer');
  assert.match(blocker.message, /same-vendor-allowed/);
  assert.equal(
    ctx.engine.read((v) => v.attempts('ops-first').length),
    0,
    'ops не выдано',
  );
  assert.equal(
    existsSync(ctx.scenarioPath + '.codex.writer.count'),
    false,
    'writer ops не вызывался',
  );
});

test('Хуки хоста: сведения в запросах writer и reviewer, отчёт writer после коммита кандидата; асинхронный контекст; отказ хука — отказ попытки', async () => {
  const seen: { sha: string; summary: string }[] = [];
  const ctx = setup({
    scenario: {
      writer: { ...implement(), recordPrompt: true },
      reviewer: { ...approve(), recordPrompt: true },
    },
    runner: {
      context: () => Promise.resolve(undefined),
      hooks: {
        notes: ({ review }) =>
          Promise.resolve([review ? 'HOST-REVIEWER-NOTE' : 'HOST-WRITER-NOTE']),
        implemented: ({ output, sha }) => {
          seen.push({ sha, summary: output.summary });
        },
      },
    },
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  const writer = readFileSync(ctx.scenarioPath + '.writer.0.prompt', 'utf8');
  assert.match(writer, /HOST-WRITER-NOTE/);
  assert.doesNotMatch(writer, /HOST-REVIEWER-NOTE/);
  // Ревью плана в фикстуре записано без вызова: ревью кандидата — первый вызов reviewer.
  assert.match(readFileSync(ctx.scenarioPath + '.reviewer.0.prompt', 'utf8'), /HOST-REVIEWER-NOTE/);
  assert.deepEqual(seen, [{ sha: a.candidateSha, summary: 'Добавлена greet' }]);

  const failing = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 1),
    runner: {
      hooks: {
        implemented: () => {
          throw new Error('хост не записал находки');
        },
      },
    },
  });
  const before = target(failing);
  await runAll(failing);
  const f = failing.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(f.status, 'failed');
  assert.match(f.error!, /хост не записал находки/);
  assert.equal(target(failing), before, 'без приёмки');
});

test('Хуки хоста prepared и failed, предмет вызова runtime: отказ prepared — отказ окружения до worktree; failed видит класс отказа', async () => {
  const subjects: unknown[] = [];
  const failures: { kind: string; message: string }[] = [];
  const bases: string[] = [];
  let refuse = false;
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 2),
    runner: {
      hooks: {
        prepared: ({ baseSha }) => {
          bases.push(baseSha);
          if (refuse) throw new BlockedError('база без закреплённого файла хоста');
        },
        failed: ({ kind, message }) => {
          failures.push({ kind, message });
        },
      },
    },
  });
  // Предмет вызова виден адаптеру: поручение, попытка, фаза.
  for (const [name, adapter] of Object.entries(ctx.runner.options.adapters)) {
    const inner = adapter;
    (ctx.runner.options.adapters as Record<string, unknown>)[name] = {
      ...inner,
      invoke: (request: { subject?: unknown }, signal: AbortSignal) => {
        subjects.push(request.subject);
        return inner.invoke(request as never, signal);
      },
    };
  }
  refuse = true;
  await runAll(ctx);
  const first = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(first.status, 'failed');
  assert.equal(first.failureKind, 'environment');
  assert.equal(first.worktree, undefined, 'работа не начиналась');
  assert.deepEqual(failures, [
    { kind: 'environment', message: 'база без закреплённого файла хоста' },
  ]);
  assert.equal(bases[0], target(ctx));
  refuse = false;
  // Отказ окружения остановил выдачу (он повторился бы на любой работе).
  assert.equal(
    ctx.engine.read((v) => v.control().paused),
    true,
  );
  ctx.engine.retry('add-greeting');
  ctx.engine.resume();
  await ctx.runner.drain();
  const second = ctx.engine.read((v) => v.attempts('add-greeting')[1]!);
  assert.equal(second.status, 'succeeded', second.error);
  assert.deepEqual(subjects[0], {
    workId: 'add-greeting',
    attemptId: second.id,
    phase: 'candidate',
  });
  assert.ok(
    subjects.some((s) => (s as { phase: string }).phase === 'integration'),
    'ревью интеграции — с фазой',
  );
});

test('Замеры стадий попытки: реализация, gates и ревью каждой фазы, ожидание интеграции', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  const stages = (a.timings ?? []).map((t) => [t.stage, t.outcome]);
  for (const stage of [
    'implementation',
    'candidate-test:unit',
    'candidate-review',
    'integration-wait',
    'integration-test:unit',
    'integration-review',
  ])
    assert.ok(
      stages.some(([s, o]) => s === stage && o === 'passed'),
      `${stage}: ${JSON.stringify(stages)}`,
    );
});

test('Короткий секрет маскирует текст ревью, но не служебные значения записи (вид наблюдения, источник)', async () => {
  // Часть служебного значения вида наблюдения («diff-only»); JSON ответа CLI не задевает.
  process.env.HARNESS_TEST_SHORT_SECRET = 'f-on';
  try {
    const ctx = setup({
      scenario: { writer: implement(), reviewer: approve() },
      policy: (p) => {
        (p as { environment: { secrets: Record<string, string> } }).environment.secrets = {
          SHORT: 'HARNESS_TEST_SHORT_SECRET',
        };
      },
    });
    await runAll(ctx);
    const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.equal(a.status, 'succeeded', a.error);
    const reviews = a.evidence.filter((e) => e.kind === 'review');
    assert.equal(reviews.length, 2);
    for (const e of reviews) {
      assert.match(e.inspection?.source ?? '', /^(codex-events|unavailable)$/);
      assert.equal(e.inspection?.mode, 'diff-only', 'вид наблюдения не замаскирован');
      const stored = JSON.parse(readFileSync(e.log, 'utf8')) as { inspection: { source: string } };
      assert.equal(stored.inspection.source, e.inspection?.source);
    }
  } finally {
    delete process.env.HARNESS_TEST_SHORT_SECRET;
  }
});

test('stateDirFor: рабочие деревья и артефакты попытки — в каталоге её репозитория', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-component-'));
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    runner: { stateDirFor: () => dir },
  });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  assert.ok(a.worktree!.startsWith(join(dir, 'worktrees')), a.worktree);
  assert.ok(existsSync(join(dir, 'artifacts', a.id)), 'артефакты попытки у репозитория');
  assert.equal(existsSync(join(ctx.state, 'artifacts', a.id)), false);
});

test('Предел времени — на фазу: ревью интеграции не получает остаток времени её проверок', async (t) => {
  const budget = 8000;
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (raw) => {
      (raw as { runTimeoutMs: number }).runTimeoutMs = budget;
    },
  });
  // Управляем таймерами с лимитом runTimeoutMs только в этом тесте. Git,
  // gate и CLI-reviewer реальны; время учитываем по их настоящему evidence.
  // Gate тратит 4 с, review — 5 с: вместе больше 8 с, по отдельности меньше.
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const recordEvidence = ctx.engine.evidence.bind(ctx.engine);
  const timers = new Map<NodeJS.Timeout, { at: number; fire: () => void }>();
  const phases: string[] = [];
  let clock = 0;
  try {
    t.mock.method(
      globalThis,
      'setTimeout',
      (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (ms !== budget) return nativeSetTimeout(callback, ms, ...args);
        const timer = nativeSetTimeout(() => {}, 2 ** 31 - 1);
        timer.unref();
        timers.set(timer, { at: clock + budget, fire: () => callback(...args) });
        return timer;
      },
    );
    t.mock.method(globalThis, 'clearTimeout', (timer: Parameters<typeof clearTimeout>[0]) => {
      if (timer && typeof timer === 'object') timers.delete(timer);
      nativeClearTimeout(timer);
    });
    t.mock.method(ctx.engine, 'evidence', (...args: Parameters<typeof ctx.engine.evidence>) => {
      const result = recordEvidence(...args);
      const evidence = args[2];
      if (evidence.kind === 'test' || evidence.kind === 'review') {
        phases.push(`${evidence.phase}:${evidence.kind}`);
        assert.ok(timers.size > 0, 'таймер бюджета действительно установлен');
        clock += evidence.kind === 'test' ? 4000 : 5000;
        for (const [timer, pending] of timers) {
          if (pending.at > clock) continue;
          timers.delete(timer);
          nativeClearTimeout(timer);
          pending.fire();
        }
      }
      return result;
    });
    await runAll(ctx);
    const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.equal(a.status, 'succeeded', a.error);
    assert.deepEqual(phases, [
      'candidate:test',
      'candidate:review',
      'integration:test',
      'integration:review',
    ]);
    assert.ok(clock > budget, 'сумма фаз превысила один бюджет');
    assert.equal(timers.size, 0, 'таймер завершённой попытки снят');
  } finally {
    for (const timer of timers.keys()) nativeClearTimeout(timer);
    t.mock.restoreAll();
  }
});

test('Повтор gate интеграции: только после зелёного кандидата, один на кандидата и не при контрпримере свойства или корпуса', async () => {
  const candidateSha = 'c'.repeat(40);
  const sha = 'd'.repeat(40);
  const attempt = { id: 'r1', workId: 'w', candidateSha } as AttemptState;
  const record = (phase: 'candidate' | 'integration', passed: boolean, extra = {}) =>
    ({
      id: `${phase}-${passed}`,
      kind: 'test',
      gate: 'unit',
      phase,
      sha: phase === 'candidate' ? candidateSha : sha,
      passed,
      ...extra,
    }) as EvidenceRecord;
  const report = (failed: { property?: boolean; corpus?: boolean }) => ({
    property: {
      report: {
        version: 1,
        properties: [{ testId: 'p', status: failed.property ? 'failed' : 'passed', cases: 3 }],
        corpus: {
          executed: 1,
          passed: failed.corpus ? 0 : 1,
          failed: failed.corpus ? [{ id: 'k1', property: 'p' }] : [],
        },
      },
    },
  });
  type IntegrationGate = (...args: unknown[]) => Promise<void>;
  const integrationGate = (Runner.prototype as unknown as { integrationGate: IntegrationGate })
    .integrationGate;
  /** Повторы, которые запросил разбор провала: ID повторённой записи по порядку запусков. */
  const runs = async (
    evidence: EvidenceRecord[],
    others: { candidateSha: string; evidence: Partial<EvidenceRecord>[] }[] = [],
    budget = { recheck: true },
  ) => {
    const calls: unknown[] = [];
    const fake = {
      engine: {
        read: (fn: (v: unknown) => unknown) =>
          fn({
            attempt: () => ({ evidence }),
            attempts: () => [{ candidateSha, evidence }, ...others],
          }),
      },
      gate: (...args: unknown[]) => {
        calls.push(args[9]);
        return Promise.reject(new TaskFailure('gate', 'integration/unit: red'));
      },
    };
    await assert.rejects(
      integrationGate.call(
        fake,
        attempt,
        '/w',
        sha,
        { id: 'unit' },
        '/a',
        new AbortController().signal,
        {},
        budget,
      ),
      TaskFailure,
    );
    return calls;
  };
  const green = record('candidate', true);
  const red = record('integration', false);
  assert.deepEqual(await runs([green, red]), [undefined, red.id], 'обычный провал повторён');
  assert.deepEqual(await runs([record('candidate', false), red]), [undefined], 'красный кандидат');
  assert.deepEqual(await runs([red]), [undefined], 'кандидат не проверен');
  assert.deepEqual(
    await runs(
      [green, red],
      [{ candidateSha, evidence: [{ recheck: { of: 'x', outcome: 'confirmed' } }] }],
    ),
    [undefined],
    'тот же кандидат уже повторялся в другой попытке',
  );
  assert.deepEqual(
    await runs(
      [green, red],
      [{ candidateSha: 'e'.repeat(40), evidence: [{ recheck: { of: 'x', outcome: 'flaky' } }] }],
    ),
    [undefined, red.id],
    'повтор другого кандидата бюджет не тратит',
  );
  assert.deepEqual(
    await runs([green, red], [], { recheck: false }),
    [undefined],
    'бюджет интеграции исчерпан',
  );
  for (const failed of [{ property: true }, { corpus: true }])
    assert.deepEqual(
      await runs([green, record('integration', false, report(failed))]),
      [undefined],
      `контрпример не повторяется: ${JSON.stringify(failed)}`,
    );
  assert.deepEqual(
    await runs([green, record('integration', false, report({}))]),
    [undefined, red.id],
    'отчёт свойств без провалов не мешает повтору',
  );
});
