import type { ReopenGameRepositoryV1, ReopenRoundRowV1 } from '@mioagent/route-storage';
import {
  REOPEN_CALL_GRACE_MS_V1,
  REOPEN_GAME_SCHEMA_VERSION_V1,
  ReopenCallV1Schema,
  ReopenResultV1Schema,
  ReopenStockV1Schema,
  reopenBaseCallsV1,
  reopenBasePicksV1,
  reopenCrowdPicksV1,
  reopenLineupV1,
  reopenRecordV1,
  reopenResultsV1,
  reopenSchedulesV1,
  reopenScoreV1,
  type ReopenCallV1,
  type ReopenGameResponseV1,
  type ReopenResultV1,
  type ReopenScheduleV1,
  type ReopenStockV1,
} from '@mioagent/rwa-market-reality/reopen-game';
import type {
  WeekendMarketResponseV1,
  WeekendMarketStockInputV1,
} from '@mioagent/rwa-market-reality/weekend-market';

// ---------------------------------------------------------------------------
// Call the reopen, as the server keeps it.
//
// The round is brought up to date by whoever asks first: the first read after
// Friday 20:00 ET opens it, the first after the lock fixes Base's calls, the
// first after the reopen settles it. Every stage reads only runs measured
// before its own moment, so the answer does not depend on who asked when, and
// the repository writes each stage once.
// ---------------------------------------------------------------------------

export interface ReopenGameDepsV1 {
  repository: ReopenGameRepositoryV1;
  /** Coinbase's lineup stocks with every stored run in [since, until]. */
  stocks: (since: Date, until: Date) => Promise<WeekendMarketStockInputV1[]>;
  /** The weekend card at this moment: the price on Base while it lasts. */
  weekend: (now: Date) => Promise<WeekendMarketResponseV1>;
}

export interface ReopenPlayerRefV1 {
  playerId: string;
  /** A wallet player; false for a device that has not signed in. */
  signed: boolean;
}

const LOOKBACK_BEFORE_CLOSE_MS_V1 = 4 * 3_600_000;

function scheduleOfRowV1(row: ReopenRoundRowV1): ReopenScheduleV1 {
  return {
    roundId: row.roundId,
    closeAt: row.closeAt,
    opensAt: row.opensAt,
    locksAt: row.locksAt,
    expectedReopenAt: row.expectedReopenAt,
    nextSessionCloseAt: row.nextSessionCloseAt,
  };
}

function runsWindowV1(schedule: ReopenScheduleV1, now: Date): { since: Date; until: Date } {
  return {
    since: new Date(Date.parse(schedule.closeAt) - LOOKBACK_BEFORE_CLOSE_MS_V1),
    until: new Date(Math.min(now.getTime(), Date.parse(schedule.nextSessionCloseAt))),
  };
}

/** A stored stage read back through the schema that wrote it. A row that no
 * longer parses is an integrity failure, not an empty stage. */
function lineupOfV1(row: ReopenRoundRowV1): ReopenStockV1[] {
  return row.stocks.map((stock) => ReopenStockV1Schema.parse(stock));
}
function callsOfV1(row: ReopenRoundRowV1): ReopenCallV1[] | null {
  return row.calls === null ? null : row.calls.map((call) => ReopenCallV1Schema.parse(call));
}
function resultsOfV1(row: ReopenRoundRowV1): ReopenResultV1[] | null {
  return row.results === null ? null : row.results.map((result) => ReopenResultV1Schema.parse(result));
}

async function finishStagesV1(row: ReopenRoundRowV1, now: Date, deps: ReopenGameDepsV1): Promise<ReopenRoundRowV1> {
  const schedule = scheduleOfRowV1(row);
  const nowMs = now.getTime();
  const callDue = row.calls === null && nowMs >= Date.parse(schedule.locksAt) + REOPEN_CALL_GRACE_MS_V1;
  const resultDue = row.results === null && nowMs >= Date.parse(schedule.expectedReopenAt);
  if (!callDue && !(resultDue && row.calls !== null)) return row;
  const window = runsWindowV1(schedule, now);
  const stocks = await deps.stocks(window.since, window.until);
  const lineup = lineupOfV1(row);
  let current = row;
  if (callDue) {
    const calls = reopenBaseCallsV1({ schedule, lineup, stocks });
    current = (await deps.repository.fixCalls({ roundId: row.roundId, calls, at: now })) ?? current;
  }
  if (current.calls !== null && current.results === null && resultDue) {
    const settled = reopenResultsV1({ schedule, lineup, stocks, now });
    if (settled.complete) {
      current = (await deps.repository.settle({ roundId: row.roundId, results: settled.results, at: now })) ?? current;
    }
  }
  return current;
}

/**
 * The round to show at `now`, brought up to date, and the next one.
 *
 * Inside a weekend that is its round, opened on the first ask. Between
 * weekends it is the last round played, whose results stay up until the next
 * one opens.
 */
export async function advanceReopenRoundV1(
  now: Date,
  deps: ReopenGameDepsV1,
): Promise<{ row: ReopenRoundRowV1 | null; next: ReopenScheduleV1 | null }> {
  const { current, next } = reopenSchedulesV1(now);
  let row: ReopenRoundRowV1 | null = null;
  if (current && now.getTime() >= Date.parse(current.opensAt)) {
    row = await deps.repository.round(current.roundId);
    if (!row) {
      const window = runsWindowV1(current, now);
      const lineup = reopenLineupV1({ schedule: current, stocks: await deps.stocks(window.since, window.until) });
      // No close for any of the five is no round, never a round with guesses.
      if (lineup.length > 0) row = await deps.repository.openRound({ opening: { ...current, stocks: lineup }, now });
    }
  }
  if (!row) row = (await deps.repository.rounds(1))[0] ?? null;
  if (row) row = await finishStagesV1(row, now, deps);
  return { row, next };
}

export interface ReopenSharedStateV1 {
  generatedAt: string;
  round: NonNullable<ReopenGameResponseV1['round']> | null;
  next: ReopenGameResponseV1['next'];
  baseRecord: ReopenGameResponseV1['baseRecord'];
  /** Every stored round, newest first: what a player's record is built from. */
  rows: ReopenRoundRowV1[];
}

/** Everything that is the same for every reader at this moment. */
export async function reopenSharedStateV1(now: Date, deps: ReopenGameDepsV1): Promise<ReopenSharedStateV1> {
  const { row, next } = await advanceReopenRoundV1(now, deps);
  const rows = await deps.repository.rounds(200);
  const nowMs = now.getTime();

  let round: ReopenSharedStateV1['round'] = null;
  if (row) {
    const lineup = lineupOfV1(row);
    const calls = callsOfV1(row);
    const results = resultsOfV1(row);
    const state = results !== null ? 'settled' : nowMs < Date.parse(row.locksAt) ? 'open' : 'locked';
    // How players split is shown only once nobody can change a pick.
    const crowd = state === 'open' ? null : await deps.repository.crowd(row.roundId);
    // The price on Base, while this round's weekend is the one on the card.
    const weekend = state === 'settled' ? null : await deps.weekend(now).catch(() => null);
    const live = weekend && weekend.window?.closeAt === row.closeAt ? weekend : null;
    round = {
      roundId: row.roundId,
      number: row.number,
      state,
      opensAt: row.opensAt,
      locksAt: row.locksAt,
      expectedReopenAt: row.expectedReopenAt,
      stocks: lineup.map((stock) => {
        const base = live?.stocks.find((card) => card.tokenAddress === stock.tokenAddress)?.base ?? null;
        const call = calls?.find((entry) => entry.symbol === stock.symbol) ?? null;
        const result = results?.find((entry) => entry.symbol === stock.symbol) ?? null;
        return {
          ...stock,
          baseNow: base ? { value: base.value, moveBps: base.moveBps } : null,
          baseCall: call ? { base: call.base, call: call.call } : null,
          crowd: crowd ? (crowd.split[stock.symbol] ?? { up: 0, down: 0 }) : null,
          result: result ? { reopen: result.reopen, at: result.at, outcome: result.outcome } : null,
        };
      }),
      players: crowd ? crowd.players : null,
      score:
        results !== null
          ? {
              base: reopenScoreV1(reopenBasePicksV1(calls ?? []), results),
              crowd: crowd && crowd.players > 0 ? reopenScoreV1(reopenCrowdPicksV1(crowd.split), results) : null,
            }
          : null,
    };
  }

  const highest = rows[0]?.number ?? 0;
  const nextOut: ReopenGameResponseV1['next'] = next
    ? { number: highest + 1, opensAt: next.opensAt, locksAt: next.locksAt, expectedReopenAt: next.expectedReopenAt }
    : null;

  let correct = 0;
  let of = 0;
  let settledRounds = 0;
  for (const stored of rows) {
    const results = resultsOfV1(stored);
    if (results === null) continue;
    const score = reopenScoreV1(reopenBasePicksV1(callsOfV1(stored) ?? []), results);
    correct += score.correct;
    of += score.of;
    settledRounds += 1;
  }

  return {
    generatedAt: now.toISOString(),
    round,
    next: nextOut,
    baseRecord: { rounds: settledRounds, correct, of },
    rows,
  };
}

/** The reader's own part: their picks in the round shown, its score, and
 * their record across every round. */
export async function reopenGameForV1(input: {
  shared: ReopenSharedStateV1;
  player: ReopenPlayerRefV1 | null;
  now: Date;
  repository: ReopenGameRepositoryV1;
}): Promise<ReopenGameResponseV1> {
  const { shared } = input;
  let me: ReopenGameResponseV1['me'] = null;
  if (input.player) {
    const picks = await input.repository.picksOf(input.player.playerId);
    const byRound = new Map(picks.map((row) => [row.roundId, row]));
    const shown = shared.round ? byRound.get(shared.round.roundId) : undefined;
    const shownRow = shared.round ? shared.rows.find((row) => row.roundId === shared.round!.roundId) : undefined;
    const shownResults = shownRow ? resultsOfV1(shownRow) : null;
    me = {
      picks: shown?.picks ?? {},
      pickedAt: shown?.pickedAt ?? null,
      score: shown && shownResults ? reopenScoreV1(shown.picks, shownResults) : null,
      record: reopenRecordV1(
        shared.rows.map((row) => ({
          roundId: row.roundId,
          number: row.number,
          locked: input.now.getTime() >= Date.parse(row.locksAt),
          results: resultsOfV1(row),
          calls: callsOfV1(row),
          picks: byRound.get(row.roundId)?.picks ?? null,
        })),
      ),
      signed: input.player.signed,
    };
  }
  return {
    schemaVersion: REOPEN_GAME_SCHEMA_VERSION_V1,
    generatedAt: shared.generatedAt,
    round: shared.round,
    next: shared.next,
    baseRecord: shared.baseRecord,
    me,
  };
}
