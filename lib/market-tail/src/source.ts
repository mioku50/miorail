import {
  ERC20_TRANSFER_TOPIC_V1,
  MARKET_TAIL_CALL_GAP_MS_V1,
  TOKEN0_SELECTOR_V1,
  TOKEN1_SELECTOR_V1,
} from './constants.js';
import type { RawLogV1 } from './ledger.js';

// ---------------------------------------------------------------------------
// The three questions the tail asks a node, and nothing else.
//
// Three, not one general-purpose client, because each has a different failure
// meaning and the caller has to be able to tell them apart. A ledger read that
// did not complete leaves the cursor where it was; a pair read that did not
// complete leaves an address a candidate. Neither may be reported as an empty
// answer, which is why every method returns a refusal rather than a default.
//
// No URL, no header and no provider message ever leaves this file. A managed
// endpoint carries its key in the path, so a verbatim error is a credential in
// a log line.
// ---------------------------------------------------------------------------

export type MarketSourceResultV1<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: string;
      /**
       * The endpoint refused because the ANSWER was too big, not because the
       * request was wrong or the endpoint was busy. The only refusal a caller
       * can act on: ask for less and the same question succeeds.
       */
      oversize?: true;
    };

/**
 * Whether a JSON-RPC error is the CONTRACT answering or the ENDPOINT failing.
 *
 * The distinction is the whole reason this function exists. An address with no
 * `token0()` reverts, and that revert is the address telling us it is not a
 * pool -- a fact worth storing. A rate limiter also produces an error, and
 * storing THAT as "not a pool" would permanently mark a real venue as a router
 * because one minute was busy. The message is inspected here and never leaves:
 * it may contain the endpoint URL.
 */
function isContractRefusalV1(message: string): boolean {
  return /execution reverted|invalid opcode|out of gas|revert/i.test(message);
}

/**
 * Whether the endpoint refused because the answer was too large.
 *
 * Measured 2026-08-25 on mainnet.base.org: thirteen official assets over 1,987
 * blocks came back HTTP 500 with `-32020 backend response too large`, while
 * the same request over 999 blocks succeeded. The bound is on the RESPONSE, so
 * it moves with how busy the assets are — a fixed smaller span would work
 * today and fail on a busy hour. This is what lets the caller split instead.
 */
function isOversizeRefusalV1(code: number | undefined, message: string): boolean {
  return code === -32020 || /response too large|query returned more than|limit exceeded/i.test(message);
}

export interface MarketTailSourceV1 {
  headBlock(): Promise<MarketSourceResultV1<number>>;
  /** One call for every tracked token over the whole range. */
  transferLogs(input: {
    tokens: readonly string[];
    fromBlock: number;
    toBlock: number;
  }): Promise<MarketSourceResultV1<RawLogV1[]>>;
  /**
   * `token0()` and `token1()`, the calls that identify a pool.
   *
   * Null for a side the address did not answer with -- which is an ANSWER, and
   * different from the call failing. `calls` is what was actually spent, one or
   * two, so the recorded cost is the cost rather than the budget.
   */
  pairReads(
    address: string,
  ): Promise<MarketSourceResultV1<{ token0: string | null; token1: string | null; calls: number }>>;
}

const hexV1 = (value: number) => `0x${value.toString(16)}`;

/** The contract answered by refusing. A successful read of a negative answer,
 * which is why it travels as a value and not as an error. */
const CONTRACT_REVERTED_V1 = Symbol('contract reverted');

export function createMarketTailSourceV1(config: {
  rpcUrl: string;
  timeoutMs?: number;
  /** Minimum spacing between requests. See MARKET_TAIL_CALL_GAP_MS_V1. */
  callGapMs?: number;
  fetchImpl?: typeof fetch;
  /** Injected so a test does not have to wait for the pacing it is asserting. */
  sleepImpl?: (ms: number) => Promise<void>;
}): MarketTailSourceV1 {
  const timeoutMs = config.timeoutMs ?? 30_000;
  const callGapMs = config.callGapMs ?? MARKET_TAIL_CALL_GAP_MS_V1;
  const doFetch = config.fetchImpl ?? fetch;
  const doSleep = config.sleepImpl ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let nextCallAt = 0;

  async function rpcV1(method: string, params: unknown[]): Promise<MarketSourceResultV1<unknown>> {
    if (config.rpcUrl.trim().length === 0) return { ok: false, reason: 'no endpoint configured' };
    // Pacing, not politeness. mainnet.base.org sustains about half an eth_call
    // per second per address, and an unpaced burst of identity reads comes back
    // throttled -- which leaves every address a candidate and spends the same
    // calls again on the next pass. Measured before this existed: fourteen
    // addresses asked per pass, twenty-eight calls spent, zero identified.
    const wait = nextCallAt - Date.now();
    if (wait > 0) await doSleep(wait);
    nextCallAt = Date.now() + callGapMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(config.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'miorail/1 (+market-tail)' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      // The body is read even on a non-2xx. A JSON-RPC endpoint carries its
      // refusal there, and mainnet.base.org answers "backend response too
      // large" with HTTP 500 — so returning on the status alone threw away the
      // one refusal a caller can do something about and reported it as an
      // unexplained server error.
      type JsonRpcEnvelopeV1 = { result?: unknown; error?: { code?: number; message?: string } };
      let envelope: JsonRpcEnvelopeV1 | null = null;
      try {
        envelope = (await response.json()) as JsonRpcEnvelopeV1;
      } catch {
        envelope = null;
      }
      if (envelope?.error) {
        const message = envelope.error.message ?? '';
        // The message is inspected and dropped, never reported: there is no
        // action its text would change, and it may contain the URL.
        if (isContractRefusalV1(message)) return { ok: true, value: CONTRACT_REVERTED_V1 };
        if (isOversizeRefusalV1(envelope.error.code, message)) {
          return { ok: false, reason: `the ${method} answer was too large`, oversize: true };
        }
        return { ok: false, reason: `endpoint refused the ${method} request` };
      }
      if (!response.ok) return { ok: false, reason: `endpoint answered ${response.status}` };
      return { ok: true, value: envelope?.result ?? null };
    } catch {
      return { ok: false, reason: `${method} did not reach the endpoint` };
    } finally {
      clearTimeout(timer);
    }
  }

  const addressFromWord = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const word = value.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(word)) return null;
    return `0x${word.slice(26)}`;
  };

  return {
    async headBlock() {
      const result = await rpcV1('eth_blockNumber', []);
      if (!result.ok) return result;
      if (typeof result.value !== 'string') return { ok: false, reason: 'head block was not a quantity' };
      const head = Number(BigInt(result.value));
      return Number.isSafeInteger(head)
        ? { ok: true, value: head }
        : { ok: false, reason: 'head block was out of range' };
    },

    async transferLogs(input) {
      if (input.tokens.length === 0) return { ok: true, value: [] };
      const tokens = input.tokens.map((token) => token.toLowerCase());

      const readV1 = async (
        fromBlock: number,
        toBlock: number,
      ): Promise<MarketSourceResultV1<RawLogV1[]>> => {
        const result = await rpcV1('eth_getLogs', [
          {
            address: tokens,
            topics: [ERC20_TRANSFER_TOPIC_V1],
            fromBlock: hexV1(fromBlock),
            toBlock: hexV1(toBlock),
          },
        ]);
        if (!result.ok) {
          // Ask for less rather than give up. The endpoint's bound is on the
          // response, so it moves with how busy the assets are — and a pass
          // that stops here leaves the cursor where it was and re-reads the
          // same oversized range on the next one, forever.
          //
          // The requested range is still fully covered when this returns: the
          // caller advances the cursor to `toBlock`, so a partial read that
          // reported success would silently skip blocks.
          if (!result.oversize || fromBlock >= toBlock) return result;
          const middle = fromBlock + Math.floor((toBlock - fromBlock) / 2);
          const left = await readV1(fromBlock, middle);
          if (!left.ok) return left;
          const right = await readV1(middle + 1, toBlock);
          if (!right.ok) return right;
          return { ok: true, value: [...left.value, ...right.value] };
        }
        if (!Array.isArray(result.value)) return { ok: false, reason: 'logs were not a list' };
        // A malformed entry stops the pass: the cursor must not advance past a
        // range that was only partly readable.
        const logs: RawLogV1[] = [];
        for (const entry of result.value) {
          if (typeof entry !== 'object' || entry === null) {
            return { ok: false, reason: 'a log entry was not an object' };
          }
          logs.push(entry as RawLogV1);
        }
        return { ok: true, value: logs };
      };

      return readV1(input.fromBlock, input.toBlock);
    },

    async pairReads(address) {
      // A failed read leaves the address a candidate; a REVERT identifies it as
      // not a pool. Conflating the two is the recurring bug class in this
      // repository: our own bad minute wearing the shape of a finding.
      const token0 = await rpcV1('eth_call', [{ to: address, data: TOKEN0_SELECTOR_V1 }, 'latest']);
      if (!token0.ok) return token0;
      // One call is enough to rule an address out, and the second is not spent.
      if (token0.value === CONTRACT_REVERTED_V1) {
        return { ok: true, value: { token0: null, token1: null, calls: 1 } };
      }
      const token1 = await rpcV1('eth_call', [{ to: address, data: TOKEN1_SELECTOR_V1 }, 'latest']);
      if (!token1.ok) return token1;
      if (token1.value === CONTRACT_REVERTED_V1) {
        return { ok: true, value: { token0: null, token1: null, calls: 2 } };
      }
      return {
        ok: true,
        value: {
          token0: addressFromWord(token0.value),
          token1: addressFromWord(token1.value),
          calls: 2,
        },
      };
    },
  };
}
