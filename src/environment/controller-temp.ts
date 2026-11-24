import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * Каталог временных файлов controller (alpha.69, ревью): каталоги проверок
 * (`dc-gate-*`), метки старта (`dc-start-*`), отчёты проб reviewer, ввод
 * эталонных случаев, домашние каталоги CLI исполнителя, каталоги ответов.
 * В облегчённом режиме временный каталог пользователя macOS открыт
 * исполнителю на запись, поэтому файлы controller лежат в своём каталоге
 * `/tmp/hx-<хеш каталога состояния>-<uid>` (0700, владелец — этот
 * пользователь), куда исполнитель не пишет. Путь короткий: сокеты unix в нём
 * укладываются в предел 104 байт. Без настройки — системный временный
 * каталог (строгий режим, прежнее поведение). Один на процесс; дочерний
 * процесс (сервер проб reviewer) получает его явно (`useDir`).
 */
let root: string | undefined;

/** Короткий корень controller для каталога состояния. */
export function controllerTempRoot(stateDir: string) {
  const hash = createHash('sha256').update(stateDir).digest('hex').slice(0, 12);
  const base = process.platform === 'win32' ? tmpdir() : '/tmp';
  return join(base, `hx-${hash}-${userInfo().uid}`);
}

export const controllerTemp = {
  /** Задать корень по каталогу состояния (`undefined` — системный временный каталог). */
  use(stateDir: string | undefined) {
    this.useDir(stateDir ? controllerTempRoot(stateDir) : undefined);
  },
  /** Задать корень явно (сервер проб получает его из спецификации). */
  useDir(dir: string | undefined) {
    if (!dir) {
      root = undefined;
      return;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    // Чужой или подменённый каталог (ссылка, другой владелец, открытые права) не берётся.
    if (!st.isDirectory() || st.uid !== userInfo().uid || (st.mode & 0o077) !== 0)
      throw new Error(
        `Каталог временных файлов controller ${dir} небезопасен (владелец или права)`,
      );
    root = dir;
  },
  dir(): string {
    return root ?? tmpdir();
  },
  /** Задан ли отдельный корень (облегчённый режим с границей записи). */
  active(): boolean {
    return root !== undefined;
  },
};
