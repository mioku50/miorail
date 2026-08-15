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
  /** Calls per JSON-RPC batch. See `B20_MAX_BATCH_SIZE_V1` for the default and
   * why it is what it is. */
  maxBatchSize?: number;
}

/**
 * Calls per batch.
 *
 * Measured against `mainnet.base.org` on 2026-08-02: eleven or more calls in
 * one batch are refused with HTTP 200 and a single JSON-RPC error object —
 * `maximum 10 calls in 1 batch` — rather than an array. Ten is the endpoint's
 * own number, not a guess, and a keyed endpoint that allows more loses nothing
 * by sending two requests instead of one.
 */
export const B20_MAX_BATCH_SIZE_V1 = 10;

/**
 * The gap a throttled reader starts at, per call.
 *
 * Measured against `mainnet.base.org` on 2026-08-02: it serves roughly two and
 * a half calls per second, so ~400ms is one call's share. The old value crept
 * up from 120ms, which is three times faster than the endpoint will answer —
 * the first reads of a card were spent discovering that, and the rows they
 * belonged to came back empty. Starting at the measured rate is not
 * pessimism; it is the number.
 */
export const B20_THROTTLED_GAP_MS_V1 = 400;

export interface B20BatchCallV1 {
  to: string;
  data: string;
  blockTag: string;
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
  call(input: B20BatchCallV1): Promise<B20RpcResultV1<string>>;
  /**
   * Several pinned calls in as few round trips as the endpoint allows.
   *
   * Optional. A reader that does not implement it — a table-backed fake, say —
   * is read one call at a time by `callManyV1`, which is the same set of
   * questions and the same set of answers, only slower. Callers use the helper
   * rather than this method so that stays true.
   */
  callMany?(inputs: readonly B20BatchCallV1[]): Promise<B20RpcResultV1<string>[]>;
  /**
   * The sender of one transaction, by hash.
   *
   * Optional for the same reason `callMany` is: the fakes in this repo
   * implement what they need, and a required method would break every one of
   * them for a read only the launch-context backfill makes.
   *
   * `null` means the endpoint ANSWERED and the transaction was not there. A
   * failure comes back as a failure — the difference decides whether anything
   * may be stored at all, because storing an outage as "absent" would turn a
   * bad minute into a permanent fact about somebody's launch.
   */
  readTransaction?(hash: string): Promise<B20RpcResultV1<B20TransactionV1 | null>>;
}

/** As much of a transaction as the identity anchor needs. Deliberately not the
 * whole object: input data and value are not read, so they cannot be stored. */
export interface B20TransactionV1 {
  from: string;
  to: string | null;
  blockNumber: string | null;
}

/**
 * Reads a list of pinned calls, batching where the reader can.
 *
 * Results come back positionally: `result[i]` answers `inputs[i]`, always, with
 * a failure in place of an answer rather than a gap. Batching must not change
 * WHICH question a row on the card came from.
 */
export async function callManyV1(
  reader: B20ReaderV1,
  inputs: readonly B20BatchCallV1[],
): Promise<B20RpcResultV1<string>[]> {
  if (inputs.length === 0) return [];
  if (reader.callMany) return reader.callMany(inputs);
  const results: B20RpcResultV1<string>[] = [];
  for (const input of inputs) results.push(await reader.call(input));
  return results;
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

/**
 * One JSON-RPC envelope, classified.
 *
 * Shared by the single-call and batch paths on purpose: a throttled call must
 * be the same outcome whether it arrived alone or as the seventh entry of a
 * batch. `mainnet.base.org` refuses individual entries inside an accepted batch
 * with `over rate limit`, so this is not a hypothetical path.
 */
function envelopeResultV1(envelope: JsonRpcEnvelope): B20RpcResultV1<unknown> {
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

/** An `eth_call` result, decoded no further than its type. */
function callResultV1(result: B20RpcResultV1<unknown>): B20RpcResultV1<string> {
  if (!result.ok) return result;
  if (typeof result.value !== 'string') return { ok: false, reason: 'invalid_response' };
  // `0x` is an ANSWER, and its meaning is "there was nothing here at this
  // block" — never `false`, never zero. See the research note: a B20 read
  // before activation returns exactly this.
  if (result.value === '0x') return { ok: false, reason: 'empty_result', detail: 'the call returned no data' };
  return { ok: true, value: result.value, raw: result.value };
}

export function createB20ReaderV1(config: B20ReaderConfigV1): B20ReaderV1 {
  const timeoutMs = config.timeoutMs ?? 8_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  const maxRetries = config.maxRetries ?? 3;
  const sleep = config.sleepImpl ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const maxBatchSize = Math.max(1, config.maxBatchSize ?? B20_MAX_BATCH_SIZE_V1);
  // Sticky. An endpoint that refuses the FORM of a batch will refuse every
  // later one too, so the fallback is decided once rather than paid for on
  // every read.
  let batchSupported = true;
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
    gapMs = Math.min(gapMs === 0 ? B20_THROTTLED_GAP_MS_V1 : gapMs * 2, 1_000);
  }
  function noteServed(): void {
    gapMs = gapMs <= 120 ? 0 : Math.floor(gapMs / 2);
  }

  /**
   * Waits for this request's share of the endpoint's allowance.
   *
   * The gap is multiplied by the number of CALLS, not paid once per request.
   * Public Base meters per call — a ten-call batch spends ten of its allowance
   * — so pacing a batch like a single call asks for ten times the quota after
   * one call's worth of patience. Measured on 2026-08-02: without this, a card
   * on mainnet.base.org filled 4 of 16 rows; with it, 16 of 16.
   *
   * Batching is therefore a round-trip saving, never a quota saving. On a
   * healthy endpoint the gap is zero and this costs nothing at all.
   */
  async function paceForV1(callCount: number): Promise<void> {
    if (gapMs <= 0) return;
    const owed = gapMs * callCount;
    const sinceLast = Date.now() - lastRequestAt;
    if (sinceLast < owed) await sleep(owed - sinceLast);
  }

  async function rpcOnce(method: string, params: unknown[]): Promise<B20RpcResultV1<unknown>> {
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
    const result = envelopeResultV1(envelope);
    // A throttle can arrive as a 200 with a JSON-RPC error body, so pacing has
    // to be driven by the classified reason, not by the HTTP status.
    if (!result.ok && result.reason === 'rate_limited') noteThrottled();
    else if (result.ok) noteServed();
    return result;
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
    return callResultV1(await rpc('eth_call', [{ to, data }, blockTag]));
  }

  /** One attempt, no retry. The batch loop owns retrying so a call cannot be
   * repeated by two layers at once. */
  async function ethCallOnce(input: B20BatchCallV1): Promise<B20RpcResultV1<string>> {
    return callResultV1(await rpcOnce('eth_call', [{ to: input.to, data: input.data }, input.blockTag]));
  }

  type BatchOutcomeV1 =
    /** The endpoint answered as a batch. Entries are keyed by input index; an
     * index that is absent was not answered at all. */
    | { kind: 'answered'; results: Map<number, B20RpcResultV1<string>> }
    /** The request itself failed, so nothing in it was answered. */
    | { kind: 'transport'; reason: B20RpcReasonV1; detail?: string }
    /** The endpoint does not take batches of this size, or at all. */
    | { kind: 'unsupported' };

  async function rpcBatchOnce(
    entries: readonly { index: number; call: B20BatchCallV1 }[],
  ): Promise<BatchOutcomeV1> {
    if (config.rpcUrl.trim().length === 0) return { kind: 'transport', reason: 'not_configured' };
    await paceForV1(entries.length);
    lastRequestAt = Date.now();

    // The id is what ties an answer back to a question. Batched responses may
    // arrive in any order, so position is never used for that.
    const byId = new Map<number, number>();
    const body = entries.map((entry) => {
      const id = nextId++;
      byId.set(id, entry.index);
      return {
        jsonrpc: '2.0',
        id,
        method: 'eth_call',
        params: [{ to: entry.call.to, data: entry.call.data }, entry.call.blockTag],
      };
    });

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
      return name === 'TimeoutError' || name === 'AbortError'
        ? { kind: 'transport', reason: 'rpc_timeout' }
        : { kind: 'transport', reason: 'rpc_unavailable' };
    }
    if (response.status === 429) {
      const header = Number(response.headers.get('retry-after'));
      retryAfterMs = Number.isFinite(header) && header > 0 && header <= 5 ? header * 1_000 : null;
      noteThrottled();
      return { kind: 'transport', reason: 'rate_limited' };
    }
    if (!response.ok) return { kind: 'transport', reason: 'rpc_unavailable', detail: `status ${response.status}` };

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { kind: 'transport', reason: 'invalid_response' };
    }
    // A batch answered with a single object is the endpoint refusing the SHAPE
    // of the request — `mainnet.base.org` answers an over-size batch with
    // exactly one `maximum 10 calls in 1 batch` error. That is a fact about the
    // endpoint, not about any one call in it, so it must not be recorded as a
    // failed read of a token.
    if (!Array.isArray(payload)) return { kind: 'unsupported' };

    const results = new Map<number, B20RpcResultV1<string>>();
    let served = false;
    let throttled = false;
    for (const raw of payload) {
      if (!raw || typeof raw !== 'object' || !('id' in raw)) continue;
      const index = byId.get(Number((raw as { id: unknown }).id));
      if (index === undefined) continue;
      const result = callResultV1(envelopeResultV1(raw as JsonRpcEnvelope));
      results.set(index, result);
      if (result.ok) served = true;
      else if (result.reason === 'rate_limited') throttled = true;
    }
    // A batch where some entries were throttled paces the next one, even though
    // the request as a whole succeeded. Without this the reader would read a
    // half-served batch as healthy and keep the same rate.
    if (throttled) noteThrottled();
    else if (served) noteServed();
    return { kind: 'answered', results };
  }

  /**
   * Reads many pinned calls, retrying only what is worth retrying.
   *
   * The rounds shrink: a round re-issues just the entries that came back
   * throttled or unanswered, so a partially served batch costs one more request
   * for the remainder rather than a full repeat. That matters on the public
   * endpoint, which serves roughly the first five calls of a batch and refuses
   * the rest with `over rate limit`.
   */
  async function ethCallMany(inputs: readonly B20BatchCallV1[]): Promise<B20RpcResultV1<string>[]> {
    const results: (B20RpcResultV1<string> | undefined)[] = inputs.map(() => undefined);
    let pending = inputs.map((_, index) => index);

    for (let attempt = 0; attempt <= maxRetries && pending.length > 0; attempt += 1) {
      if (attempt > 0) {
        await sleep(retryAfterMs ?? 250 * 2 ** (attempt - 1));
        retryAfterMs = null;
      }
      const chunkSize = batchSupported ? maxBatchSize : 1;
      for (let start = 0; start < pending.length; start += chunkSize) {
        const slice = pending.slice(start, start + chunkSize);
        // A batch of one is a plain call: the envelope array would cost bytes
        // and buy nothing, and some endpoints reject it.
        if (slice.length === 1) {
          const index = slice[0]!;
          results[index] = await ethCallOnce(inputs[index]!);
          continue;
        }
        const outcome = await rpcBatchOnce(slice.map((index) => ({ index, call: inputs[index]! })));
        if (outcome.kind === 'unsupported') {
          batchSupported = false;
          for (const index of slice) results[index] = await ethCallOnce(inputs[index]!);
          continue;
        }
        if (outcome.kind === 'transport') {
          for (const index of slice) results[index] = { ok: false, reason: outcome.reason, detail: outcome.detail };
          continue;
        }
        for (const index of slice) {
          // An index the batch did not answer is left undefined rather than
          // invented, which re-queues it for the next round.
          results[index] = outcome.results.get(index);
        }
      }
      pending = pending.filter((index) => {
        const result = results[index];
        return result === undefined || (!result.ok && RETRYABLE_REASONS_V1.includes(result.reason));
      });
    }

    return inputs.map(
      (_, index) =>
        results[index] ?? {
          ok: false,
          reason: 'invalid_response',
          detail: 'the batch returned no entry for this call',
        },
    );
  }

  function decodeBoolResult(result: B20RpcResultV1<string>): B20RpcResultV1<boolean> {
    if (!result.ok) return result;
    const decoded = decodeBoolV1(result.value);
    return decoded === null
      ? { ok: false, reason: 'invalid_response', detail: 'response is not a boolean word' }
      : { ok: true, value: decoded, raw: result.raw };
  }

  return {
    async readTransaction(hash: string) {
      const result = await rpc('eth_getTransactionByHash', [hash]);
      if (!result.ok) return result;
      // A JSON-RPC null here is the endpoint saying "no such transaction",
      // which is a real answer and is stored as one.
      if (result.value === null) return { ok: true as const, value: null, raw: 'null' };
      const tx = result.value as { from?: unknown; to?: unknown; blockNumber?: unknown };
      const from = typeof tx.from === 'string' ? tx.from.toLowerCase() : null;
      if (!from || !/^0x[0-9a-f]{40}$/.test(from)) {
        return { ok: false as const, reason: 'invalid_response' as const };
      }
      const to = typeof tx.to === 'string' ? tx.to.toLowerCase() : null;
      let blockNumber: string | null = null;
      if (typeof tx.blockNumber === 'string') {
        try {
          blockNumber = BigInt(tx.blockNumber).toString();
        } catch {
          return { ok: false as const, reason: 'invalid_response' as const };
        }
      }
      return {
        ok: true as const,
        value: { from, to: to && /^0x[0-9a-f]{40}$/.test(to) ? to : null, blockNumber },
        raw: from,
      };
    },

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

    async callMany(inputs) {
      return ethCallMany(inputs);
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
