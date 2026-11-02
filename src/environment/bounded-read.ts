import { constants, open } from 'node:fs/promises';

/** Файл больше предела: дальше предела он не читался. */
export class OversizedFile extends Error {
  constructor(readonly limit: number) {
    super(`файл больше предела ${limit} байт`);
    this.name = 'OversizedFile';
  }
}

/**
 * Текст файла, который пишет чужой процесс, не больше `limit` байт. Память
 * ограничена и тогда, когда файл растёт после проверки размера: читается
 * не больше `limit + 1` байта. Symlink не разыменовывается, FIFO без писателя
 * не держит `open` (O_NONBLOCK) и отклоняется как не обычный файл.
 */
export async function readBounded(path: string, limit: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('не обычный файл');
    if (stat.size > limit) throw new OversizedFile(limit);
    const buffer = Buffer.allocUnsafe(limit + 1);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new OversizedFile(limit);
    }
    return buffer.toString('utf8', 0, size);
  } finally {
    await handle.close();
  }
}
