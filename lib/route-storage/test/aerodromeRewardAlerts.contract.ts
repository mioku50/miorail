import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { AerodromeRewardAlertRepositoryV1 } from '../src/aerodromeRewardAlerts.js';

// ---------------------------------------------------------------------------
// Found's alerts: one wallet, one amount, and an episode that says when the
// next build-up may be told again. The same contract runs on the in-memory
// store and on Postgres, so the fake cannot drift from the SQL.
// ---------------------------------------------------------------------------

const ME = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const YOU = '0x1111111111111111111111111111111111111111';
const AT = new Date('2026-10-11T12:00:00.000Z');
const later = (hours: number) => new Date(AT.getTime() + hours * 3_600_000);

export function aerodromeRewardAlertsContractV1(label: string, make: () => Promise<AerodromeRewardAlertRepositoryV1>): void {
  describe(`${label}: an alert is kept per wallet`, () => {
    test('a new amount starts a new episode; the same amount changes nothing', async () => {
      const alerts = await make();
      const created = await alerts.subscribe({ walletAddress: ME, thresholdUsdCents: 500, at: AT });
      assert.equal(created.outcome, 'created');
      assert.equal(created.alert.episode, 0);
      assert.equal((await alerts.subscribe({ walletAddress: ME, thresholdUsdCents: 500, at: later(1) })).outcome, 'unchanged');
      const moved = await alerts.subscribe({ walletAddress: ME, thresholdUsdCents: 2_000, at: later(2) });
      assert.equal(moved.outcome, 'moved');
      assert.deepEqual([moved.alert.thresholdUsdCents, moved.alert.episode], [2_000, 1]);
      assert.equal(moved.alert.createdAt, AT.toISOString());
      assert.equal(await alerts.unsubscribe(ME), true);
      assert.equal(await alerts.unsubscribe(ME), false);
      assert.equal(await alerts.get(ME), null);
    });

    test('the fake refuses what the table refuses', async () => {
      const alerts = await make();
      await assert.rejects(() => alerts.subscribe({ walletAddress: ME.toUpperCase().replace('0X', '0x'), thresholdUsdCents: 500, at: AT }), /lowercase 20-byte wallet/);
      await assert.rejects(() => alerts.subscribe({ walletAddress: ME, thresholdUsdCents: 99, at: AT }), /from \$1 to \$10,000/);
      await assert.rejects(() => alerts.subscribe({ walletAddress: ME, thresholdUsdCents: 1_000_001, at: AT }), /from \$1 to \$10,000/);
      await assert.rejects(() => alerts.subscribe({ walletAddress: ME, thresholdUsdCents: 500.5, at: AT }), /whole cents/);
      await alerts.subscribe({ walletAddress: ME, thresholdUsdCents: 500, at: AT });
      await assert.rejects(() => alerts.recordRead({ walletAddress: ME, at: AT, block: '1', usdCents: 5, error: 'x' }), /never both or neither/);
      await assert.rejects(() => alerts.recordRead({ walletAddress: ME, at: AT, block: null, usdCents: null, error: null }), /never both or neither/);
      await assert.rejects(() => alerts.recordRead({ walletAddress: ME, at: AT, block: null, usdCents: null, error: 'Not A Code' }), /short code/);
      await assert.rejects(() => alerts.recordRead({ walletAddress: ME, at: AT, block: '0', usdCents: 1, error: null }), /positive number/);
      await assert.rejects(() => alerts.markTold({ walletAddress: ME, channel: 'email' as never, episode: 0 }), /unknown notification channel/);
    });
  });

  describe(`${label}: what the notifier reads, and when`, () => {
    test('never read first, then the oldest reading; a failure is retried sooner', async () => {
      const alerts = await make();
      await alerts.subscribe({ walletAddress: ME, thresholdUsdCents: 500, at: AT });
      await alerts.subscribe({ walletAddress: YOU, thresholdUsdCents: 500, at: AT });
      await alerts.recordRead({ walletAddress: ME, at: AT, block: '100', usdCents: 120, error: null });
      const window = (now: Date) => ({ readBefore: new Date(now.getTime() - 6 * 3_600_000), retryBefore: new Date(now.getTime() - 1_800_000), limit: 5 });
      assert.deepEqual(await alerts.dueForRead(window(later(1))), [YOU]);
      assert.deepEqual(await alerts.dueForRead({ ...window(later(1)), limit: 0 }), []);
      // Six hours on, both are due, the one never read first.
      assert.deepEqual(await alerts.dueForRead(window(later(7))), [YOU, ME]);
      await alerts.recordRead({ walletAddress: YOU, at: later(7), block: null, usdCents: null, error: 'aerodrome_read_deadline' });
      assert.deepEqual(await alerts.dueForRead(window(later(7.25))), [ME]);
      assert.deepEqual(await alerts.dueForRead(window(later(7.6))), [ME, YOU]);
    });

    test('only a fresh, good reading at the amount or over it is reached', async () => {
      const alerts = await make();
      await alerts.subscribe({ walletAddress: ME, thresholdUsdCents: 500, at: AT });
      await alerts.subscribe({ walletAddress: YOU, thresholdUsdCents: 500, at: AT });
      await alerts.recordRead({ walletAddress: ME, at: later(1), block: '100', usdCents: 500, error: null });
      await alerts.recordRead({ walletAddress: YOU, at: later(1), block: '100', usdCents: 499, error: null });
      assert.deepEqual((await alerts.reached({ freshSince: AT })).map((alert) => alert.walletAddress), [ME]);
      assert.deepEqual(await alerts.reached({ freshSince: later(2) }), []);
      await alerts.recordRead({ walletAddress: ME, at: later(2), block: null, usdCents: null, error: 'aerodrome_incomplete_coverage' });
      assert.deepEqual(await alerts.reached({ freshSince: AT }), []);
    });
  });

  describe(`${label}: the episode: once per build-up, per channel`, () => {
    test('it moves on only after a channel told it and the rewards fell under half', async () => {
      const alerts = await make();
      await alerts.subscribe({ walletAddress: ME, thresholdUsdCents: 500, at: AT });
      // Building up from nothing: no notice yet, so a small reading moves nothing.
      await alerts.recordRead({ walletAddress: ME, at: later(1), block: '1', usdCents: 100, error: null });
      assert.equal((await alerts.get(ME))!.episode, 0);
      await alerts.recordRead({ walletAddress: ME, at: later(2), block: '2', usdCents: 650, error: null });
      await alerts.markTold({ walletAddress: ME, channel: 'telegram', episode: 0 });
      assert.deepEqual((await alerts.get(ME))!.told, { base_app: null, telegram: 0 });
      // Still over half: the same episode, told already.
      await alerts.recordRead({ walletAddress: ME, at: later(3), block: '3', usdCents: 300, error: null });
      assert.equal((await alerts.get(ME))!.episode, 0);
      // A failed reading is no evidence of a claim.
      await alerts.recordRead({ walletAddress: ME, at: later(4), block: null, usdCents: null, error: 'aerodrome_read_deadline' });
      assert.equal((await alerts.get(ME))!.episode, 0);
      // Claimed: under half the amount, so the next build-up is a new episode.
      await alerts.recordRead({ walletAddress: ME, at: later(5), block: '5', usdCents: 10, error: null });
      assert.equal((await alerts.get(ME))!.episode, 1);
      await alerts.recordRead({ walletAddress: ME, at: later(6), block: '6', usdCents: 0, error: null });
      assert.equal((await alerts.get(ME))!.episode, 1);
    });

    test('a channel marks only the episode that is current', async () => {
      const alerts = await make();
      await alerts.subscribe({ walletAddress: ME, thresholdUsdCents: 500, at: AT });
      await alerts.subscribe({ walletAddress: ME, thresholdUsdCents: 900, at: later(1) });
      await alerts.markTold({ walletAddress: ME, channel: 'base_app', episode: 0 });
      assert.deepEqual((await alerts.get(ME))!.told, { base_app: null, telegram: null });
      await alerts.markTold({ walletAddress: ME, channel: 'base_app', episode: 1 });
      assert.deepEqual((await alerts.get(ME))!.told, { base_app: 1, telegram: null });
    });
  });
}
