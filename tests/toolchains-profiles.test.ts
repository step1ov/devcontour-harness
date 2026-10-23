/* eslint-disable @typescript-eslint/no-explicit-any --
 * Тест читает JSON примеров как есть; форму проверяет схема политики.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionPolicySchema } from '../src/contracts/index.ts';
import { repositoryFromProfile, resolveProfile } from '../src/profiles/resolve.ts';
import { inspectPolicy, type ToolProbe } from '../src/toolchains/index.ts';

const examples = fileURLToPath(new URL('../examples/toolchains/', import.meta.url));
const variants = ['npm', 'pnpm', 'turbo', 'go', 'python', 'mixed-go', 'mixed-python'];
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

test('T01/T02: новые профили toolchain — свои ID, без неявной npm-подготовки у языков, с закреплёнными версиями', () => {
  const expected: Record<string, { managers: string[]; tools: Record<string, string> }> = {
    'npm-ci': { managers: ['npm'], tools: { npm: '11.4.2' } },
    'pnpm-frozen': { managers: ['pnpm'], tools: { pnpm: '10.12.3' } },
    'go-gotestsum': { managers: [], tools: { gotestsum: '1.12.3' } },
    'python-uv': { managers: [], tools: { uv: '0.11.28' } },
  };
  for (const [id, want] of Object.entries(expected)) {
    const p = resolveProfile(id);
    assert.deepEqual(p.toolchain?.tools, want.tools, id);
    assert.deepEqual(Object.values(p.toolchain?.packageManagers ?? {}), want.managers, id);
    const argv = [...p.prepare, ...p.gates].map((s) => s.command.join(' '));
    assert.ok(
      argv.every((a) => !/@latest|--if-present/.test(a)),
      id,
    );
    if (!want.managers.length)
      assert.ok(
        argv.every((a) => !/^(npm|pnpm|npx|yarn)\b/.test(a)),
        `${id}: язык не наследует npm-подготовку`,
      );
  }
  // Прежние профили языков по-прежнему без npm и без toolchain (их байты не менялись).
  for (const id of ['go-api', 'python-api']) {
    const p = resolveProfile(id);
    assert.equal(p.toolchain, undefined);
    assert.ok(p.gates.every((g) => !/^(npm|pnpm)$/.test(g.command[0]!)));
  }
});

test('T01: политики примеров npm/pnpm/go/python — ровно профили; pure Go/Python без package.json', () => {
  const byProfile: Record<string, string> = {
    npm: 'npm-ci',
    pnpm: 'pnpm-frozen',
    go: 'go-gotestsum',
    python: 'python-uv',
  };
  for (const [variant, id] of Object.entries(byProfile)) {
    const policy = executionPolicySchema.parse(json(join(examples, variant, 'policy.json')));
    const repo = policy.repositories[0]!;
    const { repository } = repositoryFromProfile(resolveProfile(id), {
      id: repo.id,
      path: repo.path,
      targetRef: repo.targetRef,
    });
    assert.deepEqual(repo.gates, repository.gates, variant);
    assert.deepEqual(repo.prepare, repository.prepare, variant);
    assert.deepEqual(repo.toolchain, repository.toolchain, variant);
  }
  for (const variant of ['go', 'python'])
    assert.ok(!existsSync(join(examples, variant, 'repo/package.json')), variant);
  for (const variant of variants) {
    const policy = executionPolicySchema.parse(json(join(examples, variant, 'policy.json')));
    assert.equal(policy.repositories.length, 1, `${variant}: один Git root — одна запись`);
  }
});

test('T02: все семь примеров проходят preflight на чтении — без проблем и без запуска проекта', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-tc-examples-')));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const versions: Record<string, string> = {
    node: 'v24.3.0',
    npm: '11.4.2',
    pnpm: '10.12.3',
    go: 'go version go1.24.5 darwin/arm64',
    gotestsum: 'gotestsum version 1.12.3',
    uv: 'uv 0.11.28',
  };
  for (const name of Object.keys(versions)) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 99\n');
    chmodSync(join(bin, name), 0o755);
  }
  const calls: string[][] = [];
  const probe: ToolProbe = (argv) => {
    calls.push(argv);
    return Promise.resolve({
      code: 0,
      stdout: versions[argv[0]!.split('/').at(-1)!] ?? '',
      stderr: '',
      timedOut: false,
    });
  };
  for (const variant of variants) {
    const base = join(dir, variant);
    cpSync(join(examples, variant), base, { recursive: true });
    const rename = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true }))
        if (e.isDirectory()) rename(join(d, e.name));
        else if (e.name === '_gitignore') renameSync(join(d, e.name), join(d, '.gitignore'));
    };
    rename(base);
    const policy = executionPolicySchema.parse(json(join(base, 'policy.json')));
    const [report] = await inspectPolicy(policy, base, { probe, env: { PATH: bin, HOME: dir } });
    assert.deepEqual(report!.problems, [], variant);
    assert.deepEqual(report!.warnings, [], variant);
    const tests = report!.plan.filter((p) => p.kind === 'test');
    assert.ok(tests.length >= 1 && tests.every((p) => p.report), variant);
  }
  assert.ok(
    calls.every((argv) => argv[1] === '--version' || argv[1] === 'version'),
    'только пробы версий',
  );
});
