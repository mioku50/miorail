import { logger } from '@mioagent/utils';

// ---------------------------------------------------------------------------
// Chain conditions: the current block and gas price on the configured chain.
//
// The console header, the footer and the gas sparkline were hardcoded `null`
// and `[]`. That was honest — nothing supplied them — but it meant "Block —"
// read identically whether the chain was unreachable or nobody had ever wired
// the field. This closes the gap on the second reading.
//
// Three rules it keeps:
//
//   * An unreadable value is `null`, never a stale one and never a zero. A dash
//     in the header means "not known right now", which is a state the UI
//     already renders honestly.
//   * The sample history is MEASURED, not interpolated. Points are appended
//     only when an RPC read actually succeeded, each with the instant it was
//     observed, so a gap in the chart is a real gap.
//   * It never throws. Status is what an operator opens when something is
//     already wrong; a status endpoint that fails because a gas read failed is
//     the least useful possible behaviour.
// ---------------------------------------------------------------------------

export interface ChainConditionsV1 {
  /** Decimal string. Block numbers exceed Number.MAX_SAFE_INTEGER's comfort
   * zone in principle and are ids rather than quantities, so they stay text. */
  blockNumber: string | null;
  /** Gas price in wei, decimal string. */
  gasPriceWei: string | null;
  /** Rounded to 3 decimals for display. Null whenever gasPriceWei is null. */
  gasPriceGwei: string | null;
  /** When the successful read happened. Null when nothing was read. */
  observedAt: string | null;
  /** Measured gas samples, oldest first, for the sparkline. */
  gasPoints: Array<{ at: string; gwei: string }>;
  /** Why the values are absent, when they are.
   *
   * Four different things used to arrive as `rpc_unreachable`: a throttled
   * request, a server-side error, a request that ran out of time, and an
   * endpoint that never answered. They are four different operator actions,
   * and on 2026-08-26 the console showed a dash while the endpoint was in
   * fact answering every probe in ~120ms — the reason had to be readable to
   * tell throttling apart from an outage. */
  reason:
    | 'ok'
    | 'rpc_rate_limited'
    | 'rpc_http_error'
    | 'rpc_timeout'
    | 'rpc_unreachable'
    | 'rpc_invalid_response'
    | 'not_configured';
}

/** Why one read did not produce a sample. Separate from the public reason so
 * a caller cannot accidentally report `ok` for a failed read. */
type ReadFailureV1 = Exclude<ChainConditionsV1['reason'], 'ok' | 'not_configured'>;

const SAMPLE_TTL_MS = 12_000;
const HISTORY_WINDOW_MS = 60 * 60 * 1000;
/** One point roughly every 30s over an hour, capped so an idle server cannot
 * grow this without bound. */
const HISTORY_MAX_POINTS = 120;
const HISTORY_MIN_GAP_MS = 30_000;
const RPC_TIMEOUT_MS = 2_500;

interface SampleV1 {
  at: number;
  blockNumber: string;
  gasPriceWei: string;
}

const history: Array<{ at: number; gwei: string }> = [];
let cached: { value: SampleV1; expiresAt: number } | null = null;
let inflight: Promise<{ ok: true; sample: SampleV1 } | { ok: false; reason: ReadFailureV1 }> | null =
  null;

/** Exported for tests: module-level caches make a suite order-dependent. */
export function resetChainConditionsForTests(): void {
  history.length = 0;
  cached = null;
  inflight = null;
}

function weiToGwei(wei: string): string {
  // Integer arithmetic. A float here would render 0.001 gwei differences as
  // noise, and gas on Base routinely sits in that range.
  const value = BigInt(wei);
  const whole = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n) / 1_000_000n; // three decimals
  return `${whole}.${fraction.toString().padStart(3, '0')}`;
}

/** `now` is threaded in rather than read from the clock inside: the cache
 * window and the history thinning both compare against it, and mixing an
 * injected clock with `Date.now()` made those two disagree. */
async function rpcBatchV1(
  url: string,
  now: number,
): Promise<{ ok: true; sample: SampleV1 } | { ok: false; reason: ReadFailureV1 }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RPC_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_gasPrice', params: [] },
      ]),
      signal: controller.signal,
    });
    // A 429 is the endpoint declining to serve us this second; a 5xx is the
    // endpoint failing. Neither is "did not answer", and an operator reading
    // the first as the second goes looking for an outage that isn't there.
    if (response.status === 429) return { ok: false, reason: 'rpc_rate_limited' };
    if (!response.ok) return { ok: false, reason: 'rpc_http_error' };
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) return { ok: false, reason: 'rpc_invalid_response' };
    const byId = new Map<number, unknown>();
    let rateLimited = false;
    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') continue;
      if ('id' in entry) {
        byId.set(Number((entry as { id: unknown }).id), (entry as { result?: unknown }).result);
      }
      // Some providers answer 200 and put the throttle inside the envelope,
      // per-call. Reading that as an unreadable response would blame the shape.
      const error = (entry as { error?: { message?: unknown } }).error;
      if (error && /rate limit|too many requests/i.test(String(error.message ?? ''))) {
        rateLimited = true;
      }
    }
    const block = byId.get(1);
    const gas = byId.get(2);
    if (typeof block !== 'string' || typeof gas !== 'string') {
      return { ok: false, reason: rateLimited ? 'rpc_rate_limited' : 'rpc_invalid_response' };
    }
    return {
      ok: true,
      sample: {
        at: now,
        blockNumber: BigInt(block).toString(),
        gasPriceWei: BigInt(gas).toString(),
      },
    };
  } catch {
    // The abort we scheduled ourselves is a timeout. Anything else never
    // reached a server we can describe.
    return { ok: false, reason: timedOut ? 'rpc_timeout' : 'rpc_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

function recordSampleV1(sample: SampleV1): void {
  const last = history[history.length - 1];
  // Thinned deliberately: the status endpoint may be polled every few seconds,
  // and a chart of 600 near-identical points is not more information.
  if (last && sample.at - last.at < HISTORY_MIN_GAP_MS) return;
  history.push({ at: sample.at, gwei: weiToGwei(sample.gasPriceWei) });
  const floor = sample.at - HISTORY_WINDOW_MS;
  while (history.length > 0 && history[0]!.at < floor) history.shift();
  while (history.length > HISTORY_MAX_POINTS) history.shift();
}

function emptyV1(reason: ChainConditionsV1['reason']): ChainConditionsV1 {
  return {
    blockNumber: null,
    gasPriceWei: null,
    gasPriceGwei: null,
    observedAt: null,
    gasPoints: history.map((point) => ({ at: new Date(point.at).toISOString(), gwei: point.gwei })),
    reason,
  };
}

export async function readChainConditionsV1(
  rpcUrl: string | undefined,
  now: number = Date.now(),
): Promise<ChainConditionsV1> {
  if (!rpcUrl) return emptyV1('not_configured');

  if (cached && cached.expiresAt > now) {
    return presentV1(cached.value);
  }
  // Single-flight: a burst of status requests must not become a burst of RPC
  // calls against a metered endpoint.
  inflight ||= rpcBatchV1(rpcUrl, now).finally(() => {
    inflight = null;
  });

  const read = await inflight;
  if (!read.ok) {
    logger.warn('Chain conditions unavailable', { reason: read.reason });
    // The previous reading is NOT served as current. A block number from two
    // minutes ago presented without qualification is worse than a dash.
    return emptyV1(read.reason);
  }
  cached = { value: read.sample, expiresAt: read.sample.at + SAMPLE_TTL_MS };
  recordSampleV1(read.sample);
  return presentV1(read.sample);
}

function presentV1(sample: SampleV1): ChainConditionsV1 {
  return {
    blockNumber: sample.blockNumber,
    gasPriceWei: sample.gasPriceWei,
    gasPriceGwei: weiToGwei(sample.gasPriceWei),
    observedAt: new Date(sample.at).toISOString(),
    gasPoints: history.map((point) => ({ at: new Date(point.at).toISOString(), gwei: point.gwei })),
    reason: 'ok',
  };
}
