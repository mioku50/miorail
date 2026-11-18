import assert from 'node:assert/strict';
import test from 'node:test';

import { sharpShrinkV1, supplyDisagreementsV1 } from './rwaSupplyRead.js';

// Synthetic contracts only.
const A = `0xb200${'a'.repeat(36)}`, B = `0xb200${'b'.repeat(36)}`, C = `0xb200${'c'.repeat(36)}`, D = `0xb200${'d'.repeat(36)}`;

test('reads again every contract the issuer’s list and Miorail’s latest reading disagree on (audit STOCK-1)', () => {
  const due = supplyDisagreementsV1({
    listed: [
      { tokenAddress: A, issuerSupplyPositive: true },   // minted since the last reading: read again
      { tokenAddress: B, issuerSupplyPositive: true },   // agree
      { tokenAddress: C, issuerSupplyPositive: false },  // burned to nothing: read again
      { tokenAddress: D, issuerSupplyPositive: true },   // never read successfully: read
      { tokenAddress: `0xb200${'e'.repeat(36)}` },       // the source says nothing of supply
    ],
    stored: [
      { tokenAddress: A, state: 'zero_supply', readOutcome: 'success' },
      { tokenAddress: B, state: 'positive_supply', readOutcome: 'success' },
      { tokenAddress: C, state: 'positive_supply', readOutcome: 'success' },
      { tokenAddress: D, state: 'supply_unknown', readOutcome: 'rpc_failure' },
    ],
    limit: 10,
  });
  assert.deepEqual(due, [A, C, D]);
  assert.deepEqual(supplyDisagreementsV1({ listed: [{ tokenAddress: A, issuerSupplyPositive: true }, { tokenAddress: C, issuerSupplyPositive: true }], stored: [], limit: 1 }), [A]);
});

test('a list that lost a tenth of itself, and at least ten, in one pass is a signal', () => {
  assert.equal(sharpShrinkV1(377, 74), true);
  assert.equal(sharpShrinkV1(100, 90), true);
  assert.equal(sharpShrinkV1(100, 91), false);
  assert.equal(sharpShrinkV1(50, 41), false, 'nine is not ten');
  assert.equal(sharpShrinkV1(87, 87), false);
  assert.equal(sharpShrinkV1(87, 95), false);
  assert.equal(sharpShrinkV1(null, 10), false);
});
