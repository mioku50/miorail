import { randomBytes } from 'node:crypto';

import { RouteStorageIntegrityError } from './types.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Found's share cards: a collect or a claim that completed, made into a link
// the person can post on X or Farcaster.
//
// One card per Action Receipt, made by its owner's click and never before.
// What a card holds is what the picture shows: the protocol, the dollar value
// of what arrived (when the card was made), up to four token amounts as they
// are written on it, and the block the transaction landed in. No wallet, no
// transaction hash: the person posting chooses to say how much, not who.
// ---------------------------------------------------------------------------

export type FoundShareProtocolV1 = 'aerodrome' | 'uniswap';

export interface FoundShareTokenV1 {
  /** "WETH", as read from the token. */
  symbol: string;
  /** "0.0042", as the card writes it. */
  amount: string;
}

export interface FoundShareV1 {
  code: string;
  receiptId: string;
  protocol: FoundShareProtocolV1;
  /** What the collected amounts would have fetched in USDC when the card was made. */
  usdCents: number;
  /** The largest values first, at most four. */
  tokens: FoundShareTokenV1[];
  blockNumber: string;
  createdAt: string;
}

export interface FoundShareRepositoryV1 {
  /** The receipt's card. A second ask returns the first card unchanged. */
  make(input: {
    receiptId: string;
    tenantId: string;
    protocol: FoundShareProtocolV1;
    usdCents: number;
    tokens: FoundShareTokenV1[];
    blockNumber: string;
    at: Date;
  }): Promise<FoundShareV1>;
  byCode(code: string): Promise<FoundShareV1 | null>;
  byReceipt(receiptId: string, tenantId: string): Promise<FoundShareV1 | null>;
}

/** Nine random bytes, base64url: 72 bits nobody guesses, short enough for a post. */
const CODE_V1 = /^[A-Za-z0-9_-]{12}$/;
const SYMBOL_V1 = /^[\p{L}\p{N}._…-]{1,16}$/u;
const AMOUNT_V1 = /^[0-9][0-9,]*(?:\.[0-9]+)?$/;
const BLOCK_V1 = /^[0-9]{1,20}$/;
const MAX_CENTS_V1 = 100_000_000;

export function isFoundShareCodeV1(code: string): boolean {
  return CODE_V1.test(code);
}

export function newFoundShareCodeV1(): string {
  return randomBytes(9).toString('base64url');
}

function assertShareV1(input: { receiptId: string; protocol: string; usdCents: number; tokens: FoundShareTokenV1[]; blockNumber: string }): void {
  if (!/^base-mcp-action:[0-9a-f-]{36}$/.test(input.receiptId)) throw new RouteStorageIntegrityError('a Found card belongs to an Action Receipt');
  if (input.protocol !== 'aerodrome' && input.protocol !== 'uniswap') throw new RouteStorageIntegrityError('a Found card is for Aerodrome or Uniswap');
  if (!Number.isInteger(input.usdCents) || input.usdCents < 0 || input.usdCents > MAX_CENTS_V1) {
    throw new RouteStorageIntegrityError('a Found card holds whole cents');
  }
  if (input.tokens.length < 1 || input.tokens.length > 4
    || input.tokens.some((token) => !SYMBOL_V1.test(token.symbol) || !AMOUNT_V1.test(token.amount) || token.amount.length > 32)) {
    throw new RouteStorageIntegrityError('a Found card names one to four amounts');
  }
  if (!BLOCK_V1.test(input.blockNumber)) throw new RouteStorageIntegrityError('a Found card names its block');
}

export class InMemoryFoundShareRepositoryV1 implements FoundShareRepositoryV1 {
  private rows = new Map<string, FoundShareV1 & { tenantId: string }>();

  async make(input: Parameters<FoundShareRepositoryV1['make']>[0]): Promise<FoundShareV1> {
    assertShareV1(input);
    const existing = [...this.rows.values()].find((row) => row.receiptId === input.receiptId);
    if (existing) {
      if (existing.tenantId !== input.tenantId) throw new RouteStorageIntegrityError('a Found card belongs to its receipt’s owner');
      return this.public(existing);
    }
    const row = { code: newFoundShareCodeV1(), receiptId: input.receiptId, tenantId: input.tenantId, protocol: input.protocol,
      usdCents: input.usdCents, tokens: input.tokens.map((token) => ({ ...token })), blockNumber: input.blockNumber,
      createdAt: input.at.toISOString() };
    this.rows.set(row.code, row);
    return this.public(row);
  }

  async byCode(code: string): Promise<FoundShareV1 | null> {
    if (!isFoundShareCodeV1(code)) return null;
    const row = this.rows.get(code);
    return row ? this.public(row) : null;
  }

  async byReceipt(receiptId: string, tenantId: string): Promise<FoundShareV1 | null> {
    const row = [...this.rows.values()].find((entry) => entry.receiptId === receiptId && entry.tenantId === tenantId);
    return row ? this.public(row) : null;
  }

  private public(row: FoundShareV1 & { tenantId: string }): FoundShareV1 {
    const { tenantId: _tenant, ...shown } = row;
    return structuredClone(shown);
  }
}

function rowV1(row: Record<string, unknown>): FoundShareV1 {
  return {
    code: String(row.code),
    receiptId: String(row.receipt_id),
    protocol: String(row.protocol) as FoundShareProtocolV1,
    usdCents: Number(row.usd_cents),
    tokens: (row.tokens as FoundShareTokenV1[]).map((token) => ({ symbol: String(token.symbol), amount: String(token.amount) })),
    blockNumber: String(row.block_number),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
}

export function createDatabaseFoundShareRepositoryV1(sql: SqlTemplateExecutor): FoundShareRepositoryV1 {
  return {
    async make(input) {
      assertShareV1(input);
      // One card per receipt, its owner's: a second ask, or a racing one,
      // reads the first card back.
      const rows = await sql`
        WITH made AS (
          INSERT INTO found_shares (code, receipt_id, tenant_id, protocol, usd_cents, tokens, block_number, created_at)
          VALUES (${newFoundShareCodeV1()}, ${input.receiptId}, ${input.tenantId}, ${input.protocol}, ${input.usdCents},
            ${JSON.stringify(input.tokens)}::text::jsonb, ${input.blockNumber}, ${input.at.toISOString()}::timestamptz)
          ON CONFLICT (receipt_id) DO NOTHING
          RETURNING *
        )
        SELECT * FROM made
        UNION ALL
        SELECT * FROM found_shares WHERE receipt_id = ${input.receiptId} AND tenant_id = ${input.tenantId}
        LIMIT 1`;
      if (rows[0]) return rowV1(rows[0]);
      const again = await sql`SELECT * FROM found_shares WHERE receipt_id = ${input.receiptId} AND tenant_id = ${input.tenantId}`;
      if (!again[0]) throw new RouteStorageIntegrityError('a Found card belongs to its receipt’s owner');
      return rowV1(again[0]);
    },
    async byCode(code) {
      if (!isFoundShareCodeV1(code)) return null;
      const rows = await sql`SELECT * FROM found_shares WHERE code = ${code}`;
      return rows[0] ? rowV1(rows[0]) : null;
    },
    async byReceipt(receiptId, tenantId) {
      const rows = await sql`SELECT * FROM found_shares WHERE receipt_id = ${receiptId} AND tenant_id = ${tenantId}`;
      return rows[0] ? rowV1(rows[0]) : null;
    },
  };
}
