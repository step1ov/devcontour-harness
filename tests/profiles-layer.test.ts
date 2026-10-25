/**
 * H3-fix (Q5): `resolveProfile(ref, { layerSchema })` разбирает файлы профиля
 * схемой хоста. Профили, закреплённые у хоста, имеют свою форму (runtime
 * `demo`, `reviewVendor` ролей, `revision`/`digest` инструкций, нестрогие
 * вложенные объекты, свои правила окружения и ID шагов) — они разрешаются
 * без потери полей. Безопасность файлов, обход `extends`, сложение слоёв,
 * проверки gates, digest и тексты отказов K10 — прежние.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { HarnessError, stackProfileSchema } from '../src/index.ts';
import {
  builtinProfiles,
  resolveProfile,
  type ResolveProfileOptions,
} from '../src/profiles/resolve.ts';

/** Схема файла хоста: форма профилей DevContour (`packs.ts` baseline `ab35a6a`). */
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const envKey = name.refine((s) => !s.startsWith('DEVCONTOUR_'), 'DEVCONTOUR_* задаёт runner');
const step = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().max(3_600_000).default(120000),
});
const binding = z.object({
  runtime: z.enum(['codex', 'claude', 'demo']),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  toolProfile: z.string().optional(),
});
const hostLayer = z.strictObject({
  id,
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
  extends: z.array(z.string().min(1)).max(16).default([]),
  capabilities: z.array(z.string().min(1).max(100)).max(100).default([]),
  gates: z
    .array(
      z.object({
        id,
        dependsOn: z.array(id).optional(),
        kind: z.enum(['check', 'test']),
        command: z.array(z.string().min(1)).min(1),
        timeoutMs: z.number().positive().default(120000),
        report: z.object({ type: z.literal('junit'), path: z.string().min(1) }).optional(),
      }),
    )
    .max(100)
    .default([]),
  prepare: z.array(step).max(100).default([]),
  environment: z
    .object({
      inherit: z.array(envKey).default([]),
      values: z.record(envKey, z.string()).default({}),
      secrets: z.record(envKey, name).default({}),
    })
    .optional(),
  lifecycle: z
    .object({
      setup: z.array(step).default([]),
      ready: z.array(step).default([]),
      teardown: z.array(step).min(1),
    })
    .optional(),
  protectedPaths: z.array(z.string().min(1)).max(100).default([]),
  generatedPaths: z.array(z.string().min(1)).max(100).default([]),
  concurrency: z.number().int().min(1).max(4).optional(),
  runTimeoutMs: z.number().int().min(60_000).max(7_200_000).optional(),
  roles: z
    .record(
      z.string(),
      binding.extend({
        reviewer: binding.optional(),
        reviewVendor: z.enum(['different-vendor', 'same-vendor-allowed']).optional(),
        title: z.string().trim().min(2).max(40).optional(),
      }),
    )
    .default({}),
  contextPacks: z
    .array(
      z.object({
        id,
        version: z.string().min(1),
        repositoryId: id.default('main'),
        roles: z.array(z.string()).default([]),
        files: z.array(z.string().min(1)).min(1).max(30),
        revision: z
          .string()
          .regex(/^[a-f0-9]{40,64}$/)
          .optional(),
        digest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      }),
    )
    .max(50)
    .default([]),
});

const junit = { type: 'junit', path: '.reports/t.xml' };
const testGate = { id: 'tests', kind: 'test', command: ['true'], report: junit };
const longStep = 's'.repeat(100);
const sha40 = 'a'.repeat(40);

function hostRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-profiles-layer-')));
  mkdirSync(join(root, 'profiles'));
  const json = (path: string, value: unknown) =>
    writeFileSync(join(root, 'profiles', path), JSON.stringify(value));
  // Форма хоста, которую stackProfileSchema отвергает.
  json('base.json', {
    id: 'base',
    version: '1.0.0',
    gates: [{ ...testGate, legacy: true }],
    prepare: [{ id: longStep, command: ['npm', 'ci'], note: 'host key' }],
    environment: { inherit: ['HARNESS_HOME'], values: { HARNESS_MODE: 'x' } },
  });
  json('mobile.json', {
    id: 'mobile',
    version: '1.1.0',
    extends: ['./base.json'],
    gates: [{ id: 'lint', kind: 'check', command: ['true'], dependsOn: ['tests'] }],
    roles: {
      mobile: {
        runtime: 'demo',
        reviewVendor: 'same-vendor-allowed',
        title: 'Мобильный разработчик',
        reviewer: { runtime: 'claude', model: '' },
        extra: 1,
      },
    },
    contextPacks: [{ id: 'rn', version: '1', files: ['docs/rn.md'], revision: sha40 }],
  });
  json('dup.json', { id: 'dup', version: '1.0.0', gates: [testGate, testGate] });
  json('reserved.json', {
    id: 'reserved',
    version: '1.0.0',
    gates: [testGate, { id: 'requirement-source', kind: 'check', command: ['true'] }],
  });
  json('no-junit.json', {
    id: 'no-junit',
    version: '1.0.0',
    gates: [{ id: 'tests', kind: 'test', command: ['true'] }],
  });
  json('unknown-dep.json', {
    id: 'unknown-dep',
    version: '1.0.0',
    gates: [testGate, { id: 'lint', kind: 'check', command: ['true'], dependsOn: ['nope'] }],
  });
  json('devcontour-env.json', {
    id: 'devcontour-env',
    version: '1.0.0',
    gates: [testGate],
    environment: { inherit: ['DEVCONTOUR_STATE'] },
  });
  // Схема хоста принимает любую строку пути JUnit; resolver требует путь внутри worktree.
  for (const [file, path] of [
    ['junit-up.json', '../out.xml'],
    ['junit-abs.json', '/abs/out.xml'],
    ['junit-backslash.json', 'a\\b.xml'],
    ['junit-glob.json', 'out/*.xml'],
  ] as const)
    json(file, { id: 'j', version: '1.0.0', gates: [{ ...testGate, report: { ...junit, path } }] });
  json('junit-check.json', {
    id: 'jc',
    version: '1.0.0',
    gates: [
      testGate,
      { id: 'lint', kind: 'check', command: ['true'], report: { ...junit, path: '../l.xml' } },
    ],
  });
  json('cycle-a.json', { id: 'a', version: '1.0.0', extends: ['./cycle-b.json'] });
  json('cycle-b.json', { id: 'b', version: '1.0.0', extends: ['./cycle-a.json'] });
  return root;
}

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HarnessError, 'HarnessError, не ' + String(error));
    assert.equal(error.code, 'INVALID_INPUT');
    return error;
  }
  return assert.fail('ожидался отказ');
};

test('H3-fix: форму хоста stackProfileSchema отвергает, layerSchema разрешает без потери полей', () => {
  const root = hostRepo();
  const options = { repository: root, layerSchema: hostLayer };
  // Без схемы хоста — прежний строгий отказ harness.
  assert.match(
    refusal(() => resolveProfile('./profiles/mobile.json', { repository: root })).message,
    /^Профиль local:profiles\//,
  );
  const p = resolveProfile('./profiles/mobile.json', { ...options, includeLeafContent: true });
  assert.equal(p.id, 'mobile');
  assert.deepEqual(p.roles, {
    mobile: {
      runtime: 'demo',
      reviewVendor: 'same-vendor-allowed',
      title: 'Мобильный разработчик',
      reviewer: { runtime: 'claude', model: '' },
    },
  });
  assert.equal(p.roles.mobile.reviewVendor, 'same-vendor-allowed');
  assert.deepEqual(p.contextPacks, [
    {
      id: 'rn',
      version: '1',
      repositoryId: 'main',
      roles: [],
      files: ['docs/rn.md'],
      revision: sha40,
    },
  ]);
  // Gates — в форме хоста (лишние ключи сняты схемой хоста).
  assert.deepEqual(p.gates, [
    {
      id: 'tests',
      kind: 'test',
      command: ['true'],
      timeoutMs: 120000,
      report: { type: 'junit', path: '.reports/t.xml' },
    },
    { id: 'lint', kind: 'check', command: ['true'], dependsOn: ['tests'], timeoutMs: 120000 },
  ]);
  assert.deepEqual(p.prepare, [{ id: longStep, command: ['npm', 'ci'], timeoutMs: 120000 }]);
  assert.deepEqual(p.environment, {
    inherit: ['HARNESS_HOME'],
    values: { HARNESS_MODE: 'x' },
    secrets: {},
  });
  // Сложение и digest — прежние: файлы локальных слоёв защищены, digest замыкания.
  assert.deepEqual(
    p.closure.map((c) => c.ref),
    ['local:profiles/base.json', 'local:profiles/mobile.json'],
  );
  assert.deepEqual(p.protectedPaths, ['profiles/base.json', 'profiles/mobile.json']);
  assert.deepEqual(p.source, { repositoryId: 'main', path: 'profiles/mobile.json' });
  assert.ok(p.leafContent.includes('"runtime":"demo"'));
});

test('H3-fix: с layerSchema отказы K10 и проверки gates прежние', () => {
  const root = hostRepo();
  const options: ResolveProfileOptions = { repository: root };
  const table: [string, string][] = [
    ['./profiles/dup.json', 'Повтор gate tests'],
    ['./profiles/reserved.json', 'Зарезервированный gate: requirement-source'],
    ['./profiles/no-junit.json', 'Test gate требует JUnit: tests'],
    ['./profiles/unknown-dep.json', 'Неизвестная зависимость gate lint'],
    ['./profiles/cycle-a.json', 'Цикл наследования профилей: local:profiles/cycle-a.json'],
    ['./profiles/junit-up.json', 'Путь JUnit gate tests: '],
    ['./profiles/junit-abs.json', 'Путь JUnit gate tests: '],
    ['./profiles/junit-backslash.json', 'Путь JUnit gate tests: '],
    ['./profiles/junit-glob.json', 'Путь JUnit gate tests: '],
    ['./profiles/junit-check.json', 'Путь JUnit gate lint: '],
    ['./profiles/missing.json', 'Профиль не найден: profiles/missing.json'],
    // Правило окружения — схемы хоста: DEVCONTOUR_* отвергает она.
    ['./profiles/devcontour-env.json', 'Профиль local:profiles/devcontour-env.json: environment'],
  ];
  for (const [ref, prefix] of table) {
    const error = refusal(() => resolveProfile(ref, { ...options, layerSchema: hostLayer }));
    assert.ok(error.message.startsWith(prefix), `${ref}: «${error.message}» → «${prefix}»`);
  }
});

test('H3-fix: встроенные профили — тот же digest и closure по схеме хоста', () => {
  for (const ref of builtinProfiles()) {
    if (resolveProfile(ref).toolchain) {
      // toolchain схема хоста не знает: её отказ — её правило.
      const error = refusal(() => resolveProfile(ref, { layerSchema: hostLayer }));
      assert.match(error.message, /toolchain/, ref);
      continue;
    }
    const plain = resolveProfile(ref, { includeLeafContent: true });
    const host = resolveProfile(ref, { layerSchema: hostLayer, includeLeafContent: true });
    assert.equal(host.digest, plain.digest, ref);
    assert.deepEqual(host.closure, plain.closure, ref);
    assert.equal(host.leafContent, plain.leafContent, ref);
    assert.deepEqual(
      host.gates.map((g) => g.id),
      plain.gates.map((g) => g.id),
      ref,
    );
  }
});

test('H3-fix: stackProfileSchema как layerSchema — тот же результат, что без опции', () => {
  // Явная схема harness ведёт по пути хоста (проверка формы, gates без gateSchema) — итог тот же.
  for (const ref of builtinProfiles())
    assert.deepEqual(
      resolveProfile(ref, { layerSchema: stackProfileSchema }),
      resolveProfile(ref),
      ref,
    );
});

test('H3-fix: layerSchema — только схема Zod; отсутствующий ключ — схема harness', () => {
  for (const bad of [null, {}, 'schema', 1, [], { safeParse: () => ({ success: true }) }]) {
    const error = refusal(() =>
      resolveProfile('node-checks', { layerSchema: bad as unknown as typeof hostLayer }),
    );
    assert.deepEqual(error.issues, [
      { path: ['options', 'layerSchema'], message: 'layerSchema — схема Zod' },
    ]);
  }
  const absent: ResolveProfileOptions & { layerSchema?: undefined } = { layerSchema: undefined };
  assert.equal(resolveProfile('node-checks', absent).id, 'node-checks');
});

test('H3-fix: схема хоста без формы профиля — INVALID_INPUT, не TypeError', () => {
  const schemas = [
    z.object({ id: z.string() }),
    hostLayer.transform((v) => ({ ...v, extends: 'base' })),
    hostLayer.transform((v) => ({ ...v, gates: v.gates.map((g) => ({ ...g, kind: 'other' })) })),
    hostLayer.transform((v) => ({ ...v, roles: [] })),
    hostLayer.transform(() => null),
  ];
  for (const layerSchema of schemas) {
    const error = refusal(() =>
      resolveProfile('node-checks', { layerSchema: layerSchema as unknown as typeof hostLayer }),
    );
    assert.match(error.message, /^layerSchema: слой builtin:node-checks не даёт форму профиля: /);
  }
});
