import {
  B20_ONCHAIN_REGISTRY_V1,
  B20_REGISTRY_TOKEN_STATE_SELECTOR_V1,
  encodeAddressArgV1,
} from './pinned.js';
import type { B20BatchCallV1 } from './reader.js';

// ---------------------------------------------------------------------------
// The Coinbase onchain registry, read for one exact token address.
//
// Base Docs describes it in one sentence and gives its address without an
// interface: each tokenized stock's Chainlink feed "reads the multiplier and a
// pause flag from Coinbase's onchain oracle registry, a single contract
// (separate from the tokens) that returns both values for a token in one call".
// Miorail parsed that address out of the docs and never called it, so a fact
// the product withheld — is this token's redemption ratio still one, and is it
// frozen — was sitting one `eth_call` away.
//
// TWO THINGS THIS READER REFUSES TO DO
//
//   1. Name the function. The registry publishes no ABI. The selector was
//      recovered from the dispatcher and its shape measured; a name would be a
//      guess, and a guessed selector is what made `bGME` contradict itself.
//
//   2. Speak for an issuer the doc does not cover. The registry answers for
//      addresses outside Coinbase's thirteen, and what those answers MEAN is
//      not established by anything reviewed. Callers pass a Coinbase B20
//      address; everything else is the caller's claim to make, not this
//      module's.
//
// A failed read is `unread`, never "not paused". A registry that did not answer
// says nothing about whether transfers are frozen, and rendering a green
// "multiplier is 1.0" from a timeout is the failure mode this whole codebase is
// organised against.
// ---------------------------------------------------------------------------

/** WAD, the fixed-point scale the multiplier is published at. The docs say to
 * read it from the token's own `WAD_PRECISION()`; this is the value that call
 * returns and the divisor every worked example in the docs uses. */
export const B20_WAD_V1 = 10n ** 18n;

export type B20RegistryStateV1 =
  | {
      state: 'read';
      /** Raw, WAD-scaled. Never pre-divided: a ratio rounded on the way in
       * cannot be un-rounded by a reader who needs the exact value. */
      multiplierWad: bigint;
      paused: boolean;
    }
  | { state: 'unread'; reason: string };

/** Calldata for one token's registry entry. */
export function encodeRegistryStateCallV1(tokenAddress: string): `0x${string}` {
  return encodeAddressArgV1(B20_REGISTRY_TOKEN_STATE_SELECTOR_V1, tokenAddress);
}

/**
 * The registry read as one pinned call, ready to travel in a batch.
 *
 * Shaped for `callMany` on purpose. The pause flag is read beside the feed it
 * explains, and a second round trip to ask "was the feed paused when it
 * published that?" would be two different blocks answering one question.
 */
export function registryStateCallV1(tokenAddress: string, blockTag: string): B20BatchCallV1 {
  return {
    to: B20_ONCHAIN_REGISTRY_V1,
    data: encodeRegistryStateCallV1(tokenAddress),
    blockTag,
  };
}

/**
 * The pause flag alone, as the reference reader wants it.
 *
 * `null` is "we did not read it", and it is what every failure produces: an
 * endpoint that did not answer says nothing about whether the feed is frozen.
 * The multiplier in the same answer is deliberately dropped here — a caller
 * that wants it decodes the read itself rather than receiving it in a field
 * named for something else.
 */
export function registryPauseFromReadV1(read: { ok: boolean; value?: string }): boolean | null {
  if (!read.ok || typeof read.value !== 'string') return null;
  const state = decodeRegistryStateV1(read.value);
  return state.state === 'read' ? state.paused : null;
}

/**
 * Decode the two words the registry returns.
 *
 * Strict about length: a short answer is a different function's answer, and
 * reading the first word of it as a multiplier would publish a number this
 * contract never claimed.
 */
export function decodeRegistryStateV1(data: string): B20RegistryStateV1 {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) {
    return { state: 'unread', reason: 'The registry answer was not hex.' };
  }
  const body = data.slice(2);
  if (body.length !== 128) {
    return {
      state: 'unread',
      reason: 'The registry returned an answer of a shape this read does not recognise.',
    };
  }
  const multiplierWad = BigInt(`0x${body.slice(0, 64)}`);
  const flag = BigInt(`0x${body.slice(64, 128)}`);
  if (flag > 1n) {
    return { state: 'unread', reason: 'The registry pause flag was not a boolean.' };
  }
  // A zero multiplier is not a ratio. Publishing it would make a share count
  // collapse to nothing on a card that says the token is fine.
  if (multiplierWad === 0n) {
    return { state: 'unread', reason: 'The registry published no multiplier for this token.' };
  }
  return { state: 'read', multiplierWad, paused: flag === 1n };
}

/** `1.0` for a token whose redemption ratio has not moved. Exact: the string is
 * built from the integer, never from a float. */
export function multiplierLabelV1(multiplierWad: bigint): string {
  const whole = multiplierWad / B20_WAD_V1;
  const fraction = (multiplierWad % B20_WAD_V1).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction.length === 0 ? `${whole}.0` : `${whole}.${fraction}`;
}

/** Whether one token unit still redeems for exactly one underlying share. */
export function redemptionRatioIsOneV1(multiplierWad: bigint): boolean {
  return multiplierWad === B20_WAD_V1;
}

export { B20_ONCHAIN_REGISTRY_V1 };
