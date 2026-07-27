import {
  AERODROME_ROUTER_V1,
  decodeAddressV1,
  decodeUint256V1,
  decodeUintArrayV1,
  encodeAllowanceV1,
  encodeDefaultFactoryV1,
  encodeGetAmountsOutV1,
  type AerodromeRouteLegV1,
} from './aerodrome-pinned.js';

// ---------------------------------------------------------------------------
// T67B — the Base RPC seam.
//
// Two `eth_call`s and one `eth_blockNumber`, all against the pinned Router.
// No partner API and no key: the only credential involved is whatever the
// deployment already uses to reach its own RPC endpoint.
//
// The RPC URL is injected rather than read here, so the adapter is testable
// without a socket and so this module cannot become a second place where an
// endpoint is configured.
// ---------------------------------------------------------------------------

export type AerodromeRpcReasonV1 =
  | 'not_configured'
  | 'rpc_unavailable'
  | 'rpc_timeout'
  | 'rpc_error'
  | 'invalid_response'
  | 'no_route';

export type AerodromeRpcResultV1<T> =
  | { ok: true; value: T }
  | { ok: false; reason: AerodromeRpcReasonV1; detail?: string };

export interface AerodromeRpcConfigV1 {
  rpcUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface AerodromeReaderV1 {
  /** The Router's own factory. Read rather than pinned, so there is one
   * address in this integration instead of two. */
  readDefaultFactory(): Promise<AerodromeRpcResultV1<`0x${string}`>>;
  /** Amounts out for ONE route. `no_route` when the pool does not exist or
   * holds nothing — a normal answer, not a transport failure. */
  readAmountsOut(input: {
    amountIn: bigint;
    route: readonly AerodromeRouteLegV1[];
  }): Promise<AerodromeRpcResultV1<bigint[]>>;
  readBlockNumber(): Promise<string | null>;
  /** T67B.1: the CURRENT allowance the wallet has granted the Router.
   * Read so the approval decision is made from observed state rather than
   * from the assumption that a previous approval is still standing. */
  readAllowance(input: {
    token: `0x${string}`;
    owner: `0x${string}`;
    spender: `0x${string}`;
  }): Promise<AerodromeRpcResultV1<bigint>>;
}

interface JsonRpcEnvelope {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * Removes anything credential-shaped from RPC text before it can reach a log.
 * Alchemy and friends carry the key in the URL path.
 */
export function redactRpcTextV1(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, '<url>').slice(0, 300);
}

/** A revert is Aerodrome saying "no such pool", which is an ANSWER. Only a
 * transport or shape problem is a failure. */
function classifyRpcErrorV1(message: string): AerodromeRpcReasonV1 {
  if (/execution reverted|revert/i.test(message)) return 'no_route';
  return 'rpc_error';
}

export function createAerodromeReaderV1(config: AerodromeRpcConfigV1): AerodromeReaderV1 {
  const timeoutMs = config.timeoutMs ?? 8_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  let nextId = 1;

  async function rpc(method: string, params: unknown[]): Promise<AerodromeRpcResultV1<unknown>> {
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
    if (!response.ok) return { ok: false, reason: 'rpc_unavailable', detail: `status ${response.status}` };

    let envelope: JsonRpcEnvelope;
    try {
      envelope = (await response.json()) as JsonRpcEnvelope;
    } catch {
      return { ok: false, reason: 'invalid_response' };
    }
    if (envelope.error) {
      const message = envelope.error.message ?? '';
      return { ok: false, reason: classifyRpcErrorV1(message), detail: redactRpcTextV1(message) };
    }
    if (typeof envelope.result !== 'string') return { ok: false, reason: 'invalid_response' };
    return { ok: true, value: envelope.result };
  }

  return {
    async readDefaultFactory() {
      const result = await rpc('eth_call', [
        { to: AERODROME_ROUTER_V1, data: encodeDefaultFactoryV1() },
        'latest',
      ]);
      if (!result.ok) return result;
      const factory = decodeAddressV1(String(result.value));
      return factory ? { ok: true, value: factory } : { ok: false, reason: 'invalid_response' };
    },

    async readAmountsOut(input) {
      const result = await rpc('eth_call', [
        { to: AERODROME_ROUTER_V1, data: encodeGetAmountsOutV1(input.amountIn, input.route) },
        'latest',
      ]);
      if (!result.ok) return result;
      const amounts = decodeUintArrayV1(String(result.value));
      if (amounts === null) return { ok: false, reason: 'invalid_response' };
      // One amount per hop plus the input. A short array means the Router did
      // not price the whole route.
      if (amounts.length !== input.route.length + 1) return { ok: false, reason: 'invalid_response' };
      // A pool that exists but holds nothing quotes zero out. That is "no
      // route" for a user, not a number to put on a card.
      if ((amounts[amounts.length - 1] ?? 0n) <= 0n) return { ok: false, reason: 'no_route' };
      return { ok: true, value: amounts };
    },

    async readAllowance(input) {
      const result = await rpc('eth_call', [
        { to: input.token, data: encodeAllowanceV1(input.owner, input.spender) },
        'latest',
      ]);
      if (!result.ok) return result;
      const allowance = decodeUint256V1(String(result.value));
      // An unreadable allowance is NOT read as zero. Zero would silently
      // produce an approval that may be unnecessary; worse, a garbage answer
      // read as a large number would skip an approval that is required.
      return allowance === null ? { ok: false, reason: 'invalid_response' } : { ok: true, value: allowance };
    },

    async readBlockNumber() {
      const result = await rpc('eth_blockNumber', []);
      if (!result.ok) return null;
      try {
        return BigInt(String(result.value)).toString();
      } catch {
        return null;
      }
    },
  };
}
