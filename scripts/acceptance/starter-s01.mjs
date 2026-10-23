#!/usr/bin/env node
/**
 * S01 (backend → SDK → frontend), S02 (генерация и область записи), S05
 * (controller mode) на воспроизводимой копии Turbo Starter через обычный CLI
 * harness: validate → review-plan → approve → run → result. Writer и reviewer —
 * fixture runtime (tests/fixtures/bin), вызываются отдельно; приёмку решают
 * реальные pnpm/tsc/генератор/node --test (JUnit) и Git.
 *
 *   node scripts/acceptance/starter-s01.mjs --evidence <dir> --logs <dir> \
 *     [--work <dir>] [--source <url|path>] [--only S01-positive,S02-stale,...]
 *
 * Evidence: <evidence>/S01, S02, S05 (summary.json и материалы вариантов).
 * Код выхода: 0 PASS, 1 FAIL, 3 BLOCKED (нет внешней предпосылки).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  approve,
  changeFiles,
  controllerContext,
  git,
  implement,
  prepareStarterFixture,
  starterGraph,
  starterPolicy,
} from './starter-fixture.mjs';
import {
  Blocked,
  finish,
  harness,
  junitCases,
  readTrace,
  recorder,
  traceShims,
  walk,
} from './starter-lib.mjs';

const { values } = parseArgs({
  options: {
    work: { type: 'string' },
    source: { type: 'string' },
    evidence: { type: 'string' },
    logs: { type: 'string' },
    only: { type: 'string' },
  },
});
// Канонический путь: Git сообщает worktree через realpath (/private/var… на macOS).
const W = (() => {
  const dir = resolve(values.work ?? mkdtempSync(join(tmpdir(), 'starter-s01-')));
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
})();
const evidenceRoot = resolve(values.evidence ?? join(W, 'evidence'));
const logsRoot = resolve(values.logs ?? join(W, 'logs'));
const rec = {
  S01: recorder(join(evidenceRoot, 'S01'), join(logsRoot, 'S01')),
  S02: recorder(join(evidenceRoot, 'S02'), join(logsRoot, 'S02')),
  S05: recorder(join(evidenceRoot, 'S05'), join(logsRoot, 'S05')),
};
const only = values.only ? new Set(values.only.split(',')) : undefined;
const wanted = (label) => !only || only.has(label);

const WORK = 'issued-at';
const GENERATED = [
  'apps/nest-backend/openapi',
  'packages/client-rest-api-sdk/src/generated',
  'packages/admin-rest-api-sdk/src/generated',
];
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const within = (path, prefixes) =>
  prefixes.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : p + '/'));

let fixture, shims, trace;
const errors = {};

/** Снимок основного checkout: HEAD, ветка, refs кроме harness/*, статус, worktrees. */
function mainCheckout() {
  return {
    head: git(fixture.repo, ['rev-parse', 'HEAD']),
    branch: git(fixture.repo, ['symbolic-ref', 'HEAD']),
    status: git(fixture.repo, ['status', '--porcelain']),
    main: git(fixture.repo, ['rev-parse', 'refs/heads/main']),
    worktrees: git(fixture.repo, ['worktree', 'list', '--porcelain']),
  };
}
/** Каталог реестра worktree самого starter (`~/worktrees/.state`): только чтение. */
function starterRegistry() {
  const dir = join(homedir(), 'worktrees', '.state');
  if (!existsSync(dir)) return { exists: false };
  const files = walk(dir).sort();
  return {
    exists: true,
    files: files.length,
    digest: sha256(files.map((f) => f + ':' + sha256(readFileSync(f))).join('\n')),
  };
}

/**
 * Один вариант: отдельный каталог (policy, graph, context, scenario, state),
 * собственный target ref от baseline. Возвращает ответы CLI и состояние Git.
 */
function variant(label, r, { files, writer = {}, mode = 'agent', edit }) {
  const dir = join(W, 'runs', label);
  mkdirSync(dir, { recursive: true });
  const targetRef = `refs/heads/harness/${label.toLowerCase()}`;
  const scenario = join(dir, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      writer: { ...implement(files), recordPrompt: true, ...writer },
      reviewer: { ...approve(), recordPrompt: true },
    }),
  );
  const policy = starterPolicy(fixture, {
    scenario,
    targetRef,
    edit: (p) => {
      p.approvalMode = mode;
      edit?.(p);
    },
  });
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy, null, 2));
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(starterGraph(), null, 2));
  cpSync(join(W, 'context'), join(dir, 'context'), { recursive: true });
  git(fixture.repo, ['update-ref', targetRef, fixture.baselineSha]);
  const env = { PATH: [shims, ...fixture.pathPrepend, process.env.PATH].join(':') };
  const state = join(dir, 'state');
  const cli = (name, args) => harness(r, `${label}.${name}`, args, { cwd: dir, env });
  const targetBefore = git(fixture.repo, ['rev-parse', targetRef]);
  const validate = cli('validate', [
    'validate',
    '--graph',
    'graph.json',
    '--policy',
    'policy.json',
  ]);
  r.check(`${label}: validate`, validate.status === 0, validate.stderr);
  const steps = { validate: validate.json?.data };
  if (mode === 'operator') {
    const review = cli('review-plan', [
      'review-plan',
      '--graph',
      'graph.json',
      '--policy',
      'policy.json',
      '--state',
      state,
      '--author',
      'external',
    ]);
    r.check(`${label}: review-plan одобрен`, review.status === 0, review.stderr);
    steps.reviewPlan = review.json?.data;
    const approved = cli('approve', [
      'approve',
      '--state',
      state,
      '--subject',
      review.json.data.subject ?? starterGraph().id,
      '--digest',
      review.json.data.digest,
    ]);
    r.check(`${label}: approve`, approved.status === 0, approved.stderr);
    steps.approve = approved.json?.data;
  }
  const runArgs = [
    'run',
    '--graph',
    'graph.json',
    '--policy',
    'policy.json',
    '--state',
    state,
    '--author',
    'external',
    '--sink',
    'file:' + join(dir, 'results'),
  ];
  let run = cli('run', runArgs);
  // Preflight отказывает до записи состояния; ограниченная по времени проба версии
  // под нагрузкой общей машины может не успеть (TOOL_VERSION_UNKNOWN) — повтор
  // явный и записывается, другие отказы preflight не повторяются.
  for (
    let retry = 1;
    retry <= 2 &&
    run.json?.error?.issues?.length > 0 &&
    run.json.error.issues.every((i) => /TOOL_VERSION_UNKNOWN/.test(i.message));
    retry++
  ) {
    r.json(`${label}/preflight-retry-${retry}.json`, run.json.error);
    run = cli(`run-retry-${retry}`, runArgs);
  }
  r.check(
    `${label}: run исполнен (ответ ok, не отказ preflight/согласования)`,
    run.json?.ok === true,
    run.json?.error ?? run.stderr,
  );
  const result = cli('result', ['result', '--state', state, '--work', WORK]);
  const status = cli('status', ['status', '--state', state]);
  const targetAfter = git(fixture.repo, ['rev-parse', targetRef]);
  const work = run.json?.data?.works?.find((w) => w.id === WORK);
  const runId = result.json?.data?.result?.runId ?? work?.runId;
  const branch = runId ? `refs/heads/harness/run-${runId}` : undefined;
  const candidate =
    branch && git(fixture.repo, ['for-each-ref', '--format=%(objectname)', branch]) ? branch : '';
  const diffNames = candidate
    ? git(fixture.repo, ['diff', '--name-only', fixture.baselineSha, candidate])
        .split('\n')
        .filter(Boolean)
    : [];
  const out = {
    label,
    targetRef,
    targetBefore,
    targetAfter,
    runExit: run.status,
    work,
    runId,
    candidateSha: candidate ? git(fixture.repo, ['rev-parse', candidate]) : null,
    candidateDiff: diffNames,
    result: result.json?.data,
    status: status.json?.data,
    steps,
    dir,
    state,
    artifacts: runId ? join(state, 'artifacts', runId) : undefined,
    scenario,
  };
  r.json(`${label}/outcome.json`, { ...out, result: undefined, status: undefined });
  r.json(`${label}/result.json`, result.json ?? { stderr: result.stderr });
  r.json(`${label}/policy.json`, policy);
  if (candidate)
    r.text(
      `${label}/candidate.diff`,
      git(fixture.repo, ['diff', '--stat', fixture.baselineSha, candidate]) +
        '\n\n' +
        git(fixture.repo, ['diff', fixture.baselineSha, candidate]),
    );
  return out;
}

/** Evidence попытки: [{phase, gate, passed, summary}] из ответа `result`. */
const evidenceOf = (o) =>
  (o.result?.result?.evidence ?? o.result?.attempts?.at?.(-1)?.evidence ?? []).map((e) => ({
    phase: e.phase,
    gate: e.gate,
    passed: e.passed,
    summary: e.summary,
    sha: e.sha,
  }));
/** Причина отказа работы: `stopReason` результата и статус работы. */
const failureOf = (o) => ({
  status: o.status?.works?.find((x) => x.id === WORK)?.status,
  outcome: o.result?.result?.outcome ?? null,
  kind: o.result?.result?.stopReason?.code ?? null,
  failure: o.result?.result?.stopReason?.message ?? null,
});

const PROMPT_COMMIT_MUST =
  /(you must|must|should|have to|need to|обязан\w*|должен\w*)\s+(commit|коммит)|субагент\s+коммитит|commit (your|the) changes/i;
const PROMPT_COMMIT_FORBID = /do not commit/i;

async function main() {
  fixture = prepareStarterFixture({
    workDir: W,
    ...(values.source ? { source: values.source } : {}),
    log: (l) => rec.S01.log(l),
  });
  rec.S01.json('fixture.json', fixture.manifest);
  rec.S01.copy(join(W, 'fixture.json'), 'fixture-manifest.json');
  // Применённая настройка: отдельный baseline-коммит поверх upstream.
  rec.S01.text(
    'baseline-setup.txt',
    git(fixture.repo, ['log', '--format=%H %P%n%s', '-1', fixture.baselineSha]) +
      '\n\n' +
      git(fixture.repo, ['show', '--stat', '--format=', fixture.baselineSha]),
  );
  const context = controllerContext(fixture, join(W, 'context'));
  rec.S05.json('controller-context-provenance.json', context.provenance);
  trace = join(W, 'trace.tsv');
  shims = traceShims(
    join(W, 'shims'),
    trace,
    ['git', 'pnpm', 'harness'],
    [...fixture.pathPrepend, process.env.PATH].join(':'),
  );
  const mainBefore = mainCheckout();
  const registryBefore = starterRegistry();
  const positive = changeFiles(fixture, 'issued-at.patch');
  rec.S01.json('writer-change-files.json', Object.keys(positive));

  // ---------------- S01 positive + S05 (operator approval, controller mode) ----------------
  let pos;
  if (wanted('S01-positive')) {
    try {
      const r = rec.S01;
      pos = variant('S01-positive', r, { files: positive, mode: 'operator' });
      r.check('S01-positive: run exit 0', pos.runExit === 0, pos.work);
      r.check('S01-positive: работа done', pos.work?.status === 'done', pos.work);
      r.check(
        'S01-positive: target ref = result SHA',
        pos.targetAfter === pos.work.resultSha && pos.targetAfter !== pos.targetBefore,
        pos,
      );
      r.check(
        'S01-positive: result outcome accepted',
        pos.result?.result?.outcome === 'accepted',
        pos.result?.result?.outcome,
      );
      const integrated = git(fixture.repo, [
        'diff',
        '--name-only',
        fixture.baselineSha,
        pos.targetAfter,
      ])
        .split('\n')
        .filter(Boolean)
        .sort();
      r.check(
        'S01-positive: принятый diff = backend + OpenAPI + SDK + frontend',
        JSON.stringify(integrated) === JSON.stringify(Object.keys(positive).sort()),
        integrated,
      );
      r.text(
        'S01-positive/accepted.diff',
        git(fixture.repo, ['diff', fixture.baselineSha, pos.targetAfter]),
      );
      const ev = evidenceOf(pos);
      r.json('S01-positive/evidence.json', ev);
      for (const phase of ['candidate', 'integration'])
        for (const gate of [
          'backend-types',
          'sdk-generation',
          'sdk-build',
          'web-types',
          'acceptance',
          'independent-review',
        ])
          r.check(
            `S01-positive: ${phase}/${gate} passed`,
            ev.some((e) => e.phase === phase && e.gate === gate && e.passed),
            ev,
          );
      const junit = {};
      for (const phase of ['candidate', 'integration'])
        for (const gate of ['acceptance', 'sdk-generation']) {
          const file = join(pos.artifacts, phase, gate + '.xml');
          r.check(`S01-positive: JUnit ${phase}/${gate} сохранён`, existsSync(file), file);
          const cases = junitCases(readFileSync(file, 'utf8'));
          junit[`${phase}/${gate}`] = cases;
          r.copy(file, `S01-positive/junit/${phase}-${gate}.xml`);
          r.check(
            `S01-positive: JUnit ${phase}/${gate} все testcases passed`,
            cases.length >= (gate === 'acceptance' ? 5 : 4) &&
              cases.every((c) => c.outcome === 'passed'),
            cases,
          );
        }
      r.json('S01-positive/junit-cases.json', junit);
      r.json('S01-positive/shas.json', {
        upstream: fixture.upstream,
        baseline: fixture.baselineSha,
        candidate: pos.candidateSha,
        integration: pos.targetAfter,
        targetRef: pos.targetRef,
        reviewer: pos.result?.result?.evidence
          ?.filter((e) => e.gate === 'independent-review')
          .map((e) => ({ phase: e.phase, sha: e.sha, reviewer: e.reviewer, summary: e.summary })),
      });
      // S02/allowed: тот же прогон — разрешённые выходы генерации и детерминизм.
      rec.S02.json('S02-allowed/outcome.json', {
        source: 'S01-positive',
        writeScope: starterGraph().orders[0].writeScope,
        generatedPaths: pos.result?.result
          ? starterPolicy(fixture).repositories[0].generatedPaths
          : null,
        diff: integrated,
        generationEvidence: ev.filter((e) => e.gate === 'sdk-generation'),
        junit: {
          candidate: junit['candidate/sdk-generation'],
          integration: junit['integration/sdk-generation'],
        },
      });
      rec.S02.check(
        'S02-allowed: принят; генерация на integration SHA не меняет outputs',
        pos.work?.status === 'done' &&
          ev.some((e) => e.phase === 'integration' && e.gate === 'sdk-generation' && e.passed),
        ev,
      );
    } catch (error) {
      errors.S01 = error;
    }
  }

  // ---------------- S05: контекст writer/reviewer, трасса, основной checkout ----------------
  if (pos) {
    const r = rec.S05;
    try {
      const writerPrompt = readFileSync(`${pos.scenario}.writer.0.prompt`, 'utf8');
      const reviewerPrompts = walk(join(pos.dir))
        .filter((f) => /scenario\.json\.reviewer\.\d+\.prompt$/.test(f))
        .sort();
      r.text('writer-prompt.txt', writerPrompt);
      reviewerPrompts.forEach((f, i) => r.copy(f, `reviewer-prompt-${i}.txt`));
      r.check(
        'S05: writer видит оверлей controller-mode v1',
        writerPrompt.includes('# Controller mode (devcontour-harness overlay v1)'),
        'overlay',
      );
      r.check(
        'S05: writer получает запрет commit от controller',
        PROMPT_COMMIT_FORBID.test(writerPrompt),
        'do not commit',
      );
      const must = writerPrompt.match(PROMPT_COMMIT_MUST);
      r.check(
        'S05: в запросе writer нет одновременно «обязан commit» и «не commit»',
        !must,
        must?.[0],
      );
      r.check(
        'S05: product AGENTS.md закреплены справками с provenance (не вложены)',
        /References \(not inlined\): references\/AGENTS\.md/.test(writerPrompt) &&
          writerPrompt.includes('"baselineSha": "' + fixture.baselineSha + '"'),
        'references',
      );
      r.check(
        'S05: reviewer видит тот же оверлей',
        reviewerPrompts.length > 0 &&
          reviewerPrompts.every((f) =>
            readFileSync(f, 'utf8').includes('# Controller mode (devcontour-harness overlay v1)'),
          ),
        reviewerPrompts,
      );
      const pinned = JSON.parse(
        readFileSync(join(pos.artifacts, 'implementation', 'context.json'), 'utf8'),
      );
      r.json(
        'pinned-context.json',
        pinned.sources.map((s) => ({
          id: s.id,
          digest: s.digest,
          files: s.files.map((f) => ({ path: f.path, digest: f.digest })),
          references: s.references.map((f) => ({ path: f.path, digest: f.digest })),
        })),
      );
      // Трасса управляющих команд одной попытки.
      const commands = readTrace(trace);
      r.json('controller-trace.json', commands);
      const harnessCalls = commands.filter((c) => c.tool === 'harness');
      r.check('S05: нет рекурсивного harness', harnessCalls.length === 0, harnessCalls);
      const worktreeCmds = commands.filter(
        (c) => c.tool === 'pnpm' && c.argv.some((a) => /^worktree:|^setup$/.test(a)),
      );
      r.check('S05: нет pnpm worktree:* и setup', worktreeCmds.length === 0, worktreeCmds);
      const adds = commands.filter(
        (c) => c.tool === 'git' && c.argv[0] === 'worktree' && c.argv[1] === 'add',
      );
      r.check(
        'S05: git worktree add только harness, в его state',
        adds.length >= 2 && adds.every((c) => c.argv.some((a) => a.startsWith(pos.state + '/'))),
        adds,
      );
      const commits = commands.filter((c) => c.tool === 'git' && c.argv.includes('commit'));
      const merges = commands.filter((c) => c.tool === 'git' && c.argv.includes('merge'));
      const updates = commands.filter((c) => c.tool === 'git' && c.argv.includes('update-ref'));
      r.json('controller-git-commands.json', { adds, commits, merges, updates });
      r.check(
        'S05: commit и merge выполнены controller в рабочих деревьях harness',
        commits.length === 1 &&
          merges.length === 1 &&
          [...commits, ...merges].every((c) => c.cwd.startsWith(pos.state + '/worktrees/')),
        { commits, merges },
      );
      const mainAfter = mainCheckout();
      r.json('main-checkout.json', { before: mainBefore, after: mainAfter });
      r.check(
        'S05: основной checkout не переписан',
        JSON.stringify(mainAfter) === JSON.stringify(mainBefore),
        { before: mainBefore, after: mainAfter },
      );
      const registryAfter = starterRegistry();
      r.json('starter-registry.json', { before: registryBefore, after: registryAfter });
      r.check(
        'S05: реестр worktree starter не тронут',
        JSON.stringify(registryAfter) === JSON.stringify(registryBefore),
        registryAfter,
      );
      r.check(
        'S05: product AGENTS.md в принятом результате не изменены',
        !git(fixture.repo, [
          'diff',
          '--name-only',
          fixture.baselineSha,
          pos.targetAfter,
          '--',
          'AGENTS.md',
          '**/AGENTS.md',
        ]),
        'AGENTS.md',
      );
    } catch (error) {
      errors.S05 = error;
    }
  } else if (wanted('S01-positive')) errors.S05 = new Error('S01-positive не выполнен');

  if (wanted('S05-worker-commit')) {
    // Worker, нарушивший правило и сделавший commit, отклоняется controller-ом.
    const r = rec.S05;
    try {
      const o = variant('S05-worker-commit', r, { files: positive, writer: { commit: true } });
      const f = failureOf(o);
      r.json('S05-worker-commit/failure.json', f);
      r.check(
        'S05-worker-commit: commit worker-а отклонён (scope-violation), target не сдвинут',
        o.work?.status === 'failed' &&
          /изменил HEAD/.test(f.failure ?? '') &&
          o.targetAfter === o.targetBefore,
        f,
      );
    } catch (error) {
      errors.S05 ??= error;
    }
  }

  // ---------------- S01 negative: потребитель без backend/SDK ----------------
  if (wanted('S01-negative')) {
    const r = rec.S01;
    try {
      const o = variant('S01-negative', r, {
        files: changeFiles(fixture, 'issued-at-consumer-only.patch'),
      });
      const ev = evidenceOf(o);
      const f = failureOf(o);
      r.json('S01-negative/evidence.json', ev);
      r.json('S01-negative/failure.json', f);
      r.check('S01-negative: работа failed', o.work?.status === 'failed', o.work);
      r.check('S01-negative: target ref не сдвинут', o.targetAfter === o.targetBefore, o);
      r.check(
        'S01-negative: контроль — backend-types и sdk-generation прошли',
        ['backend-types', 'sdk-generation', 'sdk-build'].every((g) =>
          ev.some((e) => e.gate === g && e.passed),
        ),
        ev,
      );
      const web = ev.find((e) => e.gate === 'web-types' && !e.passed);
      const log = join(o.artifacts, 'candidate', 'web-types.log');
      const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
      if (text) r.copy(log, 'S01-negative/web-types.log');
      const line = text.split('\n').find((l) => /error TS2339/.test(l));
      r.json('S01-negative/compiler-error.json', { gate: 'web-types', line: line ?? null });
      r.check(
        'S01-negative: отказ конкретной проверки web-types (TS2339 issuedAt)',
        web && line && /issuedAt/.test(line) && /AccessTokenDto/.test(line),
        { web, line },
      );
      r.check(
        'S01-negative: acceptance не исполнялся после отказа',
        !ev.some((e) => e.gate === 'acceptance'),
        ev,
      );
    } catch (error) {
      errors.S01 ??= error;
    }
  }

  // ---------------- S02 variants ----------------
  const s02 = (label, files, expectation) => {
    if (!wanted(label)) return;
    const r = rec.S02;
    try {
      const o = variant(label, r, { files });
      const ev = evidenceOf(o);
      for (const gate of ['sdk-generation', 'backend-types'])
        if (o.artifacts && existsSync(join(o.artifacts, 'candidate', gate + '.log')))
          r.copy(join(o.artifacts, 'candidate', gate + '.log'), `${label}/${gate}.log`);
      const f = failureOf(o);
      r.json(`${label}/evidence.json`, ev);
      r.json(`${label}/failure.json`, f);
      r.check(`${label}: работа failed`, o.work?.status === 'failed', o.work);
      r.check(`${label}: target ref не сдвинут`, o.targetAfter === o.targetBefore, o);
      expectation(r, o, ev, f);
    } catch (error) {
      errors.S02 ??= error;
    }
  };
  const controller = 'apps/nest-backend/src/client-api/auth/client-auth.controller.ts';
  s02(
    'S02-unallowed-source',
    {
      ...positive,
      [controller]:
        git(fixture.repo, ['show', `${fixture.baselineSha}:${controller}`]) +
        '\n// изменение вне области поручения\n',
    },
    (r, o, ev, f) => {
      r.check(
        'S02-unallowed-source: отказ области записи до gates',
        f.kind === 'SCOPE_VIOLATION' &&
          f.failure.includes('вне области поручения') &&
          f.failure.includes(controller) &&
          !ev.some((e) => e.gate !== 'independent-review'),
        { f, ev },
      );
    },
  );
  const acceptanceTest = '.harness/acceptance/issued-at.test.mjs';
  s02(
    'S02-protected',
    {
      ...positive,
      [acceptanceTest]: "import { test } from 'node:test';\ntest('always green', () => {});\n",
    },
    (r, o, ev, f) => {
      r.check(
        'S02-protected: отказ защищённого пути',
        f.kind === 'SCOPE_VIOLATION' &&
          f.failure.includes('Изменены защищённые файлы') &&
          f.failure.includes(acceptanceTest),
        f,
      );
    },
  );
  const stale = Object.fromEntries(
    Object.entries(positive).filter(([p]) => !p.startsWith('apps/nest-backend/openapi/')),
  );
  s02('S02-stale', stale, (r, o, ev, f) => {
    const gen = ev.find((e) => e.gate === 'sdk-generation');
    r.check(
      'S02-stale: контроль backend-types прошёл',
      ev.some((e) => e.gate === 'backend-types' && e.passed),
      ev,
    );
    r.check(
      'S02-stale: отказ sdk-generation по устаревшему OpenAPI',
      gen && !gen.passed && gen.summary.includes('apps/nest-backend/openapi'),
      gen ?? ev,
    );
    void f;
  });
  const sdk = 'packages/client-rest-api-sdk/src/generated/data-contracts.ts';
  s02(
    'S02-hand-edited',
    {
      ...positive,
      [sdk]: positive[sdk].replace('issuedAt: string;', 'issuedAt: string; // ручная правка'),
    },
    (r, o, ev, f) => {
      const gen = ev.find((e) => e.gate === 'sdk-generation');
      r.check(
        'S02-hand-edited: отказ sdk-generation по ручной правке SDK',
        gen && !gen.passed && gen.summary.includes('packages/client-rest-api-sdk/src/generated'),
        gen ?? ev,
      );
      void f;
    },
  );
  if (wanted('S02-unallowed-source')) {
    const policy = starterPolicy(fixture);
    const scope = starterGraph().orders[0].writeScope;
    const generated = policy.repositories[0].generatedPaths;
    rec.S02.json('scheme.json', {
      writeScope: scope,
      generatedOutputsInScope: GENERATED,
      generatedPaths: generated,
      protectedPaths: policy.repositories[0].protectedPaths,
      generationGate: policy.repositories[0].gates.find((g) => g.id === 'sdk-generation'),
    });
    rec.S02.check(
      'S02: generatedPaths не пересекается с областью записи (не используется как разрешение)',
      !scope.some((s) => within(s, generated) || generated.some((g) => within(g, [s]))),
      { scope, generated },
    );
    rec.S02.check(
      'S02: выходы генерации разрешены поручением явно',
      GENERATED.every((g) => scope.includes(g)),
      scope,
    );
  }
}

let fatal;
try {
  await main();
} catch (error) {
  fatal = error;
}
const statuses = {};
for (const id of ['S01', 'S02', 'S05']) {
  const error = fatal ?? errors[id];
  statuses[id] = finish(rec[id], id, error, { work: W, fixture: fixture?.manifest });
}
process.exitCode = Object.values(statuses).every((s) => s === 'PASS')
  ? 0
  : Object.values(statuses).includes('FAIL')
    ? 1
    : 3;
console.log(JSON.stringify(statuses));
void Blocked;
