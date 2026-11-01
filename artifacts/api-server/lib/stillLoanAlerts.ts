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
}): Promise<{ due: number; read: number; failed: number }> {
  const borrowers = await input.alerts.borrowers(200);
  const wallets = borrowers.filter((wallet) => input.reachable.has(wallet)).slice(0, input.limit ?? STILL_LOAN_READS_PER_PASS_V1);
  const report = { due: wallets.length, read: 0, failed: 0 };
  for (const walletAddress of wallets) {
    const outcome = await input.read(walletAddress).catch(() => null);
    if (!outcome || outcome.outcome !== 'report') {
      report.failed += 1;
      continue;
    }
    report.read += 1;
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

/** What a chat is told about a loan whose band got worse. */
export function stillLoanNoticeV1(loan: Pick<StillLoanAlertV1, 'market' | 'state' | 'marginBps'>): {
  title: string;
  message: string;
  targetPath: string;
} {
  const label = stillLoanLabelV1(loan.market);
  const margin = `${Math.floor(loan.marginBps / 100)}%`;
  if (loan.state === 'liquidation') {
    return {
      title: 'Still loan: liquidatable now',
      message: `${label}: this loan can be liquidated now, and a liquidator may take collateral at a discount. Repay at once to keep it.`,
      targetPath: '/repay',
    };
  }
  if (loan.state === 'act') {
    return {
      title: `Still loan: act now, ${margin} left`,
      message: `${label}: your collateral can now fall only ${margin} before liquidation. Below ${percentV1(TERMS.actBelowBps)}, act now: repay part of the loan.`,
      targetPath: '/repay',
    };
  }
  return {
    title: `Still loan: margin ${margin}`,
    message: `${label}: your collateral can now fall ${margin} before liquidation. Below ${percentV1(TERMS.watchBelowBps)} Still calls it Watch. Repaying part of the loan raises the margin.`,
    targetPath: '/repay',
  };
}
