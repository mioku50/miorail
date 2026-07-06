// T19: Builder Code (ERC-8021) attribution. The builder code is a PUBLIC value
// from base.dev — it is not a secret — and is attached to every wallet_sendCalls
// batch as a `dataSuffix` capability so Base can attribute the onchain activity
// to this app. Missing attribution causes silent data loss (no error, no
// warning), so we warn once when it is unset but still let the tx proceed.

import type { Hex } from 'viem';
import { Attribution } from 'ox/erc8021';

let warnedMissing = false;

const PLACEHOLDERS = new Set([
  'placeholder',
  'miorail-placeholder',
  'todo',
  'your_builder_code',
]);

export function resetAttributionWarningForTest() {
  warnedMissing = false;
}

// Converts a builder code (e.g. "bc_a1b2c3d4") to an ERC-8021 data suffix.
// Returns undefined when no code is provided, is a placeholder, or is malformed
// so the caller can omit the capability entirely without crashing during render.
export function builderCodeToDataSuffix(
  code?: string | null,
  _converter = Attribution.toDataSuffix,
): Hex | undefined {
  if (!code || typeof code !== 'string' || PLACEHOLDERS.has(code.trim().toLowerCase())) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        '[Miorail] BUILDER_CODE not set or is a placeholder; transactions will not be attributed to this app (ERC-8021). Set VITE_BUILDER_CODE / NEXT_PUBLIC_BUILDER_CODE to a valid code from base.dev.',
      );
    }
    return undefined;
  }
  try {
    return _converter({ codes: [code.trim()] });
  } catch (err: unknown) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        `[Miorail] BUILDER_CODE "${code}" is malformed or invalid; transactions will not be attributed to this app (ERC-8021).`,
        err,
      );
    }
    return undefined;
  }
}
