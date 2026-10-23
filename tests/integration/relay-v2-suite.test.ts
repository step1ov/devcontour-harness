/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument --
   независимый read-back: сырой JSON настоящего CLI проверяется assertions, а не типами. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectorSuite,
  harnessComments,
  scenario,
  type SuiteBackend,
} from '../../src/integrations/connector/testing.ts';
import { createTransport } from '../../src/integrations/relay-v2/index.ts';
import {
  createLossyRelayV2Wrapper,
  createRelayV2Project,
  relayV2Admin,
  relayV2Binary,
  relayV2Info,
  type RelayV2Project,
} from '../../scripts/acceptance/relay-v2-fixture.mjs';

/**
 * Общий набор коннектора (W02–W05, D01–D06, R04) на НАСТОЯЩЕМ Relay-2 CLI:
 * каждый `project()` — новый изолированный проект (временный RELAY_HOME,
 * `relay init`), «другой участник» — отдельный actor через тот же CLI.
 * Процессы восстановления/гонок (testing-worker.ts) создают транспорт по
 * конфигурации коннектора (`worker: {kind: 'config'}`).
 * Плюс D02 с настоящим получателем через обёртку, теряющую ответ после commit.
 * Нет binary — BLOCKED (падение), а не пропуск.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UPGRADE = join(ROOT, '.private/integration-upgrade');
const BIN = relayV2Binary();
const INFO = relayV2Info(BIN);
const ACTOR = 'harness-controller';
/** ID набора для evidence (запуск по одному ID: CONNECTOR_SUITE_ONLY=W02 …). */
const ONLY = process.env.CONNECTOR_SUITE_ONLY?.split(',');
const EVIDENCE_ID = ONLY?.length === 1 ? ONLY[0]! : 'suite';

function evidence(id: string, name: string, value: unknown) {
  if (!existsSync(UPGRADE)) return;
  const dir = join(UPGRADE, 'evidence', id, 'relay-v2');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, name), `${JSON.stringify(value)}\n`);
}

/** Read-back проекта настоящим CLI (не через проверяемый транспорт). */
function dump(p: RelayV2Project) {
  const tasks = p.cli(['task', 'list', '--limit=100']).items as any[];
  const sessions = p.cli(['session', 'list', '--limit=100']).items as any[];
  return {
    projectId: p.projectId,
    generation: p.generation(),
    tasks: tasks.map((t) => ({
      key: t.key,
      revision: t.revision,
      column: t.data.column,
      criteria: t.data.acceptanceCriteria.map((c: any) => [c.title, c.completed]),
      comments: t.data.comments.map((c: any) => ({
        by: c.createdBy,
        marker: /devcontour-harness:op=[^ ]*/.exec(c.body)?.[0] ?? null,
        bytes: c.body.length,
      })),
    })),
    sessions: sessions.map((s) => ({
      key: s.key,
      status: s.data.status,
      revision: s.revision,
      parent: s.data.parentSessionId,
      runs: s.data.runs.map((r: any) => [r.actor, r.state]),
    })),
  };
}

function requireBinary(): string {
  if (!BIN)
    assert.fail(
      'BLOCKED: настоящий Relay-2 binary не найден. Соберите relay-2 (commit a3ee804, Bun 1.4.3) и задайте HARNESS_RELAY2_BIN',
    );
  return BIN;
}

interface Options {
  /** Binary конфигурации коннектора (то, что запускают процессы доставки). */
  binary?: (p: RelayV2Project) => string;
  onProject?: (p: RelayV2Project) => void;
}

function relayV2Backend(o: Options = {}): SuiteBackend {
  return {
    name: 'relay-v2',
    project: () => {
      const bin = requireBinary();
      const p = createRelayV2Project({ bin, name: 'Suite', slug: 'suite' });
      o.onProject?.(p);
      const binary = o.binary?.(p) ?? bin;
      const relay: Record<string, unknown> = {
        binary,
        config: p.config,
        env: p.env,
        timeoutMs: 30_000,
        ...(binary === bin && INFO.sha256
          ? { build: { sha256: INFO.sha256, ...(INFO.commit ? { commit: INFO.commit } : {}) } }
          : {}),
      };
      return Promise.resolve({
        provider: 'relay-v2-cli' as const,
        projectId: p.projectId,
        actor: ACTOR,
        relay,
        // Транспорт процесса теста — всегда настоящий binary (независимый read-back).
        transport: () =>
          createTransport({ ...relay, binary: bin, projectId: p.projectId, actor: ACTOR } as never),
        worker: { kind: 'config' as const },
        admin: relayV2Admin(p),
        cleanup: () => {
          try {
            evidence(EVIDENCE_ID, 'read-back.jsonl', dump(p));
          } finally {
            p.cleanup();
          }
          return Promise.resolve();
        },
      });
    },
  };
}

test('relay-v2 suite: настоящий binary и сборка', () => {
  requireBinary();
  assert.equal(INFO.sha256?.length, 64);
  evidence(EVIDENCE_ID, 'build.jsonl', INFO);
});

connectorSuite(relayV2Backend(), {
  timeoutMs: 600_000,
  ...(ONLY ? { only: ONLY } : {}),
});

/**
 * D02 с настоящим получателем: обёртка выполняет настоящую команду
 * `task comment add` (commit у получателя) и теряет ответ — либо убивает
 * процесс доставки (падение после commit), либо возвращает пустой вывод.
 * Новый процесс над тем же каталогом состояния находит ровно один маркер,
 * сохраняет receipt, повторной мутации нет.
 */
if (!ONLY || ONLY.includes('D02'))
  for (const mode of ['kill-parent', 'drop'] as const)
    test(
      `D02/relay-v2: настоящий commit, потерянный ответ (${mode}) → новый процесс восстанавливает по read-back без второй мутации`,
      { timeout: 600_000 },
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'relay-v2-d02-'));
        let project: RelayV2Project | undefined;
        let wrapper: ReturnType<typeof createLossyRelayV2Wrapper> | undefined;
        const s = await scenario(
          relayV2Backend({
            onProject: (p) => (project = p),
            binary: () => {
              wrapper = createLossyRelayV2Wrapper({
                bin: requireBinary(),
                dir,
                match: ['comment', 'add', 'devcontour-harness:op='],
                mode,
              });
              return wrapper.path;
            },
          }),
        );
        try {
          const o = await s.runOnly();
          const p = project!;
          const count = () =>
            (p.cli(['task', 'comment', 'list', s.task.id]).items as { body: string }[]).filter(
              (c) => c.body.includes('devcontour-harness:op='),
            );
          assert.equal(count().length, 0, 'контроль: до доставки записей нет');
          const target = s.target();
          const calls = { ...s.calls };
          const first = await s.worker({ action: 'deliver', workId: s.workId });
          assert.equal(wrapper!.hits(), 1, 'настоящая команда выполнена один раз');
          if (mode === 'kill-parent')
            assert.notEqual(first.code, 0, 'процесс доставки упал после commit у получателя');
          const committed = count();
          assert.equal(committed.length, 1, 'запись у получателя есть (commit до потери ответа)');
          const op = o.connector.store.operations({ workId: s.workId })[0]!;
          assert.ok(op, 'intent сохранён до отправки');
          await s.waitLeases();
          const resumed = await s.worker({ action: 'deliver', workId: s.workId });
          assert.equal(resumed.output?.ok, true, resumed.stderr + JSON.stringify(resumed.output));
          // Повтор доставки в ещё одном процессе — тоже без мутаций.
          const again = await s.worker({ action: 'deliver', workId: s.workId });
          assert.equal(again.output?.ok, true, again.stderr);
          assert.equal(wrapper!.hits(), 1, 'второй отправки комментария не было');
          const after = count();
          assert.equal(after.length, 1, 'ровно один маркер у получателя');
          assert.equal(after[0]!.body, committed[0]!.body);
          const final = o.connector.store.operation(op.key)!;
          assert.equal(final.status, 'delivered');
          assert.ok(final.receipt, 'receipt сохранён');
          const comment = final.steps.find((x) => x.kind === 'comment');
          assert.equal(
            comment?.sends,
            1,
            JSON.stringify(final.steps.map((x) => [x.kind, x.sends])),
          );
          assert.equal(s.target(), target, 'Git ref не изменился');
          assert.deepEqual(s.calls, calls, 'runtime не вызывался');
          assert.equal((await harnessComments(s.project.transport(), s.task.id)).length, 1);
          const task = p.cli(['task', 'get', s.task.id]);
          assert.equal(task.data.column, 'done');
          evidence('D02', `lossy-${mode}.jsonl`, {
            first: { code: first.code, output: first.output },
            resumed: resumed.output,
            steps: final.steps.map((x) => ({ kind: x.kind, status: x.status, sends: x.sends })),
            receipt: final.receipt,
            readBack: { markers: after.length, column: task.data.column, revision: task.revision },
            target,
          });
        } finally {
          await s.cleanup();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
