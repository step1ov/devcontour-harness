/**
 * 0.1.0-alpha.70: уровни безопасности облегчённого режима. Harness
 * определяет текущий уровень (none → write-guard → os-user → container →
 * vm; строгий режим — os-sandbox), doctor его показывает; выбирает владелец.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modeReport } from '../src/control/doctor.ts';
import { securityProbe, securityTierOf } from '../src/environment/security-tier.ts';
import { policyOf } from './engine-fixture.ts';

const facts = { container: false, vm: false, separateUser: false, user: 'u' };

test('уровень — самый сильный из определённых; строгий режим вне шкалы', () => {
  assert.equal(securityTierOf({ strict: false, guard: false }, facts).current, 'none');
  assert.equal(securityTierOf({ strict: false, guard: true }, facts).current, 'write-guard');
  assert.equal(
    securityTierOf({ strict: false, guard: true }, { ...facts, separateUser: true }).current,
    'os-user',
  );
  assert.equal(
    securityTierOf(
      { strict: false, guard: false },
      { ...facts, container: true, separateUser: true },
    ).current,
    'container',
  );
  assert.equal(
    securityTierOf({ strict: false, guard: true }, { ...facts, vm: true, container: true }).current,
    'vm',
  );
  assert.equal(securityTierOf({ strict: true, guard: false }, facts).current, 'os-sandbox');
  const r = securityTierOf({ strict: false, guard: true }, facts);
  assert.match(r.line, /не граница безопасности.*write-guard → os-user → container → vm.*владелец/);
  assert.match(r.lineEn, /the owner chooses/);
});

test('проба машины: рабочая копия своего пользователя — не отдельный пользователь; doctor называет уровень', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tier-'));
  const f = securityProbe.facts([dir]);
  assert.equal(f.separateUser, false);
  assert.equal(typeof f.container, 'boolean');
  assert.equal(typeof f.vm, 'boolean');
  const report = modeReport(policyOf());
  assert.ok(report.securityTier);
  assert.match(report.securityTier.line, /уровень безопасности/);
});
