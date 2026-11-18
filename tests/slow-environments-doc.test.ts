/**
 * Страница `docs/slow-environments.md`: каждое поле таблицы «Пределы
 * времени» существует в схеме политики, а умолчание в таблице — то, что
 * даёт схема (`нет` — умолчания нет); заметка о тёплом стенде помечена как
 * исследование.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p: string) => fileURLToPath(new URL('../' + p, import.meta.url));
const doc = readFileSync(root('docs/slow-environments.md'), 'utf8');
const schema = JSON.parse(
  readFileSync(root('schemas/execution-policy.schema.json'), 'utf8'),
) as Node;

interface Node {
  properties?: Record<string, Node>;
  items?: Node;
  oneOf?: Node[];
  anyOf?: Node[];
  default?: unknown;
}

/** Узел схемы по пути `a.b[].c`; варианты `oneOf`/`anyOf` — первый, где есть свойство. */
function resolve(path: string): Node | undefined {
  let nodes: Node[] = [schema];
  for (const raw of path.split('.')) {
    const array = raw.endsWith('[]');
    const key = array ? raw.slice(0, -2) : raw;
    const expand = (n: Node): Node[] => [
      n,
      ...(n.oneOf ?? []).flatMap(expand),
      ...(n.anyOf ?? []).flatMap(expand),
    ];
    const next = nodes
      .flatMap(expand)
      .map((n) => n.properties?.[key])
      .filter((n): n is Node => !!n);
    if (!next.length) return undefined;
    nodes = array
      ? next
          .flatMap(expand)
          .map((n) => n.items)
          .filter((n): n is Node => !!n)
      : next;
    if (!nodes.length) return undefined;
  }
  return nodes[0];
}

test('slow-environments: поля таблицы пределов существуют в схеме политики с теми же умолчаниями', () => {
  const section = doc.split('## Пределы времени')[1]!.split('\n## ')[0]!;
  const rows = section
    .split('\n')
    .map((l) => /^\| `([^`]+)`\s*\| (`[^`]+`|нет)\s*\|/.exec(l))
    .filter((m): m is RegExpExecArray => !!m);
  assert.ok(rows.length >= 8, 'таблица найдена');
  for (const [, path, cell] of rows) {
    const node = resolve(path!);
    assert.ok(node, `поле ${path} есть в схеме политики`);
    if (cell === 'нет') assert.equal('default' in node, false, `${path}: умолчания нет`);
    else assert.deepEqual(node.default, JSON.parse(cell!.slice(1, -1)), `${path}: умолчание`);
  }
});

test('slow-environments: поля из текста существуют в схеме; заметка — исследование', () => {
  for (const path of [
    'repositories[].gates[].when.paths',
    'repositories[].gates[].dependsOn',
    'repositories[].gates[].resources',
    'resources',
    'repositories[].prepare',
    'repositories[].lifecycle',
    'lifecycle',
    'repositories[].dependencyStore',
    'integrationReuse',
  ])
    assert.ok(resolve(path), path);
  assert.equal(resolve('repositories[].gates[].when')?.default, undefined);
  assert.deepEqual(resolve('resources')?.default, []);
  assert.deepEqual(resolve('repositories[].prepare')?.default, []);
  assert.match(doc, /## Исследование: тёплый стенд/);
  assert.match(doc, /исследовательская заметка, а не обязательство/);
});
