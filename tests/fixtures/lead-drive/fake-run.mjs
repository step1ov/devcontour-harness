#!/usr/bin/env node
// Поддельный `harness run` для перезапуска драйвером (тесты): дописывает
// строку в <dir>/runs.txt и выходит, не трогая состояние.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, 'runs.txt'), args.join(' ') + '\n');
