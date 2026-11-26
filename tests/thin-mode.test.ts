/**
 * 0.1.0-alpha.73: договоры тонкого режима. Окружение — как у облегчённого
 * (граница записи, технические ответы ведущего), выводы ускорения (B1, B2)
 * — только облегчённый; разбор ведущего — по исчерпании сдач; doctor
 * называет режим и предупреждает о resume и втором проходе ревью.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivedApplicabilityOn,
  harnessModeOf,
  hostEnvironment,
  inputPolicyOf,
  integrationReuseOn,
  leadAnswersSourceOf,
  recoveryPolicyOf,
  strictSandbox,
  writeGuardActive,
} from '../src/contracts/index.ts';
import { modeReport, thinModeWarnings } from '../src/control/doctor.ts';
import { policyOf } from './engine-fixture.ts';

const mode = (harnessMode?: 'light' | 'strict' | 'thin') =>
  policyOf((p) => {
    // Пример политики тестов — строгий; без аргумента — облегчённый по умолчанию.
    if (harnessMode) p.harnessMode = harnessMode;
    else delete p.harnessMode;
  });

test('thin: окружение облегчённого режима, B1/B2 выключены; light и strict — как раньше', () => {
  const thin = mode('thin');
  assert.equal(harnessModeOf(thin), 'thin');
  assert.equal(hostEnvironment(thin), true);
  assert.equal(writeGuardActive(thin), thin.isolation.mode !== 'none');
  assert.equal(strictSandbox(thin), false);
  assert.equal(integrationReuseOn(thin), false);
  assert.equal(integrationReuseOn(thin, { capabilities: { integrationReuse: true } }), false);
  assert.equal(derivedApplicabilityOn(thin), false);
  // И явными полями: в тонком режиме B1/B2 нет.
  const explicit = policyOf((p) => {
    p.harnessMode = 'thin';
    p.integrationReuse = 'identical-tree';
    p.derivedApplicability = 'on';
  });
  assert.equal(integrationReuseOn(explicit), false);
  assert.equal(integrationReuseOn(explicit, { capabilities: { integrationReuse: true } }), false);
  assert.equal(derivedApplicabilityOn(explicit), false);
  assert.equal(leadAnswersSourceOf(thin), 'light-default');
  assert.equal(inputPolicyOf(thin).leadAnswers?.technical, true);
  // Облегчённый режим не изменился.
  const light = mode();
  assert.equal(hostEnvironment(light), true);
  assert.equal(integrationReuseOn(light, { capabilities: { integrationReuse: true } }), true);
  assert.equal(derivedApplicabilityOn(light), true);
  assert.equal(recoveryPolicyOf(light).diagnoseAfter, 2);
  // Строгий режим не изменился.
  const strict = mode('strict');
  assert.equal(hostEnvironment(strict), false);
  assert.equal(writeGuardActive(strict), false);
  assert.equal(leadAnswersSourceOf(strict), 'default');
  assert.equal(derivedApplicabilityOn(strict), false);
});

test('thin: разбор ведущего по умолчанию — когда исчерпаны сдачи; явное правило главнее', () => {
  const thin = policyOf((p) => {
    p.harnessMode = 'thin';
    p.maxAttempts = 3;
    p.inputPolicy = { threshold: 7, criticalPaths: [], leadAnswers: { technical: true } };
  });
  const r = recoveryPolicyOf(thin);
  assert.equal(r.source, 'derived');
  assert.equal(r.diagnoseAfter, 3);
  const explicit = policyOf((p) => {
    p.harnessMode = 'thin';
    p.recovery = { mode: 'lead', diagnoseAfter: 1, leadResets: 0 };
  });
  assert.equal(recoveryPolicyOf(explicit).diagnoseAfter, 1);
  const light = policyOf((p) => {
    delete p.harnessMode;
    p.inputPolicy = { threshold: 7, criticalPaths: [], leadAnswers: { technical: true } };
  });
  assert.equal(recoveryPolicyOf(light).diagnoseAfter, 2);
});

test('doctor: строка тонкого режима; без resume у CLI исполнителя и со вторым проходом — предупреждения', () => {
  const thin = mode('thin');
  const report = modeReport(thin);
  assert.equal(report.mode, 'thin');
  assert.match(report.line, /^режим: тонкий \(harnessMode: thin/);
  assert.match(report.lineEn, /^mode: thin/);
  const writers = new Set(Object.values(thin.roles).map((b) => b.writer.runtime));
  const none = thinModeWarnings(thin, {});
  for (const runtime of writers)
    if (runtime === 'codex' || runtime === 'claude')
      assert.ok(
        none.some(
          (w) =>
            w.startsWith(`THIN_NO_RESUME: ${runtime}`) && /каждая сдача — новая сессия/.test(w),
        ),
        none.join('\n'),
      );
  assert.ok(none.some((w) => w.startsWith('THIN_REVIEW_PASSES')));
  const ready = policyOf((p) => {
    p.harnessMode = 'thin';
    (p.review as Record<string, unknown>).passes = { code: 'off' };
  });
  assert.deepEqual(
    thinModeWarnings(ready, {
      codex: { sessionContinue: true },
      claude: { sessionContinue: true },
    }),
    [],
  );
  // Облегчённый и строгий режимы этих предупреждений не получают.
  assert.deepEqual(thinModeWarnings(mode(), {}), []);
  assert.deepEqual(thinModeWarnings(mode('strict'), {}), []);
  assert.match(modeReport(mode()).line, /^режим: облегчённый \(по умолчанию\)/);
});
