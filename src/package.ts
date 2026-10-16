import { readFileSync } from 'node:fs';

/** Версия пакета читается из его собственного package.json, а не из cwd. */
export const HARNESS_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
