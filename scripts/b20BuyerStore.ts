import {
  launchBuyerWindowClosedV1,
  launchBuyersCoverWindowV1,
  type B20LaunchBuyersRepositoryV1,
  type B20LaunchBuyersRowV1,
} from '@mioagent/route-storage';
import {
  B20_BUYER_WINDOW_BLOCKS_V1,
  b20LaunchBuyersV1,
  type RawLogV1,
} from '@mioagent/swap-adapters';

// ---------------------------------------------------------------------------
// Launch-window buying, measured once and then never again.
//
// The window is 10,000 blocks from the launch — about five and a half hours —
// and `mainnet.base.org` serves that range in ONE `eth_getLogs`. Once the
// window is past, the answer cannot change, so this is the same
// measure-once-and-cache shape as the pool lookup.
//
// Three refusals, in the order they are checked:
//
//   1. A window that has not CLOSED is not measured at all. A launch an hour
//      old has most of its window in the future, and a count taken now would
//      be frozen as final — "one buyer so far" presented as "one buyer, ever".
//   2. A cached row only answers the window it searched, same origin rule as
//      the pool cache.
//   3. An endpoint that refused is not stored. "No buyers" is also the common
//      TRUE answer here, so a silent zero would be indistinguishable from the
//      real thing — the exact bug class Miorail has shipped three times.
// ---------------------------------------------------------------------------

export interface B20BuyerMeasurementV1 {
  ensureMeasured(input: {
    token: string;
    launchBlock: number;
    /** The chain head this pass observed. Without it nothing is measured: a
     * window cannot be known to be closed against an unknown present. */
    observedHead: number;
  }): Promise<B20LaunchBuyersRowV1 | null>;
}

export function createB20BuyerMeasurementV1(input: {
  repository: B20LaunchBuyersRepositoryV1;
  getLogs: (query: {
    address: string;
    fromBlock: number;
    toBlock: number;
    topics: (string | null)[];
  }) => Promise<readonly RawLogV1[]>;
  now?: () => Date;
}): B20BuyerMeasurementV1 {
  const now = input.now ?? (() => new Date());
  return {
    async ensureMeasured({ token, launchBlock, observedHead }) {
      const window = {
        fromBlock: launchBlock,
        toBlock: launchBlock + B20_BUYER_WINDOW_BLOCKS_V1,
      };

      let cached: B20LaunchBuyersRowV1 | null = null;
      try {
        cached = await input.repository.readLaunchBuyers(token);
      } catch {
        // A cache that cannot be read is a cache miss, not a failure — but the
        // window check below still applies, so an open window stays unmeasured.
        cached = null;
      }
      if (cached && launchBuyersCoverWindowV1(cached, window)) return cached;

      // The rule this measurement adds over the pool cache. Deliberately after
      // the cache read: a closed window measured earlier is still valid.
      if (!launchBuyerWindowClosedV1(window, observedHead)) return null;

      const measured = await b20LaunchBuyersV1({
        token,
        launchBlock,
        windowBlocks: B20_BUYER_WINDOW_BLOCKS_V1,
        getLogs: input.getLogs,
      });
      // Not stored, not returned. Nothing was learned about the token.
      if (!measured.ok) return null;

      const { distribution } = measured;
      const row = (distribution.buyerCount > 0
        ? {
            tokenAddress: token.toLowerCase(),
            searchFromBlock: String(window.fromBlock),
            searchToBlock: String(window.toBlock),
            measuredAt: now().toISOString(),
            buyerCount: distribution.buyerCount,
            totalBoughtAtomic: distribution.totalBoughtAtomic,
            topBuyerShareBps: distribution.topBuyerShareBps ?? 0,
            topThreeShareBps: distribution.topThreeShareBps ?? 0,
          }
        : {
            tokenAddress: token.toLowerCase(),
            searchFromBlock: String(window.fromBlock),
            searchToBlock: String(window.toBlock),
            measuredAt: now().toISOString(),
            buyerCount: 0 as const,
            totalBoughtAtomic: '0' as const,
            topBuyerShareBps: null,
            topThreeShareBps: null,
          }) as B20LaunchBuyersRowV1;

      try {
        return await input.repository.upsertLaunchBuyers(row);
      } catch {
        // Failing to remember is not a reason to discard what was measured.
        return row;
      }
    },
  };
}
