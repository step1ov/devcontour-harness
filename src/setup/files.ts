/* eslint-disable @typescript-eslint/require-await -- заглушка L0; снимается рабочим пакетом */
import type { Stats } from 'node:fs';
import type { fileConflicts } from '../contracts/project.ts';
import { notImplemented } from '../projections/stub.ts';

/**
 * Безопасная подготовка файлов: план → create-only применение. Ничего
 * существующего не перезаписывается, через symlink и вне корня не пишется.
 */

export type FileConflict = (typeof fileConflicts)[number];
export interface FileIntent {
  /** Абсолютный путь. */
  path: string;
  content: string;
  /** По умолчанию `preserve`. */
  onExisting?: 'preserve' | 'require-identical';
}
export interface FileWriteInput {
  files: FileIntent[];
  root?: string;
}
export interface FilePlanEntry {
  path: string;
  action: 'create' | 'preserve' | 'conflict';
  conflict?: FileConflict;
  /** Путь, вызвавший конфликт (symlink-предок, предок-файл). */
  conflictPath?: string;
}
export interface FilePlan {
  entries: FilePlanEntry[];
  conflicts: number;
  root?: string;
}

/** `lstat`; отсутствующий путь — undefined, прочие ошибки — как есть. */
export async function inspectPath(path: string): Promise<Stats | undefined> {
  void path;
  return notImplemented('inspectPath');
}
/** Отказ PATH_CONFLICT, если путь или предок — symlink, предок не каталог или путь вне root. */
export async function checkDestination(path: string, options?: { root?: string }): Promise<void> {
  void path;
  void options;
  return notImplemented('checkDestination');
}
/** Относительные пути обычных файлов каталога (рекурсивно). */
export async function listRegularFiles(dir: string): Promise<string[]> {
  void dir;
  return notImplemented('listRegularFiles');
}
/** План записей; конфликты не бросаются — агент видит их все сразу. */
export async function planFileWrites(input: FileWriteInput): Promise<FilePlan> {
  void input;
  return notImplemented('planFileWrites');
}
/** Применение плана: только создание, в порядке `files`. */
export async function applyFileWrites(
  plan: FilePlan,
  files: FileIntent[],
): Promise<{ created: string[]; preserved: string[] }> {
  void plan;
  void files;
  return notImplemented('applyFileWrites');
}
