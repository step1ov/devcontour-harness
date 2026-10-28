import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import type { EvidenceRecord } from '../src/contracts/index.ts';
import {
  checkoutCacheBase,
  checkoutPath,
  chooseCheckoutRoot,
  stateHash,
} from '../src/environment/checkout-root.ts';
import {
  hiddenReadRule,
  isolation,
  isolationSupport,
  parseSandboxLog,
  sandboxDenials,
} from '../src/environment/isolation.ts';
import { git } from '../src/environment/process.ts';
import { UntrustedCheckoutError, resetGitTrust } from '../src/environment/git-trust.ts';
import { redactor } from '../src/environment/redaction.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { Runner } from '../src/engine/runner.ts';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import { runGate } from '../src/verification/gates.ts';
import { repo, write } from './git-fixture.ts';
import { approve, bin, greet, implement, runAll, setup } from './runner-fixture.ts';
import { policyOf } from './engine-fixture.ts';
import { runGatesAt } from '../src/verification/gates-at.ts';
import { moveBase } from '../src/control/base-move.ts';
import { executionPolicySchema, type ExecutionPolicy } from '../src/contracts/index.ts';

/**
 * Рабочие деревья попыток вне дерева человека. При встроенном размещении
 * каталог состояния лежит внутри репозитория (`<W>/.devcontour-local`), и
 * checkout кандидата внутри него получал EPERM на `stat('<W>/package.json')`
 * от инструментов, ищущих конфигурацию вверх по дереву.
 */
const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const support = isolationSupport();
const noSandbox = support.ok ? false : 'песочница ОС недоступна: ' + support.detail;
const mac = process.platform === 'darwin';

/** Ищет package.json вверх от cwd, как browserslist/Metro: EPERM — падение. */
const walkUp = `
const fs = require('fs'), path = require('path');
for (let d = path.dirname(process.cwd()); ; d = path.dirname(d)) {
  try { fs.statSync(path.join(d, 'package.json')); }
  catch (e) { if (e.code !== 'ENOENT') { console.error(e.message); process.exit(1); } }
  if (path.dirname(d) === d) break;
}
`;

test('CR01: выбор корня — macOS и Linux, устойчивый хэш, отдельное размещение и заданный корень', () => {
  const w = tmp('harness-cr-w-');
  const state = join(w, '.devcontour-local');
  const home = '/home/u';
  const same = () => 1;
  const mac = chooseCheckoutRoot({
    stateDirs: [state],
    repositories: [w],
    platform: 'darwin',
    home,
    create: false,
    device: same,
  });
  assert.equal(mac.placement, 'cache');
  assert.equal(mac.root, join(home, 'Library/Caches/devcontour-harness', stateHash(state)));
  assert.match(stateHash(state), /^[0-9a-f]{16}$/);
  // Ещё не созданный каталог состояния и его написание через symlink — тот же хэш.
  const alias = join(tmp('harness-cr-alias-'), 'link');
  symlinkSync(w, alias);
  assert.equal(stateHash(join(alias, '.devcontour-local')), stateHash(state));
  assert.notEqual(stateHash(join(w, 'other')), stateHash(state));
  const linux = (env: NodeJS.ProcessEnv) =>
    chooseCheckoutRoot({
      stateDirs: [state],
      repositories: [w],
      platform: 'linux',
      env,
      home,
      create: false,
      device: same,
    }).root;
  assert.equal(linux({}), join(home, '.cache/devcontour-harness', stateHash(state)));
  assert.equal(
    linux({ XDG_CACHE_HOME: '/xdg' }),
    join('/xdg/devcontour-harness', stateHash(state)),
  );
  // Относительный XDG_CACHE_HOME спецификация велит игнорировать.
  assert.equal(linux({ XDG_CACHE_HOME: 'rel' }), linux({}));
  assert.equal(
    checkoutCacheBase('darwin', {}, home),
    join(home, 'Library/Caches/devcontour-harness'),
  );

  // Отдельное размещение: каталог состояния рядом с репозиторием — прежнее место.
  const separate = tmp('harness-cr-state-');
  assert.deepEqual(
    chooseCheckoutRoot({
      stateDirs: [separate],
      repositories: [w],
      home,
      create: false,
      device: same,
    }),
    { placement: 'in-place' },
  );
  // Каталог состояния сам закрыт (он в hidden) — это не вложенность.
  assert.equal(
    chooseCheckoutRoot({ stateDirs: [separate], repositories: [w], hidden: [separate] }).placement,
    'in-place',
  );
  // Внутри закрытого пути (каталог учётных данных) — вне дерева.
  assert.equal(
    chooseCheckoutRoot({
      stateDirs: [join(separate, 'inner')],
      repositories: [w],
      hidden: [separate],
      home,
      create: false,
      device: same,
    }).placement,
    'cache',
  );
  // Каталог попыток компонента внутри его репозитория при общем каталоге рядом:
  // хэш — от общего каталога состояния.
  assert.equal(
    chooseCheckoutRoot({
      stateDirs: [separate, state],
      repositories: [w],
      platform: 'darwin',
      home,
      create: false,
      device: same,
    }).root,
    join(home, 'Library/Caches/devcontour-harness', stateHash(separate)),
  );
  // Заданный хостом корень — как есть.
  const configured = tmp('harness-cr-conf-');
  assert.deepEqual(
    chooseCheckoutRoot({ stateDirs: [state], repositories: [w], configured: configured }),
    { root: configured, placement: 'configured' },
  );
  assert.equal(
    checkoutPath(mac, '/legacy', 'app', 'worktrees', 'R1'),
    join(mac.root, 'app', 'worktrees', 'R1'),
  );
  assert.equal(checkoutPath({ placement: 'in-place' }, '/legacy', 'app', 'worktrees'), '/legacy');
});

test('CR02: кэш на другом томе, чем репозиторий, — прежнее место и пояснение для doctor', () => {
  const w = tmp('harness-cr-w-');
  const state = join(w, '.devcontour-local');
  const home = '/home/u';
  const device = (path: string) => (path.startsWith(home) ? 2 : 1);
  const choice = chooseCheckoutRoot({
    stateDirs: [state],
    repositories: [w],
    platform: 'linux',
    env: {},
    home,
    create: false,
    device,
  });
  assert.equal(choice.placement, 'cross-volume');
  assert.equal(choice.root, undefined);
  assert.match(choice.note!, /на другом томе/);
  assert.match(choice.note!, /checkoutRoot/);
  // Неизвестный том (нет stat) отказом не считается.
  assert.equal(
    chooseCheckoutRoot({
      stateDirs: [state],
      repositories: [w],
      platform: 'linux',
      env: {},
      home,
      create: false,
      device: () => undefined,
    }).placement,
    'cache',
  );
});

test('CR03: корень вне дерева закрыт целиком, как каталог состояния; свои деревья открыты разрешением', () => {
  const root = tmp('harness-cr-root-');
  const own = join(root, 'app', 'worktrees', 'R1');
  const dep = join(root, 'app', 'dependencies', 'R1', 'lib');
  for (const d of [own, dep]) mkdirSync(d, { recursive: true });
  const state = tmp('harness-cr-state-');
  const policy = isolation({
    write: [own],
    controller: [state],
    readable: [dep],
    checkouts: [root],
  });
  assert.ok(policy.hidden.includes(state));
  assert.ok(policy.hidden.includes(root), 'корень закрыт целиком — и будущие деревья');
  assert.ok(policy.write.includes(own) && policy.readable.includes(dep));
  // Без корня граница прежняя.
  assert.ok(!isolation({ write: [own], controller: [state] }).hidden.includes(root));
});

test('CR04: git хоста доверяет деревьям вне дерева; прежние деревья в каталоге состояния убираются как раньше', async () => {
  resetGitTrust();
  const r = repo();
  const state = join(r.dir, '.devcontour-local');
  const root = tmp('harness-cr-root-');
  const outside = join(root, 'app', 'worktrees', 'R1');
  mkdirSync(dirname(outside), { recursive: true });
  await git(r.dir, 'worktree', 'add', '--detach', outside, r.head());
  assert.equal(await git(outside, 'rev-parse', 'HEAD'), r.head());
  // Подмена `.git` созданного дерева — по-прежнему отказ.
  const dotgit = join(outside, '.git');
  const original = execFileSync('cat', [dotgit], { encoding: 'utf8' });
  writeFileSync(dotgit, original + '\n');
  await assert.rejects(git(outside, 'status'), UntrustedCheckoutError);
  writeFileSync(dotgit, original);
  await git(r.dir, 'worktree', 'remove', '--force', outside);
  assert.equal(existsSync(outside), false);
  // Дерево прежней версии внутри каталога состояния в репозитории.
  const old = join(state, 'worktrees', 'R0');
  mkdirSync(dirname(old), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', old, r.head()], {
    cwd: r.dir,
    stdio: 'pipe',
  });
  await git(r.dir, 'worktree', 'remove', '--force', old);
  assert.equal(existsSync(old), false);
  // Файл `.git` созданного хостом дерева удалён: git не уходит в репозиторий
  // предка (здесь — checkout человека), а отказывает.
  const bare = join(state, 'worktrees', 'R5');
  await git(r.dir, 'worktree', 'add', '--detach', bare, r.head());
  rmSync(join(bare, '.git'));
  await assert.rejects(git(bare, 'status'), /\.git рабочего дерева удалён/);
  await git(r.dir, 'worktree', 'prune');
  // Дерево, удалённое мимо git, снимается prune — и под корнем вне дерева.
  const lost = join(root, 'app', 'worktrees', 'R2');
  await git(r.dir, 'worktree', 'add', '--detach', lost, r.head());
  rmSync(lost, { recursive: true, force: true });
  await git(r.dir, 'worktree', 'prune');
  assert.doesNotMatch(await git(r.dir, 'worktree', 'list', '--porcelain'), /R2/);
});

test('CR05: отказ чтения файла в закрытом предке cwd с EPERM в выводе — отказ среды; другой закрытый путь, без EPERM, внутри открытого и чужой тег — нет', () => {
  const w = '/w';
  const cwd = `${w}/.devcontour-local/worktrees/R1`;
  const policy = {
    write: [cwd],
    hidden: [w, `${w}/.devcontour-local`, '/home/u/.ssh'],
    readable: [cwd, `${w}/.git`],
    domains: [],
  };
  const line = (op: string, path: string, tag: string) =>
    `2026-10-28 12:34:52.273 E  kernel[0:1] (Sandbox) Sandbox: node(42) deny(1) ${op} ${path}\nCMD64_${Buffer.from(tag + ' node x').toString('base64')}_END_SBX`;
  const log = [
    line('file-read-metadata', `${w}/package.json`, 'dcmine'),
    line('file-read-data', `${w}/.git/config`, 'dcmine'),
    line('file-read-data', `${w}/secret`, 'dcother'),
  ].join('\n');
  const parsed = parseSandboxLog(log, 'dcmine');
  assert.equal(parsed.length, 2);
  const output = `Error: EPERM: operation not permitted, stat '${w}/package.json'\n    at findConfigFile`;
  const found = sandboxDenials(parsed, policy, output, cwd);
  assert.deepEqual(
    found.map((d) => d.path),
    [`${w}/package.json`],
  );
  assert.match(found[0]!.rule, /запрет чтения песочницы: \/w закрыт/);
  // Без рабочего каталога (прежний вызов) и вне предков cwd — нет.
  assert.deepEqual(sandboxDenials(parsed, policy, output), []);
  assert.deepEqual(sandboxDenials(parsed, policy, output, '/elsewhere/x'), []);
  // Отказ, который проверка пережила (EPERM в выводе нет), — не отказ среды.
  assert.deepEqual(
    sandboxDenials(parsed, policy, 'AssertionError: expected 1 to equal 2', cwd),
    [],
  );
  // Путь в выводе без EPERM (тест назвал файл в своём сообщении) — тоже нет.
  assert.deepEqual(
    sandboxDenials(parsed, policy, `AssertionError: expected config ${w}/package.json`, cwd),
    [],
  );
  // Без вывода чтение не учитывается.
  assert.deepEqual(sandboxDenials(parsed, policy, undefined, cwd), []);
  // EPERM на другом пути — не этот отказ.
  assert.deepEqual(
    sandboxDenials(parsed, policy, `EPERM: operation not permitted, open '/x'`, cwd),
    [],
  );
  // Прочитанный и напечатанный закрытый путь не в форме поиска вверх
  // (ключ ~/.ssh, файл в подкаталоге закрытого репозитория) с настоящим
  // провалом теста — gate, а не отказ среды.
  for (const path of ['/home/u/.ssh/id_rsa', `${w}/sub/secret.json`]) {
    const v = parseSandboxLog(line('file-read-data', path, 'dcmine'), 'dcmine');
    assert.deepEqual(
      sandboxDenials(
        v,
        policy,
        `warn: EPERM: operation not permitted, open '${path}'\nAssertionError: expected 1 to equal 2`,
        cwd,
      ),
      [],
      path,
    );
  }
  // Открытое внутри закрытого и закрытое внутри открытого.
  assert.equal(hiddenReadRule(policy, `${w}/.git/HEAD`), undefined);
  assert.equal(hiddenReadRule(policy, `${cwd}/package.json`), undefined);
  assert.ok(
    hiddenReadRule({ ...policy, hidden: [...policy.hidden, `${w}/.git/x`] }, `${w}/.git/x/y`),
  );
  // macOS: ядро пишет /private/var, вывод — /var.
  const priv = { ...policy, hidden: ['/private/var/w'] };
  const pv = parseSandboxLog(
    line('file-read-metadata', '/private/var/w/package.json', 'dcmine'),
    'dcmine',
  );
  assert.equal(
    sandboxDenials(
      pv,
      priv,
      `EPERM: operation not permitted, stat '/var/w/package.json'`,
      '/private/var/w/state/wt',
    ).length,
    1,
  );
});

async function gate(
  cwd: string,
  sha: string,
  script: string | string[],
  boundary: Parameters<typeof runGate>[0]['boundary'],
) {
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  try {
    await runGate({
      policy: { isolation: { mode: 'os', domains: [] } },
      record: (e) => {
        recorded.push(e);
        return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
      },
      cwd,
      sha,
      phase: 'candidate',
      gate: {
        id: 'walk',
        kind: 'check',
        timeoutMs: 20000,
        command: Array.isArray(script) ? script : [process.execPath, '-e', script],
      },
      artifactDir: tmp('harness-cr-art-'),
      signal: new AbortController().signal,
      execution: { env: process.env, redact: redactor([]) },
      boundary,
    });
  } catch (error) {
    if (!(error instanceof TaskFailure)) throw error;
    return { failure: error, evidence: recorded[0]! };
  }
  return { failure: undefined, evidence: recorded[0]! };
}

test(
  'CR06: gate, ищущий package.json вверх, — вне дерева проходит; внутри закрытого репозитория — отказ среды с путём, а пережитый отказ и обычный провал — gate',
  { skip: noSandbox },
  async () => {
    const r = repo({ 'README.md': 'app\n', 'package.json': '{}' });
    const sha = r.head();
    const state = join(r.dir, '.devcontour-local');
    const boundary = { hidden: [r.dir, state], readable: [join(r.dir, '.git')] };

    // Вне дерева: предки checkout открыты, соседняя попытка закрыта.
    const root = tmp('harness-cr-root-');
    const own = join(root, 'app', 'worktrees', 'R1');
    const other = join(root, 'app', 'worktrees', 'R2');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'secret.txt'), 'x');
    mkdirSync(dirname(own), { recursive: true });
    await git(r.dir, 'worktree', 'add', '--detach', own, sha);
    const sibling = `try{require('fs').readFileSync(${JSON.stringify(join(other, 'secret.txt'))});console.error('sibling readable');process.exit(1)}catch(e){if(e.code!=='EPERM'){console.error(e.code);process.exit(1)}}`;
    const passed = await gate(own, sha, walkUp + sibling, { ...boundary, checkouts: [root] });
    assert.equal(passed.failure, undefined, passed.evidence.summary);

    // Прежнее размещение: checkout внутри закрытого каталога состояния в репозитории.
    const inTree = join(state, 'worktrees', 'R3');
    mkdirSync(dirname(inTree), { recursive: true });
    await git(r.dir, 'worktree', 'add', '--detach', inTree, sha);
    const nested = await gate(inTree, sha, walkUp, boundary);
    assert.match(nested.failure?.message ?? '', /EPERM: operation not permitted, stat/);
    // Классификация — по журналу ядра (macOS). Отказ системной утилиты stat:
    // ядро может перестать сообщать об отказах node после их серии.
    if (mac) {
      const stat = await gate(
        inTree,
        sha,
        ['/usr/bin/stat', join(r.dir, 'package.json')],
        boundary,
      );
      assert.equal(stat.failure?.kind, 'environment', stat.evidence.summary);
      assert.match(
        stat.failure.message,
        /песочница проверки отказала в доступе: \S*package\.json — запрет чтения песочницы/,
      );
    }
    // Отказ node класс получает тот же, когда ядро о нём сообщило; иначе — gate.
    if (nested.failure?.kind === 'environment')
      assert.match(nested.failure.message, /отказала в доступе: \S*package\.json — запрет чтения/);
    else assert.equal(nested.failure?.kind, 'gate');
    // Отказ, который проверка пережила, затем обычный провал — класс gate.
    const tolerated = await gate(
      inTree,
      sha,
      `try{require('fs').statSync(${JSON.stringify(join(r.dir, 'package.json'))})}catch{};console.error('expected 1 to equal 2');process.exit(1)`,
      boundary,
    );
    assert.equal(tolerated.failure?.kind, 'gate', tolerated.evidence.summary);
    // Закрытый путь не в форме поиска вверх, напечатанный с EPERM, и
    // настоящий провал теста — gate: отказ среды не тратит попытку и
    // останавливает очередь.
    mkdirSync(join(r.dir, 'sub'), { recursive: true });
    writeFileSync(join(r.dir, 'sub', 'secret.json'), '{}');
    const ssh = join(homedir(), '.ssh');
    for (const path of [join(r.dir, 'sub', 'secret.json'), ...(existsSync(ssh) ? [ssh] : [])]) {
      const printed = await gate(
        inTree,
        sha,
        `const fs=require('fs');try{fs.statSync(${JSON.stringify(path)}).isDirectory()?fs.readdirSync(${JSON.stringify(path)}):fs.readFileSync(${JSON.stringify(path)})}catch(e){console.error('warn: '+e.message)};console.error('AssertionError: expected 1 to equal 2');process.exit(1)`,
        boundary,
      );
      assert.match(printed.evidence.summary, /EPERM|operation not permitted/i, path);
      assert.equal(printed.failure?.kind, 'gate', path + ': ' + printed.evidence.summary);
    }
    await git(r.dir, 'worktree', 'remove', '--force', inTree);
    await git(r.dir, 'worktree', 'remove', '--force', own);
  },
);

/** Попытка движка с каталогом состояния внутри репозитория (встроенное размещение). */
function embedded(checkoutRoot?: string) {
  const ctx = setup({
    scenario: { writer: implement(), reviewer: approve() },
    files: { 'package.json': '{}', 'test/walk.js': walkUp + "require('./run.js');\n" },
    policy: (p) => {
      (p as { maxAttempts: number }).maxAttempts = 1;
      p.isolation = { mode: 'os', domains: [] };
      const repo = (p.repositories as { gates: { command: string[] }[] }[])[0]!;
      repo.gates[0]!.command = [process.execPath, 'test/walk.js'];
    },
  });
  const state = join(ctx.repo.dir, '.devcontour-local');
  mkdirSync(state, { recursive: true });
  ctx.runner = new Runner({
    engine: ctx.engine,
    stateDir: state,
    baseDir: ctx.repo.dir,
    adapters: {
      claude: cliAdapter('claude', {
        executable: bin('fake-claude'),
        toolProfiles: ctx.policy.toolProfiles,
      }),
      codex: cliAdapter('codex', {
        executable: bin('fake-codex'),
        toolProfiles: ctx.policy.toolProfiles,
      }),
    },
    owner: 'runner-1',
    resourceDatabase: join(ctx.state, 'resources.sqlite'),
    ...(checkoutRoot ? { checkoutRoot } : {}),
  });
  return { ctx, state };
}

test(
  'CR07: встроенное размещение — рабочие деревья вне дерева, gate, ищущий package.json вверх, проходит под песочницей ОС',
  { skip: noSandbox },
  async () => {
    const root = tmp('harness-cr-root-');
    const { ctx, state } = embedded(root);
    assert.deepEqual(ctx.runner.checkoutRoot(), { root, placement: 'configured' });
    await runAll(ctx);
    const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
    assert.equal(a.status, 'succeeded', a.error);
    assert.equal(a.worktree, join(root, 'app', 'worktrees', a.id));
    assert.ok(!existsSync(a.worktree), 'рабочее дерево убрано');
    assert.ok(existsSync(join(state, 'artifacts', a.id)), 'артефакты — в каталоге состояния');
    assert.ok(!existsSync(join(state, 'worktrees')), 'в дереве человека рабочих деревьев нет');
    assert.equal(
      a.evidence.filter((e) => e.kind === 'test' && e.passed).length,
      2,
      'gate обеих фаз прошёл',
    );
  },
);

test(
  'CR08: без checkoutRoot встроенное размещение выбирает кэш пользователя вне дерева (HOME — во временном каталоге)',
  { skip: noSandbox },
  async () => {
    // Настоящий кэш пользователя тест не трогает: HOME и XDG_CACHE_HOME — свои.
    const saved = { HOME: process.env.HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
    const home = tmp('harness-cr-home-');
    mkdirSync(join(home, 'Library', 'Caches'), { recursive: true });
    mkdirSync(join(home, '.cache'));
    process.env.HOME = home;
    delete process.env.XDG_CACHE_HOME;
    try {
      const { ctx, state } = embedded();
      const base = checkoutCacheBase();
      assert.ok(base.startsWith(home + sep), base);
      const root = join(base, stateHash(state));
      assert.deepEqual(ctx.runner.checkoutRoot().root, root);
      assert.equal(ctx.runner.checkoutRoot().placement, 'cache');
      await runAll(ctx);
      const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
      assert.equal(a.status, 'succeeded', a.error);
      assert.ok(a.worktree!.startsWith(root + sep), a.worktree);
      assert.ok(!existsSync(join(state, 'worktrees')));
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  },
);

test('CR09: отдельное размещение — рабочие деревья на прежнем месте в каталоге состояния', async () => {
  const ctx = setup({ scenario: { writer: implement(), reviewer: approve() } });
  assert.deepEqual(ctx.runner.checkoutRoot(), { placement: 'in-place' });
  await runAll(ctx);
  const a = ctx.engine.read((v) => v.attempts('add-greeting')[0]!);
  assert.equal(a.status, 'succeeded', a.error);
  assert.equal(a.worktree, join(ctx.state, 'worktrees', a.id));
});

test(
  'CR10: проверка на SHA при встроенном размещении — дерево вне дерева, логи в каталоге состояния, пустые каталоги убраны',
  { skip: noSandbox },
  async () => {
    const root = tmp('harness-cr-root-');
    const { ctx, state } = embedded(root);
    write(ctx.repo.dir, { 'src/greet.js': greet });
    ctx.repo.git('add', '-A');
    ctx.repo.git('commit', '-q', '-m', 'greet');
    const recorded: EvidenceRecord[] = [];
    const result = await runGatesAt(
      {
        policy: ctx.policy,
        stateDir: state,
        checkoutRoot: root,
        repoPath: () => ctx.repo.dir,
        boundary: () => ({
          hidden: [state, ctx.repo.dir],
          readable: [join(ctx.repo.dir, '.git')],
        }),
        resourceDatabase: join(ctx.state, 'resources.sqlite'),
      },
      {
        id: 'GA-embedded',
        repositoryId: 'app',
        sha: ctx.repo.head(),
        gates: ['unit'],
        record: (e) => recorded.push(e),
      },
    );
    assert.equal(result.failure, undefined, JSON.stringify(recorded.map((e) => e.summary)));
    assert.ok(existsSync(join(state, 'gates-at', 'GA-embedded', 'artifacts')), 'логи на месте');
    assert.ok(!existsSync(join(state, 'gates-at', 'GA-embedded', 'worktree')));
    assert.ok(!existsSync(join(root, 'app', 'gates-at', 'GA-embedded')), 'каталог проверки убран');
    assert.ok(existsSync(join(root, 'app', 'gates-at')), 'дерево создавалось под корнем');
  },
);

test('CR11: перенос базы слиянием при встроенном размещении — дерево слияния вне дерева', async () => {
  const r = repo({ 'a.txt': '1\n' });
  const policy: ExecutionPolicy = executionPolicySchema.parse({
    ...policyOf(),
    repositories: [{ ...policyOf().repositories[0]!, id: 'app', path: r.dir }],
  });
  const ref = policy.repositories[0]!.targetRef;
  r.git('update-ref', ref, 'HEAD');
  const base = r.head();
  write(r.dir, { 'b.txt': '2\n' });
  r.git('add', '-A');
  r.git('commit', '-qm', 'work');
  r.git('checkout', '-q', '-b', 'side', base);
  write(r.dir, { 'c.txt': '3\n' });
  r.git('add', '-A');
  r.git('commit', '-qm', 'side');
  r.git('update-ref', ref, 'main');
  const state = join(r.dir, '.devcontour-local');
  const root = tmp('harness-cr-root-');
  const moved = await moveBase({ policy, baseDir: r.dir, stateDir: state, checkoutRoot: root });
  assert.equal(moved.updated[0]?.kind, 'merge');
  assert.ok(existsSync(join(root, 'app', 'base')), 'дерево слияния — под корнем');
  assert.deepEqual(readdirSync(join(root, 'app', 'base')), [], 'и убрано');
  assert.ok(!existsSync(join(state, 'worktrees')), 'в дереве человека деревьев нет');
});

test(
  'CR12: дерево другой попытки, созданное после построения политики, проверке не прочитать',
  { skip: noSandbox },
  async () => {
    const r = repo({ 'README.md': 'app\n', 'package.json': '{}' });
    const sha = r.head();
    const root = tmp('harness-cr-root-');
    const own = join(root, 'app', 'worktrees', 'R1');
    mkdirSync(dirname(own), { recursive: true });
    await git(r.dir, 'worktree', 'add', '--detach', own, sha);
    const late = join(root, 'app', 'worktrees', 'R9', 'secret.txt');
    // Ждёт появления файла: EPERM — закрыт (успех), чтение — провал.
    const poll = `const p=${JSON.stringify(late)};const t=Date.now();for(;;){try{fs.readFileSync(p);console.error('late sibling readable');process.exit(1)}catch(e){if(e.code==='EPERM')process.exit(0);if(e.code!=='ENOENT'){console.error(e.code);process.exit(1)}}if(Date.now()-t>15000){console.error('timeout');process.exit(2)}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)}`;
    const running = gate(own, sha, walkUp + poll, {
      hidden: [r.dir],
      readable: [join(r.dir, '.git')],
      checkouts: [root],
    });
    await new Promise((done) => setTimeout(done, 3000));
    mkdirSync(dirname(late), { recursive: true });
    writeFileSync(late, 'x');
    const result = await running;
    assert.equal(result.failure, undefined, result.evidence.summary);
    await git(r.dir, 'worktree', 'remove', '--force', own);
  },
);

test('CR13: корень внутри репозитория, закрытого пути или каталога состояния, ссылка и чужой каталог кэша — отказ', () => {
  const w = tmp('harness-cr-w-');
  const state = join(w, '.devcontour-local');
  const base = { stateDirs: [state], repositories: [w], device: () => 1 };
  // XDG_CACHE_HOME внутри репозитория: кэш вернул бы ту же вложенность.
  mkdirSync(join(w, '.cache'));
  const xdg = chooseCheckoutRoot({
    ...base,
    platform: 'linux',
    env: { XDG_CACHE_HOME: join(w, '.cache') },
    home: '/home/u',
  });
  assert.equal(xdg.placement, 'in-place');
  assert.equal(xdg.root, undefined);
  assert.match(xdg.note!, /^каталог кэша \S+ внутри /);
  assert.deepEqual(readdirSync(join(w, '.cache')), [], 'каталог в репозитории не создан');
  // Заданный корень внутри репозитория, каталога состояния или закрытого пути — ошибка.
  const separate = tmp('harness-cr-state-');
  for (const configured of [join(w, 'trees'), join(separate, 'trees')])
    assert.throws(
      () =>
        chooseCheckoutRoot({
          stateDirs: [separate],
          repositories: [w],
          hidden: [separate],
          configured,
        }),
      /INVALID_INPUT|внутри/,
      configured,
    );
  // Каталоги кэша создаются с правами 0700.
  const home = tmp('harness-cr-home-');
  mkdirSync(join(home, '.cache'));
  const made = chooseCheckoutRoot({ ...base, platform: 'linux', env: {}, home });
  assert.equal(made.placement, 'cache');
  for (const dir of [join(home, '.cache', 'devcontour-harness'), made.root!])
    assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
  // Каталог кэша — ссылка: отказ с пояснением, деревья на прежнем месте.
  const linked = tmp('harness-cr-home-');
  mkdirSync(join(linked, '.cache'));
  symlinkSync(tmp('harness-cr-elsewhere-'), join(linked, '.cache', 'devcontour-harness'));
  const link = chooseCheckoutRoot({ ...base, platform: 'linux', env: {}, home: linked });
  assert.equal(link.placement, 'in-place');
  assert.match(link.note!, /символическая ссылка/);
  // Чужой владелец каталога кэша и заданного корня.
  const foreign = chooseCheckoutRoot({ ...base, platform: 'linux', env: {}, home, uid: 12345 });
  assert.equal(foreign.placement, 'in-place');
  assert.match(foreign.note!, /другому пользователю/);
  assert.throws(
    () => chooseCheckoutRoot({ ...base, configured: tmp('harness-cr-conf-'), uid: 12345 }),
    /другому пользователю/,
  );
});
