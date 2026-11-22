import './temp-scope.ts';
/**
 * Блокировка запуска превью (`start.lock`) под гонкой: брошенная блокировка
 * мёртвого владельца и несколько одновременных запусков в отдельных процессах.
 * Критические секции не пересекаются, каждый запуск получает блокировку,
 * брошенная снята. Процессы запускаются один раз и проходят все раунды по
 * общему сигналу раунда — старт tsx не растягивает гонку.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processAlive } from '../src/environment/lifecycle.ts';

const preview = pathToFileURL(
  fileURLToPath(new URL('../src/control/preview.ts', import.meta.url)),
).href;

// Запускающий: в каждом раунде готов → ждёт сигнала раунда → захват →
// `hold` мс в секции → освобождение → запись входа и выхода.
const starter = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireStartLock, previewTiming } from ${JSON.stringify(preview)};
const [root, id, rounds, hold] = process.argv.slice(2);
previewTiming.pollMs = 5;
const now = () => performance.timeOrigin + performance.now();
for (let r = 0; r < Number(rounds); r++) {
  const dir = join(root, 'r' + r);
  while (!existsSync(join(dir, 'start.lock'))) await delay(1);
  writeFileSync(join(dir, 'ready' + id), '');
  // Сигнал ждут без пауз: запуски сходятся на брошенной блокировке почти одновременно.
  while (!existsSync(join(dir, 'go')));
  const release = await acquireStartLock(dir, 'web', 30000);
  const enter = now();
  await delay(Number(hold));
  const leave = now();
  release();
  writeFileSync(join(dir, 'out' + id + '.json'), JSON.stringify({ enter, leave }));
}
`;

async function race(racers: number, rounds: number, hold: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-preview-lock-')));
  const script = join(root, 'starter.mjs');
  writeFileSync(script, starter);
  const ids = Array.from({ length: racers }, (_, i) => i);
  const children = ids.map((id) =>
    spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--import',
        'tsx',
        script,
        root,
        String(id),
        String(rounds),
        String(hold),
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    ),
  );
  const exits = children.map(
    (child) => new Promise<number | null>((done) => child.on('exit', (code) => done(code))),
  );
  const dead = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' }).pid;
  assert.equal(processAlive(dead), false);
  let ok = false;
  try {
    for (let round = 0; round < rounds; round++) {
      const dir = join(root, `r${round}`);
      mkdirSync(dir);
      const lock = join(dir, 'start.lock');
      writeFileSync(lock, JSON.stringify({ pid: dead, start: 'x', nonce: 'dead' }));
      while (!ids.every((id) => existsSync(join(dir, `ready${id}`)))) await delay(5);
      writeFileSync(join(dir, 'go'), '');
      const outs = ids.map((id) => join(dir, `out${id}.json`));
      const deadline = Date.now() + 30_000;
      while (!outs.every((out) => existsSync(out))) {
        assert.ok(Date.now() < deadline, `раунд ${round}: не все получили блокировку`);
        await delay(5);
      }
      const spans = outs
        .map((out) => JSON.parse(readFileSync(out, 'utf8')) as { enter: number; leave: number })
        .sort((a, b) => a.enter - b.enter);
      for (let i = 1; i < spans.length; i++)
        assert.ok(
          spans[i]!.enter >= spans[i - 1]!.leave,
          `раунд ${round}: секции пересеклись ${JSON.stringify(spans)}`,
        );
      assert.equal(existsSync(lock), false, `раунд ${round}: брошенная блокировка снята`);
      assert.deepEqual(
        readdirSync(dir).filter((name) => name.startsWith('start.lock')),
        [],
        `раунд ${round}: не осталось служебных файлов блокировки`,
      );
    }
    ok = true;
  } finally {
    // Отказ проверки не оставляет запускающих ждать сигнала следующего раунда.
    if (!ok) for (const child of children) child.kill('SIGKILL');
  }
  assert.deepEqual(
    await Promise.all(exits),
    ids.map(() => 0),
    'запускающие завершились штатно',
  );
}

test('start.lock: брошенная блокировка и 3 одновременных запуска — секции не пересекаются, все получают блокировку', async () => {
  await race(3, 5, 200);
});

test('start.lock: брошенная блокировка и 8 одновременных запусков, 30 раундов — снятие брошенной не роняет свежую', async () => {
  await race(8, 30, 20);
});
