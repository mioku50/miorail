import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// The OFFICIAL trust root.
//
// `OFFICIAL` is not a bit Miorail computes. It is a claim made by a reviewed
// source outside the chain, and the only defensible way to hold it is to store
// what the source said and when we read it. Everything here follows from that:
//
//   - identity is an ADDRESS. There is no read on this interface that takes a
//     ticker, because Base's own guidance is that a B20 is identified by
//     address, its metadata is mutable onchain, and a lookalike's whole method
//     is to reuse the name;
//   - a snapshot is written on every check, INCLUDING a failed one, so an
//     outage is stored as an outage. A source that cannot be read never
//     demotes an asset that was already listed -- it only stops the clock;
//   - membership is stored per source. Two reviewed sources disagreeing is a
//     fact about the sources, not a merge conflict to resolve quietly;
//   - nothing is deleted. A source dropping an asset is an event about the
//     asset, so the row stays and `lastSeenAt` stops advancing.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha-256 digest');

/** The reviewed sources. Adding one is a review decision, not a config value. */
export const OFFICIAL_SOURCE_KINDS_V1 = ['base_docs_technical', 'base_product_list'] as const;
export type OfficialSourceKindV1 = (typeof OFFICIAL_SOURCE_KINDS_V1)[number];

/**
 * How a check ended.
 *
 * `unreachable` is the network; `unparsable` is a document we fetched and could
 * not read as a corpus. Both are OUR failure and neither is allowed to carry
 * assets, which is what stops a changed page from silently emptying the
 * official set.
 */
export const OFFICIAL_SOURCE_STATUSES_V1 = ['ok', 'unreachable', 'unparsable'] as const;
export type OfficialSourceStatusV1 = (typeof OFFICIAL_SOURCE_STATUSES_V1)[number];

export const OfficialSourceSnapshotV1Schema = z
  .object({
    sourceKind: z.enum(OFFICIAL_SOURCE_KINDS_V1),
    sourceUrl: z.string().url().startsWith('https://'),
    observedAt: z.string().datetime(),
    status: z.enum(OFFICIAL_SOURCE_STATUSES_V1),
    /** sha-256 of the document as delivered. Changes on every site rebuild. */
    documentHash: Sha256.nullable(),
    /** sha-256 of the parsed membership. Changes only when the claim moved. */
    corpusHash: Sha256.nullable(),
    /** Why the check failed, in our words. Never a credential, never a raw body. */
    detail: z.string().max(400).nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.status === 'ok' && (row.documentHash === null || row.corpusHash === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an ok snapshot must carry both the document hash and the corpus hash',
      });
    }
  });

export type OfficialSourceSnapshotV1 = z.infer<typeof OfficialSourceSnapshotV1Schema>;

export const OfficialAssetInputV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    sourceKind: z.enum(OFFICIAL_SOURCE_KINDS_V1),
    /** Display metadata, carried because the source carries it. Never identity. */
    ticker: z.string().regex(/^[A-Za-z0-9.-]{1,16}$/, 'expected a plain ticker'),
    displayName: z.string().min(1).max(120).nullable(),
    issuer: z.string().min(1).max(80),
    /** The reference feed the SAME document binds to this asset, or null. */
    referenceFeedAddress: Address.nullable(),
  })
  .strict();

export type OfficialAssetInputV1 = z.infer<typeof OfficialAssetInputV1Schema>;

/** A stored snapshot, as read back. */
export interface OfficialSourceSnapshotRecordV1 extends OfficialSourceSnapshotV1 {
  snapshotId: string;
  assetCount: number;
}

/** One source's listing of one address. */
export interface OfficialAssetListingV1 {
  sourceKind: OfficialSourceKindV1;
  sourceUrl: string;
  ticker: string;
  displayName: string | null;
  referenceFeedAddress: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * Whether the newest SUCCESSFUL check of this source still named the asset.
   *
   * False means the source dropped it, which is an event. It never means the
   * source was unreachable: a failed check writes no membership at all, so it
   * cannot move this flag.
   */
  currentlyListed: boolean;
  /** When this source was last checked, whatever the outcome. */
  sourceCheckedAt: string | null;
  /** How that check ended. `unreachable` here with `currentlyListed` true is
   * exactly the honest state: still official, freshness unknown. */
  sourceStatus: OfficialSourceStatusV1 | null;
}

export interface OfficialAssetIdentityV1 {
  chainId: number;
  tokenAddress: string;
  issuer: string;
  /** Every source that has ever listed this address, in source-kind order. */
  listings: OfficialAssetListingV1[];
}

/**
 * Two reviewed sources saying different things.
 *
 * Rendered, never reconciled. `listed_in_one_source` is the ordinary state of
 * the Coinbase corpus today -- thirteen equities are issued and four are on
 * the product page -- and collapsing it would delete the most useful sentence
 * the surface can say about an asset.
 */
export type OfficialSourceDiscrepancyV1 =
  | {
      kind: 'listed_in_one_source';
      tokenAddress: string;
      ticker: string;
      listedIn: OfficialSourceKindV1[];
      missingFrom: OfficialSourceKindV1[];
    }
  | {
      kind: 'ticker_maps_to_multiple_addresses';
      ticker: string;
      tokenAddresses: string[];
    }
  | {
      kind: 'delisted_by_source';
      tokenAddress: string;
      ticker: string;
      sourceKind: OfficialSourceKindV1;
      lastSeenAt: string;
    };

/**
 * What one recorded check CHANGED. The input to a future source Signal.
 *
 * Every field is a transition against the state before this check, not a
 * description of the state after it. A source that has been missing an asset
 * for a week reports it as delisted once, on the check that dropped it -- a
 * Signal that re-fires on every pass is noise wearing an event's name.
 */
export interface OfficialSnapshotOutcomeV1 {
  snapshotId: string;
  sourceKind: OfficialSourceKindV1;
  status: OfficialSourceStatusV1;
  observedAt: string;
  /** Named now, not listed before: a first listing or a relisting. */
  added: string[];
  /** Listed before and named again. */
  stillListed: string[];
  /** Listed before and not named now. */
  delisted: string[];
}

export function assertOfficialSnapshotV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): OfficialSourceSnapshotV1 {
  const parsed = OfficialSourceSnapshotV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`official source snapshot failed validation on ${direction}: ${detail}`);
}

export function assertOfficialAssetV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): OfficialAssetInputV1 {
  const parsed = OfficialAssetInputV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`official asset failed validation on ${direction}: ${detail}`);
}

/**
 * The rule that keeps a broken read from becoming a claim about the corpus.
 *
 * Shared by both repositories rather than written twice, because the two
 * disagreeing is how a failed fetch would end up deleting the official set in
 * production while every in-memory test still passed.
 */
export function assertSnapshotMayCarryAssetsV1(
  snapshot: OfficialSourceSnapshotV1,
  assets: readonly OfficialAssetInputV1[],
): void {
  if (snapshot.status !== 'ok') {
    if (assets.length > 0) {
      throw new RouteStorageIntegrityError(
        `refusing ${assets.length} official asset(s) under a ${snapshot.status} snapshot of ${snapshot.sourceKind}: a check that did not complete says nothing about membership`,
      );
    }
    return;
  }
  if (assets.length === 0) {
    throw new RouteStorageIntegrityError(
      `refusing an ok snapshot of ${snapshot.sourceKind} that named no assets: an empty corpus is what a silently changed document looks like, so record it as unparsable`,
    );
  }
  const seen = new Set<string>();
  for (const asset of assets) {
    if (asset.sourceKind !== snapshot.sourceKind) {
      throw new RouteStorageIntegrityError(
        `official asset ${asset.tokenAddress} claims source ${asset.sourceKind} inside a ${snapshot.sourceKind} snapshot`,
      );
    }
    if (seen.has(asset.tokenAddress)) {
      throw new RouteStorageIntegrityError(
        `official source ${snapshot.sourceKind} listed ${asset.tokenAddress} twice in one snapshot`,
      );
    }
    seen.add(asset.tokenAddress);
  }
}

/** One source's current membership row, flattened -- the only input the
 * discrepancy projection needs. */
export interface OfficialMembershipRowV1 {
  tokenAddress: string;
  sourceKind: OfficialSourceKindV1;
  ticker: string;
  lastSeenAt: string;
  currentlyListed: boolean;
}

/**
 * Where the reviewed sources disagree, computed once for both repositories.
 *
 * A projection rather than a query, and shared rather than written twice: the
 * official corpus is thirteen rows, so there is nothing to optimise, and the
 * only thing that could go wrong is the two implementations drifting into
 * different definitions of "listed".
 *
 * `reviewedKinds` is the set of sources that have actually completed a check.
 * Passing every declared kind instead would report "missing from the product
 * list" for the whole technical corpus before that list has ever been read --
 * our own gap, dressed as a disagreement between sources.
 */
export function officialSourceDiscrepanciesV1(input: {
  reviewedKinds: readonly OfficialSourceKindV1[];
  rows: readonly OfficialMembershipRowV1[];
}): OfficialSourceDiscrepancyV1[] {
  const found: OfficialSourceDiscrepancyV1[] = [];
  const listedBy = new Map<string, { ticker: string; kinds: OfficialSourceKindV1[] }>();
  const ordered = [...input.rows].sort(
    (left, right) =>
      left.tokenAddress.localeCompare(right.tokenAddress) ||
      left.sourceKind.localeCompare(right.sourceKind),
  );

  for (const row of ordered) {
    if (!row.currentlyListed) {
      // A source that has never completed a check has not dropped anything.
      if (input.reviewedKinds.includes(row.sourceKind)) {
        found.push({
          kind: 'delisted_by_source',
          tokenAddress: row.tokenAddress,
          ticker: row.ticker,
          sourceKind: row.sourceKind,
          lastSeenAt: row.lastSeenAt,
        });
      }
      continue;
    }
    const entry = listedBy.get(row.tokenAddress) ?? { ticker: row.ticker, kinds: [] };
    entry.kinds.push(row.sourceKind);
    listedBy.set(row.tokenAddress, entry);
  }

  for (const [tokenAddress, entry] of [...listedBy].sort(([left], [right]) => left.localeCompare(right))) {
    const missingFrom = input.reviewedKinds.filter((kind) => !entry.kinds.includes(kind));
    if (missingFrom.length === 0) continue;
    found.push({
      kind: 'listed_in_one_source',
      tokenAddress,
      ticker: entry.ticker,
      listedIn: [...entry.kinds].sort(),
      missingFrom: [...missingFrom].sort(),
    });
  }

  const byTicker = new Map<string, Set<string>>();
  for (const [tokenAddress, entry] of listedBy) {
    const addresses = byTicker.get(entry.ticker) ?? new Set<string>();
    addresses.add(tokenAddress);
    byTicker.set(entry.ticker, addresses);
  }
  for (const [ticker, addresses] of [...byTicker].sort(([left], [right]) => left.localeCompare(right))) {
    if (addresses.size < 2) continue;
    found.push({
      kind: 'ticker_maps_to_multiple_addresses',
      ticker,
      tokenAddresses: [...addresses].sort(),
    });
  }
  return found;
}

/** Whether any reviewed source still lists this address. The single definition
 * of OFFICIAL, so a surface cannot invent a looser one. */
export function isOfficialV1(identity: OfficialAssetIdentityV1 | null): boolean {
  return Boolean(identity?.listings.some((listing) => listing.currentlyListed));
}

export interface OfficialAssetRepositoryV1 {
  /**
   * One check of one source, written as a unit.
   *
   * Records the snapshot whatever the outcome, and touches membership only
   * when the check succeeded. The return value names what moved, which is what
   * a source Signal is later built from.
   */
  recordSnapshot(input: {
    snapshot: OfficialSourceSnapshotV1;
    assets: readonly OfficialAssetInputV1[];
  }): Promise<OfficialSnapshotOutcomeV1>;

  /** The newest check of one source, successful or not. Null before the first. */
  latestSnapshot(input: {
    sourceKind: OfficialSourceKindV1;
    /** Restrict to checks that completed -- the freshness clock. */
    successfulOnly?: boolean;
  }): Promise<OfficialSourceSnapshotRecordV1 | null>;

  /**
   * What the reviewed sources say about one address.
   *
   * Null when no source has ever listed it -- which is the ordinary answer for
   * almost every token, and is emphatically not "unofficial, proven".
   */
  officialIdentity(input: { chainId: number; tokenAddress: string }): Promise<OfficialAssetIdentityV1 | null>;

  /** The official universe, bounded. Ordered by ticker then address so two
   * contracts sharing a ticker stay adjacent instead of interleaved. */
  officialAssets(input: {
    chainId: number;
    limit: number;
    sourceKind?: OfficialSourceKindV1;
    /** Default true: only assets a source still lists. */
    currentlyListedOnly?: boolean;
  }): Promise<OfficialAssetIdentityV1[]>;

  /** Where the reviewed sources disagree with each other or with themselves. */
  sourceDiscrepancies(input: { chainId: number }): Promise<OfficialSourceDiscrepancyV1[]>;
}
