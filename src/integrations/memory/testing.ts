import type {
  MemoryDocument,
  MemoryItem,
  MemoryProvider,
  MemoryQuery,
  MemoryRecallBody,
  MemoryRetainAck,
} from './provider.ts';

/**
 * FIXTURE ONLY. Детерминированный провайдер памяти для тестов: ответы по
 * сценарию, счётчики обращений, смена ответа, недоступность и отказ retain
 * до или после записи. Ни сети, ни ключей, ни SDK.
 */
export class FakeMemoryProvider implements MemoryProvider {
  readonly calls = { recall: 0, retain: 0 };
  readonly queries: MemoryQuery[] = [];
  /** Документы по `documentId` — upsert, как у памяти с document identity. */
  readonly documents = new Map<string, MemoryDocument>();
  /** Каждая принятая операция retain по порядку (`operationId`). */
  readonly operations: string[] = [];
  /** Каждый вызов retain: какой документ и операция пришли (включая неудачные). */
  readonly log: { documentId: string; operationId: string }[] = [];
  private body: MemoryRecallBody;
  private down: string | undefined;
  private retainFailures: ('before-store' | 'after-store')[] = [];

  constructor(
    readonly id: string,
    items: MemoryItem[],
    readonly extra: { costUnits?: number; providerVersion?: string } = {},
  ) {
    this.body = { items, ...extra };
  }

  /** Новый ответ recall (например, после согласования). */
  respond(items: MemoryItem[]) {
    this.body = { ...this.body, items };
  }
  unavailable(reason = 'connection refused') {
    this.down = reason;
  }
  available() {
    this.down = undefined;
  }
  /** Следующие вызовы retain падают: до записи или после неё (неизвестный исход). */
  failRetain(...modes: ('before-store' | 'after-store')[]) {
    this.retainFailures.push(...modes);
  }

  recall(query: MemoryQuery): Promise<{ body: string }> {
    this.calls.recall++;
    this.queries.push(query);
    if (this.down) return Promise.reject(new Error(this.down));
    return Promise.resolve({ body: JSON.stringify(this.body) });
  }

  retain(document: MemoryDocument): Promise<MemoryRetainAck> {
    this.calls.retain++;
    this.log.push({ documentId: document.documentId, operationId: document.operationId });
    if (this.down) return Promise.reject(new Error(this.down));
    const failure = this.retainFailures.shift();
    if (failure === 'before-store') return Promise.reject(new Error('retain failed before store'));
    this.documents.set(document.documentId, structuredClone(document));
    if (!this.operations.includes(document.operationId)) this.operations.push(document.operationId);
    if (failure === 'after-store')
      return Promise.reject(new Error('retain response lost after store'));
    return Promise.resolve({ status: 'stored', receipt: document.documentId });
  }
}
