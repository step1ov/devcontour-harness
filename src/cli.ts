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
  HARNESS_PROJECT_DIR,
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
  leadDiagnosisCauses,
  type LeadDiagnosisCause,
  projectManifestSchema,
  type CliArgument,
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
import { statusFrame, statusSettled, statusSetup, statusText } from './control/status.ts';
import { setupProgress } from './control/setup-progress.ts';
import { planCheck, planRequestOf } from './planning/check.ts';
import { checkJsonBytes } from './catalog/bytes.ts';
import { isSharedOperation, sharedOperations } from './catalog/shared.ts';
import { harnessCapabilities } from './catalog/harness.ts';
import type { RunnerHooks } from './engine/runner.ts';
import { hostGitArgs } from './environment/process.ts';
import { FileContextSource, FileResultSink, FileWorkSource } from './connectors/files.ts';
import { SqliteExecutionStore } from './storage/sqlite.ts';
import { collectReportInput } from './control/report.ts';
import { harnessView, locateProject } from './control/operator-view.ts';
import { OPERATOR_VIEW_VERSION } from './contracts/operator-view-limits.ts';
import { reportTargets } from './control/target.ts';
import { writeReportFile } from './control/report-file.ts';
import { valueReport, reportHtml, reportMarkdown } from './report/index.ts';
import { handoffMarkdown, handoffPack } from './handoff/index.ts';
import { inputStateOf } from './projections/input.ts';
import { checkGates, gatesText } from './control/gates-check.ts';
import {
  smokeLifecycle,
  smokeText,
  stepDetailText,
  stepStatusText,
} from './control/lifecycle-smoke.ts';
import { defaultResourceDatabase } from './environment/resources.ts';
import { listPreviews, startPreview, stopPreviews } from './control/preview.ts';
import {
  UPDATE_OPERATION,
  applyUpdate,
  recoverInterrupted,
  rollbackUpdate,
  updateInProgress,
  type UpdateHost,
} from './update/apply.ts';
import {
  cachedUpdates,
  installedHarness,
  checkUpdates,
  loadUpdatesConfig,
  saveLastCheck,
  updatesDir,
  writeUpdatesConfig,
} from './update/check.ts';
import { deadUpdater, liveWork } from './update/live.ts';
import { HARNESS_PACKAGE, installPrefix, installedPackage } from './update/install.ts';
import {
  disableSchedule,
  enableSchedule,
  linuxInstructions,
  scheduleArgs,
} from './update/schedule.ts';
import { updateText } from './update/text.ts';
import { updateModes, updatesConfigSchema } from './contracts/update.ts';
import {
  LEAD_LOGGED_COMMANDS,
  leadBegin,
  leadCommandEntry,
  leadEnd,
  leadNote,
  leadCommandActor,
  leadSessionOpen,
  leadTtlMs,
  recordLeadCommand,
  releaseDone,
  type LeadCommandArgs,
} from './control/lead.ts';
import { leadOutline } from './control/outline.ts';
import { parseDurationFlag } from './control/duration.ts';
import { readyNotRunning } from './control/lead-end-warning.ts';

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

/**
 * Справка одной команды (`harness <команда> --help`, `harness help <команда>`):
 * описание, параметры с обязательностью, запись состояния, идемпотентность и
 * отказы — из того же договора `cliCommands`, по которому разбираются флаги.
 */
function commandHelp(name: CliCommand) {
  const c = cliCommands[name] as {
    description: string;
    writes: boolean;
    idempotency: string;
    args: readonly CliArgument[];
    refusals: readonly string[];
  };
  const sign = (a: (typeof c.args)[number]) =>
    a.value === 'flag' ? a.name : `${a.name} <${a.value}>`;
  const width = Math.max(...c.args.map((a) => sign(a).length), 10) + 2;
  return [
    `harness ${name} — ${c.description}`,
    '',
    `Использование: harness ${name} ${c.args.map((a) => (a.required ? sign(a) : `[${sign(a)}]`)).join(' ')}`.trimEnd(),
    '',
    'Параметры:',
    ...c.args.map(
      (a) =>
        `  ${sign(a).padEnd(width)}${a.required ? '(обязательный) ' : ''}${a.multiple ? '(можно повторить) ' : ''}${a.description}`,
    ),
    '',
    `Пишет состояние: ${c.writes ? 'да' : 'нет'}. Повтор: ${c.idempotency}`,
    ...(c.refusals.length ? [`Отказы: ${c.refusals.join(', ')}`] : []),
    `stdout — JSON (${API_VERSION}); диагностика — stderr.`,
    '',
  ].join('\n');
}

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
      forecast?: {
        progress: {
          line: string;
          added?: { line: string }[];
          works?: { line: string; percent: number; attempt?: unknown }[];
          growth?: { line: string; reason?: string };
        };
        time: { line: string };
        outline?: { line: string };
      };
      sourceReviews?: { line: string }[];
    };
    const f = view.forecast;
    const out = [
      ...(f ? [`Прогноз выпуска: ${f.progress.line}; ${f.time.line}.`] : []),
      ...(f?.progress.added ?? []).map((a) => `  ${a.line}`),
      // План выпуска (alpha.68): записан — его строка, нет — подсказка ведущему.
      ...(f?.outline ? [`  ${f.outline.line}`] : []),
      ...(f?.progress.growth
        ? [
            `  ${f.progress.growth.line}` +
              (f.progress.growth.reason ? `: ${f.progress.growth.reason}` : ''),
          ]
        : []),
      // Готовность незаконченных работ: принятые уже видны строками работ.
      ...(f?.progress.works ?? [])
        .filter((w) => w.percent < 100 && w.attempt)
        .map((w) => `  ${w.line}`),
      ...(view.sourceReviews ?? []).map((r) => `От вас: ${r.line}.`),
    ];
    return out.length ? out.join('\n') + '\n' : undefined;
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
  policy?: ExecutionPolicy,
) => {
  const file = explicit ?? (candidate && existsSync(candidate) ? candidate : undefined);
  if (!file) return undefined;
  const { relayCompatibilityCheck } = await import('./integrations/connector/commands.ts');
  const known = await knownTests(state);
  return relayCompatibilityCheck(file, {
    stateDir: resolve(state ?? '.'),
    ...((policy ?? known?.policy) ? { policy: (policy ?? known?.policy)! } : {}),
    ...(known ? { known: known.tests } : {}),
  });
};

/**
 * testcases gates из evidence попыток каталога состояния (только чтение) и
 * его политика — для проверки привязок критериев коннектора. Нет каталога
 * или он не инициализирован — undefined.
 */
const knownTests = async (state?: string) => {
  if (!state || !existsSync(bindingFile(state))) return undefined;
  try {
    const b = binding(state);
    const h = open(state, b, 'state');
    try {
      const { Connector } = await import('./integrations/connector/commands.ts');
      return { tests: Connector.known(h), policy: b.policy, baseDir: b.baseDir };
    } finally {
      h.close();
    }
  } catch {
    return undefined;
  }
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
  all: { type: 'boolean' },
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
  reprove: { type: 'boolean' },
  'writer-probe': { type: 'boolean' },
  'apply-loopback': { type: 'boolean' },
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
  check: { type: 'boolean' },
  apply: { type: 'boolean' },
  rollback: { type: 'boolean' },
  schedule: { type: 'string' },
  mode: { type: 'string' },
  prefix: { type: 'string' },
  wait: { type: 'string' },
  scheduled: { type: 'boolean' },
  'confirm-formats': { type: 'string' },
  preview: { type: 'string' },
  ref: { type: 'string' },
  ttl: { type: 'string' },
  idle: { type: 'string' },
  summary: { type: 'string' },
  cause: { type: 'string' },
  hypothesis: { type: 'string' },
  addendum: { type: 'string' },
  evidence: { type: 'string', multiple: true },
  diagnosis: { type: 'string' },
  recovery: { type: 'string' },
  'diagnose-after': { type: 'string' },
  'lead-resets': { type: 'string' },
  file: { type: 'string' },
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
  human: ['init', 'lean', 'status', 'explain', 'plan-request', 'gates', 'smoke', 'update'],
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
    'input-resolve',
    'input-carry',
    'input-show',
    'input-answer',
    'input-context',
    'input-target',
    'input-apply',
    'input-cancel',
    'input-supersede',
  ],
  text: ['input-answer', 'lead-begin', 'lead-note', 'lead-end'],
  ttl: ['lead-begin', 'preview-start'],
  summary: ['release-done'],
  file: ['lead-outline'],
  option: ['input-answer'],
  kind: ['input-answer'],
  actor: ['input-answer', 'input-carry', 'review-plan', 'review-contract', 'review-accept'],
  by: ['reapprove', 'retry'],
  cause: ['diagnose'],
  hypothesis: ['diagnose'],
  addendum: ['diagnose'],
  evidence: ['diagnose'],
  diagnosis: ['retry'],
  recovery: ['init'],
  'diagnose-after': ['init'],
  'lead-resets': ['init'],
  'accept-limitation': ['review-plan', 'review-contract', 'review-accept'],
  'continue-review': ['review-plan', 'review-contract'],
  'request-version': ['input-answer', 'input-apply', 'input-cancel', 'input-supersede'],
  'context-digest': ['input-target', 'input-apply'],
  answer: ['input-apply'],
  target: ['input-apply'],
  successor: ['input-supersede'],
  sha: ['gates', 'smoke'],
  gate: ['gates'],
  'fail-fast': ['gates'],
  reprove: ['source-deliver'],
  'writer-probe': ['smoke'],
  'apply-loopback': ['smoke'],
  watch: ['status'],
  interval: ['status'],
  base: ['review-code'],
  head: ['review-code'],
  role: ['review-code'],
  check: ['update'],
  apply: ['update'],
  rollback: ['update'],
  schedule: ['update'],
  mode: ['update'],
  prefix: ['update'],
  wait: ['update'],
  scheduled: ['update'],
  'confirm-formats': ['update'],
  preview: ['preview-start', 'preview-stop'],
  ref: ['preview-start'],
  idle: ['preview-start'],
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
  update: updateText,
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
          // Обновления — по сохранённой проверке, как у одиночного `status`.
          data: cliDataSchemas.status.parse({
            ...h.status(v.graph, { detail: true }),
            ...optional('updates', statusUpdates(resolve(state), binding(state).baseDir)),
          }),
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
      // Прогноз — по всему прогону: с --graph его нет (строки статуса — одного графа).
      const frame =
        statusFrame(data, now, intervalMs) + (v.graph ? '' : (forecastLines(state) ?? ''));
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

/**
 * Хост обновления для каталога состояния: живость, пауза операции
 * `harness-update`, событие `harness.updated`. Каждое действие открывает и
 * закрывает базу заново: возврат копии состояния подменяет файл базы, и
 * долгоживущее соединение писало бы в перенесённый файл.
 */
function updateHost(state: string, policyPath?: string): UpdateHost {
  // Привязка каталога состояния, иначе политика из --policy: база без привязки
  // тоже охраняется (живость, пауза, роль controller).
  const bound = (): Binding | undefined =>
    existsSync(bindingFile(state))
      ? binding(state)
      : policyPath
        ? loadPolicy(policyPath)
        : undefined;
  const usable = () => existsSync(join(state, 'state.sqlite')) && bound() !== undefined;
  const owner = `harness-update:${process.pid}`;
  const withHarness = <T>(fn: (h: Harness) => T, fallback: T): T => {
    if (!usable()) return fallback;
    const h = open(state, bound()!, true);
    try {
      return fn(h);
    } finally {
      h.close();
    }
  };
  const leaseMs = () => bound()?.policy.leaseMs ?? 30_000;
  return {
    live: () => (usable() ? liveWork(state, bound()!.policy, Date.now(), owner) : []),
    pause: () => withHarness((h) => h.engine.operationPause(UPDATE_OPERATION), false),
    resume: () => withHarness((h) => h.engine.operationResume(UPDATE_OPERATION), false),
    // Без базы состояния писать некому: роль «взята».
    hold: () =>
      withHarness((h) => h.engine.holdController(owner, (lease) => deadUpdater(lease.owner)), true),
    release: () => withHarness((h) => h.engine.release(owner), false),
    heartbeatMs: Math.max(1000, Math.floor(leaseMs() / 3)),
    record: (payload) => withHarness((h) => h.engine.recordUpdate(payload), undefined),
  };
}

/** Каталог .harness проекта, каталог установки и настройка обновлений. */
function updateContext(state: string, v: { policy?: string; prefix?: string }) {
  const harnessDir = v.policy
    ? dirname(resolve(v.policy))
    : existsSync(bindingFile(state))
      ? binding(state).baseDir
      : undefined;
  const prefix = installPrefix(harnessDir, v.prefix);
  const { config, exists } = loadUpdatesConfig(harnessDir);
  return {
    harnessDir,
    prefix,
    config,
    configExists: exists,
    npm: {
      cwd: prefix ?? process.cwd(),
      ...(config.registry ? { registry: config.registry } : {}),
    },
  };
}

let updatesConfigWarned = false;
/**
 * Строка об обновлениях для status. Настройка `.harness/updates.json` не по
 * схеме status не ломает и в строку «Обновления:» не попадает: поля нет, на
 * stderr — одно предупреждение простыми словами (отказ с подробностями — у
 * `harness update`).
 */
function statusUpdates(state: string, baseDir: string) {
  let loaded: ReturnType<typeof loadUpdatesConfig>;
  try {
    loaded = loadUpdatesConfig(baseDir, { quiet: true });
  } catch {
    if (!updatesConfigWarned) {
      updatesConfigWarned = true;
      process.stderr.write(
        'harness status: настройка обновлений .harness/updates.json не по схеме и пропущена; подробности — harness update --check\n',
      );
    }
    return undefined;
  }
  try {
    const cached = cachedUpdates(state, loaded.config, installedHarness(baseDir));
    if (!cached || (!loaded.exists && cached.state === 'not-checked')) return undefined;
    return { state: cached.state, line: cached.line };
  } catch {
    return undefined;
  }
}

async function runUpdate(
  v: Record<string, string | boolean | string[] | undefined>,
  state: string,
): Promise<{ data: unknown; code?: number }> {
  const flag = (k: string) => v[k] !== undefined;
  const actions = ['check', 'apply', 'rollback', 'schedule', 'mode'].filter(flag);
  if (actions.length !== 1)
    throw new HarnessError(
      'INVALID_INPUT',
      'update: нужно ровно одно из --check, --apply, --rollback, --schedule, --mode',
    );
  const action = actions[0]!;
  if (flag('wait') && action !== 'apply' && action !== 'rollback')
    throw new HarnessError('INVALID_INPUT', '--wait — только с --apply или --rollback');
  for (const only of ['scheduled', 'confirm-formats'])
    if (flag(only) && action !== 'apply')
      throw new HarnessError('INVALID_INPUT', `--${only} — только с --apply`);
  if (v.scheduled && v['confirm-formats'])
    throw new HarnessError(
      'INVALID_INPUT',
      '--confirm-formats — решение владельца; из расписания оно не принимается',
    );
  let waitMs: number | undefined;
  if (typeof v.wait === 'string') {
    const minutes = Number(v.wait);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720)
      throw new HarnessError('INVALID_INPUT', '--wait: целое число минут от 1 до 720', [
        { path: ['--wait'], message: v.wait },
      ]);
    waitMs = minutes * 60_000;
  }
  const ctx = updateContext(state, {
    ...optional('policy', typeof v.policy === 'string' ? v.policy : undefined),
    ...optional('prefix', typeof v.prefix === 'string' ? v.prefix : undefined),
  });
  const policyArg = typeof v.policy === 'string' ? v.policy : undefined;
  const host = updateHost(state, policyArg);
  // База состояния без привязки и без --policy: прогон в ней не увидеть — не ставить.
  if (
    (action === 'apply' || action === 'rollback') &&
    existsSync(join(state, 'state.sqlite')) &&
    !existsSync(bindingFile(state)) &&
    !policyArg
  )
    throw new HarnessError(
      'POLICY_REQUIRED',
      'У каталога состояния есть база, но нет привязки (binding.json): передайте --policy .harness/policy.json, чтобы обновление видело прогоны',
    );
  if (action === 'mode') {
    const mode = String(v.mode);
    if (!(updateModes as readonly string[]).includes(mode))
      throw new HarnessError('INVALID_INPUT', '--mode: ожидается auto, notify или off', [
        { path: ['--mode'], message: mode },
      ]);
    if (!ctx.harnessDir)
      throw new HarnessError(
        'POLICY_REQUIRED',
        '--mode: каталог .harness не найден — передайте --policy .harness/policy.json',
      );
    const config = updatesConfigSchema.parse({ ...ctx.config, mode });
    const file = writeUpdatesConfig(ctx.harnessDir, config);
    return {
      data: {
        action: 'mode',
        config,
        line: `Режим обновлений: ${mode} (${file}).${mode === 'auto' ? ' Ставится само только в пределах ' + config.autoScope + ' и когда нет прогона; включите ежедневную проверку: harness update --schedule daily --state ' + state : ''}`,
      },
    };
  }
  if (action === 'check') {
    // Прервавшееся обновление (процесс умер): снять его паузу, завершить возврат.
    let recovered: string | undefined;
    try {
      recovered = await recoverInterrupted(state, { config: ctx.config, npm: ctx.npm, host });
    } catch (error) {
      // Идёт другое обновление (замок занят): его пауза — его.
      if (!(error instanceof HarnessError && error.code === 'CONTROLLER_BUSY')) throw error;
    }
    const check = await checkUpdates({
      stateDir: state,
      ...optional('prefix', ctx.prefix),
      config: ctx.config,
      npm: ctx.npm,
    });
    saveLastCheck(state, check);
    return {
      data: {
        action: 'check',
        check,
        line: ((recovered ? recovered + ' ' : '') + check.line).slice(0, 500),
      },
    };
  }
  if (action === 'schedule') {
    const what = String(v.schedule);
    if (what !== 'daily' && what !== 'off')
      throw new HarnessError('INVALID_INPUT', '--schedule: ожидается daily или off', [
        { path: ['--schedule'], message: what },
      ]);
    const installed = ctx.prefix ? installedPackage(ctx.prefix, HARNESS_PACKAGE) : undefined;
    const bin = installed?.bin ?? resolve(process.argv[1] ?? 'harness');
    const args = [
      ...scheduleArgs(bin, state, typeof v.prefix === 'string' ? v.prefix : undefined),
      // Каталог без привязки: задание передаёт политику, иначе apply отказал бы каждый день.
      ...(!existsSync(bindingFile(state)) && typeof v.policy === 'string'
        ? ['--policy', resolve(v.policy)]
        : []),
    ];
    if (process.platform !== 'darwin')
      return {
        data: {
          action: 'schedule',
          schedule: { enabled: false, instructions: linuxInstructions(args) },
          line:
            what === 'daily'
              ? 'Задание создаётся само только на macOS; для этой ОС — текст ниже (systemd user timer или cron).'
              : 'На этой ОС задание не создавалось harness; уберите своё systemd/cron задание, если создавали.',
        },
      };
    if (what === 'off') {
      const r = disableSchedule(state);
      return {
        data: {
          action: 'schedule',
          schedule: { enabled: false, file: r.file },
          line: r.existed
            ? `Ежедневная проверка выключена: ${r.file} удалён.`
            : 'Ежедневной проверки не было.',
        },
      };
    }
    mkdirSync(updatesDir(state), { recursive: true });
    const r = enableSchedule(state, args, join(updatesDir(state), 'schedule.log'));
    return {
      data: {
        action: 'schedule',
        schedule: { enabled: true, file: r.file },
        line: r.loaded
          ? `Ежедневная проверка включена (каждый день в 09:30, режим ${ctx.config.mode}): ${r.file}.`
          : `Файл задания записан (${r.file}), но launchctl его не загрузил: ${r.reason ?? 'причина неизвестна'}. Загрузите: launchctl bootstrap gui/$(id -u) ${r.file}`,
      },
    };
  }
  if (!ctx.prefix)
    throw new HarnessError(
      'POLICY_REQUIRED',
      'Каталог установки не найден: передайте --prefix <каталог проекта> или --policy .harness/policy.json',
    );
  if (!installedPackage(ctx.prefix, HARNESS_PACKAGE))
    throw new HarnessError(
      'NOT_FOUND',
      `harness не установлен в ${ctx.prefix}/node_modules: обновление ставит пакеты туда, где они стоят; укажите --prefix`,
    );
  if (action === 'apply') {
    const r = await applyUpdate({
      stateDir: state,
      prefix: ctx.prefix,
      config: ctx.config,
      npm: ctx.npm,
      host,
      by: v.scheduled ? 'schedule' : 'operator',
      scheduled: Boolean(v.scheduled),
      ...optional(
        'confirmFormats',
        typeof v['confirm-formats'] === 'string' ? v['confirm-formats'] : undefined,
      ),
      // Из расписания — без ожидания: пауза оборвала бы идущий run, а
      // перезапустить его некому; идёт работа — попытка завтра.
      ...optional('waitMs', waitMs),
    });
    return { data: r.data, code: r.code };
  }
  const r = await rollbackUpdate({
    stateDir: state,
    config: ctx.config,
    npm: ctx.npm,
    host,
    ...optional('waitMs', waitMs),
  });
  return { data: r.data, code: r.code };
}

/** `init --recovery lead|user --diagnose-after N --lead-resets N` → `policy.recovery`. */
function recoveryFlags(v: {
  recovery?: string | undefined;
  'diagnose-after'?: string | undefined;
  'lead-resets'?: string | undefined;
}) {
  const int = (flag: 'diagnose-after' | 'lead-resets', min: number, max: number) => {
    const raw = v[flag];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max)
      throw new HarnessError('INVALID_INPUT', `--${flag}: целое от ${min} до ${max}`, [
        { path: ['--' + flag], message: raw },
      ]);
    return n;
  };
  const diagnoseAfter = int('diagnose-after', 1, 10);
  const leadResets = int('lead-resets', 0, 5);
  if (v.recovery === undefined) {
    if (diagnoseAfter !== undefined || leadResets !== undefined)
      throw new HarnessError(
        'INVALID_INPUT',
        '--diagnose-after и --lead-resets — вместе с --recovery lead|user',
      );
    return undefined;
  }
  const mode: 'lead' | 'user' | undefined =
    v.recovery === 'lead' ? 'lead' : v.recovery === 'user' ? 'user' : undefined;
  if (!mode)
    throw new HarnessError('INVALID_INPUT', '--recovery: ожидается lead или user', [
      { path: ['--recovery'], message: v.recovery },
    ]);
  return {
    mode,
    ...(diagnoseAfter !== undefined ? { diagnoseAfter } : {}),
    ...(leadResets !== undefined ? { leadResets } : {}),
  };
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
  if (!name || !Object.hasOwn(cliCommands, name))
    throw new HarnessError(
      'UNSUPPORTED_COMMAND',
      name ? 'Неизвестная команда: ' + name : 'Не указана команда',
    );
  const command = name as CliCommand;
  const { values: v } = parseArgs({ args: rest, options, strict: true });
  for (const [flag, owners] of Object.entries(flagOwners))
    if (v[flag as keyof typeof v] !== undefined && !(owners as readonly string[]).includes(command))
      throw new HarnessError('INVALID_INPUT', `--${flag} поддерживают: ${owners.join(', ')}`);
  // Во время обновления пакетов (или до возврата прерванного) с --state идут
  // только команды чтения: прочие писали бы состояние после копии (возврат
  // копии их потерял бы) или запускали бы заменяемые сейчас пакеты.
  const readOnly = [
    'status',
    'events',
    'result',
    'view',
    'report',
    'explain',
    'doctor',
    'capabilities',
    'validate',
    'update',
    'input-list',
    'input-show',
    'input-target',
    'source-status',
    'source-check',
    'handoff',
    'profile',
    'plan-request',
    'plan-check',
  ];
  if (typeof v.state === 'string' && !readOnly.includes(command)) {
    const state = resolve(v.state);
    let prefix: string | undefined;
    try {
      prefix = updateContext(state, {
        ...optional('policy', typeof v.policy === 'string' ? v.policy : undefined),
      }).prefix;
    } catch {
      prefix = undefined;
    }
    const updating = updateInProgress(state, prefix);
    if (updating)
      throw new HarnessError(
        'CONTROLLER_BUSY',
        `Сейчас ${updating}: дождитесь окончания обновления`,
      );
  }
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
    case 'review-accept': {
      // Решение по находкам ревью кода поручения (docs/review-protocol.md §10).
      const [accept] = reviewDispositionsOf({
        'accept-limitation': v['accept-limitation'],
        reason: need('reason'),
        ...(v.actor !== undefined ? { actor: v.actor } : {}),
      });
      const ids = (v['accept-limitation'] ?? []).flatMap((x) =>
        x
          .split(',')
          .map((y) => y.trim())
          .filter(Boolean),
      );
      if (!accept) throw new HarnessError('INVALID_INPUT', '--accept-limitation: нужен ID находки');
      const h = open(need('state'), binding(need('state')), true);
      try {
        return {
          command,
          data: h.engine.acceptCodeFindings(need('work'), ids, accept.reason, accept.by),
        };
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
      // До настройки статус — этап `setup` простыми строками, а не NOT_FOUND:
      // `--repository` без manifest или с manifest, но ещё без базы состояния;
      // `--state` — только каталог, которого нет совсем. База без привязки и
      // пустой каталог — прежний отказ: это не настройка, а неисправность.
      if (command === 'status' && !v.watch && v.interval === undefined) {
        const located =
          v.repository && !v.state
            ? locateProject({ repository: v.repository })
            : { stateDir: resolve(need('state')) };
        if (
          !located ||
          (located.fromManifest
            ? !existsSync(join(located.stateDir, 'state.sqlite'))
            : !existsSync(located.stateDir))
        ) {
          const harnessDir = join(resolve(v.repository ?? '.'), HARNESS_PROJECT_DIR);
          const progress =
            v.repository && existsSync(harnessDir)
              ? setupProgress({
                  harnessDir,
                  ...(located ? { stateDir: located.stateDir } : {}),
                  now: Date.now(),
                })
              : undefined;
          const data = {
            ...statusSetup(located ? 'state' : 'project'),
            ...(progress ? { setupProgress: progress } : {}),
          };
          return {
            command,
            data,
            ...(v.human
              ? {
                  text:
                    [...data.setup!.lines, ...(progress ? [progress.line] : [])].join('\n') + '\n',
                }
              : {}),
          };
        }
        v.state = located.stateDir;
      }
      if (command === 'status' && (v.watch || v.interval !== undefined))
        return { command, ...(await watchStatus(need('state'), v)) };
      const h = open(need('state'), binding(need('state')), 'state');
      try {
        if (command === 'status') {
          const updates = statusUpdates(resolve(need('state')), binding(need('state')).baseDir);
          const status = h.status(v.graph, { detail: Boolean(v.detail) });
          // Ход настройки, пока работ нет (alpha.67): политика — в `.harness/` проекта.
          const baseDir = binding(need('state')).baseDir;
          const progress =
            !status.works.length && !v.graph && basename(baseDir) === HARNESS_PROJECT_DIR
              ? setupProgress({
                  harnessDir: baseDir,
                  stateDir: resolve(need('state')),
                  now: Date.now(),
                })
              : undefined;
          const data = {
            ...status,
            ...optional('updates', updates),
            ...optional('setupProgress', progress),
          };
          if (!v.human) return { command, data };
          // Прогноз выпуска — та же строка, что у панели (`view.forecast`), по
          // всему прогону: с --graph строки статуса — одного графа, прогноза нет.
          // «Обновления:» печатает сам `statusText` (поле `updates`).
          const forecast = v.graph ? undefined : forecastLines(need('state'));
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
        // `--by operator` — то же, что без флага, но явно: журнал ведущего её не пишет.
        if (command === 'retry' && v.by !== undefined && v.by !== 'lead' && v.by !== 'operator')
          throw new HarnessError(
            'INVALID_INPUT',
            '--by: lead или operator (без флага — оператор)',
            [{ path: ['--by'], message: v.by }],
          );
        // В открытой сессии ведущего повтор без `--by` — отказ (alpha.68,
        // P6-17): ведущий называет свою роль явно — `--by lead` (решение
        // ведущего, с его пределами) или `--by operator` (решение человека).
        // Молчаливого умолчания нет ни в одну сторону.
        if (command === 'retry' && v.by === undefined && leadSessionOpen(h.engine))
          throw new HarnessError(
            'INVALID_INPUT',
            'Открыта сессия ведущего: повтор требует явного --by — --by lead (решение ведущего, с пределами recovery) или --by operator (решение человека, которое ведущий передаёт)',
            [{ path: ['--by'], message: 'required in an open lead session' }],
          );
        const bySource =
          command !== 'retry'
            ? undefined
            : v.by !== undefined
              ? ('flag' as const)
              : ('default' as const);
        const lead = command === 'retry' && v.by === 'lead';
        const refused = (error: unknown) => error;
        if (v.diagnosis !== undefined && !(lead && v.reset))
          throw new HarnessError(
            'INVALID_INPUT',
            '--diagnosis — только со сбросом ведущего (--reset --by lead)',
          );
        let result;
        try {
          result =
            command === 'cancel'
              ? h.engine.cancel(need('work'), v.reason, 'operator')
              : h.engine.retry(
                  need('work'),
                  v.reset
                    ? {
                        // Сброс ведущего называет причину разбором; своя причина — по желанию.
                        reason: lead ? (v.reason ?? '') : need('reason'),
                        ...(v.diagnosis !== undefined ? { diagnosis: v.diagnosis } : {}),
                      }
                    : undefined,
                  lead ? 'lead' : 'operator',
                );
        } catch (error) {
          throw refused(error);
        }
        return {
          command,
          data: {
            workId: result.work.id,
            status: result.work.status,
            attempt: result.work.attempt,
            changed: result.changed,
            ...('abandoned' in result && result.abandoned ? { abandoned: true as const } : {}),
            ...('reset' in result && result.reset ? { reset: result.reset } : {}),
            ...(bySource ? { by: lead ? ('lead' as const) : ('operator' as const), bySource } : {}),
          },
        };
      } finally {
        h.close();
      }
    }
    case 'lead-begin':
    case 'lead-note':
    case 'lead-end':
    case 'release-done': {
      // Журнал ведущего (0.1.0-alpha.66): одна локальная запись состояния.
      const h = open(need('state'), binding(need('state')), false);
      try {
        const data =
          command === 'lead-begin'
            ? leadBegin(h.engine, {
                ttlMs: leadTtlMs(typeof v.ttl === 'string' ? v.ttl : undefined),
                ...optional('text', typeof v.text === 'string' ? v.text : undefined),
              })
            : command === 'lead-note'
              ? leadNote(h.engine, {
                  text: need('text'),
                  ...optional('workId', typeof v.work === 'string' ? v.work : undefined),
                })
              : command === 'lead-end'
                ? leadEnd(
                    h.engine,
                    optional('text', typeof v.text === 'string' ? v.text : undefined),
                  )
                : releaseDone(h.engine, { summary: need('summary') });
        if (command === 'lead-end') {
          // Готовые работы, а никто не запущен (alpha.68, P6-33): сессия
          // закончена, выход прежний — только предупреждение. Сбой проверки
          // конец сессии не меняет.
          let warning;
          try {
            warning = readyNotRunning(h);
          } catch {
            warning = undefined;
          }
          if (warning) {
            process.stderr.write(`harness: ${warning.code}: ${warning.line}\n`);
            return { command, data: { ...data, readyNotRunning: warning } };
          }
        }
        return { command, data };
      } finally {
        h.close();
      }
    }
    case 'lead-outline': {
      // План выпуска ведущего (0.1.0-alpha.68): локальная запись состояния.
      const input = readJson(resolve(need('file')), 'outline');
      const h = open(need('state'), binding(need('state')), false);
      try {
        return {
          command,
          data: leadOutline(
            h.engine,
            input,
            optional('reason', typeof v.reason === 'string' ? v.reason : undefined),
          ),
        };
      } finally {
        h.close();
      }
    }
    case 'diagnose': {
      if (v.addendum !== undefined) {
        if (v.cause !== undefined || v.hypothesis !== undefined)
          throw new HarnessError(
            'INVALID_INPUT',
            '--addendum дополняет свежий разбор: без --cause и --hypothesis (новый разбор — без --addendum)',
            [{ path: ['--addendum'], message: 'exclusive' }],
          );
        const h = open(need('state'), binding(need('state')), true);
        try {
          return {
            command,
            data: {
              ...h.engine.amendDiagnosis(need('work'), {
                text: v.addendum,
                ...(v.evidence ? { evidence: v.evidence } : {}),
              }),
              amended: true as const,
            },
          };
        } finally {
          h.close();
        }
      }
      const cause = need('cause');
      if (!(leadDiagnosisCauses as readonly string[]).includes(cause))
        throw new HarnessError('INVALID_INPUT', `--cause: ${leadDiagnosisCauses.join(' | ')}`, [
          { path: ['--cause'], message: cause },
        ]);
      const h = open(need('state'), binding(need('state')), true);
      try {
        return {
          command,
          data: h.engine.diagnose(need('work'), {
            cause: cause as LeadDiagnosisCause,
            ...(v.hypothesis !== undefined ? { hypothesis: v.hypothesis } : {}),
            ...(v.evidence ? { evidence: v.evidence } : {}),
          }),
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
        const known = await knownTests(v.state);
        const data = await connector.check(
          loaded?.policy ?? known?.policy,
          loaded?.baseDir ?? known?.baseDir,
          known?.tests,
        );
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
      // source-status — чтение (в том числе во время обновления пакетов): база
      // состояния открывается только для чтения, без отметки writer и миграций.
      const h = open(state, b, command === 'source-status' ? 'state' : false);
      try {
        if (command === 'source-status') return { command, data: await connector.status(h) };
        if (command === 'source-deliver') {
          const data = v.reprove
            ? await connector.reprove(h, v.work)
            : await connector.deliver(h, v.work);
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
        ...((r) => (r ? { recovery: r } : {}))(recoveryFlags(v)),
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
          // Ревизия 5: `--repository <корень>` — состояние и политика из
          // `.harness/project.json`; до настройки — документ этапа `setup`.
          ...(v.repository && !v.state
            ? { repository: v.repository }
            : { stateDir: need('state') }),
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
          retryStoreNetworkFailure: true,
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
      // Применение loopback пишет файл политики: нужны проба и сам файл.
      if (v['apply-loopback'] && (!v['writer-probe'] || !v.policy))
        throw new HarnessError(
          'INVALID_INPUT',
          '--apply-loopback записывает сеть loopback в файл политики по итогам пробы: укажите --writer-probe и --policy',
          [{ path: ['--apply-loopback'], message: 'needs --writer-probe and --policy' }],
        );
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
          retryStoreNetworkFailure: true,
          ...(v['writer-probe']
            ? {
                writerProbe: true,
                ...optional('policyPath', v.policy ? resolve(v.policy) : undefined),
                ...(v['apply-loopback'] && b.source
                  ? { applyLoopback: true, policySha: b.source.sha }
                  : {}),
                executables: {
                  ...optional('codex', process.env.HARNESS_CODEX_BIN || undefined),
                  ...optional('claude', process.env.HARNESS_CLAUDE_BIN || undefined),
                },
              }
            : {}),
          // Ход — диагностика в stderr: stdout остаётся одним JSON.
          onStep: (s) =>
            process.stderr.write(
              `harness smoke: ${s.stage}/${s.id} ${stepStatusText(s)} ${Math.round(s.durationMs / 1000)} с${s.unused && s.detail ? ` (${stepDetailText(s)})` : ''}\n`,
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
    case 'preview-start':
    case 'preview-stop':
    case 'preview-list': {
      const state = need('state');
      const b = v.policy ? loadPolicy(v.policy) : binding(state);
      const ctx = { policy: b.policy, baseDir: b.baseDir, stateDir: resolve(state) };
      if (command === 'preview-list') return { command, data: await listPreviews(ctx) };
      if (command === 'preview-stop')
        return {
          command,
          data: await stopPreviews(ctx, {
            ...optional('repositoryId', v.repository),
            ...optional('previewId', v.preview),
            ...(v.all ? { all: true } : {}),
          }),
        };
      // Длительности — с единицей (`90s`, `30m`, `2h`), как у `lead-begin --ttl`;
      // голое число отклоняется (кроме `--idle 0` — «не по простою»).
      const duration = (flag: 'ttl' | 'idle') => {
        const raw = v[flag];
        if (raw === undefined) return undefined;
        return parseDurationFlag(flag, raw, {
          minMs: 1000,
          maxMs: 86_400_000,
          ...(flag === 'idle' ? { zero: true } : {}),
        });
      };
      const ttlMs = duration('ttl');
      const idleMs = duration('idle');
      // Принятый результат поручения — из базы состояния, только чтение.
      const work = (id: string) => {
        if (!existsSync(join(resolve(state), 'state.sqlite'))) return undefined;
        const h = open(state, b, 'state');
        try {
          return h.engine.read((view) => {
            const w = view.work(id);
            return w
              ? {
                  status: w.status,
                  repositoryId: w.order.repositoryId,
                  ...(w.resultSha ? { resultSha: w.resultSha } : {}),
                }
              : undefined;
          });
        } finally {
          h.close();
        }
      };
      return {
        command,
        data: await startPreview(ctx, {
          ...optional('repositoryId', v.repository),
          ...optional('previewId', v.preview),
          ...optional('ref', v.ref),
          ...optional('workId', v.work),
          ...optional('ttlMs', ttlMs),
          ...optional('idleMs', idleMs),
          work,
        }),
      };
    }
    case 'update': {
      const r = await runUpdate(v, resolve(need('state')));
      return { command, data: r.data, ...optional('code', r.code) };
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
          processList: true,
        },
      );
      // Manifest проекта рядом с политикой расходится с ней по слою lean — предупреждение.
      const mismatch = v.policy ? leanMismatch(resolve(v.policy)) : [];
      if (mismatch.length) report.warnings = [...(report.warnings ?? []), ...mismatch];
      // Настройка дольше мягкого бюджета (alpha.67): пока harness run ещё не
      // начинался, а настройка идёт дольше SETUP_BUDGET_MS, — одна строка.
      const over = v.policy ? setupOverBudget(resolve(v.policy)) : undefined;
      if (over) report.warnings = [...(report.warnings ?? []), `SETUP_OVER_BUDGET: ${over}`];
      // Связка с Relay: --source или connector.json рядом с политикой.
      const relay = await relayCheck(
        v.source,
        v.policy ? join(dirname(resolve(v.policy)), 'connector.json') : undefined,
        v.state,
        b?.policy,
      );
      if (!relay) return { command, data: report };
      if (relay.warning)
        report.warnings = [...(report.warnings ?? []), `RELAY_COMPATIBILITY: ${relay.warning}`];
      // Критерий, который коннектор не докажет, виден до запуска (P4-6).
      if (relay.bindings?.length)
        report.warnings = [
          ...(report.warnings ?? []),
          ...relay.bindings.map((b) => `RELAY_CRITERIA_BINDING: ${b}`),
        ];
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
    case 'input-resolve':
    case 'input-carry': {
      const b = binding(need('state'), v.policy, Boolean(v.policy));
      const h = open(need('state'), b, false);
      try {
        const id = need('request');
        const author = v.author ? parseWith(authorSchema, v.author, 'author') : undefined;
        const reset = v.reset ? { reason: need('reason') } : undefined;
        const out =
          command === 'input-resolve'
            ? await h.resolveInput(id, {
                ...optional('author', author),
                ...optional('reset', reset),
              })
            : await h.carryInputOf(id, {
                reason: need('reason'),
                by: parseWith(z.enum(['operator', 'lead']), v.actor ?? 'lead', 'actor'),
                ...optional('author', author),
                ...optional('reset', reset),
              });
        const done = 'applied' in out ? out.applied : out.carried;
        return {
          command,
          data: {
            requestId: out.requestId,
            ...('applied' in out ? { applied: out.applied } : { carried: out.carried }),
            ...('superseded' in out ? { superseded: out.superseded } : {}),
            changed: out.changed,
            lifecycle: out.lifecycle,
            ...optional('contextDigest', out.contextDigest),
            ...('reviewRound' in out
              ? { reviewRound: out.reviewRound, reviewed: out.reviewed }
              : {}),
            ...('work' in out && out.work
              ? { work: { id: out.work.id, status: out.work.status, attempt: out.work.attempt } }
              : {}),
            ...('active' in out && out.active ? { active: out.active } : {}),
            ...('joint' in out && out.joint ? { joint: true as const } : {}),
            ...('blocker' in out && out.blocker ? { blocker: out.blocker } : {}),
          },
          ...(done ? {} : { code: exitCodes.refused }),
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
          // Ответ без `--actor` — оператора, и в открытой сессии ведущего:
          // ответ владельца, который передаёт ведущий, не записывается
          // решением ведущего. Ответ ведущего — только явно `--actor lead`.
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

/**
 * Синонимы журнала ведущего (0.1.0-alpha.66): `harness lead begin|note|end` и
 * `harness release done`; строка без флага после `lead note` — `--text`,
 * после `release done` — `--summary`.
 */
function leadAlias(args: string[]): string[] {
  const [a, b, ...rest] = args;
  const lifted = (flag: string) =>
    rest[0] !== undefined && !rest[0].startsWith('--') ? [flag, rest[0], ...rest.slice(1)] : rest;
  if (a === 'lead' && (b === 'begin' || b === 'end')) return [`lead-${b}`, ...rest];
  if (a === 'lead' && b === 'note') return ['lead-note', ...lifted('--text')];
  if (a === 'lead' && b === 'outline') return ['lead-outline', ...rest];
  if (a === 'release' && b === 'done') return ['release-done', ...lifted('--summary')];
  return args;
}

/**
 * Записать команду ведущего в его журнал (P4-10 a): после успешной команды
 * (у `run` — и при старте), только для существующего состояния с привязкой;
 * сбой журнала команду не меняет — строка в stderr. Команда — ведущего, если
 * она сама это говорит (`--by lead`, `--actor lead`) или, без явного актёра,
 * если сессия ведущего активна (`diagnose` — всегда ведущего); `--by`/`--actor`
 * с другим значением — команда
 * оператора: в журнал ведущего не пишется и аренду не продлевает
 * (`recordLeadCommand`). `actor` задаёт решение явно: конец `run` пишется,
 * только если записан его старт. Возвращает, записана ли строка.
 */
function journalLeadCommand(
  args: string[],
  phase: 'start' | 'end',
  data: unknown,
  actor?: 'lead' | 'operator',
): boolean {
  const command = args[0];
  if (!command || !(LEAD_LOGGED_COMMANDS as readonly string[]).includes(command)) return false;
  try {
    const { values } = parseArgs({ args: args.slice(1), options, strict: false });
    const state = typeof values.state === 'string' ? values.state : undefined;
    if (!state || !existsSync(join(state, 'state.sqlite')) || !existsSync(bindingFile(state)))
      return false;
    const flags: LeadCommandArgs = {
      ...optional('work', typeof values.work === 'string' ? values.work : undefined),
      ...optional('request', typeof values.request === 'string' ? values.request : undefined),
      ...optional('actor', typeof values.actor === 'string' ? values.actor : undefined),
      ...(values.reset === true ? { reset: true } : {}),
      ...(typeof values.by === 'string' ? { by: values.by } : {}),
    };
    // Актёр, которого команда получила от сессии ведущего (alpha.68): журнал
    // пишет его, как если бы флаг был задан.
    const entry = leadCommandEntry(command, flags, data, phase);
    if (!entry) return false;
    const h = open(state, binding(state), false);
    try {
      return recordLeadCommand(h.engine, entry, actor ?? leadCommandActor(command, flags));
    } finally {
      h.close();
    }
  } catch (error) {
    process.stderr.write(
      `harness: журнал ведущего не записан: ${(error as Error)?.message ?? String(error)}\n`,
    );
    return false;
  }
}

const argv = leadAlias(process.argv.slice(2));
// Справка команды: `harness <команда> --help|-h` или `harness help <команда>` —
// текст на stdout, exit 0; неизвестная команда — обычный отказ ниже.
// `-h`/`--help` — только на месте флага: значение строкового параметра
// (`--text -h`) справку не вызывает.
const valued = (token: string | undefined) =>
  !!token?.startsWith('--') &&
  !token.includes('=') &&
  (options as Record<string, { type: string }>)[token.slice(2)]?.type === 'string';
const helpOf =
  argv[0] === 'help' || argv[0] === '--help'
    ? argv[1] === '--help' || argv[1] === '-h'
      ? undefined
      : argv[1]
    : argv.slice(1).some((a, i) => (a === '--help' || a === '-h') && !valued(argv[i]))
      ? argv[0]
      : undefined;
if (helpOf && Object.hasOwn(cliCommands, helpOf)) {
  process.stdout.write(commandHelp(helpOf as CliCommand));
  process.exit(exitCodes.ok);
}
if (argv[0] === '--help' || argv[0] === 'help') {
  if (helpOf) process.stderr.write(`harness: неизвестная команда: ${helpOf}\n\n`);
  process.stderr.write(usage);
  process.exit(helpOf ? exitCodes.input : exitCodes.ok);
}
let envelope: CliEnvelope;
let code: number = exitCodes.ok;
let text: string | undefined;
try {
  // Конец `run` пишется в журнал ведущего, только если записан его старт.
  const runBy =
    argv[0] === 'run'
      ? journalLeadCommand(argv, 'start', undefined)
        ? ('lead' as const)
        : ('operator' as const)
      : undefined;
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run(argv);
  } catch (error) {
    // Запуск ведущего закончился отказом — тоже конец его run.
    if (runBy) journalLeadCommand(argv, 'end', undefined, runBy);
    throw error;
  }
  journalLeadCommand(argv, 'end', result.data, runBy);
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
  const command = argv[0] && Object.hasOwn(cliCommands, argv[0]) ? (argv[0] as CliCommand) : null;
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

/**
 * Строка doctor о бюджете настройки (alpha.67): политика — в `.harness/`
 * проекта с manifest, базы состояния ещё нет (run не начинался), а ход
 * настройки дольше мягкого бюджета. Иначе — undefined.
 */
function setupOverBudget(policyPath: string): string | undefined {
  const harnessDir = dirname(policyPath);
  if (basename(harnessDir) !== HARNESS_PROJECT_DIR) return undefined;
  let located;
  try {
    located = locateProject({ repository: dirname(harnessDir) });
  } catch {
    return undefined;
  }
  if (!located || existsSync(join(located.stateDir, 'state.sqlite'))) return undefined;
  const progress = setupProgress({ harnessDir, stateDir: located.stateDir, now: Date.now() });
  return progress.overBudget ? progress.line : undefined;
}
