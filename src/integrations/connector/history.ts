import {
  sha256,
  type AttemptState,
  type RunResult,
  type WorkState,
} from '../../contracts/index.ts';
import { BlockedError } from '../../engine/classify.ts';
import type { RunnerHooks } from '../../engine/runner.ts';
import { redactor, type Redactor } from '../../environment/redaction.ts';
import { parseIdentity, type ConnectorConfig } from './config.ts';
import {
  newStep,
  runStep,
  StepConflict,
  StepRetry,
  StepUncertain,
  type ReadBack,
} from './steps.ts';
import type { ConnectorStore, StepRecord } from './store.ts';
import { stripPaths } from './summary.ts';
import { redactingTransport } from './redact.ts';
import type { HistoryMutation, RelayTransport, SessionRecord } from './transport.ts';

/**
 * История работы в backend: корневая сессия поручения и дочерняя сессия на
 * каждую попытку.
 *
 * - До исполнения попытки (`prepared`, до writer) — корневая сессия с intent,
 *   затем fork + attach дочерней и её intent. Отказ обязательной записи —
 *   `BlockedError`: попытка не начинается, runtime не вызывается.
 * - Отказ попытки (`failed`) — cancel дочернего intent и сессии.
 * - Доставка результата — checkpoint с SHA и сводкой gates, завершение
 *   дочерней, приём её корневым intent, завершение корня (или отмена).
 *
 * Каждая запись — шаг с маркером в теле/описании; после неизвестного исхода
 * он находится read-back (`findSessions`/`checkpoints`) или сравнением
 * ревизии сессии, поэтому восстановление после перезапуска не дублирует
 * checkpoints. Ревизия сессии и run backend — fencing: если сессию перехватил
 * другой владелец, наш устаревший run её не завершит (`conflict`).
 *
 * Идентификаторы различны и не смешиваются: ID сессии/run backend, sessionId
 * runtime и lease token попытки harness. Lease token и полный runtime log в
 * историю не пишутся.
 */

export interface SessionLink {
  key: string;
  kind: 'root' | 'child';
  workId: string;
  attemptId?: string;
  rootKey?: string;
  /** Ключ маркеров шагов этой сессии. */
  opKey: string;
  taskKey: string;
  sessionId?: string;
  sessionKey?: string;
  /** Run backend (не lease token harness). */
  runId?: string;
  revision?: number;
  intentId?: string;
  intentClosed?: boolean;
  status: 'opening' | 'open' | 'completed' | 'cancelled' | 'conflict' | 'uncertain';
  steps: StepRecord[];
  reason?: string;
}

const ROOT = 'root:';
const CHILD = 'child:';

const text = (value: string) => value.trim() || '—';

type Purpose = 'start' | 'intent' | 'fork' | 'attach' | 'close-intent' | 'finish';

export class HistoryRecorder {
  private readonly redact: Redactor;
  private readonly t: RelayTransport;
  constructor(
    readonly options: {
      config: ConnectorConfig;
      transport: RelayTransport;
      store: ConnectorStore;
      connectorId: string;
      redact?: Redactor;
    },
  ) {
    this.redact = options.redact ?? redactor([]);
    this.t = redactingTransport(options.transport, this.redact);
  }

  get enabled() {
    return this.options.config.history.enabled;
  }

  /** Хуки runner: intent до исполнения попытки, отмена при отказе. */
  hooks(): RunnerHooks {
    return {
      prepared: async ({ work, attempt, baseSha }) => {
        if (!this.enabled) return;
        try {
          await this.beginAttempt(work, attempt, baseSha);
        } catch (error) {
          throw new BlockedError(
            'История работы не записана до исполнения: ' +
              this.redact(error instanceof Error ? error.message : String(error)),
          );
        }
      },
      failed: async ({ attempt, message }) => {
        if (!this.enabled) return;
        await this.cancelChild(attempt.id, 'Попытка завершилась отказом: ' + message).catch(
          () => undefined,
        );
      },
    };
  }

  links(workId?: string): SessionLink[] {
    return [
      ...this.options.store.histories<SessionLink>(ROOT),
      ...this.options.store.histories<SessionLink>(CHILD),
    ]
      .map((x) => x.value)
      .filter((l) => !workId || l.workId === workId);
  }

  private link(key: string) {
    return this.options.store.history<SessionLink>(key);
  }

  private markerKey(key: string) {
    return sha256(`history:${this.options.connectorId}:${key}`).slice(0, 32);
  }

  /** Текущий корень поручения для редакции постановки; закрытый — новое поколение. */
  private rootKeyOf(work: WorkState) {
    const base = `${ROOT}${work.id}:${work.order.source.revision}:`;
    const existing = this.options.store.histories<SessionLink>(base);
    const last = existing.at(-1);
    if (last && (last.value.status === 'opening' || last.value.status === 'open')) return last.key;
    return base + String(existing.length + 1);
  }

  /* ---------------------------------------------------------------- */
  /* Read-back и применение итога по виду шага                         */
  /* ---------------------------------------------------------------- */

  private async findByMarker(marker: string): Promise<SessionRecord[]> {
    const found = await this.t.findSessions(marker);
    return found.filter((s) => s.title.includes(marker) || s.description.includes(marker));
  }

  /** Факты получателя о шаге после неизвестного исхода. */
  private async readBackFor(link: SessionLink, step: StepRecord): Promise<ReadBack> {
    const t = this.t;
    const ifRevision = step.input.ifRevision as number | undefined;
    const purpose = step.input.purpose as Purpose;
    if (purpose === 'start' || purpose === 'fork') {
      const found = await this.findByMarker(step.marker);
      const root = purpose === 'fork' ? this.link(link.rootKey!) : undefined;
      const parent = root?.sessionId ? await t.getSession(root.sessionId) : undefined;
      if (found.length === 1) {
        const s = found[0]!;
        return {
          state: 'found',
          result: {
            sessionId: s.id,
            sessionKey: s.key,
            revision: s.revision,
            ...(purpose === 'start' ? { runId: s.currentRunId } : {}),
            ...(parent ? { parentRevision: parent.revision } : {}),
          },
        };
      }
      if (found.length > 1)
        return { state: 'ambiguous', reason: `сессия с маркером найдена ${found.length} раз` };
      if (parent && parent.revision === ifRevision)
        return { state: 'absent', reason: 'ревизия корня не изменилась, fork нет' };
      if (parent) return { state: 'foreign', reason: 'ревизия корня изменилась без нашего fork' };
      return {
        state: 'ambiguous',
        reason: 'сессия с маркером не найдена после возможной отправки',
      };
    }
    if (!link.sessionId) return { state: 'ambiguous', reason: 'сессия неизвестна' };
    const session = await t.getSession(link.sessionId);
    if (purpose === 'intent' || purpose === 'close-intent') {
      const mine = (await t.checkpoints(link.sessionId)).filter(
        (c) => c.body.includes(step.marker) || c.title.includes(step.marker),
      );
      if (mine.length === 1)
        return {
          state: 'found',
          result: { checkpointId: mine[0]!.id, revision: session.revision },
        };
      if (mine.length > 1)
        return { state: 'ambiguous', reason: `checkpoint с маркером найден ${mine.length} раз` };
    } else {
      const target =
        purpose === 'attach'
          ? (s: SessionRecord) => s.status === 'open' && s.currentRunId !== null
          : (s: SessionRecord) =>
              s.status === (step.input.outcome === 'complete' ? 'completed' : 'cancelled');
      if (target(session) && ifRevision !== undefined && session.revision === ifRevision + 1)
        return {
          state: 'found',
          result: {
            runId: session.currentRunId,
            revision: session.revision,
            status: session.status,
          },
        };
    }
    if (session.revision === ifRevision)
      return { state: 'absent', reason: 'ревизия сессии не изменилась, записи нет' };
    return {
      state: 'foreign',
      reason: `ревизия сессии ${String(ifRevision)} → ${session.revision} (${session.status}) без нашей записи: другой владелец`,
    };
  }

  private applyResult(link: SessionLink, step: StepRecord, r: Record<string, unknown>) {
    switch (step.input.purpose as Purpose) {
      case 'start':
        link.sessionId = r.sessionId as string;
        link.sessionKey = r.sessionKey as string;
        link.runId = r.runId as string;
        link.revision = r.revision as number;
        return;
      case 'fork':
        link.sessionId = r.sessionId as string;
        link.sessionKey = r.sessionKey as string;
        link.revision = r.revision as number;
        return;
      case 'attach':
        link.runId = r.runId as string;
        link.revision = r.revision as number;
        return;
      case 'intent':
        link.intentId = r.checkpointId as string;
        link.revision = r.revision as number;
        link.status = 'open';
        return;
      case 'close-intent':
        link.revision = r.revision as number;
        link.intentClosed = true;
        return;
      case 'finish':
        link.revision = r.revision as number;
        link.status = step.input.outcome === 'complete' ? 'completed' : 'cancelled';
        return;
    }
  }

  private saveStep(key: string, step: StepRecord) {
    const saved = this.writeStep(key, step);
    // Fork меняет ревизию корня; идемпотентно: ревизия не опускается ниже известной.
    if (
      step.input.purpose === 'fork' &&
      step.status === 'done' &&
      typeof step.result?.parentRevision === 'number' &&
      saved.rootKey
    )
      this.options.store.putHistory<SessionLink>(saved.rootKey, (root) => ({
        ...root!,
        revision: Math.max(root!.revision ?? 0, step.result!.parentRevision as number),
      }));
    return saved;
  }

  private writeStep(key: string, step: StepRecord) {
    return this.options.store.putHistory<SessionLink>(key, (prior) => {
      const link = structuredClone(prior!);
      link.steps = link.steps.map((s) => (s.n === step.n ? step : s));
      if (step.status === 'done' && step.result) this.applyResult(link, step, step.result);
      if (step.status === 'uncertain' || step.status === 'conflict') {
        link.status = step.status;
        link.reason = step.reason;
      }
      return link;
    });
  }

  /** Выполнить шаг `n` записи `key` по протоколу шагов. */
  private async exec(
    key: string,
    n: number,
    send: (input: Record<string, unknown>, link: SessionLink) => Promise<Record<string, unknown>>,
    prepare?: (link: SessionLink) => Record<string, unknown>,
  ) {
    try {
      return await runStep(
        {
          load: () => this.link(key)!.steps.find((s) => s.n === n)!,
          save: (step) => void this.saveStep(key, step),
        },
        {
          ...(prepare ? { prepare: () => prepare(this.link(key)!) } : {}),
          send: (input) => send(input, this.link(key)!),
          readBack: () => {
            const link = this.link(key)!;
            return this.readBackFor(
              link,
              link.steps.find((s) => s.n === n)!,
            );
          },
        },
      );
    } catch (error) {
      const what = `история (${key.split(':')[0]}, шаг ${n}): `;
      if (error instanceof StepRetry) throw new StepRetry(n, what + error.message);
      if (error instanceof StepConflict) throw new StepConflict(n, what + error.message);
      if (error instanceof StepUncertain) throw new StepUncertain(n, what + error.message);
      throw error;
    }
  }

  /**
   * Запись прерванной попытки (перезапуск controller): незавершённые шаги
   * только разбираются по фактам — `planned` не отправляется, `sending`
   * подтверждается read-back; повторной отправки нет.
   */
  private async settle(key: string) {
    for (const step of this.link(key)!.steps) {
      if (step.status === 'planned') this.saveStep(key, { ...step, status: 'skipped' });
      else if (step.status === 'sending') {
        let rb: ReadBack;
        try {
          rb = await this.readBackFor(this.link(key)!, step);
        } catch (error) {
          rb = { state: 'ambiguous', reason: 'read-back недоступен: ' + String(error) };
        }
        const at = new Date().toISOString();
        if (rb.state === 'found')
          this.saveStep(key, { ...step, status: 'done', result: rb.result, updatedAt: at });
        else if (rb.state === 'absent')
          this.saveStep(key, { ...step, status: 'skipped', reason: rb.reason, updatedAt: at });
        else
          this.saveStep(key, {
            ...step,
            status: rb.state === 'foreign' ? 'conflict' : 'uncertain',
            reason: rb.reason,
            updatedAt: at,
          });
      }
    }
    return this.link(key)!;
  }

  private addSteps(key: string, make: (n: number) => StepRecord[]) {
    return this.options.store.putHistory<SessionLink>(key, (prior) => {
      const link = structuredClone(prior!);
      const fresh = make(link.steps.length + 1).filter(
        (s) => !link.steps.some((x) => x.input.purpose === s.input.purpose),
      );
      link.steps.push(...fresh.map((s, i) => ({ ...s, n: link.steps.length + 1 + i })));
      return link;
    });
  }

  private stepOf(key: string, purpose: Purpose) {
    return this.link(key)!.steps.find((s) => s.input.purpose === purpose);
  }

  /* ---------------------------------------------------------------- */
  /* Операции                                                          */
  /* ---------------------------------------------------------------- */

  private async ensureRoot(work: WorkState) {
    const key = this.rootKeyOf(work);
    const identity = parseIdentity(work.order.source.ref);
    const taskKey = work.order.title.split(':')[0] ?? identity?.taskId ?? work.id;
    if (!this.link(key))
      this.options.store.putHistory<SessionLink>(key, (prior) => {
        if (prior) return prior;
        const opKey = this.markerKey(key);
        return {
          key,
          kind: 'root',
          workId: work.id,
          opKey,
          taskKey,
          status: 'opening',
          steps: [
            newStep(1, 'session.start', opKey, { purpose: 'start' }),
            newStep(2, 'session.intent', opKey, { purpose: 'intent' }),
          ],
        };
      });
    const t = this.t;
    await this.exec(key, 1, async (_input, link) => {
      const m = await t.startSession({
        title: this.clean(`harness: ${work.order.title}`).slice(0, 180),
        description: `Исполнение задачи ${link.taskKey} через devcontour-harness (поручение ${work.id}, постановка ${work.order.source.revision.slice(0, 12)}).\n\n${link.steps[0]!.marker}`,
        client: this.options.config.history.client,
      });
      return {
        sessionId: m.session.id,
        sessionKey: m.session.key,
        runId: m.runId ?? m.session.currentRunId,
        revision: m.session.revision,
      };
    });
    await this.exec(
      key,
      2,
      async (input, link) => {
        const m = await t.openIntent(link.sessionId!, {
          runId: link.runId!,
          ifRevision: input.ifRevision as number,
          title: 'Исполнение поручения harness',
          body: `Controller harness ведёт поручение ${work.id} по задаче ${link.taskKey}: изолированные попытки, gates, независимое ревью и приёмка Git-результата.\n\n${link.steps[1]!.marker}`,
        });
        return { checkpointId: m.checkpoint?.id, revision: m.session.revision };
      },
      (link) => ({ ifRevision: link.revision }),
    );
    return key;
  }

  /** Корень и дочерняя сессия попытки до её исполнения. */
  async beginAttempt(work: WorkState, attempt: AttemptState, baseSha: string) {
    // Записи прежних попыток, оставшиеся незавершёнными (перезапуск controller):
    // разбор по фактам и отмена — без повторной отправки их шагов.
    for (const stale of this.links(work.id))
      if (
        stale.kind === 'child' &&
        stale.attemptId !== attempt.id &&
        (stale.status === 'open' || stale.status === 'opening')
      ) {
        const settled = await this.settle(stale.key);
        if (settled.sessionId && (settled.status === 'open' || settled.status === 'opening'))
          await this.close(
            stale.key,
            'cancel',
            {
              title: 'Попытка прервана',
              body: 'Попытка прервана (перезапуск controller); работа продолжена новой попыткой.',
            },
            'Попытка прервана перезапуском controller',
          ).catch(() => undefined);
      }
    const rootKey = await this.ensureRoot(work);
    const key = CHILD + attempt.id;
    const t = this.t;
    if (!this.link(key))
      this.options.store.putHistory<SessionLink>(key, (prior) => {
        if (prior) return prior;
        const opKey = this.markerKey(key);
        return {
          key,
          kind: 'child',
          workId: work.id,
          attemptId: attempt.id,
          rootKey,
          opKey,
          taskKey: this.link(rootKey)!.taskKey,
          status: 'opening',
          steps: [
            newStep(1, 'session.fork', opKey, { purpose: 'fork' }),
            newStep(2, 'session.attach', opKey, { purpose: 'attach' }),
            newStep(3, 'session.intent', opKey, { purpose: 'intent' }),
          ],
        };
      });
    await this.exec(
      key,
      1,
      async (input, link) => {
        const root = this.link(rootKey)!;
        const m: HistoryMutation = await t.fork(root.intentId!, {
          runId: root.runId!,
          ifRevision: input.ifRevision as number,
          title: this.clean(`Попытка ${attempt.attempt}: ${work.order.title}`).slice(0, 180),
          description: `Попытка harness ${attempt.id} (№ ${attempt.attempt}), runtime ${attempt.runtime}.\n\n${link.steps[0]!.marker}`,
        });
        return {
          sessionId: m.childSession?.id,
          sessionKey: m.childSession?.key,
          revision: m.childSession?.revision,
          parentRevision: m.session.revision,
        };
      },
      () => ({ ifRevision: this.link(rootKey)!.revision }),
    );
    await this.exec(
      key,
      2,
      async (input, link) => {
        const m = await t.attach(link.sessionId!, {
          ifRevision: input.ifRevision as number,
          client: this.options.config.history.client,
        });
        return { runId: m.runId ?? m.session.currentRunId, revision: m.session.revision };
      },
      (link) => ({ ifRevision: link.revision }),
    );
    await this.exec(
      key,
      3,
      async (input, link) => {
        const m = await t.openIntent(link.sessionId!, {
          runId: link.runId!,
          ifRevision: input.ifRevision as number,
          title: `Попытка ${attempt.attempt}`,
          body: `Исполнение попытки ${attempt.id} от base ${baseSha}.\n\n${link.steps[2]!.marker}`,
        });
        return { checkpointId: m.checkpoint?.id, revision: m.session.revision };
      },
      (link) => ({ ifRevision: link.revision }),
    );
  }

  /** Закрыть intent и сессию записи `key`: итог или отмена. */
  private async close(
    key: string,
    outcome: 'complete' | 'cancel',
    checkpoint: {
      title: string;
      body: string;
      checks?: string;
      acceptedSessionIds?: () => string[];
    },
    resultText: string,
  ) {
    const t = this.t;
    const link = this.link(key);
    if (!link || link.status === 'completed' || link.status === 'cancelled') return link;
    if (link.status === 'conflict')
      throw new StepConflict(0, `история ${link.kind}: конфликт: ${link.reason ?? ''}`);
    if (link.status === 'uncertain')
      throw new StepUncertain(0, `история ${link.kind}: исход не доказан: ${link.reason ?? ''}`);
    const kind = outcome === 'complete' ? 'result' : 'cancel';
    this.addSteps(key, (n) => [
      newStep(n, 'session.checkpoint', link.opKey, { purpose: 'close-intent', kind }),
      newStep(n + 1, 'session.finish', link.opKey, { purpose: 'finish', outcome }),
    ]);
    const cp = this.stepOf(key, 'close-intent')!;
    const fin = this.stepOf(key, 'finish')!;
    if (this.link(key)!.intentId && cp.status !== 'skipped')
      await this.exec(
        key,
        cp.n,
        async (input, l) => {
          const m = await t.checkpoint(l.intentId!, cp.input.kind as 'result' | 'cancel', {
            runId: l.runId!,
            ifRevision: input.ifRevision as number,
            title: this.clean(checkpoint.title).slice(0, 180),
            body: this.clean(checkpoint.body) + '\n\n' + cp.marker,
            ...(checkpoint.checks ? { checks: this.clean(checkpoint.checks) } : {}),
            ...(checkpoint.acceptedSessionIds
              ? { acceptedSessionIds: checkpoint.acceptedSessionIds() }
              : {}),
          });
          return { checkpointId: m.checkpoint?.id, revision: m.session.revision };
        },
        (l) => ({ ifRevision: l.revision }),
      );
    else if (cp.status === 'planned') this.saveStep(key, { ...cp, status: 'skipped' });
    await this.exec(
      key,
      fin.n,
      async (input, l) => {
        const m = await t.finishSession(l.sessionId!, fin.input.outcome as 'complete' | 'cancel', {
          ...(l.runId ? { runId: l.runId } : {}),
          ifRevision: input.ifRevision as number,
          result: this.clean(resultText).slice(0, 4000),
        });
        return { revision: m.session.revision, status: m.session.status };
      },
      (l) => ({ ifRevision: l.revision }),
    );
    return this.link(key);
  }

  /**
   * Reconcile: неоднозначные шаги истории поручения снова разбираются
   * read-back (`sending`); сама запись не отправляется.
   */
  resetUncertain(workId: string) {
    for (const link of this.links(workId))
      if (link.status === 'uncertain')
        this.options.store.putHistory<SessionLink>(link.key, (prior) => ({
          ...prior!,
          status: prior!.intentId ? 'open' : 'opening',
          steps: prior!.steps.map((s) =>
            s.status === 'uncertain' ? { ...s, status: 'sending' as const } : s,
          ),
        }));
  }

  /** Отмена дочерней сессии попытки (отказ, прерывание). */
  async cancelChild(attemptId: string, reason: string) {
    const key = CHILD + attemptId;
    const link = this.link(key);
    if (!link || !link.sessionId) return;
    await this.close(key, 'cancel', { title: 'Попытка отменена', body: reason }, reason);
  }

  /**
   * Итог доставки: дочерняя сессия попытки результата и корень поручения.
   * Принятый результат — checkpoint с SHA и gates, завершение и приём
   * дочерней; иначе — отмена.
   */
  async closeResult(result: RunResult, workId: string) {
    const child = this.link(CHILD + result.runId);
    const root = this.options.store
      .histories<SessionLink>(`${ROOT}${workId}:${result.source.revision}:`)
      .map((x) => x.value)
      .at(-1);
    if (!root && !child) return { status: 'none' };
    const gates = result.evidence
      .filter((e) => e.kind !== 'review')
      .map(
        (e) => `${e.gate} [${e.phase}] ${e.passed ? 'passed' : 'failed'} @ ${e.sha.slice(0, 12)}`,
      )
      .join('\n');
    const accepted = result.outcome === 'accepted';
    const body = accepted
      ? `Результат принят harness: ${result.targetRef} содержит ${result.shas.result}.\ncandidate ${result.shas.candidate}\nintegration/result ${result.shas.result}`
      : `Результат не принят: ${result.stopReason.code}: ${result.stopReason.message.slice(0, 500)}`;
    if (child)
      await this.close(
        child.key,
        accepted ? 'complete' : 'cancel',
        { title: accepted ? 'Результат попытки' : 'Попытка без результата', body, checks: gates },
        accepted ? `Принят результат ${result.shas.result}` : body,
      );
    if (root) {
      const done = this.link(CHILD + result.runId);
      await this.close(
        root.key,
        accepted ? 'complete' : 'cancel',
        {
          title: accepted ? 'Поручение выполнено' : 'Поручение без принятого результата',
          body,
          checks: gates,
          ...(accepted && done?.sessionId && done.status === 'completed'
            ? { acceptedSessionIds: () => [done.sessionId!] }
            : {}),
        },
        accepted ? `Принят результат ${result.shas.result}` : body,
      );
    }
    return {
      status: 'closed',
      ...((k) => (k ? { root: k } : {}))(root ? this.link(root.key)?.sessionKey : undefined),
      ...((k) => (k ? { child: k } : {}))(this.link(CHILD + result.runId)?.sessionKey),
    };
  }

  private clean(value: string) {
    return text(stripPaths(this.redact(value)));
  }
}
