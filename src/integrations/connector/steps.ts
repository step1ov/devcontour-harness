import { TransportError } from './transport.ts';
import type { StepRecord } from './store.ts';

/**
 * Протокол одного внешнего шага (комментарий, критерий, перемещение, запись
 * истории). Шаг сохраняется в состоянии коннектора до вызова:
 *
 * - `planned` — intent записан, вызова не было: отправка безопасна;
 * - `sending` — вызов мог дойти; после обрыва исход выясняется только
 *   read-back по маркеру (append-only) или сравнением состояния (CAS);
 * - `done` — получатель подтвердил запись (ответом или read-back);
 * - `uncertain` — исход доказать нельзя: автоматический повтор запрещён,
 *   нужен `source-reconcile`;
 * - `conflict` — CAS/доменный отказ или чужое изменение: старый результат
 *   не применяется к новой редакции.
 */

/** Итог read-back после неизвестного исхода. */
export type ReadBack =
  /** Запись найдена ровно одна (маркер) или целевое состояние достигнуто. */
  | { state: 'found'; result: Record<string, unknown> }
  /** Доказано, что запись не применена, и повтор защищён CAS (ревизия не изменилась). */
  | { state: 'absent'; reason: string }
  /** Неоднозначно: 0 маркеров после возможной отправки, больше одного, неполный read-back. */
  | { state: 'ambiguous'; reason: string }
  /** Чужое изменение: ревизия изменилась, а целевого состояния нет. */
  | { state: 'foreign'; reason: string };

export class StepUncertain extends Error {
  override name = 'StepUncertain';
  constructor(
    readonly step: number,
    message: string,
  ) {
    super(message);
  }
}
export class StepConflict extends Error {
  override name = 'StepConflict';
  constructor(
    readonly step: number,
    message: string,
    readonly currentRevision?: string,
  ) {
    super(message);
  }
}
/** Отправка точно не состоялась (или доказано отсутствие записи): шаг можно повторить позже. */
export class StepRetry extends Error {
  override name = 'StepRetry';
  constructor(
    readonly step: number,
    message: string,
  ) {
    super(message);
  }
}

export interface StepIo {
  load(): StepRecord;
  /** Сохранить шаг (под владением операции); отказ записи — исключение, вызова не будет. */
  save(step: StepRecord): void;
}

const at = () => new Date().toISOString();
const reasonOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1000);

/**
 * Выполнить шаг по протоколу. `prepare` — входы, известные только в момент
 * отправки (CAS-ревизия), записываются вместе с `sending` до вызова.
 */
export async function runStep(
  io: StepIo,
  handlers: {
    prepare?: () => Record<string, unknown>;
    send: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    readBack: (input: Record<string, unknown>) => Promise<ReadBack>;
    /** Запись без CAS (append-only): ответ conflict — подтверждённый отказ, не повод для read-back. */
    appendOnly?: boolean;
  },
): Promise<Record<string, unknown>> {
  let step = io.load();
  if (step.status === 'done' || step.status === 'skipped') return step.result ?? {};
  if (step.status === 'uncertain')
    throw new StepUncertain(step.n, step.reason ?? 'исход шага не доказан');
  if (step.status === 'conflict') throw new StepConflict(step.n, step.reason ?? 'конфликт');

  const settle = (rb: ReadBack, context: string): Record<string, unknown> => {
    switch (rb.state) {
      case 'found':
        io.save({ ...step, status: 'done', result: rb.result, reason: context, updatedAt: at() });
        return rb.result;
      case 'absent':
        // Запись не применена: шаг снова planned; повтор — следующим явным вызовом.
        io.save({
          ...step,
          status: 'planned',
          reason: `${context}: ${rb.reason}`,
          updatedAt: at(),
        });
        throw new StepRetry(step.n, `${context}: ${rb.reason}`);
      case 'foreign':
        io.save({
          ...step,
          status: 'conflict',
          reason: `${context}: ${rb.reason}`,
          updatedAt: at(),
        });
        throw new StepConflict(step.n, `${context}: ${rb.reason}`);
      case 'ambiguous':
        io.save({
          ...step,
          status: 'uncertain',
          reason: `${context}: ${rb.reason}`,
          updatedAt: at(),
        });
        throw new StepUncertain(step.n, `${context}: ${rb.reason}`);
    }
  };
  const readBack = async (context: string) => {
    let rb: ReadBack;
    try {
      rb = await handlers.readBack(step.input);
    } catch (error) {
      rb = { state: 'ambiguous', reason: 'read-back недоступен: ' + reasonOf(error) };
    }
    return settle(rb, context);
  };

  if (step.status === 'sending') {
    // Прежний процесс оборвался во время вызова: только факты получателя.
    try {
      return await readBack('после прерванной отправки');
    } catch (error) {
      if (!(error instanceof StepRetry)) throw error;
      step = io.load();
    }
  }

  const refused = (error: TransportError): never => {
    const reason = `подтверждённый отказ получателя (${error.details.code ?? error.kind}): ${reasonOf(error)}`;
    io.save({ ...step, status: 'planned', reason, updatedAt: at() });
    throw new StepRetry(step.n, reason);
  };

  const extra = handlers.prepare?.() ?? {};
  step = {
    ...step,
    status: 'sending',
    input: { ...step.input, ...extra },
    sends: step.sends + 1,
    updatedAt: at(),
  };
  io.save(step);
  let result: Record<string, unknown>;
  try {
    result = await handlers.send(step.input);
  } catch (error) {
    // Составной шаг (история) сам разобрал свои записи и назвал итог.
    if (error instanceof StepConflict) {
      io.save({ ...step, status: 'conflict', reason: error.message, updatedAt: at() });
      throw new StepConflict(step.n, error.message, error.currentRevision);
    }
    if (error instanceof StepUncertain) {
      io.save({ ...step, status: 'uncertain', reason: error.message, updatedAt: at() });
      throw new StepUncertain(step.n, error.message);
    }
    if (error instanceof StepRetry) {
      io.save({ ...step, status: 'planned', reason: error.message, updatedAt: at() });
      throw new StepRetry(step.n, error.message);
    }
    if (!(error instanceof TransportError)) {
      // Не транспорт (ошибка кода/отмена): исход вызова неизвестен.
      return readBack('исключение во время вызова: ' + reasonOf(error));
    }
    switch (error.kind) {
      case 'unavailable':
        io.save({ ...step, status: 'planned', reason: reasonOf(error), updatedAt: at() });
        throw new StepRetry(
          step.n,
          'получатель недоступен, запрос не отправлен: ' + reasonOf(error),
        );
      case 'unsupported':
        io.save({ ...step, status: 'planned', reason: reasonOf(error), updatedAt: at() });
        throw new StepRetry(step.n, 'операция не поддерживается: ' + reasonOf(error));
      case 'conflict': {
        // Запись без CAS (комментарий): получатель её подтверждённо отклонил —
        // записи нет, повтор безопасен (тот же маркер).
        if (handlers.appendOnly) return refused(error);
        // Отказ CAS/состояния: своё ли это изменение — решают только факты.
        // Ответ conflict означает, что получатель запись отклонил: «нет
        // записи» здесь — конфликт (WORK_*, REVISION_CONFLICT), а не повод
        // повторить старую команду по новой ревизии.
        const code = error.details.code ?? 'CONFLICT';
        let rb: ReadBack;
        try {
          rb = await handlers.readBack(step.input);
        } catch (failure) {
          rb = { state: 'ambiguous', reason: 'read-back недоступен: ' + reasonOf(failure) };
        }
        if (rb.state === 'absent') rb = { state: 'foreign', reason: `${code}: ${reasonOf(error)}` };
        return settle(rb, 'конфликт ' + code);
      }
      case 'refused':
        // Подтверждённый отказ (структурный ответ получателя): мутации не было.
        // Это не неизвестный исход: шаг снова planned, повтор — следующей доставкой.
        return refused(error);
      case 'not-found':
        io.save({ ...step, status: 'conflict', reason: reasonOf(error), updatedAt: at() });
        throw new StepConflict(
          step.n,
          `запись получателя не найдена (${error.details.code ?? error.kind}): ${reasonOf(error)}`,
          'removed',
        );
      case 'protocol':
        // Ответ вне договора на чтение/немутирующий вызов — не неизвестный исход записи.
        if (error.details.mutation === false) return refused(error);
        return readBack('неизвестный исход (' + error.kind + ')');
      case 'uncertain':
        return readBack('неизвестный исход (' + error.kind + ')');
    }
  }
  io.save({ ...step, status: 'done', result, updatedAt: at() });
  return result;
}

export const markerOf = (key: string, n: number) =>
  `<!-- devcontour-harness:op=${key}:step=${n} -->`;

export const newStep = (
  n: number,
  kind: StepRecord['kind'],
  key: string,
  input: Record<string, unknown>,
): StepRecord => ({
  n,
  kind,
  status: 'planned',
  marker: markerOf(key, n),
  input,
  sends: 0,
  updatedAt: at(),
});
