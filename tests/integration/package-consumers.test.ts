import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A01, A02, C01 на настоящем архиве. Архив — `HARNESS_TARBALL`, иначе он
 * упаковывается из одноразовой копии исходников (`package-pack.mjs`; рабочее
 * дерево не собирается). Отчёты — в `PACKAGE_EVIDENCE/<ID>` (по умолчанию
 * `.private/integration-upgrade/evidence/<ID>`). Каждый тест читает отчёт
 * скрипта и проверяет наблюдения, а не только код выхода.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence =
  process.env.PACKAGE_EVIDENCE ?? join(root, '.private/integration-upgrade/evidence');
const script = (name: string) => join(root, 'scripts', 'acceptance', name);

let packed: string | undefined;
function tarball() {
  if (process.env.HARNESS_TARBALL) return process.env.HARNESS_TARBALL;
  if (packed) return packed;
  const out = mkdtempSync(join(tmpdir(), 'harness-pack-out-'));
  const r = spawnSync(process.execPath, [script('package-pack.mjs'), '--out', out], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'package-pack: ' + r.stderr.slice(-2000));
  packed = (JSON.parse(r.stdout) as { tarball: string }).tarball;
  return packed;
}
function check<T>(id: string, name: string, extra: string[] = []): T & { status: string } {
  const out = join(evidence, id);
  const r = spawnSync(process.execPath, [script(name), tarball(), '--out', out, ...extra], {
    cwd: root,
    encoding: 'utf8',
  });
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as T & {
    status: string;
    failures: string[];
  };
  assert.deepEqual(report.failures, [], `${id}: ${r.stdout.slice(-1500)}`);
  assert.equal(r.status, 0, id + ': exit');
  return report;
}

test(
  'A01: прежний потребитель (alpha.5 порты) проверяет типы и проходит файловый сценарий с новым архивом',
  { timeout: 900_000 },
  () => {
    const r = check<{
      typecheck: { exit: number };
      storeContract: { pass: number; fail: number };
      scenario: Record<string, { outcome?: string }>;
      loadedOptInModules: string[];
      consumer: { devDependenciesInstalled: string[]; publicImports: string[] };
    }>('A01', 'consumer-check.mjs');
    assert.equal(r.status, 'PASS');
    assert.equal(r.typecheck.exit, 0);
    assert.ok(r.storeContract.pass > 0 && r.storeContract.fail === 0);
    for (const flow of ['cli', 'api', 'host'])
      assert.equal(r.scenario[flow]?.outcome, 'accepted', flow);
    assert.deepEqual(r.loadedOptInModules, []);
    assert.deepEqual(r.consumer.devDependenciesInstalled, []);
    assert.ok(r.consumer.publicImports.every((s) => !s.includes('integrations')));
  },
);

test(
  'A02: ядро с PATH только из node и git — сценарий принят, интеграционные программы не запускались',
  { timeout: 900_000 },
  () => {
    const r = check<{
      scenario: Record<string, { outcome?: string }>;
      processes: { programs: string[]; forbiddenAttempted: unknown[] };
      doctor: { toolProblems: string[] };
      environment: { envKeys: string[]; PATH: string[] };
    }>('A02', 'core-minimal-env.mjs');
    assert.equal(r.status, 'PASS');
    for (const flow of ['cli', 'api', 'host'])
      assert.equal(r.scenario[flow]?.outcome, 'accepted', flow);
    assert.deepEqual(r.processes.forbiddenAttempted, []);
    assert.deepEqual(r.doctor.toolProblems, []);
    assert.ok(!r.environment.envKeys.some((k) => /RELAY|HINDSIGHT/.test(k)));
    assert.deepEqual(r.environment.PATH, ['node', 'git']);
  },
);

test(
  'C01: один архив через npm и pnpm — CLI, все exports и типы; состав без приватных путей и секретов',
  { timeout: 900_000 },
  () => {
    const r = check<{
      entries: string[];
      badPaths: string[];
      contentHits: unknown[];
      missingTargets: string[];
      managers: Record<
        string,
        { help: number; typecheck: number; imports?: Record<string, unknown> }
      >;
    }>('C01', 'package-check.mjs');
    assert.equal(r.status, 'PASS');
    assert.deepEqual([r.badPaths, r.contentHits, r.missingTargets], [[], [], []]);
    for (const m of ['npm', 'pnpm']) {
      assert.equal(r.managers[m]?.help, 0, m);
      assert.equal(r.managers[m]?.typecheck, 0, m);
      for (const e of r.entries)
        assert.ok(
          r.managers[m]?.imports?.[
            e === '.' ? 'devcontour-harness' : 'devcontour-harness/' + e.slice(2)
          ],
          `${m}: ${e}`,
        );
    }
  },
);
