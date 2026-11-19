import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Still: Loops, as written (lib/db/drizzle/0102_still_loops.sql).
//
// A Loop is a Still loan against one company's stock that paid, in the same
// batch, a Bitrefill card of that same company. A confirmed attempt becomes a
// Loop once, numbered after every Loop already written: one statement takes
// the next number, and a race that takes the same one writes nothing, so the
// next pass writes it. Numbers have no gaps and never move.
// ---------------------------------------------------------------------------

export const STILL_LOOP_VIAS_V1 = ['web', 'claude', 'chatgpt', 'grok', 'assistant'] as const;
export type StillLoopViaV1 = (typeof STILL_LOOP_VIAS_V1)[number];
export const STILL_LOOP_UNDELIVERED_V1 = ['blocked', 'denied', 'payment_error'] as const;
export type StillLoopUndeliveredV1 = (typeof STILL_LOOP_UNDELIVERED_V1)[number];

export interface StillLoopCandidateV1 {
  executionId: string;
  walletAddress: string;
  brand: 'apple' | 'amazon' | 'google' | 'meta' | 'microsoft';
  collateral: 'AAPLc' | 'AMZNc' | 'GOOGLc' | 'METAc' | 'MSFTc';
  productId: string;
  productName: string;
  packageLabel: string;
  /** USDC base units, to the whole dollar (shareAmountAtomicV1). */
  priceRoundedAtomic: string;
  venue: 'aave-v4' | 'morpho';
  via: StillLoopViaV1;
  team: boolean;
  confirmedAt: string;
}

export interface StillLoopV1 extends StillLoopCandidateV1 {
  loopNo: number;
  deliveredAt: string | null;
  undelivered: StillLoopUndeliveredV1 | null;
  onWall: boolean;
  wallLabel: string | null;
  walledAt: string | null;
}

export interface StillLoopCountsV1 {
  /** Complete Loops (the card arrived) by wallets outside the team. */
  total: number;
  /** The same, confirmed at or after `weekSince`. */
  week: number;
  byBrand: Record<StillLoopCandidateV1['brand'], number>;
  /** Of `total`, prepared through a connected assistant. */
  viaAssistant: number;
}

export interface StillLoopRepositoryV1 {
  /** Writes each candidate not yet written, in the order confirmed, and returns every candidate as stored. */
  record(candidates: readonly StillLoopCandidateV1[]): Promise<StillLoopV1[]>;
  byExecution(executionId: string): Promise<StillLoopV1 | null>;
  /** Bitrefill's word on the card. The first answer stands. */
  markDelivery(input: { executionId: string; outcome: 'complete' | StillLoopUndeliveredV1; at: Date }): Promise<StillLoopV1 | null>;
  /** The owner's own choice to show a complete Loop on the wall; a team Loop never goes. */
  putOnWall(input: { executionId: string; walletAddress: string; label: string | null; at: Date }): Promise<StillLoopV1 | null>;
  /** Loops on the wall, the latest shown first. */
  wall(input: { limit: number }): Promise<StillLoopV1[]>;
  /** One wallet's own Loops, the newest first: for its owner's page only. */
  byWallet(input: { walletAddress: string; limit: number }): Promise<StillLoopV1[]>;
  counts(input: { weekSince: Date }): Promise<StillLoopCountsV1>;
}

const BRANDS_V1 = ['apple', 'amazon', 'google', 'meta', 'microsoft'] as const;
const zeroBrandsV1 = (): StillLoopCountsV1['byBrand'] => ({ apple: 0, amazon: 0, google: 0, meta: 0, microsoft: 0 });
const WALL_LABEL_V1 = /^[a-z0-9-]{1,63}\.base\.eth$/;
const PAIRS_V1: Readonly<Record<StillLoopCandidateV1['brand'], StillLoopCandidateV1['collateral']>> = { apple: 'AAPLc', amazon: 'AMZNc', google: 'GOOGLc', meta: 'METAc', microsoft: 'MSFTc' };
const LABEL_V1 = (value: unknown, max: number): boolean => typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= max;

function assertCandidateV1(c: StillLoopCandidateV1): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.executionId)
    || !/^0x[0-9a-f]{40}$/.test(c.walletAddress)
    || !BRANDS_V1.includes(c.brand) || PAIRS_V1[c.brand] !== c.collateral || !/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(c.productId)
    || !LABEL_V1(c.productName, 120) || !LABEL_V1(c.packageLabel, 84) || (c.venue !== 'aave-v4' && c.venue !== 'morpho') || typeof c.team !== 'boolean'
    || !/^[1-9]\d{0,13}000000$/.test(c.priceRoundedAtomic) || !STILL_LOOP_VIAS_V1.includes(c.via)
    || !Number.isFinite(Date.parse(c.confirmedAt))) throw new Error('still_loop_invalid');
}

export class InMemoryStillLoopRepositoryV1 implements StillLoopRepositoryV1 {
  private readonly rows = new Map<string, StillLoopV1>();

  async record(candidates: readonly StillLoopCandidateV1[]): Promise<StillLoopV1[]> {
    candidates.forEach(assertCandidateV1);
    const ordered = [...candidates].sort((a, b) => Date.parse(a.confirmedAt) - Date.parse(b.confirmedAt) || a.executionId.localeCompare(b.executionId));
    for (const c of ordered) {
      if (this.rows.has(c.executionId)) continue;
      const next = Math.max(0, ...[...this.rows.values()].map((row) => row.loopNo)) + 1;
      this.rows.set(c.executionId, { ...c, loopNo: next, deliveredAt: null, undelivered: null, onWall: false, wallLabel: null, walledAt: null });
    }
    return candidates.map((c) => ({ ...this.rows.get(c.executionId)! }));
  }

  async byExecution(executionId: string): Promise<StillLoopV1 | null> {
    const row = this.rows.get(executionId);
    return row ? { ...row } : null;
  }

  async markDelivery(input: { executionId: string; outcome: 'complete' | StillLoopUndeliveredV1; at: Date }): Promise<StillLoopV1 | null> {
    const row = this.rows.get(input.executionId);
    if (!row) return null;
    if (row.deliveredAt === null && row.undelivered === null) {
      if (input.outcome === 'complete') row.deliveredAt = input.at.toISOString();
      else row.undelivered = input.outcome;
    }
    return { ...row };
  }

  async putOnWall(input: { executionId: string; walletAddress: string; label: string | null; at: Date }): Promise<StillLoopV1 | null> {
    if (input.label !== null && !WALL_LABEL_V1.test(input.label)) throw new Error('still_loop_label_invalid');
    const row = this.rows.get(input.executionId);
    if (!row || row.walletAddress !== input.walletAddress || row.team || row.deliveredAt === null) return null;
    if (!row.onWall) Object.assign(row, { onWall: true, wallLabel: input.label, walledAt: input.at.toISOString() });
    return { ...row };
  }

  async wall(input: { limit: number }): Promise<StillLoopV1[]> {
    return [...this.rows.values()].filter((row) => row.onWall)
      .sort((a, b) => Date.parse(b.walledAt!) - Date.parse(a.walledAt!) || b.loopNo - a.loopNo)
      .slice(0, Math.max(0, Math.min(input.limit, 100))).map((row) => ({ ...row }));
  }

  async byWallet(input: { walletAddress: string; limit: number }): Promise<StillLoopV1[]> {
    return [...this.rows.values()].filter((row) => row.walletAddress === input.walletAddress.toLowerCase())
      .sort((a, b) => b.loopNo - a.loopNo)
      .slice(0, Math.max(0, Math.min(input.limit, 100))).map((row) => ({ ...row }));
  }

  async counts(input: { weekSince: Date }): Promise<StillLoopCountsV1> {
    const complete = [...this.rows.values()].filter((row) => !row.team && row.deliveredAt !== null);
    const byBrand = zeroBrandsV1();
    for (const row of complete) byBrand[row.brand] += 1;
    return {
      total: complete.length,
      week: complete.filter((row) => Date.parse(row.confirmedAt) >= input.weekSince.getTime()).length,
      byBrand,
      viaAssistant: complete.filter((row) => row.via !== 'web').length,
    };
  }
}

const isoV1 = (value: unknown): string | null => value === null || value === undefined ? null : new Date(value as string | Date).toISOString();

function loopOfRowV1(row: Record<string, unknown>): StillLoopV1 {
  return {
    executionId: String(row.execution_id),
    loopNo: Number(row.loop_no),
    walletAddress: String(row.wallet_address),
    brand: String(row.brand) as StillLoopV1['brand'],
    collateral: String(row.collateral) as StillLoopV1['collateral'],
    productId: String(row.product_id),
    productName: String(row.product_name),
    packageLabel: String(row.package_label),
    priceRoundedAtomic: String(row.price_rounded_atomic),
    venue: String(row.venue) as StillLoopV1['venue'],
    via: String(row.via) as StillLoopViaV1,
    team: row.team === true,
    confirmedAt: isoV1(row.confirmed_at)!,
    deliveredAt: isoV1(row.delivered_at),
    undelivered: row.undelivered === null || row.undelivered === undefined ? null : String(row.undelivered) as StillLoopUndeliveredV1,
    onWall: row.on_wall === true,
    wallLabel: row.wall_label === null || row.wall_label === undefined ? null : String(row.wall_label),
    walledAt: isoV1(row.walled_at),
  };
}

export function createDatabaseStillLoopRepositoryV1(sql: SqlTemplateExecutor): StillLoopRepositoryV1 {
  const byExecution = async (executionId: string): Promise<StillLoopV1 | null> => {
    const rows = await sql`SELECT * FROM still_loops WHERE execution_id = ${executionId}::uuid`;
    return rows[0] ? loopOfRowV1(rows[0]) : null;
  };
  return {
    async record(candidates) {
      candidates.forEach(assertCandidateV1);
      const ordered = [...candidates].sort((a, b) => Date.parse(a.confirmedAt) - Date.parse(b.confirmedAt) || a.executionId.localeCompare(b.executionId));
      for (const c of ordered) {
        // One statement takes the next number. Two passes racing for the same number: one writes, the
        // other writes nothing (the unique number), and the next pass writes it. No gap, no repeat.
        await sql`
          INSERT INTO still_loops (execution_id, loop_no, wallet_address, brand, collateral, product_id, product_name, package_label,
            price_rounded_atomic, venue, via, team, confirmed_at)
          SELECT ${c.executionId}::uuid, COALESCE((SELECT max(loop_no) FROM still_loops), 0) + 1, ${c.walletAddress}, ${c.brand}, ${c.collateral},
            ${c.productId}, ${c.productName}, ${c.packageLabel}, ${c.priceRoundedAtomic}::numeric, ${c.venue}, ${c.via}, ${c.team}, ${c.confirmedAt}::timestamptz
          WHERE NOT EXISTS (SELECT 1 FROM still_loops WHERE execution_id = ${c.executionId}::uuid)
          ON CONFLICT DO NOTHING`;
      }
      const out: StillLoopV1[] = [];
      for (const c of candidates) {
        const row = await byExecution(c.executionId);
        if (row) out.push(row);
      }
      return out;
    },
    byExecution,
    async markDelivery(input) {
      const delivered = input.outcome === 'complete';
      await sql`
        UPDATE still_loops
        SET delivered_at = ${delivered ? input.at.toISOString() : null}::timestamptz,
            undelivered = ${delivered ? null : input.outcome}
        WHERE execution_id = ${input.executionId}::uuid AND delivered_at IS NULL AND undelivered IS NULL`;
      return byExecution(input.executionId);
    },
    async putOnWall(input) {
      if (input.label !== null && !WALL_LABEL_V1.test(input.label)) throw new Error('still_loop_label_invalid');
      await sql`
        UPDATE still_loops
        SET on_wall = true, wall_label = ${input.label}, walled_at = ${input.at.toISOString()}::timestamptz
        WHERE execution_id = ${input.executionId}::uuid AND wallet_address = ${input.walletAddress}
          AND NOT team AND delivered_at IS NOT NULL AND NOT on_wall`;
      const row = await byExecution(input.executionId);
      return row && row.walletAddress === input.walletAddress && row.onWall ? row : null;
    },
    async wall(input) {
      const limit = Math.max(0, Math.min(Math.trunc(input.limit), 100));
      const rows = await sql`SELECT * FROM still_loops WHERE on_wall ORDER BY walled_at DESC, loop_no DESC LIMIT ${limit}`;
      return rows.map(loopOfRowV1);
    },
    async byWallet(input) {
      const limit = Math.max(0, Math.min(Math.trunc(input.limit), 100));
      const rows = await sql`SELECT * FROM still_loops WHERE wallet_address = ${input.walletAddress.toLowerCase()} ORDER BY loop_no DESC LIMIT ${limit}`;
      return rows.map(loopOfRowV1);
    },
    async counts(input) {
      const rows = await sql`
        SELECT brand, count(*)::int AS n,
          count(*) FILTER (WHERE confirmed_at >= ${input.weekSince.toISOString()}::timestamptz)::int AS week,
          count(*) FILTER (WHERE via <> 'web')::int AS assistant
        FROM still_loops WHERE NOT team AND delivered_at IS NOT NULL GROUP BY brand`;
      const byBrand = zeroBrandsV1();
      let total = 0, week = 0, viaAssistant = 0;
      for (const row of rows) {
        const brand = String(row.brand) as keyof typeof byBrand;
        if (!(brand in byBrand)) continue;
        byBrand[brand] = Number(row.n);
        total += Number(row.n); week += Number(row.week); viaAssistant += Number(row.assistant);
      }
      return { total, week, byBrand, viaAssistant };
    },
  };
}
