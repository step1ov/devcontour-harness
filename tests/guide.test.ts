import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guideDataSchema } from '../src/contracts/cli.ts';
import { guideIndex, guideSection, guideTopics, skillsRoot } from '../src/guide/guide.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harness = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    encoding: 'utf8',
  });
const skill = readFileSync(join(skillsRoot, 'harness', 'SKILL.md'), 'utf8');

test('guide: SKILL.md — короткое оглавление (≤ 8000 знаков), построенное из разделов guide', () => {
  assert.ok(skill.length <= 8000, `${skill.length} знаков`);
  assert.ok(skill.includes(guideIndex()), 'оглавление перестроено: scripts/guide-index.ts');
  for (const t of guideTopics) assert.ok(skill.includes(`\`$H guide ${t}\``), t);
  // Каждый файл каталога guide — тема оглавления; потерянных файлов нет.
  const files = readdirSync(join(skillsRoot, 'harness', 'guide')).map((f) =>
    f.replace(/\.md$/, ''),
  );
  assert.deepEqual([...files].sort(), guideTopics.filter((t) => t !== 'relay').sort());
});

test('guide: каждая тема — непустой раздел со своими заголовками; ключевые правила на месте', () => {
  const texts = Object.fromEntries(guideTopics.map((t) => [t, guideSection(t).text]));
  for (const t of guideTopics) {
    const s = guideSection(t);
    assert.ok(s.text.length > 500, t);
    assert.ok(s.headings.length > 0, t);
    guideDataSchema.parse({ topic: s.topic, title: s.title, headings: s.headings, text: s.text });
  }
  // Ревью D/E MEDIUM-2: правила сессии — в теме, которую оглавление велит читать первой.
  assert.match(skill, /Every session, new or resumed, starts with `\$H guide session`/);
  assert.equal(guideTopics[0], 'session');
  for (const rule of [
    /\$H lead begin --state/,
    /Inside\s+your open session `retry` needs an explicit role/,
    /`input-answer` without `--actor` is always the operator's/,
    /\$H lead note/,
    /\$H lead end --state/,
    /### 10\. New session[^]*0\. `\$H lead begin/,
  ])
    assert.match(texts.session!, rule);
  for (const t of guideTopics.filter((x) => x !== 'session'))
    assert.doesNotMatch(texts[t]!, /At the start of your session: `\$H lead begin/, t);
  assert.match(texts.run!, /\$H wait --state/);
  assert.match(texts.run!, /do not loop `status`/);
  assert.match(texts.recovery!, /explain/);
  assert.match(texts.release!, /release done/);
  assert.match(texts.review!, /review-code/);
  assert.match(texts.relay!, /connector\.json/);
  assert.match(texts.setup!, /H=<tooldir>\/node_modules\/\.bin\/harness/);
  assert.throws(() => guideSection('nope'), /INVALID_INPUT|Тема guide/);
});

test('guide CLI: `harness guide run` печатает текст раздела без конверта; --json — конверт; чужая тема — exit 2', () => {
  const text = harness('guide', 'run');
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, guideSection('run').text);
  const json = harness('guide', '--topic', 'recovery', '--json');
  assert.equal(json.status, 0, json.stderr);
  const envelope = JSON.parse(json.stdout) as {
    ok: boolean;
    data: { topic: string; text: string };
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.topic, 'recovery');
  assert.equal(envelope.data.text, guideSection('recovery').text);
  const bad = harness('guide', 'nope');
  assert.equal(bad.status, 2);
  assert.equal((JSON.parse(bad.stdout) as { error: { code: string } }).error.code, 'INVALID_INPUT');
});

test('guide: разделы входят в пакет (npm pack) рядом с SKILL.md', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const r = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const [pack] = JSON.parse(r.stdout) as { files: { path: string }[] }[];
  const paths = new Set(pack!.files.map((f) => f.path));
  assert.ok(paths.has('skills/harness/SKILL.md'));
  assert.ok(paths.has('skills/harness-setup/SKILL.md'), 'тема relay');
  for (const t of guideTopics.filter((x) => x !== 'relay'))
    assert.ok(paths.has(`skills/harness/guide/${t}.md`), t);
});

test('guide thin (alpha.73): весь поток тонкого режима для ведущего, не длиннее 8000 знаков', () => {
  const s = guideSection('thin');
  assert.ok(s.text.length <= 8000, `${s.text.length} знаков`);
  for (const rule of [
    /init --repository <repo> --harness-mode thin/,
    /3–5 works/,
    /run --detach --log/,
    /lead drive/,
    /\$H wait --state/,
    /gate-environment/,
    /merge-conflict/,
    /maxAttempts/,
    /Release ready/,
    /review-release/,
    /What thin mode does NOT have/,
    /retry --reset/,
    /retry --start-over/,
    // Ревью a74 M3: разрушающую миграцию ведущий не решает.
    /migration question, check it is additive or reversible.*is the owner's — do not answer it, pass it on/s,
  ])
    assert.match(s.text, rule);
  assert.match(
    guideSection('recovery').text,
    /Before you answer a\s+`migration` question, check that every option is additive or reversible.*is the owner's even when marked `impact: technical`: do not\s+answer it, pass it on/s,
  );
  assert.ok(skill.includes('`$H guide thin`'), 'тема в оглавлении skill');
  const cli = harness('guide', 'thin');
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /### Thin mode in one page/);
});
