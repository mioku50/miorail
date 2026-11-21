import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// The reopen lineup's ladder pass goes first (audit 11-20 OPS-1).
//
// Call the reopen settles on the first reference price a public-ladder run
// recorded after the feeds print again, and a full pass over the corpus takes
// half an hour. So the game's five stocks have a short pass of their own at the
// moments the game is about, and while it runs the hourly pass waits between
// assets: both ask one router whose limit is counted for this server, and two
// passes at once would end the short one's quotes in 429s.
//
// An advisory lock, held in a transaction, so a pass that dies releases it with
// its connection. The hourly pass takes it shared and lets go at once: it only
// waits while the short pass holds it, and never for longer than it is told.
// ---------------------------------------------------------------------------

export type CashExitLockTransactionV1 = <T>(work: (transaction: SqlTemplateExecutor) => Promise<T>) => Promise<T>;

export const CASH_EXIT_LINEUP_LOCK_V1 = 'miorail:cash-exit:reopen-lineup';

/** Takes the lock for the lineup's pass; resolves once it is held, to the call that lets it go. */
export async function holdCashExitLineupLockV1(transaction: CashExitLockTransactionV1): Promise<() => Promise<void>> {
  let letGo!: () => void;
  const released = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let held!: () => void;
  let refused!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    held = resolve;
    refused = reject;
  });
  const done = transaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${CASH_EXIT_LINEUP_LOCK_V1}, 0))`;
    held();
    await released;
  });
  // Surfaced by `acquired` before the lock is held and by the release after it, never left unhandled.
  done.catch((error: unknown) => refused(error));
  await acquired;
  return async () => {
    letGo();
    await done;
  };
}

/** Waits while the lineup's pass holds the lock, at most `maxMs`. A timeout is an answer, not an error. */
export async function waitOutCashExitLineupLockV1(
  transaction: CashExitLockTransactionV1,
  maxMs: number,
): Promise<{ waitedMs: number; timedOut: boolean }> {
  const started = Date.now();
  try {
    await transaction(async (tx) => {
      await tx`SELECT set_config('lock_timeout', ${`${Math.max(1, Math.round(maxMs))}ms`}, true)`;
      await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended(${CASH_EXIT_LINEUP_LOCK_V1}, 0))`;
    });
    return { waitedMs: Date.now() - started, timedOut: false };
  } catch (error) {
    // 55P03 is lock_timeout's own code.
    if ((error as { code?: unknown } | null)?.code === '55P03') return { waitedMs: Date.now() - started, timedOut: true };
    throw error;
  }
}
