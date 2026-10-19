import assert from 'node:assert/strict';
import test from 'node:test';
import { feeUsdLabelV1, operationFeeEstimateV1, proofFeeV1, proofOutputDifferenceV1 } from '../src/console/proofFigures';

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
    row: { expected: '≈ $0.0048 · swap', actual: '≈ $0.0075 · paid by you', difference: '+$0.0027', tone: 'none' },
  });
  const sponsored = proofFeeV1({ ...base, feePaidBy: 'sponsor' });
  assert.equal(sponsored.value, '$0');
  assert.equal(sponsored.detail, 'sponsored · ≈ $0.0075 paid for you');
  assert.deepEqual(sponsored.row, { expected: '≈ $0.0048 · swap', actual: 'sponsored', difference: 'you paid $0', tone: 'good' });
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
    row: { expected: '≈ $0.0048 · swap', actual: '691569 gas', difference: '—', tone: 'none' },
  });
});

test("the route screen's network cost adds what the wallet's own steps cost, once measured", () => {
  // 2026-10-19 15:42: KyberSwap priced its swap at 330,498 gas, $0.0048; the
  // operation used 496,278 and cost $0.0077. The server's median addition
  // over the three recorded operations was 165,780.
  const swap = { gasUnits: '330498', estimatedCostUsd: '0.004758128570541303' };
  assert.deepEqual(
    operationFeeEstimateV1({ ...swap, calibration: { overheadGasUnits: '165780', samples: 3, basis: 'your_operations' } }),
    { value: '≈ $0.0071', detail: 'swap $0.0048 + wallet $0.0024, measured on your last 3 swaps' },
  );
  assert.equal(
    operationFeeEstimateV1({ ...swap, calibration: { overheadGasUnits: '165780', samples: 1, basis: 'recent_operations' } }).detail,
    'swap $0.0048 + wallet $0.0024, measured on the last swap here',
  );
  // Unmeasured, the provider's figure stands and says whose it is.
  assert.deepEqual(operationFeeEstimateV1({ ...swap, calibration: null }), { value: '≈ $0.0048', detail: 'swap · est. 330498 gas' });
  assert.deepEqual(operationFeeEstimateV1({ gasUnits: '330498', estimatedCostUsd: null, calibration: null }), {
    value: '—',
    detail: 'est. 330498 gas',
  });
  assert.equal(operationFeeEstimateV1({ gasUnits: '0', estimatedCostUsd: null, calibration: null }).detail, 'provider supplied no gas estimate');
});
