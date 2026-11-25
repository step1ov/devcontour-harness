/**
 * Отказ инструмента gate (alpha.71, C1): команда gate не нашла свою
 * программу или браузер, либо менеджер пакетов отказал по своему окружению.
 * Чинится командой gate или окружением, а не кодом задачи: попытка не
 * засчитана, gate удержан до хода ведущего (`gate-definition`).
 */

/** Код в начале текста такого отказа (после кода `gate-definition`). */
export const GATE_TOOL_MISSING = 'GATE_TOOL_MISSING';

const signatures: RegExp[] = [
  // pnpm exec/run: `[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "playwright" not found`.
  /\bCommand "[^"\n]{1,200}" not found\b/,
  // sh/bash/zsh/env: программа не найдена.
  /^(?:\/\S+\/)?(?:sh|bash|dash|zsh)(?::\s*(?:line )?\d+)?:\s*\S{1,200}:\s*(?:command )?not found\s*$/m,
  /\bzsh: command not found: \S+/,
  /^env: [^\s:]{1,200}: No such file or directory\s*$/m,
  /\bspawn \S{1,200} ENOENT\b/,
  // Playwright: браузер не установлен.
  /\bExecutable doesn't exist at \S+[\s\S]{0,400}\bplaywright install\b/,
  // pnpm отказывается от каталога состояния задач (временный каталог хоста).
  /\bERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH\b/,
];

/** Первая строка с признаком отказа инструмента, или undefined. */
export function toolMissingLine(text: string): string | undefined {
  for (const re of signatures) {
    const m = re.exec(text);
    if (m) return m[0].split('\n')[0]!.trim().slice(0, 300);
  }
  return undefined;
}

/**
 * Отказ инструмента — единственное объяснение провала: признак есть в
 * выводе, а каждый упавший testcase (если они названы) несёт признак в своём
 * тексте. Упавший testcase без признака — провал кода, как прежде.
 */
export function toolMissingFailure(
  output: string,
  failures: { total: number; texts: string[] } | undefined,
): string | undefined {
  if (failures && failures.total > 0) {
    if (failures.texts.length < failures.total) return undefined;
    const lines = failures.texts.map(toolMissingLine);
    return lines.every(Boolean) ? lines[0] : undefined;
  }
  return toolMissingLine(output);
}
