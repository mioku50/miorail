import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// WHICH SECURITY a representation stands for. Currently: nothing is known.
//
// This is the axis Phase 10A needs and the axis nothing on Base currently
// supplies. It is written now, empty, because the alternative is worse: with
// no table there is nowhere to put a reviewed mapping, and the gap gets closed
// by whoever next writes `symbol.replace(/c$/, '')` and calls it Apple.
//
// WHY A TICKER CANNOT BE THE KEY
//
//   * Dinari's Base dShare declares `symbol() = "AAPL"`, and `setSymbol` is an
//     admin call on the deployed contract.
//   * Dinari's own integration guide: "Key off `stock_id`, never the ticker
//     symbol. Treat `symbol` as a display field you refresh from the API."
//     A rebrand changes the ticker, the name and sometimes the CUSIP, and
//     leaves the uuid alone.
//   * Base's issuance guide keys assets by `AAPLc` and feeds by "Coinbase
//     AAPL". Both are tickers. Neither is a stable identifier for Apple.
//   * 61.7% of the launch corpus shares a symbol with something else.
//
// So `underlyingKey` is namespaced by the source that issued it —
// `dinari:stock_id:<uuid>` — and the store refuses a bare word. A key with no
// issuing source is a guess with a colon in it.
//
// WHAT AN EMPTY TABLE MEANS
//
// That no reviewed source has bound a Base address to a security. It does NOT
// mean the representations are unidentified in the world; it means Miorail has
// not been shown the binding. `unknown` here is the absence of a row, which is
// this repository's standing convention and the reason there is no `unknown`
// value inside the row.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');

/** The reviewed sources that may issue an underlying key. Adding one is a
 * review decision about what counts as identity, not a config value. */
export const UNDERLYING_SOURCE_KINDS_V1 = ['dinari_stock_api'] as const;
export type UnderlyingSourceKindV1 = (typeof UNDERLYING_SOURCE_KINDS_V1)[number];

export const UNDERLYING_ASSET_CLASSES_V1 = ['equity', 'fund_share', 'other'] as const;
export type UnderlyingAssetClassV1 = (typeof UNDERLYING_ASSET_CLASSES_V1)[number];

/** `source:kind:value`. The namespace is what stops a ticker from becoming a
 * key by being written in the right place. */
export const UNDERLYING_KEY_SHAPE_V1 = /^[a-z0-9_]+:[a-z0-9_]+:.+$/;

export const UnderlyingAssetV1Schema = z
  .object({
    underlyingKey: z.string().regex(UNDERLYING_KEY_SHAPE_V1, 'expected source:kind:value').max(200),
    assetClass: z.enum(UNDERLYING_ASSET_CLASSES_V1),
    canonicalName: z.string().min(1).max(200),
    sourceKind: z.enum(UNDERLYING_SOURCE_KINDS_V1),
    /** What in that source said it. A stock id, a document anchor — never a
     * URL carrying a credential. */
    sourceRef: z.string().min(1).max(300),
    observedAt: z.string().datetime(),
  })
  .strict();

export type UnderlyingAssetV1 = z.infer<typeof UnderlyingAssetV1Schema>;

export const RepresentationUnderlyingV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    underlyingKey: z.string().regex(UNDERLYING_KEY_SHAPE_V1).max(200),
    sourceKind: z.enum(UNDERLYING_SOURCE_KINDS_V1),
    sourceRef: z.string().min(1).max(300),
    observedAt: z.string().datetime(),
  })
  .strict();

export type RepresentationUnderlyingV1 = z.infer<typeof RepresentationUnderlyingV1Schema>;

export function assertUnderlyingAssetV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): UnderlyingAssetV1 {
  const parsed = UnderlyingAssetV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`underlying asset failed validation on ${direction}: ${detail}`);
}

export function assertRepresentationUnderlyingV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): RepresentationUnderlyingV1 {
  const parsed = RepresentationUnderlyingV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(
    `representation underlying failed validation on ${direction}: ${detail}`,
  );
}

/** Raised when a binding names an underlying nobody reviewed. A distinct type
 * so a caller cannot mistake it for a transport failure and retry it. */
export class UnknownUnderlyingError extends RouteStorageIntegrityError {
  constructor(underlyingKey: string) {
    super(
      `refusing to bind a representation to ${underlyingKey}: no reviewed source has declared that underlying`,
    );
    this.name = 'UnknownUnderlyingError';
  }
}

/**
 * One representation's underlying, or the honest absence of one.
 *
 * `null` is the current answer for every address on Base and means only that
 * no reviewed source has bound it. It is emphatically not "this token
 * represents nothing".
 */
export interface UnderlyingAssetRepositoryV1 {
  /** Declare an underlying, from the source that named it. Idempotent on the
   * key; re-declaring refreshes the reading and never renames the asset. */
  declareUnderlying(input: UnderlyingAssetV1): Promise<UnderlyingAssetV1>;

  /**
   * Bind one address to one declared underlying.
   *
   * Refuses a key no source has declared, so the graph cannot grow an edge to
   * a node somebody invented in a worker.
   */
  bindRepresentation(input: RepresentationUnderlyingV1): Promise<RepresentationUnderlyingV1>;

  /** What a representation stands for, or null. */
  underlyingOf(input: {
    chainId: number;
    tokenAddress: string;
  }): Promise<{ binding: RepresentationUnderlyingV1; underlying: UnderlyingAssetV1 } | null>;

  /**
   * Every reviewed representation of one underlying.
   *
   * The read Phase 10A is built on: one security, N addresses, each still
   * independently identified by its own address.
   */
  representationsOf(input: {
    chainId: number;
    underlyingKey: string;
  }): Promise<RepresentationUnderlyingV1[]>;

  /** How many underlyings and bindings exist. Zero is a legible answer and the
   * current one; a surface may say so rather than showing an empty group. */
  underlyingCounts(input: {
    chainId: number;
  }): Promise<{ underlyings: number; boundRepresentations: number }>;
}
