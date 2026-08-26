import { stableHashV1 } from '@mioagent/route-domain';
import type { B20BlockAnchorV1, B20ReaderV1 } from '@mioagent/b20-control';

import {
  RepresentationMultiplierV1Schema,
  type RepresentationMultiplierV1,
} from './contracts.js';

// ---------------------------------------------------------------------------
// The multiplier is a disclosure, not an adjustment.
//
// Base's own documentation opens with the warning: "One B20 token does not
// permanently equal one share. Always apply the current multiplier when
// converting between token units and the number of underlying shares."
//
// Every Coinbase representation read on 2026-08-26 returned exactly 1e18, and
// that is precisely why this exists now rather than after the first dividend:
// a value that is 1.0 today is indistinguishable from a value nobody reads,
// and the day it stops being 1.0 is the day a stored 1.0 becomes a lie.
//
// Two rules the rest of the product depends on:
//
//   * The scale is READ (`WAD_PRECISION()`), never assumed. A hardcoded 1e18
//     would silently misprice the asset if the scale ever differed.
//   * It is NEVER applied to the reference price. The Chainlink feed publishes
//     a total-return value, which means the feed has already applied it —
//     `ReferenceValueV1.multiplierAppliedByFeed` is a literal `true` for that
//     reason. Applying it a second time here is the documented trap, so the
//     contract carries `appliedToReference: false` as a literal.
// ---------------------------------------------------------------------------

/** `multiplier()` on IB20Asset. */
export const B20_MULTIPLIER_SELECTOR_V1 = '0x1b3ed722' as const;
/** `WAD_PRECISION()` on IB20Asset — the scale the multiplier is expressed in. */
export const B20_WAD_PRECISION_SELECTOR_V1 = '0x664808a8' as const;

function singleWordV1(raw: string): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  return BigInt(raw);
}

/** `1.057380318816778075` from (1057380318816778075, 1e18). Decimal string
 * arithmetic: a float loses the last digits of a WAD, and those digits are the
 * difference between a share count that reconciles and one that does not. */
function normalizeV1(value: bigint, scale: bigint): string | null {
  if (scale <= 0n) return null;
  const digits = scale.toString();
  // A scale that is not a power of ten has no decimal rendering we can defend.
  if (!/^10*$/.test(digits)) return null;
  const places = digits.length - 1;
  if (places === 0) return `${value.toString()}.0`;
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(places, '0');
  return `${whole.toString()}.${fraction}`;
}

export function unavailableMultiplierV1(input: {
  tokenAddress: string | null;
  reason: RepresentationMultiplierV1['unavailableReason'];
  status?: 'absent' | 'unavailable' | 'invalid';
}): RepresentationMultiplierV1 {
  return RepresentationMultiplierV1Schema.parse({
    status: input.status ?? 'unavailable',
    tokenAddress: input.tokenAddress,
    rawValue: null,
    scale: null,
    normalized: null,
    oneToOne: null,
    source: null,
    appliedToReference: false,
    unavailableReason: input.reason,
    evidence: null,
  });
}

/**
 * Read the current multiplier from the reviewed callable path.
 *
 * Reviewed means: Base Docs publish `multiplier()` and `WAD_PRECISION()` on
 * `IB20Asset`, and both were confirmed callable on all thirteen Coinbase
 * representations. It does NOT generalise — a different issuer's contract that
 * happens to answer the same selector is a guess, and one such guess was
 * measured to contradict that issuer's own published value. Other issuers get
 * their own adapter or `not established`.
 */
export async function readB20MultiplierV1(
  reader: B20ReaderV1,
  input: { tokenAddress: string | null; anchor: B20BlockAnchorV1; now: Date },
): Promise<RepresentationMultiplierV1> {
  if (input.tokenAddress === null) {
    return unavailableMultiplierV1({ tokenAddress: null, reason: 'token_address_unknown' });
  }
  const tokenAddress = input.tokenAddress.toLowerCase();
  const calls = [
    { to: tokenAddress, data: B20_MULTIPLIER_SELECTOR_V1, blockTag: input.anchor.blockTag },
    { to: tokenAddress, data: B20_WAD_PRECISION_SELECTOR_V1, blockTag: input.anchor.blockTag },
  ];
  const [multiplierRead, scaleRead] = await (reader.callMany
    ? reader.callMany(calls)
    : Promise.all(calls.map((call) => reader.call(call))));

  // A contract that does not implement the pair is `absent`, not a failure of
  // ours; an endpoint that would not answer is a failure of ours. Reporting
  // either as the other has shipped here three times under different names.
  //
  // The B20 precompile makes the difference readable: an unknown function
  // reverts with its OWN SELECTOR as the revert data. Measured against a
  // control on 2026-08-26 — `0xdeadbeef` came back as `0xdeadbeef`, and so did
  // `uiMultiplier()`, which the interface reference documents but this
  // deployment does not implement. When the echo is there we trust it over the
  // coarse reason, and a revert carrying anything else is a real revert.
  if (!multiplierRead?.ok || !scaleRead?.ok) {
    const failed = multiplierRead?.ok === false ? multiplierRead : scaleRead;
    const attempted =
      multiplierRead?.ok === false ? B20_MULTIPLIER_SELECTOR_V1 : B20_WAD_PRECISION_SELECTOR_V1;
    const echoedItsOwnSelector =
      failed?.ok === false &&
      typeof failed.revertSelector === 'string' &&
      failed.revertSelector.toLowerCase() === attempted;
    const contractSaidNo =
      echoedItsOwnSelector ||
      (failed?.ok === false && (failed.reason === 'reverted' || failed.reason === 'empty_result'));
    const reason = contractSaidNo ? 'not_implemented' : 'chain_read_failed';
    return unavailableMultiplierV1({
      tokenAddress,
      reason,
      status: reason === 'not_implemented' ? 'absent' : 'unavailable',
    });
  }

  const value = singleWordV1(multiplierRead.value);
  const scale = singleWordV1(scaleRead.value);
  if (value === null || scale === null || scale <= 0n || value <= 0n) {
    return unavailableMultiplierV1({
      tokenAddress,
      reason: 'answer_unusable',
      status: 'invalid',
    });
  }
  const normalized = normalizeV1(value, scale);
  if (normalized === null) {
    return unavailableMultiplierV1({
      tokenAddress,
      reason: 'answer_unusable',
      status: 'invalid',
    });
  }

  return RepresentationMultiplierV1Schema.parse({
    status: 'read',
    tokenAddress,
    rawValue: value.toString(),
    scale: scale.toString(),
    normalized,
    oneToOne: value === scale,
    source: 'b20_asset_multiplier',
    appliedToReference: false,
    unavailableReason: null,
    evidence: {
      kind: 'base_chain_call',
      source: 'b20_asset_multiplier_read',
      observedAt: input.now.toISOString(),
      blockNumber: input.anchor.blockNumber,
      blockHash: input.anchor.blockHash,
      targetAddress: tokenAddress,
      method: 'multiplier(); WAD_PRECISION()',
      evidenceHash: stableHashV1('b20-multiplier-read/v1', {
        chainId: 8453,
        tokenAddress,
        blockNumber: input.anchor.blockNumber,
        blockHash: input.anchor.blockHash,
        multiplierResponse: multiplierRead.value.toLowerCase(),
        wadPrecisionResponse: scaleRead.value.toLowerCase(),
      }),
    },
  });
}
