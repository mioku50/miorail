import assert from 'node:assert/strict';
import test from 'node:test';

import { REPRESENTATION_STRUCTURE_ADAPTERS_V1 } from '../src/structureAdapters.js';

test('every reviewed issuer has every typed structure and eligibility field', () => {
  for (const [issuerId, adapter] of Object.entries(REPRESENTATION_STRUCTURE_ADAPTERS_V1)) {
    assert.equal(adapter.issuerId, issuerId);
    for (const key of [
      'structure',
      'claimModel',
      'transferRestrictions',
      'redemption',
      'distributions',
      'corporateActions',
      'bridge',
      'eligibility',
      'referenceSource',
    ] as const) {
      const field = adapter[key];
      if (field.status === 'reviewed') {
        assert.ok(field.value);
        assert.ok(field.sources.length > 0);
      } else {
        assert.equal(field.value, null);
        assert.deepEqual(field.sources, []);
      }
    }
  }
});

test('legacy Base bTokens do not inherit the current xStocks bridge claim', () => {
  assert.equal(REPRESENTATION_STRUCTURE_ADAPTERS_V1.backed.bridge.status, 'unknown');
  assert.equal(REPRESENTATION_STRUCTURE_ADAPTERS_V1.backed.bridge.value, null);
});
