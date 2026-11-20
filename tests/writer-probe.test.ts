/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
   Политика fixture правится как сырой JSON до разбора схемой. */
/**
 * `harness smoke --writer-probe`: команды `writerProbe` в точной изоляции
 * исполнителя без модели — ok/blocked по каждой, причина и совет; свой
 * TMPDIR исполнителя в области записи.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cliDataSchemas,
  executionPolicySchema,
  type ExecutionPolicy,
} from '../src/contracts/index.ts';
import { smokeLifecycle } from '../src/control/lifecycle-smoke.ts';
import { classifyProbe, writerProbeText } from '../src/control/writer-probe.ts';
import { isolationSupport } from '../src/environment/isolation.ts';
import { example } from './fixtures.ts';
import { repo } from './git-fixture.ts';

const node = (script: string) => [process.execPath, '-e', script];

function fixture(tune: (raw: any, root: string) => void) {
  const r = repo({ 'README.md': 'app\n' });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wprobe-')));
  const raw = structuredClone(example('policy')) as Record<string, any>;
  raw.repositories[0].path = r.dir;
  raw.runTimeoutMs = 60000;
  tune(raw, root);
  const policy: ExecutionPolicy = executionPolicySchema.parse(raw);
  r.git('update-ref', policy.repositories[0]!.targetRef, 'HEAD');
  const smoke = (over: Partial<Parameters<typeof smokeLifecycle>[0]> = {}) =>
    smokeLifecycle({
      policy,
      baseDir: root,
      stateDir: join(root, 'state'),
      rev: 'HEAD',
      resourceDatabase: join(root, 'resources.sqlite'),
      writerProbe: true,
      ...over,
    });
  return { r, root, policy, smoke };
}

test('WP01: причина отказа по выводу — listen, сеть, запись, аварийный выход, нет команды', () => {
  const v = (
    output: string,
    code = 1,
    extra: Partial<{ timedOut: boolean; signal: string }> = {},
  ) => classifyProbe({ code, timedOut: false, output, ...extra });
  assert.deepEqual(v('', 0), { status: 'ok' });
  assert.equal(
    v('Error: listen EPERM: operation not permitted 127.0.0.1:3000').reason,
    'listen-denied',
  );
  assert.equal(v('getaddrinfo ENOTFOUND registry.npmjs.org').reason, 'network-denied');
  assert.equal(v("EPERM: operation not permitted, mkdir '/Users/x/.tool'").reason, 'write-denied');
  assert.equal(v('bootstrap_check_in ... Permission denied (1100)').reason, 'process-abort');
  assert.equal(v('', 134).reason, 'process-abort');
  assert.equal(v('', 1, { signal: 'SIGABRT' }).reason, 'process-abort');
  assert.equal(v('sh: foo: command not found', 127).reason, 'missing-tool');
  assert.equal(v('', 0, { timedOut: true }).reason, 'timeout');
  const plain = v('AssertionError: expected 1');
  assert.deepEqual([plain.status, plain.reason], ['failed', 'failed']);
  assert.equal(v('listen EPERM 127.0.0.1').status, 'blocked');
});

test('WP01a: предупреждение pnpm о ~/.npmrc — шум; причина — последняя строка ошибки', () => {
  const v = (output: string, code = 1, networkMode?: 'none' | 'loopback') =>
    classifyProbe({ code, timedOut: false, output, ...(networkMode ? { networkMode } : {}) });
  const npmrc =
    '[WARN] Issue while reading "/home/u/.npmrc". EPERM: operation not permitted, open \'/home/u/.npmrc\'';
  // Сборка Turbopack под закрытой сетью: EPERM без пути, рядом предупреждения
  // pnpm с префиксом задачи turbo.
  const turbopack = [
    '• Packages in scope: @app/sdk, @app/web',
    `@app/sdk:build: ${npmrc}`,
    '@app/sdk:build: > tsc -p tsconfig.build.json',
    `@app/web:build: ${npmrc}`,
    '@app/web:build:    ▲ Next.js 16.3.4 (Turbopack)',
    '@app/web:build: Error [TurbopackInternalError]: Operation not permitted (os error 1)',
    '@app/web:build:  ELIFECYCLE  Command failed with exit code 1.',
    ' ERROR  run failed: command  exited (1)',
  ].join('\n');
  const build = v(turbopack, 1, 'none');
  assert.equal(build.reason, 'write-denied');
  assert.match(build.evidence!, /TurbopackInternalError.*os error 1/);
  assert.doesNotMatch(build.evidence!, /npmrc/);
  assert.match(build.advice!, /локальный сокет/);
  assert.match(build.advice!, /network: loopback/);
  // При loopback совет не предлагает его снова; EPERM с путём — общий совет.
  assert.doesNotMatch(v(turbopack, 1, 'loopback').advice!, /network: loopback/);
  assert.equal(
    v(`${npmrc}\nEPERM: operation not permitted, mkdir '/home/u/.tool'`).advice,
    undefined,
  );

  // Не собран пакет SDK: ошибка проекта, а не песочница.
  const sdk = v(
    [
      npmrc,
      '> @app/web@0.1.0 build /w/apps/web',
      '> next build',
      "src/api.ts(3,28): error TS2307: Cannot find module '@app/sdk/http-client' or its corresponding type declarations.",
      npmrc,
      ' ELIFECYCLE  Command failed with exit code 1.',
    ].join('\n'),
  );
  assert.deepEqual([sdk.status, sdk.reason], ['failed', 'failed']);
  assert.match(sdk.evidence!, /error TS2307/);
  assert.doesNotMatch(sdk.evidence!, /npmrc/);

  // Браузер не запустился: не отказ записи.
  const browser = v(
    [
      npmrc,
      'server: http://127.0.0.1:41234 ready',
      'Не удалось запустить браузер: Daemon process exited during startup',
      npmrc,
    ].join('\n'),
    2,
  );
  assert.equal(browser.reason, 'process-abort');
  assert.equal(
    browser.evidence,
    'Не удалось запустить браузер: Daemon process exited during startup',
  );

  // Одни предупреждения — не отказ записи; общая ошибка — последняя строка.
  const warnOnly = v(`${npmrc}\nnpm warn config x\nWARN  deprecated y\nError: boom`);
  assert.deepEqual([warnOnly.reason, warnOnly.evidence], ['failed', 'Error: boom']);
  // Настоящий отказ записи после предупреждения находится, и строка — его.
  const later = v(`${npmrc}\nError: EACCES: permission denied, open '/opt/tool/cache.json'`);
  assert.deepEqual(
    [later.reason, later.evidence],
    ['write-denied', "Error: EACCES: permission denied, open '/opt/tool/cache.json'"],
  );
  // Обёртка turbo после ошибки компилятора — не причина.
  const turboWrapped = v(
    [
      "@app/web:build: src/api.ts(3,28): error TS2307: Cannot find module '@app/sdk/http-client'.",
      '@app/web:build: ERROR: command finished with error: command (/w/apps/web) pnpm run build exited (1)',
    ].join('\n'),
  );
  assert.match(turboWrapped.evidence!, /error TS2307/);
  // Выброшенное предупреждение (`--throw-deprecation`) — причина, а обычное
  // `(node:N) …Warning` — шум.
  const thrown = v(
    [
      '(node:41) ExperimentalWarning: VM Modules is an experimental feature',
      'node:internal/process/warning:63',
      '      throw warning;',
      '      ^',
      'DeprecationWarning: this API must be removed',
      '    at emitWarning (node:internal/process/warning:63:7)',
    ].join('\n'),
  );
  assert.deepEqual(
    [thrown.reason, thrown.evidence],
    ['failed', 'DeprecationWarning: this API must be removed'],
  );
  // Тот же выброс с префиксом задачи turbo и обёрткой после него.
  const thrownTurbo = v(
    [
      '@app/web:build: node:internal/process/warning:63',
      '@app/web:build:       throw warning;',
      '@app/web:build: DeprecationWarning: this API must be removed',
      '@app/web:build: ERROR: command finished with error: command (/w/apps/web) pnpm run build exited (1)',
    ].join('\n'),
  );
  assert.equal(
    thrownTurbo.evidence,
    '@app/web:build: DeprecationWarning: this API must be removed',
  );
  // `XWarning:` без выброса (console.warn) после настоящей ошибки — не причина.
  const notThrown = v(
    'Error: actual compilation failure\nDeprecationWarning: the X option is deprecated',
  );
  assert.equal(notThrown.evidence, 'Error: actual compilation failure');
  // Невыброшенное предупреждение со словами ошибки или EPERM — тоже не причина.
  assert.equal(
    v(
      'Error: actual compilation failure\n@app/web:build: DeprecationWarning: This will become an error in a future version',
    ).evidence,
    'Error: actual compilation failure',
  );
  assert.notEqual(
    v("Error: boom\nExperimentalWarning: EPERM: operation not permitted, open '/x/y'").reason,
    'write-denied',
  );
  // Каждый кадр выброса сам по себе достаточен.
  for (const frame of ['node:internal/process/warning:63', '      throw warning;'])
    assert.equal(
      v(`${frame}\nDeprecationWarning: gone`).evidence,
      'DeprecationWarning: gone',
      frame,
    );
  // Из нескольких причин одного класса — последняя.
  assert.match(
    v(
      "EPERM: operation not permitted, open '/a/one'\nEPERM: operation not permitted, open '/b/two'",
    ).evidence!,
    /\/b\/two/,
  );
});

test('WP02: codex — команда под `codex sandbox` с профилем прав исполнителя; TMPDIR в области записи', async () => {
  const f = fixture((raw, root) => {
    raw.roles = { developer: { writer: { runtime: 'codex', toolProfile: 'web' } } };
    raw.toolProfiles = { web: { runtime: 'codex', codexNetwork: true } };
    raw.isolation = { mode: 'os', domains: [] };
    raw.repositories[0].writerProbe = [
      { id: 'tmp', command: node("require('fs').writeFileSync(process.env.TMPDIR+'/x','1')") },
      {
        id: 'listen',
        command: node(
          "console.error('Error: listen EPERM: operation not permitted');process.exit(1)",
        ),
      },
    ];
    // Подставной codex: пишет argv и окружение, исполняет команду после `--`.
    const fake = join(root, 'codex');
    writeFileSync(
      fake,
      `#!${process.execPath}\nconst fs=require('fs');const a=process.argv.slice(2);` +
        `fs.appendFileSync(${JSON.stringify(join(root, 'argv.jsonl'))},JSON.stringify({a,tmp:process.env.TMPDIR,prefix:process.env.TMPPREFIX})+'\\n');` +
        `const i=a.indexOf('--');const r=require('child_process').spawnSync(a[i+1],a.slice(i+2),{stdio:'inherit'});process.exit(r.status??1);`,
    );
    chmodSync(fake, 0o755);
  });
  const data = await f.smoke({ executables: { codex: join(f.root, 'codex') } });
  assert.equal(data.passed, true, JSON.stringify(data.failure));
  cliDataSchemas.smoke.parse(data);
  const probe = data.writerProbe!;
  assert.equal(probe.ok, false);
  const w = probe.writers[0]!;
  assert.deepEqual(
    [w.runtime, w.toolProfile, w.mechanism, w.network],
    ['codex', 'web', 'codex-sandbox', true],
  );
  assert.deepEqual(
    w.commands.map((c) => [c.id, c.status, c.reason]),
    [
      ['tmp', 'ok', undefined],
      ['listen', 'blocked', 'listen-denied'],
    ],
  );
  assert.match(w.commands[1]!.advice!, /gate harness/);
  const calls = readFileSync(join(f.root, 'argv.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { a: string[]; tmp: string; prefix: string });
  assert.equal(calls[0]!.a[0], 'sandbox');
  assert.ok(calls[0]!.a.includes('default_permissions="harness"'));
  assert.ok(
    calls[0]!.a.some((x) => /network=\{enabled=true\}/.test(x)),
    'сеть профиля',
  );
  // TMPDIR исполнителя — свой каталог, открытый профилем прав на запись.
  assert.match(calls[0]!.tmp, /\/dc-srt-\d+-[A-Za-z0-9]{6}\/w-[A-Za-z0-9]{6}$/, calls[0]!.tmp);
  assert.ok(!calls[0]!.tmp.startsWith(f.root), 'вне каталога состояния');
  assert.ok(calls[0]!.a.some((x) => x.includes(JSON.stringify(calls[0]!.tmp) + '="write"')));
  assert.equal(calls[0]!.prefix, join(calls[0]!.tmp, 'zsh'));
  assert.ok(!existsSync(calls[0]!.tmp), 'временный каталог пробы убран');
  assert.match(writerProbeText(probe), /listen: blocked — listen-denied/);
});

test('WP03: исполнитель без shell и пустой writerProbe названы, а не пропущены молча', async () => {
  const f = fixture((raw) => {
    raw.roles = { developer: { writer: { runtime: 'claude', toolProfile: 'edit' } } };
    raw.toolProfiles = { edit: { runtime: 'claude', claudeTools: ['Read', 'Edit'] } };
    raw.isolation = { mode: 'none', domains: [] };
    raw.repositories[0].writerProbe = [{ id: 'gen', command: node('0') }];
  });
  const data = await f.smoke();
  const w = data.writerProbe!.writers[0]!;
  assert.deepEqual(
    w.commands.map((c) => [c.id, c.status, c.reason]),
    [['gen', 'blocked', 'no-shell']],
  );
  const empty = fixture((raw) => {
    raw.isolation = { mode: 'none', domains: [] };
  });
  const none = await empty.smoke();
  assert.equal(none.writerProbe!.ok, false, 'пустая проба ничего не доказала');
  assert.match(none.writerProbe!.notes!.join(' '), /нет writerProbe/);
});

test(
  'WP04: claude — sandbox-runtime исполнителя: запись вне области закрыта, TMPDIR и loopback открыты',
  { skip: !isolationSupport().ok && 'sandbox-runtime недоступен' },
  async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wprobe-out-')));
    const f = fixture((raw) => {
      raw.isolation = { mode: 'os', domains: [] };
      raw.repositories[0].writerProbe = [
        { id: 'tmp', command: node("require('fs').writeFileSync(process.env.TMPDIR+'/x','1')") },
        {
          id: 'outside',
          command: node(`require('fs').writeFileSync(${JSON.stringify(join(outside, 'x'))},'1')`),
        },
        {
          id: 'listen',
          command: node(
            "require('net').createServer().listen(0,'127.0.0.1',function(){this.close()})",
          ),
        },
      ];
    });
    const data = await f.smoke();
    const w = data.writerProbe!.writers[0]!;
    assert.equal(w.mechanism, 'sandbox-runtime');
    assert.deepEqual(
      w.commands.map((c) => [c.id, c.status, c.reason]),
      [
        ['tmp', 'ok', undefined],
        ['outside', 'blocked', 'write-denied'],
        ['listen', 'ok', undefined],
      ],
      JSON.stringify(w.commands),
    );
  },
);
