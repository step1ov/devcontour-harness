/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument --
 * Тесты портят сырой JSON политики и графа до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executionPolicySchema,
  policyIssues,
  workGraphSchema,
  workOrderSchema,
  type ContractApprovals,
} from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { graphOf, planReview, policyOf, trustNone } from './engine-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, greet, implement, runAll, setup, target } from './runner-fixture.ts';

/** Движок с хостом, который сам согласует контракты (как DevContour). */
function withContracts(contracts?: ContractApprovals) {
  const policy = policyOf();
  const store = new SqliteExecutionStore(
    join(mkdtempSync(join(tmpdir(), 'harness-host-')), 'state.sqlite'),
    'test',
  );
  const engine = new Engine({
    host: { ...standaloneHost(store, policy), ...(contracts ? { contracts } : {}) },
    policy,
  });
  const raw = structuredClone(graphOf({ a: [] })) as any;
  raw.orders[0].contracts = [{ id: 'api', digest: 'a'.repeat(64) }];
  const { graph } = engine.register(workGraphSchema.parse(raw), trustNone);
  engine.recordReview(planReview(engine, graph, 1));
  engine.approve(graph.id, 'agent');
  engine.lead('c1');
  engine.resume();
  return engine;
}

test('Хост, согласующий контракты сам: редакция digest подтверждена портом — выдача без раундов ревью; отказ хоста — блокер, выдачи нет', () => {
  // Без порта: раундов ревью контракта нет — поручение не выдаётся.
  const plain = withContracts();
  assert.equal(plain.claim('c1'), undefined);
  assert.match(
    plain
      .read((v) => plain.blockers(v.work('a')!, v))
      .map((b) => b.message)
      .join(';'),
    /Контракт api не проходил технического ревью/,
  );
  // Порт хоста отказывает — его причина в блокерах, выдачи нет.
  const asked: string[] = [];
  const refusing = withContracts({
    approved: (ref) => {
      asked.push(ref.id + ':' + ref.digest);
      return { code: 'NOT_READY', message: `Контракт ${ref.id} не утверждён в продукте` };
    },
  });
  assert.equal(refusing.claim('c1'), undefined);
  assert.match(
    refusing
      .read((v) => refusing.blockers(v.work('a')!, v))
      .map((b) => b.message)
      .join(';'),
    /Контракт api не утверждён в продукте/,
  );
  assert.ok(asked.includes('api:' + 'a'.repeat(64)), 'хосту передан закреплённый digest');
  // Порт подтверждает — выдача без записей ревью контракта.
  const approving = withContracts({ approved: () => null });
  assert.ok(approving.claim('c1'), 'согласованный хостом контракт не держит выдачу');
  assert.equal(approving.reviews('contract', 'api').length, 0, 'раунды ревью не выдуманы');
});

test('Область записи «весь репозиторий» (".") — единственный элемент; запись вне src принимается, защищённые пути по-прежнему защищены', async () => {
  const order = graphOf({ a: [] }).orders[0] as any;
  assert.ok(workOrderSchema.safeParse({ ...order, writeScope: ['.'] }).success);
  assert.ok(!workOrderSchema.safeParse({ ...order, writeScope: ['.', 'src'] }).success);
  assert.ok(!workOrderSchema.safeParse({ ...order, writeScope: ['./src'] }).success);
  for (const [files, done] of [
    [{ 'src/greet.js': greet, 'lib/extra.js': 'module.exports = 1;\n' }, true],
    [{ 'src/greet.js': greet, '.github/workflows/x.yml': 'x' }, false],
  ] as const) {
    const ctx = setup({
      scenario: { writer: implement(files), reviewer: approve() },
      policy: (p) => ((p as { maxAttempts: number }).maxAttempts = 1),
      graph: (g: any) => (g.orders[0].writeScope = ['.']),
    });
    const before = target(ctx);
    await runAll(ctx);
    const work = ctx.engine.read((v) => v.work('add-greeting')!);
    if (done) assert.equal(work.status, 'done', work.failure);
    else {
      assert.equal(work.status, 'failed');
      assert.equal(work.failureKind, 'scope-violation');
      assert.match(work.failure!, /защищённые файлы: \.github\/workflows\/x\.yml/);
      assert.equal(target(ctx), before);
    }
  }
});

test('MCP-серверы профиля инструментов: CLI получает только их инструменты, переменные — по имени; без серверов — ничего лишнего', async () => {
  process.env.PROFILE_MCP_TOKEN = 'mcp-token-value';
  try {
    for (const writer of ['claude', 'codex'] as const) {
      const ctx = hsetup({
        writer,
        reviewer: writer === 'claude' ? 'codex' : 'claude',
        scenario: { writer: { ...implement(), recordPrompt: true }, reviewer: approve() },
        policy: (p: any) => {
          p.toolProfiles = {
            tools: {
              runtime: writer,
              mcp: {
                docs: {
                  transport: 'stdio',
                  command: 'docs-mcp',
                  args: ['--read-only'],
                  env: ['PROFILE_MCP_TOKEN'],
                  tools: ['search'],
                },
                tracker: {
                  transport: 'http',
                  url: 'https://tracker.example.test/mcp',
                  bearerTokenEnv: 'PROFILE_MCP_TOKEN',
                  tools: ['issue'],
                },
              },
            },
          };
          p.roles.developer.writer.toolProfile = 'tools';
        },
      });
      const h = ctx.open();
      await h.run({ graph: ctx.graph, author: writer });
      assert.equal(
        h.engine.read((v) => v.work('add-greeting')!.status),
        'done',
        writer,
      );
      const [, rawArgs] = readFileSync(`${ctx.scenarioPath}.writer.0.prompt`, 'utf8').split(
        '\n---ARGS---\n',
      ) as [string, string];
      const args = JSON.parse(rawArgs) as string[];
      if (writer === 'claude') {
        const config = args[args.indexOf('--mcp-config') + 1]!;
        assert.ok(existsSync(config), 'файл MCP-конфигурации записан');
        const servers = JSON.parse(readFileSync(config, 'utf8')).mcpServers;
        assert.deepEqual(Object.keys(servers).sort(), ['docs', 'tracker']);
        assert.equal(
          servers.docs.env.PROFILE_MCP_TOKEN,
          '${PROFILE_MCP_TOKEN}',
          'значение не записано',
        );
        assert.equal(servers.tracker.headers.Authorization, 'Bearer ${PROFILE_MCP_TOKEN}');
        const allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');
        assert.ok(allowed.includes('mcp__docs__search') && allowed.includes('mcp__tracker__issue'));
        assert.ok(args.includes('--strict-mcp-config'));
      } else {
        const servers = args.find((a) => a.startsWith('mcp_servers='))!;
        assert.match(
          servers,
          /"docs" = \{ "enabled" = true, "required" = true, "enabled_tools" = \["search"\], "command" = "docs-mcp"/,
        );
        assert.match(
          servers,
          /"tracker" = \{[^}]*"url" = "https:\/\/tracker\.example\.test\/mcp", "bearer_token_env_var" = "PROFILE_MCP_TOKEN"/,
        );
        assert.ok(args.includes('--ignore-user-config'));
      }
      assert.ok(!rawArgs.includes('mcp-token-value'), 'значение переменной не в аргументах');
      assert.equal(
        ctx.callEnv(writer, 'writer', 0)?.get('PROFILE_MCP_TOKEN'),
        'mcp-token-value',
        'переменная сервера передана writer по имени',
      );
      // Reviewer без профиля MCP-серверов не получает.
      h.close();
    }
  } finally {
    delete process.env.PROFILE_MCP_TOKEN;
  }
  assert.ok(
    !executionPolicySchema.safeParse({
      ...policyOf(),
      toolProfiles: { t: { runtime: 'codex', mcp: { x: { transport: 'stdio', tools: ['a'] } } } },
    }).success,
    'stdio без command — отказ схемы',
  );
  assert.ok(
    !executionPolicySchema.safeParse({
      ...policyOf(),
      toolProfiles: {
        t: {
          runtime: 'codex',
          mcp: { x: { transport: 'http', url: 'https://u:p@h.test/', tools: ['a'] } },
        },
      },
    }).success,
    'учётные данные в URL — отказ схемы',
  );
});

test('Роль, переопределённая репозиторием, целиком заменяет роль политики; reviewer — роли, иначе репозитория, иначе политики', async () => {
  const ctx = hsetup({
    scenario: { writer: implement(), reviewer: approve() },
    policy: (p: any) => {
      // Политика: writer claude, ревью кода codex. Репозиторий: writer codex, ревью claude.
      p.repositories[0].roles = { developer: { writer: { runtime: 'codex' } } };
      p.repositories[0].review = { reviewer: { runtime: 'claude' } };
    },
  });
  const h = ctx.open();
  await h.run({ graph: ctx.graph, author: 'claude' });
  const a = h.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  assert.equal(a.runtime, 'codex', 'writer роли репозитория');
  assert.equal(a.reviewer, 'claude', 'ревью кода репозитория');
  assert.equal(ctx.calls('claude', 'writer'), 0, 'writer роли политики не вызывался');
  assert.equal(ctx.calls('codex', 'writer'), 1);
  h.close();
  // Тот же вендор у роли репозитория без разрешения — отказ проверки политики.
  const raw = structuredClone(ctx.policy) as any;
  raw.repositories[0].review = { reviewer: { runtime: 'codex' } };
  const issues = policyIssues(executionPolicySchema.parse(raw));
  assert.ok(
    issues.some(
      (i) =>
        i.code === 'REVIEWER_SAME_VENDOR' && i.path.join('.') === 'repositories.0.roles.developer',
    ),
    JSON.stringify(issues),
  );
});
