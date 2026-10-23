import type { z } from 'zod';
import type { gateSchema, repositoryPolicySchema, stepSchema } from '../contracts/index.ts';

type Step = z.input<typeof stepSchema>;
type Gate = z.input<typeof gateSchema>;
type RepositoryInput = z.input<typeof repositoryPolicySchema>;

/**
 * Рецепты установки зависимостей: точные locked-команды менеджера, каталог —
 * собственным флагом инструмента (шаг `prepare` исполняется в корне
 * worktree). Рецепт не меняет lockfile: несовместимый lockfile — отказ шага.
 */
export const installRecipes = {
  npm: (dir: string) => (dir === '.' ? ['npm', 'ci'] : ['npm', '--prefix', dir, 'ci']),
  pnpm: (dir: string) => [
    'pnpm',
    ...(dir === '.' ? [] : ['--dir', dir]),
    'install',
    '--frozen-lockfile',
  ],
  uv: (dir: string) => ['uv', 'sync', '--locked', ...(dir === '.' ? [] : ['--directory', dir])],
  go: (dir: string) => ['go', ...(dir === '.' ? [] : ['-C', dir]), 'mod', 'download'],
} as const;
export type InstallRecipe = keyof typeof installRecipes;

export interface ToolchainComponent {
  /** Каталог компонента в репозитории (`.` — корень); gates исполняются в нём. */
  dir: string;
  install?: InstallRecipe;
  installTimeoutMs?: number;
  /** Gates компонента; `cwd` по умолчанию — каталог компонента. */
  gates: Gate[];
}

/**
 * Описание репозитория политики из компонентов: у каждого свой рецепт
 * установки, каталог и gates; один Git root — одна запись репозитория.
 * Никакого «типа проекта»: Node-компонент на pnpm и Go-компонент — просто два
 * компонента с разными рецептами. Для node-компонента выбор менеджера
 * записывается явно (`toolchain.packageManagers`).
 */
export function composeRepository(
  own: Pick<RepositoryInput, 'id' | 'path' | 'targetRef'> & Partial<RepositoryInput>,
  components: ToolchainComponent[],
  tools: Record<string, string> = {},
): RepositoryInput {
  const prepare: Step[] = [];
  const gates: Gate[] = [];
  const packageManagers: Record<string, 'npm' | 'pnpm'> = {};
  for (const c of components) {
    if (c.install) {
      const id = (c.dir === '.' ? 'root' : c.dir.replace(/[^A-Za-z0-9_-]/g, '-')) + '-install';
      prepare.push({
        id,
        command: [...installRecipes[c.install](c.dir)],
        timeoutMs: c.installTimeoutMs ?? 600000,
      });
      if (c.install === 'npm' || c.install === 'pnpm') packageManagers[c.dir] = c.install;
    }
    for (const g of c.gates)
      gates.push({ ...g, ...(g.cwd === undefined && c.dir !== '.' ? { cwd: c.dir } : {}) });
  }
  return {
    ...own,
    prepare: [...(own.prepare ?? []), ...prepare],
    gates: [...(own.gates ?? []), ...gates],
    toolchain: {
      tools: { ...own.toolchain?.tools, ...tools },
      packageManagers: { ...own.toolchain?.packageManagers, ...packageManagers },
    },
  };
}
