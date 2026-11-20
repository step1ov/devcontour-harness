/**
 * Поддельный реестр npm (локальный HTTP-сервер) и поддельные пакеты
 * devcontour-harness и devcontour-harness-ui для тестов `harness update`.
 * Пакеты — настоящие tarball npm (`package/…`), их ставит настоящий npm из
 * этого реестра во временный проект; живого реестра и публикации нет.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeVersion {
  name: string;
  version: string;
  tgz: Buffer;
  peerDependencies?: Record<string, string>;
  bin: Record<string, string>;
}

export const FORMATS = {
  api: 'devcontour-harness/v1alpha1',
  state: 1,
  policy: 1,
  handoff: 1,
  report: 1,
  view: 1,
};

const root = () => mkdtempSync(join(tmpdir(), 'harness-update-fixture-'));

function pack(dir: string): Buffer {
  const out = join(dir, '..', 'pkg.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'package']);
  return readFileSync(out);
}

/**
 * Поддельный harness: `doctor` печатает конверт с версией пакета; `fail`
 * — doctor падает (exit 4), как сломанная новая версия.
 */
export function fakeHarness(
  version: string,
  o: {
    formats?: Record<string, unknown> | null;
    notes?: string;
    fail?: boolean;
    /** doctor пишет файл в каталог состояния (новая версия успела изменить состояние). */
    touch?: boolean;
  } = {},
): FakeVersion {
  const dir = join(root(), 'src');
  const pkg = join(dir, 'package');
  mkdirSync(join(pkg, 'docs', 'release-notes'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: 'devcontour-harness',
      version,
      bin: { harness: 'cli.js' },
      ...(o.formats === null ? {} : { devcontourHarness: { formats: o.formats ?? FORMATS } }),
    }),
  );
  writeFileSync(
    join(pkg, 'cli.js'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(JSON.stringify({ ok: true, data: { harness: ${JSON.stringify(version)} } })); process.exit(0); }
// Состояние «формата» пакета: doctor новой версии помечает его своим форматом
// (как миграция), status прежней отказывает на формате новее своего.
const stateArg = args.indexOf('--state') >= 0 ? args[args.indexOf('--state') + 1] : undefined;
const fs = require('node:fs');
const path = require('node:path');
const mine = ${JSON.stringify((o.formats ?? FORMATS)?.state ?? 1)};
const marker = stateArg ? path.join(stateArg, 'fake-format') : undefined;
if (args[0] === 'status') {
  const seen = marker && fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 1;
  if (seen > mine) { console.log(JSON.stringify({ ok: false, error: { code: 'STATE_VERSION_UNSUPPORTED', message: 'newer' } })); process.exit(4); }
  console.log(JSON.stringify({ ok: true, data: {} }));
  process.exit(0);
}
if (args[0] === 'doctor') {
  if (marker && mine > 1) fs.writeFileSync(marker, String(mine));
  ${o.touch ? "if (stateArg) fs.writeFileSync(path.join(stateArg, 'touched-by-new'), 'x');" : ''}
  ${o.fail ? "console.log(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'broken' } })); process.exit(4);" : ''}
  console.log(JSON.stringify({ apiVersion: 'devcontour-harness/v1alpha1', command: 'doctor', ok: true, data: { harness: ${JSON.stringify(version)}, state: { stateVersion: 1, compatible: true } } }));
  process.exit(0);
}
console.log(JSON.stringify({ ok: true, data: {} }));
`,
  );
  chmodSync(join(pkg, 'cli.js'), 0o755);
  writeFileSync(
    join(pkg, 'docs', 'release-notes', `${version}.md`),
    o.notes ??
      `# devcontour-harness ${version}\n\nФорматы прежние.\n\n## Изменения\n\n### Новое в ${version}\n\nТекст.\n\n### Второе в ${version}\n`,
  );
  return { name: 'devcontour-harness', version, tgz: pack(dir), bin: { harness: 'cli.js' } };
}

/** Поддельная панель: `--check` — совместима; иначе печатает адрес и работает до SIGTERM. */
export function fakeUi(
  version: string,
  peer: string,
  o: { failCheck?: boolean } = {},
): FakeVersion {
  const dir = join(root(), 'src');
  const pkg = join(dir, 'package');
  mkdirSync(join(pkg, 'docs', 'release-notes'), { recursive: true });
  const bin = { 'devcontour-harness-ui': 'cli.js' };
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: 'devcontour-harness-ui',
      version,
      bin,
      peerDependencies: { 'devcontour-harness': peer },
      peerDependenciesMeta: { 'devcontour-harness': { optional: true } },
    }),
  );
  writeFileSync(
    join(pkg, 'cli.js'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--check')) { console.log(JSON.stringify({ ok: ${!o.failCheck}, compatible: ${!o.failCheck} })); process.exit(${o.failCheck ? 3 : 0}); }
if (args.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
console.log(JSON.stringify({ ok: true, url: 'http://127.0.0.1:4790/', port: 4790, readOnly: true, version: ${JSON.stringify(version)} }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );
  chmodSync(join(pkg, 'cli.js'), 0o755);
  writeFileSync(
    join(pkg, 'docs', 'release-notes', `${version}.md`),
    `# devcontour-harness-ui ${version}\n\n## Коротко\n\n- Панель ${version} показывает обновления\n`,
  );
  return {
    name: 'devcontour-harness-ui',
    version,
    tgz: pack(dir),
    bin,
    peerDependencies: { 'devcontour-harness': peer },
  };
}

export interface FakeRegistry {
  url: string;
  publish(v: FakeVersion, tag?: string): void;
  /** Запросы к реестру (метод и путь), по порядку. */
  readonly requests: string[];
  /** Забыть записанные запросы. */
  resetRequests(): void;
  close(): Promise<void>;
}

/**
 * Сервер реестра — отдельный процесс: тесты вызывают CLI и npm синхронно
 * (spawnSync), и сервер в процессе теста не ответил бы. Пакеты и журнал
 * запросов — файлы каталога реестра; сервер читает их на каждый запрос.
 */
const serverScript = String.raw`
const { createServer } = require('node:http');
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const dir = process.argv[1];
let url = '';
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  appendFileSync(join(dir, 'requests.log'), req.method + ' ' + path + '\n');
  const tarball = /^\/([^/]+)\/-\/[^/]+-(\d[^/]*)\.tgz$/.exec(path);
  if (tarball) {
    const file = join(dir, tarball[1], tarball[2] + '.tgz');
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(readFileSync(file));
  }
  const name = path.slice(1);
  const metaFile = join(dir, name, 'meta.json');
  if (!name || name.includes('..') || !existsSync(metaFile)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not found' }));
  }
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const versions = {};
  for (const [version, v] of Object.entries(meta.versions)) {
    const tgz = readFileSync(join(dir, name, version + '.tgz'));
    versions[version] = {
      name, version, bin: v.bin,
      ...(v.peerDependencies ? { peerDependencies: v.peerDependencies } : {}),
      dist: {
        tarball: url + '/' + name + '/-/' + name + '-' + version + '.tgz',
        shasum: createHash('sha1').update(tgz).digest('hex'),
        integrity: 'sha512-' + createHash('sha512').update(tgz).digest('base64'),
      },
    };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ name, 'dist-tags': meta.tags, versions }));
});
server.listen(0, '127.0.0.1', () => {
  url = 'http://127.0.0.1:' + server.address().port;
  process.stdout.write(url + '\n');
});
process.on('SIGTERM', () => process.exit(0));
`;

export async function fakeRegistry(): Promise<FakeRegistry> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-update-registry-'));
  writeFileSync(join(dir, 'requests.log'), '');
  const child = spawn(process.execPath, ['-e', serverScript, dir], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise<string>((done, fail) => {
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += String(d);
      if (out.includes('\n')) done(out.trim());
    });
    child.on('exit', (code) => fail(new Error('реестр не поднялся: ' + String(code))));
  });
  let closed = false;
  return {
    url,
    get requests() {
      return readFileSync(join(dir, 'requests.log'), 'utf8').split('\n').filter(Boolean);
    },
    resetRequests: () => writeFileSync(join(dir, 'requests.log'), ''),
    publish(v, tag = 'alpha') {
      const pkgDir = join(dir, v.name);
      mkdirSync(pkgDir, { recursive: true });
      const metaFile = join(pkgDir, 'meta.json');
      const meta = existsSync(metaFile)
        ? (JSON.parse(readFileSync(metaFile, 'utf8')) as {
            tags: Record<string, string>;
            versions: Record<string, unknown>;
          })
        : { tags: {} as Record<string, string>, versions: {} as Record<string, unknown> };
      writeFileSync(join(pkgDir, v.version + '.tgz'), v.tgz);
      meta.versions[v.version] = {
        bin: v.bin,
        ...(v.peerDependencies ? { peerDependencies: v.peerDependencies } : {}),
      };
      if (tag) meta.tags[tag] = v.version;
      writeFileSync(metaFile, JSON.stringify(meta));
    },
    close: () =>
      closed
        ? Promise.resolve()
        : new Promise<void>((r) => {
            closed = true;
            child.once('exit', () => r());
            child.kill('SIGTERM');
          }),
  };
}

/** Окружение npm теста: свой кэш и userconfig, реестр — поддельный. */
export function npmEnv(registry: string, home: string): Record<string, string> {
  mkdirSync(join(home, 'npm-cache'), { recursive: true });
  writeFileSync(join(home, '.npmrc'), `registry=${registry}/\n`);
  return {
    npm_config_cache: join(home, 'npm-cache'),
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_registry: `${registry}/`,
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
}
