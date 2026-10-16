import {
  sha256,
  usageSchema,
  type CallRecord,
  type RuntimeAdapter,
  type RuntimeRequest,
  type RuntimeResponse,
} from '../contracts/index.ts';
import { unknownUsage } from '../agents/usage.ts';
import '../environment/live-calls.ts';
import type { CallMeta } from './budget.ts';
import type { Engine } from './engine.ts';
import {
  currentBootId,
  currentProcess,
  endActive,
  priceUsage,
  startActive,
  type Price,
} from './usage.ts';

/**
 * Вызов runtime под учётом. До вызова, в одной транзакции с регистрацией
 * идущего вызова, проверяются бюджеты: превышенный или неопределённый не даёт
 * начать вызов, и записи тогда нет. Тарифы закрепляются на старте вызова:
 * правка цен во время или после вызова оценку не меняет. Тариф выбирается
 * только по модели, о которой сообщил runtime: запрошенная модель не
 * подтверждает, что работала именно она. Время идущего вызова сохраняется по
 * ходу: другой процесс не увидит его ниже этого замера при откате часов.
 * Ошибочные вызовы остаются в учёте со своей стоимостью.
 */
export async function measuredInvoke(
  engine: Engine,
  adapter: RuntimeAdapter,
  request: RuntimeRequest,
  signal: AbortSignal,
  meta: CallMeta,
): Promise<RuntimeResponse> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const tariffs: Price[] = engine.policy.prices.map((p) => ({ ...p }));
  const priceFor = (model: string) =>
    tariffs
      .filter(
        (p) =>
          p.runtime === adapter.runtime &&
          p.model === model &&
          Date.parse(p.effectiveAt) <= Date.parse(startedAt),
      )
      .sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0];
  const owner = currentProcess();
  const boot = currentBootId();
  let record: CallRecord = engine.beginCall(
    {
      ...(meta.repositoryId ? { repositoryId: meta.repositoryId } : {}),
      ...(meta.runId ? { runId: meta.runId } : {}),
      ...(meta.subjectId ? { subjectId: meta.subjectId } : {}),
      id: request.callId,
      stage: meta.stage,
      runtime: adapter.runtime,
      model: request.binding.model ?? null,
      runtimeVersion: null,
      startedAt,
      outcome: 'active',
      ...(owner ? { process: { ...owner } } : {}),
      startedHr: process.hrtime.bigint().toString(),
      ...(boot ? { bootId: boot } : {}),
      promptBytes: Buffer.byteLength(request.prompt),
      promptDigest: sha256(request.prompt),
      usage: unknownUsage(),
      costUsd: null,
      costSource: 'unknown',
    },
    meta,
  );
  startActive(record.id);
  const progress = setInterval(() => {
    record = { ...record, elapsedMs: Math.round(performance.now() - started) };
    engine.saveCall(record);
  }, 15_000);
  progress.unref();
  let outcome: CallRecord['outcome'] = 'error';
  try {
    const response = await adapter.invoke(request, signal);
    const price = response.model ? priceFor(response.model) : undefined;
    const usage = usageSchema.parse(response.usage);
    record = {
      ...record,
      usage,
      runtimeVersion: response.runtimeVersion ?? record.runtimeVersion,
      // Модель, которую runtime выбрал сам: иначе переход на дорогой вариант не виден.
      model: response.model ?? record.model,
      ...(price ? { price: { ...price } } : {}),
      ...priceUsage(usage, price),
    };
    if (response.status === 'ok') outcome = 'returned';
    return response;
  } finally {
    clearInterval(progress);
    record = {
      ...record,
      outcome,
      finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
    };
    engine.saveCall(record);
    endActive(record.id);
  }
}
