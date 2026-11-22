import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  STILL_AGENT_PASS_PLANS_V1,
  stillAgentNameV1,
  stillAgentPassPlanV1,
  stillAgentPassSpanV1,
  stillErrandCollateralV1,
  stillErrandKindFitsV1,
  stillErrandNextDueV1,
  stillErrandRecipientV1,
  stillErrandReminderV1,
  stillErrandScheduleV1,
  stillTimeZoneV1,
  stillZonedInstantV1,
} from '../src/agent.js';

describe('Still Agent', () => {
  it('takes a name the person gave it, and nothing that could be markup or a link', () => {
    assert.equal(stillAgentNameV1('  Pip  '), 'Pip');
    assert.equal(stillAgentNameV1('Мистер  Пип'), 'Мистер Пип');
    assert.equal(stillAgentNameV1("O'Neil-2"), "O'Neil-2");
    for (const bad of ['', '   ', '<b>Pip</b>', 'https://x.y', 'Pip!', '-Pip', 'a'.repeat(25), 42, null]) assert.equal(stillAgentNameV1(bad), null, String(bad));
    assert.equal(stillErrandRecipientV1('Маша'), 'Маша');
    assert.equal(stillErrandRecipientV1('<script>'), null);
  });

  it('knows a time zone only by its IANA name', () => {
    assert.equal(stillTimeZoneV1('Europe/Dublin'), 'Europe/Dublin');
    assert.equal(stillTimeZoneV1('Europe/Sofia'), 'Europe/Sofia');
    for (const bad of ['Mars/Olympus', '', 'UTC; DROP', 42]) assert.equal(stillTimeZoneV1(bad), null, String(bad));
  });

  it('reads a schedule of exactly its own shape: a month day every month can have, or a real date', () => {
    assert.deepEqual(stillErrandScheduleV1({ every: 'month', day: 1 }), { every: 'month', day: 1 });
    assert.deepEqual(stillErrandScheduleV1({ every: 'year', month: 2, day: 29 }), { every: 'year', month: 2, day: 29 });
    for (const bad of [{ every: 'month', day: 29 }, { every: 'month', day: 0 }, { every: 'year', month: 4, day: 31 }, { every: 'week', day: 1 },
      { every: 'month', day: 1, extra: true }, { every: 'month', day: 1.5 }, null, []]) {
      assert.equal(stillErrandScheduleV1(bad), null, JSON.stringify(bad));
    }
    assert.equal(stillErrandKindFitsV1('subscription', { every: 'month', day: 1 }), true);
    assert.equal(stillErrandKindFitsV1('gift', { every: 'month', day: 1 }), false);
    assert.equal(stillErrandKindFitsV1('gift', { every: 'year', month: 3, day: 14 }), true);
  });

  it('pledges only what Still lends against, as the person chose it', () => {
    assert.equal(stillErrandCollateralV1('AAPLc'), 'AAPLc');
    assert.equal(stillErrandCollateralV1('PAXG'), 'PAXG');
    assert.equal(stillErrandCollateralV1('AAPL'), null);
  });

  it('is due at 09:00 where the person is, strictly after the last time', () => {
    // Dublin is UTC+0 in winter, UTC+1 in summer.
    assert.equal(stillZonedInstantV1({ year: 2026, month: 12, day: 1, hour: 9, timeZone: 'Europe/Dublin' }).toISOString(), '2026-12-01T09:00:00.000Z');
    assert.equal(stillZonedInstantV1({ year: 2027, month: 7, day: 1, hour: 9, timeZone: 'Europe/Dublin' }).toISOString(), '2027-07-01T08:00:00.000Z');
    assert.equal(stillZonedInstantV1({ year: 2026, month: 12, day: 1, hour: 9, timeZone: 'Europe/Sofia' }).toISOString(), '2026-12-01T07:00:00.000Z');
    assert.equal(stillZonedInstantV1({ year: 2026, month: 12, day: 1, hour: 9, timeZone: 'America/New_York' }).toISOString(), '2026-12-01T14:00:00.000Z');
    const monthly = { every: 'month', day: 1 } as const;
    assert.equal(stillErrandNextDueV1(monthly, 'Europe/Sofia', new Date('2026-11-22T05:00:00Z')).toISOString(), '2026-12-01T07:00:00.000Z');
    // At the due instant itself, the next one is a month later: one reminder per day.
    assert.equal(stillErrandNextDueV1(monthly, 'Europe/Sofia', new Date('2026-12-01T07:00:00Z')).toISOString(), '2027-01-01T07:00:00.000Z');
    assert.equal(stillErrandNextDueV1(monthly, 'Europe/Sofia', new Date('2026-12-01T06:59:59Z')).toISOString(), '2026-12-01T07:00:00.000Z');
    // Across the year's end, and in a zone whose date is already tomorrow.
    assert.equal(stillErrandNextDueV1({ every: 'month', day: 15 }, 'Pacific/Auckland', new Date('2026-12-20T00:00:00Z')).toISOString(), '2027-01-14T20:00:00.000Z');
    const birthday = { every: 'year', month: 3, day: 14 } as const;
    assert.equal(stillErrandNextDueV1(birthday, 'Europe/Dublin', new Date('2026-11-22T05:00:00Z')).toISOString(), '2027-03-14T09:00:00.000Z');
    assert.equal(stillErrandNextDueV1({ every: 'year', month: 2, day: 29 }, 'Europe/Dublin', new Date('2026-11-22T05:00:00Z')).toISOString(), '2027-02-28T09:00:00.000Z');
    assert.equal(stillErrandNextDueV1({ every: 'year', month: 2, day: 29 }, 'Europe/Dublin', new Date('2027-03-01T00:00:00Z')).toISOString(), '2028-02-29T09:00:00.000Z');
  });

  it('sells a pass at one USDC first, then three for thirty days or thirty for a year, and never loses a running day', () => {
    assert.deepEqual(STILL_AGENT_PASS_PLANS_V1.map((row) => [row.plan, row.priceAtomic, row.days, row.firstOnly]),
      [['intro', '1000000', 30, true], ['month', '3000000', 30, false], ['year', '30000000', 365, false]]);
    assert.equal(stillAgentPassPlanV1('gold'), null);
    const now = new Date('2026-11-22T00:00:00Z');
    const fresh = stillAgentPassSpanV1(stillAgentPassPlanV1('month')!, now, null);
    assert.equal(fresh.endsAt.toISOString(), '2026-12-22T00:00:00.000Z');
    const extended = stillAgentPassSpanV1(stillAgentPassPlanV1('month')!, now, new Date('2026-12-01T00:00:00Z'));
    assert.equal(extended.startsAt.toISOString(), '2026-12-01T00:00:00.000Z');
    assert.equal(extended.endsAt.toISOString(), '2026-12-31T00:00:00.000Z');
    assert.equal(stillAgentPassSpanV1(stillAgentPassPlanV1('month')!, now, new Date('2026-11-01T00:00:00Z')).startsAt.toISOString(), now.toISOString());
  });

  it('says on the day what is ready, how the person chose to pay, the risk of a loan, and that nothing is signed', () => {
    const base = { agentName: 'Pip', productName: 'Netflix EU', packageLabel: '15 EUR', recipient: null } as const;
    const usdc = stillErrandReminderV1({ ...base, language: 'en', kind: 'subscription', schedule: { every: 'month', day: 1 }, funding: { kind: 'usdc' } });
    assert.equal(usdc.title, 'Pip · Still Agent');
    assert.deepEqual(usdc.lines, [
      'It\'s the 1st: your Netflix EU (15 EUR) card is ready to review.',
      'You chose to pay from your USDC.',
      'Nothing has been signed: you see the price on Still and sign in your own wallet.',
    ]);
    assert.equal(usdc.button, 'Review on Still');
    for (const [day, word] of [[2, '2nd'], [3, '3rd'], [11, '11th'], [21, '21st'], [22, '22nd'], [23, '23rd'], [28, '28th']] as const) {
      assert.match(stillErrandReminderV1({ ...base, language: 'en', kind: 'subscription', schedule: { every: 'month', day }, funding: { kind: 'usdc' } }).lines[0]!, new RegExp(`^It's the ${word}:`));
    }
    const gift = stillErrandReminderV1({ ...base, productName: 'Apple Ireland', packageLabel: '20 EUR', recipient: 'Masha', language: 'en', kind: 'gift',
      schedule: { every: 'year', month: 3, day: 14 }, funding: { kind: 'loan', collateral: 'AAPLc' } });
    assert.deepEqual(gift.lines.slice(0, 2), [
      'A gift for Masha: the Apple Ireland (20 EUR) card is ready to review.',
      'You chose a loan against AAPLc. A loan is debt, and its collateral can be liquidated.',
    ]);
    const ru = stillErrandReminderV1({ ...base, language: 'ru', kind: 'subscription', schedule: { every: 'month', day: 1 }, funding: { kind: 'loan', collateral: 'AAPLc' } });
    assert.deepEqual(ru.lines, [
      'Сегодня 1-е число: карта Netflix EU (15 EUR) готова к проверке.',
      'Вы выбрали займ под AAPLc. Займ — это долг, а залог могут ликвидировать.',
      'Ничего не подписано: цену вы увидите в Still и подпишете в своём кошельке.',
    ]);
    assert.equal(ru.button, 'Проверить в Still');
    // Never a promise that liquidation cannot happen, never "shares never sold".
    for (const words of [usdc, gift, ru]) assert.doesNotMatch(words.lines.join(' '), /never (be )?liquidat|cannot be liquidated|never sold/i);
  });
});
