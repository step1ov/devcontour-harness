/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тесты собирают сырой JSON профилей и политики до разбора схемой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HarnessError,
  executionPolicySchema,
  stackProfileSchema,
  validateInputs,
} from '../src/index.ts';
import {
  builtinProfiles,
  profilePin,
  profileRoles,
  repositoryFromProfile,
  resolveProfile,
} from '../src/profiles/resolve.ts';
import { cliCommands } from '../src/contracts/cli.ts';
import { implement, approve, runAll, setup } from './runner-fixture.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'src', 'cli.ts');
const testGate = {
  id: 'tests',
  kind: 'test',
  command: ['python3', 'verify.py'],
  report: { type: 'junit', path: '.reports/tests.xml' },
};
const json = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

/** Репозиторий с локальными профилями: стек, проверки и окружение — отдельные слои. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-profiles-')));
  const repo = join(dir, 'product');
  mkdirSync(join(repo, 'profiles'), { recursive: true });
  json(join(repo, 'profiles/stack.json'), {
    id: 'stack',
    version: '1.2.0',
    capabilities: ['python'],
    protectedPaths: ['verify.py'],
  });
  json(join(repo, 'profiles/tests.json'), { id: 'checks', version: '2.0.0', gates: [testGate] });
  json(join(repo, 'profiles/env.json'), {
    id: 'env',
    version: '1.0.0',
    environment: { values: { PROJECT_MARKER: 'product' } },
  });
  json(join(repo, 'profiles/main.json'), {
    id: 'custom-api',
    version: '1.0.0',
    extends: ['./stack.json', './tests.json', './env.json'],
  });
  return { dir, repo };
}
const refused = (pattern: RegExp) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, 'INVALID_INPUT');
  assert.match(e.message, pattern);
  return true;
};

/**
 * Digest встроенных профилей у прежних потребителей — sha256 байтов файла.
 * Перенос побайтный: те же значения, иначе закрепления потребителей разошлись бы.
 */
const goldenDigests: Record<string, string> = {
  'expo-mobile': 'ae3794dfeeca31741dd63a733b79c54bb5c3c764dd98fc49c5cb28a1c4ff4c70',
  'go-api': 'cdd8c2155365ac60294515974dea8116dd53bce38b6b79ffa846c73f2422dfaf',
  'go-gotestsum': '15e7fc4d3e8a6eb6e970b9228a8b8e32aa733aa7428277820a1fb55f57ffe15b',
  'mobile-maestro': '063daa6f8bc7180dfdbf47efb87a827de63614744e2a3c3b26849a1d94d23fd7',
  'nest-api': 'a72eee6195a1a1b0e5b579fe1f7369c2fa237602baa8563f31e3ab954526aecc',
  'next-product': '385213844ba38d5339eae909f4d8547ebaaf8c21cbb18c9a5cbfdd0a0a417fa7',
  'node-checks': '1d6a4838d99907b322ede91cce4598dc2628c79cdae3389a45b8bfb3adf38cdf',
  'npm-ci': 'ef037e96c8b1a1eeae8760c9391ca8b0bfe75bbd8b433ec55ad7c373c2759829',
  'pnpm-frozen': '4e7899fa99d665e129e9f2dcb9f02566694c5086e13e036c8e18605acd84de38',
  'python-api': 'f24cea4f71b6757dcd89746d996c6695bf2a0058c62dc881eebfbd931d02d777',
  'python-uv': '603dd02d2dad2e8bfb3925c3f8a23f575e87cf20983b1dfbaf99b9a704b6e0c9',
  'react-native': '1cd7cc3969deed0c80cf40cfecaf4df02352ee567637bbd167c5545355431eaf',
  'react-vite-admin': 'c38cfdb83adaee6fd14bb6494a580729150ad98dcc0c2158939b923630d83ce9',
};

test('Встроенные профили: каждый разрешается, digest прежних закреплений сохранён, лист — sha256 своих байтов', () => {
  assert.deepEqual(builtinProfiles(), Object.keys(goldenDigests).sort());
  for (const [id, digest] of Object.entries(goldenDigests)) {
    const p = resolveProfile(id);
    assert.equal(p.digest, digest, id);
    assert.ok(
      p.gates.some((g) => g.kind === 'test' && g.report),
      id + ': test gate с JUnit',
    );
    stackProfileSchema.parse(
      JSON.parse(readFileSync(join(root, 'profiles', id + '.json'), 'utf8')),
    );
  }
  const go = resolveProfile('go-api');
  assert.equal(
    go.digest,
    createHash('sha256')
      .update(readFileSync(join(root, 'profiles/go-api.json')))
      .digest('hex'),
  );
  const expo = resolveProfile('expo-mobile');
  for (const gate of ['unit-tests', 'build-and-install', 'mobile-acceptance'])
    assert.ok(
      expo.gates.some((g) => g.id === gate),
      gate,
    );
  assert.equal(expo.concurrency, 1);
});

test('profiles 67: локальные профили складывают стек, проверки и окружение только чтением; CLI показывает то же закрепление', () => {
  const f = fixture();
  try {
    const selected = resolveProfile('./profiles/main.json', { repository: f.repo });
    assert.equal(selected.environment!.values.PROJECT_MARKER, 'product');
    assert.deepEqual(
      selected.gates.map((g) => g.id),
      ['tests'],
    );
    assert.equal(selected.closure.length, 4);
    assert.deepEqual(selected.source, { repositoryId: 'main', path: 'profiles/main.json' });
    assert.ok(selected.protectedPaths.includes('profiles/tests.json'), 'файлы слоёв защищены');
    assert.ok(selected.protectedPaths.includes('verify.py'));
    assert.equal(
      selected.digest,
      resolveProfile('./profiles/main.json', { repository: f.repo }).digest,
    );
    assert.equal(existsSync(join(f.repo, '.reports')), false, 'команды проекта не исполнялись');
    const shown = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        cli,
        'profile',
        '--repository',
        f.repo,
        '--profile',
        './profiles/main.json',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(shown.status, 0, shown.stderr);
    assert.deepEqual(JSON.parse(shown.stdout).data.pin, profilePin(selected));
    assert.deepEqual(readdirSync(f.repo), ['profiles'], 'CLI ничего не создал в репозитории');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('profiles 116: выход за корень, symlink, цикл, неоднозначная композиция и отсутствие доказательства отклонены', () => {
  const f = fixture();
  const file = join(f.repo, 'profiles/bad.json');
  const repository = f.repo;
  const invalid = (extra: object, pattern: RegExp) => {
    json(file, { id: 'bad', version: '1.0.0', ...extra });
    assert.throws(() => resolveProfile('./profiles/bad.json', { repository }), refused(pattern));
  };
  try {
    assert.throws(() => resolveProfile('../outside.json', { repository }), refused(/внутри/));
    assert.throws(
      () => resolveProfile('/tmp/outside.json', { repository }),
      refused(/относительный/),
    );
    assert.throws(
      () => resolveProfile('https://example.invalid/profile.json', { repository }),
      refused(/относительный/),
    );
    assert.throws(() => resolveProfile('./profiles/stack.json'), refused(/корень репозитория/));
    symlinkSync(join(f.repo, 'profiles/tests.json'), join(f.repo, 'profiles/link.json'));
    assert.throws(() => resolveProfile('./profiles/link.json', { repository }), refused(/symlink/));
    invalid({ extends: ['./bad.json'] }, /Цикл/);
    invalid({ gates: [{ ...testGate, kind: 'check', report: undefined }] }, /JUnit/);
    invalid({ gates: [{ ...testGate, report: undefined }] }, /JUnit/);
    invalid({ gates: [{ ...testGate, report: { type: 'junit', path: '../out.xml' } }] }, /path/i);
    invalid({ gates: [{ ...testGate, dependsOn: ['unknown'] }] }, /Неизвестная/);
    invalid({ extends: ['./tests.json'], gates: [testGate] }, /Повтор gate/);
    invalid({ gates: [{ ...testGate, id: 'requirement-source' }] }, /Зарезервированный/);
    invalid(
      { extends: ['./main.json'], environment: { values: { PROJECT_MARKER: 'override' } } },
      /Конфликт/,
    );
    invalid({ extends: ['./tests.json'], approvalMode: 'agent' }, /Unrecognized/);
    invalid({ extends: ['./tests.json'], concurrency: 5 }, /Too big/);
    // Ромб: общий слой учитывается один раз.
    json(file, { id: 'diamond', version: '1.0.0', extends: ['./tests.json', './main.json'] });
    assert.equal(resolveProfile('./profiles/bad.json', { repository }).gates.length, 1);
    writeFileSync(file, ' '.repeat(131073));
    assert.throws(() => resolveProfile('./profiles/bad.json', { repository }), refused(/128 KiB/));
    json(file, { id: 'no-test', version: '1.0.0' });
    assert.throws(
      () => resolveProfile('./profiles/bad.json', { repository }),
      refused(/test gate с JUnit/),
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('profiles 163: закрепление локального профиля включает транзитивные слои — изменение любого меняет digest', () => {
  const f = fixture();
  try {
    const before = resolveProfile('./profiles/main.json', { repository: f.repo });
    json(join(f.repo, 'profiles/env.json'), {
      id: 'env',
      version: '1.0.0',
      environment: { values: { PROJECT_MARKER: 'changed' } },
    });
    const after = resolveProfile('./profiles/main.json', { repository: f.repo });
    assert.notEqual(
      after.digest,
      before.digest,
      'изменённый транзитивный слой — новое закрепление',
    );
    assert.equal(after.version, before.version, 'версия листа та же — digest это видит');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('profiles 351: профиль приносит инструкции стека; надстройка уточняет пакет базы, не отменяя остальные', () => {
  const resolved = resolveProfile('react-native');
  const design = resolved.contextPacks.find((p) => p.id === 'design-system');
  assert.ok(design, 'профиль приносит инструкции своей поверхности');
  assert.ok(design.files.includes('.agents/context/design-system.md'));
  assert.ok(design.roles.includes('ui-tokens'));
  assert.ok(
    resolved.contextPacks.some((p) => p.id === 'technique-testing'),
    'пакет базового слоя',
  );
  const expo = resolveProfile('expo-mobile');
  assert.ok(expo.contextPacks.some((p) => p.id === 'design-system'));
  // Роли профиля — в форме политики: writer и правило ревью кода роли.
  const roles = profileRoles(resolved);
  assert.deepEqual(roles.mobile!.writer, { runtime: 'claude' });
  assert.equal(roles.mobile!.review!.reviewer.runtime, 'codex');
  assert.equal(roles.mobile!.review!.vendor, 'different-vendor', 'умолчание — разные вендоры');
  assert.equal(roles.mobile!.requiresContract, true);
});

test('profiles 366: профиль задаёт время попытки, слои берут наибольший предел', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-timeout-')));
  const acceptance = {
    id: 'acceptance',
    kind: 'test',
    command: ['npm', 'test'],
    timeoutMs: 240000,
    report: { type: 'junit', path: '.reports/junit.xml' },
  };
  try {
    json(join(dir, 'base.json'), {
      id: 'base',
      version: '1.0.0',
      runTimeoutMs: 1_200_000,
      gates: [acceptance],
    });
    json(join(dir, 'leaf.json'), {
      id: 'leaf',
      version: '1.0.0',
      extends: ['./base.json'],
      runTimeoutMs: 2_700_000,
    });
    assert.equal(resolveProfile('./leaf.json', { repository: dir }).runTimeoutMs, 2_700_000);
    json(join(dir, 'quiet.json'), { id: 'quiet', version: '1.0.0', gates: [acceptance] });
    assert.equal(resolveProfile('./quiet.json', { repository: dir }).runTimeoutMs, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profiles 451: собственные значения репозитория сильнее профиля, переопределённое названо', () => {
  const f = fixture();
  try {
    json(join(f.repo, 'profiles/tests.json'), {
      id: 'checks',
      version: '2.1.0',
      gates: [testGate, { ...testGate, id: 'profile-new' }],
    });
    const profile = resolveProfile('./profiles/main.json', { repository: f.repo });
    const ownGate = { ...testGate, id: 'component-own' };
    const { repository, shadowed } = repositoryFromProfile(profile, {
      id: 'product',
      path: f.repo,
      targetRef: 'refs/heads/harness/accepted',
      gates: [ownGate as any],
      environment: { values: { PROJECT_MARKER: 'product' } },
    });
    assert.deepEqual(shadowed, ['gates'], 'то же окружение не переопределяет');
    assert.deepEqual(
      repository.gates.map((g) => g.id),
      ['component-own'],
      'собственный список gates решает, профиль ничего не подменяет',
    );
    const plain = repositoryFromProfile(profile, {
      id: 'product',
      path: f.repo,
      targetRef: 'refs/heads/harness/accepted',
    });
    assert.deepEqual(plain.shadowed, []);
    assert.deepEqual(
      plain.repository.gates.map((g) => g.id),
      ['tests', 'profile-new'],
    );
    for (const path of ['.github/', '.githooks/', 'verify.py', 'profiles/main.json'])
      assert.ok(plain.repository.protectedPaths.includes(path), path);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('profiles 271: свой Python gate из локального профиля отклоняет пустую работу, проверяет обе фазы; файлы профиля защищены', async () => {
  const verify = `import os, pathlib, sys, xml.etree.ElementTree as ET
ok = pathlib.Path('value.txt').read_text() == '2' and os.environ.get('PROJECT_MARKER') == 'product'
suite = ET.Element('testsuite')
case = ET.SubElement(suite, 'testcase', name='value and environment')
if not ok: ET.SubElement(case, 'failure', message='expected 2 and owner environment')
ET.ElementTree(suite).write(os.environ['HARNESS_REPORT_PATH'])
sys.exit(0 if ok else 1)
`;
  const profileFiles = {
    'profiles/stack.json': JSON.stringify({
      id: 'stack',
      version: '1.2.0',
      protectedPaths: ['verify.py'],
    }),
    'profiles/tests.json': JSON.stringify({ id: 'checks', version: '2.0.0', gates: [testGate] }),
    'profiles/env.json': JSON.stringify({
      id: 'env',
      version: '1.0.0',
      environment: { values: { PROJECT_MARKER: 'product' } },
    }),
    'profiles/main.json': JSON.stringify({
      id: 'custom-api',
      version: '1.0.0',
      extends: ['./stack.json', './tests.json', './env.json'],
    }),
    'verify.py': verify,
    'value.txt': '1',
  };
  const fromProfile = (p: any) => {
    const repository = p.repositories[0];
    const profile = resolveProfile('./profiles/main.json', {
      repository: repository.path,
      repositoryId: repository.id,
    });
    p.repositories[0] = repositoryFromProfile(profile, {
      id: repository.id,
      path: repository.path,
      targetRef: repository.targetRef,
    }).repository;
    p.environment.values = { ...p.environment.values };
    p.maxAttempts = 3;
  };
  const graph = (g: any) => {
    g.orders[0].writeScope = ['value.txt', 'notes', 'profiles'];
    g.orders[0].gates = ['tests'];
  };
  const ctx = setup({
    scenario: {
      writer: [
        implement({ 'notes/a.txt': 'ничего не сделано\n' }),
        implement({ 'value.txt': '2' }),
      ],
      reviewer: approve(),
    },
    files: profileFiles,
    policy: fromProfile,
    graph,
  });
  executionPolicySchema.parse(ctx.policy);
  await runAll(ctx);
  const first = ctx.engine.read((v) => v.work('add-greeting')!);
  assert.equal(first.status, 'failed');
  assert.equal(first.failureKind, 'gate', first.failure);
  ctx.engine.retry('add-greeting');
  await ctx.runner.drain();
  assert.equal(
    ctx.engine.read((v) => v.work('add-greeting')!.status),
    'done',
  );
  const run = ctx.engine.read((v) =>
    v.attempts('add-greeting').find((a) => a.status === 'succeeded')!,
  );
  for (const phase of ['candidate', 'integration'])
    assert.ok(
      run.evidence.some((e) => e.phase === phase && e.gate === 'tests' && e.passed),
      phase,
    );
  ctx.store.close();

  const tamper = setup({
    scenario: {
      writer: implement({ 'value.txt': '2', 'profiles/tests.json': '{}' }),
      reviewer: approve(),
    },
    files: profileFiles,
    policy: (p: any) => {
      fromProfile(p);
      p.maxAttempts = 1;
    },
    graph,
  });
  await runAll(tamper);
  const work = tamper.engine.read((v) => v.work('add-greeting')!);
  assert.equal(work.status, 'failed');
  assert.equal(work.failureKind, 'scope-violation');
  assert.match(work.failure!, /защищённые файлы: profiles\/tests\.json/);
  tamper.store.close();
});

test('Skills и шаблоны: шаблоны проходят validate; инструкции не требуют хоста, панели или памяти продукта', () => {
  validateInputs({
    graph: JSON.parse(readFileSync(join(root, 'templates/graph.json'), 'utf8')),
    policy: JSON.parse(readFileSync(join(root, 'templates/policy.json'), 'utf8')),
  });
  const skill = readFileSync(join(root, 'skills/harness/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: harness\ndescription: .+\n---\n/);
  for (const file of ['skills/harness/SKILL.md', 'templates/AGENTS.md']) {
    const text = readFileSync(join(root, file), 'utf8').replaceAll('devcontour-harness', '');
    assert.doesNotMatch(text, /devcontour|relay|панел|памят|\bmemory\b|\bmcp\b|panel/i, file);
    assert.match(text, /enforce|checked by the harness/i, file + ': проверки принадлежат harness');
  }
  // Skill установки называет Relay как источник задач пакета, остальное — то же правило.
  const setup = readFileSync(join(root, 'skills/harness-setup/SKILL.md'), 'utf8').replaceAll(
    'devcontour-harness',
    '',
  );
  assert.doesNotMatch(setup, /devcontour|панел|памят|\bmemory\b|\bmcp\b|panel/i);
  assert.match(setup, /enforced by the harness itself/);
});

test('Skill harness-setup: команды существуют в договоре CLI, принимают названные флаги и получают обязательные', () => {
  const skill = readFileSync(join(root, 'skills/harness-setup/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: harness-setup\ndescription: .+\n---\n/);
  const text = skill.replaceAll(/\\\n\s*/g, ' ');
  const commands = cliCommands as Record<string, { args: { name: string; required: boolean }[] }>;
  // Полный вызов — `$H`/`$N` (CLI установленной и проверяемой версии); упоминание
  // в тексте — команда договора в начале inline-кода, без обязательных флагов.
  const calls = [...text.matchAll(/(\$[HN] |`)(--version|[a-z][a-z-]*)([^`\n;]*)/g)];
  const external = new Set([
    'claude',
    'codex',
    'npm',
    'pnpm',
    'turbo',
    'relay',
    'git',
    'node',
    'shasum',
    'mv',
    'cp',
  ]);
  let full = 0;
  for (const [, prefix, command, tail] of calls) {
    const call = prefix !== '`';
    if (command === '--version') continue;
    const spec = commands[command!];
    // Inline-код без флагов — не обязательно команда (`node_modules/`, `app`).
    if (!call && !spec && (!/^ --/.test(tail!) || external.has(command!))) continue;
    assert.ok(spec, `неизвестная команда: $H ${command}`);
    const flags = [...tail!.split('#')[0]!.matchAll(/--[a-z-]+/g)].map(([f]) => f);
    for (const flag of flags)
      assert.ok(
        spec.args.some((a) => a.name === flag),
        `${command}: неизвестный флаг ${flag}`,
      );
    if (!call) continue;
    full++;
    for (const arg of spec.args.filter((a) => a.required))
      assert.ok(flags.includes(arg.name), `$H ${command}: нет обязательного ${arg.name}`);
  }
  assert.ok(full >= 20, 'skill называет полные вызовы через $H');
  // Пути установленного пакета, на которые ссылается skill, существуют в поставке.
  const paths = [...skill.matchAll(/<pkg>\/([A-Za-z0-9_./-]+[A-Za-z0-9_-])/g)].map(([, p]) => p!);
  assert.ok(paths.length >= 5, 'skill ссылается на файлы пакета');
  for (const path of paths) assert.ok(existsSync(join(root, path)), `нет в пакете: <pkg>/${path}`);
});

test('S2.5: исполнение не читает skills, шаблоны и профили — удаление skill ничего не отключает', () => {
  // Каталоги skills и templates — только документация; профили читает лишь
  // явное разрешение профиля. Движок, runner и проверки на них не ссылаются.
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? sources(join(dir, e.name))
        : e.name.endsWith('.ts')
          ? [join(dir, e.name)]
          : [],
    );
  for (const file of sources(join(root, 'src'))) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /['"`/]skills\/|['"`/]templates\//, file);
    if (!file.endsWith(join('profiles', 'resolve.ts')))
      assert.doesNotMatch(text, /\.\.\/\.\.\/profiles\//, file);
  }
});
