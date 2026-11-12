// ---------------------------------------------------------------------------
// Which old venue transfers the tail removes (audit OPS-7, 2026-11-12).
//
// market_venue_transfers had no retention: 10.4 million rows and 5.2 GB on
// 2026-11-12, about 250,000 more each day. What reads a stored transfer is the
// asset dossier, and it reads the last 20,000 blocks: a little over an hour.
// The one number that needed all of them, the count of movements ever observed
// for a stock, is kept as its own total since migration 0097 and no longer
// depends on the rows.
//
// So after its passes the tail removes transfers observed more than a number
// of days ago, a bounded number each run. It is off until
// MARKET_TAIL_RETENTION_DAYS says how many days to keep: removing rows is not
// something a deploy should start by itself.
// ---------------------------------------------------------------------------

/** Nothing reads a transfer older than about an hour; a week is the floor so a slow day of debugging still has its rows. */
export const MARKET_TAIL_RETENTION_MIN_DAYS_V1 = 7;
/** Transfers one statement removes at most. */
export const MARKET_TAIL_RETENTION_BATCH_V1 = 50_000;
/** Statements one run sends at most: 200,000 rows an hour, against some 15,000 arriving. */
export const MARKET_TAIL_RETENTION_STATEMENTS_V1 = 4;

/** How many days of transfers to keep, or null when retention is off. Only a whole number of days,
 * at least the minimum, turns it on: anything else is off, never a guess. */
export function marketTailRetentionDaysV1(env: NodeJS.ProcessEnv): number | null {
  const raw = (env.MARKET_TAIL_RETENTION_DAYS ?? '').trim();
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) return null;
  const days = Number(raw);
  return days >= MARKET_TAIL_RETENTION_MIN_DAYS_V1 ? days : null;
}

export interface MarketTailRetentionOutcomeV1 {
  removed: number;
  statements: number;
  /** The last statement removed a full batch: older transfers are probably still there for the next run. */
  more: boolean;
}

/**
 * Removes what was observed before the day, a batch at a time, and stops at the first batch that
 * comes back short: the oldest stored transfers are then inside the days to keep.
 */
export async function pruneOldVenueTransfersV1(input: {
  prune: (input: { chainId: number; before: string; limit: number }) => Promise<{ removed: number }>;
  days: number;
  nowMs: number;
  batch?: number;
  statements?: number;
}): Promise<MarketTailRetentionOutcomeV1 | null> {
  if (!Number.isInteger(input.days) || input.days < MARKET_TAIL_RETENTION_MIN_DAYS_V1 || !Number.isFinite(input.nowMs)) return null;
  const batch = input.batch ?? MARKET_TAIL_RETENTION_BATCH_V1;
  const statements = input.statements ?? MARKET_TAIL_RETENTION_STATEMENTS_V1;
  const before = new Date(input.nowMs - input.days * 86_400_000).toISOString();
  const outcome: MarketTailRetentionOutcomeV1 = { removed: 0, statements: 0, more: false };
  while (outcome.statements < statements) {
    const { removed } = await input.prune({ chainId: 8453, before, limit: batch });
    outcome.statements += 1;
    outcome.removed += removed;
    outcome.more = removed >= batch;
    if (!outcome.more) break;
  }
  return outcome;
}

/** The line the run prints, so the journal says what was removed. */
export function marketTailRetentionLineV1(input: { days: number } & MarketTailRetentionOutcomeV1): string {
  return `retention: removed ${input.removed} venue transfer${input.removed === 1 ? '' : 's'} observed more than ${input.days} days ago` +
    (input.more ? '; older ones remain for the next run' : '');
}
