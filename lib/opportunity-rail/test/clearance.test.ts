import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  OPPORTUNITY_PROFILE_BOUNDS_V1,
  OPPORTUNITY_REJECTION_COPY_V1,
  OPPORTUNITY_REJECTION_COPY_V2,
  OPPORTUNITY_QUOTE_ASSET_V1,
  OpportunityProfileV2Schema,
  ROUND_TRIP_CALL_INDEX_V1,
  certifyRoundTripV1,
  coverageV1,
  entryOutputFromSimulationV1,
  minimumOutputV1,
  opportunityHeadlineV2,
  profileIdentityV1,
  profileRefusalV1,
  provisionalOutcomeV1,
  type OpportunityProfileV2,
} from '../src/index.js';

const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const USDC = OPPORTUNITY_QUOTE_ASSET_V1;

const PROFILE: OpportunityProfileV2 = {
  quoteAsset: USDC,
  positionAtomic: '100000000',
  maxRoundTripBps: 300,
  maxExitSlippageBps: 300,
};

describe('the profile is the user’s, not a server constant', () => {
  test('the defaults live in the UI, and the wire takes whatever was chosen', () => {
    assert.deepEqual(OpportunityProfileV2Schema.parse({ ...PROFILE, positionAtomic: '500000000' }), {
      ...PROFILE,
      positionAtomic: '500000000',
    });
  });

  test('a round trip must start and end in the same asset', () => {
    assert.throws(() =>
      OpportunityProfileV2Schema.parse({ ...PROFILE, quoteAsset: TOKEN }),
    );
  });

  test('changing any field is a different evaluation', () => {
    const base = profileIdentityV1(PROFILE);
    assert.notEqual(base, profileIdentityV1({ ...PROFILE, positionAtomic: '100000001' }));
    assert.notEqual(base, profileIdentityV1({ ...PROFILE, maxRoundTripBps: 301 }));
    assert.notEqual(base, profileIdentityV1({ ...PROFILE, maxExitSlippageBps: 301 }));
    // A cached answer for one profile must be unable to collide with another,
    // not merely unlikely to.
    assert.equal(base, profileIdentityV1({ ...PROFILE }));
  });

  test('bounds are checked on integers, never through a float', () => {
    assert.equal(profileRefusalV1(PROFILE), null);
    assert.equal(
      profileRefusalV1({ ...PROFILE, positionAtomic: '999999' }),
      'position_below_minimum',
    );
    assert.equal(
      profileRefusalV1({ ...PROFILE, positionAtomic: '99999999999' }),
      'position_above_maximum',
    );
    assert.equal(
      profileRefusalV1({ ...PROFILE, maxRoundTripBps: 6_000 }),
      'round_trip_tolerance_too_wide',
    );
    assert.equal(
      profileRefusalV1({ ...PROFILE, maxExitSlippageBps: 6_000 }),
      'slippage_tolerance_too_wide',
    );
  });

  test('a position at the exact bound is allowed', () => {
    assert.equal(
      profileRefusalV1({
        ...PROFILE,
        positionAtomic: OPPORTUNITY_PROFILE_BOUNDS_V1.minPositionAtomic.toString(),
      }),
      null,
    );
  });
});

describe('an optimistic quote may reject, and may never certify', () => {
  test('a quoted pre-entry pass is provisional, never qualified', () => {
    // The whole point of the four states. Certifying from the one measurement
    // that systematically overstates would put the product's one affirmative
    // claim on its least reliable number.
    const outcome = provisionalOutcomeV1({
      measurement: 'quoted_pre_entry',
      quotedVerdict: { status: 'qualifies' },
    });
    assert.deepEqual(outcome, { viability: 'provisional', reason: 'quoted_pre_entry' });
  });

  test('a quoted pre-entry failure is a sound rejection', () => {
    // If the flattering number already fails, the real one fails by more.
    const outcome = provisionalOutcomeV1({
      measurement: 'quoted_pre_entry',
      quotedVerdict: { status: 'rejected', reason: 'round_trip_above_tolerance' },
    });
    assert.deepEqual(outcome, { viability: 'rejected', reason: 'round_trip_above_tolerance' });
  });

  test('a degraded search is unmeasured, not a verdict about the token', () => {
    const outcome = provisionalOutcomeV1({
      measurement: null,
      quotedVerdict: { status: 'unmeasured', reason: 'endpoint_degraded' },
    });
    assert.deepEqual(outcome, { viability: 'unmeasured', reason: 'endpoint_degraded' });
  });

  test('only a simulated measurement reaches qualified', () => {
    const outcome = provisionalOutcomeV1({
      measurement: 'simulated',
      quotedVerdict: { status: 'qualifies' },
    });
    assert.deepEqual(outcome, { viability: 'qualified' });
  });
});

describe('viability and coverage are different questions', () => {
  test('one proven route with silent alternatives is viable, not best', () => {
    const result = coverageV1({ candidatesTotal: 6, candidatesAnswered: 4, simulationProvedRoute: true });
    assert.deepEqual(result, {
      coverage: 'partial',
      viableRouteConfirmed: true,
      bestRouteConfirmed: false,
    });
  });

  test('a complete search that proved a route confirms both', () => {
    const result = coverageV1({ candidatesTotal: 6, candidatesAnswered: 6, simulationProvedRoute: true });
    assert.equal(result.coverage, 'complete');
    assert.equal(result.bestRouteConfirmed, true);
  });

  test('a complete search that proved nothing confirms nothing', () => {
    const result = coverageV1({ candidatesTotal: 6, candidatesAnswered: 6, simulationProvedRoute: false });
    assert.equal(result.viableRouteConfirmed, false);
    assert.equal(result.bestRouteConfirmed, false);
  });

  test('the headline never collapses viable-but-not-best into either extreme', () => {
    const line = opportunityHeadlineV2({ viability: 'qualified' }, {
      coverage: 'partial',
      viableRouteConfirmed: true,
      bestRouteConfirmed: false,
    });
    assert.match(line, /Viable route confirmed/);
    assert.match(line, /best route not confirmed/);
    // Neither of the two things it must never say.
    assert.ok(!/no exit/i.test(line));
    assert.ok(!/\bbest route\b(?! not)/.test(line));
  });

  test('no surface may say safe, score, rating or guaranteed', () => {
    const lines = [
      opportunityHeadlineV2({ viability: 'qualified' }, null),
      opportunityHeadlineV2({ viability: 'provisional', reason: 'quoted_pre_entry' }, null),
      opportunityHeadlineV2({ viability: 'unmeasured', reason: 'endpoint_degraded' }, null),
      opportunityHeadlineV2({ viability: 'rejected', reason: 'transfers_paused' }, null),
    ];
    for (const line of lines) {
      assert.ok(
        !/\b(safe|score|rating|promising|likely profit|guaranteed)\b/i.test(line),
        line,
      );
    }
  });
});

describe('a round trip is certified from what the wallet actually moved', () => {
  const call = (index: number, status: 'success' | 'reverted' = 'success') => ({ index, status });
  const okCalls = [call(0), call(1), call(2), call(3)];
  const move = (
    token: string,
    direction: 'in' | 'out',
    amountAtomic: string,
    callIndex: number,
  ) => ({ token, direction, amountAtomic, callIndex });

  const certified = () =>
    certifyRoundTripV1({
      quoteAsset: USDC,
      tokenAddress: TOKEN,
      positionAtomic: '100000000',
      calls: okCalls,
      assetChangesAvailable: true,
      assetChanges: [
        move(USDC, 'out', '100000000', ROUND_TRIP_CALL_INDEX_V1.entrySwap),
        move(TOKEN, 'in', '4200000000000000000000', ROUND_TRIP_CALL_INDEX_V1.entrySwap),
        move(TOKEN, 'out', '4200000000000000000000', ROUND_TRIP_CALL_INDEX_V1.exitSwap),
        move(USDC, 'in', '99000000', ROUND_TRIP_CALL_INDEX_V1.exitSwap),
      ],
    });

  test('a full sequence certifies, and the cost is measured not quoted', () => {
    const result = certified();
    assert.equal(result.status, 'certified');
    if (result.status === 'certified') {
      assert.equal(result.spentAtomic, '100000000');
      assert.equal(result.returnedAtomic, '99000000');
      // 1% lost, rounded against the user.
      assert.equal(result.costBps, 100);
    }
  });

  test('the exit must sell exactly what the entry produced', () => {
    // An exit that sold a quoted amount while the entry produced something
    // else measured two positions and reported one number.
    const result = certifyRoundTripV1({
      quoteAsset: USDC,
      tokenAddress: TOKEN,
      positionAtomic: '100000000',
      calls: okCalls,
      assetChangesAvailable: true,
      assetChanges: [
        move(USDC, 'out', '100000000', ROUND_TRIP_CALL_INDEX_V1.entrySwap),
        move(TOKEN, 'in', '4200000000000000000000', ROUND_TRIP_CALL_INDEX_V1.entrySwap),
        move(TOKEN, 'out', '4199000000000000000000', ROUND_TRIP_CALL_INDEX_V1.exitSwap),
        move(USDC, 'in', '99000000', ROUND_TRIP_CALL_INDEX_V1.exitSwap),
      ],
    });
    assert.equal(result.status, 'undecodable');
    if (result.status === 'undecodable') assert.match(result.reason, /exactly what the entry produced/);
  });

  test('a revert is named by call, and never certifies', () => {
    const result = certifyRoundTripV1({
      quoteAsset: USDC,
      tokenAddress: TOKEN,
      positionAtomic: '100000000',
      calls: [call(0), call(1), call(2), call(3, 'reverted')],
      assetChangesAvailable: true,
      assetChanges: [],
    });
    assert.deepEqual(result, { status: 'reverted', callIndex: 3 });
  });

  test('a wrong call count fails closed', () => {
    const result = certifyRoundTripV1({
      quoteAsset: USDC,
      tokenAddress: TOKEN,
      positionAtomic: '100000000',
      calls: [call(0), call(1)],
      assetChangesAvailable: true,
      assetChanges: [],
    });
    assert.equal(result.status, 'undecodable');
  });

  test('a simulation that proved no movements certifies nothing', () => {
    const result = certifyRoundTripV1({
      quoteAsset: USDC,
      tokenAddress: TOKEN,
      positionAtomic: '100000000',
      calls: okCalls,
      assetChangesAvailable: false,
      assetChanges: [],
    });
    assert.equal(result.status, 'undecodable');
    if (result.status === 'undecodable') assert.match(result.reason, /no asset movements/);
  });

  test('a spend that is not the requested position is not this profile’s answer', () => {
    const result = certifyRoundTripV1({
      quoteAsset: USDC,
      tokenAddress: TOKEN,
      positionAtomic: '500000000',
      calls: okCalls,
      assetChangesAvailable: true,
      assetChanges: [
        move(USDC, 'out', '100000000', ROUND_TRIP_CALL_INDEX_V1.entrySwap),
        move(TOKEN, 'in', '42', ROUND_TRIP_CALL_INDEX_V1.entrySwap),
        move(TOKEN, 'out', '42', ROUND_TRIP_CALL_INDEX_V1.exitSwap),
        move(USDC, 'in', '99000000', ROUND_TRIP_CALL_INDEX_V1.exitSwap),
      ],
    });
    assert.equal(result.status, 'undecodable');
  });

  test('movements from another call index are not counted', () => {
    // A transfer in the approval call is not the swap's output.
    const result = certifyRoundTripV1({
      quoteAsset: USDC,
      tokenAddress: TOKEN,
      positionAtomic: '100000000',
      calls: okCalls,
      assetChangesAvailable: true,
      assetChanges: [
        move(USDC, 'out', '100000000', ROUND_TRIP_CALL_INDEX_V1.approveEntry),
        move(TOKEN, 'in', '42', ROUND_TRIP_CALL_INDEX_V1.entrySwap),
        move(TOKEN, 'out', '42', ROUND_TRIP_CALL_INDEX_V1.exitSwap),
        move(USDC, 'in', '99000000', ROUND_TRIP_CALL_INDEX_V1.exitSwap),
      ],
    });
    assert.equal(result.status, 'undecodable');
    if (result.status === 'undecodable') assert.match(result.reason, /no quote asset left the wallet/);
  });
});

describe('the exit amount comes from the simulated entry, not from a quote', () => {
  test('the first pass measures what the entry actually produced', () => {
    const result = entryOutputFromSimulationV1({
      tokenAddress: TOKEN,
      calls: [{ index: 0, status: 'success' }, { index: 1, status: 'success' }],
      assetChangesAvailable: true,
      assetChanges: [
        { token: TOKEN, direction: 'in', amountAtomic: '4200000000000000000000', callIndex: 1 },
      ],
    });
    assert.deepEqual(result, { status: 'measured', acquiredAtomic: '4200000000000000000000' });
  });

  test('a reverted entry probe measures nothing', () => {
    const result = entryOutputFromSimulationV1({
      tokenAddress: TOKEN,
      calls: [{ index: 0, status: 'success' }, { index: 1, status: 'reverted' }],
      assetChangesAvailable: true,
      assetChanges: [],
    });
    assert.deepEqual(result, { status: 'reverted', callIndex: 1 });
  });
});

describe('a minimum output is integer arithmetic, rounded down', () => {
  test('the floor never exceeds what the tolerance allows', () => {
    assert.equal(minimumOutputV1('1000000', 300), '970000');
    assert.equal(minimumOutputV1('1', 300), '0');
    // 3.33% off an odd number: 966699.0333 floors to 966699, below the exact
    // value and never above it.
    assert.equal(minimumOutputV1('999999', 333), '966699');
  });

  test('a zero tolerance is the quoted amount exactly', () => {
    assert.equal(minimumOutputV1('1000000', 0), '1000000');
  });
});


// ---------------------------------------------------------------------------
// A route refusal is bounded by what was asked, and by who was asked.
//
// The two tables below are what a surface — including an MCP client driving
// this from another model — shows a person when nothing could be priced. They
// are the last place the reading is still ours; after that it is prose in
// somebody else's conversation.
//
// `no_exit_route` was reworded on 2026-08-09 to stop claiming that no route
// exists anywhere. `no_entry_route`, one row above it in both tables, was not,
// and went on saying "No route into this token exists at this size" — an
// existence claim about Base, from a KyberSwap 4008 that means the approved
// sources would not price a buy at one size at one moment.
//
// So the rule is pinned rather than the sentence: a refusal that reports the
// absence of a route must bound the claim, and must not assert that none
// exists.
// ---------------------------------------------------------------------------
describe('an absent route is a reading, not a fact about Base', () => {
  const ROUTE_ABSENCE_V1 = ['no_entry_route', 'no_exit_route'] as const;
  const BOUND_V1 = /measured size|approved sources|at one size|not proof/i;
  const UNBOUNDED_V1 = [
    /\bno route (into|out of|for)?\s*this token exists\b/i,
    /\bdoes not exist\b/i,
    /\bnobody\b/i,
    /\bno market\b/i,
    /\bcannot be (sold|bought|traded)\b/i,
    /\bon Base\b/i,
  ];

  for (const [label, table] of [
    ['V1', OPPORTUNITY_REJECTION_COPY_V1 as Record<string, string>],
    ['V2', OPPORTUNITY_REJECTION_COPY_V2 as Record<string, string>],
  ] as const) {
    test(`${label} bounds every route-absence sentence`, () => {
      for (const reason of ROUTE_ABSENCE_V1) {
        const copy = table[reason];
        assert.ok(copy, `${label} ${reason} has no copy`);
        assert.match(copy, BOUND_V1, `${label} ${reason} states an unbounded absence`);
        for (const pattern of UNBOUNDED_V1) {
          assert.doesNotMatch(copy, pattern, `${label} ${reason} claims more than was measured`);
        }
      }
    });
  }

  test('the two tables agree about what an absent entry route means', () => {
    // Two copies of one vocabulary is how the fix reached one of them and not
    // the other. Until they are a single table, they are checked against each
    // other.
    assert.equal(
      OPPORTUNITY_REJECTION_COPY_V1.no_entry_route,
      OPPORTUNITY_REJECTION_COPY_V2.no_entry_route,
    );
    assert.equal(
      OPPORTUNITY_REJECTION_COPY_V1.no_exit_route,
      OPPORTUNITY_REJECTION_COPY_V2.no_exit_route,
    );
  });
});
