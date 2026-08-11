import { getAddress, isAddress } from 'viem';

// ---------------------------------------------------------------------------
// Who a token is, read from the chain.
//
// The three trusted assets are known by address and always were. Everything
// beyond them has to be identified before it can be routed, and there is
// exactly one honest source for that: the contract itself.
//
// The rule this module exists to enforce: **an address comes from the user or
// from the chain, never from a model.** A language model asked for "the MIO
// token" will happily produce an address, and it will look exactly like a real
// one. Nothing here accepts a symbol as an identifier.
// ---------------------------------------------------------------------------

/** Reads one ERC-20 view function. Injected so the rules below are testable
 * without a network, and so this module owns no RPC configuration. */
export interface TokenIdentityReaderV1 {
  readSymbol(address: `0x${string}`): Promise<string | null>;
  readDecimals(address: `0x${string}`): Promise<number | null>;
}

export interface TokenIdentityV1 {
  address: `0x${string}`;
  /** Checksummed, for display. */
  displayAddress: `0x${string}`;
  /**
   * What the contract calls itself — a LABEL, never an identity.
   *
   * Two different contracts may both answer "USDC", and one of them may answer
   * "USDС" with a Cyrillic С. So this is sanitised for display and is never
   * matched against the trusted registry: see `trustedByAddressV1`.
   */
  symbol: string;
  decimals: number;
}

export type TokenIdentityRefusalV1 =
  | 'address_malformed'
  | 'symbol_unreadable'
  | 'decimals_unreadable'
  | 'decimals_out_of_range'
  | 'symbol_unusable';

export type TokenIdentityResultV1 =
  | { outcome: 'identified'; identity: TokenIdentityV1 }
  | { outcome: 'refused'; reason: TokenIdentityRefusalV1 };

/** Base units cannot be reconstructed from a decimals value this side of
 * absurd, and a contract answering 255 is not a token anyone should route. */
const MAX_DECIMALS_V1 = 36;

/**
 * A contract's own symbol, made safe to print.
 *
 * Control characters are stripped and the result is bounded. Characters
 * OUTSIDE basic Latin/digits are kept but the caller must never treat the
 * result as identifying: a symbol that renders as "USDC" in Cyrillic is a
 * phishing tool, and the defence is to show the ADDRESS, not to guess which
 * alphabet was intended.
 */
export function sanitizeTokenSymbolV1(raw: string): string | null {
  const stripped = [...raw]
    .filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)
    .join('')
    .trim();
  if (stripped.length === 0 || stripped.length > 32) return null;
  return stripped;
}

/**
 * True when this address IS one of the canonical assets.
 *
 * By address only. A token whose `symbol()` returns "USDC" gains nothing from
 * saying so — that is the whole point of identifying by address.
 */
export function trustedByAddressV1(
  address: string,
  trusted: readonly { address: string | null }[],
): boolean {
  const normalized = address.toLowerCase();
  return trusted.some((asset) => asset.address?.toLowerCase() === normalized);
}

export async function identifyTokenV1(
  rawAddress: string,
  reader: TokenIdentityReaderV1,
): Promise<TokenIdentityResultV1> {
  if (!isAddress(rawAddress)) return { outcome: 'refused', reason: 'address_malformed' };
  const address = rawAddress.toLowerCase() as `0x${string}`;

  const decimals = await reader.readDecimals(address);
  if (decimals === null) return { outcome: 'refused', reason: 'decimals_unreadable' };
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS_V1) {
    return { outcome: 'refused', reason: 'decimals_out_of_range' };
  }

  const rawSymbol = await reader.readSymbol(address);
  if (rawSymbol === null) return { outcome: 'refused', reason: 'symbol_unreadable' };
  const symbol = sanitizeTokenSymbolV1(rawSymbol);
  if (symbol === null) return { outcome: 'refused', reason: 'symbol_unusable' };

  return {
    outcome: 'identified',
    identity: { address, displayAddress: getAddress(address), symbol, decimals },
  };
}

/** Every 0x-address in a user's sentence, in the order they appear. The user
 * naming an address is the ONLY way one enters an intent by name. */
export function addressesInTextV1(message: string): `0x${string}`[] {
  const found = message.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  const seen = new Set<string>();
  const out: `0x${string}`[] = [];
  for (const candidate of found) {
    const lower = candidate.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower as `0x${string}`);
  }
  return out;
}
