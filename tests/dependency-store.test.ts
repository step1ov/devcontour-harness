/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method -- фикстура правит сырой JSON политики и подменяет методы storeTree. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { executionPolicySchema, type EvidenceRecord } from '../src/contracts/index.ts';
import { JointRunner } from '../src/engine/joint-runner.ts';
import { chooseCheckoutRoot } from '../src/environment/checkout-root.ts';
import {
  codexPermissions,
  credentialPaths,
  isolation,
  isolationSupport,
} from '../src/environment/isolation.ts';
import { executionEnvironment } from '../src/environment/lifecycle.ts';
import { processStart } from '../src/environment/process.ts';
import { ResourcePool, resourceKey } from '../src/environment/resources.ts';
import { assertToolchainReady, inspectPolicy } from '../src/toolchains/inspect.ts';
import { resolveExecutable } from '../src/toolchains/probe.ts';
import {
  dependencyStoreRoot,
  materializeStore,
  storeTree,
  type StoreContext,
} from '../src/verification/dependency-store.ts';
import { runGatesAt, type GatesAtContext } from '../src/verification/gates-at.ts';
import { components } from './components-fixture.ts';
import { ready } from './engine-fixture.ts';
import { example } from './fixtures.ts';
import { write } from './git-fixture.ts';
import { knap, propertySetup } from './property-fixture.ts';
import { approve, greet, implement, runAll, setup, target } from './runner-fixture.ts';

/**
 * Хранилище зависимостей на настоящем Git, настоящем pnpm и в настоящей
 * песочнице. Реестр — локальный сервер с настоящими tarball: песочница
 * оставляет проверкам localhost, а журнал запросов показывает, что именно
 * скачано, — это и есть различие попадания, частичного попадания и промаха.
 */
const sandbox = isolationSupport();
const pnpm = resolveExecutable('pnpm', process.env.PATH);
const unavailable = !sandbox.ok
  ? 'песочница ОС недоступна: ' + sandbox.detail
  : !pnpm
    ? 'pnpm не найден в PATH'
    : false;

type Deps = Record<string, string>;
const CONTENT = (name: string, version: string) => `module.exports = '${name}@${version}';\n`;

/** Настоящий пакет: tarball, integrity и метаданные реестра. */
function tarball(name: string, version: string, extra = Buffer.alloc(0)) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-pkg-')));
  mkdirSync(join(dir, 'package'));
  writeFileSync(
    join(dir, 'package', 'package.json'),
    JSON.stringify({ name, version, main: 'index.js' }),
  );
  writeFileSync(join(dir, 'package', 'index.js'), CONTENT(name, version));
  if (extra.length) writeFileSync(join(dir, 'package', 'data.bin'), extra);
  execFileSync('tar', ['czf', 'p.tgz', 'package'], {
    cwd: dir,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const bytes = readFileSync(join(dir, 'p.tgz'));
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

const CATALOG: Record<string, string[]> = {
  'dep-a': ['1.0.0'],
  'dep-b': ['1.0.0', '1.1.0'],
  'dep-c': ['1.0.0'],
  'dep-d': ['1.0.0'],
  'dep-big': ['1.0.0'],
};
const TARBALLS = new Map<string, Buffer>(
  Object.entries(CATALOG).flatMap(([name, versions]) =>
    versions.map(
      (v) =>
        [
          `/${name}/-/${name}-${v}.tgz`,
          tarball(name, v, name === 'dep-big' ? randomBytes(2 * 1024 * 1024) : undefined),
        ] as const,
    ),
  ),
);

/** Реестр на 127.0.0.1; `downloads` — успешно отданные tarball, `failNext` — отказать N раз. */
async function registry(t: TestContext) {
  const state = { downloads: [] as string[], failNext: 0, stallNext: 0, delayMs: 0, url: '' };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url ?? '/');
    const body = TARBALLS.get(path);
    if (body) {
      if (state.failNext > 0) {
        state.failNext--;
        res.writeHead(503).end();
        return;
      }
      state.downloads.push(path.split('/').at(-1)!);
      // Реестр, принявший запрос и не отвечающий: сеть, которая не падает, а висит.
      if (state.stallNext > 0) {
        state.stallNext--;
        return;
      }
      setTimeout(
        () => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body),
        state.delayMs,
      );
      return;
    }
    const name = path.slice(1);
    const versions = CATALOG[name];
    if (!versions) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        name,
        'dist-tags': { latest: versions.at(-1) },
        versions: Object.fromEntries(
          versions.map((version) => {
            const file = `/${name}/-/${name}-${version}.tgz`;
            const bytes = TARBALLS.get(file)!;
            return [
              version,
              {
                name,
                version,
                dist: {
                  tarball: state.url + file.slice(1),
                  shasum: createHash('sha1').update(bytes).digest('hex'),
                  integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
                },
              },
            ];
          }),
        ),
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return state;
}

const manifest = (deps: Deps) =>
  JSON.stringify({ name: 'app', version: '1.0.0', private: true, dependencies: deps }) + '\n';

/**
 * Настоящий lockfile для набора зависимостей: его пишет сам pnpm. Асинхронно:
 * реестр живёт в этом же процессе, синхронный запуск заблокировал бы его.
 */
async function lockFor(url: string, deps: Deps) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-lock-')));
  writeFileSync(join(dir, 'package.json'), manifest(deps));
  await promisify(execFile)(
    'pnpm',
    ['install', '--lockfile-only', '--ignore-workspace', `--registry=${url}`],
    { cwd: dir, env: { ...process.env, CI: '' } },
  );
  const text = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return text;
}

/** Gate читает установленный пакет: зависимость действительно на месте и нетронута. */
const useGate = (name: string, version: string) =>
  `const v=require('${name}');if(v!==${JSON.stringify(`${name}@${version}`)}){console.error('неверный пакет: '+v);process.exit(1)}`;

async function contour(
  url: string,
  deps: Deps,
  options: {
    scenario?: Parameters<typeof setup>[0]['scenario'];
    policy?: (p: Record<string, any>) => void;
    /** Файлы первого коммита; `null` — не класть. */
    files?: Record<string, string | null>;
    extraGates?: unknown[];
  } = {},
) {
  const files: Record<string, string | null> = {
    '.gitignore': 'node_modules\n',
    'package.json': manifest(deps),
    'pnpm-lock.yaml': await lockFor(url, deps),
    ...options.files,
  };
  const ctx = setup({
    scenario: options.scenario ?? {},
    files: Object.fromEntries(
      Object.entries(files).filter((e): e is [string, string] => e[1] !== null),
    ),
    policy: (p: Record<string, any>) => {
      const repo = p.repositories[0];
      repo.dependencyStore = { manager: 'pnpm' };
      repo.gates = [
        {
          id: 'install',
          kind: 'check',
          command: ['pnpm', 'install', '--frozen-lockfile'],
          timeoutMs: 60000,
        },
        ...(options.extraGates ?? []),
        ...repo.gates,
      ];
      p.isolation = { mode: 'os', domains: [] };
      p.environment.values.npm_config_registry = url;
      p.environment.values.npm_config_fetch_retries = '0';
      p.runTimeoutMs = 120000;
      options.policy?.(p);
    },
  });
  const context: GatesAtContext = {
    policy: ctx.policy,
    stateDir: ctx.state,
    repoPath: () => ctx.repo.dir,
    boundary: () => ({ hidden: [ctx.state], readable: [join(ctx.repo.dir, '.git')] }),
    resourceDatabase: join(ctx.state, 'resources.sqlite'),
  };
  const repo = ctx.policy.repositories[0]!;
  const seeds = join(ctx.state, 'dependency-store', repo.id, 'seeds');
  let run = 0;
  /** `install` и проверка пакетов на SHA; итог, квитанция и что осталось скачать. */
  const check = async (
    sha: string,
    gates = ['install'],
    extra: Partial<GatesAtContext> = {},
  ): Promise<{ result: any; receipt: any }> => {
    const id = `GA-${++run}`;
    const recorded: EvidenceRecord[] = [];
    const result = await runGatesAt(
      { ...context, ...extra },
      { id, repositoryId: repo.id, sha, gates, record: (e) => recorded.push(e) },
    );
    const path = join(ctx.state, 'gates-at', id, 'artifacts', 'dependency-store.json');
    return {
      result,
      receipt: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined,
    };
  };
  const commit = async (next: Deps, ref = repo.targetRef) => {
    write(ctx.repo.dir, {
      'package.json': manifest(next),
      'pnpm-lock.yaml': await lockFor(url, next),
    });
    ctx.repo.git('add', '-A');
    ctx.repo.git('commit', '-q', '-m', 'зависимости');
    ctx.repo.git('update-ref', ref, 'HEAD');
    return ctx.repo.head();
  };
  /** Единственный seed: файл с содержимым пакета — по манифесту и хэшу. */
  const seedOf = () => {
    const [key] = readdirSync(seeds);
    return { key: key!, dir: join(seeds, key!), store: join(seeds, key!, 'store') };
  };
  return { ...ctx, context, repoPolicy: repo, seeds, check, commit, seedOf };
}

const gatesPassed = (r: { result: any }) =>
  assert.equal(r.result.failure, undefined, JSON.stringify(r.result.failures));

const casOf = (store: string, text: string) => {
  const hash = createHash('sha512').update(text).digest('hex');
  return join(store, 'v10', 'files', hash.slice(0, 2), hash.slice(2));
};

test(
  'DS01: seed из lockfile, попадание без скачивания, частичное попадание докачивает разницу, сдвиг lockfile докачивает только её',
  { skip: unavailable, timeout: 180000 },
  async (t) => {
    const reg = await registry(t);
    const ctx = await contour(
      reg.url,
      { 'dep-a': '1.0.0' },
      {
        files: { '.gitignore': 'node_modules\n.store-path\n' },
        policy: (p) => {
          // `prepare` идёт на хосте, вне песочницы: хранилище то же, что у gates.
          p.repositories[0].prepare = [
            { id: 'where', command: ['sh', '-c', 'pnpm store path > .store-path'] },
          ];
        },
        extraGates: [
          {
            id: 'use-a',
            kind: 'check',
            command: [
              'node',
              '-e',
              useGate('dep-a', '1.0.0') +
                `;const w=require('fs').readFileSync('.store-path','utf8').trim();if(!w.startsWith(process.cwd()+'/.pnpm-store')){console.error('чужое хранилище: '+w);process.exit(1)}`,
            ],
            dependsOn: ['install'],
          },
        ],
      },
    );
    const base = ctx.repo.head();

    const first = await ctx.check(base, ['use-a']);
    gatesPassed(first);
    assert.equal(first.receipt.outcome, 'hit');
    assert.equal(first.receipt.built, true, 'первая проверка собрала seed');
    assert.deepEqual(reg.downloads, ['dep-a-1.0.0.tgz'], 'пакет скачан один раз — сборкой seed');

    reg.downloads.length = 0;
    const hit = await ctx.check(base, ['use-a']);
    gatesPassed(hit);
    assert.equal(hit.receipt.outcome, 'hit');
    assert.equal(hit.receipt.built, undefined);
    assert.deepEqual(reg.downloads, [], 'попадание ничего не качает');
    if (process.platform === 'darwin') assert.equal(hit.receipt.mode, 'clone');

    // Кандидат с другим lockfile: seed остаётся, install докачивает разницу.
    ctx.repo.git('checkout', '-q', '-b', 'side');
    const side = await ctx.commit({ 'dep-a': '1.0.0', 'dep-b': '1.0.0' }, 'refs/heads/side');
    ctx.repo.git('checkout', '-q', 'main');
    reg.downloads.length = 0;
    const partial = await ctx.check(side);
    gatesPassed(partial);
    assert.equal(partial.receipt.outcome, 'partial');
    assert.deepEqual(reg.downloads, ['dep-b-1.0.0.tgz'], 'докачана только разница');
    assert.equal(readdirSync(ctx.seeds).length, 1, 'lockfile кандидата seed не создаёт');

    // Сдвиг целевой ветки: новый seed из прежнего, докачка только разницы.
    reg.downloads.length = 0;
    const moved = await ctx.commit({ 'dep-a': '1.0.0', 'dep-c': '1.0.0' });
    const refreshed = await ctx.check(moved);
    gatesPassed(refreshed);
    assert.equal(refreshed.receipt.outcome, 'hit');
    assert.equal(refreshed.receipt.built, true);
    assert.deepEqual(reg.downloads, ['dep-c-1.0.0.tgz'], 'сборка докачала только новый пакет');
    assert.equal(readdirSync(ctx.seeds).length, 2);
  },
);

test(
  'DS02: промах и отказ сборки сводятся к обычной установке; отказ не повторяется каждой попыткой',
  { skip: unavailable, timeout: 180000 },
  async (t) => {
    const reg = await registry(t);
    const ctx = await contour(reg.url, { 'dep-a': '1.0.0' });
    const base = ctx.repo.head();

    reg.failNext = 1; // Отказ получает сборка seed; реестр восстановился к установке.
    const miss = await ctx.check(base);
    gatesPassed(miss);
    assert.equal(miss.receipt.outcome, 'miss');
    assert.match(miss.receipt.reason, /сборка seed/);
    assert.deepEqual(reg.downloads, ['dep-a-1.0.0.tgz'], 'обычная установка скачала пакет');
    assert.equal(existsSync(ctx.seeds) ? readdirSync(ctx.seeds).length : 0, 0);

    // Недавний отказ: новая сборка не идёт, установка всё равно обычная.
    reg.downloads.length = 0;
    const cooling = await ctx.check(base);
    gatesPassed(cooling);
    assert.equal(cooling.receipt.outcome, 'miss');
    assert.match(cooling.receipt.reason, /недавняя сборка/);
    assert.deepEqual(reg.downloads, ['dep-a-1.0.0.tgz']);

    // Срок вышел: seed собирается.
    const root = join(ctx.state, 'dependency-store', ctx.repoPolicy.id, 'failed');
    const old = new Date(Date.now() - 3600_000);
    for (const name of readdirSync(root)) utimesSync(join(root, name), old, old);
    const again = await ctx.check(base);
    gatesPassed(again);
    assert.equal(again.receipt.outcome, 'hit');
    assert.equal(again.receipt.built, true);

    // Сборка нового lockfile не удалась: старый seed — частичное попадание.
    reg.downloads.length = 0;
    const moved = await ctx.commit({ 'dep-a': '1.0.0', 'dep-b': '1.0.0' });
    reg.failNext = 1;
    const partial = await ctx.check(moved);
    gatesPassed(partial);
    assert.equal(partial.receipt.outcome, 'partial');
    assert.match(partial.receipt.reason, /сборка seed/, 'причина отказа сборки видна');
    assert.deepEqual(reg.downloads, ['dep-b-1.0.0.tgz'], 'разницу докачала установка');
  },
);

test(
  'DS03: занятый путь, отсутствие lockfile и изоляция none — обычная установка, запись мимо дерева невозможна',
  { skip: unavailable, timeout: 180000 },
  async (t) => {
    const reg = await registry(t);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'harness-outside-')));
    const ctx = await contour(reg.url, { 'dep-a': '1.0.0' });
    symlinkSync(outside, join(ctx.repo.dir, '.pnpm-store'));
    ctx.repo.git('add', '-A');
    ctx.repo.git('commit', '-q', '-m', 'ссылка');
    const linked = ctx.repo.head();
    ctx.repo.git('update-ref', ctx.repoPolicy.targetRef, 'HEAD');
    const occupied = await ctx.check(linked);
    assert.equal(occupied.receipt.outcome, 'miss');
    assert.match(occupied.receipt.reason, /уже есть/);
    assert.deepEqual(readdirSync(outside), [], 'через ссылку controller ничего не записал');

    const noLock = await contour(reg.url, { 'dep-a': '1.0.0' });
    noLock.repo.git('rm', '-q', 'pnpm-lock.yaml');
    noLock.repo.git('commit', '-q', '-m', 'без lockfile');
    const none = await noLock.check(noLock.repo.head(), ['install']);
    assert.equal(none.receipt.outcome, 'miss');
    assert.match(none.receipt.reason, /нет файла/);

    const open = await contour(
      reg.url,
      { 'dep-a': '1.0.0' },
      {
        policy: (p) => {
          p.isolation = { mode: 'none', domains: [] };
        },
      },
    );
    const plain = await open.check(open.repo.head());
    gatesPassed(plain);
    assert.equal(plain.receipt.outcome, 'miss');
    assert.match(plain.receipt.reason, /isolation\.mode: none/);
    assert.equal(existsSync(open.seeds), false, 'без границы seed не создаётся');
  },
);

for (const [name, tamper, why] of [
  [
    'содержимое файла',
    (s: { store: string }) => {
      const file = casOf(s.store, CONTENT('dep-a', '1.0.0'));
      chmodSync(file, 0o644);
      writeFileSync(file, 'module.exports = "отравлено";\n');
    },
    /изменено содержимое/,
  ],
  [
    'права файла',
    (s: { store: string }) => chmodSync(casOf(s.store, CONTENT('dep-a', '1.0.0')), 0o755),
    /изменены права/,
  ],
  [
    'лишний файл',
    (s: { store: string }) => writeFileSync(join(s.store, 'v10', 'planted'), 'x'),
    /набор файлов/,
  ],
  [
    'файл __proto__',
    (s: { store: string }) => writeFileSync(join(s.store, '__proto__'), 'подложено'),
    /набор файлов/,
  ],
  [
    'символическая ссылка',
    (s: { store: string }) => {
      const file = casOf(s.store, CONTENT('dep-a', '1.0.0'));
      rmSync(file);
      symlinkSync('/etc/hosts', file);
    },
    /не обычный файл/,
  ],
  [
    'манифест вместе с содержимым',
    (s: { store: string; dir: string }) => {
      const file = casOf(s.store, CONTENT('dep-a', '1.0.0'));
      chmodSync(file, 0o644);
      writeFileSync(file, 'module.exports = "отравлено";\n');
      const path = join(s.dir, 'manifest.json');
      const m = JSON.parse(readFileSync(path, 'utf8'));
      const rel = file.slice(s.store.length + 1);
      m.files[rel][0] = createHash('sha256').update(readFileSync(file)).digest('hex');
      writeFileSync(path, JSON.stringify(m));
    },
    /манифест не совпал/,
  ],
] as const)
  test(
    `DS04: подменённый seed отклоняется и собирается заново — ${name}`,
    { skip: unavailable, timeout: 120000 },
    async (t) => {
      const reg = await registry(t);
      const ctx = await contour(
        reg.url,
        { 'dep-a': '1.0.0' },
        {
          extraGates: [
            {
              id: 'use-a',
              kind: 'check',
              command: ['node', '-e', useGate('dep-a', '1.0.0')],
              dependsOn: ['install'],
            },
          ],
        },
      );
      const base = ctx.repo.head();
      gatesPassed(await ctx.check(base, ['use-a']));
      tamper(ctx.seedOf());
      reg.downloads.length = 0;
      const after = await ctx.check(base, ['use-a']);
      gatesPassed(after);
      assert.equal(after.receipt.outcome, 'hit');
      assert.equal(after.receipt.built, true, 'seed собран заново из реестра');
      assert.match(after.receipt.refused.join('\n'), why);
      assert.deepEqual(reg.downloads, ['dep-a-1.0.0.tgz']);
    },
  );

test(
  'DS05: записанное исполнителем остаётся в его дереве: seed, следующая проверка и integration чисты; commit без хранилища',
  { skip: unavailable, timeout: 240000 },
  async (t) => {
    const reg = await registry(t);
    const seedProbe = (seeds: string) => `
      const fs=require('fs');const r={};
      for (const [k,op] of [['read',()=>fs.readdirSync(${JSON.stringify(seeds)})],['write',()=>fs.writeFileSync(${JSON.stringify(join(seeds, 'x'))},'x')]])
        try{op();r[k]='доступно'}catch(e){r[k]=e.code}
      if(Object.values(r).includes('доступно')){console.error(JSON.stringify(r));process.exit(1)}
      console.log(JSON.stringify(r));`;
    const ctx = await contour(
      reg.url,
      { 'dep-a': '1.0.0' },
      {
        scenario: { reviewer: approve() },
        policy: (p) => {
          p.repositories[0].gates.push({
            id: 'use-a',
            kind: 'check',
            command: [
              'node',
              '-e',
              `if(process.env.DEVCONTOUR_PHASE==='integration'){${useGate('dep-a', '1.0.0')}}`,
            ],
            dependsOn: ['install'],
          });
        },
      },
    );
    gatesPassed(await ctx.check(ctx.repo.head()));
    const seed = ctx.seedOf();
    const before = readFileSync(join(seed.dir, 'manifest.json'), 'utf8');
    const poison = 'module.exports = "отравлено";\n';
    const rel = casOf('.pnpm-store', CONTENT('dep-a', '1.0.0'));
    writeFileSync(
      ctx.scenarioPath,
      JSON.stringify({
        writer: {
          ...implement({ 'src/greet.js': greet, '.pnpm-store/v10/planted': 'x' }),
          replace: { [rel]: poison },
        },
        reviewer: approve(),
      }),
    );
    // Песочница gate: seed закрыт и на чтение, и на запись.
    const closed = await runGatesAt(
      {
        ...ctx.context,
        policy: executionPolicySchema.parse({
          ...ctx.policy,
          repositories: [
            {
              ...ctx.repoPolicy,
              gates: [
                ...ctx.repoPolicy.gates,
                {
                  id: 'probe-seed',
                  kind: 'check',
                  command: ['node', '-e', seedProbe(ctx.seeds)],
                },
              ],
            },
          ],
        }),
      },
      {
        repositoryId: ctx.repoPolicy.id,
        sha: ctx.repo.head(),
        gates: ['probe-seed'],
        record: () => undefined,
      },
    );
    assert.equal(closed.failure, undefined, JSON.stringify(closed.failures));

    await runAll(ctx);
    const work = ctx.engine.read((v) => v.work(ctx.graph.orders[0]!.id)!);
    assert.equal(work.status, 'done', work.failure);
    assert.equal(readFileSync(join(seed.dir, 'manifest.json'), 'utf8'), before, 'seed не менялся');
    assert.equal(
      readFileSync(casOf(seed.store, CONTENT('dep-a', '1.0.0')), 'utf8'),
      CONTENT('dep-a', '1.0.0'),
    );
    assert.equal(existsSync(join(seed.store, 'v10', 'planted')), false);
    const changed = ctx.repo
      .git('diff', '--name-only', ctx.repo.git('rev-parse', `${target(ctx)}^`), target(ctx))
      .split('\n');
    assert.deepEqual(changed, ['src/greet.js'], 'хранилище не попало в commit');
    const stages = ctx.engine.read((v) =>
      v.attempts(work.id).flatMap((a) => (a.timings ?? []).map((s) => s.stage)),
    );
    assert.equal(stages.filter((s) => s === 'dependency-store').length, 2);
    gatesPassed(await ctx.check(ctx.repo.git('rev-parse', ctx.repoPolicy.targetRef)));
  },
);

test(
  'DS06: параллельные проверки на одном холодном seed: одна сборка, один раз каждый пакет',
  { skip: unavailable, timeout: 180000 },
  async (t) => {
    const reg = await registry(t);
    const ctx = await contour(reg.url, { 'dep-a': '1.0.0', 'dep-b': '1.1.0' });
    const base = ctx.repo.head();
    // Медленный реестр: сборка идёт, пока стартуют остальные проверки.
    reg.delayMs = 3000;
    const all = await Promise.all([ctx.check(base), ctx.check(base), ctx.check(base)]);
    reg.delayMs = 0;
    for (const r of all) gatesPassed(r);
    for (const r of all) assert.equal(r.receipt.reason, undefined, r.receipt.reason);
    assert.deepEqual(
      all.map((r) => r.receipt.outcome),
      ['hit', 'hit', 'hit'],
    );
    assert.equal(all.filter((r) => r.receipt.built).length, 1, 'сборка одна');
    assert.deepEqual(reg.downloads.sort(), ['dep-a-1.0.0.tgz', 'dep-b-1.1.0.tgz']);
    assert.equal(readdirSync(ctx.seeds).length, 1);
    const failed = join(ctx.state, 'dependency-store', ctx.repoPolicy.id, 'failed');
    assert.equal(existsSync(failed), false, 'ни одна сборка не отказала');
  },
);

test(
  'DS07: брошенная упавшим процессом аренда снимается, живая — ждётся',
  { skip: unavailable, timeout: 120000 },
  async (t) => {
    const reg = await registry(t);
    const ctx = await contour(reg.url, { 'dep-a': '1.0.0' });
    const database = join(ctx.state, 'resources.sqlite');
    const root = join(ctx.state, 'dependency-store', ctx.repoPolicy.id);
    const held = spawnSync(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--input-type=module',
        '-e',
        `import { DatabaseSync } from 'node:sqlite';
         import { createHash, randomBytes } from 'node:crypto';
         const [db, row] = process.argv.slice(1);
         const d = new DatabaseSync(db);
         d.exec('CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, resource TEXT NOT NULL, owner TEXT NOT NULL, token TEXT NOT NULL, pid INTEGER NOT NULL, expires INTEGER NOT NULL)');
         const { key, resource } = JSON.parse(row);
         d.prepare('INSERT INTO leases VALUES (?,?,?,?,?,?)').run(key, resource, 'dead', 'dead-token', process.pid, Date.now() + 3600000);`,
        database,
        JSON.stringify(leaseRow(root)),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(held.status, 0, held.stderr);
    const r = await ctx.check(ctx.repo.head());
    gatesPassed(r);
    assert.equal(r.receipt.built, true, 'аренда мёртвого процесса не держит сборку');
    const pool = new ResourcePool(database);
    assert.deepEqual(pool.list(), [], 'своя аренда снята');
    pool.close();
  },
);

test(
  'DS23: pid занят другим процессом — аренда снимается; живой владелец не теряет её ни по сроку, ни по бюджету',
  { skip: unavailable, timeout: 120000 },
  async (t) => {
    const reg = await registry(t);
    const ctx = await contour(reg.url, { 'dep-a': '1.0.0' });
    const database = join(ctx.state, 'resources.sqlite');
    const root = join(ctx.state, 'dependency-store', ctx.repoPolicy.id);
    const hold = (owner: string, expires: number) => {
      const db = new DatabaseSync(database);
      db.exec(
        'CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, resource TEXT NOT NULL, owner TEXT NOT NULL, token TEXT NOT NULL, pid INTEGER NOT NULL, expires INTEGER NOT NULL)',
      );
      const { key, resource } = leaseRow(root);
      db.prepare('INSERT INTO leases VALUES (?,?,?,?,?,?)').run(
        key,
        resource,
        owner,
        'other-token',
        process.pid,
        expires,
      );
      db.close();
    };
    // pid жив, но запущен в другой момент: это другой процесс.
    hold('dependency-store-started:Thu Jan  1 00:00:00 1970', Date.now() + 3600000);
    const reused = await ctx.check(ctx.repo.head());
    gatesPassed(reused);
    assert.equal(reused.receipt.built, true);

    // Тот же процесс, истёкший срок: аренда живого владельца не отнимается.
    const live = await contour(
      reg.url,
      { 'dep-a': '1.0.0' },
      {
        policy: (p) => {
          p.runTimeoutMs = 9000;
        },
      },
    );
    const liveRoot = join(live.state, 'dependency-store', live.repoPolicy.id);
    const started = await processStart(process.pid);
    const db = new DatabaseSync(join(live.state, 'resources.sqlite'));
    db.exec(
      'CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, resource TEXT NOT NULL, owner TEXT NOT NULL, token TEXT NOT NULL, pid INTEGER NOT NULL, expires INTEGER NOT NULL)',
    );
    const { key, resource } = leaseRow(liveRoot);
    db.prepare('INSERT INTO leases VALUES (?,?,?,?,?,?)').run(
      key,
      resource,
      'dependency-store-started:' + started!,
      'live-token',
      process.pid,
      Date.now() - 1000,
    );
    db.close();
    const waited = await live.check(live.repo.head());
    assert.equal(waited.receipt.outcome, 'miss');
    assert.match(waited.receipt.reason, /не дождались/);
    const check = new ResourcePool(join(live.state, 'resources.sqlite'));
    assert.equal(check.list().length, 1, 'аренда осталась');
    check.close();
  },
);

function leaseRow(root: string) {
  const resource = {
    id: 'dependency-store',
    kind: 'service',
    value: 'dependency-store:' + root,
  } as const;
  return { key: resourceKey(resource), resource: JSON.stringify(resource) };
}

test(
  'DS08: совместная проверка получает хранилище без prepare; другие компоненты не трогаются',
  { skip: unavailable, timeout: 240000 },
  async (t) => {
    const reg = await registry(t);
    const ctx = await contour(
      reg.url,
      { 'dep-a': '1.0.0' },
      {
        scenario: { writer: implement(), reviewer: approve() },
        policy: (p) => {
          p.workspaceGates = [
            {
              id: 'joint-install',
              kind: 'check',
              repositoryId: p.repositories[0].id,
              command: ['pnpm', 'install', '--frozen-lockfile'],
              timeoutMs: 60000,
            },
            {
              id: 'joint-use',
              kind: 'test',
              repositoryId: p.repositories[0].id,
              command: [
                'node',
                '-e',
                useGate('dep-a', '1.0.0') +
                  `;if(process.env.npm_config_store_dir!==process.cwd()+'/.pnpm-store'){console.error('нет хранилища в окружении');process.exit(1)}` +
                  `;require('fs').mkdirSync('reports',{recursive:true});require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="use"/></testsuite>')`,
              ],
              report: { type: 'junit', path: 'reports/joint-use.xml' },
              dependsOn: ['joint-install'],
            },
          ];
        },
      },
    );
    await ctx.runner.init();
    ready(ctx.engine, ctx.graph, 'runner-1');
    await ctx.runner.drain();
    const work = ctx.engine.read((v) => v.work(ctx.graph.orders[0]!.id)!);
    assert.equal(work.status, 'done', work.failure);
    reg.downloads.length = 0;
    const joint = new JointRunner({
      engine: ctx.engine,
      stateDir: ctx.state,
      baseDir: ctx.state,
      resourceDatabase: join(ctx.state, 'resources.sqlite'),
    });
    const verified = await joint.verify([work.id]);
    assert.equal(
      verified.status,
      'passed',
      verified.status === 'failed' ? verified.error : undefined,
    );
    assert.deepEqual(reg.downloads, [], 'совместные gates ничего не качали');
    const receipt = JSON.parse(
      readFileSync(
        join(
          ctx.state,
          'joint',
          verified.id,
          'dependency-store',
          ctx.repoPolicy.id,
          'dependency-store.json',
        ),
        'utf8',
      ),
    );
    assert.equal(receipt.outcome, 'hit');
  },
);

test(
  'DS09: диск ограничен: остаются два seed, предел размера, брошенные каталоги убираются, слишком большой seed не публикуется',
  { skip: unavailable, timeout: 240000 },
  async (t) => {
    const reg = await registry(t);
    const ctx = await contour(reg.url, { 'dep-a': '1.0.0' });
    const root = join(ctx.state, 'dependency-store', ctx.repoPolicy.id);
    gatesPassed(await ctx.check(ctx.repo.head()));
    const orphan = join(root, 'tmp', 'orphan', 'store');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'x'), 'x');
    gatesPassed(await ctx.check(await ctx.commit({ 'dep-a': '1.0.0', 'dep-b': '1.0.0' })));
    assert.equal(existsSync(join(root, 'tmp', 'orphan')), false, 'брошенная сборка убрана');
    gatesPassed(await ctx.check(await ctx.commit({ 'dep-a': '1.0.0', 'dep-c': '1.0.0' })));
    gatesPassed(await ctx.check(await ctx.commit({ 'dep-a': '1.0.0', 'dep-d': '1.0.0' })));
    assert.equal(readdirSync(ctx.seeds).length, 2, 'больше двух seeds не копится');
    // Рабочее дерево проверки убрано вместе с копией хранилища.
    assert.equal(ctx.repo.git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1);

    // Предел вмещает один seed: прежний вытесняется сразу.
    const small = await contour(
      reg.url,
      { 'dep-big': '1.0.0' },
      {
        policy: (p) => {
          p.repositories[0].dependencyStore.maxBytes = 3 * 1024 * 1024;
        },
      },
    );
    gatesPassed(await small.check(small.repo.head()));
    gatesPassed(await small.check(await small.commit({ 'dep-big': '1.0.0', 'dep-a': '1.0.0' })));
    assert.equal(readdirSync(small.seeds).length, 1);

    // Файлов больше, чем выдержит сверка защищённых путей: тоже не публикуется.
    const limit = storeTree.maxFiles;
    storeTree.maxFiles = 1;
    t.after(() => {
      storeTree.maxFiles = limit;
    });
    const crowded = await contour(reg.url, { 'dep-a': '1.0.0' });
    const many = await crowded.check(crowded.repo.head());
    gatesPassed(many);
    assert.equal(many.receipt.outcome, 'miss');
    assert.match(many.receipt.reason, /файлов больше предела/);
    storeTree.maxFiles = limit;

    // Сам seed больше предела: не публикуется, установка обычная.
    const over = await contour(
      reg.url,
      { 'dep-big': '1.0.0' },
      {
        policy: (p) => {
          p.repositories[0].dependencyStore.maxBytes = 1024 * 1024;
        },
      },
    );
    const refused = await over.check(over.repo.head());
    gatesPassed(refused);
    assert.equal(refused.receipt.outcome, 'miss');
    assert.match(refused.receipt.reason, /больше предела/);
    assert.equal(existsSync(over.seeds) ? readdirSync(over.seeds).length : 0, 0);
  },
);

test(
  'DS10: без клонирования — обычная копия с теми же проверками; нехватка места — промах',
  { skip: unavailable, timeout: 120000 },
  async (t) => {
    const reg = await registry(t);
    const ctx = await contour(reg.url, { 'dep-a': '1.0.0' });
    const original = storeTree.cloneable;
    storeTree.cloneable = () => Promise.resolve(false);
    t.after(() => {
      storeTree.cloneable = original;
    });
    const copied = await ctx.check(ctx.repo.head());
    gatesPassed(copied);
    assert.equal(copied.receipt.outcome, 'hit');
    assert.equal(copied.receipt.mode, 'copy');
    reg.downloads.length = 0;
    const again = await ctx.check(ctx.repo.head());
    gatesPassed(again);
    assert.equal(again.receipt.mode, 'copy');
    assert.deepEqual(reg.downloads, []);
    const full = storeTree.freeBytes;
    storeTree.freeBytes = () => Promise.resolve(1);
    t.after(() => {
      storeTree.freeBytes = full;
    });
    const noRoom = await ctx.check(ctx.repo.head());
    gatesPassed(noRoom);
    assert.equal(noRoom.receipt.outcome, 'miss');
    assert.match(noRoom.receipt.reason, /не помещается/);
    assert.equal(readdirSync(ctx.seeds).length, 1, 'нехватка места — не отказ от seed');
  },
);

test(
  'DS14: сборка не исполняет файлы проекта; копия не делит inode с seed и скрыта от git',
  { skip: unavailable, timeout: 120000 },
  async (t) => {
    const reg = await registry(t);
    const hook =
      "if (process.env.npm_config_state_dir) throw new Error('хук проекта в сборке seed');\nmodule.exports = {};\n";
    const ctx = await contour(
      reg.url,
      { 'dep-a': '1.0.0' },
      {
        files: { '.pnpmfile.cjs': hook, 'pnpm-workspace.yaml': 'packages: []\n' },
      },
    );
    const first = await ctx.check(ctx.repo.head());
    gatesPassed(first);
    assert.equal(first.receipt.built, true, first.receipt.reason);

    const worktree = join(ctx.state, 'held');
    ctx.repo.git('worktree', 'add', '-q', '--detach', worktree, 'HEAD');
    const execution = executionEnvironment([ctx.policy.environment], {}, process.env);
    const receipt = await materializeStore(
      {
        policy: ctx.policy,
        root: (id) => join(ctx.state, 'dependency-store', id),
        repoPath: () => ctx.repo.dir,
        boundary: { hidden: [ctx.state] },
        resourceDatabase: join(ctx.state, 'resources.sqlite'),
        deadline: Date.now() + 60000,
      },
      {
        repo: ctx.repoPolicy,
        cwd: worktree,
        execution,
        signal: new AbortController().signal,
        dir: join(ctx.state, 'held-out'),
      },
    );
    assert.equal(receipt!.outcome, 'hit');
    assert.equal(execution.env.npm_config_store_dir, join(worktree, '.pnpm-store'));
    assert.equal(
      ctx.repo.git('-C', worktree, 'status', '--porcelain', '--untracked-files=all'),
      '',
    );
    const text = CONTENT('dep-a', '1.0.0');
    const seedFile = casOf(ctx.seedOf().store, text);
    const ownFile = casOf(join(worktree, '.pnpm-store'), text);
    assert.notEqual(lstatSync(ownFile).ino, lstatSync(seedFile).ino, 'копия — отдельный файл');
    assert.equal(lstatSync(seedFile).nlink, 1, 'жёстких ссылок на seed нет');
    // Запись на месте в копию до seed не доходит: ни общего inode, ни общих блоков.
    chmodSync(ownFile, 0o644);
    writeFileSync(ownFile, 'module.exports = "отравлено";\n');
    assert.equal(readFileSync(seedFile, 'utf8'), text);
  },
);

/** Шаг хоста: записать своё хранилище и фазу в журнал вне дерева. */
const recordStore = (log: string, label: string) => [
  'node',
  '-e',
  `require('fs').appendFileSync(${JSON.stringify(log)},${JSON.stringify(label)}+' '+process.cwd()+' '+process.env.npm_config_store_dir+'\\n')`,
];
const storeLines = (log: string) =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(' '));

test(
  'DS16: снимок зависимости и проверка потребителя получают хранилище своего дерева в окружении команд',
  { skip: unavailable, timeout: 120000 },
  async () => {
    const log = join(realpathSync(mkdtempSync(join(tmpdir(), 'harness-log-'))), 'stores');
    const ctx = components({
      chain: true,
      policy: (p) => {
        p.isolation = { mode: 'os', domains: [] };
        for (const r of p.repositories) r.dependencyStore = { manager: 'pnpm' };
        const mid = p.repositories.find((r: any) => r.id === 'mid');
        mid.dependencyBuild.unshift({ id: 'record', command: recordStore(log, 'snapshot') });
        const product = p.repositories.find((r: any) => r.id === 'product');
        product.prepare = [{ id: 'record', command: recordStore(log, 'consumer') }];
      },
    });
    await ctx.runner.init();
    ready(ctx.engine, ctx.graph, 'runner-1');
    await ctx.runner.drain();
    const work = ctx.engine.read((v) => v.work(ctx.graph.orders[0]!.id)!);
    assert.equal(work.status, 'done', work.failure);
    const lines = storeLines(log);
    for (const label of ['snapshot', 'consumer']) {
      const row = lines.find((l) => l[0] === label);
      assert.ok(row, label + ': команда не запускалась');
      assert.equal(row[2], row[1] + '/.pnpm-store', label);
    }
  },
);

test(
  'DS21: проверка примера разворачивает хранилище в своём дереве',
  { skip: unavailable, timeout: 180000 },
  async () => {
    const log = join(realpathSync(mkdtempSync(join(tmpdir(), 'harness-log-'))), 'stores');
    const ctx = propertySetup({
      writer: [
        implement({ 'src/knap.mjs': knap.firstThree }),
        implement({ 'src/knap.mjs': knap.correct }),
      ],
      policy: (p: Record<string, any>) => {
        p.isolation = { mode: 'os', domains: [] };
        p.repositories[0].dependencyStore = { manager: 'pnpm' };
        p.repositories[0].prepare = [
          {
            id: 'record',
            command: [
              'node',
              '-e',
              `if(process.env.DEVCONTOUR_PHASE==='case')${recordStore(log, 'case')[2]}`,
            ],
          },
        ];
      },
    });
    await ctx.runner.init();
    await runAll(ctx);
    await ctx.runner.submitCase({
      workId: 'add-greeting',
      property: 'knapsack-optimal',
      input: JSON.stringify({ items: [{ w: 1, v: 1 }], cap: 4 }),
      expected: '1',
      key: 'store-case',
    });
    const [row] = storeLines(log);
    assert.equal(row![0], 'case');
    assert.match(row![2]!, /\/\.pnpm-store$/);
    assert.ok(row![2]!.startsWith(row![1]!), 'хранилище в дереве примера');
  },
);

test('DS15: doctor предупреждает, а не останавливает запуск', async () => {
  const ctx = setup({
    scenario: {},
    policy: (p: Record<string, any>) => {
      p.repositories[0].dependencyStore = { manager: 'pnpm' };
      p.repositories[0].prepare = [{ id: 'build', command: ['node', '--version'] }];
    },
  });
  const options = {
    probe: () =>
      Promise.resolve({ code: 0, stdout: '12.16.1\n', stderr: '', timedOut: false as const }),
  };
  const [report] = await inspectPolicy(ctx.policy, ctx.repo.dir, options);
  const warned = report!.warnings.map((w) => w.code);
  assert.ok(warned.includes('LOCKFILE_MISSING'), 'lockfile');
  assert.equal(report!.problems.filter((x) => x.code === 'LOCKFILE_MISSING').length, 0);
  const notes = report!.warnings.map((w) => w.message).join('\n');
  assert.match(notes, /12\.16\.1 вне проверенных версий/);
  assert.match(notes, /код кандидата/);
  await assertToolchainReady(ctx.policy, ctx.repo.dir, options);

  const missing = await inspectPolicy(ctx.policy, ctx.repo.dir, { env: { PATH: '/nonexistent' } });
  assert.ok(missing[0]!.warnings.some((w) => w.code === 'TOOL_MISSING'));
  assert.equal(missing[0]!.problems.filter((x) => x.message.includes('pnpm')).length, 0);
});

test(
  'DS17: lockfile больше предела вывода команды читается целиком; seed без файлов не публикуется',
  { skip: unavailable, timeout: 120000 },
  async (t) => {
    const reg = await registry(t);
    const lock = await lockFor(reg.url, { 'dep-a': '1.0.0' });
    const big = '# заполнитель заполнитель\n'.repeat(120000) + lock;
    assert.ok(big.length > 2_500_000);
    const ctx = await contour(
      reg.url,
      { 'dep-a': '1.0.0' },
      {
        files: { 'pnpm-lock.yaml': big },
      },
    );
    const first = await ctx.check(ctx.repo.head());
    gatesPassed(first);
    assert.equal(first.receipt.outcome, 'hit', first.receipt.reason);
    assert.ok(first.receipt.files > 0);

    const empty = await contour(reg.url, {});
    const r = await empty.check(empty.repo.head());
    gatesPassed(r);
    assert.equal(r.receipt.outcome, 'miss');
    assert.match(r.receipt.reason, /ни одного файла/);
    assert.equal(existsSync(empty.seeds) ? readdirSync(empty.seeds).length : 0, 0);
    const again = await empty.check(empty.repo.head());
    assert.match(again.receipt.reason, /сборка этого lockfile невозможна/);
  },
);

test(
  'DS18: висящий реестр не расходует попытку: сборку ограничивает доля времени, очередь не повторяет отказ',
  { skip: unavailable, timeout: 180000 },
  async (t) => {
    const reg = await registry(t);
    const ctx = await contour(
      reg.url,
      { 'dep-a': '1.0.0' },
      {
        scenario: { writer: implement(), reviewer: approve() },
        policy: (p) => {
          p.runTimeoutMs = 45000;
        },
      },
    );
    // Настоящая попытка: при `timeoutMs` 10 минут сборка съела бы весь её предел.
    reg.stallNext = 1;
    await ctx.runner.init();
    ready(ctx.engine, ctx.graph, 'runner-1');
    await ctx.runner.drain();
    const work = ctx.engine.read((v) => v.work(ctx.graph.orders[0]!.id)!);
    assert.equal(work.status, 'done', work.failure);
    const attempts = ctx.engine.read((v) => v.attempts(work.id));
    assert.equal(attempts.length, 1, 'попытка не потрачена');

    const queue = await contour(reg.url, { 'dep-b': '1.0.0' });
    const direct = (name: string, budget: number) => {
      const cwd = join(queue.state, name);
      queue.repo.git('worktree', 'add', '-q', '--detach', cwd, 'HEAD');
      return materializeStore(
        {
          policy: queue.policy,
          root: (id) => join(queue.state, 'dependency-store', id),
          repoPath: () => queue.repo.dir,
          boundary: { hidden: [queue.state] },
          resourceDatabase: join(queue.state, 'resources.sqlite'),
          deadline: Date.now() + budget * 3,
        },
        {
          repo: queue.repoPolicy,
          cwd,
          execution: executionEnvironment([queue.policy.environment], {}, process.env),
          signal: new AbortController().signal,
          dir: join(queue.state, name + '-out'),
        },
      );
    };
    reg.downloads.length = 0;
    reg.stallNext = 10;
    const started = Date.now();
    const building = direct('a', 6000);
    // Вторая проверка встаёт в очередь, когда сборка уже идёт.
    while (!reg.downloads.length) await new Promise((r) => setTimeout(r, 50));
    const [first, waiting] = await Promise.all([building, direct('b', 30000)]);
    assert.equal(first!.outcome, 'miss');
    assert.match(first!.reason!, /бюджет хранилища/);
    assert.equal(waiting!.outcome, 'miss');
    assert.match(waiting!.reason!, /недавняя сборка/);
    assert.equal(reg.downloads.length, 1, 'ожидавшая проверка сборку не повторила');
    assert.ok(Date.now() - started < 25000, 'ожидание не заняло бюджет целиком');
    // Истёкший бюджет — про сеть, а не про lockfile: срок вышел — сборка идёт снова.
    const marks = join(queue.state, 'dependency-store', queue.repoPolicy.id, 'failed');
    for (const name of readdirSync(marks)) {
      assert.equal(JSON.parse(readFileSync(join(marks, name), 'utf8')).permanent, false);
      const old = new Date(Date.now() - 3600_000);
      utimesSync(join(marks, name), old, old);
    }

    // Отмена попытки — единственное, что прерывает фазу.
    const controller = new AbortController();
    const cwd = join(queue.state, 'c');
    queue.repo.git('worktree', 'add', '-q', '--detach', cwd, 'HEAD');
    const failed = join(queue.state, 'dependency-store', queue.repoPolicy.id, 'failed');
    rmSync(failed, { recursive: true, force: true });
    const pending = materializeStore(
      {
        policy: queue.policy,
        root: (id) => join(queue.state, 'dependency-store', id),
        repoPath: () => queue.repo.dir,
        boundary: { hidden: [queue.state] },
        resourceDatabase: join(queue.state, 'resources.sqlite'),
        deadline: Date.now() + 90000,
      },
      {
        repo: queue.repoPolicy,
        cwd,
        execution: executionEnvironment([queue.policy.environment], {}, process.env),
        signal: controller.signal,
        dir: join(queue.state, 'c-out'),
      },
    );
    setTimeout(() => controller.abort(new Error('отмена оператора')), 1500);
    await assert.rejects(pending);

    // Реестр ожил: lockfile не списан, seed собирается.
    reg.stallNext = 0;
    const recovered = await direct('rebuilt', 30000);
    assert.equal(recovered!.outcome, 'hit', recovered!.reason);
  },
);

test(
  'DS24: менеджер, вышедший с кодом 0 по отмене бюджета, — не завершённая сборка и не приговор lockfile',
  { skip: unavailable, timeout: 120000 },
  async (t) => {
    const reg = await registry(t);
    const run = storeTree.run;
    // Гонка с отменой: менеджер и обёртка песочницы завершились с кодом 0.
    storeTree.run = (_h, options) =>
      new Promise((done) => {
        // Настоящий менеджер успевает создать пустой store.
        mkdirSync(join(options.write[0]!, 'store'), { recursive: true });
        options.signal.addEventListener('abort', () =>
          done({ code: 0, stdout: '', stderr: '', timedOut: false } as Awaited<
            ReturnType<typeof run>
          >),
        );
      });
    t.after(() => {
      storeTree.run = run;
    });
    const ctx = await contour(
      reg.url,
      { 'dep-a': '1.0.0' },
      {
        policy: (p) => {
          p.runTimeoutMs = 9000;
        },
      },
    );
    const r = await ctx.check(ctx.repo.head());
    gatesPassed(r);
    assert.equal(r.receipt.outcome, 'miss');
    assert.match(r.receipt.reason, /бюджет хранилища/);
    const marks = join(ctx.state, 'dependency-store', ctx.repoPolicy.id, 'failed');
    const [mark] = readdirSync(marks);
    assert.equal(JSON.parse(readFileSync(join(marks, mark!), 'utf8')).permanent, false);
  },
);

test(
  'DS19: версия вне проверенных: окружение и дерево как без хранилища, gate проходит',
  { skip: unavailable, timeout: 120000 },
  async (t) => {
    const reg = await registry(t);
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'harness-pnpm-')));
    writeFileSync(
      join(bin, 'pnpm'),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 12.16.1; exit 0; fi\nexec ${JSON.stringify(pnpm)} "$@"\n`,
      { mode: 0o755 },
    );
    const noStore = {
      id: 'no-store',
      kind: 'check',
      command: [
        'node',
        '-e',
        `if(process.env.npm_config_store_dir!==undefined){console.error('вмешательство');process.exit(1)}`,
      ],
    };
    const ctx = await contour(
      reg.url,
      { 'dep-a': '1.0.0' },
      {
        extraGates: [noStore],
        policy: (p) => {
          p.environment.values.PATH = bin + ':' + process.env.PATH;
        },
      },
    );
    const r = await ctx.check(ctx.repo.head(), ['install', 'no-store']);
    gatesPassed(r);
    assert.equal(r.receipt.outcome, 'miss');
    assert.match(r.receipt.reason, /12\.16\.1 вне проверенных версий/);
    assert.deepEqual(r.receipt.env, {});
    assert.equal(existsSync(ctx.seeds), false, 'seed не собирался');

    // Версия, закреплённая проектом, важнее найденной в PATH.
    const pinned = await contour(
      reg.url,
      { 'dep-a': '1.0.0' },
      {
        extraGates: [noStore],
        files: {
          'package.json': JSON.stringify({
            ...JSON.parse(manifest({ 'dep-a': '1.0.0' })),
            packageManager: 'pnpm@11.25.0',
          }),
        },
        policy: (p) => {
          p.environment.values.npm_config_manage_package_manager_versions = 'false';
        },
      },
    );
    const declared = await pinned.check(pinned.repo.head(), ['no-store']);
    gatesPassed(declared);
    assert.match(declared.receipt.reason, /11\.25\.0 вне проверенных версий/);
  },
);

test(
  'DS20: неизбежный отказ сборки не повторяется, пока lockfile не изменится',
  { skip: unavailable, timeout: 120000 },
  async (t) => {
    const reg = await registry(t);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-patched-')));
    const deps = { 'dep-a': '1.0.0' };
    const patch = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1 +1 @@
-${CONTENT('dep-a', '1.0.0').trim()}
+module.exports = 'patched';
`;
    const pkg = JSON.stringify({
      ...JSON.parse(manifest(deps)),
      pnpm: { patchedDependencies: { 'dep-a@1.0.0': 'patches/dep-a.patch' } },
    });
    mkdirSync(join(dir, 'patches'));
    writeFileSync(join(dir, 'patches', 'dep-a.patch'), patch);
    writeFileSync(join(dir, 'package.json'), pkg);
    await promisify(execFile)(
      'pnpm',
      ['install', '--lockfile-only', '--ignore-workspace', `--registry=${reg.url}`],
      { cwd: dir, env: { ...process.env, CI: '' } },
    );
    const ctx = await contour(reg.url, deps, {
      files: {
        'package.json': pkg,
        'pnpm-lock.yaml': readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8'),
        'patches/dep-a.patch': patch,
      },
    });
    const first = await ctx.check(ctx.repo.head());
    gatesPassed(first);
    assert.equal(first.receipt.outcome, 'miss');
    assert.match(first.receipt.reason, /PATCH_NOT_FOUND/);
    const root = join(ctx.state, 'dependency-store', ctx.repoPolicy.id, 'failed');
    const old = new Date(Date.now() - 3600_000);
    for (const name of readdirSync(root)) utimesSync(join(root, name), old, old);
    const later = await ctx.check(ctx.repo.head());
    assert.match(later.receipt.reason, /сборка этого lockfile невозможна/);
  },
);

test(
  'DS22: seed другого формата не основа; предел элементов; отказ квитанции и .gitignore не роняют фазу',
  { skip: unavailable, timeout: 120000 },
  async (t) => {
    const reg = await registry(t);
    const ctx = await contour(reg.url, { 'dep-a': '1.0.0' });
    gatesPassed(await ctx.check(ctx.repo.head()));
    const seed = ctx.seedOf();
    const path = join(seed.dir, 'manifest.json');
    const old = JSON.parse(readFileSync(path, 'utf8'));
    old.format = 0;
    writeFileSync(path, JSON.stringify(old));
    const database = join(ctx.state, 'resources.sqlite');
    const root = join(ctx.state, 'dependency-store', ctx.repoPolicy.id);
    const pool = new ResourcePool(database);
    pool.setSeedPin(root, seed.key, createHash('sha256').update(readFileSync(path)).digest('hex'));
    pool.close();
    reg.downloads.length = 0;
    const moved = await ctx.check(await ctx.commit({ 'dep-a': '1.0.0', 'dep-b': '1.0.0' }));
    gatesPassed(moved);
    assert.equal(moved.receipt.outcome, 'hit');
    assert.deepEqual(
      reg.downloads.sort(),
      ['dep-a-1.0.0.tgz', 'dep-b-1.0.0.tgz'],
      'основой стал пустой store, а не seed другого формата',
    );

    const entries = storeTree.maxEntries;
    storeTree.maxEntries = 2;
    t.after(() => {
      storeTree.maxEntries = entries;
    });
    const over = await ctx.check(ctx.repo.head());
    gatesPassed(over);
    assert.equal(over.receipt.outcome, 'miss');
    assert.match(over.receipt.reason, /элементов, предел 2/);
    storeTree.maxEntries = entries;

    // Каталог квитанции — файл, запись `.gitignore` отказывает: фаза идёт дальше.
    const cwd = join(ctx.state, 'held');
    ctx.repo.git('worktree', 'add', '-q', '--detach', cwd, 'HEAD');
    const blocked = join(ctx.state, 'not-a-dir');
    writeFileSync(blocked, '');
    const ignore = storeTree.ignore;
    storeTree.ignore = () => Promise.reject(new Error('нет места'));
    t.after(() => {
      storeTree.ignore = ignore;
    });
    const execution = executionEnvironment([ctx.policy.environment], {}, process.env);
    const receipt = await materializeStore(
      {
        policy: ctx.policy,
        root: (id) => join(ctx.state, 'dependency-store', id),
        repoPath: () => ctx.repo.dir,
        boundary: { hidden: [ctx.state] },
        resourceDatabase: database,
        deadline: Date.now() + 60000,
      },
      {
        repo: ctx.repoPolicy,
        cwd,
        execution,
        signal: new AbortController().signal,
        dir: join(blocked, 'x'),
      },
    );
    storeTree.ignore = ignore;
    assert.equal(receipt!.outcome, 'miss', 'копии нет — квитанция не говорит hit');
    assert.equal(receipt!.seed, undefined);
    assert.deepEqual(receipt!.env, {});
    assert.equal(execution.env.npm_config_store_dir, undefined);
    assert.equal(existsSync(join(cwd, '.pnpm-store')), false);
  },
);

test('DS11: выключено по умолчанию: политика без поля та же, этапа и файлов нет', async () => {
  const parsed = executionPolicySchema.parse(structuredClone(example('policy')));
  assert.equal('dependencyStore' in parsed.repositories[0]!, false);
  const ctx = setup({ scenario: {} });
  const execution = executionEnvironment([ctx.policy.environment], {}, process.env);
  const receipt = await materializeStore(
    {
      policy: ctx.policy,
      root: (id) => join(ctx.state, id),
      repoPath: () => ctx.repo.dir,
      boundary: { hidden: [ctx.state] },
      resourceDatabase: join(ctx.state, 'resources.sqlite'),
      deadline: Date.now() + 60000,
    } satisfies StoreContext,
    {
      repo: ctx.policy.repositories[0]!,
      cwd: ctx.repo.dir,
      execution,
      signal: new AbortController().signal,
      dir: join(ctx.state, 'x'),
    },
  );
  assert.equal(receipt, undefined);
  assert.equal(existsSync(join(ctx.state, 'x')), false);
  assert.equal(existsSync(join(ctx.repo.dir, '.pnpm-store')), false);
});

test('DS12: каталог seeds закрыт профилю codex и там, где его ещё нет', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-roots-')));
  const worktree = join(root, 'app', 'worktrees', 'a');
  mkdirSync(worktree, { recursive: true });
  const policy = isolation({ write: [worktree], controller: [], checkouts: [root] });
  const profile = codexPermissions(policy, false).join(' ');
  assert.ok(profile.includes(JSON.stringify(join(root, 'app', 'dependency-store')) + '="none"'));
  assert.ok(lstatSync(worktree).isDirectory());
});

test('DS13: каталог seeds — корень рабочих деревьев, иначе каталог состояния', () => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'harness-state-')));
  const inPlace = chooseCheckoutRoot({
    stateDirs: [state],
    repositories: [],
    hidden: credentialPaths(),
  });
  assert.equal(dependencyStoreRoot(inPlace, state, 'app'), join(state, 'dependency-store', 'app'));
  assert.equal(
    dependencyStoreRoot({ root: '/r', placement: 'configured' }, state, 'app'),
    join('/r', 'app', 'dependency-store'),
  );
});
