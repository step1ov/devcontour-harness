#!/usr/bin/env node
// Поддельная команда ведущего для `harness lead drive` (тесты, не модель):
// записывает stdin, аргументы и окружение сессии в <dir>/session-N.json и
// ждёт файла <dir>/session-N.go (тест меняет состояние, пока «ведущий
// работает»), затем выходит с кодом из аргумента. Режим `exit` не ждёт;
// `hang` не выходит сам и не уходит по SIGTERM (снимает только SIGKILL).
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, mode = 'wait-go', code = '0'] = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
const n = process.env.HARNESS_LEAD_DRIVE_SESSION ?? '0';
writeFileSync(
  join(dir, `session-${n}.json`),
  JSON.stringify({
    stdin,
    argv: process.argv.slice(2),
    env: {
      HARNESS_LEAD_DRIVE: process.env.HARNESS_LEAD_DRIVE,
      HARNESS_LEAD_DRIVE_CURSOR: process.env.HARNESS_LEAD_DRIVE_CURSOR,
      HARNESS_LEAD_DRIVE_SESSION: process.env.HARNESS_LEAD_DRIVE_SESSION,
      HARNESS_LEAD_DRIVE_EVENT: process.env.HARNESS_LEAD_DRIVE_EVENT,
    },
  }),
);
process.stderr.write(`fake lead session ${n}\n`);
if (mode === 'hang') {
  process.on('SIGTERM', () => process.stderr.write('fake lead ignores SIGTERM\n'));
  await new Promise((r) => setTimeout(r, 60_000));
}
if (mode === 'wait-go') {
  const until = Date.now() + 15_000;
  while (!existsSync(join(dir, `session-${n}.go`)) && Date.now() < until)
    await new Promise((r) => setTimeout(r, 20));
}
process.exit(Number(code));
