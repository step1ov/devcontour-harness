// Внешний коннектор через порты библиотеки: поручения приходят из сервиса
// задач, результат возвращается в него же. Движок о сервисе ничего не знает;
// коннектор не может менять политику, выдавать lease или ставить PASS —
// у портов нет таких операций.
import { readFileSync } from 'node:fs';
import { Harness, executionPolicySchema, workGraphSchema } from 'devcontour-harness';

/** Вымышленный сервис задач: `GET /plans/:ref`, `PUT /results/:workId`. */
const TRACKER = process.env.TRACKER_URL ?? 'http://127.0.0.1:8080';

/** WorkSource: граф и его редакция из сервиса. */
const source = {
  id: 'tracker',
  async fetch(ref) {
    const response = await fetch(`${TRACKER}/plans/${encodeURIComponent(ref)}`);
    if (!response.ok) throw new Error(`tracker: ${response.status}`);
    const graph = workGraphSchema.parse(await response.json());
    return { graph, source: graph.source };
  },
  async revision(ref) {
    const response = await fetch(`${TRACKER}/plans/${encodeURIComponent(ref)}`, { method: 'HEAD' });
    return response.headers.get('x-revision') ?? undefined;
  },
  // Внешним receipts по умолчанию не доверяем; доверие не отменяет проверку
  // доступности result SHA в target ref.
  async trusts() {
    return false;
  },
};

/** ResultSink: идемпотентно по ключу; новая редакция в сервисе — conflict. */
const sink = {
  id: 'tracker',
  async deliver({ key, result }) {
    const response = await fetch(`${TRACKER}/results/${result.workOrderId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(result),
    });
    if (response.status === 409)
      return { status: 'conflict', currentRevision: response.headers.get('x-revision') ?? '?' };
    if (!response.ok) throw new Error(`tracker: ${response.status}`);
    return { status: 'delivered', receipt: response.headers.get('location') ?? undefined };
  },
};

const policy = executionPolicySchema.parse(JSON.parse(readFileSync('policy.json', 'utf8')));
const harness = Harness.open({ stateDir: '../notes-state', policy, baseDir: process.cwd() });
try {
  const { graph } = await source.fetch('release-1');
  const status = await harness.run({ graph, author: 'external', sink, source });
  console.log(JSON.stringify(status, null, 2));
} finally {
  harness.close();
}
