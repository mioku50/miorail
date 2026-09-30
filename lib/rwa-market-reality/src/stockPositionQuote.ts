import { z } from 'zod';

const Atomic = z.string().regex(/^\d{1,78}$/);
const Iso = z.string().datetime({ offset: true });
export const StockPositionQuoteInputV1Schema = z
  .object({
    tokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  })
  .strict();

/** A measurement of the proven owner's entire current raw token balance.
 * No cash-to-token sizing, multiplier scaling, clearance or executable calls. */
export const StockPositionQuoteV1Schema = z
  .object({
    schemaVersion: z.literal('my-stock-cash-out/v1'),
    chainId: z.literal(8453),
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    tokenSymbol: z.string().min(1).max(40),
    generatedAt: Iso,
    holding: z
      .object({
        balanceAtomic: Atomic,
        tokens: z.string().regex(/^\d+(?:\.\d+)?$/),
        decimals: z.number().int().min(0).max(36),
        blockTag: z.string().regex(/^0x[0-9a-f]+$/),
      })
      .strict(),
    status: z.enum(['quoted', 'expired', 'no_route', 'not_established', 'empty']),
    destination: z.literal('USDC'),
    destinationDecimals: z.literal(6),
    returnedAtomic: Atomic.nullable(),
    observedAt: Iso.nullable(),
    expiresAt: Iso.nullable(),
    selectedSource: z.string().nullable(),
    approvedSources: z.array(z.string()),
    sources: z.array(
      z
        .object({ source: z.string(), status: z.string(), errorCode: z.string().nullable() })
        .strict(),
    ),
    executionProven: z.literal(false),
    createsApproval: z.literal(false),
    createsCalldata: z.literal(false),
    createsTransaction: z.literal(false),
    caveats: z.array(z.string()),
  })
  .strict();
export type StockPositionQuoteV1 = z.infer<typeof StockPositionQuoteV1Schema>;

export function stockPositionDecimalV1(atomic: string, decimals: number): string {
  const padded = atomic.padStart(decimals + 1, '0');
  if (decimals === 0) return padded;
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return `${padded.slice(0, -decimals)}${fraction ? `.${fraction}` : ''}`;
}

export function stockPositionQuoteOpenV1(quote: StockPositionQuoteV1, now: Date): boolean {
  return (
    quote.status === 'quoted' &&
    quote.expiresAt !== null &&
    Date.parse(quote.expiresAt) > now.getTime()
  );
}
