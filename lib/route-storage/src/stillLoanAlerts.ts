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
//
// Since 2026-11-17 (migration 0099) the row also keeps what three more notices
// need. The debt and rate of the last reading. The interest the loan gathered
// while Still read it: each reading adds the debt's growth since the one before
// when that growth is interest alone, and across a borrow or a repayment what
// the rate read before would have charged, counted apart as estimated. And the
// holds on its collateral, with an episode that moves when one appears. What
// each channel told of those (a loan opened, a week's note, a hold) is in
// still_loan_notices, once each.
//
// Since migration 0100 three more are told the same way. A loan repaid through
// Still, from the receipt. A margin back above the Watch line: the row keeps
// when it entered its band, so calm must hold for two readings in a row. And a
// rate that jumped: the row keeps the rate its owner last heard of (from a
// notice that said it, else the first reading) and since when the rate has
// read a jump over it, with an episode that moves each time such a stretch
// starts. The rate heard of is the loan's, whichever channel said it.
// ---------------------------------------------------------------------------

export const STILL_LOAN_STATES_V1 = ['calm', 'watch', 'act', 'liquidation'] as const;
export type StillLoanStateV1 = (typeof STILL_LOAN_STATES_V1)[number];
export type StillLoanVenueV1 = 'aave-v4' | 'morpho';

/**
 * What can hold a loan's collateral, as 'SYMBOL:kind'. Read from the token: its
 * transfers paused, or its issuer freezing what Morpho Blue holds or this
 * wallet. Read by the Mirror on Aave V4: the reserve paused, frozen or halted
 * on the spoke, or Coinbase's registry holding the stock's price feed.
 */
export const STILL_LOAN_HOLD_KINDS_V1 = [
  'transfers_paused', 'market_frozen', 'wallet_frozen', 'feed_paused', 'reserve_paused', 'spoke_halted', 'reserve_frozen',
] as const;
export type StillLoanHoldKindV1 = (typeof STILL_LOAN_HOLD_KINDS_V1)[number];
const HOLD_V1 = new RegExp(`^[A-Za-z0-9]{1,16}:(${STILL_LOAN_HOLD_KINDS_V1.join('|')})$`);

/** The notices told besides a worse band, each once per channel. */
export const STILL_LOAN_NOTICE_KINDS_V1 = ['opened', 'week', 'hold', 'closed', 'recovered', 'rate', 'weekend'] as const;
export type StillLoanNoticeKindV1 = (typeof STILL_LOAN_NOTICE_KINDS_V1)[number];

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
  /** The last debt a reading said, in USDC base units; null before one did. */
  debtAtomic: string | null;
  /** The last borrow rate a reading said, a year, in basis points; null before one did. */
  rateBps: number | null;
  /** When a reading last said the rate: it is the rate now only when this is `readAt`. A reading that could not
   * read it keeps the one before and moves `readAt` alone (audit P3, 2026-11-18). */
  rateReadAt: string | null;
  /** The interest this loan gathered while Still read it, in USDC base units. */
  interestAtomic: string;
  /** The part of it estimated from a rate, across a borrow or a repayment. */
  estimatedAtomic: string;
  /** The holds on its collateral, as 'SYMBOL:kind', sorted. */
  holds: string[];
  /** What "once" counts in for holds: it moves each time a hold appears. */
  holdEpisode: number;
  /** When the loan entered the band it is in: the first reading that read it there. */
  stateSince: string;
  /** The borrow rate its owner last heard of, a year, in basis points: from a notice that said it, else the
   * first reading's. Null before a reading said one. */
  rateToldBps: number | null;
  rateToldAt: string | null;
  /** Since when the rate has read a jump over `rateToldBps`; null when the last reading of it did not. */
  rateHighSince: string | null;
  /** What "once" counts in for a rate jump: it moves each time such a stretch starts. */
  rateEpisode: number;
}

/** What a reading could tell of the holds on a loan's collateral. A hold in neither list was not read, and stays as it was. */
export interface StillLoanHoldReadingV1 {
  held: readonly string[];
  cleared: readonly string[];
}

/** One loan a reading found: debt above zero and a safety the engine computed. */
export interface StillLoanReadingLineV1 {
  market: string;
  venue: StillLoanVenueV1;
  state: StillLoanStateV1;
  marginBps: number;
  /** The debt it read, in USDC base units; absent or null when it did not say. */
  debtAtomic?: string | null;
  /** The borrow rate a year it read, in basis points; absent or null when it did not say. */
  rateBps?: number | null;
  /** The holds it could read; absent when it read none. */
  holds?: StillLoanHoldReadingV1;
}

/** An open loan with no note this week on this channel, and what the note counts from. */
export interface StillLoanWeekDueV1 {
  loan: StillLoanAlertV1;
  /** Since when the note's interest is counted: the last week's note to this channel, or the loan's first reading. */
  since: string;
  /** The interest count at that point. */
  interestBeforeAtomic: string;
  estimatedBeforeAtomic: string;
}

/** A borrow or a repayment through Still that landed, as its review and receipt left it. */
export interface StillLoanReceiptV1 {
  executionId: string;
  walletAddress: string;
  venue: StillLoanVenueV1;
  /** The market the execution names. */
  marketId: string;
  confirmedAt: string;
  /** The review's facts and the receipt's verified effect, as stored. */
  facts: Record<string, unknown>;
  proof: Record<string, unknown> | null;
}

/** A borrow through Still that landed. */
export type StillLoanOpenedV1 = StillLoanReceiptV1;
/** A repayment through Still that landed and left no debt there. */
export type StillLoanClosedV1 = StillLoanReceiptV1;

export interface StillLoanNoticeRecordV1 {
  channel: NotificationChannelV1;
  kind: StillLoanNoticeKindV1;
  key: string;
  walletAddress: string;
  market: string;
  at: Date;
  /** A week's note: the interest count it was told at. */
  interestAtomic?: string;
  estimatedAtomic?: string;
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
   * A band worse than the row's starts the next episode; a hold the row did not
   * have starts the next hold episode; a reading older than the row's block
   * changes nothing.
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
  /** Loans under a hold whose hold episode this channel has not told, read at or after `freshSince`. */
  holdsDue(input: { channel: NotificationChannelV1; freshSince: Date }): Promise<StillLoanAlertV1[]>;
  /** Loans with a debt and no note for this week on this channel, read at or after `freshSince` and first read at or before `firstReadBy`. */
  weekDue(input: { channel: NotificationChannelV1; weekCloseAt: string; freshSince: Date; firstReadBy: Date }): Promise<StillLoanWeekDueV1[]>;
  /** Borrows by these wallets confirmed at or after `since`, that this channel has not told. */
  openedDue(input: { channel: NotificationChannelV1; wallets: readonly string[]; since: Date }): Promise<StillLoanOpenedV1[]>;
  /** Repayments by these wallets confirmed at or after `since` whose verified effect left no debt, that this channel has not told. */
  closedDue(input: { channel: NotificationChannelV1; wallets: readonly string[]; since: Date }): Promise<StillLoanClosedV1[]>;
  /**
   * Calm loans whose worse band of this episode this channel told, calm at two readings in a row (so a margin
   * that only touches the Watch line is not news), read at or after `freshSince`, and not yet told as back.
   */
  recoveredDue(input: { channel: NotificationChannelV1; freshSince: Date }): Promise<StillLoanAlertV1[]>;
  /** Loans with a debt whose rate has read a jump over the one their owner heard of since `highSince` or before,
   * read at or after `freshSince`, whose rate episode this channel has not told. */
  rateDue(input: { channel: NotificationChannelV1; freshSince: Date; highSince: Date }): Promise<StillLoanAlertV1[]>;
  /** A notice told this loan's owner this rate: the rate they last heard of, which ends a stretch of jump. */
  markRateTold(input: { walletAddress: string; market: string; rateBps: number; at: Date }): Promise<void>;
  /** Which of these keys this channel told under this kind. */
  noticesTold(input: { channel: NotificationChannelV1; kind: StillLoanNoticeKindV1; keys: readonly string[] }): Promise<Set<string>>;
  /** This channel told this notice; telling it again changes nothing. */
  recordNotice(input: StillLoanNoticeRecordV1): Promise<void>;
}

const WALLET_V1 = /^0x[0-9a-f]{40}$/;
const MARKET_V1 = /^0x[0-9a-f]{40}([0-9a-f]{24})?$/;
const NOTICE_MARKET_V1 = /^[A-Za-z0-9:_.-]{1,200}$/;
/** Postgres repeats a regex atom at most 255 times; the longest key, a wallet's market and week, is 134. */
const NOTICE_KEY_V1 = /^[A-Za-z0-9:_.|-]{1,255}$/;
const ATOMIC_V1 = /^(0|[1-9][0-9]{0,77})$/;
const YEAR_SECONDS_V1 = 31_536_000n;
/** With no rate read, a growth up to this rate a year still reads as interest; nothing is estimated from it. */
const UNREAD_RATE_BOUND_BPS_V1 = 10_000n;

/** How bad a band is; a higher rank is a worse one. */
export function stillLoanStateRankV1(state: StillLoanStateV1): number {
  return STILL_LOAN_STATES_V1.indexOf(state);
}

/** The key a hold episode is told under. */
export function stillLoanHoldKeyV1(loan: Pick<StillLoanAlertV1, 'walletAddress' | 'market' | 'holdEpisode'>): string {
  return `${loan.walletAddress}|${loan.market}|${loan.holdEpisode}`;
}

/** The key a loan's week is told under. */
export function stillLoanWeekKeyV1(loan: Pick<StillLoanAlertV1, 'walletAddress' | 'market'>, weekCloseAt: string): string {
  return `${loan.walletAddress}|${loan.market}|${weekCloseAt}`;
}

/** The key a margin back is told under: the episode whose worse band it ends. */
export function stillLoanRecoveredKeyV1(loan: Pick<StillLoanAlertV1, 'walletAddress' | 'market' | 'episode'>): string {
  return `${loan.walletAddress}|${loan.market}|${loan.episode}`;
}

/** The key a rate jump is told under. */
export function stillLoanRateKeyV1(loan: Pick<StillLoanAlertV1, 'walletAddress' | 'market' | 'rateEpisode'>): string {
  return `${loan.walletAddress}|${loan.market}|${loan.rateEpisode}`;
}

/** The key a weekend band is told under: once per band per window, so a margin that wavers says nothing twice. */
export function stillLoanWeekendKeyV1(input: { walletAddress: string; market: string; windowStartsAt: string; state: StillLoanStateV1 }): string {
  return `${input.walletAddress}|${input.market}|${input.windowStartsAt}|${input.state}`;
}

/** How far a rate must rise over the one its owner heard of to be a jump: this many basis points, and half again. */
export const STILL_LOAN_RATE_JUMP_BPS_V1 = 200;

/** A rate is a jump over the one heard of when it is at least 2 points more and at least half again as much:
 * 3.66% jumps at 5.66%, 10% at 15%. */
export function stillLoanRateJumpedV1(toldBps: number, rateBps: number): boolean {
  return rateBps >= toldBps + STILL_LOAN_RATE_JUMP_BPS_V1 && rateBps * 2 >= toldBps * 3;
}

/** What a loan keeps of its rate between readings. */
export type StillLoanRateStateV1 = Pick<StillLoanAlertV1, 'rateToldBps' | 'rateToldAt' | 'rateHighSince' | 'rateEpisode'>;

/**
 * The rate state after a reading. A reading that said no rate changes nothing. The first rate read is the one
 * the owner is taken to have heard of: what Still showed when the loan was made. A jump over the rate heard of
 * starts a stretch, and the next episode, unless one is running; a rate that is no jump ends it.
 */
export function stillLoanRateAfterV1(before: StillLoanRateStateV1 | null, rateBps: number | null, at: string): StillLoanRateStateV1 {
  const prior: StillLoanRateStateV1 = before
    ? { rateToldBps: before.rateToldBps, rateToldAt: before.rateToldAt, rateHighSince: before.rateHighSince, rateEpisode: before.rateEpisode }
    : { rateToldBps: null, rateToldAt: null, rateHighSince: null, rateEpisode: 0 };
  if (rateBps === null) return prior;
  if (prior.rateToldBps === null) return { ...prior, rateToldBps: rateBps, rateToldAt: at, rateHighSince: null };
  if (!stillLoanRateJumpedV1(prior.rateToldBps, rateBps)) return { ...prior, rateHighSince: null };
  return prior.rateHighSince !== null ? prior : { ...prior, rateHighSince: at, rateEpisode: prior.rateEpisode + 1 };
}

/**
 * The interest one reading adds. The debt's growth since the reading before is
 * interest alone when it is no more than half again what the rate read before
 * charges over that stretch; a step down of one unit is rounding. Anything else
 * means a borrow or a repayment came between, and the stretch adds the rate's
 * charge instead, counted as estimated; with no rate read, it adds nothing.
 */
export function stillLoanInterestStepV1(input: {
  before: { debtAtomic: string | null; rateBps: number | null; readAt: string } | null;
  debtAtomic: string | null;
  at: Date;
}): { interest: bigint; estimated: bigint } {
  const none = { interest: 0n, estimated: 0n };
  const { before } = input;
  if (!before || before.debtAtomic === null || input.debtAtomic === null) return none;
  const from = BigInt(before.debtAtomic);
  const to = BigInt(input.debtAtomic);
  const ms = input.at.getTime() - Date.parse(before.readAt);
  if (from === 0n || !(ms >= 1_000)) return none;
  const seconds = BigInt(Math.floor(ms / 1_000));
  const rate = before.rateBps === null ? null : BigInt(before.rateBps);
  const charge = (from * (rate ?? UNREAD_RATE_BOUND_BPS_V1) * seconds) / (10_000n * YEAR_SECONDS_V1);
  const grew = to - from;
  if (grew >= 0n && grew <= charge + charge / 2n + 2n) return { interest: grew, estimated: 0n };
  if (grew === -1n || rate === null) return none;
  return { interest: charge, estimated: charge };
}

/** The holds after a reading, and whether one appeared that the row did not have. */
export function stillLoanHoldsAfterV1(before: readonly string[], reading: StillLoanHoldReadingV1 | undefined): { holds: string[]; appeared: boolean } {
  if (!reading) return { holds: [...before].sort(), appeared: false };
  const cleared = new Set(reading.cleared);
  const kept = before.filter((hold) => !cleared.has(hold));
  const appeared = reading.held.some((hold) => !before.includes(hold));
  return { holds: [...new Set([...kept, ...reading.held])].sort(), appeared };
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

function assertRateV1(rateBps: number): void {
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 1_000_000) throw new RouteStorageIntegrityError('a rate is whole basis points from 0 to 1000000');
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
    if (line.debtAtomic != null && !ATOMIC_V1.test(line.debtAtomic)) throw new RouteStorageIntegrityError('a debt is whole USDC base units');
    if (line.rateBps != null) assertRateV1(line.rateBps);
    if (line.holds && [...line.holds.held, ...line.holds.cleared].some((hold) => !HOLD_V1.test(hold))) {
      throw new RouteStorageIntegrityError("a hold is 'SYMBOL:kind'");
    }
  }
  for (const market of input.unread) assertMarketV1(market);
}

function assertNoticesAskedV1(input: { channel: string; kind: string; keys: readonly string[] }): void {
  assertChannelV1(input.channel);
  if (!(STILL_LOAN_NOTICE_KINDS_V1 as readonly string[]).includes(input.kind)) throw new RouteStorageIntegrityError(`unknown loan notice: ${input.kind}`);
  if (input.keys.length > 500 || input.keys.some((key) => !NOTICE_KEY_V1.test(key))) throw new RouteStorageIntegrityError('a notice key is short plain text');
}

function assertNoticeV1(input: StillLoanNoticeRecordV1): void {
  assertChannelV1(input.channel);
  assertWalletV1(input.walletAddress);
  if (!(STILL_LOAN_NOTICE_KINDS_V1 as readonly string[]).includes(input.kind)) throw new RouteStorageIntegrityError(`unknown loan notice: ${input.kind}`);
  if (!NOTICE_KEY_V1.test(input.key)) throw new RouteStorageIntegrityError('a notice key is short plain text');
  if (!NOTICE_MARKET_V1.test(input.market)) throw new RouteStorageIntegrityError('a notice names a loan market');
  const week = input.kind === 'week';
  const counted = input.interestAtomic !== undefined && input.estimatedAtomic !== undefined
    && ATOMIC_V1.test(input.interestAtomic) && ATOMIC_V1.test(input.estimatedAtomic)
    && BigInt(input.estimatedAtomic) <= BigInt(input.interestAtomic);
  if (week !== counted || (!week && (input.interestAtomic !== undefined || input.estimatedAtomic !== undefined))) {
    throw new RouteStorageIntegrityError("only a week's note counts interest, and it always does");
  }
}

/** The in-memory store: refuses what the table refuses, and moves episodes
 * the way the SQL does. */
export class InMemoryStillLoanAlertRepositoryV1 implements StillLoanAlertRepositoryV1 {
  private readonly loans = new Map<string, StillLoanAlertV1>();
  private readonly notices = new Map<string, StillLoanNoticeRecordV1>();
  /** Test seam: the wallets with a Still borrow that went to the wallet (any state but `ready`). */
  readonly confirmedBorrowers = new Set<string>();
  /** Test seam: confirmed borrows through Still, as `openedDue` reads them. */
  readonly confirmedLoans: StillLoanOpenedV1[] = [];
  /** Test seam: confirmed repayments through Still, as `closedDue` reads them; it keeps those that left no debt. */
  readonly confirmedRepays: StillLoanClosedV1[] = [];

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
        const { holds, appeared } = stillLoanHoldsAfterV1([], line.holds);
        this.loans.set(key, {
          walletAddress: input.walletAddress, market: line.market, venue: line.venue, state: line.state, marginBps: line.marginBps,
          episode: line.state === 'calm' ? 0 : 1, createdAt: at, readAt: at, readBlock: input.block,
          told: { base_app: null, telegram: null },
          debtAtomic: line.debtAtomic ?? null, rateBps: line.rateBps ?? null, rateReadAt: line.rateBps != null ? at : null,
          interestAtomic: '0', estimatedAtomic: '0', holds, holdEpisode: appeared ? 1 : 0,
          stateSince: at, ...stillLoanRateAfterV1(null, line.rateBps ?? null, at),
        });
        continue;
      }
      if (BigInt(row.readBlock) > BigInt(input.block)) continue;
      const step = stillLoanInterestStepV1({ before: row, debtAtomic: line.debtAtomic ?? null, at: input.at });
      const { holds, appeared } = stillLoanHoldsAfterV1(row.holds, line.holds);
      Object.assign(row, {
        episode: row.episode + (stillLoanStateRankV1(line.state) > stillLoanStateRankV1(row.state) ? 1 : 0),
        stateSince: line.state === row.state ? row.stateSince : at,
        venue: line.venue, state: line.state, marginBps: line.marginBps, readAt: at, readBlock: input.block,
        debtAtomic: line.debtAtomic ?? row.debtAtomic, rateBps: line.rateBps ?? row.rateBps,
        rateReadAt: line.rateBps != null ? at : row.rateReadAt,
        interestAtomic: (BigInt(row.interestAtomic) + step.interest).toString(),
        estimatedAtomic: (BigInt(row.estimatedAtomic) + step.estimated).toString(),
        holds, holdEpisode: row.holdEpisode + (appeared ? 1 : 0),
        ...stillLoanRateAfterV1(row, line.rateBps ?? null, at),
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
      .sort(byLoanV1)
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

  async holdsDue(input: { channel: NotificationChannelV1; freshSince: Date }): Promise<StillLoanAlertV1[]> {
    assertChannelV1(input.channel);
    return [...this.loans.values()]
      .filter((loan) => loan.holdEpisode > 0 && loan.holds.length > 0 && Date.parse(loan.readAt) >= input.freshSince.getTime()
        && !this.notices.has(`${input.channel}|hold|${stillLoanHoldKeyV1(loan)}`))
      .sort(byLoanV1)
      .map((loan) => structuredClone(loan));
  }

  async weekDue(input: { channel: NotificationChannelV1; weekCloseAt: string; freshSince: Date; firstReadBy: Date }): Promise<StillLoanWeekDueV1[]> {
    assertChannelV1(input.channel);
    return [...this.loans.values()]
      .filter((loan) => loan.debtAtomic !== null && BigInt(loan.debtAtomic) > 0n
        && Date.parse(loan.readAt) >= input.freshSince.getTime() && Date.parse(loan.createdAt) <= input.firstReadBy.getTime()
        && !this.notices.has(`${input.channel}|week|${stillLoanWeekKeyV1(loan, input.weekCloseAt)}`))
      .sort(byLoanV1)
      .map((loan) => {
        const last = [...this.notices.values()]
          .filter((notice) => notice.channel === input.channel && notice.kind === 'week' && notice.walletAddress === loan.walletAddress
            && notice.market === loan.market && notice.at.getTime() >= Date.parse(loan.createdAt))
          .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
        return {
          loan: structuredClone(loan),
          since: last ? last.at.toISOString() : loan.createdAt,
          interestBeforeAtomic: last?.interestAtomic ?? '0',
          estimatedBeforeAtomic: last?.estimatedAtomic ?? '0',
        };
      });
  }

  async openedDue(input: { channel: NotificationChannelV1; wallets: readonly string[]; since: Date }): Promise<StillLoanOpenedV1[]> {
    assertChannelV1(input.channel);
    const wallets = new Set(input.wallets);
    return this.confirmedLoans
      .filter((loan) => wallets.has(loan.walletAddress) && Date.parse(loan.confirmedAt) >= input.since.getTime()
        && !this.notices.has(`${input.channel}|opened|${loan.executionId}`))
      .sort((a, b) => Date.parse(a.confirmedAt) - Date.parse(b.confirmedAt) || a.executionId.localeCompare(b.executionId))
      .map((loan) => structuredClone(loan));
  }

  async closedDue(input: { channel: NotificationChannelV1; wallets: readonly string[]; since: Date }): Promise<StillLoanClosedV1[]> {
    assertChannelV1(input.channel);
    const wallets = new Set(input.wallets);
    return this.confirmedRepays
      .filter((repay) => wallets.has(repay.walletAddress) && Date.parse(repay.confirmedAt) >= input.since.getTime()
        && repay.proof?.remainingDebtAssets === '0' && !this.notices.has(`${input.channel}|closed|${repay.executionId}`))
      .sort((a, b) => Date.parse(a.confirmedAt) - Date.parse(b.confirmedAt) || a.executionId.localeCompare(b.executionId))
      .map((repay) => structuredClone(repay));
  }

  async recoveredDue(input: { channel: NotificationChannelV1; freshSince: Date }): Promise<StillLoanAlertV1[]> {
    assertChannelV1(input.channel);
    return [...this.loans.values()]
      .filter((loan) => loan.state === 'calm' && loan.episode > 0 && loan.told[input.channel] === loan.episode
        && Date.parse(loan.stateSince) < Date.parse(loan.readAt) && Date.parse(loan.readAt) >= input.freshSince.getTime()
        && !this.notices.has(`${input.channel}|recovered|${stillLoanRecoveredKeyV1(loan)}`))
      .sort(byLoanV1)
      .map((loan) => structuredClone(loan));
  }

  async rateDue(input: { channel: NotificationChannelV1; freshSince: Date; highSince: Date }): Promise<StillLoanAlertV1[]> {
    assertChannelV1(input.channel);
    return [...this.loans.values()]
      .filter((loan) => loan.rateHighSince !== null && Date.parse(loan.rateHighSince) <= input.highSince.getTime()
        && loan.rateBps !== null && loan.rateToldBps !== null && loan.debtAtomic !== null && BigInt(loan.debtAtomic) > 0n
        && Date.parse(loan.readAt) >= input.freshSince.getTime()
        && !this.notices.has(`${input.channel}|rate|${stillLoanRateKeyV1(loan)}`))
      .sort(byLoanV1)
      .map((loan) => structuredClone(loan));
  }

  async markRateTold(input: { walletAddress: string; market: string; rateBps: number; at: Date }): Promise<void> {
    assertWalletV1(input.walletAddress);
    assertMarketV1(input.market);
    assertRateV1(input.rateBps);
    const loan = this.loans.get(`${input.walletAddress}|${input.market}`);
    if (!loan) return;
    Object.assign(loan, { rateToldBps: input.rateBps, rateToldAt: input.at.toISOString(), rateHighSince: null });
  }

  async noticesTold(input: { channel: NotificationChannelV1; kind: StillLoanNoticeKindV1; keys: readonly string[] }): Promise<Set<string>> {
    assertNoticesAskedV1(input);
    return new Set(input.keys.filter((key) => this.notices.has(`${input.channel}|${input.kind}|${key}`)));
  }

  async recordNotice(input: StillLoanNoticeRecordV1): Promise<void> {
    assertNoticeV1(input);
    const key = `${input.channel}|${input.kind}|${input.key}`;
    if (!this.notices.has(key)) this.notices.set(key, { ...input, at: new Date(input.at) });
  }
}

function byLoanV1(a: StillLoanAlertV1, b: StillLoanAlertV1): number {
  return a.walletAddress.localeCompare(b.walletAddress) || a.market.localeCompare(b.market);
}

function loanOfRowV1(row: Record<string, unknown>): StillLoanAlertV1 {
  const at = (value: unknown) => new Date(value as string | Date).toISOString();
  const int = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
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
    debtAtomic: text(row.debt_atomic),
    rateBps: int(row.rate_bps),
    rateReadAt: row.rate_read_at == null ? null : at(row.rate_read_at),
    interestAtomic: text(row.interest_atomic) ?? '0',
    estimatedAtomic: text(row.estimated_atomic) ?? '0',
    holds: Array.isArray(row.holds) ? row.holds.map(String).sort() : [],
    holdEpisode: Number(row.hold_episode ?? 0),
    // A row written before migration 0100 entered its band no later than its last reading.
    stateSince: at(row.state_since ?? row.read_at),
    rateToldBps: int(row.rate_told_bps),
    rateToldAt: row.rate_told_at == null ? null : at(row.rate_told_at),
    rateHighSince: row.rate_high_since == null ? null : at(row.rate_high_since),
    rateEpisode: Number(row.rate_episode ?? 0),
  };
}

function jsonObjectV1(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** A landed execution as a notice reads it; none when its review left no facts. */
function receiptOfRowV1(row: Record<string, unknown>): StillLoanReceiptV1[] {
  const facts = jsonObjectV1(row.facts);
  if (!facts) return [];
  return [{
    executionId: String(row.execution_id),
    walletAddress: String(row.wallet_address),
    venue: String(row.venue) as StillLoanVenueV1,
    marketId: String(row.market_id),
    confirmedAt: new Date(row.updated_at as string | Date).toISOString(),
    facts,
    proof: jsonObjectV1(row.proof),
  }];
}

/** Each loan's change is one statement, so two passes cannot interleave into
 * an episode neither meant. The interest and holds a reading adds are worked
 * out from the row as read just before, and written only if the row is still
 * that row. */
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
        const [row] = (await sql`
          SELECT debt_atomic, rate_bps, read_at, read_block, holds, state, state_since,
                 rate_told_bps, rate_told_at, rate_high_since, rate_episode
            FROM still_loan_alerts
           WHERE wallet_address = ${input.walletAddress} AND market = ${line.market}`) as Record<string, unknown>[];
        const iso = (value: unknown) => new Date(value as string | Date).toISOString();
        const before = row
          ? { debtAtomic: row.debt_atomic == null ? null : String(row.debt_atomic), rateBps: row.rate_bps == null ? null : Number(row.rate_bps),
            readAt: iso(row.read_at), readBlock: String(row.read_block),
            holds: Array.isArray(row.holds) ? row.holds.map(String) : [],
            state: String(row.state), stateSince: iso(row.state_since ?? row.read_at),
            rateToldBps: row.rate_told_bps == null ? null : Number(row.rate_told_bps),
            rateToldAt: row.rate_told_at == null ? null : iso(row.rate_told_at),
            rateHighSince: row.rate_high_since == null ? null : iso(row.rate_high_since),
            rateEpisode: Number(row.rate_episode ?? 0) }
          : null;
        const step = stillLoanInterestStepV1({ before, debtAtomic: line.debtAtomic ?? null, at: input.at });
        const { holds, appeared } = stillLoanHoldsAfterV1(before?.holds ?? [], line.holds);
        const stateSince = before && before.state === line.state ? before.stateSince : at;
        const rate = stillLoanRateAfterV1(before, line.rateBps ?? null, at);
        await sql`
          INSERT INTO still_loan_alerts AS a
            (wallet_address, market, venue, state, margin_bps, episode, created_at, read_at, read_block,
             debt_atomic, rate_bps, rate_read_at, interest_atomic, estimated_atomic, holds, hold_episode,
             state_since, rate_told_bps, rate_told_at, rate_high_since, rate_episode)
          VALUES (${input.walletAddress}, ${line.market}, ${line.venue}, ${line.state}, ${line.marginBps},
                  ${line.state === 'calm' ? 0 : 1}, ${at}::timestamptz, ${at}::timestamptz, ${input.block}::bigint,
                  ${line.debtAtomic ?? null}::numeric, ${line.rateBps ?? null}::integer, ${line.rateBps != null ? at : null}::timestamptz,
                  0, 0, ${holds}::text[], ${appeared ? 1 : 0},
                  ${stateSince}::timestamptz, ${rate.rateToldBps}::integer, ${rate.rateToldAt}::timestamptz,
                  ${rate.rateHighSince}::timestamptz, ${rate.rateEpisode}::int)
          ON CONFLICT (wallet_address, market) DO UPDATE
             SET episode = a.episode + CASE
                   WHEN ${rank}::int > array_position(ARRAY['calm', 'watch', 'act', 'liquidation'], a.state) - 1
                   THEN 1 ELSE 0 END,
                 venue = EXCLUDED.venue,
                 state = EXCLUDED.state,
                 margin_bps = EXCLUDED.margin_bps,
                 read_at = EXCLUDED.read_at,
                 read_block = EXCLUDED.read_block,
                 debt_atomic = COALESCE(EXCLUDED.debt_atomic, a.debt_atomic),
                 rate_bps = COALESCE(EXCLUDED.rate_bps, a.rate_bps),
                 rate_read_at = CASE WHEN EXCLUDED.rate_bps IS NULL THEN a.rate_read_at ELSE EXCLUDED.read_at END,
                 interest_atomic = a.interest_atomic + ${step.interest.toString()}::numeric,
                 estimated_atomic = a.estimated_atomic + ${step.estimated.toString()}::numeric,
                 holds = EXCLUDED.holds,
                 hold_episode = a.hold_episode + ${appeared ? 1 : 0}::int,
                 state_since = EXCLUDED.state_since,
                 rate_told_bps = EXCLUDED.rate_told_bps,
                 rate_told_at = EXCLUDED.rate_told_at,
                 rate_high_since = EXCLUDED.rate_high_since,
                 rate_episode = EXCLUDED.rate_episode
           WHERE a.read_block <= EXCLUDED.read_block
             AND a.read_block = ${before ? before.readBlock : '0'}::bigint`;
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

    async holdsDue(input) {
      assertChannelV1(input.channel);
      const rows = (await sql`
        SELECT a.* FROM still_loan_alerts a
         WHERE a.hold_episode > 0 AND cardinality(a.holds) > 0
           AND a.read_at >= ${input.freshSince.toISOString()}::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM still_loan_notices n
              WHERE n.channel = ${input.channel} AND n.kind = 'hold'
                AND n.notice_key = a.wallet_address || '|' || a.market || '|' || a.hold_episode::text)
         ORDER BY a.wallet_address, a.market`) as Record<string, unknown>[];
      return rows.map(loanOfRowV1);
    },

    async weekDue(input) {
      assertChannelV1(input.channel);
      if (!NOTICE_KEY_V1.test(input.weekCloseAt)) throw new RouteStorageIntegrityError('a week is named by its close');
      const rows = (await sql`
        SELECT a.*, w.told_at AS week_told_at, w.interest_atomic AS week_interest, w.estimated_atomic AS week_estimated
          FROM still_loan_alerts a
          LEFT JOIN LATERAL (
            SELECT n.told_at, n.interest_atomic, n.estimated_atomic FROM still_loan_notices n
             WHERE n.channel = ${input.channel} AND n.kind = 'week'
               AND n.wallet_address = a.wallet_address AND n.market = a.market AND n.told_at >= a.created_at
             ORDER BY n.told_at DESC LIMIT 1) w ON true
         WHERE a.debt_atomic > 0
           AND a.read_at >= ${input.freshSince.toISOString()}::timestamptz
           AND a.created_at <= ${input.firstReadBy.toISOString()}::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM still_loan_notices n
              WHERE n.channel = ${input.channel} AND n.kind = 'week'
                AND n.notice_key = a.wallet_address || '|' || a.market || '|' || ${input.weekCloseAt}::text)
         ORDER BY a.wallet_address, a.market`) as Record<string, unknown>[];
      return rows.map((row) => {
        const loan = loanOfRowV1(row);
        return {
          loan,
          since: row.week_told_at == null ? loan.createdAt : new Date(row.week_told_at as string | Date).toISOString(),
          interestBeforeAtomic: row.week_interest == null ? '0' : String(row.week_interest),
          estimatedBeforeAtomic: row.week_estimated == null ? '0' : String(row.week_estimated),
        };
      });
    },

    async openedDue(input) {
      assertChannelV1(input.channel);
      const wallets = input.wallets.filter((wallet) => WALLET_V1.test(wallet));
      if (wallets.length === 0) return [];
      const rows = (await sql`
        SELECT e.execution_id::text AS execution_id, e.wallet_address, e.venue, e.market_id, e.updated_at,
               e.run_json -> 'facts' AS facts, e.verification_json -> 'effect' AS proof
          FROM lending_executions e
         WHERE e.operation = 'borrow' AND e.state = 'confirmed'
           AND e.updated_at >= ${input.since.toISOString()}::timestamptz
           AND e.wallet_address = ANY(${wallets}::text[])
           AND NOT EXISTS (
             SELECT 1 FROM still_loan_notices n
              WHERE n.channel = ${input.channel} AND n.kind = 'opened' AND n.notice_key = e.execution_id::text)
         ORDER BY e.updated_at, e.execution_id
         LIMIT 50`) as Record<string, unknown>[];
      return rows.flatMap(receiptOfRowV1);
    },

    async closedDue(input) {
      assertChannelV1(input.channel);
      const wallets = input.wallets.filter((wallet) => WALLET_V1.test(wallet));
      if (wallets.length === 0) return [];
      const rows = (await sql`
        SELECT e.execution_id::text AS execution_id, e.wallet_address, e.venue, e.market_id, e.updated_at,
               e.run_json -> 'facts' AS facts, e.verification_json -> 'effect' AS proof
          FROM lending_executions e
         WHERE e.operation = 'repay' AND e.state = 'confirmed'
           AND e.verification_json -> 'effect' ->> 'remainingDebtAssets' = '0'
           AND e.updated_at >= ${input.since.toISOString()}::timestamptz
           AND e.wallet_address = ANY(${wallets}::text[])
           AND NOT EXISTS (
             SELECT 1 FROM still_loan_notices n
              WHERE n.channel = ${input.channel} AND n.kind = 'closed' AND n.notice_key = e.execution_id::text)
         ORDER BY e.updated_at, e.execution_id
         LIMIT 50`) as Record<string, unknown>[];
      return rows.flatMap(receiptOfRowV1);
    },

    async recoveredDue(input) {
      assertChannelV1(input.channel);
      const rows = (await sql`
        SELECT a.* FROM still_loan_alerts a
         WHERE a.state = 'calm' AND a.episode > 0
           AND (CASE WHEN ${input.channel}::text = 'base_app' THEN a.told_base_app ELSE a.told_telegram END) = a.episode
           AND COALESCE(a.state_since, a.read_at) < a.read_at
           AND a.read_at >= ${input.freshSince.toISOString()}::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM still_loan_notices n
              WHERE n.channel = ${input.channel} AND n.kind = 'recovered'
                AND n.notice_key = a.wallet_address || '|' || a.market || '|' || a.episode::text)
         ORDER BY a.wallet_address, a.market`) as Record<string, unknown>[];
      return rows.map(loanOfRowV1);
    },

    async rateDue(input) {
      assertChannelV1(input.channel);
      const rows = (await sql`
        SELECT a.* FROM still_loan_alerts a
         WHERE a.rate_high_since IS NOT NULL
           AND a.rate_high_since <= ${input.highSince.toISOString()}::timestamptz
           AND a.rate_bps IS NOT NULL AND a.rate_told_bps IS NOT NULL AND a.debt_atomic > 0
           AND a.read_at >= ${input.freshSince.toISOString()}::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM still_loan_notices n
              WHERE n.channel = ${input.channel} AND n.kind = 'rate'
                AND n.notice_key = a.wallet_address || '|' || a.market || '|' || a.rate_episode::text)
         ORDER BY a.wallet_address, a.market`) as Record<string, unknown>[];
      return rows.map(loanOfRowV1);
    },

    async markRateTold(input) {
      assertWalletV1(input.walletAddress);
      assertMarketV1(input.market);
      assertRateV1(input.rateBps);
      await sql`
        UPDATE still_loan_alerts
           SET rate_told_bps = ${input.rateBps}, rate_told_at = ${input.at.toISOString()}::timestamptz, rate_high_since = NULL
         WHERE wallet_address = ${input.walletAddress} AND market = ${input.market}`;
    },

    async noticesTold(input) {
      assertNoticesAskedV1(input);
      if (input.keys.length === 0) return new Set<string>();
      const rows = (await sql`
        SELECT notice_key FROM still_loan_notices
         WHERE channel = ${input.channel} AND kind = ${input.kind} AND notice_key = ANY(${[...input.keys]}::text[])`) as Record<string, unknown>[];
      return new Set(rows.map((row) => String(row.notice_key)));
    },

    async recordNotice(input) {
      assertNoticeV1(input);
      await sql`
        INSERT INTO still_loan_notices
          (channel, kind, notice_key, wallet_address, market, interest_atomic, estimated_atomic, told_at)
        VALUES (${input.channel}, ${input.kind}, ${input.key}, ${input.walletAddress}, ${input.market},
                ${input.interestAtomic ?? null}::numeric, ${input.estimatedAtomic ?? null}::numeric, ${input.at.toISOString()}::timestamptz)
        ON CONFLICT (channel, kind, notice_key) DO NOTHING`;
    },
  };
}
