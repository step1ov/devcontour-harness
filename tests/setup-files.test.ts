import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessError } from '../src/contracts/errors.ts';
import {
  applyFileWrites,
  checkDestination,
  inspectPath,
  listRegularFiles,
  planFileWrites,
  type FileIntent,
} from '../src/setup/files.ts';

/** Временный каталог: `raw` — как вернул tmpdir (на macOS под symlink `/var`), `real` — после realpath. */
async function sandbox() {
  const raw = await mkdtemp(join(tmpdir(), 'harness-setup-'));
  return { raw, real: await realpath(raw) };
}

const refusal =
  (code: string, message: string, issues: { path: (string | number)[]; message: string }[]) =>
  (error: unknown) => {
    assert.ok(error instanceof HarnessError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    assert.deepEqual(error.issues, issues);
    return true;
  };

test('H1-02: inspectPath — lstat без следования symlink; отсутствие → undefined; прочие ошибки как есть', async () => {
  const { real } = await sandbox();
  await writeFile(join(real, 'f'), 'x');
  await symlink(join(real, 'missing'), join(real, 'dangling'));
  assert.equal(await inspectPath(join(real, 'nope')), undefined);
  assert.ok((await inspectPath(join(real, 'f')))?.isFile());
  assert.ok((await inspectPath(join(real, 'dangling')))?.isSymbolicLink());
  await assert.rejects(inspectPath(join(real, 'f', 'child')), { code: 'ENOTDIR' });
});

test('H1-02: checkDestination — symlink самого пути и symlink-предка → PATH_CONFLICT с путём symlink', async () => {
  const { real } = await sandbox();
  const outside = join(real, 'outside');
  await mkdir(join(real, 'p'));
  await mkdir(outside);
  await symlink(outside, join(real, 'p', 'link'));
  await symlink(join(outside, 'target'), join(real, 'p', 'file-link'));

  await assert.rejects(
    checkDestination(join(real, 'p', 'link', 'deep', 'x')),
    refusal('PATH_CONFLICT', `Setup не пишет через symlink: ${join(real, 'p', 'link')}`, [
      { path: [join(real, 'p', 'link')], message: 'symlink' },
    ]),
  );
  await assert.rejects(
    checkDestination(join(real, 'p', 'file-link'), { root: join(real, 'p') }),
    refusal('PATH_CONFLICT', `Setup не пишет через symlink: ${join(real, 'p', 'file-link')}`, [
      { path: [join(real, 'p', 'file-link')], message: 'symlink' },
    ]),
  );
  // Существующий каталог и отсутствующий путь без symlink — допустимы.
  await checkDestination(join(real, 'p', 'new', 'x'), { root: join(real, 'p') });
  await checkDestination(join(real, 'p', 'new', 'x'));
});

test('H1-02: checkDestination — предок-файл → ancestor-not-directory вместо сырого ENOTDIR', async () => {
  const { real } = await sandbox();
  await writeFile(join(real, 'file'), 'x');
  const expected = refusal(
    'PATH_CONFLICT',
    `Родитель не является каталогом: ${join(real, 'file')}`,
    [{ path: [join(real, 'file')], message: 'ancestor-not-directory' }],
  );
  await assert.rejects(checkDestination(join(real, 'file', 'a', 'b')), expected);
  await assert.rejects(checkDestination(join(real, 'file', 'a'), { root: real }), expected);
  // Сам корень — файл.
  await assert.rejects(
    checkDestination(join(real, 'file', 'a'), { root: join(real, 'file') }),
    expected,
  );
});

test('H1-02: checkDestination — outside-root; корень сравнивается по resolve и realpath (/var → /private/var)', async () => {
  const { raw, real } = await sandbox();
  const root = join(raw, 'repo');
  await mkdir(root);
  await mkdir(join(raw, 'other'));
  // Путь задан через realpath корня, корень — через symlink (`/var/…`): это тот же корень.
  await checkDestination(join(real, 'repo', 'a', 'b.txt'), { root });
  // Корень с symlink выше него (`/var`) не мешает: обход останавливается на корне.
  await checkDestination(join(raw, 'repo', 'x'), { root });

  for (const path of [
    join(real, 'other', 'x'),
    join(raw, 'repo-sibling', 'x'),
    join(raw, 'repo', '..', 'other'),
  ]) {
    await assert.rejects(
      checkDestination(path, { root }),
      refusal('PATH_CONFLICT', `Путь вне корня проекта: ${path}`, [
        { path: [path], message: 'outside-root' },
      ]),
    );
  }
});

test('H1-02: listRegularFiles — относительные пути с рекурсией; symlink → INVALID_INPUT', async () => {
  const { real } = await sandbox();
  await mkdir(join(real, 't', 'a', 'b'), { recursive: true });
  await writeFile(join(real, 't', 'top.md'), '1');
  await writeFile(join(real, 't', 'a', 'b', 'deep.md'), '2');
  const listed = await listRegularFiles(join(real, 't'));
  assert.deepEqual([...listed].sort(), [join('a', 'b', 'deep.md'), 'top.md']);
  assert.deepEqual(await listRegularFiles(join(real, 't')), listed, 'идемпотентно');

  await symlink(join(real, 't', 'top.md'), join(real, 't', 'a', 'alias.md'));
  const rel = join('a', 'alias.md');
  await assert.rejects(
    listRegularFiles(join(real, 't')),
    refusal('INVALID_INPUT', `Неподдерживаемый файл шаблона: ${rel}`, [
      { path: [rel], message: 'not-regular-file' },
    ]),
  );
});

test('H1-02: дубликат и неабсолютный путь → INVALID_INPUT до обхода ФС (план и применение)', async () => {
  const { real } = await sandbox();
  // Предок-symlink дал бы PATH_CONFLICT, если бы обход ФС начался.
  await symlink(tmpdir(), join(real, 'link'));
  const dup = [
    { path: join(real, 'link', 'a'), content: '1' },
    { path: join(real, 'link', '.', 'a'), content: '2' },
  ];
  const dupRefusal = refusal(
    'INVALID_INPUT',
    `Путь файла повторяется: ${join(real, 'link', '.', 'a')}`,
    [{ path: ['files', 1, 'path'], message: 'duplicate' }],
  );
  await assert.rejects(planFileWrites({ files: dup }), dupRefusal);
  await assert.rejects(applyFileWrites({ entries: [], conflicts: 0 }, dup), dupRefusal);

  const relative = [{ path: 'relative/a.txt', content: '1' }];
  await assert.rejects(
    planFileWrites({ files: relative, root: real }),
    refusal('INVALID_INPUT', 'Путь файла должен быть абсолютным: relative/a.txt', [
      { path: ['files', 0, 'path'], message: 'not-absolute' },
    ]),
  );
});

test('H1-02: план — create/preserve, все конфликты сразу с conflictPath; root возвращается в плане (K6)', async () => {
  const { real: root } = await sandbox();
  await writeFile(join(root, 'AGENTS.md'), 'user policy');
  await mkdir(join(root, 'dir'));
  await writeFile(join(root, 'plain'), 'x');
  await symlink(tmpdir(), join(root, '.harness'));
  await writeFile(join(root, 'profile.json'), 'old');
  const files: FileIntent[] = [
    { path: join(root, 'new', 'a.txt'), content: 'a' },
    { path: join(root, 'AGENTS.md'), content: 'template' },
    { path: join(root, '.harness', 'project.json'), content: '{}' },
    { path: join(root, 'plain', 'x'), content: 'x' },
    { path: join(root, 'dir'), content: 'x' },
    { path: join(root, 'profile.json'), content: 'new', onExisting: 'require-identical' },
    { path: join(root, '..', 'escape.txt'), content: 'x' },
  ];
  const plan = await planFileWrites({ files, root });
  assert.equal(plan.root, root);
  assert.equal(plan.conflicts, 5);
  assert.deepEqual(plan.entries, [
    { path: files[0]?.path, action: 'create' },
    { path: files[1]?.path, action: 'preserve' },
    {
      path: files[2]?.path,
      action: 'conflict',
      conflict: 'symlink',
      conflictPath: join(root, '.harness'),
    },
    {
      path: files[3]?.path,
      action: 'conflict',
      conflict: 'ancestor-not-directory',
      conflictPath: join(root, 'plain'),
    },
    { path: files[4]?.path, action: 'conflict', conflict: 'not-regular-file' },
    { path: files[5]?.path, action: 'conflict', conflict: 'content-differs' },
    { path: files[6]?.path, action: 'conflict', conflict: 'outside-root' },
  ]);
  assert.equal((await planFileWrites({ files })).root, undefined);

  // Применение плана с конфликтами: отказ без единой записи, все конфликты в issues.
  const before = await readdir(root);
  await assert.rejects(
    applyFileWrites(plan, files),
    refusal('PATH_CONFLICT', `Setup не пишет через symlink: ${join(root, '.harness')}`, [
      { path: [join(root, '.harness')], message: 'symlink' },
      { path: [join(root, 'plain')], message: 'ancestor-not-directory' },
      { path: [join(root, 'dir')], message: 'not-regular-file' },
      { path: [join(root, 'profile.json')], message: 'content-differs' },
      { path: [join(root, '..', 'escape.txt')], message: 'outside-root' },
    ]),
  );
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(join(root, 'profile.json'), 'utf8'), 'old');
  assert.equal(await inspectPath(join(root, '..', 'escape.txt')), undefined);
});

test('H1-02: тексты отказов для not-regular-file и content-differs при применении', async () => {
  const { real: root } = await sandbox();
  await mkdir(join(root, 'dir'));
  await writeFile(join(root, 'p.json'), 'old');
  const dirFiles = [{ path: join(root, 'dir'), content: 'x' }];
  await assert.rejects(
    applyFileWrites(await planFileWrites({ files: dirFiles, root }), dirFiles),
    refusal('PATH_CONFLICT', `Назначение не является обычным файлом: ${join(root, 'dir')}`, [
      { path: [join(root, 'dir')], message: 'not-regular-file' },
    ]),
  );
  const profile: FileIntent[] = [
    { path: join(root, 'p.json'), content: 'new', onExisting: 'require-identical' },
  ];
  await assert.rejects(
    applyFileWrites(await planFileWrites({ files: profile, root }), profile),
    refusal('PATH_CONFLICT', `Файл уже существует с другим содержимым: ${join(root, 'p.json')}`, [
      { path: [join(root, 'p.json')], message: 'content-differs' },
    ]),
  );
  assert.equal(await readFile(join(root, 'p.json'), 'utf8'), 'old');
});

test('H1-02: require-identical — те же байты → preserve; изменённые после плана → content-differs без перезаписи', async () => {
  const { real: root } = await sandbox();
  await writeFile(join(root, 'p.json'), 'same');
  const files: FileIntent[] = [
    { path: join(root, 'p.json'), content: 'same', onExisting: 'require-identical' },
  ];
  const plan = await planFileWrites({ files, root });
  assert.deepEqual(plan.entries, [{ path: join(root, 'p.json'), action: 'preserve' }]);
  assert.deepEqual(await applyFileWrites(plan, files), {
    created: [],
    preserved: [join(root, 'p.json')],
  });

  await writeFile(join(root, 'p.json'), 'edited');
  await assert.rejects(applyFileWrites(plan, files), { code: 'PATH_CONFLICT' });
  assert.equal(await readFile(join(root, 'p.json'), 'utf8'), 'edited');
});

test('H1-02: применение create-only, в порядке files; повтор → created=[], всё preserved, содержимое не меняется', async () => {
  const { real: root } = await sandbox();
  await writeFile(join(root, 'AGENTS.md'), 'user');
  const files: FileIntent[] = [
    { path: join(root, 'a', 'b', 'c.txt'), content: 'c' },
    { path: join(root, 'AGENTS.md'), content: 'template' },
    { path: join(root, 'z.txt'), content: 'z' },
  ];
  const first = await applyFileWrites(await planFileWrites({ files, root }), files);
  assert.deepEqual(first, {
    created: [join(root, 'a', 'b', 'c.txt'), join(root, 'z.txt')],
    preserved: [join(root, 'AGENTS.md')],
  });
  assert.equal(await readFile(join(root, 'a', 'b', 'c.txt'), 'utf8'), 'c');
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'user');

  const again = await planFileWrites({ files, root });
  assert.ok(again.entries.every((e) => e.action === 'preserve'));
  await writeFile(join(root, 'z.txt'), 'user edit');
  assert.deepEqual(await applyFileWrites(again, files), {
    created: [],
    preserved: files.map((f) => f.path),
  });
  assert.equal(await readFile(join(root, 'z.txt'), 'utf8'), 'user edit');
});

test('H1-02: файл, появившийся между планом и применением (EEXIST), сохраняется, а не перезаписывается', async () => {
  const { real: root } = await sandbox();
  const files = [{ path: join(root, 'late.txt'), content: 'template' }];
  const plan = await planFileWrites({ files, root });
  assert.equal(plan.entries[0]?.action, 'create');
  await writeFile(join(root, 'late.txt'), 'user');
  assert.deepEqual(await applyFileWrites(plan, files), {
    created: [],
    preserved: [join(root, 'late.txt')],
  });
  assert.equal(await readFile(join(root, 'late.txt'), 'utf8'), 'user');
});

test('H1-02: files не соответствует плану → INVALID_INPUT без записи', async () => {
  const { real: root } = await sandbox();
  const files = [
    { path: join(root, 'a.txt'), content: 'a' },
    { path: join(root, 'b.txt'), content: 'b' },
  ];
  const plan = await planFileWrites({ files, root });
  const mismatch = (issuePath: (string | number)[]) =>
    refusal('INVALID_INPUT', 'Состав файлов не соответствует плану', [
      { path: issuePath, message: 'not-in-plan' },
    ]);
  await assert.rejects(applyFileWrites(plan, files.slice(0, 1)), mismatch(['files']));
  await assert.rejects(
    applyFileWrites(plan, [files[0] as FileIntent, { path: join(root, 'c.txt'), content: 'c' }]),
    mismatch(['files', 1, 'path']),
  );
  assert.deepEqual(await readdir(root), []);
});

test('H1-02: прерывание между записями (fault injection) → созданное остаётся, повтор дописывает недостающее', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root игнорирует права каталога');
  const { real: root } = await sandbox();
  await mkdir(join(root, 'locked'));
  const files = [
    { path: join(root, 'first.txt'), content: '1' },
    { path: join(root, 'locked', 'second.txt'), content: '2' },
    { path: join(root, 'third.txt'), content: '3' },
  ];
  const plan = await planFileWrites({ files, root });
  assert.equal(plan.conflicts, 0);
  // Сбой второй записи: каталог становится недоступным для записи после плана.
  await chmod(join(root, 'locked'), 0o500);
  try {
    await assert.rejects(applyFileWrites(plan, files), { code: 'EACCES' });
  } finally {
    await chmod(join(root, 'locked'), 0o700);
  }
  assert.equal(await readFile(join(root, 'first.txt'), 'utf8'), '1', 'отката нет');
  assert.equal(
    await inspectPath(join(root, 'third.txt')),
    undefined,
    'после сбоя записи прекращаются',
  );

  const resumed = await planFileWrites({ files, root });
  assert.deepEqual(
    resumed.entries.map((e) => e.action),
    ['preserve', 'create', 'create'],
  );
  assert.deepEqual(await applyFileWrites(resumed, files), {
    created: [join(root, 'locked', 'second.txt'), join(root, 'third.txt')],
    preserved: [join(root, 'first.txt')],
  });
});

test('H1-02: гонка план→применение — каталог подменён symlink наружу → PATH_CONFLICT с conflictPath, наружу не пишется', async () => {
  const { real } = await sandbox();
  const root = join(real, 'repo');
  const outside = join(real, 'outside');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(outside);
  const files = [
    { path: join(root, 'ok.txt'), content: 'ok' },
    { path: join(root, 'sub', 'a.txt'), content: 'a' },
  ];
  const plan = await planFileWrites({ files, root });
  assert.equal(plan.conflicts, 0);

  await rm(join(root, 'sub'), { recursive: true });
  await symlink(outside, join(root, 'sub'));
  await assert.rejects(
    applyFileWrites(plan, files),
    refusal('PATH_CONFLICT', `Setup не пишет через symlink: ${join(root, 'sub')}`, [
      { path: [join(root, 'sub')], message: 'symlink' },
    ]),
  );
  assert.deepEqual(await readdir(outside), []);
  assert.equal(
    await readFile(join(root, 'ok.txt'), 'utf8'),
    'ok',
    'записи до конфликта сохраняются',
  );

  // Подмена предка файлом между планом и применением.
  await rm(join(root, 'sub'));
  const later = [{ path: join(root, 'sub', 'b.txt'), content: 'b' }];
  const laterPlan = await planFileWrites({ files: later, root });
  await writeFile(join(root, 'sub'), 'file');
  await assert.rejects(
    applyFileWrites(laterPlan, later),
    refusal('PATH_CONFLICT', `Родитель не является каталогом: ${join(root, 'sub')}`, [
      { path: [join(root, 'sub')], message: 'ancestor-not-directory' },
    ]),
  );
});
