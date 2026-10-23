import { accessSync, constants } from 'node:fs';

/**
 * Системные утилиты, которыми ядро наблюдает процессы (`ps`, `lsof`) и
 * владение вызовами (`sysctl`). Они ищутся по фиксированным абсолютным путям
 * ОС раньше PATH: урезанный PATH (только node и git) не лишает ядро
 * containment, а файл из проекта или worktree с тем же именем не
 * запускается. PATH — только запасной путь, когда ни одного штатного
 * расположения нет (нестандартная ОС); поведение тогда прежнее.
 */
export const OS_TOOL_CANDIDATES = {
  ps: ['/bin/ps', '/usr/bin/ps'],
  lsof: ['/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof', '/bin/lsof'],
  sysctl: ['/usr/sbin/sysctl', '/sbin/sysctl', '/usr/bin/sysctl'],
} as const;
export type OsTool = keyof typeof OS_TOOL_CANDIDATES;

const resolved = new Map<OsTool, string>();

/** Исполняемый файл утилиты: первый существующий штатный путь, иначе имя для PATH. */
export function osTool(name: OsTool, candidates: readonly string[] = OS_TOOL_CANDIDATES[name]) {
  const cached = candidates === OS_TOOL_CANDIDATES[name] ? resolved.get(name) : undefined;
  if (cached) return cached;
  let found: string = name;
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      found = path;
      break;
    } catch {
      /* нет этого расположения — следующее */
    }
  }
  if (candidates === OS_TOOL_CANDIDATES[name]) resolved.set(name, found);
  return found;
}
