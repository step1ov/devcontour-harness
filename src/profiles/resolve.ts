import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  HarnessError,
  PROFILE_DEPTH_LIMIT,
  PROFILE_FILE_LIMIT,
  PROFILE_FILES_LIMIT,
  gateOrderIssues,
  gateSchema,
  repositoryPolicySchema,
  roleBindingSchema,
  stackProfileSchema,
  type ProfilePin,
  type ResolvedProfile,
  type ResolvedProfileWithLeaf,
  type StackProfile,
} from '../contracts/index.ts';
import { REQUIREMENT_GATE } from '../verification/requirements.ts';

/** Встроенные профили пакета: `profiles/<id>.json` рядом с `lib/`. */
export const builtinProfilesRoot = fileURLToPath(new URL('../../profiles/', import.meta.url));

const builtinId = /^[A-Za-z0-9_-]{1,80}$/;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const refuse = (message: string): never => {
  throw new HarnessError('INVALID_INPUT', message);
};

export interface ResolveProfileOptions {
  /** Корень репозитория, внутри которого лежат локальные профили (`./file.json`). */
  repository?: string;
  /** ID репозитория в политике; записывается в источник локального профиля. */
  repositoryId?: string;
  /** Каталог встроенных профилей; по умолчанию — профили пакета. */
  builtinRoot?: string;
  /** Вернуть текст файла листа (`leafContent`) — для хоста, который хранит его сам. */
  includeLeafContent?: boolean;
}

/** ID встроенных профилей пакета. */
export function builtinProfiles(root = builtinProfilesRoot) {
  return readdirSync(root)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** Файл профиля: внутри своего корня, без symlink на пути, обычный файл до 128 KiB. */
function safeFile(root: string, file: string) {
  const path = relative(root, file);
  if (!path || isAbsolute(path) || path === '..' || path.startsWith('..' + sep))
    refuse('Профиль должен находиться внутри репозитория');
  let cursor = root;
  for (const part of path.split(sep)) {
    cursor = join(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch {
      return refuse('Профиль не найден: ' + path);
    }
    if (stat.isSymbolicLink()) refuse('Профиль не допускает symlink: ' + path);
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > PROFILE_FILE_LIMIT) refuse('Профиль требует файл до 128 KiB');
  return readFileSync(file, 'utf8');
}

function parseManifest(content: string, name: string): StackProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return refuse(`Профиль ${name}: не JSON`);
  }
  const parsed = stackProfileSchema.safeParse(raw);
  if (!parsed.success)
    refuse(
      `Профиль ${name}: ` +
        parsed.error.issues
          .map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`)
          .join('; '),
    );
  return parsed.data!;
}

/**
 * Разрешение профиля: встроенный ID или относительный `./file.json` внутри
 * репозитория, слои `extends` в глубину, без циклов и не больше 32 файлов.
 * Только чтение манифестов — ни одна команда проекта не исполняется.
 *
 * Слои складываются: gates, подготовка, возможности, защищённые и
 * генерируемые пути — объединением; окружение и lifecycle — только из одного
 * слоя (иначе конфликт); параллельность — наименьшая, время попытки —
 * наибольшее; роли и инструкции стека — по ID, надстройка уточняет базу.
 * Итоговый профиль обязан иметь test gate с JUnit: зелёный выход без отчёта
 * ничего не доказывает. Файлы локальных слоёв становятся защищёнными путями.
 */
export function resolveProfile(
  ref: string,
  options: ResolveProfileOptions & { includeLeafContent: true },
): ResolvedProfileWithLeaf;
export function resolveProfile(ref: string, options?: ResolveProfileOptions): ResolvedProfile;
export function resolveProfile(
  ref: string,
  options: ResolveProfileOptions = {},
): ResolvedProfile | ResolvedProfileWithLeaf {
  const builtinRoot = realpathSync(options.builtinRoot ?? builtinProfilesRoot);
  const root = options.repository ? realpathSync(options.repository) : undefined;
  const repositoryId = options.repositoryId ?? 'main';
  const active = new Set<string>();
  const seen = new Set<string>();
  const closure: { ref: string; digest: string }[] = [];
  const layers: StackProfile[] = [];
  const files: string[] = [];
  let source: ResolvedProfile['source'];
  let leafContent = '';
  const visit = (reference: string, parent?: string, depth = 0): StackProfile => {
    if (depth > PROFILE_DEPTH_LIMIT) refuse('Слишком глубокое наследование профилей');
    const builtin = builtinId.test(reference);
    if (!builtin && !reference.startsWith('./') && !reference.startsWith('../'))
      refuse('Профиль: укажите встроенный ID либо относительный ./file.json');
    if (!builtin && (!root || parent === 'builtin'))
      refuse('Локальный профиль требует корень репозитория');
    const file = builtin
      ? join(builtinRoot, reference + '.json')
      : resolve(parent ?? root!, reference);
    const owner = builtin ? builtinRoot : root!;
    const key = builtin ? 'builtin:' + reference : 'local:' + relative(root!, file);
    if (active.has(key)) refuse('Цикл наследования профилей: ' + key);
    const content = safeFile(owner, file);
    const manifest = parseManifest(content, key);
    if (builtin && manifest.id !== reference) refuse('ID встроенного профиля не совпадает: ' + key);
    if (depth === 0) {
      leafContent = content;
      if (!builtin) source = { repositoryId, path: relative(root!, file) };
    }
    if (seen.has(key)) return manifest;
    if (seen.size + active.size >= PROFILE_FILES_LIMIT)
      refuse(`Не более ${PROFILE_FILES_LIMIT} файлов профиля`);
    active.add(key);
    for (const base of manifest.extends)
      visit(base, builtin ? 'builtin' : dirname(file), depth + 1);
    active.delete(key);
    seen.add(key);
    closure.push({ ref: key, digest: sha256(content) });
    if (!builtin) files.push(relative(root!, file));
    layers.push(manifest);
    return manifest;
  };
  const leaf = visit(ref);

  const declared = layers.flatMap((p) => p.gates);
  const order = gateOrderIssues(declared);
  if (order.length) refuse(order[0]!.message);
  for (const gate of declared) {
    if (gate.id === REQUIREMENT_GATE) refuse('Зарезервированный gate: ' + REQUIREMENT_GATE);
    if (gate.kind === 'test' && !gate.report) refuse('Test gate требует JUnit: ' + gate.id);
  }
  const gates = declared.map((g) => gateSchema.parse(g));
  if (!gates.some((g) => g.kind === 'test' && g.report))
    refuse('Итоговый профиль требует test gate с JUnit');
  const prepare = layers.flatMap((p) => p.prepare);
  if (new Set(prepare.map((s) => s.id)).size !== prepare.length) refuse('Повтор prepare step ID');
  const single = <K extends 'environment' | 'lifecycle'>(key: K): StackProfile[K] => {
    const values = layers.map((p) => p[key]).filter((v) => v !== undefined);
    if (values.length > 1) refuse('Конфликт частей профиля: ' + key);
    return values[0];
  };
  const environment = single('environment');
  const lifecycle = single('lifecycle');
  const toolchain = mergeToolchains(layers);
  for (const steps of lifecycle ? [lifecycle.setup, lifecycle.ready, lifecycle.teardown] : [])
    if (new Set(steps.map((s) => s.id)).size !== steps.length) refuse('Повтор lifecycle step ID');
  const limits = layers.flatMap((p) => (p.concurrency ? [p.concurrency] : []));
  const timeouts = layers.flatMap((p) => (p.runTimeoutMs ? [p.runTimeoutMs] : []));
  return {
    id: leaf.id,
    version: leaf.version,
    // Один встроенный файл — digest его байтов: так закреплены прежние
    // потребители; составной или локальный — digest замыкания слоёв.
    digest:
      closure.length === 1 && !source ? sha256(leafContent) : sha256(JSON.stringify(closure)),
    capabilities: [...new Set(layers.flatMap((p) => p.capabilities))],
    gates,
    prepare,
    ...(environment ? { environment } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(toolchain ? { toolchain } : {}),
    protectedPaths: [...new Set([...layers.flatMap((p) => p.protectedPaths), ...files])],
    generatedPaths: [...new Set(layers.flatMap((p) => p.generatedPaths))],
    ...(limits.length ? { concurrency: Math.min(...limits) } : {}),
    ...(timeouts.length ? { runTimeoutMs: Math.max(...timeouts) } : {}),
    roles: Object.assign({}, ...layers.map((p) => p.roles)) as StackProfile['roles'],
    contextPacks: [
      ...new Map(layers.flatMap((p) => p.contextPacks).map((pack) => [pack.id, pack])).values(),
    ],
    ...(source ? { source } : {}),
    closure,
    ...(options.includeLeafContent ? { leafContent } : {}),
  };
}

/**
 * Требования toolchain слоёв: инструменты и выбор менеджера пакетов
 * объединяются, но одно имя с разными значениями — конфликт композиции, а не
 * молчаливая победа последнего слоя.
 */
function mergeToolchains(layers: StackProfile[]): StackProfile['toolchain'] {
  const present = layers.flatMap((p) => (p.toolchain ? [p.toolchain] : []));
  if (!present.length) return undefined;
  const merged = {
    tools: {} as Record<string, string>,
    packageManagers: {} as Record<string, 'npm' | 'pnpm'>,
  };
  for (const t of present) {
    for (const [tool, version] of Object.entries(t.tools)) {
      if (merged.tools[tool] !== undefined && merged.tools[tool] !== version)
        refuse(
          `Конфликт частей профиля: toolchain.tools.${tool} (${merged.tools[tool]} и ${version})`,
        );
      merged.tools[tool] = version;
    }
    for (const [dir, manager] of Object.entries(t.packageManagers)) {
      if (merged.packageManagers[dir] !== undefined && merged.packageManagers[dir] !== manager)
        refuse(
          `Конфликт частей профиля: toolchain.packageManagers.${dir} (${merged.packageManagers[dir]} и ${manager})`,
        );
      merged.packageManagers[dir] = manager;
    }
  }
  return merged;
}

export const profilePin = (p: ResolvedProfile): ProfilePin => ({
  id: p.id,
  version: p.version,
  digest: p.digest,
  ...(p.source ? { source: p.source } : {}),
});

/** Поля репозитория, которые даёт профиль. */
const profiledKeys = [
  'gates',
  'prepare',
  'environment',
  'lifecycle',
  'protectedPaths',
  'generatedPaths',
  'toolchain',
] as const;
type RepositoryInput = z.input<typeof repositoryPolicySchema>;

/**
 * Описание репозитория политики из профиля. Явные значения `own` сильнее
 * профиля и ничего не дополняют молча: `shadowed` называет поля, которые
 * профиль задаёт иначе, а `own` переопределяет, — иначе обновлённый профиль с
 * новым gate «применялся бы», не доходя до политики.
 */
export function repositoryFromProfile(
  profile: ResolvedProfile,
  own: Pick<RepositoryInput, 'id' | 'path' | 'targetRef'> & Partial<RepositoryInput>,
) {
  const offered = (key: (typeof profiledKeys)[number]) => {
    const value = profile[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined;
  };
  const fromProfile = repositoryPolicySchema.parse({
    gates: profile.gates,
    prepare: profile.prepare,
    ...(profile.environment ? { environment: profile.environment } : {}),
    ...(profile.lifecycle ? { lifecycle: profile.lifecycle } : {}),
    ...(profile.toolchain ? { toolchain: profile.toolchain } : {}),
    // Защищённые пути профиля дополняют умолчание политики, а не заменяют его.
    protectedPaths: [
      ...new Set([
        ...repositoryPolicySchema.shape.protectedPaths.parse(undefined),
        ...profile.protectedPaths,
      ]),
    ],
    generatedPaths: profile.generatedPaths,
    id: own.id,
    path: own.path,
    targetRef: own.targetRef,
  });
  const repository = repositoryPolicySchema.parse({ ...fromProfile, ...own });
  // Сравнение — разобранных значений: то же окружение, записанное короче, не переопределение.
  const shadowed = profiledKeys.filter(
    (key) =>
      own[key] !== undefined &&
      offered(key) &&
      JSON.stringify(repository[key]) !== JSON.stringify(fromProfile[key]),
  );
  return { repository, shadowed: [...shadowed] };
}

/** Роли профиля в форме политики: writer, область записи и правило ревью кода роли. */
export function profileRoles(profile: ResolvedProfile) {
  return Object.fromEntries(
    Object.entries(profile.roles).map(([id, role]) => {
      const { runtime, model, effort, toolProfile, writePaths, reviewer, requiresContract } = role;
      const binding = roleBindingSchema.parse({
        writer: {
          runtime,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(toolProfile ? { toolProfile } : {}),
        },
        ...(writePaths ? { writePaths } : {}),
        ...(reviewer ? { review: { reviewer } } : {}),
        ...(requiresContract !== undefined ? { requiresContract } : {}),
      });
      return [id, binding];
    }),
  );
}
