/**
 * B-2: имя testcase JUnit с кавычками и спецсимволами XML совпадает с
 * названным testId — в разборе отчёта (общий для движка и коннектора),
 * в доказательстве требования движка и в сопоставлении критерия коннектора.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { junitSummary, xmlAttribute } from '../src/verification/gates.ts';
import { requirementProof } from '../src/verification/proof.ts';
import {
  fakeSuiteBackend,
  harnessComments,
  scenario,
} from '../src/integrations/connector/testing.ts';

const literal = `AccessTokenDto["issuedAt"] & <tag> 'q'`;

test('B-2/junit: сущности XML в имени testcase раскрываются один раз; testId с " \' & < совпадает', () => {
  const xml =
    '<testsuite><testcase classname="dto" name="AccessTokenDto[&quot;issuedAt&quot;] &amp; &lt;tag&gt; &#39;q&apos;"/>' +
    '<testcase classname="dto" name="literal &amp;amp; stays"/></testsuite>';
  const ids = junitSummary(xml).cases.map((c) => c.id);
  assert.deepEqual(ids, [`dto.${literal}`, 'dto.literal &amp; stays'], 'раскрытие без рекурсии');
  assert.equal(
    xmlAttribute('&#x1F600;&#0;&#x110000;'),
    '😀&#0;&#x110000;',
    'недопустимые ссылки не раскрываются',
  );
});

test('B-2/node-reporter: отчёт `node --test --test-reporter=junit` с кавычками в имени даёт исходный testId; доказательство требования — testcase', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-junit-')));
  try {
    writeFileSync(
      join(dir, 'q.test.mjs'),
      `import { test } from 'node:test';\ntest(${JSON.stringify(literal)}, () => {});\n`,
    );
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=junit', 'q.test.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      // Без NODE_TEST_CONTEXT родителя: иначе дочерний runner пишет свой протокол, а не JUnit.
      env: Object.fromEntries(
        Object.entries({ ...process.env, NODE_OPTIONS: '' }).filter(
          ([k]) => k !== 'NODE_TEST_CONTEXT',
        ),
      ),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /<testsuites>/, r.stdout.slice(0, 300));
    const summary = junitSummary(r.stdout);
    const id = summary.cases.find((c) => c.id.endsWith(literal))?.id;
    assert.ok(id, 'имя совпало: ' + JSON.stringify(summary.cases));
    const sha = 'a'.repeat(40);
    const proof = requirementProof(
      { id: 'REQ-1', gate: 'unit', testId: id },
      [
        {
          kind: 'test',
          gate: 'unit',
          phase: 'integration',
          sha,
          passed: true,
          tests: summary.cases,
        },
      ],
      sha,
    );
    assert.equal(proof.level, 'testcase', proof.reason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B-2/connector: критерий с testId из кавычек и спецсимволов закрывается по пройденному testcase', async () => {
  const s = await scenario(fakeSuiteBackend(), {
    criteria: [{ title: 'Greets by name' }, { title: 'Quotes' }],
    mapping: [
      { title: 'Greets by name', gate: 'unit', testId: 'greet.greets' },
      { title: 'Quotes', gate: 'unit', testId: `greet.quotes "a" & <b> 'c'` },
    ],
  });
  try {
    const { opened } = await s.snapshotAndRun();
    assert.equal(opened.h.result(s.workId).delivery.at(-1)?.status, 'delivered');
    const read = await opened.transport.readTask(s.task.id);
    assert.deepEqual(
      read.task.criteria.map((c) => c.completed),
      [true, true],
    );
    assert.equal(read.task.column, 'done');
    assert.equal((await harnessComments(opened.transport, s.task.id)).length, 1);
  } finally {
    await s.cleanup();
  }
});
