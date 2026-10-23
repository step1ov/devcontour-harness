import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * C02: прежняя встройка DevContour с новым архивом — `devcontour-check.mjs` в
 * свежей копии закреплённого DevContour. Нужен `DEVCONTOUR_REPO` (путь или URL
 * репозитория DevContour); без него тест — BLOCKED (отказ), а не пропуск.
 * Архив — `HARNESS_TARBALL` либо упаковка из одноразовой копии исходников.
 * Отчёт — `PACKAGE_EVIDENCE/C02` (по умолчанию `.private/integration-upgrade/evidence/C02`).
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence =
  process.env.PACKAGE_EVIDENCE ?? join(root, '.private/integration-upgrade/evidence');

interface Suite {
  verdict: string;
  pass?: number;
  fail?: number;
  retries: { file: string; classification: string }[];
}

test(
  'C02: DevContour с новым архивом — typecheck, harness-*, регрессии, прежнее состояние и новая принятая попытка; копия меняет только зависимость',
  { timeout: 7_200_000 },
  () => {
    const repo = process.env.DEVCONTOUR_REPO;
    assert.ok(repo, 'BLOCKED C02: задайте DEVCONTOUR_REPO — путь или URL репозитория DevContour');
    let archive = process.env.HARNESS_TARBALL;
    if (!archive) {
      const out = mkdtempSync(join(tmpdir(), 'harness-pack-out-'));
      const p = spawnSync(
        process.execPath,
        [join(root, 'scripts/acceptance/package-pack.mjs'), '--out', out],
        {
          cwd: root,
          encoding: 'utf8',
        },
      );
      assert.equal(p.status, 0, 'package-pack: ' + p.stderr.slice(-2000));
      archive = (JSON.parse(p.stdout) as { tarball: string }).tarball;
    }
    const out = join(evidence, 'C02');
    const r = spawnSync(
      process.execPath,
      [
        join(root, 'scripts/acceptance/devcontour-check.mjs'),
        archive,
        '--devcontour',
        repo,
        '--baseline',
        ...(process.env.DEVCONTOUR_ROLLBACK_CONTROL
          ? ['--rollback-control', process.env.DEVCONTOUR_ROLLBACK_CONTROL]
          : []),
        '--out',
        out,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.ok(existsSync(join(out, 'report.json')), 'нет отчёта: ' + r.stderr.slice(-2000));
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as {
      status: string;
      failures: string[];
      copyChanges: { unexpected: string[] };
      mainCheckout: { unchanged?: boolean };
      substitution: { lock: { integrity: string }; installed: string };
      tarball: { integrity: string };
      phases: {
        candidate: { typecheck: number; harness: Suite; regression: Suite };
        stateAfter: {
          a: { unchanged: boolean };
          newAttempt: { status: string; engineVersion: string };
        };
        upgradeCheck?: { exit: number };
        t42?: { status: string; variants: { id: string; status: string }[] };
        rollbackCheck?: { exit: number; verdict: string; control?: { sameAsCandidate: boolean } };
      };
    };
    assert.deepEqual(report.failures, []);
    assert.equal(report.status, 'PASS');
    assert.equal(report.substitution.lock.integrity, report.tarball.integrity);
    assert.deepEqual(report.copyChanges.unexpected, []);
    if (existsSync(repo)) assert.equal(report.mainCheckout.unchanged, true);
    const c = report.phases.candidate;
    assert.equal(c.typecheck, 0);
    for (const s of [c.harness, c.regression]) assert.notEqual(s.verdict, 'FAIL');
    assert.equal(report.phases.stateAfter.a.unchanged, true);
    assert.equal(report.phases.stateAfter.newAttempt.status, 'succeeded');
    assert.equal(report.phases.stateAfter.newAttempt.engineVersion, report.substitution.installed);
    assert.equal(report.phases.upgradeCheck?.exit, 0);
    // T42 а–г обеих топологий (devcontour-rollback.mjs) — основной итог.
    assert.equal(report.phases.t42?.status, 'PASS', JSON.stringify(report.phases.t42));
    assert.equal(report.phases.t42.variants.length, 10);
    // T42: PASS либо тот же отказ, что у выпущенного архива-контроля
    // (`DEVCONTOUR_ROLLBACK_CONTROL`), — свойство сценария для пары версий.
    const rollback = report.phases.rollbackCheck;
    assert.ok(
      rollback?.verdict === 'PASS' ||
        (rollback?.verdict === 'FAIL-same-as-control' &&
          rollback.control?.sameAsCandidate === true),
      'T42: ' + JSON.stringify(rollback),
    );
  },
);
