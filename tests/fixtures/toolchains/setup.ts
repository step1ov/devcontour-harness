/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-argument --
 * Фикстура читает JSON-ответ CLI как есть; его форму проверяет сам CLI схемой команды.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequirements } from '../../../src/verification/requirements.ts';

/**
 * Настоящие Git-фикстуры toolchain из `examples/toolchains/<variant>`:
 * копия `repo/` во временном каталоге, свой Git, политика и граф рядом с
 * репозиторием. Writer и reviewer — fixture executables (не живые модели).
 */
export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const examples = join(root, 'examples/toolchains');
const cli = join(root, 'src/cli.ts');
const localTools = join(root, '.private/integration-upgrade/tools/gobin');
export const PATH = [...(existsSync(localTools) ? [localTools] : []), process.env.PATH].join(
  delimiter,
);
export const has = (tool: string) =>
  PATH.split(delimiter).some((d) => d && existsSync(join(d, tool)));
/**
 * Сохранить доказательство прогона: `<evidence>/<id>/<name>.json` (каталог —
 * HARNESS_EVIDENCE_DIR, по умолчанию .private/integration-upgrade/evidence).
 */
export function saveEvidence(id: string, name: string, data: unknown) {
  const base =
    process.env.HARNESS_EVIDENCE_DIR ?? join(root, '.private/integration-upgrade/evidence');
  mkdirSync(join(base, id), { recursive: true });
  writeFileSync(
    join(base, id, name + '.json'),
    JSON.stringify({ recordedAt: new Date().toISOString(), ...(data as object) }, null, 2),
  );
}
/** Отсутствующий инструмент — явный провал BLOCKED, а не пропуск с зелёным итогом. */
export function requireTools(tools: string[]) {
  const missing = tools.filter((t) => !has(t));
  if (missing.length) throw new Error(`BLOCKED: нет ${missing.join(', ')} в PATH`);
}

function renameGitignores(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) renameGitignores(p);
    else if (e.name === '_gitignore') renameSync(p, join(dir, '.gitignore'));
  }
}
export function filesOf(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesOf(join(dir, e.name), base) : [relative(base, join(dir, e.name))],
  );
}
export const implementation = (variant: string, kind: 'good' | 'bad') => {
  const dir = join(examples, variant, kind);
  return Object.fromEntries(filesOf(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
};
export const writerStep = (files: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  files,
  result: { completed: true, summary: 'fixture implementation', discoveries: [] },
  ...extra,
});
export const approve = {
  result: {
    approved: true,
    summary: 'Критерии выполнены',
    findings: [],
    discoveries: [],
    execution: { commands: [], noCommandsReason: 'Проверка по diff и evidence' },
    previous: [],
  },
};

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

export function materialize(
  variant: string,
  options: {
    edit?: (repo: string) => void;
    policy?: (p: any) => void;
    scenario: Record<string, unknown>;
  },
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `harness-tc-${variant}-`)));
  const repo = join(dir, 'repo');
  cpSync(join(examples, variant, 'repo'), repo, { recursive: true });
  renameGitignores(repo);
  options.edit?.(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  const policy = JSON.parse(readFileSync(join(examples, variant, 'policy.json'), 'utf8'));
  git('update-ref', policy.repositories[0].targetRef, 'HEAD');
  const scenario = join(dir, 'scenario.json');
  writeFileSync(scenario, JSON.stringify(options.scenario));
  policy.environment = { values: { FIXTURE_SCENARIO: scenario } };
  options.policy?.(policy);
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy, null, 2));
  const task = JSON.parse(readFileSync(join(examples, variant, 'task.json'), 'utf8'));
  const parsed = parseRequirements(readFileSync(join(repo, 'REQUIREMENTS.md'), 'utf8'));
  writeFileSync(
    join(dir, 'graph.json'),
    JSON.stringify({
      apiVersion: 'devcontour-harness/v1alpha1',
      id: `tc-${variant}`,
      source: { connector: 'files', ref: 'graph.json', revision: '1' },
      orders: [
        {
          apiVersion: 'devcontour-harness/v1alpha1',
          id: 'pad-labels',
          source: { connector: 'files', ref: 'pad-labels', revision: '1' },
          title: task.title,
          goal: task.goal,
          acceptance: task.acceptance,
          role: 'developer',
          repositoryId: 'app',
          writeScope: task.writeScope,
          gates: task.gates,
          requirements: task.requirements.map((r: any) => {
            const found = parsed.find((p) => p.id === r.id)!;
            return {
              id: r.id,
              source: 'REQUIREMENTS.md',
              digest: found.digest,
              text: found.text,
              gate: r.gate,
              scenario: r.scenario,
              testId: r.testId,
            };
          }),
        },
      ],
    }),
  );
  const harness = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...gitEnv,
        PATH,
        NODE_OPTIONS: '',
        HARNESS_CLAUDE_BIN: join(root, 'tests/fixtures/bin/fake-claude'),
        HARNESS_CODEX_BIN: join(root, 'tests/fixtures/bin/fake-codex'),
      },
    });
    let json: any;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      json = undefined;
    }
    return { status: r.status, json, stderr: r.stderr };
  };
  const state = join(dir, 'state');
  const run = () =>
    harness('run', '--graph', 'graph.json', '--policy', 'policy.json', '--state', state);
  const count = (role: string) => {
    const file = `${scenario}.${role}.count`;
    return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  };
  return {
    dir,
    repo,
    git,
    state,
    scenario,
    policy,
    base: git('rev-parse', 'HEAD'),
    targetRef: policy.repositories[0].targetRef as string,
    harness,
    run,
    count,
  };
}
