import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliAdapter } from '../src/agents/cli-adapter.ts';
import {
  executionPolicySchema,
  harnessModeOf,
  strictSandbox,
  writeGuardActive,
} from '../src/contracts/index.ts';
import {
  guardCaches,
  guardedArgv,
  seatbeltProfile,
  writeGuardSupport,
} from '../src/environment/write-guard.ts';
import { example } from './fixtures.ts';

const supported = writeGuardSupport().ok;
const dockerUp = (() => {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: 'ignore',
      timeout: 20000,
    });
    return true;
  } catch {
    return false;
  }
})();
/** Headless-браузер машины: оболочка Playwright или Chrome; нет — тест браузера пропускается. */
const browser = (() => {
  const pw = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(pw))
    for (const dir of readdirSync(pw)
      .filter((d) => d.startsWith('chromium_headless_shell'))
      .sort()
      .reverse())
      for (const sub of readdirSync(join(pw, dir))) {
        const bin = join(pw, dir, sub, 'chrome-headless-shell');
        if (existsSync(bin)) return { bin, args: [] as string[] };
      }
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return existsSync(chrome) ? { bin: chrome, args: ['--headless=new'] } : undefined;
})();

test('политика без harnessMode — облегчённый режим; strict — прежняя песочница', () => {
  const raw = example('policy');
  delete raw.harnessMode;
  const light = executionPolicySchema.parse(raw);
  assert.equal(harnessModeOf(light), 'light');
  assert.equal(strictSandbox(light), false);
  assert.equal(writeGuardActive(light), true);
  const strict = executionPolicySchema.parse({ ...raw, harnessMode: 'strict' });
  assert.equal(strictSandbox(strict), true);
  assert.equal(writeGuardActive(strict), false);
  // isolation.mode: none и writeGuard.off снимают границу облегчённого режима.
  assert.equal(
    writeGuardActive(executionPolicySchema.parse({ ...raw, isolation: { mode: 'none' } })),
    false,
  );
  assert.equal(
    writeGuardActive(executionPolicySchema.parse({ ...raw, writeGuard: { off: true } })),
    false,
  );
});

test('кеши границы: умолчания, add, replace; профиль Seatbelt открывает только их и /dev', () => {
  const defaults = guardCaches(undefined, '/home/u').map((c) => c.source);
  for (const id of [
    'npm-cache',
    'playwright-mac',
    'core-simulator',
    'android-avd',
    'gradle-caches',
    'docker-buildx',
  ])
    assert.ok(defaults.includes(id), id);
  // Настройки CLI пользователя, исполняемые каталоги npx и глобальные
  // пакеты, целиком ~/.cache и ~/Library/Caches на запись не открыты; то, что
  // инструменты обязаны писать (gradle, corepack, .tools pnpm), — открыто.
  const paths = guardCaches(undefined, '/home/u').map((c) => c.path);
  for (const p of paths)
    assert.ok(
      !/\/\.(codex|claude)(\.json)?$|\/\.claude\/|_npx|\/\.gradle$|\/Library\/Caches$|\/\.cache$|\/\.npm$/.test(
        p,
      ),
      p,
    );
  for (const need of [
    '/home/u/.gradle/daemon',
    '/home/u/.gradle/native',
    '/home/u/.gradle/.tmp',
    '/home/u/.gradle/wrapper/dists',
    '/home/u/.maestro',
    '/home/u/.cache/node/corepack',
    '/home/u/Library/pnpm/.tools',
  ])
    assert.ok(
      paths.some((p) => p.endsWith(need.slice('/home/u'.length))),
      need,
    );
  const added = guardCaches({ add: ['~/.custom-cache'] }, '/home/u');
  assert.ok(added.some((c) => c.path.endsWith('/home/u/.custom-cache')));
  assert.deepEqual(
    guardCaches({ replace: ['/opt/cache'] }, '/home/u').map((c) => c.path),
    ['/opt/cache'],
  );
  const profile = seatbeltProfile([{ subpath: '/w/tree' }, { prefix: '/h/.claude.json' }]);
  assert.match(profile, /\(allow default\)/);
  assert.match(
    profile,
    /\(deny file-write\* \(require-not \(require-any \(subpath "\/dev"\) \(subpath "\/w\/tree"\)/,
  );
  assert.match(profile, /regex #"\^\\\/h\\\/\\\.claude\\\.json"/);
  assert.match(profile, /\/bin\/ps"\) \(with no-sandbox\)/);
});

test(
  'граница записи: запись в своё дерево есть, вне — нет; ps и сигналы работают',
  { skip: !supported },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-')));
    const own = join(root, 'tree');
    execFileSync('mkdir', ['-p', own]);
    const run = (script: string) =>
      spawnSync(
        guardedArgv(['/bin/sh', '-c', script], [{ subpath: own }])[0]!,
        guardedArgv(['/bin/sh', '-c', script], [{ subpath: own }]).slice(1),
        {
          encoding: 'utf8',
        },
      );
    assert.equal(run(`echo ok > ${own}/inside`).status, 0);
    assert.equal(readFileSync(join(own, 'inside'), 'utf8'), 'ok\n');
    const outside = run(`echo no > ${root}/outside`);
    assert.notEqual(outside.status, 0);
    assert.equal(existsSync(join(root, 'outside')), false);
    // Чтение не закрыто, список процессов и сигналы открыты.
    assert.equal(run(`cat ${own}/inside`).stdout, 'ok\n');
    assert.equal(run('ps -o pid= -p 1').status, 0);
    assert.equal(run('sleep 30 & kill $!').status, 0);
  },
);

/**
 * Исполнитель облегчённого режима — настоящий адаптер CLI с подставным
 * runtime: процесс runtime и его потомки под границей записи. Runtime
 * запускает docker и headless-браузер (профиль во временном каталоге) и
 * пытается писать вне разрешённого; итог пишет в своё дерево.
 */
test(
  'исполнитель облегчённого режима: docker и headless-браузер работают, запись вне дерева закрыта',
  { skip: !supported, timeout: 180_000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'light-writer-')));
    const cwd = join(root, 'worktree');
    const scratch = join(root, 'scratch');
    execFileSync('mkdir', ['-p', cwd, scratch]);
    const outside = join(root, 'outside.txt');
    // Свой HOME с настройками CLI: исполнитель их не меняет (alpha.69, ревью).
    const home = join(root, 'home');
    execFileSync('mkdir', ['-p', join(home, '.codex'), join(home, '.claude')]);
    writeFileSync(join(home, '.codex', 'auth.json'), '{"fake":true}');
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n');
    writeFileSync(join(home, '.claude', 'settings.json'), '{}');
    // Каталог вызова вне временного каталога: файл ответа codex пишется в него.
    const call = realpathSync(mkdtempSync('/tmp/light-call-'));
    t.after(() => rmSync(call, { recursive: true, force: true }));
    const exe = join(root, 'fake-runtime.sh');
    writeFileSync(
      exe,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake 1.0"; exit 0; fi
cat > /dev/null
R="${cwd}/report.txt"
OUT=""
while [ $# -gt 0 ]; do [ "$1" = "--output-last-message" ] && OUT="$2"; shift; done
( echo hacked > "$HOME/.claude/settings.json" ) 2>/dev/null && echo "claude-settings=ok" >> "$R" || echo "claude-settings=denied" >> "$R"
( echo hacked > "$HOME/.codex/config.toml" ) 2>/dev/null && echo "codex-config=ok" >> "$R" || echo "codex-config=denied" >> "$R"
[ -f "$CODEX_HOME/auth.json" ] && [ "$CODEX_HOME" != "$HOME/.codex" ] && echo "codex-home=own" >> "$R" || echo "codex-home=shared" >> "$R"
( echo '{"refreshed":true}' > "$CODEX_HOME/auth.json" ) 2>/dev/null && echo "auth-refresh=ok" >> "$R" || echo "auth-refresh=denied" >> "$R"
( ln -sf "$HOME/.codex/config.toml" "$CALL_DIR/runtime.log" ) 2>/dev/null && echo "call-dir=ok" >> "$R" || echo "call-dir=denied" >> "$R"
( echo inside > "${cwd}/inside.txt" ) && echo "write-inside=ok" >> "$R" || echo "write-inside=fail" >> "$R"
( echo outside > "${outside}" ) 2>/dev/null && echo "write-outside=ok" >> "$R" || echo "write-outside=denied" >> "$R"
( echo tmp > "$TMPDIR/t.txt" ) && echo "write-tmp=ok" >> "$R" || echo "write-tmp=fail" >> "$R"
ps -o pid= -p 1 > /dev/null && echo "ps=ok" >> "$R" || echo "ps=fail" >> "$R"
${dockerUp ? `docker ps -q > /dev/null 2>&1 && echo "docker=ok" >> "$R" || echo "docker=fail" >> "$R"` : 'echo "docker=skip" >> "$R"'}
${
  browser
    ? `"${browser.bin}" ${browser.args.join(' ')} --no-sandbox --user-data-dir="$TMPDIR/profile" --dump-dom 'data:text/html,<p>guarded</p>' 2>/dev/null | grep -q guarded && echo "browser=ok" >> "$R" || echo "browser=fail" >> "$R"`
    : 'echo "browser=skip" >> "$R"'
}
printf '{"done":true}' > "$OUT"
echo '{}'
`,
    );
    chmodSync(exe, 0o755);
    const adapter = cliAdapter('codex', { executable: exe });
    const response = await adapter.invoke(
      {
        callId: 'c1',
        task: 'implement',
        binding: { runtime: 'codex' },
        cwd,
        prompt: 'p',
        session: { kind: 'fresh' },
        sandbox: {
          mode: 'os',
          writable: [cwd, scratch],
          denied: [],
          network: { domains: [] },
          light: { guard: [cwd, scratch] },
        },
        timeoutMs: 150_000,
        env: { PATH: process.env.PATH!, HOME: home, TMPDIR: scratch, CALL_DIR: call },
        artifactDir: call,
      },
      AbortSignal.timeout(170_000),
    );
    const report = Object.fromEntries(
      readFileSync(join(cwd, 'report.txt'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => l.split('=') as [string, string]),
    );
    assert.equal(response.status, 'ok', JSON.stringify(response.diagnostics));
    assert.deepEqual(response.output, { done: true }, 'ответ из каталога вызова прочитан');
    assert.equal(report['claude-settings'], 'denied');
    assert.equal(report['codex-config'], 'denied');
    assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), 'model = "x"\n');
    assert.equal(report['codex-home'], 'own');
    // Вход — ссылкой на настоящий файл: обновление токена попадает в него,
    // копий входа нет ни в каталоге вызова, ни после вызова.
    assert.equal(report['auth-refresh'], 'ok');
    assert.equal(
      readFileSync(join(home, '.codex', 'auth.json'), 'utf8').trim(),
      '{"refreshed":true}',
    );
    assert.equal(existsSync(join(call, 'auth.json')), false);
    assert.equal(existsSync(join(call, 'runtime-home')), false);
    // Каталог вызова (журнал, итог controller) исполнителю не открыт.
    assert.equal(report['call-dir'], 'denied');
    assert.equal(existsSync(join(call, 'result.json')), true, 'итог перенесён controller');
    assert.equal(report['write-inside'], 'ok');
    assert.equal(report['write-tmp'], 'ok');
    assert.equal(report['write-outside'], 'denied');
    assert.equal(existsSync(outside), false);
    assert.equal(report.ps, 'ok');
    if (dockerUp) assert.equal(report.docker, 'ok');
    else t.diagnostic('docker недоступен: проверка docker пропущена');
    if (browser) assert.equal(report.browser, 'ok');
    else t.diagnostic('headless-браузер не найден: проверка браузера пропущена');
  },
);

test(
  'отказ механизма границы: домашний каталог CLI не создаётся, вход нигде не оседает',
  { skip: !supported },
  async () => {
    const { writeGuardProbe } = await import('../src/environment/write-guard.ts');
    const { controllerTemp } = await import('../src/environment/controller-temp.ts');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'light-refuse-')));
    const home = join(root, 'home');
    execFileSync('mkdir', ['-p', join(home, '.codex'), join(root, 'call'), join(root, 'w')]);
    writeFileSync(join(home, '.codex', 'auth.json'), '{"fake":true}');
    const before = readdirSync(controllerTemp.dir()).filter((n) => n.startsWith('hx-home-'));
    const original = writeGuardProbe.support;
    writeGuardProbe.support = () => ({ ok: false, detail: 'нет механизма (тест)' });
    try {
      const out = await cliAdapter('codex', { executable: '/bin/echo' }).invoke(
        {
          callId: 'c2',
          task: 'implement',
          binding: { runtime: 'codex' },
          cwd: join(root, 'w'),
          prompt: 'p',
          session: { kind: 'fresh' },
          sandbox: {
            mode: 'os',
            writable: [join(root, 'w')],
            denied: [],
            network: { domains: [] },
            light: { guard: [join(root, 'w')] },
          },
          timeoutMs: 10_000,
          env: { PATH: process.env.PATH!, HOME: home },
          artifactDir: join(root, 'call'),
        },
        AbortSignal.timeout(20_000),
      );
      assert.equal(out.status, 'unavailable');
      assert.match(out.diagnostics.reason ?? '', /нет механизма \(тест\)/);
      const after = readdirSync(controllerTemp.dir()).filter((n) => n.startsWith('hx-home-'));
      assert.deepEqual(after, before, 'домашний каталог не создан');
      assert.deepEqual(
        readdirSync(join(root, 'call')).filter((n) => /auth|credentials|home/.test(n)),
        [],
      );
    } finally {
      writeGuardProbe.support = original;
    }
  },
);
