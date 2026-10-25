/**
 * H3-01: одна декларация общих операций. `sharedOperations` — производное
 * представление договора CLI (`cliCommands`, `cliDataSchemas`,
 * `cliTransportLimits`) без второй копии текста; прежние команды, их данные и
 * конверт не меняются.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  cliCommands,
  cliDataSchemas,
  operationCatalogSchema,
  type CliArgument,
} from '../src/contracts/index.ts';
import * as root from '../src/index.ts';
import {
  cliTransportLimits,
  isSharedOperation,
  sharedOperationNames,
  sharedOperations,
} from '../src/catalog/index.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harness = (args: string[]) => {
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    cwd: mkdtempSync(join(tmpdir(), 'harness-cwd-')),
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    json: JSON.parse(r.stdout) as { ok: boolean; error?: { code: string } },
  };
};
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Команды CLI кандидата H2 (`5077625`) в порядке объявления. */
const h2Commands = [
  'validate',
  'review-plan',
  'review-contract',
  'approve',
  'run',
  'status',
  'events',
  'pause',
  'resume',
  'cancel',
  'retry',
  'result',
  'deliver',
  'cleanup',
  'profile',
  'doctor',
  'init',
  'explain',
  'plan-request',
  'plan-check',
  'source-check',
  'source-snapshot',
  'source-status',
  'source-deliver',
  'source-reconcile',
] as const;
/**
 * SHA-256 `JSON.stringify(cliCommands)` и JSON Schema данных
 * (`{io:'output', unrepresentable:'any'}`) всех команд на `5077625`.
 */
const H2_COMMANDS_SHA = '58efd5e554cd5b015538ef1d4e7dd8d20f24205ef24e28c5b27394642bc20e25';
const H2_DATA_SHA = '95016c62e6e7fb134ab3dcde4aff35679951fe1b9037452bc86846230ffa5682';
/** Единственная намеренная правка текста прежней команды в L0: порядок записи init. */
const H2_INIT_DESCRIPTION =
  'Подготовить существующий Git npm/pnpm-репозиторий: план или create-only запись .harness/ (политика из профиля и toolchain inspection, manifest последним); чужие файлы не меняются';

test('H3-01: capabilities объявлена в договоре CLI — без записи, без отказов, данные — operationCatalogSchema', () => {
  assert.ok('capabilities' in cliCommands);
  assert.equal(cliCommands.capabilities.writes, false);
  assert.deepEqual(cliCommands.capabilities.refusals, []);
  assert.deepEqual(cliCommands.capabilities.args, []);
  assert.equal(cliDataSchemas.capabilities, operationCatalogSchema);
  assert.equal(root.operationCatalogSchema, operationCatalogSchema);
});

test('H3-01: ключи sharedOperations = sharedOperationNames — пять операций в порядке декларации', () => {
  assert.deepEqual(
    [...sharedOperationNames],
    ['init', 'explain', 'plan-request', 'plan-check', 'capabilities'],
  );
  assert.deepEqual(Object.keys(sharedOperations), [...sharedOperationNames]);
  for (const name of Object.keys(cliCommands))
    assert.equal(
      isSharedOperation(name),
      (sharedOperationNames as readonly string[]).includes(name),
      name,
    );
});

test('H3-01: каждая общая операция читается из договора CLI — writes, описание, ответ, вход, пределы', () => {
  for (const c of sharedOperationNames) {
    const op = sharedOperations[c];
    const contract = cliCommands[c];
    assert.equal(contract.writes, !op.readOnly, c);
    assert.equal(op.description, contract.description, c);
    assert.equal(op.output, cliDataSchemas[c], c);
    assert.equal(op.limits, cliTransportLimits, c);
    assert.deepEqual(op.limits, { maxInputBytes: 100000, maxResultBytes: 1048576 });

    const args: readonly CliArgument[] = contract.args;
    const shape = op.input.shape as Record<string, z.ZodType>;
    assert.deepEqual(
      Object.keys(shape),
      args.map((a) => a.name.replace(/^--/, '')),
      `${c}: ключи входа = имена args`,
    );
    // Опубликованная форма входа (как в каталоге): описание и required из args.
    const json = z.toJSONSchema(op.input, { io: 'input' }) as {
      properties: Record<string, { description?: string }>;
      required?: string[];
      additionalProperties: boolean;
    };
    assert.deepEqual(
      json.required ?? [],
      args.filter((a) => a.required).map((a) => a.name.replace(/^--/, '')),
      `${c}: required ⇔ не optional`,
    );
    assert.equal(json.additionalProperties, false, c);
    for (const arg of args) {
      const key = arg.name.replace(/^--/, '');
      const schema = shape[key]!;
      assert.equal(schema.safeParse(undefined).success, !arg.required, `${c} ${key}: required`);
      assert.equal(json.properties[key]?.description, arg.description, `${c} ${key}: описание`);
      if (arg.value === 'flag') {
        assert.ok(schema.safeParse(true).success, `${c} ${key}: флаг`);
        assert.equal(schema.safeParse('x').success, false, `${c} ${key}: флаг не строка`);
      } else if (arg.multiple) {
        assert.ok(schema.safeParse(['a', 'b']).success, `${c} ${key}: список`);
        assert.equal(schema.safeParse('a').success, false, `${c} ${key}: не строка`);
        assert.equal(schema.safeParse([]).success, false, `${c} ${key}: не пустой`);
      } else {
        assert.ok(schema.safeParse('a').success, `${c} ${key}: строка`);
        assert.equal(schema.safeParse('').success, false, `${c} ${key}: не пустая`);
        assert.equal(schema.safeParse(['a']).success, false, `${c} ${key}: не список`);
      }
    }
    // Вход строгий: лишний ключ отвергается.
    assert.equal(op.input.safeParse({ unknownArg: 'x' }).success, false, c);
  }
  // multiple объявлен только у --requirements plan-request.
  const multiple = Object.entries(cliCommands).flatMap(([c, contract]) =>
    (contract.args as readonly CliArgument[]).filter((a) => a.multiple).map((a) => c + a.name),
  );
  assert.deepEqual(multiple, ['plan-request--requirements']);
  assert.deepEqual(Object.keys(sharedOperations.capabilities.input.shape), []);
});

test('H3-01: API каждой общей операции опубликован корнем пакета функцией', () => {
  const apis = Object.fromEntries(sharedOperationNames.map((c) => [c, sharedOperations[c].api]));
  assert.deepEqual(apis, {
    init: 'initProject',
    explain: 'diagnoseState',
    'plan-request': 'planRequestOf',
    'plan-check': 'planCheck',
    capabilities: 'harnessCapabilities',
  });
  const exports = root as unknown as Record<string, unknown>;
  for (const c of sharedOperationNames)
    assert.equal(typeof exports[sharedOperations[c].api], 'function', c);
});

test('H3-01: прежние команды и схемы их данных не изменились — только добавлена capabilities', () => {
  assert.deepEqual(Object.keys(cliCommands), [
    ...h2Commands.slice(0, 20),
    'capabilities',
    ...h2Commands.slice(20),
  ]);
  assert.deepEqual(
    Object.keys(cliDataSchemas).sort(),
    [...h2Commands, 'capabilities', 'version'].sort(),
  );

  // Тот же JSON договора H2: без capabilities, без аддитивного multiple и прежнего текста init.
  const before = Object.fromEntries(
    h2Commands.map((c) => {
      const contract = cliCommands[c];
      return [
        c,
        {
          ...contract,
          ...(c === 'init' ? { description: H2_INIT_DESCRIPTION } : {}),
          args: (contract.args as readonly CliArgument[]).map((arg) => {
            const copy: CliArgument = { ...arg };
            delete copy.multiple;
            return copy;
          }),
        },
      ];
    }),
  );
  assert.equal(sha256(JSON.stringify(before)), H2_COMMANDS_SHA);

  const data = Object.fromEntries(
    Object.entries(cliDataSchemas)
      .filter(([c]) => c !== 'capabilities')
      .map(([c, s]) => [
        c,
        z.toJSONSchema(s as z.ZodType, { io: 'output', unrepresentable: 'any' }),
      ]),
  );
  // Порядок ключей cliDataSchemas H2 — без capabilities.
  assert.equal(sha256(JSON.stringify(data)), H2_DATA_SHA);
});

test('H3-01: --help называет capabilities; прежние команды и capabilities отвечают тем же конвертом', () => {
  const help = spawnSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), cli, '--help'],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
  );
  assert.equal(help.status, 0);
  assert.match(help.stderr, /capabilities/);
  assert.ok(help.stderr.includes(cliCommands.capabilities.description));

  const cases: [string[], number, string[]][] = [
    [['version'], 0, ['apiVersion', 'command', 'ok', 'data']],
    [['capabilities'], 0, ['apiVersion', 'command', 'ok', 'data']],
    [['capabilities', '--human'], 2, ['apiVersion', 'command', 'ok', 'error']],
    [['capabilities', 'extra'], 2, ['apiVersion', 'command', 'ok', 'error']],
    [['profile', '--profile', 'npm-ci'], 0, ['apiVersion', 'command', 'ok', 'data']],
    [
      ['status', '--state', '/nonexistent-harness-state'],
      3,
      ['apiVersion', 'command', 'ok', 'error'],
    ],
    [['no-such-command'], 2, ['apiVersion', 'command', 'ok', 'error']],
  ];
  for (const [args, status, keys] of cases) {
    const r = harness(args);
    assert.equal(r.status, status, args.join(' ') + ' ' + r.stderr);
    assert.equal(r.stdout.trimEnd().split('\n').length, 1, 'ровно одна строка');
    assert.deepEqual(Object.keys(r.json), keys, args.join(' '));
  }
});
