import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  HARNESS_PROJECT_DIR,
  HarnessError,
  POLICY_VERSION,
  executionPolicySchema,
  runtimeAssignments,
  vendorOf,
  type ResolvedProfile,
} from '../contracts/index.ts';
import { profileRoles, repositoryFromProfile } from '../profiles/resolve.ts';
import { otherRuntime } from './runtimes.ts';
import { requiredRunTimeoutMs, timeBudgetWarnings } from '../verification/time-budget.ts';

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
 * Параметры исполнения, которые задаёт профиль (например, слой `lean`):
 * параллельность, время попытки и нижняя граница предела gate (слои уже
 * сложены: наименьшая параллельность, наибольшие пределы). Нет в профиле —
 * умолчания схемы, и политика прежняя.
 */
export const profileExecution = (profile: ResolvedProfile) => ({
  ...(profile.concurrency !== undefined ? { concurrency: profile.concurrency } : {}),
  ...(profile.runTimeoutMs !== undefined ? { runTimeoutMs: profile.runTimeoutMs } : {}),
  ...(profile.gateTimeoutFloorMs !== undefined
    ? { gateTimeoutFloorMs: profile.gateTimeoutFloorMs }
    : {}),
});

/** Поля исполнения, которые профиль переносит в политику, в порядке записи `init`. */
export const EXECUTION_FIELDS = ['concurrency', 'runTimeoutMs', 'gateTimeoutFloorMs'] as const;
export type ExecutionField = (typeof EXECUTION_FIELDS)[number];

/**
 * Поля исполнения, которые `init` записал бы в эту политику из профиля
 * `profile`: параллельность и нижняя граница предела gate — профиля (нет в
 * профиле — поля нет, действует умолчание схемы); срок фазы — профиля, а если
 * его (или умолчания) не хватает пределам шагов политики — наибольшая сумма
 * фазы с запасом (`requiredRunTimeoutMs`), не меньше срока профиля. Прочие
 * поля политики не меняются; поля исполнения самой политики не учитываются.
 */
export function executionFieldsOf(
  policy: z.input<typeof executionPolicySchema>,
  profile: ResolvedProfile,
): Partial<Record<ExecutionField, number>> {
  const base: z.input<typeof executionPolicySchema> = { ...policy };
  for (const field of EXECUTION_FIELDS) delete base[field];
  Object.assign(base, profileExecution(profile));
  const budget = executionPolicySchema.parse(base);
  if (timeBudgetWarnings(budget).length)
    base.runTimeoutMs = Math.max(requiredRunTimeoutMs(budget), profile.runTimeoutMs ?? 0);
  return Object.fromEntries(
    EXECUTION_FIELDS.flatMap((f) => (base[f] === undefined ? [] : [[f, base[f]]])),
  );
}

/**
 * Политика проекта из профиля: пользователь JSON не пишет. Репозиторий —
 * корень над `.harness/` (`path: '..'`), target ref — `harness/accepted`,
 * `.harness/` защищён от записи исполнителем. Версия менеджера пакетов из
 * `package.json#packageManager` (того же менеджера, что выбирает профиль)
 * заменяет pin профиля — это явное значение проекта, оно видно в `shadowed`.
 * Роли — профиля, иначе одна `developer` с выбранным writer. Reviewer плана и
 * контракта выбирается для ведущего (`lead` — их автор), reviewer кода — для
 * writer: при `review: 'cross'` — другой вендор, при `'same'` — тот же runtime
 * с явным `vendor: same-vendor-allowed`. `model` закрепляется на каждом writer
 * и reviewer; одна модель у runtime двух вендоров — отказ. Параллельность и
 * нижняя граница предела gate — профиля (`profileExecution`); approval,
 * isolation и прочие бюджеты — умолчания схемы. Срок фазы (`runTimeoutMs`) —
 * профиля (`profileExecution`), иначе умолчание схемы, пока его хватает
 * пределам шагов профиля (`timeBudgetWarnings`); иначе он записывается явно:
 * наибольшая сумма фазы с запасом 25 %, округлённая вверх до 5 минут
 * (`requiredRunTimeoutMs`), и не меньше `runTimeoutMs` профиля. Политика
 * профиля, которой хватало срока, не меняется.
 */
export function generatePolicy(input: {
  profile: ResolvedProfile;
  writer: 'claude' | 'codex';
  /** Автор планов и контрактов; по умолчанию — writer. */
  lead?: 'claude' | 'codex';
  /** По умолчанию — `cross`. */
  review?: 'cross' | 'same';
  model?: string;
  packageManager?: { name: string; version?: string };
  /** Хранилище зависимостей pnpm (`init --lean` в pnpm-репозитории). */
  dependencyStore?: boolean;
}): GeneratedPolicy {
  const { profile, writer, packageManager, model } = input;
  const lead = input.lead ?? writer;
  const mode = input.review ?? 'cross';
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
    ...(input.dependencyStore ? { dependencyStore: { manager: 'pnpm' as const } } : {}),
  });
  repository.protectedPaths = [
    ...new Set([...repository.protectedPaths, HARNESS_PROJECT_DIR + '/']),
  ];
  const bind = <B extends { runtime: string }>(binding: B): B =>
    model ? { ...binding, model } : binding;
  const rule = (author: 'claude' | 'codex') =>
    mode === 'cross'
      ? { reviewer: bind({ runtime: otherRuntime(author) }) }
      : { reviewer: bind({ runtime: author }), vendor: 'same-vendor-allowed' as const };
  const roles = Object.keys(profile.roles).length
    ? Object.fromEntries(
        Object.entries(profileRoles(profile)).map(([id, role]) => [
          id,
          model
            ? {
                ...role,
                writer: bind(role.writer),
                ...(role.review
                  ? {
                      review: {
                        ...role.review,
                        reviewer: bind(role.review.reviewer),
                        ...(role.review.alternates
                          ? { alternates: role.review.alternates.map(bind) }
                          : {}),
                      },
                    }
                  : {}),
              }
            : role,
        ]),
      )
    : { developer: { writer: bind({ runtime: writer }) } };
  const policy: z.input<typeof executionPolicySchema> = {
    policyVersion: POLICY_VERSION,
    repositories: [repository],
    roles,
    review: { code: rule(writer), plan: rule(lead), contract: rule(lead) },
    ...profileExecution(profile),
  };
  const { runTimeoutMs } = executionFieldsOf(policy, profile);
  if (runTimeoutMs !== policy.runTimeoutMs) policy.runTimeoutMs = runTimeoutMs;
  // В файл пишется input-форма, но только прошедшая схему.
  const parsed = executionPolicySchema.parse(policy);
  if (model) {
    const vendors = new Set([...runtimeAssignments(parsed).keys()].map(vendorOf));
    if (vendors.size > 1)
      throw new HarnessError(
        'INVALID_INPUT',
        `--model ${model} закрепляет одну модель на writer и всех reviewers, а политика назначает runtime разных вендоров (${[...runtimeAssignments(parsed).keys()].join(', ')}): укажите --review same или не задавайте --model`,
        [{ path: ['--model'], message: 'model-cross-vendor' }],
      );
  }
  return { input: policy, text: JSON.stringify(policy, null, 2) + '\n', shadowed };
}
