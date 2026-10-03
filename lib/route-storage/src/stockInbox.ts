import { z } from 'zod';
import type { RwaSignalRowV1 } from './rwaSignals.js';

export const StockInboxWalletV1Schema = z.string().regex(/^0x[0-9a-f]{40}$/);
export const StockInboxIdsV1Schema = z.array(z.string().regex(/^[1-9][0-9]*$/)).max(50);
export interface StockInboxStateV1 {
  since: string;
  openedAt: string;
  reviewedAt: string | null;
}
export interface StockInboxPageInputV1 {
  wallet: string;
  addresses: readonly string[];
  since: string;
  until: string;
  view: 'unread' | 'history';
  before?: { at: string; id: string };
  /**
   * Per held contract, the largest measured cash size that is still this
   * wallet's news. A cost change measured above it belongs to the public
   * ladder: a $0.21 position was shown a $10,000 round trip. A contract with
   * no cap here keeps every size.
   */
  sizeCaps?: readonly { address: string; maxCashAtomic: string }[];
}
export interface StockInboxGroupV1 {
  /** Latest recording/ID anchors the entire transaction, even across pages. */
  anchor: { at: string; id: string };
  rows: RwaSignalRowV1[];
}
export interface StockInboxPageV1 {
  groups: StockInboxGroupV1[];
  hasMore: boolean;
}
export const STOCK_INBOX_ISSUER_KINDS_V1 = [
  'official_asset_corporate_action_announced',
  'official_asset_multiplier_changed',
  'official_asset_multiplier_change_scheduled',
  'official_asset_multiplier_change_cancelled',
] as const;

/** A measurement at one size: whether it is a holder's news depends on that size.
 * A route appearing or disappearing is everyone's news at any size. */
export const STOCK_INBOX_SIZED_KINDS_V1 = ['official_asset_cash_exit_changed'] as const;

/** True when a sized measurement is above this wallet's cap for that contract. */
export function stockInboxAboveCapV1(
  row: Pick<RwaSignalRowV1, 'kind' | 'subjectAddress' | 'facts'>,
  caps: readonly { address: string; maxCashAtomic: string }[] | undefined,
): boolean {
  if (!caps?.length || !STOCK_INBOX_SIZED_KINDS_V1.some((kind) => kind === row.kind)) return false;
  const size = row.facts.requestedCashAtomic;
  if (typeof size !== 'string' || !/^[0-9]{1,30}$/.test(size)) return false;
  const cap = caps.find((entry) => entry.address === row.subjectAddress);
  return cap !== undefined && BigInt(size) > BigInt(cap.maxCashAtomic);
}

/** Same exact contract and issuer transaction form one news item. No grouping
 * by amount, ticker or time: independent transactions stay independent. */
export function stockInboxGroupKeyV1(
  row: Pick<RwaSignalRowV1, 'signalId' | 'chainId' | 'kind' | 'subjectAddress' | 'facts'>,
): string {
  const tx = row.facts.transactionHash;
  return STOCK_INBOX_ISSUER_KINDS_V1.some((kind) => kind === row.kind) &&
    typeof tx === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(tx)
    ? `${row.chainId}:${row.subjectAddress}:${tx.toLowerCase()}`
    : `signal:${row.signalId}`;
}

/** Keep whole groups within the existing fifty-ID proof budget. A transaction
 * cannot be split across pages or half acknowledged. */
export function stockInboxPageV1(groups: readonly StockInboxGroupV1[]): StockInboxPageV1 {
  const page: StockInboxGroupV1[] = [];
  let count = 0;
  for (const group of groups) {
    if (!group.rows.length || group.rows.length > 50) throw new Error('stock_inbox_group_unread');
    if (count + group.rows.length > 50) return { groups: page, hasMore: true };
    page.push(group);
    count += group.rows.length;
  }
  return { groups: page, hasMore: false };
}
export interface StockInboxRepositoryV1 {
  /** Establish a fixed initial 24-hour baseline. This acknowledges nothing. */
  open(wallet: string, now: Date): Promise<StockInboxStateV1>;
  /** Whole issuer transactions, with raw evidence retained and bounded proofs. */
  page(input: StockInboxPageInputV1): Promise<StockInboxPageV1>;
  /** Only IDs from a server-issued, wallet-bound review proof reach this method. */
  acknowledge(wallet: string, ids: readonly string[], now: Date): Promise<StockInboxStateV1>;
}
