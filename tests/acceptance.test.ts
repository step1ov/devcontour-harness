import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HarnessError,
  digestOf,
  runResultSchema,
  sha256,
  type ErrorCode,
  type EvidenceRecord,
  type RunResult,
} from '../src/contracts/index.ts';
import {
  contractDocuments,
  effectiveChecks,
  orderCheckManifest,
} from '../src/verification/checks.ts';
import { manifestDigest } from '../src/verification/property.ts';
import { CorpusStore } from '../src/verification/corpus.ts';
import { pinnedCorpus, resultProblems } from '../src/verification/acceptance.ts';
import { runResult } from '../src/engine/result.ts';
import { engineOf, graphOf, ready, sha } from './engine-fixture.ts';
import { propertySetup } from './property-fixture.ts';
import { target } from './runner-fixture.ts';

const refused = (code: ErrorCode, pattern?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  if (pattern) assert.match(e.message, pattern);
  return true;
};

/**
 * Согласованное property-поручение с принятой версией корпуса из одного
 * подтверждённого случая и выданной попыткой (без запуска checker: решение
 * подаётся управляемо, как запись после двойного подтверждения).
 */
function propertyAttempt(options: { corpus?: boolean; now?: () => number } = {}) {
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

type Manifest = NonNullable<NonNullable<EvidenceRecord['property']>['manifest']>;

/** Манифест, который настоящий gate записал бы для этой попытки. */
function manifestOf(ctx: ReturnType<typeof propertyAttempt>): Manifest {
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
function prove(
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

const manifestProperty = (manifest: Manifest): EvidenceRecord['property'] => ({
  seed: 1,
  reproduce: 'DEVCONTOUR_SEED=1 node check.mjs',
  contracts: {},
  artifacts: [],
  level: 'manifest',
  manifest,
});

function integrate(ctx: ReturnType<typeof propertyAttempt>) {
  const { e, a } = ctx;
  e.phase(a.id, a.token, 'verifying', { baseSha: sha('a'), candidateSha: sha('c') });
  e.phase(a.id, a.token, 'integrating', { integrationSha: sha('b') });
  return { candidate: sha('c'), integration: sha('b') };
}

test('S2-R1-09/F02: finish не принимает property-поручение без манифеста свойств или на прежнем уровне; с полным манифестом — принимает', () => {
  const ctx = propertyAttempt();
  const shas = integrate(ctx);
  const { e, a } = ctx;
  prove(ctx, shas, () => undefined);
  assert.throws(
    () => e.finish(a.id, a.token, shas.integration),
    refused('GATE_FAILED', /без манифеста свойств/),
  );
  prove(ctx, shas, () => ({ ...manifestProperty(manifestOf(ctx))!, level: 'legacy' }), {
    review: false,
  });
  assert.throws(
    () => e.finish(a.id, a.token, shas.integration),
    refused('GATE_FAILED', /без манифеста свойств/),
  );
  // Только кандидат с манифестом: интеграция без него — не принято.
  prove(ctx, shas, () => manifestProperty(manifestOf(ctx)), {
    phases: ['candidate'],
    review: false,
  });
  assert.throws(
    () => e.finish(a.id, a.token, shas.integration),
    refused('GATE_FAILED', /integration\/properties без манифеста/),
  );
  // Манифест другого договора (например, с меньшей выборкой) — не этот договор.
  prove(ctx, shas, () => manifestProperty({ ...manifestOf(ctx), digest: 'f'.repeat(64) }), {
    review: false,
  });
  assert.throws(
    () => e.finish(a.id, a.token, shas.integration),
    refused('GATE_FAILED', /манифест не соответствует договору/),
  );
  assert.equal(
    e.read((v) => v.work('add-greeting')!.status),
    'integrating',
  );
  prove(ctx, shas, () => manifestProperty(manifestOf(ctx)), { review: false });
  e.finish(a.id, a.token, shas.integration);
  assert.equal(
    e.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  ctx.ctx.store.close();
});

test('S2-R1-09/F13: обязательный корпус нельзя убрать из манифеста или занизить число его случаев', () => {
  const ctx = propertyAttempt();
  const shas = integrate(ctx);
  const { e, a } = ctx;
  const full = manifestOf(ctx);
  assert.equal(full.corpus?.cases, 1, 'корпус закреплён за попыткой');
  const stripped = { ...full };
  delete stripped.corpus;
  prove(ctx, shas, () => manifestProperty(stripped));
  assert.throws(
    () => e.finish(a.id, a.token, shas.integration),
    refused('GATE_FAILED', /не исполнял обязательный корпус/),
  );
  prove(ctx, shas, () => manifestProperty({ ...full, corpus: { ...full.corpus!, cases: 0 } }), {
    review: false,
  });
  assert.throws(
    () => e.finish(a.id, a.token, shas.integration),
    refused('GATE_FAILED', /не исполнял обязательный корпус/),
  );
  prove(
    ctx,
    shas,
    () => manifestProperty({ ...full, corpus: { ...full.corpus!, digest: 'e'.repeat(64) } }),
    {
      review: false,
    },
  );
  assert.throws(
    () => e.finish(a.id, a.token, shas.integration),
    refused('GATE_FAILED', /не исполнял обязательный корпус/),
  );
  prove(ctx, shas, () => manifestProperty(full), { review: false });
  e.finish(a.id, a.token, shas.integration);
  assert.equal(
    e.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  ctx.ctx.store.close();
});

test('S2-R1-09/F12: gate объявленного свойства обязателен и при подменённом составе requiredGates', () => {
  const ctx = propertyAttempt({ corpus: false });
  const shas = integrate(ctx);
  const { e, a } = ctx;
  // Состав обязательных gates попытки подменён: gate свойства исключён.
  e.host.store.transact('run.phase', (tx) =>
    tx.putAttempt({ ...tx.attempt(a.id)!, requiredGates: [] }),
  );
  for (const phase of ['candidate', 'integration'] as const)
    e.evidence(a.id, a.token, {
      kind: 'review',
      phase,
      sha: shas[phase],
      gate: 'independent-review',
      passed: true,
      command: ['codex', 'review-code'],
      exitCode: 0,
      log: '',
      digest: digestOf(phase),
      summary: 'ok',
    });
  assert.throws(
    () => e.finish(a.id, a.token, shas.integration),
    refused('GATE_FAILED', /Нет PASS: candidate\/properties/),
  );
  ctx.ctx.store.close();
});

test('S2-R1-09: recovery не принимает сохранённое evidence без манифеста свойств (принятие recovery идёт через finish)', () => {
  let offset = 0;
  const ctx = propertyAttempt({ now: () => Date.now() + offset });
  const { e, a } = ctx;
  const repo = ctx.ctx.repo;
  const ref = ctx.ctx.policy.repositories[0]!.targetRef;
  const base = target(ctx.ctx);
  // Настоящие коммиты: recovery сверяет integration SHA с target ref.
  repo.git('checkout', '-q', '-b', 'candidate', base);
  writeFileSync(join(repo.dir, 'src/knap.mjs'), 'export const solve = () => 0;\n');
  repo.git('add', '-A');
  repo.git('commit', '-qm', 'candidate');
  const candidate = repo.head();
  repo.git('checkout', '-q', '--detach', base);
  repo.git('merge', '--no-ff', '-q', '-m', 'integration', candidate);
  const integration = repo.head();
  repo.git('checkout', '-q', 'main');
  e.phase(a.id, a.token, 'verifying', { baseSha: base, candidateSha: candidate });
  e.phase(a.id, a.token, 'integrating', { integrationSha: integration });
  const shas = { candidate, integration };
  prove(ctx, shas, () => undefined);
  execFileSync('git', ['update-ref', ref, integration, base], { cwd: repo.dir, stdio: 'pipe' });
  offset += 10 * 60_000;
  return ctx.ctx.runner.recover().then(() => {
    assert.notEqual(
      e.read((v) => v.work('add-greeting')!.status),
      'done',
    );
    const rejected = ctx.ctx.store.events().find((x) => x.type === 'attempt.recovered');
    assert.ok(rejected?.type === 'attempt.recovered' && !rejected.payload.accepted);
    assert.match(String(rejected.payload.reason), /без манифеста свойств/);
    ctx.ctx.store.close();
  });
});

/** Принятое property-поручение и его переносимый результат. */
function acceptedProperty() {
  const ctx = propertyAttempt();
  const shas = integrate(ctx);
  prove(ctx, shas, () => manifestProperty(manifestOf(ctx)));
  ctx.e.finish(ctx.a.id, ctx.a.token, shas.integration);
  const { result, order, contracts, suites, checkVersion } = ctx.e.read((v) => ({
    result: runResult(v.attempt(ctx.a.id)!, '0.1.0-test'),
    order: v.work('add-greeting')!.order,
    contracts: contractDocuments(v.work('add-greeting')!.order, v),
    suites: v.locals('check-suites').map((x) => x.value),
    checkVersion: v.work('add-greeting')!.checkVersion,
  }));
  ctx.ctx.store.close();
  const context = {
    order,
    contracts,
    suite: (id: string) => suites.find((s) => s.id === id),
    repository: ctx.ctx.policy.repositories[0]!,
    checkVersion: checkVersion ? { suite: checkVersion.suite, digest: checkVersion.digest } : null,
  };
  return { result, context };
}

const tamper = (result: RunResult, change: (r: RunResult & { outcome: 'accepted' }) => void) => {
  const copy = structuredClone(result) as RunResult & { outcome: 'accepted' };
  change(copy);
  return copy;
};

test('S2-R1-09/AC23: переносимый результат нового формата проходит без потерь; неполный, смешанный или с подменённым корпусом — отклонён', () => {
  const { result, context } = acceptedProperty();
  assert.deepEqual(resultProblems(result, context), []);
  // Round-trip: сериализация и разбор схемой не теряют полей доказательства.
  const parsed = runResultSchema.parse(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(parsed, result);
  assert.ok(result.inputs.corpus, 'версия корпуса в результате');
  assert.ok(result.evidence.some((e) => e.property?.manifest?.corpus?.cases === 1));
  assert.deepEqual(resultProblems(parsed, context), []);
  const cases: [string, (r: RunResult & { outcome: 'accepted' }) => void, RegExp][] = [
    [
      'F02: без манифестов',
      (r) => r.evidence.forEach((e) => delete e.property),
      /без манифеста свойств/,
    ],
    ['AC23: без версии проверок', (r) => delete r.inputs.checks, /без версии проверок/],
    [
      'F02: смешанные версии',
      (r) =>
        (r.evidence.find((e) => e.phase === 'integration' && e.kind === 'review')!.checks =
          'f'.repeat(64)),
      /integration\/independent-review получен под другой версией проверок/,
    ],
    [
      'F13: корпус удалён',
      (r) => r.evidence.forEach((e) => delete e.property?.manifest?.corpus),
      /не исполнял обязательный корпус/,
    ],
    [
      'F13: корпус занижен',
      (r) =>
        r.evidence.forEach(
          (e) => e.property?.manifest?.corpus && (e.property.manifest.corpus.cases = 0),
        ),
      /не исполнял обязательный корпус/,
    ],
    [
      'AC23: версия корпуса, которой нет у получателя',
      (r) => (r.inputs.corpus!.digest = 'e'.repeat(64)),
      /которой нет у получателя|версия проверок не соответствует/,
    ],
    [
      'F12: gate свойства исключён и подменён другим PASS',
      (r) => {
        r.inputs.requiredGates = ['lint'];
        for (const e of [...r.evidence])
          if (e.gate === 'properties') {
            r.evidence.push({ ...e, gate: 'lint', id: e.id + '-lint' });
            e.passed = false;
          }
      },
      /Нет PASS: candidate\/properties/,
    ],
    [
      'чужое поручение',
      (r) => (r.inputs.workOrderDigest = 'a'.repeat(64)),
      /не соответствует поручению/,
    ],
  ];
  for (const [name, change, pattern] of cases) {
    const problems = resultProblems(tamper(result, change), context);
    assert.ok(
      problems.some((p) => pattern.test(p)),
      `${name}: ${problems.join('; ')}`,
    );
  }
});

test('AC23: результат прежнего формата у поручения без договора проверки читается на прежнем уровне; смешанные версии — нет', () => {
  const { engine: e, store } = engineOf();
  ready(e, graphOf({ a: [] }));
  const a = e.claim('c1')!;
  e.phase(a.id, a.token, 'verifying', { baseSha: sha('a'), candidateSha: sha('c') });
  e.phase(a.id, a.token, 'integrating', { integrationSha: sha('b') });
  for (const phase of ['candidate', 'integration'] as const)
    for (const kind of ['test', 'review'] as const)
      e.evidence(a.id, a.token, {
        kind,
        phase,
        sha: sha(phase === 'candidate' ? 'c' : 'b'),
        gate: kind === 'test' ? 'unit' : 'independent-review',
        passed: true,
        command: ['x'],
        exitCode: 0,
        log: '',
        digest: digestOf(kind + phase),
        summary: 'ok',
      });
  e.finish(a.id, a.token, sha('b'));
  const { result, order } = e.read((v) => ({
    result: runResult(v.attempt(a.id)!, '0.1.0-test'),
    order: v.work('a')!.order,
  }));
  store.close();
  const context = { order, contracts: [] };
  assert.deepEqual(resultProblems(result, context), []);
  // Прежний формат: без версии проверок и без записей версий evidence.
  const legacy = tamper(result, (r) => {
    delete r.inputs.checks;
    delete r.inputs.requiredGates;
    r.evidence.forEach((e) => delete e.checks);
  });
  assert.deepEqual(resultProblems(legacy, context), []);
  const mixed = tamper(legacy, (r) => (r.evidence[0]!.checks = 'f'.repeat(64)));
  assert.ok(resultProblems(mixed, context).some((p) => /разными версиями/.test(p)));
  const missing = tamper(
    legacy,
    (r) => (r.evidence = r.evidence.filter((e) => e.phase !== 'integration' || e.kind !== 'test')),
  );
  assert.ok(resultProblems(missing, context).some((p) => /Нет PASS: integration\/unit/.test(p)));
});

test('S2-R2-04/F13: согласованная, но чужая версия проверок и корпус, убранный вместе с привязкой и пересчитанным манифестом, — отклонены', () => {
  const { result, context } = acceptedProperty();
  assert.deepEqual(resultProblems(result, context), []);
  // Одна и та же произвольная версия во всех полях.
  const wrong = tamper(result, (r) => {
    r.inputs.checks = 'f'.repeat(64);
    r.evidence.forEach((e) => (e.checks = 'f'.repeat(64)));
  });
  assert.ok(
    resultProblems(wrong, context).some((p) => /версия проверок не соответствует/.test(p)),
    resultProblems(wrong, context).join('; '),
  );
  // Корпус убран вместе с привязкой; манифест и версия пересчитаны так, как
  // будто корпуса не было, — результат согласован сам с собой.
  const withoutCorpus = tamper(result, (r) => {
    delete r.inputs.corpus;
    const expected = orderCheckManifest(context.order, context.contracts, 'properties', undefined)!;
    for (const e of r.evidence)
      if (e.property?.manifest) {
        delete e.property.manifest.corpus;
        e.property.manifest.digest = manifestDigest(expected);
      }
    const effective = effectiveChecks(
      { approvedDigest: digestOf(context.order), order: context.order },
      r.inputs.policyDigest,
    );
    r.inputs.checks = effective;
    r.evidence.forEach((e) => (e.checks = effective));
  });
  const problems = resultProblems(withoutCorpus, context);
  assert.ok(
    problems.some((p) => /корпус результата не совпадает с закреплённым/.test(p)),
    problems.join('; '),
  );
  // Без сведений получателя о закреплённом корпусе такой результат не подтверждается.
  const { checkVersion: _pin, ...blind } = context;
  void _pin;
  assert.ok(
    resultProblems(withoutCorpus, blind).some((p) =>
      /не передал закреплённую версию корпуса/.test(p),
    ),
  );
});

test('S2-R2-03/T20: получатель раскрывает область поручения сам — пустой или сокращённый список, подмена группы отклонены; прежний и новый формат проходят', () => {
  const { engine: e, store } = engineOf();
  ready(e, graphOf({ a: [] }));
  const a = e.claim('c1')!;
  e.phase(a.id, a.token, 'verifying', { baseSha: sha('a'), candidateSha: sha('c') });
  e.phase(a.id, a.token, 'integrating', { integrationSha: sha('b') });
  for (const phase of ['candidate', 'integration'] as const)
    for (const gate of ['unit', 'independent-review'])
      e.evidence(a.id, a.token, {
        kind: gate === 'unit' ? 'test' : 'review',
        phase,
        sha: sha(phase === 'candidate' ? 'c' : 'b'),
        gate,
        passed: true,
        command: ['x'],
        exitCode: 0,
        log: '',
        digest: digestOf(gate + phase),
        summary: 'ok',
      });
  e.finish(a.id, a.token, sha('b'));
  const { result, order, repository } = e.read((v) => ({
    result: runResult(v.attempt(a.id)!, '0.1.0-test'),
    order: v.work('a')!.order,
    repository: e.policy.repositories[0]!,
  }));
  store.close();
  assert.deepEqual(order.gates, ['unit']);
  const context = { order, contracts: [], repository };
  assert.deepEqual(resultProblems(result, context), [], 'новый формат');
  // Пустой список и ни одной записи test — отказ.
  const empty = tamper(result, (r) => {
    r.inputs.requiredGates = [];
    r.evidence = r.evidence.filter((x) => x.kind === 'review');
  });
  const problems = resultProblems(empty, context);
  assert.ok(
    problems.some((p) => /область поручения требует unit/.test(p)),
    problems.join('; '),
  );
  assert.ok(problems.some((p) => /Нет PASS: candidate\/unit/.test(p)));
  // Прежний формат: без версий и без requiredGates — по области получателя.
  const legacy = tamper(result, (r) => {
    delete r.inputs.checks;
    delete r.inputs.requiredGates;
    r.evidence.forEach((x) => delete x.checks);
  });
  assert.deepEqual(resultProblems(legacy, context), [], 'прежний формат');
  // Группа gates у получателя: результат проверял только часть её состава.
  const grouped = { ...order, gates: ['@ci'] };
  const groupRepo = {
    ...repository,
    gates: [...repository.gates, { ...repository.gates[0]!, id: 'lint' }],
    gateGroups: { ci: ['unit', 'lint'] },
  };
  const partial = tamper(legacy, (r) => {
    r.inputs.workOrderDigest = digestOf(grouped);
    r.inputs.requiredGates = ['unit'];
  });
  const scoped = resultProblems(partial, { order: grouped, contracts: [], repository: groupRepo });
  assert.ok(
    scoped.some((p) => /область поручения требует lint/.test(p)),
    scoped.join('; '),
  );
  // Имя группы не принимается за имя проверки: PASS «@ci» ничего не доказывает.
  const named = tamper(partial, (r) => {
    r.inputs.requiredGates = ['@ci'];
    for (const x of [...r.evidence])
      if (x.gate === 'unit') r.evidence.push({ ...x, id: x.id + '-g', gate: '@ci' });
  });
  const byName = resultProblems(named, { order: grouped, contracts: [], repository: groupRepo });
  assert.ok(
    byName.some((p) => /требует unit, lint|требует lint/.test(p)),
    byName.join('; '),
  );
  // Без политики получателя поручение с группой не подтверждается.
  assert.ok(
    resultProblems(partial, { order: grouped, contracts: [] }).some((p) =>
      /нужна политика репозитория получателя/.test(p),
    ),
  );
});
