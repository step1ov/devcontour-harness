// Сбой среды тонкого режима (alpha.73): один автоповтор той же проверки или
// того же окружения, второй сбой — ведущему (`gate-environment`, не
// засчитан, без паузы и удержаний). Без классификаторов: сбой среды — это
// отказ класса `environment`, таймаут gate без упавшего теста и отказ
// подготовки окружения до первой проверки.

import { join } from 'node:path';
import {
  TaskFailure,
  type AttemptState,
  type EvidenceRecord,
  type GatePolicy,
} from '../contracts/index.ts';
import { namesFailingCases } from '../engine/engine.ts';
import { runSteps, withEnvironment } from '../environment/lifecycle.ts';
import { GateTimeout } from '../verification/gates.ts';
import type { ThinKit } from './kit.ts';

type Execution = ReturnType<ThinKit['environment']>;
type Repo = ThinKit['policy']['repositories'][number];

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Отказ подготовки окружения (до первой проверки фазы). */
class EnvironmentSetupFailure extends Error {
  constructor(readonly original: unknown) {
    super(text(original));
  }
}

/** Ведущему: та же проверка или подготовка дважды упала средой. */
function twice(label: string, error: unknown) {
  return new TaskFailure(
    'needs-lead',
    `${label}: сбой среды дважды подряд (автоповтор не помог): ${text(error).slice(0, 2000)}`,
    undefined,
    'gate-environment',
  );
}

/** Запустить `run`; сбой среды (`isEnvironment`) — ещё раз; второй — ведущему. */
export async function onceMore<T>(
  label: string,
  signal: AbortSignal,
  isEnvironment: (error: unknown) => boolean,
  run: (again: boolean) => Promise<T>,
): Promise<T> {
  try {
    return await run(false);
  } catch (error) {
    if (signal.aborted || !isEnvironment(error)) throw error;
    try {
      return await run(true);
    } catch (again) {
      if (signal.aborted || !isEnvironment(again)) throw again;
      throw twice(label, again);
    }
  }
}

/** Последняя собственная запись gate фазы на SHA. */
const lastRecord = (kit: ThinKit, attempt: AttemptState, gate: string, sha: string) =>
  kit.engine.read((v) =>
    (v.attempt(attempt.id)?.evidence ?? []).findLast(
      (e: EvidenceRecord) =>
        e.kind === 'test' &&
        e.gate === gate &&
        e.sha === sha &&
        e.phase === 'integration' &&
        !e.consumer,
    ),
  );

/** Gate интеграции: сбой среды — один повтор той же проверки (запись повтора ссылается на первую). */
export function thinGate(
  kit: ThinKit,
  input: {
    attempt: AttemptState;
    cwd: string;
    sha: string;
    gate: GatePolicy;
    artifacts: string;
    signal: AbortSignal;
    execution: Execution;
  },
) {
  const { attempt, cwd, sha, gate, artifacts, signal, execution } = input;
  const environmental = (error: unknown) => {
    if (error instanceof GateTimeout) {
      const record = lastRecord(kit, attempt, gate.id, sha);
      return (
        !record ||
        (!namesFailingCases(record) && !(record.tests ?? []).some((t) => t.status === 'failed'))
      );
    }
    return error instanceof TaskFailure && error.kind === 'environment';
  };
  return onceMore(`gate ${gate.id}`, signal, environmental, (again) =>
    kit.gate(
      attempt,
      cwd,
      sha,
      'integration',
      gate,
      artifacts,
      signal,
      execution,
      undefined,
      again ? lastRecord(kit, attempt, gate.id, sha)?.id : undefined,
    ),
  );
}

/**
 * Окружение фазы в дереве: lifecycle, хранилище зависимостей и prepare, затем
 * `action`. Отказ до `action` — сбой среды: один повтор всего окружения.
 */
export function thinEnvironment<T>(
  kit: ThinKit,
  input: {
    attempt: AttemptState;
    repo: Repo;
    cwd: string;
    /** Каталог артефактов фазы. */
    dir: string;
    stage: string;
    execution: Execution;
    signal: AbortSignal;
    base: string;
    /**
     * Дерево прошлых сдач (alpha.73, H-B): подготовка, упавшая на файлах
     * исполнителя (конфликт в манифесте), не останавливает сдачу — действие
     * получает текст отказа и чинит файлы. Без поля — повтор и ведущему.
     */
    tolerateSetup?: boolean;
  },
  action: (setupError?: string) => Promise<T>,
): Promise<T> {
  const { attempt, repo, cwd, dir, stage, execution, signal } = input;
  if (input.tolerateSetup) {
    let started = false;
    return withEnvironment(
      repo.lifecycle ?? kit.policy.lifecycle,
      cwd,
      join(dir, 'environment'),
      execution,
      signal,
      async () => {
        let setupError: string | undefined;
        try {
          await kit.dependencyStore(attempt, repo, cwd, execution, signal, dir);
          await kit.prepareSteps(attempt, `${stage}-prepare`, repo.prepare, () =>
            runSteps(repo.prepare, cwd, join(dir, 'prepare'), execution, signal, input.base),
          );
        } catch (error) {
          if (signal.aborted) throw error;
          setupError = text(error);
        }
        started = true;
        return action(setupError);
      },
      (name, run) => kit.timed(attempt, `${stage}-environment:${name}`, run),
    ).catch((error: unknown) => {
      // Lifecycle упал до действия: исполнитель работает без окружения и с причиной.
      if (started || signal.aborted) throw error;
      return action(text(error));
    });
  }
  return onceMore(
    `окружение ${stage}`,
    signal,
    (e) => e instanceof EnvironmentSetupFailure,
    async () => {
      let started = false;
      try {
        return await withEnvironment(
          repo.lifecycle ?? kit.policy.lifecycle,
          cwd,
          join(dir, 'environment'),
          execution,
          signal,
          async () => {
            try {
              await kit.dependencyStore(attempt, repo, cwd, execution, signal, dir);
              await kit.prepareSteps(attempt, `${stage}-prepare`, repo.prepare, () =>
                runSteps(repo.prepare, cwd, join(dir, 'prepare'), execution, signal, input.base),
              );
            } catch (error) {
              throw new EnvironmentSetupFailure(error);
            }
            started = true;
            return action(undefined);
          },
          (name, run) => kit.timed(attempt, `${stage}-environment:${name}`, run),
        );
      } catch (error) {
        // Отказ lifecycle до действия — тоже подготовка; отказ действия — как есть.
        if (error instanceof EnvironmentSetupFailure) throw error;
        if (!started) throw new EnvironmentSetupFailure(error);
        throw error;
      }
    },
  ).catch((error: unknown) => {
    throw error instanceof EnvironmentSetupFailure ? error.original : error;
  });
}
