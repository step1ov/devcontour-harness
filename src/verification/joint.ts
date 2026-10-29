import {
  digestOf,
  HarnessError,
  type ExecutionPolicy,
  type ExecutionView,
  type JointVerification,
  type JointVerificationState,
  type JointBudgetCheckpoint,
} from '../contracts/index.ts';

/**
 * Совместная проверка закреплённой комбинации SHA репозиториев.
 *
 * Поручения принимаются по одному, каждое — в своём репозитории. Совместная
 * проверка отвечает на другой вопрос: работает ли вместе комбинация их
 * результатов. Она привязана к manifest (SHA и tree каждого репозитория), к
 * политике совместной проверки и к основанию — постановкам, статусам и
 * результатам поручений. Сменилось любое из них — прежний результат
 * устарел. Атомарного продвижения нескольких Git-репозиториев здесь нет;
 * продуктовое принятие комбинации решает хост.
 */

/** Политика совместной проверки: всё, от чего зависит её результат. */
export function jointPolicyDigest(policy: ExecutionPolicy) {
  return digestOf({
    repositories: policy.repositories,
    environment: policy.environment,
    workspaceLifecycle: policy.workspaceLifecycle,
    gates: policy.workspaceGates,
    verificationMode: policy.verificationMode,
    resources: policy.resources,
    // Совместная проверка исполняется в той же песочнице, что и проверки
    // поручений: её смена делает прежнюю проверку другой по условиям.
    isolation: policy.isolation,
  });
}

/** Основание проверки: поручения, их постановки, статусы и результаты. */
export function jointSpecDigest(view: ExecutionView, workIds: string[]) {
  return digestOf(
    [...workIds].sort().map((id) => {
      const w = view.work(id);
      return {
        id,
        order: w ? digestOf(w.order) : null,
        status: w?.status ?? null,
        resultSha: w?.resultSha ?? null,
      };
    }),
  );
}

/** Один и тот же набор поручений — один предмет проверки, независимо от порядка. */
export const sameWorks = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Незакрытые принятием попытки; checkpoints доверенного хоста проверяются целиком. */
export function jointBudgetAttempts(
  view: ExecutionView,
  workIds: string[],
  checkpoints: readonly JointBudgetCheckpoint[],
) {
  const invalid = () => {
    throw new HarnessError(
      'INVALID_INPUT',
      'Невалидная принятая граница бюджета совместных проверок',
    );
  };
  if (!Array.isArray(checkpoints)) invalid();
  const settled = new Set<string>();
  const anchors = new Set<string>();
  for (const checkpoint of checkpoints) {
    if (
      !checkpoint ||
      typeof checkpoint.verificationId !== 'string' ||
      !checkpoint.verificationId.length ||
      !Array.isArray(checkpoint.settledVerificationIds)
    )
      invalid();
    const { verificationId, settledVerificationIds: ids } = checkpoint;
    const anchor = view.verification(verificationId);
    if (
      anchors.has(verificationId) ||
      !anchor ||
      anchor.status !== 'passed' ||
      !sameWorks(anchor.workIds, workIds) ||
      !ids.length ||
      new Set(ids).size !== ids.length ||
      !ids.includes(verificationId)
    )
      invalid();
    anchors.add(verificationId);
    for (const id of ids) {
      if (typeof id !== 'string' || !id.length) invalid();
      const v = view.verification(id);
      if (!v || (v.status !== 'passed' && v.status !== 'failed') || !sameWorks(v.workIds, workIds))
        invalid();
      settled.add(id);
    }
  }
  return view.verifications().filter((v) => sameWorks(v.workIds, workIds) && !settled.has(v.id));
}

/** Gates совместной проверки в порядке их зависимостей. */
export function orderedWorkspaceGates(gates: ExecutionPolicy['workspaceGates']) {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const out: ExecutionPolicy['workspaceGates'] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    const gate = byId.get(id);
    if (gate) out.push(gate);
  };
  for (const gate of gates) visit(gate.id);
  return out;
}

/**
 * Какие gates исполнять. По умолчанию — все. В режиме `affected` при
 * известной прежней успешной комбинации под той же политикой — только
 * изменённые компоненты, их транзитивные потребители и prerequisites их
 * проверок; без достаточного теста в этой области — снова все.
 */
export function jointImpact(
  policy: ExecutionPolicy,
  manifest: NonNullable<JointVerification['manifest']>,
  policyDigest: string,
  baseline?: JointVerificationState,
): NonNullable<JointVerification['impact']> {
  const repos = policy.repositories;
  const all = repos.map((r) => r.id);
  const gates = orderedWorkspaceGates(policy.workspaceGates);
  const base =
    baseline?.status === 'passed' && baseline.policyDigest === policyDigest ? baseline : undefined;
  const changed = all.filter((id) => base?.manifest[id]?.sha !== manifest[id]?.sha);
  const full = (reason: string) => ({
    changed,
    affected: all,
    gateIds: gates.map((g) => g.id),
    mode: 'all' as const,
    reason,
    ...(base ? { baseline: base.id } : {}),
  });
  if (policy.verificationMode !== 'affected') return full('Полная проверка по умолчанию');
  if (!base) return full('Нет успешной комбинации SHA с текущей политикой');
  if (!changed.length) return full('SHA не изменились: повторная полная проверка');
  const affected = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const repo of repos)
      if (!affected.has(repo.id) && repo.dependsOn.some((id) => affected.has(id))) {
        affected.add(repo.id);
        grew = true;
      }
  }
  const selected = new Set(gates.filter((g) => affected.has(g.repositoryId)).map((g) => g.id));
  const include = (id: string) => {
    selected.add(id);
    for (const dep of gates.find((g) => g.id === id)?.dependsOn ?? [])
      if (!selected.has(dep)) include(dep);
  };
  [...selected].forEach(include);
  if (!gates.some((g) => selected.has(g.id) && g.kind === 'test' && g.report))
    return full('Нет достаточных тестов для затронутой области');
  return {
    changed,
    affected: [...affected],
    gateIds: gates.filter((g) => selected.has(g.id)).map((g) => g.id),
    mode: 'affected',
    reason: 'Изменённые компоненты, транзитивные потребители и prerequisites проверок',
    baseline: base.id,
  };
}

/** Публичная форма: без токена и срока владения. */
export function publicJoint(v: JointVerificationState): JointVerification {
  const copy: Partial<JointVerificationState> = { ...v };
  delete copy.token;
  delete copy.leaseUntil;
  return copy as JointVerification;
}
