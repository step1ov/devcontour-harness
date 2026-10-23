// Gate `sdk-generation` (S02): закоммиченные OpenAPI и SDK равны выходу закреплённого генератора
// на закоммиченных исходниках. Генератор запускается штатной командой starter; после
// сравнения рабочее дерево возвращается к проверяемому коммиту, чтобы gate не менял
// отслеживаемые файлы (harness проверяет это отдельно).
//   node --test --test-reporter=junit --test-reporter-destination=<report> .harness/acceptance/generation.test.mjs
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';

/** Выходы генерации, которые поручение вправе менять только через генератор. */
export const GENERATED = [
  'apps/nest-backend/openapi',
  'packages/client-rest-api-sdk/src/generated',
  'packages/admin-rest-api-sdk/src/generated',
];
/** Штатная команда генерации starter; версия codegen закреплена в package.json SDK (защищён). */
const GENERATOR = ['pnpm', 'rest-api-sdk:generate'];

const root = process.env.FIXTURE_ROOT ?? process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
let generation;

before(() => {
  // Детерминированный вход: без .env файлов starter и без сетевого update-check Prisma.
  generation = spawnSync(GENERATOR[0], GENERATOR.slice(1), {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', CHECKPOINT_DISABLE: '1' },
    timeout: 540_000,
  });
});

after(() => {
  // Вернуть дерево к проверяемому коммиту: только пути генерации.
  git('checkout', '--', ...GENERATED);
  git('clean', '-fdq', '--', ...GENERATED);
});

test('sdk-generation: генератор завершился успешно', () => {
  assert.equal(
    generation.status,
    0,
    `${GENERATOR.join(' ')}: exit ${generation.status}\n${(generation.stderr || generation.stdout).slice(-4000)}`,
  );
});

for (const path of GENERATED)
  test(`sdk-generation: ${path} совпадает с выходом генератора`, () => {
    assert.equal(generation.status, 0, 'генерация не выполнена');
    const diff = git('diff', '--stat', '--', path).trim();
    const untracked = git('ls-files', '--others', '--exclude-standard', '--', path).trim();
    assert.equal(diff, '', `устаревший или изменённый вручную выход генерации:\n${diff}`);
    assert.equal(untracked, '', `генератор создал незакоммиченные файлы:\n${untracked}`);
  });
