// ---------------------------------------------------------------------------
// T67E §1 — which token a route's B20 Control Card is about, and what to say
// when there is no card.
//
// Kept out of the components so both consoles decide identically. The choice
// it encodes: the card covers the token the user is ACQUIRING.
//
// That is the asymmetry that matters. Selling a token whose transfers are
// paused fails immediately and visibly — the transaction reverts and nothing is
// lost but gas. Acquiring one succeeds, and the constraint is discovered later,
// when the holder tries to move it. A control card is worth most about the
// position a user is about to be left holding.
// ---------------------------------------------------------------------------

export interface B20TargetAssetLikeV1 {
  address: string | null;
  symbol: string;
  kind?: string;
}

export interface B20TargetV1 {
  /** The contract to inspect, or null when there is nothing to inspect. */
  address: string | null;
  symbol: string | null;
  /** Why no inspection is possible, when it is not. Null when `address` is set. */
  skipReason: string | null;
}

/**
 * The inspection target for a swap route.
 *
 * A native asset has no contract, so there is nothing to read and the card does
 * not render. That is stated rather than left blank: a missing panel where one
 * usually appears reads as a failed check.
 */
export function b20TargetForRouteV1(asset: B20TargetAssetLikeV1 | null | undefined): B20TargetV1 {
  if (!asset) return { address: null, symbol: null, skipReason: null };
  if (!asset.address) {
    return {
      address: null,
      symbol: asset.symbol,
      skipReason: `${asset.symbol} is the chain's native asset, so it has no token contract to inspect.`,
    };
  }
  return { address: asset.address, symbol: asset.symbol, skipReason: null };
}

/**
 * What the console says when a B20 read produced nothing.
 *
 * Every branch names a DIFFERENT situation, because collapsing them is how a
 * switched-off flag ends up looking like a failed safety check. The one thing
 * none of them says is that the token is fine.
 */
export function b20UnavailableCopyV1(input: {
  gateEnabled: boolean;
  skipReason: string | null;
  errorCode: string | null;
}): string | null {
  if (input.skipReason) return input.skipReason;
  if (!input.gateEnabled) {
    // Not a safety statement. The check did not run.
    return 'B20 control inspection is off on this server, so this token’s controls were not read.';
  }
  const code = input.errorCode;
  if (!code) return null;
  if (code === 'b20_rpc_unavailable') {
    return 'No Base RPC is configured for control reads, so this token’s controls were not read. Route comparison still works.';
  }
  if (code === 'b20_storage_unavailable') {
    return 'Control snapshots cannot be stored on this server right now, so nothing was read. Route comparison still works.';
  }
  if (code === 'invalid_b20_inspect_request' || code === 'b20_address_invalid') {
    return 'This address could not be checked for B20 controls.';
  }
  if (code === 'authentication_required') {
    return 'Sign in to read this token’s on-chain controls.';
  }
  return 'This token’s controls could not be read right now. Route comparison still works.';
}

/** The error code out of a failed inspection, without leaking a message that
 * could carry an RPC URL — and therefore a key. */
export function b20ErrorCodeV1(error: unknown): string | null {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  // The API's error bodies are `{ error, code }` and the client surfaces the
  // code in the message. Only an exact known token is accepted; anything else
  // becomes a generic reason rather than being echoed.
  const known = [
    'b20_control_disabled',
    'b20_rpc_unavailable',
    'b20_storage_unavailable',
    'b20_snapshot_conflict',
    'invalid_b20_inspect_request',
    'authentication_required',
    'storage_unavailable',
  ];
  return known.find((code) => message.includes(code)) ?? 'b20_unavailable';
}
