/**
 * C02: прежнее состояние и receipts DevContour под новым архивом harness.
 * Запускается `devcontour-check.mjs` из копии DevContour (cwd — копия, loader
 * tsx копии); сам файл лежит вне копии, поэтому её дерево не меняется.
 *
 *   node --import tsx devcontour-state.mjs <before|after> <каталог состояния>
 *   (env DEVCONTOUR_COPY — корень копии DevContour)
 *
 * before — версия «до» (vendored alpha.4): доска, задачи A, B; A принята
 *          существующим хостом; receipt A строится (`completion`); роль
 *          controller истекает сама (короткий срок). Снимок — before.json.
 * after  — версия «после» (проверяемый архив): то же состояние открывается
 *          без переписывания: запись A, её попытки, receipt A и журнал
 *          событий «до» совпадают побайтно (канонический JSON); затем новая
 *          принятая попытка B через тот же хост: версия движка — новая,
 *          версия потребителя — DevContour; receipt B строится. После
 *          записи B запись A и receipt A по-прежнему прежние.
 * review-protocol — версия «после», чек-лист HR: задача C — сначала
 *          невалидная запись ревью (`reviewRound.protocol: invalid`), затем
 *          валидная с находками `id/status` на том же SHA и фазе; приёмка
 *          проходит, поля переживают круг через хранилище DevContour (документ
 *          и представление движка) и receipt строится. Задача D — отказ
 *          попытки видом `review-protocol`: вид сохраняется в записи попытки;
 *          `REVIEW_PROTOCOL_INVALID` переводится в ошибку прикладного слоя с
 *          тем же кодом. Снимок базы — protocol.json.
 * hold-lead — версия «после» берёт роль controller (`controller-hold`) и
 *          завершается, не снимая её: живая роль alpha.6 на копии состояния
 *          (срок — env DEVCONTOUR_STATE_LEASE_MS).
 * old-opens <dir> <a|b|c> — версия «до» (отдельная копия с vendored alpha.4,
 *          env DEVCONTOUR_COPY) над копией состояния alpha.6, как это сделал бы
 *          оператор: открыть, прочитать, взять роль, выдать работу (без паузы —
 *          пауза сама запись). Случаи: a — состояние alpha.6 без записей ревью
 *          нового протокола; b — с ними (`reviewRound`, `findings[].id/status`)
 *          без живой роли alpha.6; c — с ними и живой ролью alpha.6. Фиксирует
 *          отказ, роль, выдачу, изменённые таблицы и сохранность новых полей.
 *          Отказ шага: потеря полей; в случае c — перехват роли или любая
 *          запись.
 * Итог — JSON в stdout; несоответствие — исключение и ненулевой exit.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [step, dir, oldCase] = process.argv.slice(2);
const copy = process.env.DEVCONTOUR_COPY;
if (!step || !dir || !copy) {
  console.error('devcontour-state: <before|after> <каталог> (env DEVCONTOUR_COPY)');
  process.exit(2);
}
const load = (rel) => import(pathToFileURL(join(copy, rel)).href);
const { configSchema } = await load('src/core/model.ts');
const { DevContour } = await load('src/core/service.ts');
const { Store } = await load('src/core/store.ts');
const { completion } = await load('src/core/sync-state.ts');
const harnessVersion = JSON.parse(
  readFileSync(join(copy, 'node_modules/devcontour-harness/package.json'), 'utf8'),
).version;

// Срок роли: короткий по умолчанию; шаг hold-lead держит роль дольше (env).
const LEASE_MS = Number(process.env.DEVCONTOUR_STATE_LEASE_MS ?? 5000);
const SHA_CANDIDATE = 'c'.repeat(40);
const SHA_MERGED_A = 'b'.repeat(40);
const SHA_MERGED_B = 'd'.repeat(40);
const SHA_MERGED_C = 'f'.repeat(40);
const DIGEST = 'e'.repeat(64);
const database = join(dir, 'state.sqlite');
const snapshotFile = join(dir, 'before.json');
const config = configSchema.parse({
  version: 1,
  name: 'C02 state check',
  repository: dir,
  mode: 'demo',
  concurrency: 2,
  leaseMs: LEASE_MS,
  roles: { qa: { runtime: 'demo' } },
  reviewer: { runtime: 'demo' },
  gates: [
    {
      id: 'test',
      kind: 'test',
      command: ['node', 'verify.mjs'],
      report: { type: 'junit', path: '.reports/junit.xml' },
    },
  ],
});
const task = (title) => ({
  title,
  description: 'An observable independent outcome.',
  role: 'qa',
  dependsOn: [],
  acceptance: ['The expected result is checked.'],
});
/** Канонический JSON: порядок ключей не влияет, значения — побайтно. */
const canonical = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
const digest = (v) => createHash('sha256').update(canonical(v)).digest('hex');
const open = () => {
  const store = new Store(database);
  return { store, h: new DevContour(store, config) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (value) => console.log(JSON.stringify({ step, harnessVersion, ...value }, null, 2));

/** Принятие задачи существующим хостом: evidence обеих фаз и finish (fixture SHA, без Git). */
function accept(h, owner, id, merged) {
  const run = h.claim(owner);
  assert.equal(run?.taskId, id, 'выдана не та задача');
  h.phase(run.id, run.token, 'integrating', {
    candidateSha: SHA_CANDIDATE,
    integrationSha: merged,
  });
  for (const phase of ['candidate', 'integration'])
    for (const kind of ['test', 'review'])
      h.evidence(run.id, run.token, {
        kind,
        phase,
        sha: phase === 'candidate' ? SHA_CANDIDATE : merged,
        gate: kind === 'test' ? 'test' : 'independent-review',
        passed: true,
        command: ['fixture'],
        exitCode: 0,
        log: 'fixture',
        digest: DIGEST,
        summary: 'C02 fixture',
      });
  h.finish(run.id, run.token, merged);
  return run;
}
const recordOf = (s, id) => ({
  task: s.tasks.find((t) => t.id === id),
  runs: s.runs.filter((r) => r.taskId === id),
});

if (step === 'before') {
  const { store, h } = open();
  const board = h.createBoard('C02');
  const a = h.addTask(board.id, task('Accepted before the upgrade'));
  const b = h.addTask(board.id, task('Accepted after the upgrade'));
  const c = h.addTask(board.id, task('Review protocol round-trip'));
  const d = h.addTask(board.id, task('Review protocol failure kind'));
  h.approve(board.id);
  h.pause(false);
  assert.equal(h.leader('controller-1'), true);
  const run = accept(h, 'controller-1', a.id, SHA_MERGED_A);
  const s = store.read();
  const receipt = completion(
    h,
    s,
    s.tasks.find((t) => t.id === a.id),
  );
  const events = store.allEvents();
  const snapshot = {
    harnessVersion,
    a: { id: a.id, run: run.id, record: recordOf(s, a.id) },
    b: { id: b.id },
    c: { id: c.id },
    d: { id: d.id },
    receipt,
    events,
    leader: s.leader,
  };
  store.close();
  writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));
  out({
    accepted: a.id,
    engineVersion: s.runs.find((r) => r.id === run.id)?.engineVersion,
    receipt: { id: receipt.id, digest: digest(receipt) },
    events: events.length,
  });
} else if (step === 'after') {
  const before = JSON.parse(readFileSync(snapshotFile, 'utf8'));
  assert.notEqual(before.harnessVersion + '', '', 'нет версии «до»');
  const { store, h } = open();
  // 1. Чтение прежнего состояния новой версией: ничего не переписано.
  let s = store.read();
  assert.equal(
    canonical(recordOf(s, before.a.id)),
    canonical(before.a.record),
    'запись A переписана',
  );
  const receiptNow = completion(
    h,
    s,
    s.tasks.find((t) => t.id === before.a.id),
  );
  assert.equal(canonical(receiptNow), canonical(before.receipt), 'receipt A изменился');
  const eventsNow = store.allEvents();
  assert.equal(
    canonical(eventsNow.slice(0, before.events.length)),
    canonical(before.events),
    'журнал событий «до» переписан',
  );
  // 2. Роль прежней версии истекает; новая принятая попытка B через тот же хост.
  await sleep(Math.max(0, (before.leader?.leaseUntil ?? 0) - Date.now()) + 300);
  h.expire();
  assert.equal(h.leader('controller-2'), true, 'новая версия не получила роль после истечения');
  const run = accept(h, 'controller-2', before.b.id, SHA_MERGED_B);
  s = store.read();
  const fresh = s.runs.find((r) => r.id === run.id);
  assert.equal(fresh.status, 'succeeded', 'попытка B не принята');
  assert.equal(fresh.engineVersion, harnessVersion, 'версия движка новой попытки');
  assert.equal(s.tasks.find((t) => t.id === before.b.id).resultSha, SHA_MERGED_B);
  const receiptB = completion(
    h,
    s,
    s.tasks.find((t) => t.id === before.b.id),
  );
  assert.equal(receiptB.taskId, before.b.id);
  assert.equal(receiptB.resultSha, SHA_MERGED_B);
  // 3. После новой записи прежние основания остаются прежними.
  assert.equal(
    canonical(recordOf(s, before.a.id)),
    canonical(before.a.record),
    'A изменена записью B',
  );
  assert.equal(
    canonical(
      completion(
        h,
        s,
        s.tasks.find((t) => t.id === before.a.id),
      ),
    ),
    canonical(before.receipt),
    'receipt A изменён записью B',
  );
  const eventsAfter = store.allEvents();
  assert.equal(
    canonical(eventsAfter.slice(0, before.events.length)),
    canonical(before.events),
    'журнал «до» переписан записью B',
  );
  store.close();
  out({
    previousVersion: before.harnessVersion,
    a: { unchanged: true, digest: digest(before.a.record), receipt: digest(before.receipt) },
    events: { before: before.events.length, after: eventsAfter.length, prefixUnchanged: true },
    newAttempt: {
      id: fresh.id,
      task: before.b.id,
      status: fresh.status,
      engineVersion: fresh.engineVersion,
      consumerVersion: fresh.consumerVersion,
      receipt: digest(receiptB),
    },
    leader: s.leader,
  });
} else if (step === 'review-protocol') {
  const before = JSON.parse(readFileSync(snapshotFile, 'utf8'));
  const { toDomain, executionOf } = await load('src/harness/execution.ts');
  const { HarnessError } = await import(
    pathToFileURL(join(copy, 'node_modules/devcontour-harness/lib/index.js')).href
  );
  const { store, h } = open();
  assert.equal(h.leader('controller-2'), true, 'роль новой версии');
  // C: невалидная, затем валидная запись ревью на том же SHA и фазе.
  const run = h.claim('controller-2');
  assert.equal(run?.taskId, before.c.id, 'выдана не задача C');
  h.phase(run.id, run.token, 'integrating', {
    candidateSha: SHA_CANDIDATE,
    integrationSha: SHA_MERGED_C,
  });
  const scope = 'a'.repeat(64);
  const findingId = '1'.repeat(64);
  const round = (protocol, call, extra = {}) => ({
    version: 1,
    scope,
    round: 1,
    call,
    calls: 2,
    protocol,
    expected: [],
    ...extra,
  });
  const sent = [];
  for (const phase of ['candidate', 'integration']) {
    const sha = phase === 'candidate' ? SHA_CANDIDATE : SHA_MERGED_C;
    const base = {
      phase,
      sha,
      command: ['fixture'],
      exitCode: 0,
      log: 'fixture',
      digest: DIGEST,
    };
    h.evidence(run.id, run.token, {
      ...base,
      kind: 'test',
      gate: 'test',
      passed: true,
      summary: 'ok',
    });
    const invalid = {
      ...base,
      kind: 'review',
      gate: 'independent-review',
      passed: false,
      summary: 'protocol error',
      reviewRound: round('invalid', 1, {
        issues: [{ path: 'findings[0].id', reason: 'unknown', message: 'fixture protocol issue' }],
      }),
    };
    const valid = {
      ...base,
      kind: 'review',
      gate: 'independent-review',
      passed: true,
      summary: 'approved',
      findings: [{ severity: 'note', message: 'fixture note', id: findingId, status: 'closed' }],
      reviewRound: round('valid', 2, {
        transitions: [{ id: findingId, from: 'open', to: 'closed', basis: 'fixed' }],
      }),
    };
    for (const e of [invalid, valid]) {
      try {
        h.evidence(run.id, run.token, e);
      } catch (error) {
        throw new Error(`запись ревью (${e.reviewRound.protocol}) отклонена: ${error.message}`);
      }
      sent.push(e);
    }
  }
  h.finish(run.id, run.token, SHA_MERGED_C);
  let s = store.read();
  const doneC = s.runs.find((r) => r.id === run.id);
  assert.equal(doneC.status, 'succeeded', 'невалидная запись ревью сорвала приёмку');
  assert.equal(s.tasks.find((t) => t.id === before.c.id).status, 'done');
  // Круг через хранилище DevContour: документ и представление движка.
  const pick = (e) => ({
    kind: e.kind,
    phase: e.phase,
    passed: e.passed,
    findings: e.findings,
    reviewRound: e.reviewRound,
  });
  const reviewsIn = (list) => list.filter((e) => e.kind === 'review').map(pick);
  const want = canonical(reviewsIn(sent));
  const fromDocument = reviewsIn(doneC.evidence ?? []);
  const { engine } = executionOf(h);
  const fromEngine = reviewsIn(engine.read((v) => v.attempt(run.id)).evidence ?? []);
  assert.equal(canonical(fromDocument), want, 'документ DevContour потерял поля ревью');
  assert.equal(canonical(fromEngine), want, 'представление движка потеряло поля ревью');
  const receiptC = completion(
    h,
    s,
    s.tasks.find((t) => t.id === before.c.id),
  );
  // D: отказ попытки видом review-protocol.
  const runD = h.claim('controller-2');
  assert.equal(runD?.taskId, before.d.id, 'выдана не задача D');
  h.fail(runD.id, runD.token, 'reviewer protocol retries exhausted', false, 'review-protocol');
  s = store.read();
  const failedD = s.runs.find((r) => r.id === runD.id);
  assert.equal(failedD.failureKind, 'review-protocol', 'вид отказа не сохранён');
  const mapped = toDomain(new HarnessError('REVIEW_PROTOCOL_INVALID', 'fixture'));
  assert.equal(mapped.code, 'REVIEW_PROTOCOL_INVALID');
  h.pause(true, 'shutdown');
  store.close();
  writeFileSync(join(dir, 'protocol.json'), JSON.stringify({ c: run.id, d: runD.id }));
  out({
    c: {
      run: run.id,
      status: doneC.status,
      reviewRecords: fromDocument.length,
      protocols: fromDocument.map((e) => e.reviewRound?.protocol),
      roundTrip: true,
      receipt: digest(receiptC),
    },
    d: { run: runD.id, status: failedD.status, failureKind: failedD.failureKind },
    errorCode: { code: mapped.code, status: mapped.status, message: mapped.message },
  });
} else if (step === 'old-opens') {
  const { DatabaseSync } = await import('node:sqlite');
  const tablesOf = () => {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);
      return Object.fromEntries(
        names.map((t) => [t, canonical(db.prepare(`SELECT * FROM "${t}"`).all())]),
      );
    } finally {
      db.close();
    }
  };
  const newFields = () => {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const doc = JSON.parse(db.prepare('SELECT data FROM state WHERE id=1').get().data);
      const ev = doc.runs.flatMap((r) => r.evidence ?? []);
      return {
        reviewRound: ev.filter((e) => e.reviewRound).map((e) => canonical(e.reviewRound)),
        findingIds: ev
          .flatMap((e) => e.findings ?? [])
          .filter((f) => f.id)
          .map(canonical),
        failureKinds: doc.runs.map((r) => r.failureKind).filter(Boolean),
      };
    } finally {
      db.close();
    }
  };
  if (!['a', 'b', 'c'].includes(oldCase ?? '')) throw new Error('old-opens: случай a|b|c');
  const leaderOf = () => {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      return JSON.parse(db.prepare('SELECT data FROM state WHERE id=1').get().data).leader ?? null;
    } finally {
      db.close();
    }
  };
  const before = tablesOf();
  const fieldsBefore = newFields();
  const leaderBefore = leaderOf();
  if (oldCase === 'a')
    assert.equal(fieldsBefore.reviewRound.length, 0, 'случай a: в состоянии есть reviewRound');
  else assert.ok(fieldsBefore.reviewRound.length > 0, 'в состоянии нет записей с reviewRound');
  const live = Boolean(leaderBefore && leaderBefore.leaseUntil > Date.now() + 2000);
  if (oldCase === 'c')
    assert.ok(
      live && leaderBefore.engineVersion !== harnessVersion,
      'случай c: нет живой роли alpha.6',
    );
  else assert.ok(!live, `случай ${oldCase}: роль ещё жива`);
  let refusal;
  let observed;
  try {
    const { store, h } = open();
    try {
      const s = store.read();
      observed = {
        lead: h.leader('controller-old'),
        issued: Boolean(h.claim('controller-old')),
        runs: s.runs.length,
      };
    } finally {
      store.close();
    }
  } catch (error) {
    refusal = String(error?.message ?? error).slice(0, 400);
  }
  const after = tablesOf();
  const changedTables = Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t]);
  const fieldsAfter = newFields();
  const leaderAfter = leaderOf();
  assert.equal(canonical(fieldsAfter), canonical(fieldsBefore), 'версия «до» потеряла новые поля');
  if (oldCase === 'c') {
    assert.ok(!observed?.lead, 'случай c: прежняя версия перехватила живую роль alpha.6');
    assert.deepEqual(changedTables, [], 'случай c: прежняя версия записала при живой роли alpha.6');
    assert.equal(canonical(leaderAfter), canonical(leaderBefore), 'случай c: роль изменена');
  }
  out({
    case: oldCase,
    refused: Boolean(refusal),
    refusal,
    observed,
    wrote: changedTables.length > 0,
    changedTables,
    leaderBefore,
    leaderAfter,
    liveNewRoleBefore: live,
    newFieldsPreserved: true,
    preserved: {
      reviewRound: fieldsAfter.reviewRound.length,
      findingIds: fieldsAfter.findingIds.length,
      failureKinds: fieldsAfter.failureKinds,
    },
  });
} else if (step === 'hold-lead') {
  const { store, h } = open();
  assert.equal(h.leader('controller-hold'), true, 'роль новой версии не получена');
  const leader = store.read().leader;
  assert.equal(leader.engineVersion, harnessVersion);
  store.close();
  // Роль не снимается: процесс «падает» с живой ролью.
  out({ leader });
} else {
  console.error('devcontour-state: неизвестный шаг ' + step);
  process.exit(2);
}
