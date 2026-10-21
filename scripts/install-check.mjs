/**
 * T39: проверка выпущенного архива пакета вне checkout — та же проверка, что
 * в `npm run check`, но для указанного архива и без сети. Байты архива не
 * меняются; установка, запуск и журнал чтения — во временном каталоге.
 *
 *   npm run check:install -- ./devcontour-harness-<version>.tgz
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const archive = process.argv[2];
if (!archive || !archive.endsWith('.tgz') || !existsSync(archive)) {
  console.error('install-check: укажите путь к архиву devcontour-harness-<version>.tgz');
  process.exit(2);
}
const smoke = fileURLToPath(new URL('smoke-package.mjs', import.meta.url));
const r = spawnSync(process.execPath, [smoke, '--archive', archive, '--offline'], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
