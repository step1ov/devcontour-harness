import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Панель оператора, запущенная CLI devcontour-harness-ui для этого каталога
 * состояния: найти процесс (`ps`), остановить и запустить новой версией с
 * теми же аргументами. Процесс перезапускается, только если его командная
 * строка разбирается однозначно: исполняемый файл панели лежит в каталоге
 * установки, а `--state` указывает на этот каталог состояния. Иначе панель
 * не трогается, и ответ говорит, как перезапустить её самому.
 */
export interface PanelProcess {
  pid: number;
  script: string;
  args: string[];
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export function findPanels(prefix: string, stateDir: string): PanelProcess[] {
  let out: string;
  try {
    out = execFileSync('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const root = real(prefix) + sep;
  const state = real(stateDir);
  const found: PanelProcess[] = [];
  for (const line of out.split('\n')) {
    if (!line.includes('devcontour-harness-ui')) continue;
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    const tokens = m[2]!.split(/\s+/);
    const at = tokens.findIndex(
      (t) => t.includes('devcontour-harness-ui') && existsSync(t) && real(t).startsWith(root),
    );
    if (at < 0) continue;
    const args = tokens.slice(at + 1);
    const s = args.indexOf('--state');
    if (s < 0 || !args[s + 1] || real(args[s + 1]!) !== state) continue;
    found.push({ pid, script: tokens[at]!, args });
  }
  return found;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Перезапустить панели новой версией (`bin` — исполняемый файл нового
 * пакета). Вывод нового процесса — в `log`; успех — первая строка JSON с
 * `ok: true` и адресом в течение 15 с.
 */
export async function restartPanels(
  panels: PanelProcess[],
  bin: string,
  log: string,
): Promise<{ restarted: { pid: number; url?: string }[]; failed: string[] }> {
  const restarted: { pid: number; url?: string }[] = [];
  const failed: string[] = [];
  for (const p of panels) {
    try {
      process.kill(p.pid, 'SIGTERM');
    } catch {
      // уже остановлена
    }
    for (let i = 0; i < 50 && alive(p.pid); i++) await sleep(100);
    if (alive(p.pid)) {
      failed.push(`панель (pid ${p.pid}) не остановилась за 5 с`);
      continue;
    }
    const fd = openSync(log, 'w');
    const child = spawn(process.execPath, [bin, ...p.args], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    child.unref();
    let url: string | undefined;
    for (let i = 0; i < 150 && child.pid !== undefined && alive(child.pid); i++) {
      const line = readFileSync(log, 'utf8')
        .split('\n')
        .find((l) => l.startsWith('{') && l.includes('"ok":true'));
      if (line) {
        url = (JSON.parse(line) as { url?: string }).url;
        break;
      }
      await sleep(100);
    }
    if (child.pid !== undefined && alive(child.pid) && url !== undefined)
      restarted.push({ pid: child.pid, url });
    else failed.push(`новая панель не запустилась; её вывод — ${log}`);
  }
  return { restarted, failed };
}
