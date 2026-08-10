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
  b20MeasurementQuoteAssetV1,
  OPPORTUNITY_QUOTE_ASSET_V1,
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
import type { B20QuoteAlignmentV1 } from '@mioagent/opportunity-rail';

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
// for B20 controls and the v4 Quoter, and `getAmountsOut` for Aerodrome. No signer, no key, no
// allowance write, no state override, no probe balance. Both endpoints are
// handed to their readers and never appear in an observation, a summary or an
// error.
// ---------------------------------------------------------------------------

export interface B20MeasureDepsInputV1 {
  rpcUrl: string;
  maxRetries: number;
  /** The position to spend in pools quoted against NATIVE ETH, in wei.
   *
   * Every B20 v4 pool sampled is ETH-quoted, and the profile's position is
   * denominated in USDC. Spending that number of wei prices a trade worth
   * roughly nothing, so this is a separate, explicitly ETH-denominated size.
   * It is not converted from dollars and must never be labelled as dollars:
   * no price feed is read here, and a converted figure would be a claim about
   * the ETH price at measurement time that nothing recorded. */
  nativePositionAtomic: string;
}

/** 0.03 ETH. Big enough to move a launch pool's price and see the curve, small
 * enough to be a position someone might actually take. */
export const B20_NATIVE_POSITION_ATOMIC_V1 = '30000000000000000';

/** Native ETH, as Uniswap v4 addresses it. */
const NATIVE_ASSET_V1 = '0x0000000000000000000000000000000000000000';

/** One `eth_call`, as the B20 reader reports it. */
export type QuoteCallResultV1 =
  | { ok: true; value: string }
  | { ok: false; reason: string };

export interface V4QuoteContextV1 {
  /** The quote function the v4 adapters take. */
  call: (request: { to: string; data: string }) => Promise<string>;
  /** Where the quotes in this measurement were actually read. */
  alignment: () => B20QuoteAlignmentV1;
  /** Why the last quote could not be taken, if one could not. Diagnostic: the
   * observation records `route_search_degraded`, which names the symptom and
   * not the call. */
  lastFailureReason: () => string | null;
}

// ---------------------------------------------------------------------------
// Quotes, pinned to the observation block.
//
// Every quote used to be read at `latest` while the factory and control reads
// were pinned, and every observation carried `latest_not_anchored` to say so.
// The reason given was Aerodrome's reader, which takes no block tag — but the
// measurement moved to Uniswap v4, whose Quoter is an ordinary `eth_call`. The
// caveat outlived its cause and sat on 50,937 observations in a single day,
// describing mixed-block data that no longer had to be mixed.
//
// So the v4 path anchors. What it must never do is anchor SOMETIMES and still
// claim to: a full node keeps roughly a hundred and twenty-eight blocks of
// state, and a slow, rate-limited pass can outlive that window mid-token. When
// the anchored block stops answering, this falls back to `latest` — and the
// measurement then reports `latest_not_anchored`, which is the same data the
// rail published before, correctly labelled.
//
// The fallback is one-way. Once a measurement has read anything at `latest`,
// its numbers no longer describe a single moment, and a later call that
// happens to anchor again does not undo that.
// ---------------------------------------------------------------------------
export function createV4QuoteContextV1(
  call: (input: { to: string; data: string; blockTag: string }) => Promise<QuoteCallResultV1>,
  blockTag: string,
): V4QuoteContextV1 {
  let alignment: B20QuoteAlignmentV1 = 'anchored';

  // `reverted` and `empty_result` ARE the pool's answer — the Quoter reverts to
  // return, and a swap it will not price comes back empty. Everything else is
  // our side failing: a throttled read must never be published as "this token
  // cannot be sold".
  const poolAnswered = (reason: string) => reason === 'reverted' || reason === 'empty_result';

  /**
   * Whether a failure is plausibly about the BLOCK rather than the endpoint.
   *
   * This distinction is the whole fallback, and getting it wrong is expensive
   * in the quiet direction. The first version treated every non-answer as a
   * reason to retry at `latest`, which meant an ordinary rate-limit — the most
   * common failure on this endpoint — silently converted an anchored
   * measurement into an unanchored one. Production showed it immediately: 87
   * of 92 v4 observations fell back, none of them because the block was gone.
   *
   * `rpc_error` is the classifier's catch-all and is where "missing trie node"
   * and "header not found" land. Throttling, timeouts and transport failures
   * are OUR problem: they degrade the measurement, exactly as they did before
   * anchoring existed, rather than quietly changing what it describes.
   */
  const blockMayBeGone = (reason: string) => reason === 'rpc_error';

  // Every throw below used to discard the reason, which is why three
  // consecutive production fixes were aimed at guesses. `route_search_degraded`
  // says only that coverage was incomplete — it never names the call that
  // failed. Recording the reason here is the difference between "the endpoint
  // is throttling us" and "the endpoint no longer holds that block", and those
  // want opposite fixes.
  let lastFailureReason: string | null = null;
  const unavailable = (reason: string, at: 'anchor' | 'latest'): V4QuoteUnavailableError => {
    lastFailureReason = reason;
    // Off unless an operator asks. A worker that prints a line per failed quote
    // is unreadable at four measurements a minute, and unusable at thirty-five.
    if (process.env.B20_DEBUG_RPC === '1') {
      // The reason is a fixed category from the reader's classifier, never an
      // echo of the endpoint — a URL with a key in it must not reach a log.
      console.log(JSON.stringify({ event: 'b20_quote_unavailable', reason, at }));
    }
    return new V4QuoteUnavailableError();
  };

  const quote = async (request: { to: string; data: string }): Promise<string> => {
    if (alignment === 'anchored') {
      const anchored = await call({ ...request, blockTag });
      if (anchored.ok) return anchored.value;
      // A revert at the anchor is a measurement AT the anchor. Still aligned.
      if (poolAnswered(anchored.reason)) return '';
      if (!blockMayBeGone(anchored.reason)) throw unavailable(anchored.reason, 'anchor');
      // The node may no longer hold state for this block. One retry at
      // `latest` says which — and if it answers, this observation is no longer
      // one atomic moment and stops claiming to be.
      const latest = await call({ ...request, blockTag: 'latest' });
      alignment = 'latest_not_anchored';
      if (latest.ok) return latest.value;
      if (poolAnswered(latest.reason)) return '';
      throw unavailable(latest.reason, 'latest');
    }
    const result = await call({ ...request, blockTag: 'latest' });
    if (result.ok) return result.value;
    if (poolAnswered(result.reason)) return '';
    throw unavailable(result.reason, 'latest');
  };

  return { call: quote, alignment: () => alignment, lastFailureReason: () => lastFailureReason };
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
    // Every other reader in this pass survives a throttle — `createB20ReaderV1`
    // carries what it learned about the endpoint's limit from token to token.
    // This one was a bare fetch, so a single 429 became `route_search_degraded`
    // on a token that was perfectly measurable. On a metered plan that was
    // rare; the moment the workers moved to a free endpoint, where the limit is
    // requests per second rather than units per month, it became 12% of every
    // pass. A throttle is the endpoint asking us to wait, so we wait.
    let lastError: unknown = new Error('eth_getLogs unavailable');
    for (let attempt = 0; attempt <= Math.max(0, input.maxRetries); attempt += 1) {
      if (attempt > 0) {
        // Doubling from 250ms. The free endpoints that answer archival logs
        // throttle near 13 requests a second, and one pass asks for far fewer
        // than that — so a 429 here is a burst, and a burst is over quickly.
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      }
      let response: Response;
      try {
        response = await fetch(input.rpcUrl, {
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
      } catch (error) {
        // A timeout or a dropped connection. Never the URL in the message —
        // it carries a key on the plans that use one.
        lastError = new Error('eth_getLogs unreachable');
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`eth_getLogs throttled (${response.status})`);
        continue;
      }
      const body = (await response.json().catch(() => ({}))) as { result?: unknown; error?: unknown };
      if (body.error || !Array.isArray(body.result)) {
        lastError = new Error('eth_getLogs unavailable');
        continue;
      }
      return body.result as { address?: string; topics?: string[]; data?: string; blockNumber?: string }[];
    }
    // An endpoint that refuses the range must not read as "no pool here", so
    // this THROWS rather than returning an empty list. The free plan caps
    // `eth_getLogs` at ten blocks and rate-limits on top of that, which makes
    // a refusal ordinary — and an ordinary refusal silently shaped like "no
    // pool" would quietly restate the exact false negative this venue was
    // added to fix. The resolver turns the throw into `endpoint_unavailable`.
    throw lastError;
  };
  // One lookup per token per pass. The pool cannot change, and the endpoint
  // meters `eth_getLogs`.
  const v4Pools = createB20PoolCacheV1(v4Logs);

  const deps: MeasurementDepsV1 = {
    // Only for an observation where the factory settled the token and no quote
    // was ever taken. Every measurement that does quote reports its own
    // alignment, decided by what the endpoint actually answered.
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

    async analyseRoutes({ tokenAddress, launchBlock, profile, anchor }) {
      const quotes = createV4QuoteContextV1(controlReader.call, anchor.blockTag);
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
        // The pool decides the currency; the profile only decides the size in
        // ITS currency. Matching them is not optional — a USDC position spent
        // as wei is a different trade, and one nobody asked to have measured.
        const positionAtomic = pool.quoteAsset === NATIVE_ASSET_V1
          ? input.nativePositionAtomic
          : profile.positionAtomic;
        // A pair the rail cannot name is a pair it cannot compare. The pool
        // resolver already refuses anything but ETH and USDC, so this is the
        // type system being told what the venue guarantees — and a fallback to
        // Aerodrome if that ever stops being true.
        const measuredAsset = b20MeasurementQuoteAssetV1(pool.quoteAsset);
        if (measuredAsset) {
        const trip = await b20RoundTripV4V1({
          pool,
          positionAtomic,
          call: quotes.call,
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
                call: quotes.call,
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
            // Already decoded from the pool's own Initialize log, and until now
            // discarded. The v4 pool id in `source` commits to it — a pool id
            // is the keccak of the PoolKey — but nothing could READ it back out
            // of a hash, so the address is carried alongside for display.
            poolHookAddress: pool.key.hooks,
            probes,
            routerCalls: trip.quotesUsed + ladder.quotesUsed,
            quoteAssetUsed: measuredAsset,
            positionAtomicUsed: positionAtomic,
            quoteAlignment: quotes.alignment(),
          };
        }
        // No entry on v4 — fall through to Aerodrome, but remember whether the
        // pool declined to price the buy or simply never answered.
        v4Unreadable = v4Unreadable || trip.endpointDegraded;
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
        degraded: analysis.endpointDegraded || v4Unreadable,
        candidatesTotal: analysis.candidatesTotal,
        candidatesAnswered: analysis.candidatesAnswered,
        entryOutputAtomic: analysis.roundTrip?.entry.outputAtomic ?? null,
        exitReturnAtomic: analysis.roundTrip?.exit.outputAtomic ?? null,
        entryRouteHash: null,
        exitRouteHash: null,
        entrySourceKey: analysis.entryRoute ? aerodromeRouteKeyV1(analysis.entryRoute) : null,
        exitSourceKey: analysis.exitRoute ? aerodromeRouteKeyV1(analysis.exitRoute) : null,
        // Aerodrome pools have no hooks. Null is the honest value, not zero —
        // the zero address is how v4 spells "a v4 pool with no hook", which is
        // a different statement about a different venue.
        poolHookAddress: null,
        probes: analysis.probes,
        routerCalls: analysis.quotesUsed,
        // Aerodrome was asked in the profile's own asset, so here the two agree.
        quoteAssetUsed: OPPORTUNITY_QUOTE_ASSET_V1,
        positionAtomicUsed: profile.positionAtomic,
        // The Aerodrome reader takes no block tag, so a measurement that fell
        // through to it is genuinely mixed-block. This is the case the caveat
        // was written for, and the only one that should still carry it.
        quoteAlignment: 'latest_not_anchored',
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
