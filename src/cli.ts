#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  API_VERSION,
  HarnessError,
  authorSchema,
  cliCommands,
  cliDataSchemas,
  contextSnapshotSchema,
  contractDocumentSchema,
  executionPolicySchema,
  exitCodeOf,
  exitCodes,
  type CliCommand,
  type CliEnvelope,
  type ExecutionPolicy,
} from './contracts/index.ts';
import { HARNESS_VERSION } from './package.ts';
import { validateInputs } from './validate.ts';
import { Harness } from './control/harness.ts';
import { policySourceOf, type PolicySource } from './control/provenance.ts';
import { doctor } from './control/doctor.ts';
import { profilePin, resolveProfile } from './profiles/resolve.ts';
import { cliAdapter } from './agents/cli-adapter.ts';
import { FileContextSource, FileResultSink, FileWorkSource } from './connectors/files.ts';

const usage = `harness ${HARNESS_VERSION}

Использование: harness <команда> [параметры]

${Object.entries(cliCommands)
  .map(
    ([name, c]) =>
      `  ${name.padEnd(16)} ${c.description}\n${' '.repeat(19)}${c.args.map((a) => (a.required ? a.name : `[${a.name}]`)).join(' ')}`,
  )
  .join('\n')}

stdout — JSON (${API_VERSION}); диагностика — stderr.
Exit codes: 0 успех, 2 неверный вход, 3 отказ/блокировка, 4 инфраструктура.
Runtime: codex и claude из PATH; HARNESS_CODEX_BIN / HARNESS_CLAUDE_BIN подменяют исполняемый файл
(например, fixture executable в тестах — это не живая модель).
`;

const readJson = (path: string, what: string): unknown => readJsonFile(path, what).value;
const readJsonFile = (path: string, what: string): { text: string; value: unknown } => {
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
    return { text, value: JSON.parse(text) as unknown };
  } catch (error) {
    throw new HarnessError(
      'INVALID_INPUT',
      `${what}: невалидный JSON: ${(error as Error).message}`,
    );
  }
};

interface Parser<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}
const parseWith = <T>(schema: Parser<T>, value: unknown, what: string): T => {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new HarnessError(
    'INVALID_INPUT',
    `${what}: вход не прошёл проверку схемы`,
    r.error.issues.map((i) => ({
      path: [what, ...(i.path as (string | number)[])],
      message: i.message,
    })),
  );
};

/** Политика и базовый каталог каталога состояния; записываются пишущими командами. */
interface Binding {
  policy: ExecutionPolicy;
  baseDir: string;
  /** Файл, из которого загружена политика: право записать её применённой. */
  source?: PolicySource;
}
const bindingFile = (state: string) => join(state, 'binding.json');

function loadPolicy(path: string): Binding {
  const file = readJsonFile(path, 'policy');
  return {
    policy: parseWith(executionPolicySchema, file.value, 'policy'),
    baseDir: dirname(resolve(path)),
    source: policySourceOf(path, file.text),
  };
}
function binding(state: string, policyPath?: string, write = false): Binding {
  if (policyPath) {
    const b = loadPolicy(policyPath);
    if (write) {
      mkdirSync(state, { recursive: true });
      writeFileSync(
        bindingFile(state),
        JSON.stringify({ policy: b.policy, baseDir: b.baseDir }, null, 2),
      );
    }
    return b;
  }
  if (!existsSync(bindingFile(state)))
    throw new HarnessError(
      'NOT_FOUND',
      'Каталог состояния не найден или не инициализирован: ' + state,
    );
  const file = readJsonFile(bindingFile(state), 'binding');
  const raw = file.value as { policy: unknown; baseDir: string };
  return {
    policy: parseWith(executionPolicySchema, raw.policy, 'policy'),
    baseDir: raw.baseDir,
    source: policySourceOf(bindingFile(state), file.text),
  };
}

function adapters(policy: ExecutionPolicy) {
  const bin = (runtime: 'codex' | 'claude') => process.env[`HARNESS_${runtime.toUpperCase()}_BIN`];
  return {
    codex: cliAdapter('codex', {
      toolProfiles: policy.toolProfiles,
      ...(bin('codex') ? { executable: bin('codex')! } : {}),
    }),
    claude: cliAdapter('claude', {
      toolProfiles: policy.toolProfiles,
      ...(bin('claude') ? { executable: bin('claude')! } : {}),
    }),
  };
}

const open = (state: string, b: Binding, readOnly: boolean) =>
  Harness.open({
    stateDir: resolve(state),
    policy: b.policy,
    baseDir: b.baseDir,
    adapters: adapters(b.policy),
    readOnly,
    ...(b.source ? { policySource: b.source } : {}),
  });

/**
 * Получатель-каталог. Текущая редакция поручения читается из файла графа,
 * из которого он зарегистрирован: если там уже другая редакция (или
 * поручения больше нет), старый результат её не закрывает.
 */
const sinkOf = (spec: string | undefined, h: Harness, baseDir: string) => {
  if (!spec) return undefined;
  if (!spec.startsWith('file:'))
    throw new HarnessError('INVALID_INPUT', 'Получатель: ожидается file:<каталог>');
  return new FileResultSink(resolve(spec.slice(5)), async (result) => {
    const graph = h.engine.read((v) => v.graph(result.graphId));
    if (!graph) return undefined;
    const path = resolve(baseDir, graph.graph.source.ref);
    if (!existsSync(path)) return undefined;
    const current = await new FileWorkSource().fetch(path).catch(() => undefined);
    if (!current) return undefined;
    return (
      current.graph.orders.find((o) => o.id === result.workOrderId)?.source.revision ?? 'removed'
    );
  });
};

const options = {
  graph: { type: 'string' },
  policy: { type: 'string' },
  context: { type: 'string' },
  contract: { type: 'string' },
  state: { type: 'string' },
  work: { type: 'string' },
  sink: { type: 'string' },
  reason: { type: 'string' },
  author: { type: 'string' },
  digest: { type: 'string' },
  subject: { type: 'string' },
  after: { type: 'string' },
  limit: { type: 'string' },
  reset: { type: 'boolean' },
  once: { type: 'boolean' },
  profile: { type: 'string' },
  repository: { type: 'string' },
} as const;

async function run(
  argv: string[],
): Promise<{ command: CliCommand | 'version'; data: unknown; code?: number }> {
  const [name, ...rest] = argv;
  if (name === '--version' || name === 'version')
    return { command: 'version', data: { harness: HARNESS_VERSION, apiVersion: API_VERSION } };
  if (!name || !(name in cliCommands))
    throw new HarnessError(
      'UNSUPPORTED_COMMAND',
      name ? 'Неизвестная команда: ' + name : 'Не указана команда',
    );
  const command = name as CliCommand;
  const { values: v } = parseArgs({ args: rest, options, strict: true });
  const need = (key: keyof typeof v) => {
    const value = v[key];
    if (value === undefined || value === '')
      throw new HarnessError('INVALID_INPUT', `${command} требует --${key}`);
    return value as string;
  };
  const context = async (graphPath: string, ids: string[]) =>
    v.context
      ? parseWith(contextSnapshotSchema, readJson(v.context, 'context'), 'context')
      : ids.length
        ? await new FileContextSource(join(dirname(resolve(graphPath)), 'context')).snapshot(ids)
        : undefined;
  const graphAndContext = async () => {
    const { graph } = await new FileWorkSource().fetch(need('graph'));
    const ctx = await context(need('graph'), [...new Set(graph.orders.flatMap((o) => o.context))]);
    return { graph, ctx };
  };
  switch (command) {
    case 'validate':
      return {
        command,
        data: validateInputs({
          graph: readJson(need('graph'), 'graph'),
          policy: readJson(need('policy'), 'policy'),
          ...(v.context ? { context: readJson(v.context, 'context') } : {}),
        }),
      };
    case 'review-plan':
    case 'review-contract': {
      const author = parseWith(authorSchema, need('author'), 'author');
      const b = binding(need('state'), need('policy'), true);
      const h = open(need('state'), b, false);
      try {
        let record;
        if (command === 'review-plan') {
          const { graph, ctx } = await graphAndContext();
          validateInputs({ graph, policy: b.policy, ...(ctx ? { context: ctx } : {}) });
          h.engine.register(graph, { trusted: () => false, reachable: () => true });
          record = await h.review({
            kind: 'plan',
            graph,
            author,
            ...(ctx ? { context: ctx } : {}),
          });
        } else {
          const contract = parseWith(
            contractDocumentSchema,
            readJson(need('contract'), 'contract'),
            'contract',
          );
          record = await h.review({ kind: 'contract', contract, author });
        }
        return { command, data: record, code: record.approved ? 0 : exitCodes.refused };
      } finally {
        h.close();
      }
    }
    case 'approve': {
      const h = open(need('state'), binding(need('state')), false);
      try {
        return { command, data: h.approve(need('subject'), need('digest')) };
      } finally {
        h.close();
      }
    }
    case 'run': {
      const b = binding(need('state'), need('policy'), true);
      const h = open(need('state'), b, false);
      try {
        const { graph, ctx } = await graphAndContext();
        const sink = sinkOf(v.sink, h, b.baseDir);
        const data = await h.run({
          graph,
          author: parseWith(authorSchema, v.author ?? 'external', 'author'),
          ...(ctx ? { context: ctx } : {}),
          ...(sink ? { sink } : {}),
          ...(v.once ? { once: true } : {}),
        });
        const failed = data.works.some((w) => w.status === 'failed' || w.status === 'cancelled');
        return { command, data, code: failed ? exitCodes.refused : exitCodes.ok };
      } finally {
        h.close();
      }
    }
    case 'status':
    case 'events':
    case 'result': {
      const h = open(need('state'), binding(need('state')), true);
      try {
        if (command === 'status') return { command, data: h.status(v.graph) };
        if (command === 'events')
          return { command, data: h.events(Number(v.after ?? 0), Number(v.limit ?? 100)) };
        return { command, data: h.result(need('work')) };
      } finally {
        h.close();
      }
    }
    case 'pause':
    case 'resume':
    case 'cancel':
    case 'retry':
    case 'deliver': {
      const b = binding(need('state'));
      const h = open(need('state'), b, true);
      try {
        if (command === 'pause') return { command, data: h.engine.pause('operator') };
        if (command === 'resume') return { command, data: h.engine.resume() };
        if (command === 'deliver')
          return {
            command,
            data: await h.deliver(need('work'), sinkOf(need('sink'), h, b.baseDir)!),
          };
        const result =
          command === 'cancel'
            ? h.engine.cancel(need('work'), v.reason)
            : h.engine.retry(need('work'), v.reset ? { reason: need('reason') } : undefined);
        return {
          command,
          data: {
            workId: result.work.id,
            status: result.work.status,
            attempt: result.work.attempt,
            changed: result.changed,
          },
        };
      } finally {
        h.close();
      }
    }
    case 'profile': {
      const profile = resolveProfile(need('profile'), {
        ...(v.repository ? { repository: v.repository } : {}),
      });
      return { command, data: { pin: profilePin(profile), profile } };
    }
    case 'doctor': {
      const b = v.policy ? loadPolicy(v.policy) : v.state ? binding(v.state) : undefined;
      return {
        command,
        data: await doctor(
          b?.policy,
          adapters(b?.policy ?? ({ toolProfiles: {} } as ExecutionPolicy)),
          v.state,
        ),
      };
    }
  }
}

const argv = process.argv.slice(2);
if (argv[0] === '--help' || argv[0] === 'help') {
  process.stderr.write(usage);
  process.exit(exitCodes.ok);
}
let envelope: CliEnvelope;
let code: number = exitCodes.ok;
try {
  const result = await run(argv);
  // Ответ проверяется схемой своей команды: CLI не может выдать данные вне договора.
  envelope = {
    apiVersion: API_VERSION,
    command: result.command,
    ok: true,
    data: cliDataSchemas[result.command].parse(result.data),
  };
  code = result.code ?? exitCodes.ok;
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
