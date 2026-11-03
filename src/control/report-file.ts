import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { HarnessError } from '../contracts/index.ts';

/** Права нового файла отчёта: только владелец (в отчёте — данные проекта). */
export const REPORT_FILE_MODE = 0o600;

/** Запись байтов в открытый дескриптор; подменяется в тестах. */
export interface ReportFileIo {
  write(fd: number, data: Uint8Array): void;
}
const fsIo: ReportFileIo = {
  write(fd, data) {
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset);
  },
};

const lstatOf = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

/**
 * Запись `report --out` без записи «сквозь» ссылки: текст пишется во
 * временный файл того же каталога (новый, `wx`) и переименовывается поверх
 * цели — rename заменяет запись каталога и не следует ни за symlink, ни за
 * жёсткой ссылкой. Права: у прежнего файла — его же, новый — `0600`.
 * Временный файл помечен созданным сразу после создания: при неполной
 * записи или отказе rename он удаляется (только он — имя с UUID).
 *
 * Отказ `PATH_CONFLICT`: цель — не обычный файл, symlink, файл с
 * несколькими жёсткими ссылками (`nlink > 1`) или путь внутри каталога
 * состояния. Каталог цели должен существовать (`INVALID_INPUT`).
 */
export function writeReportFile(out: string, state: string, text: string, io: ReportFileIo = fsIo) {
  const target = resolve(out);
  const conflict = (message: string, detail: string) =>
    new HarnessError('PATH_CONFLICT', `--out: ${message}: ${out}`, [
      { path: ['--out'], message: detail },
    ]);
  let dir: string;
  try {
    dir = realpathSync(dirname(target));
  } catch (error) {
    throw new HarnessError(
      'INVALID_INPUT',
      `--out: каталог недоступен: ${(error as Error).message}`,
      [{ path: ['--out'], message: out }],
    );
  }
  const stateDir = realpathSync(resolve(state));
  if (dir === stateDir || dir.startsWith(stateDir + sep))
    throw conflict('внутри каталога состояния', 'inside-state');
  const existing = lstatOf(target);
  if (existing) {
    if (existing.isSymbolicLink()) throw conflict('символическая ссылка', 'symlink');
    if (!existing.isFile()) throw conflict('не обычный файл', 'not-a-file');
    if (existing.nlink > 1) throw conflict('у файла несколько жёстких ссылок', 'hard-link');
  }
  const mode = existing ? existing.mode & 0o7777 : REPORT_FILE_MODE;
  const temp = join(dir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    created = true;
    try {
      io.write(fd, new TextEncoder().encode(text));
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, mode);
    renameSync(temp, join(dir, basename(target)));
    created = false;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError('INVALID_INPUT', `--out: не записан: ${(error as Error).message}`, [
      { path: ['--out'], message: out },
    ]);
  } finally {
    if (created) rmSync(temp, { force: true });
  }
}
