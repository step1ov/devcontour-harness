#!/usr/bin/env node
/**
 * A02 — ядро не зависит от интеграционной среды.
 *
 *   node scripts/acceptance/core-minimal-env.mjs <devcontour-harness-<ver>.tgz>
 *     [--out <dir>] [--offline] [--keep] [--with-os-utils]
 *
 * Установка архива (production) — обычным npm. Затем каждый шаг проверки
 * выполняется с окружением, собранным с нуля: PATH — временный каталог только
 * с symlink на `node` и `git`, без переменных RELAY и HINDSIGHT и иных ключей,
 * HOME — временный. Системные утилиты процессов (`ps`, `lsof`, `sysctl`) ядро
 * находит по штатным путям ОС, не через PATH (`src/environment/os-tools.ts`).
 * `--with-os-utils` дополнительно кладёт их в PATH (прежний вариант проверки).
 *
 * Шаги: import root/contracts (без запусков процессов при импорте); файловый
 * сценарий (CLI + API + прежний хост) с gate `node`, fixture runtime;
 * `harness doctor --policy` файловой политики. Каждый node-процесс пишет
 * argv всех запусков (spawn/execFile/exec и sync) через `--require` hook —
 * и попытки запуска отсутствующих программ тоже. PASS: сценарий принят,
 * ни одна из relay/bun/pnpm/npm/npx/corepack/go/gotestsum/uv/python/docker не
 * запускалась, doctor не сообщает проблем о неиспользуемых инструментах,
 * import не загрузил opt-in интеграции.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  Recorder,
  fixtureRuntime,
  harnessRoot,
  installConsumer,
  processTrace,
  scratchDir,
  sha256File,
  tarballArg,
  writeReport,
} from './package-lib.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    offline: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    'with-os-utils': { type: 'boolean', default: false },
  },
});
const tarball = tarballArg(positionals[0]);
const work = scratchDir('harness-a02-');
const out = resolve(values.out ?? scratchDir('harness-a02-out-'));
const rec = new Recorder(join(out, 'logs'));

const consumer = join(work, 'consumer');
cpSync(join(harnessRoot, 'tests', 'fixtures', 'consumer-alpha5'), consumer, {
  recursive: true,
  filter: (p) => !p.includes('node_modules'),
});
installConsumer(rec, { dir: consumer, tarball, offline: values.offline });
const fixtures = fixtureRuntime(join(work, 'fixture-bin'));

// PATH только из node и git (и, по флагу, системных утилит наблюдения процессов).
const which = (name) => {
  const r = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  return r.status === 0 ? realpathSync(r.stdout.trim()) : undefined;
};
const bin = join(work, 'bin');
mkdirSync(bin);
const linked = { node: realpathSync(process.execPath), git: which('git') };
if (values['with-os-utils'])
  for (const name of ['ps', 'lsof', 'sysctl']) linked[name] = which(name) ?? '/usr/sbin/' + name;
for (const [name, target] of Object.entries(linked)) {
  if (!target) rec.fail('нет программы ' + name);
  else symlinkSync(target, join(bin, name));
}
const home = join(work, 'home');
mkdirSync(home);
const trace = processTrace(join(work, 'trace'));
const env = {
  PATH: bin,
  HOME: home,
  TMPDIR: join(work, 'tmp'),
  LANG: 'C.UTF-8',
  NODE_OPTIONS: trace.nodeOptions,
};
mkdirSync(env.TMPDIR);
const leakedKeys = Object.keys(env).filter((k) => /RELAY|HINDSIGHT|MEMORY|API_KEY|TOKEN/i.test(k));
rec.assert(!leakedKeys.length, 'ключи интеграций в окружении: ' + leakedKeys.join(', '));

// 1. Импорт root/contracts: ни одного процесса, opt-in модули не загружены.
const before = trace.spawned().length;
const imported = rec.run(
  'import root + contracts',
  linked.node,
  [
    '--input-type=module',
    '-e',
    "const m = await import('devcontour-harness'); const c = await import('devcontour-harness/contracts'); if (m.API_VERSION !== c.API_VERSION) throw new Error('API_VERSION'); console.log(JSON.stringify({ version: m.HARNESS_VERSION, root: Object.keys(m).length, contracts: Object.keys(c).length }));",
  ],
  { cwd: consumer, env },
);
rec.assert(imported.status === 0, 'import: ' + imported.stderr);
const importSpawned = trace.spawned().slice(before);
// При импорте допустимы только пробы идентичности процесса ядра (`ps -o lstart`,
// `sysctl kern.boottime` — владение live-вызовами, так было и в alpha.5).
const identityProbe = (s) =>
  (s.file.split('/').pop() === 'ps' && s.args[0] === '-o' && s.args[1] === 'lstart=') ||
  (s.file.split('/').pop() === 'sysctl' && s.args.join(' ') === '-n kern.boottime');
const importOther = importSpawned.filter((s) => !identityProbe(s));
rec.assert(!importOther.length, 'import запустил процессы: ' + JSON.stringify(importOther));
const importModules = trace
  .modules()
  .filter((u) => u.includes('/devcontour-harness/lib/'))
  .map((u) => u.replace(/^.*\/devcontour-harness\//, ''));
const importOptIn = importModules.filter((m) => m.startsWith('lib/integrations/'));
rec.assert(!importOptIn.length, 'import загрузил интеграции: ' + importOptIn.join(', '));

// 2. Файловый сценарий: gate `node`, fixture runtime.
const scenarioWork = join(work, 'scenario');
const scenario = rec.run(
  'file scenario (gate node, fixture runtime)',
  linked.node,
  ['src/scenario.mts'],
  {
    cwd: consumer,
    env: { ...env, SCENARIO_WORK: scenarioWork, SCENARIO_BIN: fixtures, SCENARIO_GATE: 'node' },
  },
);
let result = {};
try {
  result = JSON.parse(readFileSync(join(scenarioWork, 'scenario.json'), 'utf8'));
} catch {
  /* нет отчёта — сценарий упал раньше */
}
rec.assert(scenario.status === 0, 'сценарий: ' + (result.failure ?? scenario.stderr.slice(-3000)));
for (const flow of ['cli', 'api', 'host'])
  rec.assert(result[flow]?.outcome === 'accepted', `поток ${flow}: ${result[flow]?.outcome}`);

// 3. Doctor файловой политики сценария (gate node): проблем о неиспользуемых инструментах нет.
const policyFile = join(scenarioWork, 'notes-cli', 'policy.json');
const doctor = rec.run(
  'harness doctor --policy (file scenario)',
  join(consumer, 'node_modules', '.bin', 'harness'),
  ['doctor', '--policy', policyFile],
  {
    cwd: scenarioWork,
    env: {
      ...env,
      HARNESS_CLAUDE_BIN: join(fixtures, 'fake-claude'),
      HARNESS_CODEX_BIN: join(fixtures, 'fake-codex'),
    },
  },
);
let doctorData;
try {
  doctorData = JSON.parse(doctor.stdout).data;
} catch {
  rec.fail('doctor: не JSON: ' + doctor.stdout.slice(0, 500) + doctor.stderr.slice(0, 500));
}
const unusedTools = /\b(relay|bun|pnpm|npm|npx|corepack|go|gotestsum|uv|python3?|docker|turbo)\b/i;
const doctorProblems = doctorData?.problems ?? [];
const toolProblems = doctorProblems.filter((p) => unusedTools.test(String(p)));
rec.assert(
  !toolProblems.length,
  'doctor требует неиспользуемые инструменты: ' + toolProblems.join('; '),
);

// Процессы: ни одна интеграционная программа не запускалась (даже безуспешно).
const forbidden =
  /^(relay|relay-2|relay2|bun|bunx|pnpm|npm|npx|corepack|yarn|go|gotestsum|uv|uvx|python|python3|pip|pip3|docker|docker-compose|turbo)$/;
const spawned = trace.spawned();
const programs = [...new Set(spawned.map((s) => s.file.split('/').pop().split(/\s+/)[0]))].sort();
const attempted = spawned.filter((s) => forbidden.test(s.file.split('/').pop().split(/\s+/)[0]));
rec.assert(
  !attempted.length,
  'запущены интеграционные программы: ' + JSON.stringify(attempted.slice(0, 10)),
);
const shellCommands = spawned
  .filter((s) => s.fn === 'exec' || s.fn === 'execSync')
  .map((s) => s.file);
for (const command of shellCommands)
  rec.assert(!forbidden.test(command.split(/\s+/)[0]), 'shell запускал ' + command);

// Установленный lib: нет ссылок на соседние checkout и машинные пути.
const libDir = join(consumer, 'node_modules', 'devcontour-harness', 'lib');
const libLeaks = readdirSync(libDir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.js'))
  .filter((f) =>
    /['"](\.\.\/)+(devcontour|relay|relay-2|turbo-starter|hindsight)(\/|['"])|PhpstormProjects|\/Users\/|\/home\//.test(
      readFileSync(join(libDir, f), 'utf8'),
    ),
  );
rec.assert(
  !libLeaks.length,
  'lib ссылается на соседние checkout/пути машины: ' + libLeaks.join(', '),
);

const report = {
  id: 'A02',
  status: rec.failures.length ? 'FAIL' : 'PASS',
  tarball: { file: tarball, sha256: sha256File(tarball) },
  environment: {
    PATH: Object.keys(linked),
    linked,
    envKeys: Object.keys(env).sort(),
    osUtilsInPath: values['with-os-utils'],
  },
  import: {
    exit: imported.status,
    output: imported.stdout.trim(),
    spawned: importSpawned,
    optInModules: importOptIn,
  },
  scenario: result,
  doctor: {
    exit: doctor.status,
    problems: doctorProblems,
    toolProblems,
    runtimes: doctorData?.runtimes,
    toolchain: doctorData?.toolchain ?? doctorData?.toolchains,
  },
  processes: { count: spawned.length, programs, forbiddenAttempted: attempted },
  libLeaks,
  failures: rec.failures,
  steps: rec.steps,
};
writeReport(join(out, 'report.json'), report);
writeReport(join(out, 'spawned.json'), spawned);
console.log(
  `A02 ${report.status}: PATH=[${Object.keys(linked).join(',')}] programs=[${programs.join(',')}] forbidden=${attempted.length} doctor problems=${doctorProblems.length} (tool ${toolProblems.length}) flows ${[
    'cli',
    'api',
    'host',
  ]
    .map((f) => f + '=' + (result[f]?.outcome ?? 'n/a'))
    .join(' ')}; report ${join(out, 'report.json')}`,
);
if (!values.keep && !rec.failures.length) rmSync(work, { recursive: true, force: true });
else console.log('work dir kept: ' + work);
process.exit(rec.failures.length ? 1 : 0);
