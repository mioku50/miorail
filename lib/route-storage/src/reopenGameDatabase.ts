import {
  assertReopenOpeningV1,
  assertReopenPicksV1,
  assertReopenPlayerV1,
  assertReopenRoundIdV1,
  assertReopenTokenHashV1,
  assertReopenWalletV1,
  reopenDevicePlayerIdV1,
  reopenWalletPlayerIdV1,
  type ReopenCrowdV1,
  type ReopenGameRepositoryV1,
  type ReopenPlayerPicksV1,
  type ReopenRoundRowV1,
  type ReopenSideV1,
} from './reopenGame.js';
import { RouteStorageIntegrityError, type SqlTemplateExecutor } from './types.js';

function isoV1(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

function isoOrNullV1(value: unknown): string | null {
  return value === null || value === undefined ? null : isoV1(value);
}

function roundV1(row: Record<string, unknown>): ReopenRoundRowV1 {
  return {
    roundId: String(row.round_id),
    number: Number(row.round_number),
    closeAt: isoV1(row.close_at),
    opensAt: isoV1(row.opens_at),
    locksAt: isoV1(row.locks_at),
    expectedReopenAt: isoV1(row.expected_reopen_at),
    nextSessionCloseAt: isoV1(row.next_session_close_at),
    stocks: row.stocks as unknown[],
    calls: (row.calls as unknown[] | null) ?? null,
    calledAt: isoOrNullV1(row.called_at),
    results: (row.results as unknown[] | null) ?? null,
    settledAt: isoOrNullV1(row.settled_at),
    createdAt: isoV1(row.created_at),
  };
}

function playerPicksV1(row: Record<string, unknown>): ReopenPlayerPicksV1 {
  return {
    roundId: String(row.round_id),
    playerId: String(row.player_id),
    // bigint comes back as a string from the driver; a player number is small.
    playerNumber: Number(row.player_number),
    picks: row.picks as Record<string, ReopenSideV1>,
  };
}

/**
 * Every write is one statement, and the ones with a rule in them carry the
 * rule: a pick is inserted only through the round whose lock is still ahead,
 * and each stage of a round is written only while it is empty.
 */
export function createDatabaseReopenGameRepositoryV1(sql: SqlTemplateExecutor): ReopenGameRepositoryV1 {
  return {
    async round(roundId) {
      assertReopenRoundIdV1(roundId);
      const rows = await sql`SELECT * FROM reopen_rounds WHERE round_id = ${roundId}`;
      return rows[0] ? roundV1(rows[0]) : null;
    },

    async rounds(limit) {
      const rows = await sql`
        SELECT * FROM reopen_rounds ORDER BY round_number DESC LIMIT ${Math.max(0, Math.floor(limit))}`;
      return rows.map(roundV1);
    },

    async openRound(input) {
      assertReopenOpeningV1(input.opening);
      const opening = input.opening;
      await sql`
        INSERT INTO reopen_rounds (
          round_id, round_number, close_at, opens_at, locks_at, expected_reopen_at,
          next_session_close_at, stocks, created_at
        )
        SELECT ${opening.roundId}, coalesce(max(round_number), 0) + 1,
               ${opening.closeAt}::timestamptz, ${opening.opensAt}::timestamptz,
               ${opening.locksAt}::timestamptz, ${opening.expectedReopenAt}::timestamptz,
               ${opening.nextSessionCloseAt}::timestamptz, ${JSON.stringify(opening.stocks)}::text::jsonb,
               ${input.now.toISOString()}::timestamptz
          FROM reopen_rounds
        ON CONFLICT (round_id) DO NOTHING`;
      const rows = await sql`SELECT * FROM reopen_rounds WHERE round_id = ${opening.roundId}`;
      if (!rows[0]) throw new RouteStorageIntegrityError('the round was not stored');
      return roundV1(rows[0]);
    },

    async fixCalls(input) {
      assertReopenRoundIdV1(input.roundId);
      await sql`
        UPDATE reopen_rounds
           SET calls = ${JSON.stringify(input.calls)}::text::jsonb, called_at = ${input.at.toISOString()}::timestamptz
         WHERE round_id = ${input.roundId}
           AND calls IS NULL
           AND locks_at <= ${input.at.toISOString()}::timestamptz`;
      const rows = await sql`SELECT * FROM reopen_rounds WHERE round_id = ${input.roundId}`;
      return rows[0] ? roundV1(rows[0]) : null;
    },

    async settle(input) {
      assertReopenRoundIdV1(input.roundId);
      await sql`
        UPDATE reopen_rounds
           SET results = ${JSON.stringify(input.results)}::text::jsonb, settled_at = ${input.at.toISOString()}::timestamptz
         WHERE round_id = ${input.roundId}
           AND results IS NULL
           AND calls IS NOT NULL
           AND expected_reopen_at <= ${input.at.toISOString()}::timestamptz`;
      const rows = await sql`SELECT * FROM reopen_rounds WHERE round_id = ${input.roundId}`;
      return rows[0] ? roundV1(rows[0]) : null;
    },

    async walletPlayer(input) {
      assertReopenWalletV1(input.wallet);
      const playerId = reopenWalletPlayerIdV1(input.wallet);
      await sql`
        INSERT INTO reopen_players (player_id, created_at)
        VALUES (${playerId}, ${input.now.toISOString()}::timestamptz)
        ON CONFLICT (player_id) DO NOTHING`;
      return playerId;
    },

    async createDevicePlayer(input) {
      assertReopenTokenHashV1(input.tokenHash);
      const playerId = reopenDevicePlayerIdV1(input.tokenHash);
      const rows = await sql`
        INSERT INTO reopen_players (player_id, created_at)
        VALUES (${playerId}, ${input.now.toISOString()}::timestamptz)
        ON CONFLICT (player_id) DO NOTHING
        RETURNING player_id`;
      if (!rows[0]) throw new RouteStorageIntegrityError('duplicate device player');
      return playerId;
    },

    async devicePlayer(tokenHash) {
      if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
      const playerId = reopenDevicePlayerIdV1(tokenHash);
      const rows = await sql`
        SELECT player_id FROM reopen_players WHERE player_id = ${playerId} AND merged_into IS NULL`;
      return rows[0] ? playerId : null;
    },

    async savePicks(input) {
      assertReopenRoundIdV1(input.roundId);
      assertReopenPlayerV1(input.playerId);
      assertReopenPicksV1(input.picks);
      const now = input.now.toISOString();
      const rows = await sql`
        WITH open_round AS (
          SELECT round_id FROM reopen_rounds
           WHERE round_id = ${input.roundId} AND locks_at > ${now}::timestamptz
        )
        INSERT INTO reopen_picks (round_id, player_id, picks, picked_at)
        SELECT round_id, ${input.playerId}, ${JSON.stringify(input.picks)}::text::jsonb, ${now}::timestamptz
          FROM open_round
        ON CONFLICT (round_id, player_id)
        DO UPDATE SET picks = EXCLUDED.picks, picked_at = EXCLUDED.picked_at
        RETURNING round_id`;
      if (rows[0]) return 'saved';
      const exists = await sql`SELECT 1 FROM reopen_rounds WHERE round_id = ${input.roundId}`;
      return exists[0] ? 'locked' : 'unknown_round';
    },

    async picksOf(playerId) {
      assertReopenPlayerV1(playerId);
      const rows = await sql`
        SELECT round_id, picks, picked_at FROM reopen_picks
         WHERE player_id = ${playerId}
         ORDER BY round_id`;
      return rows.map((row) => ({
        roundId: String(row.round_id),
        picks: row.picks as Record<string, ReopenSideV1>,
        pickedAt: isoV1(row.picked_at),
      }));
    },

    async crowd(roundId) {
      assertReopenRoundIdV1(roundId);
      const players = await sql`
        SELECT count(*)::int AS players FROM reopen_picks
         WHERE round_id = ${roundId} AND picks <> '{}'::jsonb`;
      const rows = await sql`
        SELECT pick.key AS symbol, pick.value AS side, count(*)::int AS n
          FROM reopen_picks, jsonb_each_text(reopen_picks.picks) AS pick
         WHERE round_id = ${roundId}
         GROUP BY pick.key, pick.value`;
      const split: ReopenCrowdV1['split'] = {};
      for (const row of rows) {
        const side = String(row.side);
        if (side !== 'up' && side !== 'down') continue;
        const symbol = String(row.symbol);
        const count = split[symbol] ?? { up: 0, down: 0 };
        count[side] = Number(row.n);
        split[symbol] = count;
      }
      return { players: Number(players[0]?.players ?? 0), split };
    },

    async standings() {
      const rows = await sql`
        SELECT p.round_id, p.player_id, pl.player_number, p.picks
          FROM reopen_picks AS p
          JOIN reopen_rounds AS r ON r.round_id = p.round_id
          JOIN reopen_players AS pl ON pl.player_id = p.player_id
         WHERE r.results IS NOT NULL AND p.picks <> '{}'::jsonb
         ORDER BY p.round_id, pl.player_number`;
      return rows.map(playerPicksV1);
    },

    async roundPicks(roundId) {
      assertReopenRoundIdV1(roundId);
      const rows = await sql`
        SELECT p.round_id, p.player_id, pl.player_number, p.picks
          FROM reopen_picks AS p
          JOIN reopen_players AS pl ON pl.player_id = p.player_id
         WHERE p.round_id = ${roundId} AND p.picks <> '{}'::jsonb
         ORDER BY pl.player_number`;
      return rows.map(playerPicksV1);
    },

    async mergeDevice(input) {
      assertReopenWalletV1(input.wallet);
      if (!/^[0-9a-f]{64}$/.test(input.tokenHash)) return null;
      const deviceId = reopenDevicePlayerIdV1(input.tokenHash);
      const walletId = reopenWalletPlayerIdV1(input.wallet);
      const now = input.now.toISOString();
      // One statement: the device stops playing, its picks move where the
      // wallet has none, and the rest go. The three see the same snapshot, so
      // "the wallet already picked this round" means before this merge.
      const rows = await sql`
        WITH device AS (
          UPDATE reopen_players
             SET merged_into = ${walletId}, merged_at = ${now}::timestamptz
           WHERE player_id = ${deviceId} AND merged_into IS NULL
             AND EXISTS (SELECT 1 FROM reopen_players WHERE player_id = ${walletId})
          RETURNING player_id
        ), moved AS (
          UPDATE reopen_picks AS p SET player_id = ${walletId}
           WHERE p.player_id IN (SELECT player_id FROM device)
             AND NOT EXISTS (
               SELECT 1 FROM reopen_picks AS w WHERE w.round_id = p.round_id AND w.player_id = ${walletId}
             )
          RETURNING 1
        ), dropped AS (
          DELETE FROM reopen_picks AS p
           WHERE p.player_id IN (SELECT player_id FROM device)
             AND EXISTS (
               SELECT 1 FROM reopen_picks AS w WHERE w.round_id = p.round_id AND w.player_id = ${walletId}
             )
          RETURNING 1
        )
        SELECT (SELECT count(*) FROM device)::int AS merged,
               (SELECT count(*) FROM moved)::int AS moved,
               (SELECT count(*) FROM dropped)::int AS dropped`;
      const row = rows[0];
      if (!row || Number(row.merged) === 0) return null;
      return { moved: Number(row.moved), dropped: Number(row.dropped) };
    },
  };
}
