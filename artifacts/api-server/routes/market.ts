import { Router } from 'express';
import { MarketSnapshotResponseV1Schema } from '@mioagent/api-zod';
import {
  readMarketSnapshotV1,
  type MarketSnapshotReasonV1,
  type MarketSnapshotResultV1,
} from '../lib/marketSnapshot.js';

// ---------------------------------------------------------------------------
// T65.2A — GET /api/market/snapshot.
//
// The console's price rail asked a status flag whether CoinGecko was connected
// and then showed nothing, because no endpoint ever returned a price. This is
// that endpoint.
//
// The API key is read from the environment here and never leaves: it is not in
// the response, not in the error body, and not in any log line. The client
// sends nothing at all — there is no parameter it could use to point this at a
// different host.
// ---------------------------------------------------------------------------

export const marketRouter = Router();

/** Seams, so tests never open a socket. */
export const marketRuntime = {
  read: readMarketSnapshotV1,
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
  now: () => new Date(),
  apiKey: (): string | null => {
    const key = (process.env.COINGECKO_API_KEY ?? '').trim();
    return key.length > 0 ? key : null;
  },
  /** Whether prices are this deployment's job at all. */
  priceProvider: (): string => (process.env.PRICE_PROVIDER ?? 'coingecko').trim().toLowerCase(),
};

/** One fixed sentence per reason. Never assembled per request, so an outage
 * cannot be phrased as a price. */
const MARKET_UNAVAILABLE_COPY_V1: Record<MarketSnapshotReasonV1, string> = {
  not_configured: 'No price provider is configured on this server, so no price is shown.',
  provider_unavailable: 'CoinGecko did not answer. Miorail shows no price rather than an old one.',
  rate_limited: 'CoinGecko is rate limiting this server. The price will return on its own.',
  provider_invalid_response: 'CoinGecko returned a response Miorail could not read safely.',
};

marketRouter.get('/snapshot', async (_req, res) => {
  const unavailable = (reason: MarketSnapshotReasonV1) =>
    res.json(
      MarketSnapshotResponseV1Schema.parse({
        outcome: 'unavailable',
        reason,
        detail: MARKET_UNAVAILABLE_COPY_V1[reason],
      }),
    );

  // A deployment that priced through another provider has no CoinGecko answer
  // to give, and says so rather than reading a source it was told not to use.
  if (marketRuntime.priceProvider() !== 'coingecko') {
    unavailable('not_configured');
    return;
  }

  let result: MarketSnapshotResultV1;
  try {
    result = await marketRuntime.read(
      { fetch: marketRuntime.fetch, now: marketRuntime.now },
      { apiKey: marketRuntime.apiKey() },
    );
  } catch {
    // The request URL carries the key, so the cause is not logged here.
    unavailable('provider_unavailable');
    return;
  }

  if (!result.ok) {
    unavailable(result.reason);
    return;
  }
  res.json(
    MarketSnapshotResponseV1Schema.parse({
      outcome: 'snapshot',
      status: result.status,
      ...result.snapshot,
    }),
  );
});
