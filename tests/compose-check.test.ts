/**
 * 0.1.0-alpha.68 (P6-16): модель compose до smoke. Docker не публикует порты
 * контейнера, подключённого только к сетям `internal: true`; `doctor` находит
 * файлы compose шагов lifecycle (docker compose -f, мост compose-bridge.mjs) и
 * называет такой сервис проблемой. Файл вне разбираемого подмножества YAML —
 * заметка «проверка пропущена», не ошибка.
 */
import './temp-scope.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../src/control/doctor.ts';
import {
  checkComposeFile,
  composeChecks,
  composeFilesOf,
  parseComposeYaml,
} from '../src/environment/compose-check.ts';
import { policyOf } from './engine-fixture.ts';

const INTERNAL_ONLY = `# стек приёмки
services:
  app:
    image: app:1
    ports:
      - "127.0.0.1:\${APP_PORT:?APP_PORT}:3000"
    networks: [backend]
  db:
    image: postgres:16-alpine
    ports:
      - target: 5432
        published: "15432"
        host_ip: 127.0.0.1
    networks:
      backend:
        aliases: [postgres]
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U "$$POSTGRES_USER", ok']
      interval: 1s
  worker:
    image: worker:1
    networks:
    - backend
  gateway:
    image: nginx:1
    ports: ["127.0.0.1:8080:80"]
    networks:
      - backend
      - edge
    command: |
      nginx -g 'daemon off;'
      # не комментарий YAML
networks:
  backend:
    internal: true
  edge: {}
`;

function project(compose: Record<string, string>, command: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-compose-check-')));
  const repo = join(root, 'app');
  mkdirSync(join(repo, '.harness'), { recursive: true });
  for (const [file, body] of Object.entries(compose)) writeFileSync(join(repo, file), body);
  const policy = policyOf((p) => {
    const repos = p.repositories as Record<string, unknown>[];
    repos[0]!.path = 'app';
    repos[0]!.lifecycle = {
      setup: [{ id: 'up', command }],
      teardown: [{ id: 'down', command: ['docker', 'compose', '-p', 'x', 'down'] }],
    };
  });
  return { root, repo, policy };
}

test('P6-16: разбор блочного YAML — сервисы, сети, длинная запись портов, поток и блочный скаляр', () => {
  const doc = parseComposeYaml(INTERNAL_ONLY) as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(doc.services!), ['app', 'db', 'worker', 'gateway']);
  assert.deepEqual((doc.services!.app as { networks: unknown }).networks, ['backend']);
  assert.deepEqual((doc.services!.worker as { networks: unknown }).networks, ['backend']);
  assert.deepEqual((doc.networks!.backend as { internal: unknown }).internal, 'true');
  assert.deepEqual(doc.networks!.edge, {});
});

test('P6-16: сервис с портами только во внутренних сетях — назван; с обычной сетью или без портов — нет', () => {
  const p = project({ 'compose.yml': INTERNAL_ONLY }, [
    'docker',
    'compose',
    '-f',
    'compose.yml',
    'up',
  ]);
  const check = checkComposeFile(join(p.repo, 'compose.yml'));
  assert.deepEqual(check.internalOnly, ['app', 'db']);
  assert.equal(check.unknown, undefined);
  const { problems, notes } = composeChecks(p.policy, p.root);
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(
    problems[0]!,
    /^compose-internal-ports app\/compose\.yml: Сервис app публикует порты, но подключён только к внутренним сетям \(internal: true\): Docker не публикует такие порты/,
  );
  assert.deepEqual(notes, []);
});

test('P6-16: сеть default с internal и сервис без networks; network_mode — не проверяется', () => {
  const p = project(
    {
      'docker-compose.yml': `services:
  a:
    image: a
    ports: ["8080:80"]
  b:
    image: b
    network_mode: host
    ports: ["8081:80"]
networks:
  default:
    internal: yes
`,
    },
    ['docker', 'compose', 'up', '-d'],
  );
  assert.deepEqual(composeFilesOf(p.policy, p.root), [join(p.repo, 'docker-compose.yml')]);
  assert.deepEqual(checkComposeFile(join(p.repo, 'docker-compose.yml')).internalOnly, ['a']);
});

test('P6-16: мост compose-bridge.mjs — его --compose и умолчание .harness/compose.acceptance.yml', () => {
  const named = project({ 'stack.yml': INTERNAL_ONLY }, [
    'node',
    '.harness/compose-bridge.mjs',
    'setup',
    '--compose',
    'stack.yml',
  ]);
  assert.deepEqual(composeFilesOf(named.policy, named.root), [join(named.repo, 'stack.yml')]);
  const fallback = project({ '.harness/compose.acceptance.yml': INTERNAL_ONLY }, [
    'node',
    '.harness/compose-bridge.mjs',
    'setup',
  ]);
  assert.deepEqual(composeFilesOf(fallback.policy, fallback.root), [
    join(fallback.repo, '.harness/compose.acceptance.yml'),
  ]);
  // Файла нет (модель создаётся при setup) или путь с подстановкой — пропуск.
  const missing = project({}, ['docker', 'compose', '-f', '$STACK', 'up']);
  assert.deepEqual(composeFilesOf(missing.policy, missing.root), []);
});

test('P6-16: тег, неизвестная ссылка, несколько документов, табуляция — unknown и заметка, а не догадка', () => {
  for (const body of [
    'services:\n  a:\n    image: a\n    ports: !reset []\n',
    'services:\n  a:\n    <<: *missing\n',
    'services:\n  a:\n    image: a\n---\nservices: {}\n',
    'services:\n\ta: {}\n',
  ]) {
    const p = project({ 'compose.yml': body }, ['docker', 'compose', '-f', 'compose.yml', 'up']);
    const check = checkComposeFile(join(p.repo, 'compose.yml'));
    assert.ok(check.unknown, body);
    assert.deepEqual(check.internalOnly, []);
    const { problems, notes } = composeChecks(p.policy, p.root);
    assert.deepEqual(problems, []);
    assert.match(
      notes[0]!,
      /^compose-check app\/compose\.yml: .* — проверка внутренних сетей пропущена$/,
    );
  }
});

test('P6-16: doctor называет сервис проблемой до smoke', async () => {
  const p = project({ 'compose.yml': INTERNAL_ONLY }, [
    'docker',
    'compose',
    '-f',
    'compose.yml',
    'up',
  ]);
  const report = await doctor(
    p.policy,
    {},
    undefined,
    undefined,
    { baseDir: p.root },
    {
      resourceDatabase: false,
    },
  );
  const lines = report.problems.filter((x) => x.startsWith('compose-internal-ports '));
  assert.equal(lines.length, 2, report.problems.join('\n'));
  assert.match(lines[1]!, /Сервис db публикует порты/);
});

test('P6-16: якоря, ссылки и слияние ключей — сети и порты приходят из общего фрагмента', () => {
  const p = project(
    {
      'compose.yml': `x-internal: &internal
  restart: unless-stopped
  networks:
    - private
x-ports: &ports ["127.0.0.1:9000:9000"]
services:
  api:
    <<: *internal
    image: api
    ports: *ports
  web:
    <<: *internal
    image: web
    networks: [private, public]
    ports: *ports
networks:
  private: &closed
    internal: true
  public: {}
`,
    },
    ['docker', 'compose', '-f', 'compose.yml', 'up'],
  );
  const check = checkComposeFile(join(p.repo, 'compose.yml'));
  assert.equal(check.unknown, undefined);
  assert.deepEqual(check.internalOnly, ['api'], 'явные networks сильнее слитых');
});
