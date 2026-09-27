import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  DividendWalletResponseV1Schema,
  dividendWalletConversionsV1,
  dividendWalletKeyV1,
  dividendWalletV1,
  tokenAmountV1,
} from '../src/dividendWallet.js';
import { dividendCalendarV1, type DividendTokenV1 } from '../src/dividends.js';

const WAD = '1000000000000000000';
const GOOGL_AFTER = '1000377118676784179';
const CONVERTED_AT = '2026-09-14T18:29:21.000Z';

function token(symbol: string, over: Partial<DividendTokenV1> = {}): DividendTokenV1 {
  const keys: Record<string, string> = {
    GOOGL: 'security:isin:US02079K3059',
    META: 'security:isin:US30303M1027',
    NVDA: 'security:isin:US67066G1040',
    TSLA: 'security:isin:US88160R1014',
  };
  return {
    tokenAddress: `0xb2${symbol.toLowerCase().padEnd(38, '0').replace(/[^0-9a-f]/g, '0')}`,
    tokenSymbol: `${symbol}c`,
    underlyingKey: keys[symbol]!,
    symbol,
    company: symbol,
    reading: { multiplierWad: WAD, readAt: '2026-09-27T03:18:00.000Z' },
    changes: [],
    scheduled: [],
    supplyAtRecord: {},
    priceNow: 100,
    ...over,
  };
}

const GOOGL = token('GOOGL', {
  reading: { multiplierWad: GOOGL_AFTER, readAt: '2026-09-27T03:18:00.000Z' },
  changes: [{ fromWad: WAD, toWad: GOOGL_AFTER, at: CONVERTED_AT, confirmed: true, priceAt: 347.1 }],
  supplyAtRecord: { '2026-09-07': '6113.6938' },
  priceNow: 350,
});
const META = token('META', { supplyAtRecord: { '2026-09-21': '2951.4838' }, priceNow: 749 });
const NVDA = token('NVDA', { supplyAtRecord: { '2026-09-10': '16308.99' }, priceNow: 180 });
const TSLA = token('TSLA', { priceNow: 400 });

/** Whole tokens at eight decimals. */
function units(amount: number): bigint {
  return BigInt(Math.round(amount * 1e8));
}

function wallet(input: {
  now: Date;
  tokens: DividendTokenV1[];
  held: Record<string, number>;
  before?: Record<string, number>;
}) {
  const calendar = dividendCalendarV1({ now: input.now, tokens: input.tokens });
  const address = (symbol: string) => input.tokens.find((row) => row.symbol === symbol)!.tokenAddress;
  const balances = new Map(input.tokens.map((row) => [row.tokenAddress, units(input.held[row.symbol] ?? 0)]));
  const balancesBefore = new Map(
    dividendWalletConversionsV1(calendar).map((change) => {
      const symbol = input.tokens.find((row) => row.tokenAddress === change.tokenAddress)!.symbol;
      return [dividendWalletKeyV1(change.tokenAddress, change.at), units(input.before?.[symbol] ?? 0)] as const;
    }),
  );
  const decimals = new Map(input.tokens.map((row) => [row.tokenAddress, 8]));
  return {
    calendar,
    address,
    response: dividendWalletV1({ calendar, now: input.now, blockNumber: 51_000_000, decimals, balances, balancesBefore }),
  };
}

describe('one wallet’s dividends', () => {
  const NOW = new Date('2026-09-27T12:00:00.000Z');

  test('received is what it held just before the multiplier moved; ahead is what it holds now', () => {
    const { response } = wallet({
      now: NOW,
      tokens: [GOOGL, META, NVDA, TSLA],
      held: { GOOGL: 4, META: 1, TSLA: 3 },
      before: { GOOGL: 2.5 },
    });
    assert.doesNotThrow(() => DividendWalletResponseV1Schema.parse(response));

    const alphabet = response.holdings.find((row) => row.symbol === 'GOOGL')!;
    assert.equal(alphabet.tokens, '4');
    // 2.5 tokens × 0.000377118676784179 more shares each, at $347.10.
    assert.deepEqual(alphabet.received, [
      {
        state: 'effective',
        reason: null,
        amountPerShare: '0.22',
        payDate: '2026-09-14',
        payDateApproximate: false,
        kind: 'measured',
        tokens: '2.5',
        shares: '0.00094280',
        usd: '0.3272',
        at: CONVERTED_AT,
      },
    ]);
    // The next one is a guess on the four held now, and says so.
    assert.equal(alphabet.upcoming.length, 1);
    assert.equal(alphabet.upcoming[0]?.state, 'estimated');
    assert.equal(alphabet.upcoming[0]?.kind, 'estimate');
    assert.equal(alphabet.upcoming[0]?.tokens, '4');
    assert.equal(alphabet.upcoming[0]?.usd, '0.5236');

    const meta = response.holdings.find((row) => row.symbol === 'META')!;
    assert.deepEqual(
      meta.upcoming.map((row) => [row.state, row.payDate, row.tokens, row.usd]),
      [['announced', '2026-09-28', '1', '0.3124']],
    );
    assert.deepEqual(meta.received, []);

    // Held and paying nothing: listed, with nothing ahead or behind.
    const tesla = response.holdings.find((row) => row.symbol === 'TSLA')!;
    assert.deepEqual([tesla.tokens, tesla.upcoming, tesla.received], ['3', [], []]);

    // Never held and never received: absent.
    assert.equal(response.holdings.some((row) => row.symbol === 'NVDA'), false);
    assert.equal(response.receivedUsd, '0.3272');
    assert.equal(response.passThroughPercent, '59.5');
  });

  test('bought after the conversion: nothing received, the next one ahead', () => {
    const { response } = wallet({ now: NOW, tokens: [GOOGL], held: { GOOGL: 1 }, before: { GOOGL: 0 } });
    const alphabet = response.holdings[0]!;
    assert.deepEqual(alphabet.received, []);
    assert.equal(alphabet.upcoming[0]?.state, 'estimated');
    assert.equal(response.receivedUsd, '0.0000');
  });

  test('sold since: what it received stays, and nothing is ahead', () => {
    const { response } = wallet({ now: NOW, tokens: [GOOGL], held: {}, before: { GOOGL: 2.5 } });
    const alphabet = response.holdings[0]!;
    assert.equal(alphabet.tokens, '0');
    assert.deepEqual(alphabet.upcoming, []);
    assert.equal(alphabet.received[0]?.usd, '0.3272');
  });

  test('paid and not in the token yet comes first, then the next one', () => {
    // The day after Meta paid: the token has not moved and was last read
    // before the payment, so the conversion is still to come.
    const now = new Date('2026-09-29T12:00:00.000Z');
    const unread = { ...META, reading: { multiplierWad: WAD, readAt: '2026-09-28T09:00:00.000Z' } };
    const { response } = wallet({ now, tokens: [GOOGL, unread], held: { META: 2 } });
    const meta = response.holdings.find((row) => row.symbol === 'META')!;
    assert.deepEqual(
      meta.upcoming.map((row) => [row.state, row.reason, row.payDate, row.kind]),
      [
        ['awaiting_confirmation', 'not_read_since_payment', '2026-09-28', 'estimate'],
        ['estimated', null, '2026-12-28', 'estimate'],
      ],
    );
  });

  test('converted on the day it paid: received that day, not ahead', () => {
    const now = new Date('2026-09-14T20:00:00.000Z');
    const { calendar, response } = wallet({ now, tokens: [GOOGL], held: { GOOGL: 2.5 }, before: { GOOGL: 2.5 } });
    assert.equal(calendar.stocks[0]?.next?.state, 'effective');
    assert.deepEqual(dividendWalletConversionsV1(calendar), [{ tokenAddress: GOOGL.tokenAddress, at: CONVERTED_AT }]);
    const alphabet = response.holdings[0]!;
    assert.equal(alphabet.received.length, 1);
    assert.deepEqual(alphabet.upcoming, []);
  });

  test('a balance that was not read is refused, never taken as zero', () => {
    const calendar = dividendCalendarV1({ now: NOW, tokens: [GOOGL] });
    const decimals = new Map([[GOOGL.tokenAddress, 8]]);
    assert.throws(
      () => dividendWalletV1({ calendar, now: NOW, blockNumber: 1, decimals, balances: new Map(), balancesBefore: new Map() }),
      /dividend_wallet_balance_unread/,
    );
    assert.throws(
      () =>
        dividendWalletV1({
          calendar,
          now: NOW,
          blockNumber: 1,
          decimals,
          balances: new Map([[GOOGL.tokenAddress, 1n]]),
          balancesBefore: new Map(),
        }),
      /dividend_wallet_past_balance_unread/,
    );
  });

  test('token amounts are exact decimals', () => {
    assert.equal(tokenAmountV1(611369380000n, 8), '6113.6938');
    assert.equal(tokenAmountV1(1n, 8), '0.00000001');
    assert.equal(tokenAmountV1(0n, 8), '0');
    assert.equal(tokenAmountV1(500000000n, 8), '5');
  });
});
