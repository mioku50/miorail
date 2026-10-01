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
export interface StockInboxRepositoryV1 {
  /** Establish a fixed initial 24-hour baseline. This acknowledges nothing. */
  open(wallet: string, now: Date): Promise<StockInboxStateV1>;
  /** 51 rows permit a 50-row page with an exact hasMore flag. */
  page(input: StockInboxPageInputV1): Promise<RwaSignalRowV1[]>;
  /** Only IDs from a server-issued, wallet-bound review proof reach this method. */
  acknowledge(wallet: string, ids: readonly string[], now: Date): Promise<StockInboxStateV1>;
}
