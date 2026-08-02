import {
  AERODROME_ROUTER_V1,
  encodeExactApproveV1,
  encodeSwapExactTokensForTokensV1,
  type AerodromeRouteLegV1,
} from '@mioagent/swap-adapters';
import {
  ROUND_TRIP_CALL_COUNT_V1,
  minimumOutputV1,
  type OpportunityProfileV2,
} from '@mioagent/opportunity-rail';
import type { ExecutionCallV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T68D §4 — the read-only Opportunity Simulation Blueprint.
//
// Four calls in one ordered state, built HERE from typed routes. Nothing in
// this file accepts calldata, a router address, a recipient or a deadline from
// a caller: every byte is derived from the pinned Aerodrome surface and the
// authenticated wallet, which is the same rule the execution path has followed
// since T67B.1 and the reason a client cannot widen what gets simulated.
//
// There is no signer here, no key, no broadcast and no state override. A
// simulation that had to forge a balance would be proving something about a
// wallet that does not exist.
// ---------------------------------------------------------------------------

/** The approval a leg needs is EXACT — the input amount, to the pinned Router.
 * There is no unlimited variant anywhere in this path. */
export interface OpportunityLegV1 {
  route: readonly AerodromeRouteLegV1[];
  amountInAtomic: string;
  /** The router's quote for this leg, used only to derive the minimum. */
  quotedOutAtomic: string;
}

export interface OpportunityBlueprintInputV1 {
  wallet: `0x${string}`;
  tokenAddress: `0x${string}`;
  profile: OpportunityProfileV2;
  entry: OpportunityLegV1;
  /** Absent for the two-call entry probe, which exists to learn what the entry
   * actually produces before the exit's calldata can name an amount. */
  exit?: OpportunityLegV1;
  /** Unix seconds. Threaded in rather than read from the clock so a blueprint
   * is reproducible from its own record. */
  deadlineSeconds: bigint;
}

export class OpportunityBlueprintError extends Error {}

/**
 * The calls, in the order they must execute.
 *
 * Two calls for the entry probe, four for the round trip. The order is the
 * proof: an approval after its swap proves nothing, and a reordered list is a
 * different transaction than the one that was reviewed.
 */
export function opportunityBlueprintCallsV1(
  input: OpportunityBlueprintInputV1,
): ExecutionCallV1[] {
  const position = BigInt(input.profile.positionAtomic);
  if (BigInt(input.entry.amountInAtomic) !== position) {
    // The blueprint must probe the size the profile asked about. Anything else
    // would certify a round trip nobody requested.
    throw new OpportunityBlueprintError('The entry leg must spend exactly the profile position');
  }

  const entryMinimum = minimumOutputV1(input.entry.quotedOutAtomic, input.profile.maxExitSlippageBps);
  if (BigInt(entryMinimum) <= 0n) {
    throw new OpportunityBlueprintError('The entry leg has no positive minimum output');
  }

  const calls: ExecutionCallV1[] = [
    {
      index: 0,
      callType: 'approval',
      // Exact approval of the quote asset to the pinned Router.
      to: input.profile.quoteAsset,
      valueWei: '0',
      data: encodeExactApproveV1(AERODROME_ROUTER_V1, position),
      asset: null,
      amountAtomic: position.toString(),
      recipient: null,
      spender: AERODROME_ROUTER_V1,
    },
    {
      index: 1,
      callType: 'swap',
      to: AERODROME_ROUTER_V1,
      valueWei: '0',
      data: encodeSwapExactTokensForTokensV1({
        amountIn: position,
        amountOutMin: BigInt(entryMinimum),
        routes: input.entry.route,
        // Always the authenticated wallet. There is no other allowed value.
        to: input.wallet,
        deadline: input.deadlineSeconds,
      }),
      asset: null,
      amountAtomic: position.toString(),
      recipient: input.wallet,
      spender: null,
    },
  ];

  if (!input.exit) return calls;

  const exitIn = BigInt(input.exit.amountInAtomic);
  if (exitIn <= 0n) throw new OpportunityBlueprintError('The exit leg has no positive input');
  const exitMinimum = minimumOutputV1(input.exit.quotedOutAtomic, input.profile.maxExitSlippageBps);
  if (BigInt(exitMinimum) <= 0n) {
    throw new OpportunityBlueprintError('The exit leg has no positive minimum output');
  }

  calls.push(
    {
      index: 2,
      callType: 'approval',
      // Exact approval of the B20 token itself. The amount is what the entry
      // was OBSERVED to produce, not what it was quoted to produce.
      to: input.tokenAddress,
      valueWei: '0',
      data: encodeExactApproveV1(AERODROME_ROUTER_V1, exitIn),
      asset: null,
      amountAtomic: exitIn.toString(),
      recipient: null,
      spender: AERODROME_ROUTER_V1,
    },
    {
      index: 3,
      callType: 'swap',
      to: AERODROME_ROUTER_V1,
      valueWei: '0',
      data: encodeSwapExactTokensForTokensV1({
        amountIn: exitIn,
        amountOutMin: BigInt(exitMinimum),
        routes: input.exit.route,
        to: input.wallet,
        deadline: input.deadlineSeconds,
      }),
      asset: null,
      amountAtomic: exitIn.toString(),
      recipient: input.wallet,
      spender: null,
    },
  );

  if (calls.length !== ROUND_TRIP_CALL_COUNT_V1) {
    throw new OpportunityBlueprintError('A round-trip blueprint must be exactly four calls');
  }
  return calls;
}
