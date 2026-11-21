import assert from 'node:assert/strict';
import { CRYPTO } from '@mioagent/still-engine/registry';
import test, { describe } from 'node:test';

import type { MirrorReadingV1, MirrorReport, VenueLine } from '@mioagent/still-engine';
import { InMemoryStillLoanAlertRepositoryV1 } from '@mioagent/route-storage';

import { refreshStillLoanAlertsV1, STILL_LOAN_PASS_MS_V1, stillLoanHealthOfMarginV1, stillLoanLabelV1, stillLoanLinesV1, stillLoanNoticeV1, stillLoanPassWalletsV1, stillLoanRepayToWatchAtomicV1, stillLoanUnreadMorphoMarketsV1, type StillLoanReadV1 } from './stillLoanAlerts.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const QUIET = '0x2222222222222222222222222222222222222222';
const SPOKE = '0x17905db0e4a3514467539956c084180616ae7b8d';
const CBBTC_MARKET = '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836';
const WETH_MARKET = '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda';
const NOW = new Date('2026-11-02T15:00:00.000Z');
const BLOCK = '38000000';
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
      lines: [{ market: SPOKE, venue: 'aave-v4', state: 'watch', marginBps: 3_100, debtAtomic: '500000000', rateBps: null, holds: { held: [], cleared: [] } }],
      unread: [WETH_MARKET],
    });
    const owesButUnsafe = reading([venue({ debtAtomic: '1', safety: null })]) as Extract<MirrorReadingV1, { outcome: 'report' }>;
    assert.deepEqual(stillLoanLinesV1(owesButUnsafe.report), { lines: [], unread: [SPOKE] });
  });

  // Audit LL-2, 2026-11-20: a Morpho market not read, with none of its collateral left in the wallet (it is pledged), left no
  // venue in the Mirror, so the loan's row went as if repaid.
  test('a Morpho market the reading could not read is unread, not repaid', () => {
    const cbbtc = CRYPTO.find((asset) => asset.id === 'cbBTC')!;
    const morpho = new Map(CRYPTO.map((asset) => [asset.id, asset.id === 'cbBTC' ? null : ({} as never)]));
    assert.deepEqual(stillLoanUnreadMorphoMarketsV1({ snapshot: { morpho } } as never), [cbbtc.morphoMarket.toLowerCase()]);
    assert.deepEqual(stillLoanUnreadMorphoMarketsV1({ snapshot: { morpho: new Map(CRYPTO.map((asset) => [asset.id, {} as never])) } } as never), []);
    assert.deepEqual(stillLoanUnreadMorphoMarketsV1(undefined), []);
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
    assert.deepEqual(report, { due: 1, read: 1, failed: 0, notRead: 0 });
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
    assert.deepEqual([failed, thrown], [{ due: 1, read: 0, failed: 1, notRead: 0 }, { due: 1, read: 0, failed: 1, notRead: 0 }]);
    const dry = await refreshStillLoanAlertsV1({
      alerts, reachable: new Set([WALLET]), now: NOW, dry: true,
      read: async () => reading([venue({ debtAtomic: '0' })], '200'),
    });
    assert.deepEqual(dry, { due: 1, read: 1, failed: 0, notRead: 0 });
    assert.equal((await alerts.loansOf(WALLET)).length, 1, 'the loan is still there');
  });
});

describe('whom a pass reads (audit LL-3)', () => {
  const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
  test('loans that need attention first, then a window of the rest that moves on each pass, so everyone is read in turn', () => {
    const eligible = Array.from({ length: 23 }, (_, i) => wallet(i + 1));
    const attention = new Set([wallet(20), wallet(3), wallet(999)]);
    const seen = new Set<string>();
    for (let pass = 0; pass < 3; pass++) {
      const picked = stillLoanPassWalletsV1({ eligible, attention, limit: 10, pass });
      assert.equal(picked.length, 10);
      assert.deepEqual(picked.slice(0, 2), [wallet(3), wallet(20)], 'attention is read every pass');
      assert.equal(new Set(picked).size, 10);
      for (const w of picked) seen.add(w);
    }
    assert.equal(seen.size, 23, 'three passes read all 23');
    // A pass full of loans in danger still leaves a fifth of its places to the rotation.
    const allUrgent = stillLoanPassWalletsV1({ eligible, attention: new Set(eligible), limit: 10, pass: 0 });
    assert.deepEqual(allUrgent.slice(0, 8), eligible.slice(0, 8));
    assert.equal(allUrgent.length, 10);
    assert.deepEqual(stillLoanPassWalletsV1({ eligible: [], attention, limit: 10, pass: 7 }), []);
    assert.deepEqual(stillLoanPassWalletsV1({ eligible: [wallet(1)], attention: new Set(), limit: 25, pass: 12_345 }), [wallet(1)]);
  });
  test('a reachable borrower late in the alphabet is read, whatever state its borrow was left in, and the journal says who was not read', async () => {
    const alerts = new InMemoryStillLoanAlertRepositoryV1();
    // Thirty reachable borrowers late in the alphabet, and 200 unreachable ones before them, which take no place.
    const all = Array.from({ length: 30 }, (_, i) => `0xf${(i + 1).toString(16).padStart(39, '0')}`);
    for (const w of all) alerts.confirmedBorrowers.add(w);
    for (let i = 0; i < 200; i++) alerts.confirmedBorrowers.add(wallet(i + 1));
    const reachable = new Set(all.map((w) => w.toUpperCase().replace('0X', '0x')));
    const asked = new Set<string>();
    let notRead = -1;
    for (let pass = 0; pass < 3; pass++) {
      const report = await refreshStillLoanAlertsV1({ alerts, reachable, limit: 10, now: new Date(pass * STILL_LOAN_PASS_MS_V1), dry: true,
        read: async (w) => { asked.add(w); return reading([venue({ debtAtomic: '0' })]); } });
      assert.equal(report.due, 10);
      notRead = report.notRead;
    }
    assert.equal(notRead, 20);
    assert.equal(asked.size, 30);
  });
});

describe('what a chat is told (audit LL-4)', () => {
  test('each band as facts, short enough for every channel, with the way to repay', () => {
    const watch = stillLoanNoticeV1({ market: SPOKE, state: 'watch', marginBps: 3_149, readBlock: BLOCK });
    assert.equal(watch.title, 'Still loan: margin 31%');
    assert.equal(watch.message, 'Aave V4 · Coinbase Stocks: the collateral can fall 31% before liquidation. Below 37.5% Still calls it Watch. Repaying part of the loan raises the margin.');
    const act = stillLoanNoticeV1({ market: CBBTC_MARKET, state: 'act', marginBps: 1_499, readBlock: BLOCK });
    assert.equal(act.title, 'Still loan: only 14% margin');
    assert.equal(act.message, 'Morpho · cbBTC/USDC: the collateral can fall only 14% before liquidation, below Still’s 20% line. Repaying part of the loan raises the margin.');
    const gone = stillLoanNoticeV1({ market: WETH_MARKET, state: 'liquidation', marginBps: 0, readBlock: BLOCK });
    assert.match(gone.message, /^Morpho · WETH\/USDC: this loan can be liquidated now/);
    for (const notice of [watch, act, gone]) {
      assert.ok(notice.title.length <= BASE_APP_TITLE_MAX_V1, notice.title);
      assert.ok(notice.message.length <= BASE_APP_MESSAGE_MAX_V1, notice.message);
      assert.equal(notice.targetPath, '/repay');
    }
    assert.equal(stillLoanLabelV1('0x9999999999999999999999999999999999999999'), 'Your Still loan');
  });
  test('with the debt this pass read: the debt, and the USDC that brings the margin back to the Watch line', () => {
    const at = (debtAtomic: string, healthFactor: string | null, block = BLOCK): StillLoanReadV1 => ({ debtAtomic, healthFactor, block });
    // A margin of 14.99% on 500 USDC: repaying 500 × (37.5 − 14.99) / (100 − 14.99) = 132.40… brings it back.
    const act = stillLoanNoticeV1({ market: CBBTC_MARKET, state: 'act', marginBps: 1_499, readBlock: BLOCK }, at('500000000', '1176332509706318391'));
    assert.equal(act.message, 'Morpho · cbBTC/USDC: debt 500.00 USDC; the collateral can fall only 14% before liquidation, below Still’s 20% line. Repaying 132.40 USDC brings that back to 37.5%.');
    // Without the health factor, the margin stands for the lowest one that rounds to it: never a smaller amount.
    const fromMargin = stillLoanNoticeV1({ market: CBBTC_MARKET, state: 'act', marginBps: 1_499, readBlock: BLOCK }, at('500000000', null));
    assert.match(fromMargin.message, /Repaying 132\.40 USDC brings that back to 37\.5%\.$/);
    const watch = stillLoanNoticeV1({ market: SPOKE, state: 'watch', marginBps: 3_149, readBlock: BLOCK }, at('1234567891', null));
    assert.equal(watch.message, 'Aave V4 · Coinbase Stocks: debt 1,234.57 USDC; the collateral can fall 31% before liquidation. Repaying 108.31 USDC brings that back to 37.5%, Still’s Watch line.');
    // Liquidatable at a health factor of 0.90 on 500 USDC (audit ALERT-2): the debt that may stay is
    // 0.90 × 500 × 62.5% = 281.25, so 218.75 is repaid. The margin read as zero said 187.50, which leaves 25.9%.
    const gone = stillLoanNoticeV1({ market: WETH_MARKET, state: 'liquidation', marginBps: 0, readBlock: BLOCK }, at('500000000', '900000000000000000'));
    assert.equal(gone.message, 'Morpho · WETH/USDC: debt 500.00 USDC; liquidatable now: a liquidator may take collateral at a discount. Repaying at least 218.75 USDC brings the margin back to 37.5%.');
    // Liquidatable with no health factor read: the debt, and no amount, since none can be worked out.
    const unread = stillLoanNoticeV1({ market: WETH_MARKET, state: 'liquidation', marginBps: 0, readBlock: BLOCK }, at('500000000', null));
    assert.equal(unread.message, 'Morpho · WETH/USDC: this loan can be liquidated now, and a liquidator may take collateral at a discount. Repaying part of the loan raises the margin.');
    // A reading of another block than the one the band was recorded at says nothing of this notice.
    const other = stillLoanNoticeV1({ market: WETH_MARKET, state: 'liquidation', marginBps: 0, readBlock: BLOCK }, at('500000000', '900000000000000000', '38000001'));
    assert.equal(other.message, unread.message);
    // The repayment that leaves the margin at least on the line, checked against the health factor itself.
    for (const [debt, health] of [[500_000_000n, 900_000_000_000_000_000n], [500_000_000n, 1_176_332_509_706_318_391n], [1_234_567_891n, 1_459_640_000_000_000_000n],
      [7n, 1_000_100_000_000_000_000n], [10n ** 15n, 1_599_700_000_000_000_000n], [250_000_000n, 300_000_000_000_000_000n]] as const) {
      const repay = stillLoanRepayToWatchAtomicV1(debt, health)!;
      const after = (Number(health) / 1e18) * Number(debt) / Number(debt - repay);
      assert.ok(repay > 0n && repay <= debt, `${debt} ${health}`);
      assert.ok(repay === debt || 1 - 1 / after >= 0.375 - 1e-9, `${debt} ${health}: margin after ${1 - 1 / after}`);
    }
    assert.equal(stillLoanRepayToWatchAtomicV1(500_000_000n, 1_600_000_000_000_000_000n), null);
    assert.equal(stillLoanRepayToWatchAtomicV1(0n, 900_000_000_000_000_000n), null);
    assert.equal(stillLoanRepayToWatchAtomicV1(500_000_000n, 0n), 500_000_000n);
    assert.equal(stillLoanHealthOfMarginV1(0), null);
    assert.equal(stillLoanHealthOfMarginV1(3_750), 1_600_000_000_000_000_000n);
    // Even the longest label with a very large debt fits every channel; no notice commands.
    for (const state of ['watch', 'act', 'liquidation'] as const) {
      for (const debt of [null, '1', '999999999999999', '999999999990000']) {
        const notice = stillLoanNoticeV1({ market: SPOKE, state, marginBps: state === 'liquidation' ? 0 : state === 'act' ? 1_000 : 3_000, readBlock: BLOCK },
          debt === null ? null : { debtAtomic: debt, healthFactor: state === 'liquidation' ? '900000000000000000' : null, block: BLOCK });
        assert.ok(notice.title.length <= BASE_APP_TITLE_MAX_V1, notice.title);
        assert.ok(notice.message.length <= BASE_APP_MESSAGE_MAX_V1, `${notice.message.length}: ${notice.message}`);
        assert.doesNotMatch(`${notice.title} ${notice.message}`, /act now|at once|to keep it|you should|must /i);
      }
    }
  });
  test('the pass keeps each loan’s debt as it read it, for the notice', async () => {
    const alerts = new InMemoryStillLoanAlertRepositoryV1();
    alerts.confirmedBorrowers.add(WALLET);
    const debts = new Map<string, StillLoanReadV1>();
    await refreshStillLoanAlertsV1({ alerts, reachable: new Set([WALLET]), now: NOW, debts,
      read: async () => reading([venue({ debtAtomic: '500000000', safety: safety('act', 1_400) }), venue({ venue: 'morpho', market: CBBTC_MARKET, debtAtomic: null })]) });
    // The debt and the health factor, at the block they were read at (audit ALERT-2).
    assert.deepEqual([...debts], [[`${WALLET}|${SPOKE}`, { debtAtomic: '500000000', healthFactor: '1600000000000000000', block: '38000000' }]]);
  });
});

describe('the debt, rate and holds a reading carries', () => {
  const NVDA_TOKEN = '0x00000000000000000000000000000000000000a1';
  const stock = (over: Record<string, unknown>) => ({
    asset: 'NVDA', kind: 'stock', name: 'NVIDIA', symbol: 'NVDAc', token: NVDA_TOKEN, isin: null, venue: 'aave-v4',
    wallet: { raw: '0', decimals: 18 }, pledged: { raw: '10000000000000000000', decimals: 18 }, shares: null, priceCents: '18000', priceUpdatedAt: null,
    valueCents: '180000', protocolFactorBps: 7_000, stillFactorBps: 3_500, capacityCents: '0', earnings: null, limits: [], failed: [], ...over,
  });
  const withAssets = (venues: VenueLine[], assets: Record<string, unknown>[]) => {
    const read = reading(venues) as Extract<MirrorReadingV1, { outcome: 'report' }>;
    return { ...read, report: { ...read.report, assets } as unknown as MirrorReport };
  };

  test('Aave V4: the Mirror flags read for a pledged stock join what its token said; Morpho: only what its token said', () => {
    const { report } = withAssets([
      venue({ debtAtomic: '500000000', borrowRateBps: 366, safety: safety('calm', 5_000) }),
      venue({ venue: 'morpho', market: CBBTC_MARKET, debtAtomic: '20000000', borrowRateBps: 512, safety: safety('calm', 6_000) }),
    ], [
      stock({ limits: ['reserve_frozen', 'issuer_paused'] }),
      // Not pledged: nothing of it is a hold on the loan.
      stock({ symbol: 'AAPLc', asset: 'AAPL', pledged: { raw: '0', decimals: 18 }, limits: ['reserve_paused'] }),
    ]);
    const tokens = new Map([[SPOKE, { held: [], cleared: ['NVDAc:transfers_paused'] }], [CBBTC_MARKET, { held: ['cbBTC:transfers_paused'], cleared: ['cbBTC:market_frozen'] }]]);
    const { lines } = stillLoanLinesV1(report, tokens);
    assert.deepEqual(lines.map((line) => [line.market, line.debtAtomic, line.rateBps, line.holds]), [
      [SPOKE, '500000000', 366, { held: ['NVDAc:reserve_frozen', 'NVDAc:feed_paused'], cleared: ['NVDAc:reserve_paused', 'NVDAc:spoke_halted', 'NVDAc:transfers_paused'] }],
      [CBBTC_MARKET, '20000000', 512, { held: ['cbBTC:transfers_paused'], cleared: ['cbBTC:market_frozen'] }],
    ]);
    // A Morpho loan whose token was not asked carries no holds at all; it does not read as "none".
    const unasked = stillLoanLinesV1(report).lines.find((line) => line.market === CBBTC_MARKET);
    assert.equal(unasked!.holds, undefined);
  });

  test('a flag whose read failed is not read as cleared', () => {
    const { report } = withAssets([venue({ debtAtomic: '500000000', safety: safety('calm', 5_000) })],
      [stock({ failed: ['NVDA reserve status'] })]);
    const [line] = stillLoanLinesV1(report).lines;
    // The feed's flag is Coinbase's registry, which answered: it is known not held (audit P2-3, 2026-11-18).
    assert.deepEqual(line!.holds, { held: [], cleared: ['NVDAc:spoke_halted', 'NVDAc:feed_paused'] });
    const { report: registryDown } = withAssets([venue({ debtAtomic: '500000000', safety: safety('calm', 5_000) })],
      [stock({ failed: ['NVDA Coinbase registry'] })]);
    const [held] = stillLoanLinesV1(registryDown).lines;
    assert.ok(!held!.holds!.cleared.includes('NVDAc:feed_paused'), 'a registry that did not answer clears no feed pause');
  });

  test('the pass keeps the holds the tokens said, and a failed token read changes none', async () => {
    const alerts = new InMemoryStillLoanAlertRepositoryV1();
    alerts.confirmedBorrowers.add(WALLET);
    const loan = (block: string): MirrorReadingV1 =>
      reading([venue({ venue: 'morpho', market: CBBTC_MARKET, debtAtomic: '20000000', borrowRateBps: 512, safety: safety('calm', 6_000) })], block);
    let answer: () => Promise<ReadonlyMap<string, { held: string[]; cleared: string[] }>> = async () => new Map([[CBBTC_MARKET, { held: ['cbBTC:transfers_paused'], cleared: [] }]]);
    const pass = (block: string, at: Date) => refreshStillLoanAlertsV1({ alerts, reachable: new Set([WALLET]), now: at,
      read: async () => loan(block), readHolds: () => answer() });
    await pass('100', NOW);
    let [row] = await alerts.loansOf(WALLET);
    assert.deepEqual([row!.holds, row!.holdEpisode, row!.debtAtomic, row!.rateBps], [['cbBTC:transfers_paused'], 1, '20000000', 512]);
    answer = async () => { throw new Error('rpc down'); };
    await pass('200', new Date(NOW.getTime() + 300_000));
    [row] = await alerts.loansOf(WALLET);
    assert.deepEqual([row!.holds, row!.holdEpisode, row!.readBlock], [['cbBTC:transfers_paused'], 1, '200']);
  });
});
