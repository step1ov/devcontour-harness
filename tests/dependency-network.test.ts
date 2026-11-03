/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тесты правят сырой JSON политики до разбора схемой.
 */
/**
 * Отказ установки зависимостей по сети или реестру пакетов — `environment` с
 * причиной `dependency-network`, а не провал проекта (`gate`). Выводы ниже —
 * синтетические, по образцу сообщений pnpm, npm и yarn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceRecord, GatePolicy } from '../src/contracts/index.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { ReviewProbes, type ProbeGate } from '../src/agents/review-probe.ts';
import {
  dependencyNetworkFailure,
  isDependencyInstall,
} from '../src/environment/dependency-network.ts';
import { runSteps } from '../src/environment/lifecycle.ts';
import { redactor } from '../src/environment/redaction.ts';
import { classifyFailure } from '../src/engine/classify.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { diagnoseState } from '../src/explain/diagnose.ts';
import { runGate } from '../src/verification/gates.ts';
import { repo } from './git-fixture.ts';
import { hsetup } from './harness-fixture.ts';
import { candidate, probeSpecFor } from './probe-fixture.ts';
import { approve, bin, implement } from './runner-fixture.ts';

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

test('Установка зависимостей — только argv менеджера пакетов, закреплённый политикой', () => {
  for (const argv of [
    ['pnpm', 'install'],
    ['pnpm', 'i', '--frozen-lockfile'],
    ['pnpm', 'fetch'],
    ['pnpm', '--frozen-lockfile', 'install'],
    ['pnpm', '-C', 'app', 'install'],
    ['/opt/homebrew/bin/pnpm', 'install'],
    ['corepack', 'pnpm', 'install'],
    ['npm', 'ci'],
    ['npm', 'install'],
    ['npm', 'i', 'left-pad'],
    ['npm', 'clean-install'],
    ['npm', '--prefix', 'app', 'ci'],
    ['yarn'],
    ['yarn', '--frozen-lockfile'],
    ['yarn', 'install'],
  ])
    assert.equal(isDependencyInstall(argv), true, argv.join(' '));
  for (const argv of [
    ['npm', 'run', 'install'],
    ['pnpm', 'run', 'install'],
    ['pnpm', 'exec', 'install'],
    ['pnpm', 'dlx', 'install'],
    ['npx', 'pnpm', 'install'],
    ['sh', '-c', 'pnpm install'],
    ['bash', 'scripts/install.sh'],
    ['make', 'deps'],
    ['node', 'scripts/install.js'],
    ['pnpm', 'test'],
    ['pnpm', 'build'],
    ['npm', 'test'],
    ['yarn', 'test'],
    ['yarn', 'add', 'left-pad'],
    ['pnpm'],
    ['pnpmx', 'install'],
  ])
    assert.equal(isDependencyInstall(argv), false, argv.join(' '));
});

test('Сетевые отказы реестра у установки — подпись найдена', () => {
  for (const [name, [argv, output]] of Object.entries(network)) {
    const signature = dependencyNetworkFailure(argv, output);
    assert.ok(signature, name);
    assert.doesNotMatch(signature, /\u001b/, name + ': без цвета');
  }
});

test('Ошибки проекта при установке — подписи нет, даже рядом с сетевой строкой', () => {
  for (const [name, [argv, output]] of Object.entries(project))
    assert.equal(dependencyNetworkFailure(argv, output), undefined, name);
});

test('Сетевой вывод не установки (тест, скрипт пакета, shell) — подписи нет', () => {
  const [, output] = network['pnpm 403']!;
  for (const argv of [
    ['pnpm', 'test'],
    ['npm', 'run', 'install'],
    ['sh', '-c', 'pnpm install'],
    ['node', 'test/run.js'],
  ])
    assert.equal(dependencyNetworkFailure(argv, output), undefined, argv.join(' '));
  // Тест приложения про обрыв соединения — провал проекта.
  assert.equal(
    dependencyNetworkFailure(['pnpm', 'test'], 'AssertionError: expected ECONNRESET to be retried'),
    undefined,
  );
});

test('Попытка уйти от бюджета: скрипт установки печатает подпись реестра — отказ остаётся проекта', () => {
  // Скрипт жизненного цикла кандидата печатает точный вывод pnpm 403 и падает:
  // менеджер называет упавший скрипт, и это ошибка проекта.
  const forged = [
    '. postinstall$ node scripts/postinstall.js',
    '│  ERR_PNPM_FETCH_403  GET https://registry.npmjs.org/left-pad: Forbidden - 403',
    '└─ Failed in 12ms at /work/app',
    ' ELIFECYCLE  Command failed with exit code 1.',
  ].join('\n');
  assert.equal(dependencyNetworkFailure(pnpm, forged), undefined);
  const npmForged = [
    'npm error code 1',
    'npm error path /work/app',
    'npm error command failed',
    'npm error command sh -c node scripts/postinstall.js',
    'npm error npm error code E403',
    'npm error npm error 403 403 Forbidden - GET https://registry.npmjs.org/left-pad',
  ].join('\n');
  assert.equal(dependencyNetworkFailure(npmCi, npmForged), undefined);
  // Поддельный код pnpm в выводе рядом с настоящим ненетевым — тоже проект.
  assert.equal(
    dependencyNetworkFailure(
      pnpm,
      ' ERR_PNPM_FETCH_403  GET https://registry.npmjs.org/x: Forbidden - 403\n ERR_PNPM_LOCKFILE_BREAKING_CHANGE  Lockfile is broken',
    ),
    undefined,
  );
});

/** Исполняемый «менеджер пакетов»: печатает заданный вывод; `failures` первых запусков падают. */
function fakeManager(name: string, output: string, failures = Infinity) {
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
process.exit(1);
`,
  );
  chmodSync(path, 0o755);
  return { path, runs: () => (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) };
}

async function gateFailure(command: string[]) {
  const r = repo();
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  try {
    await runGate({
      policy: { isolation: { mode: 'none', domains: [] } },
      record: (e) => {
        recorded.push(e);
        return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
      },
      cwd: r.dir,
      sha: r.head(),
      phase: 'candidate',
      gate: { id: 'install', kind: 'check', timeoutMs: 20000, command } satisfies GatePolicy,
      artifactDir: mkdtempSync(join(tmpdir(), 'harness-art-')),
      signal: new AbortController().signal,
      execution: { env: { ...process.env }, redact: redactor([]) },
      boundary: { hidden: [], readable: [] },
    });
  } catch (error) {
    assert.ok(error instanceof TaskFailure, String(error));
    assert.equal(recorded.length, 1, 'evidence записано');
    assert.equal(recorded[0]!.passed, false);
    return error;
  }
  assert.fail('gate должен упасть');
}

test('runGate: установка, упавшая на реестре, — environment с причиной dependency-network', async () => {
  const pm = fakeManager('pnpm', network['pnpm 403']![1]);
  const failure = await gateFailure([pm.path, 'install', '--frozen-lockfile']);
  assert.equal(failure.kind, 'environment');
  assert.match(failure.message, /^candidate\/install: dependency-network: /);
  assert.match(failure.message, /ERR_PNPM_FETCH_403/);
  assert.equal(classifyFailure(failure, failure.message), 'environment');
});

test('runGate: lockfile, скрипт кандидата и не установка — gate', async () => {
  const lock = fakeManager('pnpm', project['pnpm outdated lockfile']![1]);
  assert.equal((await gateFailure([lock.path, 'install'])).kind, 'gate');
  const forged = fakeManager(
    'pnpm',
    '. postinstall$ node x.js\n│  ERR_PNPM_FETCH_403  GET https://registry.npmjs.org/x: Forbidden - 403\n ELIFECYCLE  Command failed with exit code 1.',
  );
  assert.equal((await gateFailure([forged.path, 'install'])).kind, 'gate');
  // Тот же сетевой вывод от скрипта пакета или собственного скрипта.
  const script = fakeManager('pnpm', network['pnpm 403']![1]);
  assert.equal((await gateFailure([script.path, 'run', 'install'])).kind, 'gate');
  const node = fakeManager('install.js', network['pnpm 403']![1]);
  assert.equal((await gateFailure([node.path])).kind, 'gate');
});

test('Шаг prepare установки на реестре — environment; ошибка проекта — прежний отказ шага', async () => {
  const r = repo();
  const execution = { env: { ...process.env }, redact: redactor([]) };
  const dir = mkdtempSync(join(tmpdir(), 'harness-steps-'));
  const step = (command: string[]) => [{ id: 'deps', command, timeoutMs: 20000 }];
  const net = fakeManager('npm', network['npm ETIMEDOUT']![1]);
  await assert.rejects(
    runSteps(step([net.path, 'ci']), r.dir, dir, execution, new AbortController().signal),
    (e: unknown) =>
      e instanceof TaskFailure &&
      e.kind === 'environment' &&
      /^dependency-network: .*Шаг deps: exit=1/.test(e.message),
  );
  const own = fakeManager('npm', project['npm ci lockfile mismatch']![1]);
  await assert.rejects(
    runSteps(step([own.path, 'ci']), r.dir, dir, execution, new AbortController().signal),
    (e: unknown) =>
      e instanceof Error && !(e instanceof TaskFailure) && /^Шаг deps: exit=1/.test(e.message),
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
    const probes = new ReviewProbes(
      probeSpecFor(c, {
        isolation: { mode: 'none', domains: [] },
        gates: [check('install', [pm.path, 'install']), check('lock', [lock.path, 'install'])],
      }),
    );
    const net = await probes.run({ gate: 'install' });
    assert.equal(net.status, 'error');
    assert.equal(net.failure, 'environment');
    assert.match(net.note ?? '', /^dependency-network: /);
    const own = await probes.run({ gate: 'lock' });
    assert.equal(own.status, 'failed');
    assert.equal(own.failure, undefined);
  } finally {
    c.cleanup();
  }
});
