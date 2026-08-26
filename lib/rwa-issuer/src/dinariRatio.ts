import { stableHashV1 } from '@mioagent/route-domain';
import type { B20BlockAnchorV1, B20ReaderV1 } from '@mioagent/b20-control';

// ---------------------------------------------------------------------------
// Dinari's ratio, read through its own adapter.
//
// This is deliberately NOT the B20 multiplier reader with a different selector.
// The two contracts publish the same kind of number and mean opposite things
// by it, and the field that carries that difference is `application`:
//
//   B20      `balanceOf` is RAW. The caller must apply the multiplier.
//   dShare   `balanceOf` has ALREADY applied balance-per-share. Applying it
//            again double-counts every split the token has ever had.
//
// The second difference is the scale. A B20 publishes `WAD_PRECISION()` and
// the reader reads it. A dShare publishes nothing: the divisor is a constant
// in the issuer's own source — "This amount is assumed to have 18 decimals and
// is divided by 10**18 when applied", ERC20Rebasing.sol — so this adapter
// DECLARES it and says that it declared it. A read and a review are different
// kinds of evidence even when they produce the same digits.
//
// Read-only. No signer, no key, no allowance, no transaction.
// ---------------------------------------------------------------------------

/** `balancePerShare()` on DShare. Returns a uint128 in WAD units. */
export const DINARI_BALANCE_PER_SHARE_SELECTOR_V1 = '0xa781a3fd' as const;

/**
 * The divisor, from the issuer's published source rather than from the chain.
 *
 * `ERC20Rebasing._INITIAL_BALANCE_PER_SHARE = 1 ether`. The deployed contract
 * exposes no accessor for it, which is exactly why this is marked as a
 * reviewed constant instead of being presented as a measurement.
 */
export const DINARI_BALANCE_PER_SHARE_SCALE_V1 = '1000000000000000000' as const;

export type IssuerRatioReadV1 =
  | {
      outcome: 'read';
      tokenAddress: string;
      ratioKind: 'dinari_balance_per_share';
      application: 'already_applied_by_token';
      rawValue: string;
      scale: string;
      scaleSource: 'reviewed_constant';
      normalized: string;
      blockNumber: string;
      blockHash: string;
      evidenceHash: string;
    }
  | {
      /** The contract answered that it does not implement this. A fact about
       * the token. */
      outcome: 'absent';
      tokenAddress: string;
      reason: 'not_implemented' | 'answer_unusable';
    }
  | {
      /** We could not ask. A fact about us, and it stores nothing. */
      outcome: 'unread';
      tokenAddress: string;
      reason: string;
    };

function singleWordV1(raw: string): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  return BigInt(raw);
}

/** `1.191732972027972021` from (value, 1e18). Decimal-string arithmetic: a
 * float loses the last digits of a WAD, and those digits are the difference
 * between a share count that reconciles and one that does not. */
function normalizeV1(value: bigint, scale: bigint): string | null {
  if (scale <= 0n) return null;
  const digits = scale.toString();
  if (!/^10*$/.test(digits)) return null;
  const places = digits.length - 1;
  if (places === 0) return `${value.toString()}.0`;
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(places, '0');
  return `${whole.toString()}.${fraction}`;
}

/**
 * Read `balancePerShare()` from one dShare at a pinned block.
 *
 * The caller is expected to have established that this address IS a dShare —
 * via the issuer root — before calling. Reading the selector off an arbitrary
 * contract that happens to answer it is a guess, and a guess of exactly this
 * shape was measured to contradict another issuer's own published value.
 */
export async function readDinariBalancePerShareV1(
  reader: B20ReaderV1,
  input: { tokenAddress: string; anchor: B20BlockAnchorV1 },
): Promise<IssuerRatioReadV1> {
  const tokenAddress = input.tokenAddress.toLowerCase();
  const read = await reader.call({
    to: tokenAddress,
    data: DINARI_BALANCE_PER_SHARE_SELECTOR_V1,
    blockTag: input.anchor.blockTag,
  });
  if (!read.ok) {
    // A revert here is a real answer from a real contract: unlike the B20
    // precompile, a solidity contract that lacks a function simply has no
    // dispatch entry for it. Everything else is our own failure to reach it.
    if (read.reason === 'reverted' || read.reason === 'empty_result') {
      return { outcome: 'absent', tokenAddress, reason: 'not_implemented' };
    }
    return { outcome: 'unread', tokenAddress, reason: read.reason };
  }
  const value = singleWordV1(read.value);
  if (value === null || value <= 0n) {
    return { outcome: 'absent', tokenAddress, reason: 'answer_unusable' };
  }
  const scale = BigInt(DINARI_BALANCE_PER_SHARE_SCALE_V1);
  const normalized = normalizeV1(value, scale);
  if (normalized === null) return { outcome: 'absent', tokenAddress, reason: 'answer_unusable' };

  return {
    outcome: 'read',
    tokenAddress,
    ratioKind: 'dinari_balance_per_share',
    application: 'already_applied_by_token',
    rawValue: value.toString(),
    scale: DINARI_BALANCE_PER_SHARE_SCALE_V1,
    scaleSource: 'reviewed_constant',
    normalized,
    blockNumber: input.anchor.blockNumber,
    blockHash: input.anchor.blockHash,
    evidenceHash: stableHashV1('dinari-balance-per-share-read/v1', {
      token: tokenAddress,
      selector: DINARI_BALANCE_PER_SHARE_SELECTOR_V1,
      block: input.anchor.blockHash,
      rawValue: value.toString(),
      scale: DINARI_BALANCE_PER_SHARE_SCALE_V1,
    }),
  };
}
