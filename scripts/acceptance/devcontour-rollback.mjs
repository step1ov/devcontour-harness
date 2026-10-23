#!/usr/bin/env node
/**
 * C02/T42 — откат пакета и DevContour с проверяемым архивом harness, во
 * временных копиях закреплённого DevContour. Код DevContour не меняется:
 * используются его собственные шаги `scripts/rollback-scenario.ts`
 * (init, work, crash, read, write, sync, sync-only, reconcile); проверка — по
 * тем же признакам, что `scripts/upgrade-check.mjs --rollback` (базы, Git refs,
 * история задач, fencing роли controller), обе топологии хранения.
 *
 * Отличие от `upgrade-check.mjs`: вариант «в» там предполагает, что формат
 * состояния новой версии изменён, и для пары версий без изменения формата
 * обрывается. Здесь он разделён на два применимых варианта, оба доводятся до
 * восстановления, сверки Git и повтора:
 *  c-compat — авария новой версии над состоянием совместимого формата (запись
 *             ревью без новых полей): прежняя версия не перенимает живую роль
 *             новой и ничего не записывает (либо отказывает) — fencing;
 *  c-review — та же авария, но попытка новой версии записала раунд ревью с
 *             полями протокола alpha.6 (`devcontour-rollback-step.mjs`):
 *             предпосылка «формат изменён» настоящая; прежняя версия либо
 *             отказывает, либо ничего не записывает и не перенимает роль, а
 *             новые поля сохраняются.
 * Вариант «г» (откат DevContour после Git sync новой версии) — с
 * `--baseline-commit` прежней версии DevContour, receipts которой не знают
 * тождества проверок.
 *
 *   node scripts/acceptance/devcontour-rollback.mjs <devcontour-harness-<ver>.tgz>
 *     --devcontour <путь или URL> [--commit <SHA>] --baseline-commit <SHA прежнего DevContour>
 *     [--harness-commit <SHA>] [--topologies central,component] [--variants a,b,c,d]
 *     [--out <dir>] [--keep]   (c требует a и b: варианты идут цепочкой над одним каталогом)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    devcontour: { type: 'string', default: process.env.DEVCONTOUR_REPO },
    commit: { type: 'string', default: 'e26f8f4385bb0077b7abf8ff1ce019a2c5baa3f5' },
    'baseline-commit': { type: 'string' },
    'harness-commit': { type: 'string' },
    topologies: { type: 'string', default: 'central,component' },
    variants: { type: 'string', default: 'a,b,c,d' },
    out: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});
const tarball = tarballArg(positionals[0]);
if (!values.devcontour || !values['baseline-commit']) {
  console.error('укажите --devcontour и --baseline-commit');
  process.exit(2);
}
const harnessCommit =
  values['harness-commit'] ??
  spawnSync('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot, encoding: 'utf8' }).stdout.trim();
const work = scratchDir('devcontour-rollback-');
const out = resolve(values.out ?? scratchDir('devcontour-rollback-out-'));
const rec = new Recorder(join(out, 'logs'));
const toVersion = JSON.parse(
  execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }),
).version;
const report = {
  id: 'C02/T42',
  tarball: { file: tarball, sha256: sha256File(tarball), version: toVersion },
  devcontour: {
    source: values.devcontour,
    commit: values.commit,
    baseline: values['baseline-commit'],
  },
  variants: [],
};
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
const same = (a, b, message) =>
  check(
    JSON.stringify(a) === JSON.stringify(b),
    `${message}: ${JSON.stringify({ a, b }).slice(0, 600)}`,
  );

/* ---------------------------- копии DevContour ---------------------------- */
const clone = (name, commit) => {
  const dir = join(work, name);
  rec.must(`clone ${name}`, 'git', ['clone', '-q', '--no-hardlinks', values.devcontour, dir]);
  rec.must(`checkout ${name}`, 'git', ['checkout', '-q', '--detach', commit], { cwd: dir });
  const ci = rec.run(
    `npm ci ${name} (offline)`,
    'npm',
    ['ci', '--offline', '--no-audit', '--no-fund'],
    {
      cwd: dir,
    },
  );
  if (ci.status !== 0)
    rec.must(`npm ci ${name}`, 'npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], {
      cwd: dir,
    });
  return dir;
};
const vendor = (dir) => {
  let r = rec.run(
    'vendor-harness (offline)',
    process.execPath,
    ['scripts/vendor-harness.mjs', tarball, '--commit', harnessCommit],
    { cwd: dir, env: { ...process.env, npm_config_offline: 'true' } },
  );
  if (r.status !== 0)
    r = rec.must(
      'vendor-harness',
      process.execPath,
      ['scripts/vendor-harness.mjs', tarball, '--commit', harnessCommit],
      {
        cwd: dir,
      },
    );
  return r;
};
const installed = (dir) =>
  JSON.parse(readFileSync(join(dir, 'node_modules/devcontour-harness/package.json'), 'utf8'))
    .version;

/* ---------------------- шаги и признаки, как в upgrade-check ---------------------- */
const step = (consumer, name, dir, topology, arg) => {
  const r = rec.run(
    `${topology} ${name} ${arg ?? ''} @${consumer.split('/').pop()}`,
    process.execPath,
    [
      '--import',
      'tsx',
      join(consumer, 'scripts', 'rollback-scenario.ts'),
      name,
      dir,
      topology,
      ...(arg ? [arg] : []),
    ],
    { cwd: consumer },
  );
  if (r.status !== 0)
    throw new Error(`${topology} ${name} ${arg ?? ''}: ${(r.stderr || r.stdout).slice(-800)}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
};
const crashReview = (consumer, dir, topology, letter) => {
  const r = rec.run(
    `${topology} crash-review ${letter} @${consumer.split('/').pop()}`,
    process.execPath,
    [
      '--import',
      'tsx',
      join(harnessRoot, 'scripts/acceptance/devcontour-rollback-step.mjs'),
      'crash-review',
      dir,
      topology,
      letter,
    ],
    { cwd: consumer, env: { ...process.env, DEVCONTOUR_COPY: consumer } },
  );
  if (r.status !== 0) throw new Error(`crash-review: ${(r.stderr || r.stdout).slice(-800)}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
};
const databaseFiles = (dir) =>
  [join(dir, 'workspace', '.devcontour-local'), join(dir, 'product', '.devcontour-local')]
    .filter(existsSync)
    .flatMap((d) =>
      readdirSync(d)
        .filter((f) => /^state\.sqlite(-wal|-shm)?$/.test(f))
        .map((f) => join(d, f)),
    );
const backup = (dir, name) => {
  const target = join(dir, '..', name);
  for (const file of databaseFiles(dir)) {
    const to = join(target, file.slice(dir.length + 1));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(file, to);
  }
  return target;
};
const restore = (dir, copy) => {
  for (const file of databaseFiles(dir)) rmSync(file);
  for (const sub of ['workspace', 'product']) {
    const from = join(copy, sub, '.devcontour-local');
    if (!existsSync(from)) continue;
    for (const f of readdirSync(from))
      copyFileSync(join(from, f), join(dir, sub, '.devcontour-local', f));
  }
};
const refs = (dir) =>
  Object.fromEntries(
    ['product', 'workspace'].map((r) => [
      r,
      execFileSync('git', ['rev-parse', 'main'], { cwd: join(dir, r), encoding: 'utf8' }).trim(),
    ]),
  );
const reachable = (dir, sha) =>
  spawnSync('git', ['merge-base', '--is-ancestor', sha, 'main'], { cwd: join(dir, 'product') })
    .status === 0;
const tasksOf = (s) => Object.fromEntries(Object.entries(s.tasks).map(([k, v]) => [k, v.status]));

let failed = false;
const variant = (id, fn) => {
  const started = Date.now();
  try {
    const detail = fn();
    report.variants.push({ id, status: 'PASS', ms: Date.now() - started, ...detail });
    console.log('PASS ' + id);
    return true;
  } catch (error) {
    failed = true;
    report.variants.push({
      id,
      status: 'FAIL',
      ms: Date.now() - started,
      error: String(error.message ?? error).slice(0, 2000),
    });
    console.log('FAIL ' + id + ': ' + String(error.message ?? error).slice(0, 300));
    return false;
  }
};
const notRun = (id, reason) => report.variants.push({ id, status: 'NOT_RUN', reason });

/**
 * Прежняя версия над аварийным состоянием новой: отказ до записи либо
 * никакой записи и никакого перехвата живой роли новой версии.
 */
function oldOverCrash(oldC, newC, dir, topology, crash) {
  const write = step(oldC, 'write', dir, topology);
  const after = step(newC, 'read', dir, topology);
  if (!write.refusal) {
    same(write.databases, crash.databases, 'прежняя версия записала поверх состояния новой');
    same(after.leader, crash.leader, 'прежняя версия перехватила живую роль новой');
  } else same(write.databases, crash.databases, 'отказ прежней версии после записи');
  return { refusal: write.refusal ?? null, wrote: false, leaderKept: after.leader?.engineVersion };
}
/** Восстановление копии, сверка Git, повтор; история прежних задач и refs. */
function restoreAndRedo(newC, dir, topology, { copy, beforeCrash, crash, letter, history }) {
  const refsCrash = refs(dir);
  restore(dir, copy);
  const restored = step(newC, 'read', dir, topology);
  same(restored.databases, beforeCrash.databases, 'восстановленная копия отличается');
  check(
    restored.tasks['Task ' + letter].status !== 'done',
    `ложное принятие ${letter} после восстановления`,
  );
  same(refs(dir), refsCrash, 'восстановление базы сдвинуло Git refs');
  const drift = step(newC, 'reconcile', dir, topology);
  check(!drift.consistent, 'сверка не нашла принятие, о котором копия не знает');
  check(
    drift.unrecorded.some((c) => c.sha === crash.accepted.sha),
    'сверка не назвала коммит принятия новой версии',
  );
  const redo = step(newC, 'work', dir, topology, letter);
  check(redo.accepted.run !== crash.accepted.run, `повтор ${letter} — та же попытка`);
  check(reachable(dir, redo.accepted.sha), 'результат повтора не в main');
  const reconciled = step(newC, 'reconcile', dir, topology);
  check(reconciled.consistent, 'расхождение Git не закрыто повтором');
  for (const t of history) same(redo.tasks[t], beforeCrash.tasks[t], `история ${t} изменена`);
  check(!redo.leader, 'штатная остановка оставила роль');
  return { unrecorded: drift.unrecorded, redo: redo.accepted, main: reconciled.main };
}

try {
  const oldC = clone('consumer-old', values.commit);
  const newC = clone('consumer-new', values.commit);
  vendor(newC);
  const lock = JSON.parse(readFileSync(join(newC, 'package-lock.json'), 'utf8')).packages[
    'node_modules/devcontour-harness'
  ];
  check(lock.integrity === sha512Integrity(tarball), 'lock: integrity ≠ архив');
  check(installed(newC) === toVersion, 'установлена ' + installed(newC));
  const fromVersion = installed(oldC);
  report.versions = { from: fromVersion, to: toVersion };
  const midC = clone('consumer-mid', values.commit);
  const baseC = clone('consumer-baseline', values['baseline-commit']);
  copyFileSync(
    join(oldC, 'scripts', 'rollback-scenario.ts'),
    join(baseC, 'scripts', 'rollback-scenario.ts'),
  );
  report.versions.baseline = {
    devcontour: JSON.parse(readFileSync(join(baseC, 'package.json'), 'utf8')).version,
    harness: existsSync(join(baseC, 'node_modules/devcontour-harness/package.json'))
      ? installed(baseC)
      : null,
  };

  for (const topology of values.topologies.split(',')) {
    const root = join(work, 't42-' + topology);
    const dir = join(root, 'workspace-dir');
    mkdirSync(dir, { recursive: true });
    const id = (x) => `T42${x}-${topology}`;
    const want = new Set(values.variants.split(','));
    if (want.has('a') || want.has('b') || want.has('c')) {
      let init;
      const a = variant(id('a-interrupted-install'), () => {
        init = step(oldC, 'init', dir, topology);
        const refs0 = refs(dir);
        vendor(midC);
        const child = spawnSync(
          'sh',
          ['-c', 'npm ci --prefer-offline --no-audit --no-fund & sleep 2; kill -9 $!'],
          {
            cwd: midC,
            encoding: 'utf8',
          },
        );
        check(child.status === 0, 'прерывание установки не выполнено');
        const interrupted = step(oldC, 'read', dir, topology);
        same(interrupted.databases, init.databases, 'прерванная установка изменила базы');
        same(refs(dir), refs0, 'прерванная установка изменила Git refs');
        const firstOpen = step(newC, 'read', dir, topology);
        same(firstOpen.databases, init.databases, 'первое открытие новой версией переписало базы');
        return { tasks: tasksOf(firstOpen) };
      });
      const b =
        a &&
        variant(id('b-package-only'), () => {
          const workTo = step(newC, 'work', dir, topology, 'B');
          check(!workTo.leader, 'штатная остановка оставила роль controller');
          const back = step(oldC, 'read', dir, topology);
          same(back.databases, workTo.databases, 'чтение после отката пакета изменило базы');
          check(back.tasks['Task B'].status === 'done', 'принятие новой версии потеряно');
          const resumed = step(oldC, 'work', dir, topology, 'C');
          check(resumed.tasks['Task C'].status === 'done', 'прежняя версия не продолжила работу');
          const reconciled = step(oldC, 'reconcile', dir, topology);
          check(reconciled.consistent, 'Git расходится с базой после отката пакета');
          return { acceptedByNew: workTo.accepted, continuedByOld: resumed.accepted };
        });
      if (!a) notRun(id('b-package-only'), 'a failed');
      const c =
        b &&
        variant(id('c-compat-crash-restore'), () => {
          const copy = backup(dir, 'backup-before-crash');
          const beforeCrash = step(newC, 'read', dir, topology);
          const crash = step(newC, 'crash', dir, topology, 'D');
          check(crash.leader?.engineVersion === toVersion, 'роль без версии новой версии');
          const old = oldOverCrash(oldC, newC, dir, topology, crash);
          const rest = restoreAndRedo(newC, dir, topology, {
            copy,
            beforeCrash,
            crash,
            letter: 'D',
            history: ['Task A', 'Task B', 'Task C'],
          });
          return { old, ...rest };
        });
      if (!b) notRun(id('c-compat-crash-restore'), 'b failed');
      if (c)
        variant(id('c-review-format-crash-restore'), () => {
          const copy = backup(dir, 'backup-before-review-crash');
          const beforeCrash = step(newC, 'read', dir, topology);
          const crash = crashReview(newC, dir, topology, 'E');
          check(crash.reviewRounds > 0, 'в состоянии нет раунда ревью alpha.6');
          check(crash.leader?.engineVersion === toVersion, 'роль без версии новой версии');
          const old = oldOverCrash(oldC, newC, dir, topology, crash);
          const rest = restoreAndRedo(newC, dir, topology, {
            copy,
            beforeCrash,
            crash,
            letter: 'E',
            history: ['Task A', 'Task B', 'Task C', 'Task D'],
          });
          return { reviewRounds: crash.reviewRounds, old, ...rest };
        });
      else notRun(id('c-review-format-crash-restore'), 'c-compat failed');
    }
    // г. Откат DevContour к прежней версии после Git sync новой (новая — с архивом).
    const g = join(root, 'baseline-dir');
    mkdirSync(g, { recursive: true });
    if (want.has('d'))
      variant(id('d-devcontour-to-' + report.versions.baseline.devcontour), () => {
        const gInit = step(baseC, 'init', g, topology);
        const gSync = step(baseC, 'sync', g, topology);
        check(
          gSync.status === 'synchronized' && gSync.receiptsWithIdentity === 0,
          'sync прежней версии',
        );
        const gCopy = backup(g, 'backup-before-upgrade');
        const gBefore = step(baseC, 'read', g, topology);
        const upgraded = step(newC, 'work', g, topology, 'B');
        const newSync = step(newC, 'sync', g, topology);
        check(newSync.receiptsWithIdentity > 0, 'новая версия не выпустила receipt с тождеством');
        const oldRead = step(baseC, 'read', g, topology);
        const oldSync = step(baseC, 'sync-only', g, topology);
        check(
          oldRead.refusal || oldSync.result?.refusal || oldSync.result?.conflicts?.length,
          'прежняя версия продолжила над состоянием и receipts новой',
        );
        same(oldSync.databases, newSync.databases, 'отказ прежней версии после записи');
        restore(g, gCopy);
        for (const commit of newSync.committed) {
          const [repo, sha] = commit.split('@');
          execFileSync('git', ['revert', '--no-edit', sha], {
            cwd: join(g, repo),
            stdio: 'pipe',
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: 'Rollback check',
              GIT_AUTHOR_EMAIL: 'rollback-check@example.invalid',
              GIT_COMMITTER_NAME: 'Rollback check',
              GIT_COMMITTER_EMAIL: 'rollback-check@example.invalid',
            },
          });
        }
        const gRestored = step(baseC, 'read', g, topology);
        same(gRestored.databases, gBefore.databases, 'восстановленная копия отличается');
        const gResync = step(baseC, 'sync-only', g, topology);
        check(
          gResync.result?.status === 'synchronized' && !gResync.result.conflicts?.length,
          'прежняя версия не синхронизирует после revert: ' + JSON.stringify(gResync.result),
        );
        const gDrift = step(baseC, 'reconcile', g, topology);
        check(
          gDrift.unrecorded.some((c) => c.sha === upgraded.accepted.sha),
          'сверка не назвала принятие новой версии',
        );
        const gRedo = step(baseC, 'work', g, topology, 'B');
        const gDone = step(baseC, 'reconcile', g, topology);
        check(gDone.consistent, 'расхождение Git не закрыто повтором прежней версией');
        same(gRedo.tasks['Task A'], gInit.tasks['Task A'], 'история A изменена');
        return {
          refusal: (oldRead.refusal ?? JSON.stringify(oldSync.result)).slice(0, 300),
          reverted: newSync.committed,
          unrecorded: gDrift.unrecorded,
          redo: gRedo.accepted,
        };
      });
  }
} catch (error) {
  failed = true;
  rec.fail('исключение: ' + (error?.stack ?? String(error)));
} finally {
  report.status = failed || rec.failures.length ? 'FAIL' : 'PASS';
  report.failures = rec.failures;
  report.steps = rec.steps;
  writeReport(join(out, 'report.json'), report);
  console.log(
    `C02/T42 ${report.status}: ${report.variants.map((v) => v.id + '=' + v.status).join(' ')}; report ${join(out, 'report.json')}`,
  );
  if (!values.keep && report.status === 'PASS') rmSync(work, { recursive: true, force: true });
  else console.log('work dir kept: ' + work);
}
process.exit(report.status === 'PASS' ? 0 : 1);
