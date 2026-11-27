/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тест правит сырой JSON политики до разбора схемой.
 */
/**
 * 0.1.0-alpha.73: поток сдачи тонкого режима на фейковых CLI. Одно дерево и
 * одна сессия writer на работу; проверка — на чистом checkout цели со
 * слиянием; отказ возвращается в ту же сессию; сбой среды — один повтор.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { Engine } from '../src/engine/engine.ts';
import { Runner } from '../src/engine/runner.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { hsetup } from './harness-fixture.ts';
import { approve, bin, greet, implement, runAll, setup } from './runner-fixture.ts';

type Options = Parameters<typeof setup>[0];

/** Тонкий режим над Harness: очередь с повторами и маршрутом ведущего. */
function thin(options: Options & { maxAttempts?: number }) {
  const ctx = hsetup({
    ...options,
    policy: (p) => {
      p.harnessMode = 'thin';
      p.maxAttempts = options.maxAttempts ?? 3;
      options.policy?.(p);
    },
  });
  const work = ctx.graph.orders[0]!.id;
  let h: ReturnType<typeof ctx.open> | undefined;
  const run = async () => {
    h?.close();
    h = ctx.open();
    return h.run({ graph: ctx.graph, author: 'claude' });
  };
  const attempts = () => h!.engine.read((v) => v.attempts(work));
  const prompt = (i: number) => readFileSync(`${ctx.scenarioPath}.writer.${i}.prompt`, 'utf8');
  const resumed = (i: number) => {
    const f = `${ctx.scenarioPath}.claude.writer.${i}.resumed`;
    return existsSync(f) ? readFileSync(f, 'utf8') : undefined;
  };
  const head = () => ctx.repo.git('rev-parse', ctx.policy.repositories[0]!.targetRef);
  return { ...ctx, work, run, attempts, prompt, resumed, head, h: () => h! };
}

/** Сдвинуть цель коммитом с файлом `path` (содержимое `text`) из дерева исполнителя. */
const moveTarget = (path: string, text: string) =>
  `T=$(git rev-parse refs/heads/harness/accepted); export GIT_INDEX_FILE="$PWD/../.idx-$$"; git read-tree $T; ` +
  `B=$(printf "${text}" | git hash-object -w --stdin); git update-index --add --cacheinfo 100644,$B,${path}; ` +
  `TREE=$(git write-tree); C=$(git -c user.name=x -c user.email=x@x commit-tree $TREE -p $T -m moved); ` +
  `git update-ref refs/heads/harness/accepted $C $T; rm -f "$GIT_INDEX_FILE"`;

const rec = <T extends object>(step: T) => ({ ...step, recordPrompt: true });

test('thin: одна сдача — слияние, gates и ревью на интеграции, приёмка; дерево и сессии убраны', async () => {
  const ctx = thin({ scenario: { writer: rec(implement()), reviewer: approve() } });
  await ctx.run();
  const [a] = ctx.attempts();
  assert.equal(a!.status, 'succeeded', a!.error);
  assert.equal(a!.writerSession?.mode, 'fresh');
  assert.equal(
    ctx.h().engine.read((v) => v.work(ctx.work)!.status),
    'done',
  );
  assert.equal(ctx.head(), a!.integrationSha);
  assert.equal(
    a!.evidence.some((e) => e.phase === 'candidate'),
    false,
    'фазы кандидата нет',
  );
  assert.ok(a!.evidence.some((e) => e.kind === 'review' && e.phase === 'integration' && e.passed));
  assert.equal(existsSync(a!.worktree!), false, 'дерево работы убрано');
  assert.equal(
    existsSync(join(dirname(a!.worktree!), '..', 'sessions', ctx.work)),
    false,
    'сессии работы убраны',
  );
  assert.match(ctx.prompt(0), /Thin mode: this is the one writer session/);
  assert.ok(
    a!.timings?.some((t) => t.stage === 'integration-wait'),
    'ожидание замка интеграции — своя стадия',
  );
});

const wrong = "exports.greet = (name) => 'Hi ' + name;\n";
const reject = {
  result: {
    ...approve().result,
    approved: false,
    summary: 'Нет обработки пустого имени',
    findings: [
      {
        severity: 'blocking',
        message: 'Нет обработки пустого имени',
        path: 'src/greet.js',
        line: 1,
        rule: null,
        consequence: null,
        evidence: null,
      },
    ],
  },
};
const closing = {
  result: {
    ...approve().result,
    previous: [{ id: '$open:0', status: 'closed', basis: 'Пустое имя обработано' }],
  },
};

test('чистый checkout: игнорируемый файл, с которым gate зелёный в дереве работы, на интеграцию не попадает', async () => {
  const ctx = thin({
    files: { '.gitignore': 'src/greet.js\n' },
    maxAttempts: 1,
    scenario: {
      writer: rec({ ...implement({ 'src/greet.js': greet, 'src/index.js': '// entry\n' }) }),
      reviewer: approve(),
    },
  });
  await ctx.run();
  const [a] = ctx.attempts();
  assert.equal(a!.failureKind, 'gate', a!.error);
  const unit = a!.evidence.findLast((e) => e.kind === 'test' && e.gate === 'unit')!;
  assert.equal(unit.phase, 'integration');
  assert.equal(unit.passed, false);
  // Дерево работы цело, файл в нём — для следующей сдачи.
  assert.ok(existsSync(a!.worktree + '/src/greet.js'));
});

test('провал gate → та же сессия продолжена с хвостом провала → вторая сдача принята', async () => {
  const ctx = thin({
    scenario: {
      writer: [rec(implement({ 'src/greet.js': wrong })), rec(implement())],
      reviewer: approve(),
    },
  });
  await ctx.run();
  const [first, second] = ctx.attempts();
  assert.equal(first!.failureKind, 'gate');
  assert.equal(second!.status, 'succeeded', second!.error);
  assert.equal(second!.writerSession?.mode, 'resumed');
  assert.equal(second!.writerSession?.id, first!.writerSession?.id);
  assert.equal(ctx.resumed(1), first!.writerSession?.id);
  assert.match(ctx.prompt(1), /did not pass/);
  assert.match(ctx.prompt(1), /got Hi Ada/, 'хвост провала gate в продолжении');
  assert.match(ctx.prompt(1), /rerun your gates in this worktree until they pass/);
  assert.doesNotMatch(ctx.prompt(1), /You do not need to rerun the gates/);
  assert.doesNotMatch(ctx.prompt(1), /Thin mode: this is the one writer session/);
  assert.equal(first!.worktree, second!.worktree, 'одно дерево работы');
});

test('отказ ревью → ID находки controller в продолжении; закрыта во второй сдаче', async () => {
  const ctx = thin({
    scenario: {
      writer: [rec(implement()), rec(implement())],
      reviewer: [approve(), reject, closing],
    },
  });
  await ctx.run();
  const [first, second] = ctx.attempts();
  assert.equal(first!.failureKind, 'review');
  assert.equal(second!.status, 'succeeded', second!.error);
  const finding = first!.evidence.findLast((e) => e.kind === 'review')!.findings![0]!;
  assert.ok(finding.id);
  assert.ok(ctx.prompt(1).includes(finding.id), 'ID находки в продолжении');
  assert.match(ctx.prompt(1), /Нет обработки пустого имени/);
});

test('три одинаковых провала gate — та же сессия до maxAttempts, затем ведущему (правил повтора нет)', async () => {
  const ctx = thin({
    scenario: { writer: rec(implement({ 'src/greet.js': wrong })), reviewer: approve() },
  });
  const d = await ctx.run();
  const all = ctx.attempts();
  assert.equal(all.length, 3, d.workflow?.error);
  assert.ok(all.every((a) => a.failureKind === 'gate'));
  assert.equal(new Set(all.map((a) => a.failureFingerprint)).size, 1, 'один и тот же провал');
  assert.deepEqual(
    all.map((a) => a.writerSession?.mode),
    ['fresh', 'resumed', 'resumed'],
  );
  assert.match(d.workflow?.error ?? '', /исчерпан бюджет попыток/);
});

test('цель сдвинулась после сдачи — слита в ветку работы; конфликт остаётся исполнителю', async () => {
  const ctx = thin({
    scenario: {
      writer: [
        { ...rec(implement({ 'src/greet.js': wrong })), shell: moveTarget('README.md', 'moved') },
        rec(implement()),
      ],
      reviewer: approve(),
    },
  });
  await ctx.run();
  const [first, second] = ctx.attempts();
  assert.equal(first!.failureKind, 'gate');
  assert.equal(second!.status, 'succeeded', second!.error);
  assert.match(ctx.prompt(1), /merged it into this worktree cleanly/);

  const clash = thin({
    scenario: {
      writer: [
        {
          ...rec(implement({ 'src/greet.js': wrong })),
          shell: moveTarget('src/greet.js', 'other'),
        },
        rec(implement()),
      ],
      reviewer: approve(),
    },
  });
  // Первый конфликт при проверке — незасчитанный повтор без ведущего:
  // следующая сдача сливает цель в ветку работы, исполнитель разрешает.
  await clash.run();
  const [a, b] = clash.attempts();
  assert.equal(a!.failureKind, 'stale-base', a!.error);
  assert.match(a!.error ?? '', /^MERGE_CONFLICT_REQUEUE/);
  assert.equal(b!.status, 'succeeded', b!.error);
  assert.match(clash.prompt(1), /merge has conflicts in: src\/greet\.js/);
  assert.match(clash.prompt(1), /do not run git add, commit or merge/);
});

test('три отказа — работа исчерпана, маршрут ведущего', async () => {
  // Разные дефекты: одинаковый дважды подряд — ход ведущего раньше (правило повторов).
  const rejectWith = (message: string, closes = false) => ({
    result: {
      ...reject.result,
      summary: message,
      findings: [{ ...reject.result.findings[0]!, message, line: null }],
      previous: closes ? [{ id: '$open:0', status: 'closed', basis: 'Исправлено' }] : [],
    },
  });
  const ctx = thin({
    scenario: {
      writer: rec(implement()),
      reviewer: [
        approve(),
        rejectWith('Нет проверки пустого имени'),
        rejectWith('Нет экранирования HTML', true),
        rejectWith('Нет обработки null', true),
      ],
    },
  });
  const d = await ctx.run();
  const all = ctx.attempts();
  assert.equal(all.length, 3, d.workflow?.error);
  assert.ok(all.every((a) => a.failureKind === 'review'));
  assert.deepEqual(
    all.map((a) => a.writerSession?.mode),
    ['fresh', 'resumed', 'resumed'],
  );
  const w = ctx.h().engine.read((v) => v.work(ctx.work)!);
  assert.equal(w.status, 'failed');
  assert.equal(w.attempt, 3);
  assert.equal(ctx.h().engine.read((v) => v.control()).paused, false);
});

/** Gate, который виснет (таймаут без упавшего теста): первый раз или всегда. */
const hang = `
const fs = require('fs');
const mark = process.env.HANG_MARK;
if (process.env.HANG_ALWAYS || !fs.existsSync(mark)) { fs.writeFileSync(mark, ''); setInterval(() => {}, 1000); }
else require('./run.js');
`;
const hanging = (always: boolean) => (p: Record<string, any>) => {
  const gate = p.repositories[0].gates[0];
  gate.command = [process.execPath, 'test/hang.js'];
  gate.timeoutMs = 1500;
  p.environment.values.HANG_MARK = p.environment.values.FIXTURE_SCENARIO + '.hang';
  if (always) p.environment.values.HANG_ALWAYS = '1';
};

test('сбой среды gate: повтор той же проверки прошёл — сдача принята', async () => {
  const ctx = thin({
    files: { 'test/hang.js': hang },
    policy: hanging(false),
    scenario: { writer: rec(implement()), reviewer: approve() },
  });
  await ctx.run();
  const [a] = ctx.attempts();
  assert.equal(a!.status, 'succeeded', a!.error);
  const runs = a!.evidence.filter((e) => e.kind === 'test' && e.gate === 'unit');
  assert.deepEqual(
    runs.map((e) => e.passed),
    [false, true],
  );
  assert.ok(runs[1]!.recheck, 'повтор ссылается на первую запись');
});

test('сбой среды gate дважды — ведущему (gate-environment), не засчитано, без паузы', async () => {
  const ctx = thin({
    files: { 'test/hang.js': hang },
    policy: hanging(true),
    scenario: { writer: rec(implement()), reviewer: approve() },
  });
  await ctx.run();
  const [a] = ctx.attempts();
  assert.equal(a!.failureKind, 'needs-lead', a!.error);
  assert.equal(a!.leadCause, 'gate-environment');
  assert.match(a!.error ?? '', /сбой среды дважды/);
  const w = ctx.h().engine.read((v) => v.work(ctx.work)!);
  assert.equal(w.attempt, 0, 'не засчитано');
  assert.equal(ctx.h().engine.read((v) => v.control()).paused, false);
  assert.equal(ctx.attempts().length, 1, 'без автоматического повтора');
  // Повтор ведущего: незасчитанная попытка получает тот же номер, а владелец
  // общего дерева работы для уборки — последняя выданная попытка.
  ctx.h().engine.retry(ctx.work, undefined, 'lead');
  await ctx.run();
  const [, second] = ctx.attempts();
  assert.equal(second!.attempt, a!.attempt, 'номер повторился');
  const swept = await ctx.h().cleanupWorktrees({ dryRun: true });
  const tree = swept.worktrees.find((e) => e.path.endsWith(`work-${ctx.work}`));
  assert.equal(tree?.attemptId, second!.id);
});

test('цель сдвинулась между сдачами — слияние на новой цели; конфликт — ведущему (merge-conflict)', async () => {
  const ctx = thin({
    scenario: {
      writer: [
        rec(implement({ 'src/greet.js': wrong })),
        { ...rec(implement()), shell: moveTarget('README.md', 'moved') },
      ],
      reviewer: approve(),
    },
  });
  await ctx.run();
  const [first, second] = ctx.attempts();
  assert.equal(first!.failureKind, 'gate');
  assert.equal(second!.status, 'succeeded', second!.error);
  const parents = ctx.repo
    .git('rev-list', '--parents', '-n', '1', second!.integrationSha!)
    .split(' ');
  assert.equal(ctx.repo.git('show', `${parents[1]}:README.md`), 'moved', 'слияние на новой цели');
  assert.equal(parents[2], second!.candidateSha);

  const clash = thin({
    scenario: {
      // Цель меняет тот же файл на каждой сдаче: конфликт повторяется.
      writer: { ...rec(implement()), shell: moveTarget('src/greet.js', 'other-$$') },
      reviewer: approve(),
    },
  });
  await clash.run();
  const [requeued, a] = clash.attempts();
  assert.match(requeued!.error ?? '', /^MERGE_CONFLICT_REQUEUE/, 'первый — повтор без ведущего');
  assert.equal(a!.failureKind, 'needs-lead', a!.error);
  assert.equal(a!.leadCause, 'merge-conflict');
  assert.match(a!.error ?? '', /конфликт в src\/greet\.js/);
  assert.equal(clash.h().engine.read((v) => v.work(clash.work)!).attempt, 0, 'не засчитано');
});

test('гонка CAS: цель сдвинулась после ревью — проверка заново без writer, принята', async () => {
  const ctx = thin({
    scenario: {
      writer: rec(implement()),
      reviewer: [approve(), { ...approve(), shell: moveTarget('README.md', 'race') }, approve()],
    },
  });
  await ctx.run();
  const all = ctx.attempts();
  assert.equal(all.length, 1);
  const [a] = all;
  assert.equal(a!.status, 'succeeded', a!.error);
  assert.equal(ctx.calls('claude', 'writer'), 1, 'writer не вызывался повторно');
  const reviewed = new Set(
    a!.evidence.filter((e) => e.kind === 'review' && e.phase === 'integration').map((e) => e.sha),
  );
  assert.equal(reviewed.size, 2, 'ревью на двух слияниях');
  assert.equal(ctx.repo.git('show', `${a!.integrationSha}^1:README.md`), 'race');
});

test('переполнение контекста продолжения — новая сессия в той же попытке со сводкой сдачи', async () => {
  const ctx = thin({
    scenario: {
      writer: [
        rec(implement({ 'src/greet.js': wrong })),
        { contextExhausted: true },
        rec(implement()),
      ],
      reviewer: approve(),
    },
  });
  await ctx.run();
  const [first, second] = ctx.attempts();
  assert.equal(first!.failureKind, 'gate');
  assert.equal(second!.status, 'succeeded', second!.error);
  assert.equal(second!.writerSession?.mode, 'fallback');
  assert.match(second!.writerSession?.reason ?? '', /окна контекста/);
  assert.notEqual(second!.writerSession?.id, first!.writerSession?.id);
  assert.match(ctx.prompt(2), /Handover summary/);
  assert.match(ctx.prompt(2), /src\/greet\.js/, 'diff --stat сдачи в сводке');
  assert.equal(ctx.attempts().length, 2, 'в той же попытке');
});

test('рестарт controller: следующая сдача продолжает ту же сессию; потерянная — новая со сводкой', async () => {
  for (const lose of [false, true]) {
    const ctx = setup({
      scenario: {
        writer: [rec(implement({ 'src/greet.js': wrong })), rec(implement())],
        reviewer: approve(),
      },
      policy: (p) => {
        p.harnessMode = 'thin';
        p.maxAttempts = 3;
      },
      runner: {
        adapters: {
          claude: cliAdapter('claude', { executable: bin('fake-claude'), sessionContinue: true }),
          codex: cliAdapter('codex', { executable: bin('fake-codex'), sessionContinue: true }),
        },
      },
    });
    await runAll(ctx);
    const work = ctx.graph.orders[0]!.id;
    const [first] = ctx.engine.read((v) => v.attempts(work));
    assert.equal(first!.failureKind, 'gate');
    // Новый процесс controller: своё соединение с состоянием, свой Runner.
    ctx.runner.release();
    ctx.store.close();
    const store = new SqliteExecutionStore(join(ctx.state, 'state.sqlite'), 'test');
    const engine = new Engine({ host: standaloneHost(store, ctx.policy), policy: ctx.policy });
    if (lose)
      rmSync(join(dirname(first!.worktree!), '..', 'sessions', work), {
        recursive: true,
        force: true,
      });
    engine.retry(work, undefined, 'lead');
    const runner = new Runner({ ...ctx.runner.options, engine, owner: 'runner-2' });
    await runner.init();
    engine.resume();
    await runner.drain();
    const [, second] = engine.read((v) => v.attempts(work));
    assert.equal(second!.status, 'succeeded', second!.error);
    if (!lose) {
      assert.equal(second!.writerSession?.mode, 'resumed');
      assert.equal(second!.writerSession?.id, first!.writerSession?.id);
    } else {
      assert.equal(second!.writerSession?.mode, 'fallback');
      assert.match(second!.writerSession?.reason ?? '', /не продолжена/);
    }
    store.close();
  }
});

test('P11-1: исчерпан лимит провайдера (событие error codex) — provider-auth, а не неизвестный отказ; текст провайдера в причине', async () => {
  const ctx = thin({
    writer: 'codex',
    vendor: 'same-vendor-allowed',
    scenario: {
      writer: [
        {
          providerError:
            "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Dec 3rd, 2026 3:53 PM.",
        },
      ],
      reviewer: approve(),
    },
  });
  await ctx.run();
  const [a] = ctx.attempts();
  assert.equal(a!.failureKind, 'provider-auth', a!.error);
  assert.match(a!.error ?? '', /usage limit/);
});

test('P11-3: CLI ревьюера упал без ревью (таймаут провайдера) — отказ окружения, не дефект ревью исполнителя; следующая сдача принята', async () => {
  const ctx = thin({
    scenario: {
      writer: [rec(implement()), rec(implement())],
      // Первый вызов reviewer — ревью плана.
      reviewer: [
        approve(),
        {
          providerError:
            'codex_models_manager::manager: failed to refresh available models: request timed out',
        },
        approve(),
      ],
    },
  });
  await ctx.run();
  const [first, second] = ctx.attempts();
  assert.equal(first!.failureKind, 'environment', first!.error);
  assert.equal(second!.status, 'succeeded', second!.error);
});

test('P11-5: отчёты и артефакты gates, которые исполнитель гонял сам, не идут в кандидата и не нарушают область', async () => {
  const ctx = thin({
    maxAttempts: 1,
    policy: (p: any) => {
      p.repositories[0].gates[0].artifacts = ['playwright-report'];
    },
    scenario: {
      writer: rec(
        implement({
          'src/greet.js': greet,
          'test-results/junit.xml': '<testsuite/>\n',
          'playwright-report/data/trace.zip': 'zip\n',
        }),
      ),
      reviewer: approve(),
    },
  });
  await ctx.run();
  const [a] = ctx.attempts();
  assert.equal(a!.status, 'succeeded', a!.error);
  const files = ctx.repo.git('ls-tree', '-r', '--name-only', a!.integrationSha!).split('\n');
  assert.ok(files.includes('src/greet.js'));
  assert.ok(
    !files.some((f) => f.startsWith('test-results/') || f.startsWith('playwright-report/')),
  );
  const log = execFileSync('find', [ctx.state, '-name', 'gate-outputs.json'], { encoding: 'utf8' })
    .trim()
    .split('\n')[0]!;
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')).dropped, [
    'playwright-report/data/trace.zip',
    'test-results/junit.xml',
  ]);
});

test('P11-5: убранные выходы gates названы в продолжении writer и в заметке reviewer', async () => {
  const ctx = thin({
    scenario: {
      writer: [
        rec(
          implement({
            'src/greet.js': greet,
            'test-results/junit.xml': '<testsuite/>\n',
            'docs/notes.md': 'notes\n',
          }),
        ),
        rec({ ...implement({}), remove: ['docs/notes.md'] }),
      ],
      reviewer: rec(approve()),
    },
  });
  await ctx.run();
  const [first, second] = ctx.attempts();
  assert.equal(first!.failureKind, 'scope-violation', first!.error);
  assert.equal(second!.status, 'succeeded', second!.error);
  assert.match(
    ctx.prompt(1),
    /kept these new files out of your previous handover as outputs of gate runs .*: "test-results\/junit\.xml"\./,
  );
  assert.doesNotMatch(ctx.prompt(0), /outputs of gate runs/);
  // Ревью кода — последний вызов reviewer (первые — ревью плана).
  const reviews = readdirSync(dirname(ctx.scenarioPath))
    .filter((f) => /\.reviewer\.\d+\.prompt$/.test(f))
    .map((f) => readFileSync(join(dirname(ctx.scenarioPath), f), 'utf8'));
  assert.match(
    reviews.find((r) => r.includes('Base commit')) ?? reviews.join('\n'),
    /kept these new files out of the candidate as outputs of the writer's own gate runs, so they are not in the diff: "test-results\/junit\.xml"\./,
  );
});

test('R1: отказ только областью — продолжение называет пути и не требует гонять gates заново', async () => {
  const ctx = thin({
    scenario: {
      writer: [
        rec(implement({ 'src/greet.js': greet, 'docs/notes.md': 'notes\n' })),
        rec({ ...implement({}), remove: ['docs/notes.md'] }),
      ],
      reviewer: approve(),
    },
  });
  await ctx.run();
  const [first, second] = ctx.attempts();
  assert.equal(first!.failureKind, 'scope-violation', first!.error);
  assert.equal(second!.status, 'succeeded', second!.error);
  assert.equal(second!.writerSession?.mode, 'resumed');
  const resume = ctx.prompt(1);
  assert.match(
    resume,
    /rejected only because it changes files outside the work order's write scope/,
  );
  assert.match(resume, /Drop exactly these paths from your work: docs\/notes\.md\./);
  assert.match(resume, /git checkout [0-9a-f]{40} -- <path>/);
  assert.match(resume, /You do not need to rerun the gates for this/);
  assert.doesNotMatch(resume, /rerun your gates in this worktree until they pass/);
  assert.throws(() => ctx.repo.git('show', `${second!.integrationSha}:docs/notes.md`));
});
