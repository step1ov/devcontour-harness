#!/usr/bin/env node
/**
 * Приёмка R01 (Relay v1): сборка/проверка настоящего сервера, transport tests
 * (поддельный HTTP для точных отказов) и real tests против изолированного
 * сервера. Без сборки — BLOCKED с ненулевым exit (не тихий skip).
 *
 *   node scripts/acceptance/relay-v1-r01.mjs [--prepare] [--out <dir>]
 *
 * --prepare  собрать Relay v1, если сборки нет (сеть нужна для pnpm install);
 * --out      каталог evidence/logs (по умолчанию .private/integration-upgrade);
 *            пишет evidence/R01/{server.json,real-http.json,summary.json} и logs/R01/*.log.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInfo, isBuilt, prepareBuild, relayV1Paths } from './relay-v1-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outIdx = process.argv.indexOf('--out');
const out = resolve(ROOT, outIdx > 0 ? process.argv[outIdx + 1] : '.private/integration-upgrade');
const evidence = join(out, 'evidence', 'R01');
const logs = join(out, 'logs', 'R01');
mkdirSync(evidence, { recursive: true });
mkdirSync(logs, { recursive: true });

const relayHome = join(homedir(), '.relay');
const homeStamp = () => (existsSync(relayHome) ? statSync(relayHome).mtimeMs : null);
const tmpLeft = () =>
  readdirSync(tmpdir())
    .filter((n) => n.startsWith('relay-v1-'))
    .sort();

const paths = relayV1Paths();
if (!isBuilt(paths)) {
  if (process.argv.includes('--prepare')) prepareBuild(paths);
  else {
    const msg = `BLOCKED R01: Relay v1 build missing at ${paths.buildDir}; rerun with --prepare`;
    writeFileSync(
      join(evidence, 'summary.json'),
      `${JSON.stringify({ status: 'BLOCKED', reason: msg }, null, 2)}\n`,
    );
    process.stderr.write(`${msg}\n`);
    process.exit(2);
  }
}

const homeBefore = homeStamp();
const tmpBefore = tmpLeft();
const results = {};
for (const file of [
  'tests/relay-v1-transport.test.ts',
  'tests/integration/relay-v1-real.test.ts',
]) {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-timeout=120000', file],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, DC_R01_EVIDENCE: evidence },
      timeout: 600_000,
    },
  );
  const log = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(
    join(
      logs,
      `${file
        .split('/')
        .pop()
        .replace(/\.test\.ts$/, '')}.tap.log`,
    ),
    log,
  );
  const count = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(log)?.[1] ?? NaN);
  results[file] = {
    exit: r.status,
    tests: count('tests'),
    pass: count('pass'),
    fail: count('fail'),
    skipped: count('skipped'),
    todo: count('todo'),
    ids: [...log.matchAll(/^\s*(?:not )?ok \d+ - (R01[^\n]*)$/gm)].map((m) => m[1]),
  };
}

const summary = {
  run: new Date().toISOString(),
  server: buildInfo(paths),
  results,
  relayHomeUnchanged: homeStamp() === homeBefore,
  tempDirsLeft: tmpLeft().filter((n) => !tmpBefore.includes(n)),
};
const passed = Object.values(results).every(
  (r) => r.exit === 0 && r.fail === 0 && r.skipped === 0 && r.todo === 0 && r.pass > 0,
);
summary.status =
  passed && summary.relayHomeUnchanged && summary.tempDirsLeft.length === 0 ? 'PASS' : 'FAIL';
writeFileSync(join(evidence, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(summary.status === 'PASS' ? 0 : 1);
