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
  /** Why the values are absent, when they are. */
  reason: 'ok' | 'rpc_unreachable' | 'rpc_invalid_response' | 'not_configured';
}

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
let inflight: Promise<SampleV1 | null> | null = null;

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
async function rpcBatchV1(url: string, now: number): Promise<SampleV1 | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
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
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) return null;
    const byId = new Map<number, unknown>();
    for (const entry of payload) {
      if (entry && typeof entry === 'object' && 'id' in entry) {
        byId.set(Number((entry as { id: unknown }).id), (entry as { result?: unknown }).result);
      }
    }
    const block = byId.get(1);
    const gas = byId.get(2);
    if (typeof block !== 'string' || typeof gas !== 'string') return null;
    return {
      at: now,
      blockNumber: BigInt(block).toString(),
      gasPriceWei: BigInt(gas).toString(),
    };
  } catch {
    return null;
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

  const sample = await inflight;
  if (!sample) {
    logger.warn('Chain conditions unavailable', { reason: 'rpc_unreachable' });
    // The previous reading is NOT served as current. A block number from two
    // minutes ago presented without qualification is worse than a dash.
    return emptyV1('rpc_unreachable');
  }
  cached = { value: sample, expiresAt: sample.at + SAMPLE_TTL_MS };
  recordSampleV1(sample);
  return presentV1(sample);
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
