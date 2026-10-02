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
