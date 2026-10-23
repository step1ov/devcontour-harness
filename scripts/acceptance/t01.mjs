#!/usr/bin/env node
// T01 — семь вариантов toolchain целевого проекта через обычный путь harness.
//
// Запуск из корня репозитория harness:
//   node --import tsx scripts/acceptance/t01.mjs [npm pnpm turbo go python mixed-go mixed-python]
//
// Для каждого варианта из examples/toolchains/<variant>/ в отдельном
// временном каталоге собирается настоящий Git-репозиторий, и CLI harness
// выполняет `run` (ревью плана → согласование → попытка → gates → ревью кода →
// integration → принятие) с fixture-исполняемыми файлами вместо codex/claude:
// writer (fake-claude) пишет файлы из good/ либо bad/, reviewer (fake-codex)
// одобряет. Приёмку решают настоящие npm/pnpm/turbo/go/gotestsum/uv/pytest/ruff
// и разобранный JUnit, а не fixture. Отрицательный прогон — свежая копия того
// же fixture с неверной реализацией: не принят, target ref не сдвинут.
//
// Доказательства: T01_EVIDENCE (по умолчанию .private/integration-upgrade/evidence/T01),
// логи: T01_LOGS (по умолчанию .private/integration-upgrade/logs/T01).
// Отсутствующий инструмент — статус BLOCKED с причиной, не PASS.
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequirements } from '../../src/verification/requirements.ts';
import { SqliteExecutionStore } from '../../src/storage/sqlite.ts';
import { junitSummary } from '../../src/verification/gates.ts';
import { requirementProof } from '../../src/verification/proof.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const examples = join(root, 'examples/toolchains');
const cli = join(root, 'src/cli.ts');
const bin = (name) => join(root, 'tests/fixtures/bin', name);
const evidenceRoot =
  process.env.T01_EVIDENCE ?? join(root, '.private/integration-upgrade/evidence/T01');
const logsRoot = process.env.T01_LOGS ?? join(root, '.private/integration-upgrade/logs/T01');
const all = ['npm', 'pnpm', 'turbo', 'go', 'python', 'mixed-go', 'mixed-python'];
const variants = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const keep = process.argv.includes('--keep');
const selected = variants.length ? variants : all;

// Инструменты окружения harness: локальная установка gotestsum (если есть) — в начало PATH.
const localTools = join(root, '.private/integration-upgrade/tools/gobin');
const PATH = [
  ...(process.env.T01_EXTRA_PATH ? [process.env.T01_EXTRA_PATH] : []),
  ...(existsSync(localTools) ? [localTools] : []),
  process.env.PATH,
].join(delimiter);
const env = {
  ...process.env,
  PATH,
  NODE_OPTIONS: '',
  HARNESS_CLAUDE_BIN: bin('fake-claude'),
  HARNESS_CODEX_BIN: bin('fake-codex'),
  GIT_AUTHOR_NAME: 't01',
  GIT_AUTHOR_EMAIL: 't01@example.invalid',
  GIT_COMMITTER_NAME: 't01',
  GIT_COMMITTER_EMAIL: 't01@example.invalid',
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const requiredTools = {
  npm: ['node', 'npm'],
  pnpm: ['node', 'pnpm'],
  turbo: ['node', 'pnpm'],
  go: ['go', 'gotestsum'],
  python: ['uv'],
  'mixed-go': ['node', 'pnpm', 'go', 'gotestsum'],
  'mixed-python': ['node', 'pnpm', 'uv'],
};
const which = (tool) => PATH.split(delimiter).some((d) => d && existsSync(join(d, tool)));

const versions = () => {
  const v = (argv) => {
    const r = spawnSync(argv[0], argv.slice(1), { env, encoding: 'utf8', timeout: 10000 });
    return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
  };
  const gotestsum = PATH.split(delimiter)
    .map((d) => join(d, 'gotestsum'))
    .find((f) => existsSync(f));
  return {
    os: `${process.platform}-${process.arch}`,
    node: process.version,
    npm: v(['npm', '--version']),
    pnpm: v(['pnpm', '--version']),
    go: v(['go', 'version']),
    gotestsum: gotestsum
      ? (execFileSync('go', ['version', '-m', gotestsum], { env, encoding: 'utf8' }).match(
          /mod\s+\S+\s+(v\S+)/,
        )?.[1] ?? null)
      : null,
    uv: v(['uv', '--version']),
    git: v(['git', '--version']),
  };
};

function renameGitignores(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) renameGitignores(p);
    else if (e.name === '_gitignore') renameSync(p, join(dir, '.gitignore'));
  }
}
function filesOf(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesOf(join(dir, e.name), base) : [relative(base, join(dir, e.name))],
  );
}

function harness(cwd, args, log) {
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 1_800_000,
  });
  log.push(`$ harness ${args.join(' ')}\n[exit ${r.status}]\n${r.stderr}\n${r.stdout}`);
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  return { status: r.status, json, stderr: r.stderr };
}

const lockNames = ['package-lock.json', 'pnpm-lock.yaml', 'go.sum', 'go.mod', 'uv.lock'];

function runCase(variant, mode) {
  const started = Date.now();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `harness-t01-${variant}-${mode}-`)));
  const log = [];
  const repo = join(dir, 'repo');
  cpSync(join(examples, variant, 'repo'), repo, { recursive: true });
  renameGitignores(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', `T01 ${variant} fixture`);
  const policy = JSON.parse(readFileSync(join(examples, variant, 'policy.json'), 'utf8'));
  const targetRef = policy.repositories[0].targetRef;
  git('update-ref', targetRef, 'HEAD');
  const base = git('rev-parse', 'HEAD');
  const tracked = git('ls-files').split('\n');
  const locks = tracked.filter((f) => lockNames.includes(f.split('/').at(-1)));
  const lockDigest = (ref) =>
    Object.fromEntries(
      locks.map((f) => [f, sha256(execFileSync('git', ['show', `${ref}:${f}`], { cwd: repo }))]),
    );
  const lockBefore = lockDigest(base);

  // Writer: файлы реализации из good/ либо bad/; reviewer: одобрение.
  const impl = join(examples, variant, mode === 'positive' ? 'good' : 'bad');
  const files = Object.fromEntries(
    filesOf(impl).map((f) => [f, readFileSync(join(impl, f), 'utf8')]),
  );
  const scenario = join(dir, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      writer: {
        files,
        result: {
          completed: true,
          summary: `T01 ${variant}: ${mode} implementation`,
          discoveries: [],
        },
      },
      reviewer: {
        result: {
          approved: true,
          summary: 'Критерии выполнены по diff и evidence',
          findings: [],
          discoveries: [],
          execution: { commands: [], noCommandsReason: 'Проверка по diff и evidence gates' },
          previous: [],
        },
      },
    }),
  );
  const repoPolicy = policy.repositories[0];
  repoPolicy.environment = {
    ...repoPolicy.environment,
    values: { ...repoPolicy.environment?.values },
  };
  policy.environment = { values: { FIXTURE_SCENARIO: scenario } };
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy, null, 2));

  const task = JSON.parse(readFileSync(join(examples, variant, 'task.json'), 'utf8'));
  const parsed = parseRequirements(readFileSync(join(repo, 'REQUIREMENTS.md'), 'utf8'));
  const requirements = task.requirements.map((r) => {
    const found = parsed.find((p) => p.id === r.id);
    if (!found) throw new Error(`${variant}: нет ${r.id} в REQUIREMENTS.md`);
    return {
      id: r.id,
      source: 'REQUIREMENTS.md',
      digest: found.digest,
      text: found.text,
      gate: r.gate,
      scenario: r.scenario,
      testId: r.testId,
    };
  });
  const graph = {
    apiVersion: 'devcontour-harness/v1alpha1',
    id: `t01-${variant}`,
    source: { connector: 'files', ref: 'graph.json', revision: '1' },
    orders: [
      {
        apiVersion: 'devcontour-harness/v1alpha1',
        id: 'pad-labels',
        source: { connector: 'files', ref: 'pad-labels', revision: '1' },
        title: task.title,
        goal: task.goal,
        acceptance: task.acceptance,
        role: 'developer',
        repositoryId: 'app',
        writeScope: task.writeScope,
        gates: task.gates,
        requirements,
      },
    ],
  };
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(graph, null, 2));

  const state = join(dir, 'state');
  const doctor = harness(dir, ['doctor', '--policy', 'policy.json'], log);
  const run = harness(
    dir,
    ['run', '--graph', 'graph.json', '--policy', 'policy.json', '--state', state],
    log,
  );
  const after = git('rev-parse', targetRef);

  // Состояние извне: попытки, evidence, проверка требований по тем же правилам, что у движка.
  const store = new SqliteExecutionStore(join(state, 'state.sqlite'), 't01-reader', {
    readOnly: true,
  });
  let work, attempts;
  try {
    ({ work, attempts } = store.read((v) => ({
      work: v.work('pad-labels'),
      attempts: v.attempts('pad-labels'),
    })));
  } finally {
    store.close();
  }
  const evidence = attempts.flatMap((a) =>
    a.evidence
      .filter((e) => e.kind === 'test' && e.gate !== 'requirement-source')
      .map((e) => {
        const text = existsSync(e.log) ? readFileSync(e.log, 'utf8') : '';
        const header = /^# harness gate \S+: cwd=(\S+) argv=(\[.*?\])(?: fresh=(.*))?$/m.exec(text);
        const xmlPath = join(dirname(e.log), `${e.gate}.xml`);
        let junit;
        if (existsSync(xmlPath) && e.passed) {
          const s = junitSummary(readFileSync(xmlPath, 'utf8'));
          junit = { tests: s.tests, failures: s.failures, skipped: s.skipped, cases: s.cases };
        }
        return {
          runId: e.runId,
          attempt: a.id,
          phase: e.phase,
          sha: e.sha,
          gate: e.gate,
          passed: e.passed,
          exitCode: e.exitCode,
          cwd: header?.[1],
          argv: header ? JSON.parse(header[2]) : e.command,
          ...(header?.[3] ? { freshness: JSON.parse(header[3]) } : {}),
          logDigest: e.digest,
          logDigestMatches: sha256(text) === e.digest,
          summary: e.summary,
          tests: e.tests,
          ...(junit ? { junit } : {}),
        };
      }),
  );
  // Шаги prepare (установка зависимостей) по фактическим логам попыток.
  const prepare = attempts.flatMap((a) =>
    ['candidate', 'integration'].flatMap((phase) =>
      repoPolicy.prepare.flatMap((step) => {
        const file = join(state, 'artifacts', a.id, phase, 'prepare', `${step.id}.log`);
        if (!existsSync(file)) return [];
        const text = readFileSync(file, 'utf8');
        return [
          {
            attempt: a.id,
            phase,
            step: step.id,
            argv: step.command,
            log: relative(dir, file),
            logDigest: sha256(text),
            excerpt: text.trim().split('\n').slice(-3),
          },
        ];
      }),
    ),
  );
  const counter = (name) => {
    const file = `${scenario}.${name}.count`;
    return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  };
  const runtimeCalls = { writer: counter('claude.writer'), reviewer: counter('codex.reviewer') };
  const resultSha = work?.resultSha;
  const proofs = requirements.map((r) =>
    requirementProof(
      r,
      attempts.flatMap((a) => a.evidence),
      resultSha,
    ),
  );
  const lockAfter = lockDigest(after);
  const worktreeLock = Object.fromEntries(
    locks.map((f) => [f, sha256(readFileSync(join(repo, f)))]),
  );
  const treeFiles = git('ls-tree', '-r', '--name-only', after).split('\n');
  const record = {
    id: `T01/${variant}`,
    mode,
    tmp: keep ? dir : '(removed)',
    baseSha: base,
    targetRef,
    targetAfter: after,
    targetMoved: after !== base,
    exit: run.status,
    workStatus: work?.status,
    resultSha,
    runIds: attempts.map((a) => a.id),
    attempts: attempts.map((a) => ({
      id: a.id,
      status: a.status,
      candidateSha: a.candidateSha,
      worktree: a.worktree,
    })),
    prepare,
    runtimeCalls,
    evidence,
    requirementProofs: proofs,
    lockfiles: {
      before: lockBefore,
      after: lockAfter,
      worktree: worktreeLock,
      unchanged:
        JSON.stringify(lockBefore) === JSON.stringify(lockAfter) &&
        JSON.stringify(lockBefore) === JSON.stringify(worktreeLock),
    },
    nodeManifestInTarget: treeFiles.filter(
      (f) => f === 'package.json' || f.endsWith('/package.json'),
    ),
    doctor: doctor.json?.data?.toolchains?.map((t) => ({
      plan: t.plan,
      tools: t.tools,
      lockfiles: t.lockfiles,
      ambiguities: t.ambiguities,
      problems: t.problems,
      warnings: t.warnings,
    })),
    doctorProblems: doctor.json?.data?.problems,
    implementation: Object.keys(files),
    acceptedContent: resultSha
      ? Object.fromEntries(
          Object.keys(files).map((f) => [
            f,
            git('show', `${resultSha}:${f}`) === files[f].trimEnd(),
          ]),
        )
      : undefined,
    durationMs: Date.now() - started,
  };
  // Вердикт по наблюдаемому состоянию.
  const reasons = [];
  if (mode === 'positive') {
    if (work?.status !== 'done') reasons.push('работа не принята: ' + work?.status);
    if (!resultSha || after !== resultSha) reasons.push('target ref не равен принятому SHA');
    if (proofs.some((p) => p.level !== 'testcase'))
      reasons.push('требования не подтверждены testcase: ' + JSON.stringify(proofs));
    const integration = evidence.filter((e) => e.phase === 'integration' && e.sha === resultSha);
    for (const gate of task.gates)
      if (!integration.some((e) => e.gate === gate && e.passed))
        reasons.push('нет зелёного integration gate ' + gate);
    for (const e of integration.filter((x) => x.junit))
      if (!e.junit.tests || e.junit.failures || e.junit.skipped)
        reasons.push('JUnit не зелёный: ' + e.gate);
    if (record.acceptedContent && Object.values(record.acceptedContent).some((ok) => !ok))
      reasons.push('принятое содержимое не совпадает с реализацией');
  } else {
    if (work?.status === 'done') reasons.push('неверная реализация принята');
    if (after !== base) reasons.push('target ref сдвинут');
    if (!evidence.some((e) => !e.passed)) reasons.push('нет провалившейся проверки');
    if (!runtimeCalls.writer) reasons.push('writer не вызывался: отказ не по проверке реализации');
  }
  if (!record.lockfiles.unchanged) reasons.push('lockfiles изменились');
  if (!prepare.some((p) => p.phase === 'candidate'))
    reasons.push('prepare (установка) не исполнялась');
  if (['go', 'python'].includes(variant) && record.nodeManifestInTarget.length)
    reasons.push('в pure-target есть package.json');
  if (evidence.some((e) => !e.cwd || !e.logDigestMatches))
    reasons.push('evidence без фактического cwd/argv или digest лога не совпал');
  record.status = reasons.length ? 'FAIL' : 'PASS';
  record.reasons = reasons;
  mkdirSync(join(evidenceRoot, variant), { recursive: true });
  mkdirSync(logsRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, variant, `${mode}.json`), JSON.stringify(record, null, 2));
  // Разобранный JUnit решающих integration-проверок — отдельным файлом.
  writeFileSync(
    join(evidenceRoot, variant, `${mode}-junit.json`),
    JSON.stringify(
      evidence
        .filter((e) => e.junit)
        .map((e) => ({ gate: e.gate, phase: e.phase, sha: e.sha, runId: e.runId, junit: e.junit })),
      null,
      2,
    ),
  );
  writeFileSync(join(logsRoot, `${variant}-${mode}.log`), log.join('\n\n'));
  if (!keep) rmSync(dir, { recursive: true, force: true });
  return record;
}

const summary = { startedAt: new Date().toISOString(), versions: versions(), results: [] };
for (const variant of selected) {
  const missing = requiredTools[variant].filter((t) => !which(t));
  if (missing.length) {
    summary.results.push({
      id: `T01/${variant}`,
      status: 'BLOCKED',
      reason: 'нет инструментов: ' + missing.join(', '),
    });
    console.log(`T01/${variant}: BLOCKED (нет ${missing.join(', ')})`);
    continue;
  }
  const positive = runCase(variant, 'positive');
  const negative = runCase(variant, 'negative');
  const status = positive.status === 'PASS' && negative.status === 'PASS' ? 'PASS' : 'FAIL';
  summary.results.push({
    id: `T01/${variant}`,
    status,
    positive: {
      status: positive.status,
      reasons: positive.reasons,
      resultSha: positive.resultSha,
      runIds: positive.runIds,
      durationMs: positive.durationMs,
    },
    negative: {
      status: negative.status,
      reasons: negative.reasons,
      targetMoved: negative.targetMoved,
      workStatus: negative.workStatus,
      runIds: negative.runIds,
      durationMs: negative.durationMs,
    },
  });
  console.log(
    `T01/${variant}: ${status}` +
      (status === 'PASS' ? '' : ' ' + JSON.stringify([positive.reasons, negative.reasons])),
  );
}
summary.finishedAt = new Date().toISOString();
mkdirSync(evidenceRoot, { recursive: true });
writeFileSync(
  join(evidenceRoot, variants.length ? `summary-${selected.join('-')}.json` : 'summary.json'),
  JSON.stringify(summary, null, 2),
);
process.exitCode = summary.results.every((r) => r.status === 'PASS') ? 0 : 1;
