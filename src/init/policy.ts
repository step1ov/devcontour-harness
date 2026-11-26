import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  HARNESS_PROJECT_DIR,
  HarnessError,
  POLICY_VERSION,
  executionPolicySchema,
  DEFAULT_RECOVERY,
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
 * профиле — поля нет, действует умолчание схемы). Срок фазы: без срока в
 * профиле — умолчание схемы, а если его не хватает пределам шагов политики —
 * наибольшая сумма фазы с запасом (`requiredRunTimeoutMs`). Срок профиля или
 * слоя (`lean`) — нижняя граница, а не предел: требуемый с запасом больше —
 * записывается он. Так слой никогда не даёт срока меньше, чем `init` без
 * слоя: граница gate слоя только поднимает пределы шагов. Прочие поля
 * политики не меняются; поля исполнения самой политики не учитываются.
 */
export function executionFieldsOf(
  policy: z.input<typeof executionPolicySchema>,
  profile: ResolvedProfile,
): Partial<Record<ExecutionField, number>> {
  const base: z.input<typeof executionPolicySchema> = { ...policy };
  for (const field of EXECUTION_FIELDS) delete base[field];
  Object.assign(base, profileExecution(profile));
  const budget = executionPolicySchema.parse(base);
  if (profile.runTimeoutMs !== undefined)
    base.runTimeoutMs = Math.max(requiredRunTimeoutMs(budget), profile.runTimeoutMs);
  else if (timeBudgetWarnings(budget).length) base.runTimeoutMs = requiredRunTimeoutMs(budget);
  return Object.fromEntries(
    EXECUTION_FIELDS.flatMap((f) => (base[f] === undefined ? [] : [[f, base[f]]])),
  );
}

/**
 * Срок фазы, который `init` до 0.1.0-alpha.51 выводил для профиля со своим
 * сроком (слой `lean`): срок профиля, пока пределам шагов его хватает без
 * запаса, иначе требуемый с запасом. Нет срока в профиле или значение то же,
 * что у `executionFieldsOf`, — `undefined`. По нему `harness lean` и `doctor`
 * отличают политику прежнего `init --lean` от ручной правки.
 */
export function priorLayerRunTimeoutMs(
  policy: z.input<typeof executionPolicySchema>,
  profile: ResolvedProfile,
): number | undefined {
  if (profile.runTimeoutMs === undefined) return undefined;
  const base: z.input<typeof executionPolicySchema> = { ...policy };
  for (const field of EXECUTION_FIELDS) delete base[field];
  Object.assign(base, profileExecution(profile));
  const budget = executionPolicySchema.parse(base);
  const prior = timeBudgetWarnings(budget).length
    ? Math.max(requiredRunTimeoutMs(budget), profile.runTimeoutMs)
    : profile.runTimeoutMs;
  return prior === executionFieldsOf(policy, profile).runTimeoutMs ? undefined : prior;
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
 * с явным `vendor: same-vendor-allowed`; правило ревью роли профиля с reviewer
 * того же вендора, что её writer, при `'same'` получает то же разрешение.
 * `model` закрепляется на каждом writer
 * и reviewer; одна модель у runtime двух вендоров — отказ. Параллельность и
 * нижняя граница предела gate — профиля (`profileExecution`); approval,
 * isolation и прочие бюджеты — умолчания схемы. Срок фазы (`runTimeoutMs`,
 * `executionFieldsOf`): без срока в профиле — умолчание схемы, пока его
 * хватает пределам шагов профиля (`timeBudgetWarnings`); иначе он
 * записывается явно: наибольшая сумма фазы с запасом 25 %, округлённая вверх
 * до 5 минут (`requiredRunTimeoutMs`). Срок профиля или слоя — нижняя
 * граница: требуемый с запасом больше — записывается он. Политика профиля без
 * срока, которой хватало умолчания, не меняется.
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
  /**
   * Технические вопросы исполнителя решает ведущий
   * (`init --lead-technical-answers`): `inputPolicy.leadAnswers.technical`.
   */
  leadTechnicalAnswers?: boolean;
  /**
   * Восстановление после повторных отказов (`init --recovery`,
   * `--diagnose-after`, `--lead-resets`): `policy.recovery` целиком, с
   * умолчаниями незаданных чисел. Нет — поля нет (выводится из
   * `leadTechnicalAnswers`).
   */
  recovery?: { mode: 'lead' | 'user'; diagnoseAfter?: number; leadResets?: number };
  /**
   * Режим harness (`init --harness-mode`, alpha.69): `strict` записывается
   * полем `harnessMode`; облегчённый — умолчание, поля нет. `thin`
   * (alpha.73) — полем и с одним проходом ревью работ (`review.passes.code: off`).
   */
  harnessMode?: 'light' | 'strict' | 'thin';
  /** Закреплённый node (`policy.toolchain`): предложение init. */
  toolchainPin?: { node: string };
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
  // Reviewer роли профиля того же вендора, что её writer, при `review: 'same'`
  // наследует разрешение общей политики (`same-vendor-allowed`): иначе правило
  // роли с умолчанием `different-vendor` запретило бы то, что выбрал init, и
  // поручения роли остановились бы на ревью. При `cross` правило роли
  // остаётся строгим, противоречие называют init и doctor.
  const inherit = (role: ReturnType<typeof profileRoles>[string]) =>
    mode === 'same' &&
    role.review &&
    vendorOf(role.review.reviewer.runtime) === vendorOf(role.writer.runtime)
      ? { ...role, review: { ...role.review, vendor: 'same-vendor-allowed' as const } }
      : role;
  const roles = Object.keys(profile.roles).length
    ? Object.fromEntries(
        Object.entries(profileRoles(profile)).map(([id, profiled]) => {
          const role = inherit(profiled);
          return [
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
          ];
        }),
      )
    : { developer: { writer: bind({ runtime: writer }) } };
  const policy: z.input<typeof executionPolicySchema> = {
    policyVersion: POLICY_VERSION,
    repositories: [repository],
    roles,
    review: {
      code: rule(writer),
      plan: rule(lead),
      contract: rule(lead),
      ...(input.harnessMode === 'thin' ? { passes: { code: 'off' as const } } : {}),
    },
    ...profileExecution(profile),
    ...(input.leadTechnicalAnswers
      ? { inputPolicy: { threshold: 7, criticalPaths: [], leadAnswers: { technical: true } } }
      : {}),
    ...(input.harnessMode === 'strict' || input.harnessMode === 'thin'
      ? { harnessMode: input.harnessMode }
      : {}),
    ...(input.recovery
      ? {
          recovery: {
            mode: input.recovery.mode,
            diagnoseAfter: input.recovery.diagnoseAfter ?? DEFAULT_RECOVERY.diagnoseAfter,
            leadResets: input.recovery.leadResets ?? DEFAULT_RECOVERY.leadResets,
          },
        }
      : {}),
  };
  const { runTimeoutMs } = executionFieldsOf(policy, profile);
  if (runTimeoutMs !== policy.runTimeoutMs) policy.runTimeoutMs = runTimeoutMs;
  // Закреплённый node — последним полем: `lean` дописывает и возвращает поля
  // профиля на их место, и файл после `lean --off` совпадает с init без слоя.
  if (input.toolchainPin) policy.toolchain = input.toolchainPin;
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
