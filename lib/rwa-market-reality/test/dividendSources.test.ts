import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  DIVIDEND_ISSUERS_V1,
  mergeDividendDeclarationsV1,
  readDividendReleaseV1,
  releaseTextV1,
  usDateV1,
} from '../src/dividendSources.js';
import { DIVIDEND_DECLARATIONS_V1, DIVIDEND_RELEASES_READ_V1 } from '../src/dividends.js';

const issuer = (symbol: string) => DIVIDEND_ISSUERS_V1.find((row) => row.symbol === symbol)!;

test('the screens say "not read" for exactly the companies this file does not read', () => {
  assert.deepEqual(
    [...new Set(DIVIDEND_ISSUERS_V1.map((row) => row.underlyingKey))].sort(),
    [...DIVIDEND_RELEASES_READ_V1].sort(),
  );
});

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

  test('the twelve added 2026-10-19: every document of their filings reads as the registry has it', () => {
    // [symbol, the document as EDGAR serves it, when EDGAR accepted the filing].
    // Where a filing restates the declaration in its own words (Item 8.01),
    // both documents are here, and both must find the same payment.
    const cases: Array<[string, string, string]> = [
      ['AVGO', '<p>Quarterly Dividends</p><p>The Board of Directors of Broadcom has approved a quarterly cash dividend of $0.65 per share. The dividend is payable on September 30, 2026 to stockholders of record at the close of business (5:00 p.m. Eastern Time) on September 21, 2026.</p>', '2026-09-02T20:26:04Z'],
      ['AVGO', '<p>On September 2, 2026 , the Company announced that the Board of Directors has declared a quarterly cash dividend on the Company&#8217;s common stock of $0.65 per share. This dividend is payable on September 30, 2026 to common stockholders of record at the close of business (5:00 p.m., Eastern Time) on September 21, 2026.</p>', '2026-09-02T20:26:04Z'],
      ['KSS', '<p>August 18, 2026 &#8212;The Board of Directors of Kohl&#8217;s Corporation (NYSE: KSS) (&#8220;Kohl&#8217;s&#8221; or the &#8220;Company&#8221;) today declared a regular quarterly dividend of $0.125 per share on the Company&#8217;s common stock. The dividend is payable September 23, 2026, to shareholders of record at the close of business on September 9, 2026.</p>', '2026-08-19T01:05:15Z'],
      ['KSS', '<p>On August 18, 2026, the Board of Directors of Kohl\'s Corporation ("the Company") declared a quarterly cash dividend of $0.125 per share. The dividend will be payable on September 23, 2026, to shareholders of record at the close of business on September 9, 2026.</p>', '2026-08-19T01:05:15Z'],
      ['MU', '<p>On June 24, 2026, Micron&#8217;s Board of Directors declared a quarterly dividend of $0.15 per share, payable in cash on July 21, 2026, to shareholders of record as of the close of business on July 6, 2026.</p>', '2026-06-25T00:02:01Z'],
      ['MU', '<p>On September 30, 2026, Micron&#8217;s Board of Directors declared a quarterly dividend of $0.15 per share, payable in cash on October 29, 2026, to shareholders of record as of the close of business on October 14, 2026.</p>', '2026-10-01T00:02:22Z'],
      ['MRVL', '<p>Santa Clara, Calif. (June 25, 2026) &#8212; Marvell Technology, Inc. (NASDAQ: MRVL), today announced a quarterly dividend of $0.06 per share of common stock, including preferred stock on an as converted to common stock basis, payable on July 30, 2026 to stockholders of record as of July 10, 2026.</p>', '2026-06-26T00:43:43Z'],
      ['MRVL', '<p>Item 8.01 Other Events. On September 25, 2026, the Board of Directors of Marvell Technology, Inc. declared the payment of its quarterly dividend of $0.06 per share to be paid on October 29, 2026 to stockholders of common stock, including preferred stock on an as converted to common stock basis, of record as of October 9, 2026.</p>', '2026-09-26T00:35:56Z'],
      ['ORCL', '<p>The board of directors declared a quarterly cash dividend of $0.50 per share of outstanding common stock. This dividend will be paid to stockholders of record as of the close of business on July 10, 2026, with a payment date of July 24, 2026.</p>', '2026-06-10T20:13:46Z'],
      ['ORCL', '<p>Oracle announced that its Board of Directors has declared a cash dividend of $1,625 per share of our outstanding Mandatory Convertible Preferred Stock and $0.50 per share of our outstanding common stock. The Mandatory Convertible Preferred Stock dividend is payable on October 15, 2026 to stockholders of record as of the close of business on October 1, 2026 and the common stock dividend is payable on October 23, 2026 to stockholders of record as of the close of business on October 9, 2026.</p>', '2026-09-10T20:16:50Z'],
      ['PM', '<p>STAMFORD, CT, June 11, 2026 &#8211; The Board of Directors of Philip Morris International Inc. (NYSE: PM) today declared a regular quarterly dividend of $1.47 per common share, payable on July 20, 2026, to shareholders of record as of June 25, 2026. The ex-dividend date is June 25, 2026.</p>', '2026-06-11T10:04:11Z'],
      ['PM', '<p>The new quarterly dividend of $1.60 per share, up from $1.47 per share, is payable on October 26, 2026, to shareholders of record as of October 2, 2026. The ex-dividend date is October 2, 2026.</p>', '2026-09-18T12:04:53Z'],
      ['PYPL', '<p>&#8226; PayPal&#8217;s Board of Directors declared a cash dividend of $0.14 per share on the Company&#8217;s common stock, payable on September 25, 2026, to stockholders of record as of the close of business on September 4, 2026.</p>', '2026-07-28T15:02:42Z'],
      ['STZ', '<p>QUARTERLY DIVIDEND</p><p>On June 30, 2026, Constellation&#8217;s board of directors declared a quarterly cash dividend of $1.03 per share of Class A Common Stock payable on August 13, 2026, to stockholders of record as of the close of business on July 30, 2026.</p>', '2026-07-01T00:08:55Z'],
      ['STZ', '<p>QUARTERLY DIVIDEND</p><p>On October 6, 2026, Constellation&#8217;s board of directors declared a quarterly cash dividend of $1.03 per share of Class A Common Stock payable on November 13, 2026, to stockholders of record as of the close of business on October 30, 2026.</p>', '2026-10-07T00:18:54Z'],
      ['SWBI', '<p>Consistent with our capital allocation strategy, our board of directors has authorized a $0.13 per share quarterly dividend, which will be paid to stockholders of record on September 17, 2026, with payment to be made on October 1, 2026.&#8221;</p>', '2026-09-03T20:15:14Z'],
      ['WDC', '<p>Dividend</p><p>WD&#8217;s Board of Directors declared a cash dividend of $0.15 per share of the company&#8217;s common stock, which will be paid on September 17, 2026 to stockholders of record as of the close of business on September 8, 2026.</p>', '2026-08-06T00:04:35Z'],
      ['WEN', '<p>The Company announced today the declaration of a quarterly cash dividend payment of $0.07 per share. The dividend is payable on September 15, 2026, to shareholders of record as of September 1, 2026.</p>', '2026-08-07T11:06:14Z'],
      ['WING', '<p>On July 28, 2026, the Company&#8217;s Board of Directors (the &#8220;Board&#8221;) declared a quarterly cash dividend of $0.33 per share of common stock. The dividend is payable on September 5, 2026 to stockholders of record as of the close of business on August 15, 2026.</p>', '2026-07-29T11:43:53Z'],
      ['WING', '<p>In recognition of our strong cash flow generation and our commitment to returning value to stockholders, on July 28, 2026, our board of directors authorized and declared a quarterly dividend of $0.33 per share of common stock, resulting in a total dividend of approximately $9.0 million. This dividend will be paid on September 5, 2026 to stockholders of record as of August 15, 2026.</p>', '2026-07-29T11:43:53Z'],
    ];
    for (const [symbol, html, publishedAt] of cases) {
      const reading = read(symbol, html, publishedAt);
      assert.deepEqual(reading.refused, [], symbol);
      assert.equal(reading.declarations.length, 1, `${symbol} ${publishedAt}`);
      const [found] = reading.declarations;
      const registered = DIVIDEND_DECLARATIONS_V1.find((row) => row.symbol === symbol && row.payDate === found!.payDate);
      assert.ok(registered, `${symbol} ${found!.payDate}`);
      assert.deepEqual(
        [found!.amountPerShare, found!.recordDate, found!.payDate, found!.exDate, found!.declaredOn],
        [registered.amountPerShare, registered.recordDate, registered.payDate, registered.exDate, registered.declaredOn],
        `${symbol} ${found!.payDate}`,
      );
    }
    // Oracle's preferred dividend is $1,625 with its own dates; the common one never borrows them.
    const [oracle] = read('ORCL', cases[9]![1], cases[9]![2]).declarations;
    assert.deepEqual([oracle!.amountPerShare, oracle!.recordDate, oracle!.payDate], ['0.50', '2026-10-09', '2026-10-23']);
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
