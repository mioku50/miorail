import type { MirrorReadingV1, MirrorReport } from '@mioagent/still-engine';
import { TERMS } from '@mioagent/still-engine/policy';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';
import type {
  StillLoanAlertRepositoryV1,
  StillLoanAlertV1,
  StillLoanHoldReadingV1,
  StillLoanReadingLineV1,
} from '@mioagent/route-storage';

import { stillLoanMirrorHoldsV1 } from './stillLoanHolds.js';

// ---------------------------------------------------------------------------
// Still: a loan's margin, told before it is too late.
//
// The reading half. Every notifier pass reads, with the Mirror engine, the
// wallets that borrowed through Still and can hear in some channel, and keeps
// each loan's band by Still's terms: watch below a 37.5% margin, act below
// 20%, liquidation at none. The store moves an episode when a band gets worse;
// the notifier tells each episode once per channel.
//
// A report that could not be read changes nothing, and neither does a loan
// whose debt or safety it could not compute: an unread loan is not a safe
// one, and not a repaid one either.
// ---------------------------------------------------------------------------

const ATOMIC_V1 = /^[0-9]{1,78}$/;
const WAD_V1 = 10n ** 18n;
const BPS_V1 = 10_000n;

/** What one pass read of a loan, at one block: the debt and the health factor its notice works from (audit ALERT-2). */
export interface StillLoanReadV1 {
  debtAtomic: string;
  /** WAD; null when the reading computed no safety. */
  healthFactor: string | null;
  block: string;
}

/** One Mirror reading per wallet per pass; the pass runs every five minutes. */
export const STILL_LOAN_READS_PER_PASS_V1 = 25;
/** How often the pass runs, which turns the rotation by one window. */
export const STILL_LOAN_PASS_MS_V1 = 5 * 60_000;
/** The most borrowers one pass looks at to choose whom it reads. */
export const STILL_LOAN_BORROWERS_SEEN_V1 = 5_000;
/** A band read longer ago than this is not told: the next pass reads again. */
export const STILL_LOAN_FRESH_FOR_MS_V1 = 30 * 60_000;

/** The loans a report found, and the markets whose loan it could not read. */
export function stillLoanLinesV1(
  report: MirrorReport,
  /** What the collateral tokens said, by loan market (./stillLoanHolds.ts); absent when they were not asked. */
  tokenHolds?: ReadonlyMap<string, StillLoanHoldReadingV1>,
): { lines: StillLoanReadingLineV1[]; unread: string[] } {
  const lines: StillLoanReadingLineV1[] = [];
  const unread: string[] = [];
  for (const venue of report.venues) {
    const market = venue.market.toLowerCase();
    const debt = venue.debtAtomic ?? null;
    if (debt === null) {
      unread.push(market);
      continue;
    }
    if (BigInt(debt) === 0n) continue;
    if (!venue.safety) {
      unread.push(market);
      continue;
    }
    const tokens = tokenHolds?.get(market);
    const mirror = venue.venue === 'aave-v4' ? stillLoanMirrorHoldsV1(report) : null;
    const holds = mirror || tokens
      ? { held: [...(mirror?.held ?? []), ...(tokens?.held ?? [])], cleared: [...(mirror?.cleared ?? []), ...(tokens?.cleared ?? [])] }
      : undefined;
    lines.push({
      market, venue: venue.venue, state: venue.safety.state, marginBps: venue.safety.marginBps,
      debtAtomic: debt,
      rateBps: Number.isInteger(venue.borrowRateBps) && venue.borrowRateBps! >= 0 && venue.borrowRateBps! <= 1_000_000 ? venue.borrowRateBps : null,
      ...(holds ? { holds } : {}),
    });
  }
  return { lines, unread };
}

// ---------------------------------------------------------------------------
// Whom a pass reads (audit LL-3, 2026-11-14). Every pass read the same first 25
// reachable wallets, out of the first 200 borrowers by address, and only those
// with a confirmed borrow: past 25, a wallet late in the alphabet was never
// read, and a loan that landed while its record stayed sent or unknown was not
// read at all. Now reachability is filtered in the query, every borrow that
// went to the wallet counts, the wallets whose last reading was not calm are
// read first in every pass, and the rest take turns, one window further each
// pass, so every reachable borrower is read within a few passes. How many were
// not read this pass is said in the journal.
// ---------------------------------------------------------------------------

/** The wallets one pass reads: those that need attention first, then a window of the rest that moves on each pass. */
export function stillLoanPassWalletsV1(input: { eligible: readonly string[]; attention: ReadonlySet<string>; limit: number; pass: number }): string[] {
  const limit = Math.max(0, Math.floor(input.limit));
  // A few places always go to the rotation, so a pass full of loans in danger still reaches everyone in turn.
  const firstCap = limit - Math.ceil(limit / 5);
  const urgent = input.eligible.filter((wallet) => input.attention.has(wallet));
  const first = urgent.slice(0, firstCap);
  const chosen = new Set(first);
  const rest = input.eligible.filter((wallet) => !chosen.has(wallet));
  const room = Math.min(limit - first.length, rest.length);
  if (room <= 0) return first;
  const start = ((Math.floor(input.pass) * room) % rest.length + rest.length) % rest.length;
  return [...first, ...[...rest.slice(start), ...rest.slice(0, start)].slice(0, room)];
}

/** Reads each wallet and keeps what it found. A dry pass keeps nothing. */
export async function refreshStillLoanAlertsV1(input: {
  alerts: StillLoanAlertRepositoryV1;
  /** The wallets some channel can reach. */
  reachable: ReadonlySet<string>;
  /** The Mirror's reading of one address, with no name lookup. */
  read: (walletAddress: string) => Promise<MirrorReadingV1>;
  now: Date;
  dry?: boolean;
  limit?: number;
  /** Filled with each loan's debt and health factor as read, by `wallet|market`, for the words told about it
   * (audits LL-4 and ALERT-2). */
  debts?: Map<string, StillLoanReadV1>;
  /** What the collateral tokens of this reading's loans say (./stillLoanHolds.ts). A failure reads as nothing read. */
  readHolds?: (walletAddress: string, report: MirrorReport) => Promise<ReadonlyMap<string, StillLoanHoldReadingV1>>;
  /** Filled with each reading, by wallet, for what is worked out from it after the pass (./stillLoanWeekend.ts). */
  readings?: Map<string, Extract<MirrorReadingV1, { outcome: 'report' }>>;
}): Promise<{ due: number; read: number; failed: number; notRead: number }> {
  const reachable = [...input.reachable].map((wallet) => wallet.toLowerCase()).filter((wallet) => /^0x[0-9a-f]{40}$/.test(wallet));
  const eligible = await input.alerts.borrowers({ reachable, limit: STILL_LOAN_BORROWERS_SEEN_V1 });
  const attention = new Set(await input.alerts.attention());
  const wallets = stillLoanPassWalletsV1({ eligible, attention, limit: input.limit ?? STILL_LOAN_READS_PER_PASS_V1,
    pass: Math.floor(input.now.getTime() / STILL_LOAN_PASS_MS_V1) });
  const report = { due: wallets.length, read: 0, failed: 0, notRead: eligible.length - wallets.length };
  for (const walletAddress of wallets) {
    const outcome = await input.read(walletAddress).catch(() => null);
    if (!outcome || outcome.outcome !== 'report') {
      report.failed += 1;
      continue;
    }
    report.read += 1;
    input.readings?.set(walletAddress, outcome);
    for (const venue of outcome.report.venues) {
      if (venue.debtAtomic == null || !ATOMIC_V1.test(venue.debtAtomic)) continue;
      input.debts?.set(`${walletAddress}|${venue.market.toLowerCase()}`, {
        debtAtomic: venue.debtAtomic,
        healthFactor: venue.safety && ATOMIC_V1.test(venue.safety.healthFactor) ? venue.safety.healthFactor : null,
        block: outcome.report.reading.block,
      });
    }
    if (input.dry) continue;
    const holds = input.readHolds ? await input.readHolds(walletAddress, outcome.report).catch(() => undefined) : undefined;
    const { lines, unread } = stillLoanLinesV1(outcome.report, holds);
    await input.alerts.recordReading({ walletAddress, at: input.now, block: outcome.report.reading.block, lines, unread });
  }
  return report;
}

/** "Aave V4 · Coinbase Stocks", "Morpho · cbBTC/USDC": the Mirror's own names. */
export function stillLoanLabelV1(market: string): string {
  if (market === ADDRESSES.aaveSpoke.toLowerCase()) return 'Aave V4 · Coinbase Stocks';
  const asset = CRYPTO.find((row) => row.morphoMarket.toLowerCase() === market);
  return asset ? `Morpho · ${asset.symbol === 'ETH' ? 'WETH' : asset.symbol}/USDC` : 'Your Still loan';
}

/** Whole percent, rounded down: a margin is never said larger than it is. */
function percentV1(bps: number | bigint): string {
  const value = Number(bps);
  return value % 100 === 0 ? `${value / 100}%` : `${Math.floor(value / 10) / 10}%`;
}

// ---------------------------------------------------------------------------
// What a chat is told (audit LL-4, 2026-11-14). The words commanded ("act
// now", "Repay at once to keep it"), and the heaviest of them had no number at
// all, against the rule that Still states options with their measured
// consequences and never says what anyone should do. "To keep it" promised
// what no repayment can: a liquidator may come first. Now each notice says the
// debt, the margin and what repaying would do, in USDC.
//
// The amount is worked out from the health factor itself (audit ALERT-2,
// 2026-11-18). The margin is 1 - 1/HF, and the health factor moves with the
// debt alone, so the debt that may stay for the margin to be at least the
// Watch line t is HF x D x (1 - t), and the rest is the repayment. Until then
// it came from the margin, and a loan that can be liquidated has its margin
// read as zero: at a debt of 500 USDC and a health factor of 0.90 the notice
// said 187.50 USDC brings the margin back to 37.5%, where 218.75 does. The
// debt and the health factor are the ones one reading took at one block, the
// block the loan's band was recorded at; without them a liquidatable loan's
// notice names no amount, and a margin above zero stands for the lowest
// health factor that rounds to it, so the amount is never too small.
// ---------------------------------------------------------------------------

/** USDC that brings a loan's margin back to Still's Watch line, rounded up to the cent; null when it is there. */
export function stillLoanRepayToWatchAtomicV1(debtAtomic: bigint, healthFactorWad: bigint): bigint | null {
  if (debtAtomic <= 0n || healthFactorWad < 0n) return null;
  // The debt that may stay, rounded down, so the margin after is at least the line.
  const keep = (debtAtomic * healthFactorWad * (BPS_V1 - TERMS.watchBelowBps)) / (WAD_V1 * BPS_V1);
  if (keep >= debtAtomic) return null;
  // Up to the cent, and never more than the whole debt.
  const cents = ((debtAtomic - keep + 9_999n) / 10_000n) * 10_000n;
  return cents < debtAtomic ? cents : debtAtomic;
}

/** The lowest health factor whose margin rounds down to `marginBps` (policy.safetyFromHealthFactor): 1/(1 - m). */
export function stillLoanHealthOfMarginV1(marginBps: number): bigint | null {
  const margin = BigInt(Math.floor(marginBps));
  return margin > 0n && margin < BPS_V1 ? (WAD_V1 * BPS_V1) / (BPS_V1 - margin) : null;
}

/** "1,234.57 USDC", cents rounded up: a debt or a repayment is never said smaller than it is. */
function usdcCentsV1(atomic: bigint): string {
  const cents = (atomic + 9_999n) / 10_000n;
  return `${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')} USDC`;
}

/** What a chat is told about a loan whose band got worse: the debt, the margin and what repaying would do,
 * when this pass read the debt; the margin alone otherwise. */
export function stillLoanNoticeV1(loan: Pick<StillLoanAlertV1, 'market' | 'state' | 'marginBps' | 'readBlock'>, read: StillLoanReadV1 | null = null): {
  title: string;
  message: string;
  targetPath: string;
} {
  const label = stillLoanLabelV1(loan.market);
  const margin = `${Math.floor(loan.marginBps / 100)}%`;
  const watch = percentV1(TERMS.watchBelowBps), act = percentV1(TERMS.actBelowBps);
  // Only the reading the band was recorded at: a debt from one block beside a margin from another says nothing.
  const same = read !== null && read.block === loan.readBlock ? read : null;
  const debt = same && /^[1-9][0-9]{0,77}$/.test(same.debtAtomic) ? BigInt(same.debtAtomic) : null;
  const health = same?.healthFactor != null && ATOMIC_V1.test(same.healthFactor) ? BigInt(same.healthFactor)
    : loan.state === 'liquidation' ? null : stillLoanHealthOfMarginV1(loan.marginBps);
  const repay = debt === null || health === null ? null : stillLoanRepayToWatchAtomicV1(debt, health);
  const owes = debt === null ? '' : ` debt ${usdcCentsV1(debt)};`;
  if (loan.state === 'liquidation') {
    return {
      title: 'Still loan: liquidatable now',
      message: repay !== null
        ? `${label}:${owes} liquidatable now: a liquidator may take collateral at a discount. Repaying at least ${usdcCentsV1(repay)} brings the margin back to ${watch}.`
        : `${label}: this loan can be liquidated now, and a liquidator may take collateral at a discount. Repaying part of the loan raises the margin.`,
      targetPath: '/repay',
    };
  }
  if (loan.state === 'act') {
    return {
      title: `Still loan: only ${margin} margin`,
      message: repay !== null
        ? `${label}:${owes} the collateral can fall only ${margin} before liquidation, below Still’s ${act} line. Repaying ${usdcCentsV1(repay)} brings that back to ${watch}.`
        : `${label}: the collateral can fall only ${margin} before liquidation, below Still’s ${act} line. Repaying part of the loan raises the margin.`,
      targetPath: '/repay',
    };
  }
  return {
    title: `Still loan: margin ${margin}`,
    message: repay !== null
      ? `${label}:${owes} the collateral can fall ${margin} before liquidation. Repaying ${usdcCentsV1(repay)} brings that back to ${watch}, Still’s Watch line.`
      : `${label}: the collateral can fall ${margin} before liquidation. Below ${watch} Still calls it Watch. Repaying part of the loan raises the margin.`,
    targetPath: '/repay',
  };
}
