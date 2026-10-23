/**
 * Общий набор коннектора (W02–W05, D01–D06, R04) на НАСТОЯЩЕМ изолированном
 * сервере Relay v1 (scripts/acceptance/relay-v1-server.mjs): каждый
 * `project()` — новый временный проект и свой процесс сервера. Действия
 * «другого участника» идут независимым REST-клиентом с другим actor.
 * Нет сборки — тест падает с BLOCKED (подготовка: `node scripts/acceptance/relay-v1-server.mjs prepare`).
 */
import { connectorSuite } from '../../src/integrations/connector/testing.ts';
import { relayV1Backend } from './relay-v1-backend.ts';

connectorSuite(relayV1Backend(), {
  timeoutMs: 600_000,
  ...(process.env.CONNECTOR_SUITE_ONLY
    ? { only: process.env.CONNECTOR_SUITE_ONLY.split(',') }
    : {}),
});
