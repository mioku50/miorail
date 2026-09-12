import { assembleUseAccessV1 } from '@mioagent/rwa-issuer/useAccess';
import { pooledLiquidityFromReadingsV1 } from '@mioagent/rwa-issuer';
import {
  UseAccessAgentInputV1Schema,
  UseAccessAgentOutputV1Schema,
  exactUseAccessAddressV1,
  reviewedIssuerIdOrNullV1,
  useAccessForAgentV1,
  type UseAccessAgentInputV1,
  type UseAccessAgentOutputV1,
} from '@mioagent/rwa-issuer/useAccessAgent';

import { ecosystemEvidenceForV1, rwaMarketRealityRuntime } from '../rwaMarketReality.js';
import { McpPublicError } from './tools.js';

export { UseAccessAgentInputV1Schema, UseAccessAgentOutputV1Schema };

// ---------------------------------------------------------------------------
// `get_use_access`, and the two things that had to be true before it could be
// public.
//
// 1. THE KEY SPACE IS THE REVIEWED CORPUS. A reading costs roughly ten
//    `eth_call`s and two HTTP fetches. Accepting any address would let one
//    caller aim that fan-out anywhere, so an address Miorail holds no reviewed
//    binding for is refused BEFORE any of it runs. That is also the honest
//    answer: this tool reports what Miorail reviewed, and it knows nothing
//    about an address it never bound.
//
// 2. THE WORK IS SHARED, NOT REPEATED. Assistants loop; that is the normal
//    case, not the abusive one. One reading per address is computed at a time
//    and reused for a short window, so N callers asking the same question cost
//    one fan-out rather than N. The reply says when it was read — `observedAt`
//    and each venue's own `observed` — so a shared reading is never a reading
//    claiming to be newer than it is.
//
// The transport limiter above this (30 requests a minute per client) still
// applies. It bounds calls; this bounds the work behind them.
// ---------------------------------------------------------------------------

/**
 * How long one address's reading is reused.
 *
 * A venue listing is a governance action, not a price: nothing measured here
 * changes between two calls a minute apart. Long enough that a looping
 * assistant costs one fan-out, short enough that a real listing shows up in
 * the same minute it lands.
 */
export const USE_ACCESS_CACHE_TTL_MS_V1 = 60_000;

/** The reviewed corpus is ~130 addresses; this is headroom, not a policy. */
const USE_ACCESS_CACHE_MAX_V1 = 256;

type CacheEntryV1 = { at: number; value: Promise<UseAccessAgentOutputV1> };
const cacheV1 = new Map<string, CacheEntryV1>();

/** Testing seam. Nothing in production calls it. */
export function resetUseAccessCacheV1(): void {
  cacheV1.clear();
}

async function readV1(tokenAddress: string): Promise<UseAccessAgentOutputV1> {
  const identity = await rwaMarketRealityRuntime
    .underlyings()
    .underlyingOf({ chainId: 8453, tokenAddress });
  if (!identity) {
    throw new McpPublicError(
      'representation_not_reviewed',
      'Miorail holds no reviewed binding for that exact Base address, so it has nothing measured to report about it. This is a statement about Miorail’s corpus, never about the token.',
    );
  }
  // Stored, and read BEFORE the chain calls, exactly as the screen does. This
  // was missing entirely, so an assistant asked about LP was handed four
  // lending venues that all said no — the same false "no DeFi use" the pooled
  // section was built to end, reappearing one surface over.
  const stored = await rwaMarketRealityRuntime
    .poolReadings()
    .readingsForToken({ chainId: 8453, tokenAddress, limit: 60 });
  // The same evidence the screen uses, from the same function. An assistant
  // that read Base's page and asked "does Aave support this?" is exactly the
  // caller this block was built for.
  const ecosystem = await ecosystemEvidenceForV1(tokenAddress, {
    issuerId: reviewedIssuerIdOrNullV1(identity.binding.issuerId),
  });
  const use = await assembleUseAccessV1({
    tokenAddress,
    ecosystem,
    pools: pooledLiquidityFromReadingsV1(stored),
    reader: rwaMarketRealityRuntime.useAccessReader(),
    now: rwaMarketRealityRuntime.now(),
    // Per venue row: four sequential readings, two of them network fetches.
    clock: rwaMarketRealityRuntime.now,
    defiSources: rwaMarketRealityRuntime.defiSources(),
    // No wallet is passed, and the field is not named here at all. An argument
    // this file never writes is a boundary no later edit crosses by "just
    // adding a filter" -- the same reason no tool on this surface accepts a
    // wallet in its input schema. The assembly defaults to none, and the
    // projection pins `walletBound: false` as a literal.
  });
  return useAccessForAgentV1({
    use,
    underlyingKey: identity.binding.underlyingKey,
    displaySymbol: identity.underlying.displaySymbol ?? null,
    issuerId: reviewedIssuerIdOrNullV1(identity.binding.issuerId),
  });
}

export async function miorailGetUseAccessV1(
  rawInput: UseAccessAgentInputV1,
): Promise<UseAccessAgentOutputV1> {
  const input = UseAccessAgentInputV1Schema.parse(rawInput);
  const tokenAddress = exactUseAccessAddressV1(input.address);
  if (!tokenAddress) {
    throw new McpPublicError(
      'exact_address_required',
      'This tool reads one exact Base contract address or CAIP-10. It does not resolve a ticker or a company name — different issuers publish different contracts for the same company, and Miorail does not choose between them. Use list_reviewed_stocks then get_representations to obtain an address.',
    );
  }
  if (!(await rwaMarketRealityRuntime.migrationAvailable())) {
    throw new McpPublicError(
      'market_reality_storage_unavailable',
      'Miorail could not read its own representation registry. This is not a statement about any address.',
    );
  }

  const now = Date.now();
  const cached = cacheV1.get(tokenAddress);
  if (cached && now - cached.at < USE_ACCESS_CACHE_TTL_MS_V1) return cached.value;

  const value = readV1(tokenAddress);
  cacheV1.set(tokenAddress, { at: now, value });
  // A failure is never cached: a provider outage held for a minute would turn
  // one bad call into a minute of "unread" for every caller.
  value.catch(() => {
    const current = cacheV1.get(tokenAddress);
    if (current?.value === value) cacheV1.delete(tokenAddress);
  });
  if (cacheV1.size > USE_ACCESS_CACHE_MAX_V1) {
    const oldest = cacheV1.keys().next();
    if (!oldest.done) cacheV1.delete(oldest.value);
  }
  return value;
}
