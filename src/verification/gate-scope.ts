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

/**
 * Предпосылки gate при исполнении вне области задачи (проверка доски на её
 * итоговом SHA). Область задачи предпосылки называет явно, и попытка
 * исполняет ровно её. Проверке на SHA области нет, поэтому предпосылки
 * выводятся из профиля:
 *
 * - gate с `dependsOn` (режим графа) — замыкание по `dependsOn`;
 * - gate без `dependsOn` (режим порядка массива, где профиль сам задаёт
 *   последовательность) — все gates вида `check`, стоящие в профиле раньше
 *   него, с их замыканием: установка, сборка и статические проверки, на
 *   которые опирается каждый следующий gate. Более ранние test gates не
 *   добавляются: тесты друг от друга не зависят, и их повтор лишь удлинил бы
 *   проверку.
 *
 * Результат — ids в порядке профиля, сам gate последним среди равных.
 */
export function gatePrerequisites(gates: Gate[], id: string): string[] {
  const index = gates.findIndex((g) => g.id === id);
  if (index < 0) throw new HarnessError('NOT_FOUND', `Gate ${id} не объявлен`);
  const byId = new Map(gates.map((g) => [g.id, g]));
  const out = new Set<string>();
  const visit = (gid: string) => {
    const gate = byId.get(gid);
    if (!gate) throw new HarnessError('NOT_FOUND', `Gate ${gid} не объявлен`);
    if (gate.dependsOn?.length) {
      for (const dep of gate.dependsOn) if (!out.has(dep)) visit(dep);
    } else {
      const at = gates.findIndex((g) => g.id === gid);
      for (const earlier of gates.slice(0, at))
        if (earlier.kind === 'check' && !out.has(earlier.id)) visit(earlier.id);
    }
    if (gid !== id) out.add(gid);
  };
  visit(id);
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
