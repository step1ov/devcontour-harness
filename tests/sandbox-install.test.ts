import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { EvidenceRecord } from '../src/contracts/index.ts';
import { redactor } from '../src/environment/redaction.ts';
import { preparationGuard } from '../src/environment/lifecycle.ts';
import {
  anchoredAtRoot,
  pinnedBases,
  isolation,
  isolationSupport,
  mandatoryDenyRule,
  parseSandboxLog,
  protectedChanges,
  protectedSnapshot,
  protectedWriteDenies,
  SandboxPolicyError,
  sandboxDenials,
} from '../src/environment/isolation.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { prepareWriterDependencies, runCheck, runGate } from '../src/verification/gates.ts';
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
    `${root}/[s]rc/*/.vscode`,
    `${root}/[s]rc/deep/*/.idea`,
    `${root}/[a]pps/m/*/.idea`,
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
  assert.equal(denies.includes(`${root}/[s]rc/deep/er/*/.idea`), false);
  // srt закрепляет от удаления и переноса базу каждого шаблона (статический
  // префикс) и её предков: база — только корень, ни один каталог дерева.
  const base = (d: string) => {
    const prefix = d.split(/[*?[\]]/)[0]!;
    return prefix === d ? dirname(d) : prefix.endsWith('/') ? prefix.slice(0, -1) : dirname(prefix);
  };
  const pinned = denies
    .map(base)
    // `.git` и `.claude` — сами защищённые имена (их закрепление и задумано).
    .filter(
      (b) => b.startsWith(root + '/') && !['.git', '.claude'].includes(b.slice(root.length + 1)),
    );
  assert.deepEqual(pinned, [], 'каталоги дерева не закреплены запретами');
  // Корень с символами глоба шаблоном не записать: srt остаётся с полным запретом.
  assert.equal(protectedWriteDenies([join(root, 'a[1]')]), undefined);
});

test('SBX06: сверка защищённых путей — пустые служебные каталоги (.claude/.cc-writes) не нарушение; файл, ссылка или правка прежнего — нарушение', () => {
  const r = repo({ 'apps/mobile/src/store/index.ts': 'x\n' });
  const root = realpathSync(r.dir);
  /** Нарушения после правки `change` поверх чистого снимка дерева. */
  const after = (change: () => void) => {
    const before = protectedSnapshot(root);
    change();
    return protectedChanges(before, root).map((p) => p.slice(root.length + 1));
  };
  const dir = (p: string) => mkdirSync(join(root, p), { recursive: true, mode: 0o700 });
  const file = (p: string, text = 'x') => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  };

  // Как у CLI исполнителя: пустой `.claude/.cc-writes` в корне и рядом с файлами.
  assert.deepEqual(
    after(() => {
      dir('.claude/.cc-writes');
      dir('apps/mobile/.claude/.cc-writes');
      dir('apps/mobile/src/store/.claude/.cc-writes');
      dir('.vscode');
    }),
    [],
  );
  // Поверх уже пустых — снова пустые каталоги: нарушения нет.
  assert.deepEqual(
    after(() => dir('.claude/.cc-writes/nested')),
    [],
  );
  // Любой файл или ссылка внутри — нарушение, как раньше.
  assert.deepEqual(
    after(() => file('.claude/settings.json', '{}')),
    ['.claude'],
  );
  assert.deepEqual(
    after(() => file('apps/mobile/.claude/.cc-writes/x')),
    ['apps/mobile/.claude'],
  );
  assert.deepEqual(
    after(() => symlinkSync('/etc', join(root, 'apps/mobile/src/store/.claude/.cc-writes/l'))),
    ['apps/mobile/src/store/.claude'],
  );
  assert.deepEqual(
    after(() => file('.vscode/tasks.json', '{}')),
    ['.vscode'],
  );
  // Прежний `.claude` с файлом: правка содержимого и удаление файла — нарушение.
  assert.deepEqual(
    after(() => file('.claude/settings.json', '{"hooks":{}}')),
    ['.claude'],
  );
  assert.deepEqual(
    after(() => rmSync(join(root, '.claude/settings.json'))),
    ['.claude'],
  );
  // FIFO, сокет и прочие не-каталоги — содержимое, а не пустое дерево.
  assert.deepEqual(
    after(() => execFileSync('mkfifo', [join(root, '.claude/.cc-writes/pipe')])),
    ['.claude'],
  );
  rmSync(join(root, '.claude/.cc-writes/pipe'));
  // `.git` хоста: в hooks с файлами (образцы git init) нарушение — и
  // подложенный hook, и даже пустой каталог.
  assert.deepEqual(
    after(() => dir('.git/hooks/empty.d')),
    ['.git/hooks'],
  );
  assert.deepEqual(
    after(() => file('.git/hooks/pre-commit', '#!/bin/sh\n')),
    ['.git/hooks'],
  );
});

/** Нечувствительная к регистру ФС: `.Claude` и `.claude` — одно имя. */
const foldsCase = (dir: string) => {
  const probe = join(dir, 'harness-case-probe');
  writeFileSync(probe, '');
  try {
    return existsSync(join(dir, 'HARNESS-CASE-PROBE'));
  } finally {
    rmSync(probe);
  }
};
const root0 = process.getuid?.() === 0;

test('SBX08: сверка защищённых путей без регистра — .Claude, .VSCode, вложенный .GIT, .Bashrc — нарушение; обязательный запрет из журнала узнаётся в любом регистре', () => {
  const r = repo({ 'sub/index.ts': 'x\n' });
  const root = realpathSync(r.dir);
  const after = (change: () => void) => {
    const before = protectedSnapshot(root);
    change();
    return protectedChanges(before, root).map((p) => p.slice(root.length + 1));
  };
  const file = (p: string, text = 'x') => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  assert.deepEqual(
    after(() => file('.Claude/settings.json', '{"hooks":{}}')),
    ['.Claude'],
  );
  assert.deepEqual(
    after(() => file('.VSCode/tasks.json', '{}')),
    ['.VSCode'],
  );
  assert.deepEqual(
    after(() => file('sub/.GIT', 'gitdir: /elsewhere\n')),
    ['sub/.GIT'],
  );
  assert.deepEqual(
    after(() => file('.Bashrc', 'curl x | sh\n')),
    ['.Bashrc'],
  );
  assert.deepEqual(
    after(() => file('sub/.MCP.json', '{}')),
    ['sub/.MCP.json'],
  );
  // Пустой служебный каталог в другом регистре — так же не нарушение.
  assert.deepEqual(
    after(() => mkdirSync(join(root, 'sub/.CLAUDE/.cc-writes'), { recursive: true, mode: 0o700 })),
    [],
  );
  if (foldsCase(root))
    // Хост читает `.Claude/settings.json` как `.claude/settings.json`.
    assert.equal(readFileSync(join(root, '.claude/settings.json'), 'utf8'), '{"hooks":{}}');

  // Seatbelt на APFS отказывает и в записи в `.IDEA/x`: правило называется.
  const policy = isolation({ write: [root], controller: [] });
  assert.match(mandatoryDenyRule(policy, `${root}/.IDEA/workspace.xml`)!, /каталог IDE \.idea/);
  assert.match(mandatoryDenyRule(policy, `${root}/src/.VSCode/tasks.json`)!, /каталог IDE/);
  assert.match(mandatoryDenyRule(policy, `${root}/.Claude/Commands/x.md`)!, /\.Claude\/Commands/);
  assert.match(mandatoryDenyRule(policy, `${root}/x/.GIT/hooks/pre-commit`)!, /вложенный|hooks/);
  assert.match(mandatoryDenyRule(policy, `${root}/src/.ZSHRC`)!, /\.zshrc/);
  assert.equal(mandatoryDenyRule(policy, `${root}/node_modules/p/.IDEA/x`), undefined);
});

test(
  'SBX09: путь, который сверка не может прочитать, — отказ с путём, а не пропуск',
  { skip: root0 ? 'root читает каталоги без прав' : false },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-sbx-unreadable-')));
    const locked: string[] = [];
    const lock = (p: string, mode: number) => {
      chmodSync(join(root, p), mode);
      locked.push(join(root, p));
    };
    const fails = (before: Map<string, string>, path: string) =>
      assert.throws(
        () => protectedChanges(before, root),
        (e: unknown) =>
          e instanceof SandboxPolicyError && e.message.includes(`нет доступа к ${path} (EACCES)`),
      );
    try {
      mkdirSync(join(root, 'sub'));
      let before = protectedSnapshot(root);
      // Каталог без права поиска прятал бы `sub/.claude/settings.json`.
      mkdirSync(join(root, 'sub/.claude'));
      writeFileSync(join(root, 'sub/.claude/settings.json'), '{}');
      lock('sub', 0o444);
      fails(before, 'sub/.claude');
      chmodSync(join(root, 'sub'), 0o755);
      rmSync(join(root, 'sub/.claude'), { recursive: true });
      // Каталог, который нельзя перечислить, — то же.
      mkdirSync(join(root, 'other'));
      before = protectedSnapshot(root);
      lock('other', 0o000);
      fails(before, 'other');
      chmodSync(join(root, 'other'), 0o755);
      // Пустой `.claude` с mode 000 пустым деревом не назвать: внутрь не заглянуть.
      before = protectedSnapshot(root);
      mkdirSync(join(root, '.claude'));
      lock('.claude', 0o000);
      fails(before, '.claude');
    } finally {
      for (const p of locked) chmodSync(p, 0o755);
    }
  },
);

test('SBX10: пустой защищённый каталог, открытый на запись всем, — нарушение; открытый группе (umask 002) — нет', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-sbx-mode-')));
  const after = (change: () => void) => {
    const before = protectedSnapshot(root);
    change();
    return protectedChanges(before, root).map((p) => p.slice(root.length + 1));
  };
  const dir = (p: string, mode: number) => {
    mkdirSync(join(root, p), { recursive: true });
    chmodSync(join(root, p), mode);
  };
  // Закрытые для записи всем — как у CLI исполнителя (и при umask 002).
  assert.deepEqual(
    after(() => {
      dir('.claude/.cc-writes', 0o700);
      chmodSync(join(root, '.claude'), 0o755);
    }),
    [],
  );
  assert.deepEqual(
    after(() => chmodSync(join(root, '.claude/.cc-writes'), 0o777)),
    ['.claude'],
  );
  chmodSync(join(root, '.claude/.cc-writes'), 0o700);
  assert.deepEqual(
    after(() => chmodSync(join(root, '.claude'), 0o775)),
    [],
  );
  assert.deepEqual(
    after(() => dir('src/.claude/.cc-writes', 0o775)),
    [],
  );
  assert.deepEqual(
    after(() => chmodSync(join(root, '.claude'), 0o777)),
    ['.claude'],
  );
  chmodSync(join(root, '.claude'), 0o755);
  assert.deepEqual(
    after(() => dir('pkg/.vscode', 0o757)),
    ['pkg/.vscode'],
  );
  // Каталог с файлами: смена прав без смены содержимого — тоже изменение.
  writeFileSync(join(root, 'pkg/.vscode/settings.json'), '{}');
  assert.deepEqual(
    after(() => chmodSync(join(root, 'pkg/.vscode'), 0o700)),
    ['pkg/.vscode'],
  );
});

test(
  'SBX11: под песочницей ОС — .IDEA закрыт ядром и назван правилом, .Claude/settings.json и спрятанный chmod-ом .claude — scope-violation',
  { skip: noSandbox },
  async () => {
    const write = (paths: Record<string, string>, chmod: Record<string, number> = {}) =>
      `const fs=require('fs'),path=require('path');try{for(const [p,t] of Object.entries(${JSON.stringify(paths)})){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,t)}for(const [p,m] of Object.entries(${JSON.stringify(chmod)}))fs.chmodSync(p,m)}catch(e){console.error(e.message);process.exit(1)}`;
    const fresh = () => {
      const r = repo({ 'sub/index.ts': 'x\n' });
      return { r, at: (p: string) => join(realpathSync(r.dir), p) };
    };
    if (mac) {
      // Seatbelt сравнивает путь без регистра: `.IDEA` закрыт правилом для `.idea`.
      const { r, at } = fresh();
      const ide = await gate(r.dir, r.head(), write({ [at('.IDEA/workspace.xml')]: '<x/>' }));
      assert.ok(ide.failure, ide.evidence.summary);
      assert.match(ide.failure.message, /EPERM.*\.IDEA/);
      assert.equal(existsSync(at('.IDEA')), false);
      // Класс отказа приходит из журнала ядра (SBX03); когда журнал виден,
      // правило названо и для имени в другом регистре (SBX08 — без журнала).
      if (ide.failure.kind === 'environment')
        assert.match(
          ide.failure.message,
          /\.IDEA(\/workspace\.xml)? — обязательный запрет записи sandbox-runtime: каталог IDE \.idea/,
        );
      else assert.equal(ide.failure.kind, 'gate');
    }
    if (mac) {
      // Создать `.Claude` ядро не даёт (предок запрета `.claude/commands`);
      // в уже существующий каталог запись проходит — её находит сверка.
      const { r, at } = fresh();
      const denied = await gate(r.dir, r.head(), write({ [at('.Claude/settings.json')]: '{}' }));
      assert.match(denied.failure?.message ?? '', /EPERM.*\.Claude/);
      assert.equal(existsSync(at('.claude')), false);
      mkdirSync(at('.claude/.cc-writes'), { recursive: true, mode: 0o700 });
      const planted = await gate(r.dir, r.head(), write({ [at('.Claude/settings.json')]: '{}' }));
      assert.equal(planted.failure?.kind, 'scope-violation', planted.evidence.summary);
      assert.match(planted.failure.message, /защищённые пути .*: \.claude$/);
    }
    if (!root0) {
      const { r, at } = fresh();
      try {
        const hidden = await gate(
          r.dir,
          r.head(),
          write({ [at('sub/.claude/settings.json')]: '{}' }, { [at('sub')]: 0o444 }),
        );
        assert.equal(hidden.failure?.kind, 'scope-violation', hidden.evidence.summary);
        assert.match(hidden.failure.message, /нет доступа к sub\/\.claude \(EACCES\)/);
      } finally {
        chmodSync(at('sub'), 0o755);
      }
    }
  },
);

test('SBX07: файл .git worktree, заменённый каталогом (даже пустым), подложенный .git/config и вложенный .git-файл — нарушение', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-sbx-gitfile-')));
  const rel = (paths: string[]) => paths.map((p) => p.slice(root.length + 1));
  const gitFile = () => writeFileSync(join(root, '.git'), 'gitdir: /elsewhere\n');
  gitFile();
  let before = protectedSnapshot(root);
  rmSync(join(root, '.git'));
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true, mode: 0o700 });
  assert.deepEqual(rel(protectedChanges(before, root)), ['.git']);
  writeFileSync(join(root, '.git', 'config'), '[core]\n\tfsmonitor = x\n');
  assert.deepEqual(rel(protectedChanges(before, root)), ['.git', '.git/config']);
  // Вложенный `.git`-файл вместо пустого каталога — нарушение.
  rmSync(join(root, '.git'), { recursive: true });
  gitFile();
  mkdirSync(join(root, 'pkg', '.git'), { recursive: true });
  before = protectedSnapshot(root);
  rmSync(join(root, 'pkg', '.git'), { recursive: true });
  writeFileSync(join(root, 'pkg', '.git'), 'gitdir: /elsewhere\n');
  assert.deepEqual(rel(protectedChanges(before, root)), ['pkg/.git']);
});

/** Установка до исполнителя в песочнице проверки над деревом `dir` (база — HEAD). */
const writerInstall = (
  dir: string,
  base: string,
  command: string[],
  env = process.env,
  trusted = true,
) =>
  prepareWriterDependencies({
    policy: os.config,
    cwd: dir,
    base,
    trusted,
    gates: [{ id: 'install', kind: 'check', timeoutMs: 60000, command }],
    artifactDir: mkdtempSync(join(tmpdir(), 'harness-art-')),
    signal: new AbortController().signal,
    execution: { env, redact: redactor([]) },
    boundary: { hidden: [], readable: [] },
  });

test(
  'SBX12 [песочница ОС]: установка до исполнителя ставит пакет с .idea в дерево исполнителя; node_modules скрыт от git',
  { skip: noSandbox },
  async () => {
    const npm = (process.env.PATH ?? '')
      .split(delimiter)
      .map((d) => join(d, 'npm'))
      .find((p) => existsSync(p));
    assert.ok(npm, 'npm есть рядом с node');
    const src = realpathSync(mkdtempSync(join(tmpdir(), 'harness-sbx-pkg-')));
    const pkg = join(src, 'package');
    mkdirSync(join(pkg, '.idea', 'codeStyles'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{"name":"dep","version":"1.0.0"}');
    writeFileSync(join(pkg, '.idea', 'codeStyles', 'codeStyleConfig.xml'), '<x/>');
    // Кэш и конфигурация npm — в дереве, но игнорируются проектом; node_modules — нет.
    const r = repo({
      '.gitignore': '.npm-cache/\n.npmrc-user\n',
      'package.json':
        '{"name":"app","version":"1.0.0","dependencies":{"dep":"file:vendor/dep.tgz"}}',
    });
    mkdirSync(join(r.dir, 'vendor'));
    execFileSync('tar', ['czf', join(r.dir, 'vendor', 'dep.tgz'), 'package'], {
      cwd: src,
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    r.git('add', 'vendor/dep.tgz');
    r.git('commit', '-q', '-m', 'vendor');
    writeFileSync(join(r.dir, '.npmrc-user'), '');
    const outcome = await writerInstall(
      r.dir,
      r.head(),
      [
        npm,
        'install',
        '--offline',
        '--no-package-lock',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      {
        ...process.env,
        npm_config_cache: join(r.dir, '.npm-cache'),
        npm_config_userconfig: join(r.dir, '.npmrc-user'),
        npm_config_update_notifier: 'false',
      },
    );
    assert.deepEqual(outcome, { installed: ['install'], frozen: false, sealed: ['node_modules'] });
    assert.equal(
      readFileSync(join(r.dir, 'node_modules/dep/.idea/codeStyles/codeStyleConfig.xml'), 'utf8'),
      '<x/>',
    );
    assert.equal(r.git('status', '--porcelain'), '', 'node_modules скрыт своим .gitignore');
  },
);

test(
  'SBX13 [песочница ОС]: защищённый путь, перенесённый установкой до исполнителя вне node_modules, — environment/sandbox-policy',
  { skip: noSandbox },
  async () => {
    const r = repo();
    const at = (p: string) => join(r.dir, p);
    // Каталог IDE собирается внутри node_modules, где запрет не действует, и
    // переносится в дерево целиком: запреты песочницы видят только путь операции.
    const script =
      `const fs=require('fs');fs.mkdirSync(${JSON.stringify(at('node_modules/pkg/.vscode'))},{recursive:true});` +
      `fs.writeFileSync(${JSON.stringify(at('node_modules/pkg/.vscode/tasks.json'))},'{}');` +
      `fs.renameSync(${JSON.stringify(at('node_modules/pkg'))},${JSON.stringify(at('moved'))})`;
    await assert.rejects(
      writerInstall(r.dir, r.head(), [process.execPath, '-e', script]),
      (e: unknown) =>
        e instanceof TaskFailure &&
        e.kind === 'environment' &&
        e.diagnosis === 'sandbox-policy' &&
        /установка зависимостей до исполнителя \(install\) создала, изменила или удалила защищённые пути .*moved\/\.vscode/.test(
          e.message,
        ),
    );
    assert.ok(existsSync(at('moved/.vscode/tasks.json')), 'перенос состоялся: сработала сверка');
    rmSync(at('moved'), { recursive: true, force: true });
    // Над черновиком прежней попытки тот же перенос — нарушение области.
    await assert.rejects(
      writerInstall(r.dir, r.head(), [process.execPath, '-e', script], process.env, false),
      (e: unknown) =>
        e instanceof TaskFailure &&
        e.kind === 'scope-violation' &&
        /над черновиком прежней попытки/.test(e.message),
    );
    rmSync(at('moved'), { recursive: true, force: true });
    // Отказ установки без защищённого пути — только исход для заметки.
    const plain = await writerInstall(r.dir, r.head(), [
      process.execPath,
      '-e',
      'console.error("ERR boom");process.exit(2)',
    ]);
    assert.equal(plain.installed.length, 0);
    assert.match(plain.failed!.summary, /^код выхода 2: .*ERR boom/);
  },
);

test(
  'SBX14 [песочница ОС]: gate удаляет и пересоздаёт прежний вывод в дереве (каталоги на любой глубине), каталоги IDE по-прежнему закрыты',
  { skip: noSandbox },
  async () => {
    const r = repo({ '.gitignore': '.reports/\n', 'src/index.ts': 'x\n' });
    const at = (p: string) => join(realpathSync(r.dir), p);
    // Как самопроверка исполнителя: вывод сборки остался в дереве до gate.
    mkdirSync(at('.reports/expo-export/_expo/static/js'), { recursive: true });
    writeFileSync(at('.reports/expo-export/_expo/static/js/index.js'), 'old');
    writeFileSync(at('.reports/expo-export/metadata.json'), '{}');
    mkdirSync(at('src/generated/deep'), { recursive: true });
    // Как `expo export`: сначала убрать прежний вывод, затем записать новый.
    const exportLike =
      `const fs=require('fs');` +
      `fs.rmSync('.reports/expo-export',{recursive:true});` +
      `fs.mkdirSync('.reports/expo-export/_expo',{recursive:true});` +
      `fs.writeFileSync('.reports/expo-export/metadata.json','{"v":2}');` +
      `fs.rmSync('src/generated',{recursive:true});` +
      `fs.renameSync('.reports','.reports-old');fs.renameSync('.reports-old','.reports');`;
    const done = await gate(r.dir, r.head(), exportLike);
    assert.equal(done.failure, undefined, done.evidence.summary);
    assert.equal(readFileSync(at('.reports/expo-export/metadata.json'), 'utf8'), '{"v":2}');
    assert.equal(existsSync(at('.reports/expo-export/_expo/static')), false);
    assert.equal(existsSync(at('src/generated')), false);
    if (!mac) return;
    // Запреты каталогов IDE в тех же каталогах остались.
    mkdirSync(at('src/generated/deep'), { recursive: true });
    for (const p of ['.reports/expo-export/x/.idea/w.xml', 'src/generated/deep/.vscode/t.json']) {
      const denied = await gate(
        r.dir,
        r.head(),
        `const fs=require('fs'),path=require('path');try{fs.mkdirSync(path.dirname(${JSON.stringify(at(p))}),{recursive:true});fs.writeFileSync(${JSON.stringify(at(p))},'x')}catch(e){console.error(e.message);process.exit(1)}`,
      );
      assert.match(denied.failure?.message ?? '', /EPERM/, p);
      assert.equal(existsSync(at(p)), false, p);
    }
  },
);

test('SBX15: шаблон запрета с базой в корне совпадает с теми же путями; отказ в удалении каталога внутри дерева — отказ среды', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-sbx-anchor-')));
  assert.equal(anchoredAtRoot(root, `${root}/.reports/*/.idea`), `${root}/[.]reports/*/.idea`);
  assert.equal(anchoredAtRoot(root, `${root}/*/.idea`), `${root}/*/.idea`);
  assert.equal(anchoredAtRoot(root, `${root}/-x^/a/*/.idea`), `${root}/-[x]^/a/*/.idea`);
  assert.equal(
    anchoredAtRoot(root, `${root}/ёж/*/.idea`),
    `${root}/ёж/*/.idea`,
    'нет ASCII — прежний шаблон',
  );
  assert.equal(anchoredAtRoot(root, `/elsewhere/a/*/.idea`), `/elsewhere/a/*/.idea`);
  // Перевод шаблона запрета в регулярное выражение — как у srt 0.0.77
  // (`globToRegex` + хвост `(/.*)?` в `denyGlobRegex`): класс из одного
  // символа — этот символ. Внутренний модуль srt не импортируется: пакет
  // не обещает его путь. Перевод самого srt на тех же написаниях
  // проверяют SBX14 и SBX16 в настоящей песочнице.
  const denyGlobRegex = (pattern: string) =>
    '^' +
    pattern
      .replace(/[.^$+{}()|\\]/g, '\\$&')
      .replace(/\[([^\]]*?)$/g, '\\[$1')
      .replace(/\*\*\//g, '__GLOBSTAR_SLASH__')
      .replace(/\*\*/g, '__GLOBSTAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/__GLOBSTAR_SLASH__/g, '(.*/)?')
      .replace(/__GLOBSTAR__/g, '.*') +
    '(/.*)?$';
  for (const [dir, ok, bad] of [
    ['.reports', '.reports/x/.idea', 'xreports/x/.idea'],
    ['src', 'src/x/.idea/a.xml', 'srcx/x/.idea'],
    ['a+b(c)', 'a+b(c)/y/.idea', 'aab(c)/y/.idea'],
    ['$d', '$d/y/.idea', 'xd/y/.idea'],
    ['ж1', 'ж1/y/.idea', 'жx/y/.idea'],
  ] as const) {
    const pattern = anchoredAtRoot(root, join(root, dir, '*', '.idea'));
    assert.notEqual(pattern, join(root, dir, '*', '.idea'), dir);
    const re = new RegExp(denyGlobRegex(pattern));
    assert.ok(re.test(join(root, ok)), ok);
    assert.equal(re.test(join(root, bad)), false, bad);
  }

  // Удаление каталога внутри дерева — отказ среды, только когда каталог
  // закреплён запретом (`.claude` — предок `.claude/commands`) и проверка
  // упала с EPERM, назвав его.
  mkdirSync(join(root, '.reports', 'expo-export'), { recursive: true });
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.reports', 'file.txt'), 'x');
  const policy = isolation({ write: [root], controller: [] });
  const claude = join(root, '.claude');
  const unlink = (path: string) => ({ operation: 'file-write-unlink', path });
  const classify = (path: string, output: string | undefined, cwd: string | undefined = root) =>
    sandboxDenials([unlink(path)], policy, output, cwd).map((d) => d.rule);
  const eperm = (path: string) => `Error: EPERM: operation not permitted, rmdir '${path}'`;
  assert.match(classify(claude, eperm(claude))[0] ?? '', /удаление или перенос каталога/);
  assert.equal(classify(claude, eperm('.claude')).length, 1, 'путь относительно cwd');
  assert.deepEqual(classify(claude, undefined), [], 'нет вывода');
  assert.deepEqual(
    classify(claude, 'AssertionError: expected 1 to equal 2'),
    [],
    'отказ пережит, провал — тест',
  );
  assert.deepEqual(classify(claude, eperm('/elsewhere/x')), [], 'EPERM о другом пути');
  assert.deepEqual(
    classify(claude, `${eperm('/elsewhere/x')}\n    at cleanup (${root}/.claude/x.js:1:1)`),
    [],
    'EPERM о другом пути, абсолютное имя каталога — в другой строке',
  );
  assert.deepEqual(
    classify(claude, `${eperm('/elsewhere/x')}\nsee .claude/settings.json`),
    [],
    'EPERM о другом пути, относительное имя каталога — в другой строке',
  );
  assert.equal(
    classify(
      claude,
      `AssertionError: expected 1 to equal 2\r\nrm: .claude: Operation not permitted`,
    ).length,
    1,
    'EPERM и имя каталога в одной строке',
  );
  // Не закреплённый запретом каталог: отказа ядра на нём быть не должно, и
  // классом среды он не становится.
  const expo = join(root, '.reports', 'expo-export');
  assert.deepEqual(classify(expo, eperm(expo)), []);
  for (const path of [join(root, '.reports', 'file.txt'), join(root, 'gone'), root, tmpdir()])
    assert.deepEqual(classify(path, eperm(path)), [], path);
  assert.deepEqual(
    sandboxDenials([{ operation: 'file-write-create', path: claude }], policy, eperm(claude), root),
    [],
    'отказ в создании разбирают запреты имён',
  );
  assert.ok(pinnedBases([root]).includes(claude));
});

test(
  'SBX16 [песочница ОС]: запреты IDE в другом регистре и при необычных именах каталогов; перенос родителя с подложенным или удалённым .idea — scope-violation; проглоченный отказ уборки при провале теста — gate',
  { skip: noSandbox },
  async () => {
    const fresh = (files: Record<string, string> = {}) => {
      const r = repo({ 'src/a/index.ts': 'x\n', ...files });
      return { r, at: (p: string) => join(realpathSync(r.dir), p) };
    };
    if (mac) {
      const odd = ['(x) $d', '.r', '~t', "'s", 'ж1', 'ёж'];
      const { r, at } = fresh();
      for (const n of odd) mkdirSync(at(`${n}/a`), { recursive: true });
      const paths = [
        'SRC/a/.idea/x.xml',
        'src/a/.IDEA/x.xml',
        'Src/A/.VSCode/t.json',
        ...odd.map((n) => `${n}/a/.idea/w.xml`),
      ];
      const result = await check(r.dir, r.dir, tryWrites(paths.map(at)));
      assert.equal(result.code, 0, result.stderr);
      const got = JSON.parse(result.stdout) as Record<string, true | string>;
      for (const p of paths) assert.equal(got[at(p)], 'EPERM', `запись закрыта: ${p}`);
    }
    {
      // Перенос родителя наружу, подложенный `.idea`, перенос обратно.
      const { r, at } = fresh();
      const planted = await gate(
        r.dir,
        r.head(),
        `const fs=require('fs');fs.renameSync('src','tmpx');fs.mkdirSync('tmpx/a/.idea');fs.writeFileSync('tmpx/a/.idea/planted.xml','<x/>');fs.renameSync('tmpx','src')`,
      );
      assert.equal(planted.failure?.kind, 'scope-violation', planted.evidence.summary);
      assert.match(planted.failure.message, /защищённые пути .*src\/a\/\.idea/);
      assert.ok(existsSync(at('src/a/.idea/planted.xml')));
    }
    {
      // Прежний неотслеживаемый `.idea` уходит вместе с перенесённым и удалённым родителем.
      const { r, at } = fresh();
      mkdirSync(at('lib/b/.idea'), { recursive: true });
      writeFileSync(at('lib/b/.idea/workspace.xml'), '<x/>');
      const removed = await gate(
        r.dir,
        r.head(),
        `const fs=require('fs');fs.renameSync('lib','trash');fs.rmSync('trash',{recursive:true})`,
      );
      assert.equal(removed.failure?.kind, 'scope-violation', removed.evidence.summary);
      assert.match(removed.failure.message, /удалила защищённые пути .*lib\/b\/\.idea/);
    }
    if (mac) {
      // Настоящий провал теста и проглоченный отказ ядра в уборке
      // закреплённого каталога: провал gate, а не отказ среды.
      const { r, at } = fresh();
      mkdirSync(at('.claude'), { mode: 0o755 });
      const failed = await gate(
        r.dir,
        r.head(),
        `try{require('fs').rmdirSync('.claude')}catch{}console.error('AssertionError: expected 1 to equal 2');process.exit(1)`,
      );
      assert.ok(existsSync(at('.claude')), 'ядро закрепило каталог');
      assert.equal(failed.failure?.kind, 'gate', failed.evidence.summary);
      assert.match(failed.failure.message, /AssertionError/);
    }
  },
);

test('SBX17: сверка защищённых путей — исчезнувший путь с содержимым нарушение, пустой служебный — нет', () => {
  const r = repo({ 'src/a.ts': 'x\n' });
  const root = realpathSync(r.dir);
  const after = (change: () => void) => {
    const before = protectedSnapshot(root);
    change();
    return protectedChanges(before, root).map((p) => p.slice(root.length + 1));
  };
  mkdirSync(join(root, 'lib/b/.idea'), { recursive: true });
  writeFileSync(join(root, 'lib/b/.idea/workspace.xml'), '<x/>');
  mkdirSync(join(root, '.claude/.cc-writes'), { recursive: true, mode: 0o700 });
  assert.deepEqual(
    after(() => rmSync(join(root, '.claude'), { recursive: true })),
    [],
    'пустое служебное дерево может исчезнуть',
  );
  assert.deepEqual(
    after(() => rmSync(join(root, 'lib'), { recursive: true })),
    ['lib/b/.idea'],
  );
});

test('SBX18: подготовка фазы (prepare, lifecycle) не создаёт, не меняет и не удаляет защищённые пути — отказ среды; без песочницы ОС сверки нет', () => {
  const r = repo({ 'src/a.ts': 'x\n', 'vendor/x/.idea/workspace.xml': '<x/>' });
  const root = realpathSync(r.dir);
  const refused = (change: () => void) => {
    const check = preparationGuard(true, root);
    change();
    try {
      check();
    } catch (error) {
      assert.ok(error instanceof TaskFailure);
      assert.equal(error.kind, 'environment');
      assert.equal(error.diagnosis, 'sandbox-policy');
      return error.message;
    }
    return undefined;
  };
  assert.equal(
    refused(() => writeFileSync(join(root, 'src/b.ts'), 'y\n')),
    undefined,
    'обычные файлы подготовка пишет',
  );
  assert.match(
    refused(() => {
      mkdirSync(join(root, 'fixture/repo/.git'), { recursive: true });
      writeFileSync(join(root, 'fixture/repo/.git/config'), '');
    }) ?? '',
    /Подготовка окружения .*создала, изменила или удалила защищённые пути .*: fixture\/repo\/\.git\. /,
  );
  rmSync(join(root, 'fixture'), { recursive: true });
  assert.match(
    refused(() => rmSync(join(root, 'vendor'), { recursive: true })) ?? '',
    /: vendor\/x\/\.idea\. /,
    'удаление через родителя',
  );
  const off = preparationGuard(false, root);
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode/settings.json'), '{}');
  off();
});
