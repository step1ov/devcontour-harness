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

/** Адреса пробы, на которых порт занят. */
export async function busyHosts(port: number): Promise<string[]> {
  const busy: string[] = [];
  for (const host of HOSTS) if (await bindBusy(host, port)) busy.push(host);
  return busy;
}
/** Занят ли порт хотя бы на одном адресе пробы. */
export async function portBusy(port: number): Promise<boolean> {
  return (await busyHosts(port)).length > 0;
}
/**
 * Заняты только wildcard-адреса (`0.0.0.0`, `::`), loopback свободен. Так на
 * macOS выглядят системные службы (AirPlay Receiver на 5000 и 7000): служба
 * попытки, слушающая `127.0.0.1`, на таком порту работает, а слушающая все
 * адреса — нет.
 */
const wildcardOnly = (hosts: string[]) =>
  hosts.length > 0 && !hosts.includes('127.0.0.1') && !hosts.includes('::1');

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

/**
 * TERM, затем KILL после короткой отсрочки. Ожидание кончается, когда цели
 * завершились или `released()` (порт свободен): зомби остаётся в таблице до
 * своего родителя, но порт уже не держит. `true` — цели завершились или
 * порт освобождён.
 */
async function terminate(pids: number[], released: () => Promise<boolean>) {
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
      if (!pids.some(alive) || (await released())) return true;
    return !pids.some(alive) || released();
  };
  send('SIGTERM');
  if (await wait(portProbe.termGraceMs)) return true;
  send('SIGKILL');
  return wait(portProbe.killGraceMs);
}

const busy = (message: string) =>
  new TaskFailure('environment', message, undefined, 'resource-busy');

/** Совет в тексте отказа и предупреждения `resource-busy`. */
export const PORT_ADVICE =
  'Освободите порт (остановите процесс) и повторите: отказ окружения не засчитан в попытки, но ставит выдачу на паузу (класс environment) — её снимает повтор восстановления или `harness resume --state <каталог>`, поручение повторяет `harness retry --work <id>`. ' +
  'Ресурс port — порт, который поднимает сама попытка (lifecycle, prepare, gates); для внешней службы объявляйте ресурс service. ' +
  'На macOS порты 5000 и 7000 на всех адресах держит AirPlay Receiver (ControlCenter): служба на 127.0.0.1 там работает, на всех адресах — нет; выберите другой порт или выключите AirPlay Receiver';

type Listener = { pid: number; command: string };
type Row = { pid: number; ppid: number; start: string };
const named = (l: Listener) => `PID ${l.pid} (${l.command || 'команда неизвестна'})`;

/** Держатели порта с записанным пережившим процессом среди них самих и их предков. */
async function holders(port: number, database: string | undefined) {
  const listeners = await portListeners(port);
  if ('error' in listeners) return { error: listeners.error };
  if (!listeners.length) return { error: 'lsof не видит слушающих процессов этого пользователя' };
  let table: Row[] = [];
  try {
    table = await processTable(true);
  } catch {
    /* без таблицы ни один держатель не узнаётся пережившим */
  }
  const rows = new Map(table.map((r) => [r.pid, r]));
  let records = new Set<string>();
  if (database)
    try {
      records = new Set(survivorRecords(database).map((r) => `${r.pid}:${r.start}`));
    } catch (error) {
      return {
        error: `записи переживших процессов не прочитаны: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  /** Записанный переживший процесс среди держателя и его предков (не потомков). */
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
  return {
    matched: listeners.map((l) => ({ ...l, row: rows.get(l.pid), survivor: survivorOf(l.pid) })),
  };
}

/** Состояние порта для `doctor`: проба и держатели, без остановки процессов. */
export async function inspectPort(port: number, database?: string) {
  const hosts = await busyHosts(port);
  if (!hosts.length) return { status: 'free' as const };
  const found = await holders(port, database);
  const holder =
    'error' in found
      ? `держатель не определён (${found.error})`
      : found.matched
          .map((m) => named(m) + (m.survivor ? ', переживший остановку прежней попытки' : ''))
          .join(', ');
  return {
    status: wildcardOnly(hosts) ? ('wildcard-only' as const) : ('busy' as const),
    hosts,
    holder,
  };
}

/**
 * Порты, которые держит аренда попытки, свободны перед фазой — до её
 * lifecycle `setup`/`ready`, `prepare` и gates. Проба — привязка и
 * немедленное закрытие на каждом адресе пробы (миллисекунды); служба,
 * поднявшаяся сразу после пробы, ей не мешает.
 *
 * Занятый порт: держатель узнаётся `lsof`. Если он сам или его предок —
 * записанный процесс, переживший остановку команды прежней попытки
 * (`ReapFailure.survivors`, тот же PID и время старта, эта машина и
 * загрузка ОС), он и держатель останавливаются (TERM, затем KILL), и порт
 * проверяется снова. Чужой держатель — отказ окружения `resource-busy` с
 * портом, PID и именем команды (ничего не останавливается): о коде он
 * ничего не говорит, попытка не засчитывается. Чужой держатель только
 * wildcard-адресов при свободном loopback — предупреждение (возвращается),
 * а не отказ.
 *
 * Внутри окружения фазы (вложенная фаза) проверки нет: порт там может
 * держать служба её lifecycle.
 */
export async function ensurePortsFree(
  scope: LeaseScope | undefined = leaseScope.getStore(),
): Promise<string[]> {
  const warnings: string[] = [];
  if (!scope || scope.environment || !scope.ports.length) return warnings;
  for (const { id, port } of scope.ports) {
    const hosts = await busyHosts(port);
    if (!hosts.length) continue;
    const where = `Порт ${port} (ресурс ${id}) занят до начала фазы`;
    const shared = (holder: string) =>
      warnings.push(
        `Порт ${port} (ресурс ${id}) на всех адресах (${hosts.join(', ')}) держит ${holder}; loopback (127.0.0.1, ::1) свободен — служба попытки должна слушать 127.0.0.1, привязка ко всем адресам не удастся. ${PORT_ADVICE}`,
      );
    const found = await holders(port, scope.database);
    if ('error' in found) {
      if (wildcardOnly(hosts)) {
        shared(`процесс, который не определён (${found.error})`);
        continue;
      }
      throw busy(`${where}: держатель не определён (${found.error}). ${PORT_ADVICE}`);
    }
    const foreign = found.matched.filter((m) => !m.survivor);
    const survivors = found.matched.filter((m) => m.survivor);
    if (foreign.length && !wildcardOnly(hosts))
      throw busy(
        `${where}: его слушает ${named(foreign[0]!)} — процесс не из переживших остановку прежних попыток harness. ${PORT_ADVICE}`,
      );
    if (survivors.length) {
      // Время старта сверяется прямо перед сигналом: PID, освободившийся
      // после чтения таблицы, мог достаться другому процессу.
      let fresh = new Map<number, string>();
      try {
        fresh = new Map((await processTable(true)).map((r) => [r.pid, r.start]));
      } catch {
        /* таблицы нет — сигналов нет */
      }
      const targets = [
        ...new Map(
          survivors.flatMap((m) =>
            [m.row, m.survivor!].flatMap((r) => (r ? [[r.pid, r.start] as const] : [])),
          ),
        ),
      ]
        .filter(([pid, start]) => fresh.get(pid) === start)
        .map(([pid]) => pid);
      // Освобождён — свободен целиком или (при чужом держателе только
      // wildcard) свободен loopback.
      const released = (left: string[]) =>
        !left.length || (foreign.length > 0 && wildcardOnly(left));
      await terminate(targets, async () => released(await busyHosts(port)));
      try {
        forgetSurvivors(
          scope.database,
          survivors.map((m) => ({ pid: m.survivor!.pid, start: m.survivor!.start })),
        );
      } catch {
        /* запись устареет сама; время старта не даст спутать PID */
      }
      if (!released(await busyHosts(port)))
        throw busy(
          `${where}: его слушает ${named(survivors[0]!)}, переживший остановку прежней попытки; после остановки (TERM, затем KILL) порт всё ещё занят. ${PORT_ADVICE}`,
        );
    }
    if (foreign.length) shared(foreign.map(named).join(', '));
  }
  return warnings;
}
