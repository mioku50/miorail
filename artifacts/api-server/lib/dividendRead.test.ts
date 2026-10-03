import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { B20_CORPORATE_ACTION_TOPICS_V1, type B20MultiplierEventV1 } from '@mioagent/b20-control';
import type { B20CorporateActionRowV1 } from '@mioagent/route-storage';
import { DividendCalendarResponseV1Schema } from '@mioagent/rwa-market-reality/dividends';

import { dividendNoticesFromActionsV1, readDividendCalendarV1, type DividendReadDepsV1 } from './dividendRead.js';

const GOOGLC = '0xb2000000000000000000002d0ba3164cc74f58b7';
const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
const TSLAC = '0xb2000000000000000000001e800a7f5189430cd0';
const WAD = '1000000000000000000';
const GOOGL_AFTER = '1000377118676784179';

function event(over: Partial<B20MultiplierEventV1>): B20MultiplierEventV1 {
  return {
    event: 'multiplier_updated',
    multiplierWad: GOOGL_AFTER,
    effectiveAt: null,
    blockTime: '2026-09-14T18:29:21.000Z',
    blockNumber: 51_310_600,
    transactionHash: `0x${'1'.repeat(64)}`,
    logIndex: 3,
    ...over,
  };
}

function depsV1(over: Partial<DividendReadDepsV1> = {}): DividendReadDepsV1 & { windows: string[] } {
  const windows: string[] = [];
  return {
    windows,
    async tokens() {
      return [
        { tokenAddress: GOOGLC, tokenSymbol: 'GOOGLc', underlyingKey: 'security:isin:US02079K3059', symbol: 'GOOGL', company: null },
        { tokenAddress: NVDAC, tokenSymbol: 'NVDAc', underlyingKey: 'security:isin:US67066G1040', symbol: 'NVDA', company: null },
        { tokenAddress: TSLAC, tokenSymbol: 'TSLAc', underlyingKey: 'security:isin:US88160R1014', symbol: 'TSLA', company: 'Tesla, Inc.' },
      ];
    },
    async readings() {
      return [
        { tokenAddress: GOOGLC, rawValue: GOOGL_AFTER, scale: WAD, blockNumber: 51_850_000, readAt: '2026-09-27T03:18:00.000Z' },
        { tokenAddress: NVDAC, rawValue: WAD, scale: WAD, blockNumber: 51_850_000, readAt: '2026-09-27T03:18:00.000Z' },
        { tokenAddress: TSLAC, rawValue: WAD, scale: WAD, blockNumber: 51_850_000, readAt: '2026-09-27T03:18:00.000Z' },
      ];
    },
    async transitions() {
      // The reader saw it four hours after the chain logged it.
      return [{ tokenAddress: GOOGLC, fromRawValue: WAD, toRawValue: GOOGL_AFTER, scale: WAD, observedAt: '2026-09-14T22:21:00.000Z' }];
    },
    async multiplierEvents(tokenAddress) {
      if (tokenAddress === GOOGLC) return [event({})];
      if (tokenAddress === NVDAC) {
        return [event({ event: 'ui_multiplier_updated', multiplierWad: '1000650000000000000', effectiveAt: '2026-10-01T14:00:00.000Z', blockTime: '2026-09-28T12:00:00.000Z' })];
      }
      return [];
    },
    async supplies() {
      return [
        { tokenAddress: GOOGLC, recordDate: '2026-09-07', supply: '6113.6938' },
        { tokenAddress: NVDAC, recordDate: '2026-09-10', supply: '4200' },
      ];
    },
    async references(_tokens, window) {
      windows.push(`${window.since.toISOString()}..${window.until.toISOString()}`);
      return [
        { tokenAddress: GOOGLC, at: '2026-09-14T18:25:03.000Z', price: 347.1 },
        { tokenAddress: GOOGLC, at: '2026-09-14T19:31:05.000Z', price: 348.89 },
        { tokenAddress: GOOGLC, at: '2026-09-29T20:00:00.000Z', price: 350 },
        { tokenAddress: NVDAC, at: '2026-09-29T20:00:00.000Z', price: 225 },
      ];
    },
    async declarations() {
      return [];
    },
    ...over,
  };
}

describe('the dividend calendar, read', () => {
  test('a change is timed by its log, priced at that moment, and a plan published ahead is scheduled', async () => {
    const deps = depsV1();
    const calendar = await readDividendCalendarV1(new Date('2026-09-30T12:00:00.000Z'), deps);
    assert.doesNotThrow(() => DividendCalendarResponseV1Schema.parse(calendar));

    const alphabet = calendar.stocks.find((stock) => stock.symbol === 'GOOGL')!;
    const paid = alphabet.history[0]!;
    assert.equal(paid.state, 'effective');
    assert.equal(paid.token.at, '2026-09-14T18:29:21.000Z');
    assert.equal(paid.token.priceUsd, '347.10');
    assert.equal(paid.token.passThroughPercent, '59.5');
    assert.equal(alphabet.company, 'Alphabet');

    const nvidia = calendar.stocks.find((stock) => stock.symbol === 'NVDA')!;
    assert.equal(nvidia.next?.state, 'scheduled');
    assert.equal(nvidia.next?.token.multiplierTo, '1000650000000000000');
    assert.equal(nvidia.next?.token.increasePercent, '0.0650');
    assert.equal(nvidia.next?.supplyAtRecord, '4200');

    const tesla = calendar.stocks.find((stock) => stock.symbol === 'TSLA')!;
    assert.equal(tesla.next, null);
    assert.equal(tesla.company, 'Tesla, Inc.');
    // Two windows of prices: around the change, and the last twelve hours.
    assert.deepEqual(deps.windows, [
      '2026-09-14T12:29:21.000Z..2026-09-14T19:29:21.000Z',
      '2026-09-30T00:00:00.000Z..2026-09-30T12:00:00.000Z',
    ]);
  });

  test('on a Sunday the estimate uses Friday’s print: the feed is quiet, not missing', async () => {
    const calendar = await readDividendCalendarV1(
      new Date('2026-09-27T12:00:00.000Z'),
      depsV1({
        async references(_tokens, window) {
          // Runs keep coming all weekend and carry the feed's last print.
          return window.until.getTime() > Date.parse('2026-09-20T00:00:00.000Z')
            ? [
                { tokenAddress: GOOGLC, at: '2026-09-14T18:25:03.000Z', price: 347.1 },
                { tokenAddress: NVDAC, at: '2026-09-25T23:35:43.000Z', price: 224.49 },
                { tokenAddress: NVDAC, at: '2026-09-22T20:00:00.000Z', price: 1 },
              ]
            : [];
        },
        async multiplierEvents(tokenAddress) {
          return tokenAddress === GOOGLC ? [event({})] : [];
        },
      }),
    );
    const nvidia = calendar.stocks.find((stock) => stock.symbol === 'NVDA')!;
    assert.equal(nvidia.next?.state, 'announced');
    assert.equal(nvidia.next?.token.kind, 'estimate');
    assert.equal(nvidia.next?.token.priceUsd, '224.49');
    // Older than four days is no price, not a stale one.
    const stale = await readDividendCalendarV1(
      new Date('2026-10-02T12:00:00.000Z'),
      depsV1({
        async references() {
          return [{ tokenAddress: NVDAC, at: '2026-09-25T23:35:43.000Z', price: 224.49 }];
        },
      }),
    );
    assert.equal(stale.stocks.find((stock) => stock.symbol === 'NVDA')!.next?.token.priceUsd ?? null, null);
  });

  test('a declaration the watcher read joins the registry; one the registry names stays the registry’s', async () => {
    const release = (payDate: string, amountPerShare: string) => ({
      underlyingKey: 'security:isin:US02079K3059',
      symbol: 'GOOGL',
      company: 'Alphabet',
      amountPerShare,
      declaredOn: '2026-10-28',
      exDate: null,
      recordDate: '2026-12-07',
      payDate,
      source: { publisher: 'Alphabet Inc., Form 8-K, exhibit 99.1', url: 'https://www.sec.gov/x.htm', quote: 'x' },
    });
    const calendar = await readDividendCalendarV1(
      new Date('2026-10-30T12:00:00.000Z'),
      depsV1({
        async declarations() {
          // A new one, and a rewording of September's that the registry already names.
          return [release('2026-12-14', '0.23'), { ...release('2026-09-14', '0.99'), recordDate: '2026-09-07', declaredOn: '2026-07-22' }];
        },
      }),
    );
    const alphabet = calendar.stocks.find((stock) => stock.symbol === 'GOOGL')!;
    assert.equal(alphabet.next?.state, 'announced');
    assert.deepEqual([alphabet.next?.amountPerShare, alphabet.next?.payDate, alphabet.next?.source?.url], ['0.23', '2026-12-14', 'https://www.sec.gov/x.htm']);
    assert.equal(alphabet.history[0]?.amountPerShare, '0.22');
  });

  test('a change with no log keeps the reader’s time; a price older than a day is no price', async () => {
    const calendar = await readDividendCalendarV1(
      new Date('2026-09-30T12:00:00.000Z'),
      depsV1({
        async multiplierEvents() {
          return [];
        },
      }),
    );
    const paid = calendar.stocks.find((stock) => stock.symbol === 'GOOGL')!.history[0]!;
    assert.equal(paid.state, 'effective');
    assert.equal(paid.token.at, '2026-09-14T22:21:00.000Z');
    assert.equal(paid.token.priceUsd, '348.89');
  });
});

describe('notices read from the stored log', () => {
  const word = (value: bigint) => value.toString(16).padStart(64, '0');
  const text = (value: string) => {
    const bytes = Buffer.from(value, 'utf8');
    return word(BigInt(bytes.length)) + bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
  };
  /** Coinbase's layout: the caller in topic 1, the id, words and uri in the data. */
  const announcementData = (id: string, description: string, uri: string) => {
    const tails = [text(id), text(description), text(uri)];
    let cursor = 3 * 32;
    const heads = tails.map((tail) => {
      const head = word(BigInt(cursor));
      cursor += tail.length / 2;
      return head;
    });
    return `0x${heads.join('')}${tails.join('')}`;
  };
  const AEOC = '0xb2000000000000000000006064f8ec027f042294';
  const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
  const row = (over: Partial<B20CorporateActionRowV1>): B20CorporateActionRowV1 => ({
    chainId: 8453,
    tokenAddress: AEOC,
    event: 'announcement',
    payloadState: 'topic_only',
    announcementId: null,
    caller: null,
    description: null,
    uri: null,
    multiplierWad: null,
    effectiveAt: null,
    topics: [B20_CORPORATE_ACTION_TOPICS_V1.announcement, `0x${word(0xaan)}`],
    data: announcementData('4bc6:pre', 'Cash Dividend', 'https://example.test/ca/4bc6'),
    blockNumber: 52099273,
    blockTime: '2026-10-03T00:38:13.000Z',
    transactionHash: TX(1),
    logIndex: 48,
    observedAt: '2026-10-03T01:00:00.000Z',
    ...over,
  });

  test('a row stored before the decoder knew the layout is read from its raw log', () => {
    assert.deepEqual(dividendNoticesFromActionsV1([row({})]), [
      { at: '2026-10-03T00:38:13.000Z', announcementId: '4bc6:pre', description: 'Cash Dividend', transactionHash: TX(1), carriedChange: false },
    ]);
  });

  test('an announcement whose transaction moved the multiplier carried the conversion', () => {
    const rows = [
      row({ transactionHash: TX(2) }),
      row({ event: 'multiplier_updated', payloadState: 'decoded', multiplierWad: '1000537939576369481', topics: [B20_CORPORATE_ACTION_TOPICS_V1.multiplier_updated], data: `0x${word(1000537939576369481n)}`, transactionHash: TX(2), logIndex: 49 }),
    ];
    assert.deepEqual(dividendNoticesFromActionsV1(rows).map((notice) => notice.carriedChange), [true]);
  });

  test('an announcement with no readable words is no notice', () => {
    assert.deepEqual(dividendNoticesFromActionsV1([row({ data: '0x' })]), []);
  });
});
