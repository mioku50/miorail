import {
  B20_POOL_SEARCH_BLOCKS_V1,
  B20_QUOTE_ASSETS_V1,
  UNISWAP_V4_INITIALIZE_TOPIC_V1,
  UNISWAP_V4_POOL_MANAGER_V1,
} from './uniswap-v4-pinned.js';

// ---------------------------------------------------------------------------
// Turning a B20 token into the pool that prices it.
//
// A Uniswap v4 quote needs the whole PoolKey — currency0, currency1, fee,
// tickSpacing, hooks — not just the pool id. The id is a hash OF that key, so
// it cannot be worked backwards, and every B20 pool carries a hook
// (0x985c14ba… on both tokens sampled), which means the key cannot be guessed
// from a small set of standard parameters either.
//
// `Initialize` states all of it. The only difficulty is finding the log
// without scanning the chain, and the launch block solves that: the pool is
// created in the same ten-block window as the token. We already store that
// block for every launch, so this is one bounded request at a known height.
//
// Decoding is done here by hand rather than through an ABI decoder because
// there is exactly one event and three words, and because the refusals matter
// more than the parsing: a log from the wrong emitter, a pool the token is not
// in, or a pool quoted against another long-tail token must all be REFUSED
// with a reason, not coerced into a PoolKey that later prices nothing.
// ---------------------------------------------------------------------------

export interface UniswapV4PoolKeyV1 {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export interface B20PoolV1 {
  poolId: string;
  key: UniswapV4PoolKeyV1;
  /** The B20 token, as it sits in the key. */
  token: string;
  /** What the token is priced in — native ETH or USDC. */
  quoteAsset: string;
  /** True when the B20 token is currency0. Decides swap direction later. */
  tokenIsCurrency0: boolean;
  blockNumber: number;
}

export type B20PoolRefusalV1 =
  | 'no_pool_initialized'
  | 'wrong_emitter'
  | 'wrong_event'
  | 'malformed_log'
  | 'token_not_in_pool'
  | 'unsupported_quote_asset'
  // Not a fact about the token: the endpoint did not answer. Kept apart from
  // `no_pool_initialized` because collapsing the two turns a rate limit into
  // "this token has no pool", which is exactly the false negative that hid the
  // v4 venue for months.
  | 'endpoint_unavailable';

export type B20PoolResultV1 =
  | { ok: true; pool: B20PoolV1 }
  | { ok: false; refusal: B20PoolRefusalV1 };

/** A log as an Ethereum node returns it, narrowed to what is read here. */
export interface RawLogV1 {
  address?: string;
  topics?: readonly string[];
  data?: string;
  blockNumber?: string | number;
}

const ADDRESS_V1 = /^0x[0-9a-fA-F]{40}$/;
const WORD_V1 = /^0x[0-9a-fA-F]{64}$/;

function lower(value: string): string {
  return value.toLowerCase();
}

/** The low 20 bytes of a 32-byte topic, as an address. */
function addressFromTopic(topic: string): string | null {
  if (!WORD_V1.test(topic)) return null;
  const address = `0x${topic.slice(26)}`;
  return ADDRESS_V1.test(address) ? lower(address) : null;
}

/** Two's-complement int24 out of a 32-byte data word. */
function int24FromWord(word: string): number {
  const value = Number.parseInt(word, 16);
  return value >= 0x800000 ? value - 0x1000000 : value;
}

/**
 * Reads one `Initialize` log into a PoolKey, or says why it will not.
 *
 * Pure: the caller fetches the log. That keeps the refusals — which are the
 * interesting part — testable against real log bytes with no network.
 */
export function b20PoolFromInitializeLogV1(log: RawLogV1, token: string): B20PoolResultV1 {
  const wanted = lower(token);
  if (!log.address || lower(log.address) !== UNISWAP_V4_POOL_MANAGER_V1) {
    // Anyone may emit an event with this signature. Only the singleton's
    // version means a pool exists.
    return { ok: false, refusal: 'wrong_emitter' };
  }
  const topics = log.topics ?? [];
  if (topics.length < 4 || lower(topics[0] ?? '') !== UNISWAP_V4_INITIALIZE_TOPIC_V1) {
    return { ok: false, refusal: 'wrong_event' };
  }
  const poolId = topics[1] ?? '';
  const currency0 = addressFromTopic(topics[2] ?? '');
  const currency1 = addressFromTopic(topics[3] ?? '');
  const data = (log.data ?? '').startsWith('0x') ? (log.data ?? '').slice(2) : '';
  // fee, tickSpacing, hooks, sqrtPriceX96, tick — five words. Fewer means a
  // log this decoder does not understand, and guessing at a partial one would
  // produce a PoolKey that hashes to nothing.
  if (!WORD_V1.test(poolId) || !currency0 || !currency1 || data.length < 5 * 64) {
    return { ok: false, refusal: 'malformed_log' };
  }
  const word = (index: number): string => data.slice(index * 64, (index + 1) * 64);
  const hooks = addressFromTopic(`0x${word(2)}`);
  if (!hooks) return { ok: false, refusal: 'malformed_log' };

  const tokenIsCurrency0 = currency0 === wanted;
  if (!tokenIsCurrency0 && currency1 !== wanted) {
    return { ok: false, refusal: 'token_not_in_pool' };
  }
  const quoteAsset = tokenIsCurrency0 ? currency1 : currency0;
  if (!(B20_QUOTE_ASSETS_V1 as readonly string[]).includes(quoteAsset)) {
    return { ok: false, refusal: 'unsupported_quote_asset' };
  }

  return {
    ok: true,
    pool: {
      poolId: lower(poolId),
      key: {
        currency0,
        currency1,
        fee: Number.parseInt(word(0), 16),
        tickSpacing: int24FromWord(word(1)),
        hooks,
      },
      token: wanted,
      quoteAsset,
      tokenIsCurrency0,
      blockNumber: Number(log.blockNumber ?? 0),
    },
  };
}

export interface ResolveB20PoolInputV1 {
  token: string;
  /** The block the B20 launch was detected in. Already stored per launch. */
  launchBlock: number;
  /** Injected. Returns logs for one bounded range; the caller owns pacing,
   * retries and the endpoint. */
  getLogs: (query: {
    address: string;
    fromBlock: number;
    toBlock: number;
    topics: (string | null)[];
  }) => Promise<readonly RawLogV1[]>;
  /** How many ten-block windows to walk forward. One is enough for every
   * launch sampled; more is for a chain that reorganised the ordering. */
  windows?: number;
}

/**
 * Finds the pool for a B20 token, in as few requests as the RPC plan allows.
 *
 * Two queries per window, because the token may be either side of the pair —
 * `summer` is currency1 against native ETH, `PDRSTR` is currency1 against
 * USDC, and v4 orders currencies by address, so neither position is
 * guaranteed. Both are filtered server-side by topic so nothing unrelated is
 * transferred.
 */
export async function resolveB20PoolV1(input: ResolveB20PoolInputV1): Promise<B20PoolResultV1> {
  const token = lower(input.token);
  const tokenTopic = `0x000000000000000000000000${token.slice(2)}`;
  const windows = Math.max(1, input.windows ?? 1);
  let lastRefusal: B20PoolRefusalV1 = 'no_pool_initialized';

  for (let window = 0; window < windows; window += 1) {
    const fromBlock = input.launchBlock + window * B20_POOL_SEARCH_BLOCKS_V1;
    const toBlock = fromBlock + B20_POOL_SEARCH_BLOCKS_V1 - 1;
    for (const topics of [
      [UNISWAP_V4_INITIALIZE_TOPIC_V1, null, null, tokenTopic],
      [UNISWAP_V4_INITIALIZE_TOPIC_V1, null, tokenTopic, null],
    ]) {
      let logs: readonly RawLogV1[];
      try {
        logs = await input.getLogs({
          address: UNISWAP_V4_POOL_MANAGER_V1,
          fromBlock,
          toBlock,
          topics,
        });
      } catch {
        // Stop on the first unanswered request rather than walking the
        // remaining windows: an endpoint that just refused is unlikely to
        // answer the next one, and spending a metered budget to arrive at the
        // same "we could not ask" helps nobody.
        return { ok: false, refusal: 'endpoint_unavailable' };
      }
      for (const log of logs) {
        const result = b20PoolFromInitializeLogV1(log, token);
        if (result.ok) return result;
        // A refusal from a real log is more informative than "nothing found",
        // so it survives to be reported if no window yields a pool.
        lastRefusal = result.refusal;
      }
    }
  }
  return { ok: false, refusal: lastRefusal };
}
