import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CalendarRead } from '../src/calendar.js';
import { StillTermsSchema, stillTerms } from '../src/terms.js';

const SATURDAY = new Date('2026-10-31T15:00:00Z'); // 11:00 in New York
const read: CalendarRead = {
  ok: true,
  calendar: { readAt: new Date('2026-10-31T14:00:00Z'), dates: new Map([['NVDAc', ['2026-11-18']], ['TSLAc', []]]) },
};

describe('the terms', () => {
  it('name the windows open now and each stock’s next report, and the client schema accepts them', () => {
    const terms = StillTermsSchema.parse(JSON.parse(JSON.stringify(stillTerms(read, SATURDAY))));
    assert.equal(terms.sharePercentOfProtocol, 50);
    assert.equal(terms.weekend.activeNow, true);
    assert.equal(terms.weekend.endsAt, '2026-11-02T01:00:00.000Z');
    const nvda = terms.earnings.stocks.find((s) => s.id === 'NVDAc')!;
    assert.equal(nvda.windowStartsAt, '2026-11-17T05:00:00.000Z');
    assert.equal(nvda.countsAtEarningsRateNow, false);
    // Unread is the safe side: the stock counts at the earnings rate, with no window to show.
    const apple = terms.earnings.stocks.find((s) => s.id === 'AAPLc')!;
    assert.deepEqual([apple.calendarRead, apple.countsAtEarningsRateNow, apple.windowStartsAt], [false, true, null]);
  });

  it('parse with no calendar at all, and refuse a field the schema does not know', () => {
    const unread = JSON.parse(JSON.stringify(stillTerms({ ok: false }, SATURDAY)));
    assert.equal(StillTermsSchema.parse(unread).earnings.calendarReadAt, null);
    assert.equal(StillTermsSchema.safeParse({ ...unread, extra: 1 }).success, false);
    assert.equal(StillTermsSchema.safeParse({ ...unread, notOfferedTo: 'nobody' }).success, false);
  });
});
