import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

// ---------------------------------------------------------------------------
// T67B — everything the Aerodrome adapter refuses to take from a response.
//
// Aerodrome needs no partner API: quotes come from the official Router over
// Base RPC. That removes a key, and it moves the trust question — there is no
// aggregator to believe, only a contract address that must be right.
//
// So the Router is a CONSTANT here and the factory is NOT. The factory is read
// from the Router's own `defaultFactory()` at runtime rather than pinned
// alongside it: a second hardcoded address is a second thing that can be
// wrong, and this one the Router can state for itself.
//
// Function selectors are COMPUTED from their signatures at module load. A
// hand-copied 4-byte selector is unverifiable by inspection and silently calls
// a different function when wrong.
// ---------------------------------------------------------------------------

export const AERODROME_CHAIN_ID_V1 = 8453 as const;

/** The official Aerodrome Router on Base. Every quote and every future swap
 * call targets exactly this address. */
export const AERODROME_ROUTER_V1 = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43' as const;

/** Canonical Base tokens, matching lib/route-proof's constants. Native ETH is
 * quoted as WETH: Aerodrome pools hold WETH, and the Router's ETH entrypoints
 * wrap on the way in. */
export const AERODROME_WETH_V1 = '0x4200000000000000000000000000000000000006' as const;
export const AERODROME_USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;

/** Hops allowed in V1. One direct pool, or one intermediate. Nothing deeper:
 * every extra hop multiplies the failure modes and the gas, and the pairs this
 * version supports do not need three. */
export const AERODROME_MAX_HOPS_V1 = 2 as const;

/** Tokens allowed as the MIDDLE of a two-hop route. Deliberately tiny — an
 * arbitrary intermediate is how a route ends up priced through a pool nobody
 * checked. */
export const AERODROME_INTERMEDIATES_V1: readonly `0x${string}`[] = [
  AERODROME_WETH_V1,
  AERODROME_USDC_V1,
];

export const AERODROME_QUOTE_TTL_MS_DEFAULT_V1 = 20_000;
export const AERODROME_RPC_TIMEOUT_MS_DEFAULT_V1 = 8_000;

/** One leg of an Aerodrome route, as the Router's `Route` struct. */
export interface AerodromeRouteLegV1 {
  from: `0x${string}`;
  to: `0x${string}`;
  /** Aerodrome's two pool kinds. `stable` uses the correlated-asset curve. */
  stable: boolean;
  factory: `0x${string}`;
}

/** 4-byte selector for a Solidity signature, computed rather than copied. */
export function selectorV1(signature: string): string {
  return bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8);
}

export const AERODROME_SELECTORS_V1 = {
  /** Router.getAmountsOut(uint256,(address,address,bool,address)[]) */
  getAmountsOut: selectorV1('getAmountsOut(uint256,(address,address,bool,address)[])'),
  /** Router.defaultFactory() */
  defaultFactory: selectorV1('defaultFactory()'),
} as const;

function padWord(hexNoPrefix: string): string {
  return hexNoPrefix.padStart(64, '0');
}

function addressWord(address: string): string {
  return padWord(address.toLowerCase().replace(/^0x/, ''));
}

function uintWord(value: bigint): string {
  if (value < 0n) throw new TypeError('ABI uint cannot be negative');
  return padWord(value.toString(16));
}

/**
 * ABI-encodes `getAmountsOut(uint256, Route[])`.
 *
 * `Route` is a static tuple, so the array is a dynamic array of 4-word
 * elements: head is the amount plus one offset, then the length and the
 * elements laid out flat.
 */
export function encodeGetAmountsOutV1(amountIn: bigint, routes: readonly AerodromeRouteLegV1[]): string {
  if (routes.length === 0) throw new TypeError('A route needs at least one leg');
  const head = uintWord(amountIn) + uintWord(64n); // arg0, then the offset to arg1.
  const body =
    uintWord(BigInt(routes.length)) +
    routes
      .map(
        (leg) =>
          addressWord(leg.from) +
          addressWord(leg.to) +
          uintWord(leg.stable ? 1n : 0n) +
          addressWord(leg.factory),
      )
      .join('');
  return `0x${AERODROME_SELECTORS_V1.getAmountsOut}${head}${body}`;
}

export function encodeDefaultFactoryV1(): string {
  return `0x${AERODROME_SELECTORS_V1.defaultFactory}`;
}

/**
 * Decodes a `uint256[]` return value.
 *
 * Returns null rather than throwing on anything malformed — a Router that
 * answers with something unreadable is a refusal, not an exception to catch
 * three layers up.
 */
export function decodeUintArrayV1(data: string): bigint[] | null {
  const hex = data.replace(/^0x/, '');
  if (hex.length < 128 || hex.length % 64 !== 0) return null;
  const word = (index: number): bigint => BigInt(`0x${hex.slice(index * 64, index * 64 + 64)}`);
  const offset = Number(word(0));
  // The offset is a byte count into the payload; anything but a clean word
  // boundary inside the data means this is not the shape we asked for.
  if (offset % 32 !== 0) return null;
  const lengthIndex = offset / 32;
  if (lengthIndex >= hex.length / 64) return null;
  const length = Number(word(lengthIndex));
  if (!Number.isSafeInteger(length) || length === 0 || length > 8) return null;
  if ((lengthIndex + 1 + length) * 64 > hex.length) return null;
  const values: bigint[] = [];
  for (let index = 0; index < length; index += 1) values.push(word(lengthIndex + 1 + index));
  return values;
}

/** Decodes a single `address` return value. */
export function decodeAddressV1(data: string): `0x${string}` | null {
  const hex = data.replace(/^0x/, '');
  if (hex.length !== 64) return null;
  // The high 12 bytes of an address word must be zero. A non-zero prefix means
  // this is not an address, however plausible the low 20 bytes look.
  if (!/^0{24}/.test(hex)) return null;
  const address = `0x${hex.slice(24)}`.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(address) && address !== `0x${'0'.repeat(40)}`
    ? (address as `0x${string}`)
    : null;
}

/**
 * The candidate routes for one pair, in the order they are tried.
 *
 * Direct pools first (volatile, then stable), then two-hop routes through the
 * pinned intermediates. Every combination is QUOTED and the best output wins —
 * this function does not decide which pool is right, it decides which ones are
 * allowed to be asked.
 */
export function candidateRoutesV1(input: {
  from: `0x${string}`;
  to: `0x${string}`;
  factory: `0x${string}`;
}): AerodromeRouteLegV1[][] {
  const { from, to, factory } = input;
  if (from === to) return [];
  const routes: AerodromeRouteLegV1[][] = [
    [{ from, to, stable: false, factory }],
    [{ from, to, stable: true, factory }],
  ];
  for (const middle of AERODROME_INTERMEDIATES_V1) {
    if (middle === from || middle === to) continue;
    for (const firstStable of [false, true]) {
      for (const secondStable of [false, true]) {
        routes.push([
          { from, to: middle, stable: firstStable, factory },
          { from: middle, to, stable: secondStable, factory },
        ]);
      }
    }
  }
  return routes;
}
