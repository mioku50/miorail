import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Still: the Loop draws, as written (lib/db/drizzle/0103_still_loop_draws.sql).
//
// A free entry is written once per wallet per draw, and never after the
// draw's list is fixed. The list is written once, with its hash; the block
// that picks and the winners' numbers once afterwards; each winner's payment
// once.
// Every write is one statement that does nothing when it already happened,
// so two passes racing for the same step leave one answer.
// ---------------------------------------------------------------------------

export interface StillLoopFreeEntryV1 {
  drawId: string;
  walletAddress: string;
  /** The entry's public name: six letters and digits, "Entry K3F9X2". */
  code: string;
  enteredAt: string;
}

export interface StillLoopDrawEntryV1 {
  /** As served: "Loop #3" or "Entry K3F9X2". */
  label: string;
  /** Never served. */
  walletAddress: string;
  kind: 'loop' | 'free';
  loopNo: number | null;
  enteredAt: string;
}

export interface StillLoopDrawRecordV1 {
  drawId: string;
  opensAt: string;
  closesAt: string;
  /** USDC base units, to each winner. */
  prizeAtomic: string;
  /** How many entries win; fewer when fewer entered. */
  winnerCount: number;
  entries: StillLoopDrawEntryV1[];
  entryCount: number;
  entriesHash: string;
  lockedAt: string;
  blockNumber: string | null;
  blockHash: string | null;
  blockTime: string | null;
  /** The winning entries' numbers in `entries`, from 1, in the order picked. */
  winnerNos: number[] | null;
  drawnAt: string | null;
  /** One per winner whose prize was sent. */
  payouts: StillLoopDrawPayoutV1[];
}

export interface StillLoopDrawPayoutV1 {
  no: number;
  tx: string;
  at: string;
}

export type StillLoopFreeEntryOutcomeV1 =
  | { outcome: 'entered' | 'already'; entry: StillLoopFreeEntryV1 }
  /** The draw's list is fixed: nothing is written. */
  | { outcome: 'locked' }
  /** Another wallet holds this code in this draw: nothing is written; ask again with another. */
  | { outcome: 'code_taken' };

export interface StillLoopDrawRepositoryV1 {
  enterFree(input: { drawId: string; walletAddress: string; code: string; at: Date }): Promise<StillLoopFreeEntryOutcomeV1>;
  freeEntry(input: { drawId: string; walletAddress: string }): Promise<StillLoopFreeEntryV1 | null>;
  /** The draw's free entries made before `before`. */
  freeEntries(input: { drawId: string; before: Date }): Promise<StillLoopFreeEntryV1[]>;
  /** Fixes the draw's list, once; returns the list as stored, which a racing pass may have written. */
  lock(input: {
    drawId: string; opensAt: string; closesAt: string; prizeAtomic: string; winnerCount: number; entries: readonly StillLoopDrawEntryV1[]; entriesHash: string;
    lockedAt: Date;
  }): Promise<StillLoopDrawRecordV1>;
  byId(drawId: string): Promise<StillLoopDrawRecordV1 | null>;
  all(): Promise<StillLoopDrawRecordV1[]>;
  /** The block that picked and the winners' numbers, once; a draw nobody entered is drawn with neither. */
  drawn(input: { drawId: string; block: { number: string; hash: string; time: string } | null; winnerNos: number[] | null; at: Date }): Promise<StillLoopDrawRecordV1 | null>;
  /** Winner `no`'s prize was sent, once; null when the draw has no such winner. */
  paid(input: { drawId: string; no: number; paidTx: string; at: Date }): Promise<StillLoopDrawRecordV1 | null>;
}

const DRAW_ID_V1 = /^\d{4}-\d{2}-\d{2}$/;
const WALLET_V1 = /^0x[0-9a-f]{40}$/;
export const STILL_LOOP_ENTRY_CODE_V1 = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;
const HASH_V1 = /^0x[0-9a-f]{64}$/;
const ATOMIC_V1 = /^\d{1,20}$/;

function invalid(): never {
  throw new Error('still_loop_draw_invalid');
}

function assertEntryV1(input: { drawId: string; walletAddress: string; code: string; at: Date }): void {
  if (!DRAW_ID_V1.test(input.drawId) || !WALLET_V1.test(input.walletAddress) || !STILL_LOOP_ENTRY_CODE_V1.test(input.code)
    || !Number.isFinite(input.at.getTime())) invalid();
}

function assertListV1(input: Parameters<StillLoopDrawRepositoryV1['lock']>[0]): void {
  const opens = Date.parse(input.opensAt), closes = Date.parse(input.closesAt);
  if (!DRAW_ID_V1.test(input.drawId) || !Number.isFinite(opens) || !Number.isFinite(closes) || !(opens < closes)
    || !(closes <= input.lockedAt.getTime()) || !ATOMIC_V1.test(input.prizeAtomic) || BigInt(input.prizeAtomic) < 1_000_000n
    || !Number.isSafeInteger(input.winnerCount) || input.winnerCount < 1 || input.winnerCount > 20 || !HASH_V1.test(input.entriesHash)) invalid();
  for (const entry of input.entries) {
    if (typeof entry.label !== 'string' || entry.label.length < 1 || entry.label.length > 40 || !WALLET_V1.test(entry.walletAddress)
      || (entry.kind !== 'loop' && entry.kind !== 'free') || !Number.isFinite(Date.parse(entry.enteredAt))) invalid();
  }
}

function assertDrawnV1(record: StillLoopDrawRecordV1, input: Parameters<StillLoopDrawRepositoryV1['drawn']>[0]): void {
  const { block, winnerNos } = input;
  if (block && (!HASH_V1.test(block.hash) || !/^\d{1,19}$/.test(block.number) || !Number.isFinite(Date.parse(block.time)))) invalid();
  if (winnerNos !== null && (!block || winnerNos.length !== Math.min(record.winnerCount, record.entryCount) || new Set(winnerNos).size !== winnerNos.length
    || winnerNos.some((no) => !Number.isSafeInteger(no) || no < 1 || no > record.entryCount))) invalid();
  if (record.entryCount > 0 && winnerNos === null) invalid();
  if (input.at.getTime() < Date.parse(record.lockedAt)) invalid();
}

const copyV1 = (record: StillLoopDrawRecordV1): StillLoopDrawRecordV1 => ({
  ...record, entries: record.entries.map((entry) => ({ ...entry })), winnerNos: record.winnerNos ? [...record.winnerNos] : null,
  payouts: record.payouts.map((payout) => ({ ...payout })),
});

export class InMemoryStillLoopDrawRepositoryV1 implements StillLoopDrawRepositoryV1 {
  private readonly free = new Map<string, StillLoopFreeEntryV1>();
  private readonly draws = new Map<string, StillLoopDrawRecordV1>();

  async enterFree(input: { drawId: string; walletAddress: string; code: string; at: Date }): Promise<StillLoopFreeEntryOutcomeV1> {
    assertEntryV1(input);
    const key = `${input.drawId}|${input.walletAddress}`;
    const had = this.free.get(key);
    if (had) return { outcome: 'already', entry: { ...had } };
    if (this.draws.has(input.drawId)) return { outcome: 'locked' };
    if ([...this.free.values()].some((entry) => entry.drawId === input.drawId && entry.code === input.code)) return { outcome: 'code_taken' };
    const entry = { drawId: input.drawId, walletAddress: input.walletAddress, code: input.code, enteredAt: input.at.toISOString() };
    this.free.set(key, entry);
    return { outcome: 'entered', entry: { ...entry } };
  }

  async freeEntry(input: { drawId: string; walletAddress: string }): Promise<StillLoopFreeEntryV1 | null> {
    const entry = this.free.get(`${input.drawId}|${input.walletAddress}`);
    return entry ? { ...entry } : null;
  }

  async freeEntries(input: { drawId: string; before: Date }): Promise<StillLoopFreeEntryV1[]> {
    return [...this.free.values()].filter((entry) => entry.drawId === input.drawId && Date.parse(entry.enteredAt) < input.before.getTime())
      .sort((a, b) => Date.parse(a.enteredAt) - Date.parse(b.enteredAt) || a.code.localeCompare(b.code)).map((entry) => ({ ...entry }));
  }

  async lock(input: Parameters<StillLoopDrawRepositoryV1['lock']>[0]): Promise<StillLoopDrawRecordV1> {
    assertListV1(input);
    if (!this.draws.has(input.drawId)) {
      this.draws.set(input.drawId, {
        drawId: input.drawId, opensAt: new Date(input.opensAt).toISOString(), closesAt: new Date(input.closesAt).toISOString(), prizeAtomic: input.prizeAtomic,
        winnerCount: input.winnerCount, entries: input.entries.map((entry) => ({ ...entry, enteredAt: new Date(entry.enteredAt).toISOString() })),
        entryCount: input.entries.length, entriesHash: input.entriesHash, lockedAt: input.lockedAt.toISOString(),
        blockNumber: null, blockHash: null, blockTime: null, winnerNos: null, drawnAt: null, payouts: [],
      });
    }
    return copyV1(this.draws.get(input.drawId)!);
  }

  async byId(drawId: string): Promise<StillLoopDrawRecordV1 | null> {
    const record = this.draws.get(drawId);
    return record ? copyV1(record) : null;
  }

  async all(): Promise<StillLoopDrawRecordV1[]> {
    return [...this.draws.values()].sort((a, b) => Date.parse(a.closesAt) - Date.parse(b.closesAt)).map(copyV1);
  }

  async drawn(input: Parameters<StillLoopDrawRepositoryV1['drawn']>[0]): Promise<StillLoopDrawRecordV1 | null> {
    const record = this.draws.get(input.drawId);
    if (!record) return null;
    if (record.drawnAt === null) {
      assertDrawnV1(record, input);
      Object.assign(record, {
        blockNumber: input.block?.number ?? null, blockHash: input.block?.hash ?? null,
        blockTime: input.block ? new Date(input.block.time).toISOString() : null, winnerNos: input.winnerNos ? [...input.winnerNos] : null,
        drawnAt: input.at.toISOString(),
      });
    }
    return copyV1(record);
  }

  async paid(input: { drawId: string; no: number; paidTx: string; at: Date }): Promise<StillLoopDrawRecordV1 | null> {
    if (!HASH_V1.test(input.paidTx) || !Number.isSafeInteger(input.no)) invalid();
    const record = this.draws.get(input.drawId);
    if (!record || !record.winnerNos?.includes(input.no)) return null;
    if (!record.payouts.some((payout) => payout.no === input.no)) record.payouts.push({ no: input.no, tx: input.paidTx, at: input.at.toISOString() });
    return copyV1(record);
  }
}

const isoV1 = (value: unknown): string | null => value === null || value === undefined ? null : new Date(value as string | Date).toISOString();

function freeOfRowV1(row: Record<string, unknown>): StillLoopFreeEntryV1 {
  return { drawId: String(row.draw_id), walletAddress: String(row.wallet_address), code: String(row.code), enteredAt: isoV1(row.entered_at)! };
}

function entriesOfV1(value: unknown): StillLoopDrawEntryV1[] {
  const list = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(list)) return [];
  return list.map((raw) => {
    const entry = raw as Record<string, unknown>;
    return {
      label: String(entry.label), walletAddress: String(entry.walletAddress), kind: entry.kind === 'loop' ? 'loop' as const : 'free' as const,
      loopNo: typeof entry.loopNo === 'number' ? entry.loopNo : null, enteredAt: String(entry.enteredAt),
    };
  });
}

const jsonV1 = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) as unknown : value;

function drawOfRowV1(row: Record<string, unknown>): StillLoopDrawRecordV1 {
  const text = (value: unknown) => value === null || value === undefined ? null : String(value);
  const winners = jsonV1(row.winner_nos), payouts = jsonV1(row.payouts);
  return {
    drawId: String(row.draw_id), opensAt: isoV1(row.opens_at)!, closesAt: isoV1(row.closes_at)!, prizeAtomic: String(row.prize_atomic),
    winnerCount: Number(row.winner_count), entries: entriesOfV1(row.entries), entryCount: Number(row.entry_count), entriesHash: String(row.entries_hash),
    lockedAt: isoV1(row.locked_at)!, blockNumber: text(row.block_number), blockHash: text(row.block_hash), blockTime: isoV1(row.block_time),
    winnerNos: Array.isArray(winners) ? winners.map(Number) : null, drawnAt: isoV1(row.drawn_at),
    payouts: Array.isArray(payouts) ? payouts.map((raw) => {
      const payout = raw as Record<string, unknown>;
      return { no: Number(payout.no), tx: String(payout.tx), at: new Date(String(payout.at)).toISOString() };
    }) : [],
  };
}

export function createDatabaseStillLoopDrawRepositoryV1(sql: SqlTemplateExecutor): StillLoopDrawRepositoryV1 {
  const freeEntry = async (input: { drawId: string; walletAddress: string }) => {
    const rows = await sql`SELECT * FROM still_loop_free_entries WHERE draw_id = ${input.drawId} AND wallet_address = ${input.walletAddress}`;
    return rows[0] ? freeOfRowV1(rows[0]) : null;
  };
  const byId = async (drawId: string) => {
    const rows = await sql`SELECT * FROM still_loop_draws WHERE draw_id = ${drawId}`;
    return rows[0] ? drawOfRowV1(rows[0]) : null;
  };
  return {
    async enterFree(input) {
      assertEntryV1(input);
      // Never once the list is fixed: the draw's row is written when it is.
      const written = await sql`
        INSERT INTO still_loop_free_entries (draw_id, wallet_address, code, entered_at)
        SELECT ${input.drawId}, ${input.walletAddress}, ${input.code}, ${input.at.toISOString()}::timestamptz
        WHERE NOT EXISTS (SELECT 1 FROM still_loop_draws WHERE draw_id = ${input.drawId})
        ON CONFLICT DO NOTHING
        RETURNING *`;
      if (written[0]) return { outcome: 'entered', entry: freeOfRowV1(written[0]) };
      const had = await freeEntry(input);
      if (had) return { outcome: 'already', entry: had };
      return (await byId(input.drawId)) ? { outcome: 'locked' } : { outcome: 'code_taken' };
    },
    freeEntry,
    async freeEntries(input) {
      const rows = await sql`
        SELECT * FROM still_loop_free_entries WHERE draw_id = ${input.drawId} AND entered_at < ${input.before.toISOString()}::timestamptz
        ORDER BY entered_at, code`;
      return rows.map(freeOfRowV1);
    },
    async lock(input) {
      assertListV1(input);
      const entries = input.entries.map((entry) => ({ ...entry, enteredAt: new Date(entry.enteredAt).toISOString() }));
      await sql`
        INSERT INTO still_loop_draws (draw_id, opens_at, closes_at, prize_atomic, winner_count, entries, entry_count, entries_hash, locked_at)
        VALUES (${input.drawId}, ${input.opensAt}::timestamptz, ${input.closesAt}::timestamptz, ${input.prizeAtomic}::numeric, ${input.winnerCount}::integer,
          ${JSON.stringify(entries)}::text::jsonb, ${entries.length}, ${input.entriesHash}, ${input.lockedAt.toISOString()}::timestamptz)
        ON CONFLICT (draw_id) DO NOTHING`;
      return (await byId(input.drawId))!;
    },
    byId,
    async all() {
      const rows = await sql`SELECT * FROM still_loop_draws ORDER BY closes_at`;
      return rows.map(drawOfRowV1);
    },
    async drawn(input) {
      const record = await byId(input.drawId);
      if (!record) return null;
      if (record.drawnAt !== null) return record;
      assertDrawnV1(record, input);
      await sql`
        UPDATE still_loop_draws
        SET block_number = ${input.block?.number ?? null}::bigint, block_hash = ${input.block?.hash ?? null},
            block_time = ${input.block ? input.block.time : null}::timestamptz,
            winner_nos = ${input.winnerNos ? JSON.stringify(input.winnerNos) : null}::text::jsonb,
            drawn_at = ${input.at.toISOString()}::timestamptz
        WHERE draw_id = ${input.drawId} AND drawn_at IS NULL`;
      return byId(input.drawId);
    },
    async paid(input) {
      if (!HASH_V1.test(input.paidTx) || !Number.isSafeInteger(input.no)) invalid();
      // Once per winner: appended only to a draw this number won, and only when it is not there yet.
      await sql`
        UPDATE still_loop_draws
        SET payouts = payouts || ${JSON.stringify([{ no: input.no, tx: input.paidTx, at: input.at.toISOString() }])}::text::jsonb
        WHERE draw_id = ${input.drawId} AND winner_nos @> ${JSON.stringify([input.no])}::text::jsonb
          AND NOT (payouts @> ${JSON.stringify([{ no: input.no }])}::text::jsonb)`;
      const record = await byId(input.drawId);
      return record && record.winnerNos?.includes(input.no) ? record : null;
    },
  };
}
