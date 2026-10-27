import { HarnessError, type GatePolicy } from '../contracts/index.ts';

type Gate = Pick<GatePolicy, 'id' | 'kind' | 'dependsOn'>;

/**
 * Порядок исполнения области gates — один для попытки (candidate и
 * integration) и для проверки на SHA вне попытки (`runGatesAt`): ids в
 * порядке области, каждая предпосылка `dependsOn`, входящая в область, —
 * раньше своего gate. Неизвестный id (псевдо-gate требований) пропускается.
 */
export function orderedScope<T extends Pick<GatePolicy, 'id' | 'dependsOn'>>(
  gates: T[],
  ids: string[],
): T[] {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (ids.includes(dep)) visit(dep);
    out.push(byId.get(id)!);
  };
  ids.forEach(visit);
  return out;
}

/** Явные предпосылки gate: замыкание по `dependsOn`, ids в порядке профиля. */
export function explicitPrerequisites(gates: Gate[], id: string): string[] {
  const byId = new Map(gates.map((g) => [g.id, g]));
  if (!byId.has(id)) throw new HarnessError('NOT_FOUND', `Gate ${id} не объявлен`);
  const out = new Set<string>();
  const stack = [...(byId.get(id)!.dependsOn ?? [])];
  while (stack.length) {
    const gid = stack.pop()!;
    if (gid === id || out.has(gid)) continue;
    const gate = byId.get(gid);
    if (!gate) throw new HarnessError('NOT_FOUND', `Gate ${gid} не объявлен`);
    out.add(gid);
    stack.push(...(gate.dependsOn ?? []));
  }
  return gates.map((g) => g.id).filter((g) => out.has(g));
}

/**
 * Предпосылки gate при исполнении вне области задачи (проверка доски на её
 * итоговом SHA). Область задачи предпосылки называет явно, и попытка
 * исполняет ровно её. Проверке на SHA области нет, поэтому предпосылки
 * выводятся из профиля:
 *
 * - явные — замыкание по `dependsOn` (`explicitPrerequisites`); объявленный
 *   `dependsOn`, в том числе пустой, — режим графа: других предпосылок нет;
 * - неявные — у gate без поля `dependsOn` (режим порядка массива, где профиль
 *   сам задаёт последовательность) все более ранние gates вида `check`
 *   (установка, сборка, статические проверки) со своими предпосылками. Более
 *   ранние test gates не добавляются: тесты друг от друга не зависят.
 *
 * Каждый gate посещается один раз, поэтому `dependsOn` на более поздний
 * gate вместе с неявным ребром к более ранним не зацикливается. Сам gate в
 * результат не входит. Результат — ids в порядке профиля.
 */
export function gatePrerequisites(gates: Gate[], id: string): string[] {
  const byId = new Map(gates.map((g) => [g.id, g]));
  if (!byId.has(id)) throw new HarnessError('NOT_FOUND', `Gate ${id} не объявлен`);
  const out = new Set<string>();
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    const gid = queue.shift()!;
    const gate = byId.get(gid);
    if (!gate) throw new HarnessError('NOT_FOUND', `Gate ${gid} не объявлен`);
    const next =
      gate.dependsOn !== undefined
        ? gate.dependsOn
        : gates
            .slice(0, gates.indexOf(gate))
            .filter((g) => g.kind === 'check')
            .map((g) => g.id);
    for (const n of next) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.add(n);
      queue.push(n);
    }
  }
  out.delete(id);
  return gates.map((g) => g.id).filter((g) => out.has(g));
}

/**
 * Область проверки gates вне задачи: названные gates и предпосылки каждого
 * (`gatePrerequisites`), в порядке профиля. Исполняется `orderedScope`, как
 * область задачи.
 */
export function standaloneScope(gates: Gate[], ids: string[]): string[] {
  const all = new Set(ids.flatMap((id) => [...gatePrerequisites(gates, id), id]));
  return gates.map((g) => g.id).filter((g) => all.has(g));
}
