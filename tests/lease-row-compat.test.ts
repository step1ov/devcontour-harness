/**
 * D53 против настоящей прежней версии: код выпуска 0.1.0-alpha.46 берётся из
 * Git (`git archive`, как в A03) и запускается над базой, которую перевела
 * текущая версия. Новая схема как замена прежней не заметила бы, что
 * прежняя на деле приняла метку (например, если бы `leaseUntil` там был без
 * нижней границы). Нет коммита выпуска в клоне — BLOCKED (отказ), а не пропуск.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineOf, graphOf, ready } from './engine-fixture.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ALPHA46_COMMIT = '5c83a71';

test(
  'D53/compat: alpha.46 отказывает до записи на базе с меткой и не принимает попытку с меткой -1',
  { timeout: 300_000 },
  () => {
    const have = spawnSync('git', ['cat-file', '-e', ALPHA46_COMMIT + '^{commit}'], { cwd: root });
    assert.equal(have.status, 0, `BLOCKED D53/compat: в клоне нет коммита ${ALPHA46_COMMIT}`);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-d53-compat-')));
    const old = join(dir, 'alpha46');
    mkdirSync(old);
    const archive = execFileSync('git', ['archive', ALPHA46_COMMIT, 'src', 'package.json'], {
      cwd: root,
      maxBuffer: 1 << 28,
    });
    execFileSync('tar', ['-x', '-C', old], { input: archive });
    symlinkSync(join(root, 'node_modules'), join(old, 'node_modules'));

    // База текущей версии с идущей попыткой: метка `leaseRows` и строка.
    const { engine, store, dir: stateDir } = engineOf();
    ready(engine, graphOf({ a: [] }));
    const a = engine.claim('c1')!;
    const attempt = engine.read((v) => v.attempt(a.id));
    store.close();
    const file = join(stateDir, 'state.sqlite');
    const stored = () => {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return (db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string }).data;
      } finally {
        db.close();
      }
    };
    const before = stored();

    const probe = join(dir, 'probe.mts');
    writeFileSync(
      probe,
      `import { SqliteExecutionStore } from ${JSON.stringify(join(old, 'src/storage/sqlite.ts'))};
import { attemptStateSchema } from ${JSON.stringify(join(old, 'src/contracts/index.ts'))};
const out: Record<string, unknown> = {};
try {
  new SqliteExecutionStore(process.argv[2]!, 'alpha46').close();
  out.open = 'ok';
} catch (e) {
  out.open = (e as { code?: string }).code ?? String(e);
}
// Попытка с меткой хоста DevContour (leaseUntil -1) — строгая схема alpha.46.
const attempt = JSON.parse(process.argv[3]!);
out.marked = attemptStateSchema.safeParse({ ...attempt, leaseUntil: -1 }).success;
out.plain = attemptStateSchema.safeParse(attempt).success;
console.log(JSON.stringify(out));
`,
    );
    const r = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), probe, file, JSON.stringify(attempt)],
      { cwd: old, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
    assert.equal(out.open, 'STATE_VERSION_UNSUPPORTED', 'alpha.46 открыла базу с меткой');
    assert.equal(out.marked, false, 'alpha.46 приняла попытку с меткой -1');
    assert.equal(out.plain, true, 'та же попытка без метки alpha.46 годится (проба исправна)');
    assert.equal(stored(), before, 'отказ прежней версии ничего не записал');
  },
);
