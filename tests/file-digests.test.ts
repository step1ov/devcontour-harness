/**
 * Отпечатки файлов для сверки копии seed: потоки дают ровно то же, что чтение
 * по одному (SHA-256 байтов, права, размер), а файл, который между обходом и
 * чтением стал ссылкой, каталогом или каналом, — отказ без чтения и без ожидания.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileDigests, NotRegularFile } from '../src/verification/file-digests.ts';

const tree = (t: { after: (fn: () => void) => void }) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-digests-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('FD01: отпечатки потоков равны чтению по одному: байты, права, размер, порядок не важен', async (t) => {
  const root = tree(t);
  const rels: string[] = [];
  // Пустой, мелкие, больше буфера потока (1 МБ) и больше порции (256 файлов).
  const sizes = [0, 1, 4095, 1024 * 1024, 1024 * 1024 + 1, 3 * 1024 * 1024 + 7];
  for (let i = 0; i < 700; i++) sizes.push(i * 13);
  for (const [i, size] of sizes.entries()) {
    const rel = `d${i % 7}/f${i}${i % 5 === 0 ? '-exec' : ''}`;
    mkdirSync(join(root, `d${i % 7}`), { recursive: true });
    writeFileSync(join(root, rel), randomBytes(size), { mode: i % 5 === 0 ? 0o755 : 0o644 });
    rels.push(rel);
  }
  const got = await fileDigests(root, rels);
  assert.equal(got.length, rels.length);
  const byRel = new Map(got.map((d) => [d.rel, d]));
  for (const rel of rels) {
    const path = join(root, rel);
    const st = lstatSync(path);
    assert.deepEqual(byRel.get(rel), {
      rel,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      mode: st.mode & 0o777,
      size: st.size,
    });
  }
  assert.deepEqual(await fileDigests(root, []), []);
});

test('FD02: ссылка, каталог и канал на месте файла — отказ; ссылка не читается', async (t) => {
  const root = tree(t);
  writeFileSync(join(root, 'plain'), 'x');
  writeFileSync(join(root, 'target'), 'чужой файл');
  symlinkSync(join(root, 'target'), join(root, 'link'));
  mkdirSync(join(root, 'dir'));
  const cases = ['link', 'dir'];
  if (process.platform !== 'win32' && spawnSync('mkfifo', [join(root, 'fifo')]).status === 0)
    cases.push('fifo');
  for (const rel of cases)
    await assert.rejects(
      fileDigests(root, ['plain', rel]),
      (error: unknown) => error instanceof NotRegularFile && error.rel === rel,
      rel,
    );
});

test('FD03: исчезнувший файл — ошибка с кодом, а не отказ от seed', async (t) => {
  const root = tree(t);
  await assert.rejects(
    fileDigests(root, ['absent']),
    (error: unknown) =>
      !(error instanceof NotRegularFile) && (error as NodeJS.ErrnoException).code === 'ENOENT',
  );
});
