import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  COLLECTING_HISTORY_COPY_V1,
  MEASURED_MOVE_LABEL_V1,
  exitCapacityLeadersV1,
  exitCoverageV1,
  measuredChangeBpsV1,
  measuredMoversV1,
  moversCollectingHistoryV1,
  type MarketObservationV1,
  type MarketRowV1,
  type MoverPairV1,
} from '../src/marketRails.js';

// ---------------------------------------------------------------------------
// T73 §7 — the five ways these rails would lie if nobody checked.
//
// A market rail is read at a glance and acted on without being re-read, which
// makes it the highest-leverage place in the product for a number that is
// technically derived and practically false. Every test here is a specific
// false number the projection must refuse to produce.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-05T12:00:00.000Z');
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TOLERANCE = 300;

function observation(overrides: Partial<MarketObservationV1> = {}): MarketObservationV1 {
  return {
    tokenAddress: '0xb200000000000000000000d6f666fe8b27595c01',
    state: 'provisional',
    reasonCode: 'quoted_pre_entry',
    referenceQuoteAsset: USDC,
    referencePositionAtomic: '100000000',
    profileIdentity: `${USDC}:100000000:300:300`,
    measurementVersion: 'b20-observation/v1',
    entryOutputAtomic: '4000000000000000000000',
    optimisticRoundTripBps: 130,
    largestPassingSizeAtomic: '4000000000000000000000',
    firstFailingSizeAtomic: '8000000000000000000000',
    capacityToleranceBps: TOLERANCE,
    capacityStable: true,
    exitRouteFound: true,
    transfersPaused: false,
    transferPolicyState: 'open',
    controlsComplete: true,
    controlsBlockNumber: '49531075',
    observationBlockNumber: '49531075',
    measuredAt: '2026-08-05T11:50:00.000Z',
    staleAfter: '2026-08-05T12:20:00.000Z',
    ...overrides,
  };
}

function row(
  address: string,
  observationOverrides: Partial<MarketObservationV1> = {},
  launchOverrides: Partial<MarketRowV1['launch']> = {},
): MarketRowV1 {
  return {
    launch: {
      tokenAddress: address,
      symbol: 'DINo1',
      name: 'o1 mascot',
      decimals: 18,
      canonical: true,
      ...launchOverrides,
    },
    observation: observation({ tokenAddress: address, ...observationOverrides }),
  };
}

const A = '0xaa00000000000000000000000000000000000001';
const B = '0xbb00000000000000000000000000000000000002';
const C = '0xcc00000000000000000000000000000000000003';

describe('§2 — Exit Capacity Leaders rank what actually passed', () => {
  const leadersOf = (rows: MarketRowV1[], limit = 5) =>
    exitCapacityLeadersV1({ rows, toleranceBps: TOLERANCE, now: NOW, limit });

  test('ranked by the largest passing probe, descending', () => {
    const result = leadersOf([
      row(A, { largestPassingSizeAtomic: '1000' }),
      row(B, { largestPassingSizeAtomic: '9000' }),
      row(C, { largestPassingSizeAtomic: '5000' }),
    ]);
    assert.deepEqual(result.leaders.map((entry) => entry.tokenAddress), [B, C, A]);
  });

  test('the ranking is deterministic when two tokens tie', () => {
    // Without a tiebreak the rail reorders itself on every refresh and a user
    // reads movement into noise.
    const rows = [row(C, { largestPassingSizeAtomic: '5000' }), row(A, { largestPassingSizeAtomic: '5000' })];
    const first = leadersOf(rows).leaders.map((entry) => entry.tokenAddress);
    const second = leadersOf([...rows].reverse()).leaders.map((entry) => entry.tokenAddress);
    assert.deepEqual(first, second);
    assert.deepEqual(first, [A, C]);
  });

  test('a stale observation is excluded, not ranked', () => {
    const result = leadersOf([row(A, { staleAfter: '2026-08-05T11:00:00.000Z' })]);
    assert.deepEqual(result.leaders, []);
    assert.deepEqual(result.excluded, [{ tokenAddress: A, reason: 'stale' }]);
  });

  test('an unstable ladder is excluded', () => {
    // A size passed ABOVE one that failed, so "largest passing" bounds nothing.
    const result = leadersOf([row(A, { capacityStable: false }), row(B, { capacityStable: null })]);
    assert.deepEqual(result.leaders, []);
    assert.deepEqual(result.excluded.map((entry) => entry.reason), ['unstable_ladder', 'unstable_ladder']);
  });

  test('paused transfers, a missing exit route and incomplete controls are each excluded', () => {
    const result = leadersOf([
      row(A, { transfersPaused: true }),
      row(B, { exitRouteFound: false }),
      row(C, { controlsComplete: false }),
    ]);
    assert.deepEqual(result.leaders, []);
    assert.deepEqual(
      result.excluded.map((entry) => entry.reason).sort(),
      ['controls_incomplete', 'no_exit_route', 'transfers_paused'],
    );
  });

  test('a ladder measured against a different tolerance is not ranked beside these', () => {
    // §2 — ONE configured tolerance. A 500bps ladder produces a larger passing
    // size for the same pool, and mixing the two invents a leader.
    const result = leadersOf([row(A, { capacityToleranceBps: 500 })]);
    assert.deepEqual(result.excluded, [{ tokenAddress: A, reason: 'different_tolerance' }]);
  });

  test('a non-canonical launch never appears', () => {
    const result = leadersOf([row(A, {}, { canonical: false })]);
    assert.deepEqual(result.excluded, [{ tokenAddress: A, reason: 'not_canonical' }]);
  });

  test('capacity is carried as a bound, never as one number', () => {
    const leader = leadersOf([row(A)]).leaders[0]!;
    assert.equal(leader.largestPassingSizeAtomic, '4000000000000000000000');
    assert.equal(leader.firstFailingSizeAtomic, '8000000000000000000000');
    // There is no field an interpolated figure could occupy.
    assert.ok(!('estimatedCapacityAtomic' in leader));
    assert.ok(!('capacityAtomic' in leader));
  });

  test('a rejected token with real capacity is listed, and says it is rejected', () => {
    // It genuinely has the measured capacity; hiding it would make the rail a
    // curated list rather than a measurement. The state travels with it.
    const leader = leadersOf([row(A, { state: 'rejected', reasonCode: 'round_trip_above_tolerance' })]).leaders[0]!;
    assert.equal(leader.state, 'rejected');
    assert.equal(leader.reasonCode, 'round_trip_above_tolerance');
  });

  test('the list is capped at the requested size', () => {
    const rows = [A, B, C].map((address, index) => row(address, { largestPassingSizeAtomic: String(1000 + index) }));
    assert.equal(leadersOf(rows, 2).leaders.length, 2);
  });
});

// ---------------------------------------------------------------------------
// §3 — 24h Measured Movers
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function pair(
  address: string,
  latestOverrides: Partial<MarketObservationV1> = {},
  baselineOverrides: Partial<MarketObservationV1> | null = {},
  launchOverrides: Partial<MoverPairV1['launch']> = {},
): MoverPairV1 {
  return {
    launch: { tokenAddress: address, symbol: 'DINo1', name: 'o1 mascot', decimals: 18, canonical: true, ...launchOverrides },
    latest: observation({ tokenAddress: address, ...latestOverrides }),
    baseline:
      baselineOverrides === null
        ? null
        : observation({
            tokenAddress: address,
            measuredAt: '2026-08-04T11:50:00.000Z',
            staleAfter: '2026-08-04T12:20:00.000Z',
            ...baselineOverrides,
          }),
  };
}

const moversOf = (pairs: MoverPairV1[], limit = 5) =>
  measuredMoversV1({
    pairs,
    now: NOW,
    baselineAgeMs: DAY_MS,
    baselineToleranceMs: 4 * 60 * 60 * 1000,
    minExitCapacityAtomic: '1000000000000000000',
    limit,
  });

describe('§3 — a 24h move is two measured quotes, divided', () => {
  test('the change is integer arithmetic on the implied price', () => {
    // The reference position is fixed, so fewer tokens for the same USDC means
    // a higher price. 4000 -> 3200 tokens is a 25% rise: 4000/3200 - 1.
    assert.equal(
      measuredChangeBpsV1({ entryOutputThenAtomic: '4000', entryOutputNowAtomic: '3200' }),
      2500,
    );
    // And the fall: 4000 -> 5000 tokens is a 20% drop.
    assert.equal(
      measuredChangeBpsV1({ entryOutputThenAtomic: '4000', entryOutputNowAtomic: '5000' }),
      -2000,
    );
    assert.equal(
      measuredChangeBpsV1({ entryOutputThenAtomic: '4000', entryOutputNowAtomic: '4000' }),
      0,
    );
  });

  test('an 18-decimal amount keeps every digit', () => {
    // A float here turns the operand into scientific notation and the answer
    // into a plausible-looking approximation.
    const change = measuredChangeBpsV1({
      entryOutputThenAtomic: '4000000000000000000001',
      entryOutputNowAtomic: '4000000000000000000000',
    });
    assert.equal(change, 0);
  });

  test('the metric is labelled, and never as performance', () => {
    const mover = moversOf([pair(A, {}, { entryOutputAtomic: '5000000000000000000000' })]).movers[0]!;
    assert.equal(mover.label, MEASURED_MOVE_LABEL_V1);
    assert.equal(MEASURED_MOVE_LABEL_V1, '24h change from Miorail measured quotes');
    assert.ok(!/performance|gainer|market[- ]wide|return/i.test(MEASURED_MOVE_LABEL_V1));
  });

  test('the real interval is reported, so "24h" is never a rounded lie', () => {
    const mover = moversOf([
      pair(A, {}, { measuredAt: '2026-08-04T09:50:00.000Z', entryOutputAtomic: '5000000000000000000000' }),
    ]).movers[0]!;
    assert.equal(mover.intervalSeconds, 26 * 60 * 60);
  });

  test('a missing baseline excludes the token rather than assuming no change', () => {
    const result = moversOf([pair(A, {}, null)]);
    assert.deepEqual(result.movers, []);
    assert.deepEqual(result.excluded, [{ tokenAddress: A, reason: 'no_baseline' }]);
  });

  test('a baseline outside the window is refused, not stretched', () => {
    // Three days back is not a 24h change, however tempting the number is.
    const result = moversOf([pair(A, {}, { measuredAt: '2026-08-02T11:50:00.000Z' })]);
    assert.deepEqual(result.excluded, [{ tokenAddress: A, reason: 'baseline_outside_window' }]);
  });

  test('a different profile or measurement version is incomparable', () => {
    assert.deepEqual(moversOf([pair(A, {}, { profileIdentity: 'other' })]).excluded, [
      { tokenAddress: A, reason: 'incompatible_profile' },
    ]);
    assert.deepEqual(moversOf([pair(A, {}, { referencePositionAtomic: '50000000' })]).excluded, [
      { tokenAddress: A, reason: 'incompatible_profile' },
    ]);
    assert.deepEqual(moversOf([pair(A, {}, { measurementVersion: 'b20-observation/v2' })]).excluded, [
      { tokenAddress: A, reason: 'incompatible_version' },
    ]);
  });

  test('unknown decimals exclude the token', () => {
    assert.deepEqual(moversOf([pair(A, {}, {}, { decimals: null })]).excluded, [
      { tokenAddress: A, reason: 'unknown_decimals' },
    ]);
  });

  test('§7 — a thin pool is excluded before it can produce a huge percentage', () => {
    // The exact defect this guards: a token whose measured exit capacity is a
    // rounding error swings hundreds of percent on quotes nobody could act on,
    // and lands at the top of a rail sorted by absolute move.
    const result = moversOf([pair(A, { largestPassingSizeAtomic: '1000' })]);
    assert.deepEqual(result.excluded, [{ tokenAddress: A, reason: 'below_minimum_capacity' }]);
  });

  test('rejected, unmeasured and unstable observations never become movers', () => {
    assert.deepEqual(moversOf([pair(A, { state: 'rejected', reasonCode: 'no_exit_route' })]).excluded, [
      { tokenAddress: A, reason: 'not_measured' },
    ]);
    assert.deepEqual(moversOf([pair(A, { state: 'unmeasured', reasonCode: 'quote_unavailable' })]).excluded, [
      { tokenAddress: A, reason: 'not_measured' },
    ]);
    assert.deepEqual(moversOf([pair(A, { capacityStable: false })]).excluded, [
      { tokenAddress: A, reason: 'unstable_ladder' },
    ]);
    // Including on the baseline side.
    assert.deepEqual(moversOf([pair(A, {}, { capacityStable: false })]).excluded, [
      { tokenAddress: A, reason: 'unstable_ladder' },
    ]);
  });

  test('a stale latest observation is not a current move', () => {
    assert.deepEqual(moversOf([pair(A, { staleAfter: '2026-08-05T11:00:00.000Z' })]).excluded, [
      { tokenAddress: A, reason: 'stale' },
    ]);
  });

  test('sorted by absolute move, so a fall ranks like a rise', () => {
    const result = moversOf([
      pair(A, {}, { entryOutputAtomic: '4200000000000000000000' }),
      pair(B, {}, { entryOutputAtomic: '2000000000000000000000' }),
      pair(C, {}, { entryOutputAtomic: '8000000000000000000000' }),
    ]);
    // Latest output is 4000e18 for all three; only the baseline differs.
    // C bought 8000 a day ago and 4000 now — the price doubled, +10000bps.
    // B bought 2000 then and 4000 now — the price halved, -5000bps.
    // A moved +500bps. Sorted by ABSOLUTE move, a halving outranks a nudge.
    assert.deepEqual(result.movers.map((entry) => entry.tokenAddress), [C, B, A]);
    assert.deepEqual(result.movers.map((entry) => entry.changeBps), [10_000, -5_000, 500]);
  });

  test('a zero entry output is refused rather than divided by', () => {
    assert.deepEqual(moversOf([pair(A, { entryOutputAtomic: '0' })]).excluded, [
      { tokenAddress: A, reason: 'not_measured' },
    ]);
    assert.throws(() => measuredChangeBpsV1({ entryOutputThenAtomic: '1', entryOutputNowAtomic: '0' }));
  });

  test('"Collecting 24h history" only when time is the ONLY thing missing', () => {
    // Otherwise a user waits for a list that is never coming.
    assert.equal(moversCollectingHistoryV1(moversOf([pair(A, {}, null)])), true);
    assert.equal(
      moversCollectingHistoryV1(moversOf([pair(A, { largestPassingSizeAtomic: '1000' })])),
      false,
    );
    assert.equal(moversCollectingHistoryV1(moversOf([])), false);
    assert.equal(COLLECTING_HISTORY_COPY_V1, 'Collecting 24h history');
  });
});

// ---------------------------------------------------------------------------
// §4 — Your Exit Coverage
// ---------------------------------------------------------------------------

describe('§4 — coverage is the measured exit against what you actually hold', () => {
  const coverage = (positionAtomic: string, overrides: Partial<MarketObservationV1> | null = {}) =>
    exitCoverageV1({
      tokenAddress: A,
      symbol: 'DINo1',
      decimals: 18,
      positionAtomic,
      observation: overrides === null ? null : observation(overrides),
      now: NOW,
    });

  test('a position inside the measured capacity is covered', () => {
    const result = coverage('2000000000000000000000');
    assert.equal(result.verdict, 'covered');
    assert.equal(result.coverageBps, 10_000);
    assert.match(result.note, /measured bound, not a guarantee/);
  });

  test('coverage is capped rather than reported as 340%', () => {
    const result = coverage('1000000000000000000000');
    assert.equal(result.coverageBps, 10_000);
  });

  test('a position larger than the measured exit is partial, and says what is unknown', () => {
    const result = coverage('8000000000000000000000');
    assert.equal(result.verdict, 'partial');
    assert.equal(result.coverageBps, 5_000);
    assert.match(result.note, /unknown rather than impossible/);
  });

  test('a position far above the measured exit is uncovered', () => {
    const result = coverage('100000000000000000000000');
    assert.equal(result.verdict, 'uncovered');
  });

  test('no measurement is unmeasured, never zero coverage', () => {
    // A 0% would read as "you cannot sell this", which is a claim nothing
    // measured.
    for (const missing of [null, { largestPassingSizeAtomic: null }]) {
      const result = coverage('1000', missing as never);
      assert.equal(result.verdict, 'unmeasured');
      assert.equal(result.coverageBps, null);
      assert.equal(result.measuredCapacityAtomic, null);
    }
  });

  test('a stale measurement keeps its numbers and says it is stale', () => {
    const result = coverage('2000000000000000000000', { staleAfter: '2026-08-05T11:00:00.000Z' });
    assert.equal(result.freshness, 'stale');
    assert.equal(result.coverageBps, 10_000);
  });

  test('the control change that matters is surfaced', () => {
    assert.match(coverage('1000', { transfersPaused: true }).controlNote ?? '', /cannot be sold while/);
    assert.match(coverage('1000', { transferPolicyState: 'restricted' }).controlNote ?? '', /admits your wallet/);
    assert.match(coverage('1000', { controlsComplete: false }).controlNote ?? '', /incomplete/);
    assert.equal(coverage('1000').controlNote, null);
  });
});

describe('§6 — no dimension Miorail did not measure', () => {
  test('the module names none of the forbidden metrics', () => {
    const source = readFileSync(new URL('../src/marketRails.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const banned of [
      'volume',
      'uniqueBuyers',
      'unique_buyers',
      'marketCap',
      'market_cap',
      'holderConcentration',
      'aiScore',
      'predictedReturn',
      'prediction',
      'sentiment',
    ]) {
      assert.ok(!code.toLowerCase().includes(banned.toLowerCase()), `marketRails.ts computes ${banned}`);
    }
  });

  test('no output object carries a score or a rating', () => {
    const leader = exitCapacityLeadersV1({ rows: [row(A)], toleranceBps: TOLERANCE, now: NOW, limit: 5 }).leaders[0]!;
    const mover = moversOf([pair(A, {}, { entryOutputAtomic: '5000000000000000000000' })]).movers[0]!;
    for (const payload of [leader, mover] as unknown as Record<string, unknown>[]) {
      for (const key of Object.keys(payload)) {
        assert.ok(!/score|rating|rank|grade|confidence/i.test(key), `a payload exposes ${key}`);
      }
    }
  });
});
