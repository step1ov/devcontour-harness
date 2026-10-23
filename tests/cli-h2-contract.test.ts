import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cliCommands,
  cliDataSchemas,
  planDraft,
  publishedSchemas,
} from '../src/contracts/index.ts';
import * as root from '../src/index.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harness = (args: string[]) => {
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    cwd: mkdtempSync(join(tmpdir(), 'harness-cwd-')),
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  return {
    status: r.status,
    json: JSON.parse(r.stdout) as { ok: boolean; error?: { code: string } },
  };
};

test('H2-01: plan-request и plan-check объявлены без записи, со своими схемами данных и отказами', () => {
  assert.equal(cliCommands['plan-request'].writes, false);
  assert.equal(cliCommands['plan-check'].writes, false);
  assert.ok(cliDataSchemas['plan-request']);
  assert.ok(cliDataSchemas['plan-check']);
  assert.deepEqual(cliCommands['plan-request'].refusals, ['NOT_READY']);
  assert.deepEqual(cliCommands['plan-check'].refusals, ['APPROVAL_STALE', 'NOT_READY']);
  assert.ok('plan-draft' in publishedSchemas);
});

test('H2-01: флаги планирования принимают только свои команды — INVALID_INPUT, exit 2', () => {
  for (const args of [
    ['validate', '--graph', 'g.json', '--policy', 'p.json', '--draft', 'd.json'],
    ['plan-check', '--draft', 'd.json', '--policy', 'p.json', '--human'],
    ['status', '--state', '/nonexistent', '--brief', 'b.md'],
    ['plan-check', '--draft', 'd.json', '--policy', 'p.json', '--requirements', 'r.md'],
  ]) {
    const r = harness(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.json.error?.code, 'INVALID_INPUT', args.join(' '));
  }
});

test('H2-03: планирование не импортирует runtime, движок, controller и хранилище', () => {
  const dir = fileURLToPath(new URL('../src/planning/', import.meta.url));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    assert.doesNotMatch(
      text,
      /from '\.\.\/(agents|engine|control|storage|integrations|environment)\//,
      file,
    );
  }
});

test('H2-01: planDraft — один объект в корне и в /contracts; расширение не переопределяет общее поле', () => {
  assert.equal(root.planDraft, planDraft);
  assert.throws(
    () => planDraft({ key: planDraft().shape.title }),
    /не переопределяет общее поле: key/,
  );
  assert.throws(() => planDraft({}, { keyOrder: ['key'] }), /перестановка всех ключей/);
});
