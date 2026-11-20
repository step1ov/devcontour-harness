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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  API_VERSION,
  HarnessError,
  authorSchema,
  reviewDispositionSchema,
  type ReviewDisposition,
  cliCommands,
  cliDataSchemas,
  contractViolation,
  contextSnapshotSchema,
  contractDocumentSchema,
  digestSchema,
  errorCodes,
  executionPolicySchema,
  exitCodeOf,
  exitCodes,
  projectManifestSchema,
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
import { leadSandboxCheck } from './environment/lead-sandbox.ts';
import { leanMismatch, leanText, switchLean } from './init/lean.ts';
import { diagnoseState, explainText } from './explain/diagnose.ts';
import { statusFrame, statusSettled, statusText } from './control/status.ts';
import { planCheck, planRequestOf } from './planning/check.ts';
import { checkJsonBytes } from './catalog/bytes.ts';
import { isSharedOperation, sharedOperations } from './catalog/shared.ts';
import { harnessCapabilities } from './catalog/harness.ts';
import type { RunnerHooks } from './engine/runner.ts';
import { hostGitArgs } from './environment/process.ts';
import { FileContextSource, FileResultSink, FileWorkSource } from './connectors/files.ts';
import { SqliteExecutionStore } from './storage/sqlite.ts';
import { collectReportInput } from './control/report.ts';
import { harnessView } from './control/operator-view.ts';
import { OPERATOR_VIEW_VERSION } from './contracts/operator-view-limits.ts';
import { reportTargets } from './control/target.ts';
import { writeReportFile } from './control/report-file.ts';
import { valueReport, reportHtml, reportMarkdown } from './report/index.ts';
import { handoffMarkdown, handoffPack } from './handoff/index.ts';
import { inputStateOf } from './projections/input.ts';
import { checkGates, gatesText } from './control/gates-check.ts';
import { smokeLifecycle, smokeText } from './control/lifecycle-smoke.ts';
import { defaultResourceDatabase } from './environment/resources.ts';

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
    execFileSync(
      'git',
      hostGitArgs(resolve(b.baseDir, repo.path), [
        'merge-base',
        '--is-ancestor',
        sha,
        repo.targetRef,
      ]),
      {
        cwd: resolve(b.baseDir, repo.path),
        stdio: 'ignore',
      },
    );
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

/** Строки прогноза выпуска для `status --human`; представление недоступно — без них. */
const forecastLines = (state: string): string | undefined => {
  try {
    const view = harnessView({ stateDir: state }) as {
      forecast?: { progress: { line: string }; time: { line: string } };
    };
    const f = view.forecast;
    return f ? `Прогноз выпуска: ${f.progress.line}; ${f.time.line}.\n` : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Сверка Relay для `doctor`/`init`: явный `--source` или найденный файл
 * связки. Нет ни того, ни другого — `undefined` (связка не настроена).
 */
const relayCheck = async (
  explicit: string | undefined,
  candidate: string | undefined,
  state?: string,
) => {
  const file = explicit ?? (candidate && existsSync(candidate) ? candidate : undefined);
  if (!file) return undefined;
  const { relayCompatibilityCheck } = await import('./integrations/connector/commands.ts');
  return relayCompatibilityCheck(file, { stateDir: resolve(state ?? '.') });
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
  by: { type: 'string' },
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
  lean: { type: 'boolean' },
  off: { type: 'boolean' },
  human: { type: 'boolean' },
  writer: { type: 'string' },
  lead: { type: 'string' },
  review: { type: 'string' },
  model: { type: 'string' },
  draft: { type: 'string' },
  brief: { type: 'string' },
  basis: { type: 'string' },
  contracts: { type: 'string' },
  requirements: { type: 'string', multiple: true },
  'dry-run': { type: 'boolean' },
  detail: { type: 'boolean' },
  since: { type: 'string' },
  until: { type: 'string' },
  'as-of': { type: 'string' },
  format: { type: 'string' },
  'no-titles': { type: 'boolean' },
  intent: { type: 'string', multiple: true },
  request: { type: 'string' },
  text: { type: 'string' },
  option: { type: 'string' },
  kind: { type: 'string' },
  actor: { type: 'string' },
  'request-version': { type: 'string' },
  'context-digest': { type: 'string' },
  answer: { type: 'string' },
  target: { type: 'string' },
  successor: { type: 'string' },
  sha: { type: 'string' },
  gate: { type: 'string' },
  'fail-fast': { type: 'boolean' },
  'writer-probe': { type: 'boolean' },
  'accept-limitation': { type: 'string', multiple: true },
  'continue-review': { type: 'string', multiple: true },
  watch: { type: 'boolean' },
  'lead-technical-answers': { type: 'boolean' },
  interval: { type: 'string' },
  base: { type: 'string' },
  head: { type: 'string' },
  role: { type: 'string' },
  window: { type: 'string' },
  bucket: { type: 'string' },
  lang: { type: 'string' },
  'view-version': { type: 'string' },
} as const;

/** Новые флаги H1 допустимы только у своих команд; прежние команды их не принимают. */
const flagOwners = {
  plan: ['init', 'lean'],
  'lead-technical-answers': ['init'],
  lean: ['init'],
  off: ['lean'],
  writer: ['init'],
  lead: ['init'],
  review: ['init'],
  model: ['init'],
  human: ['init', 'lean', 'status', 'explain', 'plan-request', 'gates', 'smoke'],
  draft: ['plan-check'],
  basis: ['plan-check'],
  brief: ['plan-request', 'plan-check'],
  contracts: ['plan-request', 'plan-check'],
  requirements: ['plan-request'],
  'dry-run': ['worktree-cleanup'],
  detail: ['status'],
  since: ['report'],
  until: ['report'],
  'as-of': ['report'],
  format: ['report', 'handoff'],
  'no-titles': ['report', 'view'],
  window: ['view'],
  bucket: ['view'],
  lang: ['view'],
  'view-version': ['view'],
  intent: ['handoff'],
  request: [
    'input-show',
    'input-answer',
    'input-context',
    'input-target',
    'input-apply',
    'input-cancel',
    'input-supersede',
  ],
  text: ['input-answer'],
  option: ['input-answer'],
  kind: ['input-answer'],
  actor: ['input-answer', 'review-plan', 'review-contract'],
  by: ['reapprove'],
  'accept-limitation': ['review-plan', 'review-contract'],
  'continue-review': ['review-plan', 'review-contract'],
  'request-version': ['input-answer', 'input-apply', 'input-cancel', 'input-supersede'],
  'context-digest': ['input-target', 'input-apply'],
  answer: ['input-apply'],
  target: ['input-apply'],
  successor: ['input-supersede'],
  sha: ['gates', 'smoke'],
  gate: ['gates'],
  'fail-fast': ['gates'],
  'writer-probe': ['smoke'],
  watch: ['status'],
  interval: ['status'],
  base: ['review-code'],
  head: ['review-code'],
  role: ['review-code'],
} as const;

/** Явное человеческое представление успешного ответа (`--human`). */
const presenters: Partial<Record<CliCommand, (data: never) => string>> = {
  init: initText,
  lean: leanText,
  status: statusText,
  explain: explainText,
  'plan-request': (data: { prompt: string }) => data.prompt + '\n',
  gates: gatesText,
  smoke: smokeText,
};

/**
 * Ведущий проекта из manifest рядом с политикой (`.harness/project.json`);
 * нет файла, поля или файл не по схеме — undefined (doctor берёт writers ролей).
 */
const manifestLead = (policyPath: string): ['claude' | 'codex'] | undefined => {
  try {
    const parsed = projectManifestSchema.safeParse(
      JSON.parse(readFileSync(join(dirname(resolve(policyPath)), 'project.json'), 'utf8')),
    );
    return parsed.success && parsed.data.lead ? [parsed.data.lead] : undefined;
  } catch {
    return undefined;
  }
};

/** Поле объекта только при заданном значении (exactOptionalPropertyTypes). */
const optional = <K extends string, T>(key: K, value: T | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, T>>;

/** Каталог ContractDocument JSON: `*.json` по имени, каждый по схеме. */
const contractsIn = (dir: string | undefined) => {
  if (dir === undefined) return undefined;
  let names: string[];
  try {
    names = readdirSync(resolve(dir));
  } catch (error) {
    throw new HarnessError(
      'INVALID_INPUT',
      `--contracts: каталог не прочитан ${dir}: ${(error as Error).message}`,
      [{ path: ['--contracts'], message: dir }],
    );
  }
  return names
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => parseWith(contractDocumentSchema, readJson(join(dir, f), f), f));
};

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

const reportFormats = ['json', 'md', 'html'] as const;

/**
 * Решения по находкам из флагов review-plan / review-contract: ID — списком
 * через запятую или повтором флага; основание обязательно, решающий — lead
 * (по умолчанию) или operator.
 */
function reviewDispositionsOf(v: {
  'accept-limitation'?: string[];
  'continue-review'?: string[];
  reason?: string;
  actor?: string;
}): ReviewDisposition[] {
  const ids = (list?: string[]) =>
    (list ?? [])
      .flatMap((x) => x.split(','))
      .map((x) => x.trim())
      .filter(Boolean);
  const accept = ids(v['accept-limitation']);
  const proceed = ids(v['continue-review']);
  if (!accept.length && !proceed.length) {
    if (v.actor !== undefined)
      throw new HarnessError(
        'INVALID_INPUT',
        '--actor задаёт решающего: нужны --accept-limitation или --continue-review',
      );
    return [];
  }
  const by = v.actor ?? 'lead';
  if (by !== 'lead' && by !== 'operator')
    throw new HarnessError('INVALID_INPUT', '--actor: ожидается lead или operator', [
      { path: ['--actor'], message: by },
    ]);
  return [
    ...accept.map((finding) => ({ finding, decision: 'accepted-limitation' as const })),
    ...proceed.map((finding) => ({ finding, decision: 'continue' as const })),
  ].map((d) =>
    parseWith(reviewDispositionSchema, { ...d, by, reason: v.reason ?? '' }, 'disposition'),
  );
}

/**
 * `status --human --watch [--interval S]`: кадр `statusFrame` каждые S секунд
 * (по умолчанию 5, от 1 до 3600) до того, как доска успокоится
 * (`statusSettled`), или до Ctrl-C (SIGINT, SIGTERM). Каждый кадр — новое
 * чтение только для чтения; на терминале кадр заменяет прежний. Последний
 * кадр печатает основной вывод, данные — последний снимок status.
 */
async function watchStatus(
  state: string,
  v: { watch?: boolean; human?: boolean; interval?: string; graph?: string },
): Promise<{ data: unknown; text: string }> {
  if (!v.watch) throw new HarnessError('INVALID_INPUT', '--interval — только вместе с --watch');
  if (!v.human)
    throw new HarnessError(
      'INVALID_INPUT',
      '--watch — только вместе с --human (текст для человека)',
    );
  const seconds = v.interval === undefined ? 5 : Number(v.interval);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
    throw new HarnessError('INVALID_INPUT', '--interval: целое число секунд от 1 до 3600', [
      { path: ['--interval'], message: String(v.interval) },
    ]);
  const intervalMs = seconds * 1000;
  let wake: (() => void) | undefined;
  let stopped = false;
  const onSignal = () => {
    stopped = true;
    wake?.();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const clear = process.stdout.isTTY === true ? '\x1b[H\x1b[2J' : '';
  try {
    for (;;) {
      // Привязка — заново на каждый кадр: применённая новая политика меняет
      // пределы, блокировки и диагнозы.
      const h = open(state, binding(state), 'state');
      let snapshot: { data: z.output<typeof cliDataSchemas.status>; liveJobs: number };
      const now = Date.now();
      try {
        // Статус и задания графов — одним снимком (вложенное чтение SQLite
        // берёт внешний): иначе восстановление группы между двумя чтениями
        // выглядит как успокоившаяся доска. detail — для свежести владения
        // идущих попыток (`statusSettled`).
        snapshot = h.engine.read(() => ({
          data: cliDataSchemas.status.parse(h.status(v.graph, { detail: true })),
          liveJobs: h.workflows
            .list()
            .filter(
              (j) =>
                j.status === 'running' &&
                (j.leaseUntil ?? 0) > now &&
                (!v.graph || j.kind !== 'graph' || j.id === v.graph),
            ).length,
        }));
      } finally {
        h.close();
      }
      const { data, liveJobs } = snapshot;
      const frame = statusFrame(data, now, intervalMs);
      if (stopped || statusSettled(data, now, { liveJobs })) return { data, text: clear + frame };
      process.stdout.write(clear + frame + (clear ? '' : '\n'));
      await new Promise<void>((done) => {
        const timer = setTimeout(done, intervalMs);
        wake = () => {
          clearTimeout(timer);
          done();
        };
      });
      wake = undefined;
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function run(
  argv: string[],
): Promise<{ command: CliCommand | 'version'; data: unknown; code?: number; text?: string }> {
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
  if (isSharedOperation(command)) {
    // Транспортная граница общей операции: значения аргументов в UTF-8 байтах.
    const limit = sharedOperations[command].limits.maxInputBytes;
    const { bytes, within } = checkJsonBytes(v, limit);
    if (!within)
      throw new HarnessError(
        'INVALID_INPUT',
        `Аргументы ${command}: ${bytes} байт UTF-8 больше предела ${limit}`,
        [{ path: ['argv'], message: `${bytes} > ${limit}` }],
      );
  }
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
      const dispositions = reviewDispositionsOf(v);
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
              connector.assertBaselineProtected(b.policy, b.baseDir);
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
            ...(dispositions.length ? { dispositions } : {}),
          });
        } else {
          const contract = parseWith(
            contractDocumentSchema,
            readJson(need('contract'), 'contract'),
            'contract',
          );
          record = await h.review({
            kind: 'contract',
            contract,
            author,
            ...(dispositions.length ? { dispositions } : {}),
          });
        }
        return { command, data: record, code: record.approved ? 0 : exitCodes.refused };
      } finally {
        h.close();
      }
    }
    case 'reapprove': {
      const by = need('by').trim();
      const reason = need('reason').trim();
      if (!by || by.length > 200)
        throw new HarnessError('INVALID_INPUT', '--by: от 1 до 200 знаков', [
          { path: ['--by'], message: by },
        ]);
      if (reason.length < 3 || reason.length > 2000)
        throw new HarnessError('INVALID_INPUT', '--reason: от 3 до 2000 знаков', [
          { path: ['--reason'], message: reason },
        ]);
      const h = open(need('state'), binding(need('state'), need('policy'), true), false);
      try {
        return {
          command,
          data: h.reapprove(need('subject'), need('digest'), { by, reason }),
        };
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
      if (command === 'status' && (v.watch || v.interval !== undefined))
        return { command, ...(await watchStatus(need('state'), v)) };
      const h = open(need('state'), binding(need('state')), 'state');
      try {
        if (command === 'status') {
          const data = h.status(v.graph, { detail: Boolean(v.detail) });
          if (!v.human) return { command, data };
          // Прогноз выпуска — та же строка, что у панели (`view.forecast`).
          const forecast = forecastLines(need('state'));
          return {
            command,
            data,
            ...(forecast ? { text: statusText(data) + forecast } : {}),
          };
        }
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
            ? h.engine.cancel(need('work'), v.reason, 'operator')
            : h.engine.retry(
                need('work'),
                v.reset ? { reason: need('reason') } : undefined,
                'operator',
              );
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
    case 'worktree-cleanup': {
      const dryRun = !!v['dry-run'];
      const h = open(need('state'), binding(need('state')), dryRun ? 'state' : false);
      try {
        const data = await h.cleanupWorktrees({ dryRun });
        return { command, data, ...(data.failed ? { code: 4 } : {}) };
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
      const loaded = v.policy ? loadPolicy(v.policy) : undefined;
      const connector = await connectorOf(need('source'), v.state ?? '.', loaded?.policy);
      try {
        const data = await connector.check(loaded?.policy, loaded?.baseDir);
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
      const runtimeFlag = (flag: 'writer' | 'lead') => {
        const value = v[flag];
        if (value !== undefined && value !== 'claude' && value !== 'codex')
          throw new HarnessError('INVALID_INPUT', `--${flag}: ожидается claude или codex`, [
            { path: ['--' + flag], message: value },
          ]);
        return value;
      };
      const writer = runtimeFlag('writer');
      const lead = runtimeFlag('lead');
      if (v.review !== undefined && !['cross', 'same', 'auto'].includes(v.review))
        throw new HarnessError('INVALID_INPUT', '--review: ожидается cross, same или auto', [
          { path: ['--review'], message: v.review },
        ]);
      if (v.model !== undefined && (!v.model.trim() || v.model.length > 200))
        throw new HarnessError('INVALID_INPUT', '--model: ожидается имя модели до 200 символов', [
          { path: ['--model'], message: v.model },
        ]);
      const data = await initProject({
        repository: need('repository'),
        ...(v.profile ? { profile: v.profile } : {}),
        ...(lead ? { lead } : {}),
        ...(writer ? { writer } : {}),
        ...(v.review ? { review: v.review as 'cross' | 'same' | 'auto' } : {}),
        ...(v.model ? { model: v.model } : {}),
        ...(v.state ? { state: v.state } : {}),
        ...(v.plan ? { plan: true } : {}),
        ...(v.lean ? { lean: true } : {}),
        ...(v['lead-technical-answers'] ? { leadTechnicalAnswers: true } : {}),
      });
      // Ведущий внутри песочницы (Codex seatbelt): предупреждение с флагами запуска.
      const sandboxed = leadSandboxCheck({
        repositories: [resolve(need('repository'))],
        ...(v.state ? { stateDir: v.state } : {}),
      });
      if (sandboxed.inside) data.warnings.push({ code: 'lead-sandbox', message: sandboxed.advice });
      // Связка с Relay уже настроена (или указана): версия Relay ниже рекомендуемой — предупреждение.
      const relay = await relayCheck(
        v.source,
        join(resolve(need('repository')), '.harness', 'connector.json'),
        v.state,
      );
      if (relay?.warning)
        data.warnings.push({ code: 'relay-compatibility', message: relay.warning });
      // План с конфликтами или неготовым toolchain — отказ по существу с данными.
      const blocked = data.mode === 'plan' && (data.conflicts > 0 || !data.toolchain.ready);
      return { command, data, ...(blocked ? { code: exitCodes.refused } : {}) };
    }
    case 'lean': {
      const data = await switchLean({
        repository: need('repository'),
        ...(v.off ? { off: true } : {}),
        ...(v.plan ? { plan: true } : {}),
        ...(v.state ? { state: v.state } : {}),
      });
      // План с проблемами — отказ по существу с данными (как init --plan).
      return { command, data, ...(data.problems.length ? { code: exitCodes.refused } : {}) };
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
    case 'report': {
      const state = need('state');
      const format = (v.format ?? 'json') as (typeof reportFormats)[number];
      if (!reportFormats.includes(format))
        throw new HarnessError('INVALID_INPUT', '--format: ожидается json, md или html', [
          { path: ['--format'], message: String(v.format) },
        ]);
      const file = join(resolve(state), 'state.sqlite');
      if (!existsSync(file))
        throw new HarnessError('NOT_FOUND', 'Каталог состояния не найден: ' + state);
      // Однократное чтение без записи и без файлов в каталоге состояния
      // (неизменяемое открытие с проверкой после чтения, `readOnce`).
      // Политика каталога состояния (если есть): по ней принятые поручения
      // сверяются с текущими target ref. Нет политики — отчёт без сверки.
      // Нет `binding.json` — отчёт без сверки; испорченный — отказ, а не тихий пропуск.
      const bound = existsSync(bindingFile(state)) ? binding(state) : undefined;
      const report = SqliteExecutionStore.readOnce(
        file,
        'devcontour-harness@' + HARNESS_VERSION,
        (store) => {
          const input = collectReportInput(store);
          const value = valueReport(input, {
            ...optional('since', v.since),
            ...optional('until', v.until),
            ...optional('asOf', v['as-of']),
            ...(v['no-titles'] ? { noTitles: true } : {}),
            label: basename(resolve(state)),
            stateDir: resolve(state),
            harnessVersion: HARNESS_VERSION,
          });
          if (!bound) return value;
          const b = bound;
          return {
            ...value,
            targets: reportTargets(
              b.policy,
              (p) => (isAbsolute(p) ? p : resolve(b.baseDir, p)),
              input.works,
            ),
          };
        },
      );
      if (format === 'json' && !v.out) return { command, data: report };
      const text =
        format === 'json'
          ? JSON.stringify(report, null, 2) + '\n'
          : format === 'md'
            ? reportMarkdown(report)
            : reportHtml(report);
      if (!v.out) return { command, data: report, text };
      writeReportFile(v.out, state, text);
      return {
        command,
        data: { out: v.out, format, bytes: Buffer.byteLength(text), asOf: report.window.asOf },
      };
    }
    case 'handoff': {
      const format = v.format ?? 'json';
      if (format !== 'json' && format !== 'md')
        throw new HarnessError('INVALID_INPUT', '--format: для handoff ожидается json или md', [
          { path: ['--format'], message: format },
        ]);
      const h = open(need('state'), binding(need('state')), 'state');
      try {
        const data = handoffPack(h, {
          ...optional('graphId', v.graph),
          ...optional('intentions', v.intent),
        });
        // JSON-конверт по умолчанию; --format md — текст, как у report. Отказ — JSON.
        return { command, data, ...(format === 'md' ? { text: handoffMarkdown(data) } : {}) };
      } finally {
        h.close();
      }
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
    case 'view': {
      // Окно и интервал истории: Nm, Nh или Nd.
      const duration = (value: string | undefined, flag: string) => {
        if (value === undefined) return undefined;
        const m = /^(\d{1,4})(m|h|d)$/.exec(value);
        if (!m)
          throw new HarnessError(
            'INVALID_INPUT',
            `--${flag}: ожидается Nm, Nh или Nd (например 24h, 7d, 15m)`,
            [{ path: ['--' + flag], message: value }],
          );
        return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
      };
      if (v['view-version'] !== undefined && v['view-version'] !== String(OPERATOR_VIEW_VERSION))
        throw new HarnessError(
          'INVALID_INPUT',
          `--view-version: поддерживается ${OPERATOR_VIEW_VERSION}`,
          [{ path: ['--view-version'], message: String(v['view-version']) }],
        );
      if (v.lang !== undefined && v.lang !== 'ru' && v.lang !== 'en')
        throw new HarnessError('INVALID_INPUT', '--lang: ожидается ru или en', [
          { path: ['--lang'], message: v.lang },
        ]);
      const windowMs = duration(v.window, 'window');
      const bucketMs = duration(v.bucket, 'bucket');
      return {
        command,
        data: harnessView({
          stateDir: need('state'),
          ...optional('policyPath', v.policy),
          ...optional('workId', v.work),
          ...(v['no-titles'] ? { titles: false } : {}),
          ...optional('windowMs', windowMs),
          ...optional('bucketMs', bucketMs),
          ...(v.lang === 'ru' || v.lang === 'en' ? { lang: v.lang } : {}),
        }),
      };
    }
    case 'capabilities':
      return { command, data: harnessCapabilities() };
    case 'gates': {
      const state = need('state');
      const b = v.policy ? loadPolicy(v.policy) : binding(state);
      const gates = v.gate
        ?.split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      if (v.gate !== undefined && !gates?.length)
        throw new HarnessError('INVALID_INPUT', 'gates: --gate без имён gates', [
          { path: ['--gate'], message: v.gate },
        ]);
      // Прерывание (Ctrl-C, SIGTERM) останавливает gates, и рабочее дерево проверки убирается.
      const abort = new AbortController();
      const stop = () => abort.abort(new Error('Проверка прервана сигналом'));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        const data = await checkGates({
          policy: b.policy,
          baseDir: b.baseDir,
          stateDir: state,
          rev: need('sha'),
          ...optional('repositoryId', v.repository),
          ...optional('gates', gates),
          failFast: Boolean(v['fail-fast']),
          signal: abort.signal,
          resourceDatabase: defaultResourceDatabase(),
          // Ход проверки — диагностика в stderr: stdout остаётся одним JSON.
          onEvidence: (e) =>
            process.stderr.write(`harness gates: ${e.gate} ${e.passed ? 'passed' : 'failed'}\n`),
        });
        // Прерывание — отказ CANCELLED; исход каждого gate — в issues.
        if (data.interrupted)
          throw new HarnessError(
            'CANCELLED',
            'Проверка gates прервана: ' + data.interrupted,
            data.gates.map((g) => ({
              path: ['gates', g.gate],
              message: g.status + (g.message ? ': ' + g.message : ''),
            })),
          );
        // Провал gate — данные проверки и exit 3 (GATE_FAILED), как ответ plan-check с проблемами.
        return {
          command,
          data,
          ...(data.passed ? {} : { code: exitCodes[errorCodes.GATE_FAILED] }),
        };
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
    }
    case 'review-code': {
      const state = need('state');
      const author = v.author ? parseWith(authorSchema, v.author, 'author') : undefined;
      const b = v.policy ? binding(state, v.policy, true) : binding(state);
      const h = open(state, b, false);
      // Прерывание (Ctrl-C, SIGTERM) останавливает reviewer, и рабочее дерево обзора убирается.
      const abort = new AbortController();
      const stop = () => abort.abort(new Error('Обзор прерван сигналом'));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        const record = await h.reviewCode({
          base: need('base'),
          head: need('head'),
          ...optional('role', v.role),
          ...optional('author', author),
          ...optional('repositoryId', v.repository),
          signal: AbortSignal.any([
            abort.signal,
            AbortSignal.timeout(b.policy.runTimeoutMs + 5000),
          ]),
        });
        return { command, data: record, code: record.approved ? 0 : exitCodes.refused };
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        h.close();
      }
    }
    case 'smoke': {
      const state = need('state');
      const b = v.policy ? loadPolicy(v.policy) : binding(state);
      const abort = new AbortController();
      const stop = () => abort.abort(new Error('Проверка прервана сигналом'));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        const data = await smokeLifecycle({
          policy: b.policy,
          baseDir: b.baseDir,
          stateDir: state,
          rev: need('sha'),
          ...optional('repositoryId', v.repository),
          signal: abort.signal,
          resourceDatabase: defaultResourceDatabase(),
          ...(v['writer-probe']
            ? {
                writerProbe: true,
                executables: {
                  ...optional('codex', process.env.HARNESS_CODEX_BIN || undefined),
                  ...optional('claude', process.env.HARNESS_CLAUDE_BIN || undefined),
                },
              }
            : {}),
          // Ход — диагностика в stderr: stdout остаётся одним JSON.
          onStep: (s) =>
            process.stderr.write(
              `harness smoke: ${s.stage}/${s.id} ${s.status} ${Math.round(s.durationMs / 1000)} с\n`,
            ),
        });
        // Отказ окружения — данные и exit 4 (LIFECYCLE_FAILED).
        return {
          command,
          data,
          ...(data.passed && (data.writerProbe?.ok ?? true)
            ? {}
            : { code: exitCodes[errorCodes.LIFECYCLE_FAILED] }),
        };
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
    }
    case 'doctor': {
      const b = v.policy ? loadPolicy(v.policy) : v.state ? binding(v.state) : undefined;
      const report = await doctor(
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
        b && v.state ? { baseDir: b.baseDir } : undefined,
        {
          ...optional('planAuthors', v.policy ? manifestLead(v.policy) : undefined),
          leadSandbox: true,
        },
      );
      // Manifest проекта рядом с политикой расходится с ней по слою lean — предупреждение.
      const mismatch = v.policy ? leanMismatch(resolve(v.policy)) : [];
      if (mismatch.length) report.warnings = [...(report.warnings ?? []), ...mismatch];
      // Связка с Relay: --source или connector.json рядом с политикой.
      const relay = await relayCheck(
        v.source,
        v.policy ? join(dirname(resolve(v.policy)), 'connector.json') : undefined,
        v.state,
      );
      if (!relay) return { command, data: report };
      if (relay.warning)
        report.warnings = [...(report.warnings ?? []), `RELAY_COMPATIBILITY: ${relay.warning}`];
      return {
        command,
        data: {
          ...report,
          relay: {
            source: relay.source,
            ...(relay.compatibility ? { compatibility: relay.compatibility } : {}),
            ...(relay.code ? { code: relay.code } : {}),
            ...(relay.error ? { error: relay.error } : {}),
          },
        },
      };
    }
    case 'input-list':
    case 'input-show':
    case 'input-target': {
      const h = open(need('state'), binding(need('state')), 'state');
      try {
        if (command === 'input-show') return { command, data: h.inputRequest(need('request')) };
        if (command === 'input-target') {
          const { request, target, problems } = h.proposeTarget(
            need('request'),
            parseWith(digestSchema, need('context-digest'), 'context-digest'),
          );
          return {
            command,
            data: { requestId: request.id, ...optional('target', target), problems },
          };
        }
        return {
          command,
          data: {
            requests: h.inputRequests(v.work ? { workId: v.work } : {}).map((r) => ({
              id: r.id,
              workId: r.workId,
              kind: r.kind,
              blocking: r.blocking,
              lifecycle: r.lifecycle,
              ...optional('state', inputStateOf(r)),
              severity: r.effectiveSeverity,
              version: r.version,
              answers: r.answers.length,
              createdAt: r.createdAt,
            })),
          },
        };
      } finally {
        h.close();
      }
    }
    case 'input-answer':
    case 'input-context':
    case 'input-apply':
    case 'input-cancel':
    case 'input-supersede': {
      const b = binding(need('state'));
      const h = open(need('state'), b, false);
      const version = () => {
        const n = Number(need('request-version'));
        if (!Number.isSafeInteger(n) || n < 1)
          throw new HarnessError('INVALID_INPUT', '--request-version: целое ≥ 1');
        return n;
      };
      try {
        const id = need('request');
        if (command === 'input-answer') {
          const kind = parseWith(
            z.enum(['clarification', 'requirement-change']),
            v.kind ?? 'clarification',
            'kind',
          );
          const actor = parseWith(z.enum(['operator', 'lead']), v.actor ?? 'operator', 'actor');
          return {
            command,
            data: h.answerInput(
              id,
              {
                text: need('text'),
                ...optional('optionId', v.option),
                kind,
                actor: { kind: actor },
                ...optional('reason', v.reason),
              },
              version(),
            ),
          };
        }
        if (command === 'input-context') {
          const out = resolve(need('out'));
          const { requestId, answerDigest, digest, snapshot } = h.inputContext(id);
          writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
          return { command, data: { requestId, answerDigest, digest, out } };
        }
        if (command === 'input-apply') {
          const result = h.applyInput(id, {
            answerDigest: parseWith(digestSchema, need('answer'), 'answer'),
            expectedVersion: version(),
            contextDigest: parseWith(digestSchema, need('context-digest'), 'context-digest'),
            targetDigest: parseWith(digestSchema, need('target'), 'target'),
            actor: b.policy.approvalMode,
            ...(v.reset ? { reset: { reason: need('reason') } } : {}),
          });
          return {
            command,
            data: {
              requestId: id,
              applied: result.applied,
              changed: result.changed,
              lifecycle: result.request.lifecycle,
              ...('work' in result && result.work
                ? {
                    work: {
                      id: result.work.id,
                      status: result.work.status,
                      attempt: result.work.attempt,
                    },
                  }
                : {}),
              ...('active' in result && result.active ? { active: result.active } : {}),
              ...('joint' in result && result.joint ? { joint: true as const } : {}),
              ...('blocker' in result && result.blocker ? { blocker: result.blocker } : {}),
            },
            ...(result.applied ? {} : { code: exitCodes.refused }),
          };
        }
        const closed =
          command === 'input-cancel'
            ? h.cancelInput(id, { by: 'operator', reason: need('reason') }, version())
            : h.supersedeInput(
                id,
                { by: 'operator', reason: need('reason'), successor: need('successor') },
                version(),
              );
        return {
          command,
          data: {
            requestId: id,
            lifecycle: closed.request.lifecycle,
            version: closed.request.version,
            changed: closed.changed,
          },
        };
      } finally {
        h.close();
      }
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
  // report --format md|html: проверенные данные печатаются текстом, без конверта.
  if (result.text !== undefined) text = result.text;
} catch (error) {
  const known =
    error instanceof HarnessError
      ? error
      : error instanceof TypeError &&
          (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
        ? new HarnessError('INVALID_INPUT', error.message)
        : error instanceof z.ZodError
          ? contractViolation(error)
          : new HarnessError('INTERNAL', (error as Error)?.message ?? String(error));
  code = exitCodeOf(known);
  const command = argv[0] && argv[0] in cliCommands ? (argv[0] as CliCommand) : null;
  envelope = { apiVersion: API_VERSION, command, ok: false, error: known.toJSON() };
  process.stderr.write(`harness: ${known.code}: ${known.message}\n`);
  for (const issue of known.issues)
    process.stderr.write(`  ${issue.path.join('.')}: ${issue.message}\n`);
}
// Ответ общей операции сверх предела транспорта — явный отказ, данные не усекаются.
if (envelope.command && isSharedOperation(envelope.command)) {
  const limit = sharedOperations[envelope.command].limits.maxResultBytes;
  const { bytes, within } = checkJsonBytes(envelope, limit);
  if (!within) {
    const known = new HarnessError(
      'RESPONSE_TOO_LARGE',
      `Ответ ${envelope.command}: ${bytes} байт UTF-8 больше предела транспорта ${limit}; данные не усечены — сузьте вход`,
      [{ path: [envelope.ok ? 'data' : 'error'], message: `${bytes} > ${limit}` }],
    );
    envelope = {
      apiVersion: API_VERSION,
      command: envelope.command,
      ok: false,
      error: known.toJSON(),
    };
    code = exitCodeOf(known);
    text = undefined;
    process.stderr.write(`harness: ${known.code}: ${known.message}\n`);
  }
}
process.stdout.write(text ?? JSON.stringify(envelope) + '\n');
process.exitCode = code;
