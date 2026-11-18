// Генераторы закоммиченных выходов (`repositories[].generators`).
//
// Выход генерации часто лежит в области записи другой роли: данные правит
// одна роль, модуль из них строит скрипт другой, а общая проверка сверяет их
// между собой. Исполнитель не может (и не должен) править чужой выход, и
// между его работой и коммитом никто не перегенерирует — кандидат красный.
// Поэтому выходы строит controller: после исполнителя, если настоящий diff
// задел входы, инструмент или выходы генератора, он исполняет команду с
// изоляцией и окружением gate и кладёт выходы в того же кандидата. Что
// генератор изменил вне своих выходов — нарушение области. На взятом
// кандидате и на integration генератор исполняется заново и обязан дерево не
// менять: устаревший выход на новой базе — конфликт слияния, повтор
// ответвляется от неё.

import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { gateTimeoutMs, type ExecutionPolicy, type GeneratorPolicy } from '../contracts/index.ts';
import { TaskFailure } from '../engine/failure.ts';
import { within } from '../engine/scope.ts';
import type { executionEnvironment } from '../environment/lifecycle.ts';
import {
  protectedChanges,
  protectedSnapshot,
  SandboxPolicyError,
} from '../environment/isolation.ts';
import { ReapFailure, git, gitRawOutput } from '../environment/process.ts';
import { completedCheck, diagnostic, runCheck } from './gates.ts';

/**
 * Генераторы, которых касается изменение: изменённый путь совпадает со
 * входом, инструментом или выходом генератора (путь или префикс каталога).
 * Порядок — порядок политики.
 */
export function selectGenerators(
  generators: readonly GeneratorPolicy[],
  changed: readonly string[],
): GeneratorPolicy[] {
  return generators.filter((g) =>
    changed.some((p) => within(p, [...g.inputs, ...g.tool, ...g.outputs])),
  );
}

/** Исход одного генератора (квитанция `generators.json` фазы). */
export interface GeneratorOutcome {
  id: string;
  /** Пути выходов, которые генератор изменил относительно дерева до него. */
  changed: string[];
  exitCode: number;
  durationMs: number;
}

export interface GeneratorsRun {
  policy: Pick<ExecutionPolicy, 'isolation' | 'gateTimeoutFloorMs'>;
  /** Корень дерева фазы. */
  cwd: string;
  generators: readonly GeneratorPolicy[];
  /**
   * `write` — кандидат после исполнителя: выходы строятся заново и остаются
   * в индексе. `verify` — взятый кандидат и integration: генератор обязан не
   * изменить выходы; иначе конфликт слияния (`merge`).
   */
  mode: 'write' | 'verify';
  execution: ReturnType<typeof executionEnvironment>;
  signal: AbortSignal;
  boundary: { readable: string[]; hidden: string[]; checkouts?: string[] };
  /** Каталог журналов: `<id>.log` и квитанция `generators.json`. */
  artifactDir: string;
  /** Замер стадии генератора (`generate:<id>` у вызывающего). */
  timed: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
}

const names = (text: string) => text.split('\0').filter(Boolean);

/** Индекс = рабочее дерево; возвращает дерево индекса. */
async function stageAll(cwd: string) {
  await git(cwd, 'add', '-A');
  return git(cwd, 'write-tree');
}

/**
 * Исполнить генераторы по порядку. Перед каждым его отслеживаемые выходы
 * удаляются из рабочего дерева: выход — целиком результат генератора, правка
 * исполнителя (и лишний файл в каталоге выхода) перезаписывается.
 */
export async function runGenerators(run: GeneratorsRun): Promise<GeneratorOutcome[]> {
  const { cwd, signal } = run;
  const root = await realpath(cwd);
  const outcomes: GeneratorOutcome[] = [];
  await mkdir(run.artifactDir, { recursive: true });
  const head = await git(cwd, 'rev-parse', 'HEAD');
  try {
    for (const generator of run.generators) {
      signal.throwIfAborted();
      outcomes.push(await run.timed(generator.id, () => runOne(run, root, head, generator)));
    }
  } finally {
    await writeFile(
      join(run.artifactDir, 'generators.json'),
      JSON.stringify({ mode: run.mode, generators: outcomes }, null, 2),
    ).catch(() => undefined);
  }
  // Проверка не оставляет следов в индексе: дерево фазы — её коммит.
  if (run.mode === 'verify') await git(cwd, 'reset', '-q');
  return outcomes;
}

async function runOne(
  run: GeneratorsRun,
  root: string,
  head: string,
  generator: GeneratorPolicy,
): Promise<GeneratorOutcome> {
  const { cwd, signal } = run;
  const redact = run.execution.redact;
  const id = generator.id;
  const workdir = generator.cwd ? await realpath(resolve(root, generator.cwd)) : root;
  if (workdir !== root && !workdir.startsWith(root + sep))
    throw new TaskFailure('scope-violation', `generator ${id}: cwd leaves the worktree`);
  const before = await stageAll(cwd);
  // Отслеживаемые выходы удаляются: генератор строит их заново целиком.
  for (const path of names(
    await gitRawOutput(cwd, '--literal-pathspecs', 'ls-files', '-z', '--', ...generator.outputs),
  ))
    await rm(join(root, path), { force: true });
  let guarded: Map<string, string> | undefined;
  try {
    if (run.policy.isolation.mode === 'os') guarded = protectedSnapshot(root);
  } catch (error) {
    if (error instanceof SandboxPolicyError)
      throw new TaskFailure('environment', error.message, undefined, 'sandbox-policy');
    throw error;
  }
  const timeoutMs = gateTimeoutMs(generator, run.policy);
  const started = Date.now();
  let log = `# harness generator ${id}: cwd=${relative(root, workdir) || '.'} argv=${JSON.stringify(generator.command.map(redact))} mode=${run.mode}\n`;
  let result: Awaited<ReturnType<typeof runCheck>>;
  try {
    result = await runCheck(
      { config: run.policy },
      {
        activity: { kind: 'step', label: `generate:${id}` },
        argv: generator.command,
        cwd: workdir,
        env: run.execution.env,
        redact,
        timeoutMs,
        signal,
        write: [cwd],
        readable: run.boundary.readable,
        controller: run.boundary.hidden,
        ...(run.boundary.checkouts?.length ? { checkouts: run.boundary.checkouts } : {}),
        settingsDir: join(run.artifactDir, id),
        violations: true,
      },
    );
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof SandboxPolicyError)
      throw new TaskFailure('environment', error.message, undefined, 'sandbox-policy');
    // Потомки генератора не остановлены: дерево, в котором они, возможно,
    // ещё пишут, не коммитится.
    if (error instanceof ReapFailure) throw error;
    const done = completedCheck(error);
    if (!done) throw error;
    result = done;
  }
  log += result.stdout + '\n' + result.stderr;
  await writeFile(join(run.artifactDir, `${id}.log`), redact(log));
  signal.throwIfAborted();
  let planted: string[] = [];
  try {
    if (guarded) planted = protectedChanges(guarded, root, run.execution.prepared);
  } catch (error) {
    if (error instanceof SandboxPolicyError)
      throw new TaskFailure('scope-violation', `generator ${id}: ${error.message}`);
    throw error;
  }
  if (planted.length)
    throw new TaskFailure(
      'scope-violation',
      `generator ${id} created, changed or removed protected paths (IDE, shell, git or Claude configuration): ` +
        planted
          .slice(0, 5)
          .map((p) => relative(root, p))
          .join(', '),
    );
  if (result.timedOut)
    throw new TaskFailure('gate', `generator ${id} exceeded its timeout (${timeoutMs} ms)`);
  if (result.launchFailed)
    throw new TaskFailure(
      'environment',
      `the OS sandbox did not start generator ${id} (attempts: ${result.attempts}): ${diagnostic(result.stderr, result.stdout, redact)}`,
      undefined,
      'sandbox-launch',
    );
  if (result.code !== 0)
    throw new TaskFailure(
      'gate',
      `generator ${id} failed: exit=${result.code}: ${diagnostic(result.stderr, result.stdout, redact)}`,
    );
  if ((await git(cwd, 'rev-parse', 'HEAD')) !== head)
    throw new TaskFailure('scope-violation', `generator ${id} changed HEAD; harness owns commits`);
  const after = await stageAll(cwd);
  const changed = names(
    await gitRawOutput(cwd, 'diff-tree', '-r', '--no-renames', '--name-only', '-z', before, after),
  );
  const outside = changed.filter((p) => !within(p, generator.outputs));
  if (outside.length)
    throw new TaskFailure(
      'scope-violation',
      `generator ${id} changed paths outside its outputs: ${outside.slice(0, 20).join(', ')}${outside.length > 20 ? ` and ${outside.length - 20} more` : ''}`,
    );
  if (run.mode === 'verify' && changed.length)
    throw new TaskFailure(
      'merge',
      `generator ${id}: the committed output is stale on this base (regeneration changed ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ` and ${changed.length - 20} more` : ''}); a retry regenerates it on the current base`,
    );
  return { id, changed, exitCode: result.code, durationMs: Date.now() - started };
}

/** Заметка исполнителю: какие выходы строит controller и почему их не править. */
export function generatorNote(generators: readonly GeneratorPolicy[]) {
  if (!generators.length) return undefined;
  return (
    'Generated outputs: after you finish, harness reruns these generators when your changes touch their inputs, tool or outputs, and commits their outputs with your work. Do not edit the outputs by hand — they are overwritten: ' +
    generators
      .map(
        (g) =>
          `${g.id} (inputs ${g.inputs.join(', ')}${g.tool.length ? `; tool ${g.tool.join(', ')}` : ''} → outputs ${g.outputs.join(', ')})`,
      )
      .join('; ')
  );
}
