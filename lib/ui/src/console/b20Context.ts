// ---------------------------------------------------------------------------
// T67E §1 — which token a route's B20 Control Card is about, and what to say
// when there is no card.
//
// Kept out of the components so both consoles decide identically. The rule:
// the card covers the side that HAS controls to read — the one that is not
// cash.
//
// It used to be "the token the user is ACQUIRING", on the reasoning that
// selling a paused token reverts visibly and costs only gas, while acquiring
// one leaves the holder to discover the constraint later. That reasoning was
// written when every route spent USDC, and it breaks the moment a route
// returns it: on a SELL the acquired side is USDC, so the panel read USDC's
// controls, printed "this address was not verified as a B20 token", and stood
// exactly where a reader looks for the controls of the thing they hold.
//
// The premise was wrong too, for these tokens specifically. A B20 tokenized
// stock's transfer policy can refuse ONE address, and a sale it refuses is the
// case this product exists to surface — you cannot redeem with the issuer, so
// the market is the only way out. That is not a cheap, visible failure; it is
// the whole question.
//
// Token-to-token keeps the old preference: with controls on both sides, the
// position you are left holding is the one worth reading.
// ---------------------------------------------------------------------------

/** Base USDC — the cash side of every route this console prices. It has no B20
 * controls, so a card about it is a card about nothing. */
const CASH_ADDRESS_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

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
 * The disposed side as the wire hands it over.
 *
 * Looser than `B20TargetAssetLikeV1` because it comes straight off the parsed
 * intent, where every field is optional. Only the address decides anything
 * here, and a missing one simply means there is no better target than the
 * acquired side.
 */
export interface B20DisposedAssetLikeV1 {
  address?: string | null;
  symbol?: string;
}

function isCashV1(asset: { address?: string | null } | null | undefined): boolean {
  return (asset?.address ?? '').toLowerCase() === CASH_ADDRESS_V1;
}

/**
 * The inspection target for a swap route.
 *
 * `acquired` is what the route returns and `disposed` what it spends. When the
 * acquired side is cash — every SELL — the controls worth reading belong to
 * the side being sold, so that is the one inspected.
 *
 * A native asset has no contract, so there is nothing to read and the card does
 * not render. That is stated rather than left blank: a missing panel where one
 * usually appears reads as a failed check.
 */
export function b20TargetForRouteV1(
  acquired: B20TargetAssetLikeV1 | null | undefined,
  disposed?: B20DisposedAssetLikeV1 | null,
): B20TargetV1 {
  const asset: B20TargetAssetLikeV1 | null | undefined =
    isCashV1(acquired) && disposed?.address && !isCashV1(disposed)
      ? { address: disposed.address, symbol: disposed.symbol ?? '' }
      : acquired;
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
  if (code === 'b20_rpc_no_answer') {
    // Separate from the line above on purpose: "nothing is configured" is an
    // operator's problem to fix, "the endpoint went quiet" is worth retrying.
    // Collapsing them would send a user to the wrong one every other time.
    return 'The Base endpoint did not answer, so nothing was read. This says nothing about the token — try again in a moment.';
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
    'b20_rpc_no_answer',
    'b20_storage_unavailable',
    'b20_snapshot_conflict',
    'invalid_b20_inspect_request',
    'authentication_required',
    'storage_unavailable',
  ];
  return known.find((code) => message.includes(code)) ?? 'b20_unavailable';
}
