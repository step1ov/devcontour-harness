import { accessSync, constants, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { command } from '../environment/process.ts';

/**
 * Проба версии — единственный процесс, который запускает диагностика
 * toolchain: `<tool> --version` (у go — `go version`, у собранного без метки
 * версии Go-бинарника — `go version -m <файл>`, который только читает файл).
 * Каталог пробы — нейтральный временный: менеджер пакетов не должен увидеть
 * `packageManager` проекта и переключиться на другую версию.
 */
export interface ToolProbe {
  (
    argv: string[],
    options: { timeoutMs: number; env: NodeJS.ProcessEnv },
  ): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;
}

export const PROBE_TIMEOUT_MS = 10000;

export const defaultProbe: ToolProbe = async (argv, options) => {
  const r = await command(argv, tmpdir(), { timeoutMs: options.timeoutMs, env: options.env });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
};

/** Исполняемый файл из PATH (как его нашёл бы spawn) или undefined. */
export function resolveExecutable(name: string, path: string | undefined) {
  if (isAbsolute(name)) return executable(name) ? name : undefined;
  for (const dir of (path ?? '').split(delimiter).filter(Boolean)) {
    const file = join(dir, name);
    if (executable(file)) return file;
  }
  return undefined;
}
function executable(file: string) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Версия из вывода пробы: первое `1.2.3`/`1.2` (в том числе `go1.24.5`, `v24.3.0`). */
export function versionOf(output: string) {
  return /(?:^|[^\d.])v?(?:go)?(\d+\.\d+(?:\.\d+)?)/.exec(output)?.[1];
}

/** Версия модуля в build info Go-бинарника (`go version -m`). */
export function moduleVersionOf(output: string) {
  return /^\s*mod\s+\S+\s+v(\d+\.\d+\.\d+)/m.exec(output)?.[1];
}

/** Требование версии: `1.12.3` — названные компоненты совпадают, `>=1.24` — не ниже. */
export function satisfies(version: string, required: string) {
  const parse = (v: string) => v.split('.').map((n) => Number(n));
  if (required.startsWith('>=')) {
    const want = parse(required.slice(2));
    const have = parse(version);
    for (let i = 0; i < want.length; i++) {
      const h = have[i] ?? 0;
      if (h !== want[i]) return h > want[i]!;
    }
    return true;
  }
  const want = parse(required);
  const have = parse(version);
  return want.every((n, i) => have[i] === n);
}

/**
 * Версии менеджера, на которых хранилище зависимостей проверено настоящим
 * прогоном. Граница сверху — не осторожность: с pnpm 10.27.0 `pnpm fetch` кладёт
 * в store символическую ссылку `<store>/v10/projects/<hash>`, а seed с ссылками
 * отклоняется; с 11.0.0 pnpm ещё и не читает `npm_config_store_dir`. Вне диапазона
 * хранилище не вмешивается в окружение.
 */
export const dependencyStoreVersions = {
  pnpm: { from: '9.15.0', below: '10.27.0' },
} as const;

export function dependencyStoreSupports(
  manager: keyof typeof dependencyStoreVersions,
  version: string,
) {
  const { from, below } = dependencyStoreVersions[manager];
  return satisfies(version, '>=' + from) && !satisfies(version, '>=' + below);
}

/** Версия менеджера из поля `packageManager`: `pnpm@10.12.3+sha512…` → `10.12.3`. */
export function declaredManagerVersion(field: unknown, manager: string) {
  if (typeof field !== 'string' || !field.startsWith(manager + '@')) return undefined;
  return /^\d+\.\d+\.\d+/.exec(field.slice(manager.length + 1))?.[0];
}
