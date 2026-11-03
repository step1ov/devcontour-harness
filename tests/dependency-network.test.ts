/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тесты правят сырой JSON политики до разбора схемой.
 */
/**
 * Отказ установки зависимостей по сети или реестру пакетов — `environment` с
 * причиной `dependency-network`, а не провал проекта (`gate`). Выводы —
 * синтетические, по образцу сообщений pnpm, npm и yarn; файлы A1–A3 и real-* —
 * записанный вывод pnpm 10 и npm 11 (подделки и настоящий отказ локального
 * реестра; пути обезличены).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvidenceRecord, GatePolicy } from '../src/contracts/index.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { ReviewProbes, type ProbeGate } from '../src/agents/review-probe.ts';
import {
  isDependencyInstall,
  registryFailureLine,
  untrustedInputs,
} from '../src/environment/dependency-network.ts';
import { runSteps } from '../src/environment/lifecycle.ts';
import { redactor } from '../src/environment/redaction.ts';
import { classifyFailure } from '../src/engine/classify.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { diagnoseState } from '../src/explain/diagnose.ts';
import { runGate } from '../src/verification/gates.ts';
import { repo, write } from './git-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { candidate, probeSpecFor } from './probe-fixture.ts';
import { approve, bin, greet, implement } from './runner-fixture.ts';

const pnpm = ['pnpm', 'install', '--frozen-lockfile'];
const npmCi = ['npm', 'ci'];

/** Сетевые отказы реестра: pnpm, npm и yarn. */
const network: Record<string, [string[], string]> = {
  'pnpm 403': [
    pnpm,
    [
      'Lockfile is up to date, resolution step is skipped',
      'Progress: resolved 1, reused 0, downloaded 0, added 0',
      ' ERR_PNPM_FETCH_403  GET https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz: Forbidden - 403',
      '',
      'No authorization header was set for the request.',
    ].join('\n'),
  ],
  'pnpm meta fetch, DNS': [
    pnpm,
    ' ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/left-pad: request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org',
  ],
  'pnpm retries, then socket reset': [
    ['pnpm', 'i'],
    [
      ' WARN  GET https://registry.npmjs.org/left-pad error (ECONNRESET). Will retry in 10 seconds. 2 retries left.',
      ' WARN  GET https://registry.npmjs.org/left-pad error (ECONNRESET). Will retry in 1 minute. 1 retries left.',
      ' ERR_PNPM_ECONNRESET  request to https://registry.npmjs.org/left-pad failed, reason: socket hang up',
    ].join('\n'),
  ],
  'pnpm TLS issuer': [
    ['/usr/local/bin/pnpm', '-C', 'app', 'install'],
    ' ERR_PNPM_UNABLE_TO_GET_ISSUER_CERT_LOCALLY  request to https://registry.npmjs.org/left-pad failed, reason: unable to get local issuer certificate',
  ],
  'pnpm 503 with colour': [
    ['corepack', 'pnpm', 'install'],
    '\u001b[31m ERR_PNPM_FETCH_503\u001b[39m  GET https://registry.npmjs.org/left-pad: Service Unavailable - 503',
  ],
  'npm 403': [
    npmCi,
    [
      'npm error code E403',
      'npm error 403 403 Forbidden - GET https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
      'npm error 403 In most cases, you or one of your dependencies are requesting',
      'npm error 403 a package version that is forbidden by your security policy, or',
      'npm error A complete log of this run can be found in: /home/u/.npm/_logs/2026-11-03T10_00_00_000Z-debug-0.log',
    ].join('\n'),
  ],
  'npm 429, legacy prefix': [
    ['npm', 'install'],
    'npm ERR! code E429\nnpm ERR! 429 Too Many Requests - GET https://registry.npmjs.org/left-pad',
  ],
  'npm ETIMEDOUT': [
    npmCi,
    [
      'npm error code ETIMEDOUT',
      'npm error errno ETIMEDOUT',
      'npm error network request to https://registry.npmjs.org/left-pad failed, reason: connect ETIMEDOUT 104.16.0.35:443',
      'npm error network This is a problem related to network connectivity.',
    ].join('\n'),
  ],
  'npm EAI_AGAIN': [
    npmCi,
    'npm error code EAI_AGAIN\nnpm error syscall getaddrinfo\nnpm error errno EAI_AGAIN\nnpm error request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org',
  ],
  'npm self-signed proxy': [
    ['npm', '--prefix', 'app', 'ci'],
    'npm error code SELF_SIGNED_CERT_IN_CHAIN\nnpm error errno SELF_SIGNED_CERT_IN_CHAIN\nnpm error request to https://registry.npmjs.org/left-pad failed, reason: self-signed certificate in certificate chain',
  ],
  'npm ERR_SSL': [
    npmCi,
    'npm error code ERR_SSL_WRONG_VERSION_NUMBER\nnpm error request to https://registry.npmjs.org/left-pad failed, reason: ssl3_get_record:wrong version number',
  ],
  'yarn DNS': [
    ['yarn', '--frozen-lockfile'],
    'error An unexpected error occurred: "https://registry.yarnpkg.com/left-pad: getaddrinfo ENOTFOUND registry.yarnpkg.com".',
  ],
  'yarn TLS before handshake': [
    ['yarn', 'install'],
    'error An unexpected error occurred: "https://registry.yarnpkg.com/left-pad: Client network socket disconnected before secure TLS connection was established".',
  ],
};

/** Ошибки проекта: при них — `gate`, даже рядом с сетевыми строками. */
const project: Record<string, [string[], string]> = {
  'pnpm outdated lockfile': [
    pnpm,
    ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json',
  ],
  'pnpm no matching version': [
    pnpm,
    ' ERR_PNPM_NO_MATCHING_VERSION  No matching version found for left-pad@99.0.0',
  ],
  'pnpm 404': [
    pnpm,
    ' ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/left-pad-typo: Not Found - 404',
  ],
  'pnpm peer dependencies': [
    pnpm,
    ' ERR_PNPM_PEER_DEP_ISSUES  Unmet peer dependencies\n\n└─┬ react-dom 18.2.0\n  └── ✕ missing peer react@"^18.2.0"',
  ],
  'pnpm postinstall failure': [
    pnpm,
    [
      '. postinstall$ node scripts/postinstall.js',
      '│ Error: build failed',
      '└─ Failed in 52ms at /work/app',
      ' ELIFECYCLE  Command failed with exit code 1.',
    ].join('\n'),
  ],
  'pnpm lockfile error after network warning': [
    pnpm,
    [
      ' WARN  GET https://registry.npmjs.org/left-pad error (ECONNRESET). Will retry in 10 seconds. 2 retries left.',
      ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json',
    ].join('\n'),
  ],
  'pnpm unknown code with network warning': [
    pnpm,
    [
      ' WARN  GET https://registry.npmjs.org/left-pad error (ETIMEDOUT). Will retry in 10 seconds. 2 retries left.',
      ' ERR_PNPM_UNEXPECTED_STORE  Unexpected store location',
    ].join('\n'),
  ],
  'npm 404': [
    npmCi,
    "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/left-pad-typo - Not found\nnpm error 404  'left-pad-typo@^1.0.0' is not in this registry.",
  ],
  'npm no target version': [
    ['npm', 'install'],
    'npm error code ETARGET\nnpm error notarget No matching version found for left-pad@99.0.0.',
  ],
  'npm peer conflict': [
    ['npm', 'install'],
    'npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree',
  ],
  'npm ci lockfile mismatch': [
    npmCi,
    'npm error code EUSAGE\nnpm error\nnpm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.',
  ],
  'npm postinstall failure': [
    npmCi,
    'npm error code 1\nnpm error path /work/app\nnpm error command failed\nnpm error command sh -c node scripts/postinstall.js',
  ],
  'yarn missing package': [
    ['yarn', 'install'],
    'error Couldn\'t find package "left-pad-typo" on the "npm" registry.',
  ],
  'yarn outdated lockfile': [
    ['yarn', '--frozen-lockfile'],
    'error Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`.',
  ],
  'install exit without any network signature': [pnpm, 'Killed'],
};

const recorded = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/dependency-network/${name}.txt`, import.meta.url)),
    'utf8',
  );
const line = (argv: string[], output: string, code = 1) => registryFailureLine(argv, code, output);

test('Установка зависимостей — только однозначный argv менеджера пакетов', () => {
  for (const argv of [
    ['pnpm', 'install'],
    ['pnpm', 'i', '--frozen-lockfile'],
    ['pnpm', 'fetch'],
    ['pnpm', '--frozen-lockfile', 'install'],
    ['pnpm', '-C', 'app', 'install'],
    ['pnpm', '--dir=app', 'i'],
    ['pnpm', '--reporter', 'silent', 'install'],
    ['pnpm', '-w', 'install'],
    ['/opt/homebrew/bin/pnpm', 'install'],
    ['C:\\tools\\pnpm.cmd', 'install'],
    ['corepack', 'pnpm', 'install'],
    ['corepack', 'pnpm@9.12.0', 'install'],
    ['npm', 'ci'],
    ['npm', 'install'],
    ['npm', 'i', 'left-pad'],
    ['npm', 'clean-install'],
    ['npm', '--prefix', 'app', 'ci'],
    ['npm', '--loglevel', 'silly', 'ci'],
    ['npm', '-w', 'pkg', 'install'],
    ['yarn'],
    ['yarn', '--frozen-lockfile'],
    ['yarn', 'install'],
  ])
    assert.equal(isDependencyInstall(argv), true, argv.join(' '));
  for (const argv of [
    ['npm', 'run', 'install'],
    ['npm', '--', 'install'],
    ['npm', '--unknown-flag', 'ci'],
    ['pnpm', 'run', 'install'],
    ['pnpm', 'exec', 'install'],
    ['pnpm', 'dlx', 'install'],
    ['npx', 'pnpm', 'install'],
    ['sh', '-c', 'pnpm install'],
    ['bash', 'scripts/install.sh'],
    ['make', 'deps'],
    ['node', 'scripts/install.js'],
    ['pnpm', 'test'],
    ['npm', 'test'],
    ['yarn', 'test'],
    ['yarn', '--version'],
    ['yarn', '--cwd', 'x', 'run', 'build'],
    ['yarn', 'add', 'left-pad'],
    ['corepack', 'yarn', 'run', 'x'],
    ['pnpm'],
    ['pnpmx', 'install'],
  ])
    assert.equal(isDependencyInstall(argv), false, argv.join(' '));
});

test('Отчёт менеджера о сетевом отказе реестра — строка найдена', () => {
  for (const [name, [argv, output]] of Object.entries(network)) {
    const signature = line(argv, output);
    assert.ok(signature, name);
    assert.doesNotMatch(signature, /\u001b/, name + ': без цвета');
  }
  assert.ok(
    line(
      npmCi,
      'npm error code FETCH_ERROR\nnpm error errno FETCH_ERROR\nnpm error network invalid json response body at https://registry.npmjs.org/x',
    ),
  );
});

test('Записанный вывод pnpm 10 и npm 11: 403 и отказ соединения реестра — строка найдена', () => {
  for (const [name, argv] of [
    ['real-pnpm403', ['pnpm', 'install']],
    ['real-pnpmrefused', ['pnpm', 'install']],
    ['real-npm403', ['npm', 'install']],
    ['real-npmrefused', ['npm', 'install']],
  ] as const)
    assert.ok(line([...argv], recorded(name)), name);
});

test('Ошибки проекта при установке — строки нет, даже рядом с сетевой', () => {
  for (const [name, [argv, output]] of Object.entries(project))
    assert.equal(line(argv, output), undefined, name);
});

test('Сетевые слова вне отчёта менеджера не засчитываются', () => {
  for (const [name, argv, output] of [
    // Предупреждения повтора без итогового кода.
    [
      'pnpm retry warnings only',
      pnpm,
      ' WARN  GET https://registry.npmjs.org/x error (ECONNRESET). Will retry in 10 seconds. 2 retries left.',
    ],
    // Вывод скрипта и эхо его команды у npm, затем ошибка без кода.
    [
      'npm script noise and codeless crash',
      npmCi,
      '> preinstall\n> echo ETIMEDOUT\nETIMEDOUT\nnpm error Cannot read properties of undefined',
    ],
    [
      'yarn integrity after noise',
      ['yarn', 'install'],
      'ECONNRESET retrying\nerror https://registry.yarnpkg.com/x/-/x-1.0.0.tgz: Integrity check failed for "x"',
    ],
    ['yarn uncoded error', ['yarn', 'install'], 'error Something unexpected happened'],
    [
      'yarn berry network',
      ['yarn'],
      '➤ YN0001: │ RequestError: getaddrinfo ENOTFOUND registry.yarnpkg.com\n➤ YN0000: Failed with errors in 1s',
    ],
    ['pnpm 401', pnpm, ' ERR_PNPM_FETCH_401  GET https://r/x: Unauthorized - 401'],
    [
      'test about ECONNRESET',
      ['pnpm', 'test'],
      'AssertionError: expected ECONNRESET to be retried',
    ],
  ] as [string, string[], string][])
    assert.equal(line(argv, output), undefined, name);
  // Тот же отчёт 403 от команды, которая не установка.
  for (const argv of [
    ['pnpm', 'test'],
    ['npm', 'run', 'install'],
    ['sh', '-c', 'pnpm install'],
  ])
    assert.equal(line(argv, network['pnpm 403']![1]), undefined, argv.join(' '));
});

test('Выход по сигналу или без кода — не отчёт менеджера', () => {
  const [, output] = network['npm ETIMEDOUT']!;
  assert.ok(line(npmCi, output, 1));
  for (const code of [137, 143, 128, -1, 0, null, undefined])
    assert.equal(registryFailureLine(npmCi, code, output), undefined, String(code));
  // A2/A3: скрипт установки печатает строки менеджера и убивает его.
  assert.equal(registryFailureLine(['npm', 'install'], 137, recorded('a2')), undefined);
  assert.equal(registryFailureLine(pnpm, 137, recorded('a3')), undefined);
});

/** База с входами установки и второй коммит кандидата. */
const defined = (files: Partial<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(files).filter((e): e is [string, string] => e[1] !== undefined),
  );
type Files = Partial<Record<string, string>>;
function project2(files: Files, change: Files = {}) {
  const r = repo(
    defined({
      'package.json': JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: { 'left-pad': '1.3.0' },
        scripts: { test: 'node test.js' },
      }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      '.npmrc': 'registry=https://registry.npmjs.org/\n',
      'packages/lib/package.json': JSON.stringify({ name: 'lib', version: '1.0.0' }),
      'src/index.js': 'module.exports = 1;\n',
      ...files,
    }),
  );
  const base = r.head();
  if (Object.keys(change).length) {
    write(r.dir, defined(change));
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'candidate');
  }
  return { ...r, base };
}

test('Входы установки: те же, что в базе, — доверие; изменённые кандидатом — нет', async () => {
  const same = project2(
    {},
    {
      'src/index.js': 'module.exports = 2;\n',
      'package.json': JSON.stringify({
        name: 'app',
        version: '1.0.1',
        dependencies: { 'left-pad': '1.3.0' },
        scripts: { test: 'node other.js', build: 'tsc' },
      }),
    },
  );
  assert.equal(
    await untrustedInputs(same.dir, same.base),
    undefined,
    'код, версия и не установочный скрипт',
  );
  for (const [name, change] of Object.entries({
    registry: { '.npmrc': 'registry=https://blocked.invalid/\n' },
    'tarball URL': {
      'package.json': JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: { 'left-pad': 'https://example.invalid/left-pad.tgz' },
        scripts: { test: 'node test.js' },
      }),
    },
    'new package': {
      'package.json': JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: { 'left-pad': '1.3.0', 'blocked-pkg': '1.0.0' },
        scripts: { test: 'node test.js' },
      }),
    },
    'workspace package dependency': {
      'packages/lib/package.json': JSON.stringify({
        name: 'lib',
        version: '1.0.0',
        dependencies: { x: '1' },
      }),
    },
    'install script': {
      'package.json': JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: { 'left-pad': '1.3.0' },
        scripts: { test: 'node test.js', preinstall: 'node x.js' },
      }),
    },
    lockfile: { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters: {}\n" },
    pnpmfile: { '.pnpmfile.cjs': 'module.exports = {};\n' },
    'nested npmrc': { 'packages/lib/.npmrc': 'registry=https://blocked.invalid/\n' },
    yarnrc: { '.yarnrc.yml': 'npmRegistryServer: https://blocked.invalid\n' },
    packageManager: {
      'package.json': JSON.stringify({
        name: 'app',
        version: '1.0.0',
        packageManager: 'pnpm@1.0.0',
        dependencies: { 'left-pad': '1.3.0' },
        scripts: { test: 'node test.js' },
      }),
    },
  })) {
    const r = project2({}, change);
    assert.match((await untrustedInputs(r.dir, r.base)) ?? '', /./, name);
  }
});

test('Входы установки: ignored-файл, symlink, удаление и код базы — недоверие', async () => {
  // .npmrc, который git игнорирует, менеджер всё равно читает.
  const ignored = project2({ '.gitignore': '.npmrc\ntools/.npmrc\n', '.npmrc': '' });
  unlinkSync(join(ignored.dir, '.npmrc'));
  const base = ignored.head();
  assert.equal(
    await untrustedInputs(ignored.dir, base),
    undefined,
    'нет файла — нет и расхождения',
  );
  writeFileSync(join(ignored.dir, '.npmrc'), 'registry=https://blocked.invalid/\n');
  assert.match((await untrustedInputs(ignored.dir, base)) ?? '', /добавлен \.npmrc/);
  unlinkSync(join(ignored.dir, '.npmrc'));
  // Конфигурация на пути к каталогу команды, даже без манифеста рядом.
  write(ignored.dir, {
    'tools/.npmrc': 'registry=https://blocked.invalid/\n',
    'tools/x/a.txt': 'a',
  });
  assert.equal(await untrustedInputs(ignored.dir, base), undefined, 'вне пути команды');
  assert.match(
    (await untrustedInputs(ignored.dir, base, join(ignored.dir, 'tools', 'x'))) ?? '',
    /tools\/\.npmrc/,
  );

  const linked = project2({});
  unlinkSync(join(linked.dir, 'package.json'));
  writeFileSync(join(linked.dir, 'other.json'), '{}');
  symlinkSync('other.json', join(linked.dir, 'package.json'));
  assert.match((await untrustedInputs(linked.dir, linked.base)) ?? '', /не обычный файл/);

  const removed = project2({});
  unlinkSync(join(removed.dir, 'pnpm-lock.yaml'));
  assert.match((await untrustedInputs(removed.dir, removed.base)) ?? '', /удалён pnpm-lock\.yaml/);

  // База исполняет код при установке: её выводу верить нельзя, даже без правок.
  for (const [name, files] of Object.entries({
    'root preinstall': {
      'package.json': JSON.stringify({ name: 'app', scripts: { preinstall: 'node x.js' } }),
    },
    'workspace prepare': {
      'packages/lib/package.json': JSON.stringify({ name: 'lib', scripts: { prepare: 'tsc' } }),
    },
    pnpmfile: { '.pnpmfile.cjs': 'module.exports = {};\n' },
    'node-options': { '.npmrc': 'node-options=--require ./hook.js\n' },
    yarnPath: { '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn.cjs\n' },
  })) {
    const r = project2(files);
    assert.match((await untrustedInputs(r.dir, r.base)) ?? '', /./, name);
  }
  // Неизвестная база — недоверие, а не исключение.
  const r = project2({});
  assert.match((await untrustedInputs(r.dir, 'f'.repeat(40))) ?? '', /не прочитаны/);
});

/** Исполняемый «менеджер пакетов»: печатает вывод; `failures` первых запусков падают; `kill` — выход по SIGKILL. */
function fakeManager(name: string, output: string, failures = Infinity, kill = false) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-pm-'));
  const counter = join(dir, 'runs');
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require('fs');
const runs = Number(fs.existsSync(${JSON.stringify(counter)}) ? fs.readFileSync(${JSON.stringify(counter)}, 'utf8') : 0) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(runs));
if (runs > ${failures === Infinity ? 'Infinity' : failures}) { console.log('Done in 0.1s'); process.exit(0); }
process.stdout.write(${JSON.stringify(output + '\n')});
${kill ? "process.kill(process.pid, 'SIGKILL');" : 'process.exit(1);'}
`,
  );
  chmodSync(path, 0o755);
  return { path, runs: () => (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) };
}

async function gateFailure(dir: string, command: string[], trustedBase?: string) {
  const recordedEvidence: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  try {
    await runGate({
      policy: { isolation: { mode: 'none', domains: [] } },
      record: (e) => {
        recordedEvidence.push(e);
        return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
      },
      cwd: dir,
      sha: (await import('node:child_process'))
        .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' })
        .trim(),
      phase: 'candidate',
      gate: { id: 'install', kind: 'check', timeoutMs: 20000, command } satisfies GatePolicy,
      artifactDir: mkdtempSync(join(tmpdir(), 'harness-art-')),
      signal: new AbortController().signal,
      execution: { env: { ...process.env }, redact: redactor([]) },
      boundary: { hidden: [], readable: [] },
      ...(trustedBase ? { trustedBase } : {}),
    });
  } catch (error) {
    assert.ok(error instanceof TaskFailure, String(error));
    assert.equal(recordedEvidence.length, 1, 'evidence записано');
    assert.equal(recordedEvidence[0]!.passed, false);
    return error;
  }
  assert.fail('gate должен упасть');
}

test('runGate: настоящий 403 при входах базы — environment с причиной dependency-network', async () => {
  const r = project2({}, { 'src/index.js': 'module.exports = 2;\n' });
  const pm = fakeManager('pnpm', network['pnpm 403']![1]);
  const failure = await gateFailure(r.dir, [pm.path, 'install', '--frozen-lockfile'], r.base);
  assert.equal(failure.kind, 'environment');
  assert.match(failure.message, /^candidate\/install: dependency-network: /);
  assert.match(failure.message, /ERR_PNPM_FETCH_403/);
  assert.equal(classifyFailure(failure, failure.message), 'environment');
  // Без закреплённой базы классификации нет.
  assert.equal((await gateFailure(r.dir, [pm.path, 'install'])).kind, 'gate');
});

test('runGate: отказ, вызванный кандидатом, и подделки A1–A3 — gate', async () => {
  const pm = fakeManager('pnpm', network['pnpm 403']![1]);
  // Кандидат сменил реестр, сослался на tarball, добавил закрытый прокси пакет.
  for (const change of [
    { '.npmrc': 'registry=https://blocked.invalid/\n' },
    {
      'package.json': JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: { 'left-pad': 'https://example.invalid/x.tgz' },
        scripts: { test: 'node test.js' },
      }),
    },
    {
      'package.json': JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: { 'left-pad': '1.3.0', 'blocked-pkg': '1.0.0' },
        scripts: { test: 'node test.js' },
      }),
    },
  ]) {
    const r = project2({}, change);
    assert.equal(
      (await gateFailure(r.dir, [pm.path, 'install'], r.base)).kind,
      'gate',
      JSON.stringify(change),
    );
  }
  // A1: pnpmfile кандидата бросает ошибку с кодом ECONNRESET (вывод pnpm 10).
  const a1 = project2(
    {},
    {
      '.pnpmfile.cjs':
        "const e = new Error('request to https://registry.npmjs.org/left-pad failed, reason: socket hang up'); e.code='ECONNRESET';\nmodule.exports = { hooks: { readPackage(p){ throw e; } } };\n",
    },
  );
  assert.ok(line(pnpm, recorded('a1')), 'по одному выводу A1 неотличим от сети');
  const a1pm = fakeManager('pnpm', recorded('a1'));
  assert.equal((await gateFailure(a1.dir, [a1pm.path, 'install'], a1.base)).kind, 'gate');
  // A2/A3: preinstall кандидата печатает строки менеджера и убивает его.
  for (const [name, argv0, scripts] of [
    ['a2', 'npm', { preinstall: "echo 'npm error code ECONNRESET'; kill -9 $PPID" }],
    [
      'a3',
      'pnpm',
      { preinstall: "echo 'GET https://registry.npmjs.org/x error (ECONNRESET)'; kill -9 $PPID" },
    ],
  ] as const) {
    const r = project2(
      {},
      {
        'package.json': JSON.stringify({
          name,
          version: '1.0.0',
          dependencies: { 'left-pad': '1.3.0' },
          scripts,
        }),
      },
    );
    for (const kill of [true, false]) {
      const forged = fakeManager(argv0, recorded(name), Infinity, kill);
      assert.equal(
        (await gateFailure(r.dir, [forged.path, 'install'], r.base)).kind,
        'gate',
        `${name} kill=${kill}`,
      );
    }
  }
  // Выход по сигналу при входах базы — тоже не отчёт менеджера.
  const same = project2({});
  const killed = fakeManager('npm', network['npm ETIMEDOUT']![1], Infinity, true);
  assert.equal((await gateFailure(same.dir, [killed.path, 'ci'], same.base)).kind, 'gate');
  // Ошибка проекта и сетевой отчёт от скрипта, а не установки.
  const lock = fakeManager('pnpm', project['pnpm outdated lockfile']![1]);
  assert.equal((await gateFailure(same.dir, [lock.path, 'install'], same.base)).kind, 'gate');
  assert.equal((await gateFailure(same.dir, [pm.path, 'run', 'install'], same.base)).kind, 'gate');
});

test('Шаг prepare установки на реестре — environment при базе; иначе прежний отказ шага', async () => {
  const r = project2({});
  const execution = { env: { ...process.env }, redact: redactor([]) };
  const dir = mkdtempSync(join(tmpdir(), 'harness-steps-'));
  const step = (command: string[]) => [{ id: 'deps', command, timeoutMs: 20000 }];
  const net = fakeManager('npm', network['npm ETIMEDOUT']![1]);
  const signal = () => new AbortController().signal;
  await assert.rejects(
    runSteps(step([net.path, 'ci']), r.dir, dir, execution, signal(), r.base),
    (e: unknown) =>
      e instanceof TaskFailure &&
      e.kind === 'environment' &&
      /^dependency-network: .*Шаг deps: exit=1/.test(e.message),
  );
  const plain = (e: unknown) =>
    e instanceof Error && !(e instanceof TaskFailure) && /^Шаг deps: exit=1/.test(e.message);
  await assert.rejects(runSteps(step([net.path, 'ci']), r.dir, dir, execution, signal()), plain);
  const own = fakeManager('npm', project['npm ci lockfile mismatch']![1]);
  await assert.rejects(
    runSteps(step([own.path, 'ci']), r.dir, dir, execution, signal(), r.base),
    plain,
  );
});

/** Политика fixture с gate установки первым. */
const withInstall = (command: string[]) => (p: any) => {
  const repository = p.repositories[0];
  repository.gates = [
    { id: 'install', kind: 'check', command, timeoutMs: 20000 },
    ...repository.gates,
  ];
};

/** Gate установки — в области поручения. */
const inScope = (g: any) => {
  for (const order of g.orders) order.gates = ['install', ...(order.gates ?? [])];
};
test('Run: обрыв реестра не тратит попытку, держит очередь, повтор — тот же кандидат; explain называет причину', async () => {
  const pm = fakeManager('pnpm', network['pnpm 403']![1]);
  const ctx = hsetup({
    scenario: { writer: [implement(), implement()], reviewer: approve() },
    policy: withInstall([pm.path, 'install', '--frozen-lockfile']),
    graph: inScope,
  });
  const h = ctx.open();
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  const work = h.engine.read((v) => v.work(data.works[0]!.id)!);
  const attempts = h.engine.read((v) => v.attempts(work.id));
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'environment');
  assert.match(work.failure ?? '', /candidate\/install: dependency-network: /);
  assert.equal(work.attempt, 0, 'попытка не засчитана');
  assert.equal(attempts.length, 2, 'один повтор окружения, затем остановка');
  assert.ok(
    attempts.every((a) => a.failureKind === 'environment'),
    'обе попытки — environment',
  );
  assert.equal(attempts[1]!.reusedFrom?.runId, attempts[0]!.id, 'повтор взял того же кандидата');
  assert.equal(ctx.calls('claude', 'writer'), 1, 'writer вызван один раз');
  assert.equal(work.neutralFailures, 2);
  assert.equal(pm.runs(), 2);
  // Выдача держалась так же, как при любом отказе окружения: пауза runtime и
  // повтор восстановлением класса environment.
  const log = h.store.events(0, 500);
  assert.ok(
    log.some(
      (e) =>
        e.type === 'control.paused' &&
        e.payload.reason === 'runtime' &&
        JSON.stringify(e.payload).includes('environment'),
    ),
    'очередь поставлена на паузу runtime',
  );
  assert.deepEqual(
    (data.workflow?.history ?? []).filter((e) => e.event.startsWith('repair:')).map((e) => e.event),
    ['repair:environment'],
  );
  h.close();
  const { diagnoses } = await diagnoseState({
    stateDir: ctx.state,
    policy: h.policy,
    baseDir: ctx.repo.dir,
    workId: work.id,
    adapters: {
      claude: cliAdapter('claude', { executable: bin('fake-claude') }),
      codex: cliAdapter('codex', { executable: bin('fake-codex') }),
    },
  });
  const diagnosis = diagnoses.find((d) => d.workId === work.id)!;
  assert.equal(diagnosis.cause, 'environment');
  assert.equal(diagnosis.action, 'fix-environment');
  assert.match(diagnosis.message, /dependency-network: установка зависимостей/);
});

test('Run: разовый обрыв реестра — повтор с тем же кандидатом принимает работу без траты попытки', async () => {
  const pm = fakeManager('pnpm', network['npm 403']![1], 1);
  const ctx = hsetup({
    scenario: { writer: [implement(), implement()], reviewer: approve() },
    policy: withInstall([pm.path, 'install']),
    graph: inScope,
  });
  const h = ctx.open();
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  const work = h.engine.read((v) => v.work(data.works[0]!.id)!);
  const attempts = h.engine.read((v) => v.attempts(work.id));
  assert.equal(work.status, 'done');
  assert.equal(attempts[0]!.failureKind, 'environment');
  assert.match(attempts[0]!.error ?? '', /dependency-network/);
  assert.equal(attempts.at(-1)!.status, 'succeeded');
  assert.equal(work.attempt, 1, 'засчитана только успешная попытка');
  assert.equal(ctx.calls('claude', 'writer'), 1, 'writer вызван один раз');
  h.close();
});

test('Run: кандидат сменил реестр — отказ установки засчитан как gate', async () => {
  const pm = fakeManager('pnpm', network['pnpm 403']![1]);
  const files = { 'src/greet.js': greet, '.npmrc': 'registry=https://blocked.invalid/\n' };
  const ctx = hsetup({
    scenario: {
      writer: [implement(files), implement(files), implement(files)],
      reviewer: approve(),
    },
    policy: withInstall([pm.path, 'install']),
    graph: (g: any) => {
      inScope(g);
      for (const order of g.orders) order.writeScope = ['src', '.npmrc'];
    },
  });
  const h = ctx.open();
  const data = await h.run({ graph: ctx.graph, author: 'claude' });
  const work = h.engine.read((v) => v.work(data.works[0]!.id)!);
  const attempts = h.engine.read((v) => v.attempts(work.id));
  assert.equal(attempts[0]!.failureKind, 'gate', attempts[0]!.error);
  assert.doesNotMatch(attempts[0]!.error ?? '', /dependency-network/);
  assert.ok(work.attempt >= 1, 'попытка засчитана');
  h.close();
});

test('Probe reviewer: gate установки, упавший на реестре, — error/environment, а не находка', async () => {
  const c = candidate();
  try {
    const pm = fakeManager('pnpm', network['pnpm meta fetch, DNS']![1]);
    const lock = fakeManager('pnpm', project['pnpm outdated lockfile']![1]);
    const check = (id: string, command: string[]): ProbeGate => ({
      id,
      kind: 'check',
      command,
      timeoutMs: 20000,
    });
    const gates = [check('install', [pm.path, 'install']), check('lock', [lock.path, 'install'])];
    const probes = new ReviewProbes(
      probeSpecFor(c, { isolation: { mode: 'none', domains: [] }, gates, trustedBase: c.head() }),
    );
    const net = await probes.run({ gate: 'install' });
    assert.equal(net.status, 'error');
    assert.equal(net.failure, 'environment');
    assert.match(net.note ?? '', /^dependency-network: /);
    const own = await probes.run({ gate: 'lock' });
    assert.equal(own.status, 'failed');
    assert.equal(own.failure, undefined);
    // Без базы попытки — обычный провал.
    const untrusted = new ReviewProbes(
      probeSpecFor(c, { isolation: { mode: 'none', domains: [] }, gates }),
    );
    const plain = await untrusted.run({ gate: 'install' });
    assert.equal(plain.status, 'failed');
    assert.equal(plain.failure, undefined);
  } finally {
    c.cleanup();
  }
});
