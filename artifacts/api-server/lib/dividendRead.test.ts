import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { B20MultiplierEventV1 } from '@mioagent/b20-control';
import { DividendCalendarResponseV1Schema } from '@mioagent/rwa-market-reality/dividends';

import { readDividendCalendarV1, type DividendReadDepsV1 } from './dividendRead.js';

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
