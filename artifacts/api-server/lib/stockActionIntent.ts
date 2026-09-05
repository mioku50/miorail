import { hashRouteIntentV1, RouteIntentV1Schema, type RouteIntentV1 } from '@mioagent/route-domain';

import type { StockActionClearanceClaimsV1 } from './stockActionClearance.js';

// ---------------------------------------------------------------------------
// Connected Intelligence 2 — a confirmed stock action, as a route intent.
//
// Built from an ADDRESS and nothing else. The ordinary route path resolves an
// intent out of a person's words with a model; a confirmed stock action must
// not go anywhere near that, because words are exactly where a ticker gets back
// in. Two different issuers publish contracts for the same company, and the
// whole review boundary exists to make the reader pick one of them.
//
// So this is a pure function of the clearance. Same shape the engine already
// consumes, same adapters, same card, same Safety Kernel — only the resolver
// is different, and it does no resolving at all.
// ---------------------------------------------------------------------------

/** Base USDC, 6 decimals. The cash side of every reviewed stock question. */
const USDC_V1 = {
  chainId: 8453 as const,
  kind: 'erc20' as const,
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as `0x${string}`,
  symbol: 'USDC',
  decimals: 6,
  assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};

function decimalV1(atomic: string, decimals: number): string {
  const padded = atomic.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

export type StockActionIntentRefusalV1 = 'stock_action_sell_requires_exact_size';

/**
 * The exact swap a confirmed BUY describes.
 *
 * This clearance only records a cash equivalent for SELL, not an exact token
 * input. Converting it with an expiring quote would silently change the user's
 * approved amount. Keep refusing until the review contract can bind a separately
 * confirmed token amount and refresh the output quote before signing. Quote
 * expiry does not prevent exact-token SELL; that review flow is not implemented.
 */
export function stockActionIntentV1(input: {
  clearance: StockActionClearanceClaimsV1;
  /** The token's own decimals, read on chain. Never assumed: a wrong decimals
   * turns an exact size into a different size entirely. */
  tokenDecimals: number;
  tokenSymbol: string;
  requestId: string;
  now: Date;
}): { ok: true; intent: RouteIntentV1 } | { ok: false; reason: StockActionIntentRefusalV1 } {
  const clearance = input.clearance;
  if (clearance.direction !== 'buy' || clearance.sizeBasis !== 'exact_cash_in') {
    return { ok: false, reason: 'stock_action_sell_requires_exact_size' };
  }

  const representation = {
    chainId: 8453 as const,
    kind: 'erc20' as const,
    address: clearance.tokenAddress,
    symbol: input.tokenSymbol,
    decimals: input.tokenDecimals,
    assetId: `eip155:8453/erc20:${clearance.tokenAddress}`,
  };

  const stamp = input.now.toISOString();
  const draft = {
    schemaVersion: 'route-intent/v1' as const,
    // Deterministic in the clearance, so a retry plans the same intent rather
    // than a second one that could quote differently.
    id: `stock-action-${clearance.clearanceId}`,
    tenantId: clearance.tenantId,
    walletAddress: clearance.walletAddress,
    chainId: 8453 as const,
    createdAt: stamp,
    updatedAt: stamp,
    status: 'ready' as const,
    intentHash: `0x${'0'.repeat(64)}`,
    goal: 'swap' as const,
    fromAsset: USDC_V1,
    toAsset: representation,
    amount: {
      asset: USDC_V1,
      amountAtomic: clearance.requestedCashAtomic,
      amountDecimal: decimalV1(clearance.requestedCashAtomic, USDC_V1.decimals),
    },
    optimizationMode: 'best_net_result' as const,
    verificationDepth: 'enhanced' as const,
    // The reviewed policy, expressed as the constraint the engine understands.
    // A confirmed action may only be planned through the sources the person
    // confirmed under; a route found somewhere else is a different measurement.
    protocolConstraint: {
      mode: 'include_only' as const,
      protocols: [...clearance.approvedSources],
    },
    slippageConstraint: { maxBps: 50, source: 'default' as const },
    // Miorail never executes. The user's own Base Account does, after seeing
    // this planned, simulated and passed through the Safety Kernel.
    executionRequested: false,
  };

  return {
    ok: true,
    intent: RouteIntentV1Schema.parse({
      ...draft,
      intentHash: hashRouteIntentV1(draft as unknown as RouteIntentV1),
    }),
  };
}
