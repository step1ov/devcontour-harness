#!/usr/bin/env node
// Поддельная команда ведущего для `harness lead drive` (тесты, не модель):
// записывает stdin, аргументы и окружение сессии в <dir>/session-N.json и
// ждёт файла <dir>/session-N.go (тест меняет состояние, пока «ведущий
// работает»), затем выходит с кодом из аргумента. Режим `exit` не ждёт;
// `hang` не выходит сам и не уходит по SIGTERM (снимает только SIGKILL);
// `grandchild-hang` — то же, с внуком в той же группе (pid в grandchild.pid);
// `background-writer` — выходит сразу, а внук через 700 мс пишет в
// унаследованный stdout и оставляет late.done (как фоновый `harness run`).
// `provider-limit` — как codex при исчерпанном лимите: событие `error` в
// JSONL stdout и выход с кодом из аргумента.
import { spawn } from 'node:child_process';
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
    t: Date.now(),
    stdin,
    argv: process.argv.slice(2),
    env: {
      HARNESS_LEAD_DRIVE: process.env.HARNESS_LEAD_DRIVE,
      HARNESS_LEAD_DRIVE_CURSOR: process.env.HARNESS_LEAD_DRIVE_CURSOR,
      HARNESS_LEAD_DRIVE_SESSION: process.env.HARNESS_LEAD_DRIVE_SESSION,
      HARNESS_LEAD_DRIVE_EVENT: process.env.HARNESS_LEAD_DRIVE_EVENT,
      H: process.env.H,
      PATH: process.env.PATH,
    },
  }),
);
process.stderr.write(`fake lead session ${n}\n`);
if (mode === 'grandchild-hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
  });
  // Pid внука — сразу и синхронно из ведущего: внук под нагрузкой мог не
  // успеть записать его сам до остановки группы.
  writeFileSync(join(dir, 'grandchild.pid'), String(child.pid));
  child.unref();
}
if (mode === 'background-writer') {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `setTimeout(() => { process.stdout.write('late line\\n'); require('fs').writeFileSync(${JSON.stringify(join(dir, 'late.done'))}, 'ok'); }, 700);`,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  child.unref();
}
if (mode === 'provider-limit') {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't-1' }) + '\n');
  process.stdout.write(
    JSON.stringify({
      type: 'error',
      message: "You've hit your usage limit. Upgrade to Pro or try again at 3:05 PM.",
    }) + '\n',
  );
}
if (mode === 'hang' || mode === 'grandchild-hang') {
  process.on('SIGTERM', () => process.stderr.write('fake lead ignores SIGTERM\n'));
  await new Promise((r) => setTimeout(r, 60_000));
}
if (mode === 'wait-go') {
  const until = Date.now() + 15_000;
  while (!existsSync(join(dir, `session-${n}.go`)) && Date.now() < until)
    await new Promise((r) => setTimeout(r, 20));
}
process.exit(Number(code));
