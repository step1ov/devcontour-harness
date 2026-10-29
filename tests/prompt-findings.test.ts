import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeReviewHistory, type AttemptState } from '../src/contracts/index.ts';
import { findingsText, prompt } from '../src/engine/prompt.ts';
import { engineOf, graphOf, ready, sha } from './engine-fixture.ts';

test('Native review: historical gate failures with no canonical findings require previous=[]', () => {
  const { engine } = engineOf();
  ready(engine, graphOf({ a: [] }));
  const attempt = engine.claim('c1')!;
  const previous: AttemptState = {
    ...attempt,
    id: 'old',
    status: 'failed',
    error: 'Gate failed',
    evidence: [
      {
        id: 'gate-failure',
        runId: 'old',
        createdAt: attempt.startedAt,
        kind: 'test',
        phase: 'candidate',
        sha: sha('a'),
        gate: 'unit',
        passed: false,
        command: ['node', 'test.js'],
        exitCode: 1,
        log: '/synthetic/artifacts/unit.log',
        digest: 'b'.repeat(64),
        summary: 'WARN EPERM ~/.npmrc; assertion expected 0',
      },
    ],
  };
  const findings = codeReviewHistory([previous], 'scope');
  assert.deepEqual(findings.findings, []);
  const input = {
    work: engine.read((v) => v.work(attempt.workId)!),
    attempt,
    history: [previous, attempt],
    gates: [],
    review: { sha: sha('a'), phase: 'candidate', diff: '' },
  };
  const native = prompt({ ...input, findings });
  assert.match(native, /Return `previous` as exactly \[\]/);
  assert.match(native, /diagnostic context only/);
  assert.match(native, /do not invent or compute ids/);
  assert.match(native, /WARN EPERM/);
  assert.doesNotMatch(native, /Address every finding that is still open first/);
  // Legacy requests do not declare the native findings protocol.
  assert.doesNotMatch(prompt(input), /Return `previous` as exactly \[\]/);
  assert.equal(findingsText(findings, false), '');
});

test('Native review: a closed canonical finding keeps its exact ID and can be reopened', () => {
  const history = codeReviewHistory(
    [
      {
        id: 'old',
        status: 'failed',
        evidence: [
          {
            id: 'review-failure',
            runId: 'old',
            kind: 'review',
            phase: 'candidate',
            sha: sha('a'),
            passed: false,
            findings: [{ severity: 'blocking', message: 'Missing acceptance case' }],
          },
        ],
      },
    ],
    'scope',
  );
  const finding = history.findings[0]!;
  finding.status = 'closed';
  const text = findingsText(history, true);
  assert.ok(text.includes(finding.id));
  assert.match(text, /Closed or withdrawn review findings/);
  assert.match(text, /reopen it with an entry in `previous`/);
  assert.doesNotMatch(text, /Return `previous` as exactly \[\]/);
});
