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
    });
  });
}
