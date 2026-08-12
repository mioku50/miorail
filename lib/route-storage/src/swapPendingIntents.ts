import { z } from 'zod';

// ---------------------------------------------------------------------------
// The half-finished swap goal a clarification leaves behind.
//
// This is a plain row type with no dependency on the intent engine: the mapping
// between it and `PendingSwapIntentV2` lives at the one seam that imports both,
// exactly as the launch-pool cache does.
//
// The rule that makes it useful, and the one that makes it safe, are the same
// rule: a constraint is stored only when the USER STATED IT. Null means "never
// asked for", so a later turn inherits 1% slippage from someone who asked for
// 1% slippage, and inherits nothing from someone who asked for nothing. Every
// value below is one this engine writes; a shape it could not have written is
// refused rather than repaired, because this row decides what a future turn
// treats as the user's own words.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');
const AssetSymbol = z.enum(['USDC', 'ETH', 'WETH']).nullable();
const ExactDecimal = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/, 'expected an exact decimal amount')
  .nullable();

const ProtocolConstraint = z
  .object({
    // `any` is the absence of a constraint and is stored as null, so it is not
    // one of the modes this row can hold.
    mode: z.enum(['include_only', 'exclude']),
    protocols: z.array(z.enum([
      'uniswap',
      'kyberswap',
      'aerodrome',
      'balancer',
      'hydrex',
      'o1-exchange',
    ])).min(1),
  })
  .refine((value) => new Set(value.protocols).size === value.protocols.length, {
    message: 'a protocol is named twice',
  })
  .nullable();

const PendingIntentRow = z
  .object({
    tenantId: z.string().min(1),
    walletAddress: Address,
    chainId: z.literal(8453),
    sourceRequestId: z.string().min(1),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    amountDecimal: ExactDecimal,
    fromAssetSymbol: AssetSymbol,
    toAssetSymbol: AssetSymbol,
    optimizationMode: z
      .enum([
        'best_net_result',
        'lowest_fees',
        'lowest_risk',
        'fastest_execution',
        'simplest_route',
        'mev_protected',
      ])
      .nullable(),
    /** 'standard' is the default depth, stored as null like every unstated value. */
    verificationDepth: z.enum(['enhanced', 'maximum']).nullable(),
    protocolConstraint: ProtocolConstraint,
    slippageMaxBps: z.number().int().min(0).max(10_000).nullable(),
    executionRequested: z.boolean().nullable(),
  })
  .refine((row) => Date.parse(row.expiresAt) > Date.parse(row.createdAt), {
    message: 'the pending intent expires before it was created',
  })
  .refine(
    (row) =>
      row.fromAssetSymbol === null ||
      row.toAssetSymbol === null ||
      row.fromAssetSymbol !== row.toAssetSymbol,
    { message: 'the source and destination assets are the same' },
  )
  .refine(
    (row) =>
      row.amountDecimal !== null || row.fromAssetSymbol !== null || row.toAssetSymbol !== null,
    { message: 'nothing was grounded, so there is nothing to continue' },
  );

export type SwapPendingIntentRowV1 = z.infer<typeof PendingIntentRow>;

export interface SwapPendingIntentBindingV1 {
  tenantId: string;
  walletAddress: string;
}

/** Parses a row, or throws with the field that was wrong. Both repositories call
 * this, which is what keeps the in-memory fake refusing exactly what the CHECK
 * constraints refuse. */
export function assertSwapPendingIntentV1(
  row: unknown,
  at: 'read' | 'write' = 'write',
): SwapPendingIntentRowV1 {
  const parsed = PendingIntentRow.safeParse(row);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(
    `swap pending intent ${at} rejected: ${issue?.path.join('.') || '(row)'} — ${issue?.message ?? 'invalid'}`,
  );
}

export interface SwapPendingIntentRepositoryV1 {
  /** The one live pending intent for this wallet, or null. An expired row is
   * never returned — reading is the only sweep this table gets. */
  readPendingIntent(
    binding: SwapPendingIntentBindingV1,
    now: Date,
  ): Promise<SwapPendingIntentRowV1 | null>;
  /** One per wallet: a newer half-finished goal replaces the older one, because
   * two of them would leave the engine unable to tell which is being answered. */
  upsertPendingIntent(row: SwapPendingIntentRowV1): Promise<SwapPendingIntentRowV1>;
  /** Called the moment a goal resolves or is refused. A pending intent that
   * outlives its question would silently join itself to an unrelated later one. */
  clearPendingIntent(binding: SwapPendingIntentBindingV1): Promise<void>;
}
