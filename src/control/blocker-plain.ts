// Почему поручение не выдаётся — простыми словами и кто это снимает
// (`status`, `works[].blockers[].plain`/`plainEn`/`actor`). Код блокировки
// — `Engine.blockers`; разновидность внутри кода — по сообщению движка
// (его тексты — константы этого пакета) и по состоянию выдачи. Сообщение
// хоста (`HostGuards.claimable`) в простой текст не переносится: у него —
// общий текст кода, само сообщение остаётся в `message`.

import type { ControlState, ExecutionPolicy } from '../contracts/index.ts';
import type { Engine } from '../engine/engine.ts';
import type { Actor } from '../projections/index.ts';

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
    ru: 'бюджет исчерпан — нужно ваше решение поднять бюджет',
    en: 'the budget is used up — you decide whether to raise it',
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
    default:
      return {
        ru: 'пауза очереди: поставил оператор — снимите паузу, когда готовы',
        en: 'queue paused by the operator — resume when ready',
        actor: 'user',
      };
  }
};

const statusText = (status: string, mode: ExecutionPolicy['approvalMode']): Text | undefined => {
  switch (status) {
    case 'draft':
      return {
        ru: 'черновик — не утверждён',
        en: 'draft — not approved yet',
        actor: approver(mode),
      };
    case 'failed':
      return {
        ru: 'остановлено после отказа — ждёт разбора и повтора',
        en: 'stopped after a failure — waiting for diagnosis and a retry',
        actor: 'lead',
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
const idPart = (s: string) => clip(s.trim()).slice(0, 200);

function textOf(
  b: { code: BlockerCode; message: string },
  ctx: { control: ControlState; approvalMode: ExecutionPolicy['approvalMode'] },
): Text {
  const m = b.message;
  switch (b.code) {
    case 'NOT_READY': {
      const dep = /^Ждёт (\S+)$/.exec(m);
      if (dep)
        return {
          ru: `ждёт зависимости ${idPart(dep[1]!)}`,
          en: `waiting for dependency ${idPart(dep[1]!)}`,
          actor: 'controller',
        };
      const status = /^Статус (\S+)$/.exec(m);
      if (status) return statusText(status[1]!, ctx.approvalMode) ?? blockerCodeText.NOT_READY;
      if (m.startsWith('Идёт совместная проверка'))
        return {
          ru: 'ждёт конца совместной проверки репозиториев — ничего не нужно',
          en: 'waiting for the joint repository check to finish — nothing needed',
          actor: 'controller',
        };
      const hold = /^Удержано операцией (.+)$/.exec(m);
      if (hold)
        return {
          ru: `удержано операцией ${idPart(hold[1]!)} — ждёт её конца`,
          en: `held by operation ${idPart(hold[1]!)} — waiting for it to finish`,
          actor: 'controller',
        };
      if (m.startsWith('Разбор свойства'))
        return {
          ru: 'повторяющийся отказ на разборе — ждёт решения о восстановлении',
          en: 'a repeating failure is under analysis — waiting for a recovery decision',
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
    default:
      return blockerCodeText[b.code];
  }
}

/** Блокировка простыми словами и кто её снимает. */
export function plainBlocker(
  b: { code: BlockerCode; message: string },
  ctx: { control: ControlState; approvalMode: ExecutionPolicy['approvalMode'] },
): PlainBlocker {
  const t = textOf(b, ctx);
  return { plain: clip(t.ru), plainEn: clip(t.en), actor: t.actor };
}
