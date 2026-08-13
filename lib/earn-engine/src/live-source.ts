import type { EarnProtocolV1 } from '@mioagent/route-domain';
import { createMoonwellEarnDataSourceV1, type MoonwellEarnDataSourceOptionsV1 } from './moonwell-source.js';
import { createMorphoEarnDataSourceV1, type MorphoEarnDataSourceOptionsV1 } from './morpho-source.js';
import { createYoEarnDataSourceV1, type YoEarnDataSourceOptionsV1 } from './yo-source.js';
import { createCachedEarnDataSourceV1, type EarnObservationCacheOptionsV1 } from './observation-cache.js';
import type { EarnChainReaderV1 } from './live-types.js';
import type { EarnDataSourceObserveInput, EarnDataSourceV1, EarnObservationResultV1 } from './types.js';

// ---------------------------------------------------------------------------
// T63A — the composed live earn data source: one façade over the two
// per-protocol sources, each behind its own cache. Routing is by protocol only,
// there is no fallback from one provider to the other: a Moonwell candidate is
// backed by Moonwell's own data or by nothing at all.
// ---------------------------------------------------------------------------

export interface LiveEarnDataSourceOptionsV1 {
  fetchImpl?: typeof fetch;
  chainReader?: EarnChainReaderV1 | null;
  timeoutMs?: number;
  freshnessTtlMs?: number;
  cache?: EarnObservationCacheOptionsV1;
  moonwell?: Partial<MoonwellEarnDataSourceOptionsV1>;
  morpho?: Partial<MorphoEarnDataSourceOptionsV1>;
  yo?: Partial<YoEarnDataSourceOptionsV1>;
  id?: string;
}

export const LIVE_EARN_DATA_SOURCE_ID_V1 = 'earn-live-v1';

export function createLiveEarnDataSourceV1(options: LiveEarnDataSourceOptionsV1 = {}): EarnDataSourceV1 {
  const shared = {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    freshnessTtlMs: options.freshnessTtlMs,
  };
  const sources: Record<EarnProtocolV1, EarnDataSourceV1> = {
    moonwell: createCachedEarnDataSourceV1(
      createMoonwellEarnDataSourceV1({ ...shared, chainReader: options.chainReader ?? null, ...options.moonwell }),
      options.cache,
    ),
    morpho: createCachedEarnDataSourceV1(
      createMorphoEarnDataSourceV1({ ...shared, ...options.morpho }),
      options.cache,
    ),
    yo: createCachedEarnDataSourceV1(
      createYoEarnDataSourceV1({
        chainReader: options.chainReader ?? null,
        freshnessTtlMs: options.freshnessTtlMs,
        ...options.yo,
      }),
      options.cache,
    ),
  };

  return {
    id: options.id ?? LIVE_EARN_DATA_SOURCE_ID_V1,
    supportedProtocols: options.chainReader?.readYoVaultSnapshot
      ? (['moonwell', 'morpho', 'yo'] as const)
      : (['moonwell', 'morpho'] as const),
    async observe(input: EarnDataSourceObserveInput): Promise<EarnObservationResultV1> {
      const source = sources[input.protocol];
      if (!source) return { ok: false, reason: 'unsupported_protocol' };
      return source.observe(input);
    },
  };
}
