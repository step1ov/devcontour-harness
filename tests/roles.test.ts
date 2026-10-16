/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тесты правят сырой JSON политики и читают записанные fixture запросы как есть.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  API_VERSION,
  HarnessError,
  digestOf,
  executionPolicySchema,
  sha256,
  sourceDigest,
  type ContextSnapshot,
  type ContractDocument,
  type ErrorCode,
} from '../src/contracts/index.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, implement } from './runner-fixture.ts';

// Механика ролей проверяется подставными runtime (fixture executables): это
// проверка того, что harness запускает, разрешает и запрещает, а не оценка
// качества работы живых моделей.

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};
const doc: ContractDocument = {
  apiVersion: API_VERSION,
  id: 'api',
  title: 'API приветствия',
  content: 'greet(name) возвращает строку Hello, <name>!',
};
const pairs: ['claude' | 'codex', 'claude' | 'codex'][] = [
  ['claude', 'codex'],
  ['codex', 'claude'],
  ['claude', 'claude'],
  ['codex', 'codex'],
];

test('S2.2/T31: четыре пары writer → reviewer для plan, candidate, integration и contract настоящим subprocess', async () => {
  for (const [writer, reviewer] of pairs) {
    const same = writer === reviewer;
    const name = `${writer}→${reviewer}`;
    const ctx = hsetup({
      writer,
      reviewer,
      ...(same ? { vendor: 'same-vendor-allowed' as const } : {}),
      scenario: { writer: implement(), reviewer: approve() },
    });
    const h = ctx.open();
    await h.run({ graph: ctx.graph, author: writer });
    const a = h.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.equal(a.status, 'succeeded', `${name}: ${a.error}`);
    assert.equal(a.runtime, writer, name);
    assert.equal(a.reviewer, reviewer, name);
    for (const phase of ['candidate', 'integration'])
      assert.ok(
        a.evidence.some(
          (e) =>
            e.kind === 'review' && e.phase === phase && e.passed && e.command?.[0] === reviewer,
        ),
        `${name}: ревью ${phase} выполнил ${reviewer}`,
      );
    const plan = h.engine.reviews('plan', ctx.graph.id).at(-1)!;
    assert.equal(plan.reviewerRuntime, reviewer, name);
    assert.equal(plan.sameVendor, same, name);
    const contract = await h.review({ kind: 'contract', contract: doc, author: writer });
    assert.equal(contract.reviewerRuntime, reviewer, name);
    assert.equal(contract.sameVendor, same, name);
    assert.equal(contract.approved, true, name);
    // Вызовы настоящих fixture executables: writer один раз, reviewer —
    // план, кандидат, интеграция и контракт.
    assert.equal(ctx.calls(writer, 'writer'), 1, name);
    assert.equal(ctx.calls(reviewer, 'reviewer'), 4, name);
    const result = h.result('add-greeting').result;
    assert.ok(
      result.evidence
        .filter((e) => e.kind === 'review')
        .every((e) => e.reviewer?.runtime === reviewer && e.reviewer.sameVendor === same),
      name,
    );
    h.close();
  }
});

test('S2.3/T31: один вендор без явного разрешения отклоняется до вызова — для plan, contract и code по отдельности', async () => {
  for (const runtime of ['claude', 'codex'] as const) {
    const other = runtime === 'claude' ? 'codex' : 'claude';
    // Только plan или только contract — того же вендора; остальное разрешено.
    for (const kind of ['plan', 'contract'] as const) {
      const ctx = hsetup({
        writer: runtime,
        reviewer: other,
        scenario: { writer: implement(), reviewer: approve() },
        policy: (p: any) => (p.review[kind] = { reviewer: { runtime } }),
      });
      const h = ctx.open();
      const call =
        kind === 'plan'
          ? h.run({ graph: ctx.graph, author: runtime })
          : h.review({ kind, contract: doc, author: runtime });
      await assert.rejects(call, refused('REVIEWER_SAME_VENDOR'));
      assert.equal(ctx.calls(runtime, 'reviewer'), 0, `${runtime} ${kind}: reviewer не вызывался`);
      assert.equal(ctx.calls(other, 'reviewer'), 0);
      assert.equal(ctx.calls(runtime, 'writer'), 0);
      h.close();
    }
    // Только code — того же вендора: план проходит ревью, выдачи нет.
    const ctx = hsetup({
      writer: runtime,
      reviewer: other,
      scenario: { writer: implement(), reviewer: approve() },
      policy: (p: any) => (p.review.code = { reviewer: { runtime } }),
    });
    const h = ctx.open();
    await assert.rejects(
      h.run({ graph: ctx.graph, author: runtime }),
      refused('REVIEWER_SAME_VENDOR'),
    );
    assert.equal(
      h.engine.read((v) => v.attempts().length),
      0,
      `${runtime} code: попытка не выдана`,
    );
    assert.equal(ctx.calls(runtime, 'writer'), 0, `${runtime} code: writer не вызывался`);
    assert.equal(ctx.calls(runtime, 'reviewer'), 0);
    h.close();
    // Явное разрешение снимает отказ, ничего больше не меняя.
    const raw = structuredClone(ctx.policy) as any;
    raw.review.code.vendor = 'same-vendor-allowed';
    const allowed = ctx.open(executionPolicySchema.parse(raw));
    await allowed.run({ graph: ctx.graph, author: runtime });
    assert.equal(
      allowed.engine.read((v) => v.work('add-greeting')!.status),
      'done',
      `${runtime} code: same-vendor-allowed`,
    );
    allowed.close();
  }
});

const snapshot = (text: string): ContextSnapshot => {
  const entry = {
    id: 'norms',
    kind: 'files',
    version: '1',
    required: true,
    files: [
      {
        path: 'norms.md',
        digest: sha256(text),
        bytes: Buffer.byteLength(text),
        content: { encoding: 'utf8' as const, data: text },
      },
    ],
    references: [],
  };
  return {
    apiVersion: API_VERSION,
    sources: [{ ...entry, digest: sourceDigest(entry) }],
    missing: [],
  };
};

test('S2.4/T32: same-vendor reviewer — свежая сессия без истории writer; исходные критерии, контекст, контракт, diff, evidence и прежние находки; права без записи', async () => {
  for (const runtime of ['claude', 'codex'] as const) {
    const finding = {
      severity: 'blocking',
      message: 'FINDING-EMPTY-NAME: нет обработки пустого имени',
      path: 'src/greet.js',
      line: 1,
      rule: null,
      consequence: null,
      evidence: null,
      reproduction: null,
    };
    const reject = approve('Отклонено');
    (reject.result as any).approved = false;
    (reject.result as any).findings = [finding];
    const writerSummary = 'WRITER-PRIVATE-REASONING-7c1';
    const write = { ...implement(), recordPrompt: true };
    (write.result as any).summary = writerSummary;
    const norms = 'NORM-RULE-42: экспорт только через exports.\n';
    const ctx = hsetup({
      writer: runtime,
      reviewer: runtime,
      vendor: 'same-vendor-allowed',
      scenario: {
        writer: write,
        // Контракт, план, кандидат попытки 1 (отклонён), кандидат и интеграция попытки 2.
        reviewer: [
          approve(),
          approve(),
          { ...reject, recordPrompt: true },
          { ...approve(), recordPrompt: true },
          { ...approve(), recordPrompt: true },
        ],
      },
      graph: (g: any) => (g.orders[0].context = ['norms']),
      policy: (p: any) => (p.maxAttempts = 3),
    });
    const h = ctx.open();
    await h.review({ kind: 'contract', contract: doc, author: runtime });
    const graph = structuredClone(ctx.graph) as any;
    graph.orders[0].contracts = [{ id: 'api', digest: digestOf(doc) }];
    const run = { graph, author: runtime, context: snapshot(norms) } as const;
    await h.run(run);
    if (h.engine.read((v) => v.work('add-greeting')!.status) !== 'done') {
      h.engine.retry('add-greeting');
      await h.run(run);
    }
    assert.equal(
      h.engine.read((v) => v.work('add-greeting')!.status),
      'done',
      h.engine.read((v) => v.work('add-greeting')!.failure),
    );
    // Индексы reviewer считаются вместе с ревью контракта (0) и плана (1).
    const prompts = [2, 3, 4].map((i) => {
      const file = `${ctx.scenarioPath}.reviewer.${i}.prompt`;
      assert.ok(existsSync(file), `${runtime}: запрос reviewer ${i} записан`);
      const [text, args] = readFileSync(file, 'utf8').split('\n---ARGS---\n') as [string, string];
      return { text, args: JSON.parse(args) as string[] };
    });
    const writerPrompt = readFileSync(`${ctx.scenarioPath}.writer.0.prompt`, 'utf8');
    for (const [i, p] of prompts.entries()) {
      const name = `${runtime} reviewer ${i}`;
      assert.match(p.text, /greet\('Ada'\) returns 'Hello, Ada!'/, name + ': исходные AC');
      assert.match(p.text, /NORM-RULE-42/, name + ': закреплённый контекст');
      assert.match(p.text, /Approved contracts: .*Hello, <name>!/, name + ': контракт');
      assert.match(p.text, /Exact diff to review:\n[\s\S]*Hello, /, name + ': diff');
      assert.match(
        p.text,
        /Evidence the controller recorded for the review commit[^\n]*"gate":"unit"[^\n]*"passed":true/,
        name + ': evidence gates этого SHA',
      );
      assert.ok(!p.text.includes(writerSummary), name + ': нет рассуждений writer');
      // Новая сессия: никаких флагов продолжения; у claude — без сохранения сессии.
      for (const flag of ['--resume', '--continue', '--session-id', 'resume'])
        assert.ok(!p.args.includes(flag), name + ': нет ' + flag);
      if (runtime === 'claude') {
        assert.ok(p.args.includes('--no-session-persistence'), name);
        assert.equal(p.args[p.args.indexOf('--permission-mode') + 1], 'dontAsk', name);
        assert.match(p.args[p.args.indexOf('--disallowedTools') + 1]!, /Edit,Write/, name);
      } else {
        const permissions = p.args.find((x) => x.startsWith('permissions.harness='))!;
        assert.equal(
          permissions.match(/="write"/g)?.length,
          1,
          name + ': запись только во временный каталог',
        );
      }
    }
    assert.ok(!prompts[0]!.text.includes('FINDING-EMPTY-NAME'), 'у первого ревью находок нет');
    assert.match(prompts[1]!.text, /FINDING-EMPTY-NAME/, 'второй попытке видна прежняя находка');
    // Writer сам себя не одобряет: evidence ревью — только от вызова reviewer.
    assert.ok(!writerPrompt.includes('Exact diff to review'));
    const attempts = h.engine.read((v) => v.attempts('add-greeting'));
    for (const a of attempts)
      for (const e of a.evidence.filter((x) => x.kind === 'review'))
        assert.deepEqual(e.command, [runtime, 'review-code']);
    h.close();
  }
});
