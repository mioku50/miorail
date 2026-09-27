import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  DIVIDEND_ISSUERS_V1,
  mergeDividendDeclarationsV1,
  readDividendReleaseV1,
  releaseTextV1,
  usDateV1,
} from '../src/dividendSources.js';
import { DIVIDEND_DECLARATIONS_V1 } from '../src/dividends.js';

const issuer = (symbol: string) => DIVIDEND_ISSUERS_V1.find((row) => row.symbol === symbol)!;

function read(symbol: string, html: string, publishedAt = '2026-07-22T20:05:00Z') {
  return readDividendReleaseV1({
    issuer: issuer(symbol),
    text: releaseTextV1(html),
    publishedAt: new Date(publishedAt),
    url: 'https://www.sec.gov/Archives/edgar/data/1/000000000026000001/ex991.htm',
    publisher: 'x',
  });
}

/** Alphabet's second-quarter release, as EDGAR serves it: two dividends in
 * one paragraph, the preferred one first. */
const ALPHABET_Q2 = `<p><b>Preferred and Common Dividend Programs</b></p><p>In July 2026, the company&#8217;s Board of
Directors declared a quarterly cash dividend of $12.15 per share on each of our Series A and Series B mandatory
convertible preferred stock (equivalent to approximately $0.60 per each of our Series A and Series B Depositary Shares)
and a quarterly cash dividend of $0.22 per share on our Class A, Class B, and Class C stock. The mandatory convertible
preferred stock dividend is payable on August 15, 2026 to stockholders of record for each of the company&#8217;s Series A
and Series B shares as of August 1, 2026, and the common stock dividend is payable on September 14, 2026 to stockholders
of record for each of the company&#8217;s Class A, Class B, and Class C shares as of September 7, 2026.</p>`;

describe('a declaration is the company’s own sentence, in full', () => {
  test('Alphabet: the common dividend gets its own dates, not the preferred one’s', () => {
    const reading = read('GOOGL', ALPHABET_Q2);
    assert.deepEqual(reading.refused, []);
    assert.equal(reading.declarations.length, 1);
    const [common] = reading.declarations;
    assert.deepEqual(
      [common!.amountPerShare, common!.recordDate, common!.payDate, common!.declaredOn, common!.exDate],
      ['0.22', '2026-09-07', '2026-09-14', '2026-07-22', null],
    );
    assert.match(common!.source.quote, /^a quarterly cash dividend of \$0\.22 per share/);
  });

  test('each company’s 2026 sentence reads as the registry has it', () => {
    const cases: Array<[string, string, string]> = [
      [
        'AAPL',
        '<p>Apple&#8217;s board of directors has declared a cash dividend of $0.27 per share of the Company&#8217;s common stock. The dividend is payable on August 13, 2026, to shareholders of record as of the close of business on August 10, 2026.</p>',
        '2026-07-30T20:30:00Z',
      ],
      [
        'META',
        '<p>MENLO PARK, Calif., Sept. 10, 2026 /PRNewswire/ -- The Meta Platforms, Inc. (Nasdaq: META) board of directors today declared a quarterly cash dividend of $0.525 per share of the company\'s outstanding Class A common stock and Class B common stock, payable on September 28, 2026 to stockholders of record as of the close of business on September 21, 2026.</p>',
        '2026-09-10T20:15:00Z',
      ],
      [
        'MSFT',
        '<p>REDMOND, Wash. &#8212; Sept. 15, 2026 &#8212; Microsoft Corp. on Tuesday announced that its board of directors declared a quarterly dividend of $0.98 per share, reflecting a 7 cent or 8% increase over the previous quarter&#8217;s dividend. The dividend is payable Dec. 10, 2026, to shareholders of record on Nov. 19, 2026. The ex-dividend date will be Nov. 19, 2026.</p>',
        '2026-09-15T20:10:00Z',
      ],
      [
        'NVDA',
        '<p>NVIDIA will pay its next quarterly cash dividend of $0.25 per share on October 1, 2026, to all shareholders of record on September 10, 2026.</p>',
        '2026-08-26T20:20:00Z',
      ],
    ];
    for (const [symbol, html, publishedAt] of cases) {
      const [found] = read(symbol, html, publishedAt).declarations;
      const registered = DIVIDEND_DECLARATIONS_V1.find((row) => row.symbol === symbol && row.payDate === found?.payDate);
      assert.ok(found && registered, symbol);
      assert.deepEqual(
        [found.amountPerShare, found.recordDate, found.payDate, found.exDate, found.declaredOn],
        [registered.amountPerShare, registered.recordDate, registered.payDate, registered.exDate, registered.declaredOn],
        symbol,
      );
    }
  });

  test('a reworded release is nothing, and an impossible one is refused', () => {
    // A sentence the pattern was not written for: no guess at all.
    assert.deepEqual(read('AAPL', '<p>Apple declared a dividend of $0.28 per share, paid in November.</p>'), {
      declarations: [],
      refused: [],
    });
    // A record date after the payment is not a declaration.
    const backwards = read(
      'NVDA',
      '<p>NVIDIA will pay its next quarterly cash dividend of $0.25 per share on October 1, 2026, to all shareholders of record on December 10, 2026.</p>',
    );
    assert.deepEqual(backwards, { declarations: [], refused: ['NVDA:record_after_pay'] });
    // Published after its own record date.
    const late = read(
      'NVDA',
      '<p>NVIDIA will pay its next quarterly cash dividend of $0.25 per share on October 1, 2026, to all shareholders of record on September 10, 2026.</p>',
      '2026-09-20T12:00:00Z',
    );
    assert.deepEqual(late.refused, ['NVDA:declared_after_record']);
  });

  test('dates as companies spell them, and nothing else', () => {
    assert.equal(usDateV1('September 14, 2026'), '2026-09-14');
    assert.equal(usDateV1('Sept. 10, 2026'), '2026-09-10');
    assert.equal(usDateV1('Aug. 20, 2026'), '2026-08-20');
    assert.equal(usDateV1('February 30, 2026'), null);
    assert.equal(usDateV1('2026-09-14'), null);
  });

  test('markup, entities and curly quotes read as one plain sentence', () => {
    assert.equal(releaseTextV1('<p>the company&#8217;s&nbsp;<b>Board</b>\n of &amp; &#x201C;x&#x201D;</p><script>var a=1;</script>'), 'the company\'s Board of & "x"');
  });

  test('the registry wins a payment it names; the watcher fills the rest', () => {
    const [apple] = DIVIDEND_DECLARATIONS_V1.filter((row) => row.symbol === 'AAPL');
    const reworded = { ...apple!, amountPerShare: '0.99' };
    const next = { ...apple!, payDate: '2026-11-12', recordDate: '2026-11-09', declaredOn: '2026-10-29' };
    const merged = mergeDividendDeclarationsV1(DIVIDEND_DECLARATIONS_V1, [reworded, next]);
    assert.equal(merged.filter((row) => row.symbol === 'AAPL' && row.payDate === apple!.payDate)[0]?.amountPerShare, '0.27');
    assert.ok(merged.some((row) => row.symbol === 'AAPL' && row.payDate === '2026-11-12'));
    assert.equal(merged.length, DIVIDEND_DECLARATIONS_V1.length + 1);
  });
});
