import { HarnessError } from '../contracts/errors.ts';

/** Заглушка L0: сигнатура договора уже действует, тело приходит в рабочем пакете. */
export const notImplemented = (what: string): never => {
  throw new HarnessError('INTERNAL', `H1: не реализовано: ${what}`);
};
