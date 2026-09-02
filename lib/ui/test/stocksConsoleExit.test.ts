import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { autoMeasureDecisionV1, exitEvidenceV1 } from '../src/console/stocksConsole';

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
    returnedAtomic: null,
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
          returnedAtomic: '99490000000',
          observedAt: OPEN_AT,
          lastMeasured: {
            roundTripCostBps: '9999',
            returnedAtomic: '10000000',
            observedAt: OLD_AT,
          },
        }),
      ],
      QUESTION,
    );
    assert.deepEqual(exit, {
      roundTripCostBps: '51',
      requestedCashAtomic: '100000000000',
      returnedCashAtomic: '99490000000',
      basis: 'open',
      observedAt: OPEN_AT,
    });
  });

  test('history is used when nothing is open, and is never relabelled as open', () => {
    // The ordinary state of this product: a router quote lives about twenty
    // seconds and the sampler runs on tens of minutes, so a reader almost
    // always gets the last completed run. Dropping it would hide the fact
    // exactly when it is most useful.
    const exit = exitEvidenceV1(
      [
        rung({
          // The rung's own open figure is absent, so the money must come from
          // the SAME run as the cost beside it — never half from each.
          returnedAtomic: null,
          lastMeasured: {
            roundTripCostBps: '9957',
            returnedAtomic: '430000000',
            observedAt: OLD_AT,
          },
        }),
      ],
      QUESTION,
    );
    assert.deepEqual(exit, {
      roundTripCostBps: '9957',
      requestedCashAtomic: '100000000000',
      returnedCashAtomic: '430000000',
      basis: 'last_measured',
      observedAt: OLD_AT,
    });
  });

  test('a rung that measured no round trip yields nothing, never a zero', () => {
    assert.equal(exitEvidenceV1([rung()], QUESTION), null);
    assert.equal(
      exitEvidenceV1(
        [
          rung({
            lastMeasured: { roundTripCostBps: null, returnedAtomic: null, observedAt: OLD_AT },
          }),
        ],
        QUESTION,
      ),
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

test('a cost with no returned amount still answers, without inventing the money', () => {
  // The percentage is derived FROM the two amounts, so rebuilding an amount
  // from the percentage would print a figure that was never measured. When one
  // side is missing the card falls back to the percentage alone.
  const exit = exitEvidenceV1(
    [
      {
        destination: 'USDC' as const,
        requestedCashAtomic: '100000000000',
        roundTripCostBps: '51',
        returnedAtomic: null,
        observedAt: OPEN_AT,
        lastMeasured: null,
      },
    ],
    QUESTION,
  );
  assert.equal(exit?.roundTripCostBps, '51');
  assert.equal(exit?.returnedCashAtomic, null);
  assert.equal(exit?.requestedCashAtomic, '100000000000');
});

// ---------------------------------------------------------------------------
// Phase 17.2 — measuring on interest, not on render.
//
// A router quote lives about twenty seconds and the sampler runs on a timer of
// tens of minutes, so a reader has essentially never arrived to an open quote.
// The answer is to measure when somebody chooses a question — and to refuse to
// measure the moment there is nothing to buy with the call, because a page that
// measures on every render is the sampler 10B.5 deliberately did not build.
// ---------------------------------------------------------------------------

describe('autoMeasureDecisionV1', () => {
  const base = { hasOpenQuote: false, anySupplyOutstanding: true, measurementInFlight: false };

  test('a chosen question with nothing open and something outstanding is measured', () => {
    assert.equal(autoMeasureDecisionV1(base), 'measure');
  });

  test('an open quote is already the answer', () => {
    assert.equal(autoMeasureDecisionV1({ ...base, hasOpenQuote: true }), 'already_open');
  });

  test('a security with nothing outstanding buys nothing with a router call', () => {
    // Nine of the thirteen Coinbase tokenized stocks are exactly this.
    assert.equal(
      autoMeasureDecisionV1({ ...base, anySupplyOutstanding: false }),
      'no_supply_outstanding',
    );
  });

  test('a measurement already running is not doubled', () => {
    assert.equal(autoMeasureDecisionV1({ ...base, measurementInFlight: true }), 'in_flight');
  });

  test('the cheapest refusal wins, so a call is never made to learn it was unnecessary', () => {
    assert.equal(
      autoMeasureDecisionV1({ hasOpenQuote: true, anySupplyOutstanding: false, measurementInFlight: true }),
      'already_open',
    );
  });
});
