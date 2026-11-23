/**
 * H3-01: одна декларация общих операций. `sharedOperations` — производное
 * представление договора CLI (`cliCommands`, `cliDataSchemas`,
 * `cliTransportLimits`) без второй копии текста; прежние команды, их данные и
 * конверт не меняются.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  cliCommands,
  cliDataSchemas,
  GATE_SCOPE_LIMIT,
  operationCatalogSchema,
  type CliArgument,
} from '../src/contracts/index.ts';
import * as root from '../src/index.ts';
import {
  cliTransportLimits,
  isSharedOperation,
  sharedOperationNames,
  sharedOperations,
} from '../src/catalog/index.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const harness = (args: string[]) => {
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    cwd: mkdtempSync(join(tmpdir(), 'harness-cwd-')),
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    json: JSON.parse(r.stdout) as { ok: boolean; error?: { code: string } },
  };
};
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const laterCommands: readonly string[] = [
  'worktree-cleanup',
  'report',
  'handoff',
  'input-list',
  'input-show',
  'input-answer',
  'input-context',
  'input-target',
  'input-apply',
  'input-cancel',
  'input-supersede',
  'gates',
  'smoke',
  // Переключение слоя lean в подготовленном проекте (0.1.0-alpha.51).
  'lean',
  // Обзор уже написанной ветки (0.1.0-alpha.54).
  'review-code',
  // Представление оператора (0.1.0-alpha.55).
  'view',
  // Повторное согласование после правки политики (0.1.0-alpha.59).
  'reapprove',
  // Ответ до применения и перенос ответа одной командой (0.1.0-alpha.60).
  'input-resolve',
  'input-carry',
  // Решение ведущего по находкам ревью кода поручения (0.1.0-alpha.60).
  'review-accept',
  // Обновления harness и панели (0.1.0-alpha.60).
  'update',
  // Журнал ведущего и итог выпуска (0.1.0-alpha.66).
  'lead-begin',
  'lead-note',
  'lead-end',
  'release-done',
  // Превью результата (0.1.0-alpha.66).
  'preview-start',
  'preview-stop',
  'preview-list',
  // Разбор ведущего повторных отказов (0.1.0-alpha.66).
  'diagnose',
  // План выпуска ведущего (0.1.0-alpha.68).
  'lead-outline',
];
/** Команды CLI кандидата H2 (`5077625`) в порядке объявления. */
const h2Commands = [
  'validate',
  'review-plan',
  'review-contract',
  'approve',
  'run',
  'status',
  'events',
  'pause',
  'resume',
  'cancel',
  'retry',
  'result',
  'deliver',
  'cleanup',
  'profile',
  'doctor',
  'init',
  'explain',
  'plan-request',
  'plan-check',
  'source-check',
  'source-snapshot',
  'source-status',
  'source-deliver',
  'source-reconcile',
] as const;
/**
 * SHA-256 `JSON.stringify(cliCommands)` и JSON Schema данных
 * (`{io:'output', unrepresentable:'any'}`) всех команд на `5077625`.
 * Данные с тех пор расширены только аддитивно — значениями перечней классов
 * отказа и причин остановки `unfinished` (незавершённая работа) и `needs-lead`
 * (пустой результат без механического основания), полем `recheck` записи
 * evidence, пределом области gates `GATE_SCOPE_LIMIT` вместо 20, полем
 * `checkouts` ответа doctor, полем `localContext` ответа source-snapshot и
 * полем `baseline` ответов коннектора, вариантами `unknown` (тип, записанный
 * более новой версией) и `attempt.stage` событий `events`, полем `detail` и
 * флагом `--detail` команды status; без них — те же байты.
 */
const H2_COMMANDS_SHA = '58efd5e554cd5b015538ef1d4e7dd8d20f24205ef24e28c5b27394642bc20e25';
const H2_DATA_SHA = '95016c62e6e7fb134ab3dcde4aff35679951fe1b9037452bc86846230ffa5682';
/**
 * Область gates (ссылки на gates или ID gates основания ревью) с пределом
 * `GATE_SCOPE_LIMIT`: в H2 предел был 20.
 */
function gateScope(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object') return false;
  const o = v as { type?: unknown; maxItems?: unknown; items?: Record<string, unknown> };
  return (
    o.type === 'array' &&
    o.maxItems === GATE_SCOPE_LIMIT &&
    !!o.items &&
    (o.items.pattern === '^@?[A-Za-z0-9_-]{1,80}$' ||
      (o.items.type === 'string' && o.items.minLength === 1 && o.items.maxLength === 200))
  );
}
/**
 * Аддитивные варианты событий после H2: непрозрачное неизвестное событие
 * чтения, границы стадий и живость попытки, события вмешательств и причины
 * отказа (alpha.34).
 */
const ADDITIVE_EVENT_TYPES = new Set([
  'unknown',
  'attempt.stage',
  'attempt.liveness',
  'joint.liveness',
  'work.retried',
  'work.cancelled',
  'base.moved',
  'attempt.diagnosed',
  // H02: вопросы исполнителя и решения, принятые им самим.
  'input.requested',
  'input.answered',
  'input.applied',
  'input.closed',
  'input.delivered',
  'input.stale',
  'attempt.assumptions',
  // alpha.44: явный сброс бюджета совместных проверок набора.
  'joint.budget-reset',
  // alpha.60: решение ведущего по находкам ревью кода (`review-accept`).
  'work.findings-accepted',
  // Доработка принятого поручения новой редакцией графа (`WorkState.rework`).
  'work.reopened',
  // alpha.60: смена пакетов командой `harness update`.
  'harness.updated',
  // alpha.66: отказ от доработки — возврат к принятой редакции.
  'work.rework-abandoned',
  // alpha.66: разбор ведущего повторных отказов (`harness diagnose`).
  'work.diagnosed',
  // alpha.67: сверка записи окружения smoke (`harness cleanup LS-…`).
  'environment.reconciled',
  // alpha.68: дополнение разбора ведущего (`harness diagnose --addendum`).
  'work.diagnosis-amended',
  // alpha.68: поднятые пределы бюджета применённой политики.
  'budget.raised',
]);
/** Аддитивные флаги прежних команд после H2. */
const ADDITIVE_ARGS = new Set([
  'status--detail',
  // Повторное доказательство критериев принятого результата (0.1.0-alpha.66).
  'source-deliver--reprove',
  // Корень проекта вместо --state (0.1.0-alpha.65).
  'status--repository',
  // Текст сводки попыток для человека (0.1.0-alpha.52).
  'status--human',
  'init--lean',
  'init--lead',
  'init--review',
  'init--model',
  // Решения по находкам плана и контракта (0.1.0-alpha.54).
  'review-plan--accept-limitation',
  'review-plan--continue-review',
  'review-plan--reason',
  'review-plan--actor',
  'review-contract--accept-limitation',
  'review-contract--continue-review',
  'review-contract--reason',
  'review-contract--actor',
  // Обновляемый текст status для человека (0.1.0-alpha.54).
  'status--watch',
  'status--interval',
  // Технические вопросы решает ведущий (0.1.0-alpha.55).
  'init--lead-technical-answers',
  // Сверка версии Relay по связке задач (0.1.0-alpha.60).
  'doctor--source',
  'init--source',
  // Восстановление ведущим после повторных отказов (0.1.0-alpha.66).
  'retry--by',
  'retry--diagnosis',
  'init--recovery',
  'init--diagnose-after',
  'init--lead-resets',
]);
/**
 * Текст `--writer` init в H2. 0.1.0-alpha.50 меняет умолчание: writer —
 * ведущий (`--lead`), а не `claude`; аргумент и его значения прежние.
 */
const H2_INIT_WRITER = 'Runtime writer: claude (по умолчанию) или codex; reviewer — другой вендор';
/** Тип варианта события в JSON Schema (`properties.type.const`). */
const eventTypeOf = (v: unknown) =>
  (v as { properties?: { type?: { const?: unknown } } } | null)?.properties?.type?.const as
    string | undefined;
/** Прежние коды отказов, названные у прежней команды позже (команда:код). */
const ADDITIVE_REFUSALS = new Set([
  // retry: идущая попытка при --reset и повтор не после отказа (0.1.0-alpha.60).
  'retry:NOT_READY',
  // retry: третья попытка — только после разбора ведущего (0.1.0-alpha.66).
  'retry:DIAGNOSIS_REQUIRED',
]);
/** Аддитивные значения перечней после H2. */
const ADDITIVE_ENUM_VALUES = new Set([
  'unfinished',
  'needs-lead',
  'stalled',
  'context-exhausted',
  'CONTEXT_EXHAUSTED',
  // H02: остановка с вопросом исполнителя и её шаги.
  'needs-input',
  'INPUT_REQUIRED',
  'answer-input',
  'apply-input',
  'carry-stale',
  // Вид evidence неисполненного условного gate (`when.paths`).
  'not-applicable',
  // H12: блокирующий вопрос к человеку не отвечает ведущий (0.1.0-alpha.54).
  'OPERATOR_ANSWER_REQUIRED',
  // Отказ окружения `harness smoke` и preflight; несовпадение версии backend коннектора.
  'LIFECYCLE_FAILED',
  'CONNECTOR_VERSION_MISMATCH',
  // Представление оператора (`harness view`, 0.1.0-alpha.55).
  'POLICY_REQUIRED',
  'VIEW_TOO_LARGE',
  // Остановка исполнителя из-за окружения; предупреждение init о песочнице ведущего (0.1.0-alpha.59).
  'writer-environment',
  'lead-sandbox',
  // Предупреждения init о хранилище зависимостей (0.1.0-alpha.59).
  'dependency-store-unsupported',
  'dependency-cache-path',
  // Предупреждение init о версии Relay (0.1.0-alpha.60).
  'relay-compatibility',
  // Предупреждение init о реестре сборки seed хранилища (0.1.0-alpha.61).
  'dependency-store-registry',
  // Причина отказа среды: gate запускает ps в песочнице ОС (0.1.0-alpha.66).
  'sandbox-process-list',
  // Причины отказа среды: сигнал процессу вне песочницы и браузер в ней (0.1.0-alpha.68).
  'sandbox-signal',
  'sandbox-browser',
]);
/** Текст cancel в H2: alpha.66 добавила отказ от открытой доработки принятого поручения. */
const H2_CANCEL_DESCRIPTION =
  'Отменить поручение: активная попытка теряет владение, поручение становится cancelled; это не retry';
const H2_CANCEL_IDEMPOTENCY = 'Повтор для отменённого ничего не меняет';
/** alpha.67: cleanup принимает и ID запуска smoke (`LS-…`). */
const H2_CLEANUP_DESCRIPTION =
  'Довести незавершённую очистку закончившейся попытки: повторить teardown по сохранённым receipt окружений и убрать её рабочие деревья; модели, gates и Git-приёмка не вызываются';
const H2_CLEANUP_RUN = 'ID попытки (runId)';
/** Единственная намеренная правка текста прежней команды в L0: порядок записи init. */
const H2_INIT_DESCRIPTION =
  'Подготовить существующий Git npm/pnpm-репозиторий: план или create-only запись .harness/ (политика из профиля и toolchain inspection, manifest последним); чужие файлы не меняются';

test('H3-01: capabilities объявлена в договоре CLI — без записи, без отказов, данные — operationCatalogSchema', () => {
  assert.ok('capabilities' in cliCommands);
  assert.equal(cliCommands.capabilities.writes, false);
  assert.deepEqual(cliCommands.capabilities.refusals, []);
  assert.deepEqual(cliCommands.capabilities.args, []);
  assert.equal(cliDataSchemas.capabilities, operationCatalogSchema);
  assert.equal(root.operationCatalogSchema, operationCatalogSchema);
});

test('H3-01: ключи sharedOperations = sharedOperationNames — операции в порядке декларации', () => {
  assert.deepEqual(
    [...sharedOperationNames],
    ['init', 'explain', 'plan-request', 'plan-check', 'capabilities', 'view'],
  );
  assert.deepEqual(Object.keys(sharedOperations), [...sharedOperationNames]);
  for (const name of Object.keys(cliCommands))
    assert.equal(
      isSharedOperation(name),
      (sharedOperationNames as readonly string[]).includes(name),
      name,
    );
});

test('H3-01: каждая общая операция читается из договора CLI — writes, описание, ответ, вход, пределы', () => {
  for (const c of sharedOperationNames) {
    const op = sharedOperations[c];
    const contract = cliCommands[c];
    assert.equal(contract.writes, !op.readOnly, c);
    assert.equal(op.description, contract.description, c);
    assert.equal(op.output, cliDataSchemas[c], c);
    assert.equal(op.limits, cliTransportLimits, c);
    assert.deepEqual(op.limits, { maxInputBytes: 100000, maxResultBytes: 1048576 });

    const args: readonly CliArgument[] = contract.args;
    const shape = op.input.shape as Record<string, z.ZodType>;
    assert.deepEqual(
      Object.keys(shape),
      args.map((a) => a.name.replace(/^--/, '')),
      `${c}: ключи входа = имена args`,
    );
    // Опубликованная форма входа (как в каталоге): описание и required из args.
    const json = z.toJSONSchema(op.input, { io: 'input' }) as {
      properties: Record<string, { description?: string }>;
      required?: string[];
      additionalProperties: boolean;
    };
    assert.deepEqual(
      json.required ?? [],
      args.filter((a) => a.required).map((a) => a.name.replace(/^--/, '')),
      `${c}: required ⇔ не optional`,
    );
    assert.equal(json.additionalProperties, false, c);
    for (const arg of args) {
      const key = arg.name.replace(/^--/, '');
      const schema = shape[key]!;
      assert.equal(schema.safeParse(undefined).success, !arg.required, `${c} ${key}: required`);
      assert.equal(json.properties[key]?.description, arg.description, `${c} ${key}: описание`);
      if (arg.value === 'flag') {
        assert.ok(schema.safeParse(true).success, `${c} ${key}: флаг`);
        assert.equal(schema.safeParse('x').success, false, `${c} ${key}: флаг не строка`);
      } else if (arg.multiple) {
        assert.ok(schema.safeParse(['a', 'b']).success, `${c} ${key}: список`);
        assert.equal(schema.safeParse('a').success, false, `${c} ${key}: не строка`);
        assert.equal(schema.safeParse([]).success, false, `${c} ${key}: не пустой`);
      } else {
        assert.ok(schema.safeParse('a').success, `${c} ${key}: строка`);
        assert.equal(schema.safeParse('').success, false, `${c} ${key}: не пустая`);
        assert.equal(schema.safeParse(['a']).success, false, `${c} ${key}: не список`);
      }
    }
    // Вход строгий: лишний ключ отвергается.
    assert.equal(op.input.safeParse({ unknownArg: 'x' }).success, false, c);
  }
  // multiple объявлен только у --requirements plan-request, --intent handoff,
  // --evidence diagnose и
  // решений по находкам review-plan / review-contract / review-accept.
  const multiple = Object.entries(cliCommands).flatMap(([c, contract]) =>
    (contract.args as readonly CliArgument[]).filter((a) => a.multiple).map((a) => c + a.name),
  );
  assert.deepEqual(multiple, [
    'review-plan--accept-limitation',
    'review-plan--continue-review',
    'review-contract--accept-limitation',
    'review-contract--continue-review',
    'review-accept--accept-limitation',
    'diagnose--evidence',
    'handoff--intent',
    'plan-request--requirements',
  ]);
  assert.deepEqual(Object.keys(sharedOperations.capabilities.input.shape), []);
});

test('H3-01: API каждой общей операции опубликован корнем пакета функцией', () => {
  const apis = Object.fromEntries(sharedOperationNames.map((c) => [c, sharedOperations[c].api]));
  assert.deepEqual(apis, {
    init: 'initProject',
    explain: 'diagnoseState',
    'plan-request': 'planRequestOf',
    'plan-check': 'planCheck',
    capabilities: 'harnessCapabilities',
    view: 'harnessView',
  });
  const exports = root as unknown as Record<string, unknown>;
  for (const c of sharedOperationNames)
    assert.equal(typeof exports[sharedOperations[c].api], 'function', c);
});

test('H3-01: прежние команды и схемы их данных не изменились — только добавлена capabilities', () => {
  // Команды, добавленные позже: прежние они не меняют.
  const later = (name: string) => !laterCommands.includes(name);
  assert.deepEqual(Object.keys(cliCommands).filter(later), [
    ...h2Commands.slice(0, 20),
    'capabilities',
    ...h2Commands.slice(20),
  ]);
  assert.deepEqual(
    Object.keys(cliDataSchemas).filter(later).sort(),
    [...h2Commands, 'capabilities', 'version'].sort(),
  );

  // Тот же JSON договора H2: без capabilities, без аддитивного multiple и прежнего текста init.
  const before = Object.fromEntries(
    h2Commands.map((c) => {
      const contract = cliCommands[c];
      return [
        c,
        {
          ...contract,
          ...(c === 'init' ? { description: H2_INIT_DESCRIPTION } : {}),
          // alpha.66: отмена открытой доработки — возврат к принятой редакции.
          ...(c === 'cancel'
            ? { description: H2_CANCEL_DESCRIPTION, idempotency: H2_CANCEL_IDEMPOTENCY }
            : {}),
          ...(c === 'cleanup' ? { description: H2_CLEANUP_DESCRIPTION } : {}),
          // Аддитивный код отказа (alpha.35: CONTEXT_EXHAUSTED у run).
          refusals: contract.refusals.filter(
            (code) => !ADDITIVE_ENUM_VALUES.has(code) && !ADDITIVE_REFUSALS.has(`${c}:${code}`),
          ),
          args: (contract.args as readonly CliArgument[])
            .filter((arg) => !ADDITIVE_ARGS.has(c + arg.name))
            .map((arg) => {
              const copy: CliArgument = { ...arg };
              delete copy.multiple;
              if (c === 'init' && arg.name === '--writer') copy.description = H2_INIT_WRITER;
              if (c === 'cleanup' && arg.name === '--run') copy.description = H2_CLEANUP_RUN;
              // alpha.65: --state у status заменим --repository — прежний обязательный аргумент.
              if (c === 'status' && arg.name === '--state')
                Object.assign(copy, {
                  required: true,
                  description: 'Каталог состояния исполнения',
                });
              return copy;
            }),
        },
      ];
    }),
  );
  assert.equal(sha256(JSON.stringify(before)), H2_COMMANDS_SHA);

  const data = Object.fromEntries(
    Object.entries(cliDataSchemas)
      .filter(([c]) => c !== 'capabilities' && !laterCommands.includes(c))
      .map(([c, s]) => [
        c,
        z.toJSONSchema(s as z.ZodType, { io: 'output', unrepresentable: 'any' }),
      ]),
  );
  // Порядок ключей cliDataSchemas H2 — без capabilities; аддитивные значения
  // перечней убираются, остальное — байты H2.
  const h2 = JSON.stringify(data, (k, v: unknown) => {
    // Восстановление ведущим (0.1.0-alpha.66): настройки решений (`decisions`
    // у status, doctor и init), разборы и сбросы работы (`leadRecovery`),
    // правило политики (`recovery`) и строка сброса у работы status, поля
    // сброса ведущего в `work.retried`, актёр повтора `lead`, действие
    // `diagnose` и код `DIAGNOSIS_REQUIRED`.
    if (k === 'properties' && v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (
        'decisions' in o ||
        'leadRecovery' in o ||
        ('recovery' in o && ('policyVersion' in o || 'blockers' in o))
      ) {
        const rest = { ...o };
        delete rest.decisions;
        delete rest.leadRecovery;
        if ('policyVersion' in o || 'blockers' in o) delete rest.recovery;
        v = rest;
      }
      const r = v as Record<string, unknown>;
      if ('reasonLength' in r && 'spent' in r && 'diagnosis' in r) {
        const rest = { ...r };
        for (const key of ['diagnosis', 'index', 'cap', 'granted']) delete rest[key];
        v = rest;
      }
    }
    // alpha.67: ход настройки у status (`setupProgress`), готовые работы и
    // работы под вопросом у строки очереди (`runner.ready`,
    // `runner.heldByQuestion`), следующий шаг очереди у explain (`queue`),
    // сверенные записи smoke у cleanup (`reconciled`), вид работы и
    // изменения gates у поручения графа plan-check (`kind`, `gateChanges`).
    if (k === 'properties' && v && typeof v === 'object') {
      const o = { ...(v as Record<string, unknown>) };
      const before = Object.keys(o).length;
      if ('works' in o && 'control' in o) delete o.setupProgress;
      if ('state' in o && 'restartBy' in o && 'planReviews' in o) {
        delete o.ready;
        delete o.heldByQuestion;
      }
      if ('diagnoses' in o) delete o.queue;
      if ('status' in o && 'receipts' in o) delete o.reconciled;
      if ('writeScope' in o && 'context' in o && 'contracts' in o) {
        delete o.kind;
        delete o.gateChanges;
      }
      if (Object.keys(o).length !== before) v = o;
    }
    // alpha.68: кем исполнен повтор и откуда актёр (`retry`: `by`, `bySource`).
    if (k === 'properties' && v && typeof v === 'object') {
      const o = { ...(v as Record<string, unknown>) };
      const before = Object.keys(o).length;
      if ('workId' in o && 'attempt' in o && 'changed' in o && 'bySource' in o) {
        delete o.by;
        delete o.bySource;
      }
      if (Object.keys(o).length !== before) v = o;
    }
    if (k === 'enum' && Array.isArray(v) && v.includes('recovery') && v.includes('host'))
      v = (v as unknown[]).filter((x) => x !== 'lead');
    if (k === 'enum' && Array.isArray(v))
      v = (v as unknown[]).filter(
        (x) => x !== 'diagnose' && x !== 'DIAGNOSIS_REQUIRED' && x !== 'ENVIRONMENT_GATE_HELD',
      );
    // Пределы восстановления после ревью alpha.66: продолжение оставленной
    // доработки (`rework.resumed`, `abandoned.attempt/neutralFailures`),
    // удержание gate (`environmentHold`, `work.retried.gateHoldLifted`,
    // `resources.gates.held/heldLine`).
    if (k === 'properties' && v && typeof v === 'object') {
      const o = { ...(v as Record<string, unknown>) };
      const before = Object.keys(o).length;
      if ('orderDigest' in o && 'restored' in o) {
        delete o.attempt;
        delete o.neutralFailures;
      }
      if ('budgets' in o && 'fresh' in o) delete o.resumed;
      delete o.environmentHold;
      delete o.gateHoldLifted;
      if ('workspace' in o && 'repositories' in o) {
        delete o.held;
        delete o.heldLine;
      }
      // Ревью раунда 2: актёр шага пути (`track.steps[].actor`).
      if ('label' in o && 'state' in o && 'rework' in o) delete o.actor;
      if (Object.keys(o).length !== before) v = o;
    }
    // alpha.68: изменённые необязательные документы у run --source
    // (`documentsDrift`), дополнения разбора (`addenda`), предел раундов
    // ревью предмета (`rounds.remaining/free/since`, `used` с нуля).
    if (k === 'properties' && v && typeof v === 'object') {
      const o = { ...(v as Record<string, unknown>) };
      const before = Object.keys(o).length;
      if ('resumed' in o && 'works' in o) delete o.documentsDrift;
      if ('failures' in o && 'epoch' in o) delete o.addenda;
      if ('digest' in o && 'generation' in o && 'by' in o && 'at' in o) delete o.limits;
      if ('reviewerBinding' in o && 'findings' in o) {
        delete o.planDigest;
        delete o.counted;
        delete o.changes;
      }
      if ('used' in o && 'max' in o) {
        delete o.remaining;
        delete o.free;
        delete o.since;
        o.used = { type: 'integer', exclusiveMinimum: 0, maximum: 9007199254740991 };
      }
      if (Object.keys(o).length !== before || 'used' in o) v = o;
    }
    // Ревью раунда 2: событие снятия удержания при отклонённом повторе.
    if (k === 'oneOf' && Array.isArray(v))
      v = (v as { properties?: { type?: { const?: unknown } } }[]).filter(
        (x) => x?.properties?.type?.const !== 'work.gate-hold-lifted',
      );
    // Аддитивные поля ответа init (0.1.0-alpha.50): ведущий, решение о
    // ревью, наличие CLI и предупреждения — обязательные, поэтому и в `required`.
    if (v && typeof v === 'object' && !Array.isArray(v) && 'properties' in v) {
      const o = v as { properties: Record<string, unknown>; required?: string[] };
      if (o.properties && 'facts' in o.properties && 'lead' in o.properties) {
        // `questions` — правило ответов на вопросы исполнителя (0.1.0-alpha.55).
        // Необязательное: в `required` его нет (ответ прежней версии валиден).
        assert.ok(!o.required?.includes('questions'), 'init.questions необязательно');
        const added = ['lead', 'review', 'runtimes', 'warnings', 'questions'];
        const properties = { ...o.properties };
        for (const key of added) delete properties[key];
        return { ...o, properties, required: o.required?.filter((r) => !added.includes(r)) };
      }
    }
    // Аддитивные поля manifest проекта (0.1.0-alpha.50): lead, review, model;
    // запись `harness lean` о прежних значениях политики (`lean`, 0.1.0-alpha.51).
    if (k === 'properties' && v && typeof v === 'object' && 'projectId' in v && 'lead' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.lead;
      delete rest.review;
      delete rest.model;
      delete rest.lean;
      return rest;
    }
    // Аддитивные поля условного gate (`when.paths`) — до прочих правил, потому
    // что делят объект с их полями: условие gate задачи (рядом с `artifacts`),
    // сведения о неприменимости и digest определения у evidence, флаг события
    // `attempt.gate` (рядом с `recheck`), счёт неприменимых gates попытки.
    if (
      k === 'properties' &&
      v &&
      typeof v === 'object' &&
      ('notApplicable' in v || ('when' in v && 'command' in v && 'timeoutMs' in v))
    ) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.notApplicable;
      delete rest.gateBasis;
      // Перенос evidence кандидата (`integrationReuse`) рядом с `notApplicable`:
      // счёт взятых gates попытки и ссылка записи evidence.
      delete rest.reused;
      delete rest.reusedEvidence;
      // Фактический toolchain проверки у evidence (0.1.0-alpha.65).
      delete rest.toolchain;
      // `when` — только у схемы gate задачи (у gate совместной проверки его нет).
      if ('command' in rest && 'timeoutMs' in rest && !('repositoryId' in rest)) delete rest.when;
      v = rest;
    }
    // Аддитивные поля раунда ревью (0.1.0-alpha.59): политика раунда и digest
    // её границы исполнения.
    if (
      k === 'properties' &&
      v &&
      typeof v === 'object' &&
      'reviewerBinding' in v &&
      'contextDigest' in v
    ) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.policyDigest;
      delete rest.isolationDigest;
      v = rest;
    }
    // Запись повторного согласования (`approval.reapproval`, событие
    // `graph.approved`) и отметка «не используется» у стадии попытки (0.1.0-alpha.59).
    if (k === 'properties' && v && typeof v === 'object' && 'actor' in v && 'reapproval' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.reapproval;
      v = rest;
    }
    // Повторное доказательство критериев (0.1.0-alpha.66): необязательные поля
    // ответа source-deliver (`reprove`, `skipped`) и задачи source-status (`proof`).
    if (k === 'properties' && v && typeof v === 'object' && 'deliveries' in v && 'reprove' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.reprove;
      delete rest.skipped;
      v = rest;
    }
    if (k === 'properties' && v && typeof v === 'object' && 'remote' in v && 'proof' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.proof;
      v = rest;
    }
    // Итог `retry --reset` (0.1.0-alpha.60): необязательное поле ответа retry и cancel.
    if (
      k === 'properties' &&
      v &&
      typeof v === 'object' &&
      'workId' in v &&
      'attempt' in v &&
      'changed' in v &&
      'reset' in v
    ) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.reset;
      // alpha.66: cancel открытой доработки — `abandoned`.
      delete rest.abandoned;
      v = rest;
    }
    if (k === 'properties' && v && typeof v === 'object' && 'outcome' in v && 'unused' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.unused;
      v = rest;
    }
    // Закреплённый toolchain (0.1.0-alpha.65): поле политики, toolchain
    // запуска в итоге `harness gates`, предложение init, причина отказа
    // окружения `toolchain`.
    if (
      k === 'properties' &&
      v &&
      typeof v === 'object' &&
      'policyVersion' in v &&
      'repositories' in v
    ) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.toolchain;
      v = rest;
    }
    if (
      k === 'properties' &&
      v &&
      typeof v === 'object' &&
      'exitCode' in v &&
      'summary' in v &&
      'log' in v &&
      'message' in v &&
      'gate' in v
    ) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.toolchain;
      v = rest;
    }
    if (k === 'properties' && v && typeof v === 'object' && 'facts' in v && 'manifestPath' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.toolchainPin;
      v = rest;
    }
    // Список процессов в песочнице проверок у doctor (0.1.0-alpha.66).
    if (k === 'properties' && v && typeof v === 'object' && 'os' in v && 'reason' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.processList;
      // Пробы сигнала вне песочницы и браузера (0.1.0-alpha.68).
      delete rest.signal;
      delete rest.browser;
      v = rest;
    }
    if (k === 'enum' && Array.isArray(v) && v.includes('writer-environment'))
      v = (v as unknown[]).filter((x) => x !== 'toolchain');
    if (Array.isArray(v))
      return (v as unknown[]).filter(
        (x) =>
          !(typeof x === 'string' && ADDITIVE_ENUM_VALUES.has(x)) &&
          !(k === 'oneOf' && ADDITIVE_EVENT_TYPES.has(eventTypeOf(x) ?? '')),
      );
    // Аддитивное поле записи evidence — повтор провала gate интеграции.
    if (k === 'properties' && v && typeof v === 'object' && 'recheck' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.recheck;
      // PASS интеграции, взятый из кандидата (`integrationReuse`): поле
      // события `attempt.gate`.
      delete rest.reusedFrom;
      return rest;
    }
    // Аддитивное поле gate задачи — сохраняемые `artifacts` (у gate совместной
    // проверки, с `repositoryId`, поле было и в H2).
    if (
      k === 'properties' &&
      v &&
      typeof v === 'object' &&
      'artifacts' in v &&
      'command' in v &&
      !('repositoryId' in v)
    ) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.artifacts;
      return rest;
    }
    // Аддитивные поля слоя lean: граница предела gate разрешённого профиля и
    // слои профиля в manifest init.
    if (k === 'properties' && v && typeof v === 'object' && 'closure' in v && 'runTimeoutMs' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.gateTimeoutFloorMs;
      // Превью результата разрешённого профиля (0.1.0-alpha.66).
      delete rest.previews;
      return rest;
    }
    if (k === 'properties' && v && typeof v === 'object' && 'pin' in v && 'ref' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.layers;
      return rest;
    }
    // Аддитивные поля doctor — действующий корень рабочих деревьев (alpha.23),
    // проба портов ресурсов и предупреждения (порт только на wildcard, ревью
    // тем же вендором, срок фаз, советы о ресурсах машины).
    if (k === 'properties' && v && typeof v === 'object' && 'checkouts' in v && 'sandbox' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.checkouts;
      delete rest.ports;
      delete rest.warnings;
      // Правило ответов на вопросы исполнителя словами (0.1.0-alpha.55).
      delete rest.questions;
      // Ведущий внутри песочницы (0.1.0-alpha.59).
      delete rest.leadSandbox;
      // Сверка Relay по связке задач (0.1.0-alpha.60).
      delete rest.relay;
      // Ожидаемые состояния словами: проверки в браузере вне исполнителя (0.1.0-alpha.63).
      delete rest.notes;
      // Модель и effort по ролям политики (0.1.0-alpha.64).
      delete rest.models;
      // Закреплённый toolchain политики (0.1.0-alpha.65).
      delete rest.toolchainPin;
      return rest;
    }
    // Аддитивные поля ответов коннектора (0.1.0-alpha.60): совместимость с
    // Relay, предупреждения простыми словами, открытые вопросы владельцу.
    if (k === 'properties' && v && typeof v === 'object' && 'compatibility' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.compatibility;
      delete rest.warnings;
      delete rest.questions;
      v = rest;
    }
    // Контекст исполнения задачи у строки mapping и задачи снимка (0.1.0-alpha.60).
    if (
      k === 'properties' &&
      v &&
      typeof v === 'object' &&
      'taskContext' in v &&
      ('problems' in v || 'semanticDigest' in v)
    ) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.taskContext;
      return rest;
    }
    // Аддитивные поля ответов коннектора: пакеты `tasks[].context` (alpha.13) и
    // зависимости, принятые по базовой линии.
    if (
      k === 'properties' &&
      v &&
      typeof v === 'object' &&
      ('localContext' in v || 'baseline' in v)
    ) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.localContext;
      delete rest.baseline;
      return rest;
    }
    // Аддитивные поля status — живость активной попытки (`works[].liveness`),
    // вопрос исполнителя и запросы ведущему (`works[].input`, `followUps`, H02),
    // сводка попыток (`works[].attemptSummary`, 0.1.0-alpha.52), этап для
    // оператора (`works[].stage`, 0.1.0-alpha.54).
    if (k === 'properties' && v && typeof v === 'object' && 'liveness' in v && 'blockers' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.liveness;
      delete rest.input;
      delete rest.followUps;
      delete rest.attemptSummary;
      delete rest.stage;
      // Принятая версия против текущего target ref (`works[].target`, 0.1.0-alpha.54).
      delete rest.target;
      // Что проверено и как (`works[].verification`, 0.1.0-alpha.55).
      delete rest.verification;
      return rest;
    }
    // Аддитивные поля блокировки — причина простыми словами и кто её снимает
    // (`blockers[].plain`, `plainEn`, `actor`, 0.1.0-alpha.55).
    if (k === 'properties' && v && typeof v === 'object' && 'code' in v && 'plain' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.plain;
      delete rest.plainEn;
      delete rest.actor;
      // Порядок снятия блокировок разных людей (`blockers[].step`, 0.1.0-alpha.60).
      delete rest.step;
      return rest;
    }
    // Аддитивное поле строки поручения отчёта — что проверено и как (0.1.0-alpha.55).
    if (k === 'properties' && v && typeof v === 'object' && 'rejections' in v && 'costBound' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.verification;
      return rest;
    }
    // Аддитивное поле result/deliver — принятая версия против target ref (0.1.0-alpha.54).
    if (k === 'properties' && v && typeof v === 'object' && 'result' in v && 'delivery' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.target;
      // Что проверено и как у попытки результата (0.1.0-alpha.55).
      delete rest.verification;
      return rest;
    }
    // Аддитивное поле explain — сводка попыток по поручениям (0.1.0-alpha.52)
    // и сводка ревью плана и контрактов с числом сверх предела (0.1.0-alpha.54).
    if (k === 'properties' && v && typeof v === 'object' && 'diagnoses' in v && 'attempts' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.attempts;
      delete rest.attemptsTruncated;
      delete rest.reviews;
      delete rest.reviewsTruncated;
      // Что проверено и как по поручениям (0.1.0-alpha.55).
      delete rest.verification;
      return rest;
    }
    // Аддитивные поля status — снимок наблюдателя `--detail`, сводка ревью
    // плана и контрактов с числом сверх предела (0.1.0-alpha.54).
    if (k === 'properties' && v && typeof v === 'object' && 'detail' in v && 'stateVersion' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.detail;
      delete rest.reviews;
      delete rest.reviewsTruncated;
      // Кто двигает очередь (`runner`, 0.1.0-alpha.60).
      delete rest.runner;
      // Этап настройки до состояния (`setup`, 0.1.0-alpha.65).
      delete rest.setup;
      // Обновления по последней проверке `harness update --check` (0.1.0-alpha.60).
      delete rest.updates;
      // План выпуска ведущего или подсказка, что его нет (0.1.0-alpha.68).
      delete rest.outline;
      return rest;
    }
    // Аддитивные поля находки плана или контракта: счёт раундов и решение
    // ведущего или оператора (0.1.0-alpha.54).
    if (k === 'properties' && v && typeof v === 'object' && 'openedIn' in v && 'changedIn' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.rounds;
      delete rest.disposition;
      return rest;
    }
    // Аддитивная метка поздней находки ревью кода (0.1.0-alpha.60).
    if (k === 'properties' && v && typeof v === 'object' && 'severity' in v && 'late' in v) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.late;
      return rest;
    }
    // Аддитивное поле `joint.finished` — проверка прервана до результата gates (alpha.44).
    if (
      k === 'properties' &&
      v &&
      typeof v === 'object' &&
      'interrupted' in v &&
      'verificationId' in v &&
      'manifestDigest' in v
    ) {
      const rest = { ...(v as Record<string, unknown>) };
      delete rest.interrupted;
      return rest;
    }
    // Ослабленный предел области gates (20 → предел gates профиля).
    if (gateScope(v)) return { ...v, maxItems: 20 };
    return v;
  });
  assert.equal(sha256(h2), H2_DATA_SHA);
  assert.ok(
    JSON.stringify(data.doctor).includes('"checkouts"'),
    'doctor объявляет корень рабочих деревьев',
  );
  // Хеш H2 вырезает поля переноса evidence кандидата: объявление держит эта проверка.
  assert.ok(JSON.stringify(data).includes('"reused"'), 'gates.reused попытки');
  assert.ok(JSON.stringify(data).includes('"reusedFrom"'), 'attempt.gate.reusedFrom');
  assert.ok(JSON.stringify(data).includes('"reusedEvidence"'), 'evidence.reusedEvidence');
  // Хеш H2 вырезает target status и result (0.1.0-alpha.54): объявление держит эта проверка.
  assert.ok(JSON.stringify(data.status).includes('"commitsSinceAccepted"'), 'status: target');
  assert.ok(JSON.stringify(data.result).includes('"commitsSinceAccepted"'), 'result: target');
  // Хеш H2 вырезает проверку, простые блокировки и последний отказ (0.1.0-alpha.55).
  assert.ok(JSON.stringify(data.status).includes('"read-by-reviewer"'), 'status: verification');
  assert.ok(JSON.stringify(data.result).includes('"read-by-reviewer"'), 'result: verification');
  assert.ok(JSON.stringify(data.explain).includes('"read-by-reviewer"'), 'explain: verification');
  assert.ok(JSON.stringify(data.status).includes('"plainEn"'), 'status: blockers[].plain');
  assert.ok(JSON.stringify(data.status).includes('"lastFailure"'), 'status: lastFailure');
  // Хеш H2 вырезает пробу портов и предупреждения doctor: объявление держит эта проверка.
  assert.ok(JSON.stringify(data.doctor).includes('"leadSandbox"'), 'doctor: песочница ведущего');
  assert.ok(JSON.stringify(data.doctor).includes('"ports"'), 'doctor: проба портов');
  assert.ok(JSON.stringify(data.doctor).includes('"warnings"'), 'doctor: предупреждения');
  assert.ok(JSON.stringify(data.doctor).includes('"notes"'), 'doctor: ожидаемые состояния');
  assert.ok(JSON.stringify(data.doctor).includes('"models"'), 'doctor: модели по ролям');
  // Хеш H2 выше вырезает поля ведущего и ревью: объявление держит эта проверка.
  for (const field of ['"lead"', '"review"', '"runtimes"', '"warnings"'])
    assert.ok(JSON.stringify(data.init).includes(field), 'init объявляет ' + field);
  assert.ok(
    JSON.stringify(data['source-snapshot']).includes('"localContext"'),
    'source-snapshot объявляет пакеты контекста',
  );
  // Хеш H2 вырезает поля совместимости с Relay (0.1.0-alpha.60): объявление держит эта проверка.
  assert.ok(JSON.stringify(data.doctor).includes('"relay"'), 'doctor: сверка Relay');
  for (const command of ['source-check', 'source-snapshot', 'source-status'])
    assert.ok(
      JSON.stringify(data[command]).includes('"compatibility"'),
      command + ' объявляет compatibility',
    );
  assert.ok(
    JSON.stringify(data['source-status']).includes('"questions"'),
    'source-status: вопросы',
  );
  assert.ok(JSON.stringify(data['source-snapshot']).includes('"taskContext"'), 'снимок: контекст');
  // Хеш H2 выше вырезает `baseline`, поэтому только эта проверка держит объявление.
  for (const command of ['run', 'source-snapshot', 'source-status'])
    assert.ok(
      JSON.stringify(data[command]).includes('"baseline"'),
      command + ' объявляет baseline',
    );
  // Хеш H2 выше вырезает аддитивные варианты событий: объявление держит эта проверка.
  const eventVariants = (
    data.events as unknown as { properties: { events: { items: { oneOf: unknown[] } } } }
  ).properties.events.items.oneOf.map(eventTypeOf);
  for (const type of ADDITIVE_EVENT_TYPES)
    assert.ok(eventVariants.includes(type), 'events объявляет вариант ' + type);
  // Хеш H2 вырезает `interrupted` у joint.finished (alpha.44): объявление держит эта проверка.
  const finished = (
    data.events as unknown as {
      properties: { events: { items: { oneOf: Record<string, unknown>[] } } };
    }
  ).properties.events.items.oneOf.find((x) => eventTypeOf(x) === 'joint.finished');
  assert.ok(
    JSON.stringify(finished).includes('"interrupted"'),
    'joint.finished объявляет interrupted',
  );
  // Хеш H2 вырезает поля условного gate: объявление держит эта проверка.
  assert.ok(
    JSON.stringify(data).includes('"notApplicable"'),
    'данные объявляют неприменимость gate',
  );
  // Хеш H2 выше вырезает detail status и флаг --detail: объявление держит эта проверка.
  assert.ok(JSON.stringify(data.status).includes('"detail"'), 'status объявляет detail');
  // Хеш H2 вырезает сводку попыток status и explain: объявление держит эта проверка.
  assert.ok(JSON.stringify(data.status).includes('"attemptSummary"'), 'status: сводка попыток');
  assert.ok(JSON.stringify(data.explain).includes('"attempts"'), 'explain: сводка попыток');
  assert.ok(
    (cliCommands.status.args as readonly CliArgument[]).some(
      (a) => a.name === '--human' && a.value === 'flag' && !a.required,
    ),
    'status объявляет флаг --human',
  );
  // Хеш H2 вырезает вопрос исполнителя в status: объявление держит эта проверка.
  assert.ok(
    JSON.stringify(data.status).includes('"followUps"'),
    'status объявляет вопрос исполнителя',
  );
  assert.ok(
    (cliCommands.status.args as readonly CliArgument[]).some(
      (a) => a.name === '--detail' && a.value === 'flag' && !a.required,
    ),
    'status объявляет флаг --detail',
  );
  for (const value of ADDITIVE_ENUM_VALUES)
    assert.ok(JSON.stringify(data).includes(JSON.stringify(value)), value + ' объявлен');
  // Хеш H2 вырезает список процессов песочницы у doctor: объявление держит эта проверка.
  assert.ok(JSON.stringify(data.doctor).includes('"processList"'), 'doctor: sandbox.processList');
  // Хеш H2 вырезает пробы сигнала и браузера у doctor: объявление держит эта проверка.
  for (const field of ['"signal"', '"browser"'])
    assert.ok(JSON.stringify(data.doctor).includes(field), 'doctor: sandbox.' + field);
  // Хеш H2 вырезает поля слоя lean: объявление держит эта проверка.
  assert.ok(JSON.stringify(data.profile).includes('"gateTimeoutFloorMs"'), 'profile: граница gate');
  assert.ok(JSON.stringify(data.init).includes('"layers"'), 'init: слои профиля в manifest');
  // Хеш H2 вырезает запись `lean` manifest: объявление держит эта проверка.
  assert.ok(
    JSON.stringify(data.init).includes('"applied"'),
    'init: запись lean о прежних значениях в manifest',
  );
  // Хеш H2 выше вырезает `artifacts` gate задачи: объявление держит эта проверка.
  assert.ok(
    JSON.stringify(data.profile).includes('"artifacts"'),
    'gates профиля объявляют artifacts',
  );
});

test('F-B: справка каждой команды — <команда> --help, -h и help <команда>: stdout, exit 0, все флаги договора', () => {
  const call = (args: string[]) =>
    spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  for (const [name, c] of Object.entries(cliCommands)) {
    const help = call([name, '--help']);
    assert.equal(help.status, 0, name + ': ' + help.stderr);
    assert.ok(help.stdout.startsWith(`harness ${name} — `), name);
    for (const a of c.args) assert.ok(help.stdout.includes(a.name), `${name}: ${a.name}`);
  }
  // Флаги перед --help не разбираются: справка не требует обязательных.
  const short = call(['init', '--repository', '.', '-h']);
  assert.equal(short.status, 0);
  assert.match(short.stdout, /--lead-technical-answers/);
  assert.equal(call(['help', 'retry']).stdout, call(['retry', '--help']).stdout);
  // Значение строкового параметра `-h` справку не вызывает; ключи прототипа — не команды.
  const valued = call(['input-answer', '--text', '-h']);
  assert.equal(valued.status, 2);
  assert.doesNotMatch(valued.stdout, /^harness input-answer — /);
  const proto = call(['constructor', '--help']);
  assert.equal(proto.status, 2, proto.stderr);
  assert.doesNotMatch(proto.stderr, /at .*cli\.ts/);
  const meta = call(['help', '--help']);
  assert.equal(meta.status, 0);
  assert.match(meta.stderr, /Использование: harness <команда>/);
  const unknown = call(['help', 'nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /неизвестная команда: nope/);
});

test('H3-01: --help называет capabilities; прежние команды и capabilities отвечают тем же конвертом', () => {
  const help = spawnSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), cli, '--help'],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
  );
  assert.equal(help.status, 0);
  assert.match(help.stderr, /capabilities/);
  assert.ok(help.stderr.includes(cliCommands.capabilities.description));

  const cases: [string[], number, string[]][] = [
    [['version'], 0, ['apiVersion', 'command', 'ok', 'data']],
    [['capabilities'], 0, ['apiVersion', 'command', 'ok', 'data']],
    [['capabilities', '--human'], 2, ['apiVersion', 'command', 'ok', 'error']],
    [['capabilities', 'extra'], 2, ['apiVersion', 'command', 'ok', 'error']],
    [['profile', '--profile', 'npm-ci'], 0, ['apiVersion', 'command', 'ok', 'data']],
    // alpha.65: статус до настройки — данные этапа setup, а не NOT_FOUND.
    [
      ['status', '--state', '/nonexistent-harness-state'],
      0,
      ['apiVersion', 'command', 'ok', 'data'],
    ],
    [
      ['events', '--state', '/nonexistent-harness-state'],
      3,
      ['apiVersion', 'command', 'ok', 'error'],
    ],
    [['no-such-command'], 2, ['apiVersion', 'command', 'ok', 'error']],
  ];
  for (const [args, status, keys] of cases) {
    const r = harness(args);
    assert.equal(r.status, status, args.join(' ') + ' ' + r.stderr);
    assert.equal(r.stdout.trimEnd().split('\n').length, 1, 'ровно одна строка');
    assert.deepEqual(Object.keys(r.json), keys, args.join(' '));
  }
});
