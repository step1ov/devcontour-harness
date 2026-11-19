/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
 * Тест портит копию фикстуры по путям полей; форму проверяет схема.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  OPERATOR_VIEW_LIMITS,
  OPERATOR_VIEW_REVISION,
  OPERATOR_VIEW_VERSION,
  operatorViewSchema,
  workDetailViewSchema,
} from '../src/contracts/index.ts';
import * as projections from '../src/projections/index.ts';
import { harnessView } from '../src/control/operator-view.ts';
import { viewState } from './view-fixture.ts';

// Копии фикстур панели оператора (devcontour-harness-ui, fixtures/*.sample.json):
// договор harness обязан принимать документ, который рисует панель.
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/operator-view/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const schema = (name: string) =>
  ajv.compile(
    JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8')),
  );
const overviewJson = schema('operator-view');
const detailJson = schema('work-detail-view');

test('view contract: фикстуры панели проходят Zod-схему и опубликованную JSON Schema', () => {
  const view = fixture('view.sample.json');
  const work = fixture('work.sample.json');
  operatorViewSchema.parse(view);
  workDetailViewSchema.parse(work);
  assert.ok(overviewJson(view), JSON.stringify(overviewJson.errors));
  assert.ok(detailJson(work), JSON.stringify(detailJson.errors));
});

test('view contract: вывод harness проходит JSON Schema; версии и пределы — одни для проекции и договора', () => {
  const s = viewState();
  const now = Date.parse('2026-10-08T12:00:00Z');
  const view = harnessView({ stateDir: s.state, policyPath: s.policyPath, now });
  assert.ok(overviewJson(view), JSON.stringify(overviewJson.errors));
  const detail = harnessView({ stateDir: s.state, policyPath: s.policyPath, now, workId: 'gate' });
  assert.ok(detailJson(detail), JSON.stringify(detailJson.errors));
  assert.equal(projections.OPERATOR_VIEW_VERSION, OPERATOR_VIEW_VERSION);
  assert.equal(projections.OPERATOR_VIEW_REVISION, OPERATOR_VIEW_REVISION);
  assert.equal(projections.OPERATOR_VIEW_LIMITS, OPERATOR_VIEW_LIMITS);
});

test('view contract: схема отклоняет нарушения — момент без зоны, неизвестный answerableBy, executed без by', () => {
  const view = fixture('view.sample.json') as Record<string, any>;
  const bad = (
    edit: (v: Record<string, any>) => void,
    s: typeof operatorViewSchema | typeof workDetailViewSchema,
    base: unknown,
  ) => {
    const copy = structuredClone(base) as Record<string, any>;
    edit(copy);
    assert.equal(s.safeParse(copy).success, false);
  };
  bad((v) => (v.generatedAt = '2026-11-19T12:00:00'), operatorViewSchema, view);
  bad((v) => (v.questions[0].answerableBy = 'lead'), operatorViewSchema, view);
  bad((v) => (v.progress.byStage.done = -1), operatorViewSchema, view);
  bad((v) => (v.works[0].extra = 1), operatorViewSchema, view);
  bad((v) => delete v.decisions[0].reason, operatorViewSchema, view);
  bad((v) => (v.decisions[1].revisit = undefined), operatorViewSchema, view);
  const work = fixture('work.sample.json');
  bad((v) => delete v.verification[0].by, workDetailViewSchema, work);
  bad((v) => delete v.verification[1].attempt, workDetailViewSchema, work);
  bad((v) => (v.verification[3].how = 'executed'), workDetailViewSchema, work);
});
