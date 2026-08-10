import {
  launchPoolCoversWindowV1,
  type B20LaunchPoolRepositoryV1,
} from '@mioagent/route-storage';
import type { B20PoolStoreV1 } from '@mioagent/swap-adapters';

// ---------------------------------------------------------------------------
// The seam between a stored row and a pool lookup.
//
// It lives here, in the one module that already imports both packages, so that
// swap-adapters never learns about Postgres and route-storage never learns
// about pool keys. Two rules survive the crossing and everything else is
// mechanical:
//
//   1. A row only answers the window it actually searched. The resolver walks
//      forward from the launch block, so a row searched from a different
//      origin answers a different question even when the ranges overlap.
//   2. `endpoint_unavailable` is never written. It says nothing about the
//      token, and storing it would turn one throttled request into a verdict
//      that outlives the outage.
// ---------------------------------------------------------------------------

export function createB20PoolStoreV1(repository: B20LaunchPoolRepositoryV1): B20PoolStoreV1 {
  return {
    async read({ token, fromBlock, toBlock }) {
      const row = await repository.readLaunchPool(token);
      if (!row) return null;
      if (!launchPoolCoversWindowV1(row, { fromBlock, toBlock })) return null;
      if (row.outcome === 'absent') {
        // The cached miss. `no_pool_initialized` is what the resolver returns
        // for a window it searched and found nothing in — permanent for that
        // question, because a pool created later would not be in that window
        // either.
        return { ok: false, refusal: 'no_pool_initialized' };
      }
      return {
        ok: true,
        pool: {
          poolId: row.poolId,
          key: {
            currency0: row.currency0,
            currency1: row.currency1,
            fee: row.fee,
            tickSpacing: row.tickSpacing,
            hooks: row.hooks,
          },
          token: row.tokenAddress,
          quoteAsset: row.quoteAsset,
          tokenIsCurrency0: row.tokenIsCurrency0,
          // The block the Initialize log sat in — what `B20PoolV1` calls
          // `blockNumber`, stored under a name that says which block it is.
          blockNumber: Number(row.poolBlockNumber),
        },
      };
    },

    async write({ token, fromBlock, toBlock, result }) {
      const base = {
        tokenAddress: token.toLowerCase(),
        searchFromBlock: String(fromBlock),
        searchToBlock: String(toBlock),
        resolvedAt: new Date().toISOString(),
      };
      if (result.ok) {
        await repository.upsertLaunchPool({
          ...base,
          outcome: 'resolved',
          poolId: result.pool.poolId,
          currency0: result.pool.key.currency0,
          currency1: result.pool.key.currency1,
          fee: result.pool.key.fee,
          tickSpacing: result.pool.key.tickSpacing,
          hooks: result.pool.key.hooks,
          quoteAsset: result.pool.quoteAsset,
          tokenIsCurrency0: result.pool.tokenIsCurrency0,
          poolBlockNumber: String(result.pool.blockNumber),
        });
        return;
      }
      // Only a searched-and-empty window is cacheable. `endpoint_unavailable`
      // is filtered out before this is called, and the other refusals —
      // `wrong_emitter`, `malformed_log`, `token_not_in_pool`,
      // `unsupported_quote_asset` — describe a log we DID read, so the honest
      // record is that this window holds no usable pool for this token.
      await repository.upsertLaunchPool({
        ...base,
        outcome: 'absent',
        poolId: null,
        currency0: null,
        currency1: null,
        fee: null,
        tickSpacing: null,
        hooks: null,
        quoteAsset: null,
        tokenIsCurrency0: null,
        poolBlockNumber: null,
      });
    },
  };
}
