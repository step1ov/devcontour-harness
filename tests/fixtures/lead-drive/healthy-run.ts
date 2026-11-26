// Поддельный исправный `harness run` (тесты `run --detach`, не модель):
// ставит метку запуска run в состоянии (как Harness.run), пишет строку в
// stdout, ждёт полторы секунды и снимает метку. Аргументы — как у run:
// `run --state <каталог> --policy <файл> …`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executionPolicySchema } from '../../../src/contracts/index.ts';
import { Engine } from '../../../src/engine/engine.ts';
import { standaloneHost } from '../../../src/engine/standalone.ts';
import { SqliteExecutionStore } from '../../../src/storage/sqlite.ts';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name: string) => args[args.indexOf(name) + 1]!;
const state = flag('--state');
mkdirSync(state, { recursive: true });
const policy = executionPolicySchema.parse(JSON.parse(readFileSync(flag('--policy'), 'utf8')));
const store = new SqliteExecutionStore(join(state, 'state.sqlite'), 'fake-run');
const engine = new Engine({ host: standaloneHost(store, policy), policy });
engine.recordRunStart(process.pid, 60_000);
process.stdout.write('fake run started\n');
await new Promise((r) => setTimeout(r, 1500));
engine.clearRunStart(process.pid);
store.close();
