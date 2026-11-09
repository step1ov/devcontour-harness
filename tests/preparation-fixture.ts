import { TaskFailure } from '../src/contracts/index.ts';
import { preparation } from '../src/environment/lifecycle.ts';

/** Метка отказа подменённой сверки подготовки. */
export const WIRED = 'PREPARATION-GUARD-WIRED';

/** Вызов сверки подготовки: дерево, проверена ли после подготовки и чем. */
export type PreparationCall = {
  root: string;
  checked: boolean;
  /** Окружение фазы, переданное проверке: в него пишется владение подготовки. */
  execution?: { env?: NodeJS.ProcessEnv; prepared?: Set<string> };
};

/**
 * Подменяет сверку подготовки фазы (`preparation.guard`) на время `action`:
 * вызов номер `fails` (с 1) после подготовки отказывает средой с меткой
 * `WIRED`, остальные проходят. Так тест видит, что фаза создаёт сверку до
 * подготовки и проверяет её после, без песочницы ОС.
 */
export async function withPreparationStub<T>(
  fails: number,
  action: (calls: PreparationCall[]) => Promise<T>,
) {
  const original = preparation.guard;
  const calls: PreparationCall[] = [];
  preparation.guard = (_os, root) => {
    const call: PreparationCall = { root, checked: false };
    calls.push(call);
    const n = calls.length;
    return (execution) => {
      call.checked = true;
      call.execution = execution;
      if (n === fails) throw new TaskFailure('environment', WIRED, undefined, 'sandbox-policy');
    };
  };
  try {
    return await action(calls);
  } finally {
    preparation.guard = original;
  }
}
