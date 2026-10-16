import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Только собственный выход сборки: путь вычислен от этого файла, а не от cwd.
rmSync(fileURLToPath(new URL('../lib', import.meta.url)), { recursive: true, force: true });
