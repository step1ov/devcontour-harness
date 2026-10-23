import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HarnessError,
  executionPolicySchema,
  initDataSchema,
  projectManifestSchema,
} from '../src/contracts/index.ts';
import { resolveProfile } from '../src/profiles/resolve.ts';
import type { ToolProbe } from '../src/toolchains/probe.ts';
import { detectProfile, generatePolicy } from '../src/init/policy.ts';
import {
  defaultStateDir,
  initProject,
  initText,
  planProject,
  projectIdOf,
  readProjectManifest,
  type InitOptions,
} from '../src/init/project.ts';

const fixture = fileURLToPath(new URL('./fixtures/standalone/npm-app', import.meta.url));
const NPM = '11.4.2'; // pin профиля npm-ci: проба отвечает им, живой npm не нужен
const probe: ToolProbe = (argv) =>
  Promise.resolve({
    code: 0,
    stdout: argv.some((a) => /(^|\/)npm(-cli\.js)?$/.test(a)) ? NPM + '\n' : 'v24.3.0\n',
    stderr: '',
    timedOut: false,
  });

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Копия fixture npm-приложения в собственном Git с коммитом. */
function project(edit?: (dir: string) => void, options: { commit?: boolean } = {}) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-init-')));
  const root = join(scratch, 'app');
  cpSync(fixture, root, { recursive: true });
  edit?.(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  git('init', '-q', '-b', 'main');
  if (options.commit !== false) {
    git('add', '-A');
    git('commit', '-qm', 'init');
  }
  const env = { ...process.env, HARNESS_STATE_HOME: join(scratch, 'state-home') };
  const opts = (extra: Partial<InitOptions> = {}): InitOptions => ({
    repository: root,
    env,
    probe,
    ...extra,
  });
  return { scratch, root, git, env, opts };
}

/** Всё вне `.harness/`: относительный путь → sha256, плюс git status без `.harness/`. */
function outside(root: string) {
  const files: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (r === '.git' || r === '.harness') continue;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else files[r] = e.isSymbolicLink() ? 'symlink' : sha(readFileSync(join(dir, e.name)));
    }
  };
  walk(root, '');
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((l) => l && !l.startsWith('?? .harness/') && !l.startsWith('?? .harness'));
  const head = execFileSync('git', ['rev-parse', '-q', '--verify', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return { files, status, head };
}

const refusal = async (promise: Promise<unknown>, code: string) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HarnessError, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail('ожидался отказ ' + code);
};
const rel = (root: string, paths: string[]) => paths.map((p) => p.slice(root.length + 1));
const ORDER = ['.harness/.gitignore', '.harness/README.md', '.harness/policy.json'];
const ALL = [...ORDER, '.harness/project.json'];

test('H1-02: projectIdOf/defaultStateDir/detectProfile детерминированы', () => {
  const p = project();
  const id = projectIdOf(p.root);
  assert.match(id, /^p-[0-9a-f]{16}$/);
  assert.equal(id, 'p-' + createHash('sha256').update(p.root).digest('hex').slice(0, 16));
  assert.equal(projectIdOf(p.root + '/.'), id);
  assert.equal(defaultStateDir(id, { HARNESS_STATE_HOME: '/h' }), `/h/projects/${id}`);
  assert.equal(
    defaultStateDir(id, { XDG_STATE_HOME: '/x' }),
    `/x/devcontour-harness/projects/${id}`,
  );
  assert.equal(
    defaultStateDir(id, { HOME: '/u' }),
    `/u/.local/state/devcontour-harness/projects/${id}`,
  );
  assert.deepEqual(detectProfile(p.root), { id: 'npm-ci', lockfile: 'package-lock.json' });
  writeFileSync(join(p.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  assert.deepEqual(detectProfile(p.root), {
    problem: 'stack-ambiguous',
    files: ['package-lock.json', 'pnpm-lock.yaml'],
  });
  rmSync(join(p.root, 'package-lock.json'));
  assert.deepEqual(detectProfile(p.root), { id: 'pnpm-frozen', lockfile: 'pnpm-lock.yaml' });
  rmSync(join(p.root, 'pnpm-lock.yaml'));
  assert.deepEqual(detectProfile(p.root), { problem: 'stack-unsupported', files: [] });
});

test('H1-02: generatePolicy — профиль, .harness/ защищён, reviewer другого вендора, packageManager заменяет pin', () => {
  const profile = resolveProfile('npm-ci');
  const plain = generatePolicy({ profile, writer: 'codex' });
  const policy = executionPolicySchema.parse(plain.input);
  assert.deepEqual(JSON.parse(plain.text), plain.input);
  assert.equal(policy.roles.developer?.writer.runtime, 'codex');
  for (const k of ['code', 'plan', 'contract'] as const)
    assert.equal(policy.review[k].reviewer.runtime, 'claude');
  assert.equal(policy.isolation.mode, 'os');
  assert.equal(policy.approvalMode, 'agent');
  assert.equal(policy.maxAttempts, 3);
  const repo = policy.repositories[0]!;
  assert.equal(repo.path, '..');
  assert.equal(repo.targetRef, 'refs/heads/harness/accepted');
  assert.ok(repo.protectedPaths.includes('.harness/'));
  assert.ok(repo.protectedPaths.includes('package-lock.json'));
  assert.deepEqual(
    repo.gates.map((g) => [g.id, g.kind]),
    [
      ['check', 'check'],
      ['unit-tests', 'test'],
    ],
  );
  assert.equal(repo.toolchain?.tools.npm, '11.4.2');
  assert.deepEqual(plain.shadowed, []);
  const pinned = generatePolicy({
    profile,
    writer: 'claude',
    packageManager: { name: 'npm', version: '11.6.0' },
  });
  const repo2 = executionPolicySchema.parse(pinned.input).repositories[0]!;
  assert.equal(repo2.toolchain?.tools.npm, '11.6.0');
  assert.deepEqual(pinned.shadowed, ['toolchain']);
  // Другой менеджер не меняет pin профиля.
  const other = generatePolicy({
    profile,
    writer: 'claude',
    packageManager: { name: 'pnpm', version: '10.0.0' },
  });
  assert.equal(executionPolicySchema.parse(other.input).repositories[0]!.toolchain?.tools.npm, NPM);
});

test('H1-02: первый запуск — порядок created, manifest последним, данные по схеме', async () => {
  const p = project();
  const before = outside(p.root);
  const data = await initProject(p.opts());
  initDataSchema.parse(data);
  assert.equal(data.mode, 'apply');
  assert.equal(data.status, 'new');
  assert.deepEqual(rel(p.root, data.created), ALL);
  assert.deepEqual(data.preserved, []);
  assert.equal(data.conflicts, 0);
  assert.equal(data.toolchain.ready, true, data.toolchain.problems.join('\n'));
  const manifestText = readFileSync(join(p.root, '.harness/project.json'), 'utf8');
  assert.equal(manifestText, JSON.stringify(data.manifest, null, 2) + '\n');
  const manifest = projectManifestSchema.parse(JSON.parse(manifestText));
  assert.equal(manifest.root, p.root);
  assert.equal(manifest.projectId, projectIdOf(p.root));
  assert.equal(manifest.paths.state, defaultStateDir(manifest.projectId, p.env));
  assert.equal(manifest.profile.ref, 'npm-ci');
  assert.deepEqual(manifest.runtimes, { writer: 'claude', reviewer: 'codex' });
  assert.equal(readFileSync(join(p.root, '.harness/.gitignore'), 'utf8'), '/project.json\n');
  executionPolicySchema.parse(
    JSON.parse(readFileSync(join(p.root, '.harness/policy.json'), 'utf8')),
  );
  assert.equal(existsSync(manifest.paths.state), false, 'init не создаёт state');
  assert.deepEqual(await readProjectManifest(p.root), manifest);
  assert.equal(data.facts.repositoryId, 'app');
  assert.deepEqual(data.facts.roles, [{ id: 'developer', runtime: 'claude' }]);
  assert.deepEqual(data.facts.gates, [
    { id: 'check', kind: 'check' },
    { id: 'unit-tests', kind: 'test' },
  ]);
  assert.equal(data.facts.notesDir, join(p.root, '.harness/work/context/notes'));
  assert.ok(existsSync(data.facts.graphTemplate));
  assert.deepEqual(
    data.next.map((n) => n.command),
    ['doctor', 'validate', 'run', 'status', 'explain'],
  );
  assert.match(initText(data), /^init apply: new p-/);
  assert.deepEqual(outside(p.root), before);
  // .harness/project.json не под Git, остальное — видно.
  const untracked = p.git('status', '--porcelain', '--untracked-files=all').split('\n');
  assert.ok(!untracked.includes('?? .harness/project.json'));
  assert.ok(untracked.includes('?? .harness/policy.json'));
});

test('H1-02: повтор — всё preserve, created пуст, тот же projectId и state', async () => {
  const p = project();
  const first = await initProject(p.opts());
  const before = outside(p.root);
  const again = await initProject(p.opts());
  assert.equal(again.status, 'complete');
  assert.deepEqual(again.created, []);
  assert.deepEqual(rel(p.root, again.preserved), ALL);
  assert.ok(again.files.every((f) => f.action === 'preserve'));
  assert.equal(again.projectId, first.projectId);
  assert.equal(again.manifest.paths.state, first.manifest.paths.state);
  assert.deepEqual(outside(p.root), before);
});

test('H1-02: решения manifest по умолчанию; пользовательская политика сохраняется и проверяется', async () => {
  const p = project();
  const state = join(p.scratch, 'custom-state');
  await initProject(p.opts({ writer: 'codex', state }));
  const policyPath = join(p.root, '.harness/policy.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
  policy.maxAttempts = 2;
  const custom = JSON.stringify(policy, null, 2) + '\n';
  writeFileSync(policyPath, custom);
  const before = outside(p.root);
  // Новая сессия без аргументов: writer и state из manifest, политика агента — как есть.
  const planned = await planProject(p.opts());
  assert.equal(planned.status, 'complete');
  assert.equal(planned.manifest.runtimes.writer, 'codex');
  assert.equal(planned.manifest.paths.state, state);
  assert.equal(planned.policy.maxAttempts, 2);
  assert.equal(planned.plan.conflicts, 0);
  const data = await initProject(p.opts());
  assert.deepEqual(data.created, []);
  assert.equal(readFileSync(policyPath, 'utf8'), custom);
  assert.deepEqual(outside(p.root), before);
  // Проблема сохранённой политики видна toolchain, а не перекрыта сгенерированной.
  const broken = JSON.parse(custom) as { repositories: { gates: { command: string[] }[] }[] };
  broken.repositories[0]!.gates[0]!.command = ['npm', 'run', 'lint'];
  writeFileSync(policyPath, JSON.stringify(broken));
  const blocked = await initProject(p.opts({ plan: true }));
  assert.equal(blocked.toolchain.ready, false);
  assert.match(blocked.toolchain.problems.join('\n'), /SCRIPT_UNKNOWN/);
});

test('H1-02: новая сессия — --plan без аргументов даёт manifest и complete, ничего не пишет', async () => {
  const p = project();
  const first = await initProject(p.opts({ writer: 'codex', profile: 'npm-ci' }));
  const before = outside(p.root);
  const harnessBefore = readdirSync(join(p.root, '.harness')).sort();
  const plan = await initProject({ repository: p.root, env: p.env, probe, plan: true });
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.status, 'complete');
  assert.deepEqual(plan.manifest, first.manifest);
  assert.equal(plan.conflicts, 0);
  assert.deepEqual(plan.created, []);
  assert.deepEqual(readdirSync(join(p.root, '.harness')).sort(), harnessBefore);
  assert.deepEqual(outside(p.root), before);
});

test('H1-02: иной --writer или профиль при существующем manifest → PATH_CONFLICT content-differs', async () => {
  const p = project();
  await initProject(p.opts());
  const manifestPath = join(p.root, '.harness/project.json');
  const bytes = readFileSync(manifestPath, 'utf8');
  const before = outside(p.root);
  const plan = await initProject(p.opts({ writer: 'codex', plan: true }));
  assert.equal(plan.conflicts, 1);
  assert.deepEqual(plan.files.at(-1), {
    path: manifestPath,
    action: 'conflict',
    conflict: 'content-differs',
  });
  const error = await refusal(initProject(p.opts({ writer: 'codex' })), 'PATH_CONFLICT');
  assert.deepEqual(error.issues, [{ path: [manifestPath], message: 'content-differs' }]);
  await refusal(initProject(p.opts({ profile: 'node-checks' })), 'PATH_CONFLICT');
  await refusal(initProject(p.opts({ state: join(p.scratch, 'elsewhere') })), 'PATH_CONFLICT');
  assert.equal(readFileSync(manifestPath, 'utf8'), bytes);
  assert.deepEqual(outside(p.root), before);
});

test('H1-02: прерывание после k записей (k=1..3) — partial, дописывается недостающее, manifest последним', async () => {
  for (const k of [1, 2, 3]) {
    const p = project();
    const planned = await planProject(p.opts());
    assert.equal(planned.status, 'new');
    assert.deepEqual(
      rel(
        p.root,
        planned.intents.map((i) => i.path),
      ),
      ALL,
    );
    for (const intent of planned.intents.slice(0, k)) {
      mkdirSync(join(intent.path, '..'), { recursive: true });
      writeFileSync(intent.path, intent.content);
    }
    const before = outside(p.root);
    const data = await initProject(p.opts());
    assert.equal(data.status, 'partial', 'k=' + k);
    assert.deepEqual(rel(p.root, data.created), ALL.slice(k), 'k=' + k);
    assert.deepEqual(rel(p.root, data.preserved), ALL.slice(0, k), 'k=' + k);
    assert.equal(data.projectId, planned.manifest.projectId);
    assert.equal(data.manifest.paths.state, planned.manifest.paths.state);
    assert.deepEqual(outside(p.root), before);
  }
});

test('H1-02: обрезанный policy.json → INVALID_INPUT с путём, файл не перезаписан', async () => {
  const p = project();
  const planned = await planProject(p.opts());
  const [gitignore, readme, policy] = planned.intents;
  mkdirSync(join(p.root, '.harness'));
  for (const i of [gitignore!, readme!]) writeFileSync(i.path, i.content);
  const torn = policy!.content.slice(0, 40);
  writeFileSync(policy!.path, torn);
  const before = outside(p.root);
  const error = await refusal(initProject(p.opts()), 'INVALID_INPUT');
  assert.deepEqual(error.issues[0]?.path, [policy!.path]);
  assert.equal(readFileSync(policy!.path, 'utf8'), torn);
  assert.equal(existsSync(join(p.root, '.harness/project.json')), false);
  // Валидный JSON, но не политика — тоже отказ с путём.
  writeFileSync(policy!.path, '{"policyVersion":1}');
  const schema = await refusal(initProject(p.opts({ plan: true })), 'INVALID_INPUT');
  assert.equal(schema.issues[0]?.path[0], policy!.path);
  assert.deepEqual(outside(p.root), before);
});

test('H1-02: невалидный manifest → INVALID_INPUT с путём (раньше выбора профиля)', async () => {
  const p = project((dir) => writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n'));
  mkdirSync(join(p.root, '.harness'));
  const manifestPath = join(p.root, '.harness/project.json');
  writeFileSync(manifestPath, '{"kind":"harness-project"}');
  const error = await refusal(initProject(p.opts()), 'INVALID_INPUT');
  assert.equal(error.issues[0]?.path[0], manifestPath);
  writeFileSync(manifestPath, '{');
  const json = await refusal(readProjectManifest(p.root), 'INVALID_INPUT');
  assert.deepEqual(json.issues[0]?.path, [manifestPath]);
});

test('H1-02: .harness — symlink наружу → PATH_CONFLICT symlink, наружу ничего не пишется', async () => {
  const p = project();
  const outsideDir = join(p.scratch, 'elsewhere');
  mkdirSync(outsideDir);
  symlinkSync(outsideDir, join(p.root, '.harness'));
  const before = outside(p.root);
  const plan = await initProject(p.opts({ plan: true }));
  assert.equal(plan.conflicts, 4);
  for (const f of plan.files) {
    assert.equal(f.action, 'conflict');
    assert.equal(f.conflict, 'symlink');
    assert.equal(f.conflictPath, join(p.root, '.harness'));
  }
  const error = await refusal(initProject(p.opts()), 'PATH_CONFLICT');
  assert.equal(error.issues.length, 4);
  assert.deepEqual(error.issues[0], { path: [join(p.root, '.harness')], message: 'symlink' });
  assert.deepEqual(readdirSync(outsideDir), []);
  assert.deepEqual(outside(p.root), before);
});

test('H1-02: .harness — обычный файл → PATH_CONFLICT ancestor-not-directory', async () => {
  const p = project();
  writeFileSync(join(p.root, '.harness'), 'not a dir\n');
  const before = outside(p.root);
  const error = await refusal(initProject(p.opts()), 'PATH_CONFLICT');
  assert.deepEqual(error.issues[0], {
    path: [join(p.root, '.harness')],
    message: 'ancestor-not-directory',
  });
  assert.equal(readFileSync(join(p.root, '.harness'), 'utf8'), 'not a dir\n');
  assert.deepEqual(outside(p.root), before);
});

test('H1-02: DevContour-репозиторий → CONTROLLER_BUSY, ничего не создаётся', async () => {
  for (const marker of ['devcontour.config.json', '.devcontour-local']) {
    const p = project((dir) =>
      marker.endsWith('.json')
        ? writeFileSync(join(dir, marker), '{}\n')
        : mkdirSync(join(dir, marker)),
    );
    // Пункт 3 раньше 5: без lockfile всё равно CONTROLLER_BUSY.
    rmSync(join(p.root, 'package-lock.json'));
    const before = outside(p.root);
    for (const plan of [true, false]) {
      const error = await refusal(initProject(p.opts({ plan })), 'CONTROLLER_BUSY');
      assert.deepEqual(error.issues, [
        { path: [join(p.root, marker)], message: 'devcontour-owned' },
      ]);
      assert.match(error.message, /Репозиторием владеет DevContour/);
    }
    assert.equal(existsSync(join(p.root, '.harness')), false);
    assert.equal(existsSync(join(p.scratch, 'state-home')), false);
    assert.deepEqual(outside(p.root), before);
  }
});

test('H1-02: --plan ничего не пишет', async () => {
  const p = project();
  const before = outside(p.root);
  const plan = await initProject(p.opts({ plan: true }));
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.status, 'new');
  assert.ok(plan.files.every((f) => f.action === 'create'));
  assert.deepEqual(plan.created, []);
  assert.equal(existsSync(join(p.root, '.harness')), false);
  assert.equal(existsSync(plan.manifest.paths.state), false);
  assert.deepEqual(outside(p.root), before);
});

test('H1-02: --state внутри репозитория → INVALID_INPUT state-inside-repository', async () => {
  const p = project();
  const before = outside(p.root);
  for (const state of [join(p.root, 'state'), p.root, join(p.root, '.harness', 'state')]) {
    const error = await refusal(initProject(p.opts({ state })), 'INVALID_INPUT');
    assert.deepEqual(error.issues, [{ path: ['--state'], message: 'state-inside-repository' }]);
  }
  // Через symlink снаружи, ведущий внутрь, — тоже.
  const link = join(p.scratch, 'link');
  symlinkSync(p.root, link);
  await refusal(initProject(p.opts({ state: join(link, 'state') })), 'INVALID_INPUT');
  // Каталог состояния по умолчанию из окружения тоже не может быть внутри.
  await refusal(
    initProject({ ...p.opts(), env: { ...p.env, HARNESS_STATE_HOME: join(p.root, 'h') } }),
    'INVALID_INPUT',
  );
  assert.equal(existsSync(join(p.root, '.harness')), false);
  assert.deepEqual(outside(p.root), before);
});

test('H1-02: не корень Git, нет коммитов → INVALID_INPUT not-git-root / NOT_READY no-commits', async () => {
  const p = project();
  for (const repository of [join(p.root, 'src'), join(p.scratch, 'missing'), p.scratch]) {
    const error = await refusal(initProject({ ...p.opts(), repository }), 'INVALID_INPUT');
    assert.deepEqual(error.issues, [{ path: ['--repository'], message: 'not-git-root' }]);
  }
  await refusal(
    initProject({ ...p.opts(), repository: join(p.root, 'package.json') }),
    'INVALID_INPUT',
  );
  const empty = project(undefined, { commit: false });
  const error = await refusal(initProject(empty.opts()), 'NOT_READY');
  assert.deepEqual(error.issues, [{ path: ['--repository'], message: 'no-commits' }]);
  assert.equal(existsSync(join(empty.root, '.harness')), false);
});

test('H1-02: стек неоднозначен или не поддерживается → NOT_READY --profile', async () => {
  const ambiguous = project((dir) => writeFileSync(join(dir, 'pnpm-lock.yaml'), 'x: 1\n'));
  const a = await refusal(initProject(ambiguous.opts({ plan: true })), 'NOT_READY');
  assert.deepEqual(a.issues, [{ path: ['--profile'], message: 'stack-ambiguous' }]);
  const unsupported = project((dir) => rmSync(join(dir, 'package-lock.json')));
  const before = outside(unsupported.root);
  const u = await refusal(initProject(unsupported.opts()), 'NOT_READY');
  assert.deepEqual(u.issues, [{ path: ['--profile'], message: 'stack-unsupported' }]);
  assert.equal(existsSync(join(unsupported.root, '.harness')), false);
  assert.deepEqual(outside(unsupported.root), before);
  // Явный профиль снимает неоднозначность (toolchain при этом вправе отказать).
  const planned = await planProject(ambiguous.opts({ profile: 'npm-ci' }));
  assert.equal(planned.manifest.profile.ref, 'npm-ci');
});

test('H1-02: нет script gate → NOT_READY до записи; --plan — данные с toolchain.ready=false', async () => {
  const p = project((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    delete pkg.scripts.check;
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  });
  const before = outside(p.root);
  const plan = await initProject(p.opts({ plan: true }));
  assert.equal(plan.toolchain.ready, false);
  assert.match(plan.toolchain.problems.join('\n'), /SCRIPT_UNKNOWN/);
  const error = await refusal(initProject(p.opts()), 'NOT_READY');
  assert.ok(error.issues.some((i) => i.path[0] === 'policy' && /SCRIPT_UNKNOWN/.test(i.message)));
  assert.match(error.message, /^Preflight toolchain: /);
  assert.equal(existsSync(join(p.root, '.harness')), false);
  assert.deepEqual(outside(p.root), before);
});

test('H1-02: порядок отказов — state (6) раньше policy (7), policy раньше конфликтов (8), конфликты раньше toolchain (9)', async () => {
  const p = project((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    delete pkg.scripts.test;
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  });
  mkdirSync(join(p.root, '.harness'));
  writeFileSync(join(p.root, '.harness/policy.json'), '{');
  await refusal(initProject(p.opts({ state: join(p.root, 's') })), 'INVALID_INPUT').then((e) =>
    assert.equal(e.issues[0]?.message, 'state-inside-repository'),
  );
  await refusal(initProject(p.opts()), 'INVALID_INPUT').then((e) =>
    assert.equal(e.issues[0]?.path[0], join(p.root, '.harness/policy.json')),
  );
  rmSync(join(p.root, '.harness/policy.json'));
  mkdirSync(join(p.root, '.harness/README.md'));
  const conflict = await refusal(initProject(p.opts()), 'PATH_CONFLICT');
  assert.equal(conflict.issues[0]?.message, 'not-regular-file');
  rmSync(join(p.root, '.harness/README.md'), { recursive: true });
  await refusal(initProject(p.opts()), 'NOT_READY');
  assert.deepEqual(readdirSync(join(p.root, '.harness')), []);
});

test('H1-02: .harness/work или notes — symlink наружу → конфликт плана и PATH_CONFLICT; агенту путь наружу не выдаётся', async () => {
  for (const dir of ['.harness/work', '.harness/work/context/notes']) {
    const p = project();
    const outsideDir = join(p.scratch, 'elsewhere');
    mkdirSync(outsideDir);
    mkdirSync(join(p.root, dirname(dir)), { recursive: true });
    symlinkSync(outsideDir, join(p.root, dir));
    const before = outside(p.root);
    const plan = await initProject(p.opts({ plan: true }));
    const conflict = plan.files.find((f) => f.action === 'conflict');
    assert.deepEqual(conflict, {
      path: join(p.root, dir),
      action: 'conflict',
      conflict: 'symlink',
      conflictPath: join(p.root, dir),
    });
    assert.equal(plan.conflicts, 1);
    const error = await refusal(initProject(p.opts()), 'PATH_CONFLICT');
    assert.deepEqual(error.issues, [{ path: [join(p.root, dir)], message: 'symlink' }]);
    assert.equal(existsSync(join(p.root, '.harness', 'project.json')), false, 'ничего не записано');
    assert.deepEqual(readdirSync(outsideDir), []);
    assert.deepEqual(outside(p.root), before);
  }
});

test('H1-02: --state внутри репозитория в ином регистре на нечувствительной к регистру ФС — тоже отказ', async (t) => {
  const p = project();
  const upper = join(dirname(p.root), basename(p.root).toUpperCase());
  if (!existsSync(upper)) return t.skip('ФС различает регистр: другой путь — другой каталог');
  const error = await refusal(
    initProject(p.opts({ state: join(upper, 'state') })),
    'INVALID_INPUT',
  );
  assert.deepEqual(error.issues, [{ path: ['--state'], message: 'state-inside-repository' }]);
  assert.equal(existsSync(join(p.root, '.harness')), false);
});
