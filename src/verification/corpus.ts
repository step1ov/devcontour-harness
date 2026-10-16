import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import {
  HarnessError,
  digestOf,
  type CheckSuite,
  type ExecutionTransaction,
  type ExecutionView,
  type WorkState,
} from '../contracts/index.ts';
import type { Engine } from '../engine/engine.ts';
import { contractDocuments, obligationOf, suiteBasis } from './checks.ts';

/**
 * Версионируемый корпус подтверждённых случаев.
 *
 * Воспроизведение из находки ревью — наблюдение, а не обязательство.
 * Обязательство хранится здесь: случай подтверждён закреплённым эталоном на
 * дефектном SHA, вошёл в неизменяемую добавочную версию корпуса, и поручение
 * приняло эту версию отдельной операцией. Корпус — локальная запись
 * владельца-репозитория (`check-suites`); в журнал событий тела случаев не
 * попадают.
 */
export type CorpusCase = CheckSuite['cases'][string];
export type CorpusVersion = CheckSuite['versions'][number];
export type CaseDecision = CheckSuite['decisions'][number];
export type PendingAdoption = CheckSuite['pending'][number];

/** Предел случая: вход и ожидание вместе. */
export const MAX_CASE_BYTES = 64 * 1024;
/** Предел корпуса целиком: запись переносится одним файлом. */
export const MAX_SUITE_BYTES = 1_500_000;

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Канонический JSON в рамках объявленного формата: ключи объектов
 * сортируются (порядок ключей в JSON не несёт смысла), порядок массивов
 * сохраняется, числа и строки не смешиваются — `1` и `"1"` разные входы.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  );
}
export function parseCanonical(text: string, what: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HarnessError('INVALID_INPUT', `${what}: не JSON`);
  }
  return canonicalJson(value);
}

/** Канонический файл корпуса версии — его байты дают digest и Git blob. */
export function corpusFile(suite: CheckSuite, cases: string[], number: number) {
  return (
    canonicalJson({
      version: 1,
      suite: suite.id,
      number,
      cases: cases.map((id) => {
        const c = suite.cases[id]!;
        return {
          id: c.id,
          property: c.property,
          input: JSON.parse(c.input) as unknown,
          expected: JSON.parse(c.expected) as unknown,
        };
      }),
    }) + '\n'
  );
}

/*
 * Убрать локальные пути из диагностики: исключение реализации или эталона
 * называет рабочие каталоги, домашний каталог и временные файлы, а запись
 * корпуса переносится между установками. Нормативные поля (вход, ожидание)
 * не трогаются.
 *
 * Основа — точные локальные корни этой машины (репозитории, каталог
 * состояния, временный и домашний каталоги): это подстановка строк, она не
 * задевает маршруты, URL и соседний текст и идемпотентна. Дополнительно —
 * узкая эвристика: токен без пробелов от типичного пользовательского корня и
 * file://. Путь вне известных корней по тексту не отличить от маршрута API,
 * поэтому он не очищается: в причины пишут смысл, а не пути.
 */
const PATH_CHARS = String.raw`[^\s"'\x60<>|,;)\]}]`;
// Слева от корня — не буква/цифра любого алфавита (с комбинируемыми знаками),
// не часть пути и не уже поставленная метка. JSON-экранированный перевод
// строки или табуляция (\n, \r, \t) — граница: исключение часто называет
// путь с новой строки.
const LEFT = String.raw`(?:(?<=\\[nrt])|(?<![\p{L}\p{M}\p{N}_.~/\\>-]))`;
const SEP = String.raw`(?:\\{1,2}|\/)`;
const USER_PATH = new RegExp(
  LEFT +
    String.raw`(?:\/(?:Users|home)\/|[A-Za-z]:${SEP}(?:Users|Documents and Settings)${SEP})${PATH_CHARS}*`,
  'giu',
);
// URL целиком: file:// — локальный путь, остальные схемы не трогаются вовсе.
const URL_TOKEN =
  /(?:(?<=\\[nrt])|(?<![\p{L}\p{N}_+.\\-]))([a-z][a-z0-9+.-]*):\/\/[^\s"'\x60<>]*/giu;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function scrubPlain(text: string, known: string[]) {
  let out = text;
  for (const root of known)
    out = out.replace(
      new RegExp(LEFT + escape(root) + String.raw`(?=$|[\\/\s"'\x60<>|,;:)\]}])`, 'gu'),
      '<local-path>',
    );
  return out.replace(USER_PATH, '<local-path>');
}
export function scrubLocalPaths(text: string, roots: string[] = []) {
  const known = [
    ...new Set(
      roots
        .map((r) => r.replace(/[\\/]+$/, ''))
        // Windows-корень встречается и в JSON-экранированном виде.
        .flatMap((r) => (r.includes('\\') ? [r, r.replace(/\\/g, '\\\\')] : [r])),
    ),
  ]
    .filter((r) => r.length > 1)
    .sort((x, y) => y.length - x.length);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(URL_TOKEN)) {
    out += scrubPlain(text.slice(last, m.index), known);
    if (m[1]!.toLowerCase() === 'file') {
      // Путь file:// кончается там же, где путь: обрамление ссылки остаётся.
      const path = new RegExp(String.raw`^file:\/\/${PATH_CHARS}*`, 'iu').exec(m[0])![0];
      out += '<local-path>' + scrubPlain(m[0].slice(path.length), known);
    } else out += m[0];
    last = m.index + m[0].length;
  }
  return out + scrubPlain(text.slice(last), known);
}

/** Локальные корни установки — и в заданном, и в разрешённом виде. */
export function localRoots(paths: (string | undefined)[]) {
  const given = [...paths, tmpdir(), homedir()].filter((x): x is string => !!x && isAbsolute(x));
  const resolved = given.map((x) => {
    try {
      return realpathSync(x);
    } catch {
      return x;
    }
  });
  // macOS: /tmp, /var, /etc — псевдонимы /private/…; диагностика может
  // назвать любое из двух написаний.
  const aliases = [...given, ...resolved].flatMap((x) =>
    x.startsWith('/private/')
      ? [x.slice('/private'.length)]
      : /^\/(?:tmp|var|etc)(?:\/|$)/.test(x)
        ? ['/private' + x]
        : [],
  );
  return [...new Set([...given, ...resolved, ...aliases])];
}

export const caseId = (property: string, input: string, basis: string) =>
  'K-' + sha256(JSON.stringify([property, input, basis])).slice(0, 32);

/**
 * Версия корпуса по ссылке. Digest однозначен; номер — только если в
 * истории одна версия с ним: после объединения клонов номера могут совпасть.
 */
export function versionOf(suite: CheckSuite, ref: { number?: number; digest?: string }) {
  if (ref.digest) {
    const found = suite.versions.find((v) => v.digest === ref.digest);
    if (!found)
      throw new HarnessError(
        'NOT_FOUND',
        `Версии ${ref.digest.slice(0, 12)} корпуса ${suite.id} нет`,
      );
    if (ref.number !== undefined && found.number !== ref.number)
      throw new HarnessError('INVALID_INPUT', 'Номер и digest версии корпуса не совпадают');
    return found;
  }
  const same = suite.versions.filter((v) => v.number === ref.number);
  if (!same.length)
    throw new HarnessError('NOT_FOUND', `Версии ${ref.number} корпуса ${suite.id} нет`);
  if (same.length > 1)
    throw new HarnessError(
      'INVALID_INPUT',
      `Номер версии ${ref.number} неоднозначен после объединения клонов: укажите digest`,
    );
  return same[0]!;
}

export { suiteBasis } from './checks.ts';

const head = (suite: CheckSuite) =>
  [...suite.versions]
    .sort((a, b) => a.number - b.number || a.createdAt.localeCompare(b.createdAt))
    .at(-1);

/**
 * Операции корпуса под транзакциями хранилища исполнения. Запись решения и
 * версии — одна транзакция; принятие версии поручениями меняет их
 * `checkVersion` и удержание в той же транзакции, что и запись корпуса.
 */
export class CorpusStore {
  constructor(
    readonly engine: Engine,
    /** Локальные корни для очистки переносимой диагностики. */
    readonly roots: string[] = [],
  ) {}

  private get store() {
    return this.engine.host.store;
  }
  private now() {
    return this.engine.clock();
  }
  private leaseMs() {
    return this.engine.policy.leaseMs * 4;
  }

  all(view: ExecutionView, repositoryId?: string) {
    return view.locals('check-suites', repositoryId).map((x) => x.value);
  }
  get(view: ExecutionView, id: string) {
    const suite = this.all(view).find((s) => s.id === id);
    if (!suite) throw new HarnessError('NOT_FOUND', 'Корпус проверок не найден: ' + id);
    return suite;
  }
  read(id: string) {
    return this.store.read((v) => structuredClone(this.get(v, id)));
  }
  private save(tx: ExecutionTransaction, suite: CheckSuite) {
    suite.revision++;
    if (Buffer.byteLength(JSON.stringify(suite)) > MAX_SUITE_BYTES * 2)
      throw new HarnessError('INVALID_INPUT', 'Запись корпуса превысила предел хранения');
    tx.putLocal('check-suites', suite.repositoryId, suite.id, suite);
  }

  /** Корпус договора поручения; создаётся (в памяти) при первом обращении. */
  suiteFor(view: ExecutionView, work: WorkState, property: string) {
    const contracts = contractDocuments(work.order, view);
    const found = obligationOf(contracts, property);
    if (!found)
      throw new HarnessError(
        'INVALID_INPUT',
        `Свойство ${property} не объявлено в договорах поручения`,
      );
    const contract = found.contract;
    const repositoryId = work.order.repositoryId;
    // Корпус принадлежит нормативному основанию договора, а не его ID: та же
    // редакция ID с другими правилами ответа, областью или эталоном получает
    // свой корпус, а случаи прежнего основания остаются его историей.
    const basis = suiteBasis(contract);
    const suites = this.all(view, repositoryId);
    const existing = suites.find((x) => x.contractId === contract.id && x.basis === basis);
    if (existing)
      return { suite: structuredClone(existing), contract, obligation: found.obligation };
    const first = 'KS-' + contract.id;
    const id = suites.some((x) => x.id === first) ? `${first}-${basis.slice(0, 12)}` : first;
    const suite: CheckSuite = {
      id,
      repositoryId,
      contractId: contract.id,
      contractDigest: digestOf(contract),
      gate: contract.checks!.gate,
      basis,
      cases: {},
      versions: [],
      decisions: [],
      adoptions: [],
      pending: [],
      operations: {},
      revision: 0,
    };
    return { suite, contract, obligation: found.obligation };
  }

  head(suite: CheckSuite) {
    return head(suite);
  }

  /** Случаи закреплённой версии и её канонический файл: их исполняет gate. */
  snapshot(view: ExecutionView, binding: NonNullable<WorkState['checkVersion']>) {
    const suite = this.get(view, binding.suite);
    const version = suite.versions.find((v) => v.digest === binding.digest);
    if (!version)
      throw new HarnessError(
        'APPROVAL_STALE',
        `Версия корпуса ${binding.suite}#${binding.number} не найдена или подменена`,
      );
    const content = corpusFile(suite, version.cases, version.number);
    if (sha256(content) !== version.digest)
      throw new HarnessError(
        'APPROVAL_STALE',
        `Корпус ${binding.suite}#${binding.number} не совпадает с digest`,
      );
    return {
      digest: version.digest,
      content,
      cases: version.cases.map((id) => ({ id, property: suite.cases[id]!.property })),
    };
  }

  /** Начать операцию подтверждения или вернуть её прежний исход по ключу. */
  begin(
    initial: CheckSuite,
    key: string,
  ): { done: CaseDecision; token?: undefined } | { token: string; done?: undefined } {
    return this.store.transact('checks.recorded', (tx) => {
      const pending = tx.control().reconfigure;
      if (pending && !pending.appliedAt)
        throw new HarnessError(
          'NOT_READY',
          `Операция ${pending.operation} применяет политику; повторите после неё`,
        );
      const suite = structuredClone(
        this.all(tx, initial.repositoryId).find((x) => x.id === initial.id) ?? initial,
      );
      const op = suite.operations[key];
      if (op?.status === 'completed')
        return { done: suite.decisions.find((d) => d.id === op.decision)! };
      if (op?.status === 'running' && op.leaseUntil! > this.now())
        throw new HarnessError('NOT_READY', 'Подтверждение с этим ключом уже выполняется');
      const token = randomUUID();
      suite.operations[key] = {
        key,
        status: 'running',
        token,
        leaseUntil: this.now() + this.leaseMs(),
        startedAt: new Date(this.now()).toISOString(),
      };
      this.save(tx, suite);
      return { token };
    });
  }
  heartbeat(suiteId: string, key: string, token: string) {
    this.store.transact('checks.recorded', (tx) => {
      const suite = structuredClone(this.get(tx, suiteId));
      const op = suite.operations[key];
      // Истёкший lease не продлевается: владение уже потеряно, и продление
      // вернуло бы право записи тому, кого мог сменить новый владелец.
      if (op?.token !== token || op.status !== 'running' || op.leaseUntil! <= this.now()) return;
      op.leaseUntil = this.now() + this.leaseMs();
      this.save(tx, suite);
    });
  }
  /** Снять владение операцией без решения: она завершилась отказом до проверки. */
  end(suiteId: string, key: string, token: string) {
    this.store.transact('checks.recorded', (tx) => {
      const found = this.all(tx).find((x) => x.id === suiteId);
      const op = found?.operations[key];
      if (!found || op?.token !== token || op.status !== 'running') return;
      const suite = structuredClone(found);
      delete suite.operations[key];
      this.save(tx, suite);
    });
  }
  private guard(suite: CheckSuite, key: string, token: string) {
    const op = suite.operations[key];
    if (op?.status !== 'running' || op.token !== token || op.leaseUntil! <= this.now())
      throw new HarnessError('LEASE_STALE', 'Владение операцией подтверждения утрачено');
  }

  /**
   * Записать решение и, если случай подтверждён, добавочную версию корпуса и
   * отложенное принятие её поручениями. Одна транзакция: решение без версии
   * или версия без решения не возникают. Конкурентная добавка не теряется:
   * новая версия строится от текущей головы с повторной проверкой конфликта
   * ожиданий.
   */
  record(
    initial: CheckSuite,
    key: string,
    token: string,
    decision: Omit<CaseDecision, 'id' | 'at' | 'caseId' | 'version'>,
    blobFor: (content: string) => string,
    adopt: { works: string[]; actor: string; manual?: boolean },
  ) {
    return this.store.transact('checks.recorded', (tx) => {
      const suite = structuredClone(
        this.all(tx, initial.repositoryId).find((x) => x.id === initial.id) ?? initial,
      );
      this.guard(suite, key, token);
      const at = new Date(this.now()).toISOString();
      const made: CaseDecision = { ...decision, id: 'CF-' + randomUUID(), at };
      let pending: PendingAdoption | undefined;
      if (made.outcome === 'confirmed') {
        // Случай сравнивается в каноническом виде, кто бы его ни записал.
        made.input = parseCanonical(made.input, 'вход случая');
        const id = caseId(made.property, made.input, suite.basis);
        const same = Object.values(suite.cases).find(
          (c) => c.property === made.property && c.input === made.input,
        );
        if (same && same.expected !== made.observed!.expected) {
          // Одинаковый вход с другим ожиданием — конфликт, а не выбор одного.
          made.outcome = 'inconclusive';
          made.reason = `конфликт ожиданий: корпус уже содержит ${same.id} с другим ответом`;
        } else {
          const top = head(suite);
          const perProperty = Object.values(suite.cases).filter(
            (c) => c.property === made.property,
          ).length;
          const limit = this.declarationOf(tx, suite)?.corpus?.maxCases ?? 500;
          if (!same && perProperty >= limit) {
            made.outcome = 'rejected';
            made.reason = `корпус свойства достиг предела ${limit} случаев: расширьте генератор или эталон обычным изменением договора`;
          } else {
            if (!same)
              suite.cases[id] = {
                id,
                property: made.property,
                input: made.input,
                expected: made.observed!.expected!,
                source: {
                  kind: 'oracle',
                  decision: made.id,
                  sha: made.source.sha,
                  ...(made.source.runId ? { runId: made.source.runId } : {}),
                  ...(made.source.taskId ? { taskId: made.source.taskId } : {}),
                  ...(made.claimed?.reproduction
                    ? { reproduction: made.claimed.reproduction }
                    : {}),
                },
                addedAt: at,
              };
            made.caseId = same?.id ?? id;
            if (!top?.cases.includes(made.caseId)) {
              // Версия — все подтверждённые случаи корпуса.
              const cases = Object.values(suite.cases)
                .sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id))
                .map((c) => c.id);
              const number = Math.max(0, ...suite.versions.map((v) => v.number)) + 1;
              const content = corpusFile(suite, cases, number);
              if (Buffer.byteLength(content) > MAX_SUITE_BYTES)
                throw new HarnessError('INVALID_INPUT', 'Корпус превысил предел размера');
              suite.versions.push({
                number,
                digest: sha256(content),
                previous: top?.digest ?? null,
                cases,
                blob: blobFor(content),
                createdAt: at,
                reason: `подтверждён случай ${made.caseId} свойства ${made.property}`,
                decisions: [made.id],
              });
            }
            made.version = head(suite)!.number;
            if (adopt.works.length) {
              pending = {
                id: 'AD-' + randomUUID(),
                version: made.version,
                digest: head(suite)!.digest,
                ...(adopt.manual ? { awaitingOperator: true } : {}),
                tasks: adopt.works,
                status: 'waiting',
                results: {},
                actor: adopt.actor,
                reason: made.reason,
                requestedAt: at,
              };
              suite.pending.push(pending);
              if (pending.awaitingOperator) this.holdForOperator(tx, pending, suite.id);
            }
          }
        }
      }
      suite.decisions.push(made);
      suite.operations[key] = {
        key,
        status: 'completed',
        startedAt: suite.operations[key]!.startedAt,
        decision: made.id,
      };
      this.save(tx, suite);
      return { decision: made, suite, pending };
    });
  }
  private declarationOf(view: ExecutionView, suite: CheckSuite) {
    return view
      .locals('contract-documents')
      .map((x) => x.value)
      .find((c) => c.id === suite.contractId && digestOf(c) === suite.contractDigest)?.checks;
  }

  /**
   * Принять версию корпуса явно перечисленными поручениями.
   *
   * Посередине активной попытки принятие недопустимо: выдача поручения
   * удерживается, и принятие завершится после окончания попытки. Принятое
   * поручение не меняется. Повтор идемпотентен; снимается только собственное
   * удержание операции.
   */
  adopt(suiteId: string, pendingId: string) {
    return this.store.transact('checks.adopted', (tx) => {
      const suite = structuredClone(this.get(tx, suiteId));
      const pending = suite.pending.find((p) => p.id === pendingId);
      if (!pending) throw new HarnessError('NOT_FOUND', 'Принятие версии не найдено');
      if (pending.status === 'completed') return { pending, suite };
      if (pending.awaitingOperator)
        throw new HarnessError(
          'APPROVAL_REQUIRED',
          `Принятие ${pending.id} ждёт ручного технического подтверждения (operator mode)`,
        );
      const version = versionOf(suite, { number: pending.version, digest: pending.digest });
      const operation = 'checks:' + pending.id;
      const waiting: string[] = [];
      const accepted: string[] = [];
      for (const id of pending.tasks) {
        if (pending.results[id] && !pending.results[id].startsWith('ждёт')) continue;
        const w = tx.work(id);
        const verdict = this.adoptable(suite, w, version);
        if (verdict === 'busy') {
          if (w!.hold && w!.hold.operation !== operation) {
            pending.results[id] = `ждёт: поручение удерживает ${w!.hold.operation}`;
            waiting.push(id);
            continue;
          }
          if (!w!.hold) {
            tx.putWork({
              ...w!,
              hold: {
                operation,
                reason: `Принимается версия корпуса ${suite.id}#${version.number}`,
              },
            });
            tx.emit({
              type: 'work.held',
              graphId: w!.graphId,
              workId: id,
              payload: {
                operation,
                reason: `Принимается версия корпуса ${suite.id}#${version.number}`,
                released: false,
              },
            });
          }
          pending.results[id] = 'ждёт окончания попытки';
          waiting.push(id);
          continue;
        }
        if (verdict !== 'ok') {
          pending.results[id] = verdict;
          if (w?.hold?.operation === operation) this.release(tx, w, operation);
          continue;
        }
        const from = w!.checkVersion
          ? { number: w!.checkVersion.number, digest: w!.checkVersion.digest }
          : null;
        const held = w!.hold?.operation === operation;
        tx.putWork({
          ...w!,
          checkVersion: { suite: suite.id, number: version.number, digest: version.digest },
          ...(held ? { hold: undefined } : {}),
        });
        if (held)
          tx.emit({
            type: 'work.held',
            graphId: w!.graphId,
            workId: id,
            payload: { operation, reason: 'версия корпуса принята', released: true },
          });
        suite.adoptions.push({
          id: 'AA-' + randomUUID(),
          taskId: id,
          from,
          to: { number: version.number, digest: version.digest },
          actor: pending.actor,
          reason: scrubLocalPaths(pending.reason, this.roots),
          operation: pending.id,
          at: new Date(this.now()).toISOString(),
        });
        pending.results[id] = 'принята';
        accepted.push(id);
      }
      if (!waiting.length) {
        pending.status = 'completed';
        pending.completedAt = new Date(this.now()).toISOString();
      }
      this.save(tx, suite);
      tx.emit({
        type: 'corpus.adopted',
        payload: {
          suite: suite.id,
          pending: pending.id,
          version: version.number,
          digest: version.digest,
          status: pending.status,
          accepted,
        },
      });
      return { pending, suite };
    });
  }
  private release(tx: ExecutionTransaction, w: WorkState, operation: string) {
    tx.putWork({ ...w, hold: undefined });
    tx.emit({
      type: 'work.held',
      graphId: w.graphId,
      workId: w.id,
      payload: { operation, reason: 'удержание снято', released: true },
    });
  }
  private adoptable(suite: CheckSuite, w: WorkState | undefined, version: CorpusVersion): string {
    if (!w) return 'поручение не найдено';
    if (!w.order.contracts.some((c) => c.id === suite.contractId))
      return 'поручение не привязано к контракту этого корпуса';
    if (!w.order.properties?.length)
      return 'механизм договора проверки для поручения не включён: включение проходит ревью плана';
    if (w.status === 'done') return 'поручение уже принято: его история не меняется';
    if (w.status === 'cancelled') return 'поручение отменено';
    if (!w.approvedDigest) return 'поручение не согласовано';
    if (w.checkVersion && w.checkVersion.suite !== suite.id)
      return `поручение закреплено за другим корпусом ${w.checkVersion.suite}`;
    if (w.checkVersion) {
      const current = suite.versions.find((v) => v.digest === w.checkVersion!.digest);
      if (current && version.cases.every((id) => current.cases.includes(id))) return 'принята';
      // Принятие не сужает корпус поручения: версия из другой ветки истории
      // без её случаев понизила бы обязательный набор.
      if (current && !current.cases.every((id) => version.cases.includes(id)))
        return 'версия не содержит всех случаев, уже принятых поручением';
    }
    if (w.activeRunId) return 'busy';
    return 'ok';
  }

  /**
   * Явно принять уже существующую версию корпуса перечисленными поручениями.
   * Новых случаев не создаёт. В operator mode агент только запрашивает.
   */
  request(
    suiteId: string,
    ref: { number?: number; digest?: string },
    works: string[],
    actor: string,
    reason: string,
    manual = false,
  ) {
    const pending = this.store.transact('checks.awaiting-operator', (tx) => {
      const suite = structuredClone(this.get(tx, suiteId));
      const version = versionOf(suite, ref);
      if (!works.length)
        throw new HarnessError('INVALID_INPUT', 'Перечислите поручения, принимающие версию');
      const made: PendingAdoption = {
        id: 'AD-' + randomUUID(),
        version: version.number,
        digest: version.digest,
        tasks: works,
        status: 'waiting',
        results: {},
        actor,
        reason: scrubLocalPaths(reason, this.roots),
        requestedAt: new Date(this.now()).toISOString(),
        ...(manual ? { awaitingOperator: true } : {}),
      };
      suite.pending.push(made);
      if (manual) this.holdForOperator(tx, made, suite.id);
      this.save(tx, suite);
      return made;
    });
    if (manual) return { pending, suite: this.read(suiteId) };
    return this.adopt(suiteId, pending.id);
  }
  /**
   * В operator mode выдача перечисленных незавершённых поручений удерживается
   * до ручного подтверждения: иначе следующая попытка шла бы без нового корпуса.
   */
  private holdForOperator(tx: ExecutionTransaction, pending: PendingAdoption, suiteId: string) {
    for (const id of pending.tasks) {
      const w = tx.work(id);
      if (!w || w.hold || ['done', 'cancelled'].includes(w.status)) continue;
      const reason = `Принятие версии корпуса ${suiteId} ждёт подтверждения оператора`;
      tx.putWork({ ...w, hold: { operation: 'checks:' + pending.id, reason } });
      tx.emit({
        type: 'work.held',
        graphId: w.graphId,
        workId: id,
        payload: { operation: 'checks:' + pending.id, reason, released: false },
      });
    }
  }
  /** Ручное техническое подтверждение принятия (operator mode). */
  approveAdoption(suiteId: string, pendingId: string) {
    this.store.transact('checks.adopted', (tx) => {
      const suite = structuredClone(this.get(tx, suiteId));
      const pending = suite.pending.find((p) => p.id === pendingId);
      if (!pending) throw new HarnessError('NOT_FOUND', 'Принятие версии не найдено');
      if (!pending.awaitingOperator) return;
      delete pending.awaitingOperator;
      pending.actor += ' + operator';
      this.save(tx, suite);
    });
    return this.adopt(suiteId, pendingId);
  }
  /** Продолжить отложенные принятия: поручение освободилось. Ничего не запускает. */
  resume() {
    const waiting = this.store.read((v) =>
      this.all(v).flatMap((s) =>
        s.pending
          .filter((p) => p.status === 'waiting' && !p.awaitingOperator)
          .map((p) => [s.id, p.id] as const),
      ),
    );
    for (const [suite, pending] of waiting)
      try {
        this.adopt(suite, pending);
      } catch {
        // Принятие повторится на следующем шаге; причина остаётся в записи.
      }
  }
  /**
   * Снять удержание операции принятия. Только своё: чужая операция
   * чужое удержание не снимает.
   */
  abandon(suiteId: string, pendingId: string, operation: string) {
    return this.store.transact('checks.adoption-abandoned', (tx) => {
      const suite = structuredClone(this.get(tx, suiteId));
      const pending = suite.pending.find((p) => p.id === pendingId);
      if (!pending) throw new HarnessError('NOT_FOUND', 'Принятие версии не найдено');
      if (operation !== 'checks:' + pending.id)
        throw new HarnessError('INVALID_INPUT', 'Операция не владеет этим принятием');
      for (const w of tx.works())
        if (w.hold?.operation === operation) this.release(tx, w, operation);
      pending.status = 'completed';
      pending.completedAt = new Date(this.now()).toISOString();
      for (const id of pending.tasks)
        if (pending.results[id]?.startsWith('ждёт')) pending.results[id] = 'отменено';
      this.save(tx, suite);
      return { pending: pending.id };
    });
  }
}

/**
 * Переносимая форма корпуса. Локальные операции (lease, token, отложенные
 * принятия) и исполняемая конфигурация (команда checker) не переносятся:
 * команда остаётся локальной политикой, и ссылка на artifact сама по себе
 * права исполнения не даёт.
 */
export type PortableSuite = Omit<
  CheckSuite,
  'cases' | 'pending' | 'operations' | 'revision' | 'decisions'
> & {
  cases: CorpusCase[];
  decisions: (Omit<CaseDecision, 'method'> & {
    method?: Omit<NonNullable<CaseDecision['method']>, 'command'>;
  })[];
};
export function portableSuite(suite: CheckSuite, roots: string[] = []): PortableSuite {
  return scrubPortable(
    {
      id: suite.id,
      repositoryId: suite.repositoryId,
      contractId: suite.contractId,
      contractDigest: suite.contractDigest,
      gate: suite.gate,
      basis: suite.basis,
      cases: Object.values(suite.cases).sort((a, b) => a.id.localeCompare(b.id)),
      decisions: suite.decisions.map(({ method, ...d }) =>
        method
          ? {
              ...d,
              method: {
                gate: method.gate,
                artifacts: method.artifacts,
                contract: method.contract,
                basis: method.basis,
              },
            }
          : d,
      ),
      versions: suite.versions,
      adoptions: suite.adoptions,
    },
    roots,
  );
}

/**
 * Диагностические поля проходят очистку путей и на экспорте, и на чтении:
 * запись прежней версии могла сохранить их до появления очистки. Очистка
 * идемпотентна, нормативные поля (вход, ожидание, digest) не меняются.
 */
export function scrubPortable(suite: PortableSuite, roots: string[] = []): PortableSuite {
  const scrub = (text: string) => scrubLocalPaths(text, roots);
  return {
    ...suite,
    decisions: suite.decisions.map((d) => ({
      ...d,
      reason: scrub(d.reason),
      ...(d.observed
        ? {
            observed: {
              ...d.observed,
              ...(d.observed.actual !== undefined ? { actual: scrub(d.observed.actual) } : {}),
            },
          }
        : {}),
      ...(d.claimed
        ? {
            claimed: {
              ...d.claimed,
              actual: d.claimed.actual === null ? null : scrub(d.claimed.actual),
            },
          }
        : {}),
    })),
    versions: suite.versions.map((v) => ({ ...v, reason: scrub(v.reason) })),
    adoptions: suite.adoptions.map((a) => ({ ...a, reason: scrub(a.reason) })),
  };
}

/**
 * Проверка переносимого корпуса: каждая версия собирается из своих случаев в
 * канонический файл, и его digest совпадает с записанным. Запись, где версия
 * ссылается на отсутствующий случай или подменён digest, не принимается.
 */
export function verifySuite(suite: PortableSuite) {
  const local: CheckSuite = {
    ...suite,
    cases: Object.fromEntries(suite.cases.map((c) => [c.id, c])),
    decisions: suite.decisions as CaseDecision[],
    pending: [],
    operations: {},
    revision: 0,
  };
  const contents = new Map<string, string>();
  for (const v of suite.versions) {
    if (v.cases.some((id) => !local.cases[id]))
      throw new HarnessError(
        'INVALID_INPUT',
        `Версия ${v.number} корпуса ${suite.id} ссылается на отсутствующие случаи`,
      );
    const content = corpusFile(local, v.cases, v.number);
    if (sha256(content) !== v.digest)
      throw new HarnessError(
        'INVALID_INPUT',
        `Digest версии ${v.number} корпуса ${suite.id} не совпадает с её случаями`,
      );
    contents.set(v.digest, content);
  }
  for (const c of suite.cases)
    if (c.id !== caseId(c.property, c.input, suite.basis))
      throw new HarnessError(
        'INVALID_INPUT',
        `Id случая ${c.id} корпуса ${suite.id} не соответствует его входу и основанию`,
      );
  return contents;
}
