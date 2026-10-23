#!/usr/bin/env node
/**
 * Обёртка сценариев приёмки над поставляемой подготовкой
 * `examples/turbo-starter/setup.mjs` (она же — в npm-архиве). Здесь только
 * корень checkout harness для запуска CLI из исходников.
 *
 *   node scripts/acceptance/starter-fixture.mjs --work <dir> [--source <url|path>] [--warm]
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * HARNESS_PACKAGE_DIR — установленный пакет (например, из финального архива):
 * подготовка Starter берётся из его поставляемого `examples/turbo-starter/setup.mjs`.
 */
const setup = await import(
  process.env.HARNESS_PACKAGE_DIR
    ? pathToFileURL(join(process.env.HARNESS_PACKAGE_DIR, 'examples/turbo-starter/setup.mjs')).href
    : '../../examples/turbo-starter/setup.mjs'
);
export const {
  EXAMPLE,
  CONTROLLER_TEMPLATE,
  STARTER,
  SETUP_VERSION,
  git,
  prepareStarterFixture,
  starterPolicy,
  starterGraph,
  changeFiles,
  controllerContext,
  writeLayout,
  approve,
  implement,
} = setup;
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.argv[1] = fileURLToPath(
    new URL('../../examples/turbo-starter/setup.mjs', import.meta.url),
  );
  await import('../../examples/turbo-starter/setup.mjs?cli');
}
