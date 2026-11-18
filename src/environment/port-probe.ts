import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskFailure } from '../contracts/index.ts';
import { osTool } from './os-tools.ts';
import { processInventory, processTable } from './process.ts';
import { forgetSurvivors, leaseScope, survivorRecords, type LeaseScope } from './survivors.ts';

/**
 * Адреса пробы. Служба может слушать любой из них, а на macOS привязка к
 * конкретному адресу не конфликтует с привязкой к другому или к wildcard (и
 * наоборот), поэтому проверяется каждый: `127.0.0.1` и `::1` (localhost
 * dev-серверов), `0.0.0.0` и `::` (по умолчанию `listen(port)` Node — `::`
 * с IPv4).
 */
const HOSTS = ['127.0.0.1', '::1', '0.0.0.0', '::'] as const;

/** Привязать порт и сразу отпустить; `true` — адрес занят. */
function bindBusy(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) =>
      // Нет такого адреса или семейства (IPv6 выключен) — не «занят».
      resolve(error.code === 'EADDRINUSE'),
    );
    server.listen(
      { host, port, exclusive: true, ...(host === '::' ? { ipv6Only: false } : {}) },
      () => server.close(() => resolve(false)),
    );
  });
}

/** Занят ли порт хотя бы на одном адресе пробы. */
export async function portBusy(port: number): Promise<boolean> {
  for (const host of HOSTS) if (await bindBusy(host, port)) return true;
  return false;
}

/** Слушающие порт процессы (`lsof`), или почему их не узнать. */
export async function portListeners(
  port: number,
): Promise<{ pid: number; command: string }[] | { error: string }> {
  // Код 1 — слушающих нет (или они не видны этому пользователю).
  const listed = await processInventory.tool(
    osTool('lsof'),
    ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'],
    10000,
    1,
  );
  if ('error' in listed) return listed;
  const found = new Map<number, string>();
  let pid = 0;
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      if (pid > 0 && !found.has(pid)) found.set(pid, '');
    } else if (line.startsWith('c') && pid > 0) found.set(pid, line.slice(1));
  }
  return [...found].map(([pid, command]) => ({ pid, command }));
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Предел ожидания после SIGTERM, затем SIGKILL. */
export const portProbe = { termGraceMs: 2000, killGraceMs: 1000 };

/** TERM, затем KILL после короткой отсрочки; `true` — все остановлены. */
async function terminate(pids: number[]) {
  const send = (signal: NodeJS.Signals) => {
    for (const pid of pids)
      try {
        process.kill(pid, signal);
      } catch {
        /* уже завершился */
      }
  };
  const wait = async (ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; await delay(25))
      if (!pids.some(alive)) return true;
    return !pids.some(alive);
  };
  send('SIGTERM');
  if (await wait(portProbe.termGraceMs)) return true;
  send('SIGKILL');
  return wait(portProbe.killGraceMs);
}

const busy = (message: string) =>
  new TaskFailure('environment', message, undefined, 'resource-busy');

/**
 * Порты, которые держит аренда попытки, свободны перед фазой — до её
 * lifecycle `setup`/`ready`, `prepare` и gates. Проба — привязка и
 * немедленное закрытие на каждом адресе пробы (миллисекунды); служба,
 * поднявшаяся сразу после пробы, ей не мешает.
 *
 * Занятый порт: держатель узнаётся `lsof`. Если он сам или его предок —
 * записанный процесс, переживший остановку команды прежней попытки
 * (`ReapFailure.survivors`, тот же PID и время старта), он останавливается
 * (TERM, затем KILL), и порт проверяется снова. Иначе — отказ окружения
 * `resource-busy` с портом, PID и именем команды: о коде он ничего не
 * говорит, попытка не засчитывается.
 *
 * Внутри окружения фазы (вложенная фаза) проверки нет: порт там может
 * держать служба её lifecycle.
 */
export async function ensurePortsFree(scope: LeaseScope | undefined = leaseScope.getStore()) {
  if (!scope || scope.environment || !scope.ports.length) return;
  for (const { id, port } of scope.ports) {
    if (!(await portBusy(port))) continue;
    const where = `Порт ${port} (ресурс ${id}) занят до начала фазы`;
    const advice =
      'Освободите порт (остановите процесс) и повторите; попытка не засчитана. Ресурс port — порт, который поднимает сама попытка (lifecycle, prepare, gates); для внешней службы объявляйте ресурс service';
    const listeners = await portListeners(port);
    if ('error' in listeners)
      throw busy(`${where}: держатель не определён (${listeners.error}). ${advice}`);
    if (!listeners.length)
      throw busy(
        `${where}: держатель не определён (lsof не видит слушающих процессов этого пользователя). ${advice}`,
      );
    let table: { pid: number; ppid: number; start: string }[] = [];
    try {
      table = await processTable(true);
    } catch {
      /* без таблицы ни один держатель не узнаётся пережившим */
    }
    const rows = new Map(table.map((r) => [r.pid, r]));
    const records = new Map(survivorRecords(scope.database).map((r) => [`${r.pid}:${r.start}`, r]));
    /** Записанный переживший процесс среди держателя и его предков. */
    const survivorOf = (pid: number) => {
      const seen = new Set<number>();
      for (
        let row = rows.get(pid);
        row && row.pid > 1 && !seen.has(row.pid);
        row = rows.get(row.ppid)
      ) {
        seen.add(row.pid);
        if (records.has(`${row.pid}:${row.start}`)) return row;
      }
      return undefined;
    };
    const matched = listeners.map((l) => ({ ...l, survivor: survivorOf(l.pid) }));
    const foreign = matched.find((m) => !m.survivor);
    if (foreign)
      throw busy(
        `${where}: его слушает PID ${foreign.pid} (${foreign.command || 'команда неизвестна'}) — процесс не из переживших остановку прежних попыток harness. ${advice}`,
      );
    const stop = [...new Set(matched.flatMap((m) => [m.pid, m.survivor!.pid]))];
    const stopped = await terminate(stop);
    forgetSurvivors(
      scope.database,
      matched.map((m) => ({ pid: m.survivor!.pid, start: m.survivor!.start })),
    );
    if (!stopped || (await portBusy(port))) {
      const first = matched[0]!;
      throw busy(
        `${where}: его слушает PID ${first.pid} (${first.command || 'команда неизвестна'}), переживший остановку прежней попытки, и ${stopped ? 'после его остановки порт всё ещё занят' : 'его не удалось остановить (TERM, затем KILL)'}. ${advice}`,
      );
    }
  }
}
