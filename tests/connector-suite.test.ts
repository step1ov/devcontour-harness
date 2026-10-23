/**
 * Общий набор коннектора (W02–W05, D01–D06, R04) на управляемой подделке
 * backend (fixture). Настоящие Relay v1/Relay-2 запускают тот же набор в
 * tests/integration/.
 */
import { connectorSuite, fakeSuiteBackend } from '../src/integrations/connector/testing.ts';

connectorSuite(fakeSuiteBackend('relay-v1-http'), {
  ...(process.env.CONNECTOR_SUITE_ONLY
    ? { only: process.env.CONNECTOR_SUITE_ONLY.split(',') }
    : {}),
});
