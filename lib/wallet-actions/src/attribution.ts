// T19: Builder Code (ERC-8021) attribution. The builder code is a PUBLIC value
// from base.dev — it is not a secret — and is attached to every wallet_sendCalls
// batch as a `dataSuffix` capability so Base can attribute the onchain activity
// to this app. Missing attribution causes silent data loss (no error, no
// warning), so we warn once when it is unset but still let the tx proceed.

import type { Hex } from 'viem';
import { Attribution } from 'ox/erc8021';

let warnedMissing = false;

// Converts a builder code (e.g. "bc_a1b2c3d4") to an ERC-8021 data suffix.
// Returns undefined when no code is provided so the caller can omit the
// capability entirely (the wallet then sends unattributed calldata).
export function builderCodeToDataSuffix(code?: string | null): Hex | undefined {
  if (!code) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        '[Miorail] BUILDER_CODE not set; transactions will not be attributed to this app (ERC-8021). Set VITE_BUILDER_CODE / NEXT_PUBLIC_BUILDER_CODE to a code from base.dev.',
      );
    }
    return undefined;
  }
  return Attribution.toDataSuffix({ codes: [code] });
}
