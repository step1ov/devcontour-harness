// Решение области записи кандидата по списку изменённых путей — чистая
// функция без Git: её проверяет и runner (`assertScope`), и тесты.

/**
 * Путь внутри одного из префиксов (путь или каталог; `.` — всё дерево). С
 * учётом регистра — прежнее правило области harness: пути diff Git точные.
 * Пересечения путей политики (`pathsOverlap`) сравниваются без регистра.
 */
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
  /**
   * Область инфраструктуры репозитория (`repositories[].infra.paths`,
   * docs/infra-works.md) и вид работы. Продуктовой работе она защищена;
   * инфраструктурная пишет только в неё (область роли её не сужает —
   * область поручения уже внутри области инфраструктуры).
   */
  infra?: { kind: 'product' | 'infra'; paths: readonly string[] };
}

/** Нарушения области: изменённые защищённые пути и пути вне области поручения/роли. */
export function scopeViolations(changed: readonly string[], rules: ScopeRules) {
  const allowed = rules.allowed ?? [];
  const generated = (p: string) => within(p, allowed);
  const infraPaths = rules.infra?.paths ?? [];
  const infraWork = rules.infra?.kind === 'infra';
  // Продуктовой работе область инфраструктуры — защищённый путь; работе
  // инфраструктуры защита снята только внутри этой области.
  const isProtected = (p: string) =>
    infraWork
      ? within(p, rules.protected) && !within(p, infraPaths)
      : within(p, rules.protected) || within(p, infraPaths);
  const forbidden = changed.filter(
    (p) => within(p, rules.pinned) || (!generated(p) && isProtected(p)),
  );
  const outside = changed.filter(
    (p) =>
      !generated(p) &&
      (!within(p, rules.writeScope) ||
        (infraWork ? !within(p, infraPaths) : rules.role && !within(p, rules.role))),
  );
  return { forbidden, outside };
}

/** Начало отказа области с путями (`assertScope`): защищённые файлы и файлы вне области. */
export const SCOPE_PATHS_TEXT = {
  forbidden: 'Изменены защищённые файлы: ',
  outside: 'Изменены файлы вне области поручения/роли: ',
} as const;

/**
 * Пути из отказа области только по путям (защищённые или вне области); у
 * других отказов области (символические ссылки, файлы шагов, эталоны) — нет.
 */
export function scopeRejectedPaths(error: string | undefined): string[] | undefined {
  const prefix = Object.values(SCOPE_PATHS_TEXT).find((p) => error?.startsWith(p));
  if (!prefix || error!.includes('\n')) return undefined;
  const paths = error!.slice(prefix.length).split(', ').filter(Boolean);
  return paths.length ? paths : undefined;
}
