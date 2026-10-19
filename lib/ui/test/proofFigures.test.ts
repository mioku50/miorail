import assert from 'node:assert/strict';
import test from 'node:test';
import { feeUsdLabelV1, proofFeeV1, proofOutputDifferenceV1 } from '../src/console/proofFigures';

// The operator's first trade of 2026-10-19: 10 USDC → SONYc through KyberSwap,
// quoted 0.3937027 SONYc, received 0.39369698; the fee was estimated at
// $0.00481378030088898 and the person's own operation cost 0.000003101358 ETH.

test('a fee reads in dollars at the precision a reader can use', () => {
  assert.equal(feeUsdLabelV1('0.00481378030088898'), '$0.0048');
  assert.equal(feeUsdLabelV1('0.005'), '$0.005');
  assert.equal(feeUsdLabelV1(0.12345), '$0.12');
  assert.equal(feeUsdLabelV1(1234.5), '$1,234.50');
  assert.equal(feeUsdLabelV1('0'), '$0');
  assert.equal(feeUsdLabelV1(0.00000042), '<$0.0001');
  for (const missing of [null, undefined, '', 'abc', -1]) assert.equal(feeUsdLabelV1(missing), null);
});

test('the difference is the real one, in the token’s own units', () => {
  const sony = { expectedAtomic: '39370270', decimals: 8, symbol: 'SONYc' };
  assert.deepEqual(proofOutputDifferenceV1({ ...sony, actualAtomic: '39369698', minimumSatisfied: true }), {
    difference: '−0.00000572 SONYc (−0.0015%) · within your slippage',
    tone: 'none',
  });
  assert.deepEqual(proofOutputDifferenceV1({ ...sony, actualAtomic: '39370270', minimumSatisfied: true }), {
    difference: 'exactly as quoted',
    tone: 'good',
  });
  assert.deepEqual(proofOutputDifferenceV1({ ...sony, actualAtomic: '39800000', minimumSatisfied: true }), {
    difference: '+0.0042973 SONYc (+1.09%)',
    tone: 'good',
  });
  assert.equal(proofOutputDifferenceV1({ ...sony, actualAtomic: '30000000', minimumSatisfied: false }).tone, 'warn');
  // Nothing to compare is a dash, never a zero.
  assert.deepEqual(proofOutputDifferenceV1({ ...sony, actualAtomic: null, minimumSatisfied: null }), {
    difference: '—',
    tone: 'none',
  });
});

test('the fee is the person’s own, priced, and says who paid', () => {
  const base = { estimatedUsd: '0.00481378030088898', actualGasUnits: '477132', actualNative: '0.000003101358', ethUsd: '2428.20' };
  assert.deepEqual(proofFeeV1({ ...base, feePaidBy: 'wallet' }), {
    value: '≈ $0.0075',
    detail: 'paid by you · 0.0000031 ETH',
    row: { expected: '≈ $0.0048', actual: '≈ $0.0075 · paid by you', difference: '+$0.0027', tone: 'none' },
  });
  const sponsored = proofFeeV1({ ...base, feePaidBy: 'sponsor' });
  assert.equal(sponsored.value, '$0');
  assert.equal(sponsored.detail, 'sponsored · ≈ $0.0075 paid for you');
  assert.deepEqual(sponsored.row, { expected: '≈ $0.0048', actual: 'sponsored', difference: 'you paid $0', tone: 'good' });
  // No ETH price: the chain's own amount, not an invented dollar figure.
  assert.equal(proofFeeV1({ ...base, ethUsd: null, feePaidBy: 'wallet' }).value, '0.0000031 ETH');
  assert.equal(proofFeeV1({ ...base, feePaidBy: null }).row.actual, '≈ $0.0075 · payer not established');
});

test('a proof from before 2026-10-19 is never priced as the person’s fee', () => {
  // Its gas is the whole bundle's, strangers included.
  const legacy = proofFeeV1({
    estimatedUsd: '0.00481378030088898',
    actualGasUnits: '691569',
    actualNative: '0.000004149414',
    ethUsd: '2428.20',
    feePaidBy: undefined,
  });
  assert.deepEqual(legacy, {
    value: '691569',
    detail: 'gas, from the receipt',
    row: { expected: '≈ $0.0048', actual: '691569 gas', difference: '—', tone: 'none' },
  });
});
