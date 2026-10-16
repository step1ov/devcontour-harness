// FIXTURE: процесс, который проводит приёмку и падает после CAS update-ref,
// до фиксации транзакции SQLite. Аргументы: state.sqlite, policy.json, repo,
// attempt id, token, integration SHA, base SHA, target ref.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { executionPolicySchema } from '../../src/contracts/index.ts';
import { Engine } from '../../src/engine/engine.ts';
import { standaloneHost } from '../../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../../src/storage/sqlite.ts';

const [state, policyPath, repo, id, token, integration, base, ref] = process.argv.slice(
  2,
);
const policy = executionPolicySchema.parse(JSON.parse(readFileSync(policyPath!, 'utf8')));
const store = new SqliteExecutionStore(state!, 'crash');
const engine = new Engine({ host: standaloneHost(store, policy), policy });
engine.finish(id!, token!, integration!, () => {
  execFileSync('git', ['update-ref', ref!, integration!, base!], { cwd: repo, stdio: 'pipe' });
  // Аварийный выход посреди транзакции: ни COMMIT, ни ROLLBACK не выполняются.
  process.kill(process.pid, 'SIGKILL');
});
