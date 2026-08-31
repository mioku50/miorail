import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { exitEvidenceV1 } from '../src/console/stocksConsole';

// ---------------------------------------------------------------------------
// The round trip at the size being asked.
//
// Written after the Market Route Coverage Audit measured six reviewed
// representations quoting and only four of them returning the money. Both legs
// were already stored and the cost between them already computed; nothing read
// it, because every surface asked the ladder whether a quote existed rather
// than what came back.
// ---------------------------------------------------------------------------

const QUESTION = { requestedCashAtomic: '100000000000', destination: 'USDC' as const };
const OPEN_AT = '2026-08-31T09:00:00.000Z';
const OLD_AT = '2026-08-31T08:00:00.000Z';

function rung(over: Partial<Parameters<typeof exitEvidenceV1>[0][number]> = {}) {
  return {
    destination: 'USDC' as const,
    requestedCashAtomic: '100000000000',
    roundTripCostBps: null,
    observedAt: null,
    lastMeasured: null,
    ...over,
  };
}

describe('the round trip at the size being asked', () => {
  test('an open quote is preferred, and says so', () => {
    const exit = exitEvidenceV1(
      [
        rung({
          roundTripCostBps: '51',
          observedAt: OPEN_AT,
          lastMeasured: { roundTripCostBps: '9999', observedAt: OLD_AT },
        }),
      ],
      QUESTION,
    );
    assert.deepEqual(exit, { roundTripCostBps: '51', basis: 'open', observedAt: OPEN_AT });
  });

  test('history is used when nothing is open, and is never relabelled as open', () => {
    // The ordinary state of this product: a router quote lives about twenty
    // seconds and the sampler runs on tens of minutes, so a reader almost
    // always gets the last completed run. Dropping it would hide the fact
    // exactly when it is most useful.
    const exit = exitEvidenceV1(
      [rung({ lastMeasured: { roundTripCostBps: '9957', observedAt: OLD_AT } })],
      QUESTION,
    );
    assert.deepEqual(exit, {
      roundTripCostBps: '9957',
      basis: 'last_measured',
      observedAt: OLD_AT,
    });
  });

  test('a rung that measured no round trip yields nothing, never a zero', () => {
    assert.equal(exitEvidenceV1([rung()], QUESTION), null);
    assert.equal(
      exitEvidenceV1([rung({ lastMeasured: { roundTripCostBps: null, observedAt: OLD_AT } })], QUESTION),
      null,
    );
  });

  test('the rung must match the exact question, not merely exist', () => {
    // A cost measured at $1,000 is not an answer about $100,000 — that is the
    // whole reason the ladder has rungs.
    assert.equal(
      exitEvidenceV1([rung({ requestedCashAtomic: '1000000000', roundTripCostBps: '51', observedAt: OPEN_AT })], QUESTION),
      null,
    );
    // And a destination the round trip was never computed for is not a match.
    assert.equal(
      exitEvidenceV1([rung({ destination: 'ETH', roundTripCostBps: '51', observedAt: OPEN_AT })], QUESTION),
      null,
    );
    assert.equal(exitEvidenceV1([], QUESTION), null);
  });
});
