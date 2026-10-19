import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { feeCalibrationFromSamplesV1, readFeeCalibrationV1, resetFeeCalibrationCacheV1 } from './feeCalibration.js';

// The three operations of 2026-10-19 that recorded their own gas: provider
// estimate, then what the operation used.
const OCTOBER_19 = [
  { estimated: '330498', actual: '496278' },
  { estimated: '330498', actual: '474358' },
  { estimated: '357363', actual: '570259' },
];

beforeEach(() => resetFeeCalibrationCacheV1());

describe('what an operation adds to a provider’s swap figure', () => {
  test('the median of the measured differences, from the person’s own operations first', () => {
    assert.deepEqual(feeCalibrationFromSamplesV1(OCTOBER_19.map((sample) => ({ ...sample, own: true }))), {
      overheadGasUnits: '165780',
      samples: 3,
      basis: 'your_operations',
    });
    const mixed = [
      { estimated: '330498', actual: '900000', own: false },
      { estimated: '330498', actual: '474358', own: true },
    ];
    assert.equal(feeCalibrationFromSamplesV1(mixed)?.overheadGasUnits, '143860', 'their own wallet, not a stranger’s');
    assert.deepEqual(feeCalibrationFromSamplesV1(OCTOBER_19.map((sample) => ({ ...sample, own: false })))?.basis, 'recent_operations');
  });

  test('nothing measured, nothing unreadable and nothing negative becomes a figure', () => {
    assert.equal(feeCalibrationFromSamplesV1([]), null);
    assert.equal(feeCalibrationFromSamplesV1([{ estimated: '0', actual: '496278', own: true }]), null, 'a missing estimate is not one');
    assert.equal(feeCalibrationFromSamplesV1([{ estimated: '330498', actual: null, own: true }]), null);
    assert.equal(feeCalibrationFromSamplesV1([{ estimated: '500000', actual: '400000', own: true }]), null);
  });

  test('read once per window, and a failed read is no figure rather than an error', async () => {
    let clock = 0;
    let reads = 0;
    const reader = async () => {
      reads += 1;
      return OCTOBER_19.map((sample) => ({ ...sample, own: true }));
    };
    await readFeeCalibrationV1('tenant-a', reader, () => clock);
    await readFeeCalibrationV1('tenant-a', reader, () => clock);
    assert.equal(reads, 1);
    clock += 10 * 60_000 + 1;
    await readFeeCalibrationV1('tenant-a', reader, () => clock);
    assert.equal(reads, 2);
    assert.equal(
      await readFeeCalibrationV1('tenant-b', async () => {
        throw new Error('database down');
      }),
      null,
    );
  });
});
