import { RouteStorageConflictError } from './types.js';

// ---------------------------------------------------------------------------
// T68B — the watchlist a background sweep reads.
//
// This table exists because "watch" that only runs while a page is open is not
// watching, it is checking. Nothing changes while the user is away, so there is
// nothing to come back for. A sweep that runs without anyone present needs a
// durable answer to one question — WHICH tokens — and the browser's
// localStorage cannot give it one.
//
// What it deliberately does not become:
//
//   * A discovery list. Only addresses a user typed in go here. Miorail does
//     not decide on someone's behalf what is worth watching, and a list seeded
//     from a portfolio feed would silently miss every B20 token anyway — no
//     balance provider indexes them.
//   * Unbounded. A user may watch at most `B20_WATCHLIST_CAPACITY_V1` tokens.
//     Each one is a recurring on-chain cost paid by the operator, forever,
//     without anybody watching the meter.
//   * A queue with a memory. The sweep records WHEN a token was last read and
//     what came of it; it does not accumulate a backlog. A run that misses a
//     token is not owed that read later — it simply reads it next time, and the
//     page states the age of what it has.
// ---------------------------------------------------------------------------

/**
 * How many tokens one account may keep under background watch.
 *
 * Matched to the interactive sweep's budget on purpose: a user should not be
 * able to build a watchlist the "Read B20 controls" button cannot read in one request,
 * or the two surfaces would disagree about what is being watched.
 */
export const B20_WATCHLIST_CAPACITY_V1 = 25;

export type B20WatchSweepOutcomeV1 = 'read' | 'not_b20' | 'unreadable';

export interface B20WatchlistEntryV1 {
  id: string;
  userId: string;
  chainId: number;
  tokenAddress: string;
  createdAt: string;
  /** When a sweep last READ this token, background or interactive. Null means
   * it has been added but never reached. */
  lastSweptAt: string | null;
  /** What that read produced. Null alongside a null `lastSweptAt`. */
  lastOutcome: B20WatchSweepOutcomeV1 | null;
  /**
   * When the controls were last actually READ — the age of the evidence, as
   * opposed to the age of the last attempt.
   *
   * They were one field until migration 0067, so a token read three weeks ago
   * and unreachable this morning reported this morning, and the reading still
   * on screen had no timestamp anywhere. `not_b20` does not refresh this
   * either: it is a true answer about the address that establishes nothing
   * about any control.
   *
   * Null means no successful read is recorded. For rows that predate 0067 and
   * whose last attempt failed, that is the honest answer — the instant was
   * overwritten and is not recoverable.
   */
  lastReadAt: string | null;
}

export interface B20WatchlistRepositoryV1 {
  /** Idempotent. Adding a token already on the list returns the existing row
   * rather than a second one, so a double-click is not two reads forever. */
  addToken(input: { userId: string; tokenAddress: string; now: Date }): Promise<B20WatchlistEntryV1>;
  removeToken(userId: string, tokenAddress: string): Promise<boolean>;
  listForUser(userId: string): Promise<B20WatchlistEntryV1[]>;
  /**
   * Entries the background sweep should read next, across ALL accounts.
   *
   * Ordered by how long they have gone unread, never-read first, so no account
   * can starve another by holding a large list: the run takes the oldest
   * `limit` entries and stops, and the next run continues from wherever this
   * one left the clock.
   */
  dueForSweep(input: { limit: number; sweptBefore: Date }): Promise<B20WatchlistEntryV1[]>;
  /** Records that a sweep reached this entry. Never fails a sweep: the read
   * already happened and its snapshot is already stored. */
  recordSweep(input: { id: string; at: Date; outcome: B20WatchSweepOutcomeV1 }): Promise<void>;

  /**
   * Every address under watch, once, across all accounts.
   *
   * The dedupe rule made concrete: two people watching one token is one
   * address, one schedule and one measurement. Reading this rather than the
   * entry list is what stops the operator paying twice for the same answer,
   * and it is the only number the capacity model takes from storage.
   */
  distinctWatchedAddresses(input: { chainId: number; limit: number }): Promise<string[]>;
}

export type B20WatchlistAddEffectV1 =
  | { effect: 'insert' }
  | { effect: 'return_existing' }
  | { effect: 'at_capacity'; reason: string };

/**
 * What adding a token must do.
 *
 * Shared by the in-memory fake and Postgres, because a fake that accepts what
 * the database refuses is how three T65 production bugs reached production. The
 * capacity check lives here rather than in a CHECK constraint for the plain
 * reason that SQL cannot express "at most N rows per user" in one — so it is
 * expressed once, in code both implementations call.
 */
export function b20WatchlistAddEffectV1(input: {
  existing: B20WatchlistEntryV1 | null;
  currentCount: number;
}): B20WatchlistAddEffectV1 {
  if (input.existing) return { effect: 'return_existing' };
  if (input.currentCount >= B20_WATCHLIST_CAPACITY_V1) {
    return {
      effect: 'at_capacity',
      reason: `A watchlist holds at most ${B20_WATCHLIST_CAPACITY_V1} tokens. Remove one to add another.`,
    };
  }
  return { effect: 'insert' };
}

export function b20WatchlistFullV1(reason: string): RouteStorageConflictError {
  return new RouteStorageConflictError(reason);
}

/** A stable id for a watch entry, so the same account watching the same token
 * is the same row whichever surface added it. */
export function b20WatchlistIdV1(userId: string, tokenAddress: string): string {
  return `b20-watch:${userId}:${tokenAddress.toLowerCase()}`;
}

/**
 * Which of the sweep's three outcomes a snapshot's detection maps to.
 *
 * `not_b20` is kept separate from `unreadable` because it is an ORDINARY
 * answer: most addresses are not B20, and a list that showed them as failures
 * would teach a user to ignore the failures that matter.
 */
export function b20SweepOutcomeFromDetectionV1(outcome: string): B20WatchSweepOutcomeV1 {
  if (outcome === 'not_b20') return 'not_b20';
  if (outcome === 'b20' || outcome === 'b20_uninitialised') return 'read';
  return 'unreadable';
}
