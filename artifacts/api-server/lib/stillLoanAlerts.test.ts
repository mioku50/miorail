import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { MirrorReadingV1, MirrorReport, VenueLine } from '@mioagent/still-engine';
import { InMemoryStillLoanAlertRepositoryV1 } from '@mioagent/route-storage';

import { refreshStillLoanAlertsV1, stillLoanLabelV1, stillLoanLinesV1, stillLoanNoticeV1 } from './stillLoanAlerts.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const QUIET = '0x2222222222222222222222222222222222222222';
const SPOKE = '0x17905db0e4a3514467539956c084180616ae7b8d';
const CBBTC_MARKET = '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836';
const WETH_MARKET = '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda';
const NOW = new Date('2026-11-02T15:00:00.000Z');
/** The tightest channel's limits: the Base App's (scripts/baseAppNotify.ts). */
const BASE_APP_TITLE_MAX_V1 = 30;
const BASE_APP_MESSAGE_MAX_V1 = 200;

function venue(over: Partial<VenueLine>): VenueLine {
  return {
    venue: 'aave-v4', market: '0x17905Db0e4A3514467539956c084180616AE7B8D', label: 'Aave V4 · Coinbase Stocks',
    debtCents: '0', debtAtomic: '0', capacityCents: '0', availableCents: '0', borrowRateBps: null, liquidityCents: null,
    deductions: { loansCents: null, venueLimitCents: null }, safety: null, liquidationPrices: [], failed: [],
    ...over,
  };
}

function reading(venues: VenueLine[], block = '38000000'): MirrorReadingV1 {
  const report = { kind: 'still.mirror', version: 1, reading: { block, blockTime: NOW.toISOString(), assembledAt: NOW.toISOString(), provider: 'mainnet.base.org' }, venues } as unknown as MirrorReport;
  return { outcome: 'report', report, input: {} as never, cached: false };
}

const safety = (state: 'calm' | 'watch' | 'act' | 'liquidation', marginBps: number) => ({ marginBps, state, healthFactor: '1600000000000000000', source: 'protocol' as const });

describe('what a reading found', () => {
  test('a loan with a computed safety is a line; no debt is no loan; an unread debt or safety is unread, not repaid', () => {
    const { report } = reading([
      venue({ debtAtomic: '500000000', safety: safety('watch', 3_100) }),
      venue({ venue: 'morpho', market: CBBTC_MARKET, debtAtomic: '0' }),
      venue({ venue: 'morpho', market: WETH_MARKET, debtAtomic: null }),
    ]) as Extract<MirrorReadingV1, { outcome: 'report' }>;
    assert.deepEqual(stillLoanLinesV1(report), {
      lines: [{ market: SPOKE, venue: 'aave-v4', state: 'watch', marginBps: 3_100 }],
      unread: [WETH_MARKET],
    });
    const owesButUnsafe = reading([venue({ debtAtomic: '1', safety: null })]) as Extract<MirrorReadingV1, { outcome: 'report' }>;
    assert.deepEqual(stillLoanLinesV1(owesButUnsafe.report), { lines: [], unread: [SPOKE] });
  });
});

describe('the reading pass', () => {
  test('reads only Still borrowers some channel reaches, and keeps what it read', async () => {
    const alerts = new InMemoryStillLoanAlertRepositoryV1();
    alerts.confirmedBorrowers.add(WALLET);
    alerts.confirmedBorrowers.add(QUIET);
    const asked: string[] = [];
    const report = await refreshStillLoanAlertsV1({
      alerts,
      reachable: new Set([WALLET, '0x3333333333333333333333333333333333333333']),
      read: async (wallet) => {
        asked.push(wallet);
        return reading([venue({ debtAtomic: '500000000', safety: safety('act', 1_400) })]);
      },
      now: NOW,
    });
    assert.deepEqual(report, { due: 1, read: 1, failed: 0 });
    assert.deepEqual(asked, [WALLET], 'a wallet nobody can tell is not read');
    const [loan] = await alerts.loansOf(WALLET);
    assert.deepEqual([loan!.state, loan!.marginBps, loan!.episode, loan!.readBlock], ['act', 1_400, 1, '38000000']);
  });

  test('a failed read and a dry pass keep nothing', async () => {
    const alerts = new InMemoryStillLoanAlertRepositoryV1();
    alerts.confirmedBorrowers.add(WALLET);
    await alerts.recordReading({ walletAddress: WALLET, at: NOW, block: '100', lines: [{ market: SPOKE, venue: 'aave-v4', state: 'watch', marginBps: 3_000 }], unread: [] });
    const failed = await refreshStillLoanAlertsV1({
      alerts, reachable: new Set([WALLET]), now: NOW,
      read: async () => ({ outcome: 'chain_unavailable', attempts: [] }),
    });
    const thrown = await refreshStillLoanAlertsV1({
      alerts, reachable: new Set([WALLET]), now: NOW,
      read: async () => { throw new Error('rpc down'); },
    });
    assert.deepEqual([failed, thrown], [{ due: 1, read: 0, failed: 1 }, { due: 1, read: 0, failed: 1 }]);
    const dry = await refreshStillLoanAlertsV1({
      alerts, reachable: new Set([WALLET]), now: NOW, dry: true,
      read: async () => reading([venue({ debtAtomic: '0' })], '200'),
    });
    assert.deepEqual(dry, { due: 1, read: 1, failed: 0 });
    assert.equal((await alerts.loansOf(WALLET)).length, 1, 'the loan is still there');
  });
});

describe('what a chat is told', () => {
  test('each band in the reader’s words, short enough for every channel, with the way to repay', () => {
    const watch = stillLoanNoticeV1({ market: SPOKE, state: 'watch', marginBps: 3_149 });
    assert.equal(watch.title, 'Still loan: margin 31%');
    assert.equal(watch.message, 'Aave V4 · Coinbase Stocks: your collateral can now fall 31% before liquidation. Below 37.5% Still calls it Watch. Repaying part of the loan raises the margin.');
    const act = stillLoanNoticeV1({ market: CBBTC_MARKET, state: 'act', marginBps: 1_499 });
    assert.equal(act.title, 'Still loan: act now, 14% left');
    assert.match(act.message, /^Morpho · cbBTC\/USDC: your collateral can now fall only 14% before liquidation\. Below 20%, act now/);
    const gone = stillLoanNoticeV1({ market: WETH_MARKET, state: 'liquidation', marginBps: 0 });
    assert.match(gone.message, /^Morpho · WETH\/USDC: this loan can be liquidated now/);
    for (const notice of [watch, act, gone]) {
      assert.ok(notice.title.length <= BASE_APP_TITLE_MAX_V1, notice.title);
      assert.ok(notice.message.length <= BASE_APP_MESSAGE_MAX_V1, notice.message);
      assert.equal(notice.targetPath, '/repay');
    }
    assert.equal(stillLoanLabelV1('0x9999999999999999999999999999999999999999'), 'Your Still loan');
  });
});
