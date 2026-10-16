#!/usr/bin/env node
// Точка входа сервера проверок reviewer: её запускает CLI reviewer по
// команде из `probeCommand`. Спецификация — файл в каталоге ревью.
import { readFile } from 'node:fs/promises';
import { ReviewProbes, probeSpec, serveReviewProbes } from './review-probe.ts';

const index = process.argv.indexOf('--spec');
const path = index >= 0 ? process.argv[index + 1] : undefined;
if (!path) {
  process.stderr.write('probe-server: нужен --spec <файл>\n');
  process.exit(2);
}
const spec = probeSpec.parse(JSON.parse(await readFile(path, 'utf8')));
serveReviewProbes(new ReviewProbes(spec));
