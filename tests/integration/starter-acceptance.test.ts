/**
 * S01–S06 на настоящей копии Turbo Starter: сценарии
 * `scripts/acceptance/starter-s0*.mjs` (обычный CLI harness, fixture runtime,
 * реальные pnpm/tsc/генератор/node --test, Git и Docker). Отсутствие внешней
 * предпосылки (Docker, источник upstream, сеть) — отказ теста с BLOCKED, а не
 * пропуск.
 *
 * Источник: STARTER_SOURCE (URL или локальное зеркало; по умолчанию GitHub).
 * Evidence/logs: STARTER_EVIDENCE_DIR / STARTER_LOGS_DIR (по умолчанию —
 * .private/integration-upgrade/{evidence,logs}).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence =
  process.env.STARTER_EVIDENCE_DIR ?? join(root, '.private/integration-upgrade/evidence');
const logs = process.env.STARTER_LOGS_DIR ?? join(root, '.private/integration-upgrade/logs');
const source = process.env.STARTER_SOURCE;

function blockedUnless(ok: boolean, reason: string) {
  if (!ok) assert.fail('BLOCKED: ' + reason);
}
function requireSource() {
  if (source && existsSync(source)) return;
  const r = spawnSync(
    'git',
    ['ls-remote', source ?? 'https://github.com/oim-dev/turbo-starter', 'HEAD'],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  blockedUnless(
    r.status === 0,
    'источник Turbo Starter недоступен: ' + (r.stderr || r.error?.message),
  );
}
function requireDocker() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 20000,
  });
  blockedUnless(
    r.status === 0,
    'Docker недоступен: ' + (r.stderr || r.error?.message || '').trim(),
  );
}

/** Запустить сценарий; код 3 — BLOCKED изнутри сценария. Вернуть summary по ID. */
function scenario(script: string, ids: string[]) {
  const r = spawnSync(
    process.execPath,
    [
      join(root, 'scripts/acceptance', script),
      '--evidence',
      evidence,
      '--logs',
      logs,
      ...(source ? ['--source', source] : []),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  blockedUnless(
    r.status !== 3,
    `${script}: внешняя предпосылка отсутствует\n${r.stderr.slice(-2000)}`,
  );
  for (const id of ids) {
    const summary = JSON.parse(readFileSync(join(evidence, id, 'summary.json'), 'utf8')) as {
      status: string;
      error?: string;
      checks: { id: string; ok: boolean }[];
    };
    assert.equal(summary.status, 'PASS', `${id}: ${summary.error ?? ''}`);
    assert.ok(summary.checks.length > 0 && summary.checks.every((c) => c.ok), id);
  }
  assert.equal(r.status, 0, r.stderr.slice(-4000));
}

test(
  'S01/S02/S05: backend → OpenAPI/SDK → frontend принят обычным путём; неверные варианты отклонены; controller mode',
  { timeout: 3_600_000 },
  () => {
    requireSource();
    scenario('starter-s01.mjs', ['S01', 'S02', 'S05']);
  },
);

test('S03: две попытки в своих worktree и средах; чужой ресурс цел', { timeout: 1_800_000 }, () => {
  requireSource();
  requireDocker();
  scenario('starter-s03.mjs', ['S03']);
});

test(
  'S04: ошибки setup/ready/gate/teardown и прерывание; очистка в новом процессе',
  { timeout: 1_800_000 },
  () => {
    requireSource();
    requireDocker();
    scenario('starter-s04.mjs', ['S04']);
  },
);

test(
  'S06: окружение по allowlist, секрет замаскирован во всех артефактах',
  { timeout: 1_800_000 },
  () => {
    requireSource();
    requireDocker();
    scenario('starter-s06.mjs', ['S06']);
  },
);
