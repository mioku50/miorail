import assert from 'node:assert/strict';
import test from 'node:test';
import { computeRouteProofDeviationV1 } from '../src/deviation.js';

test('deviation: null when either amount is unknown', () => {
  assert.deepEqual(
    computeRouteProofDeviationV1({ expectedOutputAtomic: null, actualOutputAtomic: '100', minimumOutputAtomic: null }),
    { outputBps: null, minimumSatisfied: null },
  );
  assert.deepEqual(
    computeRouteProofDeviationV1({ expectedOutputAtomic: '100', actualOutputAtomic: null, minimumOutputAtomic: '90' }),
    { outputBps: null, minimumSatisfied: null },
  );
});

test('deviation: zero when actual equals expected', () => {
  const result = computeRouteProofDeviationV1({
    expectedOutputAtomic: '38000000000000000',
    actualOutputAtomic: '38000000000000000',
    minimumOutputAtomic: '37810000000000000',
  });
  assert.equal(result.outputBps, 0);
  assert.equal(result.minimumSatisfied, true);
});

test('deviation: positive bps when actual exceeds expected', () => {
  // actual = expected * 1.01 -> +100 bps
  const result = computeRouteProofDeviationV1({
    expectedOutputAtomic: '1000000',
    actualOutputAtomic: '1010000',
    minimumOutputAtomic: '950000',
  });
  assert.equal(result.outputBps, 100);
  assert.equal(result.minimumSatisfied, true);
});

test('deviation: negative bps when actual is below expected', () => {
  // actual = expected * 0.95 -> -500 bps
  const result = computeRouteProofDeviationV1({
    expectedOutputAtomic: '1000000',
    actualOutputAtomic: '950000',
    minimumOutputAtomic: '950000',
  });
  assert.equal(result.outputBps, -500);
  assert.equal(result.minimumSatisfied, true);
});

test('deviation: below minimum -> minimumSatisfied false', () => {
  const result = computeRouteProofDeviationV1({
    expectedOutputAtomic: '1000000',
    actualOutputAtomic: '900000',
    minimumOutputAtomic: '950000',
  });
  assert.equal(result.minimumSatisfied, false);
  assert.equal(result.outputBps, -1000);
});

test('deviation: minimumSatisfied stays null when no minimum is known', () => {
  const result = computeRouteProofDeviationV1({
    expectedOutputAtomic: '1000000',
    actualOutputAtomic: '1000000',
    minimumOutputAtomic: null,
  });
  assert.equal(result.minimumSatisfied, null);
});

test('deviation: rounds half away from zero using exact BigInt math (no float drift)', () => {
  // diff*10000/expected = 12345 * 10000 / 1000000 = 123.45 -> rounds to 123
  const roundedDown = computeRouteProofDeviationV1({
    expectedOutputAtomic: '1000000',
    actualOutputAtomic: '1012345',
    minimumOutputAtomic: null,
  });
  assert.equal(roundedDown.outputBps, 123);

  // diff*10000/expected = 12355 * 10000 / 1000000 = 123.55 -> rounds to 124
  const roundedUp = computeRouteProofDeviationV1({
    expectedOutputAtomic: '1000000',
    actualOutputAtomic: '1012355',
    minimumOutputAtomic: null,
  });
  assert.equal(roundedUp.outputBps, 124);

  // Large atomic amounts (18-decimal WETH scale) stay exact.
  const large = computeRouteProofDeviationV1({
    expectedOutputAtomic: '38000000000000000000',
    actualOutputAtomic: '37999999999999999999',
    minimumOutputAtomic: null,
  });
  assert.equal(large.outputBps, 0);
});
