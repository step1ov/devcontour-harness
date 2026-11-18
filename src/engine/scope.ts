// Решение области записи кандидата по списку изменённых путей — чистая
// функция без Git: её проверяет и runner (`assertScope`), и тесты.

/** Путь внутри одного из префиксов (путь или каталог; `.` — всё дерево). */
export const within = (path: string, prefixes: readonly string[]) =>
  prefixes.some((p) => p === '.' || path === p || path.startsWith(p.endsWith('/') ? p : p + '/'));

export interface ScopeRules {
  /** Защищённые пути и пути генерации репозитория (`protectedPaths`, `generatedPaths`). */
  protected: readonly string[];
  /**
   * Закреплённые контекст и артефакты контрактов: защищены всегда, и выход
   * генератора этого не снимает — генератор, правящий эталон, подгонял бы
   * проверку под себя.
   */
  pinned: readonly string[];
  /** Область записи поручения. */
  writeScope: readonly string[];
  /** Область записи роли; нет — роль область не сужает. */
  role?: readonly string[];
  /**
   * Выходы генераторов, исполненных controller на этом кандидате: их
   * содержимое написал генератор, а не исполнитель, поэтому защита
   * `protectedPaths`/`generatedPaths` и области поручения и роли к ним не
   * применяется.
   */
  allowed?: readonly string[];
}

/** Нарушения области: изменённые защищённые пути и пути вне области поручения/роли. */
export function scopeViolations(changed: readonly string[], rules: ScopeRules) {
  const allowed = rules.allowed ?? [];
  const generated = (p: string) => within(p, allowed);
  const forbidden = changed.filter(
    (p) => within(p, rules.pinned) || (!generated(p) && within(p, rules.protected)),
  );
  const outside = changed.filter(
    (p) =>
      !generated(p) && (!within(p, rules.writeScope) || (rules.role && !within(p, rules.role))),
  );
  return { forbidden, outside };
}
