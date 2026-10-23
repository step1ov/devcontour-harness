import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireTools } from '../fixtures/toolchains/setup.ts';

/**
 * T01: семь вариантов через обычный путь harness (`run`: ревью плана →
 * согласование → попытка → gates → ревью → integration → принятие) — runner
 * `scripts/acceptance/t01.mjs`. Положительный прогон принят и лежит в target
 * ref, отрицательный в свежей копии не принят. Доказательства — в
 * T01_EVIDENCE (по умолчанию .private/integration-upgrade/evidence/T01).
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'scripts/acceptance/t01.mjs');
const evidence =
  process.env.T01_EVIDENCE ?? join(root, '.private/integration-upgrade/evidence/T01');
const tools: Record<string, string[]> = {
  npm: ['npm'],
  pnpm: ['pnpm'],
  turbo: ['pnpm'],
  go: ['go', 'gotestsum'],
  python: ['uv'],
  'mixed-go': ['pnpm', 'go', 'gotestsum'],
  'mixed-python': ['pnpm', 'uv'],
};

for (const variant of Object.keys(tools))
  test(
    `T01/${variant}: принятый результат в target ref, неверная реализация не принята`,
    { timeout: 900_000 },
    () => {
      requireTools(tools[variant]!);
      const r = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), script, variant],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: '' },
        },
      );
      const summary = JSON.parse(
        readFileSync(join(evidence, `summary-${variant}.json`), 'utf8'),
      ) as { results: { id: string; status: string }[] };
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.deepEqual(
        summary.results.map((x) => [x.id, x.status]),
        [[`T01/${variant}`, 'PASS']],
      );
      for (const mode of ['positive', 'negative']) {
        const record = JSON.parse(
          readFileSync(join(evidence, variant, `${mode}.json`), 'utf8'),
        ) as {
          status: string;
          targetMoved: boolean;
          lockfiles: { unchanged: boolean };
        };
        assert.equal(record.status, 'PASS', mode);
        assert.equal(record.targetMoved, mode === 'positive', mode);
        assert.equal(record.lockfiles.unchanged, true, mode);
      }
    },
  );
