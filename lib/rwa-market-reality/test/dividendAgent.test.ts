import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  DIVIDEND_MECHANISM_SENTENCE_V1,
  DividendCalendarAgentInputV1Schema,
  DividendCalendarAgentOutputV1Schema,
  dividendCalendarForAgentV1,
} from '../src/dividendAgent.js';
import { dividendCalendarV1, type DividendTokenV1 } from '../src/dividends.js';

const WAD = '1000000000000000000';
const GOOGL_AFTER = '1000377118676784179';

function token(symbol: string, key: string, over: Partial<DividendTokenV1> = {}): DividendTokenV1 {
  return {
    tokenAddress: `0xb2${symbol.toLowerCase().padEnd(38, '0').replace(/[^0-9a-f]/g, '0')}`,
    tokenSymbol: `${symbol}c`,
    underlyingKey: key,
    symbol,
    company: symbol === 'GOOGL' ? 'Alphabet' : symbol === 'META' ? 'Meta' : symbol,
    reading: { multiplierWad: WAD, readAt: '2026-09-27T03:18:00.000Z' },
    changes: [],
    scheduled: [],
    supplyAtRecord: {},
    priceNow: 100,
    ...over,
  };
}

const CALENDAR = dividendCalendarV1({
  now: new Date('2026-09-27T12:00:00.000Z'),
  tokens: [
    token('GOOGL', 'security:isin:US02079K3059', {
      reading: { multiplierWad: GOOGL_AFTER, readAt: '2026-09-27T03:18:00.000Z' },
      changes: [{ fromWad: WAD, toWad: GOOGL_AFTER, at: '2026-09-14T18:29:21.000Z', confirmed: true, priceAt: 347.1 }],
      supplyAtRecord: { '2026-09-07': '6113.6938' },
      priceNow: 350,
    }),
    token('META', 'security:isin:US30303M1027', { supplyAtRecord: { '2026-09-21': '2951.4838' }, priceNow: 749 }),
    token('TSLA', 'security:isin:US88160R1014'),
  ],
});

describe('the dividend calendar, for an assistant', () => {
  test('the company’s side and the token’s side, and an estimate that says it is one', () => {
    const out = dividendCalendarForAgentV1(CALENDAR, {});
    assert.doesNotThrow(() => DividendCalendarAgentOutputV1Schema.parse(out));
    assert.match(
      out.miorailSummary,
      /Next for META: Meta \$0\.525 a share, payable 2026-09-28 \(declared\): Miorail estimates about 0\.0417% more META shares per METAc, about \$0\.3124 a token, at the 59\.5% of a dividend that has reached a token so far\. An estimate, not the company's figure\./,
    );
    assert.match(
      out.miorailSummary,
      /Last for GOOGL: Alphabet \$0\.22 a share, payable 2026-09-14 \(reinvested into the token\): GOOGLc tracked 0\.0377% more GOOGL shares per token from 2026-09-14T18:29:21\.000Z, worth \$0\.1309 a token at \$347\.10, 59\.5% of the declared amount\./,
    );
    // Tesla's releases are not read, so nothing is said about its dividends.
    assert.match(
      out.miorailSummary,
      /Not read: Miorail does not read the dividend releases of TSLA, so nothing is established about whether they pay one\./,
    );
    assert.doesNotMatch(out.miorailSummary, /No dividend on record/);
    assert.ok(out.miorailSummary.endsWith(DIVIDEND_MECHANISM_SENTENCE_V1));
  });

  test('one stock by ticker or by token; an unknown one is said to be unknown, not dividend-free', () => {
    assert.deepEqual(dividendCalendarForAgentV1(CALENDAR, { symbol: 'meta' }).stocks.map((stock) => stock.symbol), ['META']);
    assert.deepEqual(dividendCalendarForAgentV1(CALENDAR, { symbol: 'GOOGLc' }).stocks.map((stock) => stock.symbol), ['GOOGL']);
    const unknown = dividendCalendarForAgentV1(CALENDAR, { symbol: 'KO' });
    assert.deepEqual(unknown.stocks, []);
    assert.match(unknown.miorailSummary, /^KO is not one of the Coinbase tokenized stocks on Base that Miorail reads\./);
    assert.doesNotMatch(unknown.miorailSummary, /No dividend on record/);
  });

  test('the input takes a ticker and nothing that names a wallet', () => {
    assert.equal(DividendCalendarAgentInputV1Schema.safeParse({ symbol: 'META' }).success, true);
    assert.equal(DividendCalendarAgentInputV1Schema.safeParse({ symbol: '0x1111111111111111111111111111111111111111' }).success, false);
    assert.equal(DividendCalendarAgentInputV1Schema.safeParse({ wallet: '0x1' }).success, false);
  });
});
