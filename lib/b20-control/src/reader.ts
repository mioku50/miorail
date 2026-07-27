import { stableHashV1, type HashV1 } from '@mioagent/route-domain';
import {
  B20_ACTIVATION_REGISTRY_V1,
  B20_CHAIN_ID_V1,
  B20_FACTORY_V1,
  B20_FEATURE_KEYS_V1,
  B20_SELECTORS_V1,
  decodeBoolV1,
  encodeAddressArgV1,
  encodeWordArgV1,
  revertSelectorV1,
} from './pinned.js';

// ---------------------------------------------------------------------------
// T67C — the Base RPC seam.
//
// Read-only. This file encodes `eth_call` and `eth_getBlockByNumber` and
// nothing else: there is no signer, no `eth_sendRawTransaction`, and no
// method that could move an asset. That is a property of the code, not a
// promise in a comment.
//
// The endpoint is injected rather than read here, so unit tests never open a
// socket and so this module cannot become a second place an RPC URL is
// configured.
//
// Every failure is classified. "The chain said no" and "nobody answered" are
// different outcomes all the way up: an outage must never render as a verdict
// about a token.
// ---------------------------------------------------------------------------

export type B20RpcReasonV1 =
  | 'not_configured'
  | 'rpc_unavailable'
  | 'rpc_timeout'
  | 'rpc_error'
  | 'rate_limited'
  | 'invalid_response'
  | 'reverted'
  | 'empty_result';

export type B20RpcResultV1<T> =
  | { ok: true; value: T; raw: string }
  | { ok: false; reason: B20RpcReasonV1; detail?: string; revertSelector?: string | null };

export interface B20ReaderConfigV1 {
  rpcUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** How many times a THROTTLED read is repeated before it is reported as
   * unavailable. See `RETRYABLE_REASONS_V1` for why this is sound. */
  maxRetries?: number;
  /** Injected so tests do not spend real time. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * The only reasons worth repeating.
 *
 * A throttle is a fact about the endpoint, not an answer about the token, and
 * one card costs ~17 calls — enough for a public endpoint to start refusing
 * midway and leave half the rows blank. Repeating is safe here for a specific
 * reason: every read after the anchor is pinned to a fixed block tag, so a
 * repeat re-asks the same question about the same block and cannot produce a
 * snapshot that straddles two of them.
 *
 * `reverted` and `empty_result` are deliberately absent. Those ARE answers —
 * repeating them would only turn a determinate result into a slower one.
 */
export const RETRYABLE_REASONS_V1: readonly B20RpcReasonV1[] = ['rate_limited', 'rpc_timeout'];

export interface B20BlockAnchorV1 {
  blockNumber: string;
  blockHash: HashV1;
  /** The tag every subsequent read is pinned to, e.g. `0x2ee894e`. */
  blockTag: string;
}

export interface B20ReaderV1 {
  /** The block every field of one snapshot is read at. Taken FIRST, so a
   * snapshot cannot straddle two blocks. */
  readBlockAnchor(): Promise<B20RpcResultV1<B20BlockAnchorV1>>;
  /** `B20Factory.isB20`. The only accepted detection method. */
  readIsB20(token: string, blockTag: string): Promise<B20RpcResultV1<boolean>>;
  readIsB20Initialized(token: string, blockTag: string): Promise<B20RpcResultV1<boolean>>;
  /** `ActivationRegistry.isActivated` for one variant. */
  readVariantActivated(variant: 'asset' | 'stablecoin', blockTag: string): Promise<B20RpcResultV1<boolean>>;
  /** A raw `eth_call` against an arbitrary pinned target. Decoding is the
   * caller's job, so this seam never guesses at a shape. */
  call(input: { to: string; data: string; blockTag: string }): Promise<B20RpcResultV1<string>>;
}

interface JsonRpcEnvelope {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/**
 * Strips anything credential-shaped from RPC text.
 *
 * Alchemy and most managed endpoints carry the key in the URL path, so a
 * verbatim provider message is a credential leak waiting for a log line.
 */
export function redactRpcTextV1(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, '<url>').slice(0, 300);
}

/** Hash of the raw response bytes. Stored instead of the bytes so evidence
 * stays bounded while the decode remains re-checkable. */
export function rawResponseHashV1(raw: string): HashV1 {
  return stableHashV1('b20-raw-response/v1', { raw: raw.toLowerCase() });
}

function classifyRpcErrorV1(code: number | undefined, message: string): B20RpcReasonV1 {
  if (code === -32016 || /rate limit|too many requests/i.test(message)) return 'rate_limited';
  if (/execution reverted|revert/i.test(message)) return 'reverted';
  return 'rpc_error';
}

export function createB20ReaderV1(config: B20ReaderConfigV1): B20ReaderV1 {
  const timeoutMs = config.timeoutMs ?? 8_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  const maxRetries = config.maxRetries ?? 3;
  const sleep = config.sleepImpl ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let nextId = 1;
  /** Seconds the endpoint asked us to wait, if it said so on the last 429. */
  let retryAfterMs: number | null = null;
  // Adaptive pacing. Retrying alone does not survive a public endpoint, whose
  // limit is a request COUNT PER WINDOW: repeating a refused call inside the
  // same window just spends another one of its allowance. So a throttle also
  // slows every subsequent call, and the gap decays once reads start landing
  // again. A keyed endpoint never trips this and pays nothing for it.
  let gapMs = 0;
  let lastRequestAt = 0;

  function noteThrottled(): void {
    gapMs = Math.min(gapMs === 0 ? 120 : gapMs * 2, 1_000);
  }
  function noteServed(): void {
    gapMs = gapMs <= 120 ? 0 : Math.floor(gapMs / 2);
  }

  async function rpcOnce(method: string, params: unknown[]): Promise<B20RpcResultV1<unknown>> {
    if (config.rpcUrl.trim().length === 0) return { ok: false, reason: 'not_configured' };
    const sinceLast = Date.now() - lastRequestAt;
    if (gapMs > 0 && sinceLast < gapMs) await sleep(gapMs - sinceLast);
    lastRequestAt = Date.now();
    let response: Response;
    try {
      response = await fetchImpl(config.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return name === 'TimeoutError' || name === 'AbortError'
        ? { ok: false, reason: 'rpc_timeout' }
        : { ok: false, reason: 'rpc_unavailable' };
    }
    if (response.status === 429) {
      // If the endpoint said how long to wait, wait that long — but only up to
      // a few seconds, so a hostile or broken header cannot stall a request.
      const header = Number(response.headers.get('retry-after'));
      retryAfterMs = Number.isFinite(header) && header > 0 && header <= 5 ? header * 1_000 : null;
      noteThrottled();
      return { ok: false, reason: 'rate_limited' };
    }
    if (!response.ok) return { ok: false, reason: 'rpc_unavailable', detail: `status ${response.status}` };

    let envelope: JsonRpcEnvelope;
    try {
      envelope = (await response.json()) as JsonRpcEnvelope;
    } catch {
      return { ok: false, reason: 'invalid_response' };
    }
    if (envelope.error) {
      const message = envelope.error.message ?? '';
      const reason = classifyRpcErrorV1(envelope.error.code, message);
      // A throttle can arrive as a 200 with a JSON-RPC error body, so pacing
      // has to be driven by the classified reason, not by the HTTP status.
      if (reason === 'rate_limited') noteThrottled();
      return {
        ok: false,
        reason,
        detail: redactRpcTextV1(message),
        revertSelector: revertSelectorV1(typeof envelope.error.data === 'string' ? envelope.error.data : null),
      };
    }
    noteServed();
    return { ok: true, value: envelope.result, raw: '' };
  }

  async function rpc(method: string, params: unknown[]): Promise<B20RpcResultV1<unknown>> {
    let result = await rpcOnce(method, params);
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      if (result.ok || !RETRYABLE_REASONS_V1.includes(result.reason)) return result;
      await sleep(retryAfterMs ?? 250 * 2 ** attempt);
      retryAfterMs = null;
      result = await rpcOnce(method, params);
    }
    return result;
  }

  async function ethCall(to: string, data: string, blockTag: string): Promise<B20RpcResultV1<string>> {
    const result = await rpc('eth_call', [{ to, data }, blockTag]);
    if (!result.ok) return result;
    if (typeof result.value !== 'string') return { ok: false, reason: 'invalid_response' };
    // `0x` is an ANSWER, and its meaning is "there was nothing here at this
    // block" — never `false`, never zero. See the research note: a B20 read
    // before activation returns exactly this.
    if (result.value === '0x') return { ok: false, reason: 'empty_result', detail: 'the call returned no data' };
    return { ok: true, value: result.value, raw: result.value };
  }

  function decodeBoolResult(result: B20RpcResultV1<string>): B20RpcResultV1<boolean> {
    if (!result.ok) return result;
    const decoded = decodeBoolV1(result.value);
    return decoded === null
      ? { ok: false, reason: 'invalid_response', detail: 'response is not a boolean word' }
      : { ok: true, value: decoded, raw: result.raw };
  }

  return {
    async readBlockAnchor() {
      const numberResult = await rpc('eth_blockNumber', []);
      if (!numberResult.ok) return numberResult;
      if (typeof numberResult.value !== 'string') return { ok: false, reason: 'invalid_response' };
      const blockTag = numberResult.value;
      let blockNumber: bigint;
      try {
        blockNumber = BigInt(blockTag);
      } catch {
        return { ok: false, reason: 'invalid_response' };
      }
      // The hash is fetched for the SAME numbered block, so a reorg between
      // the two calls shows up as a hash nobody can reproduce rather than as
      // a silently different state.
      const blockResult = await rpc('eth_getBlockByNumber', [blockTag, false]);
      if (!blockResult.ok) return blockResult;
      const block = blockResult.value as { hash?: unknown; number?: unknown } | null;
      const hash = block && typeof block.hash === 'string' ? block.hash.toLowerCase() : null;
      if (!hash || !/^0x[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'invalid_response' };
      if (!block || typeof block.number !== 'string' || BigInt(block.number) !== blockNumber) {
        return { ok: false, reason: 'invalid_response', detail: 'block number and header disagree' };
      }
      return {
        ok: true,
        value: { blockNumber: blockNumber.toString(), blockHash: hash as HashV1, blockTag },
        raw: hash,
      };
    },

    async readIsB20(token, blockTag) {
      return decodeBoolResult(
        await ethCall(B20_FACTORY_V1, encodeAddressArgV1(B20_SELECTORS_V1.isB20, token), blockTag),
      );
    },

    async readIsB20Initialized(token, blockTag) {
      return decodeBoolResult(
        await ethCall(B20_FACTORY_V1, encodeAddressArgV1(B20_SELECTORS_V1.isB20Initialized, token), blockTag),
      );
    },

    async readVariantActivated(variant, blockTag) {
      const key = variant === 'asset' ? B20_FEATURE_KEYS_V1.asset : B20_FEATURE_KEYS_V1.stablecoin;
      return decodeBoolResult(
        await ethCall(B20_ACTIVATION_REGISTRY_V1, encodeWordArgV1(B20_SELECTORS_V1.isActivated, key), blockTag),
      );
    },

    async call(input) {
      return ethCall(input.to, input.data, input.blockTag);
    },
  };
}

/** Base mainnet only. A different chain is refused before any socket opens. */
export function isSupportedB20ChainV1(chainId: number): chainId is typeof B20_CHAIN_ID_V1 {
  return chainId === B20_CHAIN_ID_V1;
}

export function isWellFormedAddressV1(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}
