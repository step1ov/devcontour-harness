/**
 * A02/R2-F02: ядро находит системные утилиты процессов (`ps`, `lsof`,
 * `sysctl`) по штатным абсолютным путям ОС, а не через PATH. С PATH из одних
 * node и git containment команды работает; одноимённые файлы в PATH (или в
 * проекте) не запускаются.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OS_TOOL_CANDIDATES, osTool } from '../src/environment/os-tools.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

test('A02/os-tools: утилита — первый существующий штатный путь; без штатных — имя для PATH', () => {
  for (const name of ['ps', 'lsof', 'sysctl'] as const) {
    const path = osTool(name);
    if (process.platform === 'darwin')
      assert.ok((OS_TOOL_CANDIDATES[name] as readonly string[]).includes(path), name + ': ' + path);
    if (path.startsWith('/')) assert.ok(existsSync(path), path);
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-os-tools-')));
  try {
    const fake = join(dir, 'ps');
    writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    chmodSync(fake, 0o755);
    assert.equal(osTool('ps', [join(dir, 'absent'), fake]), fake, 'первый существующий');
    assert.equal(osTool('ps', [join(dir, 'absent')]), 'ps', 'нет штатных — имя для PATH');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'A02/os-tools: PATH только node+git и подставные ps/lsof/sysctl — containment работает, подставные не запускаются',
  { skip: process.platform === 'win32' },
  () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-os-path-')));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, 'node'));
      const marker = join(dir, 'fake-called');
      for (const name of ['ps', 'lsof', 'sysctl']) {
        writeFileSync(
          join(bin, name),
          `#!/bin/sh\necho ${name} >> ${JSON.stringify(marker)}\nexit 1\n`,
        );
        chmodSync(join(bin, name), 0o755);
      }
      // Импорт live-calls (ps/sysctl при загрузке) и команда с containment:
      // потомок отсоединяется, ядро обязано найти и остановить его через ps.
      const script = `
        const { command } = await import(${JSON.stringify(join(root, 'src/environment/process.ts'))});
        const r = await command(['node', '-e', "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { detached: true, stdio: 'ignore' }).unref()"], ${JSON.stringify(dir)}, { contain: { dirs: [${JSON.stringify(dir)}] }, timeoutMs: 30000 });
        console.log(JSON.stringify({ code: r.code, timedOut: r.timedOut }));
      `;
      const r = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
        { cwd: dir, encoding: 'utf8', env: { PATH: bin, HOME: dir }, timeout: 120_000 },
      );
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as {
        code: number;
        timedOut: boolean;
      };
      assert.deepEqual(out, { code: 0, timedOut: false });
      assert.equal(existsSync(marker), false, 'запущены подставные утилиты из PATH');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
