import { TERMS, safetyFromHealthFactor } from '@mioagent/still-engine/policy';
import { ADDRESSES } from '@mioagent/still-engine/registry';
import type { StillLoanAlertV1, StillLoanClosedV1, StillLoanOpenedV1, StillLoanWeekDueV1 } from '@mioagent/route-storage';

import { stillLoanLabelV1 } from './stillLoanAlerts.js';

/** The loan row an Aave V4 borrow lands in: one USDC debt on the spoke, across every stock. */
export const STILL_AAVE_SPOKE_V1 = ADDRESSES.aaveSpoke.toLowerCase();
/** How long after it landed a borrow is still told: a wallet that connects a chat just after its loan hears of it. */
export const STILL_LOAN_OPENED_FOR_MS_V1 = 6 * 3_600_000;
/** A loan gets a week's note once Still has read it for a day: one opened that evening has its own receipt. */
export const STILL_LOAN_WEEK_AFTER_MS_V1 = 24 * 3_600_000;
/** A rate jump is told once it has held this long: a market lent out for a few minutes is refilled before anyone reads of it. */
export const STILL_LOAN_RATE_HIGH_FOR_MS_V1 = 3_600_000;

/** The loan row an execution's position is in: the spoke on Aave V4, its market on Morpho. */
export function stillLoanMarketOfV1(receipt: Pick<StillLoanOpenedV1, 'venue' | 'marketId'>): string {
  return receipt.venue === 'aave-v4' ? STILL_AAVE_SPOKE_V1 : receipt.marketId.toLowerCase();
}

// ---------------------------------------------------------------------------
// Still: what a loan's owner is told besides a worse band (2026-11-17).
//
// - A loan just opened: what was borrowed against what, the debt, the rate the
//   venue charges now and how far the collateral may fall before liquidation.
//   From the receipt's verified effect where it says it, else the review.
// - The week's note on an open loan: the debt, the interest gathered since the
//   last note (or since Still first read the loan), the rate and the margin.
// - A hold on the collateral, with what it means on this venue, as measured on
//   the contracts (./stillLoanHolds.ts).
// - A loan repaid through Still, from the receipt's verified effect: what was
//   repaid, and whether the collateral came back to the wallet. Only the
//   receipt can say that: a reading that finds nothing pledged cannot tell a
//   collateral taken back from one a liquidator took.
// - A margin back: the collateral can fall more than Still's Watch line again.
// - A rate that jumped over the one the owner last heard of, held for an hour,
//   with what a day of the debt costs at it.
//
// Every notice fits the tightest channel whole (a 30-character title, a
// 200-character message): the plainest wording that fits is chosen, never a
// cut sentence. They state facts and measured consequences, never what anyone
// should do, and never that liquidation cannot happen.
// ---------------------------------------------------------------------------

export const STILL_LOAN_NOTICE_TITLE_MAX_V1 = 30;
export const STILL_LOAN_NOTICE_MESSAGE_MAX_V1 = 200;

export interface StillLoanNoticeTextV1 {
  title: string;
  message: string;
  targetPath: string;
  /** The borrow rate the message states, when it states one: once told, the rate its owner last heard of. */
  rateBps?: number;
}

const ATOMIC_V1 = /^(0|[1-9][0-9]{0,77})$/;
const SYMBOL_V1 = /^[A-Za-z0-9]{1,16}$/;
const LOAN_PATH_V1 = '/repay';

/** The first wording that fits whole; the last one is short enough to always fit. */
function fitV1(variants: readonly string[]): string {
  return variants.find((text) => text.length <= STILL_LOAN_NOTICE_MESSAGE_MAX_V1) ?? variants[variants.length - 1]!;
}

function titleV1(text: string): string {
  return text.length <= STILL_LOAN_NOTICE_TITLE_MAX_V1 ? text : `${text.slice(0, STILL_LOAN_NOTICE_TITLE_MAX_V1 - 1).trimEnd()}…`;
}

function atomicOfV1(value: unknown): bigint | null {
  return typeof value === 'string' && ATOMIC_V1.test(value) ? BigInt(value) : null;
}

/** "1,234.57": cents rounded up, so a debt or an amount owed is never said smaller than it is. */
function usdcUpV1(atomic: bigint): string {
  const cents = (atomic + 9_999n) / 10_000n;
  return `${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** Interest, to the nearest cent; under a cent is said as such, not as a cent. */
function interestV1(atomic: bigint): string {
  if (atomic === 0n) return '0.00 USDC';
  if (atomic < 10_000n) return 'under 0.01 USDC';
  const cents = (atomic + 5_000n) / 10_000n;
  return `${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')} USDC`;
}

/** "3.66%". */
function rateV1(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/** Whole percent, rounded down: a margin is never said larger than it is. */
function marginV1(bps: number): string {
  return `${Math.floor(bps / 100)}%`;
}

/** "Nov 13", in UTC. */
function dayV1(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A token amount, rounded down: up to four decimals from one token up, four significant digits below. */
export function stillTokenAmountV1(raw: bigint, decimals: number): string {
  const digits = raw.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  const lead = fraction.search(/[1-9]/);
  const places = BigInt(whole) > 0n ? 4 : lead < 0 ? 0 : lead + 4;
  const shown = fraction.slice(0, Math.min(places, decimals)).replace(/0+$/, '');
  return `${BigInt(whole).toLocaleString('en-US')}${shown ? `.${shown}` : ''}`;
}

function recordOfV1(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A loan read within the pass, for the rate and margin it has now; anything older says nothing. */
function freshV1(loan: StillLoanAlertV1 | null | undefined, freshSince: Date): StillLoanAlertV1 | null {
  return loan && Date.parse(loan.readAt) >= freshSince.getTime() ? loan : null;
}

/** What a borrow that just landed is told as; null when its record does not say what was borrowed. */
export function stillLoanOpenedNoticeV1(input: {
  opened: StillLoanOpenedV1;
  /** This loan as the pass read it, for the rate and margin it has now. */
  loan?: StillLoanAlertV1 | null;
  freshSince: Date;
}): StillLoanNoticeTextV1 | null {
  const facts = input.opened.facts;
  const proof = input.opened.proof ?? {};
  const borrowed = atomicOfV1(proof.appliedAssets) ?? atomicOfV1(facts.requestedAssets);
  if (borrowed === null || borrowed === 0n) return null;
  const debt = atomicOfV1(proof.remainingDebtAssets) ?? atomicOfV1(facts.debtAfterAssets);
  const symbol = typeof facts.collateralSymbol === 'string' && SYMBOL_V1.test(facts.collateralSymbol) ? facts.collateralSymbol : null;
  const decimals = typeof facts.collateralDecimals === 'number' && Number.isInteger(facts.collateralDecimals)
    && facts.collateralDecimals >= 0 && facts.collateralDecimals <= 36 ? facts.collateralDecimals : null;
  const supplied = atomicOfV1(facts.collateralSupplyAssets);
  const payment = recordOfV1(proof.payment) ?? recordOfV1(facts.payment);
  const paid = payment ? atomicOfV1(payment.assets) : null;
  const venue = input.opened.venue === 'aave-v4' ? 'Aave V4' : 'Morpho';

  const against = symbol === null ? ''
    : supplied !== null && supplied > 0n && decimals !== null ? ` against ${stillTokenAmountV1(supplied, decimals)} ${symbol}` : ` against your ${symbol}`;
  const order = payment?.merchant === 'bitrefill' ? 'your Bitrefill order' : 'your order';
  const head = `Borrowed ${usdcUpV1(borrowed)} USDC on ${venue}${against}${paid !== null && paid > 0n ? ` and paid ${usdcUpV1(paid)} USDC for ${order}` : ''}.`;

  const loan = freshV1(input.loan, input.freshSince);
  const rate = loan?.rateBps != null ? `, at ${rateV1(loan.rateBps)} a year now` : '';
  const owes = debt === null ? '' : ` Debt ${usdcUpV1(debt)} USDC${rate}.`;

  // The margin the review measured, with the price it named for one collateral; else as read now, else the
  // health the review expected after the borrow.
  const stress = recordOfV1(facts.stress);
  const tenths = typeof stress?.marginTenths === 'number' && Number.isInteger(stress.marginTenths)
    && stress.marginTenths >= 0 && stress.marginTenths <= 1_000 ? stress.marginTenths : null;
  const priceCents = atomicOfV1(stress?.liquidationPriceCents);
  const health = atomicOfV1(facts.healthAfterWad);
  const marginBps = tenths !== null ? tenths * 10 : loan ? loan.marginBps
    : health !== null && health > 0n ? Number(safetyFromHealthFactor(health).marginBps) : null;
  const price = tenths !== null && priceCents !== null && symbol !== null ? `: ${symbol} at $${usdcCentsOfV1(priceCents)}` : '';
  const fall = (withPrice: boolean) => marginBps === null ? ''
    : ` The collateral can fall ${marginV1(marginBps)} before liquidation${withPrice ? price : ''}.`;

  const message = fitV1([
    `${head}${owes}${fall(true)}`,
    `${head}${owes}${fall(false)}`,
    `${head}${debt === null ? '' : ` Debt ${usdcUpV1(debt)} USDC.`}${fall(false)}`,
    `${head}${debt === null ? '' : ` Debt ${usdcUpV1(debt)} USDC.`}`,
    `Borrowed ${usdcUpV1(borrowed)} USDC on ${venue}.`,
  ]);
  return {
    title: titleV1('Still loan opened'),
    message,
    targetPath: LOAN_PATH_V1,
    ...(rate !== '' && loan?.rateBps != null && message.includes(rate) ? { rateBps: loan.rateBps } : {}),
  };
}

/** "1,946.64" from cents. */
function usdcCentsOfV1(cents: bigint): string {
  return `${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** The week's note on an open loan; null when its debt was never read. */
export function stillLoanWeekNoticeV1(due: StillLoanWeekDueV1): StillLoanNoticeTextV1 | null {
  const { loan } = due;
  const debt = atomicOfV1(loan.debtAtomic);
  const total = atomicOfV1(loan.interestAtomic);
  const before = atomicOfV1(due.interestBeforeAtomic) ?? 0n;
  const estimatedTotal = atomicOfV1(loan.estimatedAtomic) ?? 0n;
  const estimatedBefore = atomicOfV1(due.estimatedBeforeAtomic) ?? 0n;
  if (debt === null || debt === 0n || total === null) return null;
  const interest = total > before ? total - before : 0n;
  const estimated = estimatedTotal > estimatedBefore ? estimatedTotal - estimatedBefore : 0n;
  const about = estimated > 0n && interest >= 10_000n ? 'about ' : '';
  const label = stillLoanLabelV1(loan.market);
  const owes = `${label}: debt ${usdcUpV1(debt)} USDC.`;
  const gathered = ` Interest since ${dayV1(due.since)}: ${about}${interestV1(interest)}`;
  const rate = loan.rateBps !== null ? `, at ${rateV1(loan.rateBps)} a year now` : '';
  const fall = ` The collateral can fall ${marginV1(loan.marginBps)} before liquidation.`;
  const message = fitV1([`${owes}${gathered}${rate}.${fall}`, `${owes}${gathered}.${fall}`, `${owes}${gathered}.`]);
  return {
    title: titleV1('Still loan: your week'),
    message,
    targetPath: LOAN_PATH_V1,
    ...(rate !== '' && loan.rateBps !== null && message.includes(rate) ? { rateBps: loan.rateBps } : {}),
  };
}

/** "41.2%": a margin to the tenth, rounded down, so it is never said larger than it is. */
function marginTenthsV1(bps: number): string {
  return bps % 100 === 0 ? `${bps / 100}%` : `${Math.floor(bps / 10) / 10}%`;
}

/** What a repayment through Still that left no debt is told as: what was repaid, and whether the collateral came
 * back to the wallet; null when its receipt does not say the debt is gone, or says nothing moved. */
export function stillLoanClosedNoticeV1(closed: StillLoanClosedV1): StillLoanNoticeTextV1 | null {
  const facts = closed.facts;
  const proof = closed.proof ?? {};
  if (atomicOfV1(proof.remainingDebtAssets) !== 0n) return null;
  const repaid = atomicOfV1(proof.appliedAssets) ?? 0n;
  const back = atomicOfV1(proof.collateralReturnedAssets);
  const left = atomicOfV1(proof.collateralAssets);
  const symbol = typeof facts.collateralSymbol === 'string' && SYMBOL_V1.test(facts.collateralSymbol) ? facts.collateralSymbol : null;
  const decimals = typeof facts.collateralDecimals === 'number' && Number.isInteger(facts.collateralDecimals)
    && facts.collateralDecimals >= 0 && facts.collateralDecimals <= 36 ? facts.collateralDecimals : null;
  const tokens = (raw: bigint) => symbol === null ? null : decimals === null ? `your ${symbol}` : `${stillTokenAmountV1(raw, decimals)} ${symbol}`;
  const venue = closed.venue === 'aave-v4' ? 'Aave V4' : 'Morpho';
  const paid = repaid > 0n ? `Repaid ${usdcUpV1(repaid)} USDC on ${venue}` : null;
  // The receipt matched the collateral arriving in the wallet: only then is it said to be back.
  if (back !== null && back > 0n) {
    const what = tokens(back) ?? 'the collateral';
    const message = paid
      ? `${paid}: no debt is left there, and ${what} came back to your wallet.`
      : `${what.charAt(0).toUpperCase()}${what.slice(1)} came back to your wallet from ${venue}, where no debt is left.`;
    return { title: titleV1('Still loan closed'), message: fitV1([message]), targetPath: LOAN_PATH_V1 };
  }
  if (!paid) return null;
  const stays = left !== null && left > 0n ? tokens(left) : null;
  return {
    title: titleV1('Still loan repaid'),
    message: fitV1([
      ...(stays ? [`${paid}, and no debt is left there. ${stays} stays pledged; Still’s Repay page can take it back.`] : []),
      `${paid}, and no debt is left there.`,
    ]),
    targetPath: LOAN_PATH_V1,
  };
}

/** What a loan whose worse band was told is told once it reads calm again. */
export function stillLoanRecoveredNoticeV1(loan: StillLoanAlertV1): StillLoanNoticeTextV1 {
  const label = stillLoanLabelV1(loan.market);
  const debt = atomicOfV1(loan.debtAtomic);
  const fall = `the collateral can fall ${marginTenthsV1(loan.marginBps)} before liquidation now, no longer under Still’s `
    + `${marginTenthsV1(Number(TERMS.watchBelowBps))} Watch line.`;
  return {
    title: titleV1('Still loan: margin back'),
    message: fitV1([
      ...(debt !== null && debt > 0n ? [`${label}: debt ${usdcUpV1(debt)} USDC, and ${fall}`] : []),
      `${label}: ${fall}`,
    ]),
    targetPath: LOAN_PATH_V1,
  };
}

/** What a rate that has held a jump over the one its owner heard of is told as, with what a day of the debt
 * costs at it; null without a rate, a rate heard of, or a debt. */
export function stillLoanRateNoticeV1(loan: StillLoanAlertV1): StillLoanNoticeTextV1 | null {
  const debt = atomicOfV1(loan.debtAtomic);
  if (loan.rateBps === null || loan.rateToldBps === null || loan.rateToldAt === null || debt === null || debt === 0n) return null;
  const label = stillLoanLabelV1(loan.market);
  const now = rateV1(loan.rateBps);
  const head = `${label}: the rate is ${now} a year now, up from ${rateV1(loan.rateToldBps)} on ${dayV1(loan.rateToldAt)}, `
    + 'and has been up for over an hour.';
  const daily = (debt * BigInt(loan.rateBps)) / (10_000n * 365n);
  const grows = daily < 10_000n ? 'under 0.01 USDC' : `about ${interestV1(daily)}`;
  return {
    title: titleV1(`Still loan: rate ${now}`),
    message: fitV1([
      `${head} At this rate the debt of ${usdcUpV1(debt)} USDC grows by ${grows} a day.`,
      `${head} At this rate the debt grows by ${grows} a day.`,
      head,
    ]),
    targetPath: LOAN_PATH_V1,
    rateBps: loan.rateBps,
  };
}

/** The holds, the one that matters most first. */
const HOLD_ORDER_V1 = ['transfers_paused', 'market_frozen', 'wallet_frozen', 'feed_paused', 'reserve_paused', 'spoke_halted', 'reserve_frozen'] as const;
type HoldKindV1 = (typeof HOLD_ORDER_V1)[number];

function holdWordsV1(venue: StillLoanAlertV1['venue'], s: string, kind: HoldKindV1): { title: string; message: string } | null {
  if (venue === 'aave-v4') {
    switch (kind) {
      case 'transfers_paused':
        return { title: `Still loan: ${s} paused`, message: `${s} transfers are paused by its issuer. On Aave V4, repaying USDC works, taking ${s} back waits until transfers resume, and a liquidation can still happen.` };
      case 'feed_paused':
        return { title: `Still loan: ${s} feed paused`, message: `Coinbase’s registry marks ${s} paused, which holds its price feed still. Still opens no new loan against ${s} meanwhile, and when the feed resumes the price can move at once.` };
      case 'reserve_paused':
        return { title: `Still loan: Aave paused ${s}`, message: `Aave V4 paused its ${s} reserve. Still opens no new loan against ${s} while the pause lasts, and keeps checking this loan’s margin.` };
      case 'spoke_halted':
        return { title: `Still loan: ${s} halted`, message: `Aave V4 halted ${s} on the spoke Still uses, so Still opens no new loan against ${s} while it lasts. Still keeps checking this loan’s margin.` };
      case 'reserve_frozen':
        return { title: `Still loan: Aave froze ${s}`, message: `Aave V4 froze its ${s} reserve: no new ${s} can be pledged and nothing new borrowed against it. Still keeps checking this loan’s margin.` };
      default:
        return null;
    }
  }
  switch (kind) {
    case 'transfers_paused':
      return { title: `Still loan: ${s} paused`, message: `${s} transfers are paused by its issuer. On Morpho, repaying USDC works, while taking ${s} back and any liquidation wait until transfers resume.` };
    case 'market_frozen':
      return { title: `Still loan: ${s} frozen`, message: `${s}’s issuer froze the ${s} held by Morpho Blue. Repaying USDC works, while taking ${s} back and any liquidation wait until the freeze is lifted.` };
    case 'wallet_frozen':
      return { title: `Still loan: ${s} frozen`, message: `${s}’s issuer froze this wallet’s ${s}. Repaying USDC works, but taking ${s} back does not, and a liquidation can still pay a liquidator.` };
    default:
      return null;
  }
}

/** What a loan's newest hold is told as: the one that matters most; null when none is one this venue has words for. */
export function stillLoanHoldNoticeV1(loan: StillLoanAlertV1): StillLoanNoticeTextV1 | null {
  const holds = loan.holds
    .map((hold) => {
      const [symbol, kind] = hold.split(':');
      return { symbol: symbol ?? '', kind: kind as HoldKindV1 };
    })
    .filter((hold) => SYMBOL_V1.test(hold.symbol) && (HOLD_ORDER_V1 as readonly string[]).includes(hold.kind))
    .sort((a, b) => HOLD_ORDER_V1.indexOf(a.kind) - HOLD_ORDER_V1.indexOf(b.kind));
  for (const hold of holds) {
    const words = holdWordsV1(loan.venue, hold.symbol, hold.kind);
    if (words) return { title: titleV1(words.title), message: fitV1([words.message]), targetPath: LOAN_PATH_V1 };
  }
  return null;
}
