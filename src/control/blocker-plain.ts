// Почему поручение не выдаётся — простыми словами и кто это снимает
// (`status`, `works[].blockers[].plain`/`plainEn`/`actor`). Код блокировки
// — `Engine.blockers`; разновидность внутри кода — по сообщению движка
// (его тексты — константы этого пакета) и по состоянию поручения. Из
// сообщения в простой текст переносятся только идентификаторы, которые
// подтверждает состояние (зависимость поручения, операция удержания) и
// числа попыток; сообщение хоста (`HostGuards.claimable`), совпавшее с
// шаблоном движка, ничего своего в текст не добавляет — само сообщение
// остаётся в `message`.

import type { ControlState, ExecutionPolicy, WorkState } from '../contracts/index.ts';
import type { Engine } from '../engine/engine.ts';
import type { Actor, NextAction } from '../projections/index.ts';
import { OPERATOR_VIEW_TEXT } from '../contracts/operator-view-limits.ts';
import { fitLine, named } from '../projections/clip.ts';
import { actionText } from './stage.ts';

/** Коды блокировок `Engine.blockers`: у каждого — простой текст (`blockerCodeText`). */
export type BlockerCode = ReturnType<Engine['blockers']>[number]['code'];

export interface PlainBlocker {
  plain: string;
  plainEn: string;
  actor: Actor;
}

type Text = { ru: string; en: string; actor: Actor };

/**
 * Общий текст кода — когда разновидность не распознана (сообщение хоста,
 * новая формулировка). Тест требует запись для каждого кода `Engine.blockers`.
 */
export const blockerCodeText: Record<BlockerCode, Text> = {
  NOT_READY: {
    ru: 'пока не готово к выдаче — ждёт условия',
    en: 'not ready to start yet — waiting on a condition',
    actor: 'controller',
  },
  PAUSED: { ru: 'пауза очереди', en: 'the queue is paused', actor: 'user' },
  ATTEMPTS_EXHAUSTED: {
    ru: 'попытки исчерпаны — нужен ваш сброс попыток',
    en: 'attempts are used up — you need to reset them',
    actor: 'user',
  },
  APPROVAL_STALE: {
    ru: 'согласование устарело — нужно согласовать заново',
    en: 'the approval is stale — approve again',
    actor: 'lead',
  },
  APPROVAL_REQUIRED: {
    ru: 'ждёт согласования',
    en: 'waiting for approval',
    actor: 'lead',
  },
  BUDGET_EXHAUSTED: {
    ru: 'бюджет исчерпан или не определён — нужно ваше решение',
    en: 'the budget is used up or undetermined — your decision is needed',
    actor: 'user',
  },
  REVIEWER_SAME_VENDOR: {
    ru: 'ревьюер того же вендора, что исполнитель — поправьте назначение ревью в политике',
    en: 'the reviewer has the same vendor as the writer — fix the review assignment in the policy',
    actor: 'user',
  },
  REVIEWER_MISSING: {
    ru: 'для роли нет ревьюера — назначьте его в политике',
    en: 'the role has no reviewer — assign one in the policy',
    actor: 'user',
  },
  INVALID_INPUT: {
    ru: 'роль задачи не объявлена в политике — поправьте политику',
    en: 'the task role is not declared in the policy — fix the policy',
    actor: 'user',
  },
  INPUT_REQUIRED: {
    ru: 'ждёт вашего ответа на вопрос исполнителя',
    en: 'waiting for your answer to the writer question',
    actor: 'user',
  },
};

/** Чей ход согласования плана: оператора (`approvalMode: operator`) или ведущего. */
const approver = (mode: ExecutionPolicy['approvalMode']): Actor =>
  mode === 'operator' ? 'user' : 'lead';

const pauseText = (control: ControlState): Text => {
  if (control.pauseFailures?.includes('budget'))
    return {
      ru: 'пауза очереди: бюджет — нужно ваше решение',
      en: 'queue paused: budget — your decision is needed',
      actor: 'user',
    };
  switch (control.pauseReason) {
    case 'shutdown':
      return {
        ru: 'пауза очереди: штатная остановка — снимет следующий запуск',
        en: 'queue paused: orderly shutdown — the next run lifts it',
        actor: 'controller',
      };
    case 'runtime':
      return {
        ru: 'пауза очереди: отказ окружения или модели — нужно исправить окружение',
        en: 'queue paused: environment or model failure — fix the environment',
        actor: 'user',
      };
    case 'base-check':
      return {
        ru: 'пауза очереди: ждёт вашего подтверждения перенесённой базы',
        en: 'queue paused: waiting for you to confirm the moved base',
        actor: 'user',
      };
    case 'reconfigure':
      return {
        ru: 'пауза очереди: применяется новая политика',
        en: 'queue paused: a new policy is being applied',
        actor: 'controller',
      };
    case undefined:
      return {
        ru: 'очередь ещё не запускали — снимет следующий запуск',
        en: 'the queue has not been started yet — the next run lifts it',
        actor: 'controller',
      };
    default:
      return {
        ru: 'пауза очереди: поставил оператор — снимите паузу, когда готовы',
        en: 'queue paused by the operator — resume when ready',
        actor: 'user',
      };
  }
};

const statusText = (status: string, ctx: BlockerContext): Text | undefined => {
  const mode = ctx.approvalMode;
  switch (status) {
    case 'draft':
      return {
        ru: 'черновик — не утверждён',
        en: 'draft — not approved yet',
        actor: approver(mode),
      };
    case 'failed':
      // Кто и что дальше — диагноз `explain` поручения (`stage.needs`).
      return ctx.needs && ctx.needs.action !== 'none' && ctx.needs.action !== 'wait'
        ? {
            ru: `остановлено после отказа — дальше: ${actionText[ctx.needs.action].ru}`,
            en: `stopped after a failure — next: ${actionText[ctx.needs.action].en}`,
            actor: ctx.needs.actor,
          }
        : {
            ru: 'остановлено после отказа — ждёт разбора',
            en: 'stopped after a failure — waiting for diagnosis',
            actor: ctx.needs?.actor ?? 'lead',
          };
    case 'done':
      return { ru: 'уже принято', en: 'already accepted', actor: null };
    case 'cancelled':
      return { ru: 'отменено', en: 'cancelled', actor: null };
    case 'running':
    case 'verifying':
    case 'reviewing':
    case 'integrating':
      return { ru: 'уже в работе', en: 'already in progress', actor: 'controller' };
    default:
      return undefined;
  }
};

const clip = (s: string) => (s.length > 300 ? s.slice(0, 299) + '…' : s);

/** Что известно о поручении, кроме сообщения блокировки. */
export interface BlockerContext {
  control: ControlState;
  approvalMode: ExecutionPolicy['approvalMode'];
  /** Статус поручения: у итога (`done`, `cancelled`) блокировка ничего не требует. */
  status?: string;
  /** Поручение: подтверждает зависимость, операцию удержания и разбор. */
  work?: Pick<WorkState, 'hold' | 'recovery'> & { order: { dependsOn: readonly string[] } };
  /** Статус другого поручения (зависимости). */
  statusOf?: (workId: string) => string | undefined;
  /** Диагноз `explain` поручения: кто и что дальше (`stage.needs`). */
  needs?: { actor: Actor; action: NextAction };
  /** Диагноз `explain` другого поручения (зависимости); нет — неизвестно. */
  needsOf?: (workId: string) => { actor: Actor; action: NextAction } | undefined;
}

function dependencyText(id: string, ctx: BlockerContext): Text {
  if (!ctx.work?.order.dependsOn.includes(id))
    return {
      ru: 'ждёт другой задачи',
      en: 'waiting for another task',
      actor: 'controller',
    };
  switch (ctx.statusOf?.(id)) {
    case 'failed': {
      // Что дальше с зависимостью — её диагноз `explain` (повтор harness,
      // разбор ведущего, решение человека).
      const next = ctx.needsOf?.(id);
      if (next && next.action !== 'none' && next.action !== 'wait')
        return {
          ru: `ждёт зависимости ${id} — она остановлена, дальше: ${actionText[next.action].ru}`,
          en: `waiting for dependency ${id} — it stopped, next: ${actionText[next.action].en}`,
          actor: next.actor,
        };
      return {
        ru: `ждёт зависимости ${id} — она остановлена отказом, нужен её разбор`,
        en: `waiting for dependency ${id} — it stopped with a failure and needs diagnosis`,
        actor: next?.actor ?? 'lead',
      };
    }
    case 'cancelled':
      return {
        ru: `зависимость ${id} отменена — нужно перепланировать зависимые`,
        en: `dependency ${id} was cancelled — the dependents need replanning`,
        actor: 'lead',
      };
    default:
      return {
        ru: `ждёт зависимости ${id}`,
        en: `waiting for dependency ${id}`,
        actor: 'controller',
      };
  }
}

function textOf(b: { code: BlockerCode; message: string }, ctx: BlockerContext): Text {
  const m = b.message;
  switch (b.code) {
    case 'NOT_READY': {
      const dep = /^Ждёт (\S+)$/.exec(m);
      if (dep) return dependencyText(dep[1]!, ctx);
      const status = /^Статус (\S+)$/.exec(m);
      if (status) return statusText(status[1]!, ctx) ?? blockerCodeText.NOT_READY;
      if (m.startsWith('Идёт совместная проверка'))
        return {
          ru: 'ждёт конца совместной проверки репозиториев — ничего не нужно',
          en: 'waiting for the joint repository check to finish — nothing needed',
          actor: 'controller',
        };
      const hold = /^Удержано операцией (.+)$/.exec(m);
      if (hold) {
        const op = ctx.work?.hold?.operation === hold[1] ? hold[1] : '';
        // Имя операции не ограничено договором: оно сокращается серединой,
        // «ждёт её конца» остаётся в пределе строки представления.
        const line = (head: string, tail: string) =>
          op ? fitLine([head + ' ', named(op), tail], OPERATOR_VIEW_TEXT.plain) : head + tail;
        return {
          ru: line('удержано операцией', ' — ждёт её конца'),
          en: line('held by an operation', ' — waiting for it to finish'),
          actor: 'controller',
        };
      }
      if (m.startsWith('Разбор свойства'))
        return ctx.work?.recovery?.status === 'awaiting-user'
          ? {
              ru: 'повторяющийся отказ — ждёт вашего решения о восстановлении',
              en: 'a repeating failure — waiting for your recovery decision',
              actor: 'user',
            }
          : {
              ru: 'повторяющийся отказ на разборе — ждёт решения ведущего о восстановлении',
              en: 'a repeating failure is under analysis — waiting for the lead recovery decision',
              actor: 'lead',
            };
      return blockerCodeText.NOT_READY;
    }
    case 'PAUSED':
      if (m.startsWith('Очередь ждёт подтверждения перенесённой базы'))
        return pauseText({ ...ctx.control, pauseReason: 'base-check' });
      if (/^Операция .+ применяет политику$/.test(m))
        return pauseText({ ...ctx.control, pauseReason: 'reconfigure', pauseFailures: [] });
      if (m.startsWith('Очередь на паузе')) return pauseText(ctx.control);
      return blockerCodeText.PAUSED;
    case 'APPROVAL_REQUIRED':
      if (m === 'Граф не согласован')
        return {
          ru: 'ждёт согласования плана',
          en: 'waiting for plan approval',
          actor: approver(ctx.approvalMode),
        };
      if (m.startsWith('Принятие версии корпуса'))
        return {
          ru: 'ждёт вашего подтверждения версии корпуса проверок',
          en: 'waiting for you to confirm the check corpus version',
          actor: 'user',
        };
      if (m.startsWith('Контракт '))
        return {
          ru: 'ждёт ревью и согласования контракта',
          en: 'waiting for the contract review and approval',
          actor: 'lead',
        };
      return blockerCodeText.APPROVAL_REQUIRED;
    case 'APPROVAL_STALE':
      if (m.startsWith('Процесс работает не с применённой политикой'))
        return {
          ru: 'процесс harness работает со старой политикой — перезапустите его с применённой',
          en: 'the harness process runs an old policy — restart it with the applied one',
          actor: 'lead',
        };
      if (m.startsWith('Политика изменилась'))
        return {
          ru: 'политика изменилась после согласования — нужно согласовать план заново',
          en: 'the policy changed after approval — approve the plan again',
          actor: approver(ctx.approvalMode),
        };
      if (m.startsWith('Постановка изменилась'))
        return {
          ru: 'задача изменилась после согласования — нужно согласовать заново',
          en: 'the task changed after approval — approve it again',
          actor: approver(ctx.approvalMode),
        };
      return { ...blockerCodeText.APPROVAL_STALE, actor: approver(ctx.approvalMode) };
    case 'INPUT_REQUIRED':
      if (m.includes('устарел'))
        return {
          ru: 'перенесённый ответ устарел — ведущему нужен новый перенос',
          en: 'the carried answer went stale — the lead has to carry it again',
          actor: 'lead',
        };
      if (m.includes('не применён'))
        return {
          ru: 'ответ записан — ждёт применения ведущим',
          en: 'the answer is recorded — waiting for the lead to apply it',
          actor: 'lead',
        };
      return blockerCodeText.INPUT_REQUIRED;
    case 'ATTEMPTS_EXHAUSTED': {
      const n = /^Исчерпано (\d+) из (\d+)/.exec(m);
      return n
        ? {
            ...blockerCodeText.ATTEMPTS_EXHAUSTED,
            ru: `попытки исчерпаны (${n[1]} из ${n[2]}) — нужен ваш сброс попыток`,
            en: `attempts are used up (${n[1]} of ${n[2]}) — you need to reset them`,
          }
        : blockerCodeText.ATTEMPTS_EXHAUSTED;
    }
    case 'BUDGET_EXHAUSTED':
      if (/^Бюджет .* не определён/.test(m))
        return {
          ru: 'бюджет не определён: у вызовов неизвестна стоимость или время — нужны цены или учёт вызовов (поднятие предела не поможет)',
          en: 'the budget is undetermined: some calls have no known cost or time — configure prices or call records (raising the limit will not help)',
          actor: 'user',
        };
      if (/^Бюджет .*исчерпан/.test(m))
        return {
          ru: 'бюджет исчерпан — нужно ваше решение поднять бюджет',
          en: 'the budget is used up — you decide whether to raise it',
          actor: 'user',
        };
      return blockerCodeText.BUDGET_EXHAUSTED;
    default:
      return blockerCodeText[b.code];
  }
}

/** Блокировка простыми словами и кто её снимает. */
export function plainBlocker(
  b: { code: BlockerCode; message: string },
  ctx: BlockerContext,
): PlainBlocker {
  // Итог: блокировка выдачи ничего не требует — поручение уже принято или
  // отменено (код и сообщение остаются для диагностики).
  const t =
    ctx.status === 'done' || ctx.status === 'cancelled'
      ? statusText(ctx.status, ctx)!
      : textOf(b, ctx);
  return { plain: clip(t.ru), plainEn: clip(t.en), actor: t.actor };
}
