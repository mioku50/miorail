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
}

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
  let nextId = 1;

  async function rpc(method: string, params: unknown[]): Promise<B20RpcResultV1<unknown>> {
    if (config.rpcUrl.trim().length === 0) return { ok: false, reason: 'not_configured' };
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
    if (response.status === 429) return { ok: false, reason: 'rate_limited' };
    if (!response.ok) return { ok: false, reason: 'rpc_unavailable', detail: `status ${response.status}` };

    let envelope: JsonRpcEnvelope;
    try {
      envelope = (await response.json()) as JsonRpcEnvelope;
    } catch {
      return { ok: false, reason: 'invalid_response' };
    }
    if (envelope.error) {
      const message = envelope.error.message ?? '';
      return {
        ok: false,
        reason: classifyRpcErrorV1(envelope.error.code, message),
        detail: redactRpcTextV1(message),
        revertSelector: revertSelectorV1(typeof envelope.error.data === 'string' ? envelope.error.data : null),
      };
    }
    return { ok: true, value: envelope.result, raw: '' };
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
