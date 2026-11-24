import { readFileSync } from 'node:fs';

/**
 * Пример single-task. Политика примера в тестах — строгий режим: с alpha.69
 * политика без `harnessMode` облегчённая, а прежние тесты проверяют
 * строгую изоляцию (она заморожена). Облегчённый режим — свои тесты
 * (`examplePolicy('light')`, tests/light-*.test.ts).
 */
export const example = (name: string): Record<string, unknown> => {
  const value = JSON.parse(
    readFileSync(new URL(`../examples/single-task/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  if (name.startsWith('policy') && value.harnessMode === undefined) value.harnessMode = 'strict';
  return value;
};

/** Глубокая копия JSON-входа, чтобы тест менял свою редакцию. */
export const clone = <T>(value: T): T => structuredClone(value);
