import type { z } from 'zod';
import {
  HarnessError,
  executionPolicySchema,
  expandGateRefs,
  graphIssues,
  policyDigest,
  policyIssues,
  workGraphDigest,
  workGraphSchema,
  type ErrorIssue,
  type ExecutionPolicy,
  type WorkGraph,
} from './contracts/index.ts';

type CodedIssue = ErrorIssue & { code: string };

const parse = <S extends z.ZodType>(schema: S, value: unknown, root: string): z.infer<S> => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new HarnessError(
    'INVALID_INPUT',
    `${root}: вход не прошёл проверку схемы`,
    parsed.error.issues.map((i) => ({
      path: [root, ...(i.path as (string | number)[])],
      message: i.message,
    })),
  );
};

/**
 * Связь поручений с политикой: репозиторий, роль, gates и потребители
 * поручения объявлены политикой и раскрываются без ошибок.
 */
export function crossIssues(graph: WorkGraph, policy: ExecutionPolicy): CodedIssue[] {
  const issues: CodedIssue[] = [];
  const repos = new Map(policy.repositories.map((r) => [r.id, r]));
  graph.orders.forEach((order, i) => {
    const at = (...p: (string | number)[]) => ['graph', 'orders', i, ...p];
    const repo = repos.get(order.repositoryId);
    if (!repo) {
      issues.push({
        code: 'INVALID_INPUT',
        path: at('repositoryId'),
        message: 'Репозиторий не объявлен политикой: ' + order.repositoryId,
      });
      return;
    }
    if (!policy.roles[order.role])
      issues.push({
        code: 'INVALID_INPUT',
        path: at('role'),
        message: 'Роль не объявлена политикой: ' + order.role,
      });
    const expand = (r: typeof repo, refs: string[] | undefined, path: (string | number)[]) => {
      try {
        expandGateRefs(r, refs);
      } catch (error) {
        issues.push({
          code: (error as { code?: string }).code ?? 'GATE_UNKNOWN',
          path,
          message: (error as Error).message,
        });
      }
    };
    expand(repo, order.gates, at('gates'));
    order.consumers?.forEach((c, k) => {
      const consumer = repos.get(c.repositoryId);
      if (!consumer)
        issues.push({
          code: 'INVALID_INPUT',
          path: at('consumers', k),
          message: 'Потребитель не объявлен политикой: ' + c.repositoryId,
        });
      else expand(consumer, c.gates, at('consumers', k, 'gates'));
    });
    order.relatedRepositories.forEach((r, k) => {
      if (!repos.has(r))
        issues.push({
          code: 'INVALID_INPUT',
          path: at('relatedRepositories', k),
          message: 'Репозиторий не объявлен политикой: ' + r,
        });
    });
  });
  return issues;
}

/**
 * Проверка входов без вызова моделей и без записи состояния. Ошибки
 * собираются все сразу; код первой определяет класс отказа.
 */
export function validateInputs(input: { graph: unknown; policy: unknown }) {
  const graph = parse(workGraphSchema, input.graph, 'graph');
  const policy = parse(executionPolicySchema, input.policy, 'policy');
  const issues = [
    ...graphIssues(graph).map((i) => ({ ...i, path: ['graph', ...i.path] })),
    ...policyIssues(policy).map((i) => ({ ...i, path: ['policy', ...i.path] })),
    ...crossIssues(graph, policy),
  ];
  if (issues.length)
    throw new HarnessError(
      issues[0]!.code as never,
      `Найдено нарушений: ${issues.length}`,
      issues.map(({ path, message }) => ({ path, message })),
    );
  return {
    graphId: graph.id,
    graphDigest: workGraphDigest(graph),
    policyDigest: policyDigest(policy),
    orders: graph.orders.length,
  };
}
