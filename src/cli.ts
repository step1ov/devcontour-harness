#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  API_VERSION,
  HarnessError,
  authorSchema,
  cliCommands,
  cliDataSchemas,
  contextSnapshotSchema,
  contractDocumentSchema,
  errorCodes,
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
import { assertToolchainReady, inspectPolicy } from './toolchains/inspect.ts';
import { profilePin, resolveProfile } from './profiles/resolve.ts';
import { cliAdapter } from './agents/cli-adapter.ts';
import { initProject, initText } from './init/project.ts';
import { diagnoseState, explainText } from './explain/diagnose.ts';
import { planCheck, planRequestOf } from './planning/check.ts';
import type { RunnerHooks } from './engine/runner.ts';
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
run: отказ по существу (GATE_FAILED, REVIEW_REJECTED, …) — 3; остановка после исчерпания
повторов reviewer при ошибке протокола его ответа (REVIEW_PROTOCOL_INVALID) — 4.
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

const open = (state: string, b: Binding, readOnly: boolean | 'state', hooks?: RunnerHooks) =>
  Harness.open({
    stateDir: resolve(state),
    policy: b.policy,
    baseDir: b.baseDir,
    adapters: adapters(b.policy),
    readOnly: Boolean(readOnly),
    ...(readOnly === 'state' ? { readOnlyState: true } : {}),
    ...(b.source ? { policySource: b.source } : {}),
    ...(hooks ? { hooks } : {}),
  });

/**
 * Exit code упавшего run: отказ по существу — 3; остановка из-за ошибки
 * протокола ответа reviewer после исчерпания повторов (класс отказа
 * `review-protocol`, код REVIEW_PROTOCOL_INVALID) — инфраструктурный 4.
 */
const runExit = (h: Harness, works: { id: string }[]) =>
  h.engine.read((v) => works.some((w) => v.work(w.id)?.failureKind === 'review-protocol'))
    ? exitCodes[errorCodes.REVIEW_PROTOCOL_INVALID]
    : exitCodes.refused;

/** Result SHA предпосылки доступен в target ref её репозитория (как при регистрации в run). */
const reachableIn = (b: Binding, repositoryId: string, sha: string) => {
  const repo = b.policy.repositories.find((r) => r.id === repositoryId);
  if (!repo) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, repo.targetRef], {
      cwd: resolve(b.baseDir, repo.path),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Коннектор внешнего хранилища задач (opt-in): модуль и адаптер provider
 * загружаются только для команд с `--source`.
 */
const connectorOf = async (path: string, state: string, policy?: ExecutionPolicy) => {
  const { openConnector } = await import('./integrations/connector/commands.ts');
  const { policySecrets } = await import('./integrations/connector/redact.ts');
  // Без явной политики — политика каталога состояния, если он уже инициализирован.
  const known = policy ?? (existsSync(bindingFile(state)) ? binding(state).policy : undefined);
  return openConnector(path, {
    stateDir: resolve(state),
    // Значения секретов политики (на любом уровне) маскируются в диагностике и итогах.
    secrets: policySecrets(known),
  });
};

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
  source: { type: 'string' },
  out: { type: 'string' },
  operation: { type: 'string' },
  decision: { type: 'string' },
  run: { type: 'string' },
  plan: { type: 'boolean' },
  human: { type: 'boolean' },
  writer: { type: 'string' },
  draft: { type: 'string' },
  brief: { type: 'string' },
  basis: { type: 'string' },
  contracts: { type: 'string' },
  requirements: { type: 'string', multiple: true },
} as const;

/** Новые флаги H1 допустимы только у своих команд; прежние команды их не принимают. */
const flagOwners = {
  plan: ['init'],
  writer: ['init'],
  human: ['init', 'explain', 'plan-request'],
  draft: ['plan-check'],
  basis: ['plan-check'],
  brief: ['plan-request', 'plan-check'],
  contracts: ['plan-request', 'plan-check'],
  requirements: ['plan-request'],
} as const;

/** Явное человеческое представление успешного ответа (`--human`). */
const presenters: Partial<Record<CliCommand, (data: never) => string>> = {
  init: initText,
  explain: explainText,
  'plan-request': (data: { prompt: string }) => data.prompt + '\n',
};

/** Поле объекта только при заданном значении (exactOptionalPropertyTypes). */
const optional = <K extends string, T>(key: K, value: T | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, T>>;

/** Каталог ContractDocument JSON: `*.json` по имени, каждый по схеме. */
const contractsIn = (dir: string | undefined) =>
  dir === undefined
    ? undefined
    : readdirSync(resolve(dir))
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => parseWith(contractDocumentSchema, readJson(join(dir, f), f), f));

/**
 * Контекст планирования по умолчанию: каталоги `<каталог политики>/work/context/<id>`
 * (не symlink). Каталога нет — контекста нет.
 */
const planningContext = async (contextPath: string | undefined, baseDir: string) => {
  if (contextPath)
    return parseWith(contextSnapshotSchema, readJson(contextPath, 'context'), 'context');
  const dir = join(baseDir, 'work', 'context');
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return undefined;
  const ids = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return ids.length ? await new FileContextSource(dir).snapshot(ids) : undefined;
};

const readText = (path: string, what: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new HarnessError(
      'INVALID_INPUT',
      `${what}: не прочитан ${path}: ${(error as Error).message}`,
    );
  }
};

async function run(
  argv: string[],
): Promise<{ command: CliCommand | 'version'; data: unknown; code?: number }> {
  const [name, ...rest] = argv;
  if (name === '--version' || name === 'version') {
    // Прочие аргументы version по-прежнему игнорирует; новые флаги — только у своих команд.
    for (const [flag, owners] of Object.entries(flagOwners))
      if (rest.some((arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`)))
        throw new HarnessError('INVALID_INPUT', `--${flag} поддерживают: ${owners.join(', ')}`);
    return { command: 'version', data: { harness: HARNESS_VERSION, apiVersion: API_VERSION } };
  }
  if (!name || !(name in cliCommands))
    throw new HarnessError(
      'UNSUPPORTED_COMMAND',
      name ? 'Неизвестная команда: ' + name : 'Не указана команда',
    );
  const command = name as CliCommand;
  const { values: v } = parseArgs({ args: rest, options, strict: true });
  for (const [flag, owners] of Object.entries(flagOwners))
    if (v[flag as keyof typeof v] !== undefined && !(owners as readonly string[]).includes(command))
      throw new HarnessError('INVALID_INPUT', `--${flag} поддерживают: ${owners.join(', ')}`);
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
          if (v.source) {
            // Источник задан: внешние предпосылки допускаются по тем же правилам,
            // что в run — решение источника `trusts` и доступность SHA в target ref.
            const connector = await connectorOf(v.source, need('state'), b.policy);
            try {
              if (connector.id !== graph.source.connector)
                throw new HarnessError(
                  'INVALID_INPUT',
                  `Граф из источника ${graph.source.connector}, передан источник ${connector.id}`,
                );
              const trusted = new Set<string>();
              for (const p of graph.prerequisites)
                if (p.receipt.kind === 'trusted' && (await connector.source.trusts(p)))
                  trusted.add(p.id);
              h.engine.register(graph, {
                trusted: (p) => trusted.has(p.id),
                reachable: (p) => reachableIn(b, p.repositoryId, p.resultSha),
              });
            } finally {
              connector.close();
            }
          } else h.engine.register(graph, { trusted: () => false, reachable: () => true });
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
      // Обязательный preflight toolchain: проблема — отказ до записи binding,
      // открытия состояния и любого вызова runtime.
      const loaded = loadPolicy(need('policy'));
      await assertToolchainReady(loaded.policy, loaded.baseDir, {
        configSource: resolve(need('policy')),
        protectedRoots: [resolve(need('state'))],
      });
      const b = binding(need('state'), need('policy'), true);
      if (v.source) {
        // Источник — коннектор задач: свежая сверка снимка и eligibility до runtime.
        const connector = await connectorOf(v.source, need('state'), b.policy);
        const h = open(need('state'), b, false, connector.hooks());
        try {
          const data = await connector.run(h, {
            author: parseWith(authorSchema, v.author ?? 'external', 'author'),
            ...(v.once ? { once: true } : {}),
          });
          const failed = data.works.some((w) => w.status === 'failed' || w.status === 'cancelled');
          return { command, data, code: failed ? runExit(h, data.works) : exitCodes.ok };
        } finally {
          h.close();
          connector.close();
        }
      }
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
        return { command, data, code: failed ? runExit(h, data.works) : exitCodes.ok };
      } finally {
        h.close();
      }
    }
    case 'status':
    case 'events':
    case 'result': {
      const h = open(need('state'), binding(need('state')), 'state');
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
    case 'cleanup': {
      // Пишет состояние (истечение прерванной попытки, записи очистки): не только чтение.
      const h = open(need('state'), binding(need('state')), false);
      try {
        return { command, data: await h.cleanup(need('run')) };
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
    case 'source-check': {
      const policyOf = v.policy ? loadPolicy(v.policy).policy : undefined;
      const connector = await connectorOf(need('source'), v.state ?? '.', policyOf);
      try {
        const data = await connector.check(policyOf);
        const ok = data.connected && data.projectMatches && data.problems.length === 0;
        return { command, data, code: ok ? exitCodes.ok : exitCodes.refused };
      } finally {
        connector.close();
      }
    }
    case 'source-snapshot': {
      const connector = await connectorOf(
        need('source'),
        need('state'),
        v.policy ? loadPolicy(v.policy).policy : undefined,
      );
      try {
        const { snapshot, ...data } = await connector.snapshot(v.out);
        void snapshot;
        return { command, data, code: data.eligible ? exitCodes.ok : exitCodes.refused };
      } finally {
        connector.close();
      }
    }
    case 'source-status':
    case 'source-deliver':
    case 'source-reconcile': {
      const state = need('state');
      const b = binding(state);
      const connector = await connectorOf(need('source'), state, b.policy);
      const h = open(state, b, command === 'source-status');
      try {
        if (command === 'source-status') return { command, data: await connector.status(h) };
        if (command === 'source-deliver') {
          const data = await connector.deliver(h, v.work);
          const settled = data.deliveries.every((d) =>
            d.delivery.every((x) => x.status === 'delivered'),
          );
          return { command, data, code: settled ? exitCodes.ok : exitCodes.refused };
        }
        const { Connector } = await import('./integrations/connector/commands.ts');
        const data = await connector.reconcile(
          h,
          need('operation'),
          Connector.decision(v.decision),
        );
        return { command, data, code: data.resolved ? exitCodes.ok : exitCodes.refused };
      } finally {
        h.close();
        connector.close();
      }
    }
    case 'init': {
      if (v.writer !== undefined && v.writer !== 'claude' && v.writer !== 'codex')
        throw new HarnessError('INVALID_INPUT', '--writer: ожидается claude или codex', [
          { path: ['--writer'], message: v.writer },
        ]);
      const data = await initProject({
        repository: need('repository'),
        ...(v.profile ? { profile: v.profile } : {}),
        ...(v.writer ? { writer: v.writer } : {}),
        ...(v.state ? { state: v.state } : {}),
        ...(v.plan ? { plan: true } : {}),
      });
      // План с конфликтами или неготовым toolchain — отказ по существу с данными.
      const blocked = data.mode === 'plan' && (data.conflicts > 0 || !data.toolchain.ready);
      return { command, data, ...(blocked ? { code: exitCodes.refused } : {}) };
    }
    case 'explain': {
      const b = loadPolicy(need('policy'));
      return {
        command,
        data: await diagnoseState({
          stateDir: need('state'),
          policy: b.policy,
          baseDir: b.baseDir,
          ...(v.work ? { workId: v.work } : {}),
          adapters: adapters(b.policy),
        }),
      };
    }
    case 'plan-request': {
      const b = loadPolicy(need('policy'));
      const first = b.policy.repositories[0]?.id ?? 'main';
      return {
        command,
        data: planRequestOf({
          policy: b.policy,
          baseDir: b.baseDir,
          brief: readText(need('brief'), '--brief'),
          ...optional('context', await planningContext(v.context, b.baseDir)),
          ...optional('contracts', contractsIn(v.contracts)),
          requirementSources: (v.requirements ?? []).map((spec) => {
            const at = spec.indexOf(':');
            return at > 0
              ? { repositoryId: spec.slice(0, at), source: spec.slice(at + 1) }
              : { repositoryId: first, source: spec };
          }),
        }),
      };
    }
    case 'plan-check': {
      const b = loadPolicy(need('policy'));
      const draftPath = need('draft');
      if (v.basis !== undefined && v.brief === undefined)
        throw new HarnessError('INVALID_INPUT', 'plan-check: --basis требует --brief', [
          { path: ['--basis'], message: 'requires --brief' },
        ]);
      const graphId = basename(draftPath).replace(/(\.draft)?\.json$/, '');
      const data = planCheck({
        policy: b.policy,
        baseDir: b.baseDir,
        draft: readJson(draftPath, 'draft'),
        graphId,
        ...optional('context', await planningContext(v.context, b.baseDir)),
        ...optional('contracts', contractsIn(v.contracts)),
        ...optional('brief', v.brief === undefined ? undefined : readText(v.brief, '--brief')),
        ...optional('basis', v.basis),
      });
      // Ответ с проблемами — данные; exit по классу первой проблемы.
      const first = data.issues[0];
      return { command, data, ...(first ? { code: exitCodes[errorCodes[first.code]] } : {}) };
    }
    case 'doctor': {
      const b = v.policy ? loadPolicy(v.policy) : v.state ? binding(v.state) : undefined;
      return {
        command,
        data: await doctor(
          b?.policy,
          adapters(b?.policy ?? ({ toolProfiles: {} } as ExecutionPolicy)),
          v.state,
          b
            ? {
                baseDir: b.baseDir,
                inspect: (policy, baseDir) =>
                  inspectPolicy(policy, baseDir, {
                    configSource: v.policy ? resolve(v.policy) : bindingFile(v.state!),
                    ...(v.state ? { protectedRoots: [resolve(v.state)] } : {}),
                  }),
              }
            : undefined,
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
let text: string | undefined;
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
  const present = result.command !== 'version' ? presenters[result.command] : undefined;
  if (present && argv.includes('--human')) text = present(envelope.data as never);
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
process.stdout.write(text ?? JSON.stringify(envelope) + '\n');
process.exitCode = code;
