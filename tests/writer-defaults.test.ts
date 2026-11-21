/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
   Политика fixture правится и читается как сырой JSON. */
/**
 * Умолчания пробы исполнителя для типичного веб-шаблона (pnpm-монорепозиторий,
 * Next.js, локальный сервер, проверки в браузере):
 * - шаг, закрытый только локальным портом, проба сама повторяет под
 *   `network: loopback`; `--apply-loopback` записывает это в политику с
 *   причиной и повторяет пробу — интернет остаётся закрыт;
 * - проверка в браузере, которую песочница исполнителя не запускает, —
 *   ожидаемое состояние `outside`, не закрытый шаг (проба и doctor).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cliDataSchemas,
  executionPolicySchema,
  isolationDigest,
  profileNetwork,
  roleBinding,
} from '../src/contracts/index.ts';
import { smokeLifecycle } from '../src/control/lifecycle-smoke.ts';
import { doctor } from '../src/control/doctor.ts';
import { LOOPBACK_CHECK, isBrowserStep, writerProbeText } from '../src/control/writer-probe.ts';
import { withLoopback } from '../src/control/writer-loopback.ts';
import { isolationSupport } from '../src/environment/isolation.ts';
import { example } from './fixtures.ts';
import { repo } from './git-fixture.ts';

const node = (script: string) => [process.execPath, '-e', script];
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** Сервер на 127.0.0.1 и соединение с ним: как dev-сервер и его проверка. */
const SERVE =
  "const s=require('net').createServer(c=>c.end('ok')).on('error',e=>{console.error('Error: listen '+e.code+': operation not permitted 127.0.0.1');process.exit(1)})" +
  ".listen(0,'127.0.0.1',()=>require('net').connect(s.address().port,'127.0.0.1').on('data',()=>{s.close();process.exit(0)}).on('error',e=>{console.error('connect '+e.code);process.exit(1)}))";

function fixture(tune: (raw: any, root: string) => void) {
  const r = repo({ 'README.md': 'app\n' });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wdef-')));
  const raw = structuredClone(example('policy')) as Record<string, any>;
  raw.repositories[0].path = r.dir;
  raw.runTimeoutMs = 60000;
  raw.isolation = { mode: 'os', domains: [] };
  tune(raw, root);
  const policyPath = join(root, 'policy.json');
  const text = JSON.stringify(raw, null, 2) + '\n';
  writeFileSync(policyPath, text);
  const policy = executionPolicySchema.parse(raw);
  r.git('update-ref', policy.repositories[0]!.targetRef, 'HEAD');
  const smoke = (over: Partial<Parameters<typeof smokeLifecycle>[0]> = {}) =>
    smokeLifecycle({
      policy,
      baseDir: root,
      stateDir: join(root, 'state'),
      rev: 'HEAD',
      resourceDatabase: join(root, 'resources.sqlite'),
      writerProbe: true,
      policyPath,
      ...over,
    });
  return { r, root, raw, policy, policyPath, text, smoke };
}

/**
 * Подставной codex: `features list` с network_proxy (или без); `sandbox`
 * исполняет команду после `--`, а сеть ей задаёт по профилю прав — с
 * `allow_local_binding=true` (loopback) локальный порт открыт, иначе закрыт
 * (`FAKE_NET`), как у настоящей песочницы codex. Проверка границы loopback
 * отвечает «внешний адрес закрыт».
 */
function fakeCodex(root: string, o: { proxy?: boolean } = {}) {
  const fake = join(root, 'codex');
  const log = join(root, 'argv.jsonl');
  const line = (k: string, v: string) => `${LOOPBACK_CHECK}:${k}:${v}`;
  writeFileSync(
    fake,
    `#!${process.execPath}
const fs=require('fs');const a=process.argv.slice(2);
if(a[0]==='features'){process.stdout.write(${JSON.stringify(o.proxy === false ? 'shell_tool   stable   true\n' : 'network_proxy   experimental   false\n')});process.exit(0)}
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
const loop=a.some(x=>x.includes('allow_local_binding=true'));
const i=a.indexOf('--');
if(a[i+2]==='-e'&&a[i+3].includes(${JSON.stringify(LOOPBACK_CHECK)})){
  console.log(${JSON.stringify([line('loopback', 'ok'), line('direct', 'closed:EPERM'), line('proxy', 'closed:HTTP/1.1 403')].join('\n'))});process.exit(0)}
const r=require('child_process').spawnSync(a[i+1],a.slice(i+2),{stdio:'inherit',env:{...process.env,FAKE_NET:loop?'loopback':'none'}});process.exit(r.status??1);
`,
  );
  chmodSync(fake, 0o755);
  return {
    fake,
    calls: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[]),
  };
}

/** Шаг подставного codex: listen только при сети loopback (`FAKE_NET`). */
const fakeServe = node(
  "if(process.env.FAKE_NET!=='loopback'){console.error('Error: listen EPERM: operation not permitted 127.0.0.1:3000');process.exit(1)}",
);
/** Шаг с интернетом: закрыт при любой сети исполнителя. */
const fakeInternet = node(
  "console.error('ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/next: getaddrinfo ENOTFOUND registry.npmjs.org');process.exit(1)",
);
/** Браузер без окна под песочницей. */
const fakeBrowser = node(
  "console.error('Error: Failed to launch the browser process! Abort trap: 6');process.exit(1)",
);

test('WD01: codex без профиля — локальный порт закрыт: проба сама повторяет шаги под loopback, интернет и браузер остаются как были', async () => {
  let codex!: ReturnType<typeof fakeCodex>;
  const f = fixture((raw, root) => {
    raw.roles = { developer: { writer: { runtime: 'codex' } } };
    raw.toolProfiles = {};
    raw.repositories[0].writerProbe = [
      { id: 'dev-server', command: fakeServe },
      { id: 'create', command: fakeInternet },
      { id: 'verify-browser', command: ['pnpm', 'verify:browser'] },
      { id: 'e2e', command: fakeBrowser },
    ];
    codex = fakeCodex(root);
  });
  // `pnpm verify:browser` подменён: шаг — браузерный по имени, падает как Chrome.
  f.policy.repositories[0]!.writerProbe![2]!.command = [
    ...fakeBrowser,
    '--',
    'pnpm',
    'verify:browser',
  ];
  const data = await f.smoke({ executables: { codex: codex.fake } });
  assert.equal(data.passed, true, JSON.stringify(data.failure));
  cliDataSchemas.smoke.parse(data);
  const probe = data.writerProbe!;
  const w = probe.writers[0]!;
  assert.equal(w.networkMode, 'legacy');
  assert.deepEqual(
    w.commands.map((c) => [c.id, c.status, c.reason]),
    [
      ['dev-server', 'blocked', 'listen-denied'],
      ['create', 'blocked', 'network-denied'],
      ['verify-browser', 'outside', 'process-abort'],
      ['e2e', 'outside', 'process-abort'],
    ],
  );
  // Повтор под loopback: граница проверена, сервер проходит, интернет закрыт.
  const loop = w.loopback!;
  assert.equal(loop.status, 'resolves', loop.reason);
  assert.equal(loop.decision, 'lead');
  assert.deepEqual(loop.steps, ['dev-server']);
  assert.deepEqual(loop.change, {
    toolProfile: 'writer-loopback',
    created: true,
    roles: ['developer'],
  });
  assert.deepEqual(
    loop.commands.map((c) => [c.id, c.status, c.reason]),
    [
      [LOOPBACK_CHECK, 'ok', undefined],
      ['dev-server', 'ok', undefined],
      ['create', 'blocked', 'network-denied'],
      ['verify-browser', 'outside', 'process-abort'],
      ['e2e', 'outside', 'process-abort'],
    ],
  );
  assert.match(w.commands[0]!.advice!, /техническое решение ведущего, не вопрос владельцу/);
  // Повтор шёл с профилем прав loopback, первый проход — без него.
  const calls = codex.calls();
  const head = (a: string[]) => a.slice(0, a.indexOf('--')).join(' ');
  assert.doesNotMatch(head(calls[0]!), /allow_local_binding/);
  assert.match(head(calls[4]!), /features\.network_proxy=true.*allow_local_binding=true/);
  // Закрыт интернет — проба не зелёная; команда применения — одна.
  assert.equal(probe.ok, false);
  assert.equal(
    probe.loopbackCommand,
    `harness smoke --state ${join(f.root, 'state')} --policy ${f.policyPath} --sha HEAD --writer-probe --apply-loopback`,
  );
  // Без --apply-loopback политика не тронута.
  assert.equal(readFileSync(f.policyPath, 'utf8'), f.text);
  const text = writerProbeText(probe);
  assert.match(text, /verify-browser: вне исполнителя — проверка в браузере/);
  assert.match(
    text,
    /проверки в браузере \(verify-browser, e2e\): .*это ожидаемо и решения не требует/,
  );
  assert.match(text, /сеть loopback \(повтор пробы\): resolves .*ведущий, не владелец/);
  assert.match(text, /применить loopback: harness smoke .*--apply-loopback/);
  assert.doesNotMatch(text, /verify-browser: blocked/);
});

test('WD02: --apply-loopback — профиль с network: loopback у ролей исполнителя, запись с причиной, повтор пробы по новой политике; больше ничего не меняется', async () => {
  let codex!: ReturnType<typeof fakeCodex>;
  const f = fixture((raw, root) => {
    raw.roles = {
      developer: { writer: { runtime: 'codex' } },
      tester: { writer: { runtime: 'codex' } },
    };
    raw.toolProfiles = {};
    raw.repositories[0].writerProbe = [{ id: 'dev-server', command: fakeServe }];
    codex = fakeCodex(root);
  });
  const data = await f.smoke({ executables: { codex: codex.fake }, applyLoopback: true });
  cliDataSchemas.smoke.parse(data);
  const probe = data.writerProbe!;
  // Итог — повтор под записанной политикой: сеть loopback, шаг проходит.
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.equal(probe.loopbackCommand, undefined);
  const w = probe.writers[0]!;
  assert.deepEqual(
    [w.toolProfile, w.networkMode, w.roles],
    ['writer-loopback', 'loopback', ['developer', 'tester']],
  );
  assert.deepEqual(
    w.commands.map((c) => [c.id, c.status]),
    [
      [LOOPBACK_CHECK, 'ok'],
      ['dev-server', 'ok'],
    ],
  );
  const receipt = probe.loopbackApplied!;
  assert.equal(receipt.policy, f.policyPath);
  assert.match(receipt.reason, /dev-server закрыты только локальным портом.*без интернета/);
  assert.deepEqual(receipt.changes, [
    {
      runtime: 'codex',
      toolProfile: 'writer-loopback',
      created: true,
      roles: ['developer', 'tester'],
    },
  ]);
  assert.match(receipt.note, /APPROVAL_STALE/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(data.logs, 'writer-probe', 'loopback-receipt.json'), 'utf8')),
    receipt,
  );
  // Файл политики: ровно профиль и ссылки ролей на него.
  const after = JSON.parse(readFileSync(f.policyPath, 'utf8'));
  const expected = structuredClone(f.raw);
  expected.toolProfiles = { 'writer-loopback': { runtime: 'codex', network: 'loopback' } };
  expected.roles.developer.writer.toolProfile = 'writer-loopback';
  expected.roles.tester.writer.toolProfile = 'writer-loopback';
  assert.deepEqual(after, expected);
  const parsed = executionPolicySchema.parse(after);
  assert.equal(
    profileNetwork(
      'codex',
      parsed.toolProfiles[roleBinding(parsed, 'developer')!.writer.toolProfile!],
    ),
    'loopback',
  );
  // Сеть профиля входит в digest изоляции: ревью плана заново.
  assert.notEqual(isolationDigest(parsed), isolationDigest(f.policy));
  assert.deepEqual(parsed.isolation, f.policy.isolation);
});

test('WD03: loopback не применяется, когда он не помогает или недоступен; у существующего профиля меняется только network', async () => {
  // Шаг падает и под loopback — not-enough, команды применения нет.
  let codex!: ReturnType<typeof fakeCodex>;
  const stuck = fixture((raw, root) => {
    raw.roles = { developer: { writer: { runtime: 'codex', toolProfile: 'web' } } };
    raw.toolProfiles = { web: { runtime: 'codex', network: 'none', codexShell: true } };
    raw.repositories[0].writerProbe = [
      {
        id: 'serve',
        command: node(
          "console.error('Error: listen EPERM: operation not permitted');process.exit(1)",
        ),
      },
    ];
    codex = fakeCodex(root);
  });
  const a = await stuck.smoke({ executables: { codex: codex.fake }, applyLoopback: true });
  const wa = a.writerProbe!.writers[0]!;
  assert.equal(wa.loopback!.status, 'not-enough');
  assert.match(wa.loopback!.reason, /не проходят serve/);
  assert.equal(a.writerProbe!.loopbackCommand, undefined);
  assert.equal(a.writerProbe!.loopbackApplied, undefined);
  assert.equal(readFileSync(stuck.policyPath, 'utf8'), stuck.text, 'политика не тронута');
  assert.match(wa.commands[0]!.advice!, /gate harness/);

  // codex без network_proxy — unavailable, шаги под loopback не запускались.
  let old!: ReturnType<typeof fakeCodex>;
  const legacy = fixture((raw, root) => {
    raw.roles = { developer: { writer: { runtime: 'codex' } } };
    raw.toolProfiles = {};
    raw.repositories[0].writerProbe = [{ id: 'dev-server', command: fakeServe }];
    old = fakeCodex(root, { proxy: false });
  });
  const b = await legacy.smoke({ executables: { codex: old.fake } });
  const wb = b.writerProbe!.writers[0]!;
  assert.equal(wb.loopback!.status, 'unavailable');
  assert.match(wb.loopback!.reason, /network_proxy/);
  assert.deepEqual(wb.loopback!.commands, []);
  assert.equal(old.calls().length, 1, 'только первый проход');

  // Существующий профиль: patch меняет только его network, роли — прежние ссылки.
  const raw = {
    toolProfiles: { web: { runtime: 'codex', network: 'none', env: 1 } },
    roles: {},
    repositories: [{ id: 'app' }],
  };
  const next = withLoopback(raw, 'app', [
    { runtime: 'codex', toolProfile: 'web', created: false, roles: ['developer'] },
  ]);
  assert.deepEqual(next, {
    ...raw,
    toolProfiles: { web: { runtime: 'codex', network: 'loopback', env: 1 } },
  });
  assert.equal(raw.toolProfiles.web.network, 'none', 'исходный объект не меняется');
});

test(
  'WD04: claude с network: none — настоящая песочница закрывает listen; loopback открывает его, применяется и повторная проба зелёная',
  { skip: !isolationSupport().ok && 'sandbox-runtime недоступен' },
  async () => {
    const f = fixture((raw) => {
      raw.roles = { developer: { writer: { runtime: 'claude', toolProfile: 'web' } } };
      raw.toolProfiles = { web: { runtime: 'claude', network: 'none' } };
      raw.repositories[0].writerProbe = [{ id: 'dev-server', command: node(SERVE) }];
    });
    const plan = await f.smoke();
    const w = plan.writerProbe!.writers[0]!;
    assert.equal(w.commands[0]!.status, 'blocked', JSON.stringify(w.commands));
    assert.equal(w.loopback!.status, 'resolves', JSON.stringify(w.loopback));
    assert.deepEqual(w.loopback!.change, {
      toolProfile: 'web',
      created: false,
      roles: ['developer'],
    });
    const applied = await f.smoke({ applyLoopback: true });
    assert.equal(applied.writerProbe!.ok, true, JSON.stringify(applied.writerProbe));
    assert.equal(applied.writerProbe!.writers[0]!.networkMode, 'loopback');
    const after = JSON.parse(readFileSync(f.policyPath, 'utf8'));
    assert.deepEqual(after.toolProfiles, { web: { runtime: 'claude', network: 'loopback' } });
    assert.deepEqual(after.isolation, f.raw.isolation);
  },
);

test('WD05: doctor называет проверки в браузере ожидаемым состоянием, не проблемой; CLI --apply-loopback требует --writer-probe и --policy', async () => {
  assert.ok(isBrowserStep({ id: 'verify', command: ['pnpm', 'verify:browser'] }));
  assert.ok(
    isBrowserStep({ id: 'ui', command: ['agent-browser', 'open', 'http://127.0.0.1:3000'] }),
  );
  assert.ok(isBrowserStep({ id: 'shots', command: ['pnpm', 'exec', 'playwright', 'test'] }));
  assert.ok(!isBrowserStep({ id: 'dev', command: ['pnpm', 'dev'] }));
  const raw = structuredClone(example('policy')) as Record<string, any>;
  raw.repositories[0].writerProbe = [
    { id: 'dev', command: ['pnpm', 'dev'] },
    { id: 'verify-browser', command: ['pnpm', 'verify:browser'] },
  ];
  const policy = executionPolicySchema.parse(raw);
  const report = await doctor(policy, {}, undefined, undefined, undefined, {
    resourceDatabase: false,
  });
  cliDataSchemas.doctor.parse(report);
  assert.equal(report.notes?.length, 1);
  assert.match(
    report.notes[0] ?? '',
    /^browser-checks \S+ \(verify-browser\): Проверки в браузере — вне исполнителя.*решения не требует/,
  );
  assert.ok(!report.problems.some((p) => /browser|браузер/i.test(p)), report.problems.join('\n'));
  assert.ok(!(report.warnings ?? []).some((p) => /browser|браузер/i.test(p)));

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wdef-cli-')));
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(example('policy')));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  for (const args of [
    ['--policy', policyPath, '--apply-loopback'],
    ['--writer-probe', '--apply-loopback'],
  ]) {
    const r = run('smoke', '--state', join(dir, 'state'), '--sha', 'HEAD', ...args);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    assert.equal(out.error.code, 'INVALID_INPUT');
    assert.match(out.error.message, /--apply-loopback .*--writer-probe и --policy/);
  }
});
