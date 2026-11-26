// Поддельный ведущий, который ведёт себя как настоящий по guide session
// (тесты `lead drive`, не модель): `lead begin` и заметка в каждой сессии;
// режим `decide` ещё принимает решение (команда журнала), `wait-owner` —
// `lead end --waiting owner`. Записывает stdin и окружение в
// <dir>/session-N.json. Аргументы: <dir> <state> <policy.json> <mode>.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executionPolicySchema } from '../../../src/contracts/index.ts';
import { Engine } from '../../../src/engine/engine.ts';
import { standaloneHost } from '../../../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../../../src/storage/sqlite.ts';
import {
  leadBegin,
  leadCommandEntry,
  leadEnd,
  leadNote,
  recordLeadCommand,
} from '../../../src/control/lead.ts';

const [dir, state, policyFile, mode = 'begin'] = process.argv.slice(2) as [
  string,
  string,
  string,
  string?,
];
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
const n = process.env.HARNESS_LEAD_DRIVE_SESSION ?? '0';
writeFileSync(
  join(dir, `session-${n}.json`),
  JSON.stringify({
    t: Date.now(),
    stdin,
    argv: process.argv.slice(2),
    env: {
      HARNESS_LEAD_DRIVE: process.env.HARNESS_LEAD_DRIVE,
      HARNESS_LEAD_DRIVE_EVENT: process.env.HARNESS_LEAD_DRIVE_EVENT,
    },
  }),
);
const policy = executionPolicySchema.parse(JSON.parse(readFileSync(policyFile, 'utf8')));
const store = new SqliteExecutionStore(join(state, 'state.sqlite'), 'fake-lead');
const engine = new Engine({ host: standaloneHost(store, policy), policy });
leadBegin(engine, { ttlMs: 30 * 60_000 });
leadNote(engine, { text: 'Разбираю событие драйвера' });
if (mode === 'decide') {
  const entry = leadCommandEntry('approve', {}, undefined);
  recordLeadCommand(engine, { ...entry! }, 'lead');
}
if (mode === 'wait-owner') leadEnd(engine, { waitingOwner: 'нужно решение владельца о тексте' });
store.close();
