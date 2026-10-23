#!/usr/bin/env node
/**
 * Приёмка общего набора коннектора (W02–W05, D01–D06, R04) и D02 с настоящим
 * получателем на изолированном Relay v1. Без сборки — BLOCKED (exit 2).
 *
 *   node scripts/acceptance/relay-v1-suite.mjs [--out <dir>]
 *
 * Пишет evidence/<ID>/relay-v1/result.json (тесты ID, pass/fail, сервер),
 * evidence/D02/relay-v1/*.json (proxy, read-back, шаги операции) и
 * logs/<ID>/relay-v1/*.tap.log.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInfo, isBuilt, relayV1Paths } from './relay-v1-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outIdx = process.argv.indexOf('--out');
const out = resolve(ROOT, outIdx > 0 ? process.argv[outIdx + 1] : '.private/integration-upgrade');
const IDS = ['W02', 'W03', 'W04', 'W05', 'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'R04'];

const paths = relayV1Paths();
if (!isBuilt(paths)) {
  process.stderr.write(`BLOCKED: Relay v1 build missing at ${paths.buildDir}\n`);
  for (const id of IDS) {
    const dir = join(out, 'evidence', id, 'relay-v1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'result.json'),
      `${JSON.stringify({ id, status: 'BLOCKED' }, null, 2)}\n`,
    );
  }
  process.exit(2);
}
const server = buildInfo(paths);
const files = [
  'tests/integration/relay-v1-suite.test.ts',
  'tests/integration/relay-v1-d02.test.ts',
];
const cases = [];
const logs = {};
for (const file of files) {
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=1',
      '--test-reporter=tap',
      '--test-timeout=1800000',
      file,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, DC_CONNECTOR_EVIDENCE: join(out, 'evidence') },
      timeout: 3_600_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const log = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  logs[file] = log;
  for (const m of log.matchAll(/^(not ok|ok) \d+ - (.+)$/gm))
    cases.push({ ok: m[1] === 'ok', name: m[2], file });
  if (r.status !== 0 && !cases.some((c) => c.file === file && !c.ok))
    cases.push({ ok: false, name: `${file}: exit ${r.status}`, file });
}
let all = true;
const summary = {};
for (const id of IDS) {
  const mine = cases.filter((c) => c.name.startsWith(`${id}/relay-v1`));
  const status = mine.length && mine.every((c) => c.ok) ? 'PASS' : 'FAIL';
  if (status !== 'PASS') all = false;
  summary[id] = {
    status,
    pass: mine.filter((c) => c.ok).length,
    fail: mine.filter((c) => !c.ok).length,
  };
  const ev = join(out, 'evidence', id, 'relay-v1');
  const lg = join(out, 'logs', id, 'relay-v1');
  mkdirSync(ev, { recursive: true });
  mkdirSync(lg, { recursive: true });
  writeFileSync(
    join(ev, 'result.json'),
    `${JSON.stringify({ id, status, run: new Date().toISOString(), server, tests: mine }, null, 2)}\n`,
  );
  for (const [file, log] of Object.entries(logs))
    if (mine.some((c) => c.file === file))
      writeFileSync(
        join(
          lg,
          `${file
            .split('/')
            .pop()
            .replace(/\.test\.ts$/, '')}.tap.log`,
        ),
        log,
      );
}
process.stdout.write(`${JSON.stringify({ server, summary }, null, 2)}\n`);
process.exit(all ? 0 : 1);
