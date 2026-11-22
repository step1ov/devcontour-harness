#!/usr/bin/env node
// Точка входа надзирающего процесса превью: его запускает `harness
// preview-start` (`supervisorCommand`) отсоединённым от вызывающего.
// Спецификация — файл в каталоге превью (docs/previews.md).
import { readFile } from 'node:fs/promises';
import { supervisePreview, type PreviewSpec } from './preview.ts';

const index = process.argv.indexOf('--spec');
const path = index >= 0 ? process.argv[index + 1] : undefined;
if (!path) {
  process.stderr.write('preview-supervisor: нужен --spec <файл>\n');
  process.exit(2);
}
const spec = JSON.parse(await readFile(path, 'utf8')) as PreviewSpec;
try {
  await supervisePreview(spec);
  process.exit(0);
} catch (error) {
  process.stderr.write(
    'preview-supervisor: ' +
      (error instanceof Error ? (error.stack ?? error.message) : String(error)) +
      '\n',
  );
  process.exit(4);
}
