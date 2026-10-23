#!/usr/bin/env node
// Локальный бинарник workspace: синтаксическая проверка перечисленных файлов.
import { execFileSync } from 'node:child_process';
for (const file of process.argv.slice(2)) execFileSync(process.execPath, ['--check', file]);
console.log('fx-check: ok ' + process.argv.slice(2).join(' '));
