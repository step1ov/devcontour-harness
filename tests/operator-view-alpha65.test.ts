/**
 * 0.1.0-alpha.65, ревизия 5 представления оператора: прогноз по всему выпуску
 * (все снимки связки, а не последний срез `run`), готовность работы не падает
 * на повторе, грубая оценка времени при 1–4 попытках, задачи, добавленные по
 * ходу; работы, ждущие проверки человека в источнике; этап настройки до
 * `init` и одно определение «попытки» в строках.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  API_VERSION,
  cliDataSchemas,
  operatorViewSchema,
  setupViewSchema,
} from '../src/contracts/index.ts';
import { connectorSources, harnessView } from '../src/control/operator-view.ts';
import { attemptLine, operatorView } from '../src/projections/index.ts';
import { NOW, at, attempt, baseInput, work } from './operator-view-input.ts';
import { viewState } from './view-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harness = (...args: string[]) => {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', cli, ...args],
    { encoding: 'utf8' },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** База коннектора по схеме 1: снимки по срезам прогона, наблюдение, доставки. */
function connectorDb(
  state: string,
  options: {
    snapshots: {
      at: string;
      tasks: { id: string; key: string; orderId: string; column?: string }[];
      problems?: { taskId: string; code: string; message: string }[];
    }[];
    observation?: { at: string; tasks: { id: string; key: string; orderId: string }[] };
    operations?: {
      task: string;
      work: string;
      outcome: 'accepted' | 'rejected';
      column?: string;
      at: string;
    }[];
  },
) {
  mkdirSync(join(state, 'connectors'), { recursive: true });
  const db = new DatabaseSync(join(state, 'connectors', 'relay-v1-http-0123456789abcdef.sqlite'));
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE snapshots (revision TEXT PRIMARY KEY, graph_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE operations (key TEXT PRIMARY KEY, work_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE observations (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  for (const [k, v] of <[string, string][]>[
    ['schema', '1'],
    ['provider', 'relay-v1-http'],
    ['projectId', 'P1'],
  ])
    db.prepare('INSERT INTO meta VALUES (?, ?)').run(k, v);
  options.snapshots.forEach((s, n) =>
    db.prepare('INSERT INTO snapshots VALUES (?, ?, ?, ?)').run(
      `rev-${n}`,
      'g1',
      JSON.stringify({
        manifest: {
          connector: 'relay-v1-http-0123',
          readAt: s.at,
          tasks: s.tasks,
          problems: s.problems ?? [],
        },
      }),
      s.at,
    ),
  );
  if (options.observation)
    db.prepare('INSERT INTO observations VALUES (?, ?, ?)').run(
      'relay',
      JSON.stringify({
        at: options.observation.at,
        connector: 'relay-v1-http-0123',
        scope: { readAt: options.observation.at, tasks: options.observation.tasks, problems: [] },
      }),
      options.observation.at,
    );
  (options.operations ?? []).forEach((o, n) =>
    db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      `op-${n}`,
      o.work,
      `run-${n}`,
      o.task,
      'delivered',
      JSON.stringify({
        outcome: o.outcome,
        steps: [
          { n: 1, kind: 'comment', status: 'done' },
          ...(o.column
            ? [{ n: 2, kind: 'move', status: 'done', input: { column: o.column }, updatedAt: o.at }]
            : []),
        ],
      }),
      o.at,
    ),
  );
  db.close();
}

const tasks = {
  a: { id: 'T-A', key: 'WEB-1', orderId: 'wa' },
  b: { id: 'T-B', key: 'WEB-2', orderId: 'wb' },
  c: { id: 'T-C', key: 'WEB-3', orderId: 'wc' },
};

/** Выпуск из двух срезов: WEB-1 и WEB-2 в первом, WEB-3 добавлена позже; последний срез — только WEB-3. */
function releaseState() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-a65-'));
  const state = join(dir, 'state');
  connectorDb(state, {
    snapshots: [
      { at: at(120), tasks: [tasks.a, tasks.b] },
      {
        at: at(60),
        tasks: [{ ...tasks.a, column: 'review' }, { ...tasks.b, column: 'done' }, tasks.c],
      },
      { at: at(55), tasks: [tasks.c] },
    ],
    observation: { at: at(50), tasks: [tasks.c] },
    operations: [
      { task: 'T-A', work: 'wa', outcome: 'rejected', at: at(100) },
      { task: 'T-A', work: 'wa', outcome: 'accepted', column: 'review', at: at(70) },
      // Владелец уже закрыл WEB-2 в источнике (колонка done по более позднему снимку).
      { task: 'T-B', work: 'wb', outcome: 'accepted', column: 'review', at: at(65) },
    ],
  });
  return { dir, state, sources: connectorSources(state, new Set(['wa', 'wb', 'wc'])) };
}

const done = (id: string) =>
  work(id, {
    status: 'done',
    stage: { ...work(id).stage, name: 'done', next: [] },
    attemptSummary: {
      ...work(id).attemptSummary,
      attempts: { used: 2, max: 3, left: 1 },
      failed: 1,
    },
  });

test('alpha.65: связка отдаёт весь выпуск (все снимки) и задачи, ждущие проверки человека', () => {
  const r = releaseState();
  try {
    const src = r.sources[0]!;
    // Последний срез — одна задача, выпуск — три, с первым снимком каждой.
    assert.deepEqual(
      src.tasks.map((t) => t.key),
      ['WEB-3'],
    );
    assert.deepEqual(
      src.release!.map((t) => [t.key, t.firstSeenAt]),
      [
        ['WEB-1', at(120)],
        ['WEB-2', at(120)],
        ['WEB-3', at(60)],
      ],
    );
    assert.equal(src.releaseStartedAt, at(120));
    // WEB-1 оставлена на проверку (последняя доставка принята, колонка review);
    // WEB-2 владелец уже закрыл — не ждёт.
    assert.deepEqual(src.reviews, [
      { taskId: 'T-A', key: 'WEB-1', workId: 'wa', column: 'review', since: at(70) },
    ]);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('alpha.65: прогноз — объём всего выпуска, «прошло» от первого запуска, добавленная задача, грубое время', () => {
  const r = releaseState();
  try {
    const running = work('wc', {
      status: 'running',
      stage: { ...work('wc').stage, name: 'writer', next: ['gates', 'review', 'integration'] },
      attemptSummary: {
        ...work('wc').attemptSummary,
        attempts: { used: 2, max: 3, left: 1 },
        failed: 1,
        lastFailure: { runId: 'wc-run-1', bucket: 'defect', plain: 'дефект' },
      },
    });
    const input = baseInput({
      works: [done('wa'), done('wb'), running],
      attempts: [
        attempt('wa', 1, { startedAt: at(110), finishedAt: at(90), status: 'failed' }),
        attempt('wa', 2, { startedAt: at(80), finishedAt: at(70) }),
        // Первая попытка WEB-3 дошла до ревью и отказала; вторая пишет код.
        attempt('wc', 1, {
          startedAt: at(50),
          finishedAt: at(40),
          status: 'failed',
          reached: 'review',
        }),
        attempt('wc', 2, { startedAt: at(30), status: 'active', finishedAt: undefined }),
      ],
      sources: r.sources,
    });
    const view = operatorView(input);
    operatorViewSchema.parse(view);
    const f = view.forecast!;
    // Весь выпуск — 3 задачи, а не одна задача последнего среза.
    assert.equal(f.progress.total, 3);
    assert.equal(f.progress.done, 2);
    // WEB-3 — 60 % (ревью первой попытки), а не 20 % этапа идущего повтора.
    assert.equal(f.progress.weighted, 2.6);
    assert.equal(f.progress.percent, 87);
    assert.deepEqual(f.progress.added, [
      {
        key: 'WEB-3',
        workId: 'wc',
        at: at(60),
        before: 2,
        after: 3,
        line: 'добавлена задача WEB-3 (задач 2 → 3)',
      },
    ]);
    assert.deepEqual(f.progress.works, [
      {
        workId: 'wc',
        key: 'WEB-3',
        percent: 60,
        attempt: { n: 2, max: 3 },
        retry: 'repair',
        line: 'WEB-3: ~60 %, попытка 2 из 3, исправляет замечания',
      },
    ]);
    // «Прошло» — от первого снимка выпуска (первый `run`), не от среза WEB-3.
    assert.equal(f.time.startedAt, at(120));
    assert.equal(f.time.elapsedMs, 120 * 60_000);
    // Три закончившиеся попытки — грубый разброс, а не «неизвестно».
    assert.equal(f.time.estimate, 'rough');
    assert.equal(f.time.remaining, undefined);
    assert.equal(f.time.rough?.samples, 3);
    assert.match(f.time.line, /^прошло 2 ч · осталось ~[^(]+\(грубо, по 3 попыткам\)$/);
    const en = operatorView(input, { lang: 'en' }).forecast!;
    assert.match(en.time.line, /\(rough, from 3 attempts\)$/);
    assert.equal(en.progress.added![0]!.line, 'task WEB-3 added (tasks 2 → 3)');

    // Повтор не роняет готовность: между попытками WEB-3 по-прежнему 60 %.
    const between = operatorView({
      ...input,
      works: [
        done('wa'),
        done('wb'),
        { ...running, status: 'ready', stage: { ...running.stage, name: 'queued' } },
      ],
      attempts: input.attempts.filter((a) => a.status !== 'active'),
    }).forecast!;
    assert.equal(between.progress.weighted, 2.6);
    assert.equal(
      between.progress.works![0]!.line,
      'WEB-3: ~60 %, между попытками (использовано 2 из 3)',
    );

    // Всё принято: «прошло» — до конца последней попытки, а не до «сейчас».
    const finished = operatorView({
      ...input,
      now: NOW + 3_600_000,
      works: [done('wa'), done('wb'), done('wc')],
      attempts: [
        ...input.attempts.filter((a) => a.status !== 'active'),
        attempt('wc', 2, { startedAt: at(30), finishedAt: at(10) }),
      ],
    }).forecast!;
    assert.equal(finished.progress.percent, 100);
    assert.equal(finished.progress.total, 3);
    assert.equal(finished.time.finishedAt, at(10));
    assert.equal(finished.time.elapsedMs, 110 * 60_000);
    assert.equal(finished.time.estimate, 'nothing');
    assert.equal(finished.time.line, 'прошло 1 ч 50 мин · осталось: ничего');
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('alpha.65: принятые, но не проверенные человеком в источнике — дело оператора', () => {
  const r = releaseState();
  try {
    const view = operatorView(baseInput({ works: [done('wa'), done('wb')], sources: r.sources }));
    operatorViewSchema.parse(view);
    assert.deepEqual(view.sourceReviews, [
      {
        connector: r.sources[0]!.connector,
        provider: 'relay-v1-http',
        tasks: [{ taskId: 'T-A', key: 'WEB-1', workId: 'wa', column: 'review', since: at(70) }],
        line: 'ждут вашей проверки в Relay: WEB-1',
      },
    ]);
    assert.deepEqual(
      view.escalations.filter((e) => e.code === 'SOURCE_REVIEW'),
      [
        {
          workId: 'wa',
          subject: 'WEB-1',
          code: 'SOURCE_REVIEW',
          actor: 'operator',
          action: 'review-in-source',
          since: at(70),
        },
      ],
    );
    assert.equal(
      operatorView(baseInput({ works: [done('wa')], sources: r.sources }), { lang: 'en' })
        .sourceReviews![0]!.line,
      'waiting for your review in Relay: WEB-1',
    );
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('alpha.65: одно определение попытки — запуски и засчитанные названы оба', () => {
  // Попытка 1 — дефект (засчитана), 2 — вопрос исполнителя (не засчитана), 3 — идёт.
  const facts = {
    total: 3,
    active: 1,
    failed: 2,
    failures: [
      { key: 'defect', count: 1 },
      { key: 'input', count: 1 },
    ],
    timeouts: 0,
    interrupted: 0,
    accepted: 0,
    attempts: { used: 2, max: 3 },
  };
  assert.equal(
    attemptLine(facts, 'ru'),
    'запусков 3 (идёт 1), из них засчитано попыток 2; отказов 2 (defect 1, input 1); по времени 0; прервано остановкой 0; принято 0; осталось попыток 1 из 3',
  );
  assert.match(attemptLine(facts, 'en'), /^runs 3 \(1 running\), counted attempts 2; /);
  // Все запуски засчитаны — прежняя короткая форма.
  assert.match(attemptLine({ ...facts, total: 2, active: 0 }, 'ru'), /^попыток 2; /);
  const view = operatorView(
    baseInput({
      works: [
        work('w', {
          attemptSummary: {
            ...work('w').attemptSummary,
            attempts: { used: 2, max: 3, left: 1 },
            line: attemptLine(facts, 'ru'),
            lineEn: attemptLine(facts, 'en'),
            lineFacts: facts,
          },
        }),
      ],
    }),
  );
  assert.equal(view.works[0]!.attempts.used, 2);
  assert.equal(view.works[0]!.attempts.runs, 3);
});

test('alpha.65: до настройки view и status — этап setup, а не NOT_FOUND; --repository подхватывает manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-a65-setup-'));
  try {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    // Нет `.harness/project.json` — проект ещё не настроен.
    const early = setupViewSchema.parse(harnessView({ repository: repo }));
    assert.equal(early.setup.waitingFor, 'project');
    assert.deepEqual(early.stage.lines, ['Идёт настройка harness', 'Задач пока нет']);
    const cliView = harness('view', '--repository', repo);
    assert.equal(cliView.status, 0, cliView.stderr);
    setupViewSchema.parse((JSON.parse(cliView.stdout) as { data: unknown }).data);
    const status = harness('status', '--repository', repo);
    assert.equal(status.status, 0, status.stderr);
    const data = cliDataSchemas.status.parse((JSON.parse(status.stdout) as { data: unknown }).data);
    assert.equal(data.setup?.waitingFor, 'project');
    assert.deepEqual(data.works, []);
    const human = harness('status', '--state', join(dir, 'no-state'), '--human');
    assert.equal(human.status, 0, human.stderr);
    assert.equal(human.stdout, 'Идёт настройка harness\nЗадач пока нет\n');

    // Manifest и политика появились — тот же вызов отдаёт обзор, без перезапуска панели.
    const s = viewState();
    mkdirSync(join(repo, '.harness'));
    copyFileSync(s.policyPath, join(repo, '.harness', 'policy.json'));
    writeFileSync(
      join(repo, '.harness', 'project.json'),
      JSON.stringify({
        apiVersion: API_VERSION,
        kind: 'harness-project',
        manifestVersion: 1,
        projectId: 'p-0123456789abcdef',
        root: repo,
        repository: { id: 'app', targetRef: 'refs/heads/main' },
        profile: {
          ref: 'node-npm',
          pin: { id: 'node-npm', version: '1.0.0', digest: 'a'.repeat(64) },
        },
        runtimes: { writer: 'codex', reviewer: 'claude' },
        paths: {
          policy: '.harness/policy.json',
          work: '.harness/work',
          notes: '.harness/work/context/notes',
          state: s.state,
        },
      }),
    );
    const later = operatorViewSchema.parse(harnessView({ repository: repo }));
    assert.equal(later.stage?.name, 'work');
    assert.ok(later.works.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('alpha.65: состояние без работ — этап setup в обзоре', () => {
  const view = operatorView(baseInput());
  assert.deepEqual(view.stage, {
    name: 'setup',
    lines: ['Идёт настройка harness', 'Задач пока нет'],
  });
  assert.deepEqual(operatorView(baseInput({ works: [work('w')] })).stage, {
    name: 'work',
    lines: [],
  });
});
