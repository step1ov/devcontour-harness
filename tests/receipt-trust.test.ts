/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return --
 * Генератор подделывает переносимый результат как сырой JSON по JSON Schema.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runResultSchema, type RunResult } from '../src/contracts/index.ts';
import {
  receiptTrust,
  resultProblems,
  type ReceiverContext,
} from '../src/verification/acceptance.ts';
import { sha } from './engine-fixture.ts';
import { acceptedProperty, maximalAttempt } from './receipt-fixtures.ts';

/**
 * Модель доверия получателя (`receiptTrust`) как проверяемое утверждение.
 * Для каждого поля принятого результата строится подделка — другое значение,
 * удаление необязательного поля, повтор и удаление элемента массива — и
 * сверяется с категорией поля: `expected`/`consistency` — отказ, `informative`
 * — тот же вердикт, `schema` — подделку отвергает схема. Покрытие таблицы
 * сверяется с JSON Schema результата целиком.
 */
const schema = JSON.parse(
  readFileSync(new URL('../schemas/run-result.schema.json', import.meta.url), 'utf8'),
);
const accepted = schema.oneOf.find((v: any) => v.properties.outcome.const === 'accepted');

/** Пути JSON Schema: `a.b`, массив `a` и его элемент `a[]`. */
function schemaPaths(node: any, path = '', out = new Map<string, any>()) {
  if (node.type === 'object' && node.properties)
    for (const [key, child] of Object.entries<any>(node.properties)) {
      const p = path ? `${path}.${key}` : key;
      out.set(p, child);
      schemaPaths(child, p, out);
    }
  else if (node.type === 'array') {
    out.set(path + '[]', node.items);
    schemaPaths(node.items, path + '[]', out);
  }
  return out;
}
const paths = schemaPaths(accepted);
/** Контейнеры верхнего уровня: их поля описаны по отдельности. */
const containers = new Set(['source', 'inputs', 'checked', 'shas']);

/** Поля, отсутствие которых получатель заменяет своим ожиданием. */
const absentEquivalent = new Set(['inputs.writer', 'inputs.requiredGates']);

test('Таблица модели доверия в docs/contracts.md совпадает с кодом', () => {
  const docs = readFileSync(new URL('../docs/contracts.md', import.meta.url), 'utf8');
  const label = {
    expected: 'ожидание получателя',
    consistency: 'согласованность',
    informative: 'сведение',
    schema: 'схема',
  } as const;
  // Строки таблицы без выравнивания пробелами (его задаёт форматирование).
  const rows = new Set(
    docs
      .split('\n')
      .filter((l) => l.startsWith('| `'))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim())
          .join('|'),
      ),
  );
  for (const [path, [trust, rule]] of Object.entries(receiptTrust))
    assert.ok(rows.has(`\`${path}\`|${label[trust]}|${rule}`), 'строка таблицы: ' + path);
});

test('Модель доверия описывает каждое поле JSON Schema принятого результата и только их', () => {
  const described = new Set(Object.keys(receiptTrust));
  const missing = [...paths.keys()].filter((p) => !containers.has(p) && !described.has(p));
  const unknown = [...described].filter((p) => !paths.has(p));
  assert.deepEqual(missing, [], 'поля без категории');
  assert.deepEqual(unknown, [], 'категории несуществующих полей');
});

const norm = (path: (string | number)[]) =>
  path.reduce<string>(
    (acc, k) => (typeof k === 'number' ? acc + '[]' : acc ? `${acc}.${k}` : k),
    '',
  );

/** Значения, которыми подменяется лист, — допустимые схемой кандидаты. */
function candidates(value: unknown, node: any): unknown[] {
  if (node?.const !== undefined) return ['x-' + String(value)];
  if (node?.enum) return node.enum.filter((v: unknown) => v !== value);
  if (typeof value === 'boolean') return [!value];
  if (typeof value === 'number') return [value + 1];
  if (typeof value !== 'string') return [];
  if (/^[a-f0-9]{40}$/.test(value)) return [value === sha('e') ? sha('9') : sha('e')];
  if (/^[a-f0-9]{64}$/.test(value))
    return [value === 'e'.repeat(64) ? '9'.repeat(64) : 'e'.repeat(64)];
  if (/^\d{4}-\d\d-\d\dT/.test(value)) return ['2031-01-01T00:00:00.000Z'];
  return [value + '-x', 'x' + value];
}

interface Forgery {
  path: string;
  how: string;
  forged: unknown;
  /** Категория, по которой судится подделка. */
  trust: 'expected' | 'consistency' | 'informative' | 'schema';
}

/** Все подделки одного поля, которые допускает схема (или пометка, что не допускает). */
function forgeries(result: RunResult, testId: string): Forgery[] {
  const out: Forgery[] = [];
  const at = (root: any, path: (string | number)[]) => path.reduce((o, k) => o[k], root);
  const trustOf = (path: (string | number)[], p: string) => {
    let trust = (receiptTrust as Record<string, readonly [Forgery['trust'], string]>)[p]?.[0];
    assert.ok(trust, 'поле без категории: ' + p);
    // Элементы списка тестов, кроме названного testcase, — сведения.
    const testsAt = path.findIndex((k, i) => k === 'tests' && typeof path[i + 1] === 'number');
    if (testsAt >= 0 && path.length > testsAt + 1) {
      const element = at(result, path.slice(0, testsAt + 2));
      if (element.id !== testId) trust = 'informative';
    }
    // Сведения о свойствах у записи потребителя: допустим только legacy без
    // манифеста — любая подмена противоречит виду записи.
    if (path[0] === 'evidence' && path[2] === 'property' && at(result, path.slice(0, 2)).consumer)
      trust = 'consistency';
    return trust;
  };
  const visit = (value: any, path: (string | number)[]) => {
    const p = norm(path);
    if (path.length && path[0] === 'outcome') return;
    if (Array.isArray(value)) {
      if (path.length && value.length) {
        const mutate = (
          target: string,
          trust: Forgery['trust'],
          how: string,
          change: (arr: any[]) => void,
        ) => {
          const forged = structuredClone(result) as any;
          change(at(forged, path));
          out.push({ path: target, how, forged, trust });
        };
        // Массив целиком — по категории массива; элементы — по категории элемента
        // (у списка тестов — первого элемента, названного testcase).
        mutate(p, trustOf(path, p), 'пустой массив', (arr) => arr.splice(0));
        const element = trustOf([...path, 0], p + '[]');
        mutate(p + '[]', element, 'повтор первого элемента', (arr) =>
          arr.push(structuredClone(arr[0])),
        );
        mutate(p + '[]', element, 'без первого элемента', (arr) => arr.shift());
      }
      value.forEach((v, i) => visit(v, [...path, i]));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) visit(v, [...path, k]);
      return;
    }
    const trust = trustOf(path, p);
    const node = paths.get(p);
    let schemaValid = false;
    for (const candidate of candidates(value, node)) {
      let forged = structuredClone(result) as any;
      const parent = at(forged, path.slice(0, -1));
      const key = path.at(-1)!;
      // Свежесть: значение головы при fresh=false — наблюдение; подделка —
      // голова, равная снимку (fresh противоречит сравнению).
      if (p.endsWith('freshness[].head') && parent.fresh === false) parent[key] = parent.snapshot;
      // ID записи: подделка — совпадение с ID другой записи.
      else if (p === 'evidence[].id')
        parent[key] = forged.evidence.find((e: any) => e.id !== value).id;
      else parent[key] = candidate;
      if (!runResultSchema.safeParse(forged).success) continue;
      forged = runResultSchema.parse(forged);
      schemaValid = true;
      out.push({ path: p, how: `значение ${JSON.stringify(parent[key])}`, forged, trust });
      if (!node?.enum) break;
    }
    if (!schemaValid)
      out.push({ path: p, how: 'нет допустимой схемой подмены', forged: null, trust });
  };
  visit(result, []);
  // Удаление необязательных полей.
  const removable = (node: any, path: (string | number)[], value: any) => {
    if (!node || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => removable(node.items, [...path, i], v));
      return;
    }
    for (const [k, child] of Object.entries<any>(node.properties ?? {})) {
      if (!(k in value)) continue;
      const next = [...path, k];
      if (!(node.required ?? []).includes(k)) {
        const p = norm(next);
        const forged = structuredClone(result) as any;
        delete at(forged, path)[k];
        out.push({
          path: p,
          how: 'поле удалено',
          forged,
          // Запись потребителя без сведений о свойствах целиком остаётся допустимой.
          trust:
            absentEquivalent.has(p) ||
            (next.length === 3 &&
              next[0] === 'evidence' &&
              next[2] === 'property' &&
              at(result, next.slice(0, 2)).consumer)
              ? 'informative'
              : trustOf(next, p),
        });
      }
      removable(child, next, value[k]);
    }
  };
  removable(accepted, [], result);
  return out;
}

function judge(result: RunResult, context: ReceiverContext, testId: string) {
  assert.deepEqual(resultProblems(result, context), [], 'исходный результат подтверждается');
  const failures: string[] = [];
  const visited = new Set<string>();
  for (const f of forgeries(result, testId)) {
    visited.add(f.path);
    if (f.forged === null) {
      if (f.trust !== 'schema') failures.push(`${f.path}: ${f.how}`);
      continue;
    }
    const parsed = runResultSchema.safeParse(f.forged);
    if (!parsed.success) {
      failures.push(`${f.path}: подделка «${f.how}» вне схемы`);
      continue;
    }
    const problems = resultProblems(parsed.data, context);
    if (f.trust === 'informative' && problems.length)
      failures.push(`${f.path} (informative), ${f.how}: изменён вердикт — ${problems.join('; ')}`);
    if ((f.trust === 'expected' || f.trust === 'consistency') && !problems.length)
      failures.push(`${f.path} (${f.trust}), ${f.how}: подделка подтверждена`);
    if (f.trust === 'schema') failures.push(`${f.path}: схема допустила подмену «${f.how}»`);
  }
  return { failures, visited };
}

/** Сведения, которых нет в штатном результате: изменение их вердикт не меняет. */
function withInformative(result: RunResult) {
  const r = structuredClone(result) as any;
  r.inputs.consumerVersion = 'host-1';
  r.findings = [{ severity: 'note', message: 'замечание', path: 'src/a.js', line: 3, rule: 'r-1' }];
  r.limitations = ['не проверено на устройстве'];
  for (const e of r.evidence) if (e.kind === 'review') e.reviewer.model = 'reviewer-model';
  return runResultSchema.parse(r);
}

/** Необязательные поля доказательства, отсутствующие в штатном результате: их подделка — отказ. */
function proofExtras(result: RunResult, context: ReceiverContext) {
  const failures: string[] = [];
  const variants: Record<string, (r: any) => void> = {
    'evidence[].testsTruncated': (r) =>
      (r.evidence.find((e: any) => e.tests).testsTruncated = true),
    'evidence[].tests[].opaque': (r) =>
      (r.evidence
        .find((e: any) => e.tests)
        .tests.find((t: any) => t.id === 'required-test').opaque = true),
  };
  for (const [path, change] of Object.entries(variants)) {
    const forged = structuredClone(result) as any;
    change(forged);
    if (!resultProblems(runResultSchema.parse(forged), context).length)
      failures.push(`${path}: подделка подтверждена`);
  }
  return { failures, visited: new Set(Object.keys(variants)) };
}

const visitedAll = new Set<string>();

test('Каждое поле максимального результата: подделка expected/consistency — отказ, informative — тот же вердикт', () => {
  const f = maximalAttempt();
  const { result, context } = f.done();
  f.store.close();
  const enriched = withInformative(result);
  const { failures, visited } = judge(enriched, context, 'required-test');
  const extras = proofExtras(enriched, context);
  for (const p of [...visited, ...extras.visited]) visitedAll.add(p);
  assert.deepEqual([...failures, ...extras.failures], []);
  // Сведения не меняют вердикт и внутри списка тестов.
  const sibling = structuredClone(enriched) as any;
  sibling.evidence.find((e: any) => e.tests).tests.find((t: any) => t.id === 'other-test').status =
    'failed';
  assert.deepEqual(resultProblems(runResultSchema.parse(sibling), context), []);
});

test('Каждое поле результата с договором проверки (манифест, корпус): подделка — отказ', () => {
  const { result, context } = acceptedProperty();
  const { failures, visited } = judge(result, context, '');
  for (const p of visited) visitedAll.add(p);
  assert.deepEqual(failures, []);
});

test('Фикстуры генератора покрывают все поля модели доверия', () => {
  const uncovered = Object.keys(receiptTrust).filter((p) => p !== 'outcome' && !visitedAll.has(p));
  assert.deepEqual(uncovered, []);
});
