#!/usr/bin/env node
/**
 * C02 — прежняя встройка DevContour с новым архивом harness, в свежей
 * изолированной копии закреплённого DevContour. Рабочий checkout DevContour
 * только читается (clone); его HEAD, status и vendor-архив сверяются до и после.
 *
 *   node scripts/acceptance/devcontour-check.mjs <devcontour-harness-<ver>.tgz>
 *     --devcontour <путь или URL репозитория DevContour>
 *     [--commit <SHA DevContour>]            (по умолчанию e26f8f43…, 0.4.0-alpha.7)
 *     [--harness-commit <SHA исходников архива>] (по умолчанию HEAD репозитория harness)
 *     [--harness-source-note <текст>]        (например «c1bb638 + uncommitted tree»; в отчёт рядом с sha256 архива)
 *     [--main-checkout <путь>]               (что сверять «не изменён»; по умолчанию --devcontour, если это каталог)
 *     [--baseline] [--no-regression] [--no-upgrade-check] [--rollback-baseline <SHA>]
 *     [--t42-baseline <SHA DevContour до пакета harness, по умолчанию 05ea929>]
 *     [--rollback-control <выпущенный архив>]  (T42 с ним же: совпавший отказ — не регрессия кандидата)
 *     [--full] [--concurrency 4] [--out <dir>] [--keep] [--work-root <dir>]
 *     [--harness-tests a,b] [--regression-tests c,d]   (сокращённый прогон для проверки скрипта)
 *
 * Шаги:
 *  1. отпечаток рабочего checkout (HEAD, status, sha256 vendor/harness, package*.json);
 *  2. `git clone --no-hardlinks` во временный каталог, checkout закреплённого
 *     коммита, `npm ci --offline` (при нехватке кэша — `--prefer-offline`);
 *  3. старое состояние: `devcontour-state.mjs before` под vendored alpha.4;
 *  4. `--baseline`: typecheck, `tests/harness-*.test.ts` и регрессии на alpha.4;
 *  5. подстановка архива штатным `scripts/vendor-harness.mjs <tgz> --commit`;
 *     сверка integrity lock = sha512 архива и установленной версии;
 *  6. diff копии: меняются только package.json, package-lock.json и vendor/harness;
 *  7. кандидат: typecheck, `tests/harness-*.test.ts`, регрессии (recovery,
 *     central/component, joint, git-sync, boundaries, runner); упавший файл
 *     перезапускается отдельно — оба результата в отчёте (flaky-timeout,
 *     если в пакетном прогоне причина — timeout и отдельно файл проходит);
 *  8. `devcontour-state.mjs after`: прежние запись/receipt/журнал не
 *     переписаны, новая принятая попытка через существующий хост;
 *     `review-protocol`: новые поля evidence переживают круг через хост,
 *     невалидная+валидная записи ревью на одном SHA не срывают приёмку, вид
 *     отказа `review-protocol` и код `REVIEW_PROTOCOL_INVALID`; `old-opens`:
 *     vendored версия над состоянием новой — отказ/изменения/сохранность полей;
 *  9. DevContour `scripts/upgrade-check.mjs` alpha.4 → архив (T40/T41) и
 *     `--rollback` (T42, central и component), если не `--no-upgrade-check`;
 * 10. `--full`: весь `npm test` DevContour;
 * 11. отпечаток рабочего checkout после — совпадает с исходным.
 * Итог — `<out>/report.json`, `<out>/copy.diff.stat`, журналы в `<out>/logs`.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  Recorder,
  harnessRoot,
  scratchDir,
  sha256File,
  sha512Integrity,
  tarballArg,
  writeReport,
} from './package-lib.mjs';

const DEFAULT_COMMIT = 'e26f8f4385bb0077b7abf8ff1ce019a2c5baa3f5';
const HARNESS_TESTS = [
  'tests/harness-host.test.ts',
  'tests/harness-legacy.test.ts',
  'tests/harness-receipt.test.ts',
  'tests/harness-roles.test.ts',
  'tests/harness-store.test.ts',
  'tests/harness-versions.test.ts',
];
// recovery; central/component (enterprise, receipt-identity, check-sync, harness-store);
// joint (workspace, workspace-mode, git-sync); граница пакета; Runner.
const REGRESSION_TESTS = [
  'tests/property-recovery.test.ts',
  'tests/workspace.test.ts',
  'tests/workspace-mode.test.ts',
  'tests/enterprise.test.ts',
  'tests/receipt-identity.test.ts',
  'tests/git-sync.test.ts',
  'tests/check-sync.test.ts',
  'tests/boundaries.test.ts',
  'tests/runner.test.ts',
];
const ALLOWED_CHANGES = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^vendor\/harness\/README\.md$/,
  /^vendor\/harness\/devcontour-harness-[0-9A-Za-z.-]+\.tgz$/,
];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    devcontour: { type: 'string', default: process.env.DEVCONTOUR_REPO },
    commit: { type: 'string', default: process.env.DEVCONTOUR_COMMIT ?? DEFAULT_COMMIT },
    'harness-commit': { type: 'string' },
    'harness-source-note': { type: 'string' },
    'main-checkout': { type: 'string' },
    baseline: { type: 'boolean', default: false },
    regression: { type: 'boolean', default: true },
    'upgrade-check': { type: 'boolean', default: true },
    'rollback-baseline': { type: 'string' },
    'rollback-control': { type: 'string' },
    't42-baseline': { type: 'string', default: '05ea929' },
    full: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: process.env.CONCURRENCY ?? '4' },
    out: { type: 'string' },
    keep: { type: 'boolean', default: false },
    'work-root': { type: 'string' },
    'harness-tests': { type: 'string' },
    'regression-tests': { type: 'string' },
  },
});
const list = (v, d) => (v ? v.split(',').filter(Boolean) : d);
const harnessTests = list(values['harness-tests'], HARNESS_TESTS);
const regressionTests = list(values['regression-tests'], REGRESSION_TESTS);
const tarball = tarballArg(positionals[0]);
if (!values.devcontour) {
  console.error('укажите --devcontour <путь или URL> (или env DEVCONTOUR_REPO)');
  process.exit(2);
}
if (values['work-root']) process.env.WORK_ROOT = resolve(values['work-root']);
const harnessCommit =
  values['harness-commit'] ??
  spawnSync('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot, encoding: 'utf8' }).stdout.trim();
if (!/^[0-9a-f]{40}$/.test(harnessCommit)) {
  console.error('--harness-commit: нужен 40-символьный SHA');
  process.exit(2);
}
const work = scratchDir('devcontour-check-');
const out = resolve(values.out ?? scratchDir('devcontour-check-out-'));
const rec = new Recorder(join(out, 'logs'));
const copy = join(work, 'devcontour');
const stateDir = join(work, 'state');
mkdirSync(stateDir);
const mainCheckout =
  values['main-checkout'] ??
  (existsSync(join(values.devcontour, '.git')) ? resolve(values.devcontour) : undefined);
const report = {
  id: 'C02',
  tarball: { file: tarball, sha256: sha256File(tarball), integrity: sha512Integrity(tarball) },
  harnessCommit,
  ...(values['harness-source-note'] ? { harnessSource: values['harness-source-note'] } : {}),
  devcontour: { source: values.devcontour, commit: values.commit },
  node: process.version,
  phases: {},
};

/** Отпечаток рабочего checkout: HEAD, status и hash файлов зависимости. */
function fingerprint(dir) {
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const vendor = join(dir, 'vendor', 'harness');
  return {
    head: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    status: git('status', '--porcelain', '--untracked-files=all'),
    files: Object.fromEntries(
      [
        'package.json',
        'package-lock.json',
        ...(existsSync(vendor) ? readdirSync(vendor).map((f) => join('vendor', 'harness', f)) : []),
      ]
        .filter((f) => existsSync(join(dir, f)))
        .map((f) => [f, sha256File(join(dir, f))]),
    ),
  };
}
const mainBefore = mainCheckout ? fingerprint(mainCheckout) : undefined;

/**
 * Промежуточный отчёт после каждой фазы: прерванный прогон (сигнал, предел
 * времени) оставляет `report.json` со статусом INCOMPLETE и пройденными фазами.
 */
const checkpoint = (status = 'INCOMPLETE') =>
  writeReport(join(out, 'report.json'), {
    ...report,
    status,
    failures: rec.failures,
    steps: rec.steps,
  });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => {
    rec.failures.push('прервано сигналом ' + signal);
    checkpoint('INTERRUPTED');
    console.log('C02 INTERRUPTED: report ' + join(out, 'report.json') + '; work dir kept: ' + work);
    process.exit(130);
  });

const node = (args, label, options = {}) =>
  rec.run(label, process.execPath, args, { cwd: copy, ...options });
const npmInstall = (label, args) => {
  const r = rec.run(
    label + ' (offline)',
    'npm',
    [...args, '--offline', '--no-audit', '--no-fund'],
    {
      cwd: copy,
    },
  );
  if (r.status === 0) return r;
  return rec.must(label, 'npm', [...args, '--prefer-offline', '--no-audit', '--no-fund'], {
    cwd: copy,
  });
};
const count = (text, name) => {
  const all = [...text.matchAll(new RegExp(`^ℹ ${name} (\\d+)`, 'gm'))];
  return all.length ? Number(all.at(-1)[1]) : undefined;
};
const failingFiles = (text) =>
  [...new Set([...text.matchAll(/test at (tests\/[^:\s]+\.test\.ts)/g)].map((m) => m[1]))].sort();

/** Набор тестов; упавший файл — отдельный повтор, оба результата в отчёте. */
function suite(phase, label, files) {
  const r = node(
    [
      '--import',
      'tsx',
      '--test',
      `--test-concurrency=${values.concurrency}`,
      '--test-reporter=spec',
      ...files,
    ],
    `${phase}: ${label}`,
  );
  const text = r.stdout + r.stderr;
  writeFileSync(join(out, 'logs', `${phase}-${label}.log`), text);
  const result = {
    files,
    exit: r.status,
    pass: count(text, 'pass'),
    fail: count(text, 'fail'),
    skipped: count(text, 'skipped'),
    todo: count(text, 'todo'),
    retries: [],
  };
  if (r.status !== 0) {
    const failed = failingFiles(text);
    if (!failed.length) result.verdict = 'FAIL';
    for (const file of failed) {
      const alone = node(
        ['--import', 'tsx', '--test', '--test-reporter=spec', file],
        `${phase}: ${label} retry ${file}`,
      );
      const t = alone.stdout + alone.stderr;
      writeFileSync(join(out, 'logs', `${phase}-${label}-retry-${file.split('/').pop()}.log`), t);
      const batchReasons = [
        ...new Set(
          [...text.matchAll(/(timeout=true|timed out|timeout|превысила timeout|cancelled)/gi)].map(
            (m) => m[1].toLowerCase(),
          ),
        ),
      ];
      result.retries.push({
        file,
        batch: 'fail',
        alone: { exit: alone.status, pass: count(t, 'pass'), fail: count(t, 'fail') },
        classification:
          alone.status === 0 ? (batchReasons.length ? 'flaky-timeout' : 'flaky') : 'fail',
        batchReasons,
      });
    }
    result.verdict =
      result.retries.every((x) => x.alone.exit === 0) && failed.length
        ? 'PASS-after-retry'
        : 'FAIL';
  } else result.verdict = 'PASS';
  if (result.verdict === 'FAIL') rec.fail(`${phase}: ${label} FAIL`);
  if ((result.skipped ?? 0) > 0 || (result.todo ?? 0) > 0)
    rec.fail(`${phase}: ${label}: skipped/todo ${result.skipped}/${result.todo}`);
  return result;
}

function checks(phase) {
  const p = { version: installedVersion() };
  const tc = rec.run(`${phase}: typecheck`, 'npm', ['run', '-s', 'typecheck'], { cwd: copy });
  p.typecheck = tc.status;
  rec.assert(tc.status === 0, `${phase}: typecheck: ${(tc.stdout + tc.stderr).slice(0, 2000)}`);
  p.harness = suite(phase, 'harness', harnessTests);
  report.phases[phase] = p;
  checkpoint();
  if (values.regression) p.regression = suite(phase, 'regression', regressionTests);
  return p;
}
const installedVersion = () =>
  JSON.parse(readFileSync(join(copy, 'node_modules/devcontour-harness/package.json'), 'utf8'))
    .version;
const state = (step, at = copy, { dir = stateDir, extra = [], env = {} } = {}) => {
  const r = node(
    [
      '--import',
      'tsx',
      join(harnessRoot, 'scripts', 'acceptance', 'devcontour-state.mjs'),
      step,
      dir,
      ...extra,
    ],
    `state ${step} ${extra.join(' ')}`.trim(),
    { cwd: at, env: { ...process.env, DEVCONTOUR_COPY: at, ...env } },
  );
  rec.assert(r.status === 0, `state ${step}: ${(r.stderr || r.stdout).slice(-2000)}`);
  try {
    return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  } catch {
    return { exit: r.status };
  }
};

try {
  // 2. Свежая копия закреплённого коммита.
  rec.must('clone', 'git', ['clone', '-q', '--no-hardlinks', values.devcontour, copy]);
  rec.must('checkout', 'git', ['checkout', '-q', '--detach', values.commit], { cwd: copy });
  report.devcontour.head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: copy,
    encoding: 'utf8',
  }).stdout.trim();
  rec.assert(report.devcontour.head.startsWith(values.commit), 'копия не на закреплённом коммите');
  npmInstall('npm ci', ['ci']);
  const vendored = spawnSync('git', ['ls-tree', '--name-only', 'HEAD', 'vendor/harness/'], {
    cwd: copy,
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .find((f) => f.endsWith('.tgz'));
  const fromTgz = join(work, vendored.split('/').pop());
  writeFileSync(
    fromTgz,
    spawnSync('git', ['show', 'HEAD:' + vendored], { cwd: copy, maxBuffer: 1 << 28 }).stdout,
  );
  report.vendored = { file: vendored, sha256: sha256File(fromTgz), version: installedVersion() };

  // 3. Старое состояние под vendored версией.
  report.phases.stateBefore = state('before');
  checkpoint();

  // 4. Базовая линия.
  if (values.baseline) report.phases.baseline = checks('baseline');
  checkpoint();

  // 5. Подстановка штатным скриптом DevContour.
  let sub = rec.run(
    'vendor-harness.mjs (offline)',
    process.execPath,
    ['scripts/vendor-harness.mjs', tarball, '--commit', harnessCommit],
    { cwd: copy, env: { ...process.env, npm_config_offline: 'true' } },
  );
  if (sub.status !== 0)
    sub = rec.run(
      'vendor-harness.mjs',
      process.execPath,
      ['scripts/vendor-harness.mjs', tarball, '--commit', harnessCommit],
      { cwd: copy },
    );
  report.substitution = { tool: 'scripts/vendor-harness.mjs', exit: sub.status };
  rec.assert(
    sub.status === 0,
    'vendor-harness.mjs отказал: ' + (sub.stderr || sub.stdout).slice(-1500),
  );
  const lock = JSON.parse(readFileSync(join(copy, 'package-lock.json'), 'utf8'));
  const entry = lock.packages?.['node_modules/devcontour-harness'] ?? {};
  const want = JSON.parse(
    spawnSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }).stdout,
  ).version;
  report.substitution.lock = {
    version: entry.version,
    resolved: entry.resolved,
    integrity: entry.integrity,
  };
  report.substitution.installed = installedVersion();
  rec.assert(entry.integrity === report.tarball.integrity, 'integrity lock ≠ sha512 архива');
  rec.assert(
    report.substitution.installed === want,
    `установлена ${report.substitution.installed}, нужна ${want}`,
  );
  // Установленные байты = байты архива: каждый файл package/ архива и
  // установленного пакета сверяется по sha256 (lock и версия этого не доказывают).
  const unpacked = join(work, 'candidate-unpacked');
  mkdirSync(unpacked);
  rec.must('tar extract candidate', 'tar', ['-xzf', tarball, '-C', unpacked]);
  const hashTree = (root) => {
    const out = {};
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') walk(full);
        } else if (e.isFile()) out[full.slice(root.length + 1)] = sha256File(full);
      }
    };
    walk(root);
    return out;
  };
  const archived = hashTree(join(unpacked, 'package'));
  const installedFiles = hashTree(join(copy, 'node_modules', 'devcontour-harness'));
  const differing = Object.keys({ ...archived, ...installedFiles })
    .filter((f) => archived[f] !== installedFiles[f])
    .sort();
  report.substitution.installedBytes = {
    files: Object.keys(archived).length,
    identical: differing.length === 0,
    differing: differing.slice(0, 50),
  };
  rec.assert(
    !differing.length,
    'установленный пакет отличается от архива: ' + differing.slice(0, 20).join(', '),
  );

  // 6. Diff копии: только зависимость.
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: copy,
    encoding: 'utf8',
  }).stdout;
  const changed = status
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3));
  const stat = spawnSync('git', ['diff', '--stat'], { cwd: copy, encoding: 'utf8' }).stdout;
  writeFileSync(join(out, 'copy.diff.stat'), stat + '\n# status --porcelain\n' + status);
  writeFileSync(
    join(out, 'copy.diff'),
    spawnSync(
      'git',
      ['diff', '--', 'package.json', 'package-lock.json', 'vendor/harness/README.md'],
      {
        cwd: copy,
        encoding: 'utf8',
      },
    ).stdout,
  );
  const unexpected = changed.filter((f) => !ALLOWED_CHANGES.some((r) => r.test(f)));
  report.copyChanges = { changed, unexpected };
  rec.assert(
    !unexpected.length,
    'копия DevContour изменена вне зависимости: ' + unexpected.join(', '),
  );

  // 7. Кандидат.
  report.phases.candidate = checks('candidate');
  checkpoint();

  // 8. Прежнее состояние под новым архивом и новая принятая попытка.
  report.phases.stateAfter = state('after');
  checkpoint();
  // Копия состояния alpha.6 без записей ревью нового протокола (случай a old-opens).
  const stateA = join(work, 'state-case-a');
  cpSync(stateDir, stateA, { recursive: true });

  // 8a. Чек-лист протокола ревью (HR): круг новых полей evidence через хост,
  // невалидная+валидная записи ревью на одном SHA, вид отказа и код ошибки.
  report.phases.reviewProtocol = state('review-protocol');
  checkpoint();

  // 8b. Прежняя версия (vendored, отдельная копия) над состоянием новой:
  // отказ или изменения фиксируются; потеря новых полей — отказ проверки.
  const old = join(work, 'devcontour-old');
  rec.must('clone old', 'git', ['clone', '-q', '--no-hardlinks', copy, old]);
  rec.must('checkout old', 'git', ['checkout', '-q', '--detach', values.commit], { cwd: old });
  const oldCi = rec.run(
    'npm ci old (offline)',
    'npm',
    ['ci', '--offline', '--no-audit', '--no-fund'],
    {
      cwd: old,
    },
  );
  if (oldCi.status !== 0)
    rec.must('npm ci old', 'npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], {
      cwd: old,
    });
  // Три случая на копиях базы: a — без новых полей ревью; b — с ними, роль
  // alpha.6 не жива; c — с ними и живой ролью alpha.6 (hold-lead новой версией).
  const stateB = join(work, 'state-case-b');
  const stateC = join(work, 'state-case-c');
  cpSync(stateDir, stateB, { recursive: true });
  cpSync(stateDir, stateC, { recursive: true });
  const hold = state('hold-lead', copy, {
    dir: stateC,
    env: { DEVCONTOUR_STATE_LEASE_MS: '300000' },
  });
  report.phases.oldOpens = {
    a: state('old-opens', old, { dir: stateA, extra: ['a'] }),
    b: state('old-opens', old, { dir: stateB, extra: ['b'] }),
    c: { hold: hold.leader, ...state('old-opens', old, { dir: stateC, extra: ['c'] }) },
  };
  checkpoint();

  // 9. Штатные сценарии обновления и отката DevContour.
  if (values['upgrade-check']) {
    const up = node(
      ['scripts/upgrade-check.mjs', fromTgz, tarball, '--to-commit', harnessCommit],
      'upgrade-check T40/T41',
    );
    writeFileSync(join(out, 'logs', 'upgrade-check.log'), up.stdout + up.stderr);
    report.phases.upgradeCheck = { exit: up.status, tail: (up.stdout + up.stderr).slice(-1500) };
    rec.assert(up.status === 0, 'upgrade-check T40/T41 FAIL');
    /**
     * T42 одним архивом `to`. Итог — шаги с id/status из вывода upgrade-check;
     * первый FAIL — его сообщение без стека.
     */
    const rollback = (to, label) => {
      const r = node(
        [
          'scripts/upgrade-check.mjs',
          fromTgz,
          to,
          '--to-commit',
          harnessCommit,
          '--rollback',
          '--baseline-commit',
          values['rollback-baseline'] ?? values.commit,
        ],
        label,
      );
      const text = r.stdout + r.stderr;
      const passed = [...text.matchAll(/"id": "([^"]+)",\s*"status": "PASS"/g)].map((m) => m[1]);
      const failure = text.match(/"status": "FAIL",\s*"error": "(?:Error: )?([^"\\]+)/)?.[1];
      return { exit: r.status, passed, failure, text };
    };
    const rb = rollback(tarball, 'upgrade-check --rollback T42 (central, component)');
    writeFileSync(join(out, 'logs', 'rollback-check.log'), rb.text);
    report.phases.rollbackCheck = {
      exit: rb.exit,
      baselineCommit: values['rollback-baseline'] ?? values.commit,
      passed: rb.passed,
      failure: rb.failure,
    };
    if (rb.exit !== 0 && values['rollback-control']) {
      // Контроль: тот же сценарий с выпущенным архивом (например, alpha.5).
      // Совпавший отказ на том же шаге — свойство сценария для этой пары
      // версий, а не регрессия кандидата; он остаётся в отчёте как есть.
      const control = rollback(
        resolve(values['rollback-control']),
        'upgrade-check --rollback T42 control',
      );
      writeFileSync(join(out, 'logs', 'rollback-control.log'), control.text);
      const same =
        control.exit !== 0 &&
        control.failure === rb.failure &&
        JSON.stringify(control.passed) === JSON.stringify(rb.passed);
      report.phases.rollbackCheck.control = {
        tarball: resolve(values['rollback-control']),
        sha256: sha256File(resolve(values['rollback-control'])),
        exit: control.exit,
        passed: control.passed,
        failure: control.failure,
        sameAsCandidate: same,
      };
      report.phases.rollbackCheck.verdict = same ? 'FAIL-same-as-control' : 'FAIL';
      if (!same) rec.fail('upgrade-check --rollback T42 FAIL (контроль ведёт себя иначе)');
    } else {
      report.phases.rollbackCheck.verdict = rb.exit === 0 ? 'PASS' : 'FAIL';
      rec.assert(rb.exit === 0, 'upgrade-check --rollback T42 FAIL: ' + rb.failure);
    }
  }

  // 9a. T42 полностью: варианты а–г обеих топологий шагами DevContour без
  // изменения его кода (`devcontour-rollback.mjs`); «в» разделён на
  // совместимый формат и настоящий раунд ревью alpha.6, «г» — откат к
  // DevContour до пакета harness (`--t42-baseline`). Это основной итог T42;
  // прогон штатного `upgrade-check --rollback` выше — дополнительное наблюдение.
  if (values['upgrade-check']) {
    const t42Out = join(out, 't42');
    const t42 = rec.run('T42 rollback driver (a–d, central+component)', process.execPath, [
      join(harnessRoot, 'scripts', 'acceptance', 'devcontour-rollback.mjs'),
      tarball,
      '--devcontour',
      values.devcontour,
      '--commit',
      values.commit,
      '--baseline-commit',
      values['t42-baseline'],
      '--harness-commit',
      harnessCommit,
      '--out',
      t42Out,
    ]);
    let t42Report = {};
    try {
      t42Report = JSON.parse(readFileSync(join(t42Out, 'report.json'), 'utf8'));
    } catch {
      /* нет отчёта — отказ ниже */
    }
    report.phases.t42 = {
      exit: t42.status,
      status: t42Report.status,
      baselineCommit: values['t42-baseline'],
      variants: (t42Report.variants ?? []).map((v) => ({
        id: v.id,
        status: v.status,
        ...(v.old ? { old: v.old } : {}),
        ...(v.error ? { error: v.error.slice(0, 300) } : {}),
      })),
    };
    rec.assert(
      t42Report.status === 'PASS',
      'T42 (a–d) FAIL: ' + JSON.stringify(report.phases.t42.variants),
    );
    checkpoint();
  }

  // 10. Полный набор DevContour.
  if (values.full) {
    const full = rec.run('candidate: npm test', 'npm', ['test'], { cwd: copy });
    writeFileSync(join(out, 'logs', 'candidate-full.log'), full.stdout + full.stderr);
    report.phases.full = {
      exit: full.status,
      pass: count(full.stdout + full.stderr, 'pass'),
      fail: count(full.stdout + full.stderr, 'fail'),
    };
    rec.assert(full.status === 0, 'npm test DevContour FAIL');
  }
} catch (error) {
  rec.fail('исключение: ' + (error?.stack ?? String(error)));
} finally {
  // 11. Рабочий checkout не изменён.
  if (mainCheckout) {
    const mainAfter = fingerprint(mainCheckout);
    report.mainCheckout = {
      path: mainCheckout,
      before: mainBefore,
      after: mainAfter,
      unchanged: JSON.stringify(mainBefore) === JSON.stringify(mainAfter),
    };
    rec.assert(report.mainCheckout.unchanged, 'рабочий checkout DevContour изменился');
  } else
    report.mainCheckout = { skipped: 'источник — не локальный каталог; укажите --main-checkout' };
  report.status = rec.failures.length ? 'FAIL' : 'PASS';
  report.failures = rec.failures;
  report.steps = rec.steps;
  writeReport(join(out, 'report.json'), report);
  const p = report.phases;
  const v = (s) => (s ? `${s.verdict} ${s.pass}/${(s.pass ?? 0) + (s.fail ?? 0)}` : 'n/a');
  console.log(
    `C02 ${report.status}: harness ${report.substitution?.installed} (sha256 ${report.tarball.sha256}) in DevContour ${report.devcontour.head}; ` +
      `baseline harness ${v(p.baseline?.harness)} regression ${v(p.baseline?.regression)}; ` +
      `candidate typecheck ${p.candidate?.typecheck} harness ${v(p.candidate?.harness)} regression ${v(p.candidate?.regression)}; ` +
      `state after ${p.stateAfter?.newAttempt?.status ?? 'n/a'}; upgrade ${p.upgradeCheck?.exit ?? 'n/a'} rollback (DevContour script) ${p.rollbackCheck?.verdict ?? 'n/a'}; T42 a–d ${p.t42?.status ?? 'n/a'}; ` +
      `review-protocol C=${p.reviewProtocol?.c?.status ?? 'n/a'} D=${p.reviewProtocol?.d?.failureKind ?? 'n/a'}; old opens ${['a', 'b', 'c'].map((k) => `${k}:refused=${p.oldOpens?.[k]?.refused} wrote=${p.oldOpens?.[k]?.wrote} lead=${p.oldOpens?.[k]?.observed?.lead} preserved=${p.oldOpens?.[k]?.newFieldsPreserved}`).join(' ')}; ` +
      `copy changes ${report.copyChanges?.changed?.length ?? '?'} (unexpected ${report.copyChanges?.unexpected?.length ?? '?'}); main checkout unchanged ${report.mainCheckout.unchanged ?? 'n/a'}; report ${join(out, 'report.json')}`,
  );
  if (!values.keep && !rec.failures.length) rmSync(work, { recursive: true, force: true });
  else console.log('work dir kept: ' + work);
}
process.exit(rec.failures.length ? 1 : 0);
