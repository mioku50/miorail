import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
// The variant union is declared in contracts.ts as a zod enum; this module
// only maps address bytes onto it.
import type { B20VariantV1 } from './contracts.js';

// ---------------------------------------------------------------------------
// T67C — everything about B20 that is fixed, and nothing that is not.
//
// Every constant here traces to docs/B20_INTERFACE_RESEARCH.md, which records
// the official source and version for each one. Anything the research marked
// Unconfirmed, Conflicting or Not found is absent from this file on purpose —
// there is no partial support and no best guess.
//
// Selectors are COMPUTED from their signatures at module load rather than
// copied. A wrong four-byte selector calls a different method, and on a
// precompile that surfaces as a revert indistinguishable from "this token
// does not support that field".
// ---------------------------------------------------------------------------

export const B20_CHAIN_ID_V1 = 8453 as const;

/** Singleton precompiles. Identical on every network where B20 is active.
 * Source: Base B20 spec, §"Precompile addresses". */
export const B20_FACTORY_V1 = '0xb20f000000000000000000000000000000000000' as const;
export const B20_ACTIVATION_REGISTRY_V1 = '0x8453000000000000000000000000000000000001' as const;
export const B20_POLICY_REGISTRY_V1 = '0x8453000000000000000000000000000000000002' as const;

/** 4-byte selector for a Solidity signature, computed rather than copied. */
export function selectorV1(signature: string): string {
  return bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8);
}

/** keccak-256 of a literal string, as a 32-byte hex word. */
export function keccakWordV1(text: string): `0x${string}` {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;
}

export const B20_SELECTORS_V1 = {
  // B20Factory
  isB20: selectorV1('isB20(address)'),
  isB20Initialized: selectorV1('isB20Initialized(address)'),
  // Activation Registry
  isActivated: selectorV1('isActivated(bytes32)'),
  // B20 base surface — reads only. No method that moves an asset appears in
  // this file, so nothing downstream can accidentally encode one.
  name: selectorV1('name()'),
  symbol: selectorV1('symbol()'),
  decimals: selectorV1('decimals()'),
  totalSupply: selectorV1('totalSupply()'),
  supplyCap: selectorV1('supplyCap()'),
  pausedFeatures: selectorV1('pausedFeatures()'),
  isPaused: selectorV1('isPaused(uint8)'),
  policyId: selectorV1('policyId(bytes32)'),
  contractURI: selectorV1('contractURI()'),
  transferSenderPolicy: selectorV1('TRANSFER_SENDER_POLICY()'),
  transferReceiverPolicy: selectorV1('TRANSFER_RECEIVER_POLICY()'),
  transferExecutorPolicy: selectorV1('TRANSFER_EXECUTOR_POLICY()'),
  mintReceiverPolicy: selectorV1('MINT_RECEIVER_POLICY()'),
  // Asset variant
  multiplier: selectorV1('multiplier()'),
  // Stablecoin variant
  currency: selectorV1('currency()'),
  // Policy Registry
  policyExists: selectorV1('policyExists(uint64)'),
  policyAdmin: selectorV1('policyAdmin(uint64)'),
  // The one question a holder actually has. `uint64` and not `uint256`: the
  // `uint256` overload reverts on the live registry (measured 2026-08-31), and
  // a wrong overload is indistinguishable from a denial at the call site.
  isAuthorized: selectorV1('isAuthorized(uint64,address)'),
} as const;

/** Feature keys the Activation Registry is asked about. The literal strings
 * come from the Base quickstart; the keys are keccak of those strings. */
export const B20_FEATURE_KEYS_V1 = {
  asset: keccakWordV1('base.b20_asset'),
  stablecoin: keccakWordV1('base.b20_stablecoin'),
} as const;

/** Typed reverts this integration recognises. Anything else is reported as an
 * unclassified revert rather than being read as a value. */
export const B20_ERROR_SELECTORS_V1 = {
  unsupportedPolicyType: selectorV1('UnsupportedPolicyType(bytes32)'),
  policyNotFound: selectorV1('PolicyNotFound(uint64)'),
  featureNotActivated: selectorV1('FeatureNotActivated(bytes32)'),
} as const;

// ---------------------------------------------------------------------------
// Address shape
// ---------------------------------------------------------------------------

/** Variant byte at index 10 of the address. Spec §"Address Derivation". */
const VARIANT_BYTE_V1: Record<number, B20VariantV1> = { 0x00: 'asset', 0x01: 'stablecoin' };

/**
 * The variant encoded in the address, or null.
 *
 * This is a PRE-FILTER, never the decision. The spec says the variant is
 * recoverable from the address; it does not say every address of this shape is
 * a B20 token, and only `B20Factory.isB20` answers that.
 */
export function variantFromAddressV1(address: string): B20VariantV1 | null {
  const hex = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(hex)) return null;
  const byte = Number.parseInt(hex.slice(20, 22), 16);
  return VARIANT_BYTE_V1[byte] ?? null;
}

// ---------------------------------------------------------------------------
// Policy IDs
// ---------------------------------------------------------------------------

/** Authorises every account. The DEFAULT scope value on a new B20 token, so
 * "policy id 0" means "no restriction configured", not "missing data". */
export const B20_ALWAYS_ALLOW_V1 = 0n;

/** `(uint64(ALLOWLIST) << 56) | 1` — denies every account. */
export const B20_ALWAYS_BLOCK_V1 = (1n << 56n) | 1n;

export type B20PolicyTypeV1 = 'blocklist' | 'allowlist' | 'unknown';

/**
 * The policy type encoded in the top byte of a policy ID.
 *
 * `2` and `3` decode to UNION and INTERSECT in base-std's `main` branch, which
 * the published Beryl spec does not document. That conflict is recorded in the
 * research note, and it resolves to `unknown` here: reporting a composite
 * policy as though its semantics were settled would be inventing a fact.
 */
export function policyTypeFromIdV1(policyId: bigint): B20PolicyTypeV1 {
  if (policyId < 0n) return 'unknown';
  const top = policyId >> 56n;
  if (top === 0n) return 'blocklist';
  if (top === 1n) return 'allowlist';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Pause features
// ---------------------------------------------------------------------------

export type B20PausableFeatureV1 = 'transfer' | 'mint' | 'burn';

/** Ordinals from the spec's `PausableFeature` enum. The enum is append-only,
 * so an ordinal beyond this list is UNKNOWN — never mapped to a neighbour. */
export const B20_PAUSABLE_FEATURES_V1: readonly B20PausableFeatureV1[] = ['transfer', 'mint', 'burn'];

export function pausableFeatureFromOrdinalV1(ordinal: number): B20PausableFeatureV1 | null {
  return B20_PAUSABLE_FEATURES_V1[ordinal] ?? null;
}

// ---------------------------------------------------------------------------
// ABI encoding / decoding — the narrow subset this card needs
// ---------------------------------------------------------------------------

function padWord(hexNoPrefix: string): string {
  return hexNoPrefix.padStart(64, '0');
}

export function encodeNoArgsV1(selector: string): `0x${string}` {
  return `0x${selector}`;
}

export function encodeAddressArgV1(selector: string, address: string): `0x${string}` {
  return `0x${selector}${padWord(address.toLowerCase().replace(/^0x/, ''))}`;
}

export function encodeWordArgV1(selector: string, word: string): `0x${string}` {
  return `0x${selector}${padWord(word.toLowerCase().replace(/^0x/, ''))}`;
}

export function encodeUintArgV1(selector: string, value: bigint): `0x${string}` {
  if (value < 0n) throw new TypeError('ABI uint cannot be negative');
  return `0x${selector}${padWord(value.toString(16))}`;
}

/** A single 32-byte word, or null. */
function wordV1(data: string): string | null {
  const hex = data.replace(/^0x/, '');
  return hex.length === 64 && /^[0-9a-f]+$/i.test(hex) ? hex.toLowerCase() : null;
}

/**
 * Decodes a `bool`.
 *
 * Returns null for EMPTY data as well as for malformed data. That distinction
 * is the whole point: a read taken at a block before B20 was activated returns
 * `0x`, and decoding that as `false` would answer "this is not a B20 token"
 * with total confidence about a question that was never asked.
 */
export function decodeBoolV1(data: string): boolean | null {
  const word = wordV1(data);
  if (word === null) return null;
  if (/^0{64}$/.test(word)) return false;
  if (/^0{63}1$/.test(word)) return true;
  // Any other bit pattern is not a bool this decoder read correctly.
  return null;
}

export function decodeUintV1(data: string): bigint | null {
  const word = wordV1(data);
  return word === null ? null : BigInt(`0x${word}`);
}

export function decodeUint8V1(data: string): number | null {
  const value = decodeUintV1(data);
  return value === null || value > 255n ? null : Number(value);
}

export function decodeBytes32V1(data: string): `0x${string}` | null {
  const word = wordV1(data);
  return word === null ? null : (`0x${word}` as `0x${string}`);
}

export function decodeAddressWordV1(data: string): `0x${string}` | null {
  const word = wordV1(data);
  if (word === null || !/^0{24}/.test(word)) return null;
  return `0x${word.slice(24)}` as `0x${string}`;
}

/** Decodes a dynamic `string`. Null on anything that is not exactly one. */
export function decodeStringV1(data: string): string | null {
  const hex = data.replace(/^0x/, '').toLowerCase();
  if (hex.length < 128 || hex.length % 64 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
  if (offset !== 32) return null;
  const length = Number(BigInt(`0x${hex.slice(64, 128)}`));
  if (!Number.isSafeInteger(length) || length > 4096) return null;
  const bytesHex = hex.slice(128, 128 + length * 2);
  if (bytesHex.length !== length * 2) return null;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number.parseInt(bytesHex.slice(index * 2, index * 2 + 2), 16);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Decodes a dynamic `uint8[]` — the shape `pausedFeatures()` returns. */
export function decodeUint8ArrayV1(data: string): number[] | null {
  const hex = data.replace(/^0x/, '').toLowerCase();
  if (hex.length < 128 || hex.length % 64 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
  if (offset !== 32) return null;
  const length = Number(BigInt(`0x${hex.slice(64, 128)}`));
  if (!Number.isSafeInteger(length) || length > 64) return null;
  if (hex.length !== 128 + length * 64) return null;
  const values: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const value = BigInt(`0x${hex.slice(128 + index * 64, 128 + (index + 1) * 64)}`);
    if (value > 255n) return null;
    values.push(Number(value));
  }
  return values;
}

/** The 4-byte selector of a revert payload, when there is one. */
export function revertSelectorV1(data: string | null | undefined): string | null {
  if (typeof data !== 'string') return null;
  const hex = data.replace(/^0x/, '').toLowerCase();
  return hex.length >= 8 ? hex.slice(0, 8) : null;
}
