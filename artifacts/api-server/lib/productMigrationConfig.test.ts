import test from 'node:test';
import assert from 'node:assert/strict';
import { getMiorailProductMigrationFlags } from './productMigrationConfig.js';

test('migration flags preserve the legacy product when variables are missing', () => {
  assert.deepStrictEqual(getMiorailProductMigrationFlags({}), {
    routeIntelligenceV1: false,
    legacyTerminal: true,
    paidIntelligence: false,
    earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false,
    nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, routeOutcomeFeedbackV1: false,
  });
});

test('migration flags accept only explicit boolean values', () => {
  assert.deepStrictEqual(
    getMiorailProductMigrationFlags({
      MIORAIL_ROUTE_INTELLIGENCE_V1: 'true',
      MIORAIL_LEGACY_TERMINAL: 'false',
      MIORAIL_PAID_INTELLIGENCE: 'TRUE',
      MIORAIL_EARN_ROUTE_V1: 'true',
    }),
    {
      routeIntelligenceV1: true,
      legacyTerminal: false,
      paidIntelligence: true,
      earnRouteV1: true, commerceRouteV1: false, commerceExecutionV1: false,
      nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, routeOutcomeFeedbackV1: false,
    },
  );
});

test('invalid migration flag values fall back to the compatibility baseline', () => {
  assert.deepStrictEqual(
    getMiorailProductMigrationFlags({
      MIORAIL_ROUTE_INTELLIGENCE_V1: 'yes',
      MIORAIL_LEGACY_TERMINAL: '0',
      MIORAIL_PAID_INTELLIGENCE: 'enabled',
      MIORAIL_EARN_ROUTE_V1: 'nope',
    }),
    {
      routeIntelligenceV1: false,
      legacyTerminal: true,
      paidIntelligence: false,
      earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false,
    nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, routeOutcomeFeedbackV1: false,
    },
  );
});
