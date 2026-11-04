import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';
import type { EvidenceRecord } from '../src/contracts/index.ts';
import { redactor } from '../src/environment/redaction.ts';
import {
  SRT_REMOVING_PREFIX,
  SRT_STALE_MS,
  SandboxPolicyError,
  isolationSupport,
  srtShellLookup,
  srtSocketsFit,
  srtTempBase,
  srtTempDir,
  sweepStaleSrtDirs,
} from '../src/environment/isolation.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import {
  checkCleanup,
  runCheck,
  runGate,
  sandboxLaunchFailure,
  startTokenFilter,
} from '../src/verification/gates.ts';
import { ReviewProbes, type ProbeSpec } from '../src/agents/review-probe.ts';
import { repo } from './git-fixture.ts';

/**
 * Запуск песочницы проверки не зависит от нагрузки машины.
 *
 * sandbox-runtime ищет shell через `spawnSync('which', …, { timeout: 1000 })`;
 * под нагрузкой этот вызов истекает, и srt выходит до запуска команды.
 * Нагрузка здесь подставная: процессу srt через NODE_OPTIONS предзагружается
 * `spawnSync('which', ['bash'])`, который истекает первые `failures` раз, а
 * потом находит `/bin/bash`. Настоящая нагрузка не нужна.
 */
const support = isolationSupport();
const noSandbox = support.ok ? false : 'песочница ОС недоступна: ' + support.detail;
const os = { config: { isolation: { mode: 'os' as const, domains: [] } } };
const whichModule = createRequire(import.meta.url).resolve(
  '@anthropic-ai/sandbox-runtime/dist/utils/which.js',
);

const fakeWhich =
  'data:text/javascript,' +
  encodeURIComponent(`
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';
const original = cp.spawnSync;
cp.spawnSync = function spawnSync(command, args) {
  if (command !== 'which' || args?.[0] !== 'bash') return original.apply(this, arguments);
  appendFileSync(process.env.FAKE_WHICH_LOG, 'x');
  if (readFileSync(process.env.FAKE_WHICH_LOG, 'utf8').length > Number(process.env.FAKE_WHICH_FAILURES))
    return { pid: 0, output: [null, '/bin/bash\\n', ''], stdout: '/bin/bash\\n', stderr: '', status: 0, signal: null };
  const error = Object.assign(new Error('spawnSync which ETIMEDOUT'), { code: 'ETIMEDOUT' });
  return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: null, signal: 'SIGTERM', error };
};
syncBuiltinESMExports();
`);
/** Окружение с подставным `which`; `calls()` — сколько раз его спросили о bash. */
function loaded(failures: number, path: string) {
  const log = join(realpathSync(mkdtempSync(join(tmpdir(), 'harness-which-'))), 'calls');
  writeFileSync(log, '');
  return {
    env: {
      ...process.env,
      PATH: path,
      NODE_OPTIONS: `--import ${fakeWhich}`,
      FAKE_WHICH_LOG: log,
      FAKE_WHICH_FAILURES: String(failures),
    },
    calls: () => readFileSync(log, 'utf8').length,
  };
}
/**
 * PATH без shell: `srtShellLookup` его не находит, и вопрос доходит до
 * подставного `which`. Остальное, что srt вызывает по имени, — на месте.
 */
const shellless: string[] = [];
function noShell() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-noshell-')));
  shellless.push(dir);
  for (const name of ['env', 'sandbox-exec', 'bwrap', 'socat']) {
    const found = ['/usr/bin', '/bin', ...(process.env.PATH ?? '').split(delimiter)]
      .map((d) => join(d, name))
      .find((f) => {
        try {
          accessSync(f, constants.X_OK);
          return statSync(f).isFile();
        } catch {
          return false;
        }
      });
    if (found) symlinkSync(found, join(dir, name));
  }
  return dir;
}

/** srt-овский поиск shell в отдельном процессе Node, с предзагрузкой или без. */
function srtWhich(env: NodeJS.ProcessEnv, names: string[], preload: boolean, cwd?: string) {
  const script = `import { whichSync } from ${JSON.stringify(whichModule)};
process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map((n) => whichSync(n))));`;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [...(preload ? ['--import', srtShellLookup] : []), '--input-type=module', '-e', script],
      { env, encoding: 'utf8', ...(cwd ? { cwd } : {}) },
    ),
  ) as (string | null)[];
}

test('Поиск shell для srt не порождает `which`; не найденное в PATH решает настоящий `which`', () => {
  // Настоящий медленный `which` первым в PATH: дольше секунды srt не ждёт.
  const slow = realpathSync(mkdtempSync(join(tmpdir(), 'harness-which-')));
  writeFileSync(join(slow, 'which'), '#!/bin/sh\nsleep 3\nexec /usr/bin/which "$@"\n');
  chmodSync(join(slow, 'which'), 0o755);
  const env = { ...process.env, PATH: [slow, '/bin', '/usr/bin'].join(delimiter) };
  // Обратная сверка: без предзагрузки медленный `which` воспроизводит отказ.
  assert.deepEqual(srtWhich(env, ['bash'], false), [null], 'без предзагрузки — «не найден»');
  assert.deepEqual(srtWhich(env, ['bash', '/bin/sh'], true), ['/bin/bash', '/bin/sh']);
  // Чего нет в PATH, подмена не выдумывает: ответ за `spawnSync('which')`.
  const fake = loaded(1, noShell());
  assert.deepEqual(srtWhich(fake.env, ['bash'], true), [null], 'истёкший `which` — не найден');
  assert.deepEqual(srtWhich(fake.env, ['bash'], true), ['/bin/bash']);
  assert.equal(fake.calls(), 2);
});

test('Подмена ищет shell только среди исполняемых файлов в абсолютных каталогах PATH', () => {
  const dir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `harness-${name}-`)));
  const shell = (at: string, mode = 0o755) => {
    writeFileSync(join(at, 'bash'), '#!/bin/sh\n');
    chmodSync(join(at, 'bash'), mode);
  };
  // Каждый отказ подмены доходит до подставного `which`, который всегда истекает.
  const rejects = (path: string, cwd?: string) => {
    const fake = loaded(99, path);
    assert.deepEqual(srtWhich(fake.env, ['bash'], true, cwd), [null], path);
    assert.equal(fake.calls(), 1, `${path}: вопрос ушёл к \`which\``);
  };
  const plain = dir('plain');
  shell(plain, 0o644);
  rejects(plain);
  const folder = dir('folder');
  mkdirSync(join(folder, 'bash'));
  rejects(folder);
  // Пустой и относительный элементы PATH указывают на текущий каталог — дерево проверки.
  const cwd = dir('cwd');
  shell(cwd);
  mkdirSync(join(cwd, 'rel'));
  shell(join(cwd, 'rel'));
  rejects(['', 'rel', '.'].join(delimiter), cwd);
  // Обратная сверка: исполняемый файл в абсолютном каталоге находится без `which`.
  const good = dir('good');
  shell(good);
  const fake = loaded(99, [plain, folder, 'rel', good].join(delimiter));
  assert.deepEqual(srtWhich(fake.env, ['bash', 'rel/bash'], true, cwd), [join(good, 'bash'), null]);
  assert.equal(fake.calls(), 0, 'bash найден подменой; rel/bash подмена не ищет');
});

const out = () => join(realpathSync(mkdtempSync(join(tmpdir(), 'harness-start-out-'))), 'ran');
const check = (env: NodeJS.ProcessEnv, file: string) =>
  runCheck(os, {
    argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(file)}, 'x')`],
    cwd: realpathSync(mkdtempSync(join(tmpdir(), 'harness-start-cwd-'))),
    env,
    signal: new AbortController().signal,
    write: [join(file, '..')],
    // Каталог PATH без shell должен читаться и внутри песочницы.
    readable: shellless,
    controller: [],
    settingsDir: mkdtempSync(join(tmpdir(), 'harness-start-settings-')),
  });

test(
  'Проверка в песочнице стартует с первой попытки, даже когда `which` всегда истекает',
  { skip: noSandbox },
  async () => {
    const file = out();
    const fake = loaded(99, process.env.PATH ?? '');
    const r = await check(fake.env, file);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(file), true, 'команда исполнилась');
    assert.equal(r.attempts, 1, 'без повторов');
    assert.equal(r.started, true);
    assert.equal(r.notStarted, false);
    assert.equal(fake.calls(), 0, 'shell найден без `which`');
  },
);

test(
  'Временный отказ запуска песочницы повторяется до старта; постоянный — проверка не стартовала',
  { skip: noSandbox },
  async () => {
    const file = out();
    const once = loaded(1, noShell());
    const r = await check(once.env, file);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(file), true);
    assert.equal(r.attempts, 2);
    assert.equal(r.started, true);
    assert.equal(r.notStarted, false);

    const never = out();
    const f = await check(loaded(99, noShell()).env, never);
    assert.notEqual(f.code, 0);
    assert.equal(existsSync(never), false, 'команда не исполнялась');
    assert.equal(f.attempts, 3);
    assert.equal(f.started, false);
    assert.equal(f.notStarted, true);
    assert.match(f.stderr, /Shell 'bash' not found in PATH/);
  },
);

async function gate(
  env: NodeJS.ProcessEnv,
  code: number,
  script = `process.exit(${code})`,
  r = repo(),
  redact = redactor([]),
) {
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  let failure: TaskFailure | undefined;
  try {
    await runGate({
      policy: os.config,
      record: (e) => {
        recorded.push(e);
        return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
      },
      cwd: r.dir,
      sha: r.head(),
      phase: 'candidate',
      gate: {
        id: 'unit',
        kind: 'check',
        timeoutMs: 20000,
        command: [process.execPath, '-e', script],
      },
      artifactDir: mkdtempSync(join(tmpdir(), 'harness-art-')),
      signal: new AbortController().signal,
      execution: { env, redact },
      boundary: { hidden: [], readable: shellless },
    });
  } catch (error) {
    if (!(error instanceof TaskFailure)) throw error;
    failure = error;
  }
  return { failure, evidence: recorded[0]! };
}

test(
  'Gate, который песочница так и не запустила, — отказ среды, а не провал проекта; стартовавшая команда судится по исходу',
  { skip: noSandbox },
  async () => {
    const never = await gate(loaded(99, noShell()).env, 0);
    assert.equal(never.evidence.passed, false, 'не запущенная проверка не проходит');
    assert.equal(never.failure?.kind, 'environment');
    assert.equal(never.failure?.diagnosis, 'sandbox-launch');
    assert.match(
      never.evidence.summary,
      /^песочница ОС не запустила команду проверки \(попыток: 3\): проверка не исполнялась/,
    );
    assert.match(never.evidence.summary, /Shell 'bash' not found in PATH/, 'причина srt сохранена');
    // Обратная сверка: команда стартовала (после временного отказа) и упала — провал проверки.
    const failed = await gate(loaded(1, noShell()).env, 3);
    assert.equal(failed.evidence.passed, false);
    assert.equal(failed.failure?.kind, 'gate');
    assert.equal(failed.failure?.diagnosis, undefined);
    assert.match(failed.evidence.summary, /^Код выхода 3/);
    const ok = await gate(loaded(1, noShell()).env, 0);
    assert.equal(ok.evidence.passed, true, ok.evidence.summary);
  },
);

test(
  'Команда reviewer, которую песочница так и не запустила, — ошибка среды, а не провал',
  { skip: noSandbox },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-probe-')));
    const spec: ProbeSpec = {
      cwd: root,
      controller: [],
      readable: [root, ...shellless],
      isolation: { mode: 'os', domains: [] },
      commandTimeoutMs: 20000,
      budgetMs: 120000,
      deadline: Date.now() + 600000,
      env: ['PATH', 'NODE_OPTIONS', 'FAKE_WHICH_LOG', 'FAKE_WHICH_FAILURES'],
      secrets: [],
      settingsDir: join(root, 'settings'),
      log: join(root, 'probes.jsonl'),
    };
    const run = (failures: number) =>
      new ReviewProbes(spec, undefined, loaded(failures, noShell()).env).run({
        argv: [process.execPath, '-e', 'process.exit(0)'],
      });
    const never = await run(99);
    assert.equal(never.status, 'error');
    assert.equal(never.failure, 'environment');
    assert.match(never.note ?? '', /^Песочница ОС не запустила команду \(попыток: 3\)/);
    // Обратная сверка: после временного отказа команда стартует и проходит.
    const once = await run(1);
    assert.equal(once.status, 'passed', once.stderr);
    assert.equal(once.failure, undefined);
  },
);

/** Собственный TMPDIR на время `fn`: команда стирает метки только этого теста. */
async function ownTmp<T>(fn: () => Promise<T>) {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = realpathSync(mkdtempSync(join(tmpdir(), 'hm-')));
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}
/**
 * Команда, которая стирает свою метку старта, печатает отказ srt и падает:
 * так она выдавала бы себя за не запущенную песочницей.
 */
const forger = (runs?: string) => `const fs = require('fs'), path = require('path');
${runs ? `fs.appendFileSync(${JSON.stringify(runs)}, 'x');` : ''}
const up = path.dirname(process.env.TMPDIR);
for (const d of fs.readdirSync(up).filter((n) => n.startsWith('dc-start-')))
  try { fs.rmSync(path.join(up, d, 'started')); } catch {}
console.error("Error: Shell 'bash' not found in PATH");
process.exit(1);`;
const signature = "Error: Shell 'bash' not found in PATH";

test(
  'Команда, стёршая свою метку старта и напечатавшая отказ srt, — провал проверки: один запуск; маска не задевает токен',
  { skip: noSandbox },
  () =>
    ownTmp(async () => {
      // Секрет из одной шестнадцатеричной цифры: маска до поиска токена
      // разрезала бы его, и старт не узнавался.
      const redact = redactor(['1']);
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-forger-')));
      const runs = join(dir, 'runs.log');
      const r = await runCheck(os, {
        argv: [process.execPath, '-e', forger(runs)],
        cwd: dir,
        env: process.env,
        redact,
        signal: new AbortController().signal,
        write: [dir],
        readable: [],
        controller: [],
        settingsDir: mkdtempSync(join(tmpdir(), 'harness-start-settings-')),
      });
      assert.equal(readFileSync(runs, 'utf8'), 'x', 'команда исполнена один раз');
      assert.equal(r.attempts, 1);
      assert.equal(r.started, true);
      assert.equal(r.notStarted, false);
      assert.equal(r.launchFailed, false);
      assert.equal(r.stderr.trim(), signature, 'в выводе нет ни токена, ни его обрывков');

      const repository = repo();
      const gateRuns = join(repository.dir, 'runs.log');
      const g = await gate(process.env, 1, forger(gateRuns), repository, redact);
      assert.equal(readFileSync(gateRuns, 'utf8'), 'x', 'gate исполнен один раз');
      assert.equal(g.evidence.passed, false);
      assert.equal(g.failure?.kind, 'gate', g.evidence.summary);
      // Код «1» маскируется секретом «1» — это маска, а не токен.
      assert.match(
        g.evidence.summary,
        /^Код выхода \[REDACTED\]: Error: Shell 'bash' not found in PATH$/,
      );
      // Первая строка лога — заголовок с путями; вывод и итог — после неё.
      const body = readFileSync(g.evidence.log, 'utf8').split('\n').slice(1).join('\n');
      assert.doesNotMatch(body, /[0-9a-f]{6,}/, 'обрывков токена в логе нет');
    }),
);

test(
  'Проба reviewer, стёршая метку и напечатавшая отказ srt, — провал команды, а не ошибка среды',
  { skip: noSandbox },
  () =>
    ownTmp(async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-probe-')));
      const spec: ProbeSpec = {
        cwd: root,
        controller: [],
        readable: [root],
        isolation: { mode: 'os', domains: [] },
        commandTimeoutMs: 20000,
        budgetMs: 120000,
        deadline: Date.now() + 600000,
        env: ['PATH', 'HARNESS_TEST_HEX_SECRET'],
        secrets: ['HARNESS_TEST_HEX_SECRET'],
        settingsDir: join(root, 'settings'),
        log: join(root, 'probes.jsonl'),
      };
      const r = await new ReviewProbes(spec, undefined, {
        ...process.env,
        HARNESS_TEST_HEX_SECRET: '1',
      }).run({ argv: [process.execPath, '-e', forger()] });
      assert.equal(r.status, 'failed', r.note);
      assert.equal(r.failure, undefined);
      assert.equal(r.exitCode, 1);
      assert.equal(r.stderr.trim(), signature);
    }),
);

test('Токен старта не попадает в вывод проверки', { skip: noSandbox }, async () => {
  const file = out();
  const r = await check(process.env, file);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '', 'служебная строка обёртки убрана');
  assert.equal(r.started, true);
});

test('Отказ среды — только stderr из одних известных отказов запуска песочницы', () => {
  for (const text of [
    "Error: Shell 'bash' not found in PATH",
    "Error: Shell 'zsh' not found in PATH\n",
    'Failed to execute command: spawn /bin/sh EAGAIN',
  ])
    assert.equal(sandboxLaunchFailure(text), true, text);
  for (const text of [
    "bwrap: Can't mkdir /tmp/x/.idea: Permission denied",
    'sandbox-exec: syntax error in profile',
    "echo: Shell 'bash' not found in PATH, try again",
    "Shell 'bash' not found in PATH",
    // Строка отказа внутри другого вывода — не отказ запуска.
    "candidate output\nError: Shell 'bash' not found in PATH",
    "Error: Shell 'bash' not found in PATH\n    at wrap (file.js:1:1)",
    'Failed to execute command: ',
    '',
  ])
    assert.equal(sandboxLaunchFailure(text), false, text);
});

test('Токен старта вырезается из сырого потока на любом стыке кусков и только один раз', () => {
  const token = 'ab12cd34';
  const line = `pre\n${token}\npost ${token}\n`;
  for (let cut = 0; cut <= line.length; cut++) {
    let seen = 0;
    const filter = startTokenFilter(token, () => seen++);
    const out = filter(line.slice(0, cut), false) + filter(line.slice(cut), true);
    assert.equal(out, `pre\npost ${token}\n`, `стык ${cut}`);
    assert.equal(seen, 1);
  }
  // Начало токена без конца отдаётся целиком в последнем куске.
  const filter = startTokenFilter(token, () => assert.fail('токена не было'));
  assert.equal(filter('x ab12', false) + filter('', true), 'x ab12');
});

/** Глубокий TMPDIR: путь сокета srt в нём длиннее предела unix-сокета. */
const deepTmp = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-deep-')));
  const deep = join(root, 'd'.repeat(60), 'e'.repeat(60));
  mkdirSync(deep, { recursive: true });
  return { root, deep };
};

test('srtTempDir: короткий TMPDIR — как есть; глубокий — свой каталог 0700 под /tmp; иначе отказ среды с TMPDIR', async () => {
  assert.deepEqual(await srtTempDir('/tmp', 'darwin'), { dir: '/tmp', created: false });
  const { root, deep } = deepTmp();
  try {
    assert.equal(srtSocketsFit(deep, 'darwin'), false);
    assert.equal(srtSocketsFit(deep, 'linux'), false);
    // Платформа без предела sun_path в таблице — каталог как есть.
    assert.deepEqual(await srtTempDir(deep, 'win32'), { dir: deep, created: false });
    for (const platform of ['darwin', 'linux'] as const) {
      const short = await srtTempDir(deep, platform);
      try {
        assert.equal(short.created, true);
        assert.notEqual(short.dir, deep);
        assert.equal(realpathSync(short.dir), short.dir);
        assert.ok(
          short.dir.startsWith(realpathSync('/tmp') + `/dc-srt-${process.pid}-`),
          short.dir,
        );
        assert.equal(statSync(short.dir).mode & 0o777, 0o700);
        assert.equal(srtSocketsFit(short.dir, platform), true);
      } finally {
        if (short.created && short.dir.includes('/dc-srt-')) await checkCleanup.remove(short.dir);
      }
    }
    // Короткий каталог недоступен или сам слишком глубокий — отказ среды до запуска.
    await assert.rejects(
      srtTempDir(deep, 'darwin', join(root, 'missing')),
      (e: unknown) =>
        e instanceof SandboxPolicyError &&
        /TMPDIR/.test(e.message) &&
        e.message.includes(deep) &&
        /недоступен/.test(e.message),
    );
    await assert.rejects(
      srtTempDir(deep, 'darwin', deep),
      (e: unknown) => e instanceof SandboxPolicyError && /тоже слишком длинный/.test(e.message),
    );
    assert.deepEqual(
      execFileSync('find', [deep, '-name', 'dc-srt-*']).toString(),
      '',
      'отвергнутый каталог убран',
    );
  } finally {
    if (root.includes('harness-deep-')) await checkCleanup.remove(root);
  }
});

test(
  'Проверка в песочнице стартует при глубоком TMPDIR; короткий каталог srt убирается',
  { skip: noSandbox },
  async () => {
    const { root, deep } = deepTmp();
    const saved = process.env.TMPDIR;
    const original = checkCleanup.remove;
    const removed: string[] = [];
    checkCleanup.remove = (dir) => (removed.push(dir), original(dir));
    try {
      const file = out();
      process.env.TMPDIR = deep;
      const r = await runCheck(os, {
        argv: [
          process.execPath,
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(file)}, process.env.TMPDIR)`,
        ],
        cwd: realpathSync(mkdtempSync(join(tmpdir(), 'harness-start-cwd-'))),
        env: loaded(0, process.env.PATH ?? '').env,
        signal: new AbortController().signal,
        write: [join(file, '..')],
        readable: shellless,
        controller: [],
        settingsDir: mkdtempSync(join(tmpdir(), 'harness-start-settings-')),
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.started, true);
      assert.doesNotMatch(r.stderr, /EINVAL/);
      // Команде — её scratch под глубоким TMPDIR, а не короткий каталог srt.
      const inner = readFileSync(file, 'utf8');
      assert.ok(inner.startsWith(deep + '/dc-gate-'), inner);
      assert.ok(!inner.includes('dc-srt-'), inner);
      const srt = removed.filter((d) => d.includes('/dc-srt-'));
      assert.equal(srt.length, 1, removed.join(', '));
      assert.equal(existsSync(srt[0]!), false, 'каталог srt убран');
    } finally {
      process.env.TMPDIR = saved;
      if (saved === undefined) delete process.env.TMPDIR;
      checkCleanup.remove = original;
      if (root.includes('harness-deep-')) await original(root);
    }
  },
);

test(
  'Gate при глубоком TMPDIR без короткого каталога srt — отказ среды до запуска, с TMPDIR в тексте',
  { skip: noSandbox },
  async () => {
    const { root, deep } = deepTmp();
    const saved = process.env.TMPDIR;
    const short = srtTempBase.short;
    // Маркер — в дереве проверки, куда gate может писать: обратная сверка
    // ниже показывает, что та же команда его создаёт, когда песочница стартует.
    const r0 = repo();
    const marker = join(r0.dir, 'ran');
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`;
    try {
      srtTempBase.short = join(root, 'missing');
      process.env.TMPDIR = deep;
      const r = await gate(loaded(0, process.env.PATH ?? '').env, 0, script, r0);
      assert.equal(r.evidence.passed, false);
      assert.equal(r.failure?.kind, 'environment');
      assert.match(r.evidence.summary, /TMPDIR/);
      assert.match(r.evidence.summary, /недоступен/);
      assert.match(r.evidence.summary, /Задайте более короткий TMPDIR/);
      assert.ok(r.evidence.summary.includes(deep), r.evidence.summary);
      assert.equal(existsSync(marker), false, 'команда не запускалась');
      // Обратная сверка: с доступным коротким каталогом та же команда пишет маркер.
      srtTempBase.short = short;
      const ok = await gate(loaded(0, process.env.PATH ?? '').env, 0, script, r0);
      assert.equal(ok.evidence.passed, true, ok.evidence.summary);
      assert.equal(existsSync(marker), true, 'маркер доступен команде на запись');
    } finally {
      srtTempBase.short = short;
      process.env.TMPDIR = saved;
      if (saved === undefined) delete process.env.TMPDIR;
      if (root.includes('harness-deep-')) await checkCleanup.remove(root);
    }
  },
);

/** Pid завершившегося процесса: потомок убит и дождан; ESRCH проверен. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await new Promise((resolve) => child.once('spawn', resolve));
  const pid = child.pid!;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  try {
    process.kill(pid, 0);
    return undefined; // pid уже занят другим процессом
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? pid : undefined;
  }
}

test('sweepStaleSrtDirs: убирает только свои старые каталоги srt завершившихся процессов', async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-srt-sweep-')));
  try {
    const dead = await deadPid();
    if (dead === undefined) return t.skip('pid завершившегося потомка уже занят');
    const old = (Date.now() - SRT_STALE_MS - 60_000) / 1000;
    const make = (name: string, age = old, inner = age) => {
      const path = join(base, name);
      mkdirSync(path);
      writeFileSync(join(path, 's.sock'), '');
      utimesSync(join(path, 's.sock'), inner, inner);
      utimesSync(path, age, age);
      return path;
    };
    const stale = make(`dc-srt-${dead}-aB3dE9`);
    const fresh = make(`dc-srt-${dead}-fResh1`, Date.now() / 1000);
    // Свежая запись внутри старого каталога: srt, переживший controller.
    const orphan = make(`dc-srt-${dead}-orphan`, old, Date.now() / 1000);
    const live = make(`dc-srt-${process.ppid}-live01`);
    const own = make(`dc-srt-${process.pid}-own001`);
    // Pid вне pid_t и вне безопасных целых — запись остаётся.
    const big = make(`dc-srt-${2 ** 31}-big001`);
    const huge = make(`dc-srt-99999999999999999999-huge01`);
    const other = make(`dc-other-${dead}-aB3dE9`);
    const odd = make(`dc-srt-${dead}-toolong7`);
    // Symlink с подходящим именем не удаляется и не разыменовывается.
    const target = make('target');
    symlinkSync(target, join(base, `dc-srt-${dead}-link01`));
    const file = join(base, `dc-srt-${dead}-file01`);
    writeFileSync(file, '');
    utimesSync(file, old, old);
    // pid 1 есть всегда: root видит его живым, не root получает EPERM — тоже живой.
    const init = make('dc-srt-1-init01');

    assert.deepEqual((await sweepStaleSrtDirs(base)).sort(), [stale]);
    assert.equal(existsSync(stale), false);
    // Удаление шло через переименование: промежуточного каталога не осталось.
    assert.deepEqual(
      readdirSync(base).filter((n) => n.startsWith(SRT_REMOVING_PREFIX)),
      [],
    );
    for (const kept of [fresh, orphan, live, own, big, huge, other, odd, target, file])
      assert.equal(existsSync(kept), true, kept);
    assert.equal(existsSync(join(target, 's.sock')), true);
    assert.equal(existsSync(join(base, `dc-srt-${dead}-link01`)), true);
    assert.equal(existsSync(init), true, 'pid 1 жив');
    // Нет каталога — пусто, без исключения.
    assert.deepEqual(await sweepStaleSrtDirs(join(base, 'missing')), []);
  } finally {
    if (base.includes('harness-srt-sweep-')) await checkCleanup.remove(base);
  }
});
