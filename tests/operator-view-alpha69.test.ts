/**
 * Представление оператора, ревизия 9 (0.1.0-alpha.69): режим harness
 * (`settings.harnessMode`, `thresholds.reviewRoundsUnlimited`), приёмка
 * выпуска (`progress.release.review`, ревью `kind: release`) и удержания
 * gate без названной причины (`resources.gates.held[].cause`).
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestOf, operatorViewSchema } from '../src/contracts/index.ts';
import { collectOperatorViewInput } from '../src/control/operator-view.ts';
import type { Engine } from '../src/engine/engine.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';
import { operatorView, releaseReviewView } from '../src/projections/operator-view.ts';
import { resourcesOf } from '../src/projections/view-resources.ts';
import { baseInput, policy } from './operator-view-input.ts';

test('settings.harnessMode: без поля — облегчённый по умолчанию, раунды без предела; strict — нет', () => {
  const light = operatorViewSchema.parse(
    operatorView(baseInput({ policy: policy((p) => delete p.harnessMode) })),
  );
  assert.equal(light.viewRevision, 10);
  assert.deepEqual(light.settings.harnessMode, { mode: 'light', default: true, writeGuard: true });
  assert.equal(light.settings.thresholds.reviewRoundsUnlimited, true);
  const strict = operatorViewSchema.parse(operatorView(baseInput()));
  assert.deepEqual(strict.settings.harnessMode, {
    mode: 'strict',
    default: false,
    writeGuard: false,
  });
  assert.equal(strict.settings.thresholds.reviewRoundsUnlimited, undefined);
  const off = operatorViewSchema.parse(
    operatorView(
      baseInput({
        policy: policy((p) => {
          delete p.harnessMode;
          p.writeGuard = { off: true };
        }),
      }),
    ),
  );
  assert.equal(off.settings.harnessMode?.writeGuard, false);
});

/** Принять первую готовую работу: gates и ревью на кандидате и интеграции. */
function acceptOne(e: Engine, candidate: string, integration: string) {
  e.lead('c1');
  const run = e.claim('c1')!;
  assert.ok(run, 'попытка выдана');
  e.phase(run.id, run.token, 'verifying', { candidateSha: candidate });
  for (const [phase, at] of [
    ['candidate', candidate],
    ['integration', integration],
  ] as const) {
    if (phase === 'integration')
      e.phase(run.id, run.token, 'integrating', { integrationSha: integration });
    for (const kind of ['test', 'review'] as const)
      e.evidence(run.id, run.token, {
        kind,
        phase,
        sha: at,
        gate: kind === 'test' ? 'unit' : 'independent-review',
        passed: true,
        command: ['x'],
        exitCode: 0,
        log: '',
        digest: digestOf(kind + phase),
        summary: 'ok',
        ...(kind === 'review' ? { findings: [] } : {}),
      });
  }
  e.finish(run.id, run.token, integration);
}

function viewOf(env: ReturnType<typeof engineOf>) {
  const { engine, dir } = env;
  return operatorViewSchema.parse(
    operatorView(
      collectOperatorViewInput(
        {
          engine,
          policy: engine.policy,
          workflows: { list: () => [], continues: () => false } as never,
          stateDir: dir,
          baseDir: dir,
        },
        { raw: engine.policy, warnings: [], baseDir: dir },
        { now: engine.clock(), lang: 'ru' },
      ),
    ),
  );
}

test('forecast.progress.release.review: принятый код без приёмки выпуска — not-run, обязательна в облегчённом режиме', () => {
  const env = engineOf(policyOf((p) => delete p.harnessMode));
  ready(env.engine, graphOf({ w1: [] }));
  acceptOne(env.engine, sha('c'), sha('e'));
  const review = viewOf(env).forecast?.progress.release?.review;
  assert.equal(review?.status, 'not-run');
  assert.equal(review?.required, true);
  assert.match(review.line, /приёмки выпуска нет.*обязательна/);
  // Строгий режим без release — тоже обязательна; совет — только явным полем.
  const strict = engineOf(policyOf());
  ready(strict.engine, graphOf({ w1: [] }));
  acceptOne(strict.engine, sha('c'), sha('e'));
  assert.equal(viewOf(strict).forecast?.progress.release?.review?.required, true);
  const advisory = engineOf(policyOf((p) => (p.release = { review: 'advisory' })));
  ready(advisory.engine, graphOf({ w1: [] }));
  acceptOne(advisory.engine, sha('c'), sha('e'));
  assert.equal(viewOf(advisory).forecast?.progress.release?.review?.required, false);
});

test('releaseReviewView: строки состояний', () => {
  assert.match(
    releaseReviewView({ required: true, status: 'findings', round: 2, open: 3, blocking: 1 }).line,
    /блокирующих 1 из открытых 3 \(раунд 2\).*обязательна/,
  );
  assert.match(
    releaseReviewView({ required: false, status: 'not-run' }, true).line,
    /no release review.*advisory/,
  );
  assert.equal(
    releaseReviewView({ required: true, status: 'approved', round: 1 }).line,
    'приёмка выпуска одобрена (раунд 1)',
  );
});

test('resources.gates.held: причина удержания gate-definition и строка без песочницы', () => {
  const r = resourcesOf(
    {
      mode: 'live',
      sandbox: 'none',
      domains: 0,
      roles: [],
      toolchain: { tools: [], packageManagers: [] },
      dependencyStores: [],
      lifecycles: [],
      environments: [],
      gates: [{ repositoryId: 'app', count: 2 }],
      workspaceGates: 0,
      heldGates: [{ repositoryId: 'app', gate: 'unit', workId: 'w1', cause: 'gate-definition' }],
    },
    { lang: 'ru', mask: (s) => s, now: Date.parse('2026-01-01T00:00:00.000Z') },
  );
  assert.equal(r.gates.held?.[0]?.cause, 'gate-definition');
  assert.match(r.gates.heldLine!, /не назвав причины/);
  assert.doesNotMatch(r.gates.heldLine!, /ps/);
});
