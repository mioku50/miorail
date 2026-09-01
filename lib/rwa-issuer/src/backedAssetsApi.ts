import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Reviewed public identity root for Backed's legacy bTokens.
 *
 * The API exposes a dedicated `btokens` corpus. Unlike a product page label,
 * every row binds an issuer UUID and certificate ISIN to an exact deployment,
 * and separately carries the underlying ISIN. Base currently appears only in
 * this legacy corpus; the v2 xStocks corpus must not be substituted for it.
 */
export const BACKED_BTOKENS_SOURCE_URL_V1 =
  'https://api.xstocks.fi/api/v1/token?type=btokens' as const;
export const BACKED_BTOKENS_OPENAPI_URL_V1 =
  'https://docs.xstocks.fi/_bundle/apis/@v1/openapi.json?download=' as const;

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Isin = z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/);

export const BackedDeploymentV1Schema = z
  .object({
    address: z.string().min(1),
    network: z.string().min(1),
    wrapperAddress: Address.optional(),
    wrapperAddressV2: Address.optional(),
  })
  .passthrough();

export const BackedAssetV1Schema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    symbol: z.string().min(1).max(32),
    isin: Isin,
    underlyingSymbol: z.string().min(1).max(32),
    underlyingIsin: Isin,
    description: z.string().min(1),
    isTradingHalted: z.boolean(),
    deployments: z.array(BackedDeploymentV1Schema),
  })
  .passthrough();
export type BackedAssetV1 = z.infer<typeof BackedAssetV1Schema>;

export const BackedAssetPageV1Schema = z
  .object({
    nodes: z.array(BackedAssetV1Schema),
    page: z.object({ currentPage: z.number(), hasNextPage: z.boolean() }).passthrough(),
  })
  .passthrough();

export const BACKED_REPRESENTATION_KINDS_V1 = [
  'rebasing_erc20',
  'non_rebasing_erc4626_wrapper',
] as const;
export type BackedRepresentationKindV1 = (typeof BACKED_REPRESENTATION_KINDS_V1)[number];

export const REVIEWED_BACKED_UNDERLYING_ASSET_CLASSES_V1 = [
  'equity',
  'fund_share',
  'other',
  'unknown',
] as const;
export type ReviewedBackedUnderlyingAssetClassV1 =
  (typeof REVIEWED_BACKED_UNDERLYING_ASSET_CLASSES_V1)[number];

/**
 * Asset class review keyed by the issuer's stable instrument UUID and exact
 * underlying ISIN. Neither ticker, name nor free-text description is allowed
 * to choose the class at runtime. The pairs below were reviewed against the
 * same versioned issuer corpus that binds each UUID/ISIN to its Base address.
 *
 * A new UUID or a changed ISIN deliberately becomes `unknown` until reviewed;
 * it is never admitted to the Stocks surface by a label-shaped guess.
 */
const REVIEWED_BACKED_ASSET_CLASS_BY_INSTRUMENT_V1: Readonly<
  Record<string, { underlyingIsin: string; assetClass: ReviewedBackedUnderlyingAssetClassV1 }>
> = {
  'c2c9dbb0-53f8-4848-8ed6-09ce2ca5261f': { underlyingIsin: 'FR0010754200', assetClass: 'other' },
  'a7c70290-b878-43cd-bbea-d16dc53f7969': { underlyingIsin: 'IE000RHYOR04', assetClass: 'other' },
  'bfdee27b-7389-4086-a2fd-da7197a4d781': { underlyingIsin: 'US5949724083', assetClass: 'equity' },
  '5dbc2b22-02bb-4f62-92d9-fc2d48b7160b': { underlyingIsin: 'IE00BJXRT698', assetClass: 'other' },
  '541a84c9-e975-467b-83c5-386242d633a4': { underlyingIsin: 'CH0102530786', assetClass: 'other' },
  '36c0d3ce-7c8e-4224-8f2a-48fce474722d': { underlyingIsin: 'US65481N1000', assetClass: 'equity' },
  'f1cfc60f-42f7-48b2-82b0-a0385b8bf325': { underlyingIsin: 'US88160R1014', assetClass: 'equity' },
  'fa5b7ff7-c40a-4fda-8c5b-0ff43c0829c3': { underlyingIsin: 'IE00BGSF1X88', assetClass: 'other' },
  '707c94eb-69c8-4ee2-879a-ac6d3ec42c30': { underlyingIsin: 'IE00BF3N7094', assetClass: 'other' },
  '626515a7-1347-4d73-a9f1-05d429127563': { underlyingIsin: 'US02079K3059', assetClass: 'equity' },
  '15865458-f1af-4be1-9b4a-0b7504e9dbce': { underlyingIsin: 'US36467W1099', assetClass: 'equity' },
  'c1077d76-ba02-4ab1-bd91-db0d18191c1a': { underlyingIsin: 'US67066G1040', assetClass: 'equity' },
  'a046956f-db44-4eb8-8ada-fae0cbea61df': { underlyingIsin: 'US5949181045', assetClass: 'equity' },
  'a3daf2e3-28df-4abd-860a-0e5a32c67873': { underlyingIsin: 'IE00B5BMR087', assetClass: 'fund_share' },
  'd9e29ddc-8009-4e54-b429-150e8e14d476': { underlyingIsin: 'IE00BYXPSP02', assetClass: 'other' },
  '0fb3fd15-dc6c-4576-a09d-8cd03604031e': { underlyingIsin: 'IE00BGCSB447', assetClass: 'other' },
  'a0ddd010-22ba-4c24-b03b-ab0ca147515e': { underlyingIsin: 'US19260Q1076', assetClass: 'equity' },
};

export function reviewedBackedAssetClassV1(
  issuerInstrumentId: string,
  underlyingIsin: string,
): ReviewedBackedUnderlyingAssetClassV1 {
  const reviewed = REVIEWED_BACKED_ASSET_CLASS_BY_INSTRUMENT_V1[issuerInstrumentId.toLowerCase()];
  return reviewed?.underlyingIsin === underlyingIsin.toUpperCase()
    ? reviewed.assetClass
    : 'unknown';
}

export interface ReviewedBackedRepresentationV1 {
  chainId: 8453;
  tokenAddress: string;
  caip10: string;
  representationKind: BackedRepresentationKindV1;
  issuerInstrumentKey: string;
  issuerInstrumentId: string;
  certificateIsin: string;
  underlyingKey: string;
  underlyingIsin: string;
  displaySymbol: string;
  displayName: string;
  underlyingDisplaySymbol: string;
  underlyingAssetClass: ReviewedBackedUnderlyingAssetClassV1;
  tradingHalted: boolean;
}

export function backedInstrumentKeyV1(id: string): string {
  return `backed:instrument_id:${id.toLowerCase()}`;
}

export function isinUnderlyingKeyV1(isin: string): string {
  return `security:isin:${isin.toUpperCase()}`;
}

function addRepresentationV1(
  output: ReviewedBackedRepresentationV1[],
  asset: BackedAssetV1,
  address: string,
  representationKind: BackedRepresentationKindV1,
): void {
  const tokenAddress = address.toLowerCase();
  output.push({
    chainId: 8453,
    tokenAddress,
    caip10: `eip155:8453:${tokenAddress}`,
    representationKind,
    issuerInstrumentKey: backedInstrumentKeyV1(asset.id),
    issuerInstrumentId: asset.id.toLowerCase(),
    certificateIsin: asset.isin,
    underlyingKey: isinUnderlyingKeyV1(asset.underlyingIsin),
    underlyingIsin: asset.underlyingIsin,
    displaySymbol: asset.symbol,
    displayName: asset.name,
    underlyingDisplaySymbol: asset.underlyingSymbol,
    underlyingAssetClass: reviewedBackedAssetClassV1(asset.id, asset.underlyingIsin),
    tradingHalted: asset.isTradingHalted,
  });
}

/** Exact Base mappings only. Ticker/name are carried after the identity join. */
export function reviewedBackedBaseRepresentationsV1(
  assets: readonly BackedAssetV1[],
): ReviewedBackedRepresentationV1[] {
  const output: ReviewedBackedRepresentationV1[] = [];
  for (const asset of assets) {
    for (const deployment of asset.deployments) {
      if (deployment.network !== 'Base' || !Address.safeParse(deployment.address).success) continue;
      addRepresentationV1(output, asset, deployment.address, 'rebasing_erc20');
      if (deployment.wrapperAddress) {
        addRepresentationV1(
          output,
          asset,
          deployment.wrapperAddress,
          'non_rebasing_erc4626_wrapper',
        );
      }
      if (deployment.wrapperAddressV2) {
        addRepresentationV1(
          output,
          asset,
          deployment.wrapperAddressV2,
          'non_rebasing_erc4626_wrapper',
        );
      }
    }
  }
  const unique = new Map<string, ReviewedBackedRepresentationV1>();
  for (const row of output) {
    const existing = unique.get(row.tokenAddress);
    if (existing && existing.issuerInstrumentKey !== row.issuerInstrumentKey) {
      throw new TypeError(`Backed API mapped ${row.tokenAddress} to two issuer instruments`);
    }
    unique.set(row.tokenAddress, row);
  }
  return [...unique.values()].sort((a, b) => a.tokenAddress.localeCompare(b.tokenAddress));
}

export function backedCorpusHashV1(rows: readonly ReviewedBackedRepresentationV1[]): string {
  const canonical = [...rows]
    .sort((a, b) => a.tokenAddress.localeCompare(b.tokenAddress))
    .map((row) => ({
      tokenAddress: row.tokenAddress,
      representationKind: row.representationKind,
      issuerInstrumentId: row.issuerInstrumentId,
      certificateIsin: row.certificateIsin,
      underlyingIsin: row.underlyingIsin,
      underlyingAssetClass: row.underlyingAssetClass,
    }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export type BackedAssetFetchV1 =
  | {
      ok: true;
      assets: BackedAssetV1[];
      representations: ReviewedBackedRepresentationV1[];
      documentHash: string;
      corpusHash: string;
    }
  | { ok: false; reason: 'http_error' | 'transport' | 'unparsable'; detail: string };

export async function fetchBackedBaseTokensV1(
  input: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<BackedAssetFetchV1> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, input.timeoutMs ?? 20_000));
  try {
    const response = await (input.fetchImpl ?? fetch)(BACKED_BTOKENS_SOURCE_URL_V1, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: 'http_error',
        detail: `the bTokens endpoint answered ${response.status}`,
      };
    }
    const body = await response.text();
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      return { ok: false, reason: 'unparsable', detail: 'the bTokens response was not JSON' };
    }
    const parsed = BackedAssetPageV1Schema.safeParse(decoded);
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'unparsable',
        detail: 'the bTokens response did not match the reviewed OpenAPI contract',
      };
    }
    const representations = reviewedBackedBaseRepresentationsV1(parsed.data.nodes);
    if (representations.length === 0) {
      return {
        ok: false,
        reason: 'unparsable',
        detail: 'the successful bTokens corpus named no exact Base representations',
      };
    }
    return {
      ok: true,
      assets: parsed.data.nodes,
      representations,
      documentHash: createHash('sha256').update(body).digest('hex'),
      corpusHash: backedCorpusHashV1(representations),
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'transport',
      detail:
        error instanceof Error && error.name === 'AbortError'
          ? 'the bTokens request timed out'
          : 'the bTokens request did not complete',
    };
  } finally {
    clearTimeout(timer);
  }
}
