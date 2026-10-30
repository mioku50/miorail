import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';
import { formatCents, formatTokenAmount } from '@mioagent/still-engine/format';

import { STILL_SHARES_V1, newYorkMomentV1, type SkyStateV1 } from './skyState';
import { dividendMoneyV1 } from './dividendMoney';

// ---------------------------------------------------------------------------
// Home, in words and shapes, from one Mirror report.
//
// The report is the one source for "my loan" (the chain at one block); the
// dividend lines are Miorail's calendar for this wallet. Nothing here reads
// anything: the page passes what it read, and every sentence below is built
// from those fields, so a number on Home is a number in the report.
// ---------------------------------------------------------------------------

export type HomeStateV1 = 'calm' | 'watch' | 'act' | 'liquidation' | 'empty';

export interface MobileHoldingV1 {
  id: string;
  /** What the shape says: NVDA, BTC. */
  label: string;
  kind: 'stock' | 'crypto' | 'more';
  /** Wallet and pledged together, in cents. */
  valueCents: number;
}

export interface MobileInputV1 {
  holdings: MobileHoldingV1[];
  /** What is owed and what the limit is, in cents. Null when nothing could be borrowed or is owed. */
  loan: { owedCents: number; limitCents: number; weekdayLimitCents: number | null; owedLabel?: string } | null;
  state: HomeStateV1;
}

export interface ComingUpV1 {
  /** "FRI 8 PM", "NOV 13": when, in New York. */
  when: string;
  icon: 'moon' | 'sun' | 'dividend' | 'earnings';
  text: string;
}

export interface HomeViewV1 {
  state: HomeStateV1;
  stateWord: string;
  stateLine: string;
  /** "$784" and ".65", printed at two sizes. Null when the report could not say. */
  available: { dollars: string; cents: string; atLeast: boolean } | null;
  owed: { amount: string; detail: string } | null;
  mobile: MobileInputV1;
  comingUp: ComingUpV1[];
  /** Reads that failed this time, named. */
  failed: string[];
}

const TICKERS_V1: Readonly<Record<string, string>> = { cbBTC: 'BTC', ETH: 'ETH' };
/** "$1,234" and ".56": the engine's amount, split for two type sizes. */
function splitCentsV1(cents: string): { dollars: string; cents: string } {
  const text = formatCents(cents);
  const dot = text.lastIndexOf('.');
  return { dollars: text.slice(0, dot), cents: text.slice(dot) };
}

function labelOfV1(line: MirrorReport['assets'][number]): string {
  return TICKERS_V1[line.asset] ?? line.asset.replace(/c$/, '');
}

/** The worst safety among the venues that hold a loan. */
function worstV1(report: MirrorReport): { state: HomeStateV1; venue: MirrorReport['venues'][number] | null } {
  const order: HomeStateV1[] = ['liquidation', 'act', 'watch', 'calm'];
  let worst: MirrorReport['venues'][number] | null = null;
  for (const venue of report.venues) {
    if (!venue.safety || venue.debtCents === null || venue.debtCents === '0') continue;
    if (!worst || order.indexOf(venue.safety.state) < order.indexOf(worst.safety!.state)) worst = venue;
  }
  return { state: worst ? worst.safety!.state : 'empty', venue: worst };
}

function stateWordV1(state: HomeStateV1): string {
  if (state === 'watch') return 'Leaning.';
  if (state === 'act') return 'Tipping.';
  if (state === 'liquidation') return 'Over the edge.';
  return 'In balance.';
}

function stateLineV1(report: MirrorReport, state: HomeStateV1, venue: MirrorReport['venues'][number] | null): string {
  const debts = report.venues.filter(v => v.debtCents !== null && v.debtCents !== '0');
  const unreadDebt = report.venues.length === 0 || report.venues.some(v => v.debtCents === null);
  const unreadSafety = debts.some(v => v.safety === null);
  const uncertainty = [unreadDebt ? 'Debt could not be read in every reviewed market.' : '',
    unreadSafety ? 'Some recorded loans have unread liquidation safety.' : ''].filter(Boolean).join(' ');
  if (!venue || !venue.safety) {
    if (uncertainty) {
      const knownDebt = debts.reduce((sum, v) => sum + BigInt(v.debtCents!), BigInt(0));
      return `${knownDebt > BigInt(0) ? `Known debt: ${formatCents(knownDebt)}. ` : ''}${uncertainty}`;
    }
    const holding = report.assets.some((line) => line.valueCents !== null && line.valueCents !== '0');
    return holding ? 'No debt was recorded in the reviewed markets at this block.' : 'Nothing here to hold up a loan yet.';
  }
  if (state === 'liquidation') return `The loan outweighs its collateral: liquidation can start now.${uncertainty ? ` ${uncertainty}` : ''}`;
  const pledged = report.assets.filter((line) => line.venue === venue.venue && line.pledged !== null && line.pledged.raw !== '0');
  const names = pledged.map((line) => line.name);
  const subject = names.length === 1 ? names[0]! : 'Your collateral';
  const together = names.length === 1 ? '' : ' together';
  return `${subject} can fall ${Math.floor(venue.safety.marginBps / 100)}%${together} before the weight wins.${uncertainty ? ` ${uncertainty}` : ''}`;
}

function venueNameV1(venue: MirrorReport['venues'][number]): string {
  return venue.venue === 'aave-v4' ? 'Aave' : 'Morpho';
}

export function homeViewV1(input: {
  report: MirrorReport;
  sky: SkyStateV1;
  dividends?: DividendWalletResponseV1 | null;
}): HomeViewV1 {
  const { report, sky } = input;
  const { state, venue } = worstV1(report);
  const debtUnread = report.venues.length === 0 || report.venues.some(v => v.debtCents === null);
  const safetyUnread = report.venues.some(v => v.debtCents !== null && v.debtCents !== '0' && v.safety === null);

  const lines = report.assets.filter((line) => line.valueCents !== null && line.valueCents !== '0');
  const sorted = [...lines].sort((a, b) => Number(BigInt(b.valueCents!) - BigInt(a.valueCents!)));
  const shown = sorted.length > 4 ? sorted.slice(0, 3) : sorted;
  const holdings: MobileHoldingV1[] = shown.map((line) => ({
    id: line.asset,
    label: labelOfV1(line),
    kind: line.kind,
    valueCents: Number(line.valueCents),
  }));
  if (sorted.length > 4) {
    const rest = sorted.slice(3);
    holdings.push({
      id: 'more',
      label: `+${rest.length}`,
      kind: 'more',
      valueCents: rest.reduce((sum, line) => sum + Number(line.valueCents), 0),
    });
  }

  const debts = report.venues.filter((v) => v.debtCents !== null && v.debtCents !== '0');
  const owedCents = debts.reduce((sum, v) => sum + BigInt(v.debtCents!), BigInt(0));
  const allHaveAtomic = debts.every((v) => v.debtAtomic != null);
  const owedAtomic = allHaveAtomic ? debts.reduce((sum, v) => sum + BigInt(v.debtAtomic!), BigInt(0)) : null;
  // The engine rounds a debt up to a whole cent. A sub-cent debt is said the
  // same way in the picture as in the sentence beside it, not as $0.01.
  const subCentOwed = owedAtomic !== null && owedAtomic > BigInt(0) && owedAtomic < BigInt(10_000);
  const availableCents = report.headline.availableCents;
  const limit = availableCents === null ? null : owedCents + BigInt(availableCents);
  const weekdayLimit = report.headline.weekdayAvailableCents === null ? null : owedCents + BigInt(report.headline.weekdayAvailableCents);
  const loan = limit === null || limit === BigInt(0)
    ? null
    : { owedCents: Number(owedCents), limitCents: Number(limit), weekdayLimitCents: weekdayLimit === null ? null : Number(weekdayLimit), ...(subCentOwed ? { owedLabel: '<$0.01' } : {}) };

  let owed: HomeViewV1['owed'] = null;
  if (debts.length > 0) {
    const rated = debts.filter((v) => v.borrowRateBps !== null);
    const detail = debts.length === 1 && rated.length === 1
      ? `${(rated[0]!.borrowRateBps! / 100).toFixed(2)}% a year on ${venueNameV1(rated[0]!)}`
      : `on ${[...new Set(debts.map(venueNameV1))].join(' and ')}`;
    const owedDisplay =
      subCentOwed
        ? `${formatTokenAmount(owedAtomic!, 6, 6).replace(/\.?0+$/, '')} USDC`
        : formatCents(owedCents);
    owed = { amount: `${debtUnread ? 'Known debt' : 'Owed'} ${owedDisplay}`, detail };
  }

  const comingUp: ComingUpV1[] = [];
  if (sky.closed.active) {
    comingUp.push({ when: comingWhenV1(sky.closed.endsAt, sky.at), icon: 'sun', text: 'Full limits come back with the market.' });
  } else {
    const weekend = newYorkMomentV1(sky.closed.startsAt).startsWith('Fri') && newYorkMomentV1(sky.closed.endsAt).startsWith('Sun');
    comingUp.push({
      when: comingWhenV1(sky.closed.startsAt, sky.at),
      icon: 'moon',
      text: weekend ? 'Weekend limits begin.' : 'Holiday limits begin: Wall Street closes.',
    });
  }
  for (const line of report.assets) {
    const earnings = line.earnings;
    const window = earnings?.window;
    if (earnings?.source !== 'calendar' || !earnings.reportDate || !window || earnings.lowered) continue;
    // lowered describes the report's block. The page's clock can be newer:
    // an active or past window from a cached report is no longer "coming up".
    const startsAt = Date.parse(window.startsAt);
    if (!(startsAt > Date.parse(sky.at)) || !(Date.parse(window.endsAt) > startsAt)) continue;
    if (![line.wallet, line.pledged].some(amount => amount !== null && BigInt(amount.raw) > BigInt(0))) continue;
    comingUp.push({
      when: comingWhenV1(window.startsAt, sky.at),
      icon: 'earnings',
      text: `${line.name} reports ${dayV1(earnings.reportDate)}: new loans against it will count at ${STILL_SHARES_V1.earnings}% of the protocol’s limit until ${newYorkMomentV1(window.endsAt)}.`,
    });
  }
  for (const holding of input.dividends?.holdings ?? []) {
    const next = holding.upcoming[0];
    if (!next) continue;
    const estimate = next.kind === 'estimate';
    const amount = dividendMoneyV1(next.usd);
    comingUp.push({
      when: `${next.payDateApproximate ? '≈ ' : ''}${dayV1(next.payDate)}`.toUpperCase(),
      icon: 'dividend',
      text: `${holding.company} dividend · ${amount ? `${estimate && !amount.startsWith('<') ? '≈ ' : ''}${amount} as more ${holding.tokenSymbol}` : 'amount not read'}${estimate ? ', an estimate' : ''}`,
    });
  }

  const failed = [...new Set([...report.coverage.failed.map((f) => f.what)])];
  return {
    state,
    stateWord: (debtUnread || safetyUnread) && (state === 'empty' || state === 'calm') ? 'Not fully read.' : stateWordV1(state),
    stateLine: stateLineV1(report, state, venue),
    available: availableCents === null ? null : { ...splitCentsV1(availableCents), atLeast: !report.headline.complete },
    owed,
    mobile: { holdings, loan, state },
    comingUp,
    failed,
  };
}

const DAY_V1 = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const NEW_YORK_DAY_V1 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });

/**
 * "FRI 8 PM" names a day of this week only. An earnings window two weeks out
 * read "MON 12 AM" and looked like the coming Monday, so a moment six days or
 * more away carries its date: "MON NOV 16 12 AM". New York time, as the
 * section heading says.
 */
function comingWhenV1(iso: string, nowIso: string): string {
  const moment = newYorkMomentV1(iso);
  if (Date.parse(iso) - Date.parse(nowIso) < 6 * 86_400_000) return moment.toUpperCase();
  const [weekday, ...time] = moment.split(' ');
  return `${weekday} ${NEW_YORK_DAY_V1.format(new Date(iso))} ${time.join(' ')}`.toUpperCase();
}

/** "Nov 13" from a New York date. */
function dayV1(date: string): string {
  return DAY_V1.format(new Date(`${date}T12:00:00Z`));
}
