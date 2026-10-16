import { readFileSync } from 'node:fs';

export const example = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../examples/single-task/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

/** Глубокая копия JSON-входа, чтобы тест менял свою редакцию. */
export const clone = <T>(value: T): T => structuredClone(value);
