// ---------------------------------------------------------------------------
// What the tail reads, and how far behind the head it stays.
// ---------------------------------------------------------------------------

/** `Transfer(address,address,uint256)`. The one event every venue emits,
 * because every venue moves the token. */
export const ERC20_TRANSFER_TOPIC_V1 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

/**
 * Uniswap v4's singleton.
 *
 * A venue with no pair of its own: every v4 pool on Base lives inside this one
 * contract, so a transfer to or from it says the trade happened on v4 and says
 * nothing about which pool. Recorded as a `singleton` rather than probed for a
 * `token0()` it does not have.
 */
export const UNISWAP_V4_SINGLETON_V1 = '0x498581ff718922c3f8e6a244956af099b2652b2b' as const;

/** `token0()` and `token1()`. Two calls turn a behavioural pool into an
 * identified one, once per address, then never again. */
export const TOKEN0_SELECTOR_V1 = '0x0dfe1681' as const;
export const TOKEN1_SELECTOR_V1 = '0xd21220a7' as const;

/**
 * How far short of the head a pass stops.
 *
 * The cursor does not rewind, so this depth is the ONLY defence against a
 * reorg writing an event for a transaction that later does not exist. Twelve
 * blocks is about twenty-four seconds on Base. Stated here rather than implied
 * by a magic number at a call site, because raising it is a safety decision
 * and lowering it is a risk decision.
 */
export const MARKET_TAIL_CONFIRMATIONS_V1 = 12;

/**
 * The widest span one `eth_getLogs` may ask for.
 *
 * mainnet.base.org serves ten thousand blocks in a single call, and a 2,000
 * block window over thirteen assets measured 5,833 logs in 1.5 seconds. Two
 * thousand keeps a pass comfortably inside any response-size ceiling while
 * still covering more than an hour, so an hourly tail is one call.
 */
export const MARKET_TAIL_MAX_SPAN_V1 = 2_000;

/**
 * How many times an address must appear on EACH side before it is worth two
 * calls.
 *
 * A pool both pays and receives the token; a wallet does one or the other. The
 * threshold is not a guess about what a pool looks like -- it is a budget. Of
 * 329 counterparties AAPLc saw in an hour, 31 cleared three each, and probing
 * all 329 would spend 658 calls to identify the same handful.
 */
export const VENUE_CANDIDATE_MIN_PER_SIDE_V1 = 3;

/**
 * Minimum spacing between requests to the node.
 *
 * mainnet.base.org sustains roughly half an `eth_call` per second per address.
 * Without a gap the identity probe fires two calls per address back to back,
 * the endpoint throttles most of them, and every throttled address stays a
 * candidate -- so the next pass spends the same calls on the same addresses and
 * identifies nothing. Measured before this constant existed: fourteen asked,
 * twenty-eight calls, zero identified, pass after pass.
 *
 * A throttled read is our failure, so it must never be cheap to repeat.
 */
export const MARKET_TAIL_CALL_GAP_MS_V1 = 2_200;
