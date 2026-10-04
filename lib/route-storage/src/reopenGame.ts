import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// Call the reopen: rounds, players and their picks.
//
// A round is stored in three stages, each written once: the stocks and their
// Friday close when it opens, Base's calls once picks have closed, and the
// results once the feeds reopened. Nothing is ever rewritten: a stage computed
// again later would come out the same, and a stored one is what the players
// were shown.
//
// A player is a wallet (`w:<address>`), or a device (`d:<sha256>`) that played
// without signing in. The device keeps a random token and only its hash is
// stored here. Signing in moves the device's picks to the wallet, so a streak
// started without a wallet is not lost, and the device stops being a player.
//
// What a pick may say is the caller's business (the round's own stocks, up or
// down). What this module guarantees is WHEN: a pick lands only before its
// round locks, checked in the same statement that writes it.
// ---------------------------------------------------------------------------

export type ReopenSideV1 = 'up' | 'down';

export interface ReopenRoundRowV1 {
  roundId: string;
  number: number;
  closeAt: string;
  opensAt: string;
  locksAt: string;
  expectedReopenAt: string;
  nextSessionCloseAt: string;
  /** The stocks as frozen at the open; the caller's schema reads them. */
  stocks: unknown[];
  calls: unknown[] | null;
  calledAt: string | null;
  results: unknown[] | null;
  settledAt: string | null;
  createdAt: string;
}

export interface ReopenRoundOpeningV1 {
  roundId: string;
  closeAt: string;
  opensAt: string;
  locksAt: string;
  expectedReopenAt: string;
  nextSessionCloseAt: string;
  stocks: unknown[];
}

export interface ReopenPicksRowV1 {
  roundId: string;
  picks: Record<string, ReopenSideV1>;
  pickedAt: string;
}

/** One player's picks in one round, with the number they are known by. */
export interface ReopenPlayerPicksV1 {
  roundId: string;
  playerId: string;
  /** In the order players joined. The board names a player by it unless a
   * Basename stands in: a number reveals nothing about a wallet. */
  playerNumber: number;
  picks: Record<string, ReopenSideV1>;
}

export interface ReopenCrowdV1 {
  players: number;
  split: Record<string, { up: number; down: number }>;
}

export interface ReopenGameRepositoryV1 {
  round(roundId: string): Promise<ReopenRoundRowV1 | null>;
  /** Newest first. */
  rounds(limit: number): Promise<ReopenRoundRowV1[]>;
  /** Opens a round once and numbers it after every round before it. Whoever
   * loses a race gets the row the winner wrote. */
  openRound(input: { opening: ReopenRoundOpeningV1; now: Date }): Promise<ReopenRoundRowV1>;
  /** Base's calls, once, and never before the lock. */
  fixCalls(input: { roundId: string; calls: unknown[]; at: Date }): Promise<ReopenRoundRowV1 | null>;
  /** The results, once, after the calls and never before the expected reopen. */
  settle(input: { roundId: string; results: unknown[]; at: Date }): Promise<ReopenRoundRowV1 | null>;

  /** The player for a wallet, created on first use. */
  walletPlayer(input: { wallet: string; now: Date }): Promise<string>;
  /** A device's player, created now. Refuses a hash already used. */
  createDevicePlayer(input: { tokenHash: string; now: Date }): Promise<string>;
  /** The device's player while it still plays; null once merged or unknown. */
  devicePlayer(tokenHash: string): Promise<string | null>;
  /** Replaces the player's picks for the round, only before the round locks. */
  savePicks(input: {
    roundId: string;
    playerId: string;
    picks: Record<string, ReopenSideV1>;
    now: Date;
  }): Promise<'saved' | 'locked' | 'unknown_round'>;
  picksOf(playerId: string): Promise<ReopenPicksRowV1[]>;
  /** How many played the round, and how they split per stock. */
  crowd(roundId: string): Promise<ReopenCrowdV1>;
  /** Every non-empty pick in every settled round: the leaderboard's input. */
  standings(): Promise<ReopenPlayerPicksV1[]>;
  /** Every non-empty pick in one round. */
  roundPicks(roundId: string): Promise<ReopenPlayerPicksV1[]>;
  /**
   * Moves the device's picks to the wallet's player. Where both picked the
   * same round the wallet's stand and the device's go, so nobody is counted
   * twice. Null when the device is unknown or already merged.
   */
  mergeDevice(input: { tokenHash: string; wallet: string; now: Date }): Promise<{ moved: number; dropped: number } | null>;
}

const ROUND_ID_V1 = /^\d{4}-\d{2}-\d{2}$/;
const WALLET_V1 = /^0x[0-9a-f]{40}$/;
const HASH_V1 = /^[0-9a-f]{64}$/;
const PLAYER_V1 = /^(w:0x[0-9a-f]{40}|d:[0-9a-f]{64})$/;
const SYMBOL_V1 = /^[A-Z0-9.]{1,12}$/;

export function assertReopenRoundIdV1(roundId: string): void {
  if (!ROUND_ID_V1.test(roundId)) throw new RouteStorageIntegrityError('a round is named by a New York date');
}

export function assertReopenWalletV1(wallet: string): void {
  if (!WALLET_V1.test(wallet)) throw new RouteStorageIntegrityError('a wallet is a lowercase address');
}

export function assertReopenTokenHashV1(tokenHash: string): void {
  if (!HASH_V1.test(tokenHash)) throw new RouteStorageIntegrityError('a device is stored as a SHA-256 hash');
}

export function assertReopenPlayerV1(playerId: string): void {
  if (!PLAYER_V1.test(playerId)) throw new RouteStorageIntegrityError('a player is a wallet or a device hash');
}

export function assertReopenPicksV1(picks: Record<string, ReopenSideV1>): void {
  const entries = Object.entries(picks);
  if (entries.length > 12) throw new RouteStorageIntegrityError('too many picks for one round');
  for (const [symbol, side] of entries) {
    if (!SYMBOL_V1.test(symbol) || (side !== 'up' && side !== 'down')) {
      throw new RouteStorageIntegrityError('a pick is a symbol and up or down');
    }
  }
}

export function assertReopenOpeningV1(opening: ReopenRoundOpeningV1): void {
  assertReopenRoundIdV1(opening.roundId);
  const order = [opening.closeAt, opening.opensAt, opening.locksAt, opening.expectedReopenAt, opening.nextSessionCloseAt].map(
    (value) => Date.parse(value),
  );
  if (order.some((value) => !Number.isFinite(value)) || order.some((value, index) => index > 0 && value <= order[index - 1]!)) {
    throw new RouteStorageIntegrityError('a round runs close < open < lock < reopen < next close');
  }
  if (!Array.isArray(opening.stocks)) throw new RouteStorageIntegrityError('a round holds a list of stocks');
}

export const reopenWalletPlayerIdV1 = (wallet: string): string => `w:${wallet}`;
export const reopenDevicePlayerIdV1 = (tokenHash: string): string => `d:${tokenHash}`;
