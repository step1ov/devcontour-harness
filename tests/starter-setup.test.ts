/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call --
 * Политика, граф и состояние попытки примера собираются как сырой JSON.
 */
/**
 * Поставляемая настройка Turbo Starter без клона upstream, pnpm и Docker:
 * политики и граф примера валидны; схема генерации не использует
 * generatedPaths как разрешение (S02); оверлей controller mode закрепляется
 * контекстом без противоречивых правил commit (S05). Сквозные прогоны на
 * настоящей копии — tests/integration/starter-acceptance.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileContextSource, validateInputs, withinPaths } from '../src/index.ts';
import { executionPolicySchema } from '../src/contracts/index.ts';
import { contextText, prompt } from '../src/engine/prompt.ts';
import {
  controllerContext,
  starterGraph,
  starterPolicy,
  STARTER,
} from '../scripts/acceptance/starter-fixture.mjs';
import { repo } from './git-fixture.ts';

const example = fileURLToPath(new URL('../examples/turbo-starter/', import.meta.url));
const GENERATED = [
  'apps/nest-backend/openapi',
  'packages/client-rest-api-sdk/src/generated',
  'packages/admin-rest-api-sdk/src/generated',
];
/** Обязательная команда сделать commit самому (англ./рус.). */
const COMMIT_MUST =
  /(you must|must|should|have to|need to|обязан\w*|должен\w*)\s+(commit|коммит)|субагент\s+коммитит|commit (your|the) changes/i;

test('S01: политики и граф примера проходят validate; upstream закреплён полным SHA', () => {
  const fixture = { repo: '/tmp/turbo-starter' };
  for (const template of ['policy.json', 'policy.lifecycle.json'] as const) {
    const policy = executionPolicySchema.parse(starterPolicy(fixture, { template }));
    const graph = starterGraph(
      template === 'policy.json'
        ? {}
        : {
            edit: (g) => {
              g.orders[0].gates = ['db-isolation'];
              g.orders[0].writeScope = ['s03'];
            },
          },
    );
    assert.equal(validateInputs({ graph, policy }).orders, 1, template);
  }
  assert.match(STARTER.commit, /^[0-9a-f]{40}$/);
  assert.equal(STARTER.pnpm, '11.25.0');
});

test('S01: gates примера — настоящие команды starter и JUnit node --test, без turbo cache и root lint', () => {
  const policy = JSON.parse(readFileSync(join(example, 'policy.json'), 'utf8'));
  const gates = policy.repositories[0].gates as {
    id: string;
    kind: string;
    command: string[];
    report?: { path: string };
  }[];
  assert.deepEqual(
    gates.map((g) => g.id),
    ['backend-types', 'sdk-generation', 'sdk-build', 'web-types', 'acceptance'],
  );
  for (const g of gates.filter((x) => x.kind === 'test')) {
    assert.ok(g.command.includes('--test-reporter=junit'), g.id);
    assert.ok(
      g.command.some((a) => a === `--test-reporter-destination=${g.report!.path}`),
      g.id,
    );
  }
  const argv = gates.flatMap((g) => g.command).join(' ');
  assert.doesNotMatch(argv, /\bturbo\b|\blint\b|env:check|--if-present|@latest/);
  assert.deepEqual(policy.repositories[0].prepare[0].command, [
    'pnpm',
    'install',
    '--frozen-lockfile',
    '--offline',
  ]);
});

test('S02: выходы генерации разрешены поручением явно; generatedPaths не разрешение; входы генератора защищены', () => {
  const policy = JSON.parse(readFileSync(join(example, 'policy.json'), 'utf8'));
  const repository = policy.repositories[0];
  const scope = starterGraph().orders[0].writeScope as string[];
  for (const path of GENERATED) assert.ok(scope.includes(path), path);
  // generatedPaths — защищённые выходы, которые никто не правит (Prisma client), а не разрешение.
  for (const g of repository.generatedPaths as string[]) {
    assert.ok(!scope.some((s) => withinPaths(s, [g]) || withinPaths(g, [s])), g);
    assert.ok(!GENERATED.includes(g));
  }
  for (const input of [
    'apps/nest-backend/src/export-openapi.ts',
    'packages/client-rest-api-sdk/package.json',
    'packages/admin-rest-api-sdk/package.json',
    '.harness/',
    'pnpm-lock.yaml',
  ])
    assert.ok(repository.protectedPaths.includes(input), input);
  for (const path of scope)
    assert.ok(
      !(repository.protectedPaths as string[]).some((p) => withinPaths(path, [p])),
      'область записи не перекрыта защитой: ' + path,
    );
  // Детерминированная проверка: gate регенерирует и сравнивает именно эти пути.
  const gate = readFileSync(join(example, 'harness/acceptance/generation.test.mjs'), 'utf8');
  for (const path of GENERATED) assert.ok(gate.includes(`'${path}'`), path);
  assert.match(gate, /\['pnpm', 'rest-api-sdk:generate'\]/);
  const patch = readFileSync(join(example, 'changes/issued-at.patch'), 'utf8');
  const files = [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]!);
  assert.deepEqual(files.sort(), [
    'apps/nest-backend/openapi/admin.openapi.json',
    'apps/nest-backend/openapi/client.openapi.json',
    'apps/nest-backend/src/infrastructure/auth/auth.dto.ts',
    'apps/nest-backend/src/infrastructure/auth/session.service.ts',
    'apps/next-web-app/src/infra/client-api/types/access-token-issued-at.type.ts',
    'packages/admin-rest-api-sdk/src/generated/data-contracts.ts',
    'packages/client-rest-api-sdk/src/generated/data-contracts.ts',
  ]);
  for (const f of files)
    assert.ok(
      scope.some((s) => withinPaths(f, [s])),
      'вне области: ' + f,
    );
});

test('controllerContext: пересборка внутри репозитория после коммита пакета — только справки продукта, без своих копий и удалённых файлов', () => {
  const r = repo({
    'AGENTS.md': '# Rules\n',
    'apps/web/AGENTS.md': '# Web\n',
    'apps/old/AGENTS.md': '# Old\n',
  });
  const dir = join(r.dir, '.harness', 'work', 'context');
  const build = (): string[] =>
    controllerContext(
      { repo: r.dir, baselineSha: r.head(), upstream: null },
      dir,
    ).provenance.product.files.map((f: { path: string }) => f.path) as string[];
  assert.deepEqual(build(), ['AGENTS.md', 'apps/old/AGENTS.md', 'apps/web/AGENTS.md']);
  r.git('add', '-A');
  r.git('commit', '-qm', 'pack');
  r.git('rm', '-q', 'apps/old/AGENTS.md');
  r.git('commit', '-qm', 'drop old');
  assert.deepEqual(build(), ['AGENTS.md', 'apps/web/AGENTS.md']);
  const listed = execFileSync('find', [join(dir, 'controller-mode', 'references'), '-type', 'f'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .map((f) => f.slice(join(dir, 'controller-mode', 'references').length + 1))
    .sort();
  assert.deepEqual(listed, ['AGENTS.md', 'apps/web/AGENTS.md']);
});

test('S05: оверлей controller mode закреплён контекстом; product AGENTS.md — справки с provenance, без конфликта commit', async () => {
  const product = {
    'AGENTS.md':
      '# Rules\n\nСубагент коммитит изменения и переводит задачу в review.\nUse pnpm worktree:create.\n',
    'apps/web/AGENTS.md': '# Web\n\nRead the Unit Architecture rules.\n',
  };
  const r = repo(product);
  const fixture = {
    repo: r.dir,
    baselineSha: r.head(),
    upstream: { source: 'x', commit: STARTER.commit },
  };
  const dir = join(r.dir, '..', 'ctx-' + Date.now());
  const { provenance } = controllerContext(fixture, dir);
  assert.equal(provenance.overlay.version, 1);
  assert.deepEqual(
    provenance.product.files.map((f: { path: string }) => f.path),
    ['AGENTS.md', 'apps/web/AGENTS.md'],
  );
  const snapshot = await new FileContextSource(dir).snapshot(['controller-mode']);
  const source = snapshot.sources[0]!;
  assert.deepEqual(
    source.references.map((f) => f.path),
    ['references/AGENTS.md', 'references/apps/web/AGENTS.md'],
  );
  for (const ref of source.references) {
    const pinned = provenance.product.files.find(
      (f: { path: string }) => 'references/' + f.path === ref.path,
    );
    assert.equal(ref.digest, pinned.sha256, ref.path);
  }
  const text = contextText(snapshot);
  assert.match(text, /# Controller mode \(devcontour-harness overlay v1\)/);
  assert.match(text, /References \(not inlined\): references\/AGENTS\.md/);
  assert.ok(!text.includes('Субагент коммитит'), 'правило product не вложено как инструкция');
  const writer = prompt({
    work: {
      approvedDigest: 'd',
      order: {
        id: 'w',
        role: 'developer',
        repositoryId: 'starter',
        title: 't',
        goal: 'g',
        acceptance: [],
        requirements: [],
        dependsOn: [],
        writeScope: ['src'],
      },
    } as any,
    attempt: { id: 'a', baseSha: r.head() } as any,
    history: [],
    context: snapshot,
    gates: [],
  });
  assert.match(writer, /Do not commit/);
  assert.equal(
    writer.match(COMMIT_MUST)?.[0],
    undefined,
    'одновременно «commit сам» и «не commit»',
  );
  const overlay = readFileSync(
    fileURLToPath(new URL('../templates/controller-mode/AGENTS.controller.md', import.meta.url)),
    'utf8',
  );
  for (const rule of ['worktree:create', 'Relay', 'harness', 'pnpm rest-api-sdk:generate'])
    assert.ok(overlay.includes(rule), rule);
  assert.doesNotMatch(overlay, COMMIT_MUST);
});

test('S01/F05: подготовка Starter поставляется в пакете и не зависит от checkout harness', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  );
  for (const dir of ['examples', 'templates']) assert.ok(pkg.files.includes(dir), dir);
  const setup = readFileSync(join(example, 'setup.mjs'), 'utf8');
  const imports = [...setup.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]!);
  assert.ok(imports.length > 0);
  for (const spec of imports) assert.match(spec, /^node:/, 'только встроенные модули: ' + spec);
  assert.doesNotMatch(setup, /scripts\/acceptance|tests\/fixtures|\.private/);
  for (const ref of [
    'harness/compose-bridge.mjs',
    'policy.json',
    'graph.json',
    'changes/issued-at.patch',
  ])
    assert.ok(readFileSync(join(example, ref)).length > 0, ref);
  const docs = readFileSync(
    fileURLToPath(new URL('../docs/turbo-starter.md', import.meta.url)),
    'utf8',
  );
  assert.match(docs, /examples\/turbo-starter\/setup\.mjs/);
});
