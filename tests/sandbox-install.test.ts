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
  mandatoryDenyRule,
  parseSandboxLog,
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
  'SBX03: отказ обязательного запрета, подтверждённый журналом ядра, — environment с путём и правилом; напечатанный отказ и запись вне дерева — gate',
  {
    skip: noSandbox,
  },
  async () => {
    const r = repo();
    const sha = r.head();
    const write = (p: string) =>
      `try{require('fs').mkdirSync(require('path').dirname(${JSON.stringify(p)}),{recursive:true});require('fs').writeFileSync(${JSON.stringify(p)},'x')}catch(e){console.error(e.message);process.exit(1)}`;

    if (mac) {
      const ide = await gate(r.dir, sha, write(join(r.dir, '.idea', 'workspace.xml')));
      assert.equal(ide.failure?.kind, 'environment', ide.evidence.summary);
      assert.match(
        ide.failure.message,
        /песочница проверки отказала в доступе: \.idea(\/workspace\.xml)? — обязательный запрет записи sandbox-runtime: каталог IDE \.idea/,
      );
    }

    // Проверка сама печатает «отказ песочницы» на закрытом пути: текст не
    // свидетельство, класс остаётся gate и очередь не встаёт.
    const forged = await gate(
      r.dir,
      sha,
      `console.error("Error: EPERM: operation not permitted, open '${join(r.dir, '.idea', 'workspace.xml')}'");process.exit(1)`,
    );
    assert.equal(forged.failure?.kind, 'gate', forged.evidence.summary);

    // Запись вне каталогов проверки — ошибка кода, а не среды.
    const outside = join(realpathSync(tmpdir()), 'harness-sbx-outside-' + process.pid + '.txt');
    const outsideRun = await gate(r.dir, sha, write(outside));
    assert.equal(outsideRun.failure?.kind, 'gate', outsideRun.evidence.summary);
    assert.equal(existsSync(outside), false);

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

test('SBX04: журнал ядра — только отказы своей проверки; правило — только обязательные запреты внутри дерева', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-sbx-parse-')));
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-sbx-scratch-')));
  const policy = isolation({ write: [root, scratch], controller: [] });
  const cmd = (text: string) => `CMD64_${Buffer.from(text).toString('base64')}_END__abc_SBX`;
  const mine = cmd(`/bin/sh -c ': dcmytoken1; : > "$0"`);
  const foreign = cmd(`/bin/sh -c ': dcothertok; : > "$0"`);
  const entry = (op: string, path: string, tag: string) =>
    `2026-10-28 12:34:52.273 E  kernel[0:1] (Sandbox) Sandbox: node(42) deny(1) ${op} ${path}\n${tag}`;
  const log = [
    'Filtering the log data using "composedMessage ENDSWITH "_SBX""',
    entry('file-write-create', `${root}/.vscode/tasks.json`, mine),
    entry('file-write-create', `${root}/.git/hooks/pre-commit`, mine),
    entry('file-write-create', `${root}/src/.zshrc`, mine),
    entry('file-write-create', `${root}/.git`, mine),
    entry('file-write-create', `${root}/sub/.git`, mine),
    entry('file-write-create', `${root}/node_modules/pkg/.idea/x.xml`, mine),
    entry('file-write-create', `/Users/x/Library/LaunchAgents/w.plist`, mine),
    entry('file-read-data', `${root}/.idea/secret`, mine),
    entry('file-write-create', `${root}/.idea/foreign.xml`, foreign),
  ].join('\n');
  const parsed = parseSandboxLog(log, 'dcmytoken1');
  assert.equal(parsed.length, 8, 'чужая песочница не попадает в отказы проверки');
  const found = Object.fromEntries(sandboxDenials(parsed, policy).map((d) => [d.path, d.rule]));
  assert.deepEqual(
    Object.keys(found).sort(),
    [
      `${root}/.git`,
      `${root}/.git/hooks/pre-commit`,
      `${root}/.vscode/tasks.json`,
      `${root}/src/.zshrc`,
      `${root}/sub/.git`,
    ].sort(),
  );
  assert.match(found[`${root}/.vscode/tasks.json`]!, /каталог IDE \.vscode/);
  assert.match(found[`${root}/.git/hooks/pre-commit`]!, /\.git\/hooks/);
  assert.match(found[`${root}/.git`]!, /файл \.git рабочего дерева/);
  assert.match(found[`${root}/sub/.git`]!, /вложенный репозиторий/);
  assert.equal(mandatoryDenyRule(policy, `${root}/src/index.js`), undefined);
  assert.match(mandatoryDenyRule(policy, `${root}/.git/commondir`)!, /\.git\/commondir/);
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
