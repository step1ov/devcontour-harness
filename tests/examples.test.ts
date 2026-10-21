import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FileContextSource, validateInputs } from '../src/index.ts';
import { executionPolicySchema, workGraphSchema } from '../src/contracts/index.ts';

const examples = fileURLToPath(new URL('../examples/', import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(examples + path, 'utf8')) as unknown;
const graph = (path: string) => workGraphSchema.parse(json(path));
const policy = (path: string) => executionPolicySchema.parse(json(path));

test('Примеры конфигурации проходят validate с графом, к которому они относятся', async () => {
  const single = graph('single-task/graph.json');
  for (const name of ['two-vendors', 'one-vendor'])
    assert.equal(
      validateInputs({ graph: single, policy: policy(name + '/policy.json') }).orders,
      1,
    );
  const files = graph('files-only/graph.json');
  const context = await new FileContextSource(examples + 'files-only/context').snapshot(['norms']);
  assert.equal(
    validateInputs({ graph: files, policy: policy('files-only/policy.json'), context }).orders,
    1,
  );
});

test('Пример одного вендора без явного разрешения отклоняется правилом вендора', () => {
  const raw = json('one-vendor/policy.json') as {
    review: Record<string, { vendor?: string }>;
  };
  for (const rule of Object.values(raw.review)) delete rule.vendor;
  let code: string | undefined;
  try {
    validateInputs({
      graph: graph('single-task/graph.json'),
      policy: executionPolicySchema.parse(raw),
    });
  } catch (e) {
    code = (e as { code?: string }).code;
  }
  assert.equal(code, 'REVIEWER_SAME_VENDOR');
});

test('Внешний коннектор примера — корректный модуль, импортирующий только публичный API', () => {
  const path = examples + 'external-connector/connector.mjs';
  assert.equal(spawnSync(process.execPath, ['--check', path]).status, 0);
  const imports = [...readFileSync(path, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['devcontour-harness', 'node:fs']);
});
