import type {
  CashExitMeasurementRunV1,
  CashExitSourceObservationV1,
  OfficialCashExitRepositoryV1,
  UnderlyingAssetRepositoryV1,
} from '@mioagent/route-storage';

import {
  MarketRealityHistoryV1Schema,
  type MarketRealityDirectionV1,
  type MarketRealityHistoryV1,
} from './contracts.js';

// ---------------------------------------------------------------------------
// What this cost the last N times anybody looked.
//
// The background sampler was never useless — it was mislabelled. Every pass it
// has ever run produced a real measurement of a real size through a real
// router, and the only thing wrong was presenting those as a current price.
// Placed on a time axis they become the thing a sampler is actually for.
//
// TWO RULES THIS PROJECTION CANNOT BE TALKED OUT OF
//
//   * A point is one EXACT question. Same size, same direction, same
//     destination, same approved-router set — the same comparability rule the
//     coverage gate applies across representations, applied here across time.
//     A series that mixed $100 and $10,000 would be a chart of the size
//     control, not of the market.
//
//   * A point is never interpolated and a gap is never bridged. The sampler
//     misses passes; an endpoint refuses; a token has no route for an hour.
//     Those are holes in the record and they stay holes, because a line drawn
//     through them is a measurement nobody took.
//
// The series carries failures as points too. "No route at 14:00" is a fact
// about the market worth seeing next to "0.4% at 15:00", and dropping it would
// turn an hour of illiquidity into an hour of silence.
// ---------------------------------------------------------------------------

export interface MarketRealityHistoryDepsV1 {
  underlyings: UnderlyingAssetRepositoryV1;
  cashExit: OfficialCashExitRepositoryV1;
  now: () => Date;
}

/** The windows a caller may ask for. Bounded in code rather than taken as a
 * number, because an unbounded window is a table scan wearing a query string. */
export const MARKET_REALITY_WINDOWS_V1 = {
  '1h': 60 * 60 * 1_000,
  '6h': 6 * 60 * 60 * 1_000,
  '24h': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
} as const;
export type MarketRealityWindowV1 = keyof typeof MARKET_REALITY_WINDOWS_V1;

function pointStatusV1(
  row: CashExitSourceObservationV1,
  direction: MarketRealityDirectionV1,
): 'quoted' | 'no_route' | 'unsized' | 'measurement_failed' {
  const quote = direction === 'buy' ? row.buyQuote : row.sellQuote;
  if (quote) return 'quoted';
  if (direction === 'buy' && row.errorCode === 'cash_size_anchor_no_route') return 'no_route';
  if (direction === 'sell' && row.errorCode === 'cash_size_anchor_no_route') return 'unsized';
  if (direction === 'sell' && ['buy_only', 'unavailable'].includes(row.status)) return 'no_route';
  return 'measurement_failed';
}

/** The best answer one run gave for one exact question, or null when the run
 * did not ask it. Best = most cash back, which is the same rule the current
 * read uses, so a point and a live answer are the same kind of number. */
function pointForRunV1(
  run: CashExitMeasurementRunV1,
  input: {
    direction: MarketRealityDirectionV1;
    requestedCashAtomic: string;
    destination: 'USDC' | 'ETH';
  },
): {
  observedAt: string;
  status: 'quoted' | 'no_route' | 'unsized' | 'measurement_failed';
  source: string;
  returnedCashAtomic: string | null;
  testedTokenAtomic: string | null;
  errorCode: string | null;
} | null {
  const rows = run.observations.filter(
    (row) =>
      row.requestedCashAtomic === input.requestedCashAtomic &&
      row.destination === input.destination,
  );
  if (rows.length === 0) return null;

  const scored = rows.map((row) => ({ row, status: pointStatusV1(row, input.direction) }));
  const quoted = scored.filter((item) => item.status === 'quoted');
  const chosen =
    quoted.length > 0
      ? quoted.sort((left, right) => {
          const l = BigInt(
            (input.direction === 'sell' ? left.row.sellQuote : left.row.buyQuote)!.outputAtomic,
          );
          const r = BigInt(
            (input.direction === 'sell' ? right.row.sellQuote : right.row.buyQuote)!.outputAtomic,
          );
          return l === r ? left.row.source.localeCompare(right.row.source) : l > r ? -1 : 1;
        })[0]!
      : // No quote anywhere. An answered market question outranks a technical
        // failure, and an explicitly unsized SELL outranks it too: the latter
        // proves this direction was never tested after the BUY sizing anchor
        // failed. Source ordering must not turn either fact into our failure.
        (scored.find((item) => item.status === 'no_route') ??
        scored.find((item) => item.status === 'unsized') ??
        scored[0]!);

  return {
    observedAt: chosen.row.observedAt,
    status: chosen.status,
    source: chosen.row.source,
    returnedCashAtomic:
      input.direction === 'sell'
        ? (chosen.row.sellQuote?.outputAtomic ?? null)
        : (chosen.row.buyQuote?.inputAtomic ?? null),
    testedTokenAtomic: chosen.row.testedTokenAtomic,
    errorCode: chosen.row.errorCode ?? null,
  };
}

/**
 * The comparable series for one underlying, one exact question, one window.
 *
 * Every representation gets its own series, and they share an x axis only in
 * the sense that they share a window — points are not aligned, resampled or
 * forward-filled onto a common grid, because a representation that was not
 * measured at 14:00 has no value at 14:00.
 */
export async function assembleMarketRealityHistoryV1(
  deps: MarketRealityHistoryDepsV1,
  input: {
    underlyingKey: string;
    direction: MarketRealityDirectionV1;
    requestedCashAtomic: string;
    destination?: 'USDC' | 'ETH';
    window: MarketRealityWindowV1;
    maxPointsPerRepresentation?: number;
  },
): Promise<MarketRealityHistoryV1> {
  const now = deps.now();
  const destination = input.destination ?? 'USDC';
  const windowMs = MARKET_REALITY_WINDOWS_V1[input.window];
  const since = new Date(now.getTime() - windowMs).toISOString();
  const limit = Math.max(1, Math.min(500, input.maxPointsPerRepresentation ?? 200));

  const bindings = await deps.underlyings.representationsOf({
    chainId: 8453,
    underlyingKey: input.underlyingKey,
  });

  const representations = await Promise.all(
    bindings.map(async (binding) => {
      const runs = await deps.cashExit.completedRunsSince({
        chainId: 8453,
        tokenAddress: binding.tokenAddress,
        scope: 'public_ladder',
        since,
        limit,
      });
      const points = runs
        .map((run) => {
          const point = pointForRunV1(run, {
            direction: input.direction,
            requestedCashAtomic: input.requestedCashAtomic,
            destination,
          });
          return point
            ? {
                ...point,
                // The router set that produced this point. Two points measured
                // through different sets are not comparable, and a series that
                // hid that would be comparing a market change with a config
                // change.
                approvedSources: [...run.approvedSources].sort(),
              }
            : null;
        })
        .filter((point): point is NonNullable<typeof point> => point !== null)
        // Oldest first: a series is read left to right, and the storage read
        // returns newest first because that is what a "latest" query wants.
        .reverse();

      const quoted = points.filter((point) => point.status === 'quoted');
      return {
        tokenAddress: binding.tokenAddress,
        issuerId: binding.issuerId ?? null,
        representationKind: binding.representationKind ?? null,
        points,
        pointCount: points.length,
        quotedCount: quoted.length,
        firstObservedAt: points[0]?.observedAt ?? null,
        lastObservedAt: points[points.length - 1]?.observedAt ?? null,
      };
    }),
  );

  return MarketRealityHistoryV1Schema.parse({
    schemaVersion: 'market-reality-history/v1',
    chainId: 8453,
    underlyingKey: input.underlyingKey,
    direction: input.direction,
    requestedCashAtomic: input.requestedCashAtomic,
    destination,
    window: input.window,
    since,
    interpolated: false,
    representations,
    assembledAt: now.toISOString(),
  });
}
