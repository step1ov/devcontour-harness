import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { command, drainPipes } from '../src/environment/process.ts';

const moduleUrl = new URL('../src/environment/process.ts', import.meta.url).href;
test('A completed contained command leaves no pipe timeout holding its caller alive', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { command } from ${JSON.stringify(moduleUrl)};
    const result = await command([process.execPath, '-e', 'process.stdout.write("done")'], process.cwd(), {contain:true});
    const resolved = performance.now();
    process.once('beforeExit', () => console.log(JSON.stringify({
      idleMs:performance.now()-resolved, code:result.code, stdout:result.stdout,
    })));
  `,
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim()) as { idleMs: number; code: number; stdout: string };
  assert.equal(out.code, 0);
  assert.equal(out.stdout, 'done');
  assert.ok(out.idleMs < 2500, `natural exit waited ${out.idleMs}ms after command completion`);
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// Предел отсчитывается от запуска: под нагрузкой он может сработать раньше,
// чем node запустит потомка. Такой прогон ничего не доказывает — он повторяется
// с вдвое большим пределом; утверждения относятся к прогону, где потомок был.
const widenedLimitsMs = [1000, 2000, 4000, 8000];
for (const outcome of ['success', 'cancel', 'timeout'] as const)
  test(
    `Contained ${outcome} still closes inherited pipes and removes detached descendants`,
    { timeout: 60000 },
    async () => {
      for (const limitMs of outcome === 'timeout' ? widenedLimitsMs : [10000]) {
        const controller = new AbortController();
        let pid = 0;
        let output = '';
        try {
          const result = await command(
            [
              process.execPath,
              '-e',
              `
        const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
          {detached:true,stdio:['ignore','inherit','inherit']});
        child.unref();
        console.log('DESCENDANT='+child.pid);
        ${outcome === 'success' ? '' : 'setInterval(()=>{},1000);'}
      `,
            ],
            process.cwd(),
            {
              contain: true,
              timeoutMs: limitMs,
              signal: controller.signal,
              onRawStdout: (chunk) => {
                output += chunk;
                const match = /DESCENDANT=(\d+)/.exec(output);
                if (match) {
                  pid = Number(match[1]);
                  if (outcome === 'cancel') controller.abort();
                }
              },
            },
          );
          if (!pid && limitMs < widenedLimitsMs.at(-1)!) continue;
          assert.ok(pid > 0, 'descendant was started');
          assert.equal(result.code === 0, outcome === 'success');
          assert.equal(result.timedOut, outcome === 'timeout');
          assert.equal(result.diagnostics.aborted, outcome === 'cancel');
          const deadline = Date.now() + 3000;
          while (alive(pid) && Date.now() < deadline) await delay(20);
          assert.equal(alive(pid), false, 'detached descendant no longer holds inherited pipes');
          return;
        } finally {
          if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
        }
      }
    },
  );

test('A contained directory given through a symlink alias still finds the descendant inside it', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'contained-alias-')));
  const alias = join(base, 'alias');
  symlinkSync(base, alias);
  let pid = 0;
  try {
    // Без окружения и с выходом родителя сразу: опрос родства его не застаёт,
    // остаётся только текущий каталог, который lsof называет настоящим путём.
    const result = await command(
      [
        process.execPath,
        '-e',
        `const c=require('node:child_process').spawn('/bin/sh',['-c','exec sleep 600'],
          {detached:true,stdio:'ignore',env:{},cwd:${JSON.stringify(alias)}});
        c.unref();console.log('DESCENDANT='+c.pid);`,
      ],
      process.cwd(),
      { contain: { dirs: [alias] } },
    );
    pid = Number(/DESCENDANT=(\d+)/.exec(result.stdout)?.[1]);
    assert.ok(pid > 0, 'descendant was started');
    assert.equal(alive(pid), false, 'the alias reached the real path');
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(base, { recursive: true, force: true });
  }
});

test('A large final stdout line of a contained command arrives whole', async () => {
  const size = 200_000;
  let raw = '';
  const result = await command(
    [process.execPath, '-e', `process.stdout.write('{"x":"' + 'a'.repeat(${size}) + '"}\\n')`],
    process.cwd(),
    { contain: true, onRawStdout: (chunk) => (raw += chunk) },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.length, size + 9);
  assert.equal(raw, result.stdout);
  assert.equal((JSON.parse(result.stdout) as { x: string }).x.length, size);
});

test('A silent descendant that escaped the sweep holds the pipe only for the idle bound', async () => {
  // Внук без окружения и вне каталогов, отсоединённый раньше первого опроса:
  // очистка его не видит, а унаследованный stdout он держит. Ожидание pipe
  // отсчитывается от последнего байта, а не растягивается до общего предела.
  const inner = `const {spawn}=require('node:child_process');const g=spawn('/bin/sh',['-c','exec sleep 60'],{detached:true,stdio:['ignore','inherit','inherit'],env:{},cwd:'/'});g.unref();console.log('ESCAPED='+g.pid);process.exit(0)`;
  const outer = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(inner)}],{detached:true,stdio:['ignore','inherit','inherit'],env:{},cwd:'/'}).unref()`;
  let pid = 0;
  const started = performance.now();
  try {
    const result = await command([process.execPath, '-e', outer], process.cwd(), {
      contain: true,
      onRawStdout: (chunk) => {
        pid ||= Number(/ESCAPED=(\d+)/.exec(chunk)?.[1] ?? 0);
      },
    });
    const elapsed = performance.now() - started;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ESCAPED=\d+/);
    assert.ok(alive(pid), 'the holder really escaped the sweep');
    assert.ok(elapsed < 15_000, `escaped holder delayed the command by ${Math.round(elapsed)}ms`);
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('Pipe drain waits while bytes arrive and gives up on a silent or endless holder', async () => {
  let bytes = 0;
  let close!: () => void;
  const closed = new Promise<void>((r) => (close = r));
  const feed = setInterval(() => (bytes += 1), 100);
  setTimeout(() => {
    clearInterval(feed);
    close();
  }, 1200);
  // Поток идёт дольше idleMs: фиксированный предел от выхода уничтожил бы pipe.
  assert.equal(await drainPipes(closed, () => bytes, { idleMs: 300, limitMs: 5000 }), true);

  let started = performance.now();
  assert.equal(await drainPipes(new Promise(() => {}), () => 0, { idleMs: 300 }), false);
  const silent = performance.now() - started;
  assert.ok(silent >= 290 && silent < 2000, `silent holder waited ${Math.round(silent)}ms`);

  let endless = 0;
  const chatter = setInterval(() => (endless += 1), 50);
  started = performance.now();
  try {
    assert.equal(
      await drainPipes(new Promise(() => {}), () => endless, { idleMs: 300, limitMs: 1000 }),
      false,
    );
  } finally {
    clearInterval(chatter);
  }
  const capped = performance.now() - started;
  assert.ok(capped >= 990 && capped < 3000, `endless holder waited ${Math.round(capped)}ms`);
});

test('Pipe drain reads data that became ready while the event loop was blocked', async () => {
  // После долгой блокировки таймер срабатывает в своей фазе раньше, чем цикл
  // прочитает уже готовые данные: без прохода фазы ввода-вывода хвост терялся.
  const dir = mkdtempSync(join(tmpdir(), 'drain-blocked-'));
  const marker = join(dir, 'written');
  try {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');fs.writeSync(1,'tail');fs.writeFileSync(${JSON.stringify(marker)},'');process.exit(0)`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let bytes = 0;
    let text = '';
    child.stdout.on('data', (d: Buffer) => {
      bytes += d.length;
      text += d.toString();
    });
    const closed = new Promise<void>((r) => child.once('close', () => r()));
    await new Promise<void>((r) => child.once('spawn', () => r()));
    // Блокировка — в фазе check: следующий виток цикла начинается с
    // таймеров, и предел истекает раньше, чем прочитан готовый хвост.
    let drained!: Promise<boolean>;
    let unread = -1;
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        drained = drainPipes(closed, () => bytes, { idleMs: 200, limitMs: 30_000 });
        // Синхронная блокировка дольше idleMs и до записи хвоста потомком.
        const armed = performance.now();
        while (!existsSync(marker) || performance.now() - armed < 600)
          if (performance.now() - armed > 20_000) break;
        unread = bytes;
        resolve();
      }),
    );
    assert.ok(existsSync(marker), 'descendant wrote its tail');
    assert.equal(unread, 0, 'the tail was unread when the bound fired');
    assert.equal(await drained, true);
    assert.equal(text, 'tail');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
