import {
  createB20ReaderV1,
  exitControlsFromSnapshotV1,
  hashB20SnapshotV1,
  inspectB20TokenV1,
} from '@mioagent/b20-control';
import {
  b20RoundTripV4V1,
  createAerodromeReaderV1,
  createB20PoolCacheV1,
} from '@mioagent/swap-adapters';
import type { B20ObservationControlsV1 } from '@mioagent/opportunity-rail';

import { aerodromeRouteKeyV1, analyseExitV1 } from '../artifacts/api-server/lib/exitAnalysis.js';
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
    // An endpoint that refuses the range must not read as "no pool here".
    if (body.error || !Array.isArray(body.result)) return [];
    return body.result as { address?: string; topics?: string[]; data?: string; blockNumber?: string }[];
  };
  // One lookup per token per pass. The pool cannot change, and the endpoint
  // meters `eth_getLogs`.
  const v4Pools = createB20PoolCacheV1(v4Logs);
  // Quotes reuse the control reader's transport: it already paces itself
  // against this endpoint's limit and retries only what is worth retrying.
  const v4Call = async (request: { to: string; data: string }) => {
    const result = await controlReader.call({ to: request.to, data: request.data, blockTag: 'latest' });
    return result.ok ? result.value : '';
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
      const pool = Number.isSafeInteger(launchBlock) && launchBlock > 0
        ? await v4Pools.lookup(tokenAddress, launchBlock)
        : null;
      if (pool) {
        const trip = await b20RoundTripV4V1({
          pool,
          positionAtomic: profile.positionAtomic,
          call: v4Call,
        });
        if (trip.entryRouteFound) {
          const source = `uniswap-v4:${pool.poolId}`;
          return {
            entryRouteFound: true,
            exitRouteFound: trip.exitRouteFound,
            // A reverting sell is an ANSWER about the token, not a failing
            // endpoint. Calling it degraded would file the single most
            // important fact this rail measures under "we could not read".
            degraded: false,
            candidatesTotal: 1,
            candidatesAnswered: 1,
            entryOutputAtomic: trip.entryOutputAtomic,
            exitReturnAtomic: trip.exitReturnAtomic,
            entryRouteHash: null,
            exitRouteHash: null,
            entrySourceKey: source,
            exitSourceKey: trip.exitRouteFound ? source : null,
            // No ladder yet: this pass answers whether a round trip exists at
            // the position at all. An invented probe would be a capacity
            // number nobody measured.
            probes: [],
            routerCalls: trip.quotesUsed,
          };
        }
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
        degraded: analysis.endpointDegraded,
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
