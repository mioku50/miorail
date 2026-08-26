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
