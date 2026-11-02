import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gateSchema,
  sha256,
  type EvidenceRecord,
  type GateArtifactFiles,
  type GatePolicy,
} from '../src/contracts/index.ts';
import { redactor } from '../src/environment/redaction.ts';
import { TaskFailure } from '../src/engine/failure.ts';
import { keepGateArtifacts } from '../src/verification/gate-artifacts.ts';
import { runGate } from '../src/verification/gates.ts';
import { junit, nodeGate, repo } from './git-fixture.ts';

const temp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** Дерево проверки и каталог артефактов вне его. */
function tree(files: Record<string, string | Buffer> = {}) {
  const root = temp('harness-ga-root-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, dest: join(temp('harness-ga-out-'), 'unit', 'artifacts') };
}

const reasons = (kept: GateArtifactFiles) => kept.skipped.map((s) => [s.path, s.reason]);

/** Каждая запись сохранённого файла соответствует байтам копии. */
function assertCopies(kept: GateArtifactFiles) {
  for (const f of kept.files) {
    const bytes = readFileSync(join(kept.dir, f.path));
    assert.equal(f.sha256, sha256(bytes), f.path);
    assert.equal(f.bytes, bytes.length, f.path);
  }
}

test('gate artifacts: каталог обходится по именам, разрешённые расширения копируются, прочие названы', async () => {
  const { root, dest } = tree({
    'shots/b.png': 'png-b',
    'shots/a.png': 'png-a',
    'shots/page.html': '<html>',
    'shots/sub/note.txt': 'note',
    'results/report.xml': '<r/>',
    'results/run.log': 'log',
    'results/data.JSON': '{}',
  });
  const kept = await keepGateArtifacts({
    root,
    paths: ['shots/', 'results', 'missing/dir'],
    dest,
    redact: (v) => v,
  });
  assert.deepEqual(
    kept.files.map((f) => f.path),
    [
      'shots/a.png',
      'shots/b.png',
      'shots/sub/note.txt',
      'results/data.JSON',
      'results/report.xml',
      'results/run.log',
    ],
  );
  assert.deepEqual(reasons(kept), [
    ['shots/page.html', 'extension'],
    ['missing/dir', 'missing'],
  ]);
  assert.equal(kept.dir, dest);
  assert.equal(readFileSync(join(dest, 'shots/a.png'), 'utf8'), 'png-a');
  assertCopies(kept);
});

test('gate artifacts: секрет окружения в текстовой копии замаскирован, digest относится к копии', async () => {
  const secret = 'synthetic-artifact-secret-4417';
  const { root, dest } = tree({
    'out/trace.json': `{"token":"${secret}"}`,
    'out/shot.png': secret,
  });
  const kept = await keepGateArtifacts({
    root,
    paths: ['out'],
    dest,
    redact: redactor([secret]),
  });
  const trace = kept.files.find((f) => f.path === 'out/trace.json')!;
  assert.equal(trace.redacted, true);
  assert.ok(!readFileSync(join(dest, 'out/trace.json'), 'utf8').includes(secret));
  // Двоичный снимок не переписывается: маска портила бы изображение.
  assert.equal(kept.files.find((f) => f.path === 'out/shot.png')!.redacted, undefined);
  assertCopies(kept);
});

test('gate artifacts: ссылки не разыменовываются — ни в каталоге, ни в компоненте пути, ни сам путь', async () => {
  const outside = temp('harness-ga-outside-');
  writeFileSync(join(outside, 'secret.png'), 'outside');
  const { root, dest } = tree({ 'shots/ok.png': 'ok' });
  symlinkSync(join(outside, 'secret.png'), join(root, 'shots', 'leak.png'));
  symlinkSync(outside, join(root, 'shots', 'dir'));
  symlinkSync(outside, join(root, 'escape'));
  symlinkSync(join(outside, 'secret.png'), join(root, 'direct.png'));
  const kept = await keepGateArtifacts({
    root,
    paths: ['shots', 'escape/secret.png', 'escape', 'direct.png'],
    dest,
    redact: (v) => v,
  });
  assert.deepEqual(
    kept.files.map((f) => f.path),
    ['shots/ok.png'],
  );
  assert.deepEqual(reasons(kept), [
    ['shots/dir', 'symlink'],
    ['shots/leak.png', 'symlink'],
    ['escape/secret.png', 'symlink'],
    ['escape', 'symlink'],
    ['direct.png', 'symlink'],
  ]);
  assert.ok(!existsSync(join(dest, 'escape')) && !existsSync(join(dest, 'direct.png')));
  assert.equal(readFileSync(join(outside, 'secret.png'), 'utf8'), 'outside', 'источник цел');
});

test('gate artifacts: путь за пределами дерева не копируется и при обходе схемы', async () => {
  const { root, dest } = tree({ 'a.png': 'a' });
  writeFileSync(join(root, '..', 'sibling.png'), 'sibling');
  const kept = await keepGateArtifacts({
    root,
    paths: ['../sibling.png', 'a.png'],
    dest,
    redact: (v) => v,
  });
  assert.deepEqual(
    kept.files.map((f) => f.path),
    ['a.png'],
  );
  assert.deepEqual(reasons(kept), [['../sibling.png', 'outside']]);
});

test('gate artifacts: не обычный файл (FIFO) не открывается и назван', async () => {
  const { root, dest } = tree({ 'out/a.log': 'a' });
  execFileSync('mkfifo', [join(root, 'out', 'pipe.log')]);
  const kept = await keepGateArtifacts({ root, paths: ['out'], dest, redact: (v) => v });
  assert.deepEqual(
    kept.files.map((f) => f.path),
    ['out/a.log'],
  );
  assert.deepEqual(reasons(kept), [['out/pipe.log', 'not-regular']]);
});

test('gate artifacts: пределы файла, суммы, числа и обхода — пропуск с причиной, не потеря', async () => {
  const { root, dest } = tree({
    'big/a.png': Buffer.alloc(30),
    'big/b.png': Buffer.alloc(11),
    'big/c.png': Buffer.alloc(10),
    'big/d.png': Buffer.alloc(10),
    'big/e.png': Buffer.alloc(1),
    'big/f.png': Buffer.alloc(1),
  });
  const kept = await keepGateArtifacts({
    root,
    paths: ['big'],
    dest,
    redact: (v) => v,
    limits: { fileBytes: 20, totalBytes: 21, files: 2 },
  });
  assert.deepEqual(
    kept.files.map((f) => f.path),
    ['big/b.png', 'big/c.png'],
  );
  assert.deepEqual(reasons(kept), [
    ['big/a.png', 'file-limit'],
    ['big/d.png', 'count-limit'],
    ['big/e.png', 'count-limit'],
    ['big/f.png', 'count-limit'],
  ]);
  assert.equal(
    kept.files.reduce((n, f) => n + f.bytes, 0),
    21,
  );
  assertCopies(kept);
  // Сумма: третий файл не помещается, следующий меньший — помещается.
  const total = await keepGateArtifacts({
    root,
    paths: ['big/b.png', 'big/c.png', 'big/e.png'],
    dest,
    redact: (v) => v,
    limits: { totalBytes: 12 },
  });
  assert.deepEqual(
    total.files.map((f) => f.path),
    ['big/b.png', 'big/e.png'],
  );
  assert.deepEqual(reasons(total), [['big/c.png', 'total-limit']]);
  assert.ok(!existsSync(join(dest, 'big/a.png')), 'прежние копии убраны');
  // Обход и список пропусков ограничены, остаток посчитан.
  const scan = await keepGateArtifacts({
    root,
    paths: ['big'],
    dest,
    redact: (v) => v,
    limits: { scan: 3, skipped: 2 },
  });
  assert.deepEqual(
    scan.files.map((f) => f.path),
    ['big/a.png', 'big/b.png'],
  );
  assert.deepEqual(reasons(scan), [
    ['big/c.png', 'scan-limit'],
    ['big/d.png', 'scan-limit'],
  ]);
  assert.equal(scan.skippedMore, 2);
});

test('gate artifacts: каталог копий, совпадающий с деревом, не удаляется — отказ записан', async () => {
  const { root } = tree({ 'a.png': 'a' });
  const kept = await keepGateArtifacts({ root, paths: ['a.png'], dest: root, redact: (v) => v });
  assert.deepEqual(kept.files, []);
  assert.deepEqual(reasons(kept), [['a.png', 'copy-failed']]);
  assert.equal(readFileSync(join(root, 'a.png'), 'utf8'), 'a', 'дерево цело');
  const parent = await keepGateArtifacts({
    root,
    paths: ['a.png'],
    dest: join(root, '..'),
    redact: (v) => v,
  });
  assert.deepEqual(reasons(parent), [['a.png', 'copy-failed']]);
  assert.ok(existsSync(join(root, 'a.png')));
});

test('gate artifacts: схема — относительные пути, не больше 16, без пустого списка', () => {
  const base = {
    id: 'visual',
    kind: 'test',
    command: ['true'],
    report: { type: 'junit', path: 'r.xml' },
  };
  assert.deepEqual(
    gateSchema.parse({ ...base, artifacts: ['test-results/shots', 'out/a.png'] }).artifacts,
    ['test-results/shots', 'out/a.png'],
  );
  assert.equal('artifacts' in gateSchema.parse(base), false, 'умолчание не подставляется');
  for (const artifacts of [
    [],
    ['/tmp/shots'],
    ['../shots'],
    ['a/../../b'],
    ['shots/*.png'],
    Array.from({ length: 17 }, (_, i) => `a${i}`),
  ])
    assert.equal(
      gateSchema.safeParse({ ...base, artifacts }).success,
      false,
      JSON.stringify(artifacts),
    );
});

/** Gate задачи на настоящем репозитории; evidence записывается при любом исходе. */
async function gate(dir: string, sha: string, g: Partial<GatePolicy> & { command: string[] }) {
  const recorded: Omit<EvidenceRecord, 'id' | 'runId' | 'createdAt'>[] = [];
  const artifactDir = temp('harness-ga-art-');
  let failure: TaskFailure | undefined;
  try {
    await runGate({
      policy: { isolation: { mode: 'none', domains: [] } },
      record: (e) => {
        recorded.push(e);
        return { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
      },
      cwd: dir,
      sha,
      phase: 'candidate',
      gate: {
        id: 'visual',
        kind: 'test',
        timeoutMs: 20000,
        report: { type: 'junit', path: 'test-results/junit.xml' },
        ...g,
      },
      artifactDir,
      signal: new AbortController().signal,
      execution: { env: process.env, redact: (v) => v },
      boundary: { hidden: [], readable: [] },
    });
  } catch (error) {
    if (!(error instanceof TaskFailure)) throw error;
    failure = error;
  }
  assert.equal(recorded.length, 1);
  return { evidence: recorded[0]!, failure, artifactDir };
}

const shots = (sizes: number[]) =>
  `const fs = require('fs'); fs.mkdirSync('test-results/shots', { recursive: true });` +
  sizes
    .map((n, i) => `fs.writeFileSync('test-results/shots/s${i}.png', Buffer.alloc(${n}, ${i}));`)
    .join('');

test('runGate: упавший gate сохраняет снимки экрана в evidence и остаётся проваленным', async () => {
  const r = repo({ '.gitignore': 'test-results/\n' });
  const { evidence, failure, artifactDir } = await gate(r.dir, r.head(), {
    command: nodeGate(
      shots([5, 7]) +
        junit('<testcase name="looks"><failure message="diff"/></testcase>') +
        ';process.exit(1)',
    ),
    artifacts: ['test-results/shots'],
  });
  assert.ok(failure, 'провал остаётся провалом');
  assert.equal(evidence.passed, false);
  const kept = evidence.artifactFiles!;
  assert.equal(kept.dir, join(artifactDir, 'visual', 'artifacts'));
  assert.deepEqual(
    kept.files.map((f) => [f.path, f.bytes]),
    [
      ['test-results/shots/s0.png', 5],
      ['test-results/shots/s1.png', 7],
    ],
  );
  assertCopies(kept);
});

test('runGate: превышение пределов не меняет исход gate ни в одну сторону и названо', async () => {
  const mb = 1024 * 1024;
  // 9 МБ — больше предела файла; 7+7+7 — больше суммы 20 МБ.
  const sizes = [9 * mb, 7 * mb, 7 * mb, 7 * mb];
  for (const ok of [true, false]) {
    const r = repo({ '.gitignore': 'test-results/\n' });
    const { evidence, failure } = await gate(r.dir, r.head(), {
      command: nodeGate(
        shots(sizes) +
          junit(ok ? '<testcase name="looks"/>' : '<testcase name="looks"><failure/></testcase>') +
          `;process.exit(${ok ? 0 : 1})`,
      ),
      artifacts: ['test-results/shots'],
    });
    assert.equal(evidence.passed, ok, evidence.summary);
    assert.equal(Boolean(failure), !ok);
    const kept = evidence.artifactFiles!;
    assert.deepEqual(
      kept.files.map((f) => f.path),
      ['test-results/shots/s1.png', 'test-results/shots/s2.png'],
    );
    assert.deepEqual(reasons(kept), [
      ['test-results/shots/s0.png', 'file-limit'],
      ['test-results/shots/s3.png', 'total-limit'],
    ]);
  }
});

test('runGate: gate без artifacts — evidence без нового поля', async () => {
  const r = repo();
  const { evidence } = await gate(r.dir, r.head(), {
    command: nodeGate(junit('<testcase name="a"/>')),
  });
  assert.equal(evidence.passed, true, evidence.summary);
  assert.equal('artifactFiles' in evidence, false);
});
