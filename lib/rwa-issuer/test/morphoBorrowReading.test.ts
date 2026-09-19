import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  readMorphoBorrowStandingV1,
  type MorphoBorrowReadingV1,
} from '../src/morphoBorrowReading.js';

// ---------------------------------------------------------------------------
// Every test here is about an input that is missing, because that is the half
// this module exists for. The arithmetic is proven next door; what is proven
// here is that no number is invented when the thing it needs was not read.
//
// The market fixture is the live NVDAc shape at block 51,521,606: an
// EIGHT-decimal collateral against 6-decimal USDC at 62.5%, $8,430 supplied
// against $7,607 borrowed, oracle at $222.37.
// ---------------------------------------------------------------------------

const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
const WALLET = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const CURATED_MARKET = '0xb4b42dd66cef25614b94510a910d54b2c148e7621d22b4271566724beda63d13';
const EMPTY_MARKET = '0x5c800e8607e9000000000000000000000000000000000000000000000000aaaa';

const LIVE_MARKET_V1 = {
  marketId: CURATED_MARKET,
  lltv: '625000000000000000',
  listed: true,
  collateralAsset: { symbol: 'NVDAc', decimals: 8 },
  loanAsset: { symbol: 'USDC', decimals: 6 },
  state: {
    blockNumber: 51_521_606,
    price: '2223700000000000000000000000000000000',
    supplyAssets: '8430896050',
    borrowAssets: '7607011096',
    borrowShares: '7589420204446323',
    borrowApy: 0.0612,
  },
};

/** A market whose oracle answered nothing — the fourth NVDAc market, measured. */
const PRICELESS_MARKET_V1 = {
  ...LIVE_MARKET_V1,
  marketId: EMPTY_MARKET,
  listed: false,
  lltv: '770000000000000000',
  state: { ...LIVE_MARKET_V1.state, price: null, supplyAssets: '0', borrowAssets: '0', borrowShares: '0' },
};

/** One live borrower from that market, verbatim. */
const LIVE_POSITION_V1 = {
  market: { marketId: CURATED_MARKET },
  state: { collateral: '6441519897', borrowShares: '7146881511822990', borrowAssets: '7163446679' },
};

function stubFetchV1(responses: {
  markets?: unknown[];
  positions?: unknown[];
  marketsThrow?: boolean;
  positionsThrow?: boolean;
}): typeof fetch {
  return (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
    const wantsPositions = /marketPositions/.test(body.query ?? '');
    if (wantsPositions ? responses.positionsThrow : responses.marketsThrow) {
      return { ok: false, status: 502, json: async () => ({}) } as unknown as Response;
    }
    const data = wantsPositions
      ? { marketPositions: { items: responses.positions ?? [] } }
      : { markets: { items: responses.markets ?? [] } };
    return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

const deps = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  now: () => new Date('2026-09-19T14:00:00.000Z'),
});

function assertRead(reading: MorphoBorrowReadingV1) {
  // Built without JSON.stringify: this payload is full of BigInt, and a
  // message argument is evaluated whether or not the assertion fails.
  assert.equal(
    reading.state,
    'read',
    reading.state === 'refused' ? `refused: ${reading.refusal} ${reading.detail ?? ''}` : 'not a reading',
  );
  return reading as Extract<MorphoBorrowReadingV1, { state: 'read' }>;
}

describe('an input nobody read produces no number', () => {
  test('no wallet is a refusal, not a market-only answer', async () => {
    // A caller asking what can be borrowed is asking about somebody. Answering
    // about nobody is the conflation this whole product exists to avoid.
    const reading = await readMorphoBorrowStandingV1({
      tokenAddress: NVDAC,
      walletAddress: null,
      deps: deps(stubFetchV1({ markets: [LIVE_MARKET_V1] })),
    });
    assert.equal(reading.state, 'refused');
    assert.equal(reading.state === 'refused' && reading.refusal, 'no_wallet_given');
  });

  test('an oracle that answered nothing is named, never priced at zero', async () => {
    // Zero would compute a maximum borrow of zero and render "you can borrow
    // nothing" — a measured-sounding refusal resting on no measurement.
    const reading = await readMorphoBorrowStandingV1({
      tokenAddress: NVDAC,
      walletAddress: WALLET,
      deps: deps(stubFetchV1({ markets: [PRICELESS_MARKET_V1] })),
    });
    assert.equal(reading.state, 'refused');
    assert.equal(reading.state === 'refused' && reading.refusal, 'oracle_did_not_answer');
  });

  test('one priceless market does not silence the ones that answered', async () => {
    const reading = assertRead(
      await readMorphoBorrowStandingV1({
        tokenAddress: NVDAC,
        walletAddress: WALLET,
        deps: deps(stubFetchV1({ markets: [PRICELESS_MARKET_V1, LIVE_MARKET_V1], positions: [] })),
      }),
    );
    assert.equal(reading.markets.length, 1);
    assert.equal(reading.markets[0]!.market.marketId, CURATED_MARKET);
  });

  test('a venue that did not answer about the wallet leaves the position null', async () => {
    // Not a zero position. "Nobody read this" and "this wallet holds nothing"
    // support completely different sentences.
    const reading = assertRead(
      await readMorphoBorrowStandingV1({
        tokenAddress: NVDAC,
        walletAddress: WALLET,
        deps: deps(stubFetchV1({ markets: [LIVE_MARKET_V1], positionsThrow: true })),
      }),
    );
    assert.equal(reading.markets[0]!.position, null);
    assert.equal(reading.markets[0]!.health, null);
    assert.equal(reading.markets[0]!.capacity, null);
    assert.equal(reading.markets[0]!.liquidationPrice, null);
    // The market's own terms are still known, and still published.
    assert.equal(reading.markets[0]!.market.lltvBps, 6250);
    assert.notEqual(reading.markets[0]!.liquidationIncentiveWad, 0n);
  });

  test('a venue that answered and named no position gives a measured empty one', async () => {
    const reading = assertRead(
      await readMorphoBorrowStandingV1({
        tokenAddress: NVDAC,
        walletAddress: WALLET,
        deps: deps(stubFetchV1({ markets: [LIVE_MARKET_V1], positions: [] })),
      }),
    );
    const row = reading.markets[0]!;
    assert.deepEqual(row.position, { collateral: 0n, borrowShares: 0n });
    assert.equal(row.health!.borrowedAssets, 0n);
    assert.equal(row.health!.healthFactorWad, null);
    // No collateral means nothing to borrow against, and the bound says so
    // without blaming the market.
    assert.equal(row.capacity!.assets, 0n);
    assert.equal(row.capacity!.bound, 'nothing_available');
    assert.equal(row.capacity!.marketLiquidityAssets, 8_430_896_050n - 7_607_011_096n);
  });

  test('the venue failing outright is a refusal that names the venue, not the token', async () => {
    const reading = await readMorphoBorrowStandingV1({
      tokenAddress: NVDAC,
      walletAddress: WALLET,
      deps: deps(stubFetchV1({ marketsThrow: true })),
    });
    assert.equal(reading.state, 'refused');
    assert.equal(reading.state === 'refused' && reading.refusal, 'venue_unread');
  });

  test('no market for the address is its own answer', async () => {
    const reading = await readMorphoBorrowStandingV1({
      tokenAddress: NVDAC,
      walletAddress: WALLET,
      deps: deps(stubFetchV1({ markets: [] })),
    });
    assert.equal(reading.state, 'refused');
    assert.equal(reading.state === 'refused' && reading.refusal, 'no_market_for_this_address');
  });
});

describe('a position that was read', () => {
  test('the live borrower reproduces the venue’s own figures', async () => {
    const reading = assertRead(
      await readMorphoBorrowStandingV1({
        tokenAddress: NVDAC,
        walletAddress: WALLET,
        deps: deps(stubFetchV1({ markets: [LIVE_MARKET_V1], positions: [LIVE_POSITION_V1] })),
      }),
    );
    const row = reading.markets[0]!;
    assert.equal(row.position!.collateral, 6_441_519_897n);
    // Ours is the contract's `toAssetsUp`; the venue publishes `toAssetsDown`.
    // Both travel, and they differ by exactly one unit.
    assert.equal(row.venuePublishedDebtAssets, 7_163_446_679n);
    assert.equal(row.health!.borrowedAssets, 7_163_446_680n);
    assert.equal(row.health!.healthy, true);
    // Health factor ≈ 1.2497, as Morpho published for this wallet.
    const hf = Number(row.health!.healthFactorWad) / 1e18;
    assert.ok(Math.abs(hf - 1.2497482389439745) < 1e-6, `health factor was ${hf}`);
    // This borrower's collateral allows far more than the market holds.
    assert.equal(row.capacity!.bound, 'market_liquidity');
    assert.equal(row.capacity!.assets, 8_430_896_050n - 7_607_011_096n);
    assert.notEqual(row.liquidationPrice, null);
  });

  test('the market is carried in integer basis points, and the block travels', async () => {
    const reading = assertRead(
      await readMorphoBorrowStandingV1({
        tokenAddress: NVDAC,
        walletAddress: WALLET,
        deps: deps(stubFetchV1({ markets: [LIVE_MARKET_V1], positions: [] })),
      }),
    );
    const row = reading.markets[0]!;
    assert.equal(row.market.lltvBps, 6250);
    assert.equal(row.market.state.blockNumber, 51_521_606);
    assert.equal(row.market.collateral.decimals, 8);
    assert.equal(row.market.loan.decimals, 6);
    assert.equal(reading.readAt, '2026-09-19T14:00:00.000Z');
  });

  test('curated first, then by what this wallet could actually borrow', async () => {
    const shallow = {
      ...LIVE_MARKET_V1,
      marketId: '0x91360eea2686000000000000000000000000000000000000000000000000ffff',
      listed: false,
      state: { ...LIVE_MARKET_V1.state, supplyAssets: '98000127', borrowAssets: '1000125' },
    };
    const reading = assertRead(
      await readMorphoBorrowStandingV1({
        tokenAddress: NVDAC,
        walletAddress: WALLET,
        deps: deps(stubFetchV1({ markets: [shallow, LIVE_MARKET_V1], positions: [LIVE_POSITION_V1] })),
      }),
    );
    assert.equal(reading.markets[0]!.market.curated, true);
    assert.equal(reading.markets[0]!.market.marketId, CURATED_MARKET);
  });
});
