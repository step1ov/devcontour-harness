/**
 * Небольшое подмножество semver npm для выбора пары harness+панель:
 * сравнение версий с prerelease и проверка peer-диапазона (`>=`, `>`, `<=`,
 * `<`, `=`, точная версия, `^`, `~`, `*`, `||`, `a - b`). Prerelease-версия
 * удовлетворяет набору, только если в нём есть сравнение с той же
 * `major.minor.patch` и prerelease (правило npm). Нераспознанный диапазон —
 * не удовлетворён: пара не выбирается вслепую.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: (string | number)[];
}

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/;

export function parseVersion(text: string): SemVer | undefined {
  const m = SEMVER.exec(text.trim());
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

function comparePre(a: SemVer['pre'], b: SemVer['pre']): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function compareParsed(a: SemVer, b: SemVer): number {
  return (
    Math.sign(a.major - b.major) ||
    Math.sign(a.minor - b.minor) ||
    Math.sign(a.patch - b.patch) ||
    comparePre(a.pre, b.pre)
  );
}

/** Сравнение строк версий; нераспознанная версия меньше любой распознанной. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  return compareParsed(x, y);
}

type Op = '<' | '<=' | '>' | '>=' | '=';
interface Comparator {
  op: Op;
  v: SemVer;
}

const zeroPre = (v: Omit<SemVer, 'pre'>): SemVer => ({ ...v, pre: [0] });

function comparators(part: string): Comparator[] | undefined {
  const text = part.trim();
  if (text === '' || text === '*' || text === 'x') return [];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  if (hyphen) {
    const lo = parseVersion(hyphen[1]!);
    const hi = parseVersion(hyphen[2]!);
    return lo && hi
      ? [
          { op: '>=', v: lo },
          { op: '<=', v: hi },
        ]
      : undefined;
  }
  const out: Comparator[] = [];
  for (const token of text.split(/\s+/)) {
    const m = /^(<=|>=|<|>|=|\^|~)?\s*(.+)$/.exec(token);
    if (!m) return undefined;
    const v = parseVersion(m[2]!);
    if (!v) return undefined;
    const op = m[1];
    if (op === '^') {
      const upper =
        v.major > 0
          ? { major: v.major + 1, minor: 0, patch: 0 }
          : v.minor > 0
            ? { major: 0, minor: v.minor + 1, patch: 0 }
            : { major: 0, minor: 0, patch: v.patch + 1 };
      out.push({ op: '>=', v }, { op: '<', v: zeroPre(upper) });
    } else if (op === '~') {
      out.push(
        { op: '>=', v },
        { op: '<', v: zeroPre({ major: v.major, minor: v.minor + 1, patch: 0 }) },
      );
    } else out.push({ op: (op as Op | undefined) ?? '=', v });
  }
  return out;
}

function test(c: Comparator, v: SemVer): boolean {
  const r = compareParsed(v, c.v);
  switch (c.op) {
    case '<':
      return r < 0;
    case '<=':
      return r <= 0;
    case '>':
      return r > 0;
    case '>=':
      return r >= 0;
    case '=':
      return r === 0;
  }
}

/** Удовлетворяет ли версия диапазону npm (подмножество выше). */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  for (const set of range.split('||')) {
    const list = comparators(set);
    if (!list) continue;
    if (!list.every((c) => test(c, v))) continue;
    if (!v.pre.length) return true;
    // Prerelease — только при сравнении с той же тройкой и prerelease.
    if (
      list.some(
        (c) =>
          c.v.pre.length > 0 &&
          !(c.v.pre.length === 1 && c.v.pre[0] === 0 && c.op === '<') &&
          c.v.major === v.major &&
          c.v.minor === v.minor &&
          c.v.patch === v.patch,
      )
    )
      return true;
  }
  return false;
}
