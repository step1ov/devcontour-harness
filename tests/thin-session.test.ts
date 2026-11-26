/**
 * 0.1.0-alpha.73: продолжение сессии writer тонкого режима в адаптере CLI.
 * Новая сессия оставляет метку в постоянном домашнем каталоге CLI работы,
 * продолжение — `codex exec resume <id>` / `claude --resume <id>` с теми же
 * флагами ответа; ID сессии из событий runtime; потерянная сессия — отказ
 * продолжения (`sessionLost`), а не недоступный runtime.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliAdapter, sessionContinueSupport } from '../src/agents/cli-adapter.ts';
import type { RuntimeRequest } from '../src/contracts/index.ts';

const bin = (name: string) => new URL(`./fixtures/bin/${name}`, import.meta.url).pathname;

function setup(steps: unknown[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'thin-session-')));
  const cwd = join(root, 'w');
  const home = join(root, 'sessions', 'work-1');
  const userHome = join(root, 'user');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(userHome, '.codex'), { recursive: true });
  writeFileSync(join(userHome, '.codex', 'auth.json'), '{"fixture":1}');
  const scenario = join(root, 'scenario.json');
  writeFileSync(scenario, JSON.stringify({ writer: steps }));
  let n = 0;
  const call = (
    runtime: 'codex' | 'claude',
    session: RuntimeRequest['session'],
    extra: {
      task?: RuntimeRequest['task'];
      home?: string | null;
      env?: Record<string, string>;
    } = {},
  ) =>
    cliAdapter(runtime, { executable: bin(`fake-${runtime}`) }).invoke(
      {
        callId: `c${++n}`,
        task: extra.task ?? 'implement',
        binding: { runtime },
        cwd,
        prompt: 'p',
        outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
        session,
        sandbox: {
          mode: 'os',
          writable: [cwd],
          denied: [],
          network: { domains: [] },
          light: extra.home === null ? {} : { home: extra.home ?? home },
        },
        timeoutMs: 30_000,
        env: {
          PATH: process.env.PATH!,
          HOME: userHome,
          FIXTURE_SCENARIO: scenario,
          ...extra.env,
        },
        artifactDir: join(root, 'calls', String(n)),
      },
      AbortSignal.timeout(40_000),
    );
  const args = (index: number) =>
    JSON.parse(
      readFileSync(`${scenario}.writer.${index}.prompt`, 'utf8').split('\n---ARGS---\n')[1]!,
    ) as string[];
  return { root, home, scenario, call, args };
}

const ok = { recordPrompt: true, result: { summary: 'done' } };

test('codex: новая сессия в постоянном каталоге, продолжение exec resume с теми же флагами', async () => {
  const s = setup([ok, ok, ok]);
  const first = await s.call('codex', { kind: 'fresh' });
  assert.equal(first.status, 'ok', JSON.stringify(first.diagnostics));
  assert.match(first.sessionId ?? '', /^fixture-/);
  assert.ok(
    existsSync(join(s.home, 'fixture-sessions', first.sessionId!)),
    'сессия в каталоге работы',
  );
  assert.ok(existsSync(s.home), 'каталог работы не удалён после вызова');
  assert.equal(existsSync(join(s.home, 'auth.json')), false, 'копии входа после вызова нет');
  const fresh = s.args(0);
  assert.deepEqual(fresh.slice(0, 2), ['exec', '--json']);
  assert.ok(fresh.includes('--sandbox'));

  const second = await s.call('codex', { kind: 'continue', id: first.sessionId! });
  assert.equal(second.status, 'ok', JSON.stringify(second.diagnostics));
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(readFileSync(`${s.scenario}.codex.writer.1.resumed`, 'utf8'), first.sessionId);
  const resumed = s.args(1);
  assert.deepEqual(resumed.slice(0, 4), ['exec', 'resume', first.sessionId, '--json']);
  // У exec resume нет --sandbox: тот же режим настройкой.
  assert.ok(!resumed.includes('--sandbox'));
  assert.ok(resumed.includes('sandbox_mode="danger-full-access"'));
  for (const flag of ['--output-schema', '--output-last-message', '--ignore-user-config'])
    assert.ok(resumed.includes(flag), flag);
  assert.equal(resumed.at(-1), '-');
  // Копия входа заменяется при каждом вызове: повтор в том же каталоге не падает.
  const third = await s.call('codex', { kind: 'continue', id: first.sessionId! });
  assert.equal(third.status, 'ok', JSON.stringify(third.diagnostics));
  assert.equal(existsSync(join(s.home, 'auth.json')), false);
});

test('claude: сессия writer с каталогом работы сохраняется и продолжается --resume; без каталога — прежние флаги', async () => {
  const s = setup([ok, ok, ok]);
  const first = await s.call('claude', { kind: 'fresh' });
  assert.equal(first.status, 'ok', JSON.stringify(first.diagnostics));
  // ID новой сессии задаёт harness (`--session-id`).
  assert.match(first.sessionId ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(s.args(0)[s.args(0).indexOf('--session-id') + 1], first.sessionId);
  assert.ok(!s.args(0).includes('--no-session-persistence'));
  assert.ok(!s.args(0).includes('--resume'));
  const second = await s.call('claude', { kind: 'continue', id: first.sessionId! });
  assert.equal(second.status, 'ok', JSON.stringify(second.diagnostics));
  const resumed = s.args(1);
  assert.equal(resumed[resumed.indexOf('--resume') + 1], first.sessionId);
  assert.ok(resumed.includes('--json-schema'));
  assert.ok(existsSync(join(s.home, '.claude.json')));
  // Облегчённый режим без каталога работы — как раньше.
  const plain = await s.call('claude', { kind: 'fresh' }, { home: null });
  assert.equal(plain.status, 'ok');
  assert.ok(s.args(2).includes('--no-session-persistence'));
});

test('продолжение потерянной сессии — отказ продолжения; reviewer продолжения не получает', async () => {
  const s = setup([ok]);
  for (const runtime of ['codex', 'claude'] as const) {
    const lost = await s.call(runtime, { kind: 'continue', id: 'gone' });
    assert.equal(lost.status, 'failed', runtime);
    assert.equal(lost.diagnostics.sessionLost, true, runtime);
    assert.match(
      lost.diagnostics.reason ?? '',
      /сессия gone не продолжена.*(session not found|No conversation found)/,
    );
    // Прочий отказ до начала (истёкший вход) — недоступный runtime, а не потерянная сессия.
    const auth = await s.call(
      runtime,
      { kind: 'continue', id: 'gone' },
      { env: { FIXTURE_RESUME_FAIL: 'Not logged in' } },
    );
    assert.equal(auth.status, 'unavailable', runtime);
    assert.equal(auth.diagnostics.sessionLost, undefined, runtime);
    // Другой каталог работы — той сессии нет.
    const fresh = await s.call(runtime, { kind: 'fresh' });
    const elsewhere = await s.call(
      runtime,
      { kind: 'continue', id: fresh.sessionId! },
      { home: join(s.root, 'other', runtime) },
    );
    assert.equal(elsewhere.diagnostics.sessionLost, true, runtime);
    await assert.rejects(
      s.call(runtime, { kind: 'continue', id: fresh.sessionId! }, { task: 'review-code' }),
      /продолжение сессии не поддерживается/,
    );
    await assert.rejects(
      s.call(runtime, { kind: 'fork', id: fresh.sessionId! }),
      /продолжение сессии не поддерживается/,
    );
  }
});

test('переполнение контекста продолжения — отказ с признаком у claude; проба resume по справке CLI', async () => {
  for (const runtime of ['claude', 'codex'] as const) {
    const s = setup([ok, { contextExhausted: true }]);
    const first = await s.call(runtime, { kind: 'fresh' });
    const full = await s.call(runtime, { kind: 'continue', id: first.sessionId! });
    assert.equal(full.status, 'failed', runtime);
    assert.equal(full.diagnostics.contextExhausted, 'blocking-limit', runtime);
    assert.equal(full.diagnostics.sessionLost, undefined, runtime);
  }
  const s = setup([ok]);
  const caps = await cliAdapter('codex', {
    executable: bin('fake-codex'),
    sessionContinue: true,
  }).capabilities();
  // Без запроса хоста (не тонкий режим) справка не пробуется.
  assert.equal(
    (await cliAdapter('codex', { executable: bin('fake-codex') }).capabilities()).sessionContinue,
    undefined,
  );
  assert.equal(caps.sessionContinue, true);
  assert.equal(await sessionContinueSupport('claude', bin('fake-claude')), true);
  // CLI без нужных флагов в справке — продолжения нет.
  const old = join(s.root, 'old-codex');
  writeFileSync(old, '#!/bin/sh\necho "Usage: codex exec resume [SESSION_ID]"\necho "  --json"\n');
  chmodSync(old, 0o755);
  assert.equal(await sessionContinueSupport('codex', old), false);
});
