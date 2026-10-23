#!/usr/bin/env node
/**
 * S06 — окружение и секреты не протекают в результаты. Canary-значения
 * (только тестовые строки): разрешённая обычная переменная политики,
 * неразрешённая переменная оператора, секрет (по имени из политики; им же
 * compose-bridge задаёт пароль базы), посторонние DEVCONTOUR_/HARNESS_
 * переменные оператора. Первая попытка намеренно падает в gate с выводом
 * секрета, вторая проходит и доставляется получателю-каталогу. Затем во всех
 * сохранённых и доставленных артефактах сценария ищутся canary.
 *
 *   node scripts/acceptance/starter-s06.mjs --evidence <dir> --logs <dir> [--work <dir>] [--source <url|path>]
 * Код выхода: 0 PASS, 1 FAIL, 3 BLOCKED (нет Docker).
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  approve,
  git,
  implement,
  prepareStarterFixture,
  starterGraph,
  starterPolicy,
} from './starter-fixture.mjs';
import {
  docker,
  finish,
  grepFiles,
  harness,
  recorder,
  requireDocker,
  walk,
} from './starter-lib.mjs';

const { values } = parseArgs({
  options: {
    work: { type: 'string' },
    source: { type: 'string' },
    evidence: { type: 'string' },
    logs: { type: 'string' },
  },
});
// Канонический путь: Git сообщает worktree через realpath (/private/var… на macOS).
const W = (() => {
  const dir = resolve(values.work ?? mkdtempSync(join(tmpdir(), 'starter-s06-')));
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
})();
const evidenceDir = join(resolve(values.evidence ?? join(W, 'evidence')), 'S06');
const logsDir = join(resolve(values.logs ?? join(W, 'logs')), 'S06');
const rec = recorder(evidenceDir, logsDir);
const hex = () => randomBytes(6).toString('hex');
const canary = {
  allowed: 'canary-allowed-' + hex(),
  disallowed: 'canary-disallowed-' + hex(),
  secret: 'canary-secret-' + hex(),
  operatorDevcontour: 'canary-operator-dc-' + hex(),
  operatorHarness: 'canary-operator-hx-' + hex(),
};
const WORK = 's06';
const runIds = new Set();

async function main() {
  rec.json('docker.json', requireDocker());
  // В evidence — только имена canary и их длины, не значения.
  rec.json(
    'canaries.json',
    Object.fromEntries(
      Object.entries(canary).map(([k, v]) => [
        k,
        { prefix: v.split('-').slice(0, 2).join('-'), length: v.length },
      ]),
    ),
  );
  const fixture = prepareStarterFixture({
    workDir: W,
    installPnpm: false,
    ...(values.source ? { source: values.source } : {}),
    log: rec.log,
  });
  const dir = join(W, 'run');
  mkdirSync(dir, { recursive: true });
  const scenario = join(dir, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      writer: [
        implement({ 's06/note.txt': 'attempt 1\n', 's06/trigger-fail': 'fail with secret\n' }),
        { ...implement({ 's06/note.txt': 'attempt 2\n' }), remove: ['s06/trigger-fail'] },
      ],
      reviewer: approve(),
    }),
  );
  const declared = [
    'S06_ALLOWED',
    'S06_DECLARED',
    'S06_ENV_FILE_KEYS',
    'HX_DB_USER',
    'HX_DB_NAME',
    'HX_DB_PASSWORD',
    'FIXTURE_SCENARIO',
  ];
  const policy = starterPolicy(fixture, {
    template: 'policy.lifecycle.json',
    scenario,
    edit: (p) => {
      const repo = p.repositories[0];
      repo.environment.values.S06_ALLOWED = canary.allowed;
      repo.environment.values.S06_DECLARED = declared.join(',');
      repo.environment.values.S06_ENV_FILE_KEYS =
        'POSTGRES_PORT,POSTGRES_USER,POSTGRES_PASSWORD,POSTGRES_DB,POSTGRES_HOST';
      // Секрет — только именем переменной оператора; значения в политике нет.
      repo.environment.secrets = { HX_DB_PASSWORD: 'S06_SECRET_SOURCE' };
      repo.gates = [
        {
          id: 'env-probe',
          kind: 'test',
          command: [
            'node',
            '.harness/compose-bridge.mjs',
            'exec',
            '--',
            'node',
            '--test',
            '--test-reporter=junit',
            '--test-reporter-destination=.artifacts/junit/env-probe.xml',
            '.harness/acceptance/env-probe.test.mjs',
          ],
          report: { type: 'junit', path: '.artifacts/junit/env-probe.xml' },
          timeoutMs: 300000,
        },
      ];
      p.concurrency = 1;
      p.maxAttempts = 2;
    },
  });
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy, null, 2));
  rec.json('policy-public.json', policy);
  writeFileSync(
    join(dir, 'graph.json'),
    JSON.stringify(
      starterGraph({
        edit: (g) => {
          g.id = 'turbo-starter-s06';
          g.orders = [
            {
              ...g.orders[0],
              id: WORK,
              source: { connector: 'files', ref: WORK, revision: '1' },
              title: 'S06 environment probe',
              goal: 'Add s06/note.txt; env-probe proves the environment allowlist and secret masking.',
              acceptance: ['env-probe passes'],
              writeScope: ['s06'],
              gates: ['env-probe'],
              context: [],
            },
          ];
        },
      }),
      null,
      2,
    ),
  );
  const state = join(dir, 'state');
  const results = join(dir, 'results');
  git(fixture.repo, ['update-ref', policy.repositories[0].targetRef, fixture.baselineSha]);
  // Окружение оператора: секрет, неразрешённая переменная, посторонние DEVCONTOUR_/HARNESS_.
  const operator = {
    S06_SECRET_SOURCE: canary.secret,
    S06_DISALLOWED: canary.disallowed,
    DEVCONTOUR_OPERATOR_CANARY: canary.operatorDevcontour,
    HARNESS_OPERATOR_CANARY: canary.operatorHarness,
  };
  const cli = (name, args) => harness(rec, name, args, { cwd: dir, env: operator });
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
    'file:' + results,
  ];
  // Попытка 1 падает в gate с выводом секрета; повтор — явный (operator decides).
  const first = cli('run-1', runArgs);
  const afterFirst = cli('status-1', ['status', '--state', state]);
  rec.check(
    'S06: первая попытка отклонена gate',
    first.status !== 0 && afterFirst.json?.data?.works?.[0]?.status === 'failed',
    afterFirst.json?.data?.works,
  );
  const retry = cli('retry', ['retry', '--state', state, '--work', WORK]);
  rec.check('S06: явный повтор принят', retry.status === 0, retry.json);
  const run = cli('run', [
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
    'file:' + results,
  ]);
  const status = cli('status', ['status', '--state', state]);
  const result = cli('result', ['result', '--state', state, '--work', WORK]);
  const events = cli('events', ['events', '--state', state, '--limit', '1000']);
  const work = status.json?.data?.works?.[0];
  rec.json('status.json', status.json?.data);
  rec.json('result.json', result.json?.data);
  rec.check(
    'S06: работа принята со второй попытки',
    work?.status === 'done' && work.attempt === 2,
    work,
  );
  const runId = result.json?.data?.result?.runId;
  runIds.add(runId);
  // Первая попытка: отказ env-probe с выводом секрета.
  const attempts = walk(join(state, 'artifacts'))
    .filter((f) => f.endsWith('/candidate/environment/environment.json'))
    .map((f) => f.split('/artifacts/')[1].split('/')[0]);
  rec.check('S06: две попытки', new Set(attempts).size === 2, attempts);
  const failedRun = attempts.find((a) => a !== runId);
  runIds.add(failedRun);
  const failedLog = join(state, 'artifacts', failedRun, 'candidate', 'env-probe.log');
  const failedText = existsSync(failedLog) ? readFileSync(failedLog, 'utf8') : '';
  rec.copy(failedLog, 'attempt-1-env-probe.log');
  rec.check(
    'S06: команда gate вывела секрет, harness записал маску',
    /failure with secret \[REDACTED\]/.test(failedText) && !failedText.includes(canary.secret),
    failedText.slice(-1500),
  );
  // Ключи окружения процесса gate (значений нет) из обеих фаз принятой попытки.
  const keys = walk(join(state, 'artifacts', runId))
    .filter((f) => /\/probe\/env-keys-\w+\.json$/.test(f))
    .map((f) => ({ file: f.split('/artifacts/')[1], keys: JSON.parse(readFileSync(f, 'utf8')) }));
  rec.json('process-env-keys.json', keys);
  rec.check(
    'S06: процесс gate получил только объявленные и HARNESS_/DEVCONTOUR_ переменные',
    keys.length === 2 &&
      keys.every(
        (k) =>
          !k.keys.includes('S06_DISALLOWED') &&
          !k.keys.includes('S06_SECRET_SOURCE') &&
          !k.keys.includes('DEVCONTOUR_OPERATOR_CANARY') &&
          !k.keys.includes('HARNESS_OPERATOR_CANARY') &&
          k.keys.includes('S06_ALLOWED') &&
          k.keys.includes('HX_DB_PASSWORD') &&
          k.keys.includes('DEVCONTOUR_RUN_ID') &&
          k.keys.includes('HARNESS_RUN_ID'),
      ),
    keys,
  );
  // Env-файлы — только во время среды: после teardown их нет ни в одной среде.
  const envFiles = walk(state).filter((f) => /\/bridge\/env\//.test(f));
  rec.check('S06: временные env-файлы удалены lifecycle', envFiles.length === 0, envFiles);
  const delivered = walk(results);
  rec.check('S06: результат доставлен получателю', delivered.length === 1, delivered);
  rec.copy(delivered[0], 'delivered-result.json');
  // Отказ первой попытки виден в событиях; маска в тексте отказа.
  const failure = (events.json?.data?.events ?? []).filter(
    (e) => e.runId === failedRun && /fail/.test(e.type),
  );
  rec.json('attempt-1-failure-events.json', failure);
  // Поиск canary во всех артефактах сценария: state (SQLite, receipts, логи),
  // доставка, логи CLI, worktree-ветки Git (объекты не сканируются: дерево не
  // содержит canary по построению), evidence этого сценария.
  const scan = grepFiles([state, results, logsDir, evidenceDir, join(dir)], {
    secret: canary.secret,
    disallowed: canary.disallowed,
    operatorDevcontour: canary.operatorDevcontour,
    operatorHarness: canary.operatorHarness,
    allowed: canary.allowed,
  });
  rec.json('canary-scan.json', scan);
  // Позитивный контроль сканера: тот же поиск находит секрет в файле с ним.
  const probeDir = mkdtempSync(join(tmpdir(), 's06-scan-control-'));
  writeFileSync(join(probeDir, 'x.bin'), Buffer.from(`prefix ${canary.secret} suffix`));
  rec.check(
    'S06: контроль сканера — секрет в файле обнаруживается',
    grepFiles([probeDir], { secret: canary.secret }).hits.secret.length === 1,
    'scanner control',
  );
  rmSync(probeDir, { recursive: true, force: true });
  for (const name of ['secret', 'disallowed', 'operatorDevcontour', 'operatorHarness'])
    rec.check(
      `S06: canary ${name} не найден ни в одном артефакте`,
      scan.hits[name].length === 0,
      scan.hits[name],
    );
  rec.check(
    'S06: разрешённое обычное значение видно только в политике/binding (не секрет)',
    scan.hits.allowed.every((f) => /policy|binding|state\.sqlite/.test(f)),
    scan.hits.allowed,
  );
  const gitLog = git(fixture.repo, ['log', '--all', '-p', '--format=%H %s']);
  rec.check(
    'S06: canary нет в истории Git копии',
    !gitLog.includes(canary.secret) && !gitLog.includes(canary.disallowed),
    'git',
  );
  void run;
}

let error;
try {
  await main();
} catch (e) {
  error = e;
} finally {
  for (const run of runIds) {
    if (!run) continue;
    const c = docker(['ps', '-aq', '--filter', `label=devcontour.harness.run=${run}`])
      .split('\n')
      .filter(Boolean);
    if (c.length) {
      rec.log('уборка теста: контейнеры попытки ' + run);
      docker(['rm', '-f', '-v', ...c]);
    }
  }
}
finish(rec, 'S06', error, { work: W });
