import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createEarningsCalendar, readCalendar, reportDay } from '../src/calendar.js';

// The Aave V4 API's answer on Sunday 2026-10-25, trimmed to the last four reports per stock.
const ANSWER = JSON.parse(readFileSync(new URL('./fixtures/aave-calendar.json', import.meta.url), 'utf8')) as {
  data: { tokenizedStocks: { items: Array<Record<string, unknown>>; pageInfo: { next: string | null } } };
};
const READ_AT = new Date('2026-10-25T18:08:00Z');

const answering = (body: unknown, status = 200) => mock.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
const withItems = (change: (items: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) => ({
  data: { tokenizedStocks: { items: change(structuredClone(ANSWER.data.tokenizedStocks.items)), pageInfo: { next: null } } },
});

describe('reading the calendar Aave shows', () => {
  it('turns the real answer into New York report days per stock, keeping last week for the day after', async () => {
    const fetchFn = answering(ANSWER);
    const calendar = await readCalendar('https://api.test/graphql', fetchFn, READ_AT, 1_000);
    const [, init] = fetchFn.mock.calls[0]!.arguments;
    assert.deepEqual(JSON.parse(String(init!.body)).variables, { request: { pageSize: 'FIFTY' }, since: '2026-10-18T18:08:00.000Z' });
    assert.deepEqual(Object.fromEntries(calendar.dates), {
      AAPLc: ['2026-11-02'],
      AMZNc: ['2026-10-29'],
      GOOGLc: ['2026-10-28'],
      METAc: ['2026-10-21'],
      MSFTc: ['2026-10-28'],
      NVDAc: ['2026-11-18'],
      TSLAc: ['2026-10-21'],
    });
    assert.equal(calendar.readAt, READ_AT);
  });

  it('matches stocks by token address on Base, never by ticker', async () => {
    const body = withItems((items) => [
      ...items.filter((i) => i.tickerSymbol !== 'NVDA'),
      { chainId: 8453, address: '0x00000000000000000000000000000000000bad01', tickerSymbol: 'NVDA', offchain: { nextEarningsReport: '2026-10-26T04:00:00+00:00', earnings: [] } },
      { chainId: 1, address: '0xb20000000000000000000078ee7ce2fE4908108C', tickerSymbol: 'NVDA', offchain: { nextEarningsReport: '2026-10-26T04:00:00+00:00', earnings: [] } },
    ]);
    const calendar = await readCalendar('https://api.test/graphql', answering(body), READ_AT, 1_000);
    assert.equal(calendar.dates.has('NVDAc'), false); // left out: unread, not "nothing scheduled"
    assert.deepEqual(calendar.dates.get('AAPLc'), ['2026-11-02']);
  });

  it('a stock whose dates cannot all be read is unread, not empty', async () => {
    const body = withItems((items) =>
      items.map((i) => {
        if (i.tickerSymbol === 'AAPL') return { ...i, offchain: null };
        if (i.tickerSymbol === 'MSFT') return { ...i, offchain: { nextEarningsReport: 'soon', earnings: [] } };
        if (i.tickerSymbol === 'AMZN') return { ...i, offchain: { nextEarningsReport: '2026-10-29T04:00:00+00:00', earnings: null } };
        return i;
      }),
    );
    const calendar = await readCalendar('https://api.test/graphql', answering(body), READ_AT, 1_000);
    assert.deepEqual([...calendar.dates.keys()].sort(), ['GOOGLc', 'METAc', 'NVDAc', 'TSLAc']);
  });

  it('refuses an answer that is not a calendar', async () => {
    for (const fetchFn of [
      answering({ errors: [{ message: 'rate limited' }] }),
      answering({ data: { tokenizedStocks: null } }),
      answering(ANSWER, 503),
      mock.fn<typeof fetch>(async () => new Response('<html>Bad Gateway</html>', { status: 200 })),
    ]) {
      await assert.rejects(readCalendar('https://api.test/graphql', fetchFn, READ_AT, 1_000));
    }
  });

  it('reads a date the way Aave writes it, and a bare UTC midnight as that day', () => {
    assert.equal(reportDay('2026-11-02T05:00:00+00:00'), '2026-11-02'); // midnight EST
    assert.equal(reportDay('2026-10-28T04:00:00+00:00'), '2026-10-28'); // midnight EDT
    assert.equal(reportDay('2026-10-28T00:00:00Z'), '2026-10-28');
    assert.equal(reportDay('2026-10-28T20:05:00Z'), '2026-10-28'); // 16:05 New York
    assert.equal(reportDay('next week'), null);
  });
});

describe('the calendar clock', () => {
  function clocked(fetchFn: typeof fetch) {
    let now = READ_AT.getTime();
    const source = createEarningsCalendar({ url: 'https://api.test/graphql', fetch: fetchFn, now: () => new Date(now), ttlMs: 3_600_000, retryMs: 60_000, staleMs: 86_400_000 });
    return { source, advance: (ms: number) => (now += ms) };
  }

  it('reads once an hour, and once for callers asking together', async () => {
    const fetchFn = answering(ANSWER);
    const { source, advance } = clocked(fetchFn);
    const [a, b] = await Promise.all([source.current(), source.current()]);
    assert.deepEqual(a, b);
    assert.equal(a.ok, true);
    advance(59 * 60_000);
    await source.current();
    assert.equal(fetchFn.mock.callCount(), 1);
    advance(2 * 60_000);
    await source.current();
    assert.equal(fetchFn.mock.callCount(), 2);
  });

  it('serves the last good calendar for a day when reads fail, retrying after a pause', async () => {
    let failing = false;
    const fetchFn = mock.fn<typeof fetch>(async () => (failing ? new Response('down', { status: 502 }) : new Response(JSON.stringify(ANSWER))));
    const { source, advance } = clocked(fetchFn);
    await source.current();
    failing = true;
    advance(2 * 3_600_000);
    const stale = await source.current();
    assert.deepEqual(stale.ok && stale.calendar.readAt, READ_AT); // says when it was read
    await source.current(); // within the pause: no new request
    assert.equal(fetchFn.mock.callCount(), 2);
    advance(23 * 3_600_000);
    assert.deepEqual(await source.current(), { ok: false }); // older than a day: unread
  });

  it('with nothing good to fall back on, the calendar is unread', async () => {
    const { source } = clocked(mock.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    assert.deepEqual(await source.current(), { ok: false });
  });
});
