import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  exitLadderIsInformativeV1,
  exitProbeLadderV1,
  priceImpactBpsV1,
  priceImpactLadderV1,
} from '../src/index.js';

describe('the probe ladder measures the size that was asked about', () => {
  test('the position itself is always a rung', () => {
    // The verdict compares capacity against the position. A ladder that
    // stopped short could only answer a question nobody asked.
    const ladder = exitProbeLadderV1('1000000', 4);
    assert.ok(ladder.includes('1000000'), ladder.join(', '));
  });

  test('the rungs halve, because depth falls off multiplicatively', () => {
    assert.deepEqual(exitProbeLadderV1('8000', 4), ['1000', '2000', '4000', '8000']);
  });

  test('a repeated rung is not probed twice', () => {
    // Halving a small position reaches the same integer twice, and a repeat is
    // a metered call that measures nothing new.
    const ladder = exitProbeLadderV1('3', 6);
    assert.deepEqual(ladder, ['1', '3']);
  });

  test('a position of nothing has nothing to probe', () => {
    assert.deepEqual(exitProbeLadderV1('0', 4), []);
  });

  test('the ladder is bounded whatever it is asked for', () => {
    assert.ok(exitProbeLadderV1('1000000000000000000000', 999).length <= 8);
    assert.equal(exitProbeLadderV1('1000000', 0).length, 1);
  });
});

describe('price impact is measured on the rate, not on the output', () => {
  test('a perfectly deep pool is zero impact, not one hundred percent', () => {
    // Comparing outputs directly would report twice the size as 100% slippage.
    assert.equal(
      priceImpactBpsV1({ referenceIn: 100n, referenceOut: 200n, probeIn: 200n, probeOut: 400n }),
      0,
    );
  });

  test('a shortfall against the reference rate is basis points of the expected output', () => {
    // Expected 400 at the reference rate, got 380 — a 5% shortfall.
    assert.equal(
      priceImpactBpsV1({ referenceIn: 100n, referenceOut: 200n, probeIn: 200n, probeOut: 380n }),
      500,
    );
  });

  test('impact rounds against the user', () => {
    // Expected 10000, got 9370: 6.30% exactly would be 630; anything worse
    // must round up, never down.
    assert.equal(
      priceImpactBpsV1({ referenceIn: 1n, referenceOut: 10_000n, probeIn: 1n, probeOut: 9369n }),
      631,
    );
  });

  test('a better-than-reference rate is zero, never a negative cost', () => {
    assert.equal(
      priceImpactBpsV1({ referenceIn: 100n, referenceOut: 200n, probeIn: 200n, probeOut: 420n }),
      0,
    );
  });

  test('a degenerate reference measures nothing rather than dividing by zero', () => {
    assert.equal(priceImpactBpsV1({ referenceIn: 0n, referenceOut: 1n, probeIn: 1n, probeOut: 1n }), null);
    assert.equal(priceImpactBpsV1({ referenceIn: 1n, referenceOut: 0n, probeIn: 1n, probeOut: 1n }), null);
  });
});

describe('the ladder turns quotes into probes without inventing any', () => {
  test('the smallest priced size is the reference, and it is named', () => {
    const ladder = priceImpactLadderV1([
      { sizeAtomic: '400', outputAtomic: '760' },
      { sizeAtomic: '100', outputAtomic: '200' },
      { sizeAtomic: '200', outputAtomic: '396' },
    ]);
    assert.equal(ladder.referenceSizeAtomic, '100');
    assert.deepEqual(ladder.probes, [
      { sizeAtomic: '100', slippageBps: 0 },
      { sizeAtomic: '200', slippageBps: 100 },
      { sizeAtomic: '400', slippageBps: 500 },
    ]);
  });

  test('a size the router could not price stays null, never a bad number', () => {
    // "No pool at this size" and "terrible price at this size" are different
    // answers, and only one of them is about the price.
    const ladder = priceImpactLadderV1([
      { sizeAtomic: '100', outputAtomic: '200' },
      { sizeAtomic: '400', outputAtomic: null },
    ]);
    assert.equal(ladder.probes[1]!.slippageBps, null);
  });

  test('a size that priced at zero cannot be the reference', () => {
    // A pool that exists but holds nothing quotes zero out. Using it as the
    // reference rate would make every larger probe look infinitely bad.
    const ladder = priceImpactLadderV1([
      { sizeAtomic: '50', outputAtomic: '0' },
      { sizeAtomic: '100', outputAtomic: '200' },
    ]);
    assert.equal(ladder.referenceSizeAtomic, '100');
  });

  test('nothing priced anywhere is nothing measured anywhere', () => {
    const ladder = priceImpactLadderV1([
      { sizeAtomic: '100', outputAtomic: null },
      { sizeAtomic: '200', outputAtomic: null },
    ]);
    assert.equal(ladder.referenceSizeAtomic, null);
    assert.ok(ladder.probes.every((probe) => probe.slippageBps === null));
  });
});

describe('a measurement says how much of one it is', () => {
  test('one priced probe is not a depth finding', () => {
    assert.equal(
      exitLadderIsInformativeV1({
        referenceSizeAtomic: '1000',
        positionAtomic: '1000',
        pricedProbeCount: 1,
      }),
      false,
    );
  });

  test('a reference the same size as the position measured one point', () => {
    // Two probes, but the smaller one failed to price, so the curve has no
    // span below the position.
    assert.equal(
      exitLadderIsInformativeV1({
        referenceSizeAtomic: '1000',
        positionAtomic: '1000',
        pricedProbeCount: 2,
      }),
      false,
    );
  });

  test('a reference below the position with two priced points is informative', () => {
    assert.equal(
      exitLadderIsInformativeV1({
        referenceSizeAtomic: '250',
        positionAtomic: '1000',
        pricedProbeCount: 3,
      }),
      true,
    );
  });

  test('nothing priced is never informative', () => {
    assert.equal(
      exitLadderIsInformativeV1({
        referenceSizeAtomic: null,
        positionAtomic: '1000',
        pricedProbeCount: 0,
      }),
      false,
    );
  });
});
