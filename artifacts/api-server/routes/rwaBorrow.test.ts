import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import { rwaBorrowRouter, rwaBorrowRuntimeV1 } from './rwaBorrow.js';
import { verifyLendingDraftV1 } from '../lib/lendingDraft.js';
import { morphoBorrowCapacityV1, morphoHealthV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import type { MorphoBorrowStandingV1 } from '@mioagent/rwa-issuer/morphoBorrowReading';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';

const WALLET = '0xfb132f4c6d9dcf4f80483ea7d96c5a5dccfcfe83';
const OTHER = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
const MARKET = '0xb4b42dd66cef25614b94510a910d54b2c148e7621d22b4271566724beda63d13';
const SECRET = 'a-session-secret-that-is-only-ever-a-test-value';
const NOW = new Date('2026-09-19T16:00:00.000Z');

const original = { ...rwaBorrowRuntimeV1 };

function app(user: typeof USER | null = USER) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  server.use('/api/route-intelligence', rwaBorrowRouter);
  return server;
}

function cryptoReading(walletCollateralAssets: bigint | null = 2_000_000n) {
  const asset = CRYPTO[0]!;
  const state = { collateralPrice: 10n ** 36n, lltvWad: 860_000_000_000_000_000n,
    totalSupplyAssets: 1_000_000_000_000n, totalBorrowAssets: 0n, totalBorrowShares: 0n, blockNumber: 53_000_000 };
  const position = { collateral: 1_000_000n, borrowShares: 0n };
  const row: MorphoBorrowStandingV1 = {
    market: { marketId: asset.morphoMarket, curated: null, lltvBps: 8600,
      collateral: { address: asset.token, symbol: asset.symbol, decimals: asset.decimals },
      loan: { address: ADDRESSES.usdc, symbol: 'USDC', decimals: 6 }, borrowApyWad: null, state },
    position, walletCollateralAssets, health: morphoHealthV1({ market: state, position }),
    capacity: morphoBorrowCapacityV1({ market: state, position }), liquidationPrice: null,
    liquidationIncentiveWad: 1_000_000_000_000_000_000n, venuePublishedDebtAssets: null,
  };
  return { state: 'read' as const, readAt: NOW.toISOString(), markets: [row] };
}

afterEach(() => {
  Object.assign(rwaBorrowRuntimeV1, original);
});

beforeEach(() => {
  rwaBorrowRuntimeV1.secret = () => SECRET;
  rwaBorrowRuntimeV1.now = () => NOW;
});

describe('the capacity read', () => {
  test('a session is required before anything is read', async () => {
    let called = false;
    rwaBorrowRuntimeV1.read = (async () => {
      called = true;
      return { state: 'refused', readAt: '', refusal: 'venue_unread', detail: null };
    }) as never;
    await request(app(null)).get(`/api/route-intelligence/rwa/borrow/capacity?token=${NVDAC}`).expect(401);
    assert.equal(called, false);
  });

  test('a token that is not an exact address is a 400, not an empty answer', async () => {
    await request(app()).get('/api/route-intelligence/rwa/borrow/capacity?token=NVDAc').expect(400);
  });

  test('each market keeps both constraints and the fact that bounded it', async () => {
    rwaBorrowRuntimeV1.read = (async () => ({
      state: 'read',
      readAt: '2026-09-19T16:00:00.000Z',
      markets: [
        {
          market: {
            marketId: MARKET,
            curated: true,
            lltvBps: 6250,
            collateral: { address: NVDAC, symbol: 'NVDAc', decimals: 8 },
            loan: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
            borrowApyWad: null,
            state: { collateralPrice: 1n, lltvWad: 1n, totalSupplyAssets: 1n, totalBorrowAssets: 0n, totalBorrowShares: 0n, blockNumber: 51_521_606 },
          },
          position: { collateral: 6_441_519_897n, borrowShares: 0n },
          health: { maxBorrowAssets: 1n, borrowedAssets: 0n, healthy: true, headroomAssets: 1n, healthFactorWad: null },
          capacity: {
            assets: 824_605_615n,
            bound: 'market_liquidity',
            collateralHeadroomAssets: 1_786_488_978n,
            marketLiquidityAssets: 824_605_615n,
            roundingMarginAssets: 1n,
          },
          liquidationPrice: null,
          liquidationIncentiveWad: 1n,
          venuePublishedDebtAssets: null,
        },
      ],
    })) as never;

    const response = await request(app()).get(`/api/route-intelligence/rwa/borrow/capacity?token=${OTHER}`).expect(200);
    assert.equal(response.body.state, 'read');
    const row = response.body.markets[0];
    assert.equal(row.availableToBorrowAtomic, '824605615');
    assert.equal(row.collateralHeadroomAtomic, '1786488978');
    assert.equal(row.marketLiquidityAtomic, '824605615');
    assert.equal(row.bound, 'market_liquidity');
    // A health factor of null is null, never a number standing in for one.
    assert.equal(row.healthFactorWad, null);
  });

  test('projects only the selected crypto supply and keeps wallet, pledged and Still amounts separate', async () => {
    const asked: unknown[] = [];
    rwaBorrowRuntimeV1.read = async input => { asked.push(input); return cryptoReading(); };
    const response = await request(app()).get('/api/route-intelligence/rwa/borrow/capacity')
      .query({ token: CRYPTO[0]!.token, collateralSupplyAtomic: '1000000', walletAddress: OTHER }).expect(200);
    assert.deepEqual(asked, [{ tokenAddress: CRYPTO[0]!.token.toLowerCase(), walletAddress: WALLET }]);
    assert.equal(response.body.state, 'read');
    assert.equal(response.body.marketScope, 'still_registered_market');
    const row = response.body.markets[0];
    assert.equal(row.walletCollateralAtomic, '2000000');
    assert.equal(row.collateralAtomic, '1000000');
    assert.equal(row.collateralSupplyAtomic, '1000000');
    assert.equal(row.still.scope, 'selected_collateral');
    assert.equal(row.still.collateralSupplyAtomic, '1000000');
    assert.equal(row.still.availableAtomic, '860000');
    const existingProtocol = cryptoReading().markets[0]!.capacity!;
    assert(BigInt(row.availableToBorrowAtomic) > existingProtocol.assets);
    assert(BigInt(row.collateralHeadroomAtomic) > existingProtocol.collateralHeadroomAssets);
    assert(BigInt(row.still.availableAtomic) <= BigInt(row.availableToBorrowAtomic));
    assert.equal('calls' in response.body, false);
  });

  test('an omitted supply reads the old existing-collateral capacity even while wallet balance is unread', async () => {
    rwaBorrowRuntimeV1.read = async () => cryptoReading(null);
    const response = await request(app()).get('/api/route-intelligence/rwa/borrow/capacity').query({ token: CRYPTO[0]!.token }).expect(200);
    const row = response.body.markets[0];
    assert.equal(row.walletCollateralAtomic, null);
    assert.equal(row.collateralSupplyAtomic, '0');
    assert.equal(row.still.scope, 'existing_collateral');
    assert.equal(row.still.availableAtomic, '430000');
    assert.equal(row.availableToBorrowAtomic, cryptoReading(null).markets[0]!.capacity!.assets.toString());
  });

  for (const [balance, code] of [[null, 'wallet_collateral_unread'], [0n, 'wallet_collateral_insufficient'], [999_999n, 'wallet_collateral_insufficient']] as const) {
    test(`does not offer a selected projection when its wallet balance is ${balance}`, async () => {
      rwaBorrowRuntimeV1.read = async () => cryptoReading(balance);
      const response = await request(app()).get('/api/route-intelligence/rwa/borrow/capacity')
        .query({ token: CRYPTO[0]!.token, collateralSupplyAtomic: '1000000' }).expect(200);
      assert.equal(response.body.state, 'refused');
      assert.equal(response.body.refusal, code);
      assert.deepEqual(response.body.markets, []);
      assert.equal('still' in response.body, false);
      assert.equal('calls' in response.body, false);
    });
  }

  test('an absent balance is unread rather than zero', async () => {
    rwaBorrowRuntimeV1.read = async () => {
      const reading = cryptoReading();
      delete reading.markets[0]!.walletCollateralAssets;
      return reading;
    };
    const response = await request(app()).get('/api/route-intelligence/rwa/borrow/capacity')
      .query({ token: CRYPTO[0]!.token, collateralSupplyAtomic: '1' }).expect(200);
    assert.equal(response.body.refusal, 'wallet_collateral_unread');
  });

  test('a refused chain reading remains a reading failure without a projection', async () => {
    rwaBorrowRuntimeV1.read = async () => ({ state: 'refused', refusal: 'venue_unread', detail: 'fixture unread', readAt: NOW.toISOString() });
    const response = await request(app()).get('/api/route-intelligence/rwa/borrow/capacity')
      .query({ token: CRYPTO[0]!.token, collateralSupplyAtomic: '1' }).expect(200);
    assert.equal(response.body.refusal, 'venue_unread');
    assert.deepEqual(response.body.markets, []);
  });

  test('unsupported supply and noncanonical bounded query amounts never reach a reader', async () => {
    let called = false;
    rwaBorrowRuntimeV1.read = async () => { called = true; return cryptoReading(); };
    for (const value of ['', '-1', '01', '1.0', ' 1', (1n << 128n).toString(), '1'.repeat(1000)]) {
      await request(app()).get('/api/route-intelligence/rwa/borrow/capacity')
        .query({ token: CRYPTO[0]!.token, collateralSupplyAtomic: value }).expect(400);
    }
    await request(app()).get('/api/route-intelligence/rwa/borrow/capacity')
      .query({ token: CRYPTO[0]!.token, collateralSupplyAtomic: ['1', '2'] }).expect(400);
    const unsupported = await request(app()).get('/api/route-intelligence/rwa/borrow/capacity')
      .query({ token: OTHER, collateralSupplyAtomic: '1' }).expect(400);
    assert.equal(unsupported.body.code, 'borrow_collateral_not_supported');
    assert.equal(called, false);
  });

  test('projects explicit native ETH funding on the WETH market and refuses when the fee reserve is breached', async () => {
    const weth = CRYPTO[1]!;
    rwaBorrowRuntimeV1.read = (async (input: { nativeFunding?: boolean }) => {
      assert.equal(input.nativeFunding, true);
      const base = cryptoReading(0n);
      base.markets[0]!.market.marketId = weth.morphoMarket;
      base.markets[0]!.market.collateral = { address: weth.token, symbol: 'WETH', decimals: 18 };
      return {
        ...base,
        nativeFunding: { balance: 10_500_000_000_000_000n, params: {} as never, deployment: {} as never },
      };
    }) as never;
    const ok = await request(app()).get('/api/route-intelligence/rwa/borrow/capacity')
      .query({ token: weth.token, collateralSupplyAtomic: '10000000000000000', funding: 'native' }).expect(200);
    assert.equal(ok.body.state, 'read');
    assert.equal(ok.body.markets[0].funding, 'native');
    assert.equal(ok.body.markets[0].nativeReserveAtomic, '500000000000000');
    assert.equal(ok.body.markets[0].feeQuoteState, 'wallet_quote_required');
    assert.equal(ok.body.markets[0].walletCollateralAtomic, '10500000000000000');

    const breached = await request(app()).get('/api/route-intelligence/rwa/borrow/capacity')
      .query({ token: weth.token, collateralSupplyAtomic: '10000000000000001', funding: 'native' }).expect(200);
    assert.equal(breached.body.state, 'refused');
    assert.equal(breached.body.refusal, 'native_fee_reserve_insufficient');
    // The numbers that say what can be done, not "unread or would spend".
    assert.equal(breached.body.detail,
      'This wallet holds 0.0105 ETH. Still leaves 0.0005 ETH in it for network fees, so you can add up to 0.01 ETH.');
    assert.equal(breached.body.walletNativeAtomic, '10500000000000000');
    assert.equal(breached.body.maximumNativeAtomic, '10000000000000000');

    // A balance nobody read is its own answer, with no figure in it.
    rwaBorrowRuntimeV1.read = (async () => {
      const base = cryptoReading(0n);
      base.markets[0]!.market.marketId = weth.morphoMarket;
      return { ...base, nativeFunding: { balance: null, params: {} as never, deployment: {} as never } };
    }) as never;
    const unread = await request(app()).get('/api/route-intelligence/rwa/borrow/capacity')
      .query({ token: weth.token, collateralSupplyAtomic: '1000', funding: 'native' }).expect(200);
    assert.equal(unread.body.refusal, 'native_balance_unread');
    assert.doesNotMatch(unread.body.detail, /\d/);
    assert.equal(unread.body.maximumNativeAtomic, undefined);

    await request(app()).get('/api/route-intelligence/rwa/borrow/capacity')
      .query({ token: weth.token, collateralSupplyAtomic: '0', funding: 'native' }).expect(400);
    await request(app()).get('/api/route-intelligence/rwa/borrow/capacity')
      .query({ token: CRYPTO[0]!.token, collateralSupplyAtomic: '1', funding: 'native' }).expect(400);
  });
});

describe('a selected borrow intent is only a wallet-bound question', () => {
  const selected = { collateralTokenAddress: CRYPTO[0]!.token, borrowAmountAtomic: '10000000', collateralSupplyAtomic: '1000000' };

  test('mints the selected question without reading, preparing, simulating or returning calls', async () => {
    let read = false, run = false;
    rwaBorrowRuntimeV1.read = async () => { read = true; throw new Error('must not read'); };
    rwaBorrowRuntimeV1.run = async () => { run = true; throw new Error('must not prepare'); };
    const response = await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send(selected).expect(200);
    assert.deepEqual(Object.keys(response.body).sort(), ['borrowDraftId', 'draft', 'expiresAt', 'reviewUrl']);
    assert.equal(response.body.reviewUrl, `/lending/${encodeURIComponent(response.body.draft)}`);
    assert.equal(response.body.expiresAt, new Date(NOW.getTime() + 5 * 60_000).toISOString());
    const verified = verifyLendingDraftV1({ draft: response.body.draft, secret: SECRET, now: NOW, walletAddress: WALLET, tenantId: USER.id });
    assert(verified.ok);
    assert.equal(verified.claims.question.operation, 'borrow');
    if (verified.claims.question.operation !== 'borrow') throw new Error('unexpected question');
    assert.equal(verified.claims.tenantId, USER.id);
    assert.equal(verified.claims.walletAddress, WALLET);
    assert.equal(verified.claims.marketId, CRYPTO[0]!.morphoMarket);
    assert.equal(verified.claims.question.collateralTokenAddress, CRYPTO[0]!.token.toLowerCase());
    assert.equal(verified.claims.question.borrowAssets, '10000000');
    assert.equal(verified.claims.question.collateralSupplyAssets, '1000000');
    assert.equal(read, false);
    assert.equal(run, false);
  });

  test('zero selected supply is a valid existing-collateral question, not an implicit wallet max', async () => {
    const response = await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send({ ...selected, collateralSupplyAtomic: '0' }).expect(200);
    const verified = verifyLendingDraftV1({ draft: response.body.draft, secret: SECRET, now: NOW, walletAddress: WALLET, tenantId: USER.id });
    assert(verified.ok);
    assert.equal(verified.claims.question.operation, 'borrow');
    if (verified.claims.question.operation !== 'borrow') throw new Error('unexpected question');
    assert.equal(verified.claims.question.collateralSupplyAssets, '0');
  });

  test('accepts the uint128 maximum as a bounded question, without claiming the wallet can fund it', async () => {
    const maximum = ((1n << 128n) - 1n).toString();
    const response = await request(app()).post('/api/route-intelligence/rwa/borrow/intent')
      .send({ ...selected, borrowAmountAtomic: maximum, collateralSupplyAtomic: maximum }).expect(200);
    const verified = verifyLendingDraftV1({ draft: response.body.draft, secret: SECRET, now: NOW, walletAddress: WALLET, tenantId: USER.id });
    assert(verified.ok);
    assert.equal(verified.claims.question.operation, 'borrow');
    if (verified.claims.question.operation !== 'borrow') throw new Error('unexpected question');
    assert.equal(verified.claims.question.borrowAssets, maximum);
    assert.equal(verified.claims.question.collateralSupplyAssets, maximum);
    assert.equal('calls' in response.body, false);
  });

  test('requires an authenticated correctly bound Base session', async () => {
    await request(app(null)).post('/api/route-intelligence/rwa/borrow/intent').send(selected).expect(401);
    await request(app({ ...USER, id: `eip155:8453:${OTHER}` })).post('/api/route-intelligence/rwa/borrow/intent').send(selected).expect(401);
  });

  test('an absent signing secret is a plain unavailable response, not a leaked value or unsigned link', async () => {
    rwaBorrowRuntimeV1.secret = () => '';
    const response = await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send(selected).expect(503);
    assert.deepEqual(response.body, { error: 'borrow_secret_unavailable', code: 'borrow_secret_unavailable' });
  });

  test('does not accept client wallets, tenants, markets, routers, calls or missing fields', async () => {
    for (const extra of [{ walletAddress: OTHER }, { tenantId: `eip155:8453:${OTHER}` }, { marketId: MARKET }, { router: OTHER }, { calls: [] }]) {
      await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send({ ...selected, ...extra }).expect(400);
    }
    await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send({ collateralTokenAddress: selected.collateralTokenAddress, borrowAmountAtomic: '1' }).expect(400);
    await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send([]).expect(400);
  });

  test('requires canonical bounded loan and collateral atoms and a registered token', async () => {
    for (const borrowAmountAtomic of ['0', '', '-1', '01', '1.0', ' 1', '1e6', 1, (1n << 128n).toString(), '1'.repeat(1000)]) {
      await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send({ ...selected, borrowAmountAtomic }).expect(400);
    }
    for (const collateralSupplyAtomic of ['', '-1', '01', '1.0', ' 1', 1, (1n << 128n).toString()]) {
      await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send({ ...selected, collateralSupplyAtomic }).expect(400);
    }
    const response = await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send({ ...selected, collateralTokenAddress: OTHER }).expect(400);
    assert.equal(response.body.code, 'borrow_collateral_not_supported');
  });

  test('mints a v2 signed question for explicit native ETH funding and rejects mismatched or non-WETH native funding', async () => {
    const weth = CRYPTO[1]!.token;
    const response = await request(app()).post('/api/route-intelligence/rwa/borrow/intent')
      .send({ collateralTokenAddress: weth, borrowAmountAtomic: '3000000', collateralSupplyAtomic: '10000000000000000', nativeFundingAtomic: '10000000000000000' }).expect(200);
    assert.match(response.body.draft, /^miorail-lending-v2\./);
    const verified = verifyLendingDraftV1({ draft: response.body.draft, secret: SECRET, now: NOW, walletAddress: WALLET, tenantId: USER.id });
    assert(verified.ok && verified.claims.question.operation === 'borrow');
    assert.equal(verified.claims.question.nativeFundingAssets, '10000000000000000');
    for (const bad of [
      { collateralTokenAddress: CRYPTO[0]!.token, borrowAmountAtomic: '3000000', collateralSupplyAtomic: '10', nativeFundingAtomic: '10' },
      { collateralTokenAddress: weth, borrowAmountAtomic: '3000000', collateralSupplyAtomic: '10', nativeFundingAtomic: '9' },
      { collateralTokenAddress: weth, borrowAmountAtomic: '3000000', collateralSupplyAtomic: '0', nativeFundingAtomic: '0' },
    ]) {
      await request(app()).post('/api/route-intelligence/rwa/borrow/intent').send(bad).expect(400);
    }
  });
});

// Audit LEND-6 (2026-11-11): the two routes that answered a borrow review with its calls are gone. They
// handed out executable calls with no record in lending_executions; every review is the owned lending one.
describe('a borrow review with calls is answered by the lending review alone', () => {
  test('the old review routes do not exist, by an amount or by a draft, signed in or not', async () => {
    for (const session of [true, false]) {
      const server = app(session ? undefined : null);
      assert.equal((await request(server).post('/api/route-intelligence/rwa/borrow/review')
        .send({ collateralTokenAddress: NVDAC, borrowAmountAtomic: '100000000' })).status, 404);
      assert.equal((await request(server).get('/api/route-intelligence/rwa/borrow/review/miorail-borrow-v1.any.thing')).status, 404);
    }
  });
});
