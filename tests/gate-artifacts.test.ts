import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
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
  return { root, dest: join(temp('harness-ga-out-'), 'unit.artifacts') };
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
    // Повтор и путь внутри объявленного каталога объединяются: копия одна.
    paths: ['shots/', 'results', 'shots', 'shots/a.png', 'missing/dir'],
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

test('gate artifacts: секрет — в тексте маскируется, двоичный файл и имя с секретом не копируются', async () => {
  const secret = 'synthetic-artifact-secret-4417';
  const { root, dest } = tree({
    'out/trace.json': `{"token":"${secret}"}`,
    'out/shot.png': Buffer.concat([Buffer.from([0x89, 0x50]), Buffer.from(secret)]),
    'out/wide.png': Buffer.from(secret, 'utf16le'),
    // Форма секрета в JSON-экранировании тоже секрет.
    'out/quoted.png': JSON.stringify(secret + '"').slice(1, -1),
    [`out/${secret}.txt`]: 'plain',
    'out/clean.png': 'no secret here',
  });
  const kept = await keepGateArtifacts({
    root,
    paths: ['out'],
    dest,
    redact: redactor([secret, secret + '"']),
  });
  const trace = kept.files.find((f) => f.path === 'out/trace.json')!;
  assert.equal(trace.redacted, true);
  assert.ok(!readFileSync(join(dest, 'out/trace.json'), 'utf8').includes(secret));
  // Изображение не переписывается маской: файл с секретом не копируется вовсе.
  assert.deepEqual(
    kept.files.map((f) => f.path),
    ['out/clean.png', 'out/trace.json'],
  );
  assert.deepEqual(reasons(kept), [
    ['out/quoted.png', 'secret'],
    ['out/shot.png', 'secret'],
    ['out/[REDACTED].txt', 'secret'],
    ['out/wide.png', 'secret'],
  ]);
  for (const name of ['shot.png', 'wide.png', 'quoted.png', `${secret}.txt`])
    assert.ok(!existsSync(join(dest, 'out', name)), name);
  assertCopies(kept);
  // Redactor без списка форм: проверка его же маской по байтам.
  const plain = await keepGateArtifacts({
    root,
    paths: ['out/shot.png', 'out/clean.png'],
    dest,
    redact: (v) => v.split(secret).join('***'),
  });
  assert.deepEqual(reasons(plain), [['out/shot.png', 'secret']]);
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
    paths: ['shots', 'escape/secret.png', 'direct.png'],
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
    ['direct.png', 'symlink'],
  ]);
  const itself = await keepGateArtifacts({ root, paths: ['escape'], dest, redact: (v) => v });
  assert.deepEqual(reasons(itself), [['escape', 'symlink']]);
  assert.ok(!existsSync(join(dest, 'escape')) && !existsSync(join(dest, 'direct.png')));
  assert.equal(readFileSync(join(outside, 'secret.png'), 'utf8'), 'outside', 'источник цел');
});

test('gate artifacts: жёсткая ссылка на файл вне дерева не копируется', async () => {
  const outside = temp('harness-ga-outside-');
  writeFileSync(join(outside, 'secret.png'), 'outside');
  const { root, dest } = tree({ 'shots/ok.png': 'ok' });
  linkSync(join(outside, 'secret.png'), join(root, 'shots', 'linked.png'));
  const kept = await keepGateArtifacts({ root, paths: ['shots'], dest, redact: (v) => v });
  assert.deepEqual(
    kept.files.map((f) => f.path),
    ['shots/ok.png'],
  );
  assert.deepEqual(reasons(kept), [['shots/linked.png', 'hardlink']]);
  assert.ok(!existsSync(join(dest, 'shots', 'linked.png')));
});

test('gate artifacts: каталог, подменённый ссылкой наружу после обхода, не копируется', async () => {
  const outside = temp('harness-ga-outside-');
  writeFileSync(join(outside, 'a.png'), 'outside');
  const { root, dest } = tree({ 'shots/a.png': 'inside' });
  const kept = await keepGateArtifacts({
    root,
    paths: ['shots'],
    dest,
    redact: (v) => v,
    // Каталог уже прочитан; перед файлом он становится ссылкой на чужой каталог.
    beforeVisit: (rel) => {
      if (rel !== 'shots/a.png') return;
      renameSync(join(root, 'shots'), join(root, 'shots-moved'));
      symlinkSync(outside, join(root, 'shots'));
    },
  });
  assert.deepEqual(kept.files, []);
  assert.deepEqual(reasons(kept), [['shots/a.png', 'outside']]);
  assert.ok(!existsSync(join(dest, 'shots', 'a.png')));
});

test('gate artifacts: отмена проверки останавливает копирование и записана', async () => {
  const { root, dest } = tree({ 'a.png': 'a', 'b.png': 'b' });
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'previous.png'), 'p');
  const controller = new AbortController();
  controller.abort();
  const kept = await keepGateArtifacts({
    root,
    paths: ['a.png', 'b.png'],
    dest,
    redact: (v) => v,
    signal: controller.signal,
  });
  assert.deepEqual(kept.files, []);
  assert.deepEqual(
    kept.skipped.map((s) => [s.path, s.reason, s.detail]),
    [
      ['a.png', 'copy-failed', 'проверка отменена'],
      ['b.png', 'copy-failed', 'проверка отменена'],
    ],
  );
  assert.equal(kept.dir, dest);
  assert.ok(existsSync(join(dest, 'previous.png')), 'отменённый запуск ничего не удаляет');
});

test('gate artifacts: текст в UTF-16 с секретом не копируется; маска UTF-8 идёт по байтам', async () => {
  const secret = 'synthetic-artifact-secret-9021';
  const raw = Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x41]),
    Buffer.from(secret),
    Buffer.from([0x80]),
  ]);
  const { root, dest } = tree({
    'out/wide.txt': Buffer.from(`token=${secret}`, 'utf16le'),
    'out/raw.log': raw,
  });
  const kept = await keepGateArtifacts({ root, paths: ['out'], dest, redact: redactor([secret]) });
  assert.deepEqual(reasons(kept), [['out/wide.txt', 'secret']]);
  assert.ok(!existsSync(join(dest, 'out', 'wide.txt')));
  // Невалидный UTF-8 вокруг секрета сохраняется байт в байт.
  assert.deepEqual(
    readFileSync(join(dest, 'out', 'raw.log')),
    Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x41]),
      Buffer.from('[REDACTED]'),
      Buffer.from([0x80]),
    ]),
  );
  assert.equal(kept.files[0]!.redacted, true);
  assertCopies(kept);
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
  // Каталог читается только до предела обхода; остановка названа.
  const scan = await keepGateArtifacts({
    root,
    paths: ['big', 'big/a.png', 'later.png'],
    dest,
    redact: (v) => v,
    limits: { scan: 3 },
  });
  assert.equal(scan.files.length, 3);
  assert.deepEqual(reasons(scan), [
    ['big', 'scan-limit'],
    ['later.png', 'scan-limit'],
  ]);
  // Список пропусков ограничен, остаток посчитан.
  const many = tree(Object.fromEntries([1, 2, 3, 4].map((i) => [`x/p${i}.html`, 'x'])));
  const listed = await keepGateArtifacts({
    root: many.root,
    paths: ['x'],
    dest: many.dest,
    redact: (v) => v,
    limits: { skipped: 2 },
  });
  assert.deepEqual(reasons(listed), [
    ['x/p1.html', 'extension'],
    ['x/p2.html', 'extension'],
  ]);
  assert.equal(listed.skippedMore, 2);
});

test('gate artifacts: каталог копий, совпадающий с деревом, не удаляется — отказ записан', async () => {
  const { root } = tree({ 'a.png': 'a' });
  const kept = await keepGateArtifacts({ root, paths: ['a.png'], dest: root, redact: (v) => v });
  assert.deepEqual(kept.files, []);
  assert.deepEqual(reasons(kept), [['a.png', 'copy-failed']]);
  assert.equal(readFileSync(join(root, 'a.png'), 'utf8'), 'a', 'дерево цело');
});

test('gate artifacts: ограждение удаления сравнивает реальные пути (/var и /private/var)', async () => {
  // Путь mkdtemp не разрешён: на macOS он начинается с /var, реальный — с /private/var.
  // Предок дерева — собственный каталог теста: ошибка ограждения не задела бы чужое.
  const outer = mkdtempSync(join(tmpdir(), 'harness-ga-raw-'));
  const raw = join(outer, 'tree');
  mkdirSync(raw);
  writeFileSync(join(raw, 'a.png'), 'a');
  mkdirSync(join(raw, 'inner'));
  writeFileSync(join(raw, 'inner', 'keep.png'), 'k');
  const root = realpathSync(raw);
  for (const dest of [raw, outer, join(raw, 'inner'), join(raw, 'new.artifacts')]) {
    for (const base of [root, raw]) {
      const kept = await keepGateArtifacts({
        root: base,
        paths: ['a.png'],
        dest,
        redact: (v) => v,
      });
      assert.deepEqual(reasons(kept), [['a.png', 'copy-failed']], `${base} → ${dest}`);
      // `dir` — реальный путь и при отказе ограждения.
      assert.equal(
        kept.dir,
        existsSync(dest) ? realpathSync(dest) : join(root, 'new.artifacts'),
        dest,
      );
    }
    assert.equal(readFileSync(join(root, 'a.png'), 'utf8'), 'a', dest);
    assert.equal(readFileSync(join(root, 'inner', 'keep.png'), 'utf8'), 'k', dest);
  }
  assert.ok(!existsSync(join(root, 'new.artifacts')), 'внутри дерева ничего не создано');
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
async function gate(
  dir: string,
  sha: string,
  g: Partial<GatePolicy> & { command: string[] },
  signal = new AbortController().signal,
) {
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
      signal,
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
  assert.equal(kept.dir, join(artifactDir, 'visual.artifacts'));
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

test('runGate: отмена запуска доходит до копирования artifacts', async () => {
  const r = repo({ '.gitignore': 'test-results/\n' });
  mkdirSync(join(r.dir, 'test-results', 'shots'), { recursive: true });
  writeFileSync(join(r.dir, 'test-results', 'shots', 'a.png'), 'png');
  const controller = new AbortController();
  controller.abort();
  const { evidence } = await gate(
    r.dir,
    r.head(),
    { command: nodeGate(junit('<testcase name="a"/>')), artifacts: ['test-results/shots'] },
    controller.signal,
  );
  assert.equal(evidence.passed, false);
  assert.deepEqual(evidence.artifactFiles!.files, []);
  assert.deepEqual(
    evidence.artifactFiles!.skipped.map((s) => [s.path, s.reason, s.detail]),
    [['test-results/shots', 'copy-failed', 'проверка отменена']],
  );
});
