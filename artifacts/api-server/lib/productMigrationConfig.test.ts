import test from 'node:test';
import assert from 'node:assert/strict';
import { getMiorailProductMigrationFlags } from './productMigrationConfig.js';

test('migration flags preserve the legacy product when variables are missing', () => {
  assert.deepStrictEqual(getMiorailProductMigrationFlags({}), {
    routeIntelligenceV1: false,
    legacyTerminal: true,
    paidIntelligence: false,
  });
});

test('migration flags accept only explicit boolean values', () => {
  assert.deepStrictEqual(
    getMiorailProductMigrationFlags({
      MIORAIL_ROUTE_INTELLIGENCE_V1: 'true',
      MIORAIL_LEGACY_TERMINAL: 'false',
      MIORAIL_PAID_INTELLIGENCE: 'TRUE',
    }),
    {
      routeIntelligenceV1: true,
      legacyTerminal: false,
      paidIntelligence: true,
    },
  );
});

test('invalid migration flag values fall back to the compatibility baseline', () => {
  assert.deepStrictEqual(
    getMiorailProductMigrationFlags({
      MIORAIL_ROUTE_INTELLIGENCE_V1: 'yes',
      MIORAIL_LEGACY_TERMINAL: '0',
      MIORAIL_PAID_INTELLIGENCE: 'enabled',
    }),
    {
      routeIntelligenceV1: false,
      legacyTerminal: true,
      paidIntelligence: false,
    },
  );
});
