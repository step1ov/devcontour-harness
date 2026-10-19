import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactDeep, redactor } from '../src/environment/redaction.ts';

test('T30: redactor маскирует секрет в исходной, URL-, JSON-, дважды JSON- и XML-форме', () => {
  const secret = 'pa"ss\\word\nline';
  const redact = redactor([secret]);
  const forms = [
    secret,
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1),
    secret.replace('"', '&quot;'),
  ];
  for (const form of forms)
    assert.equal(redact(`before ${form} after`), 'before [REDACTED] after', JSON.stringify(form));
  // Строка внутри JSON-документа — обычный путь утечки через отчёты.
  assert.equal(
    redact(JSON.stringify({ value: secret })).includes(JSON.stringify(secret).slice(1, -1)),
    false,
  );
});

test('T30: redactDeep маскирует каждую строку вложенной записи и не трогает прочие значения', () => {
  const redact = redactor(['s3cr"t']);
  const masked = redactDeep(
    {
      command: ['node', 'check.mjs', 's3cr"t'],
      nested: { list: [{ message: 'got s3cr"t' }], count: 3, ok: true, none: null },
    },
    redact,
  );
  assert.deepEqual(masked, {
    command: ['node', 'check.mjs', '[REDACTED]'],
    nested: { list: [{ message: 'got [REDACTED]' }], count: 3, ok: true, none: null },
  });
  assert.equal(redactDeep('x', undefined), 'x');
});
