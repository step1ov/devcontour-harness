// Поток сдачи тонкого режима (alpha.73). Сдача — одна попытка:
//   1. дерево работы (одно на все сдачи) и окружение в нём;
//   2. writer: новая сессия на первой сдаче, продолжение — на следующих (и
//      после разбора ведущего — с его текстом, R4);
//   3. коммит дерева — кандидат;
//   4. дерево интеграции: чистый checkout цели + слияние кандидата;
//   5. свои gates поручения, проверки потребителей, требования, одно ревью,
//      затем регрессионные gates (`regressionGates`, alpha.76) — только после
//      одобрения: отказ ревью возвращает сдачу writer без них;
//   6. CAS цели под замком интеграции репозитория. Цель сдвинулась — проверка
//      заново один раз; ещё раз — незасчитанный повтор следующей сдачей без writer.
// Отказ — обычный отказ попытки (те же записи, фаза integration): следующая
// сдача продолжит ту же сессию с находками. Принятие убирает дерево работы
// и её сессии.

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  codeReviewHistory,
  codeReviewScope,
  implementationResultSchema,
  inputPolicyOf,
  INPUT_LIMITS,
  TaskFailure,
  uncountedStop,
  type AttemptState,
  type RuntimeRequest,
} from '../contracts/index.ts';
import { gateFeedback } from '../engine/gate-feedback.ts';
import { countedFailure } from '../projections/lead-recovery.ts';
import { evaluateInput, normalizeImplementation } from '../engine/input-policy.ts';
import { attemptSecretsNote, leadDiagnosisNote, prompt } from '../engine/prompt.ts';
import { git } from '../environment/process.ts';
import { redactDeep } from '../environment/redaction.ts';
import { scopeRejectedPaths } from '../engine/scope.ts';
import { orderedScope } from '../verification/gate-scope.ts';
import { droppedGateOutputs, gateOutputPaths } from '../verification/gate-outputs.ts';
import { generatorNote, selectGenerators } from '../verification/generators.ts';
import { writerDependenciesNote, writerDependencyGates } from '../verification/gates.ts';
import type { ThinHandover, ThinKit } from './kit.ts';
import {
  handoverSummary,
  mergeText,
  setupText,
  regressionGatesText,
  resumePrompt,
  THIN_WRITER_TEXT,
  type ThinDelta,
} from './prompt.ts';
import { thinEnvironment, thinGate } from './rerun.ts';
import { diagnosisSince, intervention, lostSession, planSession, sessionHome } from './session.ts';
import { commitWork, ensureWorkTree, integrationTree, mergeBase, mergeTarget } from './tree.ts';

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Метка первого конфликта слияния при проверке: незасчитанный повтор (M4). */
export const MERGE_REQUEUE = 'MERGE_CONFLICT_REQUEUE';
type Gates = ThinHandover['repo']['gates'];

/** Вызов writer сдачи: новая сессия или продолжение; потерянная — одна новая со сводкой. */
async function writer(
  kit: ThinKit,
  h: ThinHandover,
  attempt: AttemptState,
  tree: string,
  /** Свои gates работы: их writer видит и гоняет сам. */
  gates: Gates,
  /** Регрессионные gates: harness исполняет их после ревью, writer — нет. */
  regression: string[],
  /** Слияние текущей цели в дерево работы перед этой сдачей; конфликт — файлы. */
  merged?: { conflicts: string[] },
  /** Подготовка окружения в дереве прошлых сдач упала (H-B): исполнитель чинит файлы. */
  setupError?: string,
) {
  const { work, repo, base, artifacts, signal, context } = h;
  const execution = kit.environment(attempt, 'candidate', tree);
  // Зависимости в дереве работы и самопроверка — как в облегчённом режиме:
  // исполнитель сам гоняет проверки поручения.
  const dependencies = await kit.writerDependencies(
    attempt,
    repo,
    tree,
    base,
    repo.writerDependencies === false ? [] : writerDependencyGates(gates),
    join(artifacts, 'candidate', 'writer-dependencies'),
    signal,
    execution,
    true,
  );
  await kit.prepareSelfCheck(attempt, repo, join(artifacts, 'self-check'));
  const history = kit.history(attempt);
  const previous = history.filter((a) => a.id !== attempt.id).at(-1);
  // Провал gates — только прошлого засчитанного отказа и только если это
  // провал gate; не через сброс попыток.
  const resetAt = work.leadRecovery?.resets.at(-1)?.at;
  const counted = history
    .filter((a) => a.id !== attempt.id && countedFailure(a) && (!resetAt || a.startedAt > resetAt))
    .at(-1);
  const failedGates = counted?.failureKind === 'gate' ? counted : undefined;
  const findings = (await kit.reviewProtocol(attempt.reviewer))
    ? kit.engine.read((v) =>
        codeReviewHistory(
          v.attempts(work.id),
          codeReviewScope(repo.id, work.id),
          v.work(work.id)?.codeReviewDecisions,
        ),
      )
    : undefined;
  const feedback = failedGates
    ? (await gateFeedback(failedGates, execution.redact).catch(() => undefined))?.text
    : undefined;
  // Отказ только областью (R1): пути и база работы — убрать или вернуть их.
  const outside =
    previous?.failureKind === 'scope-violation' ? scopeRejectedPaths(previous.error) : undefined;
  // Новые файлы прошлой сдачи, которые harness не взял в кандидата как выходы gates.
  const dropped = previous ? await droppedGateOutputs(join(dirname(artifacts), previous.id)) : [];
  const delta: ThinDelta = {
    ...(previous?.error ? { reason: previous.error } : {}),
    ...(dropped.length ? { dropped } : {}),
    ...(outside
      ? {
          scope: {
            paths: outside,
            base: await mergeBase(tree, base, 'HEAD').catch(() => base),
          },
        }
      : {}),
    ...(previous &&
    (uncountedStop(previous) ||
      previous.blocked ||
      previous.failureKind === 'environment' ||
      previous.failureKind === 'stalled')
      ? { stopped: true }
      : {}),
    ...(attempt.input ? { answer: attempt.input.requestId } : {}),
    ...(feedback ? { feedback } : {}),
    ...regressionDelta(failedGates, previous),
    ...(findings ? { findings } : {}),
    ...(context ? { context } : {}),
    ...(merged ? { merged } : {}),
    ...(setupError ? { setupError } : {}),
  };
  const full = prompt({
    work,
    attempt,
    history,
    ...(context ? { context } : {}),
    // Команды gates — с маской окружения: значения секретов в запрос не попадают.
    gates: gates.map((g) => ({
      id: g.id,
      command: g.command.map((a) => execution.redact(a)),
      ...(g.cwd ? { cwd: g.cwd } : {}),
    })),
    inputPolicy: attempt.inputPolicy ?? inputPolicyOf(kit.policy),
    notes: [
      ...kit.notes(attempt, false),
      ...(await kit.hostNotes(work, attempt, false)),
      ...(dependencies ? [writerDependenciesNote(dependencies)] : []),
      ...(repo.generators?.length ? [generatorNote(repo.generators)!] : []),
      ...((names) => (names.length ? [attemptSecretsNote(names)] : []))(kit.secretNames(attempt)),
      ...kit.proposalNotes(work),
      THIN_WRITER_TEXT,
      ...(regression.length ? [regressionGatesText(regression)] : []),
      ...(merged ? [mergeText(merged)] : []),
      ...(setupError ? [setupText(setupError)] : []),
    ],
    ...(findings ? { findings } : {}),
    ...(feedback ? { feedback } : {}),
  });
  // Сводка того, что уже сделано в дереве: для новой сессии вместо утраченной.
  const summary = async (why: string) => {
    const from = await mergeBase(tree, base, 'HEAD').catch(() => base);
    return handoverSummary({
      ...delta,
      why,
      commits: await git(tree, 'log', '--oneline', `${from}..HEAD`).catch(() => ''),
      diffStat: await git(tree, 'diff', '--stat', from).catch(() => ''),
    });
  };
  const home = await sessionHome(kit, repo, work, attempt.runtime);
  const dir = join(artifacts, 'implementation');
  const record = (id: string, mode: 'fresh' | 'resumed' | 'fallback', reason?: string) =>
    kit.engine.recordWriterSession(attempt.id, attempt.token, {
      runtime: attempt.runtime,
      id,
      mode,
      ...(reason ? { reason } : {}),
      ...(work.approvedDigest ? { spec: work.approvedDigest } : {}),
    });
  // Сессия записывается до исхода вызова: ID claude задаёт harness, ID codex
  // приходит событием — и при отказе следующая сдача продолжит её.
  const invoke = (
    request: string,
    session: Extract<RuntimeRequest['session'], { kind: 'continue' }> | undefined,
    mode: 'fresh' | 'resumed' | 'fallback',
    reason?: string,
  ) => {
    const preset = !session && attempt.runtime === 'claude' ? randomUUID() : undefined;
    if (session) record(session.id, mode, reason);
    if (preset) record(preset, mode, reason);
    return kit.timed(
      attempt,
      mode === 'fallback' ? 'implementation-fallback' : 'implementation',
      () =>
        kit.call(
          kit.adapter(attempt.runtime),
          {
            task: 'implement',
            attempt,
            cwd: tree,
            dir: mode === 'fallback' ? dir + '-fallback' : dir,
            phase: 'candidate',
            prompt: request,
            home,
            ...(session ? { session } : {}),
            ...(preset ? { freshSessionId: preset } : {}),
            onSession: (id) => record(id, mode, reason),
          },
          signal,
        ),
    );
  };
  const plan = await planSession(kit, attempt, work);
  try {
    // Разбор ведущего после прошлой сессии — в продолжение той же сессии
    // (R4); новой сессии он приходит заметкой полного запроса.
    const lead = diagnosisSince(kit, attempt, work);
    return plan.kind === 'resume'
      ? await invoke(
          resumePrompt({ ...delta, ...(lead ? { diagnosis: leadDiagnosisNote(lead) } : {}) }),
          { kind: 'continue', id: plan.id },
          'resumed',
        )
      : await invoke(
          // Новая сессия над деревом прежних сдач — со сводкой того, что в нём.
          previous ? full + '\n\n' + (await summary(plan.reason ?? 'новая сессия')) : full,
          undefined,
          'fresh',
          plan.reason,
        );
  } catch (error) {
    // Переполнение контекста или потерянная сессия: один новый вызов в той
    // же попытке со сводкой сдачи; второй такой же — обычный отказ попытки.
    if (!lostSession(error)) throw error;
    const why = text(error).slice(0, 500);
    return invoke(full + '\n\n' + (await summary(why)), undefined, 'fallback', why);
  }
}

/**
 * Упавшие регрессионные gates засчитанной сдачи `counted` (её ревью
 * одобрило, alpha.76) для продолжения writer. Сдача не прошлая (после неё —
 * незасчитанный отказ: окружение, вопрос, прерывание) — «более ранняя».
 */
export function regressionDelta(
  counted: AttemptState | undefined,
  previous: AttemptState | undefined,
): Pick<ThinDelta, 'regressed' | 'regressedEarlier'> {
  const regressed = counted ? failedRegression(counted) : [];
  if (!regressed.length) return {};
  return { regressed, ...(counted !== previous ? { regressedEarlier: true } : {}) };
}

/** Регрессионные gates попытки, чья последняя запись — провал. */
function failedRegression(a: AttemptState): string[] {
  const regression = new Set(a.regressionGates ?? []);
  const last = new Map<string, boolean>();
  for (const e of a.evidence)
    if (e.kind === 'test' && !e.consumer && regression.has(e.gate)) last.set(e.gate, e.passed);
  return [...last].filter(([, passed]) => !passed).map(([gate]) => gate);
}

/**
 * Новые файлы под объявленными выходами gates (P11-5) остаются в дереве, но
 * не в кандидате; их пути — в `implementation/gate-outputs.json` попытки.
 */
function gateOutputs(h: ThinHandover) {
  const outputs = gateOutputPaths(h.repo.gates);
  const dropped = new Set<string>();
  return {
    outputs,
    dropped: (paths: string[]) => paths.forEach((p) => dropped.add(p)),
    record: async () => {
      if (!dropped.size) return;
      const dir = join(h.artifacts, 'implementation');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'gate-outputs.json'),
        JSON.stringify({ outputs: outputs.paths, dropped: [...dropped].sort() }, null, 2),
      );
    },
  };
}

/** Ответ writer → кандидат: разбор, коммит дерева, область, вопросы. */
async function candidateOf(
  kit: ThinKit,
  h: ThinHandover,
  attempt: AttemptState,
  tree: string,
  response: Awaited<ReturnType<ThinKit['call']>>,
) {
  const { work, repo, base, context } = h;
  const output = redactDeep(response.output, response.redact);
  const parsed = implementationResultSchema.safeParse(output);
  const normalized = parsed.success ? undefined : normalizeImplementation(output);
  if (!parsed.success && !normalized)
    throw new Error('Ответ исполнителя вне схемы: ' + parsed.error.issues[0]?.message);
  const data = parsed.success ? parsed.data : normalized!.output;
  kit.engine.heartbeat(attempt.id, attempt.token);
  const left = gateOutputs(h);
  let sha = await commitWork(tree, `${work.id}: ${work.order.title}`, left.outputs, left.dropped);
  const from = await mergeBase(tree, base, sha);
  const changedOf = async (to: string) =>
    (await git(tree, 'diff', '--no-renames', '--name-only', from, to)).split('\n').filter(Boolean);
  // Генераторы политики — на изменённые входы, до проверки области: их
  // выходы — не правка исполнителя.
  const generators = selectGenerators(repo.generators ?? [], await changedOf(sha));
  if (generators.length) {
    h.rearm();
    await kit.generate(attempt, generators, tree, 'write', 'candidate', {
      execution: kit.environment(attempt, 'candidate', tree),
      signal: h.signal,
      artifacts: h.artifacts,
    });
    sha = await commitWork(tree, `${work.id}: generated outputs`, left.outputs, left.dropped);
  }
  await left.record();
  const empty = await kit.assertScope(
    work,
    repo,
    tree,
    context,
    [from, sha],
    true,
    generators.flatMap((g) => g.outputs),
  );
  const changed = await changedOf(sha);
  const decided = {
    ...data,
    ...(data.inputRequest ? { inputRequest: redactDeep(data.inputRequest, response.redact) } : {}),
    assumptions: redactDeep(data.assumptions, response.redact).slice(0, INPUT_LIMITS.assumptions),
  };
  const policy = attempt.inputPolicy ?? inputPolicyOf(kit.policy);
  kit.decideInput(
    attempt,
    decided,
    evaluateInput(decided, policy, changed),
    response.callId,
    normalized?.issues,
  );
  if (empty)
    throw new TaskFailure(
      'empty-result',
      'Изменений нет: сдача отчиталась о выполнении без правок в дереве работы',
    );
  await kit.implemented({ attempt, output: data, sha });
  return sha;
}

/** Проверка сдачи на чистом checkout цели и CAS; возвращает принятый SHA. */
async function verify(
  kit: ThinKit,
  h: ThinHandover,
  attempt: AttemptState,
  gates: Gates,
): Promise<string> {
  const { work, repo, repoPath, artifacts, signal, context, worktrees } = h;
  const regression = new Set(attempt.regressionGates ?? []);
  const candidate = attempt.candidateSha!;
  const target = await git(repoPath, 'rev-parse', repo.targetRef);
  const cwd = kit.checkout(repo.id, 'worktrees', attempt.id) + '-integration';
  if (!worktrees.includes(cwd)) worktrees.push(cwd);
  const sha = await integrationTree(repoPath, cwd, target, candidate).catch((error: unknown) => {
    // Первый конфликт слияния — незасчитанный повтор без ведущего: следующая
    // сдача сольёт цель в ветку работы, исполнитель разрешит конфликт.
    // Повторный — ведущему (`merge-conflict`).
    const prior = kit
      .history(attempt)
      .filter((a) => a.id !== attempt.id)
      .at(-1);
    if (
      error instanceof TaskFailure &&
      error.diagnosis === 'merge-conflict' &&
      !prior?.error?.startsWith(MERGE_REQUEUE)
    )
      throw new TaskFailure('stale-base', `${MERGE_REQUEUE}: ${error.message}`);
    throw error;
  });
  kit.engine.phase(attempt.id, attempt.token, 'integrating', { integrationSha: sha });
  const at: AttemptState = { ...attempt, integrationSha: sha };
  h.rearm();
  const execution = kit.environment(at, 'integration', cwd);
  const from = await mergeBase(cwd, target, candidate);
  await thinEnvironment(
    kit,
    {
      attempt: at,
      repo,
      cwd,
      dir: join(artifacts, 'integration'),
      stage: 'integration',
      execution,
      signal,
      base: target,
    },
    async () => {
      const applicable = await kit.applicableGates(
        at,
        work,
        repo,
        gates,
        'integration',
        cwd,
        sha,
        from,
      );
      // Выходы генераторов на слиянии обязаны остаться прежними (проверка
      // после gates установки, как в облегчённом режиме).
      const generators = repo.generators?.length
        ? selectGenerators(
            repo.generators,
            (await git(cwd, 'diff', '--no-renames', '--name-only', from, candidate))
              .split('\n')
              .filter(Boolean),
          )
        : [];
      const run = (gate: Gates[number]) =>
        thinGate(kit, { attempt: at, cwd, sha, gate, artifacts, signal, execution });
      await kit.verifyGenerated(
        at,
        applicable.filter((g) => !regression.has(g.id)),
        gates,
        generators,
        cwd,
        'integration',
        { execution, signal, artifacts },
        run,
      );
      await kit.consumers(at, cwd, sha, artifacts, signal);
      kit.requirements(at, work, repoPath, cwd, sha, 'integration');
      h.rearm();
      // Ревью — всё слияние против цели: diff всей работы, а не последней сдачи.
      await kit.review(at, work, cwd, target, sha, 'integration', artifacts, signal, context);
      // Регрессионные gates (alpha.76, R3) — после одобренного ревью, в том же
      // дереве и окружении, до CAS. Провал — обычный провал gate: writer
      // получает хвост, следующая сдача — свои gates и новое ревью.
      const after = applicable.filter((g) => regression.has(g.id));
      if (after.length) h.rearm();
      for (const gate of after) await run(gate);
    },
  );
  if (
    (await git(cwd, 'rev-parse', 'HEAD')) !== sha ||
    (await git(cwd, 'status', '--porcelain', '--untracked-files=no'))
  )
    throw new Error('Очистка окружения изменила проверенный код');
  signal.throwIfAborted();
  await kit.promote(at, work, repo, sha, target);
  return sha;
}

export const thinFlow = {
  handover: async (kit: ThinKit, h: ThinHandover): Promise<string> => {
    const { work, repo, repoPath, base, artifacts, signal } = h;
    // Сброс попыток ведущим — работа заново от цели: прежние дерево, ветка и сессии убраны.
    if (intervention(kit, h.attempt, work)?.reset) await kit.discard(repo.id, work.id);
    const dir = kit.checkout(repo.id, 'worktrees', `work-${work.id}`);
    const { created } = await ensureWorkTree(repoPath, dir, work.id, base);
    // Writer всегда в одном и том же дереве работы (настоящий путь): по нему
    // CLI находит сессию прошлой сдачи.
    const tree = realpathSync(dir);
    // Незакоммиченные правки прошлой сдачи — в ветку до слияния цели.
    if (!created)
      await commitWork(tree, `${work.id}: work in progress`, gateOutputPaths(repo.gates));
    const head = await git(tree, 'rev-parse', 'HEAD');
    // Прошлая сдача упала только сдвигом цели после проверки, а дерево то же:
    // проверка заново без writer (незасчитанный повтор).
    const previous = kit
      .history(h.attempt)
      .filter((a) => a.id !== h.attempt.id)
      .at(-1);
    const recheckOnly =
      previous?.failureKind === 'stale-base' &&
      !previous.error?.startsWith(MERGE_REQUEUE) &&
      previous.candidateSha === head
        ? head
        : undefined;
    // Цель сдвинулась с прошлой сдачи: она сливается в ветку работы; конфликт
    // остаётся в дереве, его разрешает исполнитель (не ход ведущего).
    const merged = created || recheckOnly ? undefined : await mergeTarget(tree, base);
    kit.engine.phase(h.attempt.id, h.attempt.token, 'running', { baseSha: base, worktree: dir });
    let attempt: AttemptState = { ...h.attempt, baseSha: base, worktree: dir };
    const gates = orderedScope(repo.gates, attempt.requiredGates ?? repo.gates.map((g) => g.id));
    // Writer видит и гоняет только свои gates; регрессионные — у harness (alpha.76).
    const regression = attempt.regressionGates ?? [];
    const own = gates.filter((g) => !regression.includes(g.id));
    const execution = kit.environment(attempt, 'candidate', tree);
    h.rearm();
    const candidate =
      recheckOnly ??
      (await thinEnvironment(
        kit,
        {
          attempt,
          repo,
          cwd: tree,
          dir: join(artifacts, 'candidate'),
          stage: 'candidate',
          execution,
          signal,
          base,
          // Дерево прошлых сдач или конфликт слияния цели: подготовка, упавшая
          // на файлах исполнителя, не останавливает сдачу (H-B).
          tolerateSetup: !created,
        },
        async (setupError) =>
          candidateOf(
            kit,
            h,
            attempt,
            tree,
            await writer(kit, h, attempt, tree, own, regression, merged, setupError),
          ),
      ));
    // База попытки — общая с целью база кандидата.
    const from = await mergeBase(tree, base, candidate);
    kit.engine.phase(attempt.id, attempt.token, 'verifying', {
      candidateSha: candidate,
      baseSha: from,
    });
    attempt = { ...attempt, candidateSha: candidate, baseSha: from };
    // Слияние, проверки, ревью и CAS — под замком интеграции репозитория.
    const sha = await kit.serialize(attempt, async () => {
      // Срок фазы — от взятия замка: ожидание чужой интеграции его не тратит.
      h.rearm();
      for (let round = 0; ; round++)
        try {
          return await verify(kit, h, attempt, gates);
        } catch (error) {
          // Цель сдвинулась между проверкой и CAS: проверка заново, без writer, один раз.
          if (round > 0 || !(error instanceof TaskFailure) || error.kind !== 'stale-base')
            throw error;
        }
    });
    // Принято: дерево работы, её ветка и сессии больше не нужны.
    await kit.discard(repo.id, work.id);
    return sha;
  },
};
