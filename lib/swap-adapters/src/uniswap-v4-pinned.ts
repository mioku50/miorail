import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

// ---------------------------------------------------------------------------
// Where B20 tokens actually trade.
//
// The B20 rail measured 24,306 quotes in a day and rejected 99.7% of them with
// `no_entry_route`, because the measurement asked Aerodrome and nothing else.
// B20 tokens are not on Aerodrome. Measured against real launches:
//
//   Uniswap trade-api   0 of 20   (404 — it does not index them)
//   KyberSwap           1 of 20
//   o1.exchange        12 of 20
//
// o1 finds them because it indexes the venue directly, and it names it: for
// every B20 token it prices, `exchange` is the Uniswap v4 PoolManager and
// `pool` is a 32-byte v4 pool id. Confirmed on chain — that address is a 24KB
// contract exposing `extsload(bytes32)` and `protocolFeeController()`.
//
// So the venue is Uniswap v4, and we can read it ourselves. That matters more
// than convenience: a number Miorail measures on chain is the product, and a
// number borrowed from an aggregator's API is not. No key, no shared token, no
// third party that can rotate a credential out from under a worker.
//
// Addresses are CONSTANTS and the event topic is COMPUTED from its signature.
// A hand-copied 32-byte topic is unverifiable by inspection and silently
// matches nothing when wrong — the same reasoning as the Aerodrome selectors.
// ---------------------------------------------------------------------------

export const UNISWAP_V4_CHAIN_ID_V1 = 8453 as const;

/** Uniswap v4's singleton. Every pool on Base lives inside this one contract,
 * which is why a pool is a bytes32 id and not an address. */
export const UNISWAP_V4_POOL_MANAGER_V1 = '0x498581ff718922c3f8e6a244956af099b2652b2b' as const;

/** Periphery readers. Both verified present on Base by code size before use. */
export const UNISWAP_V4_STATE_VIEW_V1 = '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71' as const;
export const UNISWAP_V4_QUOTER_V1 = '0x0d5e0f971ed27fbff6c2837bf31316121532048d' as const;

/** keccak-256 of a literal string, as a 32-byte hex word. */
export function topicV1(signature: string): `0x${string}` {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(signature)))}`;
}

/**
 * `Initialize` — the only event needed to learn a pool's identity.
 *
 * Written with the UNDERLYING types, not the Solidity aliases: the ABI encodes
 * `PoolId` as bytes32 and `Currency` as address, and a topic computed from the
 * alias names would be a different hash that matches no log ever emitted.
 */
export const UNISWAP_V4_INITIALIZE_TOPIC_V1 = topicV1(
  'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)',
);

/**
 * Assets a B20 pool may be quoted against.
 *
 * Both observed in production: `summer` pairs against native ETH, `PDRSTR`
 * against USDC. Anything else is refused rather than measured — a pool priced
 * in another long-tail token gives an exit number denominated in something the
 * holder would then have to exit from as well, which is not an answer to
 * "can I get out".
 */
export const UNISWAP_V4_NATIVE_V1 = '0x0000000000000000000000000000000000000000' as const;
export const UNISWAP_V4_BASE_USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
/**
 * Base mainnet WETH — the canonical predeploy.
 *
 * Added on evidence, not on principle. Of 120 launches sampled 2026-08-15
 * whose latest observation said Miorail had found no venue at all, nine had a
 * Uniswap v4 pool that EXISTED and was refused here, and every one of the nine
 * was quoted against this address. The card then told the user "Miorail has
 * not found where this trades", which was false: Miorail found where it trades
 * and declined to read it.
 *
 * The exclusion reasoning above is about long-tail pairs — an exit denominated
 * in something the holder must then exit from as well. Wrapped ETH is not that.
 */
export const UNISWAP_V4_BASE_WETH_V1 = '0x4200000000000000000000000000000000000006' as const;
export const B20_QUOTE_ASSETS_V1 = [
  UNISWAP_V4_NATIVE_V1,
  UNISWAP_V4_BASE_USDC_V1,
  UNISWAP_V4_BASE_WETH_V1,
] as const;

/**
 * How far past a launch a pool may be initialised and still be counted as that
 * launch's pool.
 *
 * Was ten, for two reasons that both expired:
 *
 *   * the two tokens sampled when this was written had their pool initialised
 *     in the same ten-block span as the launch;
 *   * the production RPC plan then in use capped `eth_getLogs` at ten blocks.
 *
 * Production now reads mainnet.base.org, which serves a ten-thousand-block
 * range in one call, so the second reason is gone. And the first did not
 * generalise: measured over 120 launches on 2026-08-15 whose latest
 * observation said no venue was found, nine had a readable pool and NONE of
 * the nine was inside ten blocks. The offsets were 12, 13, 13, 14, 14, 14, 15,
 * 43 and 1197.
 *
 * Forty-eight covers eight of those nine — roughly a hundred and sixty
 * seconds on Base. The ninth is deliberately left out: a pool created twenty
 * minutes after a launch is a separate event, and calling it the launch's pool
 * would be a claim about intent that nothing here measures.
 *
 * Widening this also RETIRES every cached miss for free. A stored row answers
 * only the window it searched (`launchPoolCoversWindowV1` requires its
 * `searchToBlock` to reach the asked-for `toBlock`), so every row written at
 * ten blocks stops answering and is re-resolved once.
 */
export const B20_POOL_SEARCH_BLOCKS_V1 = 48;
