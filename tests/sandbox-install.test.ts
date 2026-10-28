import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { EvidenceRecord } from '../src/contracts/index.ts';
import { redactor } from '../src/environment/redaction.ts';
import {
  isolation,
  isolationSupport,
  protectedWriteDenies,
  sandboxDenials,
} from '../src/environment/isolation.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { runCheck, runGate } from '../src/verification/gates.ts';
import { repo } from './git-fixture.ts';

/**
 * Обязательный запрет записи sandbox-runtime для каталогов IDE не должен
 * ломать установку зависимостей: пакеты публикуют `.idea/` внутри
 * `node_modules`. Вне дерева зависимостей запрет остаётся.
 */
const support = isolationSupport();
const os = { config: { isolation: { mode: 'os' as const, domains: [] } } };
// Ограничение записано явно: без песочницы здесь нечего проверять.
const noSandbox = support.ok ? false : 'песочница ОС недоступна: ' + support.detail;
const mac = process.platform === 'darwin';

/** Скрипт, который пробует записать каждый путь и печатает, что удалось. */
const tryWrites = (paths: string[]) =>
  `const fs=require('fs'),path=require('path');const r={};for(const p of ${JSON.stringify(paths)}){try{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'x');r[p]=true}catch(e){r[p]=e.code||String(e)}}console.log(JSON.stringify(r))`;

async function check(dir: string, cwd: string, script: string) {
  const r = await runCheck(os, {
    argv: [process.execPath, '-e', script],
    cwd,
    env: process.env,
    signal: new AbortController().signal,
    write: [dir],
    readable: [],
    controller: [],
    settingsDir: mkdtempSync(join(tmpdir(), 'harness-sbx-settings-')),
  });
  return r;
}

test(
  'SBX01: в песочнице проверки каталоги IDE внутри node_modules записываются, вне него — нет',
  {
    skip: noSandbox,
  },
  async () => {
    const r = repo({ 'README.md': 'app\n', 'src/index.js': '', 'apps/mobile/package.json': '{}' });
    mkdirSync(join(r.dir, 'node_modules', 'existing'), { recursive: true });
    const at = (p: string) => join(r.dir, p);
    const allowed = [
      'node_modules/pkg/.idea/codeStyles/codeStyleConfig.xml',
      'node_modules/.pnpm/text-codec@0.6.3/node_modules/text-codec_tmp_1/.idea/codeStyles/x.xml',
      'node_modules/.pnpm/text-codec@0.6.3/node_modules/text-codec/.idea/workspace.xml',
      'node_modules/@scope/pkg/.vscode/settings.json',
      'apps/mobile/node_modules/dep/.idea/x.xml',
      'src/ok.txt',
    ];
    const denied = [
      '.idea/workspace.xml',
      '.vscode/tasks.json',
      'src/.idea/x.xml',
      'apps/mobile/.vscode/tasks.json',
      // Каталоги, которых до проверки не было.
      'newdir/.idea/x.xml',
      'apps/newpkg/.vscode/tasks.json',
      '.bashrc',
      'src/.zshrc',
      '.mcp.json',
      '.claude/commands/x.md',
      '.git/hooks/pre-commit',
      'node_modules/pkg/.git/hooks/post-checkout',
      'node_modules/pkg/.bashrc',
    ];
    const result = await check(r.dir, r.dir, tryWrites([...allowed, ...denied].map(at)));
    assert.equal(result.code, 0, result.stderr);
    const got = JSON.parse(result.stdout) as Record<string, true | string>;
    for (const p of allowed) assert.equal(got[at(p)], true, `запись разрешена: ${p}`);
    for (const p of denied) {
      // На Linux srt закрывает только уже существующие пути: проверяется macOS.
      if (!mac) continue;
      assert.equal(got[at(p)], 'EPERM', `запись закрыта: ${p}`);
      assert.equal(existsSync(at(p)), false, `файла нет: ${p}`);
    }
    // Gate из подкаталога: корень checkout закрыт так же.
    const sub = await check(
      r.dir,
      at('apps/mobile'),
      tryWrites([at('.idea/sub.xml'), at('node_modules/z/.idea/x.xml'), 'ok-relative']),
    );
    const s = JSON.parse(sub.stdout) as Record<string, true | string>;
    assert.equal(s[at('node_modules/z/.idea/x.xml')], true);
    assert.equal(s['ok-relative'], true);
    assert.ok(
      existsSync(at('apps/mobile/ok-relative')),
      'команда исполнялась в своём рабочем каталоге',
    );
    if (mac) assert.equal(s[at('.idea/sub.xml')], 'EPERM');
  },
);

test(
  'SBX02: npm install локального пакета с .idea в песочнице проверки ставит его целиком',
  {
    skip: noSandbox,
  },
  async () => {
    const npm = (process.env.PATH ?? '')
      .split(delimiter)
      .map((d) => join(d, 'npm'))
      .find((p) => existsSync(p));
    assert.ok(npm, 'npm есть рядом с node');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-sbx-npm-')));
    const pkg = join(root, 'src', 'package');
    mkdirSync(join(pkg, '.idea', 'codeStyles'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{"name":"dep","version":"1.0.0"}');
    writeFileSync(join(pkg, '.idea', 'codeStyles', 'codeStyleConfig.xml'), '<x/>');
    const app = join(root, 'app');
    mkdirSync(app);
    execFileSync('tar', ['czf', join(app, 'dep.tgz'), 'package'], {
      cwd: join(root, 'src'),
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    writeFileSync(
      join(app, 'package.json'),
      '{"name":"app","version":"1.0.0","dependencies":{"dep":"file:dep.tgz"}}',
    );
    writeFileSync(join(app, '.npmrc-user'), '');
    const r = await runCheck(os, {
      argv: [npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
      cwd: app,
      env: {
        ...process.env,
        npm_config_cache: join(app, '.npm-cache'),
        npm_config_userconfig: join(app, '.npmrc-user'),
        npm_config_update_notifier: 'false',
      },
      signal: new AbortController().signal,
      write: [app],
      readable: [],
      controller: [],
      settingsDir: mkdtempSync(join(tmpdir(), 'harness-sbx-settings-')),
    });
    assert.equal(r.code, 0, r.stderr);
    // npm отказ записи только предупреждает и выходит с 0: сверяется сам файл.
    assert.doesNotMatch(r.stdout + r.stderr, /EPERM|TAR_ENTRY_ERROR/);
    assert.equal(
      readFileSync(join(app, 'node_modules/dep/.idea/codeStyles/codeStyleConfig.xml'), 'utf8'),
      '<x/>',
    );
  },
);

async function gate(dir: string, sha: string, script: string) {
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  try {
    await runGate({
      policy: os.config,
      record: (e) => {
        recorded.push(e);
        return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
      },
      cwd: dir,
      sha,
      phase: 'candidate',
      gate: {
        id: 'install',
        kind: 'check',
        timeoutMs: 20000,
        command: [process.execPath, '-e', script],
      },
      artifactDir: mkdtempSync(join(tmpdir(), 'harness-art-')),
      signal: new AbortController().signal,
      execution: { env: process.env, redact: redactor([]) },
      boundary: { hidden: [], readable: [] },
    });
  } catch (error) {
    if (!(error instanceof TaskFailure)) throw error;
    return { failure: error, evidence: recorded[0]! };
  }
  return { failure: undefined, evidence: recorded[0]! };
}

test(
  'SBX03: отказ песочницы в проверке — класс environment с путём и правилом; собственный отказ кода — gate',
  {
    skip: noSandbox,
  },
  async () => {
    const r = repo();
    const sha = r.head();
    const outside = join(realpathSync(tmpdir()), 'harness-sbx-outside-' + process.pid + '.txt');
    const write = (p: string) =>
      `try{require('fs').mkdirSync(require('path').dirname(${JSON.stringify(p)}),{recursive:true});require('fs').writeFileSync(${JSON.stringify(p)},'x')}catch(e){console.error(e.message);process.exit(1)}`;

    const outsideRun = await gate(r.dir, sha, write(outside));
    assert.equal(outsideRun.failure?.kind, 'environment', outsideRun.evidence.summary);
    assert.match(outsideRun.failure.message, /песочница проверки отказала в доступе/);
    assert.ok(outsideRun.failure.message.includes(outside), outsideRun.failure.message);
    assert.match(outsideRun.failure.message, /allowWrite/);
    assert.equal(existsSync(outside), false);

    if (mac) {
      const ide = await gate(r.dir, sha, write(join(r.dir, '.idea', 'workspace.xml')));
      assert.equal(ide.failure?.kind, 'environment', ide.evidence.summary);
      assert.match(
        ide.failure.message,
        /\.idea(\/workspace\.xml)? — обязательный запрет записи sandbox-runtime: каталог IDE \.idea/,
      );
    }

    // Код сам снял права с файла в своём дереве: это не отказ песочницы.
    const own = join(r.dir, 'locked.txt');
    const selfDenied = await gate(
      r.dir,
      sha,
      `const fs=require('fs');fs.writeFileSync(${JSON.stringify(own)},'a');fs.chmodSync(${JSON.stringify(own)},0o444);` +
        write(own),
    );
    assert.equal(selfDenied.failure?.kind, 'gate', selfDenied.evidence.summary);
    assert.match(selfDenied.failure.message, /EACCES|permission denied/i);
  },
);

test('SBX04: разбор отказов песочницы — пути и правила без песочницы', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-sbx-parse-')));
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-sbx-scratch-')));
  const hidden = join(root, '..', 'harness-controller-' + process.pid);
  const policy = isolation({ write: [root, scratch], controller: [hidden] });
  const out = [
    `EPERM: operation not permitted, mkdir '${root}/node_modules/.pnpm/text-codec@0.6.3/node_modules/text-codec_tmp_29787/.idea/codeStyles'`,
    `Error: EPERM: operation not permitted, open '${root}/.vscode/tasks.json'`,
    `fs.writeFileSync failed: EPERM: operation not permitted, open "${root}/.git/hooks/pre-commit"`,
    `/bin/sh: ${root}/src/.zshrc: Operation not permitted`,
    `EACCES: permission denied, open '${root}/src/locked.txt'`,
    `Error: EPERM: operation not permitted, open '/Users/x/Library/LaunchAgents/com.example.watcher.plist'`,
    `cat: ${hidden}/state.sqlite: Operation not permitted`,
    `connect EPERM /tmp/socket`,
    `wrote ${scratch}/ok and EPERM elsewhere`,
  ].join('\n');
  const found = Object.fromEntries(sandboxDenials(out, policy).map((d) => [d.path, d.rule]));
  assert.deepEqual(
    Object.keys(found).sort(),
    [
      `${root}/.git/hooks/pre-commit`,
      `${root}/.vscode/tasks.json`,
      `${root}/src/.zshrc`,
      '/Users/x/Library/LaunchAgents/com.example.watcher.plist',
      join(hidden, 'state.sqlite'),
    ].sort(),
  );
  assert.match(found[`${root}/.vscode/tasks.json`]!, /каталог IDE \.vscode/);
  assert.match(found[`${root}/.git/hooks/pre-commit`]!, /\.git\/hooks/);
  assert.match(found[`${root}/src/.zshrc`]!, /\.zshrc/);
  assert.match(
    found['/Users/x/Library/LaunchAgents/com.example.watcher.plist']!,
    /вне каталогов, открытых проверке на запись/,
  );
  assert.match(
    Object.entries(found).find(([p]) => p.endsWith('state.sqlite'))![1],
    /закрыт на чтение/,
  );
});

test('SBX05: явные запреты — каталоги IDE вне node_modules и прежние имена на любой глубине', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-sbx-deny-')));
  mkdirSync(join(root, 'src', 'deep', 'er', 'est'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg', 'lib'), { recursive: true });
  mkdirSync(join(root, 'apps', 'm', 'node_modules', 'x'), { recursive: true });
  const denies = protectedWriteDenies([root])!;
  for (const d of [
    `${root}/.idea`,
    `${root}/.vscode`,
    `${root}/*/.idea`,
    `${root}/src/*/.vscode`,
    `${root}/src/deep/*/.idea`,
    `${root}/apps/m/*/.idea`,
    `${root}/.bashrc`,
    `${root}/**/.bashrc`,
    `${root}/**/.git/hooks`,
    `${root}/**/.git/config`,
    `${root}/**/.claude/commands`,
    `${root}/**/.mcp.json`,
  ])
    assert.ok(denies.includes(d), d);
  assert.equal(
    denies.filter((d) => d.includes('node_modules')).length,
    0,
    'внутри node_modules каталоги IDE не перечисляются',
  );
  assert.equal(
    denies.some((d) => d.includes('**/.idea') || d.includes('**/.vscode')),
    false,
  );
  // Глубже предела перечисления правила нет — граница подхода.
  assert.equal(denies.includes(`${root}/src/deep/er/*/.idea`), false);
  // Корень с символами глоба шаблоном не записать: srt остаётся с полным запретом.
  assert.equal(protectedWriteDenies([join(root, 'a[1]')]), undefined);
});
