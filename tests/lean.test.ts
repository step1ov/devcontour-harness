import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HarnessError,
  executionPolicySchema,
  policyDigest,
  projectManifestSchema,
} from '../src/contracts/index.ts';
import { builtinProfiles, builtinProfilesRoot, resolveProfile } from '../src/profiles/resolve.ts';
import { generatePolicy } from '../src/init/policy.ts';
import { initProject, planProject, type InitOptions } from '../src/init/project.ts';
import type { ToolProbe } from '../src/toolchains/probe.ts';

const fixture = fileURLToPath(new URL('./fixtures/standalone/npm-app', import.meta.url));
const probe: ToolProbe = (argv) =>
  Promise.resolve({
    code: 0,
    stdout: argv.some((a) => /(^|\/)npm(-cli\.js)?$/.test(a)) ? '11.4.2\n' : 'v24.3.0\n',
    stderr: '',
    timedOut: false,
  });

/** Копия npm-приложения в своём Git; `pnpm` — вместо package-lock.json pnpm-lock.yaml. */
function project(stack: 'npm' | 'pnpm') {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-lean-')));
  const root = join(scratch, 'app');
  cpSync(fixture, root, { recursive: true });
  if (stack === 'pnpm') {
    rmSync(join(root, 'package-lock.json'));
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const env = { ...process.env, HARNESS_STATE_HOME: join(scratch, 'state-home') };
  const opts = (extra: Partial<InitOptions> = {}): InitOptions => ({
    repository: root,
    env,
    probe,
    ...extra,
  });
  return { root, opts };
}

test('lean: слой поверх профиля — concurrency 1 и gateTimeoutFloorMs 240000, digest замыкания', () => {
  for (const ref of ['npm-ci', 'pnpm-frozen', 'mobile-maestro']) {
    const plain = resolveProfile(ref);
    const lean = resolveProfile(ref, { layers: ['lean'] });
    assert.equal(lean.concurrency, 1, ref);
    assert.equal(lean.gateTimeoutFloorMs, 240_000, ref);
    assert.deepEqual(
      lean.closure.map((c) => c.ref),
      [...plain.closure.map((c) => c.ref), 'builtin:lean'],
      ref,
    );
    assert.equal(lean.digest, createDigest(lean.closure), ref);
    assert.notEqual(lean.digest, plain.digest, ref);
    // Профиль без слоя — прежний: без нижней границы предела gate.
    assert.equal(plain.gateTimeoutFloorMs, undefined, ref);
    assert.deepEqual(lean.gates, plain.gates, ref);
  }
  // Слой — не профиль стека: в список встроенных профилей не входит и сам не разрешается.
  assert.ok(!builtinProfiles().includes('lean'));
  assert.throws(() => resolveProfile('lean'), /test gate/);
  assert.throws(
    () => resolveProfile('npm-ci', { layers: ['./lean.json'] }),
    (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
  );
  assert.throws(() => resolveProfile('npm-ci', { layers: ['missing-layer'] }), /не найден/);
});

const createDigest = (closure: { ref: string; digest: string }[]) =>
  createHash('sha256').update(JSON.stringify(closure)).digest('hex');

test('lean: локальный профиль наследует lean через extends', () => {
  const p = project('npm');
  writeFileSync(
    join(p.root, 'stack.json'),
    JSON.stringify({ id: 'stack', version: '1.0.0', extends: ['npm-ci', 'lean'] }),
  );
  const resolved = resolveProfile('./stack.json', { repository: p.root });
  assert.equal(resolved.concurrency, 1);
  assert.equal(resolved.gateTimeoutFloorMs, 240_000);
  assert.ok(resolved.closure.some((c) => c.ref === 'builtin:lean'));
  // Файл слоя — в пакете, в каталоге layers встроенных профилей.
  const bytes = readFileSync(join(builtinProfilesRoot, 'layers', 'lean.json'), 'utf8');
  assert.deepEqual(JSON.parse(bytes), {
    id: 'lean',
    version: '0.1.0',
    concurrency: 1,
    gateTimeoutFloorMs: 240_000,
  });
});

test('lean: политика из профиля без слоя не меняется (поля и digest), со слоем — параллельность 1 и граница', () => {
  for (const ref of ['npm-ci', 'pnpm-frozen']) {
    const plain = generatePolicy({ profile: resolveProfile(ref), writer: 'claude' });
    assert.equal('concurrency' in plain.input, false, ref);
    assert.equal('gateTimeoutFloorMs' in plain.input, false, ref);
    const parsed = executionPolicySchema.parse(plain.input);
    assert.equal(parsed.concurrency, 2, ref);
    assert.equal(parsed.repositories[0]!.dependencyStore, undefined, ref);
    // Тот же digest, что у политики, собранной без новых полей.
    const { input } = plain;
    assert.equal(
      policyDigest(executionPolicySchema.parse(JSON.parse(JSON.stringify(input)))),
      policyDigest(parsed),
      ref,
    );
    const lean = executionPolicySchema.parse(
      generatePolicy({ profile: resolveProfile(ref, { layers: ['lean'] }), writer: 'claude' })
        .input,
    );
    assert.equal(lean.concurrency, 1, ref);
    assert.equal(lean.gateTimeoutFloorMs, 240_000, ref);
    assert.notEqual(policyDigest(lean), policyDigest(parsed), ref);
  }
});

test('init --lean: pnpm-репозиторий получает dependencyStore, npm — нет; решение в manifest', async () => {
  const pnpm = project('pnpm');
  const planned = await planProject(pnpm.opts({ lean: true }));
  assert.equal(planned.policy.concurrency, 1);
  assert.equal(planned.policy.gateTimeoutFloorMs, 240_000);
  assert.deepEqual(planned.policy.repositories[0]!.dependencyStore, {
    manager: 'pnpm',
    lockfile: 'pnpm-lock.yaml',
    maxBytes: 8 * 1024 * 1024 * 1024,
    timeoutMs: 600_000,
  });
  assert.deepEqual(planned.manifest.profile.layers, ['lean']);
  projectManifestSchema.parse(planned.manifest);
  // Без --lean тот же pnpm-репозиторий хранилища не получает.
  const plainPnpm = await planProject(pnpm.opts());
  assert.equal(plainPnpm.policy.repositories[0]!.dependencyStore, undefined);
  assert.equal(plainPnpm.policy.concurrency, 2);
  assert.equal(plainPnpm.manifest.profile.layers, undefined);

  const npm = project('npm');
  const written = await initProject(npm.opts({ lean: true }));
  assert.equal(written.mode, 'apply');
  const policy = executionPolicySchema.parse(
    JSON.parse(readFileSync(join(npm.root, '.harness/policy.json'), 'utf8')),
  );
  assert.equal(policy.concurrency, 1);
  assert.equal(policy.gateTimeoutFloorMs, 240_000);
  assert.equal(policy.repositories[0]!.dependencyStore, undefined);
  // Повтор без флага продолжает решение manifest: ничего не пишет и не конфликтует.
  const again = await initProject(npm.opts());
  assert.equal(again.status, 'complete');
  assert.deepEqual(again.created, []);
  assert.equal(again.conflicts, 0);
  assert.deepEqual(again.manifest.profile.layers, ['lean']);
});
