import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Still: the Loop draws, as written (lib/db/drizzle/0103_still_loop_draws.sql,
// 0104_still_loop_draw_entries.sql).
//
// An entry is written once per wallet per draw, when its owner enters, and
// never after the draw's list is fixed: with the wallet's Loop of the draw,
// or free (audits LOOP-1 and LOOP-2, 2026-11-18). The list is written once,
// with its hash; the time-stamps public authorities gave that hash before the
// winners are picked (LOOP-4); the block that picks and the winners' numbers
// once afterwards; each winner's payment once.
// Every write is one statement that does nothing when it already happened,
// so two passes racing for the same step leave one answer.
// ---------------------------------------------------------------------------

export interface StillLoopEntryRowV1 {
  drawId: string;
  walletAddress: string;
  /** Six letters and digits, unique in the draw: a free entry's public name, "Entry K3F9X2". */
  code: string;
  /** "loop": entered with this wallet's Loop of the draw, named "Loop #3"; "free": no loan and no purchase. */
  kind: 'loop' | 'free';
  loopNo: number | null;
  enteredAt: string;
}

/** An RFC 3161 time-stamp a public authority gave the list's hash, before the winners were picked. */
export interface StillLoopDrawStampV1 {
  /** The authority's address, as asked. */
  tsa: string;
  /** The time the authority signed, by its own clock. */
  genTime: string;
  /** Its whole TimeStampResp, DER, in base64: anybody can check it with openssl. */
  token: string;
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
  /** The list's time-stamps, at most one per authority. */
  stamps: StillLoopDrawStampV1[];
}

export interface StillLoopDrawPayoutV1 {
  no: number;
  tx: string;
  at: string;
}

export type StillLoopEntryOutcomeV1 =
  | { outcome: 'entered' | 'already'; entry: StillLoopEntryRowV1 }
  /** The draw's list is fixed: nothing is written. */
  | { outcome: 'locked' }
  /** Another wallet holds this code in this draw: nothing is written; ask again with another. */
  | { outcome: 'code_taken' };

export interface StillLoopDrawRepositoryV1 {
  enter(input: { drawId: string; walletAddress: string; code: string; kind: 'loop' | 'free'; loopNo: number | null; at: Date }): Promise<StillLoopEntryOutcomeV1>;
  entryOf(input: { drawId: string; walletAddress: string }): Promise<StillLoopEntryRowV1 | null>;
  /** The draw's entries made before `before`, in the order made. */
  entries(input: { drawId: string; before: Date }): Promise<StillLoopEntryRowV1[]>;
  /** Fixes the draw's list, once; returns the list as stored, which a racing pass may have written. */
  lock(input: {
    drawId: string; opensAt: string; closesAt: string; prizeAtomic: string; winnerCount: number; entries: readonly StillLoopDrawEntryV1[]; entriesHash: string;
    lockedAt: Date;
  }): Promise<StillLoopDrawRecordV1>;
  /** One authority's time-stamp of the list, once per authority, and only before the winners are picked. */
  stamp(input: { drawId: string; stamp: StillLoopDrawStampV1 }): Promise<StillLoopDrawRecordV1 | null>;
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

function assertEntryV1(input: Parameters<StillLoopDrawRepositoryV1['enter']>[0]): void {
  if (!DRAW_ID_V1.test(input.drawId) || !WALLET_V1.test(input.walletAddress) || !STILL_LOOP_ENTRY_CODE_V1.test(input.code)
    || !Number.isFinite(input.at.getTime())) invalid();
  if (input.kind === 'free' ? input.loopNo !== null : input.kind !== 'loop' || !Number.isSafeInteger(input.loopNo) || input.loopNo! < 1) invalid();
}

const TSA_V1 = /^https?:\/\/[a-z0-9.-]{1,80}(?:\/[A-Za-z0-9._/-]{0,80})?$/;
const BASE64_V1 = /^[A-Za-z0-9+/]+={0,2}$/;

function assertStampV1(stamp: StillLoopDrawStampV1): void {
  if (!TSA_V1.test(stamp.tsa) || !Number.isFinite(Date.parse(stamp.genTime)) || stamp.token.length < 16 || stamp.token.length > 24_000
    || !BASE64_V1.test(stamp.token)) invalid();
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
  payouts: record.payouts.map((payout) => ({ ...payout })), stamps: record.stamps.map((stamp) => ({ ...stamp })),
});
const MAX_STAMPS_V1 = 4;

export class InMemoryStillLoopDrawRepositoryV1 implements StillLoopDrawRepositoryV1 {
  private readonly made = new Map<string, StillLoopEntryRowV1>();
  private readonly draws = new Map<string, StillLoopDrawRecordV1>();

  async enter(input: Parameters<StillLoopDrawRepositoryV1['enter']>[0]): Promise<StillLoopEntryOutcomeV1> {
    assertEntryV1(input);
    const key = `${input.drawId}|${input.walletAddress}`;
    const had = this.made.get(key);
    if (had) return { outcome: 'already', entry: { ...had } };
    if (this.draws.has(input.drawId)) return { outcome: 'locked' };
    if ([...this.made.values()].some((entry) => entry.drawId === input.drawId && entry.code === input.code)) return { outcome: 'code_taken' };
    const entry: StillLoopEntryRowV1 = { drawId: input.drawId, walletAddress: input.walletAddress, code: input.code, kind: input.kind, loopNo: input.loopNo,
      enteredAt: input.at.toISOString() };
    this.made.set(key, entry);
    return { outcome: 'entered', entry: { ...entry } };
  }

  async entryOf(input: { drawId: string; walletAddress: string }): Promise<StillLoopEntryRowV1 | null> {
    const entry = this.made.get(`${input.drawId}|${input.walletAddress}`);
    return entry ? { ...entry } : null;
  }

  async entries(input: { drawId: string; before: Date }): Promise<StillLoopEntryRowV1[]> {
    return [...this.made.values()].filter((entry) => entry.drawId === input.drawId && Date.parse(entry.enteredAt) < input.before.getTime())
      .sort((a, b) => Date.parse(a.enteredAt) - Date.parse(b.enteredAt) || a.code.localeCompare(b.code)).map((entry) => ({ ...entry }));
  }

  async stamp(input: { drawId: string; stamp: StillLoopDrawStampV1 }): Promise<StillLoopDrawRecordV1 | null> {
    assertStampV1(input.stamp);
    const record = this.draws.get(input.drawId);
    if (!record) return null;
    if (record.drawnAt === null && record.stamps.length < MAX_STAMPS_V1 && !record.stamps.some((stamp) => stamp.tsa === input.stamp.tsa)) {
      record.stamps.push({ ...input.stamp, genTime: new Date(input.stamp.genTime).toISOString() });
    }
    return copyV1(record);
  }

  async lock(input: Parameters<StillLoopDrawRepositoryV1['lock']>[0]): Promise<StillLoopDrawRecordV1> {
    assertListV1(input);
    if (!this.draws.has(input.drawId)) {
      this.draws.set(input.drawId, {
        drawId: input.drawId, opensAt: new Date(input.opensAt).toISOString(), closesAt: new Date(input.closesAt).toISOString(), prizeAtomic: input.prizeAtomic,
        winnerCount: input.winnerCount, entries: input.entries.map((entry) => ({ ...entry, enteredAt: new Date(entry.enteredAt).toISOString() })),
        entryCount: input.entries.length, entriesHash: input.entriesHash, lockedAt: input.lockedAt.toISOString(),
        blockNumber: null, blockHash: null, blockTime: null, winnerNos: null, drawnAt: null, payouts: [], stamps: [],
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

function entryOfRowV1(row: Record<string, unknown>): StillLoopEntryRowV1 {
  return { drawId: String(row.draw_id), walletAddress: String(row.wallet_address), code: String(row.code), kind: row.kind === 'loop' ? 'loop' : 'free',
    loopNo: row.loop_no === null || row.loop_no === undefined ? null : Number(row.loop_no), enteredAt: isoV1(row.entered_at)! };
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
  const winners = jsonV1(row.winner_nos), payouts = jsonV1(row.payouts), stamps = jsonV1(row.stamps);
  return {
    drawId: String(row.draw_id), opensAt: isoV1(row.opens_at)!, closesAt: isoV1(row.closes_at)!, prizeAtomic: String(row.prize_atomic),
    winnerCount: Number(row.winner_count), entries: entriesOfV1(row.entries), entryCount: Number(row.entry_count), entriesHash: String(row.entries_hash),
    lockedAt: isoV1(row.locked_at)!, blockNumber: text(row.block_number), blockHash: text(row.block_hash), blockTime: isoV1(row.block_time),
    winnerNos: Array.isArray(winners) ? winners.map(Number) : null, drawnAt: isoV1(row.drawn_at),
    payouts: Array.isArray(payouts) ? payouts.map((raw) => {
      const payout = raw as Record<string, unknown>;
      return { no: Number(payout.no), tx: String(payout.tx), at: new Date(String(payout.at)).toISOString() };
    }) : [],
    stamps: Array.isArray(stamps) ? stamps.map((raw) => {
      const stamp = raw as Record<string, unknown>;
      return { tsa: String(stamp.tsa), genTime: new Date(String(stamp.genTime)).toISOString(), token: String(stamp.token) };
    }) : [],
  };
}

export function createDatabaseStillLoopDrawRepositoryV1(sql: SqlTemplateExecutor): StillLoopDrawRepositoryV1 {
  const entryOf = async (input: { drawId: string; walletAddress: string }) => {
    const rows = await sql`SELECT * FROM still_loop_entries WHERE draw_id = ${input.drawId} AND wallet_address = ${input.walletAddress}`;
    return rows[0] ? entryOfRowV1(rows[0]) : null;
  };
  const byId = async (drawId: string) => {
    const rows = await sql`SELECT * FROM still_loop_draws WHERE draw_id = ${drawId}`;
    return rows[0] ? drawOfRowV1(rows[0]) : null;
  };
  return {
    async enter(input) {
      assertEntryV1(input);
      // Never once the list is fixed: the draw's row is written when it is.
      const written = await sql`
        INSERT INTO still_loop_entries (draw_id, wallet_address, code, kind, loop_no, entered_at)
        SELECT ${input.drawId}, ${input.walletAddress}, ${input.code}, ${input.kind}, ${input.loopNo}::integer, ${input.at.toISOString()}::timestamptz
        WHERE NOT EXISTS (SELECT 1 FROM still_loop_draws WHERE draw_id = ${input.drawId})
        ON CONFLICT DO NOTHING
        RETURNING *`;
      if (written[0]) return { outcome: 'entered', entry: entryOfRowV1(written[0]) };
      const had = await entryOf(input);
      if (had) return { outcome: 'already', entry: had };
      return (await byId(input.drawId)) ? { outcome: 'locked' } : { outcome: 'code_taken' };
    },
    entryOf,
    async entries(input) {
      const rows = await sql`
        SELECT * FROM still_loop_entries WHERE draw_id = ${input.drawId} AND entered_at < ${input.before.toISOString()}::timestamptz
        ORDER BY entered_at, code`;
      return rows.map(entryOfRowV1);
    },
    async stamp(input) {
      assertStampV1(input.stamp);
      const stamp = { ...input.stamp, genTime: new Date(input.stamp.genTime).toISOString() };
      // Once per authority, before the winners are picked, and no more than four.
      await sql`
        UPDATE still_loop_draws
        SET stamps = stamps || ${JSON.stringify([stamp])}::text::jsonb
        WHERE draw_id = ${input.drawId} AND drawn_at IS NULL AND jsonb_array_length(stamps) < ${MAX_STAMPS_V1}
          AND NOT (stamps @> ${JSON.stringify([{ tsa: stamp.tsa }])}::text::jsonb)`;
      return byId(input.drawId);
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
