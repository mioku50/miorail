import { canonicalUsdcForBaseChain } from './baseGuards.js';

// ---------------------------------------------------------------------------
// What a swap guard is allowed to treat as an asset.
//
// Both provider guards used to name their sides with a symbol out of a set of
// three — 'USDC' | 'ETH' | 'WETH'. That was never a check on the token: it was
// a check on a NAME the kernel happened to recognise, and it made the pinned
// perimeter exactly three assets wide.
//
// A side is now an ADDRESS and a decimals. The guard keeps pinning everything
// it pinned before — the approval target, the base-unit scale, the
// native-value rule — but each pin is now derived from the asset the intent
// actually carries, which is the asset that was identified on-chain and judged
// by the token-security provider. Nothing here decides that a token is safe;
// it decides that the calldata matches the token the user was shown.
// ---------------------------------------------------------------------------

export const BASE_WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Base units cannot be reconstructed past this, and no routable ERC-20 is
 * anywhere near it. Same bound the intent layer uses when it reads decimals
 * off the contract. */
export const MAX_SWAP_ASSET_DECIMALS_V1 = 36;

/**
 * One side of a swap, as the guard pins it.
 *
 * Native ETH has no contract, so it is its own kind. Everything else is an
 * address — never a symbol. Two contracts can answer the same `symbol()`, and
 * this value decides which token an approval is allowed to name.
 */
export type SwapGuardAssetV1 =
  | { kind: 'native' }
  | { kind: 'erc20'; address: string; decimals: number };

export interface NormalizedSwapAssetV1 {
  /** Lowercase contract address, or null when the side is native ETH. */
  address: string | null;
  decimals: number;
  /**
   * The address two sides are compared BY. Native ETH normalises to WETH on
   * purpose: ETH↔WETH is a wrap, there is no pool and no price, and letting it
   * through would put a guard's name on a transaction it never checked.
   */
  side: string;
}

/**
 * The normalised side, or null when the guard must refuse.
 *
 * `reserved` holds the addresses this batch already means something else by —
 * the router and Permit2. A "token" claiming one of those addresses would make
 * the guard read a router call as an approval (or the reverse), so it is
 * refused before any calldata is looked at.
 */
export function normalizeSwapAssetV1(
  asset: SwapGuardAssetV1 | undefined,
  reserved: readonly string[] = [],
): NormalizedSwapAssetV1 | null {
  if (!asset) return null;
  if (asset.kind === 'native') return { address: null, decimals: 18, side: BASE_WETH_ADDRESS };
  if (typeof asset.address !== 'string') return null;
  const address = asset.address.toLowerCase();
  if (!ADDRESS.test(address) || address === ZERO_ADDRESS) return null;
  if (reserved.some((entry) => entry.toLowerCase() === address)) return null;
  const decimals = asset.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_SWAP_ASSET_DECIMALS_V1) return null;
  return { address, decimals, side: address };
}

/** Base units for a decimal amount, at the asset's OWN precision. Was six in
 * both guards, which is USDC's; an 18-decimal input parsed that way understates
 * the amount by twelve orders of magnitude, and every amount check compares
 * against it. Shared so the two guards cannot drift apart again. */
export function decimalAmountToRawV1(value: string, decimals: number): bigint | null {
  const pattern = decimals > 0 ? new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`) : /^\d+$/;
  if (!pattern.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  try {
    const amount = BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
    return amount > 0n ? amount : null;
  } catch {
    return null;
  }
}

/**
 * The canonical Base asset a legacy symbol names.
 *
 * Only for call sites that stored a symbol before addresses were carried —
 * the Base App native routing metadata written by earlier releases. It maps
 * the three names this repo has always pinned, and returns null for anything
 * else, so an unrecognised stored symbol produces no context and the guard
 * refuses. New code passes the address it already holds.
 */
export function canonicalGuardAssetV1(symbol: unknown): SwapGuardAssetV1 | null {
  if (typeof symbol !== 'string') return null;
  switch (symbol.trim().toUpperCase()) {
    case 'ETH':
      return { kind: 'native' };
    case 'WETH':
      return { kind: 'erc20', address: BASE_WETH_ADDRESS, decimals: 18 };
    case 'USDC':
      return { kind: 'erc20', address: canonicalUsdcForBaseChain(8453).toLowerCase(), decimals: 6 };
    default:
      return null;
  }
}

/** True when this address is canonical Base USDC — the one case where an
 * amount in base units is also a dollar figure. */
export function isCanonicalBaseUsdcV1(address: string | null): boolean {
  if (!address) return false;
  return address.toLowerCase() === canonicalUsdcForBaseChain(8453).toLowerCase();
}
