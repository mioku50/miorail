import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { StillLoanAlertV1, StillLoanOpenedV1 } from '@mioagent/route-storage';

import {
  STILL_AAVE_SPOKE_V1,
  STILL_LOAN_NOTICE_MESSAGE_MAX_V1,
  STILL_LOAN_NOTICE_TITLE_MAX_V1,
  stillLoanHoldNoticeV1,
  stillLoanOpenedNoticeV1,
  stillLoanWeekNoticeV1,
  stillTokenAmountV1,
  type StillLoanNoticeTextV1,
} from './stillLoanNotices.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const PAXG_MARKET = '0x48dca3ed245fb30931013a676d3451f7602b11150f92743ad93159628cbbe392';
const NOW = new Date('2026-11-17T10:05:00.000Z');
const FRESH = new Date(NOW.getTime() - 30 * 60_000);

function loan(over: Partial<StillLoanAlertV1> = {}): StillLoanAlertV1 {
  return {
    walletAddress: WALLET, market: STILL_AAVE_SPOKE_V1, venue: 'aave-v4', state: 'calm', marginBps: 4_812, episode: 0,
    createdAt: '2026-11-10T09:00:00.000Z', readAt: NOW.toISOString(), readBlock: '58000000', told: { base_app: null, telegram: null },
    debtAtomic: '26410000', rateBps: 366, interestAtomic: '0', estimatedAtomic: '0', holds: [], holdEpisode: 0, ...over,
  };
}

/** The rules every Still notice keeps: it fits whole, and it states facts, never orders or promises. */
function keepsTheRulesV1(notice: StillLoanNoticeTextV1 | null): StillLoanNoticeTextV1 {
  assert.ok(notice, 'a notice');
  assert.ok(notice.title.length <= STILL_LOAN_NOTICE_TITLE_MAX_V1, `title fits: ${notice.title}`);
  assert.ok(notice.message.length <= STILL_LOAN_NOTICE_MESSAGE_MAX_V1, `message fits (${notice.message.length}): ${notice.message}`);
  assert.doesNotMatch(notice.message, /…$/, 'never cut');
  assert.doesNotMatch(`${notice.title} ${notice.message}`, /\bshould\b|\bmust\b|guarantee|risk-free|no liquidation|cannot be liquidated|\bsafe\b/i);
  assert.equal(notice.targetPath, '/repay');
  return notice;
}

describe('a loan just opened', () => {
  const paxg: StillLoanOpenedV1 = {
    executionId: '00000000-0000-4000-8000-000000000001', walletAddress: WALLET, venue: 'morpho', marketId: PAXG_MARKET,
    confirmedAt: NOW.toISOString(),
    facts: {
      venue: 'morpho', operation: 'borrow', requestedAssets: '46800000', collateralSymbol: 'PAXG', collateralDecimals: 18,
      collateralSupplyAssets: '31222722452866554', debtAfterAssets: '46800001', healthAfterWad: '2000177948714146394',
      stress: { marginTenths: 500, liquidationPriceCents: '194664', priceCents: '389361' },
    },
    proof: { operation: 'borrow', venue: 'morpho', appliedAssets: '46800000', remainingDebtAssets: '46800001' },
  };

  test('what was borrowed against what, the debt, the rate now and the margin the review measured, with its price', () => {
    const notice = keepsTheRulesV1(stillLoanOpenedNoticeV1({ opened: paxg, loan: loan({ market: PAXG_MARKET, venue: 'morpho', rateBps: 410 }), freshSince: FRESH }));
    assert.equal(notice.title, 'Still loan opened');
    assert.equal(notice.message, 'Borrowed 46.80 USDC on Morpho against 0.03122 PAXG. Debt 46.81 USDC, at 4.10% a year now. '
      + 'The collateral can fall 50% before liquidation: PAXG at $1,946.64.');
  });

  test('a stale reading gives no rate; with no stress the margin is the health the review expected', () => {
    const { stress: _stress, ...facts } = paxg.facts;
    const notice = keepsTheRulesV1(stillLoanOpenedNoticeV1({ opened: { ...paxg, facts }, loan: loan({ readAt: '2026-11-17T08:00:00.000Z' }), freshSince: FRESH }));
    assert.equal(notice.message, 'Borrowed 46.80 USDC on Morpho against 0.03122 PAXG. Debt 46.81 USDC. The collateral can fall 50% before liquidation.');
  });

  test('a purchase paid by the loan says so, and the plainer wording is chosen when the full one would not fit', () => {
    const spend: StillLoanOpenedV1 = {
      executionId: '00000000-0000-4000-8000-000000000002', walletAddress: WALLET, venue: 'aave-v4', marketId: 'aave-v4:NVDA', confirmedAt: NOW.toISOString(),
      facts: { requestedAssets: '26410000', collateralSymbol: 'NVDAc', collateralDecimals: 18, collateralSupplyAssets: '0', debtAfterAssets: '26410000',
        payment: { merchant: 'bitrefill', orderId: 'x', payTo: '0x0000000000000000000000000000000000000001', assets: '26410000' } },
      proof: { appliedAssets: '26410000', remainingDebtAssets: '1026410000',
        payment: { merchant: 'bitrefill', orderId: 'x', payTo: '0x0000000000000000000000000000000000000001', assets: '26410000' } },
    };
    const notice = keepsTheRulesV1(stillLoanOpenedNoticeV1({ opened: spend, loan: loan(), freshSince: FRESH }));
    assert.match(notice.message, /^Borrowed 26\.41 USDC on Aave V4 against your NVDAc and paid 26\.41 USDC for your Bitrefill order\. Debt 1,026\.41 USDC/);
    assert.match(notice.message, /The collateral can fall 48% before liquidation\.$/);
  });

  test('nothing is told for a record that does not say what was borrowed', () => {
    assert.equal(stillLoanOpenedNoticeV1({ opened: { ...paxg, facts: {}, proof: null }, loan: null, freshSince: FRESH }), null);
    assert.equal(stillLoanOpenedNoticeV1({ opened: { ...paxg, facts: { requestedAssets: '0' }, proof: {} }, loan: null, freshSince: FRESH }), null);
  });

  test('token amounts are rounded down: four decimals from one up, four significant digits below', () => {
    assert.equal(stillTokenAmountV1(31_222_722_452_866_554n, 18), '0.03122');
    assert.equal(stillTokenAmountV1(10n * 10n ** 18n, 18), '10');
    assert.equal(stillTokenAmountV1(1_234_567_891n, 8), '12.3456');
    assert.equal(stillTokenAmountV1(5n, 8), '0.00000005');
    assert.equal(stillTokenAmountV1(0n, 18), '0');
  });
});

describe('the week\'s note', () => {
  const week = (over: Partial<StillLoanAlertV1>, before = { interestBeforeAtomic: '0', estimatedBeforeAtomic: '0' }) => ({
    loan: loan(over), since: '2026-11-13T21:00:00.000Z', ...before,
  });

  test('the debt, the interest since the last note, the rate now and the margin', () => {
    const notice = keepsTheRulesV1(stillLoanWeekNoticeV1(week({ debtAtomic: '1000673000', interestAtomic: '1673000' }, { interestBeforeAtomic: '1000000', estimatedBeforeAtomic: '0' })));
    assert.equal(notice.title, 'Still loan: your week');
    assert.equal(notice.message, 'Aave V4 · Coinbase Stocks: debt 1,000.68 USDC. Interest since Nov 13: 0.67 USDC, at 3.66% a year now. '
      + 'The collateral can fall 48% before liquidation.');
  });

  test('"about" when part of it was estimated across a borrow; under a cent is said as such', () => {
    assert.match(keepsTheRulesV1(stillLoanWeekNoticeV1(week({ interestAtomic: '673000', estimatedAtomic: '1000' }))).message, /Interest since Nov 13: about 0\.67 USDC/);
    assert.match(keepsTheRulesV1(stillLoanWeekNoticeV1(week({ interestAtomic: '4000', estimatedAtomic: '4000' }))).message, /Interest since Nov 13: under 0\.01 USDC/);
    assert.match(keepsTheRulesV1(stillLoanWeekNoticeV1(week({ interestAtomic: '0', rateBps: null }))).message, /Interest since Nov 13: 0\.00 USDC\. The collateral/);
  });

  test('nothing is told for a loan whose debt was never read, or that owes nothing', () => {
    assert.equal(stillLoanWeekNoticeV1(week({ debtAtomic: null })), null);
    assert.equal(stillLoanWeekNoticeV1(week({ debtAtomic: '0' })), null);
  });
});

describe('a hold on the collateral', () => {
  test('what each hold means on its venue, as measured on the contracts', () => {
    const aave = (hold: string) => keepsTheRulesV1(stillLoanHoldNoticeV1(loan({ holds: [hold], holdEpisode: 1 })));
    const morpho = (hold: string) => keepsTheRulesV1(stillLoanHoldNoticeV1(loan({ venue: 'morpho', market: PAXG_MARKET, holds: [hold], holdEpisode: 1 })));
    // Aave V4 moves supplied shares in a liquidation, so a B20 transfer pause does not stop one.
    assert.match(aave('GOOGLc:transfers_paused').message, /repaying USDC works, taking GOOGLc back waits until transfers resume, and a liquidation can still happen/);
    // Morpho hands the collateral itself to a liquidator, so a pause holds both.
    assert.match(morpho('PAXG:transfers_paused').message, /repaying USDC works, while taking PAXG back and any liquidation wait until transfers resume/);
    assert.match(morpho('PAXG:market_frozen').message, /froze the PAXG held by Morpho Blue/);
    assert.match(morpho('PAXG:wallet_frozen').message, /taking PAXG back does not, and a liquidation can still pay a liquidator/);
    assert.match(aave('GOOGLc:feed_paused').message, /holds its price feed still/);
    assert.match(aave('GOOGLc:reserve_paused').message, /^Aave V4 paused its GOOGLc reserve/);
    assert.match(aave('GOOGLc:reserve_frozen').message, /^Aave V4 froze its GOOGLc reserve/);
    assert.match(aave('GOOGLc:spoke_halted').message, /^Aave V4 halted GOOGLc on the spoke Still uses/);
  });

  test('with several, the one that matters most; a kind with no words on this venue is skipped', () => {
    const notice = keepsTheRulesV1(stillLoanHoldNoticeV1(loan({ holds: ['NVDAc:reserve_frozen', 'NVDAc:transfers_paused'], holdEpisode: 2 })));
    assert.equal(notice.title, 'Still loan: NVDAc paused');
    assert.equal(stillLoanHoldNoticeV1(loan({ holds: ['NVDAc:market_frozen'] })), null, 'Aave V4 has no market freeze');
    assert.equal(stillLoanHoldNoticeV1(loan({ holds: [] })), null);
  });
});
