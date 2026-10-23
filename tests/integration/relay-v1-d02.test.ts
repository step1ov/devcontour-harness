/**
 * D02 с настоящим получателем Relay v1: процессы доставки (testing-worker)
 * ходят к серверу через управляемый HTTP proxy, который пропускает запрос до
 * сервера (сервер фиксирует мутацию) и теряет ответ. Затем НОВЫЙ процесс над
 * тем же каталогом состояния продолжает доставку. Число записей считается
 * независимым REST-клиентом, а не локальными вызовами; Git ref и вызовы
 * runtime проверяются отдельно.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { scenario, type Scenario } from '../../src/integrations/connector/testing.ts';
import { relayV1Backend, type RelayFixture, type RelayV1Project } from './relay-v1-backend.ts';

type Mode = false | 'destroy' | 'hang';
const OP = 'devcontour-harness:op=';
const evidenceRoot = process.env.DC_CONNECTOR_EVIDENCE;

/** Backend с proxy, правило которого тест меняет на ходу; считает POST, дошедшие до proxy. */
function proxied() {
  let rule: (method: string, path: string) => Mode = () => false;
  const posts: string[] = [];
  let project: RelayV1Project | undefined;
  const backend = relayV1Backend({
    dropping: (method, path) => {
      if (method === 'POST') posts.push(path.replace(/^\/api\/v1\/projects\/[^/]+/, ''));
      return rule(method, path);
    },
    onProject: (p) => (project = p),
  });
  return {
    backend,
    posts,
    project: () => project!,
    /** Потерять ответ на n-й POST, путь которого оканчивается на suffix. */
    dropNth(suffix: string, mode: Exclude<Mode, false>, nth = 1) {
      let seen = 0;
      rule = (method, path) =>
        method === 'POST' && path.endsWith(suffix) && ++seen === nth ? mode : false;
    },
    pass() {
      rule = () => false;
    },
  };
}

/** Комментарии harness у задачи — независимым REST-клиентом получателя (полные тела). */
async function restMarkers(srv: RelayFixture, taskId: string) {
  const page = (await srv.get(`/board-tasks/${taskId}/comments?limit=100`)) as {
    items: { id: string }[];
  };
  const bodies: string[] = [];
  for (const c of page.items) {
    const full = (await srv.get(`/board-tasks/${taskId}/comments/${c.id}`)) as {
      description: string;
    };
    if (full.description.includes(OP)) bodies.push(full.description);
  }
  return bodies;
}

async function restTask(srv: RelayFixture, taskId: string) {
  const t = (await srv.get(`/board-tasks/${taskId}`)) as { column: string; revision: number };
  const c = (await srv.get(`/board-tasks/${taskId}/criteria?limit=100`)) as {
    items: { completed: boolean }[];
  };
  return { column: t.column, revision: t.revision, criteria: c.items.map((i) => i.completed) };
}

function save(id: string, data: unknown) {
  if (!evidenceRoot) return;
  const dir = join(evidenceRoot, 'D02', 'relay-v1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(data, null, 2)}\n`);
}

const forbiddenCalls = (s: Scenario) => existsSync(join(s.root, 'forbidden-runtime-calls.txt'));
const opOf = async (s: Scenario) => {
  const o = await s.open();
  try {
    const op = o.connector.store.operations({ workId: s.workId })[0]!;
    /* Доверенный receipt принятого результата (таблица receipts), не план операции. */
    return { ...op, trustedReceipts: o.connector.store.receipts(s.workId).length };
  } finally {
    o.close();
  }
};
const summaryOf = (op: Awaited<ReturnType<typeof opOf>>) => ({
  status: op.status,
  steps: op.steps.map((st) => ({ n: st.n, kind: st.kind, status: st.status, sends: st.sends })),
  trustedReceipts: op.trustedReceipts,
});

test(
  'D02/relay-v1/real: ответ на комментарий потерян после commit — read-back в том же процессе, без повтора',
  { timeout: 300_000 },
  async () => {
    const p = proxied();
    const s = await scenario(p.backend);
    try {
      const o = await s.runOnly();
      o.close();
      const target = s.target();
      const calls = { ...s.calls };
      p.dropNth('/comments', 'destroy');
      const res = await s.worker({ action: 'deliver', workId: s.workId });
      assert.equal(res.output?.ok, true, res.stderr);
      const proxy = p.project().proxy!;
      assert.equal(proxy.dropped.length, 1);
      assert.equal(proxy.dropped[0]!.status, 200, 'сервер зафиксировал комментарий, ответ потерян');
      const markers = await restMarkers(p.project().server, s.task.id);
      assert.equal(markers.length, 1, 'ровно один комментарий с маркером у получателя');
      assert.equal(
        p.posts.filter((x) => x.endsWith('/comments')).length,
        1,
        'комментарий отправлен один раз',
      );
      const op = await opOf(s);
      assert.equal(op.status, 'delivered');
      assert.equal(op.steps.find((st) => st.kind === 'comment')!.sends, 1);
      assert.equal(op.trustedReceipts, 1, 'receipt сохранён');
      assert.equal(s.target(), target, 'Git ref не меняется');
      assert.deepEqual(s.calls, calls);
      assert.equal(forbiddenCalls(s), false, 'worker не вызывал runtime');
      save('lost-response-in-process', {
        dropped: proxy.dropped.map(({ method, path, status }) => ({ method, path, status })),
        posts: p.posts,
        markers: markers.length,
        task: await restTask(p.project().server, s.task.id),
        operation: summaryOf(op),
      });
    } finally {
      await s.cleanup();
    }
  },
);

for (const [suffix, kind] of [
  ['/comments', 'comment'],
  ['/criteria', 'criterion'],
  ['/move', 'move'],
] as const) {
  test(
    `D02/relay-v1/real: ${kind} записан сервером, ответ не дошёл, процесс погиб — новый процесс находит запись read-back без второй мутации`,
    { timeout: 300_000 },
    async () => {
      const p = proxied();
      const s = await scenario(p.backend);
      try {
        const o = await s.runOnly();
        o.close();
        const target = s.target();
        p.dropNth(suffix, 'hang');
        // Процесс ждёт ответ, которого не будет; scenario.worker убивает его (SIGKILL) по сроку.
        await assert.rejects(
          s.worker({ action: 'deliver', workId: s.workId }, 20_000),
          /нет итога/,
        );
        const proxy = p.project().proxy!;
        assert.equal(proxy.dropped.length, 1, `${kind}: запрос дошёл до сервера`);
        assert.equal(proxy.dropped[0]!.status, 200, `${kind}: сервер зафиксировал мутацию`);
        const crashed = await opOf(s);
        const step = crashed.steps.find((st) => st.kind === kind)!;
        assert.equal(step.status, 'sending', 'после гибели процесса исход шага неизвестен');
        assert.equal(crashed.trustedReceipts, 0);
        const mid = {
          markers: (await restMarkers(p.project().server, s.task.id)).length,
          task: await restTask(p.project().server, s.task.id),
        };
        const postsBefore = p.posts.filter((x) => x.endsWith(suffix)).length;
        p.pass();
        await s.waitLeases();
        const resumed = await s.worker({ action: 'deliver', workId: s.workId });
        assert.equal(resumed.output?.ok, true, resumed.stderr);
        const op = await opOf(s);
        assert.equal(op.status, 'delivered');
        assert.equal(
          op.steps.find((st) => st.kind === kind)!.sends,
          1,
          'шаг не отправлялся повторно',
        );
        assert.equal(
          p.posts.filter((x) => x.endsWith(suffix)).length,
          postsBefore,
          'второй мутации нет',
        );
        const markers = await restMarkers(p.project().server, s.task.id);
        assert.equal(markers.length, 1, 'ровно один комментарий с маркером');
        const task = await restTask(p.project().server, s.task.id);
        assert.equal(task.column, 'done');
        assert.ok(task.criteria.every(Boolean));
        if (kind === 'move')
          assert.equal(task.revision, mid.task.revision, 'move уже был применён сервером');
        assert.equal(op.trustedReceipts, 1);
        assert.equal(s.target(), target, 'Git ref не меняется');
        assert.equal(forbiddenCalls(s), false, 'нет вызовов runtime');
        save(`lost-response-crash-${kind}`, {
          dropped: proxy.dropped.map(({ method, path, status, mode }) => ({
            method,
            path,
            status,
            mode,
          })),
          afterCrash: { operation: summaryOf(crashed), ...mid },
          afterResume: { operation: summaryOf(op), markers: markers.length, task },
          posts: p.posts,
        });
      } finally {
        await s.cleanup();
      }
    },
  );
}

test(
  'D02/relay-v1/real: остановка после intent до отправки — новый процесс отправляет один раз',
  { timeout: 300_000 },
  async () => {
    const p = proxied();
    const s = await scenario(p.backend);
    try {
      const o = await s.runOnly();
      o.close();
      const target = s.target();
      const crashed = await s.worker({
        action: 'deliver',
        workId: s.workId,
        crashOnStoreWrite: { what: 'step', nth: 1 },
      });
      assert.equal(crashed.code, 75, crashed.stderr);
      assert.equal(p.posts.length, 0, 'до получателя не дошёл ни один POST');
      assert.equal((await restMarkers(p.project().server, s.task.id)).length, 0);
      const mid = await opOf(s);
      assert.equal(mid.steps[0]!.status, 'planned');
      await s.waitLeases();
      const resumed = await s.worker({ action: 'deliver', workId: s.workId });
      assert.equal(resumed.output?.ok, true, resumed.stderr);
      assert.equal((await restMarkers(p.project().server, s.task.id)).length, 1);
      assert.equal(p.posts.filter((x) => x.endsWith('/comments')).length, 1);
      const op = await opOf(s);
      assert.equal(op.status, 'delivered');
      assert.equal(s.target(), target);
      assert.equal(forbiddenCalls(s), false);
      save('crash-before-send', {
        afterCrash: summaryOf(mid),
        afterResume: summaryOf(op),
        posts: p.posts,
      });
    } finally {
      await s.cleanup();
    }
  },
);

test(
  'D02/relay-v1/real: ответ получен, receipt не сохранён — новый процесс без новых мутаций',
  { timeout: 300_000 },
  async () => {
    const p = proxied();
    const s = await scenario(p.backend);
    try {
      const o = await s.runOnly();
      o.close();
      const target = s.target();
      const crashed = await s.worker({
        action: 'deliver',
        workId: s.workId,
        crashOnStoreWrite: { what: 'receipt', nth: 1 },
      });
      assert.equal(crashed.code, 75, crashed.stderr);
      const postsMid = [...p.posts];
      const mid = {
        markers: (await restMarkers(p.project().server, s.task.id)).length,
        task: await restTask(p.project().server, s.task.id),
      };
      assert.equal(mid.markers, 1);
      await s.waitLeases();
      const resumed = await s.worker({ action: 'deliver', workId: s.workId });
      assert.equal(resumed.output?.ok, true, resumed.stderr);
      assert.deepEqual(p.posts, postsMid, 'ни одного нового POST к получателю');
      assert.deepEqual(
        {
          markers: (await restMarkers(p.project().server, s.task.id)).length,
          task: await restTask(p.project().server, s.task.id),
        },
        mid,
      );
      const op = await opOf(s);
      assert.equal(op.status, 'delivered');
      assert.equal(op.trustedReceipts, 1);
      assert.equal(s.target(), target);
      assert.equal(forbiddenCalls(s), false);
      save('crash-before-receipt', { posts: p.posts, mid, operation: summaryOf(op) });
    } finally {
      await s.cleanup();
    }
  },
);
