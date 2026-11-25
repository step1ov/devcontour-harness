// Полный прогон gates на цели выпуска (alpha.71, ревью B): применимость по
// умолчанию и перенос на интеграцию — ускорение попыток, а приёмка выпуска
// опирается на полный `harness gates` на принятой цели: все gates
// репозитория, без неприменимости и без переноса. `review-release`
// исполняет его сам, когда его нет; `release done` без него отказывает.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gateDigest, type ExecutionPolicy } from '../contracts/index.ts';
import { GATES_RESULT_FILE } from './gates-check.ts';

type Repo = ExecutionPolicy['repositories'][number];

interface StoredResult {
  at?: string;
  data?: {
    id?: string;
    repositoryId?: string;
    sha?: string;
    passed?: boolean;
    gates?: { gate?: string; status?: string; definition?: string }[];
  };
}

/** Самый поздний итог `harness gates` репозитория на этом SHA, в котором названы все его gates. */
function newestFull(stateDir: string, repo: Repo, sha: string) {
  const root = join(stateDir, 'gates-at');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return undefined;
  }
  let newest: { at: number; data: NonNullable<StoredResult['data']> } | undefined;
  for (const name of names)
    try {
      const raw = JSON.parse(
        readFileSync(join(root, name, GATES_RESULT_FILE), 'utf8'),
      ) as StoredResult;
      const d = raw.data;
      const at = Date.parse(raw.at ?? '');
      if (!d || d.repositoryId !== repo.id || d.sha !== sha || Number.isNaN(at)) continue;
      // Прогон части gates (`--gate`) полным не бывает.
      const named = new Set((d.gates ?? []).map((g) => g.gate));
      if (!repo.gates.every((g) => named.has(g.id))) continue;
      if (!newest || at > newest.at) newest = { at, data: d };
    } catch {
      /* чужой или неполный итог */
    }
  return newest?.data;
}

/**
 * Почему на `sha` нет годного полного прогона gates репозитория, или
 * undefined: самый поздний полный итог на этом SHA прошёл целиком, и
 * определение каждого gate — нынешнее (`gateDigest`).
 */
export function fullGatesProblem(stateDir: string, repo: Repo, sha: string): string | undefined {
  const short = sha.slice(0, 12);
  const run = newestFull(stateDir, repo, sha);
  const next = `harness gates --state <каталог состояния> --repository ${repo.id} --sha ${sha}`;
  if (!run) return `нет полного прогона gates ${repo.id} на цели выпуска ${short}: ${next}`;
  const failed = (run.gates ?? []).filter((g) => g.status !== 'passed').map((g) => g.gate);
  if (failed.length || run.passed !== true)
    return `полный прогон gates ${repo.id} ${run.id ?? ''} на ${short} не прошёл: ${failed.join(', ') || 'итог не PASS'}`;
  const stale = repo.gates.find(
    (g) => run.gates?.find((r) => r.gate === g.id)?.definition !== gateDigest(g),
  );
  if (stale)
    return `полный прогон gates ${repo.id} ${run.id ?? ''} на ${short} устарел: определение gate ${stale.id} изменилось — ${next}`;
  return undefined;
}
