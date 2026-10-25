import { z } from 'zod';
import { cliCommands, cliDataSchemas, type CliArgument } from '../contracts/cli.ts';
import type { OperationLimits } from '../contracts/catalog.ts';

/** Версия протокола каталога операций harness. */
export const CATALOG_PROTOCOL_VERSION = 1;

/**
 * Пределы транспорта общих операций CLI: UTF-8 байты значений аргументов и
 * конверта ответа. Ответ сверх предела — отказ `RESPONSE_TOO_LARGE`, данные
 * не усекаются.
 */
export const cliTransportLimits = {
  maxInputBytes: 100000,
  maxResultBytes: 1048576,
} as const satisfies OperationLimits;

/** Общие операции агентского слоя; остальные команды CLI в каталог не входят. */
export const sharedOperationNames = [
  'init',
  'explain',
  'plan-request',
  'plan-check',
  'capabilities',
] as const;
export type SharedOperationName = (typeof sharedOperationNames)[number];

/** Функция корня пакета, которая выполняет операцию без CLI. */
const apiOf = {
  init: 'initProject',
  explain: 'diagnoseState',
  'plan-request': 'planRequestOf',
  'plan-check': 'planCheck',
  capabilities: 'harnessCapabilities',
} as const satisfies Record<SharedOperationName, string>;

export interface SharedOperation<C extends SharedOperationName = SharedOperationName> {
  /** Экспорт корня пакета с той же операцией. */
  api: string;
  description: string;
  readOnly: boolean;
  input: z.ZodObject;
  output: (typeof cliDataSchemas)[C];
  limits: OperationLimits;
}

/** Схема входа CLI-операции по её аргументам: ключ — имя без `--`. */
export function cliInputSchema(args: readonly CliArgument[]): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const arg of args) {
    const value =
      arg.value === 'flag'
        ? z.boolean()
        : arg.multiple
          ? z.array(z.string().min(1)).min(1)
          : z.string().min(1);
    const described = value.describe(arg.description);
    shape[arg.name.replace(/^--/, '')] = arg.required ? described : described.optional();
  }
  return z.strictObject(shape);
}

const declare = <C extends SharedOperationName>(command: C): SharedOperation<C> => {
  const contract = cliCommands[command];
  return {
    api: apiOf[command],
    description: contract.description,
    readOnly: !contract.writes,
    input: cliInputSchema(contract.args),
    output: cliDataSchemas[command],
    limits: cliTransportLimits,
  };
};

/**
 * Одна декларация общих операций: описание, `readOnly` (= `!writes`), вход и
 * ответ берутся из договора CLI (`cliCommands`, `cliDataSchemas`) — второй
 * копии текста нет. Из неё строятся каталог `capabilities` и граница CLI.
 */
export const sharedOperations: { readonly [C in SharedOperationName]: SharedOperation<C> } = {
  init: declare('init'),
  explain: declare('explain'),
  'plan-request': declare('plan-request'),
  'plan-check': declare('plan-check'),
  capabilities: declare('capabilities'),
};

export const isSharedOperation = (command: string): command is SharedOperationName =>
  (sharedOperationNames as readonly string[]).includes(command);
