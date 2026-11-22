import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  HarnessError,
  previewReceiptSchema,
  type ExecutionPolicy,
  type PreviewDefinition,
  type PreviewReason,
  type PreviewReceipt,
  type PreviewState,
} from '../contracts/index.ts';
import {
  cleanupEnvironment,
  executionEnvironment,
  processAlive,
  runSteps,
  withEnvironment,
} from '../environment/lifecycle.ts';
import { busyHosts } from '../environment/port-probe.ts';
import { osTool } from '../environment/os-tools.ts';
import { git } from '../environment/process.ts';
import { commitOf, repositoryOf, repositoryPath } from './gates-check.ts';

/**
 * Превью результата (docs/previews.md). Harness владеет жизнью превью целиком:
 *
 * - `preview-start` создаёт рабочее дерево превью (detached на коммите) в
 *   `<state>/previews/<репозиторий>/<превью>/tree` и запускает отдельный
 *   надзирающий процесс (supervisor, `preview-supervisor.ts`), отсоединённый
 *   от вызывающего;
 * - supervisor поднимает lifecycle репозитория (если `services`), исполняет
 *   `build`, запускает `start` в своей группе процессов на свободном
 *   loopback-порту, ждёт `health`, поднимает loopback-прокси на публичном
 *   порту и пишет receipt (`running`, адрес);
 * - прокси отмечает каждый запрос (`lastActivity`); supervisor сам
 *   останавливает превью по сроку (`ttlMs`) и простою (`idleMs`), а также
 *   по SIGTERM (`preview-stop`): группа приложения — TERM, затем KILL,
 *   lifecycle `teardown`, рабочее дерево убирается, receipt — `stopped`;
 * - `preview-list` и `preview-stop` сверяют receipt с живыми процессами:
 *   пропавший supervisor — та же очистка по receipt (группа приложения,
 *   teardown по receipt окружения, рабочее дерево) и `failed`.
 *
 * Превью запускает только оператор (или ведущий по его просьбе): внутри
 * попытки и gate (`DEVCONTOUR_RUN_ID`, `HARNESS_RUN_ID`, `DEVCONTOUR_PHASE`,
 * `HARNESS_PHASE` в окружении) — отказ `NOT_READY`; `run` превью не запускает.
 */

type Repo = ExecutionPolicy['repositories'][number];

/** Срок жизни и простой по умолчанию; предел ожидания готовности по умолчанию. */
export const PREVIEW_DEFAULTS = {
  ttlMs: 2 * 60 * 60 * 1000,
  idleMs: 30 * 60 * 1000,
  readyTimeoutMs: 60_000,
  health: '/',
} as const;

/** Паузы надзора: опрос готовности, отсрочка между TERM и KILL, остановка supervisor. */
export const previewTiming = {
  pollMs: 100,
  termGraceMs: 3000,
  stopGraceMs: 15_000,
};

/** Переменные, по которым узнаётся процесс попытки или gate harness. */
export const ATTEMPT_MARKERS = [
  'DEVCONTOUR_RUN_ID',
  'HARNESS_RUN_ID',
  'DEVCONTOUR_PHASE',
  'HARNESS_PHASE',
] as const;

/** Отказ внутри попытки или gate: превью запускает только оператор. */
export function assertOperatorContext(env: NodeJS.ProcessEnv = process.env) {
  const marker = ATTEMPT_MARKERS.find((k) => env[k]);
  if (marker)
    throw new HarnessError(
      'NOT_READY',
      `Превью запускает только оператор или ведущий по его просьбе, вне попытки и gate: в окружении есть ${marker}`,
      [{ path: ['env', marker], message: 'процесс попытки или gate harness' }],
    );
}

/** Корень превью каталога состояния. */
export const previewsRoot = (stateDir: string) => join(resolve(stateDir), 'previews');
const previewDir = (stateDir: string, repositoryId: string, id: string) =>
  join(previewsRoot(stateDir), repositoryId, id);
const receiptFile = (dir: string) => join(dir, 'receipt.json');

/** Receipt превью; нет файла или он не по схеме — undefined. */
export function readReceipt(dir: string): PreviewReceipt | undefined {
  try {
    const parsed = previewReceiptSchema.safeParse(
      JSON.parse(readFileSync(receiptFile(dir), 'utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
/** Запись receipt целиком: временный файл и rename, читатель не видит половины. */
export function writeReceipt(receipt: PreviewReceipt) {
  const file = receiptFile(receipt.dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(previewReceiptSchema.parse(receipt), null, 2) + '\n');
  renameSync(tmp, file);
}

/** Все receipt каталога состояния, по репозиторию и ID. */
export function previewReceipts(stateDir: string): PreviewReceipt[] {
  const root = previewsRoot(stateDir);
  const out: PreviewReceipt[] = [];
  const dirs = (path: string) => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  };
  for (const repo of dirs(root))
    for (const id of dirs(join(root, repo))) {
      const r = readReceipt(join(root, repo, id));
      if (r) out.push(r);
    }
  return out;
}

/** Время старта процесса по `ps` (`lstart`); нет процесса или `ps` — undefined. */
export function processStart(pid: number): string | undefined {
  try {
    const out = execFileSync(osTool('ps'), ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}
/** Тот же процесс жив: PID есть, а время старта (если записано) совпадает. */
const sameProcess = (pid: number | undefined, start: string | undefined) => {
  if (!pid || !processAlive(pid)) return false;
  if (!start) return true;
  const now = processStart(pid);
  return now === undefined || now === start;
};

const live = (r: PreviewReceipt) =>
  r.state === 'starting' || r.state === 'running' || r.state === 'stopping';
/** Supervisor превью жив (тот же процесс). */
export const supervisorAlive = (r: PreviewReceipt) =>
  sameProcess(r.pids.supervisor, r.starts.supervisor);

/** Живые превью для представления оператора: только чтение, без сверки и очистки. */
export function livePreviews(stateDir: string): PreviewReceipt[] {
  return previewReceipts(stateDir).filter(
    (r) => r.state === 'running' && processAlive(r.pids.supervisor),
  );
}

/** Группа процессов приложения: TERM, затем KILL после отсрочки. */
export async function stopGroup(pid: number, graceMs = previewTiming.termGraceMs) {
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
      return true;
    } catch {
      try {
        process.kill(pid, s);
        return true;
      } catch {
        return false;
      }
    }
  };
  const groupAlive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  if (!signal('SIGTERM')) return;
  for (const end = Date.now() + graceMs; Date.now() < end; await delay(50))
    if (!groupAlive()) return;
  signal('SIGKILL');
  for (const end = Date.now() + 2000; Date.now() < end; await delay(50)) if (!groupAlive()) return;
}

/** Путь внутри корня превью (не сам корень). */
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !!rel && !rel.startsWith('..' + sep) && rel !== '..' && !rel.startsWith(sep);
};

/**
 * Убрать рабочее дерево превью: `git worktree remove`, иначе каталог внутри
 * корня превью (только он; `git worktree prune` не вызывается — записи чужих
 * деревьев не трогаются).
 */
export async function removeTree(repoPath: string, tree: string, root: string) {
  if (existsSync(tree))
    await git(repoPath, 'worktree', 'remove', '--force', tree).catch(() => undefined);
  if (existsSync(tree) && inside(resolve(root), resolve(tree)))
    rmSync(resolve(tree), { recursive: true, force: true });
}

export interface PreviewContext {
  policy: ExecutionPolicy;
  baseDir: string;
  stateDir: string;
}

/**
 * Очистка по receipt, когда supervisor уже не жив: группа приложения (тот
 * же процесс), lifecycle `teardown` по receipt окружения, рабочее дерево.
 * Receipt становится итоговым с `state` и `reason`.
 */
async function cleanupDead(
  ctx: PreviewContext,
  receipt: PreviewReceipt,
  state: PreviewState,
  reason: PreviewReason,
  message?: string,
): Promise<PreviewReceipt> {
  const notes: string[] = message ? [message] : [];
  if (receipt.pids.app && sameProcess(receipt.pids.app, receipt.starts.app))
    await stopGroup(receipt.pids.app);
  const repo = ctx.policy.repositories.find((r) => r.id === receipt.repositoryId);
  const envReceipt = join(receipt.dir, 'environment', 'environment.json');
  if (receipt.services && existsSync(envReceipt) && existsSync(receipt.worktree))
    try {
      await cleanupEnvironment(envReceipt, ctx.policy, [realpathSync(previewsRoot(ctx.stateDir))]);
    } catch (error) {
      notes.push(
        'teardown по receipt окружения не выполнен: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  if (repo)
    await removeTree(
      repositoryPath(ctx.baseDir)(repo),
      receipt.worktree,
      previewsRoot(ctx.stateDir),
    );
  else notes.push('репозиторий превью не объявлен в политике: рабочее дерево не убрано');
  const final: PreviewReceipt = {
    ...receipt,
    state,
    reason,
    stoppedAt: new Date().toISOString(),
    ...(notes.length ? { message: notes.join('; ').slice(0, 2000) } : {}),
  };
  writeReceipt(final);
  return final;
}

/**
 * Остановить живое превью: SIGTERM supervisor и ожидание его итогового
 * receipt; не успел — SIGKILL и очистка по receipt.
 */
async function stopOne(
  ctx: PreviewContext,
  receipt: PreviewReceipt,
  reason: PreviewReason,
): Promise<PreviewReceipt> {
  if (!supervisorAlive(receipt))
    return cleanupDead(
      ctx,
      receipt,
      reason === 'operator' || reason === 'replaced' ? 'stopped' : 'failed',
      reason,
    );
  const marker = join(receipt.dir, 'stop-reason');
  writeFileSync(marker, reason);
  try {
    process.kill(receipt.pids.supervisor, 'SIGTERM');
  } catch {
    /* уже завершился */
  }
  const teardown = (receipt.services ? lifecycleOf(ctx, receipt.repositoryId) : undefined)?.teardown
    .map((s) => s.timeoutMs + 2000)
    .reduce((a, b) => a + b, 0);
  const end = Date.now() + previewTiming.stopGraceMs + (teardown ?? 0);
  while (Date.now() < end && processAlive(receipt.pids.supervisor))
    await delay(previewTiming.pollMs);
  if (processAlive(receipt.pids.supervisor)) {
    try {
      process.kill(receipt.pids.supervisor, 'SIGKILL');
    } catch {
      /* уже завершился */
    }
    await delay(200);
  }
  const after = readReceipt(receipt.dir) ?? receipt;
  if (!live(after)) return after;
  return cleanupDead(ctx, after, 'stopped', reason, 'supervisor не завершил остановку сам');
}

const lifecycleOf = (ctx: PreviewContext, repositoryId: string) =>
  ctx.policy.repositories.find((r) => r.id === repositoryId)?.lifecycle;

/** Сверка receipt с процессами: незавершённое превью без supervisor — очистка и `failed`. */
async function reconcile(ctx: PreviewContext, receipt: PreviewReceipt) {
  if (!live(receipt) || supervisorAlive(receipt)) return receipt;
  return cleanupDead(
    ctx,
    receipt,
    'failed',
    'supervisor-gone',
    'надзирающий процесс превью пропал; превью остановлено по receipt',
  );
}

/** `preview-list`: receipt каждого превью после сверки с живыми процессами. */
export async function listPreviews(ctx: PreviewContext) {
  const out: PreviewReceipt[] = [];
  for (const r of previewReceipts(ctx.stateDir)) out.push(await reconcile(ctx, r));
  return { previews: out };
}

/** `preview-stop`: названное превью или все живые (с фильтром по репозиторию). */
export async function stopPreviews(
  ctx: PreviewContext,
  options: { repositoryId?: string; previewId?: string } = {},
) {
  const all = previewReceipts(ctx.stateDir).filter(
    (r) =>
      (!options.repositoryId || r.repositoryId === options.repositoryId) &&
      (!options.previewId || r.id === options.previewId),
  );
  if (options.previewId && !all.length)
    throw new HarnessError('NOT_FOUND', 'Превью не запускалось: ' + options.previewId, [
      { path: ['--preview'], message: options.previewId },
    ]);
  const out: PreviewReceipt[] = [];
  let changed = false;
  for (const r of all) {
    if (!live(r)) {
      if (options.previewId) out.push(r);
      continue;
    }
    changed = true;
    out.push(await stopOne(ctx, r, 'operator'));
  }
  return { previews: out, changed };
}

/** Репозиторий и превью запуска: названные или единственные. */
function previewOf(policy: ExecutionPolicy, repositoryId?: string, previewId?: string) {
  const withPreviews = policy.repositories.filter((r) => r.previews?.length);
  let repo: Repo;
  if (repositoryId) {
    repo = repositoryOf(policy, repositoryId);
  } else if (withPreviews.length === 1) repo = withPreviews[0]!;
  else if (!withPreviews.length)
    throw new HarnessError(
      'NOT_FOUND',
      'В политике нет превью (previews[] репозитория): см. docs/previews.md',
    );
  else
    throw new HarnessError(
      'INVALID_INPUT',
      `Превью есть у нескольких репозиториев (${withPreviews.map((r) => r.id).join(', ')}): назовите --repository`,
    );
  const list = repo.previews ?? [];
  const preview = previewId
    ? list.find((p) => p.id === previewId)
    : list.length === 1
      ? list[0]
      : undefined;
  if (!preview)
    throw new HarnessError(
      previewId || !list.length ? 'NOT_FOUND' : 'INVALID_INPUT',
      previewId
        ? `Превью ${previewId} не объявлено у репозитория ${repo.id}`
        : list.length
          ? `У репозитория ${repo.id} несколько превью (${list.map((p) => p.id).join(', ')}): назовите --preview`
          : `У репозитория ${repo.id} нет превью (previews[])`,
      [{ path: ['--preview'], message: previewId ?? '' }],
    );
  return { repo, preview };
}

/** Спецификация supervisor: всё, что нужно ему без политики и базы состояния. */
export interface PreviewSpec {
  receipt: Omit<PreviewReceipt, 'pids' | 'starts' | 'startedAt' | 'expiresAt' | 'state'>;
  repoPath: string;
  previewsRoot: string;
  preview: PreviewDefinition;
  lifecycle?: Repo['lifecycle'];
  environments: Parameters<typeof executionEnvironment>[0];
  toolchain?: ExecutionPolicy['toolchain'];
}

/** Команда supervisor — этот же пакет (исходники — через загрузчик tsx, как сервер проверок). */
export function supervisorCommand(specPath: string) {
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(
    new URL(source ? './preview-supervisor.ts' : './preview-supervisor.js', import.meta.url),
  );
  return [...(source ? ['--import', import.meta.resolve('tsx')] : []), entry, '--spec', specPath];
}

export interface StartPreviewInput {
  repositoryId?: string;
  previewId?: string;
  /** `accepted` (по умолчанию) или SHA/ref. */
  ref?: string;
  workId?: string;
  ttlMs?: number;
  idleMs?: number;
  /** Принятый результат поручения: статус, SHA и репозиторий (`--work`). */
  work?: (id: string) => { status: string; resultSha?: string; repositoryId: string } | undefined;
  env?: NodeJS.ProcessEnv;
}

/**
 * `preview-start`: превью на принятом результате (или ref) в своём рабочем
 * дереве. То же превью на том же коммите уже идёт — возвращается оно
 * (`changed: false`); на другом коммите — прежнее останавливается
 * (`replaced`) и запускается новое.
 */
export async function startPreview(ctx: PreviewContext, input: StartPreviewInput) {
  assertOperatorContext(input.env);
  const ref = input.ref ?? 'accepted';
  if (input.workId && ref !== 'accepted')
    throw new HarnessError(
      'INVALID_INPUT',
      '--work задаёт принятый результат: только с --ref accepted',
      [{ path: ['--work'], message: input.workId }],
    );
  let repositoryId = input.repositoryId;
  let sha: string | undefined;
  if (input.workId) {
    const work = input.work?.(input.workId);
    if (!work)
      throw new HarnessError('NOT_FOUND', 'Поручение не найдено: ' + input.workId, [
        { path: ['--work'], message: input.workId },
      ]);
    if (work.status !== 'done' || !work.resultSha)
      throw new HarnessError(
        'NOT_READY',
        `Поручение ${input.workId} ещё не принято (${work.status}): превью показывает принятый результат`,
        [{ path: ['--work'], message: work.status }],
      );
    if (repositoryId && repositoryId !== work.repositoryId)
      throw new HarnessError(
        'INVALID_INPUT',
        `Поручение ${input.workId} — репозитория ${work.repositoryId}, а не ${repositoryId}`,
      );
    repositoryId = work.repositoryId;
    sha = work.resultSha;
  }
  const { repo, preview } = previewOf(ctx.policy, repositoryId, input.previewId);
  const repoPath = repositoryPath(ctx.baseDir)(repo);
  sha ??= await commitOf(repoPath, ref === 'accepted' ? repo.targetRef : ref, repo.id);
  if (preview.services && !repo.lifecycle)
    throw new HarnessError(
      'INVALID_INPUT',
      `Превью ${preview.id} требует служб (services), а у репозитория ${repo.id} нет lifecycle`,
    );
  const dir = previewDir(ctx.stateDir, repo.id, preview.id);
  const previous = readReceipt(dir);
  if (previous) {
    const current = await reconcile(ctx, previous);
    if (live(current)) {
      if (current.sha === sha && current.state === 'running')
        return { preview: current, changed: false };
      await stopOne(ctx, current, 'replaced');
    }
  }
  const tree = join(dir, 'tree');
  const root = previewsRoot(ctx.stateDir);
  mkdirSync(dir, { recursive: true });
  if (existsSync(tree)) await removeTree(repoPath, tree, root);
  if (existsSync(tree))
    throw new HarnessError('NOT_READY', 'Рабочее дерево прежнего превью не убрано: ' + tree);
  try {
    // `--force`: путь прежнего дерева превью, убранного без git (запись о нём
    // осталась), занимается заново; чужие записи деревьев не трогаются (без prune).
    await git(repoPath, 'worktree', 'add', '--force', '--detach', tree, sha);
  } catch (error) {
    throw new HarnessError(
      'GIT_FAILED',
      'Рабочее дерево превью не создано: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const ttlMs = input.ttlMs ?? preview.ttlMs ?? PREVIEW_DEFAULTS.ttlMs;
  const idleMs = input.idleMs ?? preview.idleMs ?? PREVIEW_DEFAULTS.idleMs;
  const spec: PreviewSpec = {
    receipt: {
      version: 1,
      id: preview.id,
      repositoryId: repo.id,
      ...(preview.title ? { title: preview.title } : {}),
      ref,
      ...(input.workId ? { workId: input.workId } : {}),
      sha,
      worktree: tree,
      dir,
      log: join(dir, 'app.log'),
      services: preview.services === true,
      ttlMs,
      idleMs,
    },
    repoPath,
    previewsRoot: root,
    preview,
    ...(preview.services && repo.lifecycle ? { lifecycle: repo.lifecycle } : {}),
    environments: [ctx.policy.environment, repo.environment],
    ...(ctx.policy.toolchain ? { toolchain: ctx.policy.toolchain } : {}),
  };
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(spec, null, 2));
  rmSync(join(dir, 'stop-reason'), { force: true });
  const logPath = join(dir, 'supervisor.log');
  const fd = openSync(logPath, 'w');
  const child = spawn(process.execPath, supervisorCommand(specPath), {
    cwd: dir,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  closeSync(fd);
  child.unref();
  const pid = child.pid;
  if (!pid) {
    await removeTree(repoPath, tree, root);
    throw new HarnessError('LIFECYCLE_FAILED', 'Надзирающий процесс превью не запустился');
  }
  const steps = (list: { timeoutMs: number }[] | undefined) =>
    (list ?? []).reduce((a, s) => a + s.timeoutMs, 0);
  const deadline =
    Date.now() +
    steps(preview.build) +
    (spec.lifecycle ? steps(spec.lifecycle.setup) + steps(spec.lifecycle.ready) : 0) +
    (preview.readyTimeoutMs ?? PREVIEW_DEFAULTS.readyTimeoutMs) +
    30_000;
  const failed = (message: string, receipt?: PreviewReceipt) =>
    new HarnessError('LIFECYCLE_FAILED', message, [
      { path: ['preview', preview.id], message: receipt?.reason ?? 'start' },
      { path: ['log'], message: receipt?.log ?? logPath },
    ]);
  for (;;) {
    const r = readReceipt(dir);
    const own = r && r.pids.supervisor === pid ? r : undefined;
    if (own?.state === 'running') return { preview: own, changed: true };
    if (own && !live(own))
      throw failed(
        `Превью ${preview.id} не поднялось (${own.reason ?? own.state}): ${own.message ?? 'см. лог'}; лог приложения — ${own.log}`,
        own,
      );
    if (!processAlive(pid)) {
      const tail = (() => {
        try {
          return readFileSync(logPath, 'utf8').slice(-1000);
        } catch {
          return '';
        }
      })();
      if (own) await cleanupDead(ctx, own, 'failed', 'supervisor-gone', tail);
      else await removeTree(repoPath, tree, root);
      throw failed(
        `Надзирающий процесс превью завершился до готовности; лог — ${logPath}: ${tail}`,
      );
    }
    if (Date.now() > deadline) {
      const stopped = own ? await stopOne(ctx, own, 'operator') : undefined;
      if (!stopped) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* уже завершился */
        }
        await removeTree(repoPath, tree, root);
      }
      throw failed(`Превью ${preview.id} не поднялось вовремя; лог — ${logPath}`, stopped);
    }
    await delay(previewTiming.pollMs);
  }
}

/* ------------------------------------------------------------------ */
/* Supervisor                                                          */
/* ------------------------------------------------------------------ */

/** Свободный loopback-порт: выдан ОС и свободен на всех адресах пробы (`busyHosts`). */
export async function freeLoopbackPort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((done, fail) => {
      const server = createServer();
      server.once('error', fail);
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = server.address();
        const p = typeof address === 'object' && address ? address.port : 0;
        server.close(() => done(p));
      });
    });
    if (port && !(await busyHosts(port)).length) return port;
  }
  throw new Error('Свободный loopback-порт не найден');
}

/** Подстановки `{port}` и `{host}`. */
const placeholders = (value: string, port: number) =>
  value.replaceAll('{port}', String(port)).replaceAll('{host}', '127.0.0.1');

/** Ответ на `health` меньше 400. */
function healthy(port: number, path: string) {
  return new Promise<boolean>((done) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', timeout: 2000 }, (res) => {
      res.resume();
      done((res.statusCode ?? 500) < 400);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(false));
    req.end();
  });
}

/**
 * Loopback-прокси на публичном порту: байты в обе стороны, каждая порция от
 * клиента — активность (`touch`). Слушает только 127.0.0.1.
 */
async function loopbackProxy(target: number, touch: () => void) {
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    touch();
    const upstream = connect({ host: '127.0.0.1', port: target });
    sockets.add(client).add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('data', touch);
    client.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen({ host: '127.0.0.1', port: 0 }, () => done());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise<void>((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => done());
      }),
  };
}

/**
 * Надзор превью (процесс `preview-supervisor`): lifecycle, сборка, запуск,
 * готовность, прокси, срок и простой, остановка и очистка. Receipt пишет
 * только он, пока жив.
 */
export async function supervisePreview(spec: PreviewSpec) {
  const startedAt = Date.now();
  const { preview } = spec;
  let receipt: PreviewReceipt = {
    ...spec.receipt,
    pids: { supervisor: process.pid },
    starts: { ...(processStart(process.pid) ? { supervisor: processStart(process.pid)! } : {}) },
    startedAt: new Date(startedAt).toISOString(),
    expiresAt: new Date(startedAt + spec.receipt.ttlMs).toISOString(),
    state: 'starting',
  };
  const save = (patch: Partial<PreviewReceipt>) => {
    receipt = { ...receipt, ...patch };
    writeReceipt(receipt);
  };
  save({});
  const abort = new AbortController();
  let reason: PreviewReason | undefined;
  const stop = (why: PreviewReason) => {
    reason ??= why;
    abort.abort(new Error('Превью останавливается: ' + why));
  };
  const onSignal = () => {
    let why: PreviewReason = 'operator';
    try {
      const text = readFileSync(join(spec.receipt.dir, 'stop-reason'), 'utf8').trim();
      if (text === 'replaced') why = 'replaced';
    } catch {
      /* причина по умолчанию — оператор */
    }
    stop(why);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('SIGHUP', onSignal);
  const ttl = setTimeout(() => stop('ttl'), spec.receipt.ttlMs);
  let stage: PreviewReason = spec.lifecycle ? 'services' : 'build';
  let app: ReturnType<typeof spawn> | undefined;
  let proxy: Awaited<ReturnType<typeof loopbackProxy>> | undefined;
  let failure: string | undefined;
  const cwd = preview.cwd ? join(spec.receipt.worktree, preview.cwd) : spec.receipt.worktree;
  try {
    const execution = executionEnvironment(
      spec.environments,
      { DEVCONTOUR_REPOSITORY_ID: spec.receipt.repositoryId, DEVCONTOUR_PHASE: 'preview' },
      process.env,
      spec.toolchain,
    );
    await withEnvironment(
      spec.lifecycle,
      spec.receipt.worktree,
      join(spec.receipt.dir, 'environment'),
      execution,
      abort.signal,
      async () => {
        stage = 'build';
        await runSteps(
          preview.build ?? [],
          cwd,
          join(spec.receipt.dir, 'build'),
          execution,
          abort.signal,
        );
        stage = 'start';
        const appPort = await freeLoopbackPort();
        const env: NodeJS.ProcessEnv = {
          ...execution.env,
          ...Object.fromEntries(
            Object.entries(preview.env ?? {}).map(([k, v]) => [k, placeholders(v, appPort)]),
          ),
          PORT: String(appPort),
          HOST: '127.0.0.1',
        };
        const argv = preview.start.map((a) => placeholders(a, appPort));
        const fd = openSync(spec.receipt.log, 'w');
        let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
        try {
          app = spawn(argv[0]!, argv.slice(1), {
            cwd,
            env,
            detached: true,
            stdio: ['ignore', fd, fd],
          });
        } finally {
          closeSync(fd);
        }
        const exit = new Promise<void>((done) => {
          app!.once('exit', (code, signal) => {
            exited = { code, signal };
            done();
          });
          app!.once('error', (error) => {
            exited = { code: null, signal: null };
            failure = `команда start не запустилась: ${error.message}`;
            done();
          });
        });
        const appPid = app.pid;
        save({
          appPort,
          pids: { supervisor: process.pid, ...(appPid ? { app: appPid } : {}) },
          starts: {
            ...receipt.starts,
            ...(appPid && processStart(appPid) ? { app: processStart(appPid)! } : {}),
          },
        });
        stage = 'health';
        const health = preview.health ?? PREVIEW_DEFAULTS.health;
        const ready = Date.now() + (preview.readyTimeoutMs ?? PREVIEW_DEFAULTS.readyTimeoutMs);
        while (!(await healthy(appPort, health))) {
          abort.signal.throwIfAborted();
          if (exited) {
            stage = 'start';
            throw new Error(
              failure ??
                `приложение завершилось до готовности (код ${exited.code ?? exited.signal}); лог — ${spec.receipt.log}`,
            );
          }
          if (Date.now() > ready)
            throw new Error(
              `нет ответа меньше 400 на http://127.0.0.1:${appPort}${health} за ${Math.round((preview.readyTimeoutMs ?? PREVIEW_DEFAULTS.readyTimeoutMs) / 1000)} с; лог — ${spec.receipt.log}`,
            );
          await delay(200);
        }
        let last = Date.now();
        let saved = last;
        proxy = await loopbackProxy(appPort, () => {
          last = Date.now();
        });
        save({
          state: 'running',
          port: proxy.port,
          url: `http://127.0.0.1:${proxy.port}/`,
          lastActivity: new Date(last).toISOString(),
        });
        const tick = Math.max(100, Math.min(5000, receipt.idleMs ? receipt.idleMs / 5 : 5000));
        const watch = setInterval(() => {
          if (last !== saved) {
            saved = last;
            save({ lastActivity: new Date(last).toISOString() });
          }
          if (receipt.idleMs && Date.now() - last > receipt.idleMs) stop('idle');
        }, tick);
        try {
          await Promise.race([
            exit,
            new Promise<void>((done) =>
              abort.signal.addEventListener('abort', () => done(), { once: true }),
            ),
          ]);
        } finally {
          clearInterval(watch);
        }
        if (exited && !reason) {
          reason = 'exited';
          failure = `приложение завершилось само (код ${exited.code ?? exited.signal}); лог — ${spec.receipt.log}`;
        }
        save({ state: 'stopping' });
        await proxy.close();
        proxy = undefined;
        if (appPid && !exited) await stopGroup(appPid);
      },
    );
  } catch (error) {
    if (!reason) {
      reason = stage;
      failure ??= error instanceof Error ? error.message : String(error);
    } else if (!['operator', 'ttl', 'idle', 'replaced', 'exited'].includes(reason))
      failure ??= error instanceof Error ? error.message : String(error);
    // Отказ очистки окружения при штатной остановке — тоже в receipt.
    if (error instanceof Error && error.name === 'CleanupFailure') failure = error.message;
  } finally {
    clearTimeout(ttl);
    if (proxy) await proxy.close();
    if (app?.pid && app.exitCode === null && app.signalCode === null) await stopGroup(app.pid);
    await removeTree(spec.repoPath, spec.receipt.worktree, spec.previewsRoot);
  }
  const ok =
    reason === 'operator' || reason === 'ttl' || reason === 'idle' || reason === 'replaced';
  save({
    state: ok && !failure ? 'stopped' : 'failed',
    reason: reason ?? 'exited',
    stoppedAt: new Date().toISOString(),
    ...(failure ? { message: failure.slice(0, 2000) } : {}),
  });
}
