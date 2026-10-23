import { resolve } from 'node:path';
import { digestOf } from '../contracts/digest.ts';
import {
  roleBinding,
  type ContextSnapshot,
  type ContractDocument,
  type ExecutionPolicy,
} from '../contracts/index.ts';
import type { PlanningFacts } from '../contracts/planning.ts';

/**
 * Факты планирования из политики самостоятельного проекта. Роли репозитория —
 * роли политики, затем роли, объявленные только репозиторием; привязка каждой
 * берётся через `roleBinding` (роль репозитория заменяет роль политики).
 * Встроенных ролей нет: планировать можно только объявленными.
 */
export function planningFactsOf(
  policy: ExecutionPolicy,
  options: { baseDir: string; context?: ContextSnapshot; contracts?: readonly ContractDocument[] },
): PlanningFacts {
  const policyRoles = Object.keys(policy.roles);
  return {
    repositories: policy.repositories.map((r) => ({
      id: r.id,
      kind: r.kind,
      path: resolve(options.baseDir, r.path),
    })),
    roles: policy.repositories.map((repo) => ({
      repositoryId: repo.id,
      roles: [
        ...policyRoles,
        ...Object.keys(repo.roles ?? {}).filter((role) => !policyRoles.includes(role)),
      ].map((role) => {
        const binding = roleBinding(policy, role, repo.id)!;
        return {
          role,
          ...(binding.writePaths ? { writePaths: binding.writePaths } : {}),
          requiresContract: binding.requiresContract,
        };
      }),
    })),
    gates: policy.repositories.map((repo) => ({
      repositoryId: repo.id,
      gates: repo.gates.map(({ id, kind }) => ({ id, kind })),
      ...(repo.gateGroups ? { groups: repo.gateGroups } : {}),
    })),
    contextPacks: (options.context?.sources ?? []).map((source) => ({
      id: source.id,
      version: source.version,
      ...(source.repositoryId ? { repositoryId: source.repositoryId } : {}),
      files: [...source.files, ...source.references].map((f) => f.path),
    })),
    resources: policy.resources.map(({ id, kind }) => ({ id, kind })),
    // Запись целиком и digest документа — тот же, что у review-contract.
    contracts: (options.contracts ?? []).map((doc) => ({ ...doc, digest: digestOf(doc) })),
  };
}
