// Проверка модели compose до smoke (alpha.68, P6-16): Docker не публикует
// порты контейнера, подключённого только к сетям `internal: true`, — порты на
// 127.0.0.1 недоступны, smoke падает на готовности без явной причины.
// `doctor` находит файлы compose, которые называют шаги lifecycle политики
// (`docker|podman compose -f <file>`, `docker-compose -f`, мост
// `compose-bridge.mjs --compose <file>` с его умолчанием), и проверяет их.
//
// Зависимости YAML в пакете нет: файл читается консервативным разбором
// блочного подмножества YAML (отображения, последовательности, скаляры,
// простые `[a, b]` и `{k: v}`, якоря `&a`, ссылки `*a` и слияние `<<: *a`).
// Теги, несколько документов, табуляция и прочее вне подмножества — итог
// `unknown` (проверка пропущена, строка в notes), а не догадка: ошибку
// называем только по тому, что разобрали точно.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { ExecutionPolicy } from '../contracts/index.ts';

/** Наибольший размер файла compose, который проверяется. */
const MAX_BYTES = 1024 * 1024;
/** Умолчание моста compose примера (`--compose`). */
const BRIDGE_DEFAULT = '.harness/compose.acceptance.yml';
const BRIDGE = /(^|[/\\])compose-bridge\.mjs$/;
/** Файлы compose по умолчанию, если команда compose не называет `-f`. */
const COMPOSE_DEFAULTS = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yml',
  'docker-compose.yaml',
];

type Yaml = string | null | Yaml[] | { [key: string]: Yaml };

class Unsupported extends Error {}

interface Line {
  indent: number;
  text: string;
  no: number;
}

/** Строка без комментария `#` вне кавычек; без хвостовых пробелов. */
function stripComment(text: string): string {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"') i++;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]!))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function linesOf(source: string): Line[] {
  const out: Line[] = [];
  let started = false;
  source.split(/\r?\n/).forEach((raw, index) => {
    const lead = /^[ \t]*/.exec(raw)![0];
    const body = raw.slice(lead.length);
    if (!body || body.startsWith('#')) return;
    if (lead.includes('\t')) throw new Unsupported(`табуляция в отступе (строка ${index + 1})`);
    if (lead.length === 0 && /^(---|\.\.\.)(\s|$)/.test(body)) {
      if (started) throw new Unsupported('несколько документов YAML');
      return;
    }
    if (lead.length === 0 && body.startsWith('%')) throw new Unsupported('директива YAML');
    started = true;
    out.push({ indent: lead.length, text: body, no: index + 1 });
  });
  return out;
}

/** Ключ и остаток строки отображения (`key: value`, `key:`); не отображение — undefined. */
function splitKey(text: string): { key: string; rest: string } | undefined {
  if (text.startsWith('? ')) throw new Unsupported('сложный ключ YAML');
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(\s|$)/.exec(text);
  if (quoted)
    return { key: scalar(quoted[1]!), rest: stripComment(text.slice(quoted[0].length)).trim() };
  const m = /^([^\s"'{[\]#&*!|>%@`][^:#]*?)\s*:(\s|$)/.exec(text);
  if (!m) return undefined;
  return { key: m[1]!, rest: stripComment(text.slice(m[0].length)).trim() };
}

function scalar(v: string): string {
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2)
    return v.slice(1, -1).replace(/\\(.)/g, '$1');
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Элементы потока `a, b` верхнего уровня; вложенный поток — вне подмножества. */
function flowItems(inner: string): string[] {
  if (/[[\]{}]/.test(inner.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '')))
    throw new Unsupported('вложенный поток YAML');
  const out: string[] = [];
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"') i++;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ',') {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Якоря разбираемого документа (`&name`) — для ссылок `*name` и `<<: *name`. */
let anchors = new Map<string, Yaml>();
const ANCHOR = /^&([A-Za-z0-9_.-]+)(?:\s+|$)/;

function inline(value: string): Yaml {
  const v = stripComment(value).trim();
  if (!v || v === '~' || v === 'null') return null;
  const alias = /^\*([A-Za-z0-9_.-]+)$/.exec(v);
  if (alias) {
    if (!anchors.has(alias[1]!)) throw new Unsupported(`ссылка на неизвестный якорь *${alias[1]}`);
    return anchors.get(alias[1]!)!;
  }
  const anchor = ANCHOR.exec(v);
  if (anchor) {
    const anchored = inline(v.slice(anchor[0].length));
    anchors.set(anchor[1]!, anchored);
    return anchored;
  }
  if (/^[&*!]/.test(v)) throw new Unsupported('якорь, ссылка или тег YAML');
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw new Unsupported('многострочный поток YAML');
    return flowItems(v.slice(1, -1)).map((x) => inline(x));
  }
  if (v.startsWith('{')) {
    if (!v.endsWith('}')) throw new Unsupported('многострочный поток YAML');
    const out: Record<string, Yaml> = {};
    for (const item of flowItems(v.slice(1, -1))) {
      const kv = splitKey(item) ?? (/^[^:]+$/.test(item) ? { key: item, rest: '' } : undefined);
      if (!kv) throw new Unsupported('поток YAML');
      out[scalar(kv.key)] = inline(kv.rest);
    }
    return out;
  }
  return scalar(v);
}

/** Разбор блока строк с отступом `indent` начиная с `i`. */
function block(lines: Line[], i: number, indent: number): [Yaml, number] {
  const first = lines[i];
  if (!first || first.indent < indent) return [null, i];
  return first.text === '-' || first.text.startsWith('- ')
    ? sequence(lines, i, first.indent)
    : mapping(lines, i, first.indent);
}

/** Значение после `key:` без значения в строке: вложенный блок или ничего. */
function nested(lines: Line[], i: number, indent: number): [Yaml, number] {
  const next = lines[i];
  if (!next) return [null, i];
  if (next.indent > indent) return block(lines, i, next.indent);
  // Последовательность на том же отступе, что ключ (`ports:\n- "80:80"`).
  if (next.indent === indent && (next.text === '-' || next.text.startsWith('- ')))
    return sequence(lines, i, indent);
  return [null, i];
}

/** Строки блочного скаляра (`|`, `>`) — пропускаются: их отступ больше ключа. */
function skipBlockScalar(lines: Line[], i: number, indent: number): number {
  while (lines[i] && lines[i]!.indent > indent) i++;
  return i;
}

function value(lines: Line[], i: number, indent: number, rest: string): [Yaml, number] {
  const anchor = ANCHOR.exec(rest);
  if (anchor) {
    const [v, next] = value(lines, i, indent, rest.slice(anchor[0].length).trim());
    anchors.set(anchor[1]!, v);
    return [v, next];
  }
  if (rest === '') return nested(lines, i, indent);
  if (/^[|>][0-9+-]*$/.test(rest)) return ['', skipBlockScalar(lines, i, indent)];
  return [inline(rest), i];
}

function mapping(lines: Line[], i: number, indent: number): [Yaml, number] {
  const out: Record<string, Yaml> = {};
  // Слияние ключей (`<<: *a` или `<<: [*a, *b]`): явные ключи отображения
  // сильнее, из ранних источников — сильнее поздних.
  const merged: Record<string, Yaml>[] = [];
  while (lines[i] && lines[i]!.indent === indent) {
    const line = lines[i]!;
    if (line.text === '-' || line.text.startsWith('- ')) break;
    const kv = splitKey(line.text);
    if (!kv) throw new Unsupported(`строка ${line.no} — не ключ отображения`);
    const [v, next] = value(lines, i + 1, indent, kv.rest);
    if (kv.key === '<<') {
      const sources = Array.isArray(v) ? v : [v];
      if (!sources.every(isMap)) throw new Unsupported('слияние ключей YAML не с отображением');
      merged.push(...(sources as Record<string, Yaml>[]));
    } else out[scalar(kv.key)] = v;
    i = next;
  }
  for (const source of merged)
    for (const [k, v] of Object.entries(source)) if (!(k in out)) out[k] = v;
  if (lines[i] && lines[i]!.indent > indent)
    throw new Unsupported(`строка ${lines[i]!.no} — неожиданный отступ`);
  return [out, i];
}

function sequence(lines: Line[], i: number, indent: number): [Yaml, number] {
  const out: Yaml[] = [];
  while (lines[i] && lines[i]!.indent === indent) {
    const line = lines[i]!;
    if (!(line.text === '-' || line.text.startsWith('- '))) break;
    const rest = line.text.slice(1).trimStart();
    const offset = line.text.length - rest.length;
    if (!rest || rest.startsWith('#')) {
      const [v, next] = nested(lines, i + 1, indent);
      out.push(v);
      i = next;
      continue;
    }
    if (splitKey(rest)) {
      // Отображение в элементе: первая пара — в строке элемента, остальные — с её отступом.
      const inner = indent + offset;
      const copy = [...lines];
      copy[i] = { indent: inner, text: rest, no: line.no };
      const [v, next] = mapping(copy, i, inner);
      out.push(v);
      i = next;
      continue;
    }
    out.push(inline(rest));
    i++;
  }
  return [out, i];
}

/** Документ YAML блочного подмножества; вне подмножества — `Unsupported`. */
export function parseComposeYaml(source: string): Yaml {
  const lines = linesOf(source);
  if (!lines.length) return null;
  anchors = new Map();
  try {
    const [doc, end] = block(lines, 0, lines[0]!.indent);
    if (end < lines.length) throw new Unsupported(`строка ${lines[end]!.no} — не разобрана`);
    return doc;
  } finally {
    anchors = new Map();
  }
}

const isMap = (v: Yaml | undefined): v is { [key: string]: Yaml } =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const truthy = (v: Yaml | undefined) => typeof v === 'string' && /^(true|yes|on)$/i.test(v.trim());

export interface ComposeFileCheck {
  /** Путь файла относительно каталога политики (или абсолютный вне его). */
  file: string;
  /** Сервисы, которые публикуют порты, а подключены только к internal-сетям. */
  internalOnly: string[];
  /** Файл не разобран: проверка пропущена с причиной. */
  unknown?: string;
}

/** Проверка одного файла compose. */
export function checkComposeFile(path: string, shown = path): ComposeFileCheck {
  let doc: Yaml;
  try {
    if (statSync(path).size > MAX_BYTES)
      return { file: shown, internalOnly: [], unknown: 'файл больше 1 МБ' };
    doc = parseComposeYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      file: shown,
      internalOnly: [],
      unknown:
        error instanceof Unsupported
          ? `формат вне разбираемого подмножества YAML: ${error.message}`
          : `не прочитан: ${(error as Error).message}`,
    };
  }
  if (!isMap(doc) || !isMap(doc.services)) return { file: shown, internalOnly: [] };
  const networks = isMap(doc.networks) ? doc.networks : {};
  const internal = (name: string) => {
    const n = networks[name];
    return isMap(n) && truthy(n.internal);
  };
  const internalOnly: string[] = [];
  for (const [name, service] of Object.entries(doc.services)) {
    if (!isMap(service) || service.network_mode !== undefined) continue;
    const ports = service.ports;
    if (!Array.isArray(ports) || !ports.length) continue;
    const joined = service.networks;
    const names = Array.isArray(joined)
      ? joined.filter((n): n is string => typeof n === 'string')
      : isMap(joined)
        ? Object.keys(joined)
        : joined === undefined || joined === null
          ? ['default']
          : [];
    if (names.length && names.every(internal)) internalOnly.push(name);
  }
  return { file: shown, internalOnly };
}

/** Значение флага команды: `-f x`, `-f=x`, `--file x`, `--file=x`. */
function flagValues(args: readonly string[], names: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n && args[i + 1] !== undefined) out.push(args[++i]!);
      else if (a.startsWith(n + '=')) out.push(a.slice(n.length + 1));
    }
  }
  return out;
}

/** Файлы compose, которые называет команда шага (относительно `cwd`). */
function composeFilesOfCommand(command: readonly string[], cwd: string): string[] {
  const head = basename(command[0] ?? '');
  const at = (f: string) => (isAbsolute(f) ? f : resolve(cwd, f));
  if (head === 'node' && command.slice(1).some((a) => BRIDGE.test(a))) {
    const named = flagValues(command, ['--compose']);
    return (named.length ? named : [BRIDGE_DEFAULT]).map(at);
  }
  const compose =
    head === 'docker-compose' ||
    head === 'podman-compose' ||
    ((head === 'docker' || head === 'podman') && command.includes('compose'));
  if (!compose) return [];
  const named = flagValues(command, ['-f', '--file']);
  if (named.length) return named.map(at);
  const found = COMPOSE_DEFAULTS.map(at).find((f) => existsSync(f));
  return found ? [found] : [];
}

/**
 * Файлы compose шагов lifecycle политики (репозиториев — от каталога
 * репозитория, рабочего пространства — от каталога политики), которые есть
 * на диске; без повторов.
 */
export function composeFilesOf(policy: ExecutionPolicy, baseDir: string): string[] {
  const out = new Set<string>();
  const steps = (l: ExecutionPolicy['lifecycle']) =>
    l ? [...(l.setup ?? []), ...(l.ready ?? []), ...l.teardown] : [];
  const add = (cwd: string, l: ExecutionPolicy['lifecycle']) => {
    for (const s of steps(l))
      for (const f of composeFilesOfCommand(s.command, cwd))
        if (!/\$\{|\$[A-Za-z_]/.test(f) && existsSync(f)) out.add(f);
  };
  add(baseDir, policy.lifecycle);
  add(baseDir, policy.workspaceLifecycle);
  for (const r of policy.repositories)
    add(isAbsolute(r.path) ? r.path : resolve(baseDir, r.path), r.lifecycle);
  return [...out];
}

/**
 * Проверка файлов compose политики для `doctor`: `problems` — сервисы с
 * опубликованными портами только во внутренних сетях, `notes` — файлы, разбор
 * которых пропущен.
 */
export function composeChecks(
  policy: ExecutionPolicy,
  baseDir: string,
): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const path of composeFilesOf(policy, baseDir)) {
    const rel = relative(baseDir, path);
    const shown = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
    const check = checkComposeFile(path, shown);
    if (check.unknown)
      notes.push(`compose-check ${shown}: ${check.unknown} — проверка внутренних сетей пропущена`);
    for (const name of check.internalOnly)
      problems.push(
        `compose-internal-ports ${shown}: Сервис ${name} публикует порты, но подключён только к внутренним сетям (internal: true): Docker не публикует такие порты — они будут недоступны на 127.0.0.1. Подключите сервис и к обычной сети или публикуйте порт через шлюз в обычной сети`,
      );
  }
  return { problems, notes };
}
