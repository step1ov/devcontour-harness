import {
  HarnessError,
  digestOf,
  type Prerequisite,
  type WorkGraph,
  type SourceRef,
  type WorkSource,
} from '../../contracts/index.ts';
import { connectorIdOf, parseIdentity, type ConnectorConfig } from './config.ts';
import {
  assertEligible,
  readFailure,
  semanticDigest,
  takeSnapshot,
  type BuiltSnapshot,
} from './snapshot.ts';
import type { ConnectorStore } from './store.ts';
import { TransportError, type RelayTransport } from './transport.ts';

/**
 * Источник поручений из внешнего хранилища задач.
 *
 * - `fetch` — согласованный снимок набора задач конфигурации (eligibility и
 *   пределы проверяются до возврата графа);
 * - `revision` — текущий semantic digest задачи (или набора) для обнаружения
 *   конфликта; ошибка сети/CLI — исключение, а не «записи нет»;
 * - `trusts` — только receipt, выданный этим коннектором (`issuer` = его ID),
 *   digest которого совпадает с записью в его состоянии. Статус задачи done
 *   доверием не является.
 */
export class RelayWorkSource implements WorkSource {
  readonly id: string;
  constructor(
    readonly options: { config: ConnectorConfig; transport: RelayTransport; store: ConnectorStore },
  ) {
    this.id = connectorIdOf(options.config.provider, options.config.projectId);
  }

  /** Снимок без проверки eligibility (для предпросмотра и диагностики). */
  snapshot(signal?: AbortSignal): Promise<BuiltSnapshot> {
    return takeSnapshot({
      config: this.options.config,
      transport: this.options.transport,
      receiptOf: (orderId) => this.options.store.receipts(orderId).at(-1),
      ...(signal ? { signal } : {}),
    });
  }

  async fetch(ref: string): Promise<{ graph: WorkGraph; source: SourceRef }> {
    const snapshot = await this.snapshot();
    if (ref && ref !== snapshot.graph.source.ref && ref !== snapshot.graph.id)
      throw new HarnessError(
        'INVALID_INPUT',
        `Источник ${this.id} читает набор задач конфигурации (${snapshot.graph.source.ref}), запрошен ${ref}`,
      );
    assertEligible(snapshot);
    return { graph: snapshot.graph, source: snapshot.graph.source };
  }

  async revision(ref: string): Promise<string | undefined> {
    const identity = parseIdentity(ref);
    const config = this.options.config;
    if (
      !identity ||
      identity.provider !== config.provider ||
      identity.projectId !== config.projectId ||
      identity.taskId.includes('+')
    ) {
      // Ссылка набора задач: semantic digest графа по свежему снимку.
      return (await this.snapshot()).revision;
    }
    let read;
    try {
      read = await this.options.transport.readTask(identity.taskId);
    } catch (error) {
      if (error instanceof TransportError && error.kind === 'not-found') return undefined;
      throw readFailure(error, 'Задача ' + identity.taskId);
    }
    const mapping = config.tasks.find((m) => m.ref === read.task.id || m.ref === read.task.key);
    return mapping ? semanticDigest(config, mapping, read) : undefined;
  }

  trusts(prerequisite: Prerequisite): Promise<boolean> {
    const receipt = prerequisite.receipt;
    if (receipt.kind !== 'trusted' || receipt.issuer !== this.id) return Promise.resolve(false);
    const stored = this.options.store
      .receipts(prerequisite.id)
      .find(
        (r) =>
          r.issuer === this.id &&
          digestOf(r) === receipt.digest &&
          r.resultSha === prerequisite.resultSha &&
          r.repositoryId === prerequisite.repositoryId,
      );
    return Promise.resolve(Boolean(stored));
  }
}
