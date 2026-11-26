import { z } from 'zod';
import { idSchema, relativePathSchema } from './primitives.ts';

/**
 * Режим работы harness (0.1.0-alpha.69, решение владельца).
 *
 * - `light` — режим по умолчанию: исполнитель и gates работают на хосте как
 *   обычный разработчик — Docker, сеть, браузер, порты, список процессов и
 *   сигналы доступны, чтение не ограничено. Остаётся одна граница — запрет
 *   записи вне своего рабочего дерева попытки, временного каталога попытки и
 *   кешей инструментов (`writeGuard`). Изоляция попыток друг от друга — своё
 *   рабочее дерево, своё имя проекта compose и свои выделенные порты.
 * - `strict` — прежняя изоляция (песочница ОС с закрытым чтением, сетью по
 *   доменам, граница инфраструктуры). Явный выбор владельца для чужого кода
 *   или секретов production; заморожен: новых возможностей не получает.
 *
 * Политика без поля — `light`. Поле не входит ни в `executionDigest`, ни в
 * `isolationDigest`: смена режима не делает согласования графов устаревшими.
 */
export const harnessModeSchema = z.enum(['light', 'strict']);
export type HarnessMode = z.infer<typeof harnessModeSchema>;
export const DEFAULT_HARNESS_MODE: HarnessMode = 'light';

/** Путь границы записи: абсолютный или от домашнего каталога (`~/…`). */
export const guardPathSchema = z
  .string()
  .min(2)
  .max(500)
  .regex(/^(\/|~\/)/, 'Путь границы записи — абсолютный или ~/…')
  .refine((p) => !p.split('/').includes('..'), 'Путь границы записи без ..')
  .refine((p) => p !== '/' && p !== '~/', 'Корень и весь домашний каталог открыть нельзя');

/**
 * Граница записи облегчённого режима. Запись разрешена в рабочее дерево
 * попытки, её временный каталог и кеши инструментов. Кеши по умолчанию —
 * `DEFAULT_WRITE_GUARD_CACHES`; `add` дополняет их, `replace` заменяет
 * целиком (тогда умолчаний нет), `off: true` снимает границу (решение
 * владельца, doctor говорит об этом). Нет поля — умолчания.
 */
export const writeGuardSchema = z.strictObject({
  off: z.literal(true).optional(),
  add: z.array(guardPathSchema).max(64).optional(),
  replace: z.array(guardPathSchema).max(64).optional(),
});
export type WriteGuardPolicy = z.infer<typeof writeGuardSchema>;

/**
 * Кеши инструментов, открытые на запись по умолчанию: менеджеры пакетов,
 * браузеры, сборка, Docker CLI, мобильные инструменты (Maestro, симуляторы
 * iOS, эмуляторы Android). Пути вида `~/…` раскрываются от HOME; `$DARWIN_*`
 * — каталоги пользователя macOS (`getconf`), на других системах пропускаются.
 */
export const DEFAULT_WRITE_GUARD_CACHES: readonly { id: string; path: string; why: string }[] = [
  // Каталоги кешей и то, что инструменты обязаны писать. Исполняемые
  // каталоги (npx, глобальные пакеты) закрыты; дистрибутивы gradle-wrapper,
  // corepack и `.tools` pnpm открыты, потому что без них сборка не идёт —
  // это осознанная цена: их подмена исполнится потом вне попытки
  // (docs/light-mode.md, «Граница записи»).
  { id: 'npm-cache', path: '~/.npm/_cacache', why: 'кеш пакетов npm' },
  { id: 'npm-logs', path: '~/.npm/_logs', why: 'журналы npm' },
  { id: 'pnpm-store', path: '~/.pnpm-store', why: 'хранилище pnpm' },
  { id: 'pnpm-store-mac', path: '~/Library/pnpm/store', why: 'хранилище pnpm на macOS' },
  { id: 'pnpm-store-xdg', path: '~/.local/share/pnpm/store', why: 'хранилище pnpm на Linux' },
  { id: 'pnpm-cache-mac', path: '~/Library/Caches/pnpm', why: 'кеш метаданных pnpm на macOS' },
  { id: 'pnpm-cache-xdg', path: '~/.cache/pnpm', why: 'кеш метаданных pnpm на Linux' },
  { id: 'pnpm-tools-mac', path: '~/Library/pnpm/.tools', why: 'версии pnpm (packageManager)' },
  { id: 'pnpm-tools-xdg', path: '~/.local/share/pnpm/.tools', why: 'версии pnpm на Linux' },
  { id: 'corepack-mac', path: '~/Library/Caches/node/corepack', why: 'кеш corepack' },
  { id: 'corepack-xdg', path: '~/.cache/node/corepack', why: 'кеш corepack на Linux' },
  { id: 'yarn-cache', path: '~/.yarn/berry/cache', why: 'кеш yarn berry' },
  { id: 'yarn-cache-mac', path: '~/Library/Caches/Yarn', why: 'кеш yarn на macOS' },
  { id: 'bun', path: '~/.bun/install/cache', why: 'кеш bun' },
  { id: 'playwright-mac', path: '~/Library/Caches/ms-playwright', why: 'браузеры Playwright' },
  { id: 'playwright-xdg', path: '~/.cache/ms-playwright', why: 'браузеры Playwright на Linux' },
  { id: 'turbo-mac', path: '~/Library/Caches/turbo', why: 'кеш turbo' },
  { id: 'turbo-xdg', path: '~/.cache/turbo', why: 'кеш turbo на Linux' },
  { id: 'node-gyp-mac', path: '~/Library/Caches/node-gyp', why: 'заголовки node-gyp' },
  { id: 'node-gyp-xdg', path: '~/.cache/node-gyp', why: 'заголовки node-gyp на Linux' },
  { id: 'prisma', path: '~/.cache/prisma', why: 'движки Prisma' },
  { id: 'docker-buildx', path: '~/.docker/buildx', why: 'состояние buildx у docker compose build' },
  {
    id: 'core-simulator',
    path: '~/Library/Developer/CoreSimulator',
    why: 'устройства симулятора iOS',
  },
  { id: 'simulator-logs', path: '~/Library/Logs/CoreSimulator', why: 'журналы симулятора iOS' },
  {
    id: 'xcode-derived',
    path: '~/Library/Developer/Xcode/DerivedData',
    why: 'сборка приложения iOS',
  },
  { id: 'android-avd', path: '~/.android/avd', why: 'AVD эмулятора Android' },
  { id: 'android-cache', path: '~/.android/cache', why: 'кеш инструментов Android' },
  { id: 'gradle-caches', path: '~/.gradle/caches', why: 'кеш Gradle (сборка Android)' },
  { id: 'gradle-daemon', path: '~/.gradle/daemon', why: 'демон Gradle' },
  { id: 'gradle-native', path: '~/.gradle/native', why: 'нативные библиотеки Gradle' },
  { id: 'gradle-tmp', path: '~/.gradle/.tmp', why: 'временные файлы Gradle' },
  { id: 'gradle-wrapper', path: '~/.gradle/wrapper/dists', why: 'дистрибутивы gradle-wrapper' },
  // Maestro вне мобильного UI gate (у UI gate — свой домашний каталог Java):
  // журналы и состояние, без `deps/` (распакованные исполняемые файлы —
  // готовятся при настройке) и без исполняемого CLI.
  { id: 'maestro-tests', path: '~/.maestro/tests', why: 'журналы прогонов Maestro' },
  { id: 'maestro-sessions', path: '~/.maestro/sessions', why: 'сессии Maestro' },
  { id: 'maestro-analytics', path: '~/.maestro/analytics.json', why: 'состояние Maestro' },
  {
    id: 'maestro-promotion',
    path: '~/.maestro/promotion-state.json',
    why: 'состояние Maestro',
  },
  {
    id: 'maestro-notification',
    path: '~/.maestro/analyze-notification.json',
    why: 'состояние Maestro',
  },
  {
    id: 'darwin-user-cache',
    path: '$DARWIN_USER_CACHE_DIR',
    why: 'системные кеши macOS (шрифты, Metal)',
  },
  {
    id: 'darwin-user-temp',
    path: '$DARWIN_USER_TEMP_DIR',
    why: 'временный каталог пользователя macOS: Chrome создаёт в нём сокет профиля',
  },
];

/**
 * Переменные, которые порт или шлюз попытки не перекрывают (alpha.69,
 * ревью): окружение процесса и загрузчика, имя проекта compose попытки.
 */
export const RESERVED_ATTEMPT_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'CI',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_FILE',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
] as const;
/** Имя переменной окружения порта попытки (не `HARNESS_*`/`DEVCONTOUR_*`, не зарезервированное). */
const portEnvName = z
  .string()
  .regex(
    /^(?!HARNESS_|DEVCONTOUR_|DYLD_)[A-Z_][A-Z0-9_]*$/,
    'Имя переменной порта — [A-Z_][A-Z0-9_]*, кроме HARNESS_*, DEVCONTOUR_* и DYLD_*',
  )
  .refine(
    (v) => !(RESERVED_ATTEMPT_ENV as readonly string[]).includes(v),
    'Переменную окружения процесса (PATH, HOME, TMPDIR, NODE_OPTIONS, COMPOSE_PROJECT_NAME…) порт или шлюз попытки не перекрывает',
  );

/**
 * Окружение попытки облегчённого режима: свои порты. Каждой попытке harness
 * выделяет свободный порт на каждое имя (проба занятости — та же, что у
 * ресурсов-портов, аренда — в базе ресурсов машины) и передаёт его
 * исполнителю и gates в переменной с этим именем. Имя проекта compose
 * (`COMPOSE_PROJECT_NAME`) и `HARNESS_ATTEMPT_ID` задаются всегда; тестовые
 * секреты (`secrets`) — случайные значения на попытку.
 */
export const attemptEnvSchema = z
  .strictObject({
    ports: z.array(portEnvName).max(20).optional(),
    /**
     * Тестовые секреты попытки (alpha.72, P9-1): имена переменных, которым
     * harness на каждую попытку даёт случайное значение, если окружение
     * политики его не задаёт (пароли базы, ключи подписи тестового стека).
     * Только для секретов тестового окружения: значение есть в окружении
     * шагов, gates и исполнителя и в файле окружения попытки, в журналах
     * маскируется; секрет production сюда не объявляется.
     */
    secrets: z.array(portEnvName).max(20).optional(),
    portRange: z
      .strictObject({
        from: z.number().int().min(1024).max(65535),
        to: z.number().int().min(1024).max(65535),
      })
      .refine((r) => r.from < r.to, 'portRange.from меньше to')
      .optional(),
  })
  .refine(
    (v) => !v.ports || new Set(v.ports).size === v.ports.length,
    'Имена портов попытки не повторяются',
  )
  .refine(
    (v) =>
      !v.secrets ||
      (new Set(v.secrets).size === v.secrets.length &&
        !v.secrets.some((s) => v.ports?.includes(s))),
    'Имена тестовых секретов попытки не повторяются и не совпадают с именами портов',
  );
export type AttemptEnvPolicy = z.infer<typeof attemptEnvSchema>;
export const DEFAULT_PORT_RANGE = { from: 20000, to: 29999 } as const;

/**
 * Шлюз gates (зеркало маршрутизации production): gates и исполнитель идут к
 * приложению через шлюз проекта (сервис Caddy/nginx в compose проекта), а не
 * прямо в порт API. `url` может ссылаться на порт попытки `${NAME}`; `env` —
 * переменные приложения, которые получают адрес шлюза с суффиксом пути
 * (`{"IMAGE_PUBLIC_BASE_URL": "/media"}` → `http://127.0.0.1:20031/media`).
 * Адрес шлюза — ещё и `HARNESS_GATEWAY_URL`. Поднимает шлюз lifecycle
 * проекта (`docker compose up gateway`), harness его не пишет.
 */
export const gatewaySchema = z.strictObject({
  url: z
    .string()
    .min(8)
    .max(300)
    .regex(/^https?:\/\//, 'Адрес шлюза — http(s)://…'),
  env: z.record(
    portEnvName,
    z
      .string()
      .max(300)
      .regex(/^(\/|$)/, 'Суффикс — путь от /'),
  ),
});
export type GatewayPolicy = z.infer<typeof gatewaySchema>;

/**
 * Приёмка выпуска (P7-6): перед `release done` независимый reviewer
 * проверяет принятую цель против договора выпуска — постановки, критериев
 * приёмки, ответов владельца и топологии развёртывания (`topology`: конфигурации
 * шлюза/прокси и файлы окружения production относительно корня репозитория).
 * `review`: `required` — без одобренного ревью выпуска на текущей цели
 * `release done` отказывает; `advisory` — только предупреждает. Нет поля —
 * `required` в обоих режимах (P7-6 прошёл и в строгом).
 */
export const releasePolicySchema = z.strictObject({
  review: z.enum(['required', 'advisory']).optional(),
  topology: z.array(relativePathSchema).max(50).optional(),
  /**
   * Шаг документации выпуска (0.1.0-alpha.70, docs/release-review.md):
   * работа с меткой `docs`, зависящая от всех корневых работ выпуска,
   * принята до приёмки выпуска. `required` — `review-release` отказывает
   * без неё; `advisory` (нет поля) — `status`, представление и
   * `review-release` называют, чего не хватает; `off` — шага нет.
   */
  docs: z.enum(['required', 'advisory', 'off']).optional(),
});
export type ReleasePolicy = z.infer<typeof releasePolicySchema>;

/**
 * UI gate (alpha.69, точка расширения): `browser` — Playwright, `mobile` —
 * Maestro на симуляторе iOS или эмуляторе Android. Команда gate остаётся его
 * `command` (например `pnpm exec playwright test` или `maestro test flows/`);
 * блок `ui` описывает, что harness готовит попытке: браузер и его профиль,
 * устройство, сборку и установку приложения, артефакты при провале.
 * В alpha.69 исполняется `browser` (окружение и артефакты); `mobile` —
 * договор: политика его проверяет, `doctor` называет, а исполнение — после
 * отчёта исследования (docs/ui-gates.md).
 */
const uiArtifacts = z.array(relativePathSchema).min(1).max(20).optional();
export const browserUiSchema = z.strictObject({
  type: z.literal('browser'),
  runner: z.literal('playwright').default('playwright'),
  /** Спеки относительно cwd gate; нет — конфигурация раннера. */
  specs: z.array(relativePathSchema).max(50).optional(),
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  headless: z.boolean().default(true),
  /** Каталоги отчётов и трасс, сохраняемые при провале (умолчание — test-results/, playwright-report/). */
  artifacts: uiArtifacts,
});
export const mobileUiSchema = z.strictObject({
  type: z.literal('mobile'),
  runner: z.literal('maestro').default('maestro'),
  platform: z.enum(['ios', 'android']),
  /** Потоки Maestro относительно cwd gate. */
  flows: z.array(relativePathSchema).min(1).max(50),
  /**
   * Устройство: ресурсы `kind: device` политики (пул; попытка берёт одно
   * свободное) или имя/версия ОС для создания своего устройства попытки.
   */
  device: z
    .strictObject({
      pool: z.array(idSchema).min(1).max(20).optional(),
      name: z.string().min(1).max(100).optional(),
      os: z.string().min(1).max(40).optional(),
      perAttempt: z.boolean().default(false),
      /** Локаль устройства попытки (`ru_RU`, `en_US`): селекторы потоков не зависят от языка системы. */
      locale: z
        .string()
        .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/)
        .optional(),
    })
    .refine((d) => d.pool || d.name, 'device: pool или name'),
  app: z.strictObject({
    /** Bundle ID (iOS) или package (Android). */
    id: z.string().min(1).max(200),
    build: z.array(z.string().min(1)).min(1).optional(),
    install: z.array(z.string().min(1)).min(1).optional(),
    buildTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
  }),
  artifacts: uiArtifacts,
  flowTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
  /** Предел старта драйвера Maestro под нагрузкой (`MAESTRO_DRIVER_STARTUP_TIMEOUT`). */
  driverStartupTimeoutMs: z.number().int().positive().max(600_000).optional(),
});
export const uiGateSchema = z.discriminatedUnion('type', [browserUiSchema, mobileUiSchema]);
export type UiGatePolicy = z.infer<typeof uiGateSchema>;
export const DEFAULT_BROWSER_ARTIFACTS = ['test-results', 'playwright-report'] as const;
