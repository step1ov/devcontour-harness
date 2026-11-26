// Поток сдачи тонкого режима (alpha.73). Сдача — одна попытка:
//   1. дерево работы (одно на все сдачи) и окружение в нём;
//   2. writer: новая сессия на первой сдаче, продолжение — на следующих;
//   3. коммит дерева — кандидат;
//   4. дерево интеграции: чистый checkout цели + слияние кандидата;
//   5. gates поручения, проверки потребителей, требования, одно ревью;
//   6. CAS цели. Цель сдвинулась — проверка заново один раз, без writer.
// Отказ — обычный отказ попытки (те же записи, фаза integration): следующая
// сдача продолжит ту же сессию с находками. Принятие убирает дерево работы
// и её сессии.

import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  codeReviewHistory,
  codeReviewScope,
  implementationResultSchema,
  inputPolicyOf,
  INPUT_LIMITS,
  TaskFailure,
  type AttemptState,
  type RuntimeRequest,
} from '../contracts/index.ts';
import { gateFeedback } from '../engine/gate-feedback.ts';
import { evaluateInput, normalizeImplementation } from '../engine/input-policy.ts';
import { prompt } from '../engine/prompt.ts';
import { git } from '../environment/process.ts';
import { redactDeep } from '../environment/redaction.ts';
import { orderedScope } from '../verification/gate-scope.ts';
import { generatorNote, selectGenerators } from '../verification/generators.ts';
import { writerDependenciesNote, writerDependencyGates } from '../verification/gates.ts';
import type { ThinHandover, ThinKit } from './kit.ts';
import {
  handoverSummary,
  mergeText,
  resumePrompt,
  THIN_WRITER_TEXT,
  type ThinDelta,
} from './prompt.ts';
import { thinEnvironment, thinGate } from './rerun.ts';
import { lostSession, planSession, sessionHome, sessionsDir } from './session.ts';
import {
  commitWork,
  ensureWorkTree,
  integrationTree,
  mergeBase,
  mergeTarget,
  removeTree,
  workBranch,
} from './tree.ts';

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
type Gates = ThinHandover['repo']['gates'];

/** Вызов writer сдачи: новая сессия или продолжение; потерянная — одна новая со сводкой. */
async function writer(
  kit: ThinKit,
  h: ThinHandover,
  attempt: AttemptState,
  tree: string,
  gates: Gates,
  /** Слияние текущей цели в дерево работы перед этой сдачей; конфликт — файлы. */
  merged?: { conflicts: string[] },
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
  const findings = (await kit.reviewProtocol(attempt.reviewer))
    ? kit.engine.read((v) =>
        codeReviewHistory(
          v.attempts(work.id),
          codeReviewScope(repo.id, work.id),
          v.work(work.id)?.codeReviewDecisions,
        ),
      )
    : undefined;
  const feedback = previous
    ? (await gateFeedback(previous, execution.redact).catch(() => undefined))?.text
    : undefined;
  const delta: ThinDelta = {
    ...(previous?.error ? { reason: previous.error } : {}),
    ...(feedback ? { feedback } : {}),
    ...(findings ? { findings } : {}),
    ...(context ? { context } : {}),
    ...(merged ? { merged } : {}),
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
      THIN_WRITER_TEXT,
      ...(merged ? [mergeText(merged)] : []),
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
  const invoke = (
    request: string,
    session: Extract<RuntimeRequest['session'], { kind: 'continue' }> | undefined,
    callDir: string,
  ) =>
    kit.timed(attempt, 'implementation', () =>
      kit.call(
        kit.adapter(attempt.runtime),
        {
          task: 'implement',
          attempt,
          cwd: tree,
          dir: callDir,
          phase: 'candidate',
          prompt: request,
          home,
          ...(session ? { session } : {}),
        },
        signal,
      ),
    );
  const plan = await planSession(kit, attempt);
  let mode: 'fresh' | 'resumed' | 'fallback' = plan.kind === 'resume' ? 'resumed' : 'fresh';
  let reason = plan.kind === 'fresh' ? plan.reason : undefined;
  let response;
  try {
    response =
      plan.kind === 'resume'
        ? await invoke(resumePrompt(delta), { kind: 'continue', id: plan.id }, dir)
        : await invoke(
            // Новая сессия над деревом прежних сдач — со сводкой того, что в нём.
            previous && reason ? full + '\n\n' + (await summary(reason)) : full,
            undefined,
            dir,
          );
  } catch (error) {
    // Переполнение контекста или потерянная сессия: один новый вызов в той
    // же попытке со сводкой сдачи; второй такой же — обычный отказ попытки.
    if (!lostSession(error)) throw error;
    mode = 'fallback';
    reason = text(error).slice(0, 500);
    response = await invoke(full + '\n\n' + (await summary(reason)), undefined, dir + '-fallback');
  }
  const id = response.sessionId ?? (plan.kind === 'resume' ? plan.id : undefined);
  if (id)
    kit.engine.recordWriterSession(attempt.id, attempt.token, {
      runtime: attempt.runtime,
      id,
      mode,
      ...(reason ? { reason } : {}),
    });
  return response;
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
  let sha = await commitWork(tree, `${work.id}: ${work.order.title}`);
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
    sha = await commitWork(tree, `${work.id}: generated outputs`);
  }
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
  const candidate = attempt.candidateSha!;
  const target = await git(repoPath, 'rev-parse', repo.targetRef);
  const cwd = kit.checkout(repo.id, 'worktrees', attempt.id) + '-integration';
  if (!worktrees.includes(cwd)) worktrees.push(cwd);
  const sha = await integrationTree(repoPath, cwd, target, candidate);
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
      await kit.verifyGenerated(
        at,
        applicable,
        gates,
        generators,
        cwd,
        'integration',
        { execution, signal, artifacts },
        (gate) => thinGate(kit, { attempt: at, cwd, sha, gate, artifacts, signal, execution }),
      );
      await kit.consumers(at, cwd, sha, artifacts, signal);
      kit.requirements(at, work, repoPath, cwd, sha, 'integration');
      h.rearm();
      // Ревью — всё слияние против цели: diff всей работы, а не последней сдачи.
      await kit.review(at, work, cwd, target, sha, 'integration', artifacts, signal, context);
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
    const dir = kit.checkout(repo.id, 'worktrees', `work-${work.id}`);
    const { created } = await ensureWorkTree(repoPath, dir, work.id, base);
    // Writer всегда в одном и том же дереве работы (настоящий путь): по нему
    // CLI находит сессию прошлой сдачи.
    const tree = realpathSync(dir);
    // Цель сдвинулась с прошлой сдачи: она сливается в ветку работы; конфликт
    // остаётся в дереве, его разрешает исполнитель (не ход ведущего).
    const merged = created ? undefined : await mergeTarget(tree, base);
    kit.engine.phase(h.attempt.id, h.attempt.token, 'running', { baseSha: base, worktree: dir });
    let attempt: AttemptState = { ...h.attempt, baseSha: base, worktree: dir };
    const gates = orderedScope(repo.gates, attempt.requiredGates ?? repo.gates.map((g) => g.id));
    const execution = kit.environment(attempt, 'candidate', tree);
    h.rearm();
    const candidate = await thinEnvironment(
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
      },
      async () =>
        candidateOf(kit, h, attempt, tree, await writer(kit, h, attempt, tree, gates, merged)),
    );
    kit.engine.phase(attempt.id, attempt.token, 'verifying', { candidateSha: candidate });
    attempt = { ...attempt, candidateSha: candidate };
    let sha: string | undefined;
    for (let round = 0; sha === undefined; round++)
      try {
        sha = await verify(kit, h, attempt, gates);
      } catch (error) {
        // Цель сдвинулась между проверкой и CAS: проверка заново, без writer, один раз.
        if (round > 0 || !(error instanceof TaskFailure) || error.kind !== 'stale-base')
          throw error;
      }
    // Принято: дерево работы, её ветка и сессии больше не нужны.
    await removeTree(repoPath, dir).catch(() => undefined);
    await git(repoPath, 'branch', '-D', workBranch(work.id)).catch(() => undefined);
    await rm(sessionsDir(kit, repo, work), { recursive: true, force: true }).catch(() => undefined);
    return sha;
  },
};
