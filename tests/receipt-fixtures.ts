/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument --
 * Фикстуры подделывают переносимый результат как сырой JSON.
 */
import {
  digestOf,
  runResultSchema,
  sha256,
  type EvidenceRecord,
  type ExecutionPolicy,
  type RunResult,
  type WorkGraph,
} from '../src/contracts/index.ts';
import { contractDocuments, orderCheckManifest } from '../src/verification/checks.ts';
import { manifestDigest } from '../src/verification/property.ts';
import { CorpusStore } from '../src/verification/corpus.ts';
import { pinnedCorpus, type ReceiverContext } from '../src/verification/acceptance.ts';
import { runResult } from '../src/engine/result.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';
import { propertySetup } from './property-fixture.ts';

/**
 * Проверка переносимого результата получателем: каждое условие приёмки,
 * проверяемое по результату, повторяется против того, что знает получатель.
 * Попытка проводится управляемо через engine (запись evidence — как после
 * настоящих gates и ревью); результат строится и сериализуется штатно.
 */
export function attempt(
  graph: WorkGraph,
  policy: ExecutionPolicy = policyOf(),
  options: {
    unitTests?: NonNullable<EvidenceRecord['tests']>;
    /** Записи ревью фазы: предшествующие решающей и дополнения решающей. */
    review?: (phase: 'candidate' | 'integration') => {
      before?: Record<string, unknown>[];
      decisive?: Record<string, unknown>;
    };
  } = {},
) {
  const { engine: e, store } = engineOf(policy);
  ready(e, graph);
  const a = e.claim('c1')!;
  e.phase(a.id, a.token, 'verifying', { baseSha: sha('a'), candidateSha: sha('c') });
  e.phase(a.id, a.token, 'integrating', { integrationSha: sha('b') });
  const evidence = (
    gate: string,
    phase: 'candidate' | 'integration',
    extra: Record<string, unknown> = {},
  ) =>
    e.evidence(a.id, a.token, {
      kind: gate === 'independent-review' ? 'review' : 'test',
      phase,
      sha: sha(phase === 'candidate' ? 'c' : 'b'),
      gate,
      passed: true,
      command: ['controlled'],
      exitCode: 0,
      log: '',
      digest: digestOf(gate + phase),
      summary: 'ok',
      ...extra,
    } as any);
  for (const phase of ['candidate', 'integration'] as const) {
    evidence(
      'unit',
      phase,
      phase === 'integration' && options.unitTests ? { tests: options.unitTests } : {},
    );
    const review = options.review?.(phase) ?? {};
    for (const extra of review.before ?? []) evidence('independent-review', phase, extra);
    evidence('independent-review', phase, review.decisive ?? {});
    if (graph.orders[0]!.requirements.length) evidence('requirement-source', phase);
  }
  const done = () => {
    e.finish(a.id, a.token, sha('b'));
    const result = runResultSchema.parse(
      JSON.parse(
        JSON.stringify(
          runResult(
            e.read((v) => v.attempt(a.id)!),
            e.version,
          ),
        ),
      ),
    );
    return {
      result,
      context: {
        order: e.read((v) => v.work(a.workId)!.order),
        graphId: graph.id,
        contracts: [],
        policy,
        contextDigest: null,
      } as ReceiverContext,
    };
  };
  return { e, store, a, evidence, done };
}

export const forge = (result: RunResult, change: (r: any) => void) => {
  const forged = structuredClone(result) as any;
  change(forged);
  return runResultSchema.parse(forged);
};

/** Поручение app, проверяемое потребителем web (gates — группой) против своего результата. */
export function consumerAttempt() {
  const policy = policyOf((p: any) => {
    const app = p.repositories[0];
    p.repositories.push({
      ...structuredClone(app),
      id: 'web',
      path: 'web',
      targetRef: 'refs/heads/web-accepted',
      dependsOn: ['app'],
      gates: [
        { ...app.gates[0], id: 'e2e' },
        { ...app.gates[0], id: 'smoke' },
      ],
      gateGroups: { ci: ['e2e', 'smoke'] },
    });
  });
  const graph = graphOf({ a: [] });
  graph.orders[0]!.consumers = [{ repositoryId: 'web', gates: ['@ci'] }];
  const f = attempt(graph, policy);
  f.evidence('e2e', 'integration', { consumer: 'web' });
  f.evidence('smoke', 'integration', { consumer: 'web' });
  f.e.consumerChecked(f.a.id, f.a.token, 'web', {
    sha: sha('d'),
    tree: sha('e'),
    dependencies: [{ repositoryId: 'app', sha: sha('b'), tree: sha('e'), artifacts: [] }],
    // Голова потребителя ушла вперёд: снимок устарел, но описан правдиво.
    freshness: [{ repositoryId: 'web', snapshot: sha('d'), head: sha('f'), fresh: false }],
    observedAt: '2026-01-01T00:00:00.000Z',
  });
  return f;
}

/**
 * Согласованное property-поручение с принятой версией корпуса из одного
 * подтверждённого случая и выданной попыткой (без запуска checker: решение
 * подаётся управляемо, как запись после двойного подтверждения).
 */
export function propertyAttempt(options: { corpus?: boolean; now?: () => number } = {}) {
  const ctx = propertySetup({ writer: {}, ...(options.now ? { now: options.now } : {}) });
  const e = ctx.engine;
  ready(e, ctx.graph);
  if (options.corpus !== false) {
    const corpus = new CorpusStore(e);
    const ref = e.read((v) => corpus.suiteFor(v, v.work('add-greeting')!, 'knapsack-optimal'));
    const begun = corpus.begin(ref.suite, 'acceptance-case');
    const input = JSON.stringify({ items: [{ w: 0, v: 5 }], cap: 0 });
    const recorded = corpus.record(
      ref.suite,
      'acceptance-case',
      begun.token!,
      {
        property: 'knapsack-optimal',
        input,
        inputHash: sha256(input),
        outcome: 'confirmed',
        reason: 'управляемое подтверждение',
        source: { sha: ctx.repo.head() },
        origin: { kind: 'agent' },
        observed: { expected: '5', actual: '0', equal: false, repeats: 2, durationsMs: [1, 1] },
      },
      () => sha('b'),
      { works: ['add-greeting'], actor: 'agent' },
    );
    corpus.adopt(ref.suite.id, recorded.pending!.id);
  }
  const a = e.claim('c1')!;
  return { ctx, e, a };
}

export type Manifest = NonNullable<NonNullable<EvidenceRecord['property']>['manifest']>;

/** Манифест, который настоящий gate записал бы для этой попытки. */
export function manifestOf(ctx: ReturnType<typeof propertyAttempt>): Manifest {
  const { e, a } = ctx;
  return e.read((v) => {
    const work = v.work(a.workId)!;
    const corpus = a.checks?.corpus ? pinnedCorpus(v, a.checks.corpus)! : undefined;
    const expected = orderCheckManifest(
      work.order,
      contractDocuments(work.order, v),
      'properties',
      corpus,
    )!;
    return {
      digest: manifestDigest(expected),
      properties: expected.properties.map((p) => p.id),
      ...(expected.corpus
        ? { corpus: { digest: expected.corpus.digest, cases: expected.corpus.cases.length } }
        : {}),
    };
  });
}

/** Evidence обеих фаз; `property` — запись генеративного gate или её отсутствие. */
export function prove(
  ctx: ReturnType<typeof propertyAttempt>,
  shas: { candidate: string; integration: string },
  property: (phase: 'candidate' | 'integration') => EvidenceRecord['property'] | undefined,
  options: { phases?: ('candidate' | 'integration')[]; review?: boolean } = {},
) {
  const { e, a } = ctx;
  for (const phase of options.phases ?? (['candidate', 'integration'] as const)) {
    const at = shas[phase];
    const prop = property(phase);
    e.evidence(a.id, a.token, {
      kind: 'test',
      phase,
      sha: at,
      gate: 'properties',
      passed: true,
      command: ['controlled'],
      exitCode: 0,
      log: '',
      digest: digestOf(['test', phase, prop ?? null]),
      summary: 'controlled',
      ...(prop ? { property: prop } : {}),
    });
    if (options.review !== false)
      e.evidence(a.id, a.token, {
        kind: 'review',
        phase,
        sha: at,
        gate: 'independent-review',
        passed: true,
        command: ['codex', 'review-code'],
        exitCode: 0,
        log: '',
        digest: digestOf(['review', phase]),
        summary: 'ok',
      });
  }
}

export const manifestProperty = (manifest: Manifest): EvidenceRecord['property'] => ({
  seed: 1,
  reproduce: 'DEVCONTOUR_SEED=1 node check.mjs',
  contracts: {},
  artifacts: [],
  level: 'manifest',
  manifest,
});

export function integrate(ctx: ReturnType<typeof propertyAttempt>) {
  const { e, a } = ctx;
  e.phase(a.id, a.token, 'verifying', { baseSha: sha('a'), candidateSha: sha('c') });
  e.phase(a.id, a.token, 'integrating', { integrationSha: sha('b') });
  return { candidate: sha('c'), integration: sha('b') };
}

/** Принятое property-поручение и его переносимый результат. */
export function acceptedProperty() {
  const ctx = propertyAttempt();
  const shas = integrate(ctx);
  prove(ctx, shas, () => manifestProperty(manifestOf(ctx)));
  ctx.e.finish(ctx.a.id, ctx.a.token, shas.integration);
  const { result, order, contracts, suites, checkVersion, graphId, contextDigest } = ctx.e.read(
    (v) => {
      const work = v.work('add-greeting')!;
      return {
        result: runResult(v.attempt(ctx.a.id)!, '0.1.0-test'),
        order: work.order,
        contracts: contractDocuments(work.order, v),
        suites: v.locals('check-suites').map((x) => x.value),
        checkVersion: work.checkVersion,
        graphId: work.graphId,
        contextDigest: v.graph(work.graphId)?.approval?.context?.digest ?? null,
      };
    },
  );
  ctx.ctx.store.close();
  const context: ReceiverContext = {
    order,
    graphId,
    contracts,
    policy: ctx.ctx.policy,
    contextDigest,
    suite: (id: string) => suites.find((s) => s.id === id),
    checkVersion: checkVersion ? { suite: checkVersion.suite, digest: checkVersion.digest } : null,
  };
  return { result, context };
}

/**
 * Принятый результат, в котором заполнено каждое поле договора, кроме
 * относящихся к договору проверки (их даёт `acceptedProperty`): собственная
 * зависимость (устаревший, правдиво описанный снимок с artifacts),
 * потребитель с транзитивным входом, названный testcase, контекст, writer с
 * моделью.
 */
export function maximalAttempt() {
  const policy = policyOf((p: any) => {
    const app = p.repositories[0];
    app.dependsOn = ['lib'];
    p.repositories.push(
      {
        ...structuredClone(app),
        id: 'lib',
        path: 'lib',
        targetRef: 'refs/heads/lib-accepted',
        dependsOn: [],
      },
      {
        ...structuredClone(app),
        id: 'web',
        path: 'web',
        targetRef: 'refs/heads/web-accepted',
        dependsOn: ['app'],
        gates: [
          { ...app.gates[0], id: 'e2e' },
          { ...app.gates[0], id: 'smoke' },
        ],
        gateGroups: { ci: ['e2e', 'smoke'] },
      },
    );
    p.roles.developer.writer.model = 'writer-model';
  });
  const graph = graphOf({ a: [] });
  const text = 'The named scenario must run.';
  graph.orders[0]!.consumers = [{ repositoryId: 'web', gates: ['@ci'] }];
  graph.orders[0]!.requirements = [
    {
      id: 'REQ-1',
      source: 'requirements.md',
      text,
      digest: sha256(text),
      gate: 'unit',
      scenario: 'Named scenario',
      testId: 'required-test',
    },
  ];
  // Раунды протокола ревью кода (docs/review-protocol.md): ошибка протокола
  // перед валидным вердиктом кандидата; решает последняя запись фазы.
  const finding = digestOf('finding-1');
  const round = (extra: Record<string, unknown>) => ({
    version: 1,
    scope: digestOf('scope'),
    calls: 2,
    expected: [finding],
    ...extra,
  });
  const f = attempt(graph, policy, {
    unitTests: [
      { id: 'required-test', status: 'passed' },
      { id: 'other-test', status: 'passed' },
    ],
    review: (phase) =>
      phase === 'candidate'
        ? {
            before: [
              {
                passed: false,
                exitCode: 1,
                findings: [],
                reviewRound: round({
                  round: 2,
                  call: 1,
                  protocol: 'invalid',
                  issues: [{ path: 'previous[0].id', reason: 'unknown', message: 'не выдан' }],
                }),
              },
            ],
            decisive: {
              reviewRound: round({
                round: 2,
                call: 2,
                protocol: 'valid',
                transitions: [{ id: finding, from: 'open', to: 'closed', basis: 'исправлено' }],
              }),
            },
          }
        : {
            decisive: {
              reviewRound: round({
                round: 3,
                call: 1,
                protocol: 'valid',
                expected: [],
                transitions: [],
              }),
            },
          },
  });
  const contextDigest = digestOf('context-snapshot');
  f.e.update(f.a.id, f.a.token, 'run.context', { contextSnapshot: contextDigest });
  f.e.dependencies(f.a.id, f.a.token, [
    {
      repositoryId: 'lib',
      sha: sha('1'),
      tree: sha('2'),
      path: '/snapshots/lib',
      artifacts: [{ path: 'dist/lib.js', digest: digestOf('lib-artifact') }],
    },
  ]);
  // Генеративный gate потребителя: его собственный уровень, без договора провайдера.
  f.evidence('e2e', 'integration', {
    consumer: 'web',
    property: {
      seed: 1347595868,
      reproduce: 'DEVCONTOUR_SEED=1347595868 controlled',
      report: {
        version: 1,
        properties: [{ testId: 'consumer-property', status: 'passed', cases: 100 }],
      },
      contracts: {},
      artifacts: [],
      level: 'legacy',
    },
  });
  f.evidence('smoke', 'integration', { consumer: 'web' });
  f.e.consumerChecked(f.a.id, f.a.token, 'web', {
    sha: sha('d'),
    tree: sha('e'),
    dependencies: [
      {
        repositoryId: 'lib',
        sha: sha('1'),
        tree: sha('2'),
        artifacts: [{ path: 'dist/lib.js', digest: digestOf('lib-artifact') }],
      },
      { repositoryId: 'app', sha: sha('b'), tree: sha('3'), artifacts: [] },
    ],
    freshness: [
      { repositoryId: 'lib', snapshot: sha('1'), head: sha('1'), fresh: true },
      { repositoryId: 'web', snapshot: sha('d'), head: sha('f'), fresh: false },
    ],
    observedAt: '2026-01-01T00:00:00.000Z',
  });
  // Ветка lib ушла вперёд после снимка попытки: устарело, описано правдиво.
  f.e.dependencyFreshness(f.a.id, f.a.token, [
    { repositoryId: 'lib', snapshot: sha('1'), head: sha('4'), fresh: false },
  ]);
  const done = () => {
    const { result, context } = f.done();
    return { result, context: { ...context, contextDigest } as ReceiverContext };
  };
  return { ...f, done };
}
