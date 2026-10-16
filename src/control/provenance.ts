import { readFileSync, realpathSync } from 'node:fs';
import { sha256 } from '../contracts/index.ts';

/**
 * Откуда загружена политика процесса: путь в том виде, как его задали,
 * разрешённая при загрузке цель и хэш именно тех байтов, которые разобраны.
 */
export interface PolicySource {
  path: string;
  real: string;
  sha: string;
}

export const policySourceOf = (path: string, text: string): PolicySource => ({
  path,
  real: realpathSync(path),
  sha: sha256(text),
});

/**
 * Источник сейчас содержит ровно разобранные байты по той же цели. Сверяется
 * содержимое, а не mtime и размер: их сохраняют копирование и перезапись тем
 * же размером; переключённая ссылка на другой файл — другой источник.
 * `undefined` — не менялся, иначе причина.
 */
export function policySourceChanged(source: PolicySource): string | undefined {
  try {
    if (realpathSync(source.path) !== source.real)
      return `путь ${source.path} указывает на другой файл, чем при загрузке`;
    if (sha256(readFileSync(source.path, 'utf8')) !== source.sha)
      return `файл ${source.path} изменился после загрузки`;
    return undefined;
  } catch (error) {
    return `файл ${source.path} недоступен: ${(error as Error).message}`;
  }
}
