/**
 * H1-05: DevContour-подобный хост на установленном пакете. Каждая проверка
 * сравнивает ответ хоста с прежними строками и формами (примеры договора
 * OP-DIAG-01…04 и OP-SETUP-03 M-2). Отчёт — JSON на stdout; exit 1 при
 * любом расхождении.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as root from 'devcontour-harness';
import * as projections from 'devcontour-harness/projections';
import {
  PROFILE_CHANGED,
  chainBlockers,
  nextStep,
  queueStopReason,
  setupFiles,
  taskProgress,
} from './devcontour-mapping.mjs';

const checks = [];
const norm = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const check = (name, actual, expected) =>
  checks.push({
    name,
    ok: JSON.stringify(norm(actual)) === JSON.stringify(norm(expected)),
    actual: norm(actual),
    expected: norm(expected),
  });
const failure = async (fn) => {
  try {
    await fn();
    return { thrown: false };
  } catch (e) {
    return { thrown: true, code: e.code ?? null, message: e.message };
  }
};

// Одна реализация: корень и ./projections отдают те же объекты функций и перечней.
const shared = Object.keys(projections).sort();
check(
  'identity: root === ./projections',
  shared.filter((k) => root[k] !== projections[k]),
  [],
);
check(
  'identity: projections exports',
  [
    'chainRoots',
    'workProgress',
    'nextAction',
    'queueStop',
    'explainStop',
    'stopCodeOf',
    'clipText',
    'clipDeep',
  ].filter((k) => typeof projections[k] !== 'function'),
  [],
);

// OP-DIAG-01: цепочка из трёх готовых за упавшим корнем с исчерпанным бюджетом.
const task = (id, status, dependsOn = [], extra = {}) => ({
  id,
  title: 'Задача ' + id,
  status,
  dependsOn,
  attempt: 0,
  ...extra,
});
const stuck = [
  task('root', 'failed', [], { attempt: 3 }),
  task('a', 'ready', ['root']),
  task('b', 'ready', ['a']),
  task('c', 'ready', ['b']),
  task('done', 'done'),
  task('free', 'ready', ['done']),
];
check('OP-DIAG-01 chainRoots exhausted', projections.chainRoots(stuck, 3), [
  { workId: 'root', code: 'failed-exhausted', waiting: 3, actor: 'user', action: 'reset-attempts' },
]);
check('OP-DIAG-01 host exhausted', chainBlockers(stuck, 3), [
  {
    taskId: 'root',
    title: 'Задача root',
    reason: 'сбой, бюджет попыток исчерпан',
    next: 'ведущий устраняет причину и повторяет со сбросом бюджета',
    waiting: 3,
  },
]);
const kinds = [
  task('d', 'draft'),
  task('h', 'ready', [], { hold: { operation: 'op', reason: 'Меняется контракт X' } }),
  task('x', 'cancelled'),
  task('r', 'running'),
  task('w1', 'ready', ['d']),
  task('w2', 'ready', ['h']),
  task('w3', 'ready', ['x']),
  task('w4', 'ready', ['r']),
];
check(
  'OP-DIAG-01 host kinds',
  chainBlockers(kinds, 3).map((b) => [b.taskId, b.reason, b.next]),
  [
    ['d', 'план не утверждён', 'ревью и утверждение плана'],
    ['h', 'удержана: Меняется контракт X', 'дождаться завершения операции'],
    ['x', 'отменена', 'перепланировать зависимые задачи'],
  ],
);
check(
  'OP-DIAG-01 chainRoots kinds',
  projections
    .chainRoots(kinds, 3)
    .map((r) => [r.workId, r.code, r.actor, r.action, r.detail ?? null]),
  [
    ['d', 'draft', 'lead', 'review-plan', null],
    ['h', 'held', 'controller', 'wait', 'Меняется контракт X'],
    ['x', 'cancelled', 'lead', 'replan-dependents', null],
  ],
);
// AC09: ромб — зависимая считается один раз.
check(
  'OP-DIAG-01 diamond',
  chainBlockers(
    [
      task('root', 'failed', [], { attempt: 1 }),
      task('a', 'ready', ['root']),
      task('b', 'ready', ['root']),
      task('c', 'ready', ['a', 'b']),
    ],
    3,
  ).map((b) => [b.taskId, b.reason, b.next, b.waiting]),
  [['root', 'сбой', 'повтор назначит восстановление или ведущий', 3]],
);
check(
  'OP-DIAG-01 budget and attempts',
  chainBlockers(
    [
      task('bb', 'ready', [], { attempt: 1, budgetBlock: { reason: 'расход неизвестен' } }),
      task('ae', 'ready', [], { attempt: 3 }),
      task('w1', 'ready', ['bb']),
      task('w2', 'ready', ['ae']),
    ],
    3,
  ).map((b) => [b.taskId, b.reason, b.next]),
  [
    ['bb', 'расход неизвестен', 'осознанно поднять предел в budgets или задать политику onUnknown'],
    ['ae', 'исчерпан бюджет попыток', 'повтор со сбросом бюджета'],
  ],
);

// OP-DIAG-04: события scheduler.error → самая свежая причина без префикса.
const errors = [
  { id: 1, type: 'scheduler.error', data: { error: 'Error: старая причина' } },
  { id: 3, type: 'base.updated', data: {} },
  { id: 2, type: 'scheduler.error', data: { error: 'TaskFailure: База прогонов отстала' } },
];
check(
  'OP-DIAG-04 runtime latest',
  queueStopReason({ paused: true }, errors),
  'База прогонов отстала',
);
check(
  'OP-DIAG-04 runtime explicit',
  queueStopReason({ paused: true, pauseReason: 'runtime' }, errors),
  'База прогонов отстала',
);
check(
  'OP-DIAG-04 operator pause',
  queueStopReason({ paused: true, pauseReason: 'operator' }, errors),
  undefined,
);
check('OP-DIAG-04 not paused', queueStopReason({ paused: false }, errors), undefined);
check(
  'OP-DIAG-04 M-3 latest without message',
  queueStopReason({ paused: true }, [...errors, { id: 9, type: 'scheduler.error', data: {} }]),
  undefined,
);

// OP-DIAG-03: прежние {actor, step}.
const limits = { maxAttempts: 3, approvalMode: 'agent' };
check(
  'OP-DIAG-03 steps',
  [
    nextStep({ status: 'done', attempt: 1 }, limits),
    nextStep({ status: 'cancelled', attempt: 0 }, limits),
    nextStep({ status: 'failed', attempt: 1 }, limits),
    nextStep({ status: 'failed', attempt: 3 }, limits),
    nextStep({ status: 'ready', attempt: 0, hold: { operation: 'op', reason: 'r' } }, limits),
    nextStep({ status: 'draft', attempt: 0 }, limits),
    nextStep({ status: 'reviewing', attempt: 1 }, limits),
    nextStep({ status: 'ready', attempt: 0 }, limits),
    nextStep({ status: 'ready', attempt: 0 }, { ...limits, waitingAdoption: true }),
    nextStep(
      { status: 'failed', attempt: 1, recovery: { status: 'awaiting-lead', property: 'p1' } },
      limits,
    ),
    nextStep(
      { status: 'failed', attempt: 1, recovery: { status: 'awaiting-lead', property: 'p1' } },
      { ...limits, approvalMode: 'operator' },
    ),
    nextStep(
      {
        status: 'failed',
        attempt: 1,
        recovery: { status: 'awaiting-user', property: 'p1', reason: 'Решите X' },
      },
      limits,
    ),
    nextStep(
      { status: 'failed', attempt: 1, recovery: { status: 'stopped', property: 'p1' } },
      limits,
    ),
  ],
  [
    { actor: null, step: 'Задача принята.' },
    { actor: null, step: 'Задача отменена.' },
    { actor: 'controller', step: 'Повтор в пределах бюджета попыток.' },
    { actor: 'user', step: 'Попытки исчерпаны: сброс — решение человека с причиной.' },
    { actor: 'controller', step: 'Выдачу удерживает операция op.' },
    { actor: 'lead', step: 'Черновик ждёт ревью плана.' },
    { actor: 'controller', step: 'Идёт попытка: реализация, гейты, ревью и интеграция.' },
    { actor: 'controller', step: 'Задача ждёт выдачи.' },
    { actor: 'controller', step: 'Новая версия корпуса будет принята после окончания попытки.' },
    {
      actor: 'lead',
      step: 'Ограниченный разбор ведущего по свойству p1: сервер вызовет его сам в пределах бюджета.',
    },
    {
      actor: 'lead',
      step: 'Разбор свойства p1: решение ведущего через recovery_decide (operator mode автоматически не вызывает модель).',
    },
    { actor: 'user', step: 'Решите X' },
    { actor: 'user', step: 'Автоматических действий больше нет.' },
  ],
);

// OP-DIAG-02: snake-причины, причины хоста до и после общих (Q2).
const statuses = { a: 'ready', z: 'done' };
const progress = (t, extra = {}) =>
  taskProgress(t, {
    statusOf: (id) => statuses[id],
    maxAttempts: 3,
    paused: false,
    activeRuns: 0,
    concurrency: 1,
    host: {},
    ...extra,
  });
check(
  'OP-DIAG-02 progress',
  [
    progress({ id: 't1', status: 'ready', attempt: 0, dependsOn: ['z'] }),
    progress({ id: 't2', status: 'draft', attempt: 0, dependsOn: [] }),
    progress({ id: 't3', status: 'failed', attempt: 1, dependsOn: [] }),
    progress(
      { id: 't4', status: 'ready', attempt: 3, dependsOn: ['a', 'z'] },
      { paused: true, activeRuns: 1, host: { inactiveRevision: true, assignedToAnother: true } },
    ),
  ].map((p) => [p.taskId, p.dependencies, p.reasons, p.eligible]),
  [
    ['t1', [], [], true],
    ['t2', [], ['plan_review_required'], false],
    ['t3', [], ['failure_requires_diagnosis'], false],
    [
      't4',
      ['a'],
      [
        'inactive_revision',
        'dependencies_incomplete',
        'attempts_exhausted',
        'queue_paused',
        'workers_busy',
        'assigned_to_another_member',
      ],
      false,
    ],
  ],
);

// OP-SETUP-03/04 с порядком отказов хоста M-2.
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-h1-')));
try {
  const p = join(dir, 'project');
  const outside = join(dir, 'outside');
  mkdirSync(join(p, '.devcontour-local', 'profiles'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(p, 'AGENTS.md'), 'user instructions\n');
  const profilePath = join(p, '.devcontour-local', 'profiles', 'go-api.json');
  writeFileSync(profilePath, '{"version":"1"}\n');
  const config = join(p, '.devcontour-local', 'config.json');
  const files = (profile) => [
    { path: join(p, 'AGENTS.md'), content: 'template\n' },
    { path: profilePath, content: profile, onExisting: 'require-identical' },
    { path: config, content: '{}\n' },
  ];
  const ok = () => {};
  const refuseConfig = () => {
    throw new Error('Сохранённая конфигурация отличается');
  };

  // (4) Изменённый профиль — прежнее сообщение хоста, ничего не записано.
  const changed = await failure(() =>
    setupFiles({ files: files('{"version":"2"}\n'), profilePath, hostChecks: ok }),
  );
  check(
    'M-2 profile content-differs',
    [changed.message, existsSync(config)],
    [PROFILE_CHANGED, false],
  );
  // (3) раньше (4): сверка хоста отказывает первой.
  const host = await failure(() =>
    setupFiles({ files: files('{"version":"2"}\n'), profilePath, hostChecks: refuseConfig }),
  );
  check('M-2 host checks before profile', host.message, 'Сохранённая конфигурация отличается');
  // (2) раньше (3): symlink — отказ общей проверки тем же текстом.
  symlinkSync(outside, join(p, 'link'));
  const linked = await failure(() =>
    setupFiles({
      files: [...files('{"version":"2"}\n'), { path: join(p, 'link', 'x.md'), content: 'x\n' }],
      profilePath,
      hostChecks: refuseConfig,
    }),
  );
  check(
    'M-2 symlink before host checks',
    [linked.code, linked.message, existsSync(join(outside, 'x.md'))],
    ['PATH_CONFLICT', `Setup не пишет через symlink: ${join(p, 'link')}`, false],
  );
  // Предок-файл: PATH_CONFLICT общей операции, без сырого ENOTDIR (D0-Q2).
  writeFileSync(join(p, 'plain'), 'x');
  const ancestor = await failure(() =>
    setupFiles({
      files: [...files('{"version":"1"}\n'), { path: join(p, 'plain', 'x.md'), content: 'x\n' }],
      profilePath,
      hostChecks: ok,
    }),
  );
  check(
    'M-2 ancestor not directory',
    [ancestor.code, ancestor.message],
    ['PATH_CONFLICT', `Родитель не является каталогом: ${join(p, 'plain')}`],
  );
  // Успех: create-only, пользовательский файл сохранён; повтор — ничего не пишет.
  const first = await setupFiles({
    files: files('{"version":"1"}\n'),
    profilePath,
    hostChecks: ok,
  });
  const second = await setupFiles({
    files: files('{"version":"1"}\n'),
    profilePath,
    hostChecks: ok,
  });
  check(
    'OP-SETUP-04 create-only and repeat',
    [
      first.created,
      first.preserved,
      second.created,
      second.preserved,
      readFileSync(join(p, 'AGENTS.md'), 'utf8'),
    ],
    [
      [config],
      [join(p, 'AGENTS.md'), profilePath],
      [],
      [join(p, 'AGENTS.md'), profilePath, config],
      'user instructions\n',
    ],
  );
  check(
    'OP-SETUP-03 plan entries',
    first.plan.entries.map((e) => [e.path, e.action]),
    [
      [join(p, 'AGENTS.md'), 'preserve'],
      [profilePath, 'preserve'],
      [config, 'create'],
    ],
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
process.stdout.write(
  JSON.stringify(
    { ok: failed.length === 0, total: checks.length, failed: failed.map((c) => c.name), checks },
    null,
    2,
  ) + '\n',
);
process.exit(failed.length ? 1 : 0);
