import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Каталог временных файлов controller (alpha.69, ревью): каталоги проверок
 * (`dc-gate-*`), метки старта (`dc-start-*`), отчёты проб reviewer, ввод
 * эталонных случаев, каталоги вызовов runtime. В облегчённом режиме
 * временный каталог пользователя macOS открыт исполнителю на запись, поэтому
 * файлы controller лежат под каталогом состояния (`<state>/tmp`, 0700),
 * куда исполнитель не пишет. Без настройки — системный временный каталог
 * (строгий режим, прежнее поведение). Один на процесс: его задаёт тот, кто
 * открыл каталог состояния с действующей границей записи.
 */
let root: string | undefined;

export const controllerTemp = {
  /** Задать корень (`undefined` — системный временный каталог). */
  use(stateDir: string | undefined) {
    if (!stateDir) {
      root = undefined;
      return;
    }
    const dir = join(stateDir, 'tmp');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    root = dir;
  },
  dir(): string {
    return root ?? tmpdir();
  },
};
