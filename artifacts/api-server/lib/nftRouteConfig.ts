import { NFT_LISTING_TTL_MS_DEFAULT_V1, NFT_OPENSEA_TIMEOUT_MS_DEFAULT_V1 } from '@mioagent/nft-engine';

// ---------------------------------------------------------------------------
// T65 §2 — the NFT family's deployment configuration.
//
// The OpenSea key is read HERE and nowhere else, from the server environment
// only. Nothing in this codebase creates a key, prompts for one, or shells out
// to an OpenSea CLI: production uses the server-side OPENSEA_API_KEY or the
// family stays off.
// ---------------------------------------------------------------------------

export interface NftRouteConfigV1 {
  openSeaApiKey: string;
  /** False when no key is configured. Every route checks this before it
   * pretends to have a provider. */
  configured: boolean;
  timeoutMs: number;
  listingTtlMs: number;
  /** This deployment's media policy. Off by default: an image URL from a
   * marketplace is a URL some surface will eventually load. */
  imageAllowed: boolean;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveNftRouteConfigV1(env: NodeJS.ProcessEnv = process.env): NftRouteConfigV1 {
  const openSeaApiKey = env.OPENSEA_API_KEY?.trim() ?? '';
  return {
    openSeaApiKey,
    configured: openSeaApiKey.length > 0,
    timeoutMs: positiveInt(env.MIORAIL_OPENSEA_TIMEOUT_MS, NFT_OPENSEA_TIMEOUT_MS_DEFAULT_V1),
    listingTtlMs: positiveInt(env.MIORAIL_NFT_LISTING_TTL_MS, NFT_LISTING_TTL_MS_DEFAULT_V1),
    imageAllowed: env.MIORAIL_NFT_IMAGES_V1?.trim().toLowerCase() === 'true',
  };
}
