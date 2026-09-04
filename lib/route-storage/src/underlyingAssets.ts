import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// WHICH SECURITY a representation stands for.
//
// This is the axis Phase 10A needs. It is populated only by reviewed mappings:
// issuer instrument identifiers, issuer-published exact-address mappings, or
// reviewed onchain metadata whose identifier is separately authenticated. The
// alternative is worse: the gap gets closed by whoever next writes
// `symbol.replace(/c$/, '')` and calls it Apple.
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
// WHAT ABSENCE MEANS
//
// That no reviewed source has bound that exact Base address to a security. It
// does NOT mean the representation is unidentified in the world; it means
// Miorail has not been shown the binding. `unknown` here is the absence of a
// row, which is this repository's standing convention and the reason there is
// no `unknown` value inside the row.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');

/** The reviewed sources that may issue an underlying key. Adding one is a
 * review decision about what counts as identity, not a config value. */
export const UNDERLYING_SOURCE_KINDS_V1 = [
  'dinari_stock_api',
  'backed_assets_api',
  'coinbase_b20_metadata',
] as const;
export type UnderlyingSourceKindV1 = (typeof UNDERLYING_SOURCE_KINDS_V1)[number];

export const UNDERLYING_ASSET_CLASSES_V1 = ['equity', 'fund_share', 'other', 'unknown'] as const;
export type UnderlyingAssetClassV1 = (typeof UNDERLYING_ASSET_CLASSES_V1)[number];

/** `source:kind:value`. The namespace is what stops a ticker from becoming a
 * key by being written in the right place. */
export const UNDERLYING_KEY_SHAPE_V1 = /^[a-z0-9_]+:[a-z0-9_]+:.+$/;

export const UNDERLYING_IDENTIFIER_SCHEMES_V1 = [
  'isin',
  'dinari_stock_id',
  'composite_figi',
] as const;

/** ISO 6166 check-digit validation. A syntactically plausible twelve-byte
 * string is not enough to become canonical identity: issuer metadata is
 * accepted only when its own check digit reconciles. */
export function isValidIsinV1(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(normalized)) return false;
  const expanded = [...normalized]
    .map((character) =>
      /[0-9]/.test(character) ? character : String(character.charCodeAt(0) - 55),
    )
    .join('');
  let sum = 0;
  let double = false;
  for (let index = expanded.length - 1; index >= 0; index -= 1) {
    let digit = Number(expanded[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
export const UNDERLYING_EVIDENCE_STRENGTHS_V1 = [
  'reviewed_issuer_identifier',
  'reviewed_machine_address_mapping',
  'reviewed_machine_mapping_with_onchain_cross_check',
] as const;
export const UNDERLYING_REPRESENTATION_KINDS_V1 = [
  'b20_asset',
  'rebasing_erc20',
  // Phase 17.5. A Dinari dShare is none of the other three: it does not rebase,
  // it is not an ERC-4626 wrapper, and it is not a B20. Adding a kind is a
  // review decision about what exists, which is why it is spelled out here
  // rather than approximated by the nearest existing value.
  'dinari_dshare',
  'non_rebasing_erc4626_wrapper',
] as const;

export const UnderlyingAssetV1Schema = z
  .object({
    underlyingKey: z.string().regex(UNDERLYING_KEY_SHAPE_V1, 'expected source:kind:value').max(200),
    assetClass: z.enum(UNDERLYING_ASSET_CLASSES_V1),
    canonicalName: z.string().min(1).max(200),
    /** Presentation metadata. It is never read back into underlyingKey. */
    displaySymbol: z.string().min(1).max(40).nullable().optional(),
    identifierScheme: z.enum(UNDERLYING_IDENTIFIER_SCHEMES_V1).nullable().optional(),
    identifierValue: z.string().min(1).max(120).nullable().optional(),
    sourceKind: z.enum(UNDERLYING_SOURCE_KINDS_V1),
    /** What in that source said it. A stock id, a document anchor — never a
     * URL carrying a credential. */
    sourceRef: z.string().min(1).max(300),
    sourceHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    observedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if ((row.identifierScheme == null) !== (row.identifierValue == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an underlying identifier scheme and value travel together',
      });
    }
    if (
      row.identifierScheme === 'isin' &&
      row.identifierValue != null &&
      !isValidIsinV1(row.identifierValue)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identifierValue'],
        message: 'an ISIN must have a valid ISO 6166 check digit',
      });
    }
  });

export type UnderlyingAssetV1 = z.infer<typeof UnderlyingAssetV1Schema>;

const RepresentationUnderlyingObjectV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    underlyingKey: z.string().regex(UNDERLYING_KEY_SHAPE_V1).max(200),
    sourceKind: z.enum(UNDERLYING_SOURCE_KINDS_V1),
    sourceRef: z.string().min(1).max(300),
    sourceHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    issuerId: z.enum(['coinbase', 'dinari', 'backed']).nullable().optional(),
    issuerInstrumentKey: z.string().min(1).max(200).nullable().optional(),
    caip10: z
      .string()
      .regex(/^eip155:8453:0x[0-9a-f]{40}$/)
      .nullable()
      .optional(),
    representationKind: z.enum(UNDERLYING_REPRESENTATION_KINDS_V1).nullable().optional(),
    evidenceStrength: z.enum(UNDERLYING_EVIDENCE_STRENGTHS_V1).nullable().optional(),
    observedBlockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable()
      .optional(),
    observedBlockHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    observedAt: z.string().datetime(),
  })
  .strict();

function refineRepresentationUnderlyingV1(
  row: {
    observedBlockNumber?: string | null;
    observedBlockHash?: string | null;
    caip10?: string | null;
    tokenAddress: string;
  },
  ctx: z.RefinementCtx,
): void {
  if ((row.observedBlockNumber === null) !== (row.observedBlockHash === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'an onchain cross-check has both block number and block hash, or neither',
    });
  }
  if (row.caip10 !== undefined && row.caip10 !== null && !row.caip10.endsWith(row.tokenAddress)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['caip10'],
      message: 'CAIP-10 must name this exact Base address',
    });
  }
}

/**
 * What a stored row may look like -- INCLUDING one written before migration
 * 0059 added issuer typing to a table that already existed. Issuer typing stays
 * nullable here so such a row can still be read, recovered from its exact
 * address, or refused as our own data-integrity gap. It must never be the
 * shape a new write is allowed to take.
 */
export const RepresentationUnderlyingV1Schema =
  RepresentationUnderlyingObjectV1Schema.superRefine(refineRepresentationUnderlyingV1);

export type RepresentationUnderlyingV1 = z.infer<typeof RepresentationUnderlyingV1Schema>;

/**
 * What a WRITE must carry. Complete typed identity, no defaults, no inference.
 *
 * The read schema above exists to tolerate history. This one exists so history
 * cannot be added to: every reviewed source names its own issuer, its own
 * instrument and its own structure, so a writer that cannot supply all three
 * has not established a representation and must not record one. There is no
 * fallback to a ticker, a name, or the string "unknown" -- an issuer nobody
 * proved is an absence, and an absence is not a value.
 */
export const BindRepresentationInputV1Schema = RepresentationUnderlyingObjectV1Schema.extend({
  issuerId: z.enum(['coinbase', 'dinari', 'backed']),
  issuerInstrumentKey: z.string().min(1).max(200),
  representationKind: z.enum(UNDERLYING_REPRESENTATION_KINDS_V1),
}).superRefine(refineRepresentationUnderlyingV1);

export type BindRepresentationInputV1 = z.infer<typeof BindRepresentationInputV1Schema>;

export function assertUnderlyingAssetV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): UnderlyingAssetV1 {
  const parsed = UnderlyingAssetV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new RouteStorageIntegrityError(
    `underlying asset failed validation on ${direction}: ${detail}`,
  );
}

export function assertRepresentationUnderlyingV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): RepresentationUnderlyingV1 {
  const parsed = RepresentationUnderlyingV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new RouteStorageIntegrityError(
    `representation underlying failed validation on ${direction}: ${detail}`,
  );
}

/** The write gate. Refuses a binding whose typed identity is incomplete. */
export function assertBindRepresentationInputV1(value: unknown): BindRepresentationInputV1 {
  const parsed = BindRepresentationInputV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new RouteStorageIntegrityError(
    `representation underlying failed validation on write: ${detail}`,
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
  bindRepresentation(input: BindRepresentationInputV1): Promise<RepresentationUnderlyingV1>;

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

  /**
   * How many underlyings and bindings exist, over the WHOLE corpus.
   *
   * Zero is a legible answer; a surface may say so rather than showing an empty
   * group. `multiIssuerUnderlyings` is counted here rather than over a returned
   * page because it is the headline claim of the Market Reality surface — how
   * many securities Base carries more than one issuer's way — and a headline
   * computed from a page silently shrinks when the page does.
   */
  underlyingCounts(input: { chainId: number }): Promise<{
    underlyings: number;
    boundRepresentations: number;
    multiIssuerUnderlyings: number;
  }>;

  /**
   * The reviewed underlyings, bounded, with how many representations each has.
   *
   * The read a chooser is built from. Ordered by representation count first,
   * because the whole point of the surface is a security that Base carries
   * MORE THAN ONE way — a one-representation underlying has nothing to compare
   * and belongs below the ones that do.
   *
   * `issuerIds` is de-duplicated and sorted, and it is deliberately a list
   * rather than a count: "Coinbase and Backed" and "Backed twice" are two very
   * different sentences about the same number two.
   */
  listUnderlyings(input: {
    chainId: number;
    limit: number;
  }): Promise<UnderlyingIndexEntryV1[]>;
}

/** One row of the chooser. */
export interface UnderlyingIndexEntryV1 {
  underlying: UnderlyingAssetV1;
  representationCount: number;
  /** Distinct issuers behind those representations, sorted. */
  issuerIds: string[];
  /**
   * How many of those representations each issuer published, keyed by issuer.
   *
   * `issuerIds` says WHICH issuers and `representationCount` says how many
   * contracts; neither says how many contracts belong to one of them. A screen
   * scoped to Coinbase counted 13 securities and 39 representations on the same
   * band, because the 39 included every Backed and Dinari contract bound to
   * those same 13 companies — two numbers in two different units, one label
   * apart. A scoped total has to be summed per issuer, so the per-issuer count
   * has to exist.
   *
   * Issuers with no representation are absent rather than zero: this is a
   * tally of what is bound, not a roster.
   */
  representationCountsByIssuer: Record<string, number>;
  /**
   * How many of those representations have tokens outstanding.
   *
   * The chooser used to rank on `representationCount` alone, which counts
   * CONTRACTS rather than markets. Nine of the thirteen Coinbase tokenized
   * stocks hold exactly zero, so the securities a reader could actually trade
   * were interleaved alphabetically with ones that can do nothing, and the
   * first card opened was as likely as not to be an empty contract.
   *
   * Zero here is a measured zero. A representation nobody has read yet is
   * `supply_unknown` and is not counted as live — the ordering may never
   * promise a market on the strength of an unread contract.
   */
  liveRepresentationCount: number;
}
