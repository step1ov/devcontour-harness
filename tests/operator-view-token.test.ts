import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operatorView, viewToken, workDetailView } from '../src/projections/index.ts';
import { NOW, baseInput, work } from './operator-view-input.ts';

test('view token: тот же вход — тот же токен; generatedAt в токен не входит', () => {
  const input = baseInput({ works: [work('a')], controller: { leaseUntil: NOW + 30_000 } });
  const a = operatorView(input);
  const b = operatorView(input);
  assert.equal(a.source.token, b.source.token);
  assert.equal(viewToken(a), a.source.token);
  assert.match(a.source.token, /^[a-f0-9]{64}$/);
  // Тот же документ с другим generatedAt — тот же токен.
  assert.equal(viewToken({ ...a, generatedAt: '2030-01-01T00:00:00.000Z' }), a.source.token);
  const detail = workDetailView(input, 'a');
  assert.equal(viewToken(detail), detail.source.token);
});

test('view token: аренда controller истекла без записи в хранилище — токен меняется', () => {
  const leaseUntil = NOW + 10_000;
  const live = operatorView(baseInput({ controller: { leaseUntil }, now: NOW }));
  // Тот же вход хранилища, часы после конца аренды (history.from/to тоже
  // зависят от часов: токен меняется при любом сдвиге окна).
  const later = NOW + 15 * 60_000;
  const expired = operatorView(baseInput({ controller: { leaseUntil }, now: later }));
  assert.equal(live.health.controller.present, true);
  assert.equal(expired.health.controller.present, false);
  assert.notEqual(live.source.token, expired.source.token);
  // Те же вход и часы — тот же токен (повтор, а не новое представление).
  const sameWindow = operatorView(baseInput({ controller: { leaseUntil }, now: NOW }));
  assert.equal(sameWindow.source.token, live.source.token);
});

test('view token: смена любого поля содержимого меняет токен', () => {
  const a = operatorView(baseInput({ works: [work('a')] }));
  const b = operatorView(baseInput({ works: [work('a', { status: 'running' })] }));
  assert.notEqual(a.source.token, b.source.token);
});
