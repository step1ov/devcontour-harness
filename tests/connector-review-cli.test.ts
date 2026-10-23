/**
 * F07/W05 через публичный CLI (operator path): `review-plan --source`
 * допускает внешнюю предпосылку только по решению источника `trusts` и
 * доступности SHA в target ref — те же правила, что у `run`. Backend задач —
 * управляемая подделка (fixture) для подготовки receipt; review-plan и
 * approve — настоящий CLI с fixture-runtime reviewer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestOf, type WorkGraph } from '../src/contracts/index.ts';
import { openConnector, parseConfig } from '../src/integrations/connector/index.ts';
import { fakeSuiteBackend, scenario } from '../src/integrations/connector/testing.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const bin = (name: string) => fileURLToPath(new URL(`./fixtures/bin/${name}`, import.meta.url));

test('F07/W05: CLI review-plan --source допускает доверенный receipt с доступным SHA; без источника, чужой издатель и недостижимый SHA — отказ до ревью', async () => {
  const s = await scenario(fakeSuiteBackend());
  try {
    // Зависимость A выполнена и доставлена через harness — receipt этого коннектора.
    const { opened } = await s.snapshotAndRun();
    assert.equal(opened.h.result(s.workId).delivery.at(-1)?.status, 'delivered');
    opened.close();
    const b = await s.project.admin.createTask({
      title: 'Use greeting',
      description: 'Use greet(name) from the dependency in src/greet.js',
      column: 'ready',
      criteria: [{ title: 'Greets by name' }],
      dependencies: [s.task.id],
    });
    const cfg = structuredClone(s.config);
    (cfg.tasks as { ref: string }[])[0]!.ref = b.id;
    const connector = await openConnector(parseConfig(cfg, s.root), {
      stateDir: s.state,
      transport: s.project.transport(),
    });
    const snap = await connector.snapshot(join(s.root, 'snapshot-b'));
    const prereq = snap.snapshot.graph.prerequisites[0]!;
    // Недостижимый SHA: запись состояния-fixture с тем же издателем.
    const ghost = '1'.repeat(40);
    const lease = connector.store.acquire('fixture-ghost', 'test', 5000).lease!;
    const record = {
      issuer: connector.id,
      orderId: prereq.id,
      taskId: s.task.id,
      repositoryId: 'app',
      resultSha: ghost,
      workId: s.workId,
      runId: 'ghost',
      operation: 'fixture-ghost',
    };
    connector.store.putReceipt(record, lease.token);
    connector.close();

    // Файлы CLI: конфигурация коннектора, политика operator mode с fixture-reviewer.
    writeFileSync(join(s.root, 'connector.json'), JSON.stringify(cfg));
    const review = join(s.root, 'review-scenario.json');
    writeFileSync(
      review,
      JSON.stringify({
        reviewer: {
          result: {
            approved: true,
            summary: 'План полон',
            findings: [],
            discoveries: [],
            execution: { commands: [], noCommandsReason: 'Проверка плана' },
            previous: [],
          },
        },
      }),
    );
    const policy = {
      ...JSON.parse(JSON.stringify(s.policy)),
      approvalMode: 'operator',
      environment: { inherit: [], values: { FIXTURE_SCENARIO: review }, secrets: {} },
    } as Record<string, unknown>;
    writeFileSync(join(s.root, 'policy.json'), JSON.stringify(policy));
    const graph = JSON.parse(readFileSync(snap.files.graph, 'utf8')) as WorkGraph;
    const variant = (name: string, patch: (g: WorkGraph) => void) => {
      const g = structuredClone(graph);
      patch(g);
      const file = join(s.root, `graph-${name}.json`);
      writeFileSync(file, JSON.stringify(g));
      return file;
    };
    const harness = (args: string[]) => {
      const r = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), cli, ...args],
        {
          cwd: s.root,
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS: '',
            HARNESS_CODEX_BIN: bin('fake-codex'),
            HARNESS_CLAUDE_BIN: bin('fake-claude'),
          },
          timeout: 120_000,
        },
      );
      return {
        status: r.status,
        stderr: r.stderr,
        json: JSON.parse(r.stdout) as {
          ok: boolean;
          data?: Record<string, unknown>;
          error?: { code: string };
        },
      };
    };
    const reviewPlan = (graphFile: string, withSource: boolean) =>
      harness([
        'review-plan',
        '--state',
        s.state,
        '--policy',
        join(s.root, 'policy.json'),
        '--graph',
        graphFile,
        '--context',
        snap.files.context,
        '--author',
        'external',
        ...(withSource ? ['--source', join(s.root, 'connector.json')] : []),
      ]);
    const reviewerCalls = () => {
      try {
        return Number(readFileSync(`${review}.codex.reviewer.count`, 'utf8'));
      } catch {
        return 0;
      }
    };

    // Без источника доверенных receipt нет — отказ до вызова reviewer.
    const noSource = reviewPlan(
      variant('nosource', (g) => (g.source.revision = 'nosource')),
      false,
    );
    assert.equal(noSource.json.error?.code, 'NOT_READY', noSource.stderr);
    // Чужой издатель.
    const forged = reviewPlan(
      variant('forged', (g) => {
        g.id += 'f';
        g.source.revision = 'forged';
        g.prerequisites[0]!.receipt = {
          ...prereq.receipt,
          issuer: 'someone-else',
        } as typeof prereq.receipt;
      }),
      true,
    );
    assert.equal(forged.json.error?.code, 'NOT_READY', forged.stderr);
    // Доверенный receipt, SHA недостижим.
    const unreachable = reviewPlan(
      variant('unreachable', (g) => {
        g.id += 'u';
        g.source.revision = 'unreachable';
        g.prerequisites[0] = {
          ...prereq,
          resultSha: ghost,
          receipt: { kind: 'trusted', issuer: record.issuer, digest: digestOf(record) },
        };
      }),
      true,
    );
    assert.equal(unreachable.json.error?.code, 'NOT_READY', unreachable.stderr);
    assert.equal(reviewerCalls(), 0, 'отказы — до вызова reviewer');

    // Валидный receipt и SHA в target: ревью и согласование оператора проходят.
    const valid = reviewPlan(snap.files.graph, true);
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.json.data?.approved, true);
    const approve = harness([
      'approve',
      '--state',
      s.state,
      '--subject',
      graph.id,
      '--digest',
      snap.graphDigest,
    ]);
    assert.equal(approve.status, 0, approve.stderr);
  } finally {
    await s.cleanup();
  }
});
