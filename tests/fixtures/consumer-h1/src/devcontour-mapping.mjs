/**
 * Хост, устроенный как DevContour: свои задачи, события и подготовка файлов,
 * а решения — общие операции установленного пакета. Хост добавляет только
 * свои тексты, поля и порядок отказов; ничего не вычисляет сам.
 *
 * Диагностика берётся из `devcontour-harness/projections` (без node:*,
 * годится для браузерного бандла), подготовка файлов — из корня пакета.
 */
import { chainRoots, nextAction, queueStop, workProgress } from 'devcontour-harness/projections';
import { checkDestination, planFileWrites, applyFileWrites } from 'devcontour-harness';

// OP-DIAG-01: прежние строки UI по машинному коду корня.
const chainTexts = {
  'failed-exhausted': () => [
    'сбой, бюджет попыток исчерпан',
    'ведущий устраняет причину и повторяет со сбросом бюджета',
  ],
  failed: () => ['сбой', 'повтор назначит восстановление или ведущий'],
  draft: () => ['план не утверждён', 'ревью и утверждение плана'],
  cancelled: () => ['отменена', 'перепланировать зависимые задачи'],
  held: (detail) => [`удержана: ${detail}`, 'дождаться завершения операции'],
  'budget-blocked': (detail) => [
    detail,
    'осознанно поднять предел в budgets или задать политику onUnknown',
  ],
  'attempts-exhausted': () => ['исчерпан бюджет попыток', 'повтор со сбросом бюджета'],
};

/** Задачи хоста → `ChainWork` 1:1; ответ — прежняя форма `{taskId, title, reason, next, waiting}`. */
export function chainBlockers(tasks, maxAttempts = 3) {
  const works = tasks.map((t) => ({
    id: t.id,
    status: t.status,
    dependsOn: t.dependsOn,
    attempt: t.attempt,
    ...(t.activeRunId ? { activeRunId: t.activeRunId } : {}),
    ...(t.hold ? { hold: t.hold } : {}),
    ...(t.budgetBlock ? { budgetBlock: t.budgetBlock } : {}),
    ...(t.failureKind ? { failureKind: t.failureKind } : {}),
  }));
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  return chainRoots(works, maxAttempts).map((root) => {
    const [reason, next] = chainTexts[root.code](root.detail);
    return {
      taskId: root.workId,
      title: titles.get(root.workId),
      reason,
      next,
      waiting: root.waiting,
    };
  });
}

/** OP-DIAG-04: события `scheduler.error` → вход `queueStop`; ответ — прежняя строка или undefined. */
export function queueStopReason(state, events) {
  return queueStop({
    paused: Boolean(state.paused),
    ...(state.pauseReason ? { pauseReason: state.pauseReason } : {}),
    errors: events
      .filter((e) => e.type === 'scheduler.error')
      .map((e) => ({ seq: e.id, message: e.data?.error })),
  }).detail;
}

// OP-DIAG-03: прежние тексты шага по машинному `step`.
const stepTexts = {
  accepted: () => 'Задача принята.',
  cancelled: () => 'Задача отменена.',
  'recovery-awaiting-lead': (v, approvalMode) =>
    approvalMode === 'agent'
      ? `Ограниченный разбор ведущего по свойству ${v.property}: сервер вызовет его сам в пределах бюджета.`
      : `Разбор свойства ${v.property}: решение ведущего через recovery_decide (operator mode автоматически не вызывает модель).`,
  'recovery-analyzing': (v) => `Ведущий разбирает отказы по свойству ${v.property}.`,
  'recovery-applying': () => 'Контур подтверждает предложенные случаи эталоном.',
  'recovery-retry-allowed': () => 'Разрешён один повтор по решению разбора; задача ждёт выдачи.',
  'recovery-retrying': () => 'Идёт разрешённый повтор.',
  'recovery-awaiting-user': (v) => v.detail ?? 'Нужно решение пользователя.',
  'recovery-stopped': (v) => v.detail ?? 'Автоматических действий больше нет.',
  'corpus-adoption': () => 'Новая версия корпуса будет принята после окончания попытки.',
  held: (v) => `Выдачу удерживает операция ${v.detail}.`,
  'plan-review': () => 'Черновик ждёт ревью плана.',
  'attempt-running': () => 'Идёт попытка: реализация, гейты, ревью и интеграция.',
  'retry-within-budget': () => 'Повтор в пределах бюджета попыток.',
  'attempts-exhausted': () => 'Попытки исчерпаны: сброс — решение человека с причиной.',
  'awaiting-claim': () => 'Задача ждёт выдачи.',
};

/** Задача хоста → `NextInput`; ответ — прежний `{actor, step}`. */
export function nextStep(task, { maxAttempts, approvalMode, waitingAdoption = false }) {
  const view = nextAction({
    status: task.status,
    attempt: task.attempt,
    maxAttempts,
    ...(task.hold ? { hold: { operation: task.hold.operation } } : {}),
    ...(task.recovery ? { recovery: task.recovery } : {}),
    waitingAdoption,
  });
  return { actor: view.actor, step: stepTexts[view.step](view, approvalMode) };
}

/**
 * OP-DIAG-02: kebab → snake; причины хоста до и после общих (Q2):
 * `[...hostBefore, ...shared, ...hostAfter]`.
 */
export function taskProgress(
  task,
  { statusOf, maxAttempts, paused, activeRuns, concurrency, host },
) {
  const hostBefore = [
    ...(host.productApprovalRequired ? ['product_approval_required'] : []),
    ...(host.inactiveRevision ? ['inactive_revision'] : []),
  ];
  const hostAfter = [
    ...(host.assignedToAnother ? ['assigned_to_another_member'] : []),
    ...(host.workspaceOperationActive ? ['workspace_operation_active'] : []),
  ];
  const view = workProgress({
    work: { status: task.status, attempt: task.attempt, dependsOn: task.dependsOn },
    statusOf,
    maxAttempts,
    paused,
    activeRuns,
    concurrency,
    hostReasons: [...hostBefore, ...hostAfter],
  });
  const reasons = [...hostBefore, ...view.reasons.map((r) => r.replaceAll('-', '_')), ...hostAfter];
  return {
    taskId: task.id,
    status: task.status,
    attempt: task.attempt,
    dependencies: view.dependencies,
    reasons,
    eligible: view.eligible,
  };
}

export const PROFILE_CHANGED = 'Сохранённый профиль изменён; требуется явная сверка версии';

/**
 * Подготовка файлов в порядке отказов хоста (M-2): (1) план общей операцией;
 * (2) первый конфликт, кроме `content-differs`, — отказ тем же текстом общей
 * проверки назначения; (3) сверки хоста (config/lock/approvalMode);
 * (4) `content-differs` профиля — прежнее сообщение. Затем create-only запись.
 */
export async function setupFiles({ files, profilePath, hostChecks }) {
  const plan = await planFileWrites({ files });
  const blocking = plan.entries.find(
    (e) => e.action === 'conflict' && e.conflict !== 'content-differs',
  );
  if (blocking) {
    if (blocking.conflict === 'not-regular-file')
      throw new Error(`Назначение не является обычным файлом: ${blocking.path}`);
    // Тот же отказ, что даёт общая операция (symlink, предок-файл): текст не дублируется.
    await checkDestination(blocking.path);
    throw new Error(`Конфликт ${blocking.conflict}: ${blocking.conflictPath ?? blocking.path}`);
  }
  hostChecks();
  const differs = plan.entries.find((e) => e.conflict === 'content-differs');
  if (differs)
    throw new Error(
      differs.path === profilePath ? PROFILE_CHANGED : `Файл изменён: ${differs.path}`,
    );
  return { plan, ...(await applyFileWrites(plan, files)) };
}
