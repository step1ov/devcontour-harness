/**
 * Байтовое равенство JSON Schema плана DevContour (M-5, K1). Фикстуры сняты
 * один раз read-only в checkout DevContour `ab35a6a`; DevContour во время
 * тестов не нужен:
 *
 *   node --import tsx -e "import('./src/core/plan.ts').then(m=>process.stdout.write(JSON.stringify(m.planSchema)))" \
 *     > tests/fixtures/planning/devcontour-plan-schema.json
 *   node --import tsx -e "Promise.all([import('./src/core/plan.ts'),import('zod')]).then(([m,{z}])=>process.stdout.write(JSON.stringify(z.toJSONSchema(m.planResult,{io:'input'}))))" \
 *     > tests/fixtures/planning/devcontour-plan-input-schema.json
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { planDraft, planDraftJsonSchema, sha256 } from '../src/contracts/index.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/planning/${name}`, import.meta.url), 'utf8');
const runtime = fixture('devcontour-plan-schema.json');
const input = fixture('devcontour-plan-input-schema.json');

/** Поля хоста DevContour: `featureId` (slug) и `assignee` из `taskInput`. */
const hostExtension = {
  featureId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}$/)
    .optional(),
  assignee: z
    .string()
    .regex(/^[A-Za-z0-9_.@-]{1,80}$/)
    .optional(),
};
const keyOrder = [
  'featureId',
  'requirements',
  'assignee',
  'scope',
  'relatedRepositories',
  'contextPacks',
  'writePaths',
  'gates',
  'properties',
  'resources',
  'repositoryId',
  'key',
  'title',
  'description',
  'role',
  'dependsOn',
  'acceptance',
  'contracts',
];
const planResult = planDraft(hostExtension, { keyOrder });

test('H2-01: фикстуры схемы плана DevContour — те самые байты (§4)', () => {
  assert.equal(Buffer.byteLength(runtime), 2394);
  assert.equal(sha256(runtime), 'b6461127f7f0831181187c2d2d9c87671f5a196ecf97d9010120a86b7e46179e');
  assert.equal(Buffer.byteLength(input), 2318);
  assert.equal(sha256(input), '36c5ec758791d049f5929522d60dd730363d925c07cedc144f682703db4f05f7');
  assert.equal(runtime.endsWith('\n'), false);
  assert.equal(input.endsWith('\n'), false);
});

test('H2-01: planDraft хоста с keyOrder даёт байтово ту же JSON Schema DevContour (runtime и io:input)', () => {
  const runtimeBytes = JSON.stringify(planDraftJsonSchema(planResult));
  const inputBytes = JSON.stringify(z.toJSONSchema(planResult, { io: 'input' }));
  assert.equal(runtimeBytes, runtime);
  assert.equal(sha256(runtimeBytes), sha256(runtime));
  assert.equal(inputBytes, input);
  assert.equal(sha256(inputBytes), sha256(input));
});

test('H2-01: без keyOrder порядок полей иной — байты схемы отличаются (K1, регрессия)', () => {
  const unordered = planDraft(hostExtension);
  const runtimeBytes = JSON.stringify(planDraftJsonSchema(unordered));
  const inputBytes = JSON.stringify(z.toJSONSchema(unordered, { io: 'input' }));
  assert.notEqual(runtimeBytes, runtime);
  assert.notEqual(inputBytes, input);
  // Отличие — только порядок: канонически схемы совпадают.
  const sorted = (text: string) => JSON.stringify(sortKeys(JSON.parse(text)));
  assert.equal(sorted(runtimeBytes), sorted(runtime));
  assert.equal(sorted(inputBytes), sorted(input));
  // Общая форма без расширения — тоже не схема DevContour.
  assert.notEqual(JSON.stringify(planDraftJsonSchema(planDraft())), runtime);
});

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
  );
}

test('H2-01: ожидания consumer-h2 — байтовые копии фикстур схемы (§4, п. 4)', () => {
  for (const name of ['devcontour-plan-schema.json', 'devcontour-plan-input-schema.json'])
    assert.equal(
      readFileSync(new URL(`./fixtures/consumer-h2/expected/${name}`, import.meta.url), 'utf8'),
      fixture(name),
      name,
    );
});
