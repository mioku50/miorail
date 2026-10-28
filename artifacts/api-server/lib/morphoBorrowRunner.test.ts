import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { encodeFunctionResult } from 'viem';
import { stableHashV1 } from '@mioagent/route-domain';

import type { SimulationProvider } from '@mioagent/paid-intelligence';

import { runMorphoBorrowV1 } from './morphoBorrowRunner.js';
import { ACTIONS_NOW, preparedActionV1, signedActionsFixtureV1 } from '../../../lib/rwa-issuer/test/fixtures/morphoActions.js';
import type { SimulationChainV1 } from './swapSimulation.js';
import { morphoAfterBorrowV1, morphoBorrowCapacityV1, morphoHealthV1, morphoLiquidationPriceV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { CRYPTO } from '@mioagent/still-engine/registry';
import { erc20Abi, morphoAbi, morphoOracleAbi } from '@mioagent/still-engine/abi';

// ---------------------------------------------------------------------------
// The whole gate, end to end, on the shapes the live venue actually returns.
//
// The market is the curated NVDAc one: 8-decimal collateral, 6-decimal USDC,
// 62.5% LLTV, an oracle at $222.37, and — the number that matters — a market
// holding about 824 USDC while the venue publishes a `maxBorrowable` of 1,779.
// ---------------------------------------------------------------------------

const MARKET = '0xb4b42dd66cef25614b94510a910d54b2c148e7621d22b4271566724beda63d13';
const WALLET = '0xfb132f4c6d9dcf4f80483ea7d96c5a5dccfcfe83';
const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const MORPHO_BLUE = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
const BUNDLER = '0x6bfd8137e702540e7a42b74178a4a49ba43920c4';
const ADAPTER = '0xb98c948cfa24072e58935bc004a8a7b376ae746a';

const MARKET_ROW_V1 = {
  marketId: MARKET,
  lltv: '625000000000000000',
  listed: true,
  collateralAsset: { address: NVDAC, symbol: 'NVDAc', decimals: 8 },
  loanAsset: { address: USDC, symbol: 'USDC', decimals: 6 },
  state: {
    blockNumber: 51_521_606,
    price: '2223700000000000000000000000000000000',
    supplyAssets: '8431685036',
    borrowAssets: '7607079421',
    borrowShares: '7607079421000000',
    borrowApy: 0.0564,
  },
};

const POSITION_ROW_V1 = {
  market: { marketId: MARKET },
  state: { collateral: '6441519897', borrowShares: '7163511021000000', borrowAssets: '7163511021' },
};

/** The venue's GraphQL, answering both queries from one fake. */
function readerV1(
  over: { markets?: unknown[]; positions?: unknown[]; positionsFail?: boolean } = {},
): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query: string };
    if (body.query.includes('marketPositions')) {
      if (over.positionsFail) return new Response('upstream is down', { status: 502 });
      return new Response(JSON.stringify({ data: { marketPositions: { items: over.positions ?? [POSITION_ROW_V1] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { markets: { items: over.markets ?? [MARKET_ROW_V1] } } }), { status: 200 });
  }) as unknown as typeof fetch;
}

const AUTHORIZE_DATA = `0xeecea000000000000000000000000000${ADAPTER.slice(2)}${'0'.repeat(63)}1`;
const BUNDLE_DATA = `0x374f435d${'0'.repeat(62)}20`;

/** Real ES256-signed Actions HTTP fixture, through the production adapter. */
function venueV1(over: Record<string, unknown> = {}): typeof fetch {
  return signedActionsFixtureV1(preparedActionV1({
    account: WALLET,
    market: { id: MARKET, loan_asset: { address: USDC }, collateral_asset: { address: NVDAC } },
    calls: [
      { id: 'call_0', kind: 'authorization', to: MORPHO_BLUE, data: AUTHORIZE_DATA, value: '0' },
      { id: 'call_1', kind: 'blue_borrow', to: BUNDLER, data: BUNDLE_DATA, value: '0' },
    ],
    ...over,
  })).fetchImpl;
}

/** A chain of exactly one reviewed provider, answering with a given body. */
function chainV1(body: unknown, providerId = 'test-eth-simulate'): SimulationChainV1 {
  const provider: SimulationProvider = {
    providerId,
    async simulate() {
      return { ok: true, body };
    },
  };
  return { providers: [provider], batchCapableIds: new Set([providerId]) };
}

function executedV1(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'success',
    blockNumber: 51_521_606,
    gasUsed: '412000',
    stateChanges: [],
    revertReason: null,
    failedCallIndex: null,
    assetChanges: {
      status: 'available',
      unavailableReason: null,
      changes: [
        { kind: 'erc20_transfer', token: USDC, direction: 'in', amountAtomic: '10000000', counterparty: MORPHO_BLUE, callIndex: 1 },
      ],
    },
    ...over,
  };
}

const ASK = { collateralTokenAddress: NVDAC, walletAddress: WALLET, borrowAssets: 10_000_000n, marketId: MARKET };

function cryptoStanding(borrowShares = 300_000_000_000_000n) {
  const asset = CRYPTO[0]!;
  const state = { collateralPrice: 10n ** 36n, lltvWad: 860_000_000_000_000_000n,
    totalSupplyAssets: 1_000_000_000_000n, totalBorrowAssets: 1_000_000_000n, totalBorrowShares: 1_000_000_000_000_000n, blockNumber: 53_000_000 };
  const position = { collateral: 1_000_000_000n, borrowShares };
  return { market: { marketId: asset.morphoMarket, curated: null, collateral: { address: asset.token, symbol: 'cbBTC', decimals: 8 },
    loan: { address: USDC, symbol: 'USDC', decimals: 6 }, lltvBps: 8600, borrowApyWad: null,
    oracleAddress: '0x663becd10dae6c4a3dcd89f1d76c1174199639b9' as const, state }, position,
    health: morphoHealthV1({ market: state, position }), capacity: morphoBorrowCapacityV1({ market: state, position }),
    liquidationPrice: morphoLiquidationPriceV1({ market: state, position }), liquidationIncentiveWad: 1_000_000_000_000_000_000n,
    venuePublishedDebtAssets: null, walletCollateralAssets: 5_000_000_000n as bigint | null };
}

function cryptoSimulationChain(price = 10n ** 36n, spendsAnotherAsset = false, supply = 0n, borrowedAssets = ASK.borrowAssets): SimulationChainV1 {
  const standing = cryptoStanding();
  const pre = standing.market.state;
  const interest = 12_000n;
  const accrued = { ...pre, collateralPrice: price, totalSupplyAssets: pre.totalSupplyAssets + interest, totalBorrowAssets: pre.totalBorrowAssets + interest };
  const projected = morphoAfterBorrowV1({ market: accrued, position: { ...standing.position, collateral: standing.position.collateral + supply }, assets: borrowedAssets });
  assert(projected);
  const provider: SimulationProvider = { providerId: 'fixture-observed-batch', async simulate(request) {
    assert(request.calls.length <= 4, 'read probes never become wallet calls');
    assert(request.observations);
    const params = [USDC, CRYPTO[0]!.token, standing.market.oracleAddress, '0x46415998764C29aB2a25CbeA6254146D50D22687', 860_000_000_000_000_000n] as const;
    const results = (['before', 'after'] as const).flatMap(phase => request.observations![phase].map(probe => {
      const isAfter = phase === 'after';
      const returnData = probe.id === 'market_params' ? encodeFunctionResult({ abi: morphoAbi, functionName: 'idToMarketParams', result: params })
        : probe.id === 'oracle_price' ? encodeFunctionResult({ abi: morphoOracleAbi, functionName: 'price', result: price })
          : probe.id === 'position' ? encodeFunctionResult({ abi: morphoAbi, functionName: 'position', result: [0n, isAfter ? projected.position.borrowShares : standing.position.borrowShares, standing.position.collateral + (isAfter ? supply : 0n)] })
            : probe.id === 'collateral_wallet_balance' ? encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: 5_000_000_000n - (isAfter ? supply : 0n) })
            : encodeFunctionResult({ abi: morphoAbi, functionName: 'market', result: isAfter
              ? [accrued.totalSupplyAssets, 1_000_000_000_000_000_000n, accrued.totalBorrowAssets + borrowedAssets, pre.totalBorrowShares + projected.position.borrowShares - standing.position.borrowShares, 1001n, 0n]
              : [pre.totalSupplyAssets, 1_000_000_000_000_000_000n, pre.totalBorrowAssets, pre.totalBorrowShares, 1000n, 0n] });
      return { ...probe, phase, status: 'success' as const, returnData };
    }));
    const body = executedV1({ blockNumber: 53_000_001, observations: {
      requestHash: stableHashV1('simulation-observations/v1', { chainId: 8453, walletAddress: request.walletAddress.toLowerCase(), callsHash: request.callsHash,
        before: request.observations.before, after: request.observations.after }), results,
    } });
    body.assetChanges = { status: 'available', unavailableReason: null, changes: [
      { kind: 'erc20_transfer', token: USDC, direction: 'in', amountAtomic: borrowedAssets.toString(), counterparty: MORPHO_BLUE, callIndex: 0 },
      ...(supply > 0n ? [{ kind: 'erc20_transfer', token: CRYPTO[0]!.token, direction: 'out', amountAtomic: supply.toString(), counterparty: MORPHO_BLUE, callIndex: 0 }] : []),
      ...(spendsAnotherAsset ? [{ kind: 'erc20_transfer', token: NVDAC, direction: 'out', amountAtomic: '1', counterparty: BUNDLER, callIndex: 0 }] : []),
    ] };
    return { ok: true, body };
  } };
  return { providers: [provider], batchCapableIds: new Set([provider.providerId]) };
}

function cryptoVenue(supply: bigint, ask: bigint, calls?: Record<string, unknown>[]) {
  const asset = CRYPTO[0]!;
  return signedActionsFixtureV1(preparedActionV1({ account: WALLET,
    market: { id: asset.morphoMarket, loan_asset: { address: USDC }, collateral_asset: { address: asset.token } },
    amount: { unit: 'assets', value: ask.toString() }, resolved_amount: { unit: 'assets', value: ask.toString() },
    ...(supply > 0n ? {
      collateral_amount: { unit: 'assets', value: supply.toString() },
      resolved_funding: { wrapped_asset: asset.token, max_native_assets: '0', native_assets: '0', erc20_assets: supply.toString() },
    } : {}),
    simulation: { status: 'success', effects: { gross_assets: ask.toString(), net_assets: ask.toString(), referral_fee_assets: '0',
      ...(supply > 0n ? { supplied_collateral_assets: supply.toString() } : {}) } },
    calls: calls ?? [{ id: 'call_0', kind: supply > 0n ? 'blue_supply_collateral_borrow' : 'blue_borrow', to: BUNDLER, data: BUNDLE_DATA, value: '0' }],
  }));
}

describe('selected collateral is an explicit part of the measured borrow', () => {
  test('only the selected pledge supports a larger draw, and the review binds it', async () => {
    const asset = CRYPTO[0]!, supply = 1_000_000_000n, ask = 200_000_000n;
    const venue = cryptoVenue(supply, ask);
    const run = await runMorphoBorrowV1({ ...ASK, collateralTokenAddress: asset.token, marketId: asset.morphoMarket, borrowAssets: ask, collateralSupplyAssets: supply }, depsV1({
      read: async () => ({ state: 'read', readAt: ACTIONS_NOW.toISOString(), markets: [cryptoStanding()] }),
      venue: { fetchImpl: venue.fetchImpl }, chain: cryptoSimulationChain(10n ** 36n, false, supply, ask),
    }));
    assert.equal(run.state, 'ready');
    if (run.state !== 'ready') return;
    assert.equal(run.stillPolicy!.limitAtomic, '860000000');
    assert.equal(run.funding!.amountAtomic, supply.toString());
    assert.equal(run.atomicRequired, true);
    assert.equal(run.review.before.collateral, '10.00 cbBTC');
    assert.equal(run.review.after!.collateral, '20.00 cbBTC');
    assert.match(run.review.warnings[0]!, /You chose to add 10 cbBTC/);
  });
  for (const balance of [null, 0n, 99n] as const) {
    test(`an unread or insufficient wallet balance (${balance}) prepares no calls`, async () => {
      const asset = CRYPTO[0]!;
      let asked = false;
      const standing = cryptoStanding(); standing.walletCollateralAssets = balance;
      const run = await runMorphoBorrowV1({ ...ASK, collateralTokenAddress: asset.token, marketId: asset.morphoMarket, collateralSupplyAssets: 100n }, depsV1({
        read: async () => ({ state: 'read', readAt: ACTIONS_NOW.toISOString(), markets: [standing] }),
        venue: { fetchImpl: (async () => { asked = true; throw new Error('must not prepare'); }) as typeof fetch },
      }));
      assert.equal(run.state, 'refused');
      if (run.state === 'refused') assert.equal(run.refusal, balance === null ? 'wallet_collateral_unread' : 'wallet_collateral_insufficient');
      assert.equal(asked, false);
      assert.equal('calls' in run, false);
    });
  }
  test('a top-level approval cannot exceed the chosen collateral', async () => {
    const asset = CRYPTO[0]!, supply = 1_000_000_000n;
    const venue = cryptoVenue(supply, ASK.borrowAssets, [
      { id: 'call_0', kind: 'approval', to: asset.token, data: `0x095ea7b3${ADAPTER.slice(2).padStart(64, '0')}${(supply + 1n).toString(16).padStart(64, '0')}`, value: '0' },
      { id: 'call_1', kind: 'blue_supply_collateral_borrow', to: BUNDLER, data: BUNDLE_DATA, value: '0' },
    ]);
    const run = await runMorphoBorrowV1({ ...ASK, collateralTokenAddress: asset.token, marketId: asset.morphoMarket, collateralSupplyAssets: supply }, depsV1({
      read: async () => ({ state: 'read', readAt: ACTIONS_NOW.toISOString(), markets: [cryptoStanding()] }),
      venue: { fetchImpl: venue.fetchImpl },
    }));
    assert.equal(run.state, 'refused');
    if (run.state === 'refused') assert.equal(run.refusal, 'unrequested_token_approval');
  });
});

describe('Still is enforced inside the existing borrow runner', () => {
  for (const errorCode of ['provider_observation_failed', 'provider_observation_unread'] as const) {
    test(`${errorCode} is a position-reading gap rather than a claim that no simulation ran`, async () => {
      const failed: SimulationProvider = { providerId: 'fixture-observer', async simulate() {
        return { ok: false, errorCode, detail: 'getter could not be read' };
      } };
      const run = await runMorphoBorrowV1(ASK, depsV1({ chain: { providers: [failed], batchCapableIds: new Set([failed.providerId]) } }));
      assert.equal(run.state, 'refused');
      if (run.state === 'refused') {
        assert.equal(run.refusal, errorCode);
        assert.match(run.review!.refusal!, /could not read the position before and after/);
        assert.doesNotMatch(run.review!.refusal!, /No provider executed/);
      }
      assert.equal('calls' in run, false);
    });
  }
  test('subtracts debt from half the total limit, not half the remaining headroom', async () => {
    const asset = CRYPTO[0]!;
    let venueAsked = false;
    const run = await runMorphoBorrowV1({ ...ASK, collateralTokenAddress: asset.token, marketId: asset.morphoMarket, borrowAssets: 200_000_000n }, depsV1({
      read: async () => ({ state: 'read', readAt: ACTIONS_NOW.toISOString(), markets: [cryptoStanding()] }),
      venue: { fetchImpl: (async () => { venueAsked = true; throw new Error('must not prepare'); }) as typeof fetch },
    }));
    assert.equal(run.state, 'refused');
    if (run.state === 'refused') { assert.equal(run.refusal, 'over_still_limit'); assert.match(run.review!.refusal!, /half the protocol/); }
    assert.equal(venueAsked, false);
    assert.equal('calls' in run, false);
  });
  test('a draw inside Still still needs authenticated venue calls and independent arrival', async () => {
    const asset = CRYPTO[0]!;
    const fixture = signedActionsFixtureV1(preparedActionV1({ account: WALLET,
      market: { id: asset.morphoMarket, loan_asset: { address: USDC }, collateral_asset: { address: asset.token } },
      calls: [{ id: 'call_0', kind: 'blue_borrow', to: BUNDLER, data: BUNDLE_DATA, value: '0' }],
    }));
    const run = await runMorphoBorrowV1({ ...ASK, collateralTokenAddress: asset.token, marketId: asset.morphoMarket }, depsV1({
      read: async () => ({ state: 'read', readAt: ACTIONS_NOW.toISOString(), markets: [cryptoStanding()] }),
      venue: { fetchImpl: fixture.fetchImpl },
      chain: cryptoSimulationChain(),
    }));
    assert.equal(run.state, 'ready');
    if (run.state !== 'ready') return;
    assert.equal(run.stillPolicy!.limitAtomic, '430000000');
    assert.equal(run.stillPolicy!.shareBps, 5000);
    assert.match(run.review.warnings[0]!, /already deposited/);
    assert.match(run.signingTermsHash!, /^0x[0-9a-f]{64}$/);
    assert.equal(run.expiresAt, new Date(ACTIONS_NOW.getTime() + 30_000).toISOString());
    assert.equal(run.review.before.debt, '300.00 USDC');
    assert.equal(run.measured.blockNumber, 53_000_001);
  });
  test('an exact USDC arrival alone cannot release a Still crypto loan', async () => {
    const asset = CRYPTO[0]!;
    const fixture = signedActionsFixtureV1(preparedActionV1({ account: WALLET,
      market: { id: asset.morphoMarket, loan_asset: { address: USDC }, collateral_asset: { address: asset.token } },
    }));
    const run = await runMorphoBorrowV1({ ...ASK, collateralTokenAddress: asset.token, marketId: asset.morphoMarket }, depsV1({
      read: async () => ({ state: 'read', readAt: ACTIONS_NOW.toISOString(), markets: [cryptoStanding()] }),
      venue: { fetchImpl: fixture.fetchImpl }, chain: chainV1(executedV1({ blockNumber: 53_000_001 })),
    }));
    assert.equal(run.state, 'refused');
    if (run.state === 'refused') assert.equal(run.refusal, 'poststate_observations_unread');
    assert.equal('calls' in run, false);
  });
  test('an exact arrival and debt increase cannot authorise an unrequested wallet outflow', async () => {
    const asset = CRYPTO[0]!;
    const fixture = signedActionsFixtureV1(preparedActionV1({ account: WALLET,
      market: { id: asset.morphoMarket, loan_asset: { address: USDC }, collateral_asset: { address: asset.token } },
      calls: [{ id: 'call_0', kind: 'blue_borrow', to: BUNDLER, data: BUNDLE_DATA, value: '0' }],
    }));
    const run = await runMorphoBorrowV1({ ...ASK, collateralTokenAddress: asset.token, marketId: asset.morphoMarket }, depsV1({
      read: async () => ({ state: 'read', readAt: ACTIONS_NOW.toISOString(), markets: [cryptoStanding()] }),
      venue: { fetchImpl: fixture.fetchImpl }, chain: cryptoSimulationChain(10n ** 36n, true),
    }));
    assert.equal(run.state, 'refused');
    if (run.state === 'refused') assert.equal(run.refusal, 'unrequested_wallet_outflow');
    assert.equal('calls' in run, false);
  });
  test('the independently observed price and accrued debt must still fit Still', async () => {
    const asset = CRYPTO[0]!;
    const fixture = signedActionsFixtureV1(preparedActionV1({ account: WALLET,
      market: { id: asset.morphoMarket, loan_asset: { address: USDC }, collateral_asset: { address: asset.token } },
      calls: [{ id: 'call_0', kind: 'blue_borrow', to: BUNDLER, data: BUNDLE_DATA, value: '0' }],
    }));
    const run = await runMorphoBorrowV1({ ...ASK, collateralTokenAddress: asset.token, marketId: asset.morphoMarket }, depsV1({
      read: async () => ({ state: 'read', readAt: ACTIONS_NOW.toISOString(), markets: [cryptoStanding()] }),
      venue: { fetchImpl: fixture.fetchImpl }, chain: cryptoSimulationChain(7n * 10n ** 35n),
    }));
    assert.equal(run.state, 'refused');
    if (run.state === 'refused') assert.equal(run.refusal, 'over_still_limit');
    assert.equal('calls' in run, false);
  });
  test('a position already over the Still ceiling cannot borrow more while protocol health still passes', async () => {
    const asset = CRYPTO[0]!;
    const run = await runMorphoBorrowV1({ ...ASK, collateralTokenAddress: asset.token, marketId: asset.morphoMarket }, depsV1({
      read: async () => ({ state: 'read', readAt: ACTIONS_NOW.toISOString(), markets: [cryptoStanding(450_000_000_000_000n)] }),
    }));
    assert.equal(run.state, 'refused');
    if (run.state === 'refused') assert.equal(run.refusal, 'over_still_limit');
  });
  test('cannot use another market for a registered Still collateral', async () => {
    const asset = CRYPTO[0]!;
    const standing = cryptoStanding();
    standing.market.marketId = MARKET as typeof asset.morphoMarket;
    const run = await runMorphoBorrowV1({ ...ASK, collateralTokenAddress: asset.token }, depsV1({
      read: async () => ({ state: 'read', readAt: ACTIONS_NOW.toISOString(), markets: [standing] }),
    }));
    assert.equal(run.state, 'refused');
    if (run.state === 'refused') assert.equal(run.refusal, 'still_market_mismatch');
  });
  test('does not release calls when the proof expires during independent simulation', async () => {
    let now = ACTIONS_NOW;
    const chain = chainV1(executedV1());
    const original = chain.providers[0]!.simulate;
    chain.providers[0]!.simulate = async (...args) => { now = new Date(ACTIONS_NOW.getTime() + 61_000); return original(...args); };
    const run = await runMorphoBorrowV1(ASK, depsV1({ chain, now: () => now }));
    assert.equal(run.state, 'refused');
    if (run.state === 'refused') assert.equal(run.refusal, 'venue_expired');
    assert.equal('calls' in run, false);
  });
});

function depsV1(over: Partial<Parameters<typeof runMorphoBorrowV1>[1]> = {}) {
  return {
    reader: { fetchImpl: readerV1(), url: 'https://api.morpho.org/graphql', now: () => ACTIONS_NOW },
    now: () => ACTIONS_NOW,
    venue: { fetchImpl: venueV1() },
    chain: chainV1(executedV1()),
    ...over,
  };
}

describe('a borrow that measures out is the only one that carries calls', () => {
  test('the ready branch hands over exactly the calls that were simulated', async () => {
    const run = await runMorphoBorrowV1(ASK, depsV1());
    assert.equal(run.state, 'ready');
    if (run.state !== 'ready') return;
    assert.equal(run.calls.length, 2);
    assert.equal(run.calls[0]!.to, MORPHO_BLUE);
    assert.equal(run.calls[1]!.to, BUNDLER);
    assert.equal(run.measured.arrivedAssets, '10000000');
    assert.equal(run.measured.blockNumber, 51_521_606);
    assert.equal(run.measured.providerId, 'test-eth-simulate');
    assert.match(run.callsHash, /^0x[0-9a-f]{64}$/);
  });

  test('the review shows the position this transaction would create, and names the adapter', async () => {
    const run = await runMorphoBorrowV1(ASK, depsV1());
    assert.equal(run.state, 'ready');
    if (run.state !== 'ready') return;
    assert.equal(run.review.verdict, 'ready_for_your_approval');
    assert.equal(run.review.refusal, null);
    assert.notEqual(run.review.after, null);
    // The authorisation outlives the borrow, so it is decoded and named.
    assert.deepEqual(run.plan.authorizations, [{ index: 0, authorized: ADAPTER, granted: true }]);
    // And the bundler frame says plainly that nobody read it.
    assert.equal(run.plan.steps[1]!.decodedByMiorail, false);
  });

  test('every refusal branch has no field to read calls out of', async () => {
    // The shape is the gate. A client cannot ignore a refusal and take the
    // calls anyway, because a refusal carries none.
    const run = await runMorphoBorrowV1({ ...ASK, borrowAssets: 900_000_000n }, depsV1());
    assert.equal(run.state, 'refused');
    assert.equal('calls' in run, false);
  });
});

describe('what stops the flow before a wallet ever sees it', () => {
  test('an authentication gap is named as our verification failure, not a market finding', async () => {
    const fixture = signedActionsFixtureV1(preparedActionV1({ account: WALLET }), { proof: null });
    const run = await runMorphoBorrowV1(ASK, depsV1({ venue: { fetchImpl: fixture.fetchImpl } }));
    assert.equal(run.state, 'refused');
    if (run.state === 'refused') {
      assert.equal(run.refusal, 'venue_proof_invalid');
      assert.match(run.review!.refusal!, /could not authenticate/);
      assert.match(run.review!.refusal!, /not a finding about this wallet or the market/);
    }
    assert.equal('calls' in run, false);
  });
  test('an ask beyond the market’s liquidity is a fact about the market', async () => {
    // 900 USDC asked of a market holding ~824, with collateral that supports
    // far more: the venue would have called this well within `maxBorrowable`.
    const run = await runMorphoBorrowV1({ ...ASK, borrowAssets: 900_000_000n }, depsV1());
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.stage, 'capacity');
    assert.equal(run.refusal, 'over_capacity');
    assert.match(run.review!.refusal!, /about the market, not about this wallet’s collateral/);
  });

  test('an ask beyond both is not reported as a fact about the market alone', async () => {
    const run = await runMorphoBorrowV1({ ...ASK, borrowAssets: 9_000_000_000n }, depsV1());
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.match(run.review!.refusal!, /Neither this wallet’s collateral nor the market’s liquidity/);
  });

  test('a position nobody read is not a wallet with nothing', async () => {
    // The positions query itself failing is the only thing that makes a
    // position unread. An empty RESULT is a measured zero, and the two get
    // different sentences below.
    const run = await runMorphoBorrowV1(ASK, depsV1({ reader: { fetchImpl: readerV1({ positionsFail: true }) } }));
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.refusal, 'position_unread');
    assert.match(run.review!.refusal!, /did not read this wallet’s position/);
  });

  test('a wallet with no collateral here is a measured zero, and says so', async () => {
    const run = await runMorphoBorrowV1(ASK, depsV1({ reader: { fetchImpl: readerV1({ positions: [] }) } }));
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.refusal, 'nothing_to_borrow');
    assert.match(run.review!.refusal!, /nothing to borrow here right now/);
    assert.doesNotMatch(run.review!.refusal!, /did not read/);
  });

  test('a venue that would not prepare anything stops the flow with its own reason', async () => {
    const run = await runMorphoBorrowV1(
      ASK,
      depsV1({ venue: { fetchImpl: venueV1({ calls: [] }) } }),
    );
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.stage, 'venue');
    assert.equal(run.refusal, 'venue_prepared_nothing');
    assert.match(run.review!.refusal!, /did not prepare this borrow/);
  });

  test('a prepared call that moves native value is refused before it is executed', async () => {
    const run = await runMorphoBorrowV1(
      ASK,
      depsV1({
        venue: {
          fetchImpl: venueV1({
            calls: [{ id: 'call_0', kind: 'blue_borrow', to: BUNDLER, data: BUNDLE_DATA, value: '1' }],
          }),
        },
      }),
    );
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.stage, 'venue');
    assert.equal(run.refusal, 'venue_answer_unreadable');
  });
});

describe('the simulation is what binds the review to reality', () => {
  test('no provider answering is a gap in our reading, never a pass', async () => {
    const dead: SimulationProvider = {
      providerId: 'dead',
      async simulate() {
        return { ok: false, errorCode: 'provider_not_configured', detail: 'nothing configured' };
      },
    };
    const run = await runMorphoBorrowV1(
      ASK,
      depsV1({ chain: { providers: [dead], batchCapableIds: new Set(['dead']) } }),
    );
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.stage, 'simulation');
    assert.equal(run.refusal, 'provider_not_configured');
    assert.match(run.review!.refusal!, /gap in Miorail’s reading/);
    assert.doesNotMatch(run.review!.refusal!, /revert/);
  });

  test('a measured revert is refused, and it does not borrow the unmeasured one’s words', async () => {
    const run = await runMorphoBorrowV1(
      ASK,
      depsV1({
        chain: chainV1(
          executedV1({ status: 'reverted', failedCallIndex: 1, revertReason: 'insufficient liquidity', assetChanges: undefined }),
        ),
      }),
    );
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.refusal, 'reverted');
    assert.match(run.review!.refusal!, /revert when executed/);
    assert.doesNotMatch(run.review!.refusal!, /No provider/);
  });

  test('a batch that executes cleanly and delivers something else is refused', async () => {
    // The check no amount of decoding performs.
    const run = await runMorphoBorrowV1(
      ASK,
      depsV1({
        chain: chainV1(
          executedV1({
            assetChanges: {
              status: 'available',
              unavailableReason: null,
              changes: [
                { kind: 'erc20_transfer', token: USDC, direction: 'in', amountAtomic: '9000000', counterparty: MORPHO_BLUE, callIndex: 1 },
              ],
            },
          }),
        ),
      }),
    );
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.refusal, 'wrong_amount_arrived');
    assert.match(run.review!.refusal!, /was read, and it is not what this review describes/);
  });

  test('an executed batch whose effects could not be read is its OWN refusal', async () => {
    const run = await runMorphoBorrowV1(
      ASK,
      depsV1({
        chain: chainV1(
          executedV1({
            assetChanges: { status: 'unavailable', unavailableReason: 'no_logs_emitted', changes: [] },
          }),
        ),
      }),
    );
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.refusal, 'arrival_unread');
    assert.equal(run.detail, 'no_logs_emitted');
    assert.match(run.review!.refusal!, /The calls execute/);
    assert.match(run.review!.refusal!, /gap in Miorail’s reading/);
  });

  test('the venue reverting while we execute stops the flow rather than picking a winner', async () => {
    // Measured live: Morpho returns SIMULATION_REVERTED and two signable
    // transactions in the same answer.
    const run = await runMorphoBorrowV1(
      ASK,
      depsV1({
        venue: {
          fetchImpl: venueV1({
            status: 'simulation_failed', simulation: { status: 'failed' }, calls: [],
          }),
        },
      }),
    );
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.stage, 'venue');
    assert.equal(run.refusal, 'venue_refused');
    assert.equal(run.detail, 'the venue simulation failed');
    assert.match(run.review!.refusal!, /did not prepare/);
  });

  test('the loan asset is the one the market defines, not the one the batch moved most of', async () => {
    // A batch that credits a different token in the right amount must not pass.
    const run = await runMorphoBorrowV1(
      ASK,
      depsV1({
        chain: chainV1(
          executedV1({
            assetChanges: {
              status: 'available',
              unavailableReason: null,
              changes: [
                { kind: 'erc20_transfer', token: NVDAC, direction: 'in', amountAtomic: '10000000', counterparty: MORPHO_BLUE, callIndex: 1 },
              ],
            },
          }),
        ),
      }),
    );
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.refusal, 'nothing_arrived');
  });
});

describe('which market, and whose choice that is', () => {
  test('a collateral with several markets is not resolved on the reader’s behalf', async () => {
    const second = { ...MARKET_ROW_V1, marketId: `0xa${MARKET.slice(3)}` };
    const run = await runMorphoBorrowV1(
      { ...ASK, marketId: null },
      depsV1({ reader: { fetchImpl: readerV1({ markets: [MARKET_ROW_V1, second] }) } }),
    );
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.refusal, 'market_not_named');
    // Both ids travel, so the choice can be made rather than guessed at.
    assert.match(run.detail!, new RegExp(MARKET));
    assert.match(run.detail!, new RegExp(second.marketId));
  });

  test('a market this collateral does not have is refused by name', async () => {
    const run = await runMorphoBorrowV1({ ...ASK, marketId: `0x${'9'.repeat(64)}` }, depsV1());
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.refusal, 'no_such_market_here');
  });
});
