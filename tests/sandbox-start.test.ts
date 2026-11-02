import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';
import type { EvidenceRecord } from '../src/contracts/index.ts';
import { redactor } from '../src/environment/redaction.ts';
import { isolationSupport, srtShellLookup } from '../src/environment/isolation.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { runCheck, runGate, sandboxLaunchFailure } from '../src/verification/gates.ts';
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
      execution: { env, redact: redactor([]) },
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
    assert.match(
      never.evidence.summary,
      /^песочница ОС не запустила команду проверки \(попыток: 3\): проверка не исполнялась/,
    );
    assert.match(never.evidence.summary, /Shell 'bash' not found in PATH/, 'причина srt сохранена');
    // Обратная сверка: команда стартовала (после временного отказа) и упала — провал проверки.
    const failed = await gate(loaded(1, noShell()).env, 3);
    assert.equal(failed.evidence.passed, false);
    assert.equal(failed.failure?.kind, 'gate');
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

test(
  'Команда, стёршая свою метку старта и упавшая, — провал проверки: один запуск, без повторов',
  { skip: noSandbox },
  async () => {
    // Свой TMPDIR: команда стирает метки только этого теста.
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = realpathSync(mkdtempSync(join(tmpdir(), 'harness-marks-')));
    try {
      const r = repo();
      const runs = join(r.dir, 'runs.log');
      const script = `const fs = require('fs'), path = require('path');
fs.appendFileSync(${JSON.stringify(runs)}, 'x');
const up = path.dirname(process.env.TMPDIR);
for (const d of fs.readdirSync(up).filter((n) => n.startsWith('dc-start-')))
  try { fs.rmSync(path.join(up, d, 'started')); } catch {}
process.exit(1);`;
      const g = await gate(process.env, 1, script, r);
      assert.equal(readFileSync(runs, 'utf8'), 'x', 'команда исполнена один раз');
      assert.equal(g.evidence.passed, false);
      assert.equal(g.failure?.kind, 'gate', g.evidence.summary);
      assert.match(g.evidence.summary, /^Код выхода 1/);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  },
);

test('Токен старта не попадает в вывод проверки', { skip: noSandbox }, async () => {
  const file = out();
  const r = await check(process.env, file);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '', 'служебная строка обёртки убрана');
  assert.equal(r.started, true);
});

test('Отказ среды — только известные отказы запуска самой песочницы, а не любой текст srt', () => {
  for (const text of [
    "Error: Shell 'bash' not found in PATH\n    at wrap (file.js:1:1)",
    "Shell 'zsh' not found in PATH",
    'Failed to execute command: spawn /bin/sh EAGAIN',
  ])
    assert.match(text, sandboxLaunchFailure, text);
  for (const text of [
    "bwrap: Can't mkdir /tmp/x/.idea: Permission denied",
    'sandbox-exec: syntax error in profile',
    "echo: Shell 'bash' not found in PATH, try again",
    '',
  ])
    assert.doesNotMatch(text, sandboxLaunchFailure, text);
});
