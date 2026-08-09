import {
  createB20ReaderV1,
  exitControlsFromSnapshotV1,
  hashB20SnapshotV1,
  inspectB20TokenV1,
} from '@mioagent/b20-control';
import {
  b20QuoteExitSizesV4V1,
  b20RoundTripV4V1,
  createAerodromeReaderV1,
  createB20PoolCacheV1,
  V4QuoteUnavailableError,
} from '@mioagent/swap-adapters';
import {
  exitProbeLadderV1,
  priceImpactLadderV1,
  type B20ObservationControlsV1,
} from '@mioagent/opportunity-rail';

import {
  aerodromeRouteKeyV1,
  analyseExitV1,
  EXIT_PROBE_RUNGS_V1,
} from '../artifacts/api-server/lib/exitAnalysis.js';
import {
  transferPolicyStateV1,
  type MeasurementDepsV1,
  type ObservationAnchorV1,
} from './b20MeasureRun.js';

// ---------------------------------------------------------------------------
// T73-LIVE §2 — the measurement pass's dependencies, in one place.
//
// Lifted out of `b20_measure_opportunities.ts` unchanged when the same work
// became a long-running service. Two copies of this wiring would be two
// definitions of what a measurement IS — one of them would eventually anchor a
// control read at a different block from its factory read, and the observation
// would claim to describe a moment that never existed.
//
// READ-ONLY by construction: two readers, `eth_call` / `eth_getBlockByNumber`
// for B20 controls and `getAmountsOut` for Aerodrome. No signer, no key, no
// allowance write, no state override, no probe balance. Both endpoints are
// handed to their readers and never appear in an observation, a summary or an
// error.
// ---------------------------------------------------------------------------

export interface B20MeasureDepsInputV1 {
  rpcUrl: string;
  maxRetries: number;
}

export function createB20MeasureDepsV1(input: B20MeasureDepsInputV1): MeasurementDepsV1 {
  // ONE reader per pass, for the reason the sweep has one: it carries what it
  // learned about the endpoint's rate limit from token to token.
  const controlReader = createB20ReaderV1({ rpcUrl: input.rpcUrl, timeoutMs: 15_000, maxRetries: input.maxRetries });
  const aerodromeReader = createAerodromeReaderV1({ rpcUrl: input.rpcUrl, timeoutMs: 15_000, maxRetries: input.maxRetries });

  // --- the venue B20 tokens are actually on ---------------------------------
  //
  // Measured on mainnet: of the twelve most recent canonical launches, twelve
  // have a Uniswap v4 pool and none are on Aerodrome. Asking Aerodrome alone
  // is why 23,903 of 24,306 daily observations came back `no_entry_route` — a
  // true statement about the wrong venue.
  //
  // v4 is tried FIRST and Aerodrome remains the fallback. Removing a venue to
  // add one would trade a known blind spot for an unknown one.
  const v4Logs = async (query: {
    address: string;
    fromBlock: number;
    toBlock: number;
    topics: (string | null)[];
  }) => {
    const response = await fetch(input.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getLogs',
        params: [{
          address: query.address,
          fromBlock: `0x${query.fromBlock.toString(16)}`,
          toBlock: `0x${query.toBlock.toString(16)}`,
          topics: query.topics,
        }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    // An endpoint that refuses the range must not read as "no pool here", so
    // this THROWS rather than returning an empty list. The free plan caps
    // `eth_getLogs` at ten blocks and rate-limits on top of that, which makes
    // a refusal ordinary — and an ordinary refusal silently shaped like "no
    // pool" would quietly restate the exact false negative this venue was
    // added to fix. The resolver turns the throw into `endpoint_unavailable`.
    if (body.error || !Array.isArray(body.result)) throw new Error('eth_getLogs unavailable');
    return body.result as { address?: string; topics?: string[]; data?: string; blockNumber?: string }[];
  };
  // One lookup per token per pass. The pool cannot change, and the endpoint
  // meters `eth_getLogs`.
  const v4Pools = createB20PoolCacheV1(v4Logs);
  // Quotes reuse the control reader's transport: it already paces itself
  // against this endpoint's limit and retries only what is worth retrying.
  const v4Call = async (request: { to: string; data: string }) => {
    const result = await controlReader.call({ to: request.to, data: request.data, blockTag: 'latest' });
    if (result.ok) return result.value;
    // `reverted` and `empty_result` ARE the pool's answer — the Quoter reverts
    // to return, and a swap it will not price comes back empty. Everything
    // else is our side failing: a throttled read must never be published as
    // "this token cannot be sold".
    if (result.reason === 'reverted' || result.reason === 'empty_result') return '';
    throw new V4QuoteUnavailableError();
  };

  const deps: MeasurementDepsV1 = {
    // Aerodrome's `getAmountsOut` takes no block tag, so router quotes are read
    // at `latest` while the factory and control reads are pinned. Named rather
    // than hidden: presenting the two as one atomic snapshot would be a claim
    // nothing measured.
    quoteAlignment: 'latest_not_anchored',

    async readAnchor(): Promise<ObservationAnchorV1 | null> {
      const anchor = await controlReader.readBlockAnchor();
      // No anchor, no observation. A measurement of no particular moment is
      // not a measurement.
      if (!anchor.ok) return null;
      return {
        blockNumber: anchor.value.blockNumber,
        blockHash: anchor.value.blockHash,
        blockTag: anchor.value.blockTag,
      };
    },

    async readFactoryStatus({ tokenAddress, anchor }) {
      const isB20 = await controlReader.readIsB20(tokenAddress, anchor.blockTag);
      // Null, never false: "the factory said no" and "nobody answered" are
      // different facts and only one of them is about the token.
      if (!isB20.ok) return { isB20: null, initialized: null };
      if (!isB20.value) return { isB20: false, initialized: null };
      const initialized = await controlReader.readIsB20Initialized(tokenAddress, anchor.blockTag);
      return { isB20: true, initialized: initialized.ok ? initialized.value : null };
    },

    async analyseRoutes({ tokenAddress, launchBlock, profile }) {
      const lookup = Number.isSafeInteger(launchBlock) && launchBlock > 0
        ? await v4Pools.lookup(tokenAddress, launchBlock)
        : ({ ok: false, refusal: 'no_pool_initialized' } as const);
      // The endpoint not answering is not evidence about the token. Carried
      // into the fallback so the observation lands on `route_search_degraded`
      // instead of asserting `no_entry_route` on the strength of a venue we
      // never got to ask.
      let v4Unreadable = !lookup.ok && lookup.refusal === 'endpoint_unavailable';
      if (lookup.ok) {
        const pool = lookup.pool;
        const trip = await b20RoundTripV4V1({
          pool,
          positionAtomic: profile.positionAtomic,
          call: v4Call,
        });
        if (trip.entryRouteFound) {
          const source = `uniswap-v4:${pool.poolId}`;
          // The capacity ladder, and only where there is something to climb:
          // a token whose sale reverts at the full position has no capacity
          // boundary to find, and probing one would spend four metered calls
          // to rediscover that.
          //
          // The full-size rung is handed in rather than re-quoted — the round
          // trip just paid for exactly that call.
          const ladder = trip.exitRouteFound && trip.entryOutputAtomic
            ? await b20QuoteExitSizesV4V1({
                pool,
                sizes: exitProbeLadderV1(trip.entryOutputAtomic, EXIT_PROBE_RUNGS_V1),
                known: {
                  sizeAtomic: trip.entryOutputAtomic,
                  outputAtomic: trip.exitReturnAtomic,
                },
                call: v4Call,
              })
            : { quotes: [], quotesUsed: 0, endpointDegraded: false };
          // Impact is measured against the smallest rung that priced, by the
          // same pure function Aerodrome's ladder uses. One venue-independent
          // definition of price impact, or the two rails would disagree about
          // what a number on the same card means.
          const probes = ladder.quotes.length > 0
            ? priceImpactLadderV1(ladder.quotes).probes
            : [];
          return {
            entryRouteFound: true,
            exitRouteFound: trip.exitRouteFound,
            // A reverting sell is an ANSWER about the token, not a failing
            // endpoint. Calling it degraded would file the single most
            // important fact this rail measures under "we could not read".
            //
            // An unanswered quote is the mirror image and gets the mirror
            // treatment: the round trip reports which one happened, and only
            // that case is degraded.
            degraded: trip.endpointDegraded || ladder.endpointDegraded,
            candidatesTotal: 1,
            candidatesAnswered: 1,
            entryOutputAtomic: trip.entryOutputAtomic,
            exitReturnAtomic: trip.exitReturnAtomic,
            entryRouteHash: null,
            exitRouteHash: null,
            entrySourceKey: source,
            exitSourceKey: trip.exitRouteFound ? source : null,
            probes,
            routerCalls: trip.quotesUsed + ladder.quotesUsed,
          };
        }
        // No entry on v4 — fall through to Aerodrome, but remember whether the
        // pool declined to price the buy or simply never answered.
        v4Unreadable = v4Unreadable || trip.endpointDegraded;
      }
      const analysis = await analyseExitV1({
        reader: aerodromeReader,
        tokenAddress: tokenAddress as `0x${string}`,
        quoteAsset: profile.quoteAsset as `0x${string}`,
        profile: {
          positionAtomic: profile.positionAtomic,
          maxRoundTripBps: profile.maxRoundTripBps,
          maxSlippageBps: profile.maxExitSlippageBps,
        },
        // The economics only. Controls are read separately and AFTER this, so
        // an open set here is not an assumption — it keeps `analyseExitV1` from
        // short-circuiting before the numbers this feed needs are measured.
        controls: {
          factoryConfirmed: true,
          transfersPaused: false,
          transferPolicyActive: false,
          controlsFullyRead: true,
        },
      });
      return {
        entryRouteFound: analysis.entryRouteFound,
        exitRouteFound: analysis.exitRouteFound,
        degraded: analysis.endpointDegraded || v4Unreadable,
        candidatesTotal: analysis.candidatesTotal,
        candidatesAnswered: analysis.candidatesAnswered,
        entryOutputAtomic: analysis.roundTrip?.entry.outputAtomic ?? null,
        exitReturnAtomic: analysis.roundTrip?.exit.outputAtomic ?? null,
        entryRouteHash: null,
        exitRouteHash: null,
        entrySourceKey: analysis.entryRoute ? aerodromeRouteKeyV1(analysis.entryRoute) : null,
        exitSourceKey: analysis.exitRoute ? aerodromeRouteKeyV1(analysis.exitRoute) : null,
        probes: analysis.probes,
        routerCalls: analysis.quotesUsed,
      };
    },

    async readControls({ tokenAddress, anchor }) {
      const result = await inspectB20TokenV1(
        { reader: controlReader },
        {
          tenantId: 'feed',
          chainId: 8453,
          tokenAddress,
          now: new Date(),
          // The SAME block as the factory read, so every anchored fact in this
          // observation describes one moment.
          anchor: {
            blockNumber: anchor.blockNumber,
            blockHash: anchor.blockHash as `0x${string}`,
            blockTag: anchor.blockTag,
          },
        },
      );
      const snapshot = result.snapshot;
      const exit = exitControlsFromSnapshotV1(snapshot);
      const controls: B20ObservationControlsV1 = {
        factoryConfirmed: exit.factoryConfirmed,
        initialized: snapshot.detection.outcome === 'b20',
        transfersPaused: exit.transfersPaused,
        transferPolicyState: transferPolicyStateV1(snapshot),
        controlsComplete: exit.controlsFullyRead,
      };
      return {
        controls,
        snapshotHash: hashB20SnapshotV1(snapshot),
        blockNumber: snapshot.blockNumber,
        // The control card is a fixed set of paced reads; counting it as one
        // unit per token is what the budget bounds.
        controlCalls: snapshot.fields.length,
      };
    },
  };

  return deps;
}
