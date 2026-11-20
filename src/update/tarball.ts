import { gunzipSync } from 'node:zlib';

/**
 * Чтение файлов из tarball пакета npm (gzip + ustar/pax) без распаковки на
 * диск: только нужные пути, только обычные файлы, с пределом размера.
 * Архив скачивает и проверяет (integrity) сам npm (`npm pack`).
 */
export function readTarball(
  gz: Buffer,
  wanted: (path: string) => boolean,
  maxFileBytes = 1024 * 1024,
): Map<string, string> {
  const tar = gunzipSync(gz, { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map<string, string>();
  let offset = 0;
  let paxPath: string | undefined;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) break;
    const type = field(156, 1);
    const magic = field(257, 6);
    const prefix = magic.startsWith('ustar') ? field(345, 155) : '';
    let name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const bodyStart = offset + 512;
    const body = tar.subarray(bodyStart, bodyStart + size);
    offset = bodyStart + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      paxPath = m?.[1];
      continue;
    }
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'g') continue;
    if (paxPath) name = paxPath;
    else if (longName) name = longName;
    paxPath = undefined;
    longName = undefined;
    if ((type === '0' || type === '') && size <= maxFileBytes && wanted(name))
      files.set(name, body.toString('utf8'));
  }
  return files;
}
