// ---------------------------------------------------------------------------
// What a measured position is denominated in — decided in ONE place.
//
// There were three implementations of this and they disagreed. The Discover
// card defaulted an unrecognised asset to six decimals; the copilot defaulted
// the same asset to eighteen. So the same stored observation could be printed
// as two numbers twelve orders of magnitude apart, each with a confident
// currency label beside it.
//
// The rule here is that a guess is not allowed. An asset this build does not
// know gets `decimals: null`, and a caller that cannot divide must show the
// atomic figure and say so. That is worse-looking and correct, which is the
// trade this feed makes everywhere else.
// ---------------------------------------------------------------------------

/** Native ETH, as Uniswap v4 addresses it. */
export const B20_NATIVE_ASSET_V1 = '0x0000000000000000000000000000000000000000' as const;
/** Base mainnet USDC. */
export const B20_USDC_ASSET_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
/**
 * Base mainnet WETH — the canonical predeploy, not a long-tail token.
 *
 * Added after measurement: of 120 sampled launches whose latest observation
 * said Miorail had found no venue, 9 had a Uniswap v4 pool that existed and
 * was REFUSED, and every one of the 9 was quoted against this address. The
 * refusal's own reasoning — that a pool priced in another long-tail token
 * gives an exit denominated in something the holder must then exit from too —
 * does not apply to wrapped ETH.
 */
export const B20_WETH_ASSET_V1 = '0x4200000000000000000000000000000000000006' as const;

export interface B20QuoteAssetDisplayV1 {
  symbol: string;
  /** Null when this build does not know the asset. An amount is then shown
   * atomic, never divided by an assumed scale. */
  decimals: number | null;
}

const KNOWN_V1: Readonly<Record<string, B20QuoteAssetDisplayV1>> = {
  [B20_NATIVE_ASSET_V1]: { symbol: 'ETH', decimals: 18 },
  [B20_USDC_ASSET_V1]: { symbol: 'USDC', decimals: 6 },
  [B20_WETH_ASSET_V1]: { symbol: 'WETH', decimals: 18 },
};

/**
 * How to name and scale an amount in this asset.
 *
 * An unknown asset is shown BY ADDRESS with null decimals: a guessed symbol on
 * a long-tail token is exactly the kind of confident wrong label this feed
 * exists to avoid, and a guessed scale is worse.
 */
export function b20QuoteAssetDisplayV1(asset: string | null | undefined): B20QuoteAssetDisplayV1 {
  const address = (asset ?? '').toLowerCase();
  const known = KNOWN_V1[address];
  if (known) return known;
  return {
    symbol: address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'quote asset',
    decimals: null,
  };
}

/**
 * Whether a position in this asset is sized like ETH rather than like a dollar.
 *
 * The measurement worker holds two position sizes — one in USDC from the
 * profile, one explicitly in wei — and picks between them by asset. It used to
 * pick by "is this native ETH", which sends a WETH-quoted pool a position of
 * 100000000 wei: a tenth of a billionth of an ETH, a trade worth nothing, and
 * a number that would then be stored as though somebody had asked for it.
 */
export function b20QuoteAssetIsEthScaledV1(asset: string): boolean {
  const address = asset.toLowerCase();
  return address === B20_NATIVE_ASSET_V1 || address === B20_WETH_ASSET_V1;
}
