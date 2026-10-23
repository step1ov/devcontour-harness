/**
 * A03: состояние и результаты, записанные выпуском 0.1.0-alpha.5, читаются
 * текущим кодом без переписывания.
 *
 * Код alpha.5 берётся из Git (`git archive c1bb638`) во временный каталог и
 * запускается тем же CLI на примере `single-task` с fixture runtime: попытка
 * принята, результат доставлен в каталог. Затем текущий CLI читает то же
 * состояние (`status`, `result`, `events`, `doctor --state`): результат и журнал
 * совпадают с прочитанными alpha.5, строки всех таблиц базы прежние. Повтор
 * доставки текущим кодом идемпотентен: прежняя запись доставки и получателя не
 * меняются. Нет коммита выпуска в клоне — BLOCKED (отказ), а не пропуск.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
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
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ALPHA5_COMMIT = 'c1bb638';
/** Конверт CLI: только поля, которые сверяет тест. */
interface Envelope {
  ok: boolean;
  data: {
    result?: { outcome?: string };
    state?: { compatible?: boolean };
    events?: unknown[];
  } & Record<string, unknown>;
}

test(
  'A03/state: состояние, результат и доставка alpha.5 читаются текущим кодом без переписывания',
  { timeout: 300_000 },
  () => {
    const have = spawnSync('git', ['cat-file', '-e', ALPHA5_COMMIT + '^{commit}'], { cwd: root });
    assert.equal(have.status, 0, `BLOCKED A03/state: в клоне нет коммита выпуска ${ALPHA5_COMMIT}`);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-a03-state-')));
    try {
      // Код alpha.5 из Git; зависимости — те же закреплённые версии checkout.
      const old = join(dir, 'alpha5');
      mkdirSync(old);
      const archive = execFileSync(
        'git',
        [
          'archive',
          ALPHA5_COMMIT,
          'src',
          'package.json',
          'tests/fixtures/bin',
          'examples/single-task',
        ],
        {
          cwd: root,
          maxBuffer: 1 << 28,
        },
      );
      execFileSync('tar', ['-x', '-C', old], { input: archive });
      symlinkSync(join(root, 'node_modules'), join(old, 'node_modules'));
      const bin = join(old, 'tests', 'fixtures', 'bin');
      for (const f of ['fake-claude', 'fake-codex']) chmodSync(join(bin, f), 0o755);

      // Проект примера в собственном Git, fixture-сценарий.
      const app = join(dir, 'app');
      cpSync(join(old, 'examples', 'single-task'), app, { recursive: true });
      const scenario = join(dir, 'scenario.json');
      writeFileSync(
        scenario,
        JSON.stringify({
          writer: {
            files: { 'src/greet.js': "exports.greet = (n) => 'Hello, ' + n + '!';\n" },
            result: { completed: true, summary: 'change', discoveries: [] },
          },
          reviewer: {
            result: {
              approved: true,
              summary: 'ok',
              findings: [],
              discoveries: [],
              execution: { commands: [], noCommandsReason: 'diff' },
              previous: [],
            },
          },
        }),
      );
      const policy = JSON.parse(readFileSync(join(app, 'policy.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      policy.isolation = { mode: 'none', domains: [] };
      policy.environment = { values: { FIXTURE_SCENARIO: scenario } };
      policy.maxAttempts = 1;
      writeFileSync(join(app, 'policy.json'), JSON.stringify(policy));
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'a',
        GIT_AUTHOR_EMAIL: 'a@a',
        GIT_COMMITTER_NAME: 'a',
        GIT_COMMITTER_EMAIL: 'a@a',
      };
      for (const args of [
        ['init', '-q', '-b', 'main'],
        ['add', '-A'],
        ['commit', '-qm', 'init'],
      ])
        execFileSync('git', args, { cwd: app, env: gitEnv });

      const state = join(dir, 'state');
      const sink = join(dir, 'sink');
      const cli = (src: string, ...args: string[]) => {
        const r = spawnSync(
          process.execPath,
          ['--import', import.meta.resolve('tsx'), join(src, 'src', 'cli.ts'), ...args],
          {
            cwd: dir,
            encoding: 'utf8',
            env: {
              ...process.env,
              HARNESS_CLAUDE_BIN: join(bin, 'fake-claude'),
              HARNESS_CODEX_BIN: join(bin, 'fake-codex'),
            },
          },
        );
        return {
          status: r.status,
          json: JSON.parse(r.stdout || '{}') as Envelope,
          stderr: r.stderr,
        };
      };
      const ran = cli(
        old,
        'run',
        '--graph',
        join(app, 'graph.json'),
        '--policy',
        join(app, 'policy.json'),
        '--state',
        state,
        '--sink',
        'file:' + sink,
      );
      assert.equal(ran.status, 0, 'alpha.5 run: ' + ran.stderr + JSON.stringify(ran.json));
      const readAll = (src: string) => ({
        status: cli(src, 'status', '--state', state).json,
        result: cli(src, 'result', '--state', state, '--work', 'add-greeting').json,
        events: cli(src, 'events', '--state', state, '--limit', '1000').json,
      });
      const before = readAll(old);
      assert.equal(before.result.data.result?.outcome, 'accepted');
      // Логическое содержимое всех таблиц базы (только чтение). Байты файла
      // меняет и сама alpha.5 при чтении CLI (заголовок SQLite), поэтому
      // сравниваются строки таблиц, а не hash файла.
      const dump = () => {
        const db = new DatabaseSync(join(state, 'state.sqlite'), { readOnly: true });
        try {
          const tables = (
            db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
              name: string;
            }[]
          ).map((r) => r.name);
          return Object.fromEntries(
            tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]),
          );
        } finally {
          db.close();
        }
      };
      const sinkFile = join(sink, 'add-greeting.json');
      const delivered = readFileSync(sinkFile, 'utf8');
      const stateBefore = dump();

      // Текущий код: только чтение — те же данные, файлы состояния прежние.
      const now = readAll(root);
      const doctor = cli(root, 'doctor', '--state', state);
      assert.equal(doctor.json.ok, true, 'doctor --state: ' + JSON.stringify(doctor.json));
      assert.equal(doctor.json.data.state?.compatible, true, 'состояние alpha.5 несовместимо');
      assert.deepEqual(now.result.data, before.result.data, 'результат alpha.5 читается иначе');
      assert.deepEqual(now.events.data, before.events.data, 'журнал alpha.5 читается иначе');
      assert.deepEqual(now.status.data, before.status.data, 'статус alpha.5 читается иначе');
      assert.deepEqual(dump(), stateBefore, 'чтение изменило содержимое базы');

      // Повтор доставки текущим кодом: идемпотентен, прежние записи не переписаны.
      const again = cli(
        root,
        'deliver',
        '--state',
        state,
        '--work',
        'add-greeting',
        '--sink',
        'file:' + sink,
      );
      assert.equal(again.status, 0, 'deliver: ' + JSON.stringify(again.json));
      assert.equal(readFileSync(sinkFile, 'utf8'), delivered, 'запись получателя переписана');
      const after = readAll(root);
      assert.deepEqual(
        after.result.data,
        before.result.data,
        'доставка изменила результат или запись доставки',
      );
      const oldEvents = before.events.data.events ?? [];
      assert.ok(oldEvents.length > 0, 'журнал alpha.5 пуст');
      assert.deepEqual(
        (after.events.data.events ?? []).slice(0, oldEvents.length),
        oldEvents,
        'журнал alpha.5 переписан',
      );
      assert.ok(existsSync(sinkFile));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
