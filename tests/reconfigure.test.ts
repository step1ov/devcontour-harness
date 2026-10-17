import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HarnessError,
  digestOf,
  executionDigest,
  policyDigest,
  type ErrorCode,
  type ExecutionPolicy,
} from '../src/contracts/index.ts';
import { Engine } from '../src/engine/engine.ts';
import { standaloneHost } from '../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../src/storage/sqlite.ts';
import { policySourceChanged, policySourceOf } from '../src/control/provenance.ts';
import { engineOf, graphOf, policyOf, ready, sha } from './engine-fixture.ts';

const refused = (code: ErrorCode, message?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  if (message) assert.match(e.message, message);
  return true;
};

/** Ещё один процесс над тем же файлом состояния: своя политика, свои часы. */
function processOf(
  dir: string,
  policy: ExecutionPolicy,
  options: {
    now?: () => number;
    provenance?: () => string | undefined;
    policyIdentity?: string;
  } = {},
) {
  const store = new SqliteExecutionStore(join(dir, 'state.sqlite'), 'test');
  let n = 0;
  return new Engine({
    host: standaloneHost(store, policy),
    policy,
    now: options.now ?? (() => Date.parse('2026-01-01T00:00:00.000Z')),
    id: () => `p-${String(++n).padStart(6, '0')}-${Math.random().toString(16).slice(2, 8)}`,
    ...(options.provenance ? { provenance: options.provenance } : {}),
    ...(options.policyIdentity ? { policyIdentity: options.policyIdentity } : {}),
  });
}

/** Провести попытку через обе фазы с PASS всех gates и ревью. */
function passEvidence(e: Engine, id: string, token: string) {
  e.phase(id, token, 'verifying', { candidateSha: sha('a') });
  for (const [phase, at] of [
    ['candidate', sha('a')],
    ['integration', sha('b')],
  ] as const) {
    if (phase === 'integration') e.phase(id, token, 'integrating', { integrationSha: at });
    for (const kind of ['test', 'review'] as const)
      e.evidence(id, token, {
        kind,
        phase,
        sha: at,
        gate: kind === 'test' ? 'unit' : 'independent-review',
        passed: true,
        command: ['x'],
        exitCode: 0,
        log: '',
        digest: digestOf(kind + phase),
        summary: 'ok',
        ...(kind === 'review' ? { findings: [] } : {}),
      });
  }
}

const A = policyOf();
const B = policyOf((p) => ((p as { maxAttempts: number }).maxAttempts = 5));
/** Отличается только пределами бюджета: применяется операцией, согласование графа остаётся. */
const R = policyOf(
  (p) => ((p as { budgets: unknown }).budgets = { work: { usd: 100 }, onUnknown: 'stop' }),
);

test('T27: запрос применения держит выдачу; идущая попытка держит применение; применяет процесс с ожидаемой политикой', () => {
  const { engine: old, dir } = engineOf(A);
  ready(old, graphOf({ a: [], b: [] }));
  assert.equal(old.policyState().applied?.digest, policyDigest(A), 'запуск controller применил A');
  const a = old.claim('c1')!;
  old.requestReconfigure('op-1', policyDigest(B));
  assert.equal(old.claim('c1'), undefined, 'новые попытки не выдаются, пока запрос не применён');
  const blockers = old.read((v) => old.blockers(v.work('b')!, v));
  assert.ok(blockers.some((b) => b.code === 'PAUSED' && /op-1/.test(b.message)));
  // Процесс с прежней политикой запрос не применяет и не отклоняет.
  assert.equal(old.serveReconfigure('c1').status, 'none');
  const next = processOf(dir, B);
  const busy = next.applyReconfigure('p2');
  assert.equal(busy.status, 'busy');
  assert.deepEqual(busy.status === 'busy' && busy.busy, [a.id], 'ждёт идущую попытку');
  passEvidence(old, a.id, a.token);
  old.finish(a.id, a.token, sha('b'));
  const applied = next.applyReconfigure('p2');
  assert.equal(applied.status, 'applied');
  assert.equal(next.policyState().applied?.digest, policyDigest(B));
  assert.equal(next.policyState().applied?.generation, 2);
  assert.equal(next.policyState().reconfigure?.appliedBy, 'p2');
  // Прежний процесс устарел: не выдаёт, не согласует, а блокер называет причину.
  assert.match(old.policyState().stale ?? '', /не с применённой политикой/);
  assert.equal(old.claim('c1'), undefined);
  assert.throws(() => old.approve('g', 'agent'), refused('APPROVAL_STALE'));
  assert.ok(
    old
      .read((v) => old.blockers(v.work('b')!, v))
      .some((b) => b.code === 'APPROVAL_STALE' && /перезапустите/.test(b.message)),
  );
});

test('T27: попытка, выданная под прежней политикой, не принимается ни прежним, ни новым процессом', () => {
  const { engine: old, dir } = engineOf(A);
  ready(old, graphOf({ a: [] }));
  const a = old.claim('c1')!;
  passEvidence(old, a.id, a.token);
  old.requestReconfigure('op-1', policyDigest(B));
  // Владение попыткой истекло — запись с истёкшим сроком применение не держит.
  const late = processOf(dir, B, { now: () => Date.parse('2026-01-01T00:10:00.000Z') });
  assert.equal(late.applyReconfigure('p2').status, 'applied');
  assert.throws(() => old.finish(a.id, a.token, sha('b')), refused('APPROVAL_STALE'));
  assert.equal(
    old.read((v) => v.work('a')!.status),
    'integrating',
    'не принято',
  );
});

test('T27: чужая политика — отказ с обоими digest; повтор операции сбрасывает отказ; вторая операция ждёт первую', () => {
  const { engine: old, dir } = engineOf(A);
  ready(old, graphOf({ a: [] }));
  old.requestReconfigure('op-1', policyDigest(B));
  assert.throws(
    () => old.requestReconfigure('op-2', policyDigest(B)),
    refused('NOT_READY', /op-1/),
  );
  const other = processOf(
    dir,
    policyOf((p) => ((p as { maxAttempts: number }).maxAttempts = 7)),
  );
  const failed = other.applyReconfigure('p3');
  assert.equal(failed.status, 'failed');
  assert.match(
    failed.status === 'failed' ? failed.error : '',
    new RegExp(
      `ожидался digest ${policyDigest(B).slice(0, 16)}, загружен ${policyDigest(other.policy).slice(0, 16)}`,
    ),
  );
  assert.equal(old.policyState().applied?.digest, policyDigest(A), 'применённая не сменилась');
  assert.equal(old.claim('c1'), undefined, 'выдача удержана и после отказа');
  assert.equal(old.requestReconfigure('op-1', policyDigest(B)).retried, true);
  assert.equal(old.policyState().reconfigure?.error, undefined);
  assert.equal(processOf(dir, B).applyReconfigure('p2').status, 'applied');
  assert.equal(old.clearReconfigure('op-1'), true);
});

test('T27: пауза человека переживает операцию; штатная остановка поверх паузы операции не снимается применением', () => {
  const { engine: old, dir } = engineOf(A);
  ready(old, graphOf({ a: [] }));
  old.pause('operator');
  assert.equal(old.operationPause('op-1'), false, 'пауза человека не перезаписывается');
  old.requestReconfigure('op-1', policyDigest(B));
  assert.equal(processOf(dir, B).applyReconfigure('p2').status, 'applied');
  assert.equal(
    old.read((v) => v.control().pauseReason),
    'operator',
  );
  assert.equal(old.operationResume('op-1'), false, 'чужую паузу операция не снимает');

  const second = engineOf(A);
  ready(second.engine, graphOf({ a: [] }));
  assert.equal(second.engine.operationPause('op-1'), true);
  assert.throws(() => second.engine.resume(), refused('PAUSED'), 'паузу операции снимает она сама');
  second.engine.pause('shutdown');
  second.engine.requestReconfigure('op-1', policyDigest(B));
  assert.equal(processOf(second.dir, B).applyReconfigure('p2').status, 'applied');
  assert.equal(
    second.engine.read((v) => v.control().pauseReason),
    'shutdown',
  );

  const third = engineOf(A);
  ready(third.engine, graphOf({ a: [] }));
  third.engine.operationPause('op-1');
  third.engine.requestReconfigure('op-1', policyDigest(B));
  assert.equal(processOf(third.dir, B).applyReconfigure('p2').status, 'applied');
  assert.equal(
    third.engine.read((v) => v.control().paused),
    false,
    'применение снимает свою паузу',
  );
});

test('T27: перезапуск во время операции — запрос сохранён; новый процесс с ожидаемой политикой применяет его', () => {
  const { engine: old, dir, store } = engineOf(A);
  ready(old, graphOf({ a: [] }));
  old.requestReconfigure('op-1', policyDigest(R));
  store.close();
  const restarted = processOf(dir, R, { now: () => Date.parse('2026-01-01T00:10:00.000Z') });
  assert.equal(restarted.lead('c2'), true);
  // Запуск controller записал свою политику (перезапуск — штатная смена),
  // но запрос операции не применён, и выдача стоит до его применения.
  assert.equal(restarted.policyState().applied?.digest, policyDigest(R));
  assert.equal(restarted.policyState().reconfigure?.appliedAt, undefined);
  assert.equal(restarted.claim('c2'), undefined);
  assert.equal(restarted.serveReconfigure('c2').status, 'applied');
  assert.equal(
    restarted.claim('c2')?.workId,
    'a',
    'бюджеты и пределы повторов не требуют согласования',
  );
});

test('T27: устаревание по поколениям, а не по часам: прежний процесс не возвращает свою политику и после истечения роли', () => {
  const { engine: old, dir } = engineOf(A);
  ready(old, graphOf({ a: [] }));
  old.release('c1');
  const next = processOf(dir, B);
  assert.equal(next.lead('c2'), true, 'без живого controller новый процесс применяет свою');
  assert.equal(next.policyState().applied?.generation, 2);
  next.release('c2');
  // Роль свободна, источника у прежнего нет, но после его запуска применена
  // другая политика: вернуть свою он не вправе.
  assert.equal(old.lead('c1'), true);
  assert.equal(old.policyState().applied?.digest, policyDigest(B));
  assert.match(old.policyState().stale ?? '', /поколения 2/);
  assert.equal(old.claim('c1'), undefined);
  // Процесс, запущенный после применения, с прежней политикой — перезапуск:
  // он вправе.
  old.release('c1');
  const rerun = processOf(dir, A);
  assert.equal(rerun.lead('c3'), true);
  assert.equal(rerun.policyState().applied?.digest, policyDigest(A));
});

test('T27: при живом чужом controller процесс с другой политикой её не применяет и ничего не выдаёт', () => {
  const { engine: running, dir } = engineOf(A);
  ready(running, graphOf({ a: [] }));
  const other = processOf(dir, B);
  assert.equal(other.lead('c2'), false, 'роль у работающего');
  assert.equal(other.policyState().applied?.digest, policyDigest(A));
  assert.match(other.policyState().stale ?? '', /работает controller c1/);
  assert.throws(() => other.approve('g', 'agent'), refused('APPROVAL_STALE', /c1/));
});

test('T27: политика, изменённая в памяти после создания движка, не становится применённой', () => {
  const { engine: first, dir } = engineOf(A);
  ready(first, graphOf({ a: [] }));
  first.release('c1');
  const policy = policyOf((p) => ((p as { maxAttempts: number }).maxAttempts = 5));
  const mutated = processOf(dir, policy);
  (policy as { maxAttempts: number }).maxAttempts = 9;
  mutated.lead('c2');
  assert.equal(mutated.policyState().applied?.digest, policyDigest(A));
  assert.match(mutated.policyState().stale ?? '', /изменена в памяти/);
});

test('T27: источник политики — по байтам и цели: правка или переключённая ссылка лишают права, перезапись тем же содержимым — нет', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-policy-src-'));
  const file = join(root, 'policy.json');
  const text = JSON.stringify(B);
  writeFileSync(file, text);
  const link = join(root, 'current.json');
  symlinkSync(file, link);
  const source = policySourceOf(link, text);
  assert.equal(policySourceChanged(source), undefined);
  writeFileSync(file, text);
  assert.equal(policySourceChanged(source), undefined, 'те же байты — тот же источник');
  writeFileSync(join(root, 'other.json'), text);
  renameSync(link, join(root, 'old-link'));
  symlinkSync(join(root, 'other.json'), link);
  assert.match(policySourceChanged(source) ?? '', /другой файл/);

  const { engine: first, dir } = engineOf(A);
  ready(first, graphOf({ a: [] }));
  first.release('c1');
  const edited = policySourceOf(file, text);
  writeFileSync(file, text + ' ');
  const stale = processOf(dir, B, { provenance: () => policySourceChanged(edited) });
  stale.lead('c2');
  assert.equal(stale.policyState().applied?.digest, policyDigest(A));
  assert.match(stale.policyState().stale ?? '', /изменился после загрузки/);
});

test('Пределы бюджетов и тарифы не входят в основание согласования; смена gates — входит', () => {
  const raised = policyOf((p) => {
    (p as { budgets: unknown }).budgets = { work: { usd: 100 }, onUnknown: 'stop' };
    (p as { prices: unknown }).prices = [];
  });
  assert.equal(executionDigest(raised), executionDigest(A));
  assert.notEqual(policyDigest(raised), policyDigest(A), 'применённая политика — целиком');
  const gates = policyOf((p) => {
    const repo = (p as { repositories: { gates: { command: string[] }[] }[] }).repositories[0]!;
    repo.gates[0]!.command = ['other-test'];
  });
  assert.notEqual(executionDigest(gates), executionDigest(A));
  const { engine: first, dir } = engineOf(A);
  ready(first, graphOf({ a: [] }));
  first.release('c1');
  const changed = processOf(dir, gates);
  changed.lead('c2');
  assert.equal(changed.claim('c2'), undefined);
  assert.ok(
    changed
      .read((v) => changed.blockers(v.work('a')!, v))
      .some((b) => b.code === 'APPROVAL_STALE' && /согласуйте заново/.test(b.message)),
  );
});

const [C1, C2, C3] = ['config-1', 'config-2', 'config-3'].map((c) => digestOf(c));

test('T27: тождество политики по формуле хоста — применяется и сравнивается оно, а не содержимое нейтральной политики', () => {
  const { engine: first, dir } = engineOf(A);
  ready(first, graphOf({ a: [] }));
  first.release('c1');
  // Хост строит ту же нейтральную политику из другой конфигурации: это другая политика.
  const host1 = processOf(dir, A, { policyIdentity: C1 });
  assert.equal(host1.lead('c2'), true);
  assert.equal(host1.policyState().applied?.digest, C1);
  assert.equal(host1.policyState().loaded, C1);
  const host2 = processOf(dir, A, { policyIdentity: C2 });
  assert.equal(host2.lead('c3'), false, 'роль у работающего');
  assert.match(host2.policyState().stale ?? '', /работает controller c2/);
  assert.throws(() => host2.approve('g', 'agent'), refused('APPROVAL_STALE'));
  // Тот же идентификатор — та же политика, независимо от процесса.
  const same = processOf(dir, A, { policyIdentity: C1 });
  assert.equal(same.policyState().stale, undefined);
  // Изменение политики в памяти по-прежнему проверяется по содержимому.
  host1.release('c2');
  const policy = policyOf();
  const mutated = processOf(dir, policy, { policyIdentity: C3 });
  (policy as { maxAttempts: number }).maxAttempts = 9;
  mutated.lead('c4');
  assert.equal(mutated.policyState().applied?.digest, C1);
  assert.match(mutated.policyState().stale ?? '', /изменена в памяти/);
});
