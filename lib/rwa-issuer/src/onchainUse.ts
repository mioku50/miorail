// ---------------------------------------------------------------------------
// What can actually be done with one exact address, read from the chain.
//
// The Use & access surface used to be almost entirely documentation: what the
// token legally represents, what the issuer says about redemption, which
// prospectus says so. All true, none of it an answer to "what can I do with
// this right now" — and three of its rows said `Not established` because
// nothing had ever looked.
//
// Base Docs publishes every predicate needed to look:
//
//   * `isPaused(uint8)` with `TRANSFER = 0`. "Transfer pause state changes
//     without pausing mint or burn", so the transfer answer is its own read and
//     cannot be inferred from a mint or burn pause.
//   * `policyId(bytes32)` on the token, for the six policy scopes. A scope
//     bound to `ALWAYS_ALLOW` (id 0) restricts nobody.
//   * `isAuthorized(uint64,address)` on the PolicyRegistry precompile. It never
//     reverts and is always callable.
//
// THE TRAP, AND WHY THE STATES BELOW ARE SHAPED THIS WAY
//
// `isAuthorized` alone is ambiguous. Base Docs' own invariants say a
// NON-EXISTENT blocklist authorizes everyone and a non-existent allowlist
// denies everyone — so `true` can mean "checked and allowed" or "asked about a
// policy that is not there". And the warning on the blocklist page says a
// policy only stops transfers "when the blocklist is bound to
// TRANSFER_SENDER_POLICY". So a usable answer needs three reads, in order:
// which policy the token binds to the scope, whether that policy exists, and
// only then whether the account passes it. Any link missing is `not_confirmed`,
// never "allowed".
//
// AND WHAT THIS IS NOT
//
// Every result here is an ONCHAIN ADDRESS-POLICY CHECK. It is not KYC, not
// jurisdiction eligibility, and not legal permission to trade a security. An
// address that passes every policy on this page may still be barred by the
// issuer's terms, and nothing measured here can see that. The types carry no
// field that could be read as one.
// ---------------------------------------------------------------------------

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
const WORD_V1 = /^0x[0-9a-f]{64}$/;

/**
 * The PolicyRegistry singleton precompile.
 *
 * Base Docs: "The PolicyRegistry is a singleton precompile that stores policies
 * addressed by `uint64 policyId`. B20 tokens store policy IDs in fixed scopes
 * and call `isAuthorized(policyId, account)` during gated operations."
 */
export const B20_POLICY_REGISTRY_V1 = '0x8453000000000000000000000000000000000002' as const;

/** `PausableFeature.TRANSFER`. MINT, BURN and SEIZE are 1, 2 and 3 and are
 * deliberately not read here: this surface answers about transfers. */
export const B20_PAUSABLE_TRANSFER_V1 = 0;

/** `ALWAYS_ALLOW`. Base Docs: it "authorizes every account" and "cannot be
 * created, modified, or renounced", so a scope bound to it restricts nobody. */
export const B20_ALWAYS_ALLOW_POLICY_ID_V1 = 0n;

/**
 * Selectors, from Base Docs where it publishes them and computed where it does
 * not. `isAuthorized(uint64,address)` and `policyExists(uint64)` are published
 * in the Cobalt changelog as `0x55a1179e` and `0x330f5637`; both match the
 * keccak of their signatures, which is the cross-check that says the rest of
 * this table was computed the same way the chain was.
 */
export const B20_USE_SELECTORS_V1 = {
  isPaused: 'bc61e733',
  policyId: 'db3de624',
  isAuthorized: '55a1179e',
  policyExists: '330f5637',
} as const;

/** LayerZero OFT probes. Presence of a selector is not a bridge — see
 * `bridgeCapabilityFromReadsV1`, which requires a configured peer. */
export const OFT_SELECTORS_V1 = {
  oftVersion: '156a0d0f',
  endpoint: '5e280f11',
  token: 'fc0c546a',
  peers: 'bb0b6a53',
} as const;

export const B20_TRANSFER_POLICY_SCOPES_V1 = {
  sender: '0xb81736c875ab819dd97f59f2a6542cfb731ad52b4ae15a6f24df2fb02b0327f5',
  receiver: '0x8a4b3fa2d8b921852bc0089c6ef0958aa6961897be36fd731330fe2cd23f8363',
  executor: '0x10be5173aff2a44e748bd9acd8b19fe34689581398a9db7ba2fb671e786ff7d8',
} as const;

export type B20TransferScopeV1 = keyof typeof B20_TRANSFER_POLICY_SCOPES_V1;

// --- encoding -------------------------------------------------------------

function wordV1(value: bigint): string {
  if (value < 0n) throw new Error('onchainUse: a word is never negative');
  return value.toString(16).padStart(64, '0');
}

function addressWordV1(address: string): string {
  const lower = address.toLowerCase();
  if (!ADDRESS_V1.test(lower)) throw new Error('onchainUse: an exact Base address is required');
  return lower.slice(2).padStart(64, '0');
}

export function encodeIsPausedCallV1(feature = B20_PAUSABLE_TRANSFER_V1): string {
  if (!Number.isInteger(feature) || feature < 0 || feature > 255) {
    throw new Error('onchainUse: a PausableFeature is a uint8');
  }
  return `0x${B20_USE_SELECTORS_V1.isPaused}${wordV1(BigInt(feature))}`;
}

export function encodePolicyIdCallV1(scope: B20TransferScopeV1): string {
  return `0x${B20_USE_SELECTORS_V1.policyId}${B20_TRANSFER_POLICY_SCOPES_V1[scope].slice(2)}`;
}

export function encodePolicyExistsCallV1(policyId: bigint): string {
  return `0x${B20_USE_SELECTORS_V1.policyExists}${wordV1(policyId)}`;
}

export function encodeIsAuthorizedCallV1(policyId: bigint, account: string): string {
  return `0x${B20_USE_SELECTORS_V1.isAuthorized}${wordV1(policyId)}${addressWordV1(account)}`;
}

export function encodeOftProbeCallV1(probe: keyof typeof OFT_SELECTORS_V1): string {
  return `0x${OFT_SELECTORS_V1[probe]}`;
}

export function encodeOftPeersCallV1(endpointId: number): string {
  if (!Number.isInteger(endpointId) || endpointId < 0 || endpointId > 0xffffffff) {
    throw new Error('onchainUse: a LayerZero endpoint id is a uint32');
  }
  return `0x${OFT_SELECTORS_V1.peers}${wordV1(BigInt(endpointId))}`;
}

// --- decoding -------------------------------------------------------------

/**
 * One 32-byte word, or nothing.
 *
 * Strict on length AND on the boolean's own encoding: a word that is neither 0
 * nor 1 is not a `false` with rubbish in it, it is a call that answered
 * something this decoder does not understand, and the difference matters when
 * the question is whether transfers are frozen.
 */
export function decodeBoolWordV1(data: string): boolean | null {
  const value = data.trim().toLowerCase();
  if (!WORD_V1.test(value)) return null;
  const asBigInt = BigInt(value);
  if (asBigInt === 0n) return false;
  if (asBigInt === 1n) return true;
  return null;
}

export function decodeUint64WordV1(data: string): bigint | null {
  const value = data.trim().toLowerCase();
  if (!WORD_V1.test(value)) return null;
  const asBigInt = BigInt(value);
  return asBigInt > 0xffff_ffff_ffff_ffffn ? null : asBigInt;
}

export function decodeAddressWordV1(data: string): string | null {
  const value = data.trim().toLowerCase();
  if (!WORD_V1.test(value)) return null;
  if (BigInt(value) >> 160n) return null;
  const address = `0x${value.slice(26)}`;
  return ADDRESS_V1.test(address) ? address : null;
}

// --- results --------------------------------------------------------------

/** Whether transfers of this exact token are paused right now. */
export type TransferPauseStateV1 =
  | { state: 'read'; transfersPaused: boolean }
  | { state: 'unread'; reason: string };

/**
 * Which policy the token binds to one transfer scope, and whether it is real.
 *
 * `unrestricted` is a positive finding: the scope is bound to ALWAYS_ALLOW, so
 * no address can fail it. `bound` means a real policy gates it and a per-wallet
 * answer is therefore meaningful. `unread` never means either.
 */
export type TransferPolicyBindingV1 =
  | { scope: B20TransferScopeV1; state: 'unrestricted' }
  | { scope: B20TransferScopeV1; state: 'bound'; policyId: string; policyExists: boolean }
  | { scope: B20TransferScopeV1; state: 'unread'; reason: string };

/**
 * Whether ONE address passes ONE bound policy.
 *
 * `not_confirmed` covers every case where the chain did not give a usable
 * answer AND the case where the policy the scope names does not exist — because
 * a non-existent blocklist authorizes everyone and a non-existent allowlist
 * denies everyone, so `isAuthorized` over a missing policy is a coin flip
 * dressed as a fact.
 */
export type WalletPolicyCheckV1 =
  | { scope: B20TransferScopeV1; state: 'allowed' | 'blocked'; policyId: string }
  | { scope: B20TransferScopeV1; state: 'unrestricted' }
  | { scope: B20TransferScopeV1; state: 'not_confirmed'; reason: string };

export type BridgeCapabilityV1 =
  | { state: 'none_detected' }
  | { state: 'detected'; endpointAddress: string | null; configuredPeers: number[] }
  | { state: 'unread'; reason: string };

/** One `eth_call` answer, as the readers in this repo already shape them. */
export type RawCallResultV1 = { ok: true; value: string } | { ok: false; reason: string };

export function transferPauseFromReadV1(read: RawCallResultV1): TransferPauseStateV1 {
  if (!read.ok) return { state: 'unread', reason: read.reason };
  const paused = decodeBoolWordV1(read.value);
  if (paused === null) return { state: 'unread', reason: 'isPaused did not return a boolean word' };
  return { state: 'read', transfersPaused: paused };
}

export function transferPolicyBindingFromReadsV1(
  scope: B20TransferScopeV1,
  policyIdRead: RawCallResultV1,
  policyExistsRead: RawCallResultV1 | null,
): TransferPolicyBindingV1 {
  if (!policyIdRead.ok) return { scope, state: 'unread', reason: policyIdRead.reason };
  const policyId = decodeUint64WordV1(policyIdRead.value);
  if (policyId === null) {
    return { scope, state: 'unread', reason: 'policyId did not return a uint64 word' };
  }
  if (policyId === B20_ALWAYS_ALLOW_POLICY_ID_V1) return { scope, state: 'unrestricted' };
  if (!policyExistsRead) {
    return { scope, state: 'unread', reason: 'the policy was named but never checked for existence' };
  }
  if (!policyExistsRead.ok) return { scope, state: 'unread', reason: policyExistsRead.reason };
  const exists = decodeBoolWordV1(policyExistsRead.value);
  if (exists === null) {
    return { scope, state: 'unread', reason: 'policyExists did not return a boolean word' };
  }
  return { scope, state: 'bound', policyId: policyId.toString(), policyExists: exists };
}

export function walletPolicyCheckFromReadsV1(
  binding: TransferPolicyBindingV1,
  isAuthorizedRead: RawCallResultV1 | null,
): WalletPolicyCheckV1 {
  const scope = binding.scope;
  if (binding.state === 'unrestricted') return { scope, state: 'unrestricted' };
  if (binding.state === 'unread') return { scope, state: 'not_confirmed', reason: binding.reason };
  if (!binding.policyExists) {
    // The documented trap, refused rather than resolved: a missing BLOCKLIST
    // authorizes everyone and a missing ALLOWLIST denies everyone, and this
    // read cannot tell which kind is missing.
    return {
      scope,
      state: 'not_confirmed',
      reason: 'the policy this scope names does not exist, and a missing policy answers differently by type',
    };
  }
  if (!isAuthorizedRead) {
    return { scope, state: 'not_confirmed', reason: 'the policy was not checked for this address' };
  }
  if (!isAuthorizedRead.ok) {
    return { scope, state: 'not_confirmed', reason: isAuthorizedRead.reason };
  }
  const authorized = decodeBoolWordV1(isAuthorizedRead.value);
  if (authorized === null) {
    return { scope, state: 'not_confirmed', reason: 'isAuthorized did not return a boolean word' };
  }
  return { scope, state: authorized ? 'allowed' : 'blocked', policyId: binding.policyId };
}

/**
 * A bridge is a configured destination, not a selector that answers.
 *
 * An OFT-shaped contract with no peer set can send nothing anywhere, so
 * `detected` requires the endpoint read to have succeeded, and a DESTINATION is
 * only claimed for an endpoint id whose `peers` entry is a non-zero address.
 * This is the same distinction the project already learned once: documented and
 * callable are two axes, and a third — configured — is what makes either useful.
 */
export function bridgeCapabilityFromReadsV1(input: {
  endpoint: RawCallResultV1;
  peers: readonly { endpointId: number; read: RawCallResultV1 }[];
}): BridgeCapabilityV1 {
  if (!input.endpoint.ok) return { state: 'none_detected' };
  const endpointAddress = decodeAddressWordV1(input.endpoint.value);
  if (endpointAddress === null) return { state: 'none_detected' };
  const configuredPeers: number[] = [];
  let anyRead = false;
  for (const peer of input.peers) {
    if (!peer.read.ok) continue;
    anyRead = true;
    const value = peer.read.value.trim().toLowerCase();
    if (!WORD_V1.test(value)) continue;
    if (BigInt(value) !== 0n) configuredPeers.push(peer.endpointId);
  }
  if (!anyRead && input.peers.length > 0) {
    return { state: 'unread', reason: 'the OFT endpoint answered but no peer could be read' };
  }
  return { state: 'detected', endpointAddress, configuredPeers };
}
