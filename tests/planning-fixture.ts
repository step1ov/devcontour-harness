/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Фикстура читает JSON-ответы CLI как есть; их форму проверяет сам CLI схемой команды.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approve, bin, implement } from './runner-fixture.ts';

/**
 * Проект планирования H2 через настоящий CLI: копия fixture npm-приложения в
 * своём Git, закоммиченная постановка `docs/spec.md` с `## REQ-greet`,
 * `harness init`, overlay fixture runtime (isolation none, сценарий ответов).
 *
 * Runtime `run`/`review-plan` — подставные executables `tests/fixtures/bin/fake-*`
 * со scripted-ответами (не модель). На время `plan-request`/`plan-check`
 * подставляются ловушки: каждый их запуск пишет строку в журнал.
 */
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/standalone/npm-app', import.meta.url));

const gitEnv = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

export const SPEC = 'docs/spec.md';
export const spec = (behaviour = 'greet(name) returns "Hello, <name>!" for any name.') =>
  `# Greeting\n\n## REQ-greet\n\n${behaviour}\n`;

export type Cli = { status: number | null; stdout: string; stderr: string; json: any };

export function planningProject() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-plan-')));
  const app = join(scratch, 'npm-app');
  cpSync(fixture, app, { recursive: true });
  // Точная версия менеджера, которую выбирает профиль (как в маршруте H1).
  const npm = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  pkg.packageManager = 'npm@' + npm;
  writeFileSync(join(app, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: app,
      encoding: 'utf8',
      env: { ...process.env, ...gitEnv },
    }).trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(join(app, 'docs'));
  writeFileSync(join(app, SPEC), spec());
  git('add', '-A');
  git('commit', '-qm', 'init');

  // Ловушки runtime: планирование не должно вызвать ни одну модель.
  const trapLog = join(scratch, 'trap.log');
  const trap = (name: string) => {
    const path = join(scratch, name);
    writeFileSync(
      path,
      `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(trapLog)}, ${JSON.stringify(name)} + ' ' + JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(7);\n`,
    );
    chmodSync(path, 0o755);
    return path;
  };
  const traps = { HARNESS_CODEX_BIN: trap('trap-codex'), HARNESS_CLAUDE_BIN: trap('trap-claude') };
  const fixtures = { HARNESS_CODEX_BIN: bin('fake-codex'), HARNESS_CLAUDE_BIN: bin('fake-claude') };
  const stateHome = join(scratch, 'state-home');

  const run = (runtimes: Record<string, string>, args: string[]): Cli => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd: scratch,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...gitEnv,
        NODE_OPTIONS: '',
        HARNESS_STATE_HOME: stateHome,
        ...runtimes,
      },
    });
    let json: any;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      json = undefined;
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  /** Команды планирования — с ловушками вместо runtime. */
  const planning = (...args: string[]) => run(traps, args);
  /** review-plan/run/result — с fixture runtime. */
  const harness = (...args: string[]) => run(fixtures, args);

  const init = harness('init', '--repository', app);
  if (init.status !== 0) throw new Error('init: ' + init.stderr + init.stdout);
  const facts = init.json.data.facts;
  const state: string = init.json.data.manifest.paths.state;
  const harnessDir = join(app, '.harness');
  const policyPath = join(harnessDir, 'policy.json');
  const workDir: string = facts.workDir;
  mkdirSync(workDir, { recursive: true });

  const scenario = join(scratch, 'scenario.json');
  writeFileSync(scenario, JSON.stringify({ writer: implement(), reviewer: approve() }));
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  policy.isolation = { mode: 'none', domains: [] };
  policy.environment = { values: { FIXTURE_SCENARIO: scenario } };
  writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n');

  const write = (name: string, value: unknown) => {
    const path = join(workDir, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    return path;
  };
  /** Снимок Git, который планирование не меняет: рабочее дерево и все ref. */
  const gitState = () => ({
    status: git('status', '--porcelain', '--untracked-files=all', '--ignored'),
    refs: git('for-each-ref', '--format=%(refname) %(objectname)'),
  });
  const trapCalls = () =>
    existsSync(trapLog) ? readFileSync(trapLog, 'utf8').split('\n').filter(Boolean) : [];

  return {
    scratch,
    app,
    git,
    planning,
    harness,
    facts,
    state,
    policyPath,
    workDir,
    write,
    gitState,
    trapCalls,
    scenario,
  };
}

export type PlanningProject = ReturnType<typeof planningProject>;

/** Снимки требований из prompt plan-request (T6) — то, что копирует ведущий агент. */
export function requirementsInPrompt(prompt: string) {
  const line = prompt.split('\n').find((l) => l.startsWith('Requirement snapshots at HEAD'));
  if (!line) throw new Error('В prompt нет снимков требований');
  return JSON.parse(line.slice(line.indexOf('): ') + 3)) as {
    repositoryId: string;
    source: string;
    requirements: { id: string; text: string; digest: string }[];
  }[];
}

/**
 * Draft, который пишет ведущий агент (тест в его роли): одна задача из facts
 * init (все gates: test gate требует check, validate требует его явно), requirement REQ-greet с testId из JUnit fixture и лишние ключи
 * `approved`/`status`, которые не должны дойти до графа.
 */
export function greetingDraft(
  facts: { repositoryId: string; roles: { id: string }[]; gates: { id: string; kind: string }[] },
  requirement: { id: string; text: string; digest: string },
  patch: (task: Record<string, any>) => void = () => {},
) {
  const testGate = facts.gates.find((g) => g.kind === 'test')!.id;
  const task: Record<string, any> = {
    key: 'add-greeting',
    title: 'Implement greet',
    description: 'src/greet.js exports greet(name) returning "Hello, <name>!"',
    role: facts.roles[0]!.id,
    repositoryId: facts.repositoryId,
    scope: 'component',
    writePaths: ['src'],
    gates: facts.gates.map((g) => g.id),
    dependsOn: [],
    acceptance: ['greet("Ada") returns "Hello, Ada!"'],
    contracts: [],
    requirements: [
      {
        id: requirement.id,
        source: SPEC,
        digest: requirement.digest,
        text: requirement.text,
        gate: testGate,
        scenario: 'greet("Ada") returns "Hello, Ada!"',
        testId: 'greet.greets',
      },
    ],
    approved: true,
    status: 'done',
  };
  patch(task);
  return {
    title: 'Greeting slice',
    description: 'Implement greet in the npm app.',
    approved: true,
    status: 'done',
    tasks: [task],
  };
}
