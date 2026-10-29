import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import { rwaBorrowRouter, rwaBorrowRuntimeV1 } from './rwaBorrow.js';
import { issueBorrowDraftV1 } from '../lib/borrowDraft.js';
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

const READY_RUN = {
  state: 'ready' as const,
  marketId: MARKET,
  review: {
    title: 'Borrow 10 USDC',
    market: { id: MARKET, shortId: '0xb4b42dd6', pair: 'NVDAc / USDC', standing: 'On the venue’s own list', lltv: '62.5%', rate: '6.2% variable' },
    ask: '10 USDC',
    before: { collateral: '64.41 NVDAc', debt: '7,163.51 USDC', health: '1.24', liquidationPrice: '$177.93' },
    after: { collateral: '64.41 NVDAc', debt: '7,173.51 USDC', health: '1.24', liquidationPrice: '$178.17' },
    warnings: ['A 14.3% fall in the NVDAc price liquidates this position.'],
    notStated: ['The rate is variable.'],
    measuredAt: 'Measured at block 51,521,606',
    verdict: 'ready_for_your_approval' as const,
    refusal: null,
  },
  calls: [
    { index: 0, callType: 'other', to: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', valueWei: '0', data: '0xeecea000', asset: null, amountAtomic: null, recipient: null, spender: null },
  ],
  callsHash: `0x${'1'.repeat(64)}`,
  signingTermsHash: `0x${'2'.repeat(64)}`,
  expiresAt: '2026-09-19T16:00:30.000Z',
  atomicRequired: true as const,
  plan: {
    calls: [],
    steps: [
      { index: 0, to: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', selector: '0xeecea000', venueDescription: 'Authorize Morpho GeneralAdapter1', decodedByMiorail: true, reading: 'Gives 0xb98c… the right to act for this wallet inside Morpho, until it is revoked.' },
    ],
    authorizations: [{ index: 0, authorized: '0xb98c948cfa24072e58935bc004a8a7b376ae746a', granted: true }],
    targets: ['0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb'],
    venueSimulation: null,
  },
  measured: { blockNumber: 51_521_606, arrivedAssets: '10000000', providerId: 'base-rpc-eth-simulate-v1' },
};

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
});

describe('the review, for a person looking at a screen', () => {
  test('a ready verdict carries the measured calls and the block they were measured at', async () => {
    rwaBorrowRuntimeV1.run = (async () => READY_RUN) as never;
    const response = await request(app())
      .post('/api/route-intelligence/rwa/borrow/review')
      .send({ collateralTokenAddress: NVDAC, borrowAmountAtomic: '10000000', marketId: MARKET })
      .expect(200);
    assert.equal(response.body.state, 'ready');
    assert.equal(response.body.calls.length, 1);
    assert.equal(response.body.callsHash, `0x${'1'.repeat(64)}`);
    assert.equal(response.body.measured.blockNumber, 51_521_606);
    assert.equal(response.body.measured.arrivedAtomic, '10000000');
    assert.equal(response.body.atomicRequired, true);
    // The authorisation is on the screen, named, beside the calls it rides with.
    assert.equal(response.body.authorizations[0].authorized, '0xb98c948cfa24072e58935bc004a8a7b376ae746a');
  });

  test('a refusal carries no field a client could read calls out of', async () => {
    rwaBorrowRuntimeV1.run = (async () => ({
      state: 'refused',
      stage: 'simulation',
      refusal: 'reverted',
      detail: 'insufficient liquidity',
      marketId: MARKET,
      review: { ...READY_RUN.review, after: null, verdict: 'refused', refusal: 'These calls revert when executed against current state.' },
    })) as never;
    const response = await request(app())
      .post('/api/route-intelligence/rwa/borrow/review')
      .send({ collateralTokenAddress: NVDAC, borrowAmountAtomic: '10000000' })
      .expect(200);
    assert.equal(response.body.state, 'refused');
    assert.equal(response.body.refusal, 'reverted');
    assert.equal('calls' in response.body, false);
    assert.equal('callsHash' in response.body, false);
    assert.equal('measured' in response.body, false);
    assert.equal('atomicRequired' in response.body, false);
    assert.equal('funding' in response.body, false);
  });

  test('an amount that is not an exact positive integer never reaches the venue', async () => {
    let called = false;
    rwaBorrowRuntimeV1.run = (async () => {
      called = true;
      return READY_RUN;
    }) as never;
    for (const borrowAmountAtomic of ['0', '10.5', '-1', 'max', '', 10, (1n << 128n).toString()]) {
      await request(app())
        .post('/api/route-intelligence/rwa/borrow/review')
        .send({ collateralTokenAddress: NVDAC, borrowAmountAtomic })
        .expect(400);
    }
    assert.equal(called, false);
  });

  test('passes selected collateral and serializes the atomic funding review', async () => {
    let asked: unknown = null;
    const funding = { type: 'erc20' as const, token: CRYPTO[0]!.token.toLowerCase(), amountAtomic: '1000000' };
    rwaBorrowRuntimeV1.run = (async input => { asked = input; return { ...READY_RUN, funding }; }) as typeof rwaBorrowRuntimeV1.run;
    const response = await request(app()).post('/api/route-intelligence/rwa/borrow/review')
      .send({ collateralTokenAddress: CRYPTO[0]!.token, borrowAmountAtomic: '10000000', collateralSupplyAtomic: '1000000', walletAddress: OTHER }).expect(200);
    assert.deepEqual(asked, { collateralTokenAddress: CRYPTO[0]!.token.toLowerCase(), walletAddress: WALLET, borrowAssets: 10_000_000n, marketId: null, collateralSupplyAssets: 1_000_000n });
    assert.equal(response.body.atomicRequired, true);
    assert.deepEqual(response.body.funding, funding);
  });

  test('refuses unsupported or malformed selected supply before running a review', async () => {
    let called = false;
    rwaBorrowRuntimeV1.run = async () => { called = true; throw new Error('must not run'); };
    await request(app()).post('/api/route-intelligence/rwa/borrow/review')
      .send({ collateralTokenAddress: NVDAC, borrowAmountAtomic: '1', collateralSupplyAtomic: '1' }).expect(400);
    for (const collateralSupplyAtomic of ['-1', '01', '0.1', (1n << 128n).toString()]) {
      await request(app()).post('/api/route-intelligence/rwa/borrow/review')
        .send({ collateralTokenAddress: CRYPTO[0]!.token, borrowAmountAtomic: '1', collateralSupplyAtomic }).expect(400);
    }
    assert.equal(called, false);
  });
});

describe('opening a link an assistant produced', () => {
  const draft = () =>
    issueBorrowDraftV1({
      tenantId: USER.id,
      walletAddress: WALLET,
      collateralTokenAddress: NVDAC,
      marketId: MARKET,
      borrowAssets: 10_000_000n,
      secret: SECRET,
      now: NOW,
    }).draft;

  test('the numbers on the screen come from THIS request, not from the conversation', async () => {
    const asked: unknown[] = [];
    rwaBorrowRuntimeV1.run = (async (input: unknown) => {
      asked.push(input);
      return READY_RUN;
    }) as never;
    const response = await request(app())
      .get(`/api/route-intelligence/rwa/borrow/review/${encodeURIComponent(draft())}`)
      .expect(200);
    assert.equal(response.body.state, 'ready');
    assert.equal(response.body.borrowDraftId.length > 0, true);
    // The whole gate ran again for this open: the draft is a question, not a
    // cached answer.
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0], {
      collateralTokenAddress: NVDAC,
      walletAddress: WALLET,
      borrowAssets: 10_000_000n,
      marketId: MARKET,
    });
  });

  test('another wallet cannot open it, and is told that rather than told it is broken', async () => {
    let called = false;
    rwaBorrowRuntimeV1.run = (async () => {
      called = true;
      return READY_RUN;
    }) as never;
    const other = { id: `eip155:8453:${OTHER}`, address: OTHER, chainId: 8453 as const };
    const response = await request(app(other))
      .get(`/api/route-intelligence/rwa/borrow/review/${encodeURIComponent(draft())}`)
      .expect(403);
    assert.equal(response.body.code, 'borrow_draft_wrong_wallet');
    assert.equal(called, false);
  });

  test('an expired link measures nothing', async () => {
    let called = false;
    rwaBorrowRuntimeV1.run = (async () => {
      called = true;
      return READY_RUN;
    }) as never;
    const link = draft();
    rwaBorrowRuntimeV1.now = () => new Date(NOW.getTime() + 60 * 60 * 1000);
    const response = await request(app())
      .get(`/api/route-intelligence/rwa/borrow/review/${encodeURIComponent(link)}`)
      .expect(400);
    assert.equal(response.body.code, 'borrow_draft_expired');
    assert.equal(called, false);
  });

  test('a forged link measures nothing', async () => {
    let called = false;
    rwaBorrowRuntimeV1.run = (async () => {
      called = true;
      return READY_RUN;
    }) as never;
    const [prefix, body] = draft().split('.');
    await request(app())
      .get(`/api/route-intelligence/rwa/borrow/review/${encodeURIComponent(`${prefix}.${body}.forged`)}`)
      .expect(400);
    assert.equal(called, false);
  });

  test('a selected question link re-runs its exact signed collateral amount for its owner', async () => {
    const issued = issueBorrowDraftV1({ tenantId: USER.id, walletAddress: WALLET, collateralTokenAddress: CRYPTO[0]!.token,
      marketId: CRYPTO[0]!.morphoMarket, borrowAssets: 10_000_000n, collateralSupplyAssets: 1_000_000n, secret: SECRET, now: NOW });
    let asked: unknown = null;
    rwaBorrowRuntimeV1.run = (async input => { asked = input; return READY_RUN; }) as typeof rwaBorrowRuntimeV1.run;
    const response = await request(app()).get(`/api/route-intelligence/rwa/borrow/review/${encodeURIComponent(issued.draft)}`).expect(200);
    assert.equal(response.body.borrowDraftId, issued.borrowDraftId);
    assert.deepEqual(asked, { collateralTokenAddress: CRYPTO[0]!.token.toLowerCase(), walletAddress: WALLET,
      borrowAssets: 10_000_000n, marketId: CRYPTO[0]!.morphoMarket, collateralSupplyAssets: 1_000_000n });
  });
});
