#!/usr/bin/env node
/**
 * Изолированные проекты настоящего Relay-2 CLI для R02/R03/R04/W01/D02.
 *
 * Binary: `--bin <path>` или `HARNESS_RELAY2_BIN`; по умолчанию — сборка
 * относительно корня harness (`.private/integration-upgrade/tools/relay-2-build/apps/cli/dist/relay`).
 * Сборка: клон relay-2 на commit a3ee804, `bun install --frozen-lockfile`,
 * `bun run build:cli` (Bun 1.4.3); Bun во время работы не нужен.
 *
 * Каждый проект — временный каталог вне Git: `RELAY_HOME=<tmp>/home`,
 * `relay init --config <tmp>/relay.config.json`. `~/.relay` не используется;
 * унаследованные RELAY_* не передаются. На macOS bun:sqlite берёт системный
 * SQLite 3.43, а Relay-2 требует >= 3.44: каталог новой libsqlite3 задаётся
 * `HARNESS_RELAY2_SQLITE_LIB` или находится в Homebrew и передаётся как
 * `DYLD_LIBRARY_PATH` — только через явный `env` транспорта.
 *
 * CLI:
 *   node scripts/acceptance/relay-v2-fixture.mjs info              # binary/sha256/commit (JSON)
 *   node scripts/acceptance/relay-v2-fixture.mjs smoke [--second]  # создать, засеять, проверить, удалить
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RELAY_V2_COMMIT = 'a3ee80461e0ca0e250f6272fc884041f5c2081f1';
export const RELAY_V2_BUILD_DIR = join(ROOT, '.private/integration-upgrade/tools/relay-2-build');
const DEFAULT_BIN = join(RELAY_V2_BUILD_DIR, 'apps/cli/dist/relay');

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** Путь к binary или `undefined`, если его нет (вызывающий решает: BLOCKED). */
export function relayV2Binary(explicit) {
  const bin = explicit ?? process.env.HARNESS_RELAY2_BIN ?? DEFAULT_BIN;
  return existsSync(bin) ? resolve(bin) : undefined;
}

/** Каталог SQLite >= 3.44 для macOS или `undefined` (Linux/не найдено). */
export function relayV2SqliteLib() {
  if (process.env.HARNESS_RELAY2_SQLITE_LIB) return process.env.HARNESS_RELAY2_SQLITE_LIB;
  if (process.platform !== 'darwin') return undefined;
  return ['/opt/homebrew/opt/sqlite/lib', '/usr/local/opt/sqlite/lib'].find((d) =>
    existsSync(join(d, 'libsqlite3.dylib')),
  );
}

/** Явное окружение Relay-2 для проекта: RELAY_HOME и, на macOS, DYLD_LIBRARY_PATH. */
export function relayV2Env(home) {
  const lib = relayV2SqliteLib();
  return { RELAY_HOME: home, ...(lib ? { DYLD_LIBRARY_PATH: lib } : {}) };
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Идентичность сборки: sha256 binary, commit клона, версия Bun (если есть). */
export function relayV2Info(bin = relayV2Binary()) {
  if (!bin) return { available: false };
  const git = spawnSync('git', ['-C', RELAY_V2_BUILD_DIR, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  const bunBin = join(ROOT, '.private/integration-upgrade/tools/bun/bin/bun');
  const bun = existsSync(bunBin)
    ? spawnSync(bunBin, ['--version'], { encoding: 'utf8' })
    : undefined;
  const version = spawnSync(bin, ['--version'], { encoding: 'utf8', env: minimalEnv({}) });
  return {
    available: true,
    binary: bin,
    sha256: sha256File(bin),
    commit: git.status === 0 ? git.stdout.trim() : RELAY_V2_COMMIT,
    expectedCommit: RELAY_V2_COMMIT,
    bun: bun?.status === 0 ? bun.stdout.trim() : undefined,
    cliVersion: version.stdout.trim(),
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    sqliteLib: relayV2SqliteLib(),
  };
}

function minimalEnv(extra) {
  const env = {};
  for (const k of ['PATH', 'HOME']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

/** Каталог вне Git worktree (проверяется). */
function scratch(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const git = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  });
  if (git.status === 0 && git.stdout.trim() === 'true') {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Временный каталог ${dir} оказался внутри Git worktree`);
  }
  return dir;
}

/**
 * Новый пустой проект Relay-2. `cli(args)` — независимое синхронное чтение/запись
 * тем же binary с явным `--config` (не через проверяемый транспорт).
 */
export function createRelayV2Project({
  bin = relayV2Binary(),
  name = 'Fixture',
  slug = 'fixture',
  root,
} = {}) {
  if (!bin) throw new Error('BLOCKED: Relay-2 binary не найден (HARNESS_RELAY2_BIN)');
  const dir = root ?? scratch('relay-v2-');
  mkdirSync(dir, { recursive: true });
  const home = join(dir, 'home');
  const config = join(dir, 'relay.config.json');
  const env = relayV2Env(home);
  const exec = (args, input) => {
    const r = spawnSync(bin, [...args, `--config=${config}`, '--format=json'], {
      cwd: dir,
      env: minimalEnv(env),
      encoding: 'utf8',
      input,
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const text = r.status === 0 ? r.stdout : r.stderr;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const init = exec(['init', `--name=${name}`, `--slug=${slug}`]);
  if (init.status !== 0 || !init.json?.ok)
    throw new Error(`relay init: ${init.stderr || init.stdout}`);
  const projectId = init.json.data.projectId;
  /** Успешный вызов → `data` (или `{data, meta}` при `full`); иначе исключение с кодом. */
  const cli = (args, { actor, full } = {}) => {
    const r = exec(actor ? [...args, `--actor=${actor}`] : args);
    if (r.status !== 0 || !r.json?.ok) {
      const error = new Error(`relay ${args.join(' ')}: ${r.stderr || r.stdout}`);
      error.code = r.json?.error?.code;
      error.status = r.status;
      throw error;
    }
    return full ? r.json : r.json.data;
  };
  return {
    bin,
    root: dir,
    home,
    config,
    projectId,
    env,
    cli,
    exec,
    generation: () => cli(['storage', 'status']).generation,
    /** Настройки транспорта для этого проекта. */
    settings: (extra = {}) => ({
      binary: bin,
      config,
      projectId,
      actor: 'harness',
      env,
      ...extra,
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Засеять задачу по рецепту брифа: документ, зависимость, главная задача с
 * двумя критериями, подзадача, связь документа. Возвращает ключи и ID.
 */
export function seedRelayV2Task(project, { actor = 'fixture', title = 'Main task', docBody } = {}) {
  const { cli } = project;
  const body = docBody ?? '# Spec\n\n  indented line\n\nEnd\n';
  const doc = cli(['document', 'create', '--name=Spec', `--body=${body}`, '--summary=s'], {
    actor,
  });
  const dep = cli(
    ['task', 'create', '--board=product', '--title=Dep task', '--description=Dependency'],
    { actor },
  );
  const main = cli(
    [
      'task',
      'create',
      '--board=product',
      `--title=${title}`,
      '--description=Main **md**',
      `--dependencies=${dep.key}`,
      '--acceptance-criteria=[{"title":"C1","summary":"first"},{"title":"C2"}]',
    ],
    { actor },
  );
  const sub = cli(
    ['task', 'create', '--board=product', '--title=Sub task', `--parent=${main.key}`],
    { actor },
  );
  cli(
    [
      'document',
      'link',
      doc.key,
      `--target=${main.key}`,
      '--relation=documents',
      `--if-revision=${doc.revision}`,
    ],
    {
      actor,
    },
  );
  return {
    main: { id: main.id, key: main.key },
    dependency: { id: dep.id, key: dep.key },
    subtask: { id: sub.id, key: sub.key },
    document: { id: doc.id, key: doc.key, body },
    criteria: main.data.acceptanceCriteria.map((c) => ({ id: c.id, title: c.title })),
  };
}

/**
 * Готовая фикстура: проект A с засеянной задачей и, по желанию, второй
 * независимый проект B (другой config/projectId, такая же нумерация задач).
 */
export function createRelayV2Fixture({ bin = relayV2Binary(), second = false } = {}) {
  const a = createRelayV2Project({ bin, name: 'Project A', slug: 'project-a' });
  let b;
  try {
    const seedA = seedRelayV2Task(a);
    let seedB;
    if (second) {
      b = createRelayV2Project({ bin, name: 'Project B', slug: 'project-b' });
      seedB = seedRelayV2Task(b, { title: 'Other project task' });
    }
    return {
      a: { ...a, seed: seedA },
      ...(b ? { b: { ...b, seed: seedB } } : {}),
      cleanup: () => {
        a.cleanup();
        b?.cleanup();
      },
    };
  } catch (error) {
    a.cleanup();
    b?.cleanup();
    throw error;
  }
}

/**
 * Управляемая обёртка над настоящим binary для D02: при совпадении argv с
 * `match` (все подстроки присутствуют) выполняет настоящую команду (запись
 * фиксируется у получателя), затем теряет ответ: `drop` — exit 0 без вывода,
 * `hang` — зависает до таймаута/отмены, `kill-parent` — убивает вызвавший
 * процесс (SIGKILL: падение controller после commit у получателя). Срабатывает `times` раз; счётчик —
 * в файле `<dir>/hits`. Остальные вызовы проходят прозрачно.
 */
export function createLossyRelayV2Wrapper({
  bin = relayV2Binary(),
  dir,
  match,
  mode = 'drop',
  times = 1,
}) {
  if (!bin) throw new Error('BLOCKED: Relay-2 binary не найден (HARNESS_RELAY2_BIN)');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'relay-lossy');
  const hits = join(dir, 'hits');
  writeFileSync(hits, '0');
  writeFileSync(
    path,
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const match = ${JSON.stringify(match)};
const hits = ${JSON.stringify(hits)};
const n = Number(fs.readFileSync(hits, 'utf8'));
const hit = n < ${Number(times)} && match.every((m) => args.some((a) => a.includes(m)));
const r = spawnSync(${JSON.stringify(bin)}, args, { stdio: hit ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
if (!hit) process.exit(r.status ?? 1);
fs.writeFileSync(hits, String(n + 1));
fs.writeFileSync(hits + '.' + (n + 1), String(r.stdout));
if (${JSON.stringify(mode)} === 'kill-parent') { process.kill(process.ppid, 'SIGKILL'); process.exit(0); }
if (${JSON.stringify(mode)} === 'hang') setInterval(() => {}, 1 << 30);
else process.exit(0);
`,
  );
  chmodSync(path, 0o755);
  return { path, hits: () => Number(readFileSync(hits, 'utf8')) };
}

/**
 * Действия «другого участника» (SuiteAdmin connectorSuite) напрямую через CLI
 * от отдельного actor. Каждая правка читает текущую ревизию и пишет с CAS.
 */
export function relayV2Admin(project, actor = 'suite-admin') {
  const { cli } = project;
  const w = (args) => cli(args, { actor });
  const rev = (ref) => cli(['task', 'get', ref]).revision;
  const done =
    (fn) =>
    (...a) =>
      Promise.resolve().then(() => fn(...a));
  return {
    createTask: done((i) => {
      const t = w([
        'task',
        'create',
        '--board=product',
        `--title=${i.title}`,
        ...(i.description ? [`--description=${i.description}`] : []),
        ...(i.column ? [`--column=${i.column}`] : []),
        ...(i.criteria?.length ? [`--acceptance-criteria=${JSON.stringify(i.criteria)}`] : []),
        ...(i.dependencies ?? []).map((d) => `--dependencies=${d}`),
        ...(i.parentId ? [`--parent=${i.parentId}`] : []),
      ]);
      return { id: t.id, key: t.key, criteria: t.data.acceptanceCriteria.map((c) => c.id) };
    }),
    updateTask: done((id, patch) => {
      w([
        'task',
        'update',
        id,
        ...(patch.title !== undefined ? [`--title=${patch.title}`] : []),
        ...(patch.description !== undefined ? [`--description=${patch.description}`] : []),
        `--if-revision=${rev(id)}`,
      ]);
    }),
    updateCriterion: done((id, criterionId, title) => {
      w([
        'task',
        'criterion',
        'update',
        id,
        criterionId,
        `--title=${title}`,
        `--if-revision=${rev(id)}`,
      ]);
    }),
    completeCriterion: done((id, criterionId, completed = true) => {
      w([
        'task',
        'criterion',
        completed ? 'complete' : 'reopen',
        id,
        criterionId,
        `--if-revision=${rev(id)}`,
      ]);
    }),
    addDocument: done((taskId, doc) => {
      const d = w(['document', 'create', `--name=${doc.name}`, `--body=${doc.body}`]);
      w([
        'document',
        'link',
        d.id,
        `--target=${taskId}`,
        '--relation=documents',
        `--if-revision=${d.revision}`,
      ]);
      return { id: d.id };
    }),
    updateDocument: done((id, body) => {
      const d = cli(['document', 'get', id]);
      w(['document', 'update', id, `--body=${body}`, `--if-revision=${d.revision}`]);
    }),
    addDependency: done((id, dependsOn) => {
      w(['task', 'dependency', 'add', id, dependsOn, `--if-revision=${rev(id)}`]);
    }),
    move: done((id, column) => {
      w(['task', 'move', id, `--column=${column}`, `--if-revision=${rev(id)}`]);
    }),
    comment: done((id, body) => {
      w(['task', 'comment', 'add', id, `--body=${body}`]);
    }),
    takeover: done((sessionId) => {
      const s = cli(['session', 'get', sessionId]);
      w([
        'session',
        'takeover',
        sessionId,
        '--reason=suite takeover',
        '--client=suite-admin',
        `--if-revision=${s.revision}`,
      ]);
    }),
  };
}

const command = process.argv[2];
if (command && import.meta.url === `file://${process.argv[1]}`) {
  const bin = relayV2Binary(flag('bin'));
  if (command === 'info') {
    console.log(JSON.stringify(relayV2Info(bin), null, 2));
  } else if (command === 'smoke') {
    if (!bin) {
      console.error('BLOCKED: Relay-2 binary не найден (--bin/HARNESS_RELAY2_BIN)');
      process.exit(2);
    }
    const fx = createRelayV2Fixture({ bin, second: process.argv.includes('--second') });
    try {
      const task = fx.a.cli(['task', 'get', fx.a.seed.main.key]);
      console.log(
        JSON.stringify(
          {
            a: { projectId: fx.a.projectId, task: task.key, generation: fx.a.generation() },
            ...(fx.b ? { b: { projectId: fx.b.projectId, generation: fx.b.generation() } } : {}),
          },
          null,
          2,
        ),
      );
    } finally {
      fx.cleanup();
    }
  } else {
    console.error('usage: relay-v2-fixture.mjs info|smoke [--bin <path>] [--second]');
    process.exit(2);
  }
}
