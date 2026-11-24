// «Что задействовано» (`resources` представления оператора): чистая проекция
// без node:* и zod — годится для браузерного бандла, как `operator-view.ts`.
// Вход уже прочитан с диска (`src/control/view-resources.ts`); здесь только
// раскладка, классификация окружений и простые слова на ru/en. Каждая
// свободная строка проходит `mask`, каждый список ограничен.

import { ruCount, ruForm, type RuForms } from '../contracts/plural.ts';
import { RESOURCES_LIMITS } from '../contracts/operator-view-limits.ts';

/** Пределы — `RESOURCES_LIMITS` листа договоров (без zod): одни числа с договором. */
export const RESOURCES_VIEW_LIMITS = RESOURCES_LIMITS;
const L = RESOURCES_VIEW_LIMITS;
const T = L.text;

export type ResourcesNetwork = 'closed' | 'loopback' | 'domains' | 'open' | 'mixed';
type ReviewKind = 'plan' | 'contract' | 'code';

/** Всё, что нужно проекции; строки сырые — проекция маскирует их сама. */
export interface ResourcesInput {
  mode: 'live' | 'fixture';
  /** `policy.isolation.mode`. */
  sandbox: 'os' | 'none';
  /** Число `policy.isolation.domains`. */
  domains: number;
  roles: {
    role: string;
    kind: 'writer' | 'reviewer';
    review?: ReviewKind;
    alternate?: boolean;
    /** Проверяющий кода одной роли (`roles.<role>.review`). */
    reviewsRole?: string;
    runtime: string;
    /** `vendorOf(runtime)`: openai, anthropic, fixture, external. */
    vendor: string;
    model?: string;
    effort?: string;
    repositoryId?: string;
    /** Сеть исполнителя (`profileNetwork`); нет — прежняя граница claude (домены и локальные порты). */
    network?: 'none' | 'loopback' | 'full';
  }[];
  /** Ведущий из манифеста проекта (`lead`); нет — не известен. */
  lead?: { runtime: string; vendor: string };
  toolchain: {
    /** `policy.toolchain.node`: версия либо абсолютный каталог. */
    node?: string;
    tools: { name: string; version: string; repositoryId: string }[];
    packageManagers: { repositoryId: string; dir: string; manager: string }[];
  };
  dependencyStores: {
    repositoryId: string;
    /** Нет — у репозитория хранилища нет. */
    manager?: string;
    seeds?: number;
  }[];
  /** Lifecycle политики: репозиторий (или `@workspace`) и его шаги setup. */
  lifecycles: {
    repositoryId: string;
    scope: 'attempt' | 'workspace';
    setup: string[];
    docker: boolean;
  }[];
  /** Сохранённые записи окружений (`environment.json`). */
  environments: {
    repositoryId: string;
    scope: 'attempt' | 'workspace';
    /** `active`, `cleaned`, `cleanup-failed` (прочее — как `active`). */
    status: string;
    /** Жив ли процесс-владелец; нет — не известно. */
    ownerAlive?: boolean;
    /** Попытка уже закончена по записям хранилища; нет — не известно. */
    attemptFinished?: boolean;
    runId?: string;
    startedAt?: string;
    setup: string[];
    docker: boolean;
    /** Службы compose (`bridge/compose.json`), если записаны. */
    services: { name: string; image?: string }[];
  }[];
  /** Записи окружений, не прочитанные пределом обхода. */
  environmentsTruncated?: number;
  gates: { repositoryId: string; count: number }[];
  workspaceGates: number;
  /** Удержанные gates (`Engine.environmentGateHolds`); нет — удержаний нет. */
  heldGates?: {
    repositoryId: string;
    gate: string;
    workId: string;
    /** Ревизия 9: причина удержания (`gate-definition` — gate не назвал причину). */
    cause?: 'sandbox-process-list' | 'sandbox-signal' | 'sandbox-browser' | 'gate-definition';
  }[];
}

export interface ResourcesRoleView {
  role: string;
  kind: 'writer' | 'reviewer' | 'lead';
  review?: ReviewKind;
  alternate?: true;
  runtime: string;
  vendor: string;
  model?: string;
  effort?: string;
  repositoryId?: string;
  network?: ResourcesNetwork;
  line: string;
}
export interface ResourcesServiceView {
  repositoryId: string;
  name: string;
  engine?: 'docker';
  scope: 'attempt' | 'workspace';
  running: number;
  stopped: number;
  leftover: number;
  since?: string;
  leftoverRuns?: string[];
  line: string;
}
export interface ResourcesView {
  roles: ResourcesRoleView[];
  isolation: {
    sandbox: 'os' | 'none';
    writers: ResourcesNetwork;
    gates: ResourcesNetwork;
    domains: number;
    line: string;
  };
  toolchain: { tools: { name: string; version: string; repositoryId?: string }[]; line: string };
  dependencyStore: {
    state: 'on' | 'off' | 'partial';
    repositories: { repositoryId: string; manager: string; seeds?: number }[];
    line: string;
  };
  services: ResourcesServiceView[];
  gates: {
    total: number;
    workspace: number;
    repositories: { repositoryId: string; count: number }[];
    line: string;
    held?: { repositoryId: string; gate: string; workId: string }[];
    heldLine?: string;
  };
  lines: string[];
  truncated?: { roles?: number; tools?: number; services?: number; receipts?: number };
}

export interface ResourcesOptions {
  lang: 'ru' | 'en';
  mask: (s: string, max: number) => string;
  now: number;
}

const WORKSPACE = '@workspace';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const VENDORS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  fixture: 'fixture',
  external: 'external',
};
const RUNTIMES: Record<string, string> = { codex: 'Codex', claude: 'Claude', fixture: 'fixture' };

/** Известные образы служб: имя для человека. */
const IMAGES: Record<string, string> = {
  postgres: 'PostgreSQL',
  postgis: 'PostGIS',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  mongo: 'MongoDB',
  redis: 'Redis',
  valkey: 'Valkey',
  rabbitmq: 'RabbitMQ',
  elasticsearch: 'Elasticsearch',
  opensearch: 'OpenSearch',
  minio: 'MinIO',
  memcached: 'Memcached',
  nginx: 'nginx',
  mailhog: 'MailHog',
  mailpit: 'Mailpit',
  localstack: 'LocalStack',
  kafka: 'Kafka',
  clickhouse: 'ClickHouse',
};

/** `postgres:16-alpine` → «PostgreSQL 16»; неизвестный образ — последний сегмент имени и тег. */
export function imageLabel(image: string): string {
  const at = image.indexOf('@');
  const ref = at >= 0 ? image.slice(0, at) : image;
  const colon = ref.lastIndexOf(':');
  const slash = ref.lastIndexOf('/');
  const repo = colon > slash ? ref.slice(0, colon) : ref;
  const tag = colon > slash ? ref.slice(colon + 1) : '';
  const base = repo.slice(repo.lastIndexOf('/') + 1);
  const known = IMAGES[base.toLowerCase()];
  const version = /^\d+(?:\.\d+)*/.exec(tag)?.[0];
  if (known) return version ? `${known} ${version}` : known;
  return tag && tag !== 'latest' ? `${base} ${tag}` : base;
}

export function resourcesOf(input: ResourcesInput, opts: ResourcesOptions): ResourcesView {
  const ru = opts.lang === 'ru';
  // Маска с обрезкой может дописать «…» за пределом: предел договора держится здесь.
  const m = (s: string, max: number) => {
    const out = opts.mask(s, max).trim();
    return out.length > max ? out.slice(0, max - 1) + '…' : out;
  };
  const mid = (s: string) => m(s, T.id) || '?';
  const clipLine = (s: string) => m(s, T.line) || '—';
  const truncated: NonNullable<ResourcesView['truncated']> = {};
  const vendorName = (v: string) => VENDORS[v] ?? v;
  const runtimeName = (r: string) => RUNTIMES[r] ?? r;
  const who = (runtime: string, vendor: string, model?: string) => {
    if (runtime === 'fixture')
      return ru ? 'тестовые ответы (fixture)' : 'scripted answers (fixture)';
    const base = `${runtimeName(runtime)} (${vendorName(vendor)})`;
    if (model) return `${base}, ${ru ? 'модель' : 'model'} ${model}`;
    return `${base}, ${ru ? 'модель по умолчанию' : 'default model'}`;
  };

  // --- Сеть ---
  const writerNetwork = (r: ResourcesInput['roles'][number]): ResourcesNetwork | undefined => {
    if (r.runtime === 'fixture') return undefined;
    if (input.sandbox === 'none') return 'open';
    if (r.network === 'none') return 'closed';
    if (r.network === 'loopback') return 'loopback';
    if (r.network === 'full') return 'open';
    return input.domains > 0 ? 'domains' : 'loopback';
  };
  const netText = (n: ResourcesNetwork) =>
    ({
      closed: ru ? 'сеть закрыта' : 'network closed',
      loopback: ru
        ? 'только локальные адреса (127.0.0.1), без интернета'
        : 'local addresses only (127.0.0.1), no internet',
      domains: ru
        ? `только разрешённые адреса (${input.domains}) и локальные`
        : `only allowed addresses (${input.domains}) and local ones`,
      open: ru ? 'сеть открыта' : 'network open',
      mixed: ru ? 'у ролей по-разному' : 'differs by role',
    })[n];

  // --- Роли ---
  const reviewText = (k: ReviewKind) =>
    ru
      ? { plan: 'план', contract: 'контракт', code: 'код' }[k]
      : { plan: 'plans', contract: 'contracts', code: 'code' }[k];
  const allRoles: ResourcesRoleView[] = [];
  for (const r of input.roles) {
    const runtime = mid(r.runtime);
    const vendor = mid(vendorName(r.vendor));
    const model = r.model ? m(r.model, T.model) || undefined : undefined;
    const repositoryId = r.repositoryId ? mid(r.repositoryId) : undefined;
    const role = mid(r.role);
    const inRepo = repositoryId ? (ru ? ` в ${repositoryId}` : ` in ${repositoryId}`) : '';
    const network = r.kind === 'writer' ? writerNetwork(r) : undefined;
    let head: string;
    if (r.kind === 'writer')
      head = ru ? `Пишет код — роль ${role}${inRepo}` : `Writes code — role ${role}${inRepo}`;
    else {
      const k = r.review ?? 'code';
      const of = r.reviewsRole ? mid(r.reviewsRole) : undefined;
      const acc = of ? (ru ? `код роли ${of}` : `code of role ${of}`) : reviewText(k);
      const gen = of
        ? `кода роли ${of}`
        : { plan: 'плана', contract: 'контракта', code: 'кода' }[k];
      head = ru
        ? r.alternate
          ? `Запасной проверяющий ${gen}${inRepo}`
          : `Проверяет ${acc}${inRepo}`
        : `${r.alternate ? 'Backup reviewer of' : 'Reviews'} ${acc}${inRepo}`;
    }
    const tail = network
      ? ru
        ? `; сеть: ${netText(network)}`
        : `; network: ${netText(network)}`
      : '';
    allRoles.push({
      role,
      kind: r.kind,
      ...(r.kind === 'reviewer' ? { review: r.review ?? 'code' } : {}),
      ...(r.alternate ? { alternate: true as const } : {}),
      runtime,
      vendor,
      ...(model ? { model } : {}),
      ...(r.effort ? { effort: mid(r.effort) } : {}),
      ...(repositoryId ? { repositoryId } : {}),
      ...(network ? { network } : {}),
      line: clipLine(`${head}: ${who(r.runtime, r.vendor, model)}${tail}`),
    });
  }
  if (input.lead) {
    const runtime = mid(input.lead.runtime);
    allRoles.unshift({
      role: 'lead',
      kind: 'lead',
      runtime,
      vendor: mid(vendorName(input.lead.vendor)),
      line: clipLine(
        `${ru ? 'Ведёт проект' : 'Leads the project'}: ${runtimeName(runtime)} (${vendorName(input.lead.vendor)})`,
      ),
    });
  }
  const roles = allRoles.slice(0, L.roles);
  if (allRoles.length > roles.length) truncated.roles = allRoles.length - roles.length;

  // --- Изоляция ---
  const nets = [...new Set(allRoles.flatMap((r) => (r.network ? [r.network] : [])))];
  const writers: ResourcesNetwork =
    input.sandbox === 'none'
      ? 'open'
      : nets.length === 1
        ? nets[0]!
        : nets.length === 0
          ? 'closed'
          : 'mixed';
  const gatesNet: ResourcesNetwork =
    input.sandbox === 'none' ? 'open' : input.domains > 0 ? 'domains' : 'loopback';
  const isolationLine =
    input.sandbox === 'none'
      ? ru
        ? 'Песочница выключена: исполнители и проверки работают без ограничений системы, сеть открыта'
        : 'Sandbox is off: writers and checks run without OS limits, network open'
      : writers === gatesNet
        ? ru
          ? `Песочница системы: у исполнителей и проверок ${netText(writers)}`
          : `OS sandbox: writers and checks — ${netText(writers)}`
        : ru
          ? `Песочница системы: исполнители — ${netText(writers)}; проверки — ${netText(gatesNet)}`
          : `OS sandbox: writers — ${netText(writers)}; checks — ${netText(gatesNet)}`;
  const isolation = {
    sandbox: input.sandbox,
    writers,
    gates: gatesNet,
    domains: Math.max(0, Math.trunc(input.domains)),
    line: clipLine(isolationLine),
  };

  // --- Инструменты ---
  const allTools: ResourcesView['toolchain']['tools'] = [];
  if (input.toolchain.node)
    allTools.push({ name: 'node', version: m(input.toolchain.node, T.version) || '?' });
  for (const t of input.toolchain.tools)
    allTools.push({
      name: m(t.name, T.name) || '?',
      version: m(t.version, T.version) || '?',
      repositoryId: mid(t.repositoryId),
    });
  const tools = allTools.slice(0, L.tools);
  if (allTools.length > tools.length) truncated.tools = allTools.length - tools.length;
  const pms = input.toolchain.packageManagers.map((p) => mid(p.manager));
  const toolText = (t: (typeof tools)[number]) =>
    `${t.name === 'node' ? 'Node' : t.name} ${t.version.startsWith('>=') ? (ru ? 'не ниже ' : 'at least ') + t.version.slice(2) : t.version}`;
  let toolLine: string;
  if (!tools.length && !pms.length)
    toolLine = ru
      ? 'Версии инструментов не закреплены: используется то, что установлено на машине'
      : 'Tool versions are not pinned: whatever is installed on the machine is used';
  else {
    const parts: string[] = [];
    const global = tools.filter((t) => !t.repositoryId);
    if (global.length)
      parts.push(
        `${global.map(toolText).join(', ')} ${ru ? 'для всех процессов' : 'for every process'}`,
      );
    const repos = [...new Set(tools.flatMap((t) => (t.repositoryId ? [t.repositoryId] : [])))];
    for (const repo of repos)
      parts.push(
        `${repo}: ${tools
          .filter((t) => t.repositoryId === repo)
          .map(toolText)
          .join(', ')}`,
      );
    if (pms.length)
      parts.push(`${ru ? 'менеджер пакетов' : 'package manager'} ${[...new Set(pms)].join(', ')}`);
    toolLine = `${ru ? 'Закреплено' : 'Pinned'}: ${parts.join('; ')}`;
  }
  const toolchain = { tools, line: clipLine(toolLine) };

  // --- Хранилище зависимостей ---
  const stores = input.dependencyStores
    .filter((s) => s.manager)
    .slice(0, L.repositories)
    .map((s) => ({
      repositoryId: mid(s.repositoryId),
      manager: mid(s.manager!),
      ...(s.seeds !== undefined && s.seeds >= 0 ? { seeds: Math.trunc(s.seeds) } : {}),
    }));
  const without = input.dependencyStores.filter((s) => !s.manager).map((s) => mid(s.repositoryId));
  const storeState: 'on' | 'off' | 'partial' = !stores.length
    ? 'off'
    : without.length
      ? 'partial'
      : 'on';
  const seeds = stores.reduce((n, s) => n + (s.seeds ?? 0), 0);
  const seedsKnown = stores.some((s) => s.seeds !== undefined);
  const seedText = seedsKnown
    ? ru
      ? `; готовых наборов: ${seeds}`
      : `; ready sets: ${seeds}`
    : '';
  const managers = [...new Set(stores.map((s) => s.manager))].join(', ');
  const storeLine =
    storeState === 'off'
      ? ru
        ? 'Хранилище зависимостей выключено: каждая попытка ставит пакеты сама'
        : 'Dependency store is off: every attempt installs packages itself'
      : storeState === 'on'
        ? ru
          ? `Хранилище зависимостей включено (${managers}): пакеты ставятся один раз по lockfile и копируются в каждую попытку${seedText}`
          : `Dependency store is on (${managers}): packages are installed once per lockfile and copied into every attempt${seedText}`
        : ru
          ? `Хранилище зависимостей включено для ${stores.map((s) => s.repositoryId).join(', ')} (${managers}), выключено для ${without.join(', ')}${seedText}`
          : `Dependency store is on for ${stores.map((s) => s.repositoryId).join(', ')} (${managers}), off for ${without.join(', ')}${seedText}`;
  const dependencyStore = { state: storeState, repositories: stores, line: clipLine(storeLine) };

  // --- Службы lifecycle ---
  type Acc = {
    repositoryId: string;
    name: string;
    engine?: 'docker';
    scope: 'attempt' | 'workspace';
    running: number;
    stopped: number;
    leftover: number;
    since?: string;
    leftoverRuns: string[];
  };
  const acc = new Map<string, Acc>();
  const stepsName = (setup: string[]) =>
    setup.length
      ? (ru ? 'окружение (шаги ' : 'environment (steps ') +
        setup.slice(0, 3).join(', ') +
        (setup.length > 3 ? ', …' : '') +
        ')'
      : ru
        ? 'окружение'
        : 'environment';
  const keyOf = (repo: string, scope: string, name: string) => `${repo}\u0000${scope}\u0000${name}`;
  const entry = (repo: string, scope: Acc['scope'], name: string, docker: boolean) => {
    const k = keyOf(repo, scope, name);
    let a = acc.get(k);
    if (!a) {
      a = {
        repositoryId: repo,
        name,
        ...(docker ? { engine: 'docker' as const } : {}),
        scope,
        running: 0,
        stopped: 0,
        leftover: 0,
        leftoverRuns: [],
      };
      acc.set(k, a);
    }
    return a;
  };
  const seen = new Set<string>();
  for (const e of input.environments) {
    const repo = mid(e.repositoryId);
    seen.add(`${repo}\u0000${e.scope}`);
    const state = environmentState(e);
    const names = e.services.length
      ? e.services.slice(0, 10).map((s) => m(s.image ? imageLabel(s.image) : s.name, T.name) || '?')
      : [m(stepsName(e.setup), T.name) || '?'];
    for (const name of new Set(names)) {
      const a = entry(repo, e.scope, name, e.docker || e.services.length > 0);
      a[state]++;
      if (state === 'running' && e.startedAt && ISO.test(e.startedAt))
        if (!a.since || e.startedAt < a.since) a.since = e.startedAt;
      if (state === 'leftover' && e.runId && a.leftoverRuns.length < L.leftoverRuns) {
        const run = mid(e.runId);
        if (!a.leftoverRuns.includes(run)) a.leftoverRuns.push(run);
      }
    }
  }
  // Lifecycle политики без единой записи: служба есть, но ещё не запускалась.
  for (const l of input.lifecycles) {
    const repo = mid(l.repositoryId);
    if (seen.has(`${repo}\u0000${l.scope}`)) continue;
    entry(repo, l.scope, m(stepsName(l.setup), T.name) || '?', l.docker);
  }
  const minutes = (since: string) => {
    const ms = opts.now - Date.parse(since);
    if (!Number.isFinite(ms) || ms < 0) return undefined;
    const min = Math.floor(ms / 60000);
    if (min < 60) return ru ? `${min} мин` : `${min} min`;
    const h = Math.floor(min / 60);
    return ru ? `${h} ч ${min % 60} мин` : `${h} h ${min % 60} min`;
  };
  const serviceLine = (a: Acc) => {
    const unit =
      a.engine === 'docker'
        ? a.scope === 'workspace'
          ? ru
            ? 'контейнер на каждую совместную проверку'
            : 'a container per joint check'
          : ru
            ? 'контейнер на каждую попытку'
            : 'a container per attempt'
        : a.scope === 'workspace'
          ? ru
            ? 'на каждую совместную проверку'
            : 'per joint check'
          : ru
            ? 'на каждую попытку'
            : 'per attempt';
    const where =
      a.repositoryId === WORKSPACE ? (ru ? 'совместная проверка' : 'joint check') : a.repositoryId;
    const head = `${a.engine === 'docker' ? 'Docker: ' : ''}${a.name}, ${unit} (${where})`;
    const parts: string[] = [];
    if (a.running) {
      const d = a.since ? minutes(a.since) : undefined;
      parts.push(
        ru
          ? `сейчас ${ruForm(a.running, ['работает', 'работают', 'работают'] as RuForms)} ${a.running}${d ? ` (${d})` : ''}`
          : `running now: ${a.running}${d ? ` (${d})` : ''}`,
      );
    } else parts.push(ru ? 'сейчас не запущено' : 'not running now');
    if (a.stopped) parts.push(ru ? `остановлено: ${a.stopped}` : `stopped: ${a.stopped}`);
    if (a.leftover)
      parts.push(
        ru
          ? `осталось после попыток: ${a.leftover} — убрать: harness cleanup --run <id>`
          : `left after attempts: ${a.leftover} — clean up: harness cleanup --run <id>`,
      );
    if (!a.running && !a.stopped && !a.leftover)
      parts[0] = ru ? 'ещё не запускалось' : 'not started yet';
    return clipLine(`${head} — ${parts.join(' · ')}`);
  };
  const allServices = [...acc.values()];
  const services: ResourcesServiceView[] = allServices.slice(0, L.services).map((a) => ({
    repositoryId: a.repositoryId,
    name: a.name,
    ...(a.engine ? { engine: a.engine } : {}),
    scope: a.scope,
    running: a.running,
    stopped: a.stopped,
    leftover: a.leftover,
    ...(a.since ? { since: a.since } : {}),
    ...(a.leftoverRuns.length ? { leftoverRuns: a.leftoverRuns } : {}),
    line: serviceLine(a),
  }));
  if (allServices.length > services.length)
    truncated.services = allServices.length - services.length;
  if (input.environmentsTruncated && input.environmentsTruncated > 0)
    truncated.receipts = Math.trunc(input.environmentsTruncated);

  // --- Проверки ---
  const gateRepos = input.gates.slice(0, L.repositories).map((g) => ({
    repositoryId: mid(g.repositoryId),
    count: Math.max(0, Math.trunc(g.count)),
  }));
  const workspace = Math.max(0, Math.trunc(input.workspaceGates));
  const total = input.gates.reduce((n, g) => n + Math.max(0, Math.trunc(g.count)), 0) + workspace;
  const gateParts = gateRepos.map((g) => `${g.repositoryId} ${g.count}`);
  if (workspace) gateParts.push(`${ru ? 'совместных' : 'joint'} ${workspace}`);
  const gatesLine = ru
    ? `${ruCount(total, ['проверка', 'проверки', 'проверок'])} (gates)${gateParts.length > 1 || workspace ? ': ' + gateParts.join(', ') : ''}`
    : `${total} ${total === 1 ? 'check' : 'checks'} (gates)${gateParts.length > 1 || workspace ? ': ' + gateParts.join(', ') : ''}`;
  const held = (input.heldGates ?? []).slice(0, L.repositories).map((h) => ({
    repositoryId: mid(h.repositoryId),
    gate: mid(h.gate),
    workId: mid(h.workId),
    ...(h.cause ? { cause: h.cause } : {}),
  }));
  // Причина удержания простыми словами: у всех одна — она, иначе общая.
  const causes = new Set(held.map((h) => h.cause ?? 'sandbox-process-list'));
  const only = causes.size === 1 ? [...causes][0] : undefined;
  const why = ru
    ? only === 'gate-definition'
      ? 'gate упал, не назвав причины (ни упавших тестов, ни строки ошибки)'
      : only === 'sandbox-process-list'
        ? 'gate зовёт ps, а в песочнице проверок списка процессов нет'
        : only === 'sandbox-signal'
          ? 'gate шлёт сигнал процессу вне песочницы проверок'
          : only === 'sandbox-browser'
            ? 'gate запускает браузер, а в песочнице проверок он не стартует'
            : 'отказ без повтора, который правкой кода задачи не снять'
    : only === 'gate-definition'
      ? 'the gate failed without naming a cause (no failed tests, no error line)'
      : only === 'sandbox-process-list'
        ? 'the gate runs ps, and the check sandbox has no process list'
        : only === 'sandbox-signal'
          ? 'the gate signals a process outside the check sandbox'
          : only === 'sandbox-browser'
            ? 'the gate launches a browser, which does not start in the check sandbox'
            : 'a no-retry failure that task code changes cannot fix';
  const heldLine = held.length
    ? clipLine(
        ru
          ? `Удержано: ${held.map((h) => `${h.repositoryId}/${h.gate} (работа ${h.workId})`).join(', ')} — ${why}; ход ведущего: поменять gate или исправить тест и повторить работу (retry --by lead)`
          : `Held: ${held.map((h) => `${h.repositoryId}/${h.gate} (work ${h.workId})`).join(', ')} — ${why}; the lead changes the gate, or fixes the test and retries the work (retry --by lead)`,
      )
    : undefined;
  const gates = {
    total,
    workspace,
    repositories: gateRepos,
    line: clipLine(gatesLine),
    ...(held.length ? { held, heldLine } : {}),
  };

  // --- Сводка ---
  const lines: string[] = [];
  // Удержание gate — то, что держит выдачу сейчас: первой строкой сводки.
  if (gates.heldLine) lines.push(gates.heldLine);
  const group = (kind: ResourcesRoleView['kind']) => {
    const list = [
      ...new Set(
        allRoles
          .filter((r) => r.kind === kind && !r.alternate)
          .map((r) =>
            r.runtime === 'fixture'
              ? 'fixture'
              : `${runtimeName(r.runtime)} (${r.vendor}${r.model ? ', ' + r.model : ''})`,
          ),
      ),
    ];
    return list.length > 3
      ? list.slice(0, 3).join(', ') +
          (ru ? ` и ещё ${list.length - 3}` : ` and ${list.length - 3} more`)
      : list.join(', ');
  };
  const modelParts: string[] = [];
  const lead = group('lead');
  const wr = group('writer');
  const rv = group('reviewer');
  if (lead) modelParts.push(`${ru ? 'ведёт' : 'lead'} ${lead}`);
  if (wr) modelParts.push(`${ru ? 'пишет' : 'writes'} ${wr}`);
  if (rv) modelParts.push(`${ru ? 'проверяет' : 'reviews'} ${rv}`);
  if (modelParts.length)
    lines.push(clipLine(`${ru ? 'Модели' : 'Models'}: ${modelParts.join('; ')}`));
  lines.push(isolation.line, toolchain.line, dependencyStore.line);
  const shown = services.filter((s) => s.running || s.leftover || s.stopped);
  const forHome = (shown.length ? shown : services).slice(0, 2);
  for (const s of forHome) lines.push(s.line);
  if (services.length > forHome.length)
    lines.push(
      clipLine(
        ru
          ? `И ещё ${ruCount(services.length - forHome.length, ['служба', 'службы', 'служб'])} окружения`
          : `And ${services.length - forHome.length} more environment services`,
      ),
    );
  lines.push(gates.line);

  return {
    roles,
    isolation,
    toolchain,
    dependencyStore,
    services,
    gates,
    lines: lines.slice(0, L.lines),
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
}

/**
 * Состояние окружения по записи: `cleaned` — остановлено; `cleanup-failed` —
 * осталось; иначе (setup записан, teardown нет) — работает, пока жив
 * процесс-владелец и попытка не закончена, а после — осталось.
 */
export function environmentState(
  e: Pick<ResourcesInput['environments'][number], 'status' | 'ownerAlive' | 'attemptFinished'>,
): 'running' | 'stopped' | 'leftover' {
  if (e.status === 'cleaned') return 'stopped';
  if (e.status === 'cleanup-failed') return 'leftover';
  if (e.ownerAlive === false || e.attemptFinished === true) return 'leftover';
  return 'running';
}
