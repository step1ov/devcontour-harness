// Типы для tests/affected.test.ts: сам выбор написан на JS, чтобы
// scripts/test.mjs запускал его без tsx.
export interface Selection {
  full: boolean;
  reasons: string[];
  files: Map<string, string[]>;
  notes: string[];
}
export interface ParsedModule {
  imports: { target: string; names: Set<string> | 'all' }[];
  reexports: { target: string; star?: true; ns?: string; map?: [string, string][] }[];
  locals: Set<string>;
}
export function parseModule(root: string, file: string): ParsedModule;
export function closures(root: string, testFiles: string[]): Map<string, Set<string>>;
export function selectTests(root: string, changed: string[], testFiles: string[]): Selection;
export function defaultBase(root: string): string;
export function changedFiles(root: string, base: string): string[];
export function suiteFiles(root: string): string[];
