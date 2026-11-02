import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

/**
 * SHA-256 и права файлов дерева в потоках: сверка копии seed читает десятки
 * тысяч мелких файлов, и асинхронное чтение по одному упирается в переходы
 * через пул libuv из четырёх потоков, а хэш — в один главный поток. Здесь
 * каждый поток сам открывает, читает и хэширует свою порцию синхронно.
 *
 * Байты и права берутся с одного дескриптора: файл открыт без перехода по
 * ссылке и без ожидания устройства, а `fstat` того же дескриптора решает,
 * обычный ли это файл. Подмена между обходом и чтением — отказ, а не чтение
 * чужого файла.
 */
export interface FileDigest {
  rel: string;
  sha256: string;
  /** Права вместе с setuid, setgid и sticky (`0o7777`). */
  mode: number;
  size: number;
}

/** Файл оказался не обычным: ссылка, каталог, устройство. */
export class NotRegularFile extends Error {
  constructor(readonly rel: string) {
    super(`в хранилище не обычный файл: ${rel}`);
  }
}

/** Порция файлов на одно сообщение: обмен не должен стоить больше чтения. */
const BATCH = 256;
const MAX_THREADS = 8;

// Код потока — строка: модуль работает и из исходников TypeScript, и из сборки.
const WORKER = `
const { parentPort } = require('node:worker_threads');
const { openSync, fstatSync, readSync, closeSync, constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const buffer = Buffer.allocUnsafe(1024 * 1024);
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
parentPort.on('message', ({ root, rels }) => {
  const results = [];
  for (const rel of rels) {
    let fd;
    try {
      fd = openSync(join(root, rel), flags);
    } catch (error) {
      if (error.code === 'ELOOP') return parentPort.postMessage({ refused: rel });
      return parentPort.postMessage({ error: { message: error.message, code: error.code } });
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return parentPort.postMessage({ refused: rel });
      const hash = createHash('sha256');
      for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0; )
        hash.update(buffer.subarray(0, n));
      results.push([rel, hash.digest('hex'), st.mode & 0o7777, st.size]);
    } catch (error) {
      return parentPort.postMessage({ error: { message: error.message, code: error.code } });
    } finally {
      closeSync(fd);
    }
  }
  parentPort.postMessage({ results });
});
`;

type Reply =
  | { results: [string, string, number, number][] }
  | { refused: string }
  | { error: { message: string; code?: string } };

/** Запуск потока; тест подменяет его, чтобы проверить отказ запуска. */
export const digestWorker = { create: () => new Worker(WORKER, { eval: true }) };

/**
 * Отпечатки файлов `rels` под `root`. Первый отказ или отмена останавливает раздачу
 * и все потоки; результат возвращается, только когда ни один поток не работает.
 */
export async function fileDigests(
  root: string,
  rels: string[],
  signal?: AbortSignal,
): Promise<FileDigest[]> {
  signal?.throwIfAborted();
  const batches: string[][] = [];
  for (let i = 0; i < rels.length; i += BATCH) batches.push(rels.slice(i, i + BATCH));
  const threads = Math.min(MAX_THREADS, Math.max(1, availableParallelism() - 1), batches.length);
  const out: FileDigest[] = [];
  let next = 0;
  let failure: Error | undefined;
  const stops = new Set<() => void>();
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    for (const stop of stops) stop();
  };
  const onAbort = () => fail(signal!.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const run = () =>
    new Promise<void>((resolve) => {
      let worker: Worker;
      try {
        worker = digestWorker.create();
      } catch (error) {
        fail(error);
        return resolve();
      }
      let done = false;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        stops.delete(stop);
        if (error !== undefined) fail(error);
        worker.removeAllListeners();
        worker.on('error', () => undefined);
        void worker.terminate().then(() => resolve());
      };
      const stop = () => finish();
      stops.add(stop);
      const feed = () => {
        if (failure || next >= batches.length) return finish();
        worker.postMessage({ root, rels: batches[next++] });
      };
      worker.on('message', (reply: Reply) => {
        if ('refused' in reply) return finish(new NotRegularFile(reply.refused));
        if ('error' in reply)
          return finish(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
        for (const [rel, sha256, mode, size] of reply.results)
          out.push({ rel, sha256, mode, size });
        feed();
      });
      worker.on('error', (error: Error) => finish(error));
      worker.on('exit', () => finish(new Error('поток сверки завершился раньше времени')));
      feed();
    });
  try {
    await Promise.all(Array.from({ length: threads }, run));
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (failure) throw failure;
  return out;
}
