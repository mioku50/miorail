import type { ReopenGameRepositoryV1, ReopenRoundRowV1 } from '@mioagent/route-storage';
import {
  REOPEN_CALL_GRACE_MS_V1,
  REOPEN_LINEUP_V1,
  REOPEN_GAME_SCHEMA_VERSION_V1,
  ReopenCallV1Schema,
  ReopenResultV1Schema,
  ReopenStockV1Schema,
  reopenBaseCallsV1,
  reopenBasePicksV1,
  reopenCrowdPicksV1,
  reopenLeaderboardV1,
  reopenLineupV1,
  reopenPlayerNameV1,
  reopenRecordV1,
  reopenResultsV1,
  reopenSchedulesV1,
  reopenScoreV1,
  type ReopenCallV1,
  type ReopenDirectionV1,
  type ReopenGameResponseV1,
  type ReopenResultV1,
  type ReopenScheduleV1,
  type ReopenScoreV1,
  type ReopenStandingV1,
  type ReopenStockV1,
} from './reopenGame.js';
import type { WeekendMarketResponseV1, WeekendMarketStockInputV1 } from './weekendMarket.js';

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
  /** The issuer's own company names, by lowercase token address. A display
   * name is not part of a round's record: the close, the calls and the
   * results are, and nothing here touches them. */
  names?: () => Promise<ReadonlyMap<string, { name: string }>>;
  /** The Basename a wallet calls itself, verified forward, or null. Asked only
   * for the players the leaderboard shows. */
  basename?: (wallet: string) => Promise<string | null>;
}

/** How many players the leaderboard names. */
export const REOPEN_LEADERBOARD_ROWS_V1 = 10;

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
  /** Everybody ranked, and the names of those the board shows. Null before
   * the first round settles. */
  leaderboard: { rounds: number; standings: ReopenStandingV1[]; names: ReadonlyMap<string, string> } | null;
}

/** Everything that is the same for every reader at this moment. */
export async function reopenSharedStateV1(now: Date, deps: ReopenGameDepsV1): Promise<ReopenSharedStateV1> {
  const { row, next } = await advanceReopenRoundV1(now, deps);
  const rows = await deps.repository.rounds(200);
  const nowMs = now.getTime();

  let round: ReopenSharedStateV1['round'] = null;
  if (row) {
    const names = deps.names ? await deps.names().catch(() => null) : null;
    const lineup = lineupOfV1(row).map((stock) => ({
      ...stock,
      name: names?.get(stock.tokenAddress)?.name ?? stock.name,
    }));
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

  // The leaderboard: every settled round, everybody who picked in one.
  const settledRows = rows.filter((stored) => stored.results !== null);
  let leaderboard: ReopenSharedStateV1['leaderboard'] = null;
  if (settledRows.length > 0) {
    const standings = reopenLeaderboardV1({
      rounds: settledRows.map((stored) => ({
        roundId: stored.roundId,
        results: resultsOfV1(stored) ?? [],
        calls: callsOfV1(stored),
      })),
      picks: await deps.repository.standings(),
    });
    const shown = standings.slice(0, REOPEN_LEADERBOARD_ROWS_V1);
    const names = new Map<string, string>();
    await Promise.all(
      shown.map(async (standing) => {
        // A Basename the wallet set for itself, or the player's number. A
        // device has neither a wallet nor a name, only its number.
        const basename =
          standing.playerId.startsWith('w:') && deps.basename
            ? await deps.basename(standing.playerId.slice(2)).catch(() => null)
            : null;
        names.set(standing.playerId, basename ?? reopenPlayerNameV1(standing.playerNumber));
      }),
    );
    leaderboard = { rounds: settledRows.length, standings, names };
  }

  return {
    generatedAt: now.toISOString(),
    round,
    next: nextOut,
    baseRecord: { rounds: settledRounds, correct, of },
    rows,
    leaderboard,
  };
}

/** The reader's own part: their picks in the round shown, its score, and
 * their record across every round. */
export async function reopenGameForV1(input: {
  shared: ReopenSharedStateV1;
  player: ReopenPlayerRefV1 | null;
  now: Date;
  repository: ReopenGameRepositoryV1;
  /** A fresh random share code, offered when the reader's settled round has
   * none yet. Absent: no share code is made or read. */
  newShareCode?: () => string;
}): Promise<ReopenGameResponseV1> {
  const { shared } = input;
  let me: ReopenGameResponseV1['me'] = null;
  if (input.player) {
    const picks = await input.repository.picksOf(input.player.playerId);
    const byRound = new Map(picks.map((row) => [row.roundId, row]));
    const shown = shared.round ? byRound.get(shared.round.roundId) : undefined;
    const shownRow = shared.round ? shared.rows.find((row) => row.roundId === shared.round!.roundId) : undefined;
    const shownResults = shownRow ? resultsOfV1(shownRow) : null;
    // A settled round the reader picked in gets the code its post links to.
    const share =
      input.newShareCode && shown && shownResults && Object.keys(shown.picks).length > 0
        ? await input.repository.shareCode({
            roundId: shown.roundId,
            playerId: input.player.playerId,
            code: input.newShareCode(),
            now: input.now,
          })
        : null;
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
      share,
    };
  }
  const board = shared.leaderboard;
  const mine = board && input.player ? board.standings.find((row) => row.playerId === input.player!.playerId) : undefined;
  return {
    schemaVersion: REOPEN_GAME_SCHEMA_VERSION_V1,
    generatedAt: shared.generatedAt,
    round: shared.round,
    next: shared.next,
    leaderboard: board
      ? {
          rounds: board.rounds,
          players: board.standings.length,
          rows: board.standings.slice(0, REOPEN_LEADERBOARD_ROWS_V1).map((row) => ({
            rank: row.rank,
            name: board.names.get(row.playerId) ?? reopenPlayerNameV1(row.playerNumber),
            correct: row.correct,
            of: row.of,
            played: row.played,
            you: row.playerId === input.player?.playerId,
          })),
          me: mine ? { rank: mine.rank, correct: mine.correct, of: mine.of, played: mine.played } : null,
        }
      : null,
    baseRecord: shared.baseRecord,
    me,
  };
}

// --- A shared result -------------------------------------------------------------

/** One player's settled round, as the picture of a shared post draws it. */
export interface ReopenSharedResultV1 {
  roundId: string;
  number: number;
  closeAt: string;
  opensAt: string;
  expectedReopenAt: string;
  stocks: {
    symbol: string;
    name: string;
    close: string;
    pick: ReopenDirectionV1 | null;
    /** Base's call at the lock; null with too few quotes to make one. */
    baseCall: ReopenDirectionV1 | null;
    reopen: string | null;
    outcome: 'up' | 'down' | 'void';
  }[];
  mine: ReopenScoreV1;
  base: ReopenScoreV1;
}

/**
 * What a share code names, read back from the database: the round as it was
 * frozen and the picks as they were copied when the code was made. Nothing
 * the request carries reaches a number here; the code only picks the row.
 */
export async function reopenSharedResultV1(
  code: string,
  deps: Pick<ReopenGameDepsV1, 'repository' | 'names'>,
): Promise<ReopenSharedResultV1 | null> {
  const share = await deps.repository.share(code);
  if (!share) return null;
  const row = await deps.repository.round(share.roundId);
  const results = row ? resultsOfV1(row) : null;
  if (!row || results === null) return null;
  const calls = callsOfV1(row) ?? [];
  const names = deps.names ? await deps.names().catch(() => null) : null;
  return {
    roundId: row.roundId,
    number: row.number,
    closeAt: row.closeAt,
    opensAt: row.opensAt,
    expectedReopenAt: row.expectedReopenAt,
    stocks: lineupOfV1(row).map((stock) => {
      const result = results.find((entry) => entry.symbol === stock.symbol);
      return {
        symbol: stock.symbol,
        name: names?.get(stock.tokenAddress)?.name ?? stock.name,
        close: stock.close,
        pick: share.picks[stock.symbol] ?? null,
        baseCall: calls.find((entry) => entry.symbol === stock.symbol)?.call ?? null,
        reopen: result?.reopen ?? null,
        outcome: result?.outcome ?? 'void',
      };
    }),
    mine: reopenScoreV1(share.picks, results),
    base: reopenScoreV1(reopenBasePicksV1(calls), results),
  };
}

/**
 * The lineup's stored runs, from one issuer: a symbol is not an identifier,
 * and another issuer's NVDA would be another question. Shared by the API and
 * the notifier, which identify tokens through their own repositories.
 */
export async function reopenLineupStocksV1(input: {
  runs: readonly { token: string; at: string; mid: number; reference: number; referenceUpdatedAt: string }[];
  identify: (tokenAddress: string) => Promise<{ symbol: string; name: string; coinbase: boolean } | null>;
}): Promise<WeekendMarketStockInputV1[]> {
  const byToken = new Map<string, WeekendMarketStockInputV1['runs'][number][]>();
  for (const row of input.runs) {
    const token = row.token.toLowerCase();
    byToken.set(token, [
      ...(byToken.get(token) ?? []),
      { at: row.at, mid: row.mid, reference: row.reference, referenceUpdatedAt: row.referenceUpdatedAt },
    ]);
  }
  const stocks: WeekendMarketStockInputV1[] = [];
  for (const [token, runs] of byToken) {
    const identity = await input.identify(token);
    if (!identity?.coinbase || !(REOPEN_LINEUP_V1 as readonly string[]).includes(identity.symbol)) continue;
    stocks.push({ tokenAddress: token, symbol: identity.symbol, name: identity.name, runs });
  }
  return stocks;
}

// --- What the notifier needs ----------------------------------------------------

/** One round as the notifier sees it: who played, how they did, who played
 * before. Wallets only: a device has nobody to push to. */
export interface ReopenNoticeFactsV1 {
  roundId: string;
  number: number;
  opensAt: string;
  locksAt: string;
  settledAt: string | null;
  symbols: readonly string[];
  /** Wallets with picks in this round, with their score and place once settled. */
  players: ReadonlyMap<string, { score: { correct: number; of: number } | null; rank: number | null; beatBase: boolean }>;
  /** Wallets that played a settled round before this one. */
  returning: ReadonlySet<string>;
  base: { correct: number; of: number } | null;
  /** How many players the leaderboard ranks. */
  ranked: number;
}

/**
 * The round brought up to date, as the notifier needs it. The notifier runs
 * every five minutes, so a round opens, is called and settles on time even
 * when nobody opens the page.
 */
export async function reopenNoticeFactsV1(now: Date, deps: ReopenGameDepsV1): Promise<ReopenNoticeFactsV1 | null> {
  const { row } = await advanceReopenRoundV1(now, deps);
  if (!row) return null;
  const results = resultsOfV1(row);
  const calls = callsOfV1(row);
  const base = results ? reopenScoreV1(reopenBasePicksV1(calls ?? []), results) : null;
  const settledRows = (await deps.repository.rounds(200)).filter((stored) => stored.results !== null);
  const standings =
    settledRows.length > 0
      ? reopenLeaderboardV1({
          rounds: settledRows.map((stored) => ({
            roundId: stored.roundId,
            results: resultsOfV1(stored) ?? [],
            calls: callsOfV1(stored),
          })),
          picks: await deps.repository.standings(),
        })
      : [];
  const rankOf = new Map(standings.map((standing) => [standing.playerId, standing.rank]));
  const players = new Map<string, { score: { correct: number; of: number } | null; rank: number | null; beatBase: boolean }>();
  for (const entry of await deps.repository.roundPicks(row.roundId)) {
    if (!entry.playerId.startsWith('w:')) continue;
    const score = results ? reopenScoreV1(entry.picks, results) : null;
    players.set(entry.playerId.slice(2), {
      score: score ? { correct: score.correct, of: score.of } : null,
      rank: results ? (rankOf.get(entry.playerId) ?? null) : null,
      beatBase: Boolean(score && base && score.correct > base.correct),
    });
  }
  // Played a settled round other than this one.
  const earlier = (await deps.repository.standings()).filter(
    (entry) => entry.roundId !== row.roundId && entry.playerId.startsWith('w:'),
  );
  return {
    roundId: row.roundId,
    number: row.number,
    opensAt: row.opensAt,
    locksAt: row.locksAt,
    settledAt: row.settledAt,
    symbols: lineupOfV1(row).map((stock) => stock.symbol),
    players,
    returning: new Set(earlier.map((entry) => entry.playerId.slice(2))),
    base: base ? { correct: base.correct, of: base.of } : null,
    ranked: standings.length,
  };
}

