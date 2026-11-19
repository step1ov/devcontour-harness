/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
 * Тест читает JSON-ответ CLI как есть; его форму проверяет сам CLI схемой команды.
 */
/**
 * Принятая версия против текущего target ref (H11): после приёмки на target
 * ref появляются коммиты вне harness — `status`, `status --human`, `result`
 * и `report` называют принятый SHA, число коммитов и файлов после него как
 * не проверенные. Writer и reviewer — fixture executables, не живые модели.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliDataSchemas } from '../src/contracts/index.ts';
import { targetLines } from '../src/control/target.ts';
import { bin, implement } from './runner-fixture.ts';
import { verdict } from './review-fixture.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const example = fileURLToPath(new URL('../examples/single-task', import.meta.url));
const REF = 'refs/heads/harness/accepted';

function accepted() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-target-')));
  const app = join(root, 'greeting');
  cpSync(example, app, { recursive: true });
  const scenarioPath = join(root, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify({ writer: implement(), reviewer: verdict(true) }));
  const policy = JSON.parse(readFileSync(join(app, 'policy.json'), 'utf8'));
  policy.isolation = { mode: 'none', domains: [] };
  policy.environment = { values: { FIXTURE_SCENARIO: scenarioPath } };
  writeFileSync(join(app, 'policy.json'), JSON.stringify(policy, null, 2));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: app, encoding: 'utf8', env }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const state = join(root, 'state');
  const harness = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd: existsSync(app) ? app : root,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        HARNESS_CLAUDE_BIN: bin('fake-claude'),
        HARNESS_CODEX_BIN: bin('fake-codex'),
      },
    });
    let json: any = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      /* --human */
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  const run = harness(
    'run',
    '--graph',
    'graph.json',
    '--policy',
    'policy.json',
    '--state',
    state,
    '--author',
    'external',
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const acceptedSha = git('rev-parse', REF);
  /** Коммит на target ref вне harness (новые файлы `files`). */
  const commitOnRef = (files: Record<string, string>) => {
    git('checkout', '-q', REF.replace('refs/heads/', ''));
    for (const [f, t] of Object.entries(files)) writeFileSync(join(app, f), t);
    git('add', '-A');
    git('commit', '-qm', 'after acceptance');
    git('checkout', '-q', 'main');
    return git('rev-parse', REF);
  };
  return { app, git, state, harness, acceptedSha, commitOnRef };
}

test('H11: принятая работа без коммитов после приёмки — target с нулями и строкой «коммитов нет»', () => {
  const p = accepted();
  const status = cliDataSchemas.status.parse(p.harness('status', '--state', p.state).json.data);
  const work = status.works[0]!;
  assert.equal(work.status, 'done');
  assert.deepEqual(
    { ...work.target, line: undefined, lineEn: undefined },
    {
      repositoryId: 'app',
      ref: REF,
      acceptedSha: p.acceptedSha,
      head: p.acceptedSha,
      commitsSinceAccepted: 0,
      filesSinceAccepted: 0,
      line: undefined,
      lineEn: undefined,
    },
  );
  assert.match(work.target!.line, /после приёмки коммитов нет/);
});

test('H11: коммиты на target ref после приёмки — status, status --human, result и report называют их непроверенными', () => {
  const p = accepted();
  p.commitOnRef({ 'a.txt': 'a\n' });
  const head = p.commitOnRef({ 'b.txt': 'b\n', 'c.txt': 'c\n' });
  const status = cliDataSchemas.status.parse(p.harness('status', '--state', p.state).json.data);
  const target = status.works[0]!.target!;
  assert.equal(target.acceptedSha, p.acceptedSha);
  assert.equal(target.head, head);
  assert.equal(target.commitsSinceAccepted, 2);
  assert.equal(target.filesSinceAccepted, 3);
  assert.equal(target.diverged, undefined);
  const sha = p.acceptedSha.slice(0, 12);
  assert.equal(target.line, `принято на ${sha}; после приёмки 2 коммита (3 файла) — не проверены`);
  assert.equal(
    target.lineEn,
    `accepted at ${sha}; 2 commits (3 files) since acceptance are not verified`,
  );

  const human = p.harness('status', '--state', p.state, '--human');
  assert.equal(human.status, 0);
  assert.ok(human.stdout.includes(target.line), human.stdout);
  assert.ok(human.stdout.includes(target.lineEn), human.stdout);

  const result = cliDataSchemas.result.parse(
    p.harness('result', '--state', p.state, '--work', 'add-greeting').json.data,
  );
  assert.equal(result.result.outcome, 'accepted');
  assert.deepEqual(result.target, target);

  const report = p.harness('report', '--state', p.state);
  const data = cliDataSchemas.report.parse(report.json.data) as any;
  assert.equal(data.targets.checked, 1);
  assert.equal(data.targets.rows[0].workId, 'add-greeting');
  assert.equal(data.targets.rows[0].commitsSinceAccepted, 2);
  const md = p.harness('report', '--state', p.state, '--format', 'md');
  assert.match(md.stdout, /## After acceptance/);
  assert.ok(md.stdout.includes(target.lineEn), md.stdout);
});

test('H11: переписанный target ref — diverged; отсутствующий ref — unavailable, а не отказ status', () => {
  const p = accepted();
  // Ref переписан: принятый коммит больше не в его истории.
  const other = p.git('commit-tree', '-m', 'rewrite', `${p.acceptedSha}^{tree}`);
  p.git('update-ref', REF, other);
  let status = cliDataSchemas.status.parse(p.harness('status', '--state', p.state).json.data);
  assert.equal(status.works[0]!.target!.diverged, true);
  assert.match(status.works[0]!.target!.line, /переписан/);
  p.git('update-ref', '-d', REF);
  const r = p.harness('status', '--state', p.state);
  assert.equal(r.status, 0);
  status = cliDataSchemas.status.parse(r.json.data);
  assert.equal(status.works[0]!.target!.unavailable, 'ref не прочитан');
  assert.match(status.works[0]!.target!.line, /не проверено/);
  // Причина — класс, без путей машины (сверка попадает в отчёт).
  assert.ok(!status.works[0]!.target!.line.includes(p.app));
  const report = cliDataSchemas.report.parse(
    p.harness('report', '--state', p.state).json.data,
  ) as any;
  assert.ok(!JSON.stringify(report.targets).includes(p.app));
  assert.equal(report.targets.rows[0].unavailable, 'ref не прочитан');
});

test('H11: строки target — русские формы числа', () => {
  const base = { repositoryId: 'app', ref: REF, acceptedSha: 'a'.repeat(40), head: 'b'.repeat(40) };
  const line = (n: number, f: number) =>
    targetLines({ ...base, commitsSinceAccepted: n, filesSinceAccepted: f }).line;
  assert.match(line(1, 1), /1 коммит \(1 файл\)/);
  assert.match(line(5, 11), /5 коммитов \(11 файлов\)/);
  assert.match(line(22, 21), /22 коммита \(21 файл\)/);
  assert.match(
    targetLines({ ...base, commitsSinceAccepted: 1, filesSinceAccepted: 1 }).lineEn,
    /1 commit \(1 file\)/,
  );
});

test('H11: строки target укладываются в предел при длинном ref; причина unavailable без путей машины', () => {
  const long = 'refs/heads/' + 'x'.repeat(480);
  const t = targetLines({
    repositoryId: 'app',
    ref: long,
    acceptedSha: 'a'.repeat(40),
    unavailable: 'ref не прочитан',
  });
  assert.ok(t.line.length <= 500 && t.lineEn.length <= 500);
});

test('H11: имена из пробелов и с переводом строки считаются; испорченный binding.json — отказ report; пропавший checkout — unavailable', () => {
  const p = accepted();
  p.commitOnRef({ '   ': 'spaces\n', 'a\nb.txt': 'newline\n' });
  const status = cliDataSchemas.status.parse(p.harness('status', '--state', p.state).json.data);
  assert.equal(status.works[0]!.target!.filesSinceAccepted, 2);
  assert.equal(status.works[0]!.target!.commitsSinceAccepted, 1);

  const bindingPath = join(p.state, 'binding.json');
  const saved = readFileSync(bindingPath, 'utf8');
  writeFileSync(bindingPath, '{broken');
  const broken = p.harness('report', '--state', p.state);
  assert.equal(broken.json.ok, false, broken.stdout);
  writeFileSync(bindingPath, saved);

  renameSync(p.app, p.app + '-moved');
  const moved = p.harness('result', '--state', p.state, '--work', 'add-greeting');
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  const target = cliDataSchemas.result.parse(moved.json.data).target!;
  assert.equal(target.unavailable, 'checkout репозитория не найден');
  assert.ok(!target.line.includes(p.app));
});
