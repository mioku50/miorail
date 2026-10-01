import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { client } from '@mioagent/db';
import {
  createDatabaseStockInboxRepositoryV1,
  StockInboxIdsV1Schema,
  StockInboxWalletV1Schema,
} from '@mioagent/route-storage';
import {
  StockInboxReadInputV1Schema,
  StockInboxReadResultV1Schema,
} from '@mioagent/rwa-market-reality/stock-brief';

const Iso = z.string().datetime();
const Common = { wallet: StockInboxWalletV1Schema, issuedAt: Iso, expiresAt: Iso };
const Review = z
  .object({ ...Common, kind: z.literal('review'), ids: StockInboxIdsV1Schema })
  .strict();
const Cursor = z
  .object({
    ...Common,
    kind: z.literal('cursor'),
    view: z.enum(['unread', 'history']),
    since: Iso,
    until: Iso,
    before: z.object({ at: Iso, id: z.string().regex(/^[1-9][0-9]*$/) }).strict(),
  })
  .strict();
const Proof = z.discriminatedUnion('kind', [Review, Cursor]);
export const stockInboxRuntime = {
  repository: () => createDatabaseStockInboxRepositoryV1(client),
  now: () => new Date(),
  secret: () => {
    const secret = process.env.MCP_OAUTH_ENCRYPTION_SECRET ?? process.env.SESSION_SECRET;
    if (secret && secret.length >= 32) return secret;
    if (process.env.NODE_ENV !== 'production') return 'miorail-stock-inbox-development-only';
    throw new Error('stock_inbox_secret_unavailable');
  },
};
export class StockInboxErrorV1 extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function stockInboxProofV1(payload: z.infer<typeof Proof>): string {
  const body = Buffer.from(JSON.stringify(Proof.parse(payload))).toString('base64url');
  const mac = createHmac('sha256', stockInboxRuntime.secret())
    .update(`miorail-stock-inbox/v1:${body}`)
    .digest('base64url');
  return `${body}.${mac}`;
}
export function readStockInboxProofV1(
  token: string,
  wallet: string,
  kind: 'review' | 'cursor',
  now: Date,
) {
  try {
    if (token.length > 8192) throw new Error();
    const parts = token.split('.');
    if (
      parts.length !== 2 ||
      !/^[A-Za-z0-9_-]+$/.test(parts[0]!) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)
    )
      throw new Error();
    const expected = createHmac('sha256', stockInboxRuntime.secret())
      .update(`miorail-stock-inbox/v1:${parts[0]}`)
      .digest();
    const actual = Buffer.from(parts[1]!, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const payload = Proof.parse(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')));
    if (
      payload.wallet !== wallet ||
      payload.kind !== kind ||
      Date.parse(payload.issuedAt) > now.getTime() ||
      Date.parse(payload.expiresAt) <= now.getTime()
    )
      throw new Error();
    return payload;
  } catch {
    throw new StockInboxErrorV1(`stock_inbox_${kind}_invalid`);
  }
}
export async function acknowledgeStockInboxV1(wallet: string, input: unknown) {
  wallet = StockInboxWalletV1Schema.parse(wallet.toLowerCase());
  const parsed = StockInboxReadInputV1Schema.safeParse(input);
  if (!parsed.success) throw new StockInboxErrorV1('stock_inbox_review_input_invalid');
  const now = stockInboxRuntime.now();
  const proof = readStockInboxProofV1(parsed.data.reviewToken, wallet, 'review', now);
  if (proof.kind !== 'review') throw new StockInboxErrorV1('stock_inbox_review_invalid');
  const state = await stockInboxRuntime.repository().acknowledge(wallet, proof.ids, now);
  return StockInboxReadResultV1Schema.parse({
    reviewedAt: state.reviewedAt,
    markedCount: new Set(proof.ids).size,
  });
}
