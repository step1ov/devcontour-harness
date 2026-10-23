// Приёмочные проверки поручения `issued-at` (S01): контракт backend → OpenAPI → SDK → потребитель.
// Поставляются примером devcontour-harness и запускаются gate `acceptance`:
//   node --test --test-reporter=junit --test-reporter-destination=<report> .harness/acceptance/issued-at.test.mjs
// Только встроенные модули Node: зависимостей проекта не требуется.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.env.FIXTURE_ROOT ?? process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');

/** Тело `export interface <name> { ... }` в сгенерированном файле SDK. */
function interfaceBody(source, name) {
  const start = source.indexOf(`export interface ${name} {`);
  assert.ok(start >= 0, `в SDK нет interface ${name}`);
  return source.slice(start, source.indexOf('\n}', start));
}

for (const realm of ['client', 'admin']) {
  test(`issued-at: ${realm} OpenAPI AccessTokenDto.issuedAt — обязательный date-time`, () => {
    const doc = JSON.parse(read(`apps/nest-backend/openapi/${realm}.openapi.json`));
    const schema = doc.components.schemas.AccessTokenDto;
    assert.equal(schema.properties.issuedAt?.type, 'string');
    assert.equal(schema.properties.issuedAt?.format, 'date-time');
    assert.ok(schema.required.includes('issuedAt'), 'issuedAt должен быть required');
  });
  test(`issued-at: ${realm} SDK AccessTokenDto объявляет issuedAt: string`, () => {
    const body = interfaceBody(
      read(`packages/${realm}-rest-api-sdk/src/generated/data-contracts.ts`),
      'AccessTokenDto',
    );
    assert.match(body, /\n\s+issuedAt: string;/);
  });
}

test('issued-at: потребитель web использует AccessTokenDto.issuedAt из SDK', () => {
  const path = 'apps/next-web-app/src/infra/client-api/types/access-token-issued-at.type.ts';
  assert.ok(existsSync(resolve(root, path)), `нет ${path}`);
  const text = read(path);
  assert.match(text, /from '@oim\/client-rest-api-sdk\/data-contracts'/);
  assert.match(text, /AccessTokenDto\['issuedAt'\]/);
});
