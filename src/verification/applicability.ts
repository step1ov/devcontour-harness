import { existsSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import {
  HARNESS_PROJECT_DIR,
  digestOf,
  type ExecutionPolicy,
  gateApplicabilityLimits,
  gateDigest,
  sha256,
  type ContractDocument,
  type AttemptState,
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
  const normal = pattern.normalize('NFC');
  const trimmed = normal.endsWith('/') ? normal.slice(0, -1) : normal;
  // `X/**` задевает и сам путь `X` (подмодуль, файл вместо каталога).
  const body = trimmed.endsWith('/**') ? trimmed.slice(0, -3) : trimmed;
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
  // Без учёта регистра и в NFC: лишнее совпадение только чаще исполняет gate.
  const out = new RegExp('^(?:' + re + ')(?:/.*)?$', 'si');
  globCache.set(pattern, out);
  return out;
}

const openBrace = (body: string, at: number) =>
  body.lastIndexOf('{', at) > body.lastIndexOf('}', at);

/** Буквальный префикс шаблона до первого glob-символа, по целым сегментам. */
const literalPrefix = (pattern: string) => {
  const normal = pattern.normalize('NFC').toLowerCase();
  const glob = normal.search(/[*?{]/);
  if (glob < 0) return normal.replace(/\/$/, '');
  return normal.slice(0, normal.lastIndexOf('/', glob) + 1).replace(/\/$/, '');
};

/**
 * Пути, которые задевает хотя бы один шаблон: совпадение glob или путь —
 * каталог-предок буквального префикса шаблона (`vendor` для `vendor/lib/**`:
 * файл или подмодуль на месте каталога шаблона).
 */
export function matchingPaths(patterns: readonly string[], files: readonly string[]) {
  const res = patterns.map(gatePathRegExp);
  const prefixes = patterns.map(literalPrefix).filter(Boolean);
  const segmented = patterns.map(patternSegments);
  return files.filter((f) => {
    const path = f.normalize('NFC');
    if (res.some((re) => re.test(path))) return true;
    const lower = path.toLowerCase();
    if (prefixes.some((p) => p === lower || p.startsWith(lower + '/'))) return true;
    const parts = path.split('/');
    return segmented.some((segments) => coversPrefix(segments, parts));
  });
}

/** Сегменты шаблона по `/` вне `{}`. */
function patternSegments(pattern: string) {
  const body = pattern.normalize('NFC').replace(/\/$/, '');
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of body) {
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (c === '/' && depth === 0) {
      out.push(current);
      current = '';
    } else current += c;
  }
  out.push(current);
  return out;
}

/**
 * Изменённый путь — каталог (подмодуль, ссылка), внутри которого шаблон
 * может что-то задеть: его сегменты совпадают с первыми сегментами шаблона
 * (`packages/ui` для `packages/*\/src/**`); до `**` — не дальше.
 */
function coversPrefix(segments: string[], parts: string[]) {
  if (parts.length >= segments.length) return false;
  for (let i = 0; i < parts.length; i++) {
    // Под `**` любой путь мог бы быть каталогом: подмодули и ссылки там
    // называют в `when.paths` явно (иначе любой файл исполнял бы gate).
    if (segments[i] === '**') return false;
    if (segments[i]!.includes('/')) return true;
    if (!gatePathRegExp(segments[i]!).test(parts[i]!)) return false;
  }
  return true;
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
    // Замены объектов и grafts подменяют историю для git: такой diff не
    // доказывает ничего, и условные gates исполняются.
    const replaced = await gitRawOutput(cwd, 'for-each-ref', '--count=1', 'refs/replace/');
    const common = (await gitRawOutput(cwd, 'rev-parse', '--git-common-dir')).trim();
    if (replaced.trim() || existsSync(resolve(cwd, common, 'info', 'grafts')))
      return {
        ranges,
        files: [],
        complete: false,
        problem: 'в репозитории есть refs/replace или info/grafts',
      };
    for (const { from, to } of ranges) {
      // Подмодули — всегда (`ignore` из .gitmodules пишет исполнитель),
      // без относительных путей и textconv.
      const text = await gitRawOutput(
        cwd,
        'diff',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--no-relative',
        '--ignore-submodules=none',
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
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.yarnrc\.yml|bun\.lockb?|\.npmrc|\.pnpmfile\.cjs|\.nvmrc|\.node-version|\.tool-versions|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|go\.work|go\.work\.sum|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile|Pipfile\.lock|requirements[^/]*\.txt|Gemfile|Gemfile\.lock|composer\.json|composer\.lock|\.gitattributes|\.gitmodules|\.lfsconfig)$/i;

const fold = (path: string) => path.normalize('NFC').toLowerCase();
/** Путь внутри префикса (без учёта регистра, NFC): лишнее совпадение только чаще исполняет gate. */
const under = (raw: string, rawPrefix: string) => {
  const path = fold(raw);
  const prefix = fold(rawPrefix);
  return (
    prefix === '.' ||
    prefix === '' ||
    path === prefix ||
    path === prefix.replace(/\/$/, '') ||
    path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')
  );
};

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

/**
 * Основание исполнения условного gate: его определение (`gateDigest`),
 * описания его ресурсов, определения и ресурсы его предпосылок
 * (`gatePrerequisites`, транзитивно), окружение, lifecycle, подготовка, хранилище
 * зависимостей и toolchain репозитория, изоляция и версия harness. Зелёный
 * SHA gate засчитывается только под тем же основанием: смена любого из них
 * исполняет gate заново.
 */
export function gateBasis(
  policy: Pick<ExecutionPolicy, 'resources' | 'environment' | 'lifecycle' | 'isolation'>,
  repo: Pick<
    ExecutionPolicy['repositories'][number],
    'gates' | 'environment' | 'lifecycle' | 'prepare' | 'dependencyStore' | 'toolchain'
  >,
  gate: GatePolicy,
  harnessVersion: string,
) {
  const resources = (g: GatePolicy) => policy.resources.filter((r) => g.resources?.includes(r.id));
  // Предпосылки (`dependsOn` или, в режиме порядка массива, более ранние
  // check gates) исполняются перед gate в том же дереве: их вывод — его вход.
  const prerequisites = gatePrerequisites(repo.gates, gate.id)
    .sort()
    .map((id) => repo.gates.find((g) => g.id === id)!)
    .map((g) => ({ id: g.id, gate: gateDigest(g), resources: resources(g) }));
  return digestOf({
    gate: gateDigest(gate),
    resources: resources(gate),
    prerequisites,
    environment: [policy.environment, repo.environment],
    lifecycle: repo.lifecycle ?? policy.lifecycle,
    prepare: repo.prepare,
    dependencyStore: repo.dependencyStore,
    toolchain: repo.toolchain,
    isolation: policy.isolation,
    harness: harnessVersion,
  });
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
      // Длинный путь (их пишет исполнитель) не перечисляется: он в `count` и `pathsDigest`.
      files: changed.files.filter((f) => f.length <= 1000).slice(0, gateApplicabilityLimits.files),
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

/** Снимок провайдера, против которого шла попытка (`AttemptState.dependencies`). */
export type ProviderSnapshot = Pick<
  NonNullable<AttemptState['dependencies']>[number],
  'repositoryId' | 'sha'
>;

/**
 * Почему база провайдеров сдвинулась с зелёного SHA gate, или undefined.
 * Провайдеры — `dependsOn` репозитория и все репозитории снимков (в том числе
 * транзитивные). Сдвиг — другой SHA провайдера; снимок провайдера, которого
 * нет у зелёной попытки или у текущей (запись прежней версии, новый
 * провайдер), — тоже сдвиг: изменение провайдера меняет вход gate
 * потребителя, даже если diff потребителя не задел его путей. Artifacts
 * провайдера не сравниваются: их пересобирают в каждой попытке, и
 * невоспроизводимая сборка давала бы сдвиг на каждой; при том же SHA их
 * вход — тот же источник.
 */
export function providerMovement(
  providers: readonly string[],
  green: readonly ProviderSnapshot[] | undefined,
  current: readonly ProviderSnapshot[] | undefined,
): string | undefined {
  const ids = [
    ...new Set([
      ...providers,
      ...(green ?? []).map((d) => d.repositoryId),
      ...(current ?? []).map((d) => d.repositoryId),
    ]),
  ].sort();
  for (const id of ids) {
    const from = green?.find((d) => d.repositoryId === id);
    const to = current?.find((d) => d.repositoryId === id);
    if (!from || !to)
      return `снимок провайдера ${id} ${from ? 'попытки' : 'зелёного SHA'} неизвестен`;
    if (from.sha !== to.sha)
      return `база провайдера ${id} сдвинулась: ${from.sha.slice(0, 12)} → ${to.sha.slice(0, 12)}`;
  }
  return undefined;
}

export interface GateDecisionInput {
  repo: { gates: GatePolicy[]; protectedPaths: readonly string[] };
  /** Область фазы в порядке исполнения. */
  scope: GatePolicy[];
  /**
   * Diff фазы условного gate от его последнего зелёного SHA (integration
   * принятой попытки под тем же основанием gate, предок базы попытки) до
   * SHA фазы; undefined — такого SHA нет, и gate исполняется.
   */
  changedFor(gate: GatePolicy): ChangedPaths | undefined;
  /**
   * Почему база провайдеров сдвинулась с того же зелёного SHA
   * (`providerMovement`), или undefined. Спрашивается только у условного gate
   * с зелёным SHA. Без поля провайдеры считаются не сдвинувшимися: вызывающий
   * ручается, что `changedFor` даёт зелёный SHA только под теми же SHA
   * провайдеров (или что провайдеров нет). Runner его передаёт всегда.
   */
  providersMoved?(gate: GatePolicy): string | undefined;
  /** `proofGates` поручения. */
  proof: ReadonlySet<string>;
}

export interface GateDecision {
  gate: GatePolicy;
  run: boolean;
  reason: string;
  record?: GateApplicability;
}

/**
 * Решения по области фазы. Gate без `when` исполняется всегда. Условный
 * исполняется, если: он доказывает требование или договор; среди предков
 * базы нет его зелёного SHA под тем же основанием (`changedFor`); с этого
 * зелёного SHA сдвинулась база провайдеров (`providersMoved`); diff
 * неизвестен, пуст или задевает его путь или неявный вход; он — предпосылка
 * (`gatePrerequisites`: `dependsOn` или более ранний check gate) исполняемого
 * gate области. Иначе — запись `not-applicable`.
 */
export function gateDecisions(input: GateDecisionInput): GateDecision[] {
  const decisions = input.scope.map((gate): GateDecision => {
    if (!gate.when) return { gate, run: true, reason: 'gate без when' };
    if (input.proof.has(gate.id))
      return { gate, run: true, reason: 'gate доказывает требование или договор поручения' };
    const changed = input.changedFor(gate);
    if (!changed)
      return {
        gate,
        run: true,
        reason: 'нет зелёного SHA gate под тем же основанием среди предков базы',
      };
    const moved = input.providersMoved?.(gate);
    if (moved) return { gate, run: true, reason: moved };
    const path = pathApplicability(input.repo, gate, changed);
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

/**
 * Объединённый diff набора для `uncoveredGates`: от зелёного SHA каждой
 * записи неприменимости фазы интеграции (`notApplicable.ranges[0].from`) до
 * итогового SHA репозитория. Хосту не нужно собирать пары самому.
 */
export function coverageChanges(
  cwd: string,
  evidence: readonly {
    kind: string;
    phase: string;
    notApplicable?: GateApplicability | undefined;
  }[],
  finalSha: string,
): Promise<ChangedPaths> {
  const anchors = [
    ...new Set(
      evidence
        .filter((e) => e.kind === 'not-applicable' && e.phase === 'integration')
        .flatMap((e) => (e.notApplicable?.ranges[0] ? [e.notApplicable.ranges[0].from] : [])),
    ),
  ];
  return changedPaths(
    cwd,
    anchors.map((from) => ({ from, to: finalSha })),
  );
}
