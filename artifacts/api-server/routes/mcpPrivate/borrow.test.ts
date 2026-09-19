import assert from 'node:assert/strict';
import test, { beforeEach, describe } from 'node:test';

import {
  McpPrivateError,
  borrowRuntimeV1,
  miorailReadBorrowCapacityV1,
  miorailReviewBorrowV1,
} from './tools.js';
import {
  MiorailReadBorrowCapacityOutputV1Schema,
  MiorailReviewBorrowOutputV1Schema,
} from './outputs.js';
import type { McpPrivateIdentityV1 } from './session.js';

// ---------------------------------------------------------------------------
// What the two borrow tools may and may not hand an assistant.
//
// The registry test pins that they exist. This one is about what comes back:
// that a review never carries a call, that two markets never collapse into one
// figure, and that each refusal keeps its own sentence.
// ---------------------------------------------------------------------------

const WALLET = '0xfb132f4c6d9dcf4f80483ea7d96c5a5dccfcfe83';
const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
const MARKET = '0xb4b42dd66cef25614b94510a910d54b2c148e7621d22b4271566724beda63d13';
const OTHER_MARKET = `0xa${MARKET.slice(3)}`;

const identity: McpPrivateIdentityV1 = {
  tenantId: `eip155:8453:${WALLET}`,
  walletAddress: WALLET,
  chainId: 8453,
  tokenId: 'token-under-test',
  source: 'handoff_token',
};

const originalRead = borrowRuntimeV1.read;
const originalRun = borrowRuntimeV1.run;

function marketV1(over: Record<string, unknown> = {}): any {
  return {
    market: {
      marketId: MARKET,
      curated: true,
      lltvBps: 6250,
      collateral: { address: NVDAC, symbol: 'NVDAc', decimals: 8 },
      loan: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
      borrowApyWad: 61_200_000_000_000_000n,
      state: {
        collateralPrice: 2_223_700_000_000_000_000_000_000_000_000_000_000n,
        lltvWad: 625_000_000_000_000_000n,
        totalSupplyAssets: 8_431_685_036n,
        totalBorrowAssets: 7_607_079_421n,
        totalBorrowShares: 7_607_079_421_000_000n,
        blockNumber: 51_521_606,
      },
    },
    position: { collateral: 6_441_519_897n, borrowShares: 7_163_511_021_000_000n },
    health: { maxBorrowAssets: 8_950_000_000n, borrowedAssets: 7_163_511_022n, healthy: true, headroomAssets: 1_786_488_978n, healthFactorWad: 1_249_748_238_943_974_500n },
    capacity: {
      assets: 824_605_615n,
      bound: 'market_liquidity',
      collateralHeadroomAssets: 1_786_488_978n,
      marketLiquidityAssets: 824_605_615n,
      roundingMarginAssets: 1n,
    },
    liquidationPrice: 1_779_300_000_000_000_000_000_000_000_000_000_000n,
    liquidationIncentiveWad: 1_126_760_563_380_281_690n,
    venuePublishedDebtAssets: 7_163_511_021n,
    ...over,
  };
}

const REVIEW_V1 = {
  title: 'Borrow 10 USDC',
  market: { id: MARKET, shortId: '0xb4b42dd6', pair: 'NVDAc / USDC', standing: 'On the venue’s own list', lltv: '62.5%', rate: '6.2% variable' },
  ask: '10 USDC',
  before: { collateral: '64.41 NVDAc', debt: '7,163.51 USDC', health: '1.24', liquidationPrice: '$177.93' },
  after: { collateral: '64.41 NVDAc', debt: '7,173.51 USDC', health: '1.24', liquidationPrice: '$178.17' },
  warnings: ['A 14.3% fall in the NVDAc price liquidates this position, and nobody has to warn you first.'],
  notStated: ['The rate is variable.'],
  measuredAt: 'Measured at block 51,521,606',
  verdict: 'ready_for_your_approval' as const,
  refusal: null,
};

beforeEach(() => {
  borrowRuntimeV1.read = originalRead;
  borrowRuntimeV1.run = originalRun;
  borrowRuntimeV1.secret = () => 'a-session-secret-that-is-only-ever-a-test-value';
});

describe('the calculation tool reads and does nothing else', () => {
  test('every market keeps its own row, and every row says what bounded it', async () => {
    borrowRuntimeV1.read = async () =>
      ({
        state: 'read',
        readAt: '2026-09-19T16:00:00.000Z',
        markets: [
          marketV1(),
          marketV1({
            market: { ...marketV1().market, marketId: OTHER_MARKET, curated: false },
            capacity: {
              assets: 0n,
              bound: 'nothing_available',
              collateralHeadroomAssets: 0n,
              marketLiquidityAssets: 0n,
              roundingMarginAssets: 0n,
            },
          }),
        ],
      }) as never;

    const result = await miorailReadBorrowCapacityV1(identity, { collateralTokenAddress: NVDAC });
    MiorailReadBorrowCapacityOutputV1Schema.parse(result);
    const markets = result.markets as any[];
    assert.equal(markets.length, 2);
    assert.equal(markets[0].availableToBorrowAtomic, '824605615');
    assert.equal(markets[0].bound, 'market_liquidity');
    // The collateral supports more than twice what the market holds, and both
    // numbers travel rather than being collapsed into one.
    assert.equal(markets[0].collateralHeadroomAtomic, '1786488978');
    assert.equal(markets[1].availableToBorrowAtomic, '0');
    assert.equal(markets[1].bound, 'nothing_available');
    // And the instruction to the assistant says so in words, not just in data.
    assert.match(String(result.nextStep), /never summarise them into one figure/);
    assert.equal(result.createsCalldata, false);
  });

  test('a market whose oracle said nothing is refused by name, not reported as zero', async () => {
    borrowRuntimeV1.read = async () =>
      ({ state: 'refused', readAt: '2026-09-19T16:00:00.000Z', refusal: 'oracle_did_not_answer', detail: null }) as never;
    const result = await miorailReadBorrowCapacityV1(identity, { collateralTokenAddress: NVDAC });
    MiorailReadBorrowCapacityOutputV1Schema.parse(result);
    assert.equal(result.refusal, 'oracle_did_not_answer');
    assert.deepEqual(result.markets, []);
    assert.match(String(result.nextStep), /Do not substitute a figure/);
  });

  test('a ticker cannot select a collateral', async () => {
    await assert.rejects(
      () => miorailReadBorrowCapacityV1(identity, { collateralTokenAddress: 'NVDAc' }),
      (error: unknown) => error instanceof McpPrivateError,
    );
  });
});

describe('the review tool returns a review and never a call', () => {
  test('a measured borrow produces a draft, a link and no calldata anywhere in the payload', async () => {
    borrowRuntimeV1.run = async () =>
      ({
        state: 'ready',
        marketId: MARKET,
        review: REVIEW_V1,
        calls: [{ index: 0, callType: 'other', to: `0x${'b'.repeat(40)}`, valueWei: '0', data: '0xeecea000', asset: null, amountAtomic: null, recipient: null, spender: null }],
        callsHash: `0x${'1'.repeat(64)}`,
        plan: {
          calls: [],
          steps: [
            { index: 0, to: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', selector: '0xeecea000', venueDescription: 'Authorize Morpho GeneralAdapter1', decodedByMiorail: true, reading: 'Gives 0xb98c… the right to act for this wallet inside Morpho, until it is revoked.' },
            { index: 1, to: '0x6bfd8137e702540e7a42b74178a4a49ba43920c4', selector: '0x374f435d', venueDescription: 'Borrow 10 USDC', decodedByMiorail: false, reading: 'Miorail did not read what this call does.' },
          ],
          authorizations: [],
          targets: [],
          venueSimulation: null,
        },
        measured: { blockNumber: 51_521_606, arrivedAssets: '10000000', providerId: 'base-rpc-eth-simulate-v1' },
      }) as never;

    const result = await miorailReviewBorrowV1(identity, {
      collateralTokenAddress: NVDAC,
      borrowAmountAtomic: '10000000',
      marketId: MARKET,
    });
    MiorailReviewBorrowOutputV1Schema.parse(result);
    assert.equal(result.verdict, 'ready_for_your_approval');
    assert.equal(result.createsCalldata, false);
    assert.match(String(result.reviewUrl), /\/borrow\/miorail-borrow-v1\./);
    assert.equal((result.measured as any).arrivedAtomic, '10000000');

    // The whole payload, searched for the thing it must never contain.
    const everything = JSON.stringify(result);
    assert.doesNotMatch(everything, /"calls"/);
    assert.doesNotMatch(everything, /"valueWei"/);
    assert.doesNotMatch(everything, /"data"\s*:/);
  });

  test('the authorisation that outlives the borrow travels as a step, named', async () => {
    borrowRuntimeV1.run = async () =>
      ({
        state: 'ready',
        marketId: MARKET,
        review: REVIEW_V1,
        calls: [],
        callsHash: `0x${'1'.repeat(64)}`,
        plan: {
          calls: [],
          steps: [
            { index: 0, to: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', selector: '0xeecea000', venueDescription: 'Authorize Morpho GeneralAdapter1', decodedByMiorail: true, reading: 'Gives 0xb98c948cfa24072e58935bc004a8a7b376ae746a the right to act for this wallet inside Morpho, until it is revoked.' },
          ],
          authorizations: [],
          targets: [],
          venueSimulation: null,
        },
        measured: { blockNumber: 51_521_606, arrivedAssets: '10000000', providerId: 'p' },
      }) as never;
    const result = await miorailReviewBorrowV1(identity, {
      collateralTokenAddress: NVDAC,
      borrowAmountAtomic: '10000000',
    });
    const steps = result.steps as any[];
    assert.equal(steps[0].readByMiorail, true);
    assert.match(steps[0].reading, /until it is revoked/);
    assert.match(String(result.nextStep), /measured at one block/);
  });

  test('each refusal keeps its precise code AND the sentence a person reads', async () => {
    for (const [refusal, matcher] of [
      ['provider_not_configured', /gap in Miorail’s reading/],
      ['reverted', /revert when executed/],
      ['arrival_unread', /The calls execute/],
      ['wrong_amount_arrived', /not what this review describes/],
    ] as const) {
      borrowRuntimeV1.run = async () =>
        ({
          state: 'refused',
          stage: 'simulation',
          refusal,
          detail: null,
          marketId: MARKET,
          review: { ...REVIEW_V1, after: null, verdict: 'refused', refusal: matcher.source.replace(/\\/g, '') },
        }) as never;
      const result = await miorailReviewBorrowV1(identity, {
        collateralTokenAddress: NVDAC,
        borrowAmountAtomic: '10000000',
      });
      MiorailReviewBorrowOutputV1Schema.parse(result);
      assert.equal(result.verdict, 'refused');
      assert.equal(result.refusal, refusal);
      assert.equal(result.borrowDraftId, null);
      assert.equal(result.reviewUrl, null);
      assert.equal(result.measured, null);
      assert.deepEqual(result.steps, []);
      assert.match(String(result.nextStep), /Read the refusal out as it is written/);
    }
  });

  test('an amount that is not an exact positive integer never reaches the venue', async () => {
    let called = false;
    borrowRuntimeV1.run = async () => {
      called = true;
      return { state: 'refused', stage: 'venue', refusal: 'x', detail: null, marketId: null, review: null } as never;
    };
    for (const amount of ['0', '-1', '1.5', '', 'max', '1e6']) {
      await assert.rejects(
        () => miorailReviewBorrowV1(identity, { collateralTokenAddress: NVDAC, borrowAmountAtomic: amount }),
        (error: unknown) => error instanceof McpPrivateError,
      );
    }
    assert.equal(called, false);
  });

  test('without a signing secret there is no link, and therefore no review', async () => {
    borrowRuntimeV1.secret = () => null;
    borrowRuntimeV1.run = async () =>
      ({
        state: 'ready',
        marketId: MARKET,
        review: REVIEW_V1,
        calls: [],
        callsHash: `0x${'1'.repeat(64)}`,
        plan: { calls: [], steps: [], authorizations: [], targets: [], venueSimulation: null },
        measured: { blockNumber: 1, arrivedAssets: '10000000', providerId: 'p' },
      }) as never;
    await assert.rejects(
      () => miorailReviewBorrowV1(identity, { collateralTokenAddress: NVDAC, borrowAmountAtomic: '10000000' }),
      (error: unknown) => error instanceof McpPrivateError && error.code === 'borrow_secret_unavailable',
    );
  });
});
