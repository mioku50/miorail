import {
  assertReopenOpeningV1,
  assertReopenPicksV1,
  assertReopenPlayerV1,
  assertReopenRoundIdV1,
  assertReopenShareCodeV1,
  assertReopenTokenHashV1,
  assertReopenWalletV1,
  isReopenShareCodeV1,
  reopenDevicePlayerIdV1,
  reopenWalletPlayerIdV1,
  type ReopenCrowdV1,
  type ReopenGameRepositoryV1,
  type ReopenPicksRowV1,
  type ReopenPlayerPicksV1,
  type ReopenRoundOpeningV1,
  type ReopenRoundRowV1,
  type ReopenShareRowV1,
  type ReopenSideV1,
} from './reopenGame.js';
import { RouteStorageIntegrityError } from './types.js';

/** The in-memory store: refuses what the tables refuse, and checks the lock
 * the way the SQL does, against the round it writes into. */
export class InMemoryReopenGameRepositoryV1 implements ReopenGameRepositoryV1 {
  private readonly roundRows = new Map<string, ReopenRoundRowV1>();
  private readonly players = new Map<string, { createdAt: string; mergedInto: string | null; number: number }>();
  private nextNumber = 1;
  private readonly picks = new Map<string, { roundId: string; playerId: string; picks: Record<string, ReopenSideV1>; pickedAt: string }>();
  private readonly shares = new Map<string, ReopenShareRowV1 & { playerId: string }>();

  private copy(row: ReopenRoundRowV1): ReopenRoundRowV1 {
    return structuredClone(row);
  }

  async round(roundId: string): Promise<ReopenRoundRowV1 | null> {
    assertReopenRoundIdV1(roundId);
    const row = this.roundRows.get(roundId);
    return row ? this.copy(row) : null;
  }

  async rounds(limit: number): Promise<ReopenRoundRowV1[]> {
    return [...this.roundRows.values()]
      .sort((a, b) => b.number - a.number)
      .slice(0, Math.max(0, limit))
      .map((row) => this.copy(row));
  }

  async openRound(input: { opening: ReopenRoundOpeningV1; now: Date }): Promise<ReopenRoundRowV1> {
    assertReopenOpeningV1(input.opening);
    const existing = this.roundRows.get(input.opening.roundId);
    if (existing) return this.copy(existing);
    const number = Math.max(0, ...[...this.roundRows.values()].map((row) => row.number)) + 1;
    const row: ReopenRoundRowV1 = {
      ...structuredClone(input.opening),
      number,
      calls: null,
      calledAt: null,
      results: null,
      settledAt: null,
      createdAt: input.now.toISOString(),
    };
    this.roundRows.set(row.roundId, row);
    return this.copy(row);
  }

  async fixCalls(input: { roundId: string; calls: unknown[]; at: Date }): Promise<ReopenRoundRowV1 | null> {
    assertReopenRoundIdV1(input.roundId);
    const row = this.roundRows.get(input.roundId);
    if (!row) return null;
    if (row.calls === null && input.at.getTime() >= Date.parse(row.locksAt)) {
      row.calls = structuredClone(input.calls);
      row.calledAt = input.at.toISOString();
    }
    return this.copy(row);
  }

  async settle(input: { roundId: string; results: unknown[]; at: Date }): Promise<ReopenRoundRowV1 | null> {
    assertReopenRoundIdV1(input.roundId);
    const row = this.roundRows.get(input.roundId);
    if (!row) return null;
    if (row.results === null && row.calls !== null && input.at.getTime() >= Date.parse(row.expectedReopenAt)) {
      row.results = structuredClone(input.results);
      row.settledAt = input.at.toISOString();
    }
    return this.copy(row);
  }

  async walletPlayer(input: { wallet: string; now: Date }): Promise<string> {
    assertReopenWalletV1(input.wallet);
    const playerId = reopenWalletPlayerIdV1(input.wallet);
    if (!this.players.has(playerId)) {
      this.players.set(playerId, { createdAt: input.now.toISOString(), mergedInto: null, number: this.nextNumber++ });
    }
    return playerId;
  }

  async createDevicePlayer(input: { tokenHash: string; now: Date }): Promise<string> {
    assertReopenTokenHashV1(input.tokenHash);
    const playerId = reopenDevicePlayerIdV1(input.tokenHash);
    if (this.players.has(playerId)) throw new RouteStorageIntegrityError('duplicate device player');
    this.players.set(playerId, { createdAt: input.now.toISOString(), mergedInto: null, number: this.nextNumber++ });
    return playerId;
  }

  async devicePlayer(tokenHash: string): Promise<string | null> {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
    const playerId = reopenDevicePlayerIdV1(tokenHash);
    const player = this.players.get(playerId);
    return player && player.mergedInto === null ? playerId : null;
  }

  async savePicks(input: {
    roundId: string;
    playerId: string;
    picks: Record<string, ReopenSideV1>;
    now: Date;
  }): Promise<'saved' | 'locked' | 'unknown_round'> {
    assertReopenRoundIdV1(input.roundId);
    assertReopenPlayerV1(input.playerId);
    assertReopenPicksV1(input.picks);
    if (!this.players.has(input.playerId)) throw new RouteStorageIntegrityError('unknown player');
    const round = this.roundRows.get(input.roundId);
    if (!round) return 'unknown_round';
    if (input.now.getTime() >= Date.parse(round.locksAt)) return 'locked';
    this.picks.set(`${input.roundId}|${input.playerId}`, {
      roundId: input.roundId,
      playerId: input.playerId,
      picks: { ...input.picks },
      pickedAt: input.now.toISOString(),
    });
    return 'saved';
  }

  async picksOf(playerId: string): Promise<ReopenPicksRowV1[]> {
    assertReopenPlayerV1(playerId);
    return [...this.picks.values()]
      .filter((row) => row.playerId === playerId)
      .sort((a, b) => a.roundId.localeCompare(b.roundId))
      .map((row) => ({ roundId: row.roundId, picks: { ...row.picks }, pickedAt: row.pickedAt }));
  }

  async crowd(roundId: string): Promise<ReopenCrowdV1> {
    assertReopenRoundIdV1(roundId);
    const rows = [...this.picks.values()].filter((row) => row.roundId === roundId && Object.keys(row.picks).length > 0);
    const split: ReopenCrowdV1['split'] = {};
    for (const row of rows) {
      for (const [symbol, side] of Object.entries(row.picks)) {
        const count = split[symbol] ?? { up: 0, down: 0 };
        count[side] += 1;
        split[symbol] = count;
      }
    }
    return { players: rows.length, split };
  }

  private playerPicksV1(filter: (row: { roundId: string }) => boolean): ReopenPlayerPicksV1[] {
    return [...this.picks.values()]
      .filter((row) => filter(row) && Object.keys(row.picks).length > 0)
      .map((row) => ({
        roundId: row.roundId,
        playerId: row.playerId,
        playerNumber: this.players.get(row.playerId)!.number,
        picks: { ...row.picks },
      }))
      .sort((a, b) => a.roundId.localeCompare(b.roundId) || a.playerNumber - b.playerNumber);
  }

  async standings(): Promise<ReopenPlayerPicksV1[]> {
    return this.playerPicksV1((row) => this.roundRows.get(row.roundId)?.results != null);
  }

  async roundPicks(roundId: string): Promise<ReopenPlayerPicksV1[]> {
    assertReopenRoundIdV1(roundId);
    return this.playerPicksV1((row) => row.roundId === roundId);
  }

  async mergeDevice(input: { tokenHash: string; wallet: string; now: Date }): Promise<{ moved: number; dropped: number } | null> {
    assertReopenWalletV1(input.wallet);
    if (!/^[0-9a-f]{64}$/.test(input.tokenHash)) return null;
    const deviceId = reopenDevicePlayerIdV1(input.tokenHash);
    const walletId = reopenWalletPlayerIdV1(input.wallet);
    const device = this.players.get(deviceId);
    // The SQL merges only into a wallet player that exists, and otherwise
    // merges nothing.
    if (!device || device.mergedInto !== null || !this.players.has(walletId)) return null;
    device.mergedInto = walletId;
    let moved = 0;
    let dropped = 0;
    for (const [key, row] of [...this.picks.entries()]) {
      if (row.playerId !== deviceId) continue;
      this.picks.delete(key);
      if (this.picks.has(`${row.roundId}|${walletId}`)) {
        dropped += 1;
        continue;
      }
      this.picks.set(`${row.roundId}|${walletId}`, { ...row, playerId: walletId });
      moved += 1;
    }
    return { moved, dropped };
  }

  async shareCode(input: { roundId: string; playerId: string; code: string; now: Date }): Promise<string | null> {
    assertReopenRoundIdV1(input.roundId);
    assertReopenPlayerV1(input.playerId);
    assertReopenShareCodeV1(input.code);
    const made = [...this.shares.values()].find(
      (row) => row.roundId === input.roundId && row.playerId === input.playerId,
    );
    if (made) return made.code;
    const round = this.roundRows.get(input.roundId);
    const picked = this.picks.get(`${input.roundId}|${input.playerId}`);
    if (!round || round.results === null || !picked || Object.keys(picked.picks).length === 0) return null;
    if (this.shares.has(input.code)) throw new RouteStorageIntegrityError('duplicate share code');
    this.shares.set(input.code, {
      code: input.code,
      roundId: input.roundId,
      playerId: input.playerId,
      picks: { ...picked.picks },
      createdAt: input.now.toISOString(),
    });
    return input.code;
  }

  async share(code: string): Promise<ReopenShareRowV1 | null> {
    if (!isReopenShareCodeV1(code)) return null;
    const row = this.shares.get(code);
    return row ? { code: row.code, roundId: row.roundId, picks: { ...row.picks }, createdAt: row.createdAt } : null;
  }
}
