import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { StillLoanAlertRepositoryV1, StillLoanReadingLineV1 } from '../src/stillLoanAlerts.js';

// ---------------------------------------------------------------------------
// Still's loan alerts: one row per loan, and an episode that moves only when
// the band gets worse. The same contract runs on the in-memory store and on
// Postgres, so the fake cannot drift from the SQL.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const SPOKE = '0x17905db0e4a3514467539956c084180616ae7b8d';
const MORPHO_MARKET = `0x${'ab'.repeat(32)}`;
const AT = new Date('2026-11-02T15:00:00.000Z');
const later = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);

const aave = (state: StillLoanReadingLineV1['state'], marginBps: number): StillLoanReadingLineV1 => ({ market: SPOKE, venue: 'aave-v4', state, marginBps });
const morpho = (state: StillLoanReadingLineV1['state'], marginBps: number): StillLoanReadingLineV1 => ({ market: MORPHO_MARKET, venue: 'morpho', state, marginBps });

export function stillLoanAlertsContractV1(label: string, make: () => Promise<StillLoanAlertRepositoryV1>): void {
  describe(`${label}: a loan is told once per worse band`, () => {
    test('a calm first reading is kept and owes nothing; a first reading in watch is due', async () => {
      const alerts = await make();
      await alerts.recordReading({ walletAddress: WALLET, at: AT, block: '100', lines: [aave('calm', 5_000)], unread: [] });
      const [calm] = await alerts.loansOf(WALLET);
      assert.deepEqual([calm!.state, calm!.marginBps, calm!.episode, calm!.readBlock], ['calm', 5_000, 0, '100']);
      assert.deepEqual(await alerts.due({ channel: 'telegram', freshSince: AT }), []);
      await alerts.recordReading({ walletAddress: OTHER, at: AT, block: '100', lines: [morpho('watch', 3_100)], unread: [] });
      const due = await alerts.due({ channel: 'telegram', freshSince: AT });
      assert.deepEqual(due.map((loan) => [loan.walletAddress, loan.market, loan.state, loan.episode]), [[OTHER, MORPHO_MARKET, 'watch', 1]]);
    });

    test('worse moves the episode, better does not, and each channel tells it once', async () => {
      const alerts = await make();
      await alerts.recordReading({ walletAddress: WALLET, at: AT, block: '100', lines: [aave('calm', 5_000)], unread: [] });
      await alerts.recordReading({ walletAddress: WALLET, at: later(5), block: '200', lines: [aave('watch', 3_000)], unread: [] });
      let [loan] = await alerts.due({ channel: 'telegram', freshSince: AT });
      assert.deepEqual([loan!.state, loan!.episode], ['watch', 1]);
      await alerts.markTold({ walletAddress: WALLET, market: SPOKE, channel: 'telegram', episode: 1 });
      assert.deepEqual(await alerts.due({ channel: 'telegram', freshSince: AT }), []);
      // The other channel has not told it yet.
      assert.equal((await alerts.due({ channel: 'base_app', freshSince: AT })).length, 1);

      await alerts.recordReading({ walletAddress: WALLET, at: later(10), block: '300', lines: [aave('act', 1_500)], unread: [] });
      [loan] = await alerts.due({ channel: 'telegram', freshSince: AT });
      assert.deepEqual([loan!.state, loan!.marginBps, loan!.episode], ['act', 1_500, 2]);
      // A told mark for an episode that has moved on changes nothing.
      await alerts.markTold({ walletAddress: WALLET, market: SPOKE, channel: 'telegram', episode: 1 });
      assert.equal((await alerts.due({ channel: 'telegram', freshSince: AT })).length, 1);
      await alerts.markTold({ walletAddress: WALLET, market: SPOKE, channel: 'telegram', episode: 2 });

      // Better again: the band is kept, the episode stays, nothing is due.
      await alerts.recordReading({ walletAddress: WALLET, at: later(15), block: '400', lines: [aave('watch', 3_200)], unread: [] });
      assert.deepEqual(await alerts.due({ channel: 'telegram', freshSince: AT }), []);
      [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.state, loan!.episode], ['watch', 2]);
      // A later fall is told again.
      await alerts.recordReading({ walletAddress: WALLET, at: later(20), block: '500', lines: [aave('act', 1_900)], unread: [] });
      [loan] = await alerts.due({ channel: 'telegram', freshSince: AT });
      assert.deepEqual([loan!.state, loan!.episode], ['act', 3]);
    });

    test('the wallets read first are those whose last reading was not calm (audit LL-3)', async () => {
      const alerts = await make();
      assert.deepEqual(await alerts.attention(), []);
      await alerts.recordReading({ walletAddress: WALLET, at: AT, block: '100', lines: [aave('calm', 5_000)], unread: [] });
      await alerts.recordReading({ walletAddress: OTHER, at: AT, block: '100', lines: [aave('calm', 5_000), morpho('act', 1_500)], unread: [] });
      assert.deepEqual(await alerts.attention(), [OTHER]);
      await alerts.recordReading({ walletAddress: WALLET, at: later(5), block: '200', lines: [aave('liquidation', 0)], unread: [] });
      assert.deepEqual(await alerts.attention(), [WALLET, OTHER]);
      await alerts.recordReading({ walletAddress: OTHER, at: later(6), block: '210', lines: [], unread: [] });
      assert.deepEqual(await alerts.attention(), [WALLET]);
    });

    test('a repaid loan goes, an unread one stays, and an older block changes nothing', async () => {
      const alerts = await make();
      await alerts.recordReading({ walletAddress: WALLET, at: AT, block: '100', lines: [aave('watch', 3_000), morpho('calm', 6_000)], unread: [] });
      assert.equal((await alerts.loansOf(WALLET)).length, 2);
      // The Aave side could not be read: it is not repaid, and not safe either.
      await alerts.recordReading({ walletAddress: WALLET, at: later(5), block: '200', lines: [morpho('calm', 6_100)], unread: [SPOKE] });
      assert.deepEqual((await alerts.loansOf(WALLET)).map((loan) => [loan.market, loan.state]), [[SPOKE, 'watch'], [MORPHO_MARKET, 'calm']]);
      // A reading from before the one each row keeps is not news.
      await alerts.recordReading({ walletAddress: WALLET, at: later(6), block: '50', lines: [aave('liquidation', 0), morpho('act', 1_000)], unread: [] });
      const kept = await alerts.loansOf(WALLET);
      assert.deepEqual(kept.map((loan) => [loan.market, loan.state, loan.episode, loan.readBlock]),
        [[SPOKE, 'watch', 1, '100'], [MORPHO_MARKET, 'calm', 0, '200']]);
      // Both repaid: both rows go, and only this wallet's.
      await alerts.recordReading({ walletAddress: OTHER, at: later(7), block: '210', lines: [morpho('act', 1_000)], unread: [] });
      await alerts.recordReading({ walletAddress: WALLET, at: later(8), block: '220', lines: [], unread: [] });
      assert.deepEqual(await alerts.loansOf(WALLET), []);
      assert.equal((await alerts.loansOf(OTHER)).length, 1);
    });

    test('only a fresh reading is told', async () => {
      const alerts = await make();
      await alerts.recordReading({ walletAddress: WALLET, at: AT, block: '100', lines: [aave('act', 1_000)], unread: [] });
      assert.equal((await alerts.due({ channel: 'telegram', freshSince: AT })).length, 1);
      assert.deepEqual(await alerts.due({ channel: 'telegram', freshSince: later(1) }), []);
    });

    test('the fake refuses what the table refuses', async () => {
      const alerts = await make();
      const ok = { walletAddress: WALLET, at: AT, block: '100', lines: [aave('calm', 5_000)], unread: [] };
      await assert.rejects(() => alerts.recordReading({ ...ok, walletAddress: WALLET.replace('0x', '0X') }), /lowercase 20-byte wallet/);
      await assert.rejects(() => alerts.recordReading({ ...ok, block: '0' }), /positive number/);
      await assert.rejects(() => alerts.recordReading({ ...ok, lines: [{ ...aave('calm', 5_000), market: SPOKE.toUpperCase().replace('0X', '0x') }] }), /lowercase/);
      await assert.rejects(() => alerts.recordReading({ ...ok, lines: [aave('calm', 10_001)] }), /from 0 to 10000/);
      await assert.rejects(() => alerts.recordReading({ ...ok, lines: [aave('calm', 50.5)] }), /whole basis points/);
      await assert.rejects(() => alerts.recordReading({ ...ok, lines: [aave('calm', 5_000), aave('watch', 3_000)] }), /one line per loan/);
      await assert.rejects(() => alerts.recordReading({ ...ok, lines: [{ ...aave('calm', 5_000), state: 'fine' as never }] }), /unknown loan band/);
      await assert.rejects(() => alerts.recordReading({ ...ok, unread: ['0x1234'] }), /Aave spoke or a Morpho market id/);
      await assert.rejects(() => alerts.due({ channel: 'email' as never, freshSince: AT }), /unknown notification channel/);
      await assert.rejects(() => alerts.markTold({ walletAddress: WALLET, market: SPOKE, channel: 'sms' as never, episode: 0 }), /unknown notification channel/);
      await assert.rejects(() => alerts.recordReading({ ...ok, lines: [{ ...aave('calm', 5_000), debtAtomic: '1.5' }] }), /whole USDC base units/);
      await assert.rejects(() => alerts.recordReading({ ...ok, lines: [{ ...aave('calm', 5_000), rateBps: -1 }] }), /from 0 to 1000000/);
      await assert.rejects(() => alerts.recordReading({ ...ok, lines: [{ ...aave('calm', 5_000), holds: { held: ['NVDAc:asleep'], cleared: [] } }] }), /'SYMBOL:kind'/);
      const notice = { channel: 'telegram' as const, kind: 'hold' as const, key: `${WALLET}|${SPOKE}|1`, walletAddress: WALLET, market: SPOKE, at: AT };
      await assert.rejects(() => alerts.recordNotice({ ...notice, kind: 'gift' as never }), /unknown loan notice/);
      await assert.rejects(() => alerts.recordNotice({ ...notice, interestAtomic: '1', estimatedAtomic: '0' }), /only a week's note counts interest/);
      await assert.rejects(() => alerts.recordNotice({ ...notice, kind: 'week' }), /only a week's note counts interest/);
      await assert.rejects(() => alerts.recordNotice({ ...notice, kind: 'week', interestAtomic: '1', estimatedAtomic: '2' }), /only a week's note counts interest/);
      await assert.rejects(() => alerts.recordNotice({ ...notice, key: 'a key with spaces' }), /short plain text/);
      await assert.rejects(() => alerts.recordNotice({ ...notice, kind: 'rate', interestAtomic: '1', estimatedAtomic: '0' }), /only a week's note counts interest/);
      await assert.rejects(() => alerts.markRateTold({ walletAddress: WALLET, market: SPOKE, rateBps: 1.5, at: AT }), /from 0 to 1000000/);
      await assert.rejects(() => alerts.markRateTold({ walletAddress: WALLET, market: '0x1234', rateBps: 100, at: AT }), /Aave spoke or a Morpho market id/);
      await assert.rejects(() => alerts.recoveredDue({ channel: 'sms' as never, freshSince: AT }), /unknown notification channel/);
      await assert.rejects(() => alerts.rateDue({ channel: 'sms' as never, freshSince: AT, highSince: AT }), /unknown notification channel/);
    });
  });

  describe(`${label}: the interest a loan gathers while Still reads it`, () => {
    // 1,000 USDC at 5% a year gathers about 95.13 base units a minute.
    const owed = (debtAtomic: string, rateBps: number | null = 500) => ({ ...aave('calm', 5_000), debtAtomic, rateBps });

    test('growth that is interest alone counts as measured; a borrow between counts the rate as estimated', async () => {
      const alerts = await make();
      await alerts.recordReading({ walletAddress: WALLET, at: AT, block: '100', lines: [owed('1000000000')], unread: [] });
      let [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.debtAtomic, loan!.rateBps, loan!.interestAtomic, loan!.estimatedAtomic], ['1000000000', 500, '0', '0']);
      // Five minutes: 475 units of growth, inside the rate's charge, so it is the interest.
      await alerts.recordReading({ walletAddress: WALLET, at: later(5), block: '200', lines: [owed('1000000475')], unread: [] });
      [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.debtAtomic, loan!.interestAtomic, loan!.estimatedAtomic], ['1000000475', '475', '0']);
      // Another 50 USDC borrowed in the next five minutes: the stretch counts the rate's charge, 475, as estimated.
      await alerts.recordReading({ walletAddress: WALLET, at: later(10), block: '300', lines: [owed('1050000951')], unread: [] });
      [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.interestAtomic, loan!.estimatedAtomic], ['950', '475']);
      // A reading that says no debt or rate keeps the last ones.
      await alerts.recordReading({ walletAddress: WALLET, at: later(15), block: '400', lines: [aave('calm', 5_000)], unread: [] });
      [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.debtAtomic, loan!.rateBps, loan!.interestAtomic], ['1050000951', 500, '950']);
      // A repaid loan goes; borrowing again starts from nothing.
      await alerts.recordReading({ walletAddress: WALLET, at: later(20), block: '500', lines: [], unread: [] });
      await alerts.recordReading({ walletAddress: WALLET, at: later(25), block: '600', lines: [owed('5000000')], unread: [] });
      [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.debtAtomic, loan!.interestAtomic, loan!.estimatedAtomic], ['5000000', '0', '0']);
    });
  });

  describe(`${label}: a hold on the collateral is told once per episode`, () => {
    const held = (held: string[], cleared: string[] = []) => ({ ...morpho('calm', 6_000), holds: { held, cleared } });

    test('a hold appearing starts an episode; the same hold does not; one unread stays as it was', async () => {
      const alerts = await make();
      await alerts.recordReading({ walletAddress: WALLET, at: AT, block: '100', lines: [held([], ['PAXG:transfers_paused'])], unread: [] });
      let [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.holds, loan!.holdEpisode], [[], 0]);
      assert.deepEqual(await alerts.holdsDue({ channel: 'telegram', freshSince: AT }), []);

      await alerts.recordReading({ walletAddress: WALLET, at: later(5), block: '200', lines: [held(['PAXG:transfers_paused'])], unread: [] });
      [loan] = await alerts.holdsDue({ channel: 'telegram', freshSince: AT });
      assert.deepEqual([loan!.holds, loan!.holdEpisode], [['PAXG:transfers_paused'], 1]);
      await alerts.recordNotice({ channel: 'telegram', kind: 'hold', key: `${WALLET}|${MORPHO_MARKET}|1`, walletAddress: WALLET, market: MORPHO_MARKET, at: later(5) });
      await alerts.recordNotice({ channel: 'telegram', kind: 'hold', key: `${WALLET}|${MORPHO_MARKET}|1`, walletAddress: WALLET, market: MORPHO_MARKET, at: later(6) });
      assert.deepEqual(await alerts.holdsDue({ channel: 'telegram', freshSince: AT }), []);
      assert.equal((await alerts.holdsDue({ channel: 'base_app', freshSince: AT })).length, 1, 'the other channel has not told it');

      // Still paused, then a reading that could not tell: nothing new either way.
      await alerts.recordReading({ walletAddress: WALLET, at: later(10), block: '300', lines: [held(['PAXG:transfers_paused'])], unread: [] });
      await alerts.recordReading({ walletAddress: WALLET, at: later(15), block: '400', lines: [morpho('calm', 6_000)], unread: [] });
      [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.holds, loan!.holdEpisode], [['PAXG:transfers_paused'], 1]);
      assert.deepEqual(await alerts.holdsDue({ channel: 'telegram', freshSince: AT }), []);

      // Lifted, then paused again: told again.
      await alerts.recordReading({ walletAddress: WALLET, at: later(20), block: '500', lines: [held([], ['PAXG:transfers_paused'])], unread: [] });
      assert.deepEqual(await alerts.holdsDue({ channel: 'telegram', freshSince: AT }), [], 'no hold, nothing to tell');
      await alerts.recordReading({ walletAddress: WALLET, at: later(25), block: '600', lines: [held(['PAXG:transfers_paused', 'PAXG:wallet_frozen'])], unread: [] });
      [loan] = await alerts.holdsDue({ channel: 'telegram', freshSince: AT });
      assert.deepEqual([loan!.holds, loan!.holdEpisode], [['PAXG:transfers_paused', 'PAXG:wallet_frozen'], 2]);
    });
  });

  describe(`${label}: a loan's week is told once, with the interest since the last note`, () => {
    const owed = (debtAtomic: string) => ({ ...aave('calm', 5_000), debtAtomic, rateBps: 500 });
    const CLOSE = '2026-11-06T21:00:00.000Z';
    const NEXT = '2026-11-13T21:00:00.000Z';

    test('due for a loan with a debt, read fresh and read first long enough ago; the next week counts from the note', async () => {
      const alerts = await make();
      await alerts.recordReading({ walletAddress: WALLET, at: AT, block: '100', lines: [owed('1000000000')], unread: [] });
      await alerts.recordReading({ walletAddress: OTHER, at: AT, block: '100', lines: [aave('calm', 5_000)], unread: [] });
      await alerts.recordReading({ walletAddress: WALLET, at: later(5), block: '200', lines: [owed('1000000475')], unread: [] });
      const ask = { channel: 'telegram' as const, weekCloseAt: CLOSE, freshSince: AT, firstReadBy: AT };
      // Too new: first read after the line.
      assert.deepEqual(await alerts.weekDue({ ...ask, firstReadBy: new Date(AT.getTime() - 1) }), []);
      // Read too long ago.
      assert.deepEqual(await alerts.weekDue({ ...ask, freshSince: later(6) }), []);
      let [week] = await alerts.weekDue(ask);
      assert.deepEqual([week!.loan.walletAddress, week!.loan.interestAtomic, week!.since, week!.interestBeforeAtomic, week!.estimatedBeforeAtomic],
        [WALLET, '475', AT.toISOString(), '0', '0'], 'the loan with no debt read is not due');

      await alerts.recordNotice({ channel: 'telegram', kind: 'week', key: `${WALLET}|${SPOKE}|${CLOSE}`, walletAddress: WALLET, market: SPOKE,
        at: later(6), interestAtomic: '475', estimatedAtomic: '0' });
      assert.deepEqual(await alerts.weekDue(ask), [], 'told this week');
      assert.equal((await alerts.weekDue({ ...ask, channel: 'base_app' })).length, 1);

      await alerts.recordReading({ walletAddress: WALLET, at: later(10), block: '300', lines: [owed('1000000950')], unread: [] });
      [week] = await alerts.weekDue({ ...ask, weekCloseAt: NEXT, freshSince: later(10) });
      assert.deepEqual([week!.loan.interestAtomic, week!.since, week!.interestBeforeAtomic], ['950', later(6).toISOString(), '475']);
    });
  });

  describe(`${label}: a margin back is told once, after two calm readings, to a chat that heard the worse band`, () => {
    test('calm once could be a margin touching the line; calm twice is told, once per episode, where the band was told', async () => {
      const alerts = await make();
      await alerts.recordReading({ walletAddress: WALLET, at: AT, block: '100', lines: [aave('watch', 3_000)], unread: [] });
      await alerts.markTold({ walletAddress: WALLET, market: SPOKE, channel: 'telegram', episode: 1 });
      await alerts.recordReading({ walletAddress: WALLET, at: later(5), block: '200', lines: [aave('calm', 3_900)], unread: [] });
      let [loan] = await alerts.loansOf(WALLET);
      assert.equal(loan!.stateSince, later(5).toISOString(), 'a new band begins at the reading that read it');
      assert.deepEqual(await alerts.recoveredDue({ channel: 'telegram', freshSince: AT }), []);

      await alerts.recordReading({ walletAddress: WALLET, at: later(10), block: '300', lines: [aave('calm', 4_100)], unread: [] });
      [loan] = await alerts.loansOf(WALLET);
      assert.equal(loan!.stateSince, later(5).toISOString(), 'the same band keeps when it began');
      const [back] = await alerts.recoveredDue({ channel: 'telegram', freshSince: AT });
      assert.deepEqual([back!.state, back!.marginBps, back!.episode], ['calm', 4_100, 1]);
      assert.deepEqual(await alerts.recoveredDue({ channel: 'base_app', freshSince: AT }), [], 'that channel never told the band');
      assert.deepEqual(await alerts.recoveredDue({ channel: 'telegram', freshSince: later(11) }), [], 'only a fresh reading is told');
      await alerts.recordNotice({ channel: 'telegram', kind: 'recovered', key: `${WALLET}|${SPOKE}|1`, walletAddress: WALLET, market: SPOKE, at: later(10) });
      assert.deepEqual(await alerts.recoveredDue({ channel: 'telegram', freshSince: AT }), []);

      // A later fall is a new episode: its margin back is told once its band was.
      await alerts.recordReading({ walletAddress: WALLET, at: later(15), block: '400', lines: [aave('act', 1_500)], unread: [] });
      await alerts.recordReading({ walletAddress: WALLET, at: later(20), block: '500', lines: [aave('calm', 4_000)], unread: [] });
      await alerts.recordReading({ walletAddress: WALLET, at: later(25), block: '600', lines: [aave('calm', 4_000)], unread: [] });
      assert.deepEqual(await alerts.recoveredDue({ channel: 'telegram', freshSince: AT }), [], 'the act band of episode 2 was not told');
      await alerts.markTold({ walletAddress: WALLET, market: SPOKE, channel: 'telegram', episode: 2 });
      assert.deepEqual((await alerts.recoveredDue({ channel: 'telegram', freshSince: AT })).map((row) => row.episode), [2]);
      // A loan calm from its first reading never had a band to be back from.
      await alerts.recordReading({ walletAddress: OTHER, at: later(20), block: '500', lines: [morpho('calm', 6_000)], unread: [] });
      await alerts.recordReading({ walletAddress: OTHER, at: later(25), block: '600', lines: [morpho('calm', 6_000)], unread: [] });
      assert.deepEqual((await alerts.recoveredDue({ channel: 'telegram', freshSince: AT })).map((row) => row.walletAddress), [WALLET]);
    });
  });

  describe(`${label}: a rate jump over the rate heard of is told once per stretch`, () => {
    const rated = (rateBps: number) => ({ ...aave('calm', 5_000), debtAtomic: '1000000000', rateBps });

    test('the first rate read is the one heard of; a jump held long enough is due; telling a rate makes it the one heard of', async () => {
      const alerts = await make();
      const read = (minutes: number, block: string, line: StillLoanReadingLineV1) =>
        alerts.recordReading({ walletAddress: WALLET, at: later(minutes), block, lines: [line], unread: [] });
      await read(0, '100', rated(410));
      let [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.rateToldBps, loan!.rateToldAt, loan!.rateHighSince, loan!.rateEpisode], [410, AT.toISOString(), null, 0]);
      // Up, but less than 2 points: no jump.
      await read(5, '200', rated(600));
      [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.rateBps, loan!.rateHighSince], [600, null]);
      // A jump starts a stretch; a reading with no rate, or one still high, keeps when it began.
      await read(10, '300', rated(1_240));
      await read(15, '400', aave('calm', 5_000));
      [loan] = await alerts.loansOf(WALLET);
      // The reading with no rate keeps the rate before it, and says when that one was read (audit P3, 2026-11-18).
      assert.deepEqual([loan!.rateBps, loan!.readAt, loan!.rateReadAt], [1_240, later(15).toISOString(), later(10).toISOString()]);
      await read(20, '500', rated(1_300));
      [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.rateBps, loan!.rateToldBps, loan!.rateHighSince, loan!.rateEpisode], [1_300, 410, later(10).toISOString(), 1]);
      assert.equal(loan!.rateReadAt, later(20).toISOString());
      const ask = { channel: 'telegram' as const, freshSince: AT };
      assert.deepEqual(await alerts.rateDue({ ...ask, highSince: later(9) }), [], 'not held long enough yet');
      assert.deepEqual(await alerts.rateDue({ ...ask, freshSince: later(21), highSince: later(10) }), [], 'only a fresh reading is told');
      const [due] = await alerts.rateDue({ ...ask, highSince: later(10) });
      assert.deepEqual([due!.walletAddress, due!.rateBps, due!.rateToldBps, due!.rateEpisode], [WALLET, 1_300, 410, 1]);
      await alerts.recordNotice({ channel: 'telegram', kind: 'rate', key: `${WALLET}|${SPOKE}|1`, walletAddress: WALLET, market: SPOKE, at: later(20) });
      assert.deepEqual(await alerts.rateDue({ ...ask, highSince: later(20) }), []);
      assert.equal((await alerts.rateDue({ ...ask, channel: 'base_app', highSince: later(20) })).length, 1, 'the other channel has not told it');

      await alerts.markRateTold({ walletAddress: WALLET, market: SPOKE, rateBps: 1_300, at: later(20) });
      [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.rateToldBps, loan!.rateToldAt, loan!.rateHighSince, loan!.rateEpisode], [1_300, later(20).toISOString(), null, 1]);
      await read(25, '600', rated(1_300));
      assert.deepEqual(await alerts.rateDue({ ...ask, channel: 'base_app', highSince: later(30) }), [], 'no jump over the rate heard of now');
      // Past a jump over 13% (15% and 19.5%): a new stretch, a new episode; back under ends it.
      await read(30, '700', rated(2_000));
      [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.rateHighSince, loan!.rateEpisode], [later(30).toISOString(), 2]);
      await read(35, '800', rated(1_900));
      [loan] = await alerts.loansOf(WALLET);
      assert.deepEqual([loan!.rateHighSince, loan!.rateEpisode], [null, 2]);
    });
  });

  describe(`${label}: which weekend bands a channel told`, () => {
    test('the told subset of the keys asked, per channel and kind; nothing asked, nothing told', async () => {
      const alerts = await make();
      const key = (state: string) => `${WALLET}|${SPOKE}|2026-11-21T01:00:00.000Z|${state}`;
      assert.deepEqual(await alerts.noticesTold({ channel: 'telegram', kind: 'weekend', keys: [] }), new Set());
      await alerts.recordNotice({ channel: 'telegram', kind: 'weekend', key: key('watch'), walletAddress: WALLET, market: SPOKE, at: AT });
      assert.deepEqual(await alerts.noticesTold({ channel: 'telegram', kind: 'weekend', keys: [key('watch'), key('act'), key('liquidation')] }), new Set([key('watch')]));
      assert.deepEqual(await alerts.noticesTold({ channel: 'base_app', kind: 'weekend', keys: [key('watch')] }), new Set(), 'the other channel told nothing');
      assert.deepEqual(await alerts.noticesTold({ channel: 'telegram', kind: 'hold', keys: [key('watch')] }), new Set(), 'another kind is another notice');
      await assert.rejects(() => alerts.noticesTold({ channel: 'telegram', kind: 'gift' as never, keys: [key('watch')] }), /unknown loan notice/);
      await assert.rejects(() => alerts.noticesTold({ channel: 'telegram', kind: 'weekend', keys: ['a key with spaces'] }), /short plain text/);
    });
  });
}
