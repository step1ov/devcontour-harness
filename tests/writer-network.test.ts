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
  assert.match(loop.join(' '), /network=\{enabled=true, allow_local_binding=true\}\}$/);
  assert.ok(!/domains/.test(loop.join(' ')), 'разрешённых доменов нет');

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
  network: 'none' | 'loopback',
  task: RuntimeRequest['task'] = 'implement',
) {
  const worktree = join(root, 'wt');
  await mkdir(worktree, { recursive: true });
  const argsFile = join(root, `args-${runtime}-${network}-${task}.json`);
  await cliAdapter(runtime, {
    executable: bin,
    toolProfiles: { p: parse({ p: { runtime, network } }).toolProfiles.p! },
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
    assert.match(codex, /network=\{enabled=true, allow_local_binding=true\}/);
    assert.match(codex, /sandbox_workspace_write\.network_access=false/);
    const review = (await invoke(root, 'codex', bin, 'loopback', 'review-code')).join(' ');
    assert.ok(!review.includes('network_proxy'));
    assert.match(review, /network=\{enabled=false\}/);

    const claude = await invoke(root, 'claude', bin, 'loopback');
    const settings = JSON.parse(claude[claude.indexOf('--settings') + 1]!) as {
      sandbox: { network: unknown };
    };
    assert.deepEqual(settings.sandbox.network, { allowedDomains: [], allowLocalBinding: true });
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
