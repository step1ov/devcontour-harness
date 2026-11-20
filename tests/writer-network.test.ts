/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
   Политика fixture правится как сырой JSON до разбора схемой. */
/**
 * Сеть исполнителя профиля (`toolProfiles.<id>.network`): `none`, `loopback`
 * (только 127.0.0.1 и ::1), `full`. Старые профили разбираются и ведут себя
 * как прежде; режим входит в digest границы; codex без функции
 * `network_proxy` получает отказ, а не всю сеть.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executionPolicySchema,
  isolationDigest,
  policyIssues,
  profileNetwork,
  type RuntimeRequest,
} from '../src/contracts/index.ts';
import {
  CODEX_LOOPBACK_NETWORK,
  claudeSandbox,
  codexPermissions,
  isolatedCommand,
  isolation,
  isolationSupport,
  withWriterNetwork,
} from '../src/environment/isolation.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { command } from '../src/environment/process.ts';
import { example } from './fixtures.ts';

const parse = (profiles: Record<string, unknown>) => {
  const raw = structuredClone(example('policy')) as Record<string, any>;
  raw.toolProfiles = profiles;
  return executionPolicySchema.parse(raw);
};

test('WN01: старый профиль без network — прежний разбор и digest; network меняет digest', () => {
  const old = parse({ web: { runtime: 'codex', codexNetwork: true } });
  assert.equal('network' in old.toolProfiles.web!, false, 'умолчание не подставляется');
  assert.equal(profileNetwork('codex', old.toolProfiles.web), 'full');
  assert.equal(profileNetwork('codex', parse({ p: { runtime: 'codex' } }).toolProfiles.p), 'none');
  assert.equal(
    profileNetwork('claude', parse({ p: { runtime: 'claude' } }).toolProfiles.p),
    undefined,
  );
  assert.equal(
    isolationDigest(old),
    isolationDigest(parse({ web: { runtime: 'codex', codexNetwork: true } })),
  );
  const loop = parse({ web: { runtime: 'codex', network: 'loopback' } });
  assert.equal(profileNetwork('codex', loop.toolProfiles.web), 'loopback');
  assert.notEqual(isolationDigest(loop), isolationDigest(parse({ web: { runtime: 'codex' } })));
  assert.throws(() => parse({ web: { runtime: 'codex', network: 'lan' } }));
});

test('WN02: противоречивая сеть профиля отклоняется проверкой политики', () => {
  const msgs = (profiles: Record<string, unknown>) =>
    policyIssues(parse(profiles))
      .filter((i) => i.path[0] === 'toolProfiles')
      .map((i) => i.message);
  assert.deepEqual(msgs({ a: { runtime: 'codex', network: 'loopback' } }), []);
  assert.deepEqual(msgs({ a: { runtime: 'claude', network: 'loopback' } }), []);
  assert.deepEqual(msgs({ a: { runtime: 'codex', network: 'full', codexNetwork: true } }), []);
  assert.match(
    msgs({ a: { runtime: 'codex', network: 'loopback', codexNetwork: true } })[0]!,
    /противоречит codexNetwork/,
  );
  assert.match(msgs({ a: { runtime: 'claude', network: 'full' } })[0]!, /только для codex/);
  // Веб-инструменты claude ходят в сеть мимо песочницы: с режимом без интернета — отказ.
  for (const rule of ['WebFetch', 'WebSearch', 'WebFetch(domain:example.com)'])
    assert.match(
      msgs({ a: { runtime: 'claude', network: 'loopback', claudeAllowedTools: [rule] } })[0]!,
      /мимо песочницы/,
      rule,
    );
  assert.deepEqual(msgs({ a: { runtime: 'claude', claudeAllowedTools: ['WebFetch'] } }), []);
});

test('WN03: аргументы codex и настройки claude по режиму сети', () => {
  const iso = isolation({ write: [tmpdir()], controller: [], domains: ['example.com'] });
  const text = (n: Parameters<typeof codexPermissions>[1]) => codexPermissions(iso, n).join(' ');
  // Прежние булевы значения — прежние строки.
  assert.match(text(false), /network=\{enabled=false\}\}$/);
  assert.match(text(true), /network=\{enabled=true\}\}$/);
  assert.equal(text('none'), text(false));
  assert.equal(text('full'), text(true));
  assert.ok(!text(true).includes('network_proxy'));
  const loop = codexPermissions(iso, 'loopback');
  assert.deepEqual(loop.slice(0, 2), ['-c', 'features.network_proxy=true']);
  assert.ok(loop.join(' ').endsWith(`network={${CODEX_LOOPBACK_NETWORK}}}`));
  for (const key of ['domains={}', 'allow_local_binding=true', 'allow_upstream_proxy=false'])
    assert.ok(CODEX_LOOPBACK_NETWORK.includes(key), key);
  assert.ok(!/domains=\{"/.test(loop.join(' ')), 'разрешённых доменов нет');

  const net = (n: Parameters<typeof withWriterNetwork>[1]) =>
    claudeSandbox(withWriterNetwork(iso, n), false, tmpdir()).sandbox.network;
  assert.deepEqual(net(undefined), { allowedDomains: ['example.com'], allowLocalBinding: true });
  assert.deepEqual(net('loopback'), { allowedDomains: [], allowLocalBinding: true });
  assert.deepEqual(net('none'), { allowedDomains: [], allowLocalBinding: false });
});

/** Подставной CLI: пишет argv; `features list` отвечает заданным текстом. */
function recorder(root: string, features: string) {
  const bin = join(root, 'record-cli');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs=require('fs');const a=process.argv.slice(2);
if(a.includes('--version')){console.log('record 0.0.1');process.exit(0)}
if(a[0]==='features'&&a[1]==='list'){process.stdout.write(${JSON.stringify(features)});process.exit(0)}
fs.writeFileSync(process.env.ARGS_FILE,JSON.stringify(a));
const out=a.indexOf('--output-last-message');if(out>=0)fs.writeFileSync(a[out+1],'{}');
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

async function invoke(
  root: string,
  runtime: 'codex' | 'claude',
  bin: string,
  network: 'none' | 'loopback' | undefined,
  task: RuntimeRequest['task'] = 'implement',
) {
  const worktree = join(root, 'wt');
  await mkdir(worktree, { recursive: true });
  const argsFile = join(root, `args-${runtime}-${network}-${task}.json`);
  await cliAdapter(runtime, {
    executable: bin,
    toolProfiles: {
      p: parse({ p: { runtime, ...(network ? { network } : {}) } }).toolProfiles.p!,
    },
  }).invoke(
    {
      callId: 'c1',
      task,
      binding: { runtime, toolProfile: 'p' },
      cwd: worktree,
      prompt: 'p',
      session: { kind: 'fresh' },
      sandbox: {
        mode: 'os',
        writable: [worktree],
        denied: [],
        network: { domains: ['example.com'] },
      },
      timeoutMs: 20_000,
      env: { PATH: process.env.PATH ?? '', ARGS_FILE: argsFile },
      artifactDir: join(root, `call-${runtime}-${network}-${task}`),
    },
    new AbortController().signal,
  );
  return JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
}

test('WN04: адаптер — loopback исполнителю codex и claude; ревьюер сети профиля не получает', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wnet-')));
  try {
    const bin = recorder(
      root,
      'network_proxy                            experimental       false\n',
    );
    const codex = (await invoke(root, 'codex', bin, 'loopback')).join(' ');
    assert.match(codex, /features\.network_proxy=true/);
    assert.ok(codex.includes(`network={${CODEX_LOOPBACK_NETWORK}}`));
    assert.match(codex, /sandbox_workspace_write\.network_access=false/);
    assert.match(codex, /web_search="disabled"/);
    assert.match((await invoke(root, 'codex', bin, 'none')).join(' '), /web_search="disabled"/);
    // Без поля network — прежний вызов: веб-поиск codex не трогается.
    assert.ok(!(await invoke(root, 'codex', bin, undefined)).join(' ').includes('web_search'));
    const review = (await invoke(root, 'codex', bin, 'loopback', 'review-code')).join(' ');
    assert.ok(!review.includes('network_proxy'));
    assert.ok(!review.includes('web_search'));
    assert.match(review, /network=\{enabled=false\}/);

    const claude = await invoke(root, 'claude', bin, 'loopback');
    const settings = JSON.parse(claude[claude.indexOf('--settings') + 1]!) as {
      sandbox: { network: unknown };
    };
    assert.deepEqual(settings.sandbox.network, { allowedDomains: [], allowLocalBinding: true });
    assert.equal(claude[claude.indexOf('--disallowedTools') + 1], 'WebFetch,WebSearch');
    assert.ok(!(await invoke(root, 'claude', bin, undefined)).includes('--disallowedTools'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WN05: codex без функции network_proxy — отказ вызова, а не вся сеть', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wnet-')));
  try {
    const bin = recorder(
      root,
      'network_proxy                            removed            false\n',
    );
    await assert.rejects(invoke(root, 'codex', bin, 'loopback'), /не поддерживает сеть loopback/);
    // Определённый ответ кешируется: повтор не спрашивает codex заново.
    writeFileSync(bin, readFileSync(bin, 'utf8').replace('removed   ', 'experimental'));
    await assert.rejects(invoke(root, 'codex', bin, 'loopback'), /не поддерживает сеть loopback/);
    // Режим none проверки не требует.
    assert.match((await invoke(root, 'codex', bin, 'none')).join(' '), /network=\{enabled=false\}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WN06: sandbox-runtime — loopback открывает listen на 127.0.0.1, none закрывает', async (t) => {
  const support = isolationSupport();
  if (!support.ok || process.platform !== 'darwin') {
    // На Linux bubblewrap даёт команде свою сеть с loopback при любом режиме.
    t.skip(
      'проверяется на macOS с песочницей ОС: ' + (support.ok ? process.platform : support.detail),
    );
    return;
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wnet-')));
  try {
    const script =
      "const s=require('net').createServer(c=>c.end('ok')).on('error',e=>{console.log('listen '+e.code);process.exit(2)})" +
      ".listen(0,'127.0.0.1',()=>require('net').connect(s.address().port,'127.0.0.1').on('data',d=>{console.log('loop '+d);process.exit(0)}))";
    const run = async (mode: 'none' | 'loopback') => {
      const dir = join(root, mode);
      await mkdir(dir, { recursive: true });
      const iso = withWriterNetwork(isolation({ write: [dir], controller: [] }), mode);
      const c = await isolatedCommand(
        iso,
        [process.execPath, '-e', script],
        join(dir, 'settings'),
        dir,
        join(dir, 'started'),
        dir,
        [dir],
      );
      const r = await command(c.argv, c.cwd, {
        env: { ...process.env, ...c.env },
        timeoutMs: 30_000,
        signal: new AbortController().signal,
      });
      return r.stdout.trim();
    };
    assert.equal(await run('loopback'), 'loop ok');
    assert.equal(await run('none'), 'listen EPERM');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WN07: проба исполнителя называет режим сети; codex без network_proxy — blocked до запуска', async () => {
  const { smokeLifecycle } = await import('../src/control/lifecycle-smoke.ts');
  const { writerProbeText } = await import('../src/control/writer-probe.ts');
  const { repo } = await import('./git-fixture.ts');
  const r = repo({ 'README.md': 'app\n' });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wnet-')));
  try {
    const raw = structuredClone(example('policy')) as Record<string, any>;
    raw.repositories[0].path = r.dir;
    raw.runTimeoutMs = 60000;
    raw.roles = { developer: { writer: { runtime: 'codex', toolProfile: 'web' } } };
    raw.toolProfiles = { web: { runtime: 'codex', network: 'loopback' } };
    raw.isolation = { mode: 'os', domains: [] };
    raw.repositories[0].writerProbe = [{ id: 'serve', command: [process.execPath, '-e', '0'] }];
    const policy = executionPolicySchema.parse(raw);
    r.git('update-ref', policy.repositories[0]!.targetRef, 'HEAD');
    const fake = recorder(
      root,
      'network_proxy                            removed            false\n',
    );
    const data = await smokeLifecycle({
      policy,
      baseDir: root,
      stateDir: join(root, 'state'),
      rev: 'HEAD',
      resourceDatabase: join(root, 'resources.sqlite'),
      writerProbe: true,
      executables: { codex: fake },
    });
    const w = data.writerProbe!.writers[0]!;
    assert.deepEqual([w.networkMode, w.network], ['loopback', false]);
    assert.deepEqual(
      w.commands.map((c) => [c.id, c.status, c.reason]),
      [['serve', 'blocked', 'environment']],
    );
    assert.match(w.commands[0]!.evidence!, /network_proxy/);
    assert.match(writerProbeText(data.writerProbe!), /сеть только локальная \(127\.0\.0\.1, ::1\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WN08: сбой проверки network_proxy назван сбоем и не кешируется', async () => {
  const { codexLoopbackSupport } = await import('../src/environment/isolation.ts');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wnet-')));
  try {
    const bin = join(root, 'flaky-codex');
    const flag = join(root, 'fail');
    writeFileSync(flag, '');
    writeFileSync(
      bin,
      `#!${process.execPath}
if(require('fs').existsSync(${JSON.stringify(flag)})){console.error('boom');process.exit(3)}
process.stdout.write('network_proxy   experimental   false\\n');
`,
    );
    chmodSync(bin, 0o755);
    const first = await codexLoopbackSupport(bin);
    assert.match(first!, /не удалось проверить поддержку сети loopback у codex.*код 3/);
    assert.doesNotMatch(first!, /не поддерживает/);
    await rm(flag);
    assert.equal(await codexLoopbackSupport(bin), null, 'после сбоя спрашивается заново');
    const missing = await codexLoopbackSupport(join(root, 'no-such-codex'));
    assert.match(missing!, /не удалось проверить.*ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WN09: проба проверяет границу loopback codex на деле; открытый внешний адрес — blocked', async () => {
  const { loopbackVerdict, LOOPBACK_CHECK } = await import('../src/control/writer-probe.ts');
  const line = (k: string, v: string) => `${LOOPBACK_CHECK}:${k}:${v}`;
  const out = (l: string, d: string, p: string) =>
    [line('loopback', l), line('direct', d), line('proxy', p)].join('\n');
  assert.deepEqual(loopbackVerdict(0, out('ok', 'closed:EPERM', 'closed:HTTP/1.1 403')), {
    status: 'ok',
  });
  assert.equal(loopbackVerdict(0, out('ok', 'open', 'none')).reason, 'network-open');
  assert.equal(loopbackVerdict(0, out('ok', 'closed:EPERM', 'open')).reason, 'network-open');
  assert.equal(
    loopbackVerdict(0, out('fail:EPERM', 'closed:EPERM', 'none')).reason,
    'listen-denied',
  );
  assert.equal(loopbackVerdict(0, 'garbage').status, 'failed');
  assert.equal(loopbackVerdict(1, out('ok', 'closed:x', 'none')).status, 'failed');

  // Подставной codex поддерживает network_proxy, но «пропускает» внешний адрес.
  const { smokeLifecycle } = await import('../src/control/lifecycle-smoke.ts');
  const { repo } = await import('./git-fixture.ts');
  const r = repo({ 'README.md': 'app\n' });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wnet-')));
  try {
    const raw = structuredClone(example('policy')) as Record<string, any>;
    raw.repositories[0].path = r.dir;
    raw.runTimeoutMs = 60000;
    raw.roles = { developer: { writer: { runtime: 'codex', toolProfile: 'web' } } };
    raw.toolProfiles = { web: { runtime: 'codex', network: 'loopback' } };
    raw.isolation = { mode: 'os', domains: [] };
    raw.repositories[0].writerProbe = [{ id: 'serve', command: [process.execPath, '-e', '0'] }];
    const policy = executionPolicySchema.parse(raw);
    r.git('update-ref', policy.repositories[0]!.targetRef, 'HEAD');
    const fake = join(root, 'codex');
    const argvLog = join(root, 'argv.jsonl');
    writeFileSync(
      fake,
      `#!${process.execPath}
const fs=require('fs');const a=process.argv.slice(2);
if(a[0]==='features'){process.stdout.write('network_proxy   experimental   false\\n');process.exit(0)}
fs.appendFileSync(${JSON.stringify(argvLog)},JSON.stringify(a)+'\\n');
const i=a.indexOf('--');
if(a[i+2]==='-e'&&a[i+3].includes(${JSON.stringify(LOOPBACK_CHECK)})){
  console.log(${JSON.stringify(out('ok', 'open', 'none'))});process.exit(0)}
const r=require('child_process').spawnSync(a[i+1],a.slice(i+2),{stdio:'inherit'});process.exit(r.status??1);
`,
    );
    chmodSync(fake, 0o755);
    const data = await smokeLifecycle({
      policy,
      baseDir: root,
      stateDir: join(root, 'state'),
      rev: 'HEAD',
      resourceDatabase: join(root, 'resources.sqlite'),
      writerProbe: true,
      executables: { codex: fake },
    });
    const w = data.writerProbe!.writers[0]!;
    assert.equal(data.writerProbe!.ok, false);
    assert.deepEqual(
      w.commands.map((c) => [c.id, c.status, c.reason]),
      [
        [LOOPBACK_CHECK, 'blocked', 'network-open'],
        ['serve', 'ok', undefined],
      ],
    );
    assert.match(w.commands[0]!.advice!, /не держит границу loopback/);
    // Проверка идёт с теми же аргументами песочницы, что у шагов исполнителя.
    const calls = readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    const head = (a: string[]) => a.slice(0, a.indexOf('--')).join(' ');
    assert.equal(head(calls[0]!), head(calls[1]!));
    assert.match(head(calls[0]!), /features\.network_proxy=true.*allow_local_binding=true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WN10: профиль без поля network — режим legacy, а не none: инструменты runtime не закрыты', async () => {
  const { smokeLifecycle } = await import('../src/control/lifecycle-smoke.ts');
  const { writerProbeText, LOOPBACK_CHECK } = await import('../src/control/writer-probe.ts');
  const { repo } = await import('./git-fixture.ts');
  const r = repo({ 'README.md': 'app\n' });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wnet-')));
  try {
    const raw = structuredClone(example('policy')) as Record<string, any>;
    raw.repositories[0].path = r.dir;
    raw.runTimeoutMs = 60000;
    raw.roles = {
      developer: { writer: { runtime: 'codex', toolProfile: 'old' } },
      tester: { writer: { runtime: 'codex', toolProfile: 'closed' } },
    };
    raw.toolProfiles = {
      old: { runtime: 'codex' },
      closed: { runtime: 'codex', network: 'none' },
    };
    raw.isolation = { mode: 'os', domains: [] };
    raw.repositories[0].writerProbe = [{ id: 'step', command: [process.execPath, '-e', '0'] }];
    const policy = executionPolicySchema.parse(raw);
    r.git('update-ref', policy.repositories[0]!.targetRef, 'HEAD');
    const fake = join(root, 'codex');
    writeFileSync(
      fake,
      `#!${process.execPath}
const a=process.argv.slice(2);const i=a.indexOf('--');
const r=require('child_process').spawnSync(a[i+1],a.slice(i+2),{stdio:'inherit'});process.exit(r.status??1);
`,
    );
    chmodSync(fake, 0o755);
    const data = await smokeLifecycle({
      policy,
      baseDir: root,
      stateDir: join(root, 'state'),
      rev: 'HEAD',
      resourceDatabase: join(root, 'resources.sqlite'),
      writerProbe: true,
      executables: { codex: fake },
    });
    const writers = data.writerProbe!.writers;
    const by = {
      old: writers.find((w) => w.toolProfile === 'old'),
      closed: writers.find((w) => w.toolProfile === 'closed'),
    };
    assert.deepEqual([by.old!.networkMode, by.old!.network], ['legacy', false]);
    assert.deepEqual([by.closed!.networkMode, by.closed!.network], ['none', false]);
    assert.ok(!by.old!.commands.some((c) => c.id === LOOPBACK_CHECK));
    const text = writerProbeText(data.writerProbe!);
    assert.match(
      text,
      /\(old\).*сеть shell закрыта \(профиль без поля network\), сетевые инструменты runtime не закрыты/,
    );
    assert.match(text, /\(closed\).*сеть закрыта \(и локальные порты\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
