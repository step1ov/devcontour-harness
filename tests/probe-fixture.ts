import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeGate, ProbeResult, ProbeSpec } from '../src/agents/review-probe.ts';
import { repo } from './git-fixture.ts';

/**
 * Runner приёмочных тестов как у demo-стенда: JUnit — в
 * DEVCONTOUR_REPORT_PATH/HARNESS_REPORT_PATH, иначе в `.reports/<suite>.xml`;
 * прежний отчёт удаляется до запуска. Именно это удаление в дереве только для
 * чтения давало EPERM на пилоте.
 */
export const demoRunner = `import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const suites = { domain: 30000, api: 60000, broken: 30000 };
const suite = process.argv[2];
if (!(suite in suites)) { console.error('unknown suite ' + suite); process.exit(2); }
const report = resolve(process.env.DEVCONTOUR_REPORT_PATH || process.env.HARNESS_REPORT_PATH || '.reports/' + suite + '.xml');
mkdirSync(dirname(report), { recursive: true });
rmSync(report, { force: true });
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=junit', '--test-reporter-destination=' + report,
  'test/' + suite + '.test.mjs'], { stdio: 'inherit', env: process.env });
let size = 0;
try { size = statSync(report).size; } catch {}
if (!size) { console.error('JUnit not written: ' + report); process.exit(result.status || 1); }
console.log('JUnit: ' + report + ' (' + size + ' bytes)');
process.exit(result.status ?? 1);
`;

const suite = (name: string, cases: string[], fail = false) =>
  `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n` +
  cases
    .map(
      (c, i) =>
        `test(${JSON.stringify(`${name}: ${c}`)}, () => assert.equal(${fail && i === 0 ? 1 : 0}, 0));`,
    )
    .join('\n') +
  '\n';

/** Пакет с относительным cwd: свой runner, отчёт — тоже по переменной controller. */
const subRunner = `const fs = require('fs');
const out = process.env.HARNESS_REPORT_PATH || '.reports/sub.xml';
fs.mkdirSync(require('path').dirname(out), { recursive: true });
fs.writeFileSync(out, '<testsuite><testcase classname="sub" name="cwd is ' + require('path').basename(process.cwd()) + '"/></testsuite>');
`;

export const candidateFiles: Record<string, string> = {
  'README.md': 'demo\n',
  '.gitignore': '**/.reports/*.xml\n',
  '.reports/README.md': 'reports land here when the runner has no REPORT_PATH\n',
  'test/run-tests.mjs': demoRunner,
  'test/domain.test.mjs': suite('domain', ['books a slot', 'rejects overlap']),
  'test/api.test.mjs': suite('api', ['POST /bookings 201', 'invalid JSON 400', 'GET /slots']),
  'test/broken.test.mjs': suite('broken', ['fails on purpose', 'passes'], true),
  'packages/sub/run.cjs': subRunner,
};

/** Gates как в политике demo: команды из policy, отчёты внутри дерева. */
export const demoGates: ProbeGate[] = [
  {
    id: 'domain',
    kind: 'test',
    command: [process.execPath, 'test/run-tests.mjs', 'domain'],
    timeoutMs: 60000,
    report: { type: 'junit', path: '.reports/domain.xml' },
  },
  {
    id: 'api',
    kind: 'test',
    command: [process.execPath, 'test/run-tests.mjs', 'api'],
    timeoutMs: 60000,
    report: { type: 'junit', path: '.reports/api.xml' },
  },
  {
    id: 'sub',
    kind: 'test',
    cwd: 'packages/sub',
    command: [process.execPath, 'run.cjs'],
    timeoutMs: 60000,
    report: { type: 'junit', path: 'packages/sub/.reports/sub.xml' },
  },
];

/** Прежние отчёты в дереве: старше любого запуска и с узнаваемым содержимым. */
export const staleXml = (name: string) =>
  `<testsuite name="${name}"><testcase classname="old" name="stale ${name}"/></testsuite>`;

export const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * Проверяемое дерево: Git-репозиторий с demo runner, прежними
 * `.reports/domain.xml`/`api.xml` (игнорируются Git, как на стенде) и
 * каталогом controller рядом (закрыт проверке).
 */
export function candidate(files: Record<string, string> = {}) {
  const r = repo({ ...candidateFiles, ...files });
  for (const name of ['domain', 'api'])
    writeFileSync(join(r.dir, '.reports', `${name}.xml`), staleXml(name));
  const controller = realpathSync(mkdtempSync(join(tmpdir(), 'harness-probe-controller-')));
  const review = join(controller, 'candidate', 'review');
  mkdirSync(review, { recursive: true });
  return {
    ...r,
    controller,
    review,
    cleanup: () => {
      rmSync(r.dir, { recursive: true, force: true });
      rmSync(controller, { recursive: true, force: true });
    },
  };
}

export function probeSpecFor(
  c: ReturnType<typeof candidate>,
  overrides: Partial<ProbeSpec> = {},
): ProbeSpec {
  return {
    cwd: c.dir,
    controller: [c.controller],
    readable: [c.dir],
    isolation: { mode: 'os', domains: [] },
    commandTimeoutMs: 90000,
    budgetMs: 600000,
    deadline: Date.now() + 900000,
    env: ['PATH', 'HOME'],
    secrets: [],
    settingsDir: join(c.review, 'probe-settings'),
    log: join(c.review, 'probes.jsonl'),
    gates: demoGates,
    phase: 'candidate',
    sha: c.head(),
    artifacts: join(c.review, 'probe-runs'),
    ...overrides,
  };
}

/** Evidence приёмки — только при явно заданном каталоге (прогон приёмки, не обычный тест). */
export function saveEvidence(id: string, name: string, data: unknown) {
  const root = process.env.PROBE_EVIDENCE_DIR;
  if (!root) return;
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, name), JSON.stringify(data, null, 2) + '\n');
}

/** Минимальный stdio-клиент MCP: запрос — ответ с тем же id; уведомления — без ответа. */
export function mcpClient(command: string, args: string[], timeoutMs = 120000) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let buffer = '';
  let stderr = '';
  const waiting = new Map<number, (message: McpMessage) => void>();
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as McpMessage;
      if (typeof message.id === 'number') {
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
    }
  });
  let next = 1;
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
  return {
    /** Запрос и его id (для отмены). */
    start(method: string, params: unknown) {
      const id = next++;
      const response = new Promise<McpMessage>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`MCP ${method}: нет ответа за ${timeoutMs} мс; ${stderr}`)),
          timeoutMs,
        );
        waiting.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
      send({ jsonrpc: '2.0', id, method, params });
      return { id, response };
    },
    request(method: string, params: unknown) {
      return this.start(method, params).response;
    },
    notify(method: string, params?: unknown) {
      send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    },
    async handshake() {
      await this.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'probe-test', version: '1' },
      });
      this.notify('notifications/initialized');
    },
    close() {
      child.kill();
    },
  };
}
export interface McpMessage {
  id?: number;
  result?: { structuredContent?: ProbeResult; tools?: { name: string; description: string }[] };
  error?: { code: number; message: string };
}
