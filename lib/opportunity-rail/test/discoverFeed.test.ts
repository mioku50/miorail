import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_CARD_ACTIONS_V1,
  B20_CATCHING_UP_BLOCKS_V1,
  B20_NOT_MEASURED_DIMENSIONS_V1,
  B20_PIPELINE_STATES_V1,
  B20_PRE_ENTRY_NOTICE_V1,
  B20_PROFILE_REJECTIONS_V1,
  B20_QUOTE_ALIGNMENT_NOTICE_V1,
  B20_TRANSFER_POLICY_NOTICE_V1,
  B20_WALLET_INDEPENDENT_REJECTIONS_V1,
  b20LaunchBuyerWindowV1,
  b20OpportunityCardV1,
  b20PipelineCopyV1,
  b20PipelineStatusV1,
  type B20CardInputV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T69-C §1/§5/§6/§18 — what the feed says, and what an EMPTY feed says.
//
// The second is the one this file mostly exists for. An empty array has seven
// causes and only one of them is "the chain was quiet". Rendering all seven the
// same way tells a user the product is working when it is not, and they have no
// way to tell the difference.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-04T12:00:00.000Z');

test('launch-buyer window state distinguishes collecting from a closed miss', () => {
  assert.deepEqual(
    b20LaunchBuyerWindowV1({ launchBlock: '1000', observedHead: '10999', windowBlocks: 10_000, measured: false }),
    { status: 'collecting', closesAtBlock: '11000' },
  );
  assert.deepEqual(
    b20LaunchBuyerWindowV1({ launchBlock: '1000', observedHead: '11000', windowBlocks: 10_000, measured: false }),
    { status: 'closed_unmeasured', closesAtBlock: '11000' },
  );
  assert.deepEqual(
    b20LaunchBuyerWindowV1({ launchBlock: '1000', observedHead: null, windowBlocks: 10_000, measured: false }),
    { status: 'unknown', closesAtBlock: '11000' },
  );
  assert.deepEqual(
    b20LaunchBuyerWindowV1({
      launchBlock: '1000',
      observedHead: '10999',
      windowBlocks: 10_000,
      measured: true,
      measuredToBlock: '12000',
    }),
    { status: 'measured', closesAtBlock: '12000' },
  );
});

const BASE_FACTS = {
  storageAvailable: true,
  ingestionCursorBlock: '49500000',
  confirmedHead: '49500100',
  lastIngestionRunAt: '2026-08-04T11:59:00.000Z',
  lastIngestionResult: 'success',
  lastMeasurementRunAt: '2026-08-04T11:58:00.000Z',
  canonicalLaunchCount: 12,
  launchesAwaitingMeasurement: 0,
  observationCount: 12,
  observationsLastRun: 4 as number | null,
  budgetExhausted: false,
  operatorState: null as string | null,
  // T73-LIVE — staleness is measured against a clock, so every fixture states
  // one. The base run finished a minute ago: current by any threshold.
  now: NOW.toISOString(),
};

function card(overrides: Partial<B20CardInputV1['observation']> = {}, launchOverrides = {}) {
  const observation: B20CardInputV1['observation'] = {
    state: 'provisional',
    reasonCode: 'quoted_pre_entry',
    referencePositionAtomic: '100000000',
    referenceQuoteAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    maxRoundTripBps: 300,
    maxExitSlippageBps: 300,
    entryRouteFound: true,
    exitRouteFound: true,
    entrySourceKey: 'aerodrome|in',
    exitSourceKey: 'aerodrome|out',
    optimisticExitReturnAtomic: '98700000',
    optimisticRoundTripBps: 130,
    routeCoverage: 'partial',
    viableRouteConfirmed: true,
    bestRouteConfirmed: false,
    largestPassingSizeAtomic: '250000000',
    firstFailingSizeAtomic: '500000000',
    capacityToleranceBps: 300,
    capacityProbeCount: 5,
    capacityStable: true,
    transfersPaused: false,
    transferPolicyState: 'open',
    controlsComplete: true,
    controlsBlockNumber: '49531075',
    observationBlockNumber: '49531075',
    quoteAlignment: 'latest_not_anchored',
    measuredAt: '2026-08-04T11:50:00.000Z',
    staleAfter: '2026-08-04T12:20:00.000Z',
    ...overrides,
  };
  return b20OpportunityCardV1({
    launch: {
      tokenAddress: '0xb200000000000000000000d6f666fe8b27595c01',
      name: 'o1 mascot',
      symbol: 'DINo1',
      variant: 'asset',
      decimals: 18,
      blockNumber: '49531000',
      transactionHash: `0x${'cd'.repeat(32)}`,
      logIndex: 3,
      detectedAt: '2026-08-04T11:42:00.000Z',
      canonical: true,
      ...launchOverrides,
    },
    observation,
    now: NOW,
  });
}

describe('an empty feed says which of seven things happened', () => {
  test('no start block configured is not the same as nothing launched', () => {
    // §21.1.
    const status = b20PipelineStatusV1({
      ...BASE_FACTS,
      ingestionCursorBlock: null,
      lastIngestionResult: 'configuration_required',
      canonicalLaunchCount: 0,
      observationCount: 0,
    });
    assert.equal(status.state, 'configuration_required');
    assert.match(b20PipelineCopyV1(status), /explicit historical start block/);
  });

  test('configured but never run is its own state', () => {
    const status = b20PipelineStatusV1({
      ...BASE_FACTS,
      ingestionCursorBlock: null,
      lastIngestionResult: null,
      canonicalLaunchCount: 0,
      observationCount: 0,
    });
    assert.equal(status.state, 'ingestion_not_started');
  });

  test('a cursor far behind the head is catching up, and says how far', () => {
    // §21.2.
    const status = b20PipelineStatusV1({
      ...BASE_FACTS,
      ingestionCursorBlock: '49420000',
      confirmedHead: '49531000',
    });
    assert.equal(status.state, 'ingestion_catching_up');
    assert.equal(status.blocksBehind, 111_000);
    const copy = b20PipelineCopyV1(status);
    assert.match(copy, /49,420,000/);
    assert.match(copy, /49,531,000/);
  });

  test('a small lag is not catching up', () => {
    const status = b20PipelineStatusV1({
      ...BASE_FACTS,
      ingestionCursorBlock: String(49_531_000 - B20_CATCHING_UP_BLOCKS_V1),
      confirmedHead: '49531000',
    });
    assert.equal(status.state, 'healthy');
  });

  test('launches with no measurement yet are measurement_pending, counted', () => {
    // §21.3.
    const status = b20PipelineStatusV1({ ...BASE_FACTS, launchesAwaitingMeasurement: 7 });
    assert.equal(status.state, 'measurement_pending');
    assert.match(b20PipelineCopyV1(status), /7 launches have been found/);
    assert.match(
      b20PipelineCopyV1(b20PipelineStatusV1({ ...BASE_FACTS, launchesAwaitingMeasurement: 1 })),
      /1 launch has been found/,
    );
  });

  test('a stopped decoder outranks every later state', () => {
    // Nothing downstream is meaningful while the launch feed refuses to read.
    const status = b20PipelineStatusV1({
      ...BASE_FACTS,
      operatorState: 'decoder_mismatch',
      launchesAwaitingMeasurement: 99,
    });
    assert.equal(status.state, 'decoder_mismatch');
  });

  test('any other operator state is degraded, and never a token failure', () => {
    const status = b20PipelineStatusV1({ ...BASE_FACTS, operatorState: 'endpoint_unavailable' });
    assert.equal(status.state, 'degraded');
    assert.match(b20PipelineCopyV1(status), /not treated as a token failure/);
  });

  test('healthy but empty is the only state that may say "no opportunities"', () => {
    const status = b20PipelineStatusV1(BASE_FACTS);
    assert.equal(status.state, 'healthy');
    assert.match(b20PipelineCopyV1(status), /No measured B20 opportunities/);
    // And no OTHER state is allowed to say it.
    for (const state of B20_PIPELINE_STATES_V1) {
      if (state === 'healthy') continue;
      const other = b20PipelineCopyV1({ state, facts: status.facts, blocksBehind: null });
      assert.ok(!/No measured B20 opportunities/.test(other), `${state} must not read as an empty chain`);
    }
  });

  test('the status carries no endpoint and no credential', () => {
    const status = b20PipelineStatusV1({ ...BASE_FACTS, operatorState: 'endpoint_unavailable' });
    const text = JSON.stringify(status).toLowerCase();
    for (const forbidden of ['http', '://', 'postgres', 'password', 'apikey']) {
      assert.ok(!text.includes(forbidden), `the status must not contain "${forbidden}"`);
    }
  });
});

describe('a card states what was measured and what it means', () => {
  test('a provisional card always carries the pre-entry warning', () => {
    // §21.9.
    assert.equal(card().observation?.preEntryNotice, B20_PRE_ENTRY_NOTICE_V1);
  });

  test('a rejected card always names a reason in words', () => {
    // §21.10.
    const rejected = card({ state: 'rejected', reasonCode: 'transfers_paused', transfersPaused: true });
    assert.equal(rejected.observation?.reasonCode, 'transfers_paused');
    assert.match(rejected.observation!.detail, /paused right now/);
    assert.equal(rejected.observation?.preEntryNotice, null, 'a rejection is not a pre-entry estimate');
  });

  test('a route rejection speaks about Miorail’s routes, not about Base', () => {
    const rejected = card({ state: 'rejected', reasonCode: 'no_exit_route', exitRouteFound: false });
    assert.match(rejected.observation!.detail, /not about every venue on Base/);
    assert.ok(!/cannot be sold anywhere/i.test(rejected.observation!.detail));
  });

  test('unmeasured values stay null and are never zero', () => {
    // §21.11. A card showing 0.00% for an unmeasured token is a lie with a
    // decimal point in it.
    const unmeasured = card({
      state: 'unmeasured',
      reasonCode: 'route_search_degraded',
      optimisticRoundTripBps: null,
      optimisticExitReturnAtomic: null,
      largestPassingSizeAtomic: null,
      firstFailingSizeAtomic: null,
      capacityStable: null,
    });
    assert.equal(unmeasured.observation?.optimisticRoundTripBps, null);
    assert.equal(unmeasured.observation?.optimisticReturnAtomic, null);
    assert.equal(unmeasured.observation?.largestPassingSizeAtomic, null);
    assert.equal(unmeasured.observation?.capacityStable, null);
  });

  test('partial coverage never renders as best-route confirmed', () => {
    // §21.12.
    const partial = card();
    assert.equal(partial.observation?.routeCoverage, 'partial');
    assert.equal(partial.observation?.viableRouteConfirmed, true);
    assert.equal(partial.observation?.bestRouteConfirmed, false);
  });

  test('unanchored quotes are stated on the card, not hidden', () => {
    // §21.13/§7.
    assert.equal(card().observation?.quoteAlignmentNotice, B20_QUOTE_ALIGNMENT_NOTICE_V1);
    assert.match(B20_QUOTE_ALIGNMENT_NOTICE_V1, /Market quotes were read at latest/);
    assert.equal(card({ quoteAlignment: 'anchored' }).observation?.quoteAlignmentNotice, null);
  });

  test('capacity is the tested boundaries, and nothing between them', () => {
    // §21.14.
    const observation = card().observation!;
    assert.equal(observation.largestPassingSizeAtomic, '250000000');
    assert.equal(observation.firstFailingSizeAtomic, '500000000');
    assert.equal(observation.capacityProbeCount, 5);
    // No field exists for an interpolated figure, which is the strongest form
    // the prohibition can take.
    assert.ok(!('estimatedCapacityAtomic' in observation));
  });

  test('an active transfer policy warns and does NOT reject', () => {
    // §21.15/§21.16. There is no wallet here to resolve the policy against.
    const restricted = card({ transferPolicyState: 'restricted' });
    assert.equal(restricted.observation?.state, 'provisional');
    assert.equal(restricted.observation?.transferPolicyNotice, B20_TRANSFER_POLICY_NOTICE_V1);
    assert.match(B20_TRANSFER_POLICY_NOTICE_V1, /requires a wallet-specific check/);
    assert.equal(card().observation?.transferPolicyNotice, null, 'an open policy carries no warning');
  });

  test('a transfer pause renders as rejected', () => {
    // §21.17.
    const paused = card({ state: 'rejected', reasonCode: 'transfers_paused', transfersPaused: true });
    assert.equal(paused.observation?.state, 'rejected');
    assert.equal(paused.observation?.transfersPaused, true);
  });

  test('no card language grades, scores or promises', () => {
    // §21.18.
    for (const sample of [
      card(),
      card({ state: 'rejected', reasonCode: 'no_exit_route' }),
      card({ state: 'unmeasured', reasonCode: 'controls_incomplete' }),
      card({ state: 'candidate', reasonCode: null }),
    ]) {
      const text = `${sample.observation!.headline} ${sample.observation!.detail}`.toLowerCase();
      for (const forbidden of [
        'safe',
        'unsafe',
        'risk score',
        'security score',
        'rating',
        'profit',
        'guaranteed',
        'recommended',
        'promising',
      ]) {
        assert.ok(!text.includes(forbidden), `no card may say "${forbidden}"`);
      }
    }
  });

  test('not-measured dimensions are named, never rendered as zero', () => {
    // §21.19. A missing row reads as "nothing to report"; a named one reads as
    // "nobody measured this".
    const sample = card();
    assert.deepEqual(sample.notMeasured, B20_NOT_MEASURED_DIMENSIONS_V1);
    for (const dimension of [
      'unique buyers beyond the launch window',
      'trading volume',
      // Still here on purpose. Launch-window BUYING is measured now, and a
      // wallet counted there may have sold everything since — so nothing this
      // product publishes says who holds the supply. Dropping this line
      // because a concentration number appeared would be the overclaim the
      // number was written to avoid.
      'holder concentration',
    ] as const) {
      assert.ok(sample.notMeasured.includes(dimension));
    }
    assert.ok(!JSON.stringify(sample).includes('"uniqueBuyers":0'));
  });

  test('an unmeasured launch is a card with no observation, not a zeroed one', () => {
    const never = b20OpportunityCardV1({
      launch: {
        tokenAddress: '0xb200000000000000000000d6f666fe8b27595c01',
        name: 'x',
        symbol: 'X',
        variant: 'asset',
        decimals: 18,
        blockNumber: '49531000',
        transactionHash: `0x${'cd'.repeat(32)}`,
        logIndex: 0,
        detectedAt: '2026-08-04T11:42:00.000Z',
        canonical: true,
      },
      observation: null,
      now: NOW,
    });
    assert.equal(never.observation, null);
    assert.equal(never.canCheckProfile, false, 'nothing has been measured to check against');
  });
});

describe('freshness gates the action, not the facts', () => {
  test('a fresh observation may offer a profile check', () => {
    const fresh = card();
    assert.equal(fresh.observation?.freshness, 'fresh');
    assert.equal(fresh.canCheckProfile, true);
  });

  test('a stale observation keeps its facts and loses the action', () => {
    // §21.6/§21.7. The numbers were true when they were measured; what they may
    // no longer do is start a wallet-bound entry.
    const stale = card({ staleAfter: '2026-08-04T11:55:00.000Z' });
    assert.equal(stale.observation?.freshness, 'stale');
    assert.equal(stale.canCheckProfile, false);
    assert.equal(stale.observation?.optimisticRoundTripBps, 130, 'the measurement is still shown');
    assert.equal(stale.observation?.largestPassingSizeAtomic, '250000000');
  });

  test('a launch the chain took back offers no action either', () => {
    const reorged = card({}, { canonical: false });
    assert.equal(reorged.canCheckProfile, false);
  });

  test('T69-C.1 §1 — detection time is never presented as launch time', () => {
    // The worker can be days behind the head. `detectedAt` is a fact about
    // Miorail's backlog; using it as an age made every stored launch look
    // minutes old, which is the one thing a launch feed must not get wrong.
    const withoutTimestamp = card();
    assert.equal(withoutTimestamp.launch.ageSeconds, null);
    assert.equal(withoutTimestamp.launch.launchedAt, null);
    assert.equal(withoutTimestamp.launch.launchTimeSource, 'discovered');
    // The block is still there, so a surface can say WHERE it was found.
    assert.equal(withoutTimestamp.launch.blockNumber, '49531000');
  });

  test('a block timestamp, when the endpoint reports one, is the launch time', () => {
    const withTimestamp = card({}, { blockTimestamp: '2026-08-04T09:00:00.000Z' });
    assert.equal(withTimestamp.launch.launchTimeSource, 'onchain_block');
    assert.equal(withTimestamp.launch.launchedAt, '2026-08-04T09:00:00.000Z');
    // Three hours before the 12:00 server time the fixture uses.
    assert.equal(withTimestamp.launch.ageSeconds, 3 * 60 * 60);
  });

  test('an unreadable block timestamp falls back rather than guessing', () => {
    const broken = card({}, { blockTimestamp: 'not-a-time' });
    assert.equal(broken.launch.launchTimeSource, 'discovered');
    assert.equal(broken.launch.ageSeconds, null);
  });
});

describe('the card carries nothing executable', () => {
  test('no calldata, no ids a client cannot use, no provider output', () => {
    // §21.28.
    const text = JSON.stringify(card());
    for (const forbidden of ['calldata', '0x095ea7b3', 'blueprintHash', 'evidenceHash', 'rawResponse', 'sessionId']) {
      assert.ok(!text.includes(forbidden), `the card must not carry ${forbidden}`);
    }
    // Source KEYS are display strings naming pools; they are not routes a
    // client could execute.
    assert.equal(card().observation?.entrySourceKey, 'aerodrome|in');
  });

  test('the pool hook reaches the card decoded, not as a bare address', () => {
    // The point of storing the address is that a card can say what the hook is
    // ALLOWED to do. A raw string would leave every consumer to re-derive it.
    const hooked = card({
      poolHookAddress: '0x985c14baa2a18316ffda0aefb3a632fadfca2acc',
    }).observation?.poolHook;
    assert.equal(hooked?.standing, 'standard');
    assert.equal(hooked?.permissions?.mayChangeSwapAmounts, true);
    assert.equal(hooked?.permissions?.mayGateLiquidity, true);

    const unusual = card({
      poolHookAddress: '0xf85f1f3082cfbc5e1149972309b25054e4d420cc',
    }).observation?.poolHook;
    assert.equal(unusual?.standing, 'non_standard');
    // Fewer permissions, but it can still move the amounts of every swap —
    // which with a zero pool fee is what decides an exit's cost.
    assert.equal(unusual?.permissions?.mayGateLiquidity, false);
    assert.equal(unusual?.permissions?.mayChangeSwapAmounts, true);
  });

  test('a venue with no hook recorded shows null, never a default hook', () => {
    // Aerodrome has no hooks, and every observation written before the column
    // existed has none either. Inventing one would be a claim about a pool
    // nobody read.
    assert.equal(card().observation?.poolHook, null);
  });
});

// ---------------------------------------------------------------------------
// T69-C.1 §2/§3 — the action a card offers follows the REASON.
// ---------------------------------------------------------------------------

describe('a wallet check is offered only where a wallet could change the answer', () => {
  test('§3 — a fresh, wallet-independent rejection offers nothing at all', () => {
    // The defect: every fresh canonical card offered "Check against my wallet",
    // including one rejected because no exit route exists. That invites a user
    // to spend a simulation disproving something already proven, and quietly
    // suggests their wallet might be exempt from a fact about the token.
    for (const reasonCode of B20_WALLET_INDEPENDENT_REJECTIONS_V1) {
      const result = card({ state: 'rejected', reasonCode });
      assert.equal(result.action.action, 'none', `${reasonCode} offered ${result.action.action}`);
      assert.equal(result.action.label, null, `${reasonCode} rendered a button`);
      assert.match(result.action.reason, /not about any particular wallet/);
    }
  });

  test('a profile rejection points at the profile, not at the wallet', () => {
    for (const reasonCode of B20_PROFILE_REJECTIONS_V1) {
      const result = card({ state: 'rejected', reasonCode });
      assert.equal(result.action.action, 'try_profile');
      assert.equal(result.action.label, 'Try another profile');
      assert.match(result.action.reason, /smaller position or a wider tolerance/);
    }
  });

  test('a stale card asks to be re-measured, whatever its reason', () => {
    // Stale numbers support nothing — including a rejection, which the chain
    // may since have overturned by adding a route or unpausing transfers.
    const stale = { measuredAt: '2026-08-04T10:00:00.000Z', staleAfter: '2026-08-04T10:30:00.000Z' };
    for (const reasonCode of ['no_exit_route', 'round_trip_above_tolerance'] as const) {
      const result = card({ state: 'rejected', reasonCode, ...stale });
      assert.equal(result.action.action, 'refresh_measurement');
      assert.equal(result.action.label, 'Refresh measurement');
    }
    const staleProvisional = card(stale);
    assert.equal(staleProvisional.action.action, 'refresh_measurement');
  });

  test('a fresh sound rejection outranks staleness handling, and is final', () => {
    // Ordering matters: the wallet-independent check runs BEFORE the stale
    // check, so a fresh no-exit-route is final rather than merely refreshable.
    const result = card({ state: 'rejected', reasonCode: 'no_exit_route' });
    assert.equal(result.action.action, 'none');
  });

  test('a provisional card offers the wallet check it has always offered', () => {
    const result = card();
    assert.equal(result.action.action, 'check_wallet');
    assert.equal(result.action.label, 'Check against my wallet');
    assert.match(result.action.reason, /entry and exit in sequence/);
  });

  test('an active transfer policy is THE wallet-dependent case', () => {
    // The one thing a wallet-specific check can genuinely resolve: B20 offers
    // no way to enumerate who a policy admits.
    const result = card({ transferPolicyState: 'restricted' });
    assert.equal(result.action.action, 'check_wallet');
    assert.match(result.action.reason, /admits YOUR wallet/);
  });

  test('an unmeasured or queued card asks for a measurement, not a wallet', () => {
    assert.equal(card({ state: 'unmeasured', reasonCode: 'quote_unavailable' }).action.action, 'refresh_measurement');
    assert.equal(card({ state: 'candidate', reasonCode: null }).action.action, 'refresh_measurement');
  });

  test('a launch with no observation, and one taken back by a reorg, offer nothing', () => {
    const never = b20OpportunityCardV1({
      launch: {
        tokenAddress: '0xb200000000000000000000d6f666fe8b27595c01',
        name: 'o1 mascot',
        symbol: 'DINo1',
        variant: 'asset',
        decimals: 18,
        blockNumber: '49531000',
        transactionHash: `0x${'cd'.repeat(32)}`,
        logIndex: 3,
        detectedAt: '2026-08-04T11:42:00.000Z',
        canonical: true,
      },
      observation: null,
      now: new Date('2026-08-04T12:00:00.000Z'),
    });
    assert.equal(never.action.action, 'none');
    assert.equal(card({}, { canonical: false }).action.action, 'none');
  });

  test('an unknown rejection reason fails closed', () => {
    // A reason this build has never seen must not fall through to a wallet
    // check on the assumption that it might be wallet-dependent.
    const result = card({ state: 'rejected', reasonCode: 'something_new' as never });
    assert.equal(result.action.action, 'none');
    assert.equal(result.action.label, null);
  });

  test('every action carries a reason, and no card offers two things', () => {
    for (const sample of [
      card(),
      card({ state: 'rejected', reasonCode: 'no_entry_route' }),
      card({ state: 'rejected', reasonCode: 'exit_capacity_below_position' }),
      card({ state: 'unmeasured', reasonCode: 'controls_unread' }),
    ]) {
      assert.ok(sample.action.reason.length > 20, 'an action with no explanation');
      assert.ok((B20_CARD_ACTIONS_V1 as readonly string[]).includes(sample.action.action));
      // `label` is present exactly when there is something to press.
      assert.equal(sample.action.label === null, sample.action.action === 'none');
    }
  });
});
