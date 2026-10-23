import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  HARNESS_PROJECT_DIR,
  POLICY_VERSION,
  executionPolicySchema,
  type ResolvedProfile,
} from '../contracts/index.ts';
import { profileRoles, repositoryFromProfile } from '../profiles/resolve.ts';

export type DetectedProfile =
  | { id: 'npm-ci' | 'pnpm-frozen'; lockfile: string }
  | { problem: 'stack-ambiguous' | 'stack-unsupported'; files: string[] };

/** ID репозитория и target ref проекта: одинаковы у каждого standalone-проекта. */
export const PROJECT_REPOSITORY_ID = 'app';
export const PROJECT_TARGET_REF = 'refs/heads/harness/accepted';

const stackLockfiles = { 'package-lock.json': 'npm-ci', 'pnpm-lock.yaml': 'pnpm-frozen' } as const;

const isFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Профиль стека по lockfile корня: только `package-lock.json` — `npm-ci`,
 * только `pnpm-lock.yaml` — `pnpm-frozen`; оба — неоднозначно, ни одного —
 * стек не поддерживается. Угадывания нет: без lockfile нужен явный `--profile`.
 */
export function detectProfile(root: string): DetectedProfile {
  const found = (Object.keys(stackLockfiles) as (keyof typeof stackLockfiles)[]).filter((name) =>
    isFile(join(root, name)),
  );
  if (found.length > 1) return { problem: 'stack-ambiguous', files: found };
  const [lockfile] = found;
  if (!lockfile) return { problem: 'stack-unsupported', files: [] };
  return { id: stackLockfiles[lockfile], lockfile };
}

export interface GeneratedPolicy {
  input: z.input<typeof executionPolicySchema>;
  text: string;
  shadowed: string[];
}

/**
 * Политика проекта из профиля: пользователь JSON не пишет. Репозиторий —
 * корень над `.harness/` (`path: '..'`), target ref — `harness/accepted`,
 * `.harness/` защищён от записи исполнителем. Версия менеджера пакетов из
 * `package.json#packageManager` (того же менеджера, что выбирает профиль)
 * заменяет pin профиля — это явное значение проекта, оно видно в `shadowed`.
 * Роли — профиля, иначе одна `developer` с выбранным writer; reviewer —
 * другой вендор. Approval, isolation и бюджеты — умолчания схемы.
 */
export function generatePolicy(input: {
  profile: ResolvedProfile;
  writer: 'claude' | 'codex';
  packageManager?: { name: string; version?: string };
}): GeneratedPolicy {
  const { profile, writer, packageManager } = input;
  const manager = profile.toolchain?.packageManagers['.'];
  const pinned =
    packageManager?.version && manager !== undefined && packageManager.name === manager
      ? {
          toolchain: {
            tools: { ...profile.toolchain?.tools, [manager]: packageManager.version },
            packageManagers: { ...profile.toolchain?.packageManagers, '.': manager },
          },
        }
      : {};
  const { repository, shadowed } = repositoryFromProfile(profile, {
    id: PROJECT_REPOSITORY_ID,
    path: '..',
    targetRef: PROJECT_TARGET_REF,
    ...pinned,
  });
  repository.protectedPaths = [
    ...new Set([...repository.protectedPaths, HARNESS_PROJECT_DIR + '/']),
  ];
  const reviewer = { runtime: writer === 'claude' ? ('codex' as const) : ('claude' as const) };
  const roles = Object.keys(profile.roles).length
    ? profileRoles(profile)
    : { developer: { writer: { runtime: writer } } };
  const policy: z.input<typeof executionPolicySchema> = {
    policyVersion: POLICY_VERSION,
    repositories: [repository],
    roles,
    review: { code: { reviewer }, plan: { reviewer }, contract: { reviewer } },
  };
  // В файл пишется input-форма, но только прошедшая схему.
  executionPolicySchema.parse(policy);
  return { input: policy, text: JSON.stringify(policy, null, 2) + '\n', shadowed };
}
