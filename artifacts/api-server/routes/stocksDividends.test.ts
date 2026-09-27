import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import type { B20BlockHeaderV1, B20ReaderV1 } from '@mioagent/b20-control';
import { DividendWalletResponseV1Schema } from '@mioagent/rwa-market-reality/dividend-wallet';
import { dividendCalendarV1, type DividendTokenV1 } from '@mioagent/rwa-market-reality/dividends';

import { createDividendWalletCachesV1 } from '../lib/dividendWalletRead.js';
import { stocksDividendsCacheV1, stocksDividendsRouter, stocksDividendsRuntime } from './stocksDividends.js';

const WALLET = '0x8e525bfce1ef40aa8075ef64e45421b5855c8909';
const SOMEONE_ELSE = '0x1111111111111111111111111111111111111111';
const NOW = new Date('2026-09-27T12:00:00.000Z');
const WAD = '1000000000000000000';
const GOOGL_AFTER = '1000377118676784179';
const CONVERTED_AT = '2026-09-14T18:29:21.000Z';
const GOOGLC = '0xb2000000000000000000002d0ba3164cc74f58b7';
const METAC = '0xb2000000000000000000008bc8786b856e61707c';

function token(input: Partial<DividendTokenV1> & Pick<DividendTokenV1, 'tokenAddress' | 'symbol' | 'underlyingKey'>): DividendTokenV1 {
  return {
    tokenSymbol: `${input.symbol}c`,
    company: input.symbol,
    reading: { multiplierWad: WAD, readAt: '2026-09-27T03:18:00.000Z' },
    changes: [],
    scheduled: [],
    supplyAtRecord: {},
    priceNow: 100,
    ...input,
  };
}

const CALENDAR = dividendCalendarV1({
  now: NOW,
  tokens: [
    token({
      tokenAddress: GOOGLC,
      symbol: 'GOOGL',
      underlyingKey: 'security:isin:US02079K3059',
      reading: { multiplierWad: GOOGL_AFTER, readAt: '2026-09-27T03:18:00.000Z' },
      changes: [{ fromWad: WAD, toWad: GOOGL_AFTER, at: CONVERTED_AT, confirmed: true, priceAt: 347.1 }],
      supplyAtRecord: { '2026-09-07': '6113.6938' },
      priceNow: 350,
    }),
    token({ tokenAddress: METAC, symbol: 'META', underlyingKey: 'security:isin:US30303M1027', priceNow: 749 }),
  ],
});

/** Two-second blocks from 2026-06-01. The wallet held 2.5 GOOGLc until the
 * block that converted, and 4 from then on; one METAc throughout. */
function readerV1() {
  const start = Date.parse('2026-06-01T00:00:00Z') / 1000;
  const head = 5_200_000;
  const converted = Date.parse(CONVERTED_AT) / 1000;
  const asked: string[] = [];
  let calls = 0;
  const header = (n: number): B20BlockHeaderV1 => ({
    blockNumber: n,
    blockHash: `0x${n.toString(16).padStart(64, '0')}` as never,
    timestamp: start + (n - 1) * 2,
  });
  const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
  const reader = {
    async readBlockAnchor() {
      return { ok: true as const, value: { blockNumber: String(head), blockHash: header(head).blockHash, blockTag: `0x${head.toString(16)}` }, raw: 'x' };
    },
    async readBlockHeader(tag: string) {
      const n = tag === 'latest' ? head : Number.parseInt(tag, 16);
      return { ok: true as const, value: n > head ? null : header(n), raw: 'x' };
    },
    async call(input: { to: string; data: string; blockTag: string }) {
      calls += 1;
      if (input.data === '0x313ce567') return { ok: true as const, value: word(8n), raw: 'x' };
      asked.push(`0x${input.data.slice(-40)}`);
      const time = header(Number.parseInt(input.blockTag, 16)).timestamp;
      if (input.to === GOOGLC) return { ok: true as const, value: word(time < converted ? 250_000_000n : 400_000_000n), raw: 'x' };
      if (input.to === METAC) return { ok: true as const, value: word(100_000_000n), raw: 'x' };
      return { ok: true as const, value: word(0n), raw: 'x' };
    },
  } as unknown as B20ReaderV1;
  return { reader, asked, calls: () => calls };
}

function app(user: unknown = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 }) {
  const server = express();
  server.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = user ? { user } : {};
    next();
  });
  server.use('/stocks/dividends', stocksDividendsRouter);
  return server;
}

const original = { ...stocksDividendsRuntime };
let chain: ReturnType<typeof readerV1>;

beforeEach(() => {
  chain = readerV1();
  stocksDividendsCacheV1.clear();
  Object.assign(stocksDividendsRuntime, {
    now: () => NOW,
    storageAvailable: async () => true,
    calendar: async () => CALENDAR,
    reader: () => chain.reader,
    caches: createDividendWalletCachesV1(),
  });
});

afterEach(() => {
  Object.assign(stocksDividendsRuntime, original);
  stocksDividendsCacheV1.clear();
});

describe('my dividends', () => {
  test('signed out, or the development user, reads nothing', async () => {
    assert.equal((await request(app(null)).get('/stocks/dividends/mine')).status, 401);
    const zero = '0x0000000000000000000000000000000000000000';
    assert.equal((await request(app({ id: 'dev-single-user', address: zero, chainId: 8453 })).get('/stocks/dividends/mine')).status, 401);
    assert.equal(chain.calls(), 0);
  });

  test('the session’s wallet, whatever the query names: received before the conversion, ahead on what it holds now', async () => {
    const response = await request(app()).get(`/stocks/dividends/mine?wallet=${SOMEONE_ELSE}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    const body = DividendWalletResponseV1Schema.parse(response.body);
    assert.deepEqual([...new Set(chain.asked)], [WALLET]);

    const alphabet = body.holdings.find((row) => row.symbol === 'GOOGL')!;
    assert.equal(alphabet.tokens, '4');
    // The 2.5 held going into the block that converted, not the 4 after it.
    assert.deepEqual(
      alphabet.received.map((row) => [row.tokens, row.usd]),
      [['2.5', '0.3272']],
    );
    assert.equal(alphabet.upcoming[0]?.tokens, '4');
    const meta = body.holdings.find((row) => row.symbol === 'META')!;
    assert.deepEqual(meta.upcoming.map((row) => [row.state, row.tokens]), [['announced', '1']]);
    assert.equal(body.receivedUsd, '0.3272');
    assert.equal(body.blockNumber, 5_200_000);
  });

  test('a reload inside half a minute reads the chain once; the past is read once per wallet', async () => {
    await request(app()).get('/stocks/dividends/mine');
    const first = chain.calls();
    await request(app()).get('/stocks/dividends/mine');
    assert.equal(chain.calls(), first);
    stocksDividendsCacheV1.clear();
    await request(app()).get('/stocks/dividends/mine');
    // Two balances now; no decimals, no search and no past balance again.
    assert.equal(chain.calls(), first + 2);
  });

  test('a balance the endpoint would not give is a refusal, not an empty wallet', async () => {
    stocksDividendsRuntime.reader = () =>
      ({
        ...chain.reader,
        async call() {
          return { ok: false as const, reason: 'rate_limited' as const };
        },
      }) as unknown as B20ReaderV1;
    const response = await request(app()).get('/stocks/dividends/mine');
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'dividend_wallet_unread');
    assert.equal(JSON.stringify(response.body).includes(WALLET), false);
  });
});
