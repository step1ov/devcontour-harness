/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument --
 * Тест правит package.json примера как сырой JSON.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewProbes, type ProbeGate } from '../../src/agents/review-probe.ts';
import type { EvidenceRecord, GatePolicy } from '../../src/contracts/index.ts';
import { isolationSupport } from '../../src/environment/isolation.ts';
import { redactor } from '../../src/environment/redaction.ts';
import { runGate } from '../../src/verification/gates.ts';
import { saveEvidence } from '../probe-fixture.ts';

/**
 * Рецепты основного ТЗ (npm, Go, Python) и probe по ID на настоящих
 * инструментах под песочницей ОС: команда из профиля с путём отчёта в argv
 * или в package script даёт проверяемую ошибку среды, а не EPERM-находку;
 * рецепт с HARNESS_REPORT_PATH проходит и в probe (дерево только для
 * чтения), и в gate движка (отчёт в дереве) — gate движка не регрессирует.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const gobin = join(root, '.private', 'integration-upgrade', 'tools', 'gobin');
const has = (tool: string, env: NodeJS.ProcessEnv) => {
  try {
    execFileSync('sh', ['-c', 'command -v "$0"', tool], { env, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

interface Case {
  tool: string;
  tools: string[];
  prepare?: string[];
  /** Команда из профиля/примера (байты профиля не меняются). */
  shipped: string[];
  /** Аргумент с путём в argv; `undefined` — путь зашит в package script. */
  argument?: number;
  recipe: string[];
  /** Правка package script под рецепт. */
  script?: (pkg: Record<string, any>) => void;
}
const report = '.reports/junit.xml';
const cases: Case[] = [
  {
    tool: 'go',
    tools: ['go', 'gotestsum'],
    shipped: ['gotestsum', '--junitfile', report, '--', '-count=1', './...'],
    argument: 2,
    recipe: [
      'sh',
      '-c',
      'GOCACHE="${GOCACHE:-$TMPDIR/go-build}" exec gotestsum --junitfile "${HARNESS_REPORT_PATH:-.reports/junit.xml}" -- -count=1 ./...',
    ],
  },
  {
    tool: 'python',
    tools: ['uv'],
    prepare: ['uv', 'sync', '--locked'],
    shipped: ['uv', 'run', '--no-sync', 'pytest', '--junitxml=' + report],
    argument: 4,
    recipe: [
      'sh',
      '-c',
      'PYTHONDONTWRITEBYTECODE=1 UV_CACHE_DIR="${UV_CACHE_DIR:-$TMPDIR/uv}" exec uv run --no-sync pytest -p no:cacheprovider --junitxml="${HARNESS_REPORT_PATH:-.reports/junit.xml}"',
    ],
  },
  {
    tool: 'npm',
    tools: ['npm'],
    prepare: ['npm', 'ci', '--no-audit', '--no-fund'],
    shipped: ['npm', 'run', 'test'],
    recipe: ['npm', 'run', 'test'],
    script: (pkg) =>
      (pkg.scripts.test = pkg.scripts.test.replace(
        '--test-reporter-destination=.reports/junit.xml',
        '--test-reporter-destination=${HARNESS_REPORT_PATH:-.reports/junit.xml}',
      )),
  },
];

function tree(c: Case, recipe: boolean, env: NodeJS.ProcessEnv) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `harness-recipe-${c.tool}-`)));
  const example = join(root, 'examples', 'toolchains', c.tool);
  cpSync(join(example, 'repo'), dir, { recursive: true });
  cpSync(join(example, 'good'), dir, { recursive: true });
  renameSync(join(dir, '_gitignore'), join(dir, '.gitignore'));
  if (recipe && c.script) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    c.script(pkg);
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  // Установка — вне песочницы, как prepare движка.
  if (c.prepare)
    execFileSync(c.prepare[0]!, c.prepare.slice(1), { cwd: dir, env, stdio: 'ignore' });
  mkdirSync(join(dir, '.reports'), { recursive: true });
  writeFileSync(
    join(dir, '.reports', 'junit.xml'),
    '<testsuite><testcase name="stale"/></testsuite>',
  );
  return { dir, git };
}

for (const c of cases)
  test(`HP08/recipe/${c.tool}: путь отчёта профиля — диагностика среды; рецепт HARNESS_REPORT_PATH — probe в песочнице и gate движка`, async (t: TestContext) => {
    const support = isolationSupport();
    if (!support.ok) assert.fail('BLOCKED: песочница ОС недоступна: ' + support.detail);
    const env = { ...process.env, PATH: [gobin, process.env.PATH].join(delimiter) };
    const missing = c.tools.filter((x) => !has(x, env));
    if (missing.length) {
      t.skip(`NOT_RUN: нет инструментов ${missing.join(', ')}`);
      return;
    }
    const evidence: Record<string, unknown> = {};
    const controller = realpathSync(mkdtempSync(join(tmpdir(), 'harness-recipe-controller-')));
    const trees: string[] = [];
    try {
      for (const recipe of [false, true]) {
        const r = tree(c, recipe, env);
        trees.push(r.dir);
        const stale = readFileSync(join(r.dir, report), 'utf8');
        const staleTime = statSync(join(r.dir, report)).mtimeMs;
        const gate: ProbeGate = {
          id: 'acceptance',
          kind: 'test',
          command: recipe ? c.recipe : c.shipped,
          timeoutMs: 240000,
          report: { type: 'junit', path: report },
        };
        const review = join(controller, recipe ? 'recipe' : 'shipped');
        const probes = new ReviewProbes(
          {
            cwd: r.dir,
            controller: [controller],
            readable: [r.dir],
            isolation: { mode: 'os', domains: [] },
            commandTimeoutMs: 240000,
            budgetMs: 600000,
            deadline: Date.now() + 900000,
            env: ['PATH', 'HOME', 'GOFLAGS', 'GOMODCACHE'],
            secrets: [],
            settingsDir: join(review, 'settings'),
            log: (mkdirSync(review, { recursive: true }), join(review, 'probes.jsonl')),
            gates: [gate],
            phase: 'candidate',
            sha: r.git('rev-parse', 'HEAD'),
          },
          () => Date.now(),
          env,
        );
        const result = await probes.run({ gate: 'acceptance' });
        if (!recipe) {
          assert.equal(result.status, 'error', `${result.note}\n${result.stderr}`);
          assert.equal(result.failure, 'environment');
          assert.match(result.note ?? '', /HARNESS_REPORT_PATH/);
          if (c.argument !== undefined)
            assert.match(result.note ?? '', new RegExp(`аргумент ${c.argument}`));
          else assert.match(result.note ?? '', /EPERM/);
        } else {
          assert.equal(
            result.status,
            'passed',
            `${result.note}\n${result.stdout}\n${result.stderr}`,
          );
          assert.equal(result.gate?.report?.status, 'fresh');
          assert.ok((result.gate?.report?.tests ?? 0) >= 1);
          assert.ok(existsSync(result.gate.report.path!));
        }
        assert.equal(
          readFileSync(join(r.dir, report), 'utf8'),
          stale,
          'прежний отчёт в дереве цел',
        );
        assert.equal(statSync(join(r.dir, report)).mtimeMs, staleTime);
        assert.equal(r.git('status', '--porcelain', '--untracked-files=no'), '');
        evidence[recipe ? 'probeRecipe' : 'probeShipped'] = {
          status: result.status,
          failure: result.failure,
          argv: result.argv,
          report: result.gate?.report,
          note: result.note,
        };
        if (!recipe) continue;
        // Тот же рецепт — gate движка: пишет отчёт в дерево и проходит.
        const recorded: EvidenceRecord[] = [];
        await runGate({
          policy: { isolation: { mode: 'os', domains: [] } },
          record: (e) => {
            const full = { ...e, id: 'e', runId: 'r', createdAt: new Date().toISOString() };
            recorded.push(full);
            return full;
          },
          cwd: r.dir,
          sha: r.git('rev-parse', 'HEAD'),
          phase: 'candidate',
          gate: { ...gate, report: gate.report! } as GatePolicy,
          artifactDir: join(controller, 'engine'),
          signal: new AbortController().signal,
          // Без переменных node --test самого теста: иначе вложенный
          // node --test проекта считает себя дочерним и не запускает файлы.
          execution: {
            env: Object.fromEntries(
              Object.entries(env).filter(([k]) => !k.startsWith('NODE_TEST')),
            ),
            redact: redactor([]),
          },
          boundary: { hidden: [controller], readable: [] },
        }).catch(() => undefined);
        assert.equal(
          recorded[0]?.passed,
          true,
          recorded[0] ? readFileSync(recorded[0].log, 'utf8') : 'нет evidence',
        );
        assert.notEqual(
          readFileSync(join(r.dir, report), 'utf8'),
          stale,
          'gate движка пишет отчёт в дерево',
        );
        evidence.engineRecipe = {
          passed: recorded[0].passed,
          summary: recorded[0].summary,
          command: recorded[0].command,
        };
      }
      saveEvidence('HP08', `recipe-${c.tool}.json`, evidence);
    } finally {
      rmSync(controller, { recursive: true, force: true });
      for (const dir of trees) rmSync(dir, { recursive: true, force: true });
    }
  });
