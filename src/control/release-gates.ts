// Полный прогон gates на цели выпуска (alpha.71, ревью B): применимость по
// умолчанию и перенос на интеграцию — ускорение попыток, а приёмка выпуска
// опирается на полный `harness gates` на принятой цели: все gates
// репозитория, без неприменимости и без переноса. `review-release`
// исполняет его сам, когда его нет; `release done` без него отказывает.
//
// Ревью B2 M4: годен только прогон, записанный в состоянии движка
// (`gates-runs`) тем путём, который его исполнил: digest файла итога и
// основание (`gateBasis`) каждого gate. Файл итога, написанный руками,
// без записи в состоянии не засчитывается; смена toolchain, окружения,
// подготовки или версии harness делает прогон устаревшим.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sha256,
  WORKSPACE_OWNER,
  type ExecutionPolicy,
  type ExecutionView,
} from '../contracts/index.ts';
import type { Engine } from '../engine/engine.ts';
import { gateBasis } from '../verification/applicability.ts';
import { GATES_RESULT_FILE, type checkGates } from './gates-check.ts';

type Repo = ExecutionPolicy['repositories'][number];
type GatesData = Awaited<ReturnType<typeof checkGates>>;

/** Основание каждого gate репозитория под нынешней политикой и версией harness. */
export const gatesBasis = (policy: ExecutionPolicy, repo: Repo, harnessVersion: string) =>
  new Map(repo.gates.map((g) => [g.id, gateBasis(policy, repo, g, harnessVersion)]));

/** Записать прогон `harness gates` в состояние движка: digest файла итога и основание gates. */
export function recordGatesRun(engine: Engine, policy: ExecutionPolicy, data: GatesData) {
  const repo = policy.repositories.find((r) => r.id === data.repositoryId);
  if (!repo) return;
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(data.logs, GATES_RESULT_FILE));
  } catch {
    return;
  }
  const basis = gatesBasis(policy, repo, engine.version);
  engine.recordGatesRun(repo.id, data.sha, {
    id: data.id,
    at: new Date().toISOString(),
    digest: sha256(bytes),
    passed: data.passed,
    gates: data.gates.flatMap((g) =>
      basis.has(g.gate) ? [{ gate: g.gate, status: g.status, basis: basis.get(g.gate)! }] : [],
    ),
  });
}

/**
 * Почему на `sha` нет годного полного прогона gates репозитория, или
 * undefined: самый поздний прогон из состояния (`gates-runs`), где названы
 * все gates репозитория, прошёл целиком, его файл итога цел (тот же digest),
 * а основание каждого gate — нынешнее.
 */
export function fullGatesProblem(
  view: ExecutionView,
  stateDir: string,
  policy: ExecutionPolicy,
  repo: Repo,
  sha: string,
  harnessVersion: string,
): string | undefined {
  const short = sha.slice(0, 12);
  const next = `harness gates --state <каталог состояния> --repository ${repo.id} --sha ${sha}`;
  const runs = view.local('gates-runs', WORKSPACE_OWNER, `${repo.id}@${sha}`)?.runs ?? [];
  const run = runs
    .filter((r) => repo.gates.every((g) => r.gates.some((x) => x.gate === g.id)))
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);
  if (!run) return `нет полного прогона gates ${repo.id} на цели выпуска ${short}: ${next}`;
  const failed = run.gates.filter((g) => g.status !== 'passed').map((g) => g.gate);
  if (failed.length || !run.passed)
    return `полный прогон gates ${repo.id} ${run.id} на ${short} не прошёл: ${failed.join(', ') || 'итог не PASS'}`;
  let digest: string | undefined;
  try {
    digest = sha256(readFileSync(join(stateDir, 'gates-at', run.id, GATES_RESULT_FILE)));
  } catch {
    digest = undefined;
  }
  if (digest !== run.digest)
    return `итог полного прогона gates ${repo.id} ${run.id} на ${short} не совпадает с записью состояния — ${next}`;
  const basis = gatesBasis(policy, repo, harnessVersion);
  const stale = repo.gates.find(
    (g) => run.gates.find((r) => r.gate === g.id)?.basis !== basis.get(g.id),
  );
  if (stale)
    return `полный прогон gates ${repo.id} ${run.id} на ${short} устарел: основание gate ${stale.id} изменилось (определение, toolchain, окружение, подготовка или версия harness) — ${next}`;
  return undefined;
}

/**
 * Причины по репозиториям с принятыми работами (ревью B2 M2): цель не
 * читается — отказ с ходом; иначе `fullGatesProblem`.
 */
export function releaseGatesProblems(
  view: ExecutionView,
  stateDir: string,
  policy: ExecutionPolicy,
  heads: Readonly<Record<string, string | undefined>>,
  repositories: ReadonlySet<string>,
  harnessVersion: string,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const repo of policy.repositories) {
    if (!repositories.has(repo.id)) continue;
    const head = heads[repo.id];
    out[repo.id] = head
      ? fullGatesProblem(view, stateDir, policy, repo, head, harnessVersion)
      : `цель ${repo.targetRef} репозитория ${repo.id} не читается — полный прогон gates на ней не проверить: исправьте targetRef или путь checkout, затем harness review-release`;
  }
  return out;
}
