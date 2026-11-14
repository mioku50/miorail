import { NOTIFICATION_CHANNELS_V1, type NotificationChannelV1 } from './baseAppNotifications.js';
import { RouteStorageIntegrityError } from './types.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Still: a loan's margin, told before it is too late.
//
// The notifier reads the wallets that borrowed through Still with the Mirror
// engine and keeps one row per loan: the Aave V4 spoke (one USDC debt across
// every stock) or a Morpho market. A row holds the band of the last reading
// (calm, watch, act or liquidation, by Still's terms) and the margin, the share
// by which all the collateral may fall before liquidation.
//
// The episode is what "once" counts in. It moves on each time the band gets
// worse, so watch, act and liquidation are each told once; a better band moves
// nothing, and a later fall is told again. A loan the reading found gone loses
// its row. A reading that failed changes nothing: an unread loan is not a safe
// one, and it is not a repaid one either.
// ---------------------------------------------------------------------------

export const STILL_LOAN_STATES_V1 = ['calm', 'watch', 'act', 'liquidation'] as const;
export type StillLoanStateV1 = (typeof STILL_LOAN_STATES_V1)[number];
export type StillLoanVenueV1 = 'aave-v4' | 'morpho';

export interface StillLoanAlertV1 {
  walletAddress: string;
  /** The Aave spoke's address, or a Morpho market id. */
  market: string;
  venue: StillLoanVenueV1;
  state: StillLoanStateV1;
  /** The share by which all the collateral may fall before liquidation. */
  marginBps: number;
  episode: number;
  createdAt: string;
  readAt: string;
  readBlock: string;
  /** The episode each channel last told this wallet about this loan. */
  told: Record<NotificationChannelV1, number | null>;
}

/** One loan a reading found: debt above zero and a safety the engine computed. */
export interface StillLoanReadingLineV1 {
  market: string;
  venue: StillLoanVenueV1;
  state: StillLoanStateV1;
  marginBps: number;
}

export interface StillLoanAlertRepositoryV1 {
  /**
   * Wallets among `reachable` with a Still borrow that ever went to the wallet, in address order, up to
   * `limit` (audit LL-3, 2026-11-14). Any state but `ready`: confirmed, sent, unknown, stopped part way or
   * released as never sent; the Mirror reads the position from the chain, so one with no debt costs only
   * a reading. Reachability is filtered before the limit, so a reachable wallet late in the alphabet is
   * not cut off by unreachable ones.
   */
  borrowers(input: { reachable: readonly string[]; limit: number }): Promise<string[]>;
  /** Wallets whose last reading put a loan in watch, act or liquidation, in address order: read every pass. */
  attention(): Promise<string[]>;
  /**
   * Keeps one wallet's reading. Every line is a loan it found. A row whose
   * market is neither a line nor in `unread` is a loan that is gone, and goes.
   * A band worse than the row's starts the next episode; a reading older than
   * the row's block changes nothing.
   */
  recordReading(input: {
    walletAddress: string;
    at: Date;
    block: string;
    lines: readonly StillLoanReadingLineV1[];
    unread: readonly string[];
  }): Promise<void>;
  /** This wallet's loans, by market. */
  loansOf(walletAddress: string): Promise<StillLoanAlertV1[]>;
  /** Loans in watch, act or liquidation, read at or after `freshSince`, whose
   * episode this channel has not told yet. */
  due(input: { channel: NotificationChannelV1; freshSince: Date }): Promise<StillLoanAlertV1[]>;
  /** This channel told the wallet about this episode of this loan. */
  markTold(input: { walletAddress: string; market: string; channel: NotificationChannelV1; episode: number }): Promise<void>;
}

const WALLET_V1 = /^0x[0-9a-f]{40}$/;
const MARKET_V1 = /^0x[0-9a-f]{40}([0-9a-f]{24})?$/;

/** How bad a band is; a higher rank is a worse one. */
export function stillLoanStateRankV1(state: StillLoanStateV1): number {
  return STILL_LOAN_STATES_V1.indexOf(state);
}

function assertWalletV1(wallet: string): void {
  if (!WALLET_V1.test(wallet)) throw new RouteStorageIntegrityError('expected a lowercase 20-byte wallet address');
}

function assertMarketV1(market: string): void {
  if (!MARKET_V1.test(market)) throw new RouteStorageIntegrityError('a loan market is the Aave spoke or a Morpho market id, lowercase');
}

function assertChannelV1(channel: string): void {
  if (!(NOTIFICATION_CHANNELS_V1 as readonly string[]).includes(channel)) {
    throw new RouteStorageIntegrityError(`unknown notification channel: ${channel}`);
  }
}

function assertReadingV1(input: { walletAddress: string; block: string; lines: readonly StillLoanReadingLineV1[]; unread: readonly string[] }): void {
  assertWalletV1(input.walletAddress);
  if (!/^[1-9][0-9]{0,18}$/.test(input.block)) throw new RouteStorageIntegrityError('a block is a positive number');
  const seen = new Set<string>();
  for (const line of input.lines) {
    assertMarketV1(line.market);
    if (seen.has(line.market)) throw new RouteStorageIntegrityError('one line per loan');
    seen.add(line.market);
    if (line.venue !== 'aave-v4' && line.venue !== 'morpho') throw new RouteStorageIntegrityError('a loan is on Aave V4 or Morpho');
    if (!(STILL_LOAN_STATES_V1 as readonly string[]).includes(line.state)) throw new RouteStorageIntegrityError('unknown loan band');
    if (!Number.isInteger(line.marginBps) || line.marginBps < 0 || line.marginBps > 10_000) {
      throw new RouteStorageIntegrityError('a margin is whole basis points from 0 to 10000');
    }
  }
  for (const market of input.unread) assertMarketV1(market);
}

/** The in-memory store: refuses what the table refuses, and moves episodes
 * the way the SQL does. */
export class InMemoryStillLoanAlertRepositoryV1 implements StillLoanAlertRepositoryV1 {
  private readonly loans = new Map<string, StillLoanAlertV1>();
  /** Test seam: the wallets with a Still borrow that went to the wallet (any state but `ready`). */
  readonly confirmedBorrowers = new Set<string>();

  async borrowers(input: { reachable: readonly string[]; limit: number }): Promise<string[]> {
    const reachable = new Set(input.reachable);
    return [...this.confirmedBorrowers].filter((wallet) => reachable.has(wallet)).sort().slice(0, input.limit);
  }

  async attention(): Promise<string[]> {
    return [...new Set([...this.loans.values()].filter((loan) => loan.state !== 'calm').map((loan) => loan.walletAddress))].sort();
  }

  async recordReading(input: { walletAddress: string; at: Date; block: string; lines: readonly StillLoanReadingLineV1[]; unread: readonly string[] }) {
    assertReadingV1(input);
    const at = input.at.toISOString();
    const keep = new Set([...input.lines.map((line) => line.market), ...input.unread]);
    for (const [key, loan] of this.loans) {
      if (loan.walletAddress === input.walletAddress && !keep.has(loan.market)) this.loans.delete(key);
    }
    for (const line of input.lines) {
      const key = `${input.walletAddress}|${line.market}`;
      const row = this.loans.get(key);
      if (!row) {
        this.loans.set(key, {
          walletAddress: input.walletAddress, market: line.market, venue: line.venue, state: line.state, marginBps: line.marginBps,
          episode: line.state === 'calm' ? 0 : 1, createdAt: at, readAt: at, readBlock: input.block,
          told: { base_app: null, telegram: null },
        });
        continue;
      }
      if (BigInt(row.readBlock) > BigInt(input.block)) continue;
      Object.assign(row, {
        episode: row.episode + (stillLoanStateRankV1(line.state) > stillLoanStateRankV1(row.state) ? 1 : 0),
        venue: line.venue, state: line.state, marginBps: line.marginBps, readAt: at, readBlock: input.block,
      });
    }
  }

  async loansOf(walletAddress: string): Promise<StillLoanAlertV1[]> {
    assertWalletV1(walletAddress);
    return [...this.loans.values()]
      .filter((loan) => loan.walletAddress === walletAddress)
      .sort((a, b) => a.market.localeCompare(b.market))
      .map((loan) => structuredClone(loan));
  }

  async due(input: { channel: NotificationChannelV1; freshSince: Date }): Promise<StillLoanAlertV1[]> {
    assertChannelV1(input.channel);
    return [...this.loans.values()]
      .filter((loan) => loan.state !== 'calm' && loan.told[input.channel] !== loan.episode
        && Date.parse(loan.readAt) >= input.freshSince.getTime())
      .sort((a, b) => a.walletAddress.localeCompare(b.walletAddress) || a.market.localeCompare(b.market))
      .map((loan) => structuredClone(loan));
  }

  async markTold(input: { walletAddress: string; market: string; channel: NotificationChannelV1; episode: number }) {
    assertWalletV1(input.walletAddress);
    assertMarketV1(input.market);
    assertChannelV1(input.channel);
    const loan = this.loans.get(`${input.walletAddress}|${input.market}`);
    if (!loan || input.episode !== loan.episode) return;
    loan.told[input.channel] = input.episode;
  }
}

function loanOfRowV1(row: Record<string, unknown>): StillLoanAlertV1 {
  const at = (value: unknown) => new Date(value as string | Date).toISOString();
  const int = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    walletAddress: String(row.wallet_address),
    market: String(row.market),
    venue: String(row.venue) as StillLoanVenueV1,
    state: String(row.state) as StillLoanStateV1,
    marginBps: Number(row.margin_bps),
    episode: Number(row.episode),
    createdAt: at(row.created_at),
    readAt: at(row.read_at),
    readBlock: String(row.read_block),
    told: { base_app: int(row.told_base_app), telegram: int(row.told_telegram) },
  };
}

/** Each loan's change is one statement, so two passes cannot interleave into
 * an episode neither meant. */
export function createDatabaseStillLoanAlertRepositoryV1(sql: SqlTemplateExecutor): StillLoanAlertRepositoryV1 {
  return {
    async borrowers(input) {
      const reachable = input.reachable.filter((wallet) => WALLET_V1.test(wallet));
      if (reachable.length === 0) return [];
      const rows = (await sql`
        SELECT DISTINCT wallet_address FROM lending_executions
         WHERE operation = 'borrow' AND state <> 'ready'
           AND wallet_address = ANY(${reachable}::text[])
         ORDER BY wallet_address
         LIMIT ${input.limit}`) as Record<string, unknown>[];
      return rows.map((row) => String(row.wallet_address));
    },

    async attention() {
      const rows = (await sql`
        SELECT DISTINCT wallet_address FROM still_loan_alerts
         WHERE state <> 'calm'
         ORDER BY wallet_address`) as Record<string, unknown>[];
      return rows.map((row) => String(row.wallet_address));
    },

    async recordReading(input) {
      assertReadingV1(input);
      const at = input.at.toISOString();
      const keep = [...input.lines.map((line) => line.market), ...input.unread];
      await sql`
        DELETE FROM still_loan_alerts
         WHERE wallet_address = ${input.walletAddress}
           AND NOT (market = ANY(${keep}::text[]))`;
      for (const line of input.lines) {
        const rank = stillLoanStateRankV1(line.state);
        await sql`
          INSERT INTO still_loan_alerts AS a
            (wallet_address, market, venue, state, margin_bps, episode, created_at, read_at, read_block)
          VALUES (${input.walletAddress}, ${line.market}, ${line.venue}, ${line.state}, ${line.marginBps},
                  ${line.state === 'calm' ? 0 : 1}, ${at}::timestamptz, ${at}::timestamptz, ${input.block}::bigint)
          ON CONFLICT (wallet_address, market) DO UPDATE
             SET episode = a.episode + CASE
                   WHEN ${rank}::int > array_position(ARRAY['calm', 'watch', 'act', 'liquidation'], a.state) - 1
                   THEN 1 ELSE 0 END,
                 venue = EXCLUDED.venue,
                 state = EXCLUDED.state,
                 margin_bps = EXCLUDED.margin_bps,
                 read_at = EXCLUDED.read_at,
                 read_block = EXCLUDED.read_block
           WHERE a.read_block <= EXCLUDED.read_block`;
      }
    },

    async loansOf(walletAddress) {
      assertWalletV1(walletAddress);
      const rows = (await sql`
        SELECT * FROM still_loan_alerts WHERE wallet_address = ${walletAddress} ORDER BY market`) as Record<string, unknown>[];
      return rows.map(loanOfRowV1);
    },

    async due(input) {
      assertChannelV1(input.channel);
      const rows = (await sql`
        SELECT * FROM still_loan_alerts
         WHERE state <> 'calm'
           AND read_at >= ${input.freshSince.toISOString()}::timestamptz
           AND (CASE WHEN ${input.channel}::text = 'base_app' THEN told_base_app ELSE told_telegram END) IS DISTINCT FROM episode
         ORDER BY wallet_address, market`) as Record<string, unknown>[];
      return rows.map(loanOfRowV1);
    },

    async markTold(input) {
      assertWalletV1(input.walletAddress);
      assertMarketV1(input.market);
      assertChannelV1(input.channel);
      // The column is named by the channel, never by the caller's text.
      if (input.channel === 'base_app') {
        await sql`
          UPDATE still_loan_alerts SET told_base_app = ${input.episode}
           WHERE wallet_address = ${input.walletAddress} AND market = ${input.market} AND episode = ${input.episode}`;
      } else {
        await sql`
          UPDATE still_loan_alerts SET told_telegram = ${input.episode}
           WHERE wallet_address = ${input.walletAddress} AND market = ${input.market} AND episode = ${input.episode}`;
      }
    },
  };
}
