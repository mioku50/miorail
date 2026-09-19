import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { SimulationProvider } from '@mioagent/paid-intelligence';

import { runMorphoBorrowV1 } from './morphoBorrowRunner.js';
import type { SimulationChainV1 } from './swapSimulation.js';

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

/** The venue's MCP, answering `morpho_prepare_borrow` over SSE. */
function venueV1(over: Record<string, unknown> = {}): typeof fetch {
  const payload = {
    operation: 'borrow',
    chain: 'base',
    summary: 'Borrow 10 USDC',
    requirements: [],
    transactions: [
      { to: MORPHO_BLUE, data: AUTHORIZE_DATA, value: '0', chainId: 8453, description: 'Authorize Morpho GeneralAdapter1' },
      { to: BUNDLER, data: BUNDLE_DATA, value: '0', chainId: 8453, description: 'Borrow 10 USDC' },
    ],
    outcome: { market: { maxBorrowable: 1_778_993_850 } },
    simulation: {
      transfers: [{ token: { address: USDC, symbol: 'USDC' }, from: MORPHO_BLUE, to: WALLET, amount: { symbol: 'USDC', value: '10' } }],
      postState: {},
    },
    warnings: [{ level: 'info', message: 'Estimated health factor after borrow: 1.2480' }],
    ...over,
  };
  return (async () =>
    new Response(
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })}\n\n`,
      { status: 200 },
    )) as unknown as typeof fetch;
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

function depsV1(over: Partial<Parameters<typeof runMorphoBorrowV1>[1]> = {}) {
  return {
    reader: { fetchImpl: readerV1(), url: 'https://api.morpho.org/graphql' },
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
      depsV1({ venue: { fetchImpl: venueV1({ transactions: [] }) } }),
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
            transactions: [{ to: BUNDLER, data: BUNDLE_DATA, value: '1', chainId: 8453 }],
          }),
        },
      }),
    );
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.stage, 'plan');
    assert.equal(run.refusal, 'call_moves_native_value');
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
            warnings: [{ level: 'error', code: 'SIMULATION_REVERTED', message: 'Simulation reverted: insufficient liquidity' }],
          }),
        },
      }),
    );
    assert.equal(run.state, 'refused');
    if (run.state !== 'refused') return;
    assert.equal(run.refusal, 'venue_and_miorail_disagree');
    assert.equal(run.detail, 'Simulation reverted: insufficient liquidity');
    assert.match(run.review!.refusal!, /disagree/);
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
