import { posix } from 'node:path';
import type { GatePolicy } from '../contracts/index.ts';
import { changedPaths, gateCommandPaths, isInstallInput } from './applicability.ts';

/**
 * Отказ инструмента gate (alpha.71, C1; ревью C HIGH-1): команда gate не
 * нашла свою программу или браузер, либо менеджер пакетов отказал по своему
 * окружению. Чинится командой gate или окружением, а не кодом задачи —
 * только когда это единственное объяснение провала, проба harness
 * подтвердила отсутствие инструмента и изменение задачи его не касалось
 * (`toolMissingVerdict`). Иначе — засчитанный провал.
 */

/** Код в начале текста такого отказа (после кода `gate-definition`). */
export const GATE_TOOL_MISSING = 'GATE_TOOL_MISSING';

/** Найденный признак: строка, имя инструмента или путь браузера; код pnpm — без пробы. */
export interface ToolMissing {
  line: string;
  /** Имя программы (или путь, как его назвала оболочка). */
  name?: string;
  /** Путь исполняемого файла браузера Playwright. */
  path?: string;
  /** Отказ pnpm по каталогу состояния: подтверждён своим кодом. */
  code?: 'ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH';
  /** `spawn X ENOENT` — имя назвал процесс, а не оболочка gate (ревью B2 M3). */
  spawn?: true;
}

const signatures: { re: RegExp; take: (m: RegExpExecArray) => Omit<ToolMissing, 'line'> }[] = [
  // pnpm exec/run: `[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "playwright" not found`.
  { re: /\bCommand "([^"\n]{1,200})" not found\b/, take: (m) => ({ name: m[1]! }) },
  // sh/bash/zsh/env: программа не найдена.
  {
    re: /^(?:\/\S+\/)?(?:sh|bash|dash|zsh)(?::\s*(?:line )?\d+)?:\s*(\S{1,200}):\s*(?:command )?not found\s*$/m,
    take: (m) => ({ name: m[1]! }),
  },
  { re: /\bzsh: command not found: (\S+)/, take: (m) => ({ name: m[1]! }) },
  { re: /^env: ([^\s:]{1,200}): No such file or directory\s*$/m, take: (m) => ({ name: m[1]! }) },
  { re: /\bspawn (\S{1,200}) ENOENT\b/, take: (m) => ({ name: m[1]!, spawn: true as const }) },
  // Playwright: браузер не установлен.
  {
    re: /\bExecutable doesn't exist at (\S+)[\s\S]{0,400}\bplaywright install\b/,
    take: (m) => ({ path: m[1]! }),
  },
  // pnpm отказывается от каталога состояния задач (временный каталог хоста).
  {
    re: /\bERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH\b/,
    take: () => ({ code: 'ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH' as const }),
  },
];

/** Первый признак отказа инструмента в тексте, или undefined. */
export function toolMissing(text: string): ToolMissing | undefined {
  for (const { re, take } of signatures) {
    const m = re.exec(text);
    if (m) return { line: m[0].split('\n')[0]!.trim().slice(0, 300), ...take(m) };
  }
  return undefined;
}

/** Строка признака отказа инструмента, или undefined. */
export const toolMissingLine = (text: string) => toolMissing(text)?.line;

/** Счётчики упавших случаев в выводе исполнителей тестов. */
const failingCounts =
  /^#\s*fail\s+[1-9]|^ℹ fail [1-9]|\b[1-9]\d* (?:failing|failed)\b|Tests:\s+[1-9]\d* failed|^not ok \d+/im;

/**
 * Отказ инструмента — единственное объяснение провала: с отчётом — признак
 * у каждого упавшего testcase; без отчёта (`summary` — выжимка провала) —
 * признак в выводе и никакого другого сигнала: упавших тестов, строки
 * утверждения, которая сама не признак, счётчиков упавших случаев.
 */
export function toolMissingFailure(
  output: string,
  failures: { total: number; texts: string[] } | undefined,
  summary?: { tests?: string[] | undefined; assertion?: string | undefined },
): ToolMissing | undefined {
  if (failures && failures.total > 0) {
    if (failures.texts.length < failures.total) return undefined;
    const found = failures.texts.map(toolMissing);
    return found.every(Boolean) ? found[0] : undefined;
  }
  const found = toolMissing(output);
  if (!found) return undefined;
  if (summary?.tests?.length) return undefined;
  if (summary?.assertion && !toolMissing(summary.assertion)) return undefined;
  if (failingCounts.test(output)) return undefined;
  return found;
}

/** Файлы, через которые gate зовёт инструмент: обёртки, make, конфиги тестов. */
const wrapper =
  /(^|\/)(?:Makefile|GNUmakefile|[^/]+\.mk|[^/]+\.(?:sh|bash|zsh)|(?:playwright|vitest|jest|cypress)\.config\.[^/]+|\.tool-versions|\.nvmrc|\.node-version)$/;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Решение по признаку отказа инструмента: удержать (`held`) или засчитать
 * с причиной. Удержание — только когда: проба в той же среде после gate
 * подтвердила отсутствие (`command -v` с `node_modules/.bin` дерева и
 * каталога gate или `test -x` пути браузера; отказ pnpm по каталогу
 * состояния подтверждён своим кодом); diff база..SHA прочитан и не трогал
 * манифесты, lockfiles, файлы из команды gate, обёртки и конфиги тестов,
 * файл с именем инструмента; добавленные строки изменения не называют
 * инструмент. Неуверенность — засчитанный провал.
 */
/**
 * Программы, которые зовёт сам gate (ревью B2 M3): `argv[0]` (после `env`
 * с присваиваниями), цель `exec`/`dlx`/`npx`, первая программа script
 * пакета, который запускает менеджер пакетов (`run <script>` или краткая
 * форма), из `package.json` каталога gate.
 */
export function gateBinaries(
  gate: Pick<GatePolicy, 'command'>,
  scriptsOf: () => Record<string, string> | undefined,
): string[] {
  const strip = (argv: string[]) => {
    let a = argv;
    if (posix.basename(a[0] ?? '') === 'env') a = a.slice(1);
    while (a[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a = a.slice(1);
    return a;
  };
  const argv = strip([...gate.command]);
  const out = new Set<string>(argv[0] ? [argv[0]] : []);
  const tool = posix.basename(argv[0] ?? '');
  const positional = argv.slice(1).filter((a) => !a.startsWith('-'));
  if (tool === 'npx' && positional[0]) out.add(positional[0]);
  if (['pnpm', 'npm', 'yarn'].includes(tool)) {
    const [verb, next] = positional;
    if ((verb === 'exec' || verb === 'dlx' || verb === 'x') && next) out.add(next);
    const script = verb === 'run' || verb === 'run-script' ? next : verb;
    const text = script ? scriptsOf()?.[script] : undefined;
    const first = text ? strip(text.trim().split(/\s+/))[0] : undefined;
    if (first) out.add(first);
  }
  return [...out];
}

export async function toolMissingVerdict(input: {
  tool: ToolMissing;
  gate: Pick<GatePolicy, 'command' | 'cwd'>;
  cwd: string;
  gateCwd: string;
  base: string | undefined;
  sha: string;
  /** Код выхода пробы или undefined (проба не исполнилась). */
  probe(argv: string[]): Promise<number | undefined>;
  /** Файлы, куда изменение добавило строку, распознанную `isCall`. */
  addedCalls?(isCall: (line: string) => boolean): Promise<string[]>;
  /** Scripts `package.json` каталога gate (для `run <script>`). */
  scripts?(): Record<string, string> | undefined;
}): Promise<{ held: boolean; why: string }> {
  const { tool } = input;
  // `spawn X ENOENT` — обычно код под проверкой зовёт неверный путь: это
  // отказ инструмента gate, только когда X — программа самого gate.
  if (tool.spawn && tool.name) {
    const own = gateBinaries(input.gate, () => input.scripts?.()).some(
      (b) => b === tool.name || (!tool.name!.includes('/') && posix.basename(b) === tool.name),
    );
    if (!own)
      return {
        held: false,
        why: `spawn ${tool.name} — не программа gate (зовёт код под проверкой)`,
      };
  }
  if (!tool.code) {
    const argv = tool.path
      ? ['test', '-x', tool.path]
      : [
          'sh',
          '-c',
          'PATH="$1/node_modules/.bin:$2/node_modules/.bin:$PATH" command -v -- "$3"',
          'tool-probe',
          input.cwd,
          input.gateCwd,
          tool.name ?? '',
        ];
    const code = tool.path || tool.name ? await input.probe(argv) : undefined;
    if (code === undefined) return { held: false, why: 'проба инструмента не исполнилась' };
    if (code === 0) return { held: false, why: 'проба harness нашла инструмент' };
  }
  if (input.base && input.base !== input.sha) {
    const changed = await changedPaths(input.cwd, [{ from: input.base, to: input.sha }]);
    if (!changed.complete) return { held: false, why: 'diff изменения неизвестен' };
    if (changed.files.some(isInstallInput))
      return { held: false, why: 'изменение задачи меняет манифесты или lockfile' };
    const named = gateCommandPaths(input.gate);
    const own = tool.name?.includes('/')
      ? posix.normalize(posix.join(input.gate.cwd ?? '.', tool.name))
      : undefined;
    const touched = changed.files.find(
      (f) =>
        wrapper.test(f) ||
        named.some((n) => f === n || f.startsWith(n + '/')) ||
        f === own ||
        (tool.name !== undefined && posix.basename(f) === posix.basename(tool.name)),
    );
    if (touched)
      return {
        held: false,
        why: `изменение задачи трогает ${touched}, через который gate зовёт инструмент`,
      };
    // Код отказа менеджера пакетов (ревью final L1): не напечатало ли его
    // само изменение (тест, который выводит ту же строку и падает).
    if (tool.code && input.addedCalls) {
      const added = await input.addedCalls((line) => line.includes(tool.code!));
      if (added.length)
        return {
          held: false,
          why: `изменение задачи добавило строку с ${tool.code} (${added.join(', ')})`,
        };
    }
    if (tool.name && input.addedCalls) {
      const name = posix.basename(tool.name);
      const word = new RegExp(`(^|[^\\w.-])${escape(name)}($|[^\\w.-])`);
      const added = await input.addedCalls((line) => word.test(line));
      if (added.length)
        return {
          held: false,
          why: `изменение задачи добавило вызов ${name} (${added.join(', ')})`,
        };
    }
  }
  return { held: true, why: '' };
}
