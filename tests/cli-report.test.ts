import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  chmodSync,
  linkSync,
  writeSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_OWNER,
  cliCommands,
  cliDataSchemas,
  cliErrorSchema,
  containsToken,
  reportFileSchema,
  valueReportSchema,
  type RunEventDraft,
} from '../src/contracts/index.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { REPORT_FILE_MODE, writeReportFile } from '../src/control/report-file.ts';
import { HarnessError } from '../src/contracts/index.ts';
import { Harness } from '../src/control/harness.ts';
import { example } from './fixtures.ts';
import { SECRET, reportFixture } from './report-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** Каталог состояния с записями фикстуры отчёта (события — со временем записи). */
function seededState() {
  const parent = mkdtempSync(join(tmpdir(), 'harness-report-'));
  const state = join(parent, 'demo-project');
  mkdirSync(state);
  const input = reportFixture();
  const store = new SqliteExecutionStore(join(state, 'state.sqlite'), 'test');
  try {
    store.transact('graph.registered', (tx) => {
      for (const g of input.graphs ?? []) tx.putGraph(g);
      for (const w of input.works) tx.putWork(w);
      for (const a of input.attempts) tx.putAttempt(a);
      for (const c of input.calls ?? [])
        tx.putLocal('usage', c.repositoryId ?? WORKSPACE_OWNER, c.id, c);
      for (const r of input.reviews ?? []) tx.putLocal('reviews', WORKSPACE_OWNER, r.id, r);
      for (const e of input.events ?? [])
        if (e.type !== 'unknown') {
          // Конверт (apiVersion, seq, at) назначает хранилище при записи.
          const draft: Record<string, unknown> = { ...e };
          for (const key of ['apiVersion', 'seq', 'at']) delete draft[key];
          tx.emit(draft as RunEventDraft);
        }
    });
  } finally {
    store.close();
  }
  return { parent, state, input };
}

/**
 * Каталог состояния целиком: каждый файл (включая служебные `-wal`/`-shm`
 * SQLite) с содержимым. Чтение не должно ни менять файлы, ни создавать новые.
 */
const snapshot = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => join(e.parentPath, e.name))
    .sort()
    .map((p) =>
      statSync(p).isFile()
        ? `${p}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`
        : `${p}:dir`,
    )
    .join('\n');

const run = (args: string[], env: Record<string, string> = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'harness-home-'));
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    cwd: mkdtempSync(join(tmpdir(), 'harness-cwd-')),
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', HOME: home, TSX_DISABLE_CACHE: '1', ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const envelope = (stdout: string) => {
  const json = JSON.parse(stdout) as {
    ok: boolean;
    command: string;
    data?: unknown;
    error?: { code: string };
  };
  if (json.ok) cliDataSchemas.report.parse(json.data);
  else cliErrorSchema.parse(json.error);
  return json;
};

test('report CLI: JSON в конверте по схеме; только чтение — каталог состояния байт в байт прежний', () => {
  const { state, input } = seededState();
  const before = snapshot(state);
  const r = run(['report', '--state', state]);
  assert.equal(r.status, 0, r.stderr);
  const json = envelope(r.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.command, 'report');
  const report = valueReportSchema.parse(json.data);
  assert.equal(report.label, 'demo-project');
  assert.equal(report.speed.finished.accepted, 5);
  assert.equal(report.autonomy.approvals.source, 'events');
  // Пути evidence — относительно каталога состояния: в фикстуре он другой, поэтому только имя.
  assert.ok(!r.stdout.includes(state));
  assert.ok(!r.stdout.includes(SECRET));
  for (const a of input.attempts) assert.equal(containsToken(r.stdout, a.token), false);
  assert.equal(snapshot(state), before, 'report не пишет в каталог состояния');
  assert.equal(cliCommands.report.writes, false);
});

test('report CLI: md и html — текст в stdout без конверта; повтор и часовой пояс дают те же байты', () => {
  const { state } = seededState();
  const md = run(['report', '--state', state, '--format', 'md']);
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /^# Harness report: demo-project\n/);
  assert.match(md.stdout, /## Limits and unknowns/);
  const html = run(['report', '--state', state, '--format', 'html', '--no-titles']);
  assert.equal(html.status, 0, html.stderr);
  assert.match(html.stdout, /^<!doctype html>/);
  assert.ok(!html.stdout.includes('demo-project'), '--no-titles убирает метку проекта');
  assert.ok(!html.stdout.includes('Add the greeting'), '--no-titles убирает заголовки');
  for (const tz of ['UTC', 'Asia/Tokyo']) {
    assert.equal(
      run(['report', '--state', state, '--format', 'md'], { TZ: tz }).stdout,
      md.stdout,
      tz,
    );
    assert.equal(
      run(['report', '--state', state, '--format', 'html', '--no-titles'], { TZ: tz }).stdout,
      html.stdout,
      tz,
    );
  }
  assert.equal(run(['report', '--state', state]).stdout, run(['report', '--state', state]).stdout);
});

test('report CLI: --out пишет файл выбранного формата, в stdout — конверт с путём и размером', () => {
  const { parent, state } = seededState();
  const before = snapshot(state);
  const out = join(parent, 'report.html');
  const r = run(['report', '--state', state, '--format', 'html', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const json = envelope(r.stdout);
  const data = reportFileSchema.parse(json.data);
  const text = readFileSync(out, 'utf8');
  assert.equal(data.format, 'html');
  assert.equal(data.bytes, Buffer.byteLength(text));
  assert.equal(text, run(['report', '--state', state, '--format', 'html']).stdout);
  assert.deepEqual(
    readdirSync(parent).filter((f) => f.endsWith('.tmp')),
    [],
    'временный файл не остаётся',
  );
  // Повтор перезаписывает свой обычный файл.
  assert.equal(run(['report', '--state', state, '--format', 'html', '--out', out]).status, 0);
  const jsonOut = join(parent, 'report.json');
  assert.equal(run(['report', '--state', state, '--out', jsonOut]).status, 0);
  valueReportSchema.parse(JSON.parse(readFileSync(jsonOut, 'utf8')));
  assert.equal(snapshot(state), before);
});

test('report CLI: отказы — нет каталога, неверный формат и окно, --out в symlink и файл состояния, чужие флаги', () => {
  const { parent, state } = seededState();
  const missing = join(parent, 'missing');
  let r = run(['report', '--state', missing]);
  assert.equal(r.status, 3);
  assert.equal(envelope(r.stdout).error?.code, 'NOT_FOUND');
  assert.equal(existsSync(missing), false, 'отсутствующий каталог не создаётся');

  r = run(['report', '--state', state, '--format', 'pdf']);
  assert.equal(r.status, 2);
  assert.equal(envelope(r.stdout).error?.code, 'INVALID_INPUT');

  r = run(['report', '--state', state, '--since', '2026-10-20', '--until', '2026-10-10']);
  assert.equal(r.status, 2);
  assert.equal(envelope(r.stdout).error?.code, 'INVALID_INPUT');

  // Отказ при md — тот же JSON-конверт.
  r = run(['report', '--state', state, '--format', 'md', '--since', 'soon']);
  assert.equal(r.status, 2);
  assert.equal(envelope(r.stdout).ok, false);

  const target = join(parent, 'target.txt');
  writeFileSync(target, 'keep');
  const link = join(parent, 'link.html');
  symlinkSync(target, link);
  r = run(['report', '--state', state, '--format', 'html', '--out', link]);
  assert.equal(r.status, 3);
  assert.equal(envelope(r.stdout).error?.code, 'PATH_CONFLICT');
  assert.equal(readFileSync(target, 'utf8'), 'keep');

  const before = snapshot(state);
  // Жёсткая ссылка на базу состояния вне каталога: отказ, база байт в байт прежняя.
  const hard = join(parent, 'hard.json');
  linkSync(join(state, 'state.sqlite'), hard);
  r = run(['report', '--state', state, '--out', hard]);
  assert.equal(r.status, 3);
  assert.equal(envelope(r.stdout).error?.code, 'PATH_CONFLICT');
  assert.match(r.stdout, /hard-link/);
  // Любой путь внутри каталога состояния, даже новый файл, — отказ.
  r = run(['report', '--state', state, '--format', 'md', '--out', join(state, 'report.md')]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /inside-state/);
  assert.equal(existsSync(join(state, 'report.md')), false);

  r = run(['report', '--state', state, '--out', join(state, 'state.sqlite')]);
  assert.equal(r.status, 3);
  assert.equal(envelope(r.stdout).error?.code, 'PATH_CONFLICT');
  assert.equal(snapshot(state), before);

  r = run([
    'report',
    '--state',
    state,
    '--out',
    join(parent, 'no-such-dir', 'r.md'),
    '--format',
    'md',
  ]);
  assert.equal(r.status, 2);

  r = run(['status', '--state', state, '--format', 'json']);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /--format поддерживают: report/);
});

test('report: Harness.report — тот же отчёт по каталогу состояния, что и CLI', () => {
  const { state } = seededState();
  const cliReport = envelope(run(['report', '--state', state]).stdout).data;
  const h = Harness.open({
    stateDir: state,
    policy: example('policy') as never,
    baseDir: state,
    readOnly: true,
    readOnlyState: true,
  });
  try {
    const report = h.report();
    // Метку проекта задаёт CLI (имя каталога); библиотека её не придумывает.
    assert.deepEqual({ ...report, label: 'demo-project' }, cliReport);
  } finally {
    h.close();
  }
});

test('report: однократное чтение не создаёт файлов; обычное только для чтения — лишь пустые служебные', () => {
  const { state } = seededState();
  const file = join(state, 'state.sqlite');
  const sha = () => createHash('sha256').update(readFileSync(file)).digest('hex');
  const data = sha();
  assert.deepEqual(readdirSync(state).sort(), ['state.sqlite']);
  SqliteExecutionStore.readOnce(file, 'reader', (store) => {
    assert.ok(store.read((v) => v.works()).length > 0);
    assert.ok(store.events(0, 10).length > 0);
  });
  assert.deepEqual(readdirSync(state).sort(), ['state.sqlite']);
  // Долгоживущий дескриптор (status, Harness.open): блокировки SQLite и -wal/-shm без данных.
  const store = new SqliteExecutionStore(file, 'reader', { readOnly: true });
  try {
    assert.ok(store.read((v) => v.works()).length > 0);
  } finally {
    store.close();
  }
  assert.equal(sha(), data);
  const wal = join(state, 'state.sqlite-wal');
  assert.ok(!existsSync(wal) || statSync(wal).size === 0);
});

const lateWork = (input: ReturnType<typeof reportFixture>, id: string) => ({
  ...input.works[0]!,
  id,
});

test('round 2: readOnce — без писателя одно неизменяемое чтение без файлов; писатель начал работу — повтор обычным чтением', () => {
  const { state, input } = seededState();
  const file = join(state, 'state.sqlite');
  let calls = 0;
  const quiet = SqliteExecutionStore.readOnce(file, 'r', (store) => {
    calls += 1;
    return store.read((v) => v.works().length);
  });
  assert.deepEqual([quiet, calls], [input.works.length, 1]);
  assert.deepEqual(readdirSync(state), ['state.sqlite']);

  // Писатель открывает базу и фиксирует запись во время неизменяемого чтения
  // и держит её открытой (есть -wal): чтение повторяется и видит запись.
  let writer: SqliteExecutionStore | undefined;
  calls = 0;
  try {
    const counted = SqliteExecutionStore.readOnce(file, 'r', (store) => {
      calls += 1;
      if (!writer) {
        writer = new SqliteExecutionStore(file, 'writer');
        writer.transact('graph.registered', (tx) => tx.putWork(lateWork(input, 'late-1')));
      }
      return store.read((v) => v.works().length);
    });
    assert.deepEqual([counted, calls], [input.works.length + 1, 2]);
  } finally {
    writer?.close();
  }

  // Писатель зафиксировал и закрылся (журнал снова удалён, основной файл изменён).
  calls = 0;
  const closed = SqliteExecutionStore.readOnce(file, 'r', (store) => {
    calls += 1;
    if (calls === 1) {
      const w = new SqliteExecutionStore(file, 'writer');
      try {
        w.transact('graph.registered', (tx) => tx.putWork(lateWork(input, 'late-2')));
      } finally {
        w.close();
      }
    }
    return store.read((v) => v.works().length);
  });
  assert.deepEqual([closed, calls], [input.works.length + 2, 2]);
});

test('round 2: долгоживущий дескриптор только для чтения видит новые фиксации', () => {
  const { state, input } = seededState();
  const file = join(state, 'state.sqlite');
  const reader = new SqliteExecutionStore(file, 'reader', { readOnly: true });
  const writer = new SqliteExecutionStore(file, 'writer');
  try {
    assert.equal(
      reader.read((v) => v.works().length),
      input.works.length,
    );
    writer.transact('graph.registered', (tx) => tx.putWork(lateWork(input, 'late')));
    assert.equal(
      reader.read((v) => v.works().length),
      input.works.length + 1,
    );
  } finally {
    writer.close();
    reader.close();
  }
});

test('round 2: --out сохраняет права прежнего файла, новый — 0600; неполная запись не оставляет временного файла', () => {
  const { parent, state } = seededState();
  const fresh = join(parent, 'fresh.md');
  writeReportFile(fresh, state, 'one');
  assert.equal(statSync(fresh).mode & 0o777, REPORT_FILE_MODE);
  const shared = join(parent, 'shared.md');
  writeFileSync(shared, 'old');
  chmodSync(shared, 0o640);
  writeReportFile(shared, state, 'two');
  assert.equal(readFileSync(shared, 'utf8'), 'two');
  assert.equal(statSync(shared).mode & 0o777, 0o640);

  assert.throws(
    () =>
      writeReportFile(shared, state, 'three-partial', {
        write(fd, data) {
          writeSync(fd, data, 0, 3);
          throw new Error('disk full');
        },
      }),
    (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
  );
  assert.equal(readFileSync(shared, 'utf8'), 'two');
  assert.deepEqual(
    readdirSync(parent).filter((f) => f.endsWith('.tmp')),
    [],
  );
});
