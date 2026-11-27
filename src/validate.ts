import type { z } from 'zod';
import {
  roleBinding,
  HarnessError,
  executionPolicySchema,
  expandGateRefs,
  graphIssues,
  policyDigest,
  policyIssues,
  sha256,
  contextDigest,
  contextIssues,
  contextSnapshotSchema,
  type ContextSnapshot,
  workGraphDigest,
  workGraphSchema,
  withinInfra,
  type CodedIssue,
  type ErrorCode,
  type ExecutionPolicy,
  type WorkGraph,
} from './contracts/index.ts';

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

/** Путь внутри одного из префиксов (как `withinPaths` DevContour). */
export const withinPaths = (path: string, prefixes: string[]) =>
  prefixes.some((p) => p === '.' || path === p || path.startsWith(p.endsWith('/') ? p : p + '/'));

/**
 * Связь поручений с политикой — проверки DevContour `validateTaskContext`,
 * выполнимые без модели и без внешних источников: репозиторий и роль
 * объявлены; ресурсы известны; область записи пересекается с областью роли;
 * область доказательства раскрывается, замкнута по `dependsOn` gates и
 * содержит test gate; требования не повторяются, их текст совпадает с
 * digest, а gate — test gate из области; потребители уникальны, отличны от
 * провайдера, зависят от него и проверяются test gate; поручение уровня
 * workspace затрагивает минимум два известных репозитория.
 *
 * Не проверяется здесь: байты и digests контекста и контрактов — их
 * сверяет движок с `ContextSource` при регистрации графа.
 */
export function crossIssues(graph: WorkGraph, policy: ExecutionPolicy): CodedIssue[] {
  const issues: CodedIssue[] = [];
  const repos = new Map(policy.repositories.map((r) => [r.id, r]));
  const resources = new Set(policy.resources.map((r) => r.id));
  const dependsOn = (consumer: string, provider: string) => {
    const seen = new Set<string>();
    const visit = (id: string): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      return (repos.get(id)?.dependsOn ?? []).some((p) => p === provider || visit(p));
    };
    return visit(consumer);
  };
  graph.prerequisites.forEach((p, i) => {
    if (!repos.has(p.repositoryId))
      issues.push({
        code: 'INVALID_INPUT',
        path: ['graph', 'prerequisites', i, 'repositoryId'],
        message: 'Репозиторий предпосылки не объявлен политикой: ' + p.repositoryId,
      });
  });
  graph.orders.forEach((order, i) => {
    const at = (...p: (string | number)[]) => ['graph', 'orders', i, ...p];
    const add = (code: ErrorCode, path: (string | number)[], message: string) =>
      issues.push({ code, path, message });
    const repo = repos.get(order.repositoryId);
    if (!repo) {
      add(
        'INVALID_INPUT',
        at('repositoryId'),
        'Репозиторий не объявлен политикой: ' + order.repositoryId,
      );
      return;
    }
    const role = roleBinding(policy, order.role, order.repositoryId);
    if (!role) add('INVALID_INPUT', at('role'), 'Роль не объявлена политикой: ' + order.role);
    for (const r of order.resources ?? [])
      if (!resources.has(r)) add('INVALID_INPUT', at('resources'), 'Неизвестный ресурс: ' + r);
    // Работу инфраструктуры область роли не сужает (runner: `scopeViolations`):
    // её область записи проверяет область инфраструктуры ниже.
    if (role?.writePaths?.length && order.kind !== 'infra') {
      const reachable = order.writeScope.filter(
        (p) =>
          withinPaths(p, role.writePaths!) || role.writePaths!.some((r) => withinPaths(r, [p])),
      );
      if (!reachable.length)
        add(
          'INVALID_INPUT',
          at('writeScope'),
          `Область записи поручения не пересекается с областью роли ${order.role}: исполнитель не сможет изменить ни одного файла`,
        );
    }
    const expand = (
      r: typeof repo,
      refs: string[] | undefined,
      path: (string | number)[],
      label: string,
    ) => {
      let gates: string[];
      try {
        gates = expandGateRefs(r, refs);
      } catch (error) {
        add((error as { code?: ErrorCode }).code ?? 'GATE_UNKNOWN', path, (error as Error).message);
        return undefined;
      }
      for (const id of gates)
        for (const parent of r.gates.find((g) => g.id === id)?.dependsOn ?? [])
          if (!gates.includes(parent))
            add(
              'INVALID_INPUT',
              path,
              `Область ${label}: gate ${id} требует ${parent} — добавьте ${parent} явно`,
            );
      if (!gates.some((id) => r.gates.some((g) => g.id === id && g.kind === 'test')))
        add('INVALID_INPUT', path, `Область ${label} должна включать test gate`);
      return gates;
    };
    const own = expand(repo, order.gates, at('gates'), 'поручения');
    // Регрессионные gates (alpha.76, R3): известные ссылки, не повтор своей
    // области; их предпосылки — в одной из двух областей (исполняются после
    // своих gates в том же дереве), свои gates от регрессионных не зависят.
    let regression: string[] = [];
    if (order.regressionGates) {
      try {
        regression = expandGateRefs(repo, order.regressionGates);
      } catch (error) {
        add(
          (error as { code?: ErrorCode }).code ?? 'GATE_UNKNOWN',
          at('regressionGates'),
          (error as Error).message,
        );
      }
      const explicit = order.gates?.length ? (own ?? []) : undefined;
      const twice = explicit ? regression.filter((id) => explicit.includes(id)) : [];
      if (twice.length)
        add(
          'INVALID_INPUT',
          at('regressionGates'),
          `Gate и в gates, и в regressionGates: ${twice.join(', ')} — регрессионные gates не повторяют свою область`,
        );
      const mine = explicit ?? repo.gates.map((g) => g.id).filter((id) => !regression.includes(id));
      const parents = (id: string) => repo.gates.find((g) => g.id === id)?.dependsOn ?? [];
      for (const id of regression)
        for (const parent of parents(id))
          if (!mine.includes(parent) && !regression.includes(parent))
            add(
              'INVALID_INPUT',
              at('regressionGates'),
              `Регрессионный gate ${id} требует ${parent} — добавьте ${parent} в gates или regressionGates`,
            );
      if (!explicit) {
        for (const id of mine)
          for (const parent of parents(id))
            if (regression.includes(parent))
              add(
                'INVALID_INPUT',
                at('regressionGates'),
                `Gate ${id} своей области требует регрессионный ${parent}: предпосылка своего gate исполняется до ревью`,
              );
        if (!mine.some((id) => repo.gates.some((g) => g.id === id && g.kind === 'test')))
          add(
            'INVALID_INPUT',
            at('regressionGates'),
            'Своя область поручения (все gates, кроме регрессионных) должна включать test gate',
          );
      }
    }
    const keys = new Set<string>();
    order.requirements.forEach((req, k) => {
      const key = `${req.source}#${req.id}`;
      if (keys.has(key)) add('INVALID_INPUT', at('requirements', k), 'Повтор требования: ' + key);
      keys.add(key);
      if (sha256(req.text) !== req.digest)
        add(
          'INVALID_INPUT',
          at('requirements', k, 'digest'),
          'Текст требования не соответствует digest',
        );
      if (!repo.gates.some((g) => g.id === req.gate && g.kind === 'test'))
        add(
          'INVALID_INPUT',
          at('requirements', k, 'gate'),
          'Требование должно ссылаться на test gate: ' + req.gate,
        );
      else if (order.gates && own && !own.includes(req.gate))
        add(
          'INVALID_INPUT',
          at('requirements', k, 'gate'),
          'Требование ссылается на проверку вне области поручения: ' + req.gate,
        );
      else if (regression.includes(req.gate))
        add(
          'INVALID_INPUT',
          at('requirements', k, 'gate'),
          'Требование ссылается на регрессионный gate: требование доказывает своя проверка поручения — ' +
            req.gate,
        );
    });
    const consumerIds = (order.consumers ?? []).map((c) => c.repositoryId);
    if (new Set(consumerIds).size !== consumerIds.length)
      add(
        'INVALID_INPUT',
        at('consumers'),
        'Потребитель назван дважды: объедините его проверки в одну запись',
      );
    order.consumers?.forEach((c, k) => {
      const consumer = repos.get(c.repositoryId);
      if (c.repositoryId === order.repositoryId)
        add(
          'INVALID_INPUT',
          at('consumers', k),
          'Потребитель — другой компонент, а не компонент поручения',
        );
      else if (!consumer)
        add(
          'INVALID_INPUT',
          at('consumers', k),
          'Потребитель не объявлен политикой: ' + c.repositoryId,
        );
      else if (!dependsOn(c.repositoryId, order.repositoryId))
        add(
          'INVALID_INPUT',
          at('consumers', k),
          `Компонент ${c.repositoryId} не зависит от ${order.repositoryId}: он не потребитель`,
        );
      else expand(consumer, c.gates, at('consumers', k, 'gates'), `потребителя ${c.repositoryId}`);
    });
    // Работа инфраструктуры (docs/infra-works.md): область записи — внутри
    // области инфраструктуры репозитория; согласованные изменения gates — у
    // неё одной и внутри той же области.
    if (order.kind === 'infra') {
      const infra = repo.infra?.paths ?? [];
      if (!infra.length)
        add(
          'INVALID_INPUT',
          at('kind'),
          `Работа инфраструктуры в репозитории ${repo.id} без области инфраструктуры: объявите repositories[].infra.paths в политике`,
        );
      else
        order.writeScope.forEach((p, k) => {
          if (p === '.' || !withinInfra(p, infra))
            add(
              'INVALID_INPUT',
              at('writeScope', k),
              `Область записи работы инфраструктуры (${p}) вне области инфраструктуры ${JSON.stringify(infra)}`,
            );
        });
      order.gateChanges?.forEach((p, k) => {
        if (!withinPaths(p, order.writeScope))
          add(
            'INVALID_INPUT',
            at('gateChanges', k),
            `Изменение gate ${p} вне области записи работы инфраструктуры`,
          );
      });
    } else if (order.gateChanges?.length)
      add(
        'INVALID_INPUT',
        at('gateChanges'),
        'gateChanges — только у работы инфраструктуры (kind: infra): продуктовая работа gates не меняет',
      );
    if (order.relatedRepositories.length && new Set(order.relatedRepositories).size < 2)
      add(
        'INVALID_INPUT',
        at('relatedRepositories'),
        'Поручение уровня workspace должно затрагивать минимум два компонента',
      );
    order.relatedRepositories.forEach((r, k) => {
      if (!repos.has(r))
        add(
          'INVALID_INPUT',
          at('relatedRepositories', k),
          'Репозиторий не объявлен политикой: ' + r,
        );
    });
  });
  issues.push(...infraOrderIssues(graph));
  return issues;
}

/**
 * Работы инфраструктуры принимаются раньше продуктовых своего репозитория:
 * продуктовая работа графа, у репозитория которой в том же графе есть работа
 * инфраструктуры, зависит от неё (прямо или через другие работы). Так
 * продуктовые работы получают gates и мосты из принятой ревизии
 * инфраструктуры, а не из незаконченной.
 */
function infraOrderIssues(graph: WorkGraph): CodedIssue[] {
  const issues: CodedIssue[] = [];
  const byId = new Map(graph.orders.map((o) => [o.id, o]));
  const infra = graph.orders.filter((o) => o.kind === 'infra');
  if (!infra.length) return issues;
  const reaches = (from: string, target: string) => {
    const seen = new Set<string>();
    const stack = [...(byId.get(from)?.dependsOn ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(byId.get(id)?.dependsOn ?? []));
    }
    return false;
  };
  graph.orders.forEach((order, i) => {
    if (order.kind === 'infra') return;
    // Репозитории работы: свой и связанные (`relatedRepositories`) — gates и
    // мосты каждого из них должны быть из принятой ревизии инфраструктуры.
    const repos = new Set([order.repositoryId, ...order.relatedRepositories]);
    const missing = infra
      .filter((x) => repos.has(x.repositoryId) && !reaches(order.id, x.id))
      .map((x) => x.id);
    if (missing.length)
      issues.push({
        code: 'INVALID_INPUT',
        path: ['graph', 'orders', i, 'dependsOn'],
        message: `Продуктовая работа ${order.id} не зависит от работ инфраструктуры своего репозитория: ${missing.join(', ')} — добавьте их в dependsOn`,
      });
  });
  return issues;
}

/**
 * Снимок контекста против графа: содержимое совпадает с digests, каждый
 * источник, названный поручением, присутствует и обязателен либо явно
 * помечен отсутствующим дополнительным.
 */
function contextSnapshotIssues(graph: WorkGraph, context: ContextSnapshot): CodedIssue[] {
  const issues: CodedIssue[] = contextIssues(context).map((message) => ({
    code: 'INVALID_INPUT',
    path: ['context'],
    message,
  }));
  const sources = new Map(context.sources.map((s) => [s.id, s]));
  graph.orders.forEach((order, i) =>
    order.context.forEach((id, k) => {
      const source = sources.get(id);
      if (!source)
        issues.push({
          code: 'INVALID_INPUT',
          path: ['graph', 'orders', i, 'context', k],
          message: 'Обязательный источник контекста отсутствует в снимке: ' + id,
        });
      else if (!source.required)
        issues.push({
          code: 'INVALID_INPUT',
          path: ['graph', 'orders', i, 'context', k],
          message: 'Источник, названный поручением, должен быть обязательным: ' + id,
        });
    }),
  );
  return issues;
}

/**
 * Все нарушения графа, политики, их связи и контекста — в том порядке, в
 * котором `validateInputs` называет первое. Ничего не бросает.
 */
export function validationIssues(
  graph: WorkGraph,
  policy: ExecutionPolicy,
  context?: ContextSnapshot,
): CodedIssue[] {
  return [
    ...(context ? contextSnapshotIssues(graph, context) : []),
    ...graphIssues(graph).map((i) => ({ ...i, path: ['graph', ...i.path] })),
    ...policyIssues(policy).map((i) => ({ ...i, path: ['policy', ...i.path] })),
    ...crossIssues(graph, policy),
  ];
}

/**
 * Проверка входов без вызова моделей и без записи состояния. Ошибки
 * собираются все сразу; код первой определяет класс отказа.
 */
export function validateInputs(input: { graph: unknown; policy: unknown; context?: unknown }) {
  const graph = parse(workGraphSchema, input.graph, 'graph');
  const policy = parse(executionPolicySchema, input.policy, 'policy');
  const context =
    input.context === undefined
      ? undefined
      : parse(contextSnapshotSchema, input.context, 'context');
  const issues = validationIssues(graph, policy, context);
  if (issues.length)
    throw new HarnessError(
      issues[0]!.code,
      `Найдено нарушений: ${issues.length}`,
      issues.map(({ path, message }) => ({ path, message })),
    );
  return {
    graphId: graph.id,
    graphDigest: workGraphDigest(graph),
    policyDigest: policyDigest(policy),
    orders: graph.orders.length,
    ...(context ? { contextDigest: contextDigest(context) } : {}),
  };
}
