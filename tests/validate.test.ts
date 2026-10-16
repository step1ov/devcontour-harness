/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
 * Тест портит сырой JSON-вход произвольными способами: типы входа здесь — то, что проверяется.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HarnessError,
  executionPolicySchema,
  policyIssues,
  sha256,
} from '../src/contracts/index.ts';
import { validateInputs } from '../src/validate.ts';
import { example } from './fixtures.ts';

type Json = Record<string, any>;

const inputs = () => ({ graph: example('graph') as Json, policy: example('policy') as Json });
const twoRepos = (p: Json) => {
  p.repositories.push({
    ...structuredClone(p.repositories[0]),
    id: 'web',
    path: 'web',
    dependsOn: ['app'],
  });
};

/** Каждый вариант обязан отклоняться с названным кодом и путём; принятие любого — регресс. */
const cases: [string, (g: Json, p: Json) => void, string, RegExp][] = [
  [
    'цикл репозиториев',
    (_, p) => (p.repositories[0].dependsOn = ['app']),
    'INVALID_INPUT',
    /Цикл зависимостей компонентов/,
  ],
  [
    'неизвестный репозиторий зависимости',
    (_, p) => (p.repositories[0].dependsOn = ['ghost']),
    'INVALID_INPUT',
    /Неизвестный репозиторий ghost/,
  ],
  [
    'цикл gate',
    (_, p) => (p.repositories[0].gates[0].dependsOn = ['unit']),
    'GATE_GROUP_CYCLE',
    /Цикл зависимостей gates/,
  ],
  [
    'неизвестная зависимость gate',
    (_, p) => (p.repositories[0].gates[0].dependsOn = ['ghost']),
    'GATE_UNKNOWN',
    /ghost/,
  ],
  [
    'test gate без JUnit',
    (_, p) => delete p.repositories[0].gates[0].report,
    'INVALID_INPUT',
    /report/,
  ],
  [
    'JUnit вне worktree',
    (_, p) => (p.repositories[0].gates[0].report.path = '../outside.xml'),
    'INVALID_INPUT',
    /относительный путь/,
  ],
  [
    'только check в репозитории',
    (_, p) => (p.repositories[0].gates[0] = { id: 'unit', kind: 'check', command: ['true'] }),
    'INVALID_INPUT',
    /test gate/,
  ],
  [
    'зарезервированный gate',
    (_, p) =>
      p.repositories[0].gates.push({ id: 'requirement-source', kind: 'check', command: ['true'] }),
    'INVALID_INPUT',
    /зарезервированный/,
  ],
  [
    'неизвестный ресурс поручения',
    (g) => (g.orders[0].resources = ['ghost']),
    'INVALID_INPUT',
    /Неизвестный ресурс: ghost/,
  ],
  [
    'неизвестный ресурс gate',
    (_, p) => (p.repositories[0].gates[0].resources = ['ghost']),
    'INVALID_INPUT',
    /Неизвестный ресурс: ghost/,
  ],
  [
    'порт вне диапазона',
    (_, p) => (p.resources = [{ id: 'db', kind: 'port', value: '80' }]),
    'INVALID_INPUT',
    /1024–65535/,
  ],
  [
    'области роли и поручения не пересекаются',
    (_, p) => (p.roles.developer.writePaths = ['docs']),
    'INVALID_INPUT',
    /не пересекается/,
  ],
  [
    'потребитель равен провайдеру',
    (g) => (g.orders[0].consumers = [{ repositoryId: 'app', gates: ['unit'] }]),
    'INVALID_INPUT',
    /другой компонент/,
  ],
  [
    'повтор потребителя',
    (g, p) => {
      twoRepos(p);
      g.orders[0].consumers = [
        { repositoryId: 'web', gates: ['unit'] },
        { repositoryId: 'web', gates: ['unit'] },
      ];
    },
    'INVALID_INPUT',
    /назван дважды/,
  ],
  [
    'потребитель не зависит от провайдера',
    (g, p) => {
      twoRepos(p);
      p.repositories[1].dependsOn = [];
      g.orders[0].consumers = [{ repositoryId: 'web', gates: ['unit'] }];
    },
    'INVALID_INPUT',
    /не зависит/,
  ],
  [
    'неизвестный tool profile reviewer',
    (_, p) => (p.review.code.reviewer.toolProfile = 'ghost'),
    'INVALID_INPUT',
    /toolProfile/,
  ],
  [
    'tool profile другого runtime',
    (_, p) => {
      p.toolProfiles = { wrong: { runtime: 'codex' } };
      p.roles.developer.writer.toolProfile = 'wrong';
    },
    'INVALID_INPUT',
    /несовместимый toolProfile/,
  ],
  [
    'effort не для codex',
    (_, p) => (p.roles.developer.writer.effort = 'high'),
    'INVALID_INPUT',
    /effort/,
  ],
  [
    'fixture вне режима fixture',
    (_, p) => (p.roles.developer.writer.runtime = 'fixture'),
    'INVALID_INPUT',
    /mode: fixture/,
  ],
  [
    'требование с неизвестным gate',
    (g) =>
      (g.orders[0].requirements = [
        {
          id: 'REQ-1',
          source: 'spec.md',
          digest: sha256('required behavior'),
          text: 'required behavior',
          gate: 'ghost',
          scenario: 'some scenario',
        },
      ]),
    'INVALID_INPUT',
    /test gate: ghost/,
  ],
  [
    'текст требования не совпадает с digest',
    (g) =>
      (g.orders[0].requirements = [
        {
          id: 'REQ-1',
          source: 'spec.md',
          digest: 'a'.repeat(64),
          text: 'required behavior',
          gate: 'unit',
          scenario: 'some scenario',
        },
      ]),
    'INVALID_INPUT',
    /digest/,
  ],
  [
    'область доказательства без test gate',
    (g, p) => {
      p.repositories[0].gates.push({ id: 'lint', kind: 'check', command: ['true'] });
      g.orders[0].gates = ['lint'];
    },
    'INVALID_INPUT',
    /test gate/,
  ],
  [
    'область не замкнута по dependsOn',
    (g, p) => {
      p.repositories[0].gates.push({ id: 'build', kind: 'check', command: ['true'] });
      p.repositories[0].gates[0].dependsOn = ['build'];
      g.orders[0].gates = ['unit'];
    },
    'INVALID_INPUT',
    /требует build/,
  ],
  [
    'репозиторий предпосылки неизвестен',
    (g) => {
      g.orders[0].dependsOn = ['external'];
      g.prerequisites = [
        {
          id: 'external',
          repositoryId: 'ghost',
          resultSha: 'a'.repeat(40),
          receipt: { kind: 'engine', runId: 'r' },
        },
      ];
    },
    'INVALID_INPUT',
    /предпосылки/,
  ],
  [
    'workspace-поручение с одним репозиторием',
    (g) => (g.orders[0].relatedRepositories = ['app']),
    'INVALID_INPUT',
    /минимум два/,
  ],
  [
    'targetRef с точкой в конце',
    (_, p) => (p.repositories[0].targetRef = 'refs/heads/main.'),
    'INVALID_INPUT',
    /check-ref-format/,
  ],
  [
    'targetRef с //',
    (_, p) => (p.repositories[0].targetRef = 'refs/heads/a//b'),
    'INVALID_INPUT',
    /check-ref-format/,
  ],
  [
    'targetRef с .lock',
    (_, p) => (p.repositories[0].targetRef = 'refs/heads/a.lock/b'),
    'INVALID_INPUT',
    /check-ref-format/,
  ],
  [
    'env с префиксом harness',
    (_, p) => (p.environment = { values: { HARNESS_RUN_ID: 'x' } }),
    'INVALID_INPUT',
    /HARNESS_RUN_ID/,
  ],
  ['пустой предел бюджета', (_, p) => (p.budgets = { work: {} }), 'INVALID_INPUT', /budgets/],
];

for (const [name, mutate, code, message] of cases)
  test('validate отклоняет: ' + name, () => {
    const { graph, policy } = inputs();
    mutate(graph, policy);
    assert.throws(
      () => validateInputs({ graph, policy }),
      (e: unknown) => {
        assert.ok(e instanceof HarnessError, String(e));
        const text = [e.message, ...e.issues.map((i) => `${i.path.join('.')}: ${i.message}`)].join(
          '\n',
        );
        assert.equal(e.code, code, text);
        assert.match(text, message);
        return true;
      },
    );
  });

test('Без мутаций пример проходит: отказы выше вызваны мутацией, а не самим примером', () => {
  const { graph, policy } = inputs();
  assert.equal(validateInputs({ graph, policy }).orders, 1);
  // Тот же потребитель, корректно объявленный, проходит: запрет точечный.
  twoRepos(policy);
  graph.orders[0].consumers = [{ repositoryId: 'web', gates: ['unit'] }];
  assert.equal(validateInputs({ graph, policy }).orders, 1);
});

test('Репозиторий только с check отклоняет сама политика, а не только связь поручения', () => {
  const { policy } = inputs();
  policy.repositories[0].gates[0] = { id: 'unit', kind: 'check', command: ['true'] };
  const issues = policyIssues(executionPolicySchema.parse(policy));
  assert.ok(
    issues.some((i) => /test gate/.test(i.message) && i.path[0] === 'repositories'),
    JSON.stringify(issues),
  );
});
