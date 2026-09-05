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
      'custody',
      'supervision',
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

test('the custody chain is a reviewed document for Coinbase and an absence elsewhere', () => {
  const coinbase = REPRESENTATION_STRUCTURE_ADAPTERS_V1.coinbase;
  assert.equal(coinbase.custody.value, 'regulated_broker_custodian_bankruptcy_remote');
  assert.match(coinbase.custody.note, /Alpaca/);
  assert.match(coinbase.custody.note, /bankruptcy-remote/);
  // The kind of evidence must travel with the claim: no read on Base can
  // confirm that a custodian is holding a share.
  assert.match(coinbase.custody.note, /not an onchain read/);
  assert.equal(coinbase.supervision.value, 'adgm_regulatory_authority');
  assert.match(coinbase.supervision.note, /Abu Dhabi Global Market/);
  // Supervision of the structure is not permission for a holder.
  assert.match(coinbase.supervision.note, /not a statement about any holder/);
  for (const source of [...coinbase.custody.sources, ...coinbase.supervision.sources]) {
    assert.equal(source.kind, 'reviewed_document');
    assert.match(source.ref, /^https:\/\//);
    assert.ok(Number.isFinite(Date.parse(source.reviewedAt)));
  }
  for (const issuerId of ['dinari', 'backed'] as const) {
    assert.equal(REPRESENTATION_STRUCTURE_ADAPTERS_V1[issuerId].custody.status, 'unknown');
    assert.equal(REPRESENTATION_STRUCTURE_ADAPTERS_V1[issuerId].supervision.status, 'unknown');
  }
});
