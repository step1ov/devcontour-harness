import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { z } from 'zod';
import {
  HarnessError,
  PROJECT_MANIFEST_PATH,
  PROJECT_POLICY_PATH,
  dependencyStoreSchema,
  executionDigest,
  executionPolicySchema,
  policyDigest,
  projectManifestSchema,
  type ExecutionPolicy,
  type ExecutionPolicyInput,
  type ProjectManifest,
  repositoryPolicySchema,
  type leanDataSchema,
} from '../contracts/index.ts';
import { HARNESS_VERSION } from '../package.ts';
import { profilePin, resolveProfile } from '../profiles/resolve.ts';
import { SqliteExecutionStore } from '../storage/sqlite.ts';
import { timeBudgetWarnings, requiredRunTimeoutMs } from '../verification/time-budget.ts';
import {
  EXECUTION_FIELDS,
  PROJECT_REPOSITORY_ID,
  executionFieldsOf,
  type ExecutionField,
} from './policy.ts';
import { gitRoot, projectFile } from './project.ts';

export type LeanData = z.infer<typeof leanDataSchema>;
type LeanRecord = NonNullable<ProjectManifest['lean']>;
type Problem = LeanData['problems'][number];
type Change = LeanData['changes'][number];

export interface LeanOptions {
  repository: string;
  /** Выключить слой; по умолчанию — включить. */
  off?: boolean;
  /** Только изменения, без записи. */
  plan?: boolean;
  /** Каталог состояния для проверки идущего run; по умолчанию — `paths.state` manifest. */
  state?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /**
   * Точки внутренних проверок записи (тесты): перед последней сверкой файла
   * (временный файл уже записан) и после его rename.
   */
  beforeReplace?: (path: string) => void;
  afterReplace?: (path: string) => void;
}

const LAYER = 'lean';

const lstat = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Записать поле объекта, не трогая порядок прочих: существующее — на месте,
 * новое — перед первым существующим полем, которое идёт после него в `order`,
 * иначе в конец. Удаление — `undefined`.
 */
function setField(
  object: Record<string, unknown>,
  key: string,
  value: unknown,
  order: readonly string[],
): Record<string, unknown> {
  if (value === undefined) {
    const rest = { ...object };
    delete rest[key];
    return rest;
  }
  if (key in object) return { ...object, [key]: value };
  const after = order.slice(order.indexOf(key) + 1);
  const entries = Object.entries(object);
  const at = order.includes(key) ? entries.findIndex(([k]) => after.includes(k)) : -1;
  entries.splice(at === -1 ? entries.length : at, 0, [key, value]);
  return Object.fromEntries(entries);
}

/**
 * Manifest в порядке полей `init`: `lean` — сразу после `profile`; прочие поля
 * и их порядок — как в сохранённом файле.
 */
function manifestWith(
  saved: ProjectManifest,
  profile: ProjectManifest['profile'],
  record: LeanRecord | undefined,
): ProjectManifest {
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(saved)) {
    if (key === 'lean') continue;
    if (key === 'profile') {
      entries.push(['profile', profile]);
      if (record) entries.push(['lean', record]);
    } else entries.push([key, value]);
  }
  return projectManifestSchema.parse(Object.fromEntries(entries));
}

/** Запись поверх файла: временный файл того же каталога и rename; права прежние. */
function replaceFile(
  path: string,
  text: string,
  expected: string,
  written: string[],
  before?: (path: string) => void,
) {
  if (readFileSync(path, 'utf8') !== expected) throw changedUnder(path, written);
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const mode = lstatSync(path).mode & 0o7777;
  let created = false;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    created = true;
    try {
      const data = new TextEncoder().encode(text);
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, mode);
    before?.(path);
    // Последняя сверка перед заменой: чужая запись между чтением и rename — отказ.
    // Окно между этой сверкой и rename остаётся: блокировки файлов политики нет.
    if (readFileSync(path, 'utf8') !== expected) throw changedUnder(path, written);
    renameSync(temp, path);
    created = false;
  } finally {
    if (created) rmSync(temp, { force: true });
  }
}

const changedUnder = (path: string, written: string[] = []) =>
  new HarnessError(
    'REVISION_CONFLICT',
    written.length
      ? `${path} изменён после чтения: он не записан, а ${written.join(', ')} уже записан — переключение выполнено наполовину; повторите команду, она допишет недостающее`
      : `${path} изменён после чтения: переключение слоя lean не записано, файлы прежние; повторите команду`,
    [
      { path: [path], message: 'changed-after-read' },
      ...written.map((w) => ({ path: [w], message: 'written' })),
    ],
  );

/** Файл проекта для чтения: настоящий файл внутри `.harness/`, текст и разбор. */
function readProjectFile<T>(
  root: string,
  rel: string,
  schema: z.ZodType<T>,
  missing: string,
): { path: string; text: string; value: T; raw: unknown } {
  const path = projectFile(root, rel);
  if (!path)
    throw new HarnessError('NOT_READY', missing, [
      {
        path: [join(root, rel)],
        message: rel === PROJECT_MANIFEST_PATH ? 'manifest-missing' : 'policy-missing',
      },
    ]);
  const text = readFileSync(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new HarnessError('INVALID_INPUT', `${path}: не JSON (${(error as Error).message})`, [
      { path: [path], message: 'invalid-json' },
    ]);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new HarnessError(
      'INVALID_INPUT',
      `${path}: не проходит схему; исправьте файл`,
      parsed.error.issues.map((i) => ({
        path: [path, ...(i.path as (string | number)[])],
        message: i.message,
      })),
    );
  return { path, text, value: parsed.data, raw };
}

/** Идущий run в каталоге состояния: живая роль controller, попытки и совместные проверки. */
function stateFacts(stateDir: string, before: ExecutionPolicy, now: number) {
  const file = join(stateDir, 'state.sqlite');
  const problems: Problem[] = [];
  const notes: string[] = [];
  let approved: string[] = [];
  if (!existsSync(file)) return { problems, notes, approved };
  SqliteExecutionStore.readOnce(file, 'devcontour-harness@' + HARNESS_VERSION, (store) =>
    store.read((v) => {
      const lease = v.controller();
      if (lease && lease.leaseUntil > now)
        problems.push({
          code: 'CONTROLLER_BUSY',
          message: `Роль controller держит ${lease.owner} до ${new Date(lease.leaseUntil).toISOString()}: идёт harness run. Политика не меняется посреди исполнения — дождитесь окончания или остановите run (pause), затем повторите`,
        });
      const active = (v.activeAttempts ? v.activeAttempts() : v.attempts()).filter(
        (a) => a.status === 'active',
      );
      for (const a of active) {
        const until = v.attemptLease?.(a.id)?.leaseUntil ?? a.leaseUntil;
        if (until > now)
          problems.push({
            code: 'CONTROLLER_BUSY',
            message: `Идёт попытка ${a.id} поручения ${a.workId} (владение до ${new Date(until).toISOString()}): она исполняется под прежней политикой. Дождитесь её окончания, затем повторите`,
          });
        else
          notes.push(
            `Попытка ${a.id} поручения ${a.workId} прервана (владение истекло): следующий run восстановит её уже под новой политикой`,
          );
      }
      for (const j of v.verifications())
        if (j.status === 'active' && j.leaseUntil > now)
          problems.push({
            code: 'CONTROLLER_BUSY',
            message: `Идёт совместная проверка ${j.id}: дождитесь её окончания, затем повторите`,
          });
      const digest = executionDigest(before);
      // Завершённый граф (все поручения done или cancelled) согласования больше не требует.
      approved = v
        .graphs()
        .filter(
          (g) =>
            g.approval &&
            g.policyDigest === digest &&
            v.works(g.id).some((w) => w.status !== 'done' && w.status !== 'cancelled'),
        )
        .map((g) => g.id);
    }),
  );
  return { problems, notes, approved };
}

/**
 * `harness lean`: включить или выключить слой `lean` в подготовленном проекте.
 *
 * Включение складывает поля исполнения политики со слоем по правилам слоёв:
 * `concurrency` — наименьшая, `gateTimeoutFloorMs` — наибольшая, `runTimeoutMs`
 * — наибольший из текущего, слоя и требуемого пределами шагов
 * (`requiredRunTimeoutMs`, когда их сумма больше срока); pnpm-репозиторию с
 * `pnpm-lock.yaml` (как `init --lean`) добавляется `dependencyStore`. Manifest
 * получает `profile.layers` с `lean`, закрепление профиля со слоем и запись
 * `lean` — прежние и записанные значения. Выключение по записи возвращает
 * прежние значения точно; без записи (`init --lean`) — значения, которые
 * `init` вывел бы из профиля без слоя. Поле, изменённое вручную после
 * включения, — проблема `PATH_CONFLICT`, а не молчаливая перезапись.
 *
 * Прочие байты файлов прежние (JSON с отступом 2, как пишет `init`). Запись
 * атомарна для каждого файла (временный файл и rename) и отказывает
 * `REVISION_CONFLICT`, если файл изменился после чтения. Порядок записи
 * делает прерывание продолжаемым: включение — manifest, затем политика;
 * выключение — политика, затем manifest.
 */
export async function switchLean(options: LeanOptions): Promise<LeanData> {
  const env = options.env ?? process.env;
  const now = (options.now ?? Date.now)();
  const enable = !options.off;
  const root = await gitRoot(options.repository, env);
  const manifestFile = readProjectFile(
    root,
    PROJECT_MANIFEST_PATH,
    projectManifestSchema,
    `Нет ${join(root, PROJECT_MANIFEST_PATH)} (или это не обычный файл): lean записывает решение о слое и прежние значения политики в manifest. ` +
      `Выполните harness init --repository ${root} — в новом checkout manifest восстанавливается по сохранённой политике, политика не меняется, — затем повторите harness lean`,
  );
  const policyFile = readProjectFile(
    root,
    PROJECT_POLICY_PATH,
    executionPolicySchema,
    `Нет ${join(root, PROJECT_POLICY_PATH)}: подготовка не завершена — выполните harness init --repository ${root}, затем повторите harness lean`,
  );
  const manifest = manifestFile.value;
  const before = policyFile.value;
  const raw = policyFile.raw as ExecutionPolicyInput & Record<string, unknown>;
  const layers = manifest.profile.layers ?? [];
  const enabledBefore = layers.includes(LAYER);
  const others = layers.filter((l) => l !== LAYER);
  const resolve = (withLean: boolean) => {
    const list = withLean ? [...others, LAYER] : others;
    return resolveProfile(manifest.profile.ref, {
      repository: root,
      repositoryId: PROJECT_REPOSITORY_ID,
      ...(list.length ? { layers: list } : {}),
    });
  };
  const plain = resolve(false);
  const lean = resolve(true);
  const repoIndex = before.repositories.findIndex((r) => r.id === manifest.repository.id);
  const repo = repoIndex === -1 ? undefined : before.repositories[repoIndex]!;
  const storeEligible =
    repo !== undefined &&
    plain.toolchain?.packageManagers['.'] === 'pnpm' &&
    Boolean(lstat(join(root, 'pnpm-lock.yaml'))?.isFile());
  const storeValue = dependencyStoreSchema.parse({ manager: 'pnpm' });
  const storeField = `repositories[${repoIndex}].dependencyStore`;
  const rawRepo = () =>
    (raw.repositories as unknown as Record<string, unknown>[] | undefined)?.[repoIndex];

  const problems: Problem[] = [];
  const notes: string[] = [];
  // Целевые значения полей исполнения; undefined — удалить поле.
  const target = new Map<ExecutionField, number | undefined>();
  let store: 'add' | 'remove' | undefined;
  let record: LeanRecord | undefined = manifest.lean;
  const conflict = (field: string, message: string) =>
    problems.push({ code: 'PATH_CONFLICT', field, message });

  if (enable && !enabledBefore) {
    const wanted: Record<ExecutionField, number | undefined> = {
      concurrency: Math.min(before.concurrency, lean.concurrency ?? before.concurrency),
      gateTimeoutFloorMs:
        Math.max(before.gateTimeoutFloorMs ?? 0, lean.gateTimeoutFloorMs ?? 0) || undefined,
      runTimeoutMs: Math.max(before.runTimeoutMs, lean.runTimeoutMs ?? 0),
    };
    // Срок фазы — не меньше требуемого пределами шагов с новой границей gate.
    const candidate = executionPolicySchema.parse({ ...raw, ...definedOf(wanted) });
    if (timeBudgetWarnings(candidate).length)
      wanted.runTimeoutMs = Math.max(requiredRunTimeoutMs(candidate), wanted.runTimeoutMs!);
    const changes: LeanRecord['policy'] = [];
    for (const field of EXECUTION_FIELDS) {
      const value = wanted[field];
      if (value === undefined || value === before[field]) continue;
      const previous = raw[field];
      target.set(field, value);
      changes.push({ field, ...(previous !== undefined ? { previous } : {}), applied: value });
      if (previous !== undefined)
        notes.push(
          `${field}: в политике было явно ${previous}; слой lean ставит ${value}; lean --off вернёт ${previous}`,
        );
    }
    if (storeEligible && repo.dependencyStore === undefined) store = 'add';
    record = {
      policy: changes,
      ...(store === 'add' ? { dependencyStore: { repository: repo!.id } } : {}),
    };
  } else if (enable) {
    // Уже включён: прерванное включение дописывается, ручные правки остаются.
    for (const c of manifest.lean?.policy ?? []) {
      const current = raw[c.field];
      if (current === c.applied) continue;
      if (current === c.previous) target.set(c.field, c.applied);
      else
        notes.push(
          `${c.field}: слой lean записал ${c.applied}, сейчас ${current ?? 'нет поля'} — правка после включения сохраняется`,
        );
    }
    const added = manifest.lean?.dependencyStore;
    if (added && repo && repo.dependencyStore === undefined) store = 'add';
    if (!manifest.lean) {
      // Слой init --lean: поле со значением профиля без слоя — прерванное
      // выключение, его значение слоя возвращается; иное — ручная правка.
      const base = withoutExecution(raw);
      const expected = executionFieldsOf(base, lean);
      const without = executionFieldsOf(base, plain);
      for (const field of EXECUTION_FIELDS) {
        const current = raw[field];
        if (current === expected[field]) continue;
        if (current === without[field]) target.set(field, expected[field]);
        else
          notes.push(
            `${field}: слой lean (init --lean) дал бы ${expected[field] ?? 'нет поля'}, сейчас ${String(current ?? 'нет поля')} — правка сохраняется`,
          );
      }
      if (storeEligible && repo.dependencyStore === undefined) store = 'add';
    }
  } else if (enabledBefore) {
    if (manifest.lean) {
      for (const c of manifest.lean.policy) {
        const current = raw[c.field];
        if (current === c.previous) continue;
        if (current === c.applied) target.set(c.field, c.previous);
        else
          conflict(
            c.field,
            `${c.field}: слой lean записал ${c.applied} (до него — ${c.previous ?? 'нет поля'}), а сейчас ${current ?? 'нет поля'}: поле изменено вручную после включения. ` +
              `Верните ${c.applied} или задайте нужное значение в .harness/policy.json сами и уберите запись этого поля из manifest — lean --off не перезаписывает ручные правки`,
          );
      }
      if (manifest.lean.dependencyStore) {
        const current = rawRepo()?.dependencyStore;
        if (current !== undefined) {
          if (isLeanStore(current)) store = 'remove';
          else
            conflict(
              storeField,
              `${storeField}: слой lean добавил ${JSON.stringify(storeValue)}, а сейчас ${JSON.stringify(current)}: хранилище настроено вручную, lean --off его не удаляет. Удалите поле сами или оставьте его`,
            );
        }
      }
    } else {
      // Включён `init --lean`: прежние значения — те, что init дал бы без слоя.
      const base = withoutExecution(raw);
      const withLean = executionFieldsOf(base, lean);
      const without = executionFieldsOf(base, plain);
      for (const field of EXECUTION_FIELDS) {
        const current = raw[field];
        // Слой не задаёт поле, если с ним и без него init вывел бы одно значение.
        if (withLean[field] === without[field] || current === without[field]) continue;
        if (current === withLean[field]) target.set(field, without[field]);
        else
          conflict(
            field,
            `${field}: слой lean (init --lean) дал бы ${withLean[field] ?? 'нет поля'}, профиль без слоя — ${without[field] ?? 'нет поля'}, а сейчас ${current ?? 'нет поля'}: значение задано вручную. Задайте нужное значение в .harness/policy.json сами — lean --off не перезаписывает ручные правки`,
          );
      }
      const current = rawRepo()?.dependencyStore;
      if (storeEligible && current !== undefined) {
        if (isLeanStore(current)) store = 'remove';
        else
          notes.push(
            `${storeField}: ${JSON.stringify(current)} отличается от того, что добавляет init --lean, — хранилище настроено вручную и остаётся`,
          );
      }
    }
    record = undefined;
  }

  // Новая политика: только изменённые поля, прочие байты — прежние.
  let next: Record<string, unknown> = raw;
  const changes: Change[] = [];
  for (const [field, value] of target) {
    if (raw[field] === value) continue;
    changes.push({
      file: 'policy',
      field,
      ...(raw[field] !== undefined ? { before: raw[field] } : {}),
      ...(value !== undefined ? { after: value } : {}),
    });
    next = setField(next, field, value, EXECUTION_FIELDS);
  }
  if (store) {
    const repos = [...(next.repositories as Record<string, unknown>[])];
    const current = repos[repoIndex]!;
    const value = store === 'add' ? storeValue : undefined;
    repos[repoIndex] = setField(
      current,
      'dependencyStore',
      value,
      Object.keys(repositoryPolicySchema.shape),
    );
    next = { ...next, repositories: repos };
    changes.push({
      file: 'policy',
      field: storeField,
      ...(current.dependencyStore !== undefined ? { before: current.dependencyStore } : {}),
      ...(value ? { after: value } : {}),
    });
  }
  const after = executionPolicySchema.parse(next);
  const policyText = changes.length ? json(next) : policyFile.text;
  if (changes.length && json(raw) !== policyFile.text)
    notes.push(
      `${policyFile.path} записан не в формате init (JSON с отступом 2): файл перезаписывается в этом формате, значения прочих полей прежние`,
    );

  // Manifest: слои, закрепление профиля со слоем или без и запись прежних значений.
  const enabled = enable;
  let manifestText = manifestFile.text;
  if (enabled !== enabledBefore || (enabled && !same(record, manifest.lean))) {
    const nextLayers = enabled ? [...others, LAYER] : others;
    const profile: ProjectManifest['profile'] = {
      ref: manifest.profile.ref,
      pin: profilePin(enabled ? lean : plain),
      ...(nextLayers.length ? { layers: nextLayers } : {}),
    };
    const updated = manifestWith(manifest, profile, enabled ? record : undefined);
    manifestText = json(updated);
    const push = (field: string, a: unknown, b: unknown) => {
      if (!same(a, b))
        changes.push({
          file: 'manifest',
          field,
          ...(a !== undefined ? { before: a } : {}),
          ...(b !== undefined ? { after: b } : {}),
        });
    };
    push('profile.layers', manifest.profile.layers, profile.layers);
    push('profile.pin', manifest.profile.pin, profile.pin);
    push('lean', manifest.lean, updated.lean);
  }

  const policyChanged = policyText !== policyFile.text;
  const stateDir = options.state ?? manifest.paths.state;
  const state = policyChanged
    ? stateFacts(stateDir, before, now)
    : { problems: [], notes: [], approved: [] };
  problems.push(...state.problems);
  notes.push(...state.notes);
  const digests = { before: policyDigest(before), after: policyDigest(after) };
  const staleApprovals = executionDigest(after) === executionDigest(before) ? [] : state.approved;
  if (policyChanged)
    notes.push(
      `policyDigest меняется (${digests.before.slice(0, 12)} → ${digests.after.slice(0, 12)}): следующий run --policy ${policyFile.path} применяет новую политику` +
        (staleApprovals.length
          ? `; графы ${staleApprovals.join(', ')} согласованы под прежней политикой и получат APPROVAL_STALE — повторите review-plan`
          : ''),
    );
  // Возвращённый срок фазы может не покрывать пределы шагов: политика — та, что была.
  if (policyChanged)
    for (const w of timeBudgetWarnings(after)) notes.push(`срок фазы: ${w.message}`);

  const changed = changes.length > 0;
  if (!options.plan && problems.length)
    throw new HarnessError(
      problems[0]!.code,
      problems.map((p) => p.message).join('; '),
      problems.map((p) => ({ path: [p.field ?? manifest.paths.state], message: p.code })),
    );
  if (!options.plan && changed) {
    const writes: [string, string, string][] = [];
    if (manifestText !== manifestFile.text)
      writes.push([manifestFile.path, manifestText, manifestFile.text]);
    if (policyChanged) writes.push([policyFile.path, policyText, policyFile.text]);
    // Оба файла сверяются до первой записи: изменённый второй файл не оставляет полупереключения.
    for (const [path, , expected] of writes)
      if (readFileSync(path, 'utf8') !== expected) throw changedUnder(path);
    if (!enable) writes.reverse();
    const written: string[] = [];
    for (const [path, text, expected] of writes) {
      replaceFile(path, text, expected, written, options.beforeReplace);
      written.push(path);
      options.afterReplace?.(path);
    }
  }
  return {
    mode: options.plan ? 'plan' : 'apply',
    layer: LAYER,
    enabledBefore,
    enabled,
    changed,
    root,
    policyPath: policyFile.path,
    manifestPath: manifestFile.path,
    changes,
    notes,
    problems,
    policyDigest: digests,
    staleApprovals,
    next: [
      {
        command: 'doctor',
        args: ['--policy', policyFile.path],
        why: 'Советы о ресурсах (LOW_RESOURCES, DEPENDENCY_STORE_RECOMMENDED) и toolchain новой политики',
      },
      ...(staleApprovals.length
        ? [
            {
              command: 'review-plan',
              args: ['--state', stateDir, '--graph', '<graph>', '--policy', policyFile.path],
              why: `Согласовать заново графы прежней политики: ${staleApprovals.join(', ')}`,
            },
          ]
        : []),
    ],
  };
}

/** Хранилище, которое добавляет слой: `{ manager: 'pnpm' }` в краткой или полной форме. */
const isLeanStore = (value: unknown) => {
  const parsed = dependencyStoreSchema.safeParse(value);
  return parsed.success && same(parsed.data, dependencyStoreSchema.parse({ manager: 'pnpm' }));
};

/**
 * Расхождение manifest и политики проекта (прерванное переключение или правка
 * вручную): поля, которые слой lean записал по manifest, а в политике другие.
 * Нет manifest рядом с политикой, записи `lean` или расхождений — пусто.
 */
export function leanMismatch(policyPath: string): string[] {
  try {
    const dir = dirname(policyPath);
    const manifest = projectManifestSchema.safeParse(
      JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')),
    );
    if (!manifest.success || !manifest.data.lean) return [];
    const raw = JSON.parse(readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
    const on = manifest.data.profile.layers?.includes(LAYER) ?? false;
    const off = manifest.data.lean.policy.filter((c) => raw[c.field] !== c.applied);
    if (!on || !off.length) return [];
    return [
      `LEAN_MISMATCH: manifest (${join(dir, 'project.json')}) включает слой lean, а в политике ${off
        .map(
          (c) =>
            `${c.field} = ${raw[c.field] === undefined ? 'нет поля' : JSON.stringify(raw[c.field])} (слой записал ${c.applied})`,
        )
        .join(
          ', ',
        )}: переключение прервано или поле правили вручную. Повторите harness lean --repository ${dirname(dir)} --plan (или --off --plan)`,
    ];
  } catch {
    return [];
  }
}

const definedOf = (fields: Record<string, number | undefined>) =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/** Политика без полей исполнения: основание для вывода их из профиля. */
function withoutExecution(raw: ExecutionPolicyInput): ExecutionPolicyInput {
  const rest = { ...raw };
  for (const field of EXECUTION_FIELDS) delete rest[field];
  return rest;
}

export function leanText(data: LeanData): string {
  const show = (v: unknown) => (v === undefined ? '—' : JSON.stringify(v));
  const state = (on: boolean) => (on ? 'включён' : 'выключен');
  return (
    [
      `lean ${data.mode}: ${state(data.enabledBefore)} → ${state(data.enabled)}${data.changed ? '' : ' (без изменений)'}`,
      `policy: ${data.policyPath}`,
      `manifest: ${data.manifestPath}`,
      ...data.changes.map((c) => `  ${c.file} ${c.field}: ${show(c.before)} → ${show(c.after)}`),
      ...data.problems.map((p) => `problem ${p.code}${p.field ? ` ${p.field}` : ''}: ${p.message}`),
      ...data.notes.map((n) => `note: ${n}`),
      ...(data.staleApprovals.length ? [`stale approvals: ${data.staleApprovals.join(', ')}`] : []),
      'next:',
      ...data.next.map((n) => `  harness ${n.command} ${n.args.join(' ')}  # ${n.why}`),
    ].join('\n') + '\n'
  );
}
