export const TEST_TEMP_PREFIX: string;
export function keepTestTemp(env?: NodeJS.ProcessEnv): boolean;
export function scopeTestTemp(options?: {
  parent?: string;
  env?: NodeJS.ProcessEnv;
  warn?: (text: string) => void;
}): string;
export function removeTestTemp(
  path: string,
  warn?: (text: string) => void,
  parent?: string,
): boolean;
export function treeBytes(path: string): number;
export interface Leftover {
  name: string;
  path: string;
  bytes: number;
  created: number;
  file: string;
}
export function findLeftovers(dir: string, options?: { since?: number }): Leftover[];
export function formatBytes(bytes: number): string;
export function leftoverReport(dir: string, leftovers: Leftover[], limit?: number): string[];
export function main(
  args: string[],
  options?: { dir?: string; ppid?: number; log?: (text: string) => void },
): number;
