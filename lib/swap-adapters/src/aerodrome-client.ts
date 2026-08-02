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
  /** The endpoint refused because we asked too fast. A fact about us and the
   * endpoint, never about the pair — and the one reason worth repeating. */
  | 'rate_limited'
  | 'invalid_response'
  | 'no_route';

export type AerodromeRpcResultV1<T> =
  | { ok: true; value: T }
  | { ok: false; reason: AerodromeRpcReasonV1; detail?: string };

export interface AerodromeRpcConfigV1 {
  rpcUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** How many times a THROTTLED read is repeated. A revert is never repeated. */
  maxRetries?: number;
  /** Injected so tests do not spend real time. */
  sleepImpl?: (ms: number) => Promise<void>;
  maxBatchSize?: number;
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
  /**
   * Amounts out for MANY routes in as few round trips as the endpoint allows.
   *
   * Results come back positionally: `result[i]` answers `routes[i]`, always,
   * with a failure in its place rather than a gap. One exit check quotes a
   * dozen-odd routes and sizes, and issuing those one at a time is what makes
   * the difference between a card and a timeout — public Base serves roughly
   * two and a half calls a second.
   *
   * Optional. A reader without it — a table-backed fake, say — is read one
   * route at a time by `readAmountsOutManyV1`, which asks the same questions
   * and gets the same answers, only slower. Callers use the helper so that
   * stays true.
   */
  readAmountsOutMany?(
    inputs: readonly { amountIn: bigint; route: readonly AerodromeRouteLegV1[] }[],
  ): Promise<AerodromeRpcResultV1<bigint[]>[]>;
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

/**
 * Calls per JSON-RPC batch.
 *
 * The public Base endpoint's own number: eleven or more come back as HTTP 200
 * with a single `maximum 10 calls in 1 batch` error object rather than an
 * array. Measured 2026-08-02.
 */
export const AERODROME_MAX_BATCH_V1 = 10;

/**
 * One `getAmountsOut` result, decoded.
 *
 * Shared by the single and batched paths on purpose: a quote must mean the
 * same thing whichever way it was fetched, and these three rules are the whole
 * meaning — a short array is a route the Router did not price, a zero output is
 * "no route" for a user rather than a number to put on a card, and a revert is
 * the Router saying the pool does not exist.
 */
function decodeAmountsOutV1(
  result: AerodromeRpcResultV1<unknown>,
  hops: number,
): AerodromeRpcResultV1<bigint[]> {
  if (!result.ok) return result;
  const amounts = decodeUintArrayV1(String(result.value));
  if (amounts === null) return { ok: false, reason: 'invalid_response' };
  if (amounts.length !== hops + 1) return { ok: false, reason: 'invalid_response' };
  if ((amounts[amounts.length - 1] ?? 0n) <= 0n) return { ok: false, reason: 'no_route' };
  return { ok: true, value: amounts };
}

/** A revert is Aerodrome saying "no such pool", which is an ANSWER. Only a
 * transport or shape problem is a failure. */
function classifyRpcErrorV1(message: string): AerodromeRpcReasonV1 {
  if (/execution reverted|revert/i.test(message)) return 'no_route';
  // `over rate limit` used to land in `rpc_error`, which meant a throttled
  // quote was never repeated and a whole exit check could be decided by how
  // fast we asked.
  if (/rate limit|too many requests/i.test(message)) return 'rate_limited';
  return 'rpc_error';
}

/**
 * The gap a throttled reader starts at, per call.
 *
 * Measured against `mainnet.base.org` on 2026-08-02: it serves roughly two and
 * a half calls a second, so ~400ms is one call's share. An exit check is a
 * dozen-odd quotes, and without pacing the second half of them come back
 * throttled — which reads as "no route out of this token" for a token that has
 * one. That is the worst sentence this file could produce.
 */
export const AERODROME_THROTTLED_GAP_MS_V1 = 400;

/** The only reasons worth repeating. A revert is Aerodrome saying "no such
 * pool", which is an ANSWER — repeating it only makes it slower. */
const AERODROME_RETRYABLE_V1: readonly AerodromeRpcReasonV1[] = ['rate_limited', 'rpc_timeout'];

export function createAerodromeReaderV1(config: AerodromeRpcConfigV1): AerodromeReaderV1 {
  const timeoutMs = config.timeoutMs ?? 8_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  const maxRetries = config.maxRetries ?? 2;
  const sleep = config.sleepImpl ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const maxBatch = Math.max(1, config.maxBatchSize ?? AERODROME_MAX_BATCH_V1);
  let nextId = 1;
  // Adaptive, and multiplied by the CALL COUNT of each request: the endpoint's
  // limit is a call budget per window, so pacing a ten-call batch like a single
  // call asks for ten times the quota after one call's worth of patience.
  let gapMs = 0;
  let lastRequestAt = 0;

  function noteThrottled(): void {
    gapMs = Math.min(gapMs === 0 ? AERODROME_THROTTLED_GAP_MS_V1 : gapMs * 2, 1_000);
  }
  function noteServed(): void {
    gapMs = gapMs <= 120 ? 0 : Math.floor(gapMs / 2);
  }
  async function paceForV1(callCount: number): Promise<void> {
    if (gapMs <= 0) return;
    const owed = gapMs * callCount;
    const sinceLast = Date.now() - lastRequestAt;
    if (sinceLast < owed) await sleep(owed - sinceLast);
  }

  async function rpc(method: string, params: unknown[]): Promise<AerodromeRpcResultV1<unknown>> {
    let result = await rpcOnce(method, params);
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      if (result.ok || !AERODROME_RETRYABLE_V1.includes(result.reason)) return result;
      await sleep(250 * 2 ** attempt);
      result = await rpcOnce(method, params);
    }
    return result;
  }

  async function rpcOnce(method: string, params: unknown[]): Promise<AerodromeRpcResultV1<unknown>> {
    if (config.rpcUrl.trim().length === 0) return { ok: false, reason: 'not_configured' };
    await paceForV1(1);
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
    if (!response.ok) return { ok: false, reason: 'rpc_unavailable', detail: `status ${response.status}` };

    let envelope: JsonRpcEnvelope;
    try {
      envelope = (await response.json()) as JsonRpcEnvelope;
    } catch {
      return { ok: false, reason: 'invalid_response' };
    }
    if (envelope.error) {
      const message = envelope.error.message ?? '';
      const reason = classifyRpcErrorV1(message);
      // A throttle arrives as a 200 with a JSON-RPC error body, so pacing is
      // driven by the classified reason rather than by the HTTP status.
      if (reason === 'rate_limited') noteThrottled();
      return { ok: false, reason, detail: redactRpcTextV1(message) };
    }
    if (typeof envelope.result !== 'string') return { ok: false, reason: 'invalid_response' };
    noteServed();
    return { ok: true, value: envelope.result };
  }

  /**
   * One JSON-RPC batch of `eth_call`s.
   *
   * Capped at ten because that is the public Base endpoint's own limit — it
   * answers an over-size batch with HTTP 200 and a single
   * `maximum 10 calls in 1 batch` error OBJECT rather than an array. A non-array
   * response is therefore the endpoint refusing the SHAPE of the request, which
   * is a fact about the endpoint and must never be recorded as "no route" for
   * ten pairs.
   *
   * Batching saves round trips, not quota: the endpoint meters per call. This
   * is why an exit check is still bounded by a probe count rather than by how
   * many routes it would like to ask about.
   */
  async function rpcBatch(calls: readonly { to: string; data: string }[]): Promise<AerodromeRpcResultV1<unknown>[]> {
    if (config.rpcUrl.trim().length === 0) {
      return calls.map(() => ({ ok: false, reason: 'not_configured' as const }));
    }
    const results: (AerodromeRpcResultV1<unknown> | undefined)[] = calls.map(() => undefined);
    let pending = calls.map((_call, index) => index);

    for (let attempt = 0; attempt <= maxRetries && pending.length > 0; attempt += 1) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
      for (let start = 0; start < pending.length; start += maxBatch) {
        const slice = pending.slice(start, start + maxBatch);
        const answers = await rpcBatchOnce(slice.map((index) => calls[index]!));
        slice.forEach((index, position) => {
          results[index] = answers[position];
        });
      }
      // The rounds SHRINK: only what came back throttled is asked again, so a
      // partially served batch costs one more request for the remainder rather
      // than a full repeat. That is the whole reason a check on the public
      // endpoint finishes at all.
      pending = pending.filter((index) => {
        const result = results[index];
        return result !== undefined && !result.ok && AERODROME_RETRYABLE_V1.includes(result.reason);
      });
    }
    return results.map(
      (result) => result ?? { ok: false, reason: 'invalid_response' as const },
    );
  }

  async function rpcBatchOnce(
    calls: readonly { to: string; data: string }[],
  ): Promise<AerodromeRpcResultV1<unknown>[]> {
    await paceForV1(calls.length);
    lastRequestAt = Date.now();
    const byId = new Map<number, number>();
    const body = calls.map((call, index) => {
      const id = nextId++;
      byId.set(id, index);
      return { jsonrpc: '2.0', id, method: 'eth_call', params: [call, 'latest'] };
    });
    const all = (reason: AerodromeRpcReasonV1, detail?: string): AerodromeRpcResultV1<unknown>[] =>
      calls.map(() => ({ ok: false, reason, detail }));

    let response: Response;
    try {
      response = await fetchImpl(config.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return all(name === 'TimeoutError' || name === 'AbortError' ? 'rpc_timeout' : 'rpc_unavailable');
    }
    if (!response.ok) return all('rpc_unavailable', `status ${response.status}`);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return all('invalid_response');
    }
    // Not an array: the endpoint refused the batch itself. Falling back to
    // single calls keeps the answer about the pairs rather than about us.
    if (!Array.isArray(payload)) {
      const single: AerodromeRpcResultV1<unknown>[] = [];
      for (const call of calls) single.push(await rpc('eth_call', [call, 'latest']));
      return single;
    }

    const results: AerodromeRpcResultV1<unknown>[] = calls.map(() => ({
      ok: false,
      reason: 'invalid_response' as const,
      detail: 'the batch returned no entry for this call',
    }));
    for (const entry of payload) {
      if (!entry || typeof entry !== 'object' || !('id' in entry)) continue;
      // Ids, never positions: a batched response may arrive in any order, and
      // a route priced by position would be a quote for the wrong pair.
      const index = byId.get(Number((entry as { id: unknown }).id));
      if (index === undefined) continue;
      const envelope = entry as JsonRpcEnvelope;
      if (envelope.error) {
        const message = envelope.error.message ?? '';
        results[index] = {
          ok: false,
          reason: classifyRpcErrorV1(message),
          detail: redactRpcTextV1(message),
        };
        continue;
      }
      results[index] =
        typeof envelope.result === 'string'
          ? { ok: true, value: envelope.result }
          : { ok: false, reason: 'invalid_response' };
    }
    // A batch where some entries were throttled paces the next one, even though
    // the request as a whole succeeded. Without this the reader reads a
    // half-served batch as healthy and keeps the same rate.
    if (results.some((result) => !result.ok && result.reason === 'rate_limited')) noteThrottled();
    else if (results.some((result) => result.ok)) noteServed();
    return results;
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
      return decodeAmountsOutV1(result, input.route.length);
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

    async readAmountsOutMany(inputs) {
      if (inputs.length === 0) return [];
      if (inputs.length === 1) {
        return [await this.readAmountsOut(inputs[0]!)];
      }
      const raw = await rpcBatch(
        inputs.map((input) => ({
          to: AERODROME_ROUTER_V1,
          data: encodeGetAmountsOutV1(input.amountIn, input.route),
        })),
      );
      return raw.map((result, index) => decodeAmountsOutV1(result, inputs[index]!.route.length));
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

/**
 * Quotes many routes, batching where the reader can.
 *
 * Positional: `result[i]` answers `inputs[i]`. Batching must never change WHICH
 * pair a quote is about.
 */
export async function readAmountsOutManyV1(
  reader: AerodromeReaderV1,
  inputs: readonly { amountIn: bigint; route: readonly AerodromeRouteLegV1[] }[],
): Promise<AerodromeRpcResultV1<bigint[]>[]> {
  if (inputs.length === 0) return [];
  if (reader.readAmountsOutMany) return reader.readAmountsOutMany(inputs);
  const results: AerodromeRpcResultV1<bigint[]>[] = [];
  for (const input of inputs) results.push(await reader.readAmountsOut(input));
  return results;
}
