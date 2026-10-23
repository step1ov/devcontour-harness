import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TransportError } from '../src/integrations/connector/transport.ts';
import { createTransport, type RelayV2CallLog } from '../src/integrations/relay-v2/index.ts';
import { HarnessError } from '../src/contracts/errors.ts';

/**
 * R02: transport tests на поддельном CLI. Поддельный binary — небольшой Node
 * script, эмулирующий договор Relay-2 (`{ok,data}` в stdout, `{ok:false,error}`
 * в stderr с ненулевым exit) и точные отказы. Он не заменяет проверку с
 * настоящим binary (tests/relay-v2-real.test.ts).
 */

const PROJECT = '11111111-2222-3333-4444-555555555555';
const ZERO = '00000000-0000-0000-0000-000000000000';

const FAKE = `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const env = process.env;
const dir = env.FAKE_DIR;
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(env).filter((k) => k.startsWith('RELAY_') || k.startsWith('FAKE_')).sort() }) + '\\n');
const pos = args.filter((a) => !a.startsWith('--'));
const opt = (n) => { const a = args.find((x) => x.startsWith('--' + n + '=')); return a === undefined ? undefined : a.slice(n.length + 3); };
const cmd = pos.slice(0, 3).join(' ');
const mode = env.FAKE_MODE || 'ok';
const ok = (data, meta) => { process.stdout.write(JSON.stringify(meta ? { ok: true, data, meta } : { ok: true, data }) + '\\n'); process.exit(0); };
const err = (exit, code, message, details) => { process.stderr.write(JSON.stringify({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) + '\\n'); process.exit(exit); };
const task = (over = {}) => ({ id: 'aaaaaaaa-0000-0000-0000-000000000001', kind: 'task', key: 'PRODUCT-2', revision: 3,
  data: { title: 'Main', description: 'd', column: 'inbox', parentId: null, dependencies: [], acceptanceCriteria: [], comments: [], ...over } });
const page = (items, nextCursor = null) => ok({ items }, { page: { count: items.length, total: items.length, limit: 100, nextCursor, nextCommand: nextCursor ? 'relay task children --cursor=' + nextCursor + ' ; touch ' + dir + '/nextCommand-executed' : null, consistency: 'snapshot' } });
const hang = () => {
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(dir + '/pids', JSON.stringify([process.pid, g.pid]));
  setInterval(() => {}, 1000);
};
if (args.includes(${JSON.stringify(ZERO)}) || args.includes('--target=${ZERO}')) {
  if (env.FAKE_NO_HISTORY && (pos[0] === 'session' || pos[0] === 'checkpoint')) err(2, 'INVALID_ARGUMENT', 'Неизвестная команда: «' + pos[1] + '»');
  err(3, 'NOT_FOUND', 'Запись не найдена.', { ref: ${JSON.stringify(ZERO)} });
}
switch (cmd.startsWith('task comment') || cmd.startsWith('task criterion') ? cmd : pos.slice(0, 2).join(' ')) {
  case 'storage status': {
    const n = Number(fs.existsSync(dir + '/status') ? fs.readFileSync(dir + '/status', 'utf8') : '0');
    fs.writeFileSync(dir + '/status', String(n + 1));
    const pid = env.FAKE_SWITCH_AFTER && n >= Number(env.FAKE_SWITCH_AFTER) ? 'ffffffff-0000-0000-0000-000000000000' : env.FAKE_PROJECT;
    ok({ projectId: pid, databasePath: dir + '/db.sqlite', bytes: 1, generation: 7, records: 3 });
  }
  case 'project get': ok({ id: env.FAKE_PROJECT, kind: 'project', key: 'PROJECT', revision: 1, data: { name: 'Fake', slug: 'fake' } });
  case 'doctor check': ok({ projectId: env.FAKE_PROJECT, generation: 7, valid: true, records: 3, issues: [] });
  case 'task get':
    if (mode === 'error') err(3, 'NOT_FOUND', 'Запись не найдена.', { ref: pos[2], kind: 'task' });
    if (mode === 'invalid-json') { process.stdout.write('{"ok":true,"data":\\n'); process.exit(0); }
    if (mode === 'two-lines') { process.stdout.write('{"ok":true,"data":1}\\n{"ok":true,"data":2}\\n'); process.exit(0); }
    if (mode === 'oversized') { try { fs.writeSync(1, 'x'.repeat(4 * 1024 * 1024)); } catch {} process.exit(0); }
    if (mode === 'no-envelope') { process.stdout.write(JSON.stringify({ data: task() }) + '\\n'); process.exit(0); }
    if (mode === 'bad-shape') ok({ id: 'x', kind: 'task', key: 'PRODUCT-2', revision: 'three', data: {} });
    if (mode === 'ok-false-exit0') { process.stdout.write(JSON.stringify({ ok: false, error: { code: 'X', message: 'm' } }) + '\\n'); process.exit(0); }
    if (mode === 'text-error') { process.stderr.write('Ошибка: STORAGE_ERROR: boom\\n'); process.exit(1); }
    if (mode === 'storage-error') err(1, 'STORAGE_ERROR', 'Ошибка локальной базы данных.', { reason: 'near "ORDER": syntax error' });
    if (mode === 'sleep') hang();
    else ok(task());
    break;
  case 'task children': {
    const cursor = opt('cursor');
    if (!cursor) { if (opt('limit') !== '100') err(2, 'INVALID_ARGUMENT', 'limit'); page([task({ title: 'c1' })], 'CUR1'); }
    const n = Number(fs.existsSync(dir + '/snap') ? fs.readFileSync(dir + '/snap', 'utf8') : '0');
    fs.writeFileSync(dir + '/snap', String(n + 1));
    if (n < Number(env.FAKE_SNAPSHOT_CONFLICTS || 0)) err(4, 'SNAPSHOT_CONFLICT', 'Данные изменились. Начните список заново без --cursor');
    if (opt('limit')) err(2, 'INVALID_CURSOR', 'limit must not change');
    page([task({ title: 'c2' })]);
  }
  case 'task progress': ok({ completed: false, canComplete: false, blockers: [] });
  case 'document list': page([]);
  case 'task comment add':
    fs.writeFileSync(dir + '/comment-args.json', JSON.stringify(args));
    if (mode === 'sleep') hang();
    else ok(task({ comments: [{ id: 'cm-1', title: opt('title') || '', body: opt('body'), createdAt: 't', createdBy: opt('actor') }] }));
    break;
  case 'task move':
    if (mode === 'conflict') err(4, 'REVISION_CONFLICT', 'Задача изменена: перечитайте её перед записью', { id: 'x', expectedRevision: Number(opt('if-revision')), actualRevision: 7 });
    if (mode === 'incomplete') err(2, 'TASK_INCOMPLETE', 'Завершение требует выполнения критериев, детей и зависимостей', { blockers: ['b'] });
    if (mode === 'busy') err(4, 'STORAGE_BUSY', 'busy');
    if (mode === 'sleep') hang();
    else if (mode === 'oversized') { try { fs.writeSync(1, 'x'.repeat(4 * 1024 * 1024)); } catch {} process.exit(0); }
    else if (mode === 'internal') err(1, 'INTERNAL_ERROR', 'boom');
    else ok(task({ column: opt('column') }));
    break;
  default:
    err(2, 'INVALID_ARGUMENT', 'Неизвестная команда: «' + cmd + '»');
}
`;

interface Fake {
  dir: string;
  bin: string;
  calls(): { args: string[]; cwd: string; env: string[] }[];
  cleanup(): void;
}

function fakeCli(): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'relay-v2-fake-'));
  const bin = join(dir, 'relay');
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  return {
    dir,
    bin,
    calls: () =>
      existsSync(join(dir, 'calls.jsonl'))
        ? readFileSync(join(dir, 'calls.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as { args: string[]; cwd: string; env: string[] })
        : [],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function transport(
  fake: Fake,
  env: Record<string, string> = {},
  extra: { timeoutMs?: number; maxOutputBytes?: number; projectId?: string; project?: string } = {},
  log?: RelayV2CallLog[],
) {
  return createTransport(
    {
      binary: fake.bin,
      config: join(fake.dir, 'relay.config.json'),
      projectId: extra.projectId ?? PROJECT,
      actor: 'harness-agent',
      env: {
        RELAY_HOME: join(fake.dir, 'home'),
        FAKE_DIR: fake.dir,
        FAKE_PROJECT: PROJECT,
        ...env,
      },
      ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
      ...(extra.maxOutputBytes ? { maxOutputBytes: extra.maxOutputBytes } : {}),
      ...(extra.project ? { project: extra.project } : {}),
    },
    { cwd: fake.dir, killGraceMs: 200, ...(log ? { onCall: (c) => log.push(c) } : {}) },
  );
}

async function rejects(
  promise: Promise<unknown>,
  expect: Partial<{ kind: string; code: string; mutation: boolean; actualRevision: number }>,
) {
  const error = await promise.then(
    () => assert.fail('ожидался отказ'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof TransportError, `TransportError, а не ${String(error)}`);
  if (expect.kind) assert.equal(error.kind, expect.kind, error.message);
  if (expect.code) assert.equal(error.details.code, expect.code, error.message);
  if (expect.mutation !== undefined) assert.equal(error.details.mutation, expect.mutation);
  if (expect.actualRevision !== undefined)
    assert.equal(error.details.actualRevision, expect.actualRevision);
  assert.equal(error.details.provider, 'relay-v2-cli');
  assert.equal(error.details.projectId, PROJECT);
  assert.match(error.message, new RegExp(`relay-v2 ${error.operation.replace('.', '\\.')}`));
  return error;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('R02/transport: настройки — абсолютные пути, RELAY_CONFIG/RELAY_ACTOR в env запрещены', () => {
  const base = {
    binary: '/x/relay',
    config: '/x/relay.config.json',
    projectId: PROJECT,
    actor: 'a',
  };
  assert.doesNotThrow(() => createTransport(base));
  for (const bad of [
    { ...base, binary: 'relay' },
    { ...base, config: 'relay.config.json' },
    { ...base, env: { RELAY_CONFIG: '/other.json' } },
    { ...base, env: { RELAY_ACTOR: 'other' } },
    { ...base, unknown: 1 },
  ])
    assert.throws(
      () => createTransport(bad as never),
      (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
    );
});

test('R02/transport: success JSON stdout разбирается; каждый вызов несёт --config/--format/--project, --actor только на записи; окружение минимальное', async () => {
  const fake = fakeCli();
  const saved = {
    c: process.env.RELAY_CONFIG,
    a: process.env.RELAY_ACTOR,
    u: process.env.RELAY_USER_NAME,
  };
  process.env.RELAY_CONFIG = '/evil/relay.config.json';
  process.env.RELAY_ACTOR = 'evil';
  process.env.RELAY_USER_NAME = 'evil';
  try {
    const t = transport(fake, {}, { project: 'main' });
    const id = await t.identity();
    assert.equal(id.provider, 'relay-v2-cli');
    assert.equal(id.projectId, PROJECT);
    assert.ok(id.capabilities.includes('relay-2.history.session'));
    assert.ok(id.capabilities.includes('relay-2.task.progress'));
    assert.equal(id.build.sha256Verified, 'false');
    assert.match(id.build.sha256 ?? '', /^[0-9a-f]{64}$/);
    const read = await t.readTask('PRODUCT-2');
    assert.equal(read.task.key, 'PRODUCT-2');
    assert.equal(read.task.revision, 3);
    assert.deepEqual(read.consistency, { before: '7', after: '7' });
    const moved = await t.move('PRODUCT-2', { column: 'in-progress', ifRevision: 3 });
    assert.equal(moved.revision, 3);
    const comment = await t.addComment('PRODUCT-2', { title: 't', body: 'b' });
    assert.equal(comment.commentId, 'cm-1');
    for (const call of fake.calls()) {
      assert.ok(
        call.args.includes(`--config=${join(fake.dir, 'relay.config.json')}`),
        call.args.join(' '),
      );
      assert.ok(call.args.includes('--format=json'));
      assert.ok(call.args.includes('--project=main'));
      assert.deepEqual(
        call.env,
        ['FAKE_DIR', 'FAKE_PROJECT', 'RELAY_HOME'],
        'унаследованные RELAY_* не переданы',
      );
      const write = ['move', 'add'].includes(
        call.args[1] === 'comment' ? call.args[2]! : call.args[1]!,
      );
      assert.equal(
        call.args.some((a) => a.startsWith('--actor=')),
        write,
        call.args.join(' '),
      );
      if (write) assert.ok(call.args.includes('--actor=harness-agent'));
    }
    const move = fake.calls().find((c) => c.args[1] === 'move')!;
    assert.ok(move.args.includes('--if-revision=3'));
    const add = fake.calls().find((c) => c.args[2] === 'add')!;
    assert.ok(
      !add.args.some((a) => a.startsWith('--if-revision')),
      'create-mode без --if-revision',
    );
  } finally {
    process.env.RELAY_CONFIG = saved.c;
    process.env.RELAY_ACTOR = saved.a;
    process.env.RELAY_USER_NAME = saved.u;
    if (saved.c === undefined) delete process.env.RELAY_CONFIG;
    if (saved.a === undefined) delete process.env.RELAY_ACTOR;
    if (saved.u === undefined) delete process.env.RELAY_USER_NAME;
    fake.cleanup();
  }
});

test('R02/transport: аргумент с пробелами, кавычками и символами shell доходит дословно, без shell expansion', async () => {
  const fake = fakeCli();
  try {
    const t = transport(fake);
    const pwned = join(fake.dir, 'pwned');
    const body = `a b  $(touch ${pwned}) \`touch ${pwned}\` ; rm -rf ${fake.dir} && echo "q'uote" | cat > ${pwned} $HOME *\n--not-a-flag`;
    const title = `--title=x; touch ${pwned}`;
    await t.addComment('PRODUCT-2', { title, body });
    const args = JSON.parse(readFileSync(join(fake.dir, 'comment-args.json'), 'utf8')) as string[];
    assert.ok(args.includes(`--body=${body}`));
    assert.ok(args.includes(`--title=${title}`));
    assert.equal(existsSync(pwned), false, 'shell не выполнялся');
    assert.ok(existsSync(fake.dir));
    // Ref, который мог бы стать флагом, отклоняется до запуска процесса.
    const before = fake.calls().length;
    await rejects(t.readTask('--config=/etc/other.json'), { kind: 'refused', code: 'INVALID_REF' });
    await rejects(t.move('PRODUCT-2; rm -rf /', { column: 'done', ifRevision: 1 }), {
      kind: 'refused',
      code: 'INVALID_REF',
    });
    assert.equal(fake.calls().length, before);
  } finally {
    fake.cleanup();
  }
});

test('R02/transport: error JSON stderr + ненулевой exit → класс по коду; exit — только грубый класс', async () => {
  const fake = fakeCli();
  try {
    await rejects(transport(fake, { FAKE_MODE: 'error' }).readTask('PRODUCT-9'), {
      kind: 'not-found',
      code: 'NOT_FOUND',
      mutation: false,
    });
    await rejects(
      transport(fake, { FAKE_MODE: 'conflict' }).move('PRODUCT-2', {
        column: 'done',
        ifRevision: 3,
      }),
      {
        kind: 'conflict',
        code: 'REVISION_CONFLICT',
        actualRevision: 7,
        mutation: true,
      },
    );
    await rejects(
      transport(fake, { FAKE_MODE: 'incomplete' }).move('PRODUCT-2', {
        column: 'done',
        ifRevision: 3,
      }),
      {
        kind: 'refused',
        code: 'TASK_INCOMPLETE',
      },
    );
    await rejects(
      transport(fake, { FAKE_MODE: 'busy' }).move('PRODUCT-2', { column: 'done', ifRevision: 3 }),
      {
        kind: 'conflict',
        code: 'STORAGE_BUSY',
      },
    );
    // exit 1 (сбой backend): чтение — unavailable, мутация — uncertain.
    await rejects(transport(fake, { FAKE_MODE: 'storage-error' }).readTask('PRODUCT-2'), {
      kind: 'unavailable',
      code: 'STORAGE_ERROR',
    });
    await rejects(
      transport(fake, { FAKE_MODE: 'internal' }).move('PRODUCT-2', {
        column: 'done',
        ifRevision: 3,
      }),
      {
        kind: 'uncertain',
        code: 'INTERNAL_ERROR',
        mutation: true,
      },
    );
  } finally {
    fake.cleanup();
  }
});

test('R02/transport: невалидный JSON, две строки, чужой envelope, неверная форма, ok:false при exit 0, текстовая ошибка → protocol, не пустой success', async () => {
  const fake = fakeCli();
  try {
    for (const mode of [
      'invalid-json',
      'two-lines',
      'no-envelope',
      'bad-shape',
      'ok-false-exit0',
      'text-error',
    ])
      await rejects(transport(fake, { FAKE_MODE: mode }).readTask('PRODUCT-2'), {
        kind: 'protocol',
        mutation: false,
      });
  } finally {
    fake.cleanup();
  }
});

test('R02/transport: вывод больше лимита → protocol (для мутации — флаг mutation), процесс остановлен', async () => {
  const fake = fakeCli();
  try {
    const opts = { maxOutputBytes: 64 * 1024 };
    // Положительный контроль: тот же лимит пропускает обычный ответ.
    await transport(fake, {}, opts).readTask('PRODUCT-2');
    const e = await rejects(
      transport(fake, { FAKE_MODE: 'oversized' }, opts).readTask('PRODUCT-2'),
      { kind: 'protocol', mutation: false },
    );
    assert.match(e.message, /65536/);
    await rejects(
      transport(fake, { FAKE_MODE: 'oversized' }, opts).move('PRODUCT-2', {
        column: 'done',
        ifRevision: 3,
      }),
      {
        kind: 'protocol',
        mutation: true,
      },
    );
  } finally {
    fake.cleanup();
  }
});

test('R02/transport: таймаут убивает группу процессов; чтение → unavailable, мутация → uncertain; зомби и внуков нет', async () => {
  const fake = fakeCli();
  try {
    const t0 = Date.now();
    await rejects(
      transport(fake, { FAKE_MODE: 'sleep' }, { timeoutMs: 5000 }).readTask('PRODUCT-2'),
      { kind: 'unavailable', mutation: false },
    );
    assert.ok(Date.now() - t0 < 12000, 'длительность ограничена');
    let pids = JSON.parse(readFileSync(join(fake.dir, 'pids'), 'utf8')) as number[];
    await sleep(100);
    for (const pid of pids) assert.equal(alive(pid), false, `процесс ${pid} завершён и собран`);

    rmSync(join(fake.dir, 'pids'));
    await rejects(
      transport(fake, { FAKE_MODE: 'sleep' }, { timeoutMs: 5000 }).move('PRODUCT-2', {
        column: 'done',
        ifRevision: 3,
      }),
      {
        kind: 'uncertain',
        mutation: true,
      },
    );
    pids = JSON.parse(readFileSync(join(fake.dir, 'pids'), 'utf8')) as number[];
    await sleep(100);
    for (const pid of pids) assert.equal(alive(pid), false, `процесс ${pid} завершён и собран`);
  } finally {
    fake.cleanup();
  }
});

test('R02/transport: отмена после запуска мутации → uncertain, дерево процессов остановлено; отмена до запуска → unavailable без процесса', async () => {
  const fake = fakeCli();
  try {
    const t = transport(fake, { FAKE_MODE: 'sleep' }, { timeoutMs: 60_000 });
    await t.identity();
    const controller = new AbortController();
    const pending = t.addComment('PRODUCT-2', { title: '', body: 'x' }, controller.signal);
    const pidsFile = join(fake.dir, 'pids');
    for (let i = 0; i < 100 && !existsSync(pidsFile); i++) await sleep(50);
    const pids = JSON.parse(readFileSync(pidsFile, 'utf8')) as number[];
    assert.ok(pids.every(alive), 'процессы запущены до отмены');
    const t0 = Date.now();
    controller.abort();
    await rejects(pending, { kind: 'uncertain', mutation: true });
    assert.ok(Date.now() - t0 < 3000);
    await sleep(100);
    for (const pid of pids) assert.equal(alive(pid), false, `процесс ${pid} не завис после отмены`);

    const before = fake.calls().length;
    const aborted = new AbortController();
    aborted.abort();
    await rejects(t.move('PRODUCT-2', { column: 'done', ifRevision: 3 }, aborted.signal), {
      kind: 'unavailable',
    });
    assert.equal(fake.calls().length, before, 'процесс не запускался');
  } finally {
    fake.cleanup();
  }
});

test('R02/transport: отсутствующий binary → unavailable, мутация не отправлена', async () => {
  const fake = fakeCli();
  try {
    const t = createTransport({
      binary: join(fake.dir, 'no-such-relay'),
      config: join(fake.dir, 'relay.config.json'),
      projectId: PROJECT,
      actor: 'a',
    });
    await rejects(t.identity(), { kind: 'unavailable' });
    await rejects(t.move('PRODUCT-2', { column: 'done', ifRevision: 1 }), { kind: 'unavailable' });
    await rejects(t.readTask('PRODUCT-2'), { kind: 'unavailable' });
  } finally {
    fake.cleanup();
  }
});

test('R02/transport: binary, который не выполняется (нет прав) → unavailable', async () => {
  const fake = fakeCli();
  try {
    chmodSync(fake.bin, 0o644);
    const e = await rejects(transport(fake).readTask('PRODUCT-2'), { kind: 'unavailable' });
    assert.match(e.message, /EACCES|binary/);
  } finally {
    fake.cleanup();
  }
});

test('R02/transport: идентичность — несовпадение sha256 сборки и projectId блокирует мутации до запуска записи', async () => {
  const fake = fakeCli();
  try {
    const badBuild = createTransport({
      binary: fake.bin,
      config: join(fake.dir, 'relay.config.json'),
      projectId: PROJECT,
      actor: 'a',
      env: { FAKE_DIR: fake.dir, FAKE_PROJECT: PROJECT },
      build: { sha256: 'f'.repeat(64), commit: 'a3ee804' },
    });
    await rejects(badBuild.identity(), { kind: 'unsupported', code: 'BUILD_MISMATCH' });
    await rejects(badBuild.move('PRODUCT-2', { column: 'done', ifRevision: 1 }), {
      code: 'BUILD_MISMATCH',
    });
    assert.equal(fake.calls().filter((c) => c.args[1] === 'move').length, 0);

    const wrong = transport(fake, {}, { projectId: '99999999-0000-0000-0000-000000000000' });
    const e = await wrong.identity().catch((x: unknown) => x as TransportError);
    assert.ok(
      e instanceof TransportError &&
        e.kind === 'refused' &&
        e.details.code === 'PROJECT_ID_MISMATCH',
    );
    await wrong.move('PRODUCT-2', { column: 'done', ifRevision: 1 }).catch(() => undefined);
    await wrong.readTask('PRODUCT-2').catch(() => undefined);
    assert.equal(
      fake.calls().filter((c) => ['move', 'get'].includes(c.args[1]!) && c.args[0] === 'task')
        .length,
      0,
      'ни чтения, ни записи чужого проекта',
    );

    // projectId хранилища сменился после проверки (config подменён): мутация не уходит.
    rmSync(join(fake.dir, 'calls.jsonl'));
    const switched = transport(fake, { FAKE_SWITCH_AFTER: '1' });
    rmSync(join(fake.dir, 'status'), { force: true });
    await switched.identity();
    await rejects(switched.move('PRODUCT-2', { column: 'done', ifRevision: 1 }), {
      kind: 'refused',
      code: 'PROJECT_ID_MISMATCH',
      mutation: true,
    });
    assert.equal(fake.calls().filter((c) => c.args[1] === 'move').length, 0);
  } finally {
    fake.cleanup();
  }
});

test('R02/transport: capability probes — отсутствие команд истории → unsupported без запуска мутации', async () => {
  const fake = fakeCli();
  try {
    const t = transport(fake, { FAKE_NO_HISTORY: '1' });
    const id = await t.identity();
    assert.ok(!id.capabilities.includes('relay-2.history.session'));
    assert.ok(id.capabilities.includes('relay-2.task.read'));
    await rejects(t.startSession({ title: 't', description: '', client: 'harness' }), {
      kind: 'unsupported',
    });
    assert.equal(
      fake.calls().filter((c) => c.args[0] === 'session' && c.args[1] === 'start').length,
      0,
    );
  } finally {
    fake.cleanup();
  }
});

test('R02/transport: pagination — cursor из meta.page.nextCursor, nextCommand не исполняется; SNAPSHOT_CONFLICT → перезапуск, исчерпание → conflict без частичного списка', async () => {
  const fake = fakeCli();
  try {
    const log: RelayV2CallLog[] = [];
    const read = await transport(fake, {}, {}, log).readTask('PRODUCT-2');
    assert.deepEqual(
      read.children.map((c) => c.title),
      ['c1', 'c2'],
    );
    assert.equal(existsSync(join(fake.dir, 'nextCommand-executed')), false);
    assert.ok(
      log.some((c) => c.argv.includes('--cursor=<cursor>')),
      'cursor маскирован в журнале',
    );

    rmSync(join(fake.dir, 'snap'), { force: true });
    const again = await transport(fake, { FAKE_SNAPSHOT_CONFLICTS: '2' }).readTask('PRODUCT-2');
    assert.deepEqual(
      again.children.map((c) => c.title),
      ['c1', 'c2'],
      'после перезапуска — полный список без дублей',
    );

    rmSync(join(fake.dir, 'snap'), { force: true });
    await rejects(transport(fake, { FAKE_SNAPSHOT_CONFLICTS: '100' }).readTask('PRODUCT-2'), {
      kind: 'conflict',
      code: 'SNAPSHOT_CONFLICT',
    });
  } finally {
    fake.cleanup();
  }
});

test('R02/transport: адаптер не открывает SQLite получателя и не импортирует Bun/@relay core — только subprocess', () => {
  const dir = join(import.meta.dirname, '..', 'src', 'integrations', 'relay-v2');
  for (const name of ['index.ts', 'process.ts', 'protocol.ts']) {
    const source = readFileSync(join(dir, name), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    for (const spec of imports)
      assert.ok(
        ['node:child_process', 'node:crypto', 'node:fs', 'node:path', 'zod'].includes(spec) ||
          spec.startsWith('.'),
        `${name}: недопустимый импорт ${spec}`,
      );
    assert.doesNotMatch(source, /\b(require|import)\s*\(/, 'нет динамических импортов');
  }
});
