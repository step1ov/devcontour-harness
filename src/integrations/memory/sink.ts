import {
  HarnessError,
  digestOf,
  type DeliveryOutcome,
  type ResultSink,
  type RunResult,
} from '../../contracts/index.ts';
import {
  memoryRetainAckSchema,
  providerIdSchema,
  type MemoryDocument,
  type MemoryRetainProvider,
} from './provider.ts';

export interface MemoryResultSinkOptions {
  /** ID получателя; по умолчанию `memory-<provider.id>` — отдельный от Git и Relay ключ доставки. */
  id?: string;
  bank: string;
  project: string;
  timeoutMs?: number;
}

/** Учёт записи во внешнюю память — отдельно от usage coding runtime. */
export interface MemoryRetainUsage {
  retainCalls: number;
  costUnits: number;
}

/**
 * Детерминированный UUID (форма версии 5, вариант RFC 4122) из hex-digest:
 * `operation_id` Hindsight — UUID, а повтор обязан дать тот же.
 */
export function uuidOf(digest: string) {
  const h = digest.slice(0, 32).split('');
  h[12] = '5';
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Стабильная identity документа результата: провайдер, bank, project,
 * поручение, попытка и digest самого результата. Повтор доставки того же
 * результата даёт тот же `documentId` (upsert), другой результат — другой.
 */
export const memoryDocumentId = (
  providerId: string,
  bank: string,
  project: string,
  result: RunResult,
) =>
  'dch-' +
  digestOf({
    provider: providerId,
    bank,
    project,
    work: result.workOrderId,
    run: result.runId,
    result: digestOf(result),
  });

/**
 * Текст подтверждённого итога: только то, что записал controller (исход,
 * SHA, gates и их итоги, находки ревью). Пересказ writer сюда не входит.
 */
export function memoryContent(result: RunResult) {
  return [
    `Harness result for work order ${result.workOrderId} (run ${result.runId}): ${result.outcome}.`,
    `Source: ${result.source.connector} ${result.source.ref} @ ${result.source.revision}.`,
    result.outcome === 'accepted'
      ? `Accepted commit: ${result.shas.result} (base ${result.shas.base}).`
      : `Stop reason: ${result.stopReason.code}: ${result.stopReason.message}`,
    'Controller evidence: ' +
      JSON.stringify(
        result.evidence.map((e) => ({ gate: e.gate, phase: e.phase, passed: e.passed })),
      ),
    ...(result.findings.length
      ? ['Review findings: ' + JSON.stringify(result.findings.map((f) => f.message))]
      : []),
  ].join('\n');
}

/**
 * Получатель подтверждённого итога во внешней памяти. Это обычный
 * `ResultSink`: harness ведёт его доставку отдельной записью по своему
 * ключу (`<sink>:<work>:<run>`), так что сбой памяти не трогает принятый
 * Git-результат и receipt других получателей, а повтор
 * (`Harness.deliver(work, sink)`) отправляет только память — с тем же
 * `documentId` и `operationId`, без нового writer.
 *
 * Сохраняются только принятые результаты; остальные исходы доставляются
 * явной отметкой «пропущено» без обращения к провайдеру.
 */
export class MemoryResultSink implements ResultSink {
  readonly id: string;
  readonly usage: MemoryRetainUsage = { retainCalls: 0, costUnits: 0 };
  constructor(
    readonly provider: MemoryRetainProvider,
    readonly options: MemoryResultSinkOptions,
  ) {
    providerIdSchema.parse(provider.id);
    this.id = providerIdSchema.parse(options.id ?? 'memory-' + provider.id);
  }

  documentId(result: RunResult) {
    return memoryDocumentId(this.provider.id, this.options.bank, this.options.project, result);
  }

  /** Документ доставки: `operationId` стабилен для ключа доставки и документа. */
  document(key: string, result: RunResult): MemoryDocument {
    const documentId = this.documentId(result);
    return {
      bank: this.options.bank,
      project: this.options.project,
      documentId,
      operationId: uuidOf(digestOf({ key, documentId })),
      content: memoryContent(result),
      metadata: {
        workOrderId: result.workOrderId,
        runId: result.runId,
        outcome: result.outcome,
        sourceConnector: result.source.connector,
        sourceRef: result.source.ref,
        sourceRevision: result.source.revision,
        ...(result.outcome === 'accepted' ? { resultSha: result.shas.result } : {}),
      },
    };
  }

  async deliver({ key, result }: { key: string; result: RunResult }): Promise<DeliveryOutcome> {
    if (result.outcome !== 'accepted')
      return {
        status: 'delivered',
        receipt: `skipped: memory retains only accepted results (outcome ${result.outcome})`,
      };
    const document = this.document(key, result);
    this.usage.retainCalls++;
    const ack = memoryRetainAckSchema.safeParse(
      await this.provider.retain(document, AbortSignal.timeout(this.options.timeoutMs ?? 30_000)),
    );
    if (!ack.success)
      throw new HarnessError(
        'DELIVERY_FAILED',
        'Ответ retain вне схемы: ' + ack.error.issues[0]?.message,
      );
    this.usage.costUnits += ack.data.costUnits ?? 0;
    return {
      status: 'delivered',
      receipt: [
        `memory:${this.provider.id}`,
        `bank=${document.bank}`,
        `document=${document.documentId}`,
        `operation=${document.operationId}`,
        `status=${ack.data.status}`,
        ...(ack.data.receipt ? [`receipt=${ack.data.receipt}`] : []),
      ].join(' '),
    };
  }
}

export const memoryResultSink = (
  provider: MemoryRetainProvider,
  options: MemoryResultSinkOptions,
) => new MemoryResultSink(provider, options);
