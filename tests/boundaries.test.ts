import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint } from 'eslint';

const root = new URL('..', import.meta.url).pathname;
const lint = async (file: string, extra: string) => {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(extra + readFileSync(join(root, file), 'utf8'), {
    filePath: join(root, file),
  });
  return result!.messages.filter((m) => m.ruleId === 'no-restricted-imports');
};

test('Импорт DevContour, Relay или UI из исходников harness — ошибка линтера', async () => {
  for (const line of [
    "import { DevContour } from 'devcontour';\n",
    "import { Store } from '../../devcontour/src/core/store.ts';\n",
    "import { relay } from '@relay/client';\n",
    "import React from 'react';\n",
    "import { Dialog } from '@radix-ui/react-dialog';\n",
  ]) {
    const messages = await lint('src/validate.ts', line);
    assert.equal(messages.length, 1, line);
    assert.equal(messages[0]!.severity, 2, line);
  }
  assert.equal((await lint('src/validate.ts', '')).length, 0, 'разрешённое направление не шумит');
});

test('Договоры не зависят от других модулей, процессов и ввода-вывода', async () => {
  for (const line of [
    "import { validateInputs } from '../validate.ts';\n",
    "import { spawn } from 'node:child_process';\n",
    "import { readFileSync } from 'node:fs';\n",
    "import { DatabaseSync } from 'node:sqlite';\n",
    "import { readFile } from 'node:fs/promises';\n",
    "import { readFileSync } from 'fs';\n",
  ]) {
    const messages = await lint('src/contracts/work.ts', line);
    assert.equal(messages.length, 1, line);
    assert.equal(messages[0]!.severity, 2, line);
  }
});

test('Runtime-зависимости пакета не содержат DevContour, Relay и UI', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
  for (const dep of deps)
    assert.doesNotMatch(dep, /^(devcontour$|react|@radix-ui|vite|relay|@relay)/, dep);
  for (const spec of Object.values({ ...pkg.dependencies }))
    assert.doesNotMatch(
      spec,
      /^(file:|link:|\.\.?\/|\/)/,
      'нет зависимостей от соседних каталогов',
    );
});

test('Исходники не ссылаются на соседний checkout и не загружают его модули', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true }))
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith('.ts')) files.push(join(dir, e.name));
  };
  walk('src');
  assert.ok(files.length >= 10, 'проверка видит исходники: ' + files.length);
  assert.ok(files.includes(join('src', 'contracts', 'ports.ts')));
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(text, /\.\.\/devcontour\b|PhpstormProjects|\/Users\//, file);
    assert.doesNotMatch(text, /import\(\s*[^'"]/, file + ': динамический import вычисленного пути');
  }
});

test('Корень пакета экспортирует строительные блоки хоста', async () => {
  const api = await import('../src/index.ts');
  for (const name of [
    'Engine',
    'Runner',
    'WorkflowQueue',
    'JointRunner',
    'moveBase',
    'fencedRefMove',
    'runGate',
    'unprovenReason',
    'ReviewProbes',
    'redactDeep',
    'redactor',
    'executionDigest',
    'policyDigest',
    'expandGateRefs',
    'analyzeRecovery',
    'applyCases',
    'recoveryBrief',
    'resultProblems',
    'CorpusStore',
    'submitCase',
    'junitSummary',
    'prepareReportPath',
    'sandboxBlockedHosts',
    'runCheck',
    'caseId',
    'corpusFile',
    'parseCanonical',
    'versionOf',
    'closeIfBasisChanged',
    'hostGitArgs',
    'assertTrustedCheckout',
    'UntrustedCheckoutError',
    'gitHardening',
    'rememberWorktree',
    'worktreeAddPath',
  ])
    assert.ok(name in api, 'нет экспорта ' + name);
});
