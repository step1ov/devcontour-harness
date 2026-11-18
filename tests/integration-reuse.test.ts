/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
 * Фикстура правит сырой JSON политики и подделывает переносимый результат.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HarnessError,
  digestOf,
  executionDigest,
  executionPolicySchema,
  integrationReuseProblem,
  runResultSchema,
  sha256,
  type AttemptState,
  type EvidenceRecord,
  type RunResult,
  valueReportSchema,
} from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { runResult } from '../src/engine/result.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { resultProblems, type ReceiverContext } from '../src/verification/acceptance.ts';
import { reusedEvidenceProblem } from '../src/verification/integration-reuse.ts';
import { attemptView } from '../src/projections/attempt.ts';
import { valueReport } from '../src/report/compute.ts';
import { reportMarkdown } from '../src/report/index.ts';
import { planReview, trustNone } from './engine-fixture.ts';
import { approve, greet, implement, runAll, setup, target } from './runner-fixture.ts';
import { components, node } from './components-fixture.ts';
import { write } from './git-fixture.ts';

/** Счётчик запусков вне репозитория: строка на запуск, `метка:фаза`. */
function counter() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-reuse-count-')));
  const path = join(dir, 'runs.log');
  const append = (label: string) =>
    `require('fs').appendFileSync(${JSON.stringify(path)}, ${JSON.stringify(label)} + ':' + process.env.DEVCONTOUR_PHASE + '\\n');`;
  const lines = () => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : []);
  return {
    path,
    append,
    lines,
    count: (label: string) => lines().filter((l) => l.startsWith(label + ':')).length,
  };
}

/**
 * Политика: gate `unit` (test) и `lint` (check, после него — не предпосылка
 * unit), оба пишут счётчик; lifecycle setup — тоже.
 */
function reuseSetup(
  options: {
    reuse?: boolean;
    lint?: Record<string, unknown>;
    graph?: (g: any) => void;
    files?: Record<string, string>;
    moveTarget?: boolean;
  } = {},
) {
  const runs = counter();
  const ctx: ReturnType<typeof setup> = setup({
    scenario: { writer: implement(), reviewer: approve() },
    ...(options.files ? { files: options.files } : {}),
    graph: (g: any) => {
      g.orders[0].gates = ['unit', 'lint'];
      options.graph?.(g);
    },
    policy: (p: any) => {
      if (options.reuse !== false) p.integrationReuse = 'identical-tree';
      p.maxAttempts = 1;
      const repo = p.repositories[0];
      repo.gates[0].command = [
        process.execPath,
        '-e',
        runs.append('unit') + "require(process.cwd() + '/test/run.js');",
      ];
      repo.gates.push({
        id: 'lint',
        kind: 'check',
        command: node(
          runs.append('lint') +
            "require('fs').mkdirSync('out', { recursive: true }); require('fs').writeFileSync('out/x.txt', 'x');",
        ),
        ...options.lint,
      });
      p.lifecycle = {
        setup: [{ id: 'boot', command: node(runs.append('setup')) }],
        teardown: [{ id: 'down', command: node('0') }],
      };
    },
    ...(options.moveTarget
      ? {
          runner: {
            // Пока идёт попытка, в target принята посторонняя работа.
            hooks: {
              implemented: () => {
                const ref = ctx.policy.repositories[0]!.targetRef;
                ctx.repo.git('checkout', '-q', '--detach', ref);
                write(ctx.repo.dir, { 'OTHER.md': 'other\n' });
                ctx.repo.git('add', '-A');
                ctx.repo.git('commit', '-qm', 'other work');
                ctx.repo.git('update-ref', ref, 'HEAD');
                ctx.repo.git('checkout', '-q', 'main');
              },
            },
          },
        }
      : {}),
  });
  return { ctx, runs };
}

const attemptOf = (ctx: ReturnType<typeof setup>) =>
  ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
const integrationRecord = (a: AttemptState, gate: string) =>
  a.evidence.findLast(
    (e) => e.kind === 'test' && e.phase === 'integration' && e.gate === gate && !e.consumer,
  );
const treeOf = (ctx: ReturnType<typeof setup>, sha: string) =>
  ctx.repo.git('rev-parse', sha + '^{tree}');

test('integrationReuse: target не сдвинулся — каждый gate исполнен один раз, lifecycle setup один раз; записи интеграции взяты из кандидата', async () => {
  const { ctx, runs } = reuseSetup();
  const graph = await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'done', work.failure);
  assert.equal(runs.count('unit'), 1, runs.lines().join(','));
  assert.equal(runs.count('lint'), 1, runs.lines().join(','));
  assert.equal(
    runs.count('setup'),
    1,
    'окружение интеграции не поднималось: ' + runs.lines().join(','),
  );
  const a = attemptOf(ctx);
  assert.equal(target(ctx), a.integrationSha);
  const tree = treeOf(ctx, a.candidateSha!);
  assert.equal(treeOf(ctx, a.integrationSha!), tree);
  for (const gate of ['unit', 'lint']) {
    const record = integrationRecord(a, gate)!;
    const source = a.evidence.findLast(
      (e) => e.kind === 'test' && e.phase === 'candidate' && e.gate === gate,
    )!;
    assert.equal(record.passed, true);
    assert.equal(record.sha, a.integrationSha);
    assert.deepEqual(record.reusedEvidence, {
      evidenceId: source.id,
      phase: 'candidate',
      sha: a.candidateSha,
      tree,
    });
    assert.match(record.summary, /взято из кандидата/);
  }
  // Ревью интеграции и событие gate — как прежде, с пометкой переноса.
  assert.ok(a.evidence.some((e) => e.kind === 'review' && e.phase === 'integration' && e.passed));
  const gateEvents = ctx.store
    .events()
    .filter((e) => e.type === 'attempt.gate' && e.payload.phase === 'integration');
  assert.equal(gateEvents.length, 2);
  assert.ok(gateEvents.every((e) => e.type === 'attempt.gate' && e.payload.reusedFrom));
  const view = attemptView(
    { ...a, phase: 'integrating' },
    { now: Date.now(), leaseMs: ctx.policy.leaseMs },
  );
  assert.equal(view.gates.reused, 2);
  assert.equal(view.gates.passed, 2);

  // Получатель: деревья своим Git — PASS; без деревьев, с другими деревьями
  // или с подменённой ссылкой — отказ.
  const { result, order } = ctx.engine.read((v) => ({
    result: runResult(v.attempt(a.id)!, '0.1.0-test') as RunResult & { outcome: 'accepted' },
    order: v.work('add-greeting')!.order,
  }));
  assert.deepEqual(runResultSchema.parse(JSON.parse(JSON.stringify(result))), result);
  assert.ok(result.evidence.filter((e) => e.reusedEvidence).length === 2);
  const context: ReceiverContext = {
    order,
    graphId: graph.id,
    contracts: [],
    policy: ctx.policy,
    contextDigest: null,
    trees: { candidate: tree, result: treeOf(ctx, result.shas.result) },
  };
  assert.deepEqual(resultProblems(result, context), []);
  const withoutTrees = { ...context };
  delete withoutTrees.trees;
  assert.ok(
    resultProblems(result, withoutTrees).some((p) =>
      /Нет PASS: integration\/unit: .*не передал деревья/.test(p),
    ),
  );
  const other = treeOf(ctx, a.baseSha!);
  assert.ok(
    resultProblems(result, { ...context, trees: { candidate: tree, result: other } }).some((p) =>
      /integration\/unit: .*дерево результата .* не совпадает с деревом кандидата/.test(p),
    ),
  );
  assert.ok(
    resultProblems(result, { ...context, trees: { candidate: other, result: other } }).some((p) =>
      /записанное дерево .* не совпадает/.test(p),
    ),
  );
  const forged = (change: (r: any) => void) => {
    const copy = structuredClone(result) as any;
    change(copy);
    return resultProblems(runResultSchema.parse(copy), context);
  };
  const reused = (r: any) => r.evidence.find((e: any) => e.reusedEvidence && e.gate === 'unit');
  assert.ok(
    forged((r) => (reused(r).reusedEvidence.evidenceId = 'missing')).some((p) =>
      /запись кандидата missing не найдена/.test(p),
    ),
  );
  assert.ok(
    forged((r) => {
      const id = reused(r).reusedEvidence.evidenceId;
      r.evidence.find((e: any) => e.id === id).passed = false;
    }).some((p) => /integration\/unit: .*не PASS/.test(p)),
  );
  assert.ok(
    forged((r) => {
      // Ссылка на запись другого gate кандидата.
      const lint = r.evidence.find(
        (e: any) => e.phase === 'candidate' && e.gate === 'lint' && e.kind === 'test',
      );
      reused(r).reusedEvidence.evidenceId = lint.id;
    }).some((p) => /не собственная проверка unit на кандидате/.test(p)),
  );
  assert.ok(
    forged((r) => (reused(r).reusedEvidence.sha = r.shas.base)).some((p) =>
      /ссылка не на SHA кандидата/.test(p),
    ),
  );
  assert.ok(
    forged((r) => {
      const review = r.evidence.find((e: any) => e.kind === 'review' && e.phase === 'candidate');
      review.reusedEvidence = reused(r).reusedEvidence;
    }).some((p) => /взятой из кандидата бывает только запись test интеграции/.test(p)),
  );
  ctx.store.close();
});

test('integrationReuse: без поля в политике каждый gate и lifecycle исполняются на интеграции (прежнее поведение)', async () => {
  const { ctx, runs } = reuseSetup({ reuse: false });
  await runAll(ctx);
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  assert.equal(runs.count('unit'), 2);
  assert.equal(runs.count('lint'), 2);
  assert.equal(runs.count('setup'), 2);
  assert.ok(attemptOf(ctx).evidence.every((e) => !e.reusedEvidence));
  ctx.store.close();
});

test('integrationReuse: target сдвинулся во время попытки — деревья различаются, gates интеграции исполняются', async () => {
  const { ctx, runs } = reuseSetup({ moveTarget: true });
  await runAll(ctx);
  const a = attemptOf(ctx);
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
    a.error,
  );
  assert.notEqual(treeOf(ctx, a.integrationSha!), treeOf(ctx, a.candidateSha!));
  assert.equal(runs.count('unit'), 2);
  assert.equal(runs.count('lint'), 2);
  assert.equal(runs.count('setup'), 2);
  assert.ok(a.evidence.every((e) => !e.reusedEvidence));
  ctx.store.close();
});

test('integrationReuse: gate доказательства требования исполняется на интеграции; остальные взяты из кандидата', async () => {
  const text = '## REQ-1 Приветствие\n\ngreet("Ada") возвращает Hello, Ada!';
  const { ctx, runs } = reuseSetup({
    files: { 'spec.md': text + '\n' },
    graph: (g) =>
      (g.orders[0].requirements = [
        {
          id: 'REQ-1',
          source: 'spec.md',
          digest: sha256(text),
          text,
          gate: 'unit',
          scenario: 'Приветствие по имени',
          testId: 'greet.greets',
        },
      ]),
  });
  await runAll(ctx);
  const a = attemptOf(ctx);
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
    a.error,
  );
  assert.equal(runs.count('unit'), 2, 'доказательство требования — на каждой фазе');
  assert.equal(runs.count('lint'), 1);
  assert.equal(integrationRecord(a, 'unit')!.reusedEvidence, undefined);
  assert.ok(integrationRecord(a, 'lint')!.reusedEvidence);
  ctx.store.close();
});

test('integrationReuse: gate с artifacts исполняется на интеграции; остальные взяты из кандидата', async () => {
  const { ctx, runs } = reuseSetup({ lint: { artifacts: ['out'] } });
  await runAll(ctx);
  const a = attemptOf(ctx);
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
    a.error,
  );
  assert.equal(runs.count('lint'), 2);
  assert.equal(runs.count('unit'), 1);
  assert.equal(runs.count('setup'), 2, 'исполняемому gate нужно окружение');
  assert.equal(integrationRecord(a, 'lint')!.reusedEvidence, undefined);
  assert.ok(integrationRecord(a, 'lint')!.artifactFiles);
  assert.ok(integrationRecord(a, 'unit')!.reusedEvidence);
  ctx.store.close();
});

test('integrationReuse: предпосылка исполняемого gate исполняется вместе с ним', async () => {
  // lint перед unit — неявная предпосылка unit (check раньше в массиве).
  const runs = counter();
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p: any) => {
      p.integrationReuse = 'identical-tree';
      const repo = p.repositories[0];
      repo.gates[0].command = [
        process.execPath,
        '-e',
        runs.append('unit') + "require(process.cwd() + '/test/run.js');",
      ];
      repo.gates[0].artifacts = ['test-results'];
      repo.gates.unshift({ id: 'lint', kind: 'check', command: node(runs.append('lint')) });
    },
    graph: (g: any) => (g.orders[0].gates = ['lint', 'unit']),
  });
  await runAll(ctx);
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  assert.equal(runs.count('unit'), 2);
  assert.equal(runs.count('lint'), 2, 'предпосылка исполняемого gate не переносится');
  assert.ok(attemptOf(ctx).evidence.every((e) => !e.reusedEvidence));
  ctx.store.close();
});

/**
 * Поручение product (зависит от library); проверка product в фазе кандидата
 * может сдвинуть target библиотеки — база провайдера уходит со снимка.
 */
function providerSetup(move: boolean) {
  const runs = counter();
  let libraryDir = '';
  let libraryRef = '';
  const moveScript = `
const { execFileSync } = require('child_process');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
if (${move} && process.env.DEVCONTOUR_PHASE === 'candidate') {
  const run = (...a) => execFileSync('git', ['-C', process.env.REUSE_LIB, ...a], { env, encoding: 'utf8' }).trim();
  const tree = run('rev-parse', process.env.REUSE_REF + '^{tree}');
  const head = run('rev-parse', process.env.REUSE_REF);
  const next = run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', head, '-m', 'moved');
  run('update-ref', process.env.REUSE_REF, next);
}
`;
  const c = components({
    scenario: {
      writer: {
        files: { 'value.json': '3\n' },
        result: { completed: true, summary: 'value 3', discoveries: [] },
      },
      reviewer: approve(),
    },
    policy: (p) => {
      p.integrationReuse = 'identical-tree';
      p.maxAttempts = 1;
      const product = p.repositories.find((r: any) => r.id === 'product');
      const library = p.repositories.find((r: any) => r.id === 'library');
      libraryDir = library.path;
      libraryRef = library.targetRef;
      product.gates = [
        {
          id: 'unit',
          kind: 'check',
          command: node(runs.append('unit') + moveScript),
        },
      ];
      p.environment.values.REUSE_LIB = libraryDir;
      p.environment.values.REUSE_REF = libraryRef;
    },
    graph: (g) => {
      g.orders[0].repositoryId = 'product';
      g.orders[0].writeScope = ['value.json'];
      delete g.orders[0].consumers;
    },
  });
  return { c, runs };
}

async function runComponents(c: ReturnType<typeof components>) {
  await c.runner.init();
  const { graph } = c.engine.register(c.graph, trustNone);
  c.engine.recordReview(planReview(c.engine, graph, 1));
  c.engine.approve(graph.id, 'agent');
  c.engine.resume();
  await c.runner.drain();
  return c.engine.read((v) => v.attempts('add-greeting')[0]!);
}

test('integrationReuse: снимок провайдера не сдвинулся — gate взят из кандидата; сдвинулся — исполняется на интеграции', async () => {
  for (const move of [false, true]) {
    const { c, runs } = providerSetup(move);
    const a = await runComponents(c);
    assert.equal(
      c.engine.read((v) => v.work('add-greeting')!.status),
      'done',
      a.error,
    );
    assert.ok(a.dependencies?.some((d) => d.repositoryId === 'library'));
    assert.equal(runs.count('unit'), move ? 2 : 1, `move=${move}: ${runs.lines().join(',')}`);
    assert.equal(
      a.evidence.some((e) => e.reusedEvidence),
      !move,
      `move=${move}`,
    );
    c.store.close();
  }
});

test('integrationReuse: без поля digest политики прежний; с полем — executionDigest меняется', () => {
  const ctx = setup({ scenario: {} });
  const raw = JSON.parse(JSON.stringify(ctx.policy));
  const withField = executionPolicySchema.parse({ ...raw, integrationReuse: 'identical-tree' });
  assert.notEqual(executionDigest(withField), executionDigest(ctx.policy));
  assert.equal(executionDigest(executionPolicySchema.parse(raw)), executionDigest(ctx.policy));
  assert.equal(
    executionPolicySchema.safeParse({ ...raw, integrationReuse: 'always' }).success,
    false,
  );
  ctx.store.close();
});

test('integrationReuse: хост без объявленной поддержки не создаёт движок с такой политикой', () => {
  const ctx = setup({ scenario: {}, policy: (p: any) => (p.integrationReuse = 'identical-tree') });
  const host = standaloneHost(ctx.store, ctx.policy);
  delete host.capabilities;
  assert.throws(
    () => new Engine({ host, policy: ctx.policy }),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'INVALID_INPUT' &&
      /capabilities\.integrationReuse/.test(e.message),
  );
  assert.match(integrationReuseProblem(ctx.policy, host) ?? '', /требует поддержки хоста/);
  assert.equal(
    integrationReuseProblem(ctx.policy, standaloneHost(ctx.store, ctx.policy)),
    undefined,
  );
  // Политика без поля — под любым хостом.
  const plain = executionPolicySchema.parse({
    ...JSON.parse(JSON.stringify(ctx.policy)),
    integrationReuse: undefined,
  });
  assert.equal(integrationReuseProblem(plain, host), undefined);
  assert.doesNotThrow(() => new Engine({ host, policy: plain }));
  ctx.store.close();
});

/**
 * Попытка, доведённая до интеграции вручную: кандидат поверх базы, merge
 * --no-ff в неподвижную принятую ветку (дерево то же), evidence кандидата.
 */
async function manual(options: { reuse?: boolean } = {}) {
  let offset = 0;
  const ctx = setup({
    scenario: {},
    now: () => Date.now() + offset,
    policy: (p: any) => {
      if (options.reuse !== false) p.integrationReuse = 'identical-tree';
    },
  });
  await ctx.runner.init();
  const { graph } = ctx.engine.register(ctx.graph, trustNone);
  ctx.engine.recordReview(planReview(ctx.engine, graph, 1));
  ctx.engine.approve(graph.id, 'agent');
  ctx.engine.resume();
  ctx.engine.lead('runner-1');
  const a: AttemptState = ctx.engine.claim('runner-1')!;
  const ref = ctx.policy.repositories[0]!.targetRef;
  const base = target(ctx);
  ctx.repo.git('checkout', '-q', '-b', 'candidate', base);
  write(ctx.repo.dir, { 'src/greet.js': greet });
  ctx.repo.git('add', '-A');
  ctx.repo.git('commit', '-qm', 'candidate');
  const candidate = ctx.repo.head();
  ctx.repo.git('checkout', '-q', '--detach', base);
  ctx.repo.git('merge', '--no-ff', '-q', '-m', 'integration', candidate);
  const integration = ctx.repo.head();
  ctx.repo.git('checkout', '-q', 'main');
  ctx.engine.phase(a.id, a.token, 'verifying', { baseSha: base, candidateSha: candidate });
  const ev = (
    kind: 'test' | 'review',
    phase: 'candidate' | 'integration',
    sha: string,
    extra: Partial<EvidenceRecord> = {},
  ) =>
    ctx.engine.evidence(a.id, a.token, {
      kind,
      phase,
      sha,
      gate: kind === 'test' ? 'unit' : 'independent-review',
      passed: true,
      command: [],
      exitCode: 0,
      log: '',
      digest: digestOf(kind + phase),
      summary: 'ok',
      ...extra,
    });
  const source = ev('test', 'candidate', candidate);
  ev('review', 'candidate', candidate);
  ctx.engine.phase(a.id, a.token, 'integrating', { integrationSha: integration });
  const tree = treeOf(ctx, integration);
  const reuse = (extra: Partial<EvidenceRecord['reusedEvidence']> = {}) =>
    ev('test', 'integration', integration, {
      reusedEvidence: { evidenceId: source.id, phase: 'candidate', sha: candidate, tree, ...extra },
    });
  const publish = () =>
    execFileSync('git', ['update-ref', ref, integration, base], {
      cwd: ctx.repo.dir,
      stdio: 'pipe',
    });
  return {
    ctx,
    a,
    base,
    candidate,
    integration,
    source,
    tree,
    ev,
    reuse,
    publish,
    expire: () => (offset += 60_000),
  };
}

const invalid = (pattern: RegExp) => (e: unknown) =>
  e instanceof HarnessError && e.code === 'INVALID_INPUT' && pattern.test(e.message);

test('integrationReuse: движок записывает взятую из кандидата запись только по правилу переноса', async () => {
  const off = await manual({ reuse: false });
  assert.throws(() => off.reuse(), invalid(/без integrationReuse в политике/));
  off.ctx.store.close();

  const m = await manual();
  assert.throws(() => m.reuse({ evidenceId: 'missing' }), invalid(/не найдена/));
  assert.throws(() => m.reuse({ sha: m.base }), invalid(/ссылка не на SHA кандидата/));
  assert.throws(
    () =>
      m.ev('test', 'integration', m.integration, {
        reusedEvidence: {
          evidenceId: m.source.id,
          phase: 'candidate',
          sha: m.candidate,
          tree: m.tree,
        },
        passed: false,
      }),
    invalid(/только PASS собственного gate/),
  );
  // Провал после PASS: прежний PASS кандидата уже не решающий.
  m.ev('test', 'candidate', m.candidate, { passed: false, exitCode: 1 });
  assert.throws(() => m.reuse(), invalid(/не решающая запись кандидата|не PASS/));
  m.ctx.store.close();
});

test('integrationReuse: правило переноса не принимает доказательство, gate с artifacts и неизвестный gate', () => {
  const source = {
    id: 's',
    kind: 'test',
    phase: 'candidate' as const,
    gate: 'unit',
    sha: 'c'.repeat(40),
    passed: true,
  };
  const record = {
    id: 'r',
    kind: 'test',
    phase: 'integration' as const,
    gate: 'unit',
    sha: 'd'.repeat(40),
    passed: true,
    reusedEvidence: {
      evidenceId: 's',
      phase: 'candidate' as const,
      sha: 'c'.repeat(40),
      tree: 'e'.repeat(40),
    },
  };
  const base = {
    record,
    evidence: [source, record],
    candidateSha: 'c'.repeat(40),
    resultSha: 'd'.repeat(40),
    proof: new Set<string>(),
    gates: [{ id: 'unit' }],
    trees: { candidate: 'e'.repeat(40), result: 'e'.repeat(40) },
  };
  assert.equal(reusedEvidenceProblem(base), undefined);
  assert.match(reusedEvidenceProblem({ ...base, proof: new Set(['unit']) })!, /доказательство/);
  assert.match(
    reusedEvidenceProblem({ ...base, gates: [{ id: 'unit', artifacts: ['out'] }] })!,
    /artifacts/,
  );
  assert.match(reusedEvidenceProblem({ ...base, gates: [] })!, /не объявлен/);
  assert.match(
    reusedEvidenceProblem({
      ...base,
      trees: { candidate: 'e'.repeat(40), result: 'f'.repeat(40) },
    })!,
    /дерево результата/,
  );
  assert.match(
    reusedEvidenceProblem({ ...base, record: { ...record, property: { level: 'manifest' } } })!,
    /свойствах/,
  );
  assert.match(
    reusedEvidenceProblem({ ...base, record: { ...record, consumer: 'x' } })!,
    /собственного gate/,
  );
});

test('integrationReuse: recovery принимает взятые из кандидата записи при том же дереве; при подменённом дереве — отказ', async () => {
  for (const forged of [false, true]) {
    const m = await manual();
    m.reuse(forged ? { tree: treeOf(m.ctx, m.base) } : {});
    m.ev('review', 'integration', m.integration);
    assert.throws(() =>
      m.ctx.engine.finish(m.a.id, m.a.token, m.integration, () => {
        m.publish();
        throw new Error('crash after update-ref');
      }),
    );
    assert.equal(target(m.ctx), m.integration);
    m.expire();
    await m.ctx.runner.recover();
    const work = m.ctx.engine.read((v) => v.work('add-greeting')!);
    const recovered = m.ctx.store.events().find((e) => e.type === 'attempt.recovered');
    if (forged) {
      assert.notEqual(work.status, 'done');
      assert.ok(recovered?.type === 'attempt.recovered' && !recovered.payload.accepted);
      assert.match(String(recovered.payload.reason), /Дерево интеграции не совпадает/);
    } else {
      assert.equal(
        work.status,
        'done',
        String(recovered?.type === 'attempt.recovered' && recovered.payload.reason),
      );
      assert.equal(work.resultSha, m.integration);
      const a = m.ctx.engine.read((v) => v.attempt(m.a.id)!);
      assert.equal(a.status, 'succeeded');
      assert.ok(integrationRecord(a, 'unit')!.reusedEvidence);
    }
    m.ctx.store.close();
  }
});

test('integrationReuse: отчёт называет число gates интеграции, взятых из кандидата', async () => {
  const { ctx } = reuseSetup();
  await runAll(ctx);
  const input = ctx.engine.read((v) => ({ works: v.works(), attempts: v.attempts() }));
  const report = valueReport(input);
  valueReportSchema.parse(report);
  assert.equal(report.environment.reused, 2);
  assert.match(
    reportMarkdown(report),
    /Integration gates taken from the candidate \(взято из кандидата/,
  );
  // Без переноса поля нет: прежние отчёты не меняются.
  const plain = valueReport({
    ...input,
    attempts: input.attempts.map((a) => ({
      ...a,
      evidence: a.evidence.filter((e) => !e.reusedEvidence),
    })),
  });
  assert.equal(plain.environment.reused, undefined);
  ctx.store.close();
});

test('integrationReuse: все gates взяты из кандидата, но есть потребитель — окружение интеграции поднимается, потребитель видит подготовленного провайдера', async () => {
  const runs = counter();
  // Потребитель читает выход prepare провайдера в дереве интеграции.
  const verify = `const fs = require('fs');
const p = JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON);
const ok = fs.existsSync(p.library + '/.prepared') && fs.readFileSync(p.library + '/value.json', 'utf8').trim() === '2';
fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="consumer"' + (ok ? '/>' : '><failure message="unprepared"/></testcase>') + '</testsuite>');
process.exit(ok ? 0 : 1);`;
  const c = components({
    policy: (p) => {
      p.integrationReuse = 'identical-tree';
      p.maxAttempts = 1;
      const library = p.repositories.find((r: any) => r.id === 'library');
      library.gates[0].command = node(runs.append('unit') + "require(process.cwd() + '/unit.js');");
      library.prepare = [
        {
          id: 'prep',
          command: node(runs.append('prepare') + "require('fs').writeFileSync('.prepared', '1');"),
        },
      ];
      const product = p.repositories.find((r: any) => r.id === 'product');
      product.gates[0].command = node(verify);
    },
  });
  const a = await runComponents(c);
  assert.equal(
    c.engine.read((v) => v.work('add-greeting')!.status),
    'done',
    a.error,
  );
  assert.equal(runs.count('unit'), 1, 'gate провайдера взят из кандидата');
  assert.ok(integrationRecord(a, 'unit')?.reusedEvidence);
  assert.equal(runs.count('prepare'), 2, 'prepare интеграции исполнен ради потребителя');
  assert.ok(
    a.evidence.some((e) => e.consumer === 'product' && e.phase === 'integration' && e.passed),
    'потребитель проверен и прошёл',
  );
  c.store.close();
});

test('integrationReuse: попытка без изменений (кандидат — база) ничего не переносит', async () => {
  const confirmed = approve('Приёмка уже выполнена на базе');
  (confirmed.result as Record<string, unknown>).alreadySatisfied = {
    gates: ['unit'],
    evidence: 'unit passes on the base: greet returns Hello, Ada!',
  };
  const ctx = setup({
    files: {},
    scenario: { writer: [implement(), implement({})], reviewer: confirmed },
    policy: (p: any) => {
      p.maxAttempts = 1;
      p.integrationReuse = 'identical-tree';
    },
    graph: (g: any) => {
      const order = g.orders[0];
      g.orders = [
        { ...order, id: 'dep', source: { ...order.source, ref: 'dep' } },
        { ...order, dependsOn: ['dep'] },
      ];
    },
  });
  await runAll(ctx);
  const work = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'done', work.failure);
  const a = attemptOf(ctx);
  assert.equal(a.candidateSha, a.baseSha);
  const record = integrationRecord(a, 'unit');
  assert.ok(record?.passed);
  assert.equal(record.reusedEvidence, undefined, 'без изменений gate исполняется на интеграции');
  ctx.store.close();
});
