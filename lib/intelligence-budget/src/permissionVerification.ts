// T71 §4/§5 — what has to be true before a budget exists.
//
// The whole task turns on one rule: a spending permission is a fact about the
// CHAIN, and the client is not a source of facts about the chain. A browser
// that has just prompted a wallet knows what it asked for; it does not know
// what was granted, and a hostile one knows neither and says both.
//
// So every field the server checks against is resolved server-side — the wallet
// from the session, the chain from a constant, the token from the canonical
// USDC address, the spender from the operator's configuration — and the request
// body supplies only the CLAIM. Nothing here reads a value from the claim and
// then validates the claim against it.
//
// Pure: no I/O, no clock of its own, no SDK. `@base-org/account` is never
// imported by this package (see spendPermissionCharger.ts for why); the
// on-chain status is read by the caller and passed in.

/** The permission as the wallet returned it, exactly as it arrives on the wire. */
export interface SpendPermissionClaimV1 {
  /** The wallet's signature over the typed data. Presence only is checked here;
   * the signature's validity is decided on-chain, not in this process. */
  signature: string;
  chainId: number;
  /** What the client says the permission hash is. Never trusted — the caller
   * recomputes it and passes the recomputed value in as `derivedHash`. */
  permissionHash: string;
  permission: {
    account: string;
    spender: string;
    token: string;
    /** Base-10 atomic string. */
    allowance: string;
    /** Seconds. */
    period: number;
    /** Unix seconds. */
    start: number;
    /** Unix seconds. */
    end: number;
    salt: string;
    extraData: string;
  };
}

/** Everything the server already knows, from somewhere the caller cannot reach. */
export interface ExpectedPermissionBindingV1 {
  /** From the SESSION. Never from the request body. */
  walletAddress: string;
  chainId: 8453;
  /** Canonical USDC on Base mainnet. */
  token: string;
  /** The operator's configured spender. A permission naming anyone else is a
   * permission this server cannot draw on, whatever it says. */
  spender: string;
  /** The monthly limit the budget is about to be created with, in atomic USDC. */
  periodLimitAtomic: string;
  /** The minimum period the product will accept, in seconds. */
  minimumPeriodSeconds: number;
  now: Date;
}

/** The on-chain answer, read by the caller through the SDK. */
export interface OnchainPermissionStatusV1 {
  isActive: boolean;
  /**
   * Whether SpendPermissionManager has the permission in STORAGE.
   *
   * T71-LIVE-2: this is false for every freshly signed permission and stays
   * false until somebody submits `approveWithSignature`. `requestSpendPermission`
   * only signs — it sends no transaction — and the Base Account SDK's own
   * `prepareSpendCallData` treats `isApprovedOnchain === false` as "prepend the
   * approve call to the first spend", not as an error. So this is a fact worth
   * recording and NOT a precondition for activation.
   */
  isApprovedOnchain: boolean;
  /**
   * Whether the contract accepts the signature for this exact permission.
   *
   * This is the check that replaces `isApprovedOnchain` as the gate. It is a
   * simulated `approveWithSignature` — the same call the first charge will
   * make — so a true here means the chain has validated the account's signature
   * over these exact fields, and the first spend's approve step will succeed.
   */
  signatureAcceptedOnchain: boolean;
  isRevoked: boolean;
  isExpired: boolean;
  /** Atomic string. What is left in the current period. */
  remainingSpendAtomic: string;
}

export type PermissionRefusalV1 =
  | 'malformed_permission'
  | 'signature_missing'
  | 'permission_hash_mismatch'
  | 'wallet_mismatch'
  | 'chain_mismatch'
  | 'token_mismatch'
  | 'spender_mismatch'
  | 'allowance_below_limit'
  | 'period_too_short'
  | 'not_started'
  | 'already_expired'
  | 'not_approved_onchain'
  | 'permission_revoked'
  | 'permission_inactive'
  | 'remaining_below_limit';

export type PermissionVerificationV1 =
  | { ok: true }
  | { ok: false; refusal: PermissionRefusalV1 };

const ADDRESS_V1 = /^0x[0-9a-fA-F]{40}$/;
const ATOMIC_V1 = /^(0|[1-9][0-9]*)$/;
const HEX_HASH_V1 = /^0x[0-9a-fA-F]{64}$/;

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Stage one: does the claim describe a permission this server could ever use?
 *
 * Every check is an equality against a server-held value, and every failure is
 * a refusal rather than a normalisation. A permission for the wrong token is
 * not "corrected" to USDC; it is refused, because the wallet signed for the
 * wrong token and a corrected copy is not something anybody signed.
 */
export function verifyPermissionBindingV1(input: {
  claim: SpendPermissionClaimV1;
  expected: ExpectedPermissionBindingV1;
  /** The hash the SERVER derived from the claim's own fields. */
  derivedHash: string;
}): PermissionVerificationV1 {
  const { claim, expected, derivedHash } = input;
  const p = claim.permission;

  if (
    !ADDRESS_V1.test(p.account) ||
    !ADDRESS_V1.test(p.spender) ||
    !ADDRESS_V1.test(p.token) ||
    !ATOMIC_V1.test(p.allowance) ||
    !Number.isInteger(p.period) ||
    p.period <= 0 ||
    !Number.isInteger(p.start) ||
    !Number.isInteger(p.end) ||
    p.end <= p.start
  ) {
    return { ok: false, refusal: 'malformed_permission' };
  }
  if (typeof claim.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(claim.signature)) {
    return { ok: false, refusal: 'signature_missing' };
  }

  // The hash IS the identity a later charge is addressed to. If the client
  // could name it freely, it could bind this budget to a permission granted by
  // somebody else — the fields would all check out, because they would be that
  // other permission's fields.
  if (!HEX_HASH_V1.test(claim.permissionHash) || !sameAddress(claim.permissionHash, derivedHash)) {
    return { ok: false, refusal: 'permission_hash_mismatch' };
  }

  if (!sameAddress(p.account, expected.walletAddress)) return { ok: false, refusal: 'wallet_mismatch' };
  if (claim.chainId !== expected.chainId) return { ok: false, refusal: 'chain_mismatch' };
  if (!sameAddress(p.token, expected.token)) return { ok: false, refusal: 'token_mismatch' };
  if (!sameAddress(p.spender, expected.spender)) return { ok: false, refusal: 'spender_mismatch' };

  // A permission that allows less than the budget's monthly limit would let the
  // product promise a ceiling the chain will not honour, and the user would
  // discover the difference as a failed paid check halfway through a month.
  if (BigInt(p.allowance) < BigInt(expected.periodLimitAtomic)) {
    return { ok: false, refusal: 'allowance_below_limit' };
  }
  if (p.period < expected.minimumPeriodSeconds) return { ok: false, refusal: 'period_too_short' };

  const nowSeconds = Math.floor(expected.now.getTime() / 1000);
  if (p.start > nowSeconds) return { ok: false, refusal: 'not_started' };
  if (p.end <= nowSeconds) return { ok: false, refusal: 'already_expired' };

  return { ok: true };
}

/**
 * Stage two: will the chain accept it?
 *
 * A signature in a POST body is a claim, and this is where the chain answers.
 * It is the check that makes §10's "no DB-only fake permission" structural
 * rather than a promise — without it, anyone who can reach the endpoint can
 * mint themselves a budget by inventing well-formed JSON.
 *
 * T71-LIVE-2 changed WHICH on-chain answer decides that, and the old one was
 * unachievable. Requiring `isApprovedOnchain` required a permission to already
 * be in SpendPermissionManager's storage — but nothing puts it there. The
 * wallet only signs; the approve transaction is bundled into the FIRST SPEND,
 * by design, by the spender. So the gate demanded a state that could only exist
 * after the very charge the gate was blocking. Every real Base Account grant
 * refused, forever, and no amount of retrying could have changed it.
 *
 * `signatureAcceptedOnchain` asks the question the old gate meant to ask: does
 * SpendPermissionManager accept THIS signature over THESE fields? It is decided
 * by the contract, over a permission whose identity was already pinned by the
 * contract's own `getHash` in stage one, so the security property is intact —
 * a client that invents JSON produces a signature the chain rejects.
 */
export function verifyPermissionStatusV1(input: {
  status: OnchainPermissionStatusV1;
  periodLimitAtomic: string;
}): PermissionVerificationV1 {
  const { status } = input;
  if (status.isRevoked) return { ok: false, refusal: 'permission_revoked' };
  if (status.isExpired) return { ok: false, refusal: 'already_expired' };
  // Either is sufficient, and they are the two ways a permission can be real:
  // already in storage, or carrying a signature the contract will honour.
  if (!status.isApprovedOnchain && !status.signatureAcceptedOnchain) {
    return { ok: false, refusal: 'not_approved_onchain' };
  }
  if (!status.isActive) return { ok: false, refusal: 'permission_inactive' };
  if (!ATOMIC_V1.test(status.remainingSpendAtomic)) return { ok: false, refusal: 'malformed_permission' };
  if (BigInt(status.remainingSpendAtomic) < BigInt(input.periodLimitAtomic)) {
    return { ok: false, refusal: 'remaining_below_limit' };
  }
  return { ok: true };
}

/** Both stages, in order. Binding first: it costs no network call, and a claim
 * for the wrong wallet should never reach an RPC endpoint at all. */
export function verifySpendPermissionV1(input: {
  claim: SpendPermissionClaimV1;
  expected: ExpectedPermissionBindingV1;
  derivedHash: string;
  status: OnchainPermissionStatusV1;
}): PermissionVerificationV1 {
  const binding = verifyPermissionBindingV1(input);
  if (!binding.ok) return binding;
  return verifyPermissionStatusV1({
    status: input.status,
    periodLimitAtomic: input.expected.periodLimitAtomic,
  });
}

/**
 * What a user is told. Every refusal gets a sentence that names the situation
 * and confirms what still works — free route comparison is never affected by
 * any of these, and saying so is the difference between "this failed" and
 * "the product is broken".
 */
export const PERMISSION_REFUSAL_COPY_V1: Readonly<Record<PermissionRefusalV1, string>> = {
  malformed_permission:
    'Your wallet returned a permission this server cannot read. Nothing was stored and nothing was charged.',
  signature_missing:
    'That permission arrived without a wallet signature, so it was not stored. Nothing was charged.',
  permission_hash_mismatch:
    'The permission does not match its own identifier, so it was refused. Nothing was stored.',
  wallet_mismatch:
    'That permission was granted by a different wallet than the one signed in here, so it was refused.',
  chain_mismatch: 'That permission is for a different network. Miorail only spends on Base mainnet.',
  token_mismatch: 'That permission is for a different token. Paid evidence is charged in USDC only.',
  spender_mismatch:
    'That permission names a different spender, so this server could never draw on it. Nothing was stored.',
  allowance_below_limit:
    'The permission allows less than the monthly limit you chose. Lower the limit or grant a larger permission.',
  period_too_short:
    'That permission renews faster than a monthly budget can track. Nothing was stored.',
  not_started: 'That permission does not start until later, so it cannot be activated yet.',
  already_expired: 'That permission has already expired. Granting a new one is the fix.',
  // No longer "not yet" — the contract was asked to accept this signature and
  // declined. Waiting cannot change that, so the copy must not imply it can.
  not_approved_onchain:
    'Base would not accept the signature on this permission, so no budget was created. Granting a new permission is the fix. Free route comparison is unaffected.',
  permission_revoked: 'That permission has been revoked, so no budget was created.',
  permission_inactive: 'That permission is not active on-chain, so no budget was created.',
  remaining_below_limit:
    'This permission has less left in the current period than the monthly limit you chose. Lower the limit, or wait for the period to roll over.',
};
