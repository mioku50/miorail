// Browser-safe evidence for stock distributions. These are per-share issuer facts, never a
// claim that the connected wallet held a share at the distribution or received cash.
import type { Address } from 'viem';
import type { StockId } from './registry.js';

export interface DividendDeclaration {
  exDate: string;
  recordDate: string | null;
  paymentDate: string | null;
  /** Dollars per underlying share, as a decimal string from Aave's calendar. */
  amountUsd: string;
  frequency: string | null;
}

export interface DividendReceipt {
  state: 'verified' | 'not_verified' | 'unread';
  reason:
    | 'no_payment_in_calendar'
    | 'not_measured'
    | 'no_net_change_in_window'
    | 'dividend_not_verified'
    | 'history_unread'
    | 'ambiguous_calendar'
    | null;
  declaration: DividendDeclaration | null;
  /** A bounded search is not a search of the token's entire history. */
  searched: { from: string; to: string } | null;
  proof: {
    block: string;
    blockHash: string;
    blockTime: string;
    transactionHash: string;
    announcementId: string;
    multiplierBeforeWad: string;
    multiplierAfterWad: string;
    /** Aave's price per raw token, in the oracle's decimals, at the application block. */
    oraclePrice: string | null;
    oracleDecimals: number;
    /** Dollar estimate per one underlying share before the change. Not a USDC transfer. */
    reinvestedUsdPerShare: string | null;
    addedSharesPerShare: string;
    /** Reinvested value / declared amount. No attribution of the difference to tax or fees. */
    ofDeclaredBps: number | null;
  } | null;
}

export interface StockDividend {
  asset: StockId;
  name: string;
  token: Address;
  calendar: 'read' | 'unread';
  next: {
    state: 'announced' | 'not_announced' | 'no_dividends_listed' | 'unread';
    declaration: DividendDeclaration | null;
  };
  /** A scheduled scale change can also be a split. Do not call it a dividend without evidence. */
  adjustment: {
    state: 'scheduled' | 'none' | 'unread';
    currentMultiplierWad: string | null;
    nextMultiplierWad: string | null;
    effectiveAt: string | null;
  };
  receipt: DividendReceipt;
}

export interface DividendReport {
  kind: 'still.dividends';
  version: 1;
  reading: { block: string; blockTime: string; provider: string } | null;
  calendarReadAt: string | null;
  calendarSince: string | null;
  stocks: StockDividend[];
  coverage: {
    total: number;
    calendarsRead: number;
    adjustmentsRead: number;
    receiptsVerified: number;
    receiptsPriced: number;
    receiptsUnread: number;
  };
}
