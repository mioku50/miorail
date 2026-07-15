import assert from 'node:assert/strict';
import test from 'node:test';
import {
  atomicToHumanDecimal,
  basisPointsToPercentage,
  humanDecimalToAtomic,
  minimumOutputAtomic,
  percentageToBasisPoints,
} from '../src/index.js';

test('human decimals convert to atomic amounts without floating point arithmetic', () => {
  assert.equal(humanDecimalToAtomic('100.25', 6), '100250000');
  assert.equal(humanDecimalToAtomic('0.000000000000000001', 18), '1');
  assert.equal(humanDecimalToAtomic('1.0000001', 6), null);
});

test('atomic amounts convert to canonical human decimals', () => {
  assert.equal(atomicToHumanDecimal('100250000', 6), '100.25');
  assert.equal(atomicToHumanDecimal('1', 18), '0.000000000000000001');
});

test('percentage and basis point conversions are deterministic', () => {
  assert.equal(percentageToBasisPoints('0.5'), 50);
  assert.equal(percentageToBasisPoints('1.25'), 125);
  assert.equal(basisPointsToPercentage(50), '0.5');
});

test('minimum output uses integer arithmetic and rounds down', () => {
  assert.equal(minimumOutputAtomic('101', 50), '100');
  assert.equal(minimumOutputAtomic('1000000', 50), '995000');
});
