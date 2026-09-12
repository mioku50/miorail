import type { B20CorporateActionObservationV1 } from '@mioagent/b20-control';
import type { CashExitMeasurementRunV1 } from '@mioagent/route-storage';
import {
  RWA_CASH_EXIT_CHANGE_THRESHOLD_BPS_V1,
  type RwaOnchainSignalKindV1,
  type OfficialSnapshotOutcomeV1,
  type OfficialLookalikeRowV1,
  type RwaSignalV1,
} from '@mioagent/route-storage';

import { previewLadderFromRunV1, routeStatusFromPreviewV1 } from './overview.js';

// ---------------------------------------------------------------------------
// Turning a writer's outcome into transitions.
//
// Pure, and separate from the workers on purpose: every one of these functions
// is a place where "what we just stored" could be mistaken for "what changed",
// and that mistake is only visible in a test that hands the same input twice.
//
// The rule that runs through all of them: our own failure is never a signal.
// A source that could not be read drops no asset. A router that timed out does
// not close a market. Both would produce a confident sentence about a token,
// authored entirely by our outage.
// ---------------------------------------------------------------------------

/**
 * What one recorded source check changed.
 *
 * `outcome.added` and `outcome.delisted` are transitions the repository
 * computed against the state it already held, which is why they can be trusted
 * here -- and why a failed check produces neither: it writes no membership at
 * all, so nothing can have moved.
 */
export function officialSourceSignalsV1(input: {
  outcome: OfficialSnapshotOutcomeV1;
  /** Ticker and display name per address, from the corpus this check wrote. */
  named: ReadonlyMap<string, { ticker: string; displayName: string | null }>;
  sourceUrl: string;
}): RwaSignalV1[] {
  if (input.outcome.status !== 'ok') return [];
  const signals: RwaSignalV1[] = [];
  const facts = (tokenAddress: string) => {
    const named = input.named.get(tokenAddress);
    return named === undefined
      ? null
      : {
          sourceKind: input.outcome.sourceKind,
          sourceUrl: input.sourceUrl,
          ticker: named.ticker,
          displayName: named.displayName,
        };
  };
  for (const tokenAddress of input.outcome.added) {
    const row = facts(tokenAddress);
    if (row === null) continue;
    signals.push({
      kind: 'official_source_added_asset',
      chainId: 8453,
      subjectAddress: tokenAddress,
      officialAddress: null,
      occurredAt: input.outcome.observedAt,
      // The snapshot id, so a transition is tied to the exact check that saw
      // it. A later re-add after a delisting is a different check and a
      // different row, which is correct: it happened twice.
      dedupeKey: `official_source_added_asset:${input.outcome.sourceKind}:${tokenAddress}:${input.outcome.snapshotId}`,
      facts: row,
    } as RwaSignalV1);
  }
  for (const tokenAddress of input.outcome.delisted) {
    const row = facts(tokenAddress);
    if (row === null) continue;
    signals.push({
      kind: 'official_source_removed_asset',
      chainId: 8453,
      subjectAddress: tokenAddress,
      officialAddress: null,
      occurredAt: input.outcome.observedAt,
      dedupeKey: `official_source_removed_asset:${input.outcome.sourceKind}:${tokenAddress}:${input.outcome.snapshotId}`,
      facts: row,
    } as RwaSignalV1);
  }
  return signals;
}

/**
 * Contracts that started wearing an official name.
 *
 * Only `flagged` -- contracts the scan saw for the first time. A refreshed
 * reading of a contract flagged last week is not news, and firing on it every
 * hour is how a feed becomes something people stop reading.
 */
export function lookalikeSignalsV1(input: {
  flagged: readonly string[];
  rows: readonly OfficialLookalikeRowV1[];
  officialTickers: ReadonlyMap<string, string>;
  occurredAt: string;
}): RwaSignalV1[] {
  const byAddress = new Map(input.rows.map((row) => [row.tokenAddress, row]));
  const signals: RwaSignalV1[] = [];
  for (const tokenAddress of input.flagged) {
    const row = byAddress.get(tokenAddress);
    if (row === undefined) continue;
    const officialTicker = input.officialTickers.get(row.officialAddress);
    if (officialTicker === undefined) continue;
    signals.push({
      kind: 'official_asset_lookalike_created',
      chainId: 8453,
      subjectAddress: row.tokenAddress,
      officialAddress: row.officialAddress,
      // When the contract was flagged, not when it launched. The launch is in
      // the facts; dating the signal to it would put a three-week-old token at
      // the top of a feed of things that just happened.
      occurredAt: input.occurredAt,
      dedupeKey: `official_asset_lookalike_created:${row.tokenAddress}`,
      facts: {
        matchKind: row.matchKind,
        matchedAlias: row.matchedAlias,
        matchedValue: row.matchedValue,
        officialTicker,
        launchSymbol: row.launchSymbol,
        launchName: row.launchName,
      },
    } as RwaSignalV1);
  }
  return signals;
}

/**
 * What one cash-exit measurement changed against the one before it.
 *
 * Three transitions, in the order they matter, and at most one cost row per
 * asset per run: the largest comparable move. A signal per rung would put four
 * lines on the feed saying the same thing at four sizes.
 */
export function cashExitSignalsV1(input: {
  previous: CashExitMeasurementRunV1 | null;
  next: CashExitMeasurementRunV1;
  ticker: string;
}): RwaSignalV1[] {
  // The stored readings, NOT the freshness-gated ladder.
  //
  // A router quote lapses in about twenty seconds. Comparing two runs through
  // the executable projection would read the previous one as `not_measured`
  // the moment it aged, so every hourly pass would announce that the market
  // had just become reachable. What changed between two measurements cannot
  // depend on how long ago they were taken.
  const nextRungs = previewLadderFromRunV1(input.next);
  const previousRungs = previewLadderFromRunV1(input.previous);
  const nextStatus = routeStatusFromPreviewV1(nextRungs);
  const previousStatus = routeStatusFromPreviewV1(previousRungs);
  const tokenAddress = input.next.tokenAddress;
  const occurredAt = input.next.completedAt;
  const approvedSources = input.next.approvedSources;

  // A measurement that failed says nothing about the market. Reporting it as a
  // market closing would be our outage wearing the token's name -- a bug class
  // this product has shipped three times.
  if (nextStatus === 'measurement_failed' || nextStatus === 'not_measured') return [];

  // Both no-route words are market findings, so both close a market. They stay
  // separate everywhere a reader can see them and are treated alike only here,
  // where the question is whether a route that existed still does.
  const closed =
    nextStatus === 'no_route_at_measured_sizes' ||
    nextStatus === 'no_entry_route_at_measured_sizes';
  if (previousStatus === 'cash_route_established' && closed) {
    const smallest = nextRungs[0];
    if (!smallest) return [];
    return [
      {
        kind: 'official_asset_market_became_unreachable',
        chainId: 8453,
        subjectAddress: tokenAddress,
        officialAddress: null,
        occurredAt,
        dedupeKey: `official_asset_market_became_unreachable:${tokenAddress}:${input.next.runId}`,
        facts: {
          ticker: input.ticker,
          destination: smallest.destination,
          requestedCashAtomic: smallest.requestedCashAtomic,
          roundTripCostBps: null,
          approvedSources,
        },
      } as RwaSignalV1,
    ];
  }

  if (previousStatus !== 'cash_route_established' && nextStatus === 'cash_route_established') {
    // The largest size that completed: the strongest true statement about the
    // route that just appeared.
    const largest = nextRungs
      .filter((rung) => rung.status === 'full')
      .sort((left, right) =>
        BigInt(left.requestedCashAtomic) > BigInt(right.requestedCashAtomic) ? -1 : 1,
      )[0];
    if (!largest) return [];
    return [
      {
        kind: 'official_asset_market_became_active',
        chainId: 8453,
        subjectAddress: tokenAddress,
        officialAddress: null,
        occurredAt,
        dedupeKey: `official_asset_market_became_active:${tokenAddress}:${input.next.runId}`,
        facts: {
          ticker: input.ticker,
          destination: largest.destination,
          requestedCashAtomic: largest.requestedCashAtomic,
          roundTripCostBps: largest.roundTripCostBps,
          approvedSources,
        },
      } as RwaSignalV1,
    ];
  }

  // Comparable means the same size to the same destination, both completed,
  // both carrying an exact cost. A rung whose cost was carried forward from a
  // smaller size is excluded: comparing it would report a move between two
  // different sizes as a move in the market.
  const before = new Map(
    previousRungs
      .filter((rung) => rung.status === 'full' && rung.roundTripCostBps !== null)
      .map((rung) => [`${rung.destination}:${rung.requestedCashAtomic}`, rung]),
  );
  let biggest: { key: string; change: bigint; previous: string; next: string } | null = null;
  for (const rung of nextRungs) {
    if (rung.status !== 'full' || rung.roundTripCostBps === null) continue;
    const key = `${rung.destination}:${rung.requestedCashAtomic}`;
    const prior = before.get(key);
    if (!prior?.roundTripCostBps) continue;
    const change = BigInt(rung.roundTripCostBps) - BigInt(prior.roundTripCostBps);
    const magnitude = change < 0n ? -change : change;
    if (magnitude < BigInt(RWA_CASH_EXIT_CHANGE_THRESHOLD_BPS_V1)) continue;
    const currentMagnitude =
      biggest === null ? -1n : biggest.change < 0n ? -biggest.change : biggest.change;
    if (magnitude <= currentMagnitude) continue;
    biggest = { key, change, previous: prior.roundTripCostBps, next: rung.roundTripCostBps };
  }
  if (biggest === null) return [];
  const [destination, requestedCashAtomic] = biggest.key.split(':') as ['USDC' | 'ETH', string];
  return [
    {
      kind: 'official_asset_cash_exit_changed',
      chainId: 8453,
      subjectAddress: tokenAddress,
      officialAddress: null,
      occurredAt,
      dedupeKey: `official_asset_cash_exit_changed:${tokenAddress}:${biggest.key}:${input.next.runId}`,
      facts: {
        ticker: input.ticker,
        destination,
        requestedCashAtomic,
        previousRoundTripCostBps: biggest.previous,
        roundTripCostBps: biggest.next,
        changeBps: biggest.change.toString(),
        thresholdBps: RWA_CASH_EXIT_CHANGE_THRESHOLD_BPS_V1,
        approvedSources,
      },
    } as RwaSignalV1,
  ];
}

/**
 * What a corporate-action pass observed, as transitions.
 *
 * Unlike every other emitter in this file, this one is not comparing two
 * stored states: Base emits `Announcement` precisely so an integrator can
 * catch a corporate action as it executes, so the log IS the transition. What
 * stays identical is the discipline around it.
 *
 * THREE RULES, EACH ONE A BUG SOMEWHERE ELSE IN THIS PRODUCT
 *
 *   * Nothing older than the watch. A tail may be pointed at any range -- and
 *     it should be, once, to establish that the record was empty before it
 *     started -- but history is stored and never announced. The repository
 *     refuses a signal dated before its watch, and an emitter that made it
 *     raise that refusal would be a worker crashing on correct data.
 *
 *   * `EndAnnouncement` is not a transition. It closes the bracket the opening
 *     event already reported; emitting both would put one corporate action on
 *     the feed twice, in two sentences a reader cannot reconcile.
 *
 *   * An unreadable payload still reports the event. `topic_only` means the
 *     action executed and its words were somewhere this build cannot read --
 *     a gap in our reading, not an absence of news, and the feed says which.
 */
export function corporateActionSignalsV1(input: {
  observations: readonly B20CorporateActionObservationV1[];
  /** When each kind's watch opened. A kind absent from the map is not being
   * watched, and emits nothing at all. */
  watchingSince: ReadonlyMap<RwaOnchainSignalKindV1, string>;
}): RwaSignalV1[] {
  const signals: RwaSignalV1[] = [];
  for (const observation of input.observations) {
    const { action } = observation;
    if (action.event === 'end_announcement') continue;
    const multiplierEvent = action.event === 'announcement' ? null : action.event;
    const kind =
      action.event === 'announcement'
        ? 'official_asset_corporate_action_announced'
        : 'official_asset_multiplier_changed';
    const since = input.watchingSince.get(kind);
    if (since === undefined) continue;
    if (Date.parse(observation.blockTime) < Date.parse(since)) continue;

    // One log, one transition, forever. The transaction and the log index
    // identify it for all time, so a re-read of the same range writes nothing.
    const dedupeKey = `${kind}:${observation.transactionHash}:${observation.logIndex}`;
    const blockNumber = String(observation.blockNumber);
    if (kind === 'official_asset_corporate_action_announced') {
      signals.push({
        kind,
        chainId: 8453,
        subjectAddress: observation.tokenAddress,
        officialAddress: null,
        occurredAt: observation.blockTime,
        dedupeKey,
        facts: {
          event: 'announcement',
          announcementId: action.announcementId,
          description: action.description,
          uri: action.uri,
          payloadState: action.payload,
          transactionHash: observation.transactionHash,
          blockNumber,
        },
      });
      continue;
    }
    signals.push({
      kind,
      chainId: 8453,
      subjectAddress: observation.tokenAddress,
      officialAddress: null,
      occurredAt: observation.blockTime,
      dedupeKey,
      facts: {
        event: multiplierEvent!,
        multiplierWad: action.multiplierWad,
        payloadState: action.payload,
        transactionHash: observation.transactionHash,
        blockNumber,
      },
    });
  }
  return signals;
}
