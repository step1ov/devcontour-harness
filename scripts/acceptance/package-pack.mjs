#!/usr/bin/env node
/**
 * Упаковка архива из одноразовой копии исходников (C01): рабочее дерево не
 * собирается и не чистится — `lib/` checkout не трогается. Копия получает
 * чистую установку (`npm ci`), `npm pack` выполняет prepack (schemas:check +
 * build) в копии. Печатает JSON { tarball, sha256, integrity, files }.
 *
 *   node scripts/acceptance/package-pack.mjs [--source <repo>] [--out <dir>] [--offline]
 *
 * `--source` по умолчанию — репозиторий, в котором лежит скрипт.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    out: { type: 'string' },
    offline: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});
const source = realpathSync(values.source ?? fileURLToPath(new URL('../..', import.meta.url)));
const out = resolve(values.out ?? process.cwd());
mkdirSync(out, { recursive: true });
const work = realpathSync(mkdtempSync(join(tmpdir(), 'harness-pack-')));
const copy = join(work, 'h');
const skip = new Set(['node_modules', '.private', 'lib', '.git']);
cpSync(source, copy, {
  recursive: true,
  filter: (p) => {
    const rel = relative(source, p);
    return !rel.split(sep).some((part) => skip.has(part));
  },
});
const npm = (args) =>
  execFileSync('npm', args, { cwd: copy, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
npm(['ci', '--no-audit', '--no-fund', values.offline ? '--offline' : '--prefer-offline']);
const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', out]));
const tarball = join(out, packed.filename);
const bytes = readFileSync(tarball);
console.log(
  JSON.stringify(
    {
      tarball,
      version: packed.version,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      files: packed.files.length,
      work: values.keep ? work : undefined,
    },
    null,
    2,
  ),
);
if (!values.keep) rmSync(work, { recursive: true, force: true });
