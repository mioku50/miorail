// The Mirror report: what any wallet could borrow through Still without selling, and everything
// a reader needs to check it. One shape for the page, the API and agent tools.
//
// JSON-safe: amounts are decimal strings of integer units. Money is in cents of USDC (1 USDC is
// treated as $1 on screen, and the report says so). Absence has three spellings: a field that
// was not measured is absent from its list's `failed` entry, a measured zero is "0", and an
// unknown value is null with a reason next to it.

import type { Address } from 'viem';
import type { AssetId } from './registry.js';
import type { SafetyState } from './policy.js';

export type Venue = 'aave-v4' | 'morpho';

export interface TokenAmount {
  /** Integer base units. */
  raw: string;
  decimals: number;
}

/** Why an asset adds nothing, or less than its full value, to what can be borrowed. */
export type AssetLimit =
  | 'reserve_paused' // Aave paused the reserve (a corporate action, for example)
  | 'reserve_frozen' // Aave froze the reserve: no new collateral, no new borrowing against it
  | 'spoke_halted' // the hub halted this spoke for the asset
  | 'issuer_paused' // Coinbase's registry marks the token paused
  | 'supply_cap' // Aave's collateral cap leaves room for only part of the wallet's tokens
  | 'gas_reserve' // part of the native ETH stays in the wallet for network fees
  | 'not_listed'; // the venue lists no market for this asset now

/** A stock's earnings report and the window around it, in which Still lends at the lower rate. */
export interface EarningsNote {
  /** "calendar": read from the Aave V4 API; "unread": it could not be read, so the stock counts at the earnings rate. */
  source: 'calendar' | 'unread';
  /** The report whose window is open now or comes next, a New York day; null when none is scheduled or unread. */
  reportDate: string | null;
  window: { startsAt: string; endsAt: string } | null;
  /** True when Still's factor is lowered now: inside the window, or the calendar was not read. */
  lowered: boolean;
}

export interface AssetLine {
  asset: AssetId;
  kind: 'stock' | 'crypto';
  name: string;
  /** cbBTC, ETH, or the stock token's ticker such as NVDAc. */
  symbol: string;
  token: Address;
  isin: string | null;
  venue: Venue;
  wallet: TokenAmount | null;
  /** Already held as collateral at the venue. */
  pledged: TokenAmount | null;
  /** Share-equivalents for a stock: tokens × Coinbase multiplier. Null for crypto or unread. */
  shares: TokenAmount | null;
  /** Price per whole token in cents, as the venue's own oracle reads it. */
  priceCents: string | null;
  priceUpdatedAt: string | null;
  valueCents: string | null;
  protocolFactorBps: number | null;
  stillFactorBps: number | null;
  /** What this asset adds to the limit, before debts. Null when it could not be computed. */
  capacityCents: string | null;
  /** Stocks only: the earnings report that lowers Still's factor around it. Null for crypto. */
  earnings: EarningsNote | null;
  limits: AssetLimit[];
  /** Reads that failed for this asset, by name. Empty when everything was read. */
  failed: string[];
}

export interface Safety {
  /** Share by which all collateral may fall together before liquidation, in basis points. */
  marginBps: number;
  state: SafetyState;
  healthFactor: string; // WAD
  source: 'protocol' | 'computed';
}

export interface LiquidationPrice {
  asset: AssetId;
  /** Below this price per whole token, if only this asset moved, liquidation can start. Rounded up. */
  priceCents: string | null;
  /** True when no price of this asset alone could trigger liquidation. */
  unreachable: boolean;
}

export interface VenueLine {
  venue: Venue;
  /** Morpho markets are isolated: one line per market. */
  market: string;
  label: string;
  debtCents: string | null;
  /** Exact atomic USDC debt (6 decimals) when read, so sub-cent micro-debt is never lost. */
  debtAtomic?: string | null;
  /** Still's limit from this venue's collateral, before debts. */
  capacityCents: string | null;
  availableCents: string | null;
  /** Borrow rate a year in basis points, as the venue reports it now. */
  borrowRateBps: number | null;
  /** What the venue can lend now; the available amount never exceeds it. */
  liquidityCents: string | null;
  /**
   * What stands between capacity and available, so rows can add up to the headline:
   * capacity − loans − venueLimit = available. Loans count only up to the capacity they use.
   */
  deductions: { loansCents: string | null; venueLimitCents: string | null };
  safety: Safety | null;
  liquidationPrices: LiquidationPrice[];
  failed: string[];
}

export type HeadlineState = 'funded' | 'dust' | 'none' | 'unknown';

export interface Headline {
  state: HeadlineState;
  /** Null when unknown. Rounded down; it adds up exactly from the lines. */
  availableCents: string | null;
  /** False when some read failed: then the amount is a floor, "at least". */
  complete: boolean;
  /** Why "none": the wallet holds nothing Still lends against, or its loans already use the limit. */
  reason: 'no_eligible_assets' | 'limit_in_use' | 'paused' | null;
  /** During the weekend window: the same wallet on a weekday terms, for comparison. */
  weekdayAvailableCents: string | null;
}

export interface FailedRead {
  what: string;
  /** "us": our provider or a call we could not decode; never the wallet's fault. */
  owner: 'us' | 'protocol';
}

export interface MirrorReport {
  kind: 'still.mirror';
  version: 1;
  subject: {
    address: Address;
    /** Primary Basename or ENS name, only when it resolves forward to the same address. */
    name: string | null;
    /** What the person typed, trimmed. */
    input: string;
  };
  reading: {
    block: string;
    blockTime: string;
    assembledAt: string;
    /** Host label of the provider that answered, never its URL. */
    provider: string;
  };
  terms: {
    version: string;
    stockShareBps: number;
    cryptoShareBps: number;
    weekend: { active: boolean; startsAt: string; endsAt: string; stockShareBps: number };
    /** Around a stock's earnings report; when the calendar was read, null when it was not. */
    earnings: { stockShareBps: number; calendarReadAt: string | null };
  };
  headline: Headline;
  assets: AssetLine[];
  venues: VenueLine[];
  coverage: {
    /** The full set this report measured, so a count is never mistaken for everything. */
    measured: string[];
    notCounted: string[];
    failed: FailedRead[];
  };
  evidence: Array<{ label: string; address: Address }>;
}
