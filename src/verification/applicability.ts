import { posix } from 'node:path';
import {
  HARNESS_PROJECT_DIR,
  gateApplicabilityLimits,
  gateDigest,
  sha256,
  type ContractDocument,
  type GateApplicability,
  type GatePolicy,
  type WorkOrder,
} from '../contracts/index.ts';
import { gitRawOutput } from '../environment/process.ts';
import { gatePrerequisites } from './gate-scope.ts';
import { REQUIREMENT_GATE } from './requirements.ts';

/**
 * Применимость gate с `when.paths`. Решение принимает controller по
 * настоящему diff фазы из Git, а не по заявлению исполнителя. Правило
 * консервативное: всё, в чём нет уверенности, исполняет gate.
 */

/** Изменённые пути фазы: объединение diff сравненных пар коммитов. */
export interface ChangedPaths {
  ranges: { from: string; to: string }[];
  /** Отсортированные уникальные пути; при `complete: false` — неполны. */
  files: string[];
  /** Diff прочитан целиком и не превысил предел. */
  complete: boolean;
  /** Почему diff неполон. */
  problem?: string;
}

const globCache = new Map<string, RegExp>();

/**
 * Регулярное выражение шаблона `when.paths`. `**` целым сегментом — любое
 * число сегментов (и ни одного), `*` — любые символы внутри сегмента, `?` —
 * один символ сегмента, `{a,b}` — варианты. Шаблон задевает и всё внутри
 * совпавшего каталога: `src/ui` и `src/ui/` задевают `src/ui/a.ts`.
 */
export function gatePathRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  const body = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  let re = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    const segmentStart = i === 0 || body[i - 1] === '/';
    if (c === '*' && body[i + 1] === '*') {
      const segmentEnd = i + 2 === body.length || body[i + 2] === '/';
      if (segmentStart && segmentEnd) {
        if (i + 2 === body.length) re += '.*';
        else {
          re += '(?:.*/)?';
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      re += '[^/]*';
      i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',' && openBrace(body, i)) re += '|';
    else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  const out = new RegExp('^(?:' + re + ')(?:/.*)?$', 's');
  globCache.set(pattern, out);
  return out;
}

const openBrace = (body: string, at: number) =>
  body.lastIndexOf('{', at) > body.lastIndexOf('}', at);

/** Пути, которые задевает хотя бы один шаблон. */
export function matchingPaths(patterns: readonly string[], files: readonly string[]) {
  const res = patterns.map(gatePathRegExp);
  return files.filter((f) => res.some((re) => re.test(f)));
}

/**
 * Изменённые пути объединения пар `from..to` (`git diff --no-renames
 * --name-only`: переименование — оба пути; удаление, смена режима и
 * подмодуль — их пути). Ошибка Git или больше `gateApplicabilityLimits.changed`
 * путей — `complete: false`, и gate исполняется.
 */
export async function changedPaths(
  cwd: string,
  ranges: { from: string; to: string }[],
): Promise<ChangedPaths> {
  const files = new Set<string>();
  try {
    for (const { from, to } of ranges) {
      const text = await gitRawOutput(
        cwd,
        'diff',
        '--no-renames',
        '--no-ext-diff',
        '--name-only',
        '-z',
        from,
        to,
      );
      for (const f of text.split('\0')) if (f) files.add(f);
      if (files.size > gateApplicabilityLimits.changed)
        return {
          ranges,
          files: [...files].sort(),
          complete: false,
          problem: `изменено больше ${gateApplicabilityLimits.changed} путей`,
        };
    }
  } catch (error) {
    return {
      ranges,
      files: [...files].sort(),
      complete: false,
      problem:
        'git diff: ' + (error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  }
  return { ranges, files: [...files].sort(), complete: true };
}

/**
 * Манифесты, lockfiles и версии инструментов в любом каталоге: их смена
 * меняет то, что ставится и чем собирается, — любой условный gate исполняется.
 */
const installInputs =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.yarnrc\.yml|bun\.lockb?|\.npmrc|\.pnpmfile\.cjs|\.nvmrc|\.node-version|\.tool-versions|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|go\.work|go\.work\.sum|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile|Pipfile\.lock|requirements[^/]*\.txt|Gemfile|Gemfile\.lock|composer\.json|composer\.lock)$/;

const under = (path: string, prefix: string) =>
  prefix === '.' ||
  prefix === '' ||
  path === prefix ||
  path === prefix.replace(/\/$/, '') ||
  path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');

/** Пути в argv gate, относительные корню репозитория (с учётом `cwd`). */
function commandPaths(gate: Pick<GatePolicy, 'command' | 'cwd'>) {
  const out = new Set<string>();
  for (const raw of gate.command) {
    for (const arg of [raw, raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : '']) {
      if (!arg || arg.startsWith('-') || posix.isAbsolute(arg) || !/[/.]/.test(arg)) continue;
      if (/[\s$`|&;<>*?{}]/.test(arg)) continue;
      const path = posix.normalize(posix.join(gate.cwd ?? '.', arg));
      if (path === '.' || path.startsWith('..')) continue;
      out.add(path.replace(/\/$/, ''));
    }
  }
  return [...out];
}

/**
 * Неявный вход gate, задетый изменением, или undefined: защищённые пути
 * репозитория, каталог проекта harness, манифесты и lockfiles, файлы и
 * каталоги, названные в команде gate.
 */
export function implicitInput(
  repo: { protectedPaths: readonly string[] },
  gate: Pick<GatePolicy, 'command' | 'cwd'>,
  files: readonly string[],
): string | undefined {
  const named = commandPaths(gate);
  return files.find(
    (f) =>
      repo.protectedPaths.some((p) => under(f, p)) ||
      under(f, HARNESS_PROJECT_DIR + '/') ||
      installInputs.test(f) ||
      named.some((n) => under(f, n)),
  );
}

/** Решение по одному gate с `when`: исполнять (с причиной) или нет (с записью). */
export type PathDecision =
  { applies: true; reason: string } | { applies: false; record: GateApplicability };

/** Применимость gate с `when` по diff (без правил области задачи). */
export function pathApplicability(
  repo: { protectedPaths: readonly string[] },
  gate: GatePolicy,
  changed: ChangedPaths,
): PathDecision {
  if (!gate.when) return { applies: true, reason: 'gate без when' };
  if (!changed.complete) return { applies: true, reason: 'diff неизвестен: ' + changed.problem };
  if (!changed.files.length) return { applies: true, reason: 'изменений нет' };
  const matched = matchingPaths(gate.when.paths, changed.files);
  if (matched.length) return { applies: true, reason: 'изменён путь gate: ' + matched[0] };
  const input = implicitInput(repo, gate, changed.files);
  if (input) return { applies: true, reason: 'изменён неявный вход gate: ' + input };
  return {
    applies: false,
    record: {
      gateDigest: gateDigest(gate),
      patterns: [...gate.when.paths],
      ranges: changed.ranges.map(({ from, to }) => ({ from, to })),
      count: changed.files.length,
      files: changed.files.slice(0, gateApplicabilityLimits.files),
      pathsDigest: sha256(changed.files.join('\0')),
    },
  };
}

/**
 * Gates, которые не бывают неприменимыми у поручения: источник требований,
 * gates его требований и gates договоров проверки (свойства, эталоны,
 * обязательства). Их доказательство — только исполнение.
 */
export function proofGates(
  order: Pick<WorkOrder, 'requirements' | 'properties'>,
  contracts: readonly ContractDocument[],
): Set<string> {
  const out = new Set<string>([REQUIREMENT_GATE]);
  for (const r of order.requirements ?? []) out.add(r.gate);
  for (const c of contracts) {
    if (!c.checks) continue;
    out.add(c.checks.gate);
    for (const o of c.checks.obligations) for (const g of o.gates ?? []) out.add(g);
  }
  return out;
}

export interface GateDecisionInput {
  repo: { gates: GatePolicy[]; protectedPaths: readonly string[] };
  /** Область фазы в порядке исполнения. */
  scope: GatePolicy[];
  changed: ChangedPaths;
  /** `proofGates` поручения. */
  proof: ReadonlySet<string>;
  /** Gate уже прошёл integration принятой попытки под этим определением (`gateDigest`). */
  passedUnder(gate: GatePolicy, digest: string): boolean;
}

export interface GateDecision {
  gate: GatePolicy;
  run: boolean;
  reason: string;
  record?: GateApplicability;
}

/**
 * Решения по области фазы. Gate без `when` исполняется всегда. Условный
 * исполняется, если: он доказывает требование или договор; под своим
 * определением он ещё ни разу не прошёл integration принятой попытки; diff
 * неизвестен, пуст или задевает его путь или неявный вход; он — предпосылка
 * (`gatePrerequisites`: `dependsOn` или более ранний check gate) исполняемого
 * gate области. Иначе — запись `not-applicable`.
 */
export function gateDecisions(input: GateDecisionInput): GateDecision[] {
  const decisions = input.scope.map((gate): GateDecision => {
    if (!gate.when) return { gate, run: true, reason: 'gate без when' };
    if (input.proof.has(gate.id))
      return { gate, run: true, reason: 'gate доказывает требование или договор поручения' };
    if (!input.passedUnder(gate, gateDigest(gate)))
      return {
        gate,
        run: true,
        reason: 'определение gate ещё не проходило integration принятой попытки',
      };
    const path = pathApplicability(input.repo, gate, input.changed);
    return path.applies
      ? { gate, run: true, reason: path.reason }
      : { gate, run: false, reason: 'diff не задел пути gate', record: path.record };
  });
  const ids = new Set(input.scope.map((g) => g.id));
  for (let grew = true; grew;) {
    grew = false;
    for (const d of decisions) {
      if (!d.run) continue;
      for (const pre of gatePrerequisites(input.repo.gates, d.gate.id)) {
        const dep = decisions.find((x) => x.gate.id === pre);
        if (!ids.has(pre) || !dep || dep.run) continue;
        dep.run = true;
        dep.reason = 'предпосылка исполняемого gate ' + d.gate.id;
        delete dep.record;
        grew = true;
      }
    }
  }
  return decisions;
}

/**
 * Почему запись `not-applicable` не закрывает обязательный gate, или
 * undefined. Закрывает только обычный gate с `when` под тем же определением,
 * не доказательство требования или договора и не предпосылку исполненного
 * gate той же фазы.
 */
export function notApplicableProblem(input: {
  gates: readonly GatePolicy[];
  gate: string;
  record: { notApplicable?: GateApplicability | undefined };
  proof: ReadonlySet<string>;
  /** Gates той же фазы с решающей записью исполнения. */
  ran: readonly string[];
}): string | undefined {
  const gate = input.gates.find((g) => g.id === input.gate);
  if (!gate?.when) return `gate ${input.gate} без when не бывает неприменимым`;
  if (input.proof.has(gate.id))
    return `gate ${gate.id} доказывает требование или договор: нужен PASS`;
  if (!input.record.notApplicable || input.record.notApplicable.gateDigest !== gateDigest(gate))
    return `решение о неприменимости ${gate.id} принято под другим определением gate`;
  const dependent = input.ran.find(
    (id) =>
      input.gates.some((g) => g.id === id) &&
      gatePrerequisites([...input.gates], id).includes(gate.id),
  );
  if (dependent) return `gate ${gate.id} — предпосылка исполненного ${dependent}: нужен PASS`;
  return undefined;
}
