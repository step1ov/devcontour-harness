/**
 * Отдельный процесс набора проверки коннектора (fixture, не рабочий путь):
 * доставка, reconcile или начало истории попытки над тем же каталогом
 * состояния, с точками отказа. Crash — `process.exit(75)` в заданной точке.
 * Итог — одна строка JSON в stdout.
 *
 * Запуск: `node --import tsx testing-worker.ts <spec.json>`.
 */
import { readFileSync } from 'node:fs';
import { executionPolicySchema, type AttemptState, type WorkState } from '../../contracts/index.ts';
import { Harness } from '../../control/harness.ts';
import { parseConfig } from './config.ts';
import { Connector, openConnector } from './commands.ts';
import {
  FakeRelayTransport,
  FileBarrier,
  faultyTransport,
  fileBackend,
  type FaultRule,
} from './fake.ts';
import { createTransportFor } from './registry.ts';
import type { WorkerSpec, WorkerTransport } from './testing.ts';
import { forbiddenAdapters } from './testing.ts';

interface Spec extends WorkerSpec {
  transport: WorkerTransport;
  config: unknown;
  baseDir: string;
  state: string;
  repo: string;
  policy: unknown;
  forbidden: string;
  resources: string;
}

const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Spec;
const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');

try {
  const loaded = parseConfig(spec.config, spec.baseDir);
  const inner =
    spec.transport.kind === 'fake'
      ? new FakeRelayTransport(fileBackend(spec.transport.file), {
          provider: spec.transport.provider,
          actor: spec.transport.actor,
        })
      : await createTransportFor(loaded);
  const rules: FaultRule[] = (spec.faults ?? []).map(({ barrier, ...f }) => ({
    ...f,
    ...(barrier ? { barrier: new FileBarrier(barrier.dir, barrier.name, 60_000) } : {}),
  }));
  const writes: Record<string, number> = {};
  const connector = await openConnector(loaded, {
    stateDir: spec.state,
    transport: faultyTransport(inner, rules),
    ...(spec.owner ? { owner: spec.owner } : {}),
    onStoreWrite: (what) => {
      writes[what] = (writes[what] ?? 0) + 1;
      if (spec.crashOnStoreWrite?.what === what && writes[what] === spec.crashOnStoreWrite.nth)
        process.exit(75);
    },
  });
  if (spec.action === 'begin-attempt') {
    const a = spec.attempt!;
    await connector.history.beginAttempt(a.work as WorkState, a.attempt as AttemptState, a.baseSha);
    print({ ok: true });
  } else {
    const h = Harness.open({
      stateDir: spec.state,
      policy: executionPolicySchema.parse(spec.policy),
      baseDir: spec.repo,
      adapters: forbiddenAdapters(spec.forbidden),
      hooks: connector.hooks(),
      resourceDatabase: spec.resources,
    });
    try {
      if (spec.action === 'deliver') {
        const envelope = await h.deliver(spec.workId!, connector.sink);
        print({ ok: true, result: envelope });
      } else {
        const result = await connector.reconcile(
          h,
          spec.operation!,
          Connector.decision(spec.decision),
        );
        print({ ok: true, result });
      }
    } finally {
      h.close();
    }
  }
  connector.close();
} catch (error) {
  print({
    ok: false,
    error: {
      code: (error as { code?: string }).code,
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 3;
}
