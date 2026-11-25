/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
 * Фикстура правит сырой JSON политики и подделывает переносимый результат.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executionPolicySchema,
  integrationReuseOn,
  integrationReuseProblem,
  runResultSchema,
  type AttemptState,
  type RunResult,
} from '../src/contracts/index.ts';
import { runResult } from '../src/engine/result.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { resultProblems, type ReceiverContext } from '../src/verification/acceptance.ts';
import { reusedEvidenceProblem } from '../src/verification/integration-reuse.ts';
import { approve, implement, runAll, setup, target } from './runner-fixture.ts';
import { write } from './git-fixture.ts';
import { example } from './fixtures.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';

/** Политика облегчённого режима без поля integrationReuse (или с `reuse`). */
function lightSetup(options: { reuse?: 'off' | 'identical-tree'; moveTarget?: boolean } = {}) {
  const ctx: ReturnType<typeof setup> = setup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p: any) => {
      p.harnessMode = 'light';
      p.maxAttempts = 1;
      if (options.reuse) p.integrationReuse = options.reuse;
    },
    ...(options.moveTarget
      ? {
          runner: {
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
  return ctx;
}

const attemptOf = (ctx: ReturnType<typeof setup>) =>
  ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
/** Вызовы reviewer fixture (кандидат, интеграция, …). */
const reviewerCalls = (ctx: ReturnType<typeof setup>) => {
  const path = `${ctx.scenarioPath}.codex.reviewer.count`;
  return existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
};
const tree = (ctx: ReturnType<typeof setup>, sha: string) =>
  ctx.repo.git('rev-parse', sha + '^{tree}');
const review = (a: AttemptState, phase: 'candidate' | 'integration') =>
  a.evidence.findLast((e) => e.kind === 'review' && e.phase === phase)!;

test('integrationReuseOn: облегчённый режим без поля — перенос при поддержке хоста; off и строгий режим — нет', () => {
  const yes = { capabilities: { integrationReuse: true } };
  assert.equal(integrationReuseOn({}, yes), true);
  assert.equal(integrationReuseOn({ harnessMode: 'light' }, yes), true);
  assert.equal(integrationReuseOn({}, {}), false, 'хост без поддержки');
  // Получатель без режима перенос не включает (ревью B L2); облегчённый явно — включает.
  assert.equal(integrationReuseOn({}), false, 'получатель без режима');
  assert.equal(integrationReuseOn({ harnessMode: 'light' }), true);
  assert.equal(integrationReuseOn({ harnessMode: 'strict' }, yes), false);
  assert.equal(integrationReuseOn({ integrationReuse: 'off' }, yes), false);
  assert.equal(
    integrationReuseOn({ harnessMode: 'strict', integrationReuse: 'identical-tree' }, yes),
    true,
  );
  // Явное identical-tree под хостом без поддержки — отказ; без поля и off — нет.
  const raw = structuredClone(example('policy')) as any;
  raw.harnessMode = 'light';
  const store = new SqliteExecutionStore(
    join(realpathSync(mkdtempSync(join(tmpdir(), 'harness-carry-'))), 'state.sqlite'),
    'test',
  );
  const host = { ...standaloneHost(store, executionPolicySchema.parse(raw)), capabilities: {} };
  for (const [value, problem] of [
    [undefined, false],
    ['off', false],
    ['identical-tree', true],
  ] as const) {
    const policy = executionPolicySchema.parse({
      ...raw,
      ...(value ? { integrationReuse: value } : {}),
    });
    assert.equal(integrationReuseProblem(policy, host) !== undefined, problem, String(value));
  }
  store.close();
});

test('облегчённый режим без поля: дерево интеграции = дерево кандидата — gates и ревью перенесены, reviewer вызван один раз', async () => {
  const ctx = lightSetup();
  const graph = await runAll(ctx);
  const a = attemptOf(ctx);
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
    a.error,
  );
  assert.equal(target(ctx), a.integrationSha);
  assert.equal(tree(ctx, a.integrationSha!), tree(ctx, a.candidateSha!));
  assert.equal(reviewerCalls(ctx), 1, 'второго ревью того же дерева нет');
  const unit = a.evidence.findLast((e) => e.kind === 'test' && e.phase === 'integration')!;
  assert.ok(unit.reusedEvidence, 'gate интеграции взят из кандидата');
  const carried = review(a, 'integration');
  const source = review(a, 'candidate');
  assert.equal(carried.passed, true);
  assert.deepEqual(carried.reusedEvidence, {
    evidenceId: source.id,
    phase: 'candidate',
    sha: a.candidateSha,
    tree: tree(ctx, a.candidateSha!),
  });
  assert.match(carried.summary, /ревью кандидата .* перенесено/);
  // Получатель: деревья своим Git — PASS; подмена ссылки ревью — отказ.
  const { result, order } = ctx.engine.read((v) => ({
    result: runResult(v.attempt(a.id)!, '0.1.0-test') as RunResult & { outcome: 'accepted' },
    order: v.work('add-greeting')!.order,
  }));
  const context: ReceiverContext = {
    order,
    graphId: graph.id,
    contracts: [],
    policy: ctx.policy,
    contextDigest: null,
    trees: { candidate: tree(ctx, a.candidateSha!), result: tree(ctx, result.shas.result) },
  };
  assert.deepEqual(resultProblems(result, context), []);
  const forged = (change: (r: any) => void) => {
    const copy = structuredClone(result) as any;
    change(copy);
    return resultProblems(runResultSchema.parse(copy), context);
  };
  const carriedOf = (r: any) =>
    r.evidence.find((e: any) => e.kind === 'review' && e.phase === 'integration');
  assert.ok(
    forged((r) => {
      const id = carriedOf(r).reusedEvidence.evidenceId;
      r.evidence.find((e: any) => e.id === id).passed = false;
    }).some((p) => /integration\/independent-review: .*не PASS/.test(p)),
  );
  assert.ok(
    forged((r) => {
      const unitCandidate = r.evidence.find(
        (e: any) => e.kind === 'test' && e.phase === 'candidate',
      );
      carriedOf(r).reusedEvidence.evidenceId = unitCandidate.id;
    }).some((p) => /не собственное ревью кандидата/.test(p)),
  );
  assert.ok(
    resultProblems(result, {
      ...context,
      policy: { ...ctx.policy, integrationReuse: 'off' },
    }).some((p) => /integration\/independent-review: .*не включает integrationReuse/.test(p)),
  );
  // Правило переноса ревью на записанном: не решающая запись кандидата — отказ.
  const problem = reusedEvidenceProblem({
    record: carried,
    evidence: [...a.evidence, { ...source, id: 'later', passed: false }],
    candidateSha: a.candidateSha!,
    resultSha: a.integrationSha!,
    proof: new Set(),
    gates: ctx.policy.repositories[0]!.gates,
    trees: null,
  });
  assert.match(problem ?? '', /не решающее ревью кандидата/);
  ctx.store.close();
});

test('облегчённый режим, integrationReuse: off — gates и ревью исполняются на интеграции', async () => {
  const ctx = lightSetup({ reuse: 'off' });
  await runAll(ctx);
  const a = attemptOf(ctx);
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
    a.error,
  );
  assert.equal(reviewerCalls(ctx), 2);
  assert.ok(a.evidence.every((e) => !e.reusedEvidence));
  ctx.store.close();
});

test('облегчённый режим без поля: target сдвинулся — деревья различаются, gates и ревью интеграции полностью', async () => {
  const ctx = lightSetup({ moveTarget: true });
  await runAll(ctx);
  const a = attemptOf(ctx);
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
    a.error,
  );
  assert.notEqual(tree(ctx, a.integrationSha!), tree(ctx, a.candidateSha!));
  assert.equal(reviewerCalls(ctx), 2);
  assert.ok(a.evidence.every((e) => !e.reusedEvidence));
  ctx.store.close();
});
