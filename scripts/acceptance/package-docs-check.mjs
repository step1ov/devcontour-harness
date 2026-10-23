#!/usr/bin/env node
/**
 * F05 на рабочем дереве, без сборки: список файлов будущего архива берётся из
 * `npm pack --dry-run --ignore-scripts --json`, правило — то же, что в
 * `package-check.mjs` (`shippedRefProblems`): ссылки на инструменты checkout
 * только внутри `<!-- repo-only -->`, относительные ссылки Markdown — внутри
 * архива. Exit 1 при нарушениях.
 *
 *   node scripts/acceptance/package-docs-check.mjs [--source <repo>]
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { harnessRoot, shippedRefProblems } from './package-lib.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' } } });
const root = realpathSync(values.source ?? harnessRoot);
const [packed] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: root,
    encoding: 'utf8',
  }),
);
const files = packed.files.map((f) => f.path);
const { unshippedRefs, brokenLinks } = shippedRefProblems(root, files);
for (const r of unshippedRefs) console.log('repo-only вне области: ' + r);
for (const l of brokenLinks) console.log('ссылка вне архива: ' + l);
console.log(
  `package-docs-check: ${files.length} файлов, нарушений ${unshippedRefs.length + brokenLinks.length}`,
);
process.exit(unshippedRefs.length + brokenLinks.length ? 1 : 0);
