#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  API_VERSION,
  HarnessError,
  cliCommands,
  exitCodeOf,
  exitCodes,
  type CliCommand,
  type CliEnvelope,
} from './contracts/index.ts';
import { HARNESS_VERSION } from './package.ts';
import { validateInputs } from './validate.ts';

const usage = `harness ${HARNESS_VERSION}

Использование: harness <команда> [параметры]

${Object.entries(cliCommands)
  .map(([name, text]) => `  ${name.padEnd(16)} ${text}`)
  .join('\n')}

  validate --graph <файл.json> --policy <файл.json>

stdout — JSON (${API_VERSION}); диагностика — stderr.
Exit codes: 0 успех, 2 неверный вход, 3 отказ/блокировка, 4 инфраструктура.
`;

/** Команды, реализованные в этой версии пакета; остальные объявлены договором. */
const available = new Set<CliCommand>(['validate']);

const readJson = (path: string, what: string): unknown => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new HarnessError(
      'INVALID_INPUT',
      `${what}: файл недоступен: ${(error as Error).message}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HarnessError(
      'INVALID_INPUT',
      `${what}: невалидный JSON: ${(error as Error).message}`,
    );
  }
};

function run(argv: string[]): { command: CliCommand | 'version'; data: unknown } {
  const [name, ...rest] = argv;
  if (name === '--version' || name === 'version')
    return { command: 'version', data: { harness: HARNESS_VERSION, apiVersion: API_VERSION } };
  if (!name || !(name in cliCommands))
    throw new HarnessError(
      'UNSUPPORTED_COMMAND',
      name ? 'Неизвестная команда: ' + name : 'Не указана команда',
    );
  const command = name as CliCommand;
  if (!available.has(command))
    throw new HarnessError(
      'UNSUPPORTED_COMMAND',
      `Команда ${command} не реализована в ${HARNESS_VERSION}`,
    );
  const { values } = parseArgs({
    args: rest,
    options: { graph: { type: 'string' }, policy: { type: 'string' } },
    strict: true,
  });
  if (!values.graph || !values.policy)
    throw new HarnessError('INVALID_INPUT', 'validate требует --graph и --policy');
  return {
    command,
    data: validateInputs({
      graph: readJson(values.graph, 'graph'),
      policy: readJson(values.policy, 'policy'),
    }),
  };
}

const argv = process.argv.slice(2);
if (argv[0] === '--help' || argv[0] === 'help') {
  process.stderr.write(usage);
  process.exit(exitCodes.ok);
}
let envelope: CliEnvelope;
let code: number = exitCodes.ok;
try {
  const { command, data } = run(argv);
  envelope = { apiVersion: API_VERSION, command, ok: true, data };
} catch (error) {
  const known =
    error instanceof HarnessError
      ? error
      : error instanceof TypeError &&
          (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
        ? new HarnessError('INVALID_INPUT', error.message)
        : new HarnessError('INTERNAL', (error as Error)?.message ?? String(error));
  code = exitCodeOf(known);
  const command = argv[0] && argv[0] in cliCommands ? (argv[0] as CliCommand) : null;
  envelope = { apiVersion: API_VERSION, command, ok: false, error: known.toJSON() };
  process.stderr.write(`harness: ${known.code}: ${known.message}\n`);
  for (const issue of known.issues)
    process.stderr.write(`  ${issue.path.join('.')}: ${issue.message}\n`);
}
process.stdout.write(JSON.stringify(envelope) + '\n');
process.exitCode = code;
