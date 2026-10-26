import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContractDocument, GatePolicy, WorkOrder } from '../contracts/index.ts';
import { isReference, obligationOf } from './checks.ts';

/**
 * Самопроверка исполнителя: тот же закреплённый checker, полный корпус
 * закреплённой версии, генератор с воспроизводимым seed и селектор свойств
 * поручения. Проверяется рабочий, незакоммиченный код — результат
 * диагностический и не заменяет evidence controller на commit SHA: gates
 * исполняются всегда, с самопроверкой или без неё.
 */
export interface SelfCheckPlan {
  command: string[];
  corpus?: string;
  cases: number;
  seed: number;
  properties: string[];
}

export async function writeSelfCheck(input: {
  order: Pick<WorkOrder, 'id' | 'properties'>;
  contracts: ContractDocument[];
  gates: GatePolicy[];
  dir: string;
  seed: number;
  /** Канонический файл закреплённой версии корпуса и число её случаев. */
  corpus?: { content: string; cases: number };
}): Promise<SelfCheckPlan | undefined> {
  const gates = new Map<string, { command: string[]; cwd?: string; properties: string[] }>();
  for (const id of input.order.properties ?? []) {
    const found = obligationOf(input.contracts, id);
    // Gate эталонных наборов отчитывается тем же отчётом свойств.
    for (const gate of input.gates.filter(
      (g) => found?.gates.includes(g.id) && (g.property || isReference(found.obligation)),
    )) {
      const entry = gates.get(gate.id) ?? {
        command: gate.command,
        ...(gate.cwd ? { cwd: gate.cwd } : {}),
        properties: [],
      };
      entry.properties.push(id);
      gates.set(gate.id, entry);
    }
  }
  if (!gates.size) return undefined;
  await mkdir(input.dir, { recursive: true });
  const corpus = input.corpus ? join(input.dir, 'corpus.json') : undefined;
  if (input.corpus) await writeFile(corpus!, input.corpus.content);
  const plan = {
    work: input.order.id,
    seed: input.seed,
    corpus: corpus ?? null,
    gates: [...gates].map(([id, g]) => ({ id, ...g })),
  };
  const script = join(input.dir, 'selfcheck.mjs');
  await writeFile(script, selfCheckSource(plan));
  return {
    command: [process.execPath, script],
    ...(corpus ? { corpus } : {}),
    cases: input.corpus?.cases ?? 0,
    seed: input.seed,
    properties: [...new Set([...gates.values()].flatMap((g) => g.properties))],
  };
}

/** Строка запроса исполнителю о самопроверке. */
export function selfCheckNote(plan: SelfCheckPlan) {
  return `Self-check: run \`${plan.command.join(' ')}\` from the worktree root before returning. It runs the pinned checker on your working tree with ${plan.cases} mandatory corpus cases, the generator with seed ${plan.seed} and your properties (${plan.properties.join(', ')}). A non-zero exit names the property, the exact input and the reason. It is diagnostic: the controller still runs the gates on your commit.`;
}

function selfCheckSource(plan: unknown) {
  return `// Самопроверка исполнителя: закреплённый checker, полный корпус, seed и
// свойства поручения. Диагностика рабочего кода: controller всё равно
// исполняет gates на commit SHA. Ненулевой код — свойство, точный вход и причина.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const plan = ${JSON.stringify(plan, null, 2)};
const both = (name, value) => ({ ['DEVCONTOUR_' + name]: value, ['HARNESS_' + name]: value });
let failed = 0;
for (const gate of plan.gates) {
  const scratch = mkdtempSync(join(tmpdir(), 'harness-self-'));
  const report = join(scratch, 'property.json');
  const result = spawnSync(gate.command[0], gate.command.slice(1), {
    cwd: gate.cwd ? join(process.cwd(), gate.cwd) : process.cwd(),
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      ...both('SEED', String(plan.seed)),
      ...both('PROPERTIES', gate.properties.join(',')),
      ...(plan.corpus ? both('CORPUS', plan.corpus) : {}),
      ...both('PROPERTY_REPORT', report),
      ...both('REPORT_PATH', join(scratch, 'junit.xml')),
    },
  });
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(report, 'utf8'));
  } catch {}
  rmSync(scratch, { recursive: true, force: true });
  if (!parsed) {
    failed++;
    console.log('FAIL ' + gate.id + ': отчёт свойств не записан (код выхода ' + result.status + ')');
    continue;
  }
  for (const p of parsed.properties) {
    if (p.status === 'passed') continue;
    failed++;
    const c = p.counterexample;
    const input = c ? (c.reduced ?? c.original) : p.current;
    const reason = p.error ?? (c ? 'ожидалось ' + JSON.stringify(c.expected) + ', получено ' + JSON.stringify(c.actual) : 'не завершилось');
    console.log('FAIL ' + p.testId + (c && c.case ? ' [случай корпуса ' + c.case + ']' : '') + ': input=' + JSON.stringify(input) + ' — ' + reason);
  }
  for (const f of parsed.corpus?.failed ?? [])
    console.log('CORPUS ' + f.property + ' [' + f.id + ']: ожидалось ' + JSON.stringify(f.expected) + ', получено ' + JSON.stringify(f.actual));
  if (result.status && !parsed.properties.some((p) => p.status !== 'passed')) {
    failed++;
    console.log('FAIL ' + gate.id + ': код выхода ' + result.status);
  }
}
console.log(failed ? 'self-check: ' + failed + ' failing (seed ' + plan.seed + ')' : 'self-check: all properties hold (seed ' + plan.seed + '); diagnostic only — the controller runs the gates on your commit');
process.exit(failed ? 1 : 0);
`;
}
