import type { MirrorReadingV1, MirrorReport } from '@mioagent/still-engine';
import { TERMS } from '@mioagent/still-engine/policy';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';
import type {
  StillLoanAlertRepositoryV1,
  StillLoanAlertV1,
  StillLoanReadingLineV1,
} from '@mioagent/route-storage';

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

/** One Mirror reading per wallet per pass; the pass runs every five minutes. */
export const STILL_LOAN_READS_PER_PASS_V1 = 25;
/** How often the pass runs, which turns the rotation by one window. */
export const STILL_LOAN_PASS_MS_V1 = 5 * 60_000;
/** The most borrowers one pass looks at to choose whom it reads. */
export const STILL_LOAN_BORROWERS_SEEN_V1 = 5_000;
/** A band read longer ago than this is not told: the next pass reads again. */
export const STILL_LOAN_FRESH_FOR_MS_V1 = 30 * 60_000;

/** The loans a report found, and the markets whose loan it could not read. */
export function stillLoanLinesV1(report: MirrorReport): { lines: StillLoanReadingLineV1[]; unread: string[] } {
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
    lines.push({ market, venue: venue.venue, state: venue.safety.state, marginBps: venue.safety.marginBps });
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
  /** Filled with each loan's debt as read, by `wallet|market`, for the words told about it (audit LL-4). */
  debts?: Map<string, string>;
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
    for (const venue of outcome.report.venues) {
      if (venue.debtAtomic != null && /^[0-9]{1,78}$/.test(venue.debtAtomic)) input.debts?.set(`${walletAddress}|${venue.market.toLowerCase()}`, venue.debtAtomic);
    }
    if (input.dry) continue;
    const { lines, unread } = stillLoanLinesV1(outcome.report);
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
// debt, the margin and what repaying would do, in USDC: the margin is the share
// by which all the collateral may fall, 1 - 1/HF, and the health factor moves
// with the debt alone, so repaying R of a debt D at margin m leaves a margin
// of at least the Watch line t when R = D(t - m)/(1 - m). A loan that can be
// liquidated has a margin read as zero, so its amount is a least one.
// ---------------------------------------------------------------------------

/** USDC that brings a loan's margin back to Still's Watch line, rounded up to the cent; null when it is there. */
export function stillLoanRepayToWatchAtomicV1(debtAtomic: bigint, marginBps: number): bigint | null {
  const target = TERMS.watchBelowBps, margin = BigInt(Math.floor(marginBps));
  if (debtAtomic <= 0n || margin < 0n || margin >= target) return null;
  const whole = 10_000n - margin;
  const exact = (debtAtomic * (target - margin) + whole - 1n) / whole;
  // Up to the cent, and never more than the whole debt.
  const cents = ((exact + 9_999n) / 10_000n) * 10_000n;
  return cents < debtAtomic ? cents : debtAtomic;
}

/** "1,234.57 USDC", cents rounded up: a debt or a repayment is never said smaller than it is. */
function usdcCentsV1(atomic: bigint): string {
  const cents = (atomic + 9_999n) / 10_000n;
  return `${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')} USDC`;
}

/** What a chat is told about a loan whose band got worse: the debt, the margin and what repaying would do,
 * when this pass read the debt; the margin alone otherwise. */
export function stillLoanNoticeV1(loan: Pick<StillLoanAlertV1, 'market' | 'state' | 'marginBps'>, debtAtomic: string | null = null): {
  title: string;
  message: string;
  targetPath: string;
} {
  const label = stillLoanLabelV1(loan.market);
  const margin = `${Math.floor(loan.marginBps / 100)}%`;
  const watch = percentV1(TERMS.watchBelowBps), act = percentV1(TERMS.actBelowBps);
  const debt = debtAtomic !== null && /^[1-9][0-9]{0,77}$/.test(debtAtomic) ? BigInt(debtAtomic) : null;
  const repay = debt === null ? null : stillLoanRepayToWatchAtomicV1(debt, loan.marginBps);
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
