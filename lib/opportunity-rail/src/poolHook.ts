// ---------------------------------------------------------------------------
// What a B20 pool's hook is ALLOWED to do.
//
// Uniswap v4 encodes a hook's permissions in the low 14 bits of its own
// address — the deployer mines an address whose last bits spell the callbacks
// it implements, and the PoolManager reads those bits to decide what to call.
// That makes this the rare on-chain fact that needs no bytecode and no RPC: the
// address IS the permission set. Which matters here, because a B20 token's own
// code cannot be read at all (`eth_getCode` returns the single byte `0xef`,
// `codeHash` confirms it, BaseScan calls it a System Contract and shows no
// source). The hook is the one part of the venue we can verify by inspection.
//
// Measured across 50 real B20 launches on 2026-08-10, reading each launch's own
// `Initialize` log filtered by its pool id:
//
//   0x985c14ba…2acc   48 of 50   the standard launch hook
//   0xf85f1f30…20cc    2 of 50   a second hook, fewer permissions
//
// So it is not a constant, and a launch that does not use the usual hook is a
// thing worth saying. Every sampled pool paired against native ETH and carried
// `fee = 0` in its PoolKey — NOT the dynamic-fee flag (0x800000), a literal
// zero static fee. With no LP fee, whatever a swap costs beyond the curve comes
// from the hook, and both observed hooks hold BEFORE_SWAP_RETURNS_DELTA and
// AFTER_SWAP_RETURNS_DELTA, which is permission to change the amounts of every
// swap. For an exit-first rail that is the single most load-bearing fact about
// the venue.
//
// The honesty boundary, and it is not a detail: these bits say what the hook
// MAY do, never what it DOES. A hook permitted to take a fee may take none.
// Callers must word it as permission, and the measured round trip — not this
// decoder — remains the only evidence of what exiting actually costs.
// ---------------------------------------------------------------------------

/** The permission bits, named as Uniswap's `Hooks.sol` names them. Order is
 * high bit first so a rendered list reads in lifecycle order. */
export const UNISWAP_V4_HOOK_FLAGS_V1 = [
  { bit: 13, id: 'before_initialize' },
  { bit: 12, id: 'after_initialize' },
  { bit: 11, id: 'before_add_liquidity' },
  { bit: 10, id: 'after_add_liquidity' },
  { bit: 9, id: 'before_remove_liquidity' },
  { bit: 8, id: 'after_remove_liquidity' },
  { bit: 7, id: 'before_swap' },
  { bit: 6, id: 'after_swap' },
  { bit: 5, id: 'before_donate' },
  { bit: 4, id: 'after_donate' },
  { bit: 3, id: 'before_swap_returns_delta' },
  { bit: 2, id: 'after_swap_returns_delta' },
  { bit: 1, id: 'after_add_liquidity_returns_delta' },
  { bit: 0, id: 'after_remove_liquidity_returns_delta' },
] as const;

export type V4HookFlagIdV1 = (typeof UNISWAP_V4_HOOK_FLAGS_V1)[number]['id'];

/** Only the low 14 bits carry permissions; the rest is just an address. */
const ALL_HOOK_MASK_V1 = (1 << 14) - 1;

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;

/** v4 spells "no hook" as the zero address, and a pool with no hook is a
 * materially different pool — nothing can intercept its swaps. */
export const V4_NO_HOOK_V1 = '0x0000000000000000000000000000000000000000' as const;

/**
 * The hook every B20 launch used but two, of fifty sampled.
 *
 * Pinned from measurement, not from an announcement. It is a comparison point,
 * not an endorsement: "the usual one" is a statement about frequency, and the
 * standard hook holds MORE permissions than the rare one, so common is not the
 * same as safer.
 */
export const B20_STANDARD_LAUNCH_HOOK_V1 = '0x985c14baa2a18316ffda0aefb3a632fadfca2acc' as const;

export interface V4HookPermissionsV1 {
  hook: string;
  /** The low 14 bits, the whole of what the address encodes. */
  permissionBits: number;
  /** Every flag the address claims, in lifecycle order. */
  flags: V4HookFlagIdV1[];
  /** No hook at all — the zero address. */
  none: boolean;
  /** May return a delta on a swap, i.e. may change what a swap pays or
   * returns. With a zero static fee this is what sets the cost of exiting. */
  mayChangeSwapAmounts: boolean;
  /** Runs before a swap and so may refuse one outright. */
  mayInterceptSwaps: boolean;
  /** Runs before liquidity is added or removed, and so may gate who provides
   * or withdraws it. */
  mayGateLiquidity: boolean;
}

/**
 * Reads a hook address into its permissions, or refuses.
 *
 * Pure and total: no network, no bytecode. `null` means the input was not an
 * address, which is a caller bug rather than a fact about a pool — every other
 * answer, including "no hook", is a real verdict.
 */
export function v4HookPermissionsV1(hook: string): V4HookPermissionsV1 | null {
  const lower = (hook ?? '').toLowerCase();
  if (!ADDRESS_V1.test(lower)) return null;

  const none = lower === V4_NO_HOOK_V1;
  // Parse only the last 4 hex digits: the full address overflows a JS number,
  // and nothing above bit 13 is a permission anyway.
  const permissionBits = none ? 0 : Number.parseInt(lower.slice(-4), 16) & ALL_HOOK_MASK_V1;
  const flags = UNISWAP_V4_HOOK_FLAGS_V1
    .filter((flag) => (permissionBits & (1 << flag.bit)) !== 0)
    .map((flag) => flag.id);
  const has = (id: V4HookFlagIdV1): boolean => flags.includes(id);

  return {
    hook: lower,
    permissionBits,
    flags,
    none,
    mayChangeSwapAmounts: has('before_swap_returns_delta') || has('after_swap_returns_delta'),
    mayInterceptSwaps: has('before_swap'),
    mayGateLiquidity: has('before_add_liquidity') || has('before_remove_liquidity'),
  };
}

export type B20HookStandingV1 = 'standard' | 'non_standard' | 'no_hook' | 'unreadable';

export interface B20HookAssessmentV1 {
  standing: B20HookStandingV1;
  permissions: V4HookPermissionsV1 | null;
}

/**
 * Where a launch's hook stands against the one almost every launch uses.
 *
 * `unreadable` is deliberately a value rather than a thrown error: a pool whose
 * hook we could not decode must show as unknown, never as standard by default.
 */
export function b20HookAssessmentV1(hook: string): B20HookAssessmentV1 {
  const permissions = v4HookPermissionsV1(hook);
  if (!permissions) return { standing: 'unreadable', permissions: null };
  if (permissions.none) return { standing: 'no_hook', permissions };
  return {
    standing: permissions.hook === B20_STANDARD_LAUNCH_HOOK_V1 ? 'standard' : 'non_standard',
    permissions,
  };
}
