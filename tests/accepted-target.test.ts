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
import { cliDataSchemas, operatorViewSchema } from '../src/contracts/index.ts';
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
    { ...work.target, line: undefined, lineEn: undefined, remote: undefined },
    {
      repositoryId: 'app',
      ref: REF,
      acceptedSha: p.acceptedSha,
      head: p.acceptedSha,
      commitsSinceAccepted: 0,
      filesSinceAccepted: 0,
      line: undefined,
      lineEn: undefined,
      remote: undefined,
    },
  );
  assert.match(work.target!.line, /после приёмки коммитов нет/);
  // Удалённой ветки нет: «неизвестно», а не «не отправлено».
  assert.deepEqual(work.target!.remote, {
    state: 'unknown',
    reason: 'нет удалённой ветки',
    reasonEn: 'no remote branch',
    line: 'неизвестно (нет удалённой ветки)',
    lineEn: 'unknown (no remote branch)',
  });
});

test('P2-c: принято локально против удалённой ветки — только по локальной remote-tracking ref, без fetch', () => {
  const p = accepted();
  const origin = p.app + '-origin.git';
  execFileSync('git', ['init', '-q', '--bare', origin]);
  p.git('remote', 'add', 'origin', origin);
  const branch = REF.replace('refs/heads/', '');
  // Удалённая ветка на родителе принятого коммита, upstream настроен.
  p.git('push', '-q', 'origin', `${p.acceptedSha}^:${REF}`);
  p.git('fetch', '-q', 'origin');
  p.git('branch', '-q', `--set-upstream-to=origin/${branch}`, branch);
  const remote = () =>
    cliDataSchemas.status.parse(p.harness('status', '--state', p.state).json.data).works[0]!.target!
      .remote!;
  const viewToken = () =>
    operatorViewSchema.parse(p.harness('view', '--state', p.state).json.data).source.token;
  const notPushedToken = viewToken();
  let r = remote();
  assert.equal(r.state, 'not-pushed');
  assert.equal(r.trackingRef, `origin/${branch}`);
  assert.equal(r.line, `принято локально; в удалённой ветке origin/${branch} ещё нет`);
  assert.equal(r.lineEn, `accepted locally; not yet on the remote branch origin/${branch}`);
  // Время — последнее обновление ref на машине (reflog), а не часы запроса.
  const gd = p.git(
    'reflog',
    'show',
    '-n',
    '1',
    '--date=iso-strict',
    '--format=%gd',
    `refs/remotes/origin/${branch}`,
  );
  assert.equal(r.checkedAt, new Date(/@\{([^}]+)\}$/.exec(gd)![1]!).toISOString());
  assert.deepEqual(
    { remote: r.pushRemote, ref: r.pushRef },
    { remote: 'origin', ref: REF },
    'куда отправлять — ветка upstream',
  );
  const human = p.harness('status', '--state', p.state, '--human');
  assert.ok(human.stdout.includes(`удалённая ветка: ${r.line}`), human.stdout);

  // Коммит появился в удалённом репозитории, но ref на этой машине не обновлён:
  // без fetch состояние остаётся прежним (сети нет).
  execFileSync('git', ['--git-dir', origin, 'fetch', '-q', p.app, `+${REF}:${REF}`]);
  assert.equal(remote().state, 'not-pushed');

  // Отправлено: принятый коммит в истории remote-tracking ref, вершина ушла
  // дальше (коммит поверх принятого в удалённом репозитории): сверка по
  // истории, а не по равенству SHA.
  p.git('push', '-q', 'origin', REF);
  const ahead = p.git(
    'commit-tree',
    '-p',
    p.acceptedSha,
    '-m',
    'remote ahead',
    `${p.acceptedSha}^{tree}`,
  );
  p.git('push', '-q', 'origin', `${ahead}:${REF}`);
  assert.equal(p.git('rev-parse', `refs/remotes/origin/${branch}`), ahead);
  r = remote();
  assert.equal(r.state, 'pushed');
  assert.equal(r.line, `уже в удалённой ветке origin/${branch}`);
  assert.notEqual(viewToken(), notPushedToken, 'смена удалённой ветки меняет токен представления');
  // Раздел отчёта «после приёмки» — о дрейфе: удалённой ветки в нём нет.
  const report = cliDataSchemas.report.parse(
    p.harness('report', '--state', p.state).json.data,
  ) as any;
  assert.ok(!JSON.stringify(report.targets).includes('remote'), JSON.stringify(report.targets));
  const result = cliDataSchemas.result.parse(
    p.harness('result', '--state', p.state, '--work', 'add-greeting').json.data,
  );
  assert.equal(result.target!.remote!.state, 'pushed');
  // Представление оператора: та же сверка в работе и лента из записей прогона.
  const detail = cliDataSchemas.view.parse(
    p.harness('view', '--state', p.state, '--work', 'add-greeting').json.data,
  ) as any;
  assert.deepEqual(
    { state: detail.work.target.remote.state, trackingRef: detail.work.target.remote.trackingRef },
    { state: 'pushed', trackingRef: `origin/${branch}` },
  );
  assert.equal(detail.work.target.remote.line, `уже в удалённой ветке origin/${branch}`);
  const overview = operatorViewSchema.parse(
    p.harness('view', '--state', p.state, '--lang', 'en').json.data,
  );
  const activity = overview.activity ?? [];
  const actions = new Set(activity.map((x) => `${x.actor} ${x.action}`));
  for (const a of [
    'controller attempt.started',
    'controller gate.passed',
    'reviewer review.approved',
    'controller work.accepted',
  ])
    assert.ok(actions.has(a), `${a}: ${[...actions].join(', ')}`);
  const acceptedRow = activity.find((x) => x.action === 'work.accepted')!;
  assert.equal(acceptedRow.workId, 'add-greeting');
  assert.match(acceptedRow.plain, new RegExp(`on ${REF}, locally$`));

  // Upstream с другим именем ветки: сверка и адрес отправки — по нему.
  p.git('push', '-q', 'origin', `${p.acceptedSha}^:refs/heads/release`);
  p.git('branch', '-q', '--set-upstream-to=origin/release', branch);
  r = remote();
  assert.deepEqual(
    { state: r.state, trackingRef: r.trackingRef, pushRemote: r.pushRemote, pushRef: r.pushRef },
    {
      state: 'not-pushed',
      trackingRef: 'origin/release',
      pushRemote: 'origin',
      pushRef: 'refs/heads/release',
    },
  );
  p.git('push', '-q', 'origin', `${REF}:refs/heads/release`);
  assert.equal(remote().state, 'pushed');

  // Без upstream — та же ветка origin/<имя>.
  p.git('branch', '-q', '--unset-upstream', branch);
  r = remote();
  assert.equal(r.state, 'pushed');
  assert.equal(r.trackingRef, `origin/${branch}`);
  // Дрейф после приёмки: строка отчёта есть, удалённой ветки в ней нет.
  p.commitOnRef({ 'late.txt': 'late\n' });
  const drifted = cliDataSchemas.report.parse(
    p.harness('report', '--state', p.state).json.data,
  ) as any;
  assert.equal(drifted.targets.rows.length, 1);
  assert.equal(drifted.targets.rows[0].commitsSinceAccepted, 1);
  assert.equal(drifted.targets.rows[0].remote, undefined);
  // Upstream настроен, а remote-tracking ref на машине нет — неизвестно.
  p.git('config', `branch.${branch}.remote`, 'origin');
  p.git('config', `branch.${branch}.merge`, 'refs/heads/elsewhere');
  r = remote();
  assert.equal(r.state, 'unknown');
  assert.equal(r.reason, 'удалённая ветка ещё не получена на этой машине');
  assert.equal(r.trackingRef, 'origin/elsewhere');
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
  assert.equal(target.remote!.state, 'unknown');
  assert.equal(target.remote!.reason, 'checkout репозитория не найден');
  assert.equal(target.remote!.line, 'неизвестно (checkout репозитория не найден)');
});
