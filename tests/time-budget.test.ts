import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doctor } from '../src/control/doctor.ts';
import { policyIssues, type ExecutionPolicy } from '../src/contracts/index.ts';
import * as root from '../src/index.ts';
import {
  gateChain,
  longestGateChain,
  timeBudgetWarnings,
} from '../src/verification/time-budget.ts';
import { policyOf } from './engine-fixture.ts';

const MIN = 60_000;
const junit = (id: string) => ({ type: 'junit', path: `reports/${id}.xml` });
const gate = (id: string, minutes: number, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'test',
  command: ['node', id + '.js'],
  report: junit(id),
  timeoutMs: minutes * MIN,
  ...extra,
});
const check = (id: string, minutes: number, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'check',
  command: ['node', id + '.js'],
  timeoutMs: minutes * MIN,
  ...extra,
});

/** Политика из примера с одним репозиторием, заданными gates и сроком фазы. */
const policyWith = (
  gates: Record<string, unknown>[],
  runMinutes: number,
  patch: (repo: Record<string, unknown>, p: Record<string, unknown>) => void = () => {},
): ExecutionPolicy =>
  policyOf((p) => {
    const repos = p.repositories as Record<string, unknown>[];
    p.repositories = [repos[0]];
    const repo = repos[0]!;
    repo.gates = gates;
    delete repo.gateGroups;
    p.runTimeoutMs = runMinutes * MIN;
    patch(repo, p);
  });

test('срок фазы: сумма пределов больше runTimeoutMs — предупреждение с числами, не ошибка политики', () => {
  const policy = policyWith([gate('unit', 10), gate('e2e', 8)], 15, (repo) => {
    repo.lifecycle = {
      setup: [{ id: 'db', command: ['true'], timeoutMs: 2 * MIN }],
      ready: [{ id: 'wait', command: ['true'], timeoutMs: MIN }],
      teardown: [{ id: 'down', command: ['true'] }],
    };
    repo.prepare = [{ id: 'build', command: ['true'], timeoutMs: 3 * MIN }];
  });
  assert.deepEqual(policyIssues(policy), [], 'срок фазы не делает политику невалидной');
  const warnings = timeBudgetWarnings(policy);
  assert.deepEqual(
    warnings.map((w) => [w.phase, w.totalMs, w.limitMs]),
    [
      ['verification', 18 * MIN, 15 * MIN],
      ['integration', 24 * MIN, 15 * MIN],
    ],
  );
  const integration = warnings[1]!;
  assert.deepEqual(integration.parts, [
    { what: 'lifecycle setup/ready', ms: 3 * MIN },
    { what: 'prepare', ms: 3 * MIN },
    { what: 'gates', ms: 18 * MIN },
  ]);
  assert.match(
    integration.message,
    /^app, фаза integration: сумма пределов lifecycle setup\/ready 3 мин \+ prepare 3 мин \+ gates 18 мин \(24 мин\) больше runTimeoutMs \(15 мин\): /,
  );
  assert.match(integration.message, /истечь до конца проверок/);
  // Gates независимы: самая длинная цепочка — один unit (10 мин), с окружением 16 мин > 15.
  assert.deepEqual(integration.longestChain, { gates: ['unit'], ms: 10 * MIN });
  assert.match(integration.message, /даже самая длинная цепочка gates \(unit, 10 мин\)/);
  assert.match(warnings[0]!.message, /цепочка gates \(unit, 10 мин\) укладывается/);
});

test('срок фазы: в пределах runTimeoutMs — предупреждений нет', () => {
  const policy = policyWith([gate('unit', 5), gate('e2e', 5)], 15, (repo) => {
    repo.prepare = [{ id: 'build', command: ['true'], timeoutMs: 4 * MIN }];
    repo.generators = [
      { id: 'api', command: ['true'], inputs: ['api/'], outputs: ['gen/'], timeoutMs: MIN },
    ];
  });
  assert.deepEqual(timeBudgetWarnings(policy), []);
});

test('срок фазы: цепочка dependsOn — gate с замыканием предпосылок в порядке исполнения', () => {
  const gates = [
    check('install', 4),
    check('build', 6, { dependsOn: ['install'] }),
    gate('unit', 3, { dependsOn: ['build'] }),
    gate('lint', 2, { dependsOn: [] }),
    gate('e2e', 9, { dependsOn: ['build', 'lint'] }),
  ];
  const policy = policyWith(gates, 60);
  const repo = policy.repositories[0]!;
  assert.deepEqual(gateChain(repo.gates, 'unit', policy), {
    gates: ['install', 'build', 'unit'],
    ms: 13 * MIN,
  });
  assert.deepEqual(gateChain(repo.gates, 'lint', policy), { gates: ['lint'], ms: 2 * MIN });
  assert.deepEqual(longestGateChain(repo.gates, policy), {
    gates: ['install', 'build', 'lint', 'e2e'],
    ms: 21 * MIN,
  });
  // Режим порядка массива: у gate без dependsOn предпосылки — более ранние check gates.
  const ordered = policyWith([check('install', 4), gate('fast', 1), gate('slow', 7)], 60);
  assert.deepEqual(longestGateChain(ordered.repositories[0]!.gates, ordered), {
    gates: ['install', 'slow'],
    ms: 11 * MIN,
  });
  // Нижняя граница предела gate входит в сумму.
  const floored = policyWith(gates, 60, (_, p) => {
    p.gateTimeoutFloorMs = 5 * MIN;
  });
  assert.equal(gateChain(floored.repositories[0]!.gates, 'unit', floored).ms, 16 * MIN);
  // Полная область всех gates: 24 мин > 20 мин, цепочка e2e (21 мин) — тоже нет.
  const tight = policyWith(gates, 20);
  const [verification] = timeBudgetWarnings(tight);
  assert.equal(verification?.phase, 'verification');
  assert.equal(verification?.totalMs, 24 * MIN);
  assert.match(verification.message, /install → build → lint → e2e, 21 мин\) не укладывается/);
});

test('срок фазы: генераторы, установка зависимостей исполнителя и совместная проверка', () => {
  const policy = policyWith(
    [check('install', 6, { command: ['npm', 'ci'] }), gate('unit', 1)],
    10,
    (repo, p) => {
      repo.prepare = [{ id: 'build', command: ['true'], timeoutMs: 5 * MIN }];
      repo.generators = [
        { id: 'a', command: ['true'], inputs: ['a/'], outputs: ['ga/'], timeoutMs: 6 * MIN },
        { id: 'b', command: ['true'], inputs: ['b/'], outputs: ['gb/'], timeoutMs: 5 * MIN },
      ];
      p.workspaceGates = [
        {
          id: 'joint',
          kind: 'check',
          repositoryId: 'app',
          command: ['true'],
          timeoutMs: 11 * MIN,
        },
      ];
    },
  );
  const warnings = timeBudgetWarnings(policy);
  assert.deepEqual(
    warnings.map((w) => [w.phase, w.totalMs / MIN]),
    [
      ['implementation', 11],
      ['generation', 11],
      ['verification', 18],
      ['integration', 23],
      ['joint', 11],
    ],
  );
  assert.match(warnings[0]!.message, /установка зависимостей исполнителя 6 мин/);
  const off = policyWith(
    [check('install', 6, { command: ['npm', 'ci'] }), gate('unit', 1)],
    10,
    (repo) => {
      repo.prepare = [{ id: 'build', command: ['true'], timeoutMs: 5 * MIN }];
      repo.writerDependencies = false;
    },
  );
  assert.deepEqual(
    timeBudgetWarnings(off).map((w) => w.phase),
    ['integration'],
    'без установки исполнителя фаза реализации укладывается',
  );
  assert.equal(root.timeBudgetWarnings, timeBudgetWarnings, 'опубликовано корнем пакета');
});

test('doctor --policy называет превышение срока фазы в warnings, не в problems', async () => {
  const over = policyWith([gate('unit', 10), gate('e2e', 8)], 15);
  const report = await doctor(over, {});
  assert.equal(report.warnings?.length, 1);
  assert.match(report.warnings[0]!, /\(18 мин\) больше runTimeoutMs \(15 мин\)/);
  assert.ok(!report.problems.some((p) => /runTimeoutMs/.test(p)));
  assert.deepEqual((await doctor(policyWith([gate('unit', 1)], 15), {})).warnings, []);
  assert.equal((await doctor(undefined, {})).warnings, undefined, 'без политики поля нет');
});
