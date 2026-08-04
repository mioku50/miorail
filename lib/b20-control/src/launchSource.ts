import type { LaunchLogSourceV1 } from './launchReader.js';
import { B20_CREATED_TOPIC_V1, type RawLogV1 } from './launches.js';
import { B20_FACTORY_V1 } from './pinned.js';

// ---------------------------------------------------------------------------
// T69-A §0/§11 — the three JSON-RPC calls launch ingestion is allowed to make.
//
// `eth_blockNumber`, `eth_getLogs` and `eth_getBlockByNumber`. Nothing else is
// encoded here, so there is no signer, no `eth_sendRawTransaction`, and no
// method in this file that could move an asset.
//
// EVERY FAILURE IS `null`, AND THAT IS DELIBERATE. Not an error object, not a
// provider message — null. A managed endpoint carries its API key in the URL,
// so a verbatim provider message is a credential in a log line waiting to
// happen. The reader turns null into `endpoint_unavailable`, which is a
// category, and the category is all an operator needs to act.
//
// The cost of one pass is three calls, whatever the range: `getLogs` is capped
// by the caller rather than trusted to the endpoint. That is what makes this
// safe to put on a timer against the public endpoint, whose limit is a call
// count per window (T67F).
// ---------------------------------------------------------------------------

export interface LaunchSourceConfigV1 {
  rpcUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** How many times a RETRYABLE failure is repeated. See `retryableV1`. */
  maxRetries?: number;
  /** Injected so tests do not spend real time. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Whether a failure is worth repeating.
 *
 * Only three things are: a 429, a 5xx, and a transport failure that never
 * reached the endpoint. Those are facts about the connection and may differ a
 * second later.
 *
 * A JSON-RPC error is NOT retried. `-32600` is how Alchemy says "that block
 * range is too wide" — repeating the identical request would produce the
 * identical refusal, three times as slowly, and burn quota to learn nothing.
 * The fix for that error is a narrower window, which is the caller's decision.
 */
export function retryableV1(input: {
  httpStatus: number | null;
  transportFailed: boolean;
  jsonRpcError: boolean;
}): boolean {
  if (input.jsonRpcError) return false;
  if (input.transportFailed) return true;
  if (input.httpStatus === null) return false;
  return input.httpStatus === 429 || input.httpStatus >= 500;
}

const hexV1 = (value: number): string => `0x${value.toString(16)}`;

function asRawLogV1(value: unknown): RawLogV1 | null {
  if (typeof value !== 'object' || value === null) return null;
  const log = value as Record<string, unknown>;
  if (typeof log.address !== 'string' || !Array.isArray(log.topics) || typeof log.data !== 'string') return null;
  return {
    address: log.address,
    topics: log.topics.filter((topic): topic is string => typeof topic === 'string'),
    data: log.data,
    blockNumber: typeof log.blockNumber === 'string' ? log.blockNumber : null,
    blockHash: typeof log.blockHash === 'string' ? log.blockHash : null,
    transactionHash: typeof log.transactionHash === 'string' ? log.transactionHash : null,
    logIndex: typeof log.logIndex === 'string' ? log.logIndex : null,
    transactionIndex: typeof log.transactionIndex === 'string' ? log.transactionIndex : null,
    removed: log.removed === true,
  };
}

export function createLaunchLogSourceV1(config: LaunchSourceConfigV1): LaunchLogSourceV1 {
  const timeoutMs = config.timeoutMs ?? 15_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  const maxRetries = config.maxRetries ?? 2;
  const sleep = config.sleepImpl ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let nextId = 1;

  /** One attempt, classified. The classification is all that leaves this
   * function — never the status text, never the body, never the URL. */
  async function attemptV1(
    method: string,
    params: unknown[],
  ): Promise<{ value: unknown | null; retryable: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(config.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          value: null,
          retryable: retryableV1({ httpStatus: response.status, transportFailed: false, jsonRpcError: false }),
        };
      }
      const envelope = (await response.json()) as { result?: unknown; error?: unknown };
      // A JSON-RPC error is an unavailable endpoint as far as this worker is
      // concerned, and it is NOT retried: `-32600` ("block range too wide")
      // would refuse the identical request identically. The message is dropped
      // rather than reported — there is no action it would change, and it may
      // contain the URL.
      if (envelope.error) {
        return {
          value: null,
          retryable: retryableV1({ httpStatus: null, transportFailed: false, jsonRpcError: true }),
        };
      }
      return { value: envelope.result ?? null, retryable: false };
    } catch {
      // Never reached the endpoint, or the timeout fired. A fact about the
      // connection, and it may differ a second later.
      return {
        value: null,
        retryable: retryableV1({ httpStatus: null, transportFailed: true, jsonRpcError: false }),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function rpcV1(method: string, params: unknown[]): Promise<unknown | null> {
    if (config.rpcUrl.trim().length === 0) return null;
    for (let attempt = 0; ; attempt += 1) {
      const result = await attemptV1(method, params);
      if (result.value !== null) return result.value;
      if (!result.retryable || attempt >= maxRetries) return null;
      // Linear backoff. A throttled endpoint wants time, not cleverness.
      await sleep(250 * (attempt + 1));
    }
  }

  return {
    async headBlock() {
      const result = await rpcV1('eth_blockNumber', []);
      if (typeof result !== 'string') return null;
      try {
        const head = Number(BigInt(result));
        return Number.isSafeInteger(head) ? head : null;
      } catch {
        return null;
      }
    },

    async getLogs({ fromBlock, toBlock }) {
      // Pinned address AND pinned topic, so the endpoint filters rather than
      // this process paging through every log Base produced in the window.
      const result = await rpcV1('eth_getLogs', [
        {
          address: B20_FACTORY_V1,
          topics: [B20_CREATED_TOPIC_V1],
          fromBlock: hexV1(fromBlock),
          toBlock: hexV1(toBlock),
        },
      ]);
      if (!Array.isArray(result)) return null;
      const logs: RawLogV1[] = [];
      for (const entry of result) {
        const log = asRawLogV1(entry);
        // A malformed entry is not silently skipped: the reader must not be
        // told a range was clean when part of it was unreadable.
        if (!log) return null;
        logs.push(log);
      }
      return logs;
    },

    async blockHash(blockNumber) {
      // `false` — headers only. The transactions in the block are not needed
      // and would be several megabytes on a busy block.
      const result = await rpcV1('eth_getBlockByNumber', [hexV1(blockNumber), false]);
      if (typeof result !== 'object' || result === null) return null;
      const hash = (result as Record<string, unknown>).hash;
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
      return hash.toLowerCase();
    },
  };
}
