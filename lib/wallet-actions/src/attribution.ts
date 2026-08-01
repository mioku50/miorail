// T19 / T67X-B: Builder Code (ERC-8021) attribution. The builder code is a
// PUBLIC value from base.dev — it is not a secret — and is attached to the
// wallet_sendCalls batch as a `dataSuffix` capability so Base can attribute the
// onchain activity to this app.
//
// Two properties this module exists to hold:
//
//   * The suffix is OPTIONAL. A wallet that does not implement `dataSuffix`
//     must still be able to send the batch. Attribution is worth less than the
//     transaction the user asked for.
//   * Missing attribution is SILENT. No error, no warning, no revert — the
//     bytes simply are not there. That is why the outcome is classified
//     explicitly below instead of being assumed from "we passed the capability".

import type { Hex } from 'viem';
import { Attribution } from 'ox/erc8021';
import {
  builderCodeAdviceV1,
  resolveBuilderCodeV1,
  type BuilderCodeEnvV1,
} from '@mioagent/route-domain';

export {
  builderCodeAdviceV1,
  builderCodeFromEnvV1,
  resolveBuilderCodeV1,
  type BuilderCodeEnvV1,
  type BuilderCodeResolutionV1,
} from '@mioagent/route-domain';

let warnedMissing = false;

export function resetAttributionWarningForTest() {
  warnedMissing = false;
}

// Converts a builder code (e.g. "bc_a1b2c3d4") to an ERC-8021 data suffix.
// Returns undefined when no code is provided, is a placeholder, is malformed,
// or when BASE_BUILDER_CODE and the deprecated BUILDER_CODE alias disagree —
// so the caller can omit the capability entirely without crashing during
// render. Validity is decided by the shared resolver, so a code refused at
// deployment time cannot still reach the wallet here.
export function builderCodeToDataSuffix(
  code?: string | null,
  _converter = Attribution.toDataSuffix,
): Hex | undefined {
  const resolution = resolveBuilderCodeV1({ BASE_BUILDER_CODE: code ?? undefined });
  if (resolution.status !== 'resolved') {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(`[Miorail] ${builderCodeAdviceV1(resolution)}`);
    }
    return undefined;
  }
  try {
    return _converter({ codes: [resolution.code] });
  } catch (err: unknown) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        `[Miorail] Builder Code "${resolution.code}" was rejected by the ERC-8021 encoder; transactions will not be attributed to this app.`,
        err,
      );
    }
    return undefined;
  }
}

/** Resolves the Builder Code from a surface's inlined env. Both bundlers
 * require literal member access to inline the value, so callers pass an object
 * literal — the precedence and the fail-closed conflict rule stay here. */
export function builderCodeForSurfaceV1(env: BuilderCodeEnvV1): string | undefined {
  const resolution = resolveBuilderCodeV1(env);
  return resolution.status === 'resolved' ? resolution.code : undefined;
}

// ---------------------------------------------------------------------------
// T67X-B5 — what actually happened to the attribution.
// ---------------------------------------------------------------------------

export type BuilderAttributionStatusV1 =
  /** The wallet reported dataSuffix support and the suffix was sent with the
   * batch. The strongest claim this client can make without reading the
   * UserOperation back off the chain. */
  | 'included'
  /** The wallet answered wallet_getCapabilities and said it does NOT support
   * dataSuffix. The batch still went out — `optional: true` — unattributed. */
  | 'unsupported_by_wallet'
  /** Not established. Either there was no code to send, or the wallet never
   * said whether it supports the capability. NOT a claim that attribution
   * failed, and never upgraded to `included` on an assumption. */
  | 'unavailable';

export interface BuilderAttributionOutcomeV1 {
  status: BuilderAttributionStatusV1;
  /** A usable code resolved from env. */
  builderCodePresent: boolean;
  /** The dataSuffix capability was actually attached to this batch. */
  dataSuffixRequested: boolean;
  /** What the wallet said. `null` means it did not say — which is why
   * `included` is not reachable from here. */
  dataSuffixSupported: boolean | null;
}

/** Reads `wallet_getCapabilities` output for Base mainnet. Shaped loosely on
 * purpose: this is a wallet-supplied object and a wallet may return anything. */
export function dataSuffixSupportV1(
  capabilities: unknown,
  chainId = 8453,
): boolean | null {
  if (!capabilities || typeof capabilities !== 'object') return null;
  const byChain = capabilities as Record<string | number, unknown>;
  // wagmi keys by decimal chain id; the raw RPC keys by hex. Accept both rather
  // than guessing which layer the caller came through.
  const entry = byChain[chainId] ?? byChain[`0x${chainId.toString(16)}`];
  if (!entry || typeof entry !== 'object') return null;
  const dataSuffix = (entry as Record<string, unknown>).dataSuffix;
  if (!dataSuffix || typeof dataSuffix !== 'object') return null;
  const supported = (dataSuffix as { supported?: unknown }).supported;
  return typeof supported === 'boolean' ? supported : null;
}

export function builderAttributionOutcomeV1(input: {
  suffix: Hex | undefined;
  capabilities: unknown;
  chainId?: number;
}): BuilderAttributionOutcomeV1 {
  const dataSuffixSupported = dataSuffixSupportV1(input.capabilities, input.chainId ?? 8453);
  const dataSuffixRequested = Boolean(input.suffix);
  const status: BuilderAttributionStatusV1 = !dataSuffixRequested
    ? 'unavailable'
    : dataSuffixSupported === false
      ? 'unsupported_by_wallet'
      : dataSuffixSupported === true
        ? 'included'
        : 'unavailable';
  return {
    status,
    builderCodePresent: dataSuffixRequested,
    dataSuffixRequested,
    dataSuffixSupported,
  };
}

export const BUILDER_ATTRIBUTION_LABELS_V1: Record<BuilderAttributionStatusV1, string> = {
  included: 'Builder attribution included',
  unsupported_by_wallet: 'Builder attribution skipped — wallet does not support dataSuffix',
  unavailable: 'Builder attribution not established',
};
