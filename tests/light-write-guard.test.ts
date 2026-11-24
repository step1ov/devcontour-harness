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
  for (const id of ['npm', 'mac-caches', 'maestro', 'core-simulator', 'android', 'docker-buildx'])
    assert.ok(defaults.includes(id), id);
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
    const exe = join(root, 'fake-runtime.sh');
    writeFileSync(
      exe,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake 1.0"; exit 0; fi
cat > /dev/null
R="${cwd}/report.txt"
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
echo '{}'
`,
    );
    chmodSync(exe, 0o755);
    const adapter = cliAdapter('codex', { executable: exe });
    await adapter.invoke(
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
        env: { PATH: process.env.PATH!, HOME: homedir(), TMPDIR: scratch },
        artifactDir: join(root, 'call'),
      },
      AbortSignal.timeout(170_000),
    );
    const report = Object.fromEntries(
      readFileSync(join(cwd, 'report.txt'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => l.split('=') as [string, string]),
    );
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
