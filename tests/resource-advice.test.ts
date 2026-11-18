import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../src/control/doctor.ts';
import { resourceWarnings } from '../src/control/resource-advice.ts';
import { hostLoad, type HostResources } from '../src/environment/host-load.ts';
import { policyOf } from './engine-fixture.ts';

const GiB = 1024 ** 3;
const small: HostResources = {
  memoryBytes: 8 * GiB,
  performanceCores: 4,
  coresSource: 'perflevel0',
};
const large: HostResources = { memoryBytes: 64 * GiB, performanceCores: 12, coresSource: 'cpus' };

/** Каталог репозитория политики с lockfile `lockfile` (или без него). */
function repository(t: { after: (fn: () => void) => void }, lockfile?: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-advice-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (lockfile) writeFileSync(join(dir, lockfile), 'lockfileVersion: 9\n');
  return dir;
}

/** doctor с подменённым чтением ресурсов хоста и без runtime/toolchain. */
async function doctorWith(
  t: { after: (fn: () => void) => void },
  resources: HostResources,
  patch: (p: Record<string, unknown>) => void,
) {
  const read = hostLoad.resources;
  t.after(() => {
    hostLoad.resources = read;
  });
  let calls = 0;
  hostLoad.resources = () => {
    calls++;
    return resources;
  };
  const policy = policyOf(patch);
  const report = await doctor(policy, {}, undefined, {
    baseDir: '/',
    inspect: () => Promise.resolve([]),
  });
  return { report, calls };
}

const codes = (warnings: string[] | undefined) => (warnings ?? []).map((w) => w.split(':')[0]);

test('LOW_RESOURCES: слабая машина и параллельность 2 — предупреждение с советом lean, не проблема', async (t) => {
  const dir = repository(t);
  const { report, calls } = await doctorWith(t, small, (p) => {
    (p.repositories as Record<string, unknown>[])[0]!.path = dir;
  });
  assert.equal(calls, 1);
  assert.deepEqual(codes(report.warnings), ['LOW_RESOURCES']);
  const [warning] = report.warnings!;
  assert.match(warning!, /4 производительных ядер и 8 ГБ памяти/);
  assert.match(warning!, /параллельность политики 2/);
  // Совет выполним и в готовом проекте: поля политики, init --lean — для нового.
  assert.match(
    warning!,
    /\.harness\/policy\.json\) "concurrency": 1, "runTimeoutMs": 1800000, "gateTimeoutFloorMs": 240000/,
  );
  assert.match(warning!, /новый проект — harness init --lean/);
  assert.doesNotMatch(warning!, /частот|нагрев/, 'без ограничения частоты о нагреве не говорится');
  assert.ok(!report.problems.some((p) => p.includes('LOW_RESOURCES')));
  // Мало только памяти или только ядер — тоже слабая машина.
  for (const r of [
    { ...large, memoryBytes: 16 * GiB - 1 },
    { ...large, performanceCores: 2 },
  ])
    assert.deepEqual(
      codes(
        resourceWarnings(
          policyOf(
            (p) => ((p as { repositories: { path: string }[] }).repositories[0]!.path = dir),
          ),
          '/',
          r,
        ),
      ),
      ['LOW_RESOURCES'],
    );
  // Тепловое ограничение macOS — только сведение в тексте.
  const hot = resourceWarnings(
    policyOf((p) => ((p as { repositories: { path: string }[] }).repositories[0]!.path = dir)),
    '/',
    { ...small, cpuSpeedLimit: 60 },
  );
  assert.match(hot[0]!, /до 60%/);
});

test('LOW_RESOURCES: большая машина или параллельность 1 — без предупреждения', async (t) => {
  const dir = repository(t);
  const at = (p: Record<string, unknown>) => {
    (p.repositories as Record<string, unknown>[])[0]!.path = dir;
  };
  assert.deepEqual((await doctorWith(t, large, at)).report.warnings, []);
  // Ровно 16 ГиБ и 8 производительных ядер — не слабая машина (граница памяти — строгая).
  assert.deepEqual(
    (await doctorWith(t, { ...large, memoryBytes: 16 * GiB, performanceCores: 8 }, at)).report
      .warnings,
    [],
  );
  // Ограничение частоты 100% — не ограничение.
  assert.deepEqual((await doctorWith(t, { ...large, cpuSpeedLimit: 100 }, at)).report.warnings, []);
  const lean = await doctorWith(t, small, (p) => {
    at(p);
    p.concurrency = 1;
  });
  assert.deepEqual(lean.report.warnings, []);
  // Без политики советов нет и ресурсы не читаются.
  const read = hostLoad.resources;
  hostLoad.resources = () => assert.fail('ресурсы читаются без политики');
  try {
    const bare = await doctor(undefined, {});
    assert.equal(bare.warnings, undefined);
  } finally {
    hostLoad.resources = read;
  }
});

test('DEPENDENCY_STORE_RECOMMENDED: pnpm-lock.yaml без dependencyStore — предупреждение; с ним и у npm — нет', async (t) => {
  const pnpm = repository(t, 'pnpm-lock.yaml');
  const at =
    (path: string, store = false) =>
    (p: Record<string, unknown>) => {
      const repo = (p.repositories as Record<string, unknown>[])[0]!;
      repo.path = path;
      if (store) repo.dependencyStore = { manager: 'pnpm' };
    };
  const { report } = await doctorWith(t, large, at(pnpm));
  assert.deepEqual(codes(report.warnings), ['DEPENDENCY_STORE_RECOMMENDED']);
  assert.match(
    report.warnings![0]!,
    /\.harness\/policy\.json\) repositories\[0\]: "dependencyStore": \{ "manager": "pnpm" \}; новый проект — harness init --lean/,
  );
  assert.deepEqual(
    report.problems.filter((p) => p.includes('DEPENDENCY_STORE')),
    [],
  );
  assert.deepEqual((await doctorWith(t, large, at(pnpm, true))).report.warnings, []);
  const npm = repository(t, 'package-lock.json');
  assert.deepEqual((await doctorWith(t, large, at(npm))).report.warnings, []);
  // Относительный путь репозитория — от каталога политики.
  const relative = resourceWarnings(
    policyOf((p) => ((p as { repositories: { path: string }[] }).repositories[0]!.path = '.')),
    pnpm,
    large,
  );
  assert.deepEqual(codes(relative), ['DEPENDENCY_STORE_RECOMMENDED']);
  // Оба совета вместе на слабой машине.
  assert.deepEqual(codes((await doctorWith(t, small, at(pnpm))).report.warnings), [
    'DEPENDENCY_STORE_RECOMMENDED',
    'LOW_RESOURCES',
  ]);
});

test('hostLoad.resources: память, ядра и источник числа ядер', () => {
  const r = hostLoad.resources();
  assert.ok(r.memoryBytes > 0);
  assert.ok(Number.isInteger(r.performanceCores) && r.performanceCores >= 1);
  if (process.platform !== 'darwin') assert.equal(r.coresSource, 'cpus');
  if (r.cpuSpeedLimit !== undefined) assert.ok(r.cpuSpeedLimit >= 0 && r.cpuSpeedLimit <= 100);
});

test('DIGEST_THREADS_INVALID: HARNESS_DIGEST_THREADS вне 1–8 — предупреждение; верное значение и отсутствие — нет', () => {
  const policy = policyOf((p) => {
    p.concurrency = 1;
  });
  for (const bad of ['0', '9', 'two', '1.5', ''])
    assert.deepEqual(
      codes(resourceWarnings(policy, '/', large, { HARNESS_DIGEST_THREADS: bad })),
      ['DIGEST_THREADS_INVALID'],
      bad,
    );
  for (const good of ['1', ' 8 ', '08'])
    assert.deepEqual(
      resourceWarnings(policy, '/', large, { HARNESS_DIGEST_THREADS: good }),
      [],
      good,
    );
  assert.deepEqual(resourceWarnings(policy, '/', large, {}), []);
});
