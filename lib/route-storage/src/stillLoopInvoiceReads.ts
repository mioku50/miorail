import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Still: a Loop card's Bitrefill invoice, kept to read its delivery after the
// open order is gone (lib/db/drizzle/0108_still_loop_invoice_reads.sql, audit
// LOOP-1, 2026-11-21). One row per invoice: what to read it with, encrypted
// by the server before it gets here, when it was opened and when last read.
// This module never sees the token itself.
// ---------------------------------------------------------------------------

export interface StillLoopInvoiceReadRowV1 {
  orderId: string;
  walletAddress: string;
  /** {invoiceId, accessToken}, encrypted with a key the database does not hold. */
  readEnc: string;
  createdAt: string;
  readAt: string | null;
}

export interface StillLoopInvoiceReadRepositoryV1 {
  /** Kept once per invoice; a second keep of the same invoice changes nothing. */
  keep(input: { orderId: string; walletAddress: string; readEnc: string; at: Date }): Promise<void>;
  get(input: { orderId: string; walletAddress: string }): Promise<StillLoopInvoiceReadRowV1 | null>;
  /** When it was last asked: a read is not repeated sooner than the ticker's pace. */
  touched(input: { orderId: string; at: Date }): Promise<void>;
  /** Once Bitrefill's word on the card is in. */
  forget(input: { orderId: string }): Promise<void>;
  /** Every row opened before `before`; returns how many went. */
  prune(input: { before: Date }): Promise<number>;
}

const ORDER_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WALLET_V1 = /^0x[0-9a-f]{40}$/;
function assertKeyV1(input: { orderId: string; walletAddress?: string }): void {
  if (!ORDER_V1.test(input.orderId)) throw new Error('still_loop_invoice_order_invalid');
  if (input.walletAddress !== undefined && !WALLET_V1.test(input.walletAddress)) throw new Error('still_loop_invoice_wallet_invalid');
}
function assertKeepV1(input: { orderId: string; walletAddress: string; readEnc: string }): void {
  assertKeyV1(input);
  if (input.readEnc.length < 16 || input.readEnc.length > 4000) throw new Error('still_loop_invoice_read_invalid');
}

export class InMemoryStillLoopInvoiceReadRepositoryV1 implements StillLoopInvoiceReadRepositoryV1 {
  private rows = new Map<string, StillLoopInvoiceReadRowV1>();
  async keep(input: { orderId: string; walletAddress: string; readEnc: string; at: Date }): Promise<void> {
    assertKeepV1(input);
    if (!this.rows.has(input.orderId)) {
      this.rows.set(input.orderId, { orderId: input.orderId, walletAddress: input.walletAddress, readEnc: input.readEnc, createdAt: input.at.toISOString(), readAt: null });
    }
  }
  async get(input: { orderId: string; walletAddress: string }): Promise<StillLoopInvoiceReadRowV1 | null> {
    assertKeyV1(input);
    const row = this.rows.get(input.orderId);
    return row && row.walletAddress === input.walletAddress ? { ...row } : null;
  }
  async touched(input: { orderId: string; at: Date }): Promise<void> {
    assertKeyV1(input);
    const row = this.rows.get(input.orderId);
    if (row) row.readAt = input.at.toISOString();
  }
  async forget(input: { orderId: string }): Promise<void> {
    assertKeyV1(input);
    this.rows.delete(input.orderId);
  }
  async prune(input: { before: Date }): Promise<number> {
    let gone = 0;
    for (const [id, row] of this.rows) {
      if (Date.parse(row.createdAt) < input.before.getTime()) {
        this.rows.delete(id);
        gone += 1;
      }
    }
    return gone;
  }
}

const isoV1 = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string | Date).toISOString());

export function createDatabaseStillLoopInvoiceReadRepositoryV1(sql: SqlTemplateExecutor): StillLoopInvoiceReadRepositoryV1 {
  return {
    async keep(input) {
      assertKeepV1(input);
      await sql`
        INSERT INTO still_loop_invoice_reads (order_id, wallet_address, read_enc, created_at)
        VALUES (${input.orderId}::uuid, ${input.walletAddress}, ${input.readEnc}, ${input.at.toISOString()}::timestamptz)
        ON CONFLICT (order_id) DO NOTHING`;
    },
    async get(input) {
      assertKeyV1(input);
      const rows = await sql`
        SELECT order_id, wallet_address, read_enc, created_at, read_at FROM still_loop_invoice_reads
         WHERE order_id = ${input.orderId}::uuid AND wallet_address = ${input.walletAddress}`;
      const row = rows[0];
      return row ? { orderId: String(row.order_id), walletAddress: String(row.wallet_address), readEnc: String(row.read_enc),
        createdAt: isoV1(row.created_at)!, readAt: isoV1(row.read_at) } : null;
    },
    async touched(input) {
      assertKeyV1(input);
      await sql`UPDATE still_loop_invoice_reads SET read_at = ${input.at.toISOString()}::timestamptz WHERE order_id = ${input.orderId}::uuid`;
    },
    async forget(input) {
      assertKeyV1(input);
      await sql`DELETE FROM still_loop_invoice_reads WHERE order_id = ${input.orderId}::uuid`;
    },
    async prune(input) {
      const rows = await sql`DELETE FROM still_loop_invoice_reads WHERE created_at < ${input.before.toISOString()}::timestamptz RETURNING order_id`;
      return rows.length;
    },
  };
}
