import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { InMemoryDividendDeclarationRepositoryV1, createMemoryRwaSignalRepository } from '@mioagent/route-storage';
import { DIVIDEND_ISSUERS_V1 } from '@mioagent/rwa-market-reality/dividend-sources';

import { SEC_USER_AGENT_V1, runDividendDeclarationWatchV1, type DividendFetchV1 } from './dividendDeclarationWatch.js';

const APPLE = 'security:isin:US0378331005';
const META = 'security:isin:US30303M1027';
const AAPLC = '0xb200000000000000000000c2e324d24d7eecd1fb';
const METAC = '0xb2000000000000000000008bc8786b856e61707c';

const APPLE_FILING = '0000320193-26-000020';
const APPLE_FOLDER = 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000020';
const META_RELEASE = 'https://www.prnewswire.com/news-releases/meta-announces-quarterly-cash-dividend-302999999.html';

function appleExhibit(amount: string, pay: string, record: string): string {
  return `<html><body><p>Apple&#8217;s board of directors has declared a cash dividend of $${amount} per share of the Company&#8217;s common stock. The dividend is payable on ${pay}, to shareholders of record as of the close of business on ${record}.</p></body></html>`;
}

/** EDGAR, Microsoft's newsroom and PR Newswire as a table of URLs. */
function webV1(pages: Record<string, string | number>) {
  const asked: Array<{ url: string; agent: string }> = [];
  const fetch: DividendFetchV1 = async (url, init) => {
    asked.push({ url, agent: init.headers['User-Agent'] ?? '' });
    const page = pages[url];
    if (page === undefined) return { ok: false, status: 404, text: async () => '' };
    if (typeof page === 'number') return { ok: false, status: page, text: async () => '' };
    return { ok: true, status: 200, text: async () => page };
  };
  return { fetch, asked };
}

function submissions(filings: Array<{ accession: string; accepted: string; items: string }>): string {
  return JSON.stringify({
    filings: {
      recent: {
        form: filings.map(() => '8-K'),
        accessionNumber: filings.map((row) => row.accession),
        acceptanceDateTime: filings.map((row) => row.accepted),
        items: filings.map((row) => row.items),
      },
    },
  });
}

const EMPTY_FEED = '<rss><channel></channel></rss>';

function metaFeed(published: string): string {
  return `<rss><channel><item><title><![CDATA[Meta Announces Quarterly Cash Dividend]]></title><link>${META_RELEASE}</link><pubDate>${published}</pubDate></item></channel></rss>`;
}

/** Apple files its October results with the next dividend; Meta announces
 * its own on PR Newswire. */
function pagesV1(over: Record<string, string | number> = {}): Record<string, string | number> {
  return {
    // Every other company the watcher reads filed nothing that week.
    ...Object.fromEntries(
      DIVIDEND_ISSUERS_V1.filter((issuer) => issuer.cik).map((issuer) => [
        `https://data.sec.gov/submissions/CIK${issuer.cik!.padStart(10, '0')}.json`,
        submissions([]),
      ]),
    ),
    'https://data.sec.gov/submissions/CIK0000320193.json': submissions([
      { accession: APPLE_FILING, accepted: '2026-10-29T20:30:12.000Z', items: '2.02,9.01' },
    ]),
    [`${APPLE_FOLDER}/index.json`]: JSON.stringify({
      directory: {
        item: [{ name: 'aapl-20261029.htm' }, { name: 'a8-kex991q4.htm' }, { name: 'R1.htm' }, { name: `${APPLE_FILING}-index.htm` }],
      },
    }),
    [`${APPLE_FOLDER}/aapl-20261029.htm`]: '<html><body>Item 2.02 Results of Operations and Financial Condition.</body></html>',
    [`${APPLE_FOLDER}/a8-kex991q4.htm`]: appleExhibit('0.27', 'November 12, 2026', 'November 9, 2026'),
    'https://data.sec.gov/submissions/CIK0001652044.json': submissions([]),
    'https://data.sec.gov/submissions/CIK0001045810.json': submissions([]),
    'https://data.sec.gov/submissions/CIK0000789019.json': submissions([]),
    'https://data.sec.gov/submissions/CIK0001326801.json': submissions([]),
    'https://news.microsoft.com/source/?s=quarterly+dividend&feed=rss2': EMPTY_FEED,
    'https://www.prnewswire.com/rss/financial-services-latest-news/dividends-list.rss': metaFeed('Thu, 29 Oct 2026 20:15:00 +0000'),
    [META_RELEASE]:
      "<p>The Meta Platforms, Inc. (Nasdaq: META) board of directors today declared a quarterly cash dividend of $0.525 per share of the company's outstanding Class A common stock and Class B common stock, payable on December 28, 2026 to stockholders of record as of the close of business on December 21, 2026.</p>",
    ...over,
  };
}

async function tokensOf(underlyingKey: string): Promise<string[]> {
  return underlyingKey === APPLE ? [AAPLC] : underlyingKey === META ? [METAC] : [];
}

describe('new dividend declarations, from the companies’ own releases', () => {
  test('the pass that opens the watch stores what it finds and announces none of it', async () => {
    const declarations = new InMemoryDividendDeclarationRepositoryV1();
    const signals = createMemoryRwaSignalRepository();
    const web = webV1(pagesV1());
    const pass = await runDividendDeclarationWatchV1({
      fetch: web.fetch,
      now: new Date('2026-10-30T02:00:00Z'),
      declarations,
      signals,
      tokensOf,
    });
    assert.equal(pass.openedWatch, true);
    assert.deepEqual([pass.recorded, pass.signalled, pass.failed, pass.unmatched], [2, 0, [], []]);
    const stored = await declarations.declarations();
    assert.deepEqual(
      stored.map((row) => [row.symbol, row.amountPerShare, row.recordDate, row.payDate, row.declaredOn, row.sourceKind]),
      [
        ['AAPL', '0.27', '2026-11-09', '2026-11-12', '2026-10-29', 'sec_8k'],
        ['META', '0.525', '2026-12-21', '2026-12-28', '2026-10-29', 'press_wire'],
      ],
    );
    assert.equal(stored[0]!.source.url, `${APPLE_FOLDER}/a8-kex991q4.htm`);
    assert.equal(stored[0]!.source.publisher, 'Apple Inc., Form 8-K, exhibit 99.1');
    // EDGAR is told who is asking, by the product's name; nothing else is.
    for (const request of web.asked) {
      const sec = /^https:\/\/(data|www)\.sec\.gov\//.test(request.url);
      assert.equal(request.agent === SEC_USER_AGENT_V1, sec, request.url);
      assert.doesNotMatch(request.agent, /@/);
    }
    // The R pages and the filing index page are never fetched.
    assert.equal(web.asked.some((request) => /R1\.htm|-index\.htm$/.test(request.url)), false);
  });

  test('once watching, a new declaration is one signal per token, and a repeat is nothing', async () => {
    const declarations = new InMemoryDividendDeclarationRepositoryV1();
    const signals = createMemoryRwaSignalRepository();
    const quiet = pagesV1({
      'https://data.sec.gov/submissions/CIK0000320193.json': submissions([]),
      'https://www.prnewswire.com/rss/financial-services-latest-news/dividends-list.rss': EMPTY_FEED,
    });
    await runDividendDeclarationWatchV1({ fetch: webV1(quiet).fetch, now: new Date('2026-10-29T12:00:00Z'), declarations, signals, tokensOf });

    const now = new Date('2026-10-30T02:00:00Z');
    const pass = await runDividendDeclarationWatchV1({ fetch: webV1(pagesV1()).fetch, now, declarations, signals, tokensOf });
    assert.deepEqual([pass.openedWatch, pass.recorded, pass.signalled], [false, 2, 2]);
    const feed = await signals.recentSignals({ chainId: 8453, kinds: ['official_asset_dividend_declared'], limit: 10 });
    const apple = feed.find((row) => row.subjectAddress === AAPLC)!;
    assert.equal(apple.occurredAt, '2026-10-29T20:30:12.000Z');
    assert.deepEqual(apple.facts, {
      underlyingKey: APPLE,
      symbol: 'AAPL',
      company: 'Apple',
      amountPerShare: '0.27',
      declaredOn: '2026-10-29',
      exDate: null,
      recordDate: '2026-11-09',
      payDate: '2026-11-12',
      sourceUrl: `${APPLE_FOLDER}/a8-kex991q4.htm`,
    });

    const again = await runDividendDeclarationWatchV1({ fetch: webV1(pagesV1()).fetch, now, declarations, signals, tokensOf });
    assert.deepEqual([again.recorded, again.known, again.signalled], [0, 2, 0]);
  });

  test('what the registry names is the registry’s; a second release that disagrees is left for review', async () => {
    const declarations = new InMemoryDividendDeclarationRepositoryV1();
    const signals = createMemoryRwaSignalRepository();
    const now = new Date('2026-10-30T02:00:00Z');
    await runDividendDeclarationWatchV1({ fetch: webV1(pagesV1()).fetch, now, declarations, signals, tokensOf });
    // The same payment date, a different amount: not merged, not replaced.
    const reworded = pagesV1({ [`${APPLE_FOLDER}/a8-kex991q4.htm`]: appleExhibit('0.28', 'November 12, 2026', 'November 9, 2026') });
    const pass = await runDividendDeclarationWatchV1({ fetch: webV1(reworded).fetch, now, declarations, signals, tokensOf });
    assert.deepEqual(pass.conflicts, ['AAPL:2026-11-12']);
    assert.equal((await declarations.declarations()).find((row) => row.symbol === 'AAPL')?.amountPerShare, '0.27');

    // Apple's August payment is in the registry: found, and left to it.
    const august = pagesV1({
      'https://data.sec.gov/submissions/CIK0000320193.json': submissions([
        { accession: APPLE_FILING, accepted: '2026-07-30T20:30:12.000Z', items: '2.02,9.01' },
      ]),
      [`${APPLE_FOLDER}/a8-kex991q4.htm`]: appleExhibit('0.27', 'August 13, 2026', 'August 10, 2026'),
      'https://www.prnewswire.com/rss/financial-services-latest-news/dividends-list.rss': EMPTY_FEED,
    });
    const known = await runDividendDeclarationWatchV1({
      fetch: webV1(august).fetch,
      now: new Date('2026-07-31T02:00:00Z'),
      declarations: new InMemoryDividendDeclarationRepositoryV1(),
      signals: createMemoryRwaSignalRepository(),
      tokensOf,
    });
    assert.deepEqual([known.found, known.recorded, known.known], [1, 0, 1]);
  });

  test('a source that refuses is named, and the others are still read; a reworded release is reported, not guessed', async () => {
    const pages = pagesV1({
      'https://data.sec.gov/submissions/CIK0001326801.json': 403,
      [`${APPLE_FOLDER}/a8-kex991q4.htm`]:
        '<p>The board declared a quarterly cash dividend of $0.28 per share, to be paid in November.</p>',
    });
    const pass = await runDividendDeclarationWatchV1({
      fetch: webV1(pages).fetch,
      now: new Date('2026-10-30T02:00:00Z'),
      declarations: new InMemoryDividendDeclarationRepositoryV1(),
      signals: createMemoryRwaSignalRepository(),
      tokensOf,
    });
    assert.deepEqual(pass.failed, ['META:sec:dividend_source_http_403']);
    assert.deepEqual(pass.unmatched, [`AAPL:${APPLE_FOLDER}/a8-kex991q4.htm`]);
    assert.equal(pass.recorded, 1, 'Meta, from its feed');
  });

  test('a filing whose release was read is read; a restatement of a declaration is not a new one', async () => {
    // Philip Morris, 2026-09-18: the cover page restates the declaration
    // without its dates, beside the release that has them.
    const PM_FOLDER = 'https://www.sec.gov/Archives/edgar/data/1413329/000162828026062621';
    // Kohl's, 2026-08-26: its results 8-K repeats the dividend declared on
    // 2026-08-18, and that release was read a week before.
    const KSS_FOLDER = 'https://www.sec.gov/Archives/edgar/data/885639/000119312526365860';
    const pages = pagesV1({
      'https://data.sec.gov/submissions/CIK0001413329.json': submissions([
        { accession: '0001628280-26-062621', accepted: '2026-09-18T12:04:53.000Z', items: '8.01,9.01' },
      ]),
      [`${PM_FOLDER}/index.json`]: JSON.stringify({ directory: { item: [{ name: 'pm-20260918.htm' }, { name: 'september2026dividend.htm' }] } }),
      [`${PM_FOLDER}/pm-20260918.htm`]:
        '<p>On September 18, 2026, Philip Morris International Inc. issued a press release announcing that its Board of Directors declared a regular quarterly dividend of $1.60 per common share, which press release is attached as Exhibit 99.</p>',
      [`${PM_FOLDER}/september2026dividend.htm`]:
        '<p>The new quarterly dividend of $1.60 per share, up from $1.47 per share, is payable on October 26, 2026, to shareholders of record as of October 2, 2026. The ex-dividend date is October 2, 2026.</p>',
      'https://data.sec.gov/submissions/CIK0000885639.json': submissions([
        { accession: '0001193125-26-365860', accepted: '2026-08-26T15:00:10.000Z', items: '2.02,8.01,9.01' },
      ]),
      [`${KSS_FOLDER}/index.json`]: JSON.stringify({ directory: { item: [{ name: 'd171200d8k.htm' }] } }),
      [`${KSS_FOLDER}/d171200d8k.htm`]:
        '<p>Item 8.01 Other Events . As previously announced, on August 18, 2026, the Board of Directors of the Company declared a quarterly cash dividend of $0.125 per share. The dividend will be paid on September 23, 2026, to all shareholders of record at the close of business on September 9, 2026.</p>',
    });
    const pass = await runDividendDeclarationWatchV1({
      fetch: webV1(pages).fetch,
      now: new Date('2026-09-18T14:00:00Z'),
      declarations: new InMemoryDividendDeclarationRepositoryV1(),
      signals: createMemoryRwaSignalRepository(),
      tokensOf,
      issuers: DIVIDEND_ISSUERS_V1.filter((issuer) => issuer.symbol === 'PM'),
    });
    assert.deepEqual([pass.found, pass.known, pass.unmatched], [1, 1, []], 'the registry already names it');
    const kohls = await runDividendDeclarationWatchV1({
      fetch: webV1(pages).fetch,
      now: new Date('2026-08-27T02:00:00Z'),
      declarations: new InMemoryDividendDeclarationRepositoryV1(),
      signals: createMemoryRwaSignalRepository(),
      tokensOf,
      issuers: DIVIDEND_ISSUERS_V1.filter((issuer) => issuer.symbol === 'KSS'),
    });
    assert.deepEqual([kohls.found, kohls.unmatched], [0, []]);
  });

  test('a release dated a few minutes ahead of our clock is read as published now', async () => {
    const declarations = new InMemoryDividendDeclarationRepositoryV1();
    const pass = await runDividendDeclarationWatchV1({
      fetch: webV1(pagesV1()).fetch,
      now: new Date('2026-10-29T20:14:00Z'),
      declarations,
      signals: createMemoryRwaSignalRepository(),
      tokensOf,
    });
    assert.deepEqual(pass.failed, []);
    const meta = (await declarations.declarations()).find((row) => row.symbol === 'META')!;
    assert.equal(meta.publishedAt, '2026-10-29T20:14:00.000Z');
  });

  test('releases older than three days are not fetched at all', async () => {
    const web = webV1(pagesV1());
    const pass = await runDividendDeclarationWatchV1({
      fetch: web.fetch,
      now: new Date('2026-11-05T02:00:00Z'),
      declarations: new InMemoryDividendDeclarationRepositoryV1(),
      signals: createMemoryRwaSignalRepository(),
      tokensOf,
    });
    assert.equal(pass.releasesRead, 0);
    assert.equal(web.asked.some((request) => request.url.endsWith('.htm') || request.url === META_RELEASE), false);
  });
});
