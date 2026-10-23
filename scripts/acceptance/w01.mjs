#!/usr/bin/env node
/**
 * W01 — сквозной пользовательский путь «задача Relay → принятый Git-результат
 * → подтверждённая доставка» на копии Turbo Starter (fixture S01) через
 * публичный CLI и поставляемые материалы:
 *
 *   source-check → source-snapshot → review-plan → approve → run --source →
 *   source-status → (сбой доставки, правка задачи другим участником) →
 *   source-deliver → source-status → повтор source-deliver → независимое чтение.
 *
 * Получатель — настоящий Relay v1 (сервер из scripts/acceptance/relay-v1-server.mjs)
 * или Relay-2 (binary из relay-v2-fixture.mjs) на временных данных. Writer и
 * reviewer — fixture runtime (tests/fixtures/bin), вызываются отдельно.
 *
 * Две задачи: T1 (issued-at, все gates, критерии ↔ testcases JUnit) — демонстрация
 * восстановления доставки после сбоя без повторной реализации; T2 (то же
 * изменение, gate acceptance) — её постановку меняет другой участник после
 * принятия, доставка показывает конфликт и не закрывает задачу.
 *
 *   node scripts/acceptance/w01.mjs relay-v1|relay-v2 --evidence <dir> --logs <dir> [--work <dir>] [--source <url|path>]
 * Код выхода: 0 PASS, 1 FAIL, 3 BLOCKED.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  approve,
  changeFiles,
  git,
  implement,
  prepareStarterFixture,
  starterGraph,
  starterPolicy,
} from './starter-fixture.mjs';
import { Blocked, finish, harnessAsync, junitCases, recorder } from './starter-lib.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    work: { type: 'string' },
    source: { type: 'string' },
    evidence: { type: 'string' },
    logs: { type: 'string' },
  },
});
const relay = positionals[0];
if (relay !== 'relay-v1' && relay !== 'relay-v2') {
  console.error('usage: w01.mjs relay-v1|relay-v2 [--evidence dir] [--logs dir]');
  process.exit(2);
}
const W = (() => {
  const dir = resolve(values.work ?? mkdtempSync(join(tmpdir(), `w01-${relay}-`)));
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
})();
const rec = recorder(
  join(resolve(values.evidence ?? join(W, 'evidence')), 'W01', relay),
  join(resolve(values.logs ?? join(W, 'logs')), 'W01', relay),
);
const block = join(W, 'block-comments');

/** Тексты задач Relay = поручение примера (graph.json Turbo Starter). */
const order = starterGraph().orders[0];
const T1 = {
  title: order.title,
  description: order.goal,
  criteria: [
    'client OpenAPI AccessTokenDto.issuedAt is a required date-time',
    'client SDK AccessTokenDto declares issuedAt: string',
    'admin OpenAPI AccessTokenDto.issuedAt is a required date-time',
    'admin SDK AccessTokenDto declares issuedAt: string',
    'web consumer reads AccessTokenDto["issuedAt"] from the client SDK',
  ],
  /** testcase JUnit gate acceptance для каждого критерия (classname.name). */
  tests: [
    'test.issued-at: client OpenAPI AccessTokenDto.issuedAt — обязательный date-time',
    'test.issued-at: client SDK AccessTokenDto объявляет issuedAt: string',
    'test.issued-at: admin OpenAPI AccessTokenDto.issuedAt — обязательный date-time',
    'test.issued-at: admin SDK AccessTokenDto объявляет issuedAt: string',
    'test.issued-at: потребитель web использует AccessTokenDto.issuedAt из SDK',
  ],
};
const T2 = {
  title: 'Expose the access token validity window to the web app',
  description:
    'Same contract change as the issued-at task; accepted when the acceptance gate passes.',
  criteria: ['acceptance gate passes on the integrated result'],
};

/**
 * Relay v1: прокси к настоящему серверу в отдельном процессе (CLI harness
 * вызывается синхронно); при файле block отвечает отказом на POST комментария,
 * не пересылая его.
 */
async function blockingProxy(target) {
  const script = join(W, 'relay-v1-proxy.cjs');
  writeFileSync(
    script,
    `const http = require('node:http'); const fs = require('node:fs');
const target = new URL(${JSON.stringify(target)}); const block = ${JSON.stringify(block)};
const server = http.createServer((req, res) => {
  if (fs.existsSync(block) && req.method === 'POST' && /\\/comments$/.test(req.url || '')) {
    req.resume();
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'UNAVAILABLE', message: 'w01: comments blocked' } }));
    return;
  }
  const fwd = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
  });
  fwd.on('error', () => res.destroy());
  req.pipe(fwd);
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`,
  );
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((res, rej) => {
    child.stdout.once('data', (d) => res(Number(String(d).trim())));
    child.once('exit', (c) => rej(new Error('proxy exited ' + c)));
  });
  return { url: `http://127.0.0.1:${port}`, close: () => child.kill() };
}

/** Relay-2: обёртка binary; при файле block `task comment add` отклоняется до вызова настоящего binary. */
function blockingWrapper(bin) {
  const path = join(W, 'relay-w01');
  writeFileSync(
    path,
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (fs.existsSync(${JSON.stringify(block)}) && args[0] === 'task' && args[1] === 'comment' && args[2] === 'add') {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: 'UNAVAILABLE', message: 'w01: comments blocked' } }) + '\\n');
  process.exit(1);
}
const r = spawnSync(${JSON.stringify(bin)}, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

/** Независимый получатель (не адаптер harness): задача, критерии, комментарии, колонка. */
async function backend() {
  if (relay === 'relay-v1') {
    const m = await import('./relay-v1-server.mjs');
    if (!m.isBuilt())
      throw new Blocked('Relay v1 не собран: node scripts/acceptance/relay-v1-server.mjs prepare');
    const srv = await m.startRelayServer();
    const proxy = await blockingProxy(srv.url);
    const create = (t) =>
      srv.createTask({
        title: t.title,
        description: t.description,
        column: 'ready',
        criteria: t.criteria,
      });
    const read = async (ref) => {
      const task = await srv.task(ref);
      const criteria = await srv.criteria(ref);
      const comments = await srv.comments(ref);
      return {
        column: task.column,
        revision: task.revision,
        criteria: (criteria.items ?? criteria).map((c) => ({
          title: c.title,
          completed: c.completed,
        })),
        // Список отдаёт только заголовки; текст — отдельным чтением каждого комментария.
        comments: await Promise.all(
          (comments.items ?? comments).map(async (c) => ({
            id: c.id,
            body:
              (
                await srv.get(
                  `/board-tasks/${encodeURIComponent(ref)}/comments/${encodeURIComponent(c.id)}`,
                )
              ).description ?? '',
          })),
        ),
      };
    };
    return {
      info: { url: srv.url, projectId: srv.projectId, build: m.buildInfo() },
      projectId: srv.projectId,
      columns: ['ready', 'in-progress'],
      settings: { endpoint: proxy.url },
      create: async (t) => {
        const task = await create(t);
        return { ref: task.key ?? task.id, id: task.id };
      },
      read,
      edit: (ref, description) => srv.updateTask(ref, { description }),
      stop: async () => {
        proxy.close();
        await srv.stop();
      },
    };
  }
  const m = await import('./relay-v2-fixture.mjs');
  const bin = m.relayV2Binary();
  if (!bin) throw new Blocked('Relay-2 binary не найден (HARNESS_RELAY2_BIN)');
  const p = m.createRelayV2Project({ bin, name: 'W01', slug: 'w01' });
  const actor = 'relay-admin';
  const read = async (ref) => {
    const task = p.cli(['task', 'get', ref]);
    const comments = p.cli(['task', 'comment', 'list', ref]);
    return {
      column: task.data.column,
      revision: task.revision,
      criteria: task.data.acceptanceCriteria.map((c) => ({
        title: c.title,
        completed: c.completed,
      })),
      comments: (comments.items ?? comments).map((c) => ({ id: c.id, body: c.body ?? '' })),
    };
  };
  return {
    info: { root: p.root, projectId: p.projectId, binary: m.relayV2Info(bin) },
    projectId: p.projectId,
    columns: ['inbox', 'ready', 'in-progress'],
    settings: { binary: blockingWrapper(bin), config: p.config, env: p.env },
    create: async (t) => {
      const task = p.cli(
        [
          'task',
          'create',
          '--board=product',
          `--title=${t.title}`,
          `--description=${t.description}`,
          `--acceptance-criteria=${JSON.stringify(t.criteria.map((title) => ({ title })))}`,
        ],
        { actor },
      );
      return { ref: task.key, id: task.id };
    },
    read,
    edit: async (ref, description) => {
      const rev = p.cli(['task', 'get', ref]).revision;
      return p.cli(
        ['task', 'update', ref, `--description=${description}`, `--if-revision=${rev}`],
        { actor },
      );
    },
    stop: async () => p.cleanup(),
  };
}

const markers = (task) =>
  task.comments.filter((c) => c.body.includes('devcontour-harness:op=')).length;
let be;
async function main() {
  be = await backend();
  rec.json('backend.json', be.info);
  const fixture = prepareStarterFixture({
    workDir: W,
    ...(values.source ? { source: values.source } : {}),
    log: rec.log,
  });
  rec.json('fixture.json', fixture.manifest);
  const t1 = await be.create(T1);
  const t2 = await be.create(T2);
  rec.json('tasks.json', { t1, t2 });

  // Конфигурация пользователя: политика примера (operator approval, fixture runtime) и connector.json.
  const scenario = join(W, 'scenario.json');
  const files = changeFiles(fixture, 'issued-at.patch');
  // Вторая задача добавляет ещё один файл потребителя: какой бы из двух задач ни
  // достался первый вызов writer, у второй остаётся непустое изменение над новой базой.
  const extra = {
    'apps/next-web-app/src/infra/client-api/types/access-token-validity.type.ts':
      "import type { AccessTokenDto } from '@oim/client-rest-api-sdk/data-contracts'\n\n" +
      "export type AccessTokenValidity = Pick<AccessTokenDto, 'issuedAt' | 'sessionExpiresAt'>\n",
  };
  writeFileSync(
    scenario,
    JSON.stringify({
      writer: [implement(files), implement({ ...files, ...extra })],
      reviewer: approve(),
    }),
  );
  const policy = starterPolicy(fixture, {
    repoPath: 'turbo-starter',
    scenario,
    edit: (p) => {
      p.approvalMode = 'operator';
    },
  });
  writeFileSync(join(W, 'policy.json'), JSON.stringify(policy, null, 2));
  const connector = {
    version: 1,
    provider: relay === 'relay-v1' ? 'relay-v1-http' : 'relay-v2-cli',
    relay: be.settings,
    projectId: be.projectId,
    actor: 'harness-controller',
    repository: { id: 'starter' },
    tasks: [
      {
        ref: t1.ref,
        role: 'developer',
        writeScope: order.writeScope,
        gates: order.gates,
        criteria: T1.criteria.map((title, i) => ({
          title,
          gate: 'acceptance',
          testId: T1.tests[i],
        })),
      },
      {
        ref: t2.ref,
        role: 'developer',
        writeScope: order.writeScope,
        gates: ['acceptance'],
        criteria: [{ title: T2.criteria[0], gate: 'acceptance', evidence: 'gate' }],
      },
    ],
    completion: { mode: 'complete', historicalComment: false },
    eligibility: { columns: be.columns },
    history: { enabled: true, client: 'devcontour-harness' },
  };
  writeFileSync(join(W, 'connector.json'), JSON.stringify(connector, null, 2));
  rec.json('connector.json', connector);
  rec.json('policy.json', policy);

  const env = { PATH: [...fixture.pathPrepend, process.env.PATH].join(':') };
  const state = join(W, 'state');
  const cli = async (label, args) => {
    const r = await harnessAsync(rec, label, args, { cwd: W, env });
    rec.json(`cli/${label}.json`, r.json ?? { status: r.status, stderr: r.stderr.slice(-4000) });
    return r;
  };
  const counts = () => ({
    writer: Number(
      existsSync(`${scenario}.claude.writer.count`)
        ? readFileSync(`${scenario}.claude.writer.count`, 'utf8')
        : 0,
    ),
    reviewer: Number(
      existsSync(`${scenario}.codex.reviewer.count`)
        ? readFileSync(`${scenario}.codex.reviewer.count`, 'utf8')
        : 0,
    ),
  });
  /** SHA target ref; до первой инициализации harness ref ещё нет — ''. */
  const target = () => {
    try {
      return git(fixture.repo, ['rev-parse', '--verify', '-q', policy.repositories[0].targetRef]);
    } catch {
      return '';
    }
  };

  // 1. Проверка подключения — только чтение.
  const before1 = await be.read(t1.ref);
  const check = await cli('1-source-check', [
    'source-check',
    '--source',
    'connector.json',
    '--policy',
    'policy.json',
    '--state',
    state,
  ]);
  rec.check(
    'W01: source-check — подключение, проект, mapping',
    check.status === 0 && check.json?.data?.connected,
    check.json,
  );
  rec.check(
    'W01: source-check ничего не записал в задачу',
    JSON.stringify(await be.read(t1.ref)) === JSON.stringify(before1),
    'read-only',
  );

  // 2. Снимок.
  const snap = await cli('2-source-snapshot', [
    'source-snapshot',
    '--source',
    'connector.json',
    '--state',
    state,
    '--out',
    'snapshot',
  ]);
  rec.check(
    'W01: source-snapshot — обе задачи допущены',
    snap.status === 0 && snap.json?.data?.eligible && snap.json.data.tasks.length === 2,
    snap.json,
  );
  for (const f of ['graph.json', 'context.json', 'manifest.json'])
    rec.copy(join(W, 'snapshot', f), `snapshot/${f}`);

  // 3–4. Согласование оператором по файлам снимка.
  const review = await cli('3-review-plan', [
    'review-plan',
    '--state',
    state,
    '--policy',
    'policy.json',
    '--graph',
    'snapshot/graph.json',
    '--context',
    'snapshot/context.json',
    '--author',
    'external',
  ]);
  rec.check(
    'W01: review-plan одобрен независимым reviewer',
    review.status === 0 && review.json?.data?.approved,
    review.json,
  );
  const approved = await cli('4-approve', [
    'approve',
    '--state',
    state,
    '--subject',
    snap.json.data.graphId,
    '--digest',
    review.json.data.digest,
  ]);
  rec.check('W01: approve', approved.status === 0, approved.json);
  const afterApproval = counts();

  // 5. Запуск из источника; получатель комментариев временно недоступен — доставка не завершится.
  writeFileSync(block, 'w01');
  const baseTarget = target();
  const run = await cli('5-run-source', [
    'run',
    '--source',
    'connector.json',
    '--policy',
    'policy.json',
    '--state',
    state,
    '--author',
    'external',
  ]);
  const works = run.json?.data?.works ?? [];
  for (const w of works)
    if (w.status !== 'done')
      await cli(`5b-result-${w.id}`, ['result', '--state', state, '--work', w.id]);
  rec.check(
    'W01: run --source — обе задачи приняты в Git',
    works.length === 2 && works.every((w) => w.status === 'done'),
    run.json?.data ?? run.json,
  );
  const accepted = target();
  rec.check(
    'W01: target ref сдвинут на результат',
    accepted && accepted !== baseTarget && works.some((w) => w.resultSha === accepted),
    { baseTarget, accepted },
  );
  const afterRun = counts();
  rec.json('runtime-calls.json', { afterApproval, afterRun });
  rec.check(
    'W01: writer вызван по разу на задачу, reviewer — отдельно',
    afterRun.writer === 2 && afterRun.reviewer >= 5,
    afterRun,
  );

  // 6. Статус: принято локально, не доставлено.
  const status1 = await cli('6-source-status-blocked', [
    'source-status',
    '--source',
    'connector.json',
    '--state',
    state,
  ]);
  const s1 = status1.json?.data?.tasks ?? [];
  rec.check(
    'W01: source-status — принято локально, доставка не завершена',
    s1.length === 2 &&
      s1.every(
        (t) => t.local.status === 'done' && !t.deliveries.some((d) => d.status === 'delivered'),
      ),
    s1.map((t) => ({
      ref: t.ref,
      local: t.local,
      deliveries: t.deliveries,
      operations: t.operations?.map((o) => o.status),
    })),
  );
  const t1Blocked = await be.read(t1.ref);
  rec.check(
    'W01: при сбое получатель не получил комментария и задача не закрыта',
    markers(t1Blocked) === 0 && !['done'].includes(t1Blocked.column),
    t1Blocked,
  );

  // Другой участник меняет постановку T2 после принятия.
  await be.edit(t2.ref, T2.description + ' Changed by another participant after acceptance.');

  // 7. Доступ восстановлен — продолжение доставки тем же ключом.
  rmSync(block);
  const deliver = await cli('7-source-deliver', [
    'source-deliver',
    '--source',
    'connector.json',
    '--state',
    state,
  ]);
  let status2 = await cli('8-source-status', [
    'source-status',
    '--source',
    'connector.json',
    '--state',
    state,
  ]);
  let tasks2 = status2.json?.data?.tasks ?? [];
  let s2t1 = tasks2.find((t) => t.ref === t1.ref);
  // Отказ получателя на комментарии коннектор не считает доказанным «не записано»:
  // операция в `uncertain`. Разбор — фактами получателя (reconcile), затем — при
  // 0 маркеров — явное решение оператора `resend` с тем же маркером, а не слепой повтор.
  const reconciled = [];
  for (const task of tasks2)
    for (const op of task.operations ?? [])
      if (op.status === 'uncertain') {
        const facts = await cli(`7b-source-reconcile-${task.ref}`, [
          'source-reconcile',
          '--source',
          'connector.json',
          '--state',
          state,
          '--operation',
          op.key,
        ]);
        const entry = {
          ref: task.ref,
          operation: op.key,
          markers: task.remote?.markers?.[op.key],
          facts: facts.json?.data,
        };
        if (!facts.json?.data?.resolved && task.remote?.markers?.[op.key] === 0) {
          const resend = await cli(`7c-source-reconcile-resend-${task.ref}`, [
            'source-reconcile',
            '--source',
            'connector.json',
            '--state',
            state,
            '--operation',
            op.key,
            '--decision',
            'resend',
          ]);
          entry.resend = resend.json?.data ?? resend.json;
        }
        reconciled.push(entry);
      }
  rec.json('reconcile.json', reconciled);
  if (reconciled.length) {
    status2 = await cli('8b-source-status', [
      'source-status',
      '--source',
      'connector.json',
      '--state',
      state,
    ]);
    tasks2 = status2.json?.data?.tasks ?? [];
    s2t1 = tasks2.find((t) => t.ref === t1.ref);
  }
  const s2t2 = tasks2.find((t) => t.ref === t2.ref);
  rec.json('status-after-recovery.json', status2.json?.data);
  rec.check(
    'W01: T1 доставлена после восстановления',
    s2t1?.deliveries.some((d) => d.status === 'delivered'),
    { deliver: deliver.json?.data, s2t1 },
  );
  rec.check(
    'W01: T2 — конфликт: постановка изменилась, результат остаётся историческим, задача не закрыта',
    s2t2 &&
      !s2t2.deliveries.some((d) => d.status === 'delivered') &&
      s2t2.deliveries.some((d) => d.status === 'conflict') &&
      s2t2.remote.matchesSnapshot === false,
    s2t2,
  );
  const afterDeliver = counts();
  rec.check(
    'W01: восстановление доставки без повторной реализации и без изменения Git',
    JSON.stringify(afterDeliver) === JSON.stringify(afterRun) && target() === accepted,
    { afterRun, afterDeliver },
  );

  // 9. Повтор доставки — без новых записей у получателя.
  const t1Delivered = await be.read(t1.ref);
  const again = await cli('9-source-deliver-repeat', [
    'source-deliver',
    '--source',
    'connector.json',
    '--state',
    state,
    '--work',
    s2t1.workId,
  ]);
  const t1Again = await be.read(t1.ref);
  rec.check(
    'W01: повтор доставки идемпотентен (те же комментарии, критерии, колонка)',
    again.status === 0 && JSON.stringify(t1Again) === JSON.stringify(t1Delivered),
    { t1Delivered, t1Again },
  );

  // Независимое чтение получателя.
  const t2Final = await be.read(t2.ref);
  rec.json('readback.json', { t1: t1Again, t2: t2Final });
  rec.check(
    'W01: T1 — ровно один комментарий-итог с маркером',
    markers(t1Again) === 1,
    t1Again.comments,
  );
  const summary =
    t1Again.comments.find((c) => c.body.includes('devcontour-harness:op='))?.body ?? '';
  rec.text('t1-result-comment.md', summary);
  rec.check(
    'W01: итог содержит проверяемый result SHA и не содержит локальных путей',
    Boolean(s2t1.local.resultSha) &&
      summary.includes(s2t1.local.resultSha) &&
      git(fixture.repo, ['merge-base', '--is-ancestor', s2t1.local.resultSha, accepted]) === '' &&
      !summary.includes(W),
    { resultSha: s2t1.local.resultSha, target: accepted },
  );
  rec.check(
    'W01: критерии T1 отмечены по testcase JUnit',
    t1Again.criteria.length === 5 && t1Again.criteria.every((c) => c.completed),
    t1Again.criteria,
  );
  rec.check('W01: T1 закрыта (completion complete)', t1Again.column === 'done', t1Again.column);
  rec.check(
    'W01: T2 не закрыта и без отметок критериев',
    t2Final.column !== 'done' && t2Final.criteria.every((c) => !c.completed),
    t2Final,
  );
  // JUnit принятого результата T1.
  const result = await cli('10-result', ['result', '--state', state, '--work', s2t1.workId]);
  const runId = result.json?.data?.result?.runId;
  const xml = join(state, 'artifacts', runId, 'integration', 'acceptance.xml');
  rec.copy(xml, 'junit/integration-acceptance.xml');
  const cases = junitCases(readFileSync(xml, 'utf8'));
  rec.check(
    'W01: JUnit integration acceptance — 5 testcases passed',
    cases.length === 5 && cases.every((c) => c.outcome === 'passed'),
    cases,
  );
  rec.json('shas.json', {
    upstream: fixture.upstream,
    baseline: fixture.baselineSha,
    target: accepted,
    t1: s2t1.local,
    t2: s2t2.local,
  });
}

let error;
try {
  await main();
} catch (e) {
  error = e;
} finally {
  try {
    await be?.stop();
  } catch (e) {
    rec.log('остановка получателя: ' + e.message);
  }
}
finish(rec, `W01/${relay}`, error, { work: W });
