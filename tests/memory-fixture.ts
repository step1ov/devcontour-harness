/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Фикстура правит сырой JSON политики и графа до разбора схемой.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ContextSnapshot,
  RuntimeAdapter,
  RuntimeRequest,
  WorkGraph,
} from '../src/contracts/index.ts';
import type { Harness } from '../src/control/harness.ts';
import { FileContextSource } from '../src/connectors/files.ts';
import { hsetup } from './harness-fixture.ts';
import type { Scenario } from './runner-fixture.ts';

/** Проект fixture с операторским согласованием и записью фактических запросов runtime. */
export function msetup(options: { scenario: Scenario; context: string[] }) {
  const ctx = hsetup({
    scenario: options.scenario,
    policy: (p) => {
      (p as any).approvalMode = 'operator';
      (p as any).maxAttempts = 1;
    },
    graph: (g) => ((g as any).orders[0].context = options.context),
  });
  // Каталог файлового контекста: источник norms.
  const contextDir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-memory-context-')));
  mkdirSync(join(contextDir, 'norms'));
  writeFileSync(join(contextDir, 'norms', 'style.md'), 'Функции экспортируются через exports.\n');
  const files = new FileContextSource(contextDir);
  const requests: RuntimeRequest[] = [];
  const capture = (adapter: RuntimeAdapter): RuntimeAdapter => ({
    runtime: adapter.runtime,
    capabilities: () => adapter.capabilities(),
    invoke: (request, signal) => {
      requests.push(structuredClone(request));
      return adapter.invoke(request, signal);
    },
  });
  const open = () => ctx.open(ctx.policy, capture);
  const prompts = (task: RuntimeRequest['task']) =>
    requests.filter((r) => r.task === task).map((r) => r.prompt);
  return { ...ctx, files, contextDir, requests, open, prompts };
}

/**
 * Обычный операторский путь: регистрация (`run` отказывает до согласования),
 * ревью плана с тем же снимком, согласование digest зарегистрированного графа.
 */
export async function reviewAndApprove(h: Harness, graph: WorkGraph, context: ContextSnapshot) {
  await h.run({ graph, author: 'claude', context }).then(
    () => {
      throw new Error('run без согласования не должен исполняться');
    },
    (e: unknown) => {
      if ((e as { code?: string }).code !== 'APPROVAL_REQUIRED') throw e;
    },
  );
  const review = await h.review({ kind: 'plan', graph, context, author: 'claude' });
  if (!review.approved) throw new Error('ревью плана не одобрило: ' + review.summary);
  const digest = h.engine.read((v) => v.graph(graph.id)!.digest);
  return h.approve(graph.id, digest);
}

/** Evidence для отчёта — только если задан каталог (`HARNESS_EVIDENCE_DIR`). */
export function evidence(id: string, name: string, value: unknown) {
  const root = process.env.HARNESS_EVIDENCE_DIR;
  if (!root) return;
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n');
}
